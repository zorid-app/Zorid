import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserVaultIntent, BrowserVaultRead, BrowserVaultOutcome } from '../core/browser-vault.ts';
import type { BrowserCoreBackend } from './browser-core.ts';
import type { DurableCheckpoints, Checkpoint, CheckpointPage, CheckpointListOptions, CheckpointChangesOptions } from '../core/durable-checkpoints.ts';
import { boundedUtf8, checkpointKey, snapshotCheckpointChange } from '../core/checkpoint-input.ts';

export interface BrowserCoreRuntimeOptions {
  database: string;
  /** Explicit canonical fixture UUID, retained across restart. Duplicate active
   * consumers fail closed in the worker; production slot allocation is separate. */
  clientId: string;
  /** Same-origin generated production ESM asset; no prototype URL fallback. */
  wasmModuleUrl: string;
  /** Required opt-in while startup/migration integration is not yet installed. */
  allowNewVault: true;
  timeoutMs?: number;
}
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; operation: string }

/** Dedicated worker transport. No native service, filesystem or desktop bridge. */
export class BrowserCoreRuntime implements BrowserCoreBackend {
  private authorityScope?: Readonly<{vaultId:string;clientId:string}>;
  get durableScope(): Readonly<{vaultId:string;clientId:string}> | undefined { return this.authorityScope; }
  private checkpointProvider?: DurableCheckpoints;
  get checkpoints():DurableCheckpoints|undefined{return this.checkpointProvider;}
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private dispatchTail: Promise<void> = Promise.resolve();
  private queuedCalls = 0;
  private admissionGuard?: () => void;
  private listeners = new Set<(paths?: readonly string[]) => void>();
  private closed = false;
  private releasing = false;
  private releasePending?: Promise<void>;
  private recovery = new Set<string>();
  private timeoutMs: number;
  private visibility = () => {
    if (!this.closed && !this.releasing && document.visibilityState === 'visible') void this.call('refresh').catch(error => {
      // Refresh is only a hint. Intentional release may cancel an already queued
      // hint; capacity pressure must not terminate an otherwise healthy writer.
      if (error?.code === 'client_queue_full' || this.releasing && error?.code === 'client_not_admitted') return;
      this.fail(error);
    });
  };
  private constructor(options: BrowserCoreRuntimeOptions) {
    this.timeoutMs = options.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new BrowserVaultError('invalid_timeout', 'Worker timeout must be 1–120000 milliseconds');
    this.worker = new Worker(new URL('./browser-core-worker.ts', import.meta.url), {type:'module'});
    this.worker.onmessage = ({data}) => {
      if (data?.event === 'storage-error') { this.fail(new BrowserVaultError(data.code, 'Browser vault could not refresh committed state')); return; }
      if (data?.event === 'change') {
        for (const listener of this.listeners) { try { listener(data.paths); } catch (error) { console.error('Browser vault listener failed', error); } }
        return;
      }
      const request = this.pending.get(data?.id);
      if (!request) return;
      this.pending.delete(data.id); clearTimeout(request.timer);
      if (data.ok) request.resolve(data.result);
      else request.reject(new BrowserVaultError(data.error.code, data.error.message, data.error.details, data.error.source));
    };
    this.worker.onerror = () => this.fail(new BrowserVaultError('outcome_unknown', 'Browser worker failed; recover the original intent before retrying'));
    this.worker.onmessageerror = () => this.fail(new BrowserVaultError('outcome_unknown', 'Browser worker response could not be decoded; recover the original intent'));
  }
  static async open(options: BrowserCoreRuntimeOptions): Promise<BrowserCoreRuntime> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.clientId)) throw new BrowserVaultError('invalid_client_identity', 'Fixture client must be a canonical UUID retained across restart');
    if (options.allowNewVault !== true) throw new BrowserVaultError('explicit_vault_required', 'New core vault opening requires explicit opt-in');
    const moduleUrl = new URL(options.wasmModuleUrl, location.href);
    if (moduleUrl.origin !== location.origin) throw new BrowserVaultError('invalid_wasm_url', 'WASM runtime must be a same-origin application asset');
    const runtime = new BrowserCoreRuntime(options);
    try {
      // The worker exclusively claims this authority/client before recovering
      // this named client's pending intents, using Rust
      // receipt lookup, before this Promise exposes a ready adapter.
      const clientId = options.clientId;
      const opened = await runtime.call<{recovery:string[];authorityId:string}>('open', {...options, wasmModuleUrl:moduleUrl.href});
      if (typeof opened.authorityId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(opened.authorityId)) throw new BrowserVaultError('storage_corrupt','Worker returned no valid local storage authority');
      runtime.authorityScope = Object.freeze({vaultId:opened.authorityId,clientId});
      const pageOptions=(input:CheckpointListOptions)=>{
        if(!input || !Number.isInteger(input.limit) || input.limit<1 || input.limit>1000)throw new BrowserVaultError('invalid_checkpoint','Page limit must be 1–1000');
        if(input.cursor!==undefined)boundedUtf8(input.cursor,8192,'invalid_checkpoint_cursor');
        return {limit:input.limit,...(input.cursor===undefined?{}:{cursor:input.cursor})};
      };
      runtime.checkpointProvider=Object.freeze({scope:runtime.authorityScope,
        async load(key:string){checkpointKey(key);return runtime.call<Checkpoint|null>('checkpoint-load',key);},
        async compareAndSwap(input){const {change}=snapshotCheckpointChange(input);return runtime.call<Checkpoint>('checkpoint-cas',change);},
        async list(input:CheckpointListOptions){return runtime.call<CheckpointPage>('checkpoint-list',pageOptions(input));},
        async changes(input:CheckpointChangesOptions){
          const page=pageOptions(input),after=input.after;
          if(typeof after!=='string' || !/^(0|[1-9][0-9]{0,19})$/.test(after))throw new BrowserVaultError('invalid_checkpoint','Invalid checkpoint change sequence');
          return runtime.call<CheckpointPage>('checkpoint-changes',{...page,after});
        },
      } satisfies DurableCheckpoints);
      runtime.recovery = new Set(opened.recovery);
      document.addEventListener('visibilitychange', runtime.visibility);
      return runtime;
    } catch (error) { runtime.close(); throw error; }
  }
  private assertDispatch(operation: string): void {
    if (this.closed) throw new BrowserVaultError('storage_closed', 'Browser worker is closed');
    if (this.releasing && operation !== 'release-client') throw new BrowserVaultError('client_not_admitted', 'Browser consumer is releasing its ownership');
    if (operation !== 'release-client') this.admissionGuard?.();
  }
  /** One owner guard per opened runtime. Checked again after transport queue
   * waits, immediately before posting the request; not only at facade entry. */
  installAdmissionGuard(guard: () => void): void {
    this.assertActive();
    if (this.admissionGuard || typeof guard !== 'function') throw new BrowserVaultError('client_already_admitted', 'Runtime already has a consumer guard');
    this.admissionGuard = guard;
  }
  private call<T>(operation: string, payload?: unknown): Promise<T> {
    let snapshot: unknown;
    try {
      this.assertDispatch(operation);
      // Bound retained structured-clone payloads while the worker is stalled.
      if (this.queuedCalls >= 8) throw new BrowserVaultError('client_queue_full', 'Browser consumer request queue is full; retain the original operation');
      snapshot = structuredClone(payload);
    } catch (error) { return Promise.reject(error); }
    this.queuedCalls++;
    const result = this.dispatchTail.then(() => {
      this.assertDispatch(operation);
      const id = crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The worker might still execute a timed-out request. Terminate and
          // fence all queued calls, rather than advancing behind unknown work.
          this.fail(new BrowserVaultError('outcome_unknown', 'Worker response timed out; recover the exact durable operation in a new runtime', {request_id:id,operation}));
        }, this.timeoutMs);
        this.pending.set(id, {resolve: value => resolve(value as T), reject, timer, operation});
        try { this.worker.postMessage({id, operation, payload:snapshot}); }
        catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
    this.dispatchTail = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.queuedCalls--; });
  }
  private fail(error: BrowserVaultError): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.close();
  }
  assertActive(): void {
    if (this.closed || this.releasing || !this.authorityScope) throw new BrowserVaultError('client_ownership_lost', 'Browser consumer no longer owns its worker');
  }
  /** Call only after the consumer drain and scoped durable flush. An uncertain
   * host reply permits exact release retry while transport is alive. Timeout or
   * worker loss instead requires recovery in a new runtime; never further writes. */
  releaseClient(): Promise<void> {
    if (this.releasePending) return this.releasePending;
    if (this.closed) return Promise.reject(new BrowserVaultError('client_ownership_lost', 'Worker release cannot be confirmed after transport loss'));
    this.releasing = true;
    document.removeEventListener('visibilitychange', this.visibility);
    this.releasePending = this.call<void>('release-client').then(() => this.close())
      .finally(() => { this.releasePending = undefined; });
    return this.releasePending;
  }
  inventory(): Promise<BrowserVaultRead[]> { return this.call('inventory'); }
  readEntry(path: string): Promise<BrowserVaultRead | null> { return this.call('read', path); }
  readEntryById(id:string):Promise<BrowserVaultRead|null>{return this.call('read-id',id);}
  async execute(intentId: string, requestJson: string): Promise<string> {
    await this.prepare(intentId,requestJson);
    return this.commit(intentId);
  }
  /** Inert durable preparation. Consumer must checkpoint identity before commit. */
  async prepare(intentId: string, requestJson: string): Promise<void> {
    if (this.recovery.size && !this.recovery.has(intentId)) throw new BrowserVaultError('recovery_required',
      'Reconcile and acknowledge this client’s recovered intent outcomes before issuing new mutations', {intent_ids:[...this.recovery]});
    await this.call('prepare', {intentId, requestJson});
  }
  /** Explicit authorization: host persists commit_requested before applying. */
  commit(intentId: string): Promise<string> {
    if (this.recovery.size && !this.recovery.has(intentId)) return Promise.reject(new BrowserVaultError('recovery_required',
      'Reconcile recovered outcomes before authorizing another mutation', {intent_ids:[...this.recovery]}));
    return this.call('execute', intentId);
  }
  intents(): Promise<BrowserVaultIntent[]> { return this.call('intents'); }
  async acknowledge(intentId: string, outcome: BrowserVaultOutcome): Promise<void> {
    await this.call('acknowledge',{intentId,outcome}); this.recovery.delete(intentId);
  }
  subscribe(listener: (paths?: readonly string[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void {
    if (this.closed) return;
    this.closed = true; document.removeEventListener('visibilitychange', this.visibility);
    this.worker.terminate(); this.listeners.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new BrowserVaultError('outcome_unknown', 'Worker closed before acknowledgement; original intent retained', {operation:request.operation}));
    }
    this.pending.clear();
  }
}
