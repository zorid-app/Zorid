import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserVaultIntent, BrowserVaultRead, BrowserVaultOutcome } from '../core/browser-vault.ts';
import type { BrowserCoreBackend } from './browser-core.ts';

export interface BrowserCoreRuntimeOptions {
  database: string;
  /** Stable for reload recovery of this tab incarnation; never shared across tabs. */
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
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(paths?: readonly string[]) => void>();
  private closed = false;
  private recovery = new Set<string>();
  private timeoutMs: number;
  private visibility = () => { if (!this.closed && document.visibilityState === 'visible') void this.call('refresh').catch(error => this.fail(error)); };
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
    if (options.allowNewVault !== true) throw new BrowserVaultError('explicit_vault_required', 'New core vault opening requires explicit opt-in');
    const moduleUrl = new URL(options.wasmModuleUrl, location.href);
    if (moduleUrl.origin !== location.origin) throw new BrowserVaultError('invalid_wasm_url', 'WASM runtime must be a same-origin application asset');
    const runtime = new BrowserCoreRuntime(options);
    try {
      // The worker recovers only this named client's pending intents, using Rust
      // receipt lookup, before this Promise exposes a ready adapter.
      const clientId = options.clientId;
      const opened = await runtime.call<{recovery:string[];authorityId:string}>('open', {...options, wasmModuleUrl:moduleUrl.href});
      if (typeof opened.authorityId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(opened.authorityId)) throw new BrowserVaultError('storage_corrupt','Worker returned no valid local storage authority');
      runtime.authorityScope = Object.freeze({vaultId:opened.authorityId,clientId});
      runtime.recovery = new Set(opened.recovery);
      document.addEventListener('visibilitychange', runtime.visibility);
      return runtime;
    } catch (error) { runtime.close(); throw error; }
  }
  private call<T>(operation: string, payload?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserVaultError('storage_closed', 'Browser worker is closed'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserVaultError('outcome_unknown', 'Worker response timed out; exact prepared intent remains recoverable', {request_id:id, operation}));
      }, this.timeoutMs);
      this.pending.set(id, {resolve: value => resolve(value as T), reject, timer, operation});
      try { this.worker.postMessage({id, operation, payload}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: BrowserVaultError): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.close();
  }
  inventory(): Promise<BrowserVaultRead[]> { return this.call('inventory'); }
  readEntry(path: string): Promise<BrowserVaultRead | null> { return this.call('read', path); }
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
