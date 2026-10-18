import {createBrowserWorkBlocks,workBlockFailure} from './browser-workblocks.ts';
import type {WorkBlockService} from '../core/workblocks.ts';
import type {BrowserDocumentIndex} from '../core/browser-document-index.ts';
import type { BrowserSyncFixtureCredentials, BrowserSyncSweep } from './browser-sync-worker.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserVaultIntent, BrowserVaultRead, BrowserVaultOutcome } from '../core/browser-vault.ts';
import { BINARY_CHUNK_BYTES, BINARY_FORMAT_FILE_BYTES } from '../core/binary-streams.ts';
import type { BinaryStreams, BinaryStreamLimits, BinaryStageRef, BinaryReadRef } from '../core/binary-streams.ts';
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
  /** Normal local vault: enroll persistent family authority without network credentials. */
  initializeLocal?: boolean;
  /** Explicit reference fixtures only; normal startup never falls back. */
  legacyFixture?:true;
  timeoutMs?: number;
}
type ReadInput=Parameters<BinaryStreams['openRead']>[0];
interface ReadState {version:1;requestedReadId:string;input:ReadInput;phase:'opening'|'opened'|'closing';ref?:BinaryReadRef}
const binaryId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value);
const binaryFailure=(code:string)=>new BrowserVaultError(code,'Browser binary request did not complete; its original identity is retained');
function binaryLength(value:unknown):bigint {if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(value)||BigInt(value)>18446744073709551615n)throw binaryFailure('invalid_binary_length');return BigInt(value);}
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; operation: string }

/** Dedicated worker transport. No native service, filesystem or desktop bridge. */
export class BrowserCoreRuntime implements BrowserCoreBackend {
  private authorityScope?: Readonly<{vaultId:string;clientId:string}>;
  get durableScope(): Readonly<{vaultId:string;clientId:string}> | undefined { return this.authorityScope; }
  private indexProvider?:Omit<BrowserDocumentIndex,'close'>;
  get documentIndex():Omit<BrowserDocumentIndex,'close'>|undefined{return this.indexProvider;}
  private checkpointProvider?: DurableCheckpoints;
  get checkpoints():DurableCheckpoints|undefined{return this.checkpointProvider;}
  private workBlockBinding?:ReturnType<typeof createBrowserWorkBlocks>;
  get workBlocks():WorkBlockService|undefined{return this.workBlockBinding?.service;}
  private binaryCapability?:BinaryStreams;
  get binaryStreams():BinaryStreams|undefined{return this.binaryCapability;}
  private readonly binaryInFlight=new Set<Promise<unknown>>();
  private readonly liveReads=new Map<string,{key:string;ref:BinaryReadRef}>();
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private dispatchTail: Promise<void> = Promise.resolve();
  private queuedCalls = 0;
  private admissionGuard?: () => void;
  private listeners = new Set<(paths?: readonly string[]) => void>();
  private closed = false;
  private releasing = false;
  private workBlockDraining = false;
  private releasePending?: Promise<void>;
  private syncPending?:Promise<BrowserSyncSweep>;
  private syncRevokePending?:Promise<void>;
  private recovery = new Set<string>();
  private timeoutMs: number;
  private readonly legacyFixture:boolean;
  private visibility = () => {
    if (!this.closed && !this.releasing && document.visibilityState === 'visible') void this.call('refresh').catch(error => {
      // Refresh is only a hint. Intentional release may cancel an already queued
      // hint; capacity pressure must not terminate an otherwise healthy writer.
      if (error?.code === 'client_queue_full' || this.releasing && error?.code === 'client_not_admitted') return;
      this.fail(error);
    });
  };
  private constructor(options: BrowserCoreRuntimeOptions) {
    this.legacyFixture=options.legacyFixture===true;
    this.timeoutMs = options.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new BrowserVaultError('invalid_timeout', 'Worker timeout must be 1–120000 milliseconds');
    this.worker = new Worker(new URL('./browser-core-worker.ts', import.meta.url), {type:'module'});
    this.worker.onmessage = ({data}) => {
      if (data?.event === 'storage-error') { this.fail(new BrowserVaultError(data.code, 'Browser vault could not refresh committed state', data.details)); return; }
      if (data?.event === 'change') {
        for (const listener of this.listeners) { try { listener(data.paths); } catch (error) { console.error('Browser vault listener failed', error); } }
        return;
      }
      const request = this.pending.get(data?.id);
      if (!request) return;
      this.pending.delete(data.id); clearTimeout(request.timer);
      if(request.operation==='workblock-command'){
        if(data.ok===true){request.resolve(data.result);return;}
        const error=data?.error;
        request.reject(data.ok===false&&error&&typeof error.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)&&(error.source==='host'||error.source==='rust')&&typeof error.commitUncertain==='boolean'
          ?workBlockFailure(error.code,error.commitUncertain,error.source):workBlockFailure('invalid_workblock_response',true));
      }else if(data.ok)request.resolve(data.result);
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
      const opened = await runtime.call<{recovery:string[];authorityId:string;binaryLimits?:BinaryStreamLimits;documentIndexAvailable?:boolean;workBlocks?:boolean}>('open', {...options, wasmModuleUrl:moduleUrl.href});
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
      if(opened.documentIndexAvailable)runtime.indexProvider=Object.freeze<Omit<BrowserDocumentIndex,'close'>>({
        initialize:()=>runtime.call('document-index-initialize'),discard:id=>runtime.call('document-index-discard',id),
        status:()=>runtime.call('document-index-status'),begin:()=>runtime.call('document-index-begin'),
        pump:id=>runtime.call('document-index-pump',id),publish:id=>runtime.call('document-index-publish',id),
        open:()=>runtime.call('document-index-open'),closePin:id=>runtime.call('document-index-close-pin',id),
        search:input=>runtime.call('document-index-search',structuredClone(input)),
        metadata:input=>runtime.call('document-index-metadata',structuredClone(input)),base:input=>runtime.call('document-index-base',structuredClone(input)),
        resolve:input=>runtime.call('document-index-resolve',structuredClone(input)),
        backlinks:input=>runtime.call('document-index-backlinks',structuredClone(input)),rebuild:()=>runtime.call('document-index-rebuild'),
      });
      if(opened.workBlocks===true)runtime.installWorkBlocks();
      runtime.recovery = new Set(opened.recovery);
      if(opened.binaryLimits){runtime.installBinaryStreams(opened.binaryLimits);await runtime.recoverReadRequests();}
      document.addEventListener('visibilitychange', runtime.visibility);
      return runtime;
    } catch (error) { runtime.close(); throw error; }
  }
  /** Called only after an owner-fenced host readiness acknowledgement. One
   * binding preserves retained mutation identities across sync reconfiguration. */
  private installWorkBlocks():void {
    this.assertDispatch('workblock-command');
    if(this.workBlockBinding)return;
    this.workBlockBinding=createBrowserWorkBlocks(async request=>{
      const reply=await this.call('workblock-command',request);
      try{this.assertDispatch('workblock-command');}catch{throw workBlockFailure('client_ownership_lost',true);}
      return reply;
    });
  }
  private assertDispatch(operation: string): void {
    if (this.closed) throw new BrowserVaultError('storage_closed', 'Browser worker is closed');
    if (this.releasing && operation !== 'release-client' && !(operation==='workblock-command'&&this.workBlockDraining)) throw new BrowserVaultError('client_not_admitted', 'Browser consumer is releasing its ownership');
    if (operation !== 'release-client') this.admissionGuard?.();
  }
  /** One owner guard per opened runtime. Checked again after transport queue
   * waits, immediately before posting the request; not only at facade entry. */
  installAdmissionGuard(guard: () => void): void {
    this.assertActive();
    if (this.admissionGuard || typeof guard !== 'function') throw new BrowserVaultError('client_already_admitted', 'Runtime already has a consumer guard');
    this.admissionGuard = guard;
  }
  private call<T>(operation: string, payload?: unknown, network = false): Promise<T> {
    let snapshot: unknown;
    try {
      this.assertDispatch(operation);
      // Bound retained structured-clone payloads while the worker is stalled.
      if (this.queuedCalls >= 8 && operation !== 'sync-revoke') throw new BrowserVaultError('client_queue_full', 'Browser consumer request queue is full; retain the original operation');
      snapshot = structuredClone(payload);
    } catch (error) { return Promise.reject(error); }
    this.queuedCalls++;
    const binary=operation.startsWith('binary-'),independent=network||binary;
    const result = (independent ? Promise.resolve() : this.dispatchTail).then(() => {
      this.assertDispatch(operation);
      const id = crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The worker might still execute a timed-out request. Terminate and
          // fence all queued calls, rather than advancing behind unknown work.
          this.fail(new BrowserVaultError('outcome_unknown', 'Worker response timed out; recover the exact durable operation in a new runtime', {request_id:id,operation}));
        }, network ? 60_000 : this.timeoutMs);
        this.pending.set(id, {resolve: value => resolve(value as T), reject, timer, operation});
        try {
          const chunk=operation==='binary-append'?(snapshot as {input:{bytes:Uint8Array}}).input.bytes:undefined;
          this.worker.postMessage({id, operation, payload:snapshot},chunk?[chunk.buffer as ArrayBuffer]:[]);
          if(operation==='sync-configure'){const credentials=snapshot as BrowserSyncFixtureCredentials;credentials.keyBytes.fill(0);credentials.bearerToken='';}
        }
        catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
    if (!independent) this.dispatchTail = result.then(() => undefined, () => undefined);
    const tracked=result.finally(() => {
      this.queuedCalls--;
      if(binary)this.binaryInFlight.delete(tracked);
      if(operation==='sync-configure'&&snapshot){const credentials=snapshot as BrowserSyncFixtureCredentials;credentials.keyBytes?.fill(0);credentials.bearerToken='';}
    });
    if(binary)this.binaryInFlight.add(tracked);
    return tracked;
  }
  private binaryActive():void {this.assertDispatch('binary-query');this.assertActive();}
  private boundStage(input:BinaryStageRef):BinaryStageRef {
    const scope=this.authorityScope;
    if(!scope||input?.localStoreId!==scope.vaultId||input.clientId!==scope.clientId||!binaryId(input.operationId)||!binaryId(input.stageId))throw binaryFailure('owner_mismatch');
    return {localStoreId:input.localStoreId,clientId:input.clientId,operationId:input.operationId,stageId:input.stageId};
  }
  private readInput(input:ReadInput):ReadInput {
    if(!input||!binaryId(input.entryId)||input.expectedRevision!==undefined&&!binaryId(input.expectedRevision)||input.expectedContentEvent!==undefined&&!binaryId(input.expectedContentEvent))throw binaryFailure('invalid_request');
    return {entryId:input.entryId,...(input.expectedRevision===undefined?{}:{expectedRevision:input.expectedRevision}),...(input.expectedContentEvent===undefined?{}:{expectedContentEvent:input.expectedContentEvent})};
  }
  private boundRead(input:BinaryReadRef):BinaryReadRef {
    const scope=this.authorityScope;
    if(!scope||input?.localStoreId!==scope.vaultId||input.clientId!==scope.clientId||!binaryId(input.readId)||!binaryId(input.entryId)||!binaryId(input.entryRevision)||!binaryId(input.selectedContentEvent)||binaryLength(input.length)>binaryLength(this.binaryCapability!.limits.maxFileBytes))throw binaryFailure('owner_mismatch');
    return {localStoreId:input.localStoreId,clientId:input.clientId,readId:input.readId,entryId:input.entryId,entryRevision:input.entryRevision,selectedContentEvent:input.selectedContentEvent,length:input.length};
  }
  private async saveRead(head:Checkpoint|null,state:ReadState|null,key:string):Promise<Checkpoint> {
    this.binaryActive();const encodedState=state===null?null:JSON.stringify(state);if(encodedState!==null)boundedUtf8(encodedState,16384,'invalid_binary_checkpoint');
    return this.checkpointProvider!.compareAndSwap({key,expectedRevision:head?.revision??null,nextRevision:crypto.randomUUID(),encodedState});
  }
  private decodeRead(head:Checkpoint):ReadState {
    try{
      if(head.deleted||!head.encodedState||head.vaultId!==this.authorityScope!.vaultId||head.clientId!==this.authorityScope!.clientId)throw 0;
      boundedUtf8(head.encodedState,16384);const state=JSON.parse(head.encodedState) as ReadState;
      if(state.version!==1||!binaryId(state.requestedReadId)||head.key!=='binary-read/v1/'+state.requestedReadId||!['opening','opened','closing'].includes(state.phase)||JSON.stringify(this.readInput(state.input))!==JSON.stringify(state.input))throw 0;
      if(state.ref){const ref=this.boundRead(state.ref);if(JSON.stringify(ref)!==JSON.stringify(state.ref)||ref.entryId!==state.input.entryId||state.input.expectedRevision!==undefined&&ref.entryRevision!==state.input.expectedRevision||state.input.expectedContentEvent!==undefined&&ref.selectedContentEvent!==state.input.expectedContentEvent)throw 0;}
      if(state.phase!=='opening'&&!state.ref)throw 0;return state;
    }catch{throw binaryFailure('invalid_binary_checkpoint');}
  }
  private async recoverReadRequests():Promise<void> {
    let cursor:string|undefined;
    for(let pageNumber=0;pageNumber<100;pageNumber++){
      this.binaryActive();const page=await this.checkpointProvider!.list({limit:100,cursor});
      for(const item of page.items){
        if(item.deleted||!item.key.startsWith('binary-read/v1/'))continue;
        const head=await this.checkpointProvider!.load(item.key);if(!head?.encodedState)continue;const state=this.decodeRead(head);
        if(state.phase==='opened'&&state.ref&&this.liveReads.get(state.ref.readId)?.key===head.key)continue;
        // Closing the original request is idempotent, including a lost open ACK.
        // Never reopen an entry/path to discover a replacement read reference.
        await this.call<void>('binary-close-request',{requestedReadId:state.requestedReadId,input:state.input});
        await this.saveRead(head,null,head.key);if(state.ref)this.liveReads.delete(state.ref.readId);
      }
      if(page.cursor===null)return;cursor=page.cursor;
    }
    throw binaryFailure('binary_read_recovery_limit');
  }
  private installBinaryStreams(input:BinaryStreamLimits):void {
    const limits=Object.freeze({...input});
    if(binaryLength(limits.maxFileBytes)>BigInt(BINARY_FORMAT_FILE_BYTES)||binaryLength(limits.smallReadBytes)>binaryLength(limits.maxFileBytes)||binaryLength(limits.smallReadBytes)>16777216n||!Number.isInteger(limits.maxChunkBytes)||limits.maxChunkBytes<1||limits.maxChunkBytes>BINARY_CHUNK_BYTES)throw binaryFailure('invalid_stream_limits');
    this.binaryCapability=Object.freeze<BinaryStreams>({limits,
      begin:input=>this.call('binary-begin',structuredClone(input)),
      append:(inputRef,input)=>{
        try{const ref=this.boundStage(inputRef);if(!input||!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>limits.maxChunkBytes||!Number.isInteger(input.sequence)||input.sequence<0||input.sequence>0xffffffff||binaryLength(input.offset)>binaryLength(limits.maxFileBytes))throw binaryFailure('request_limit');
          return this.call('binary-append',{ref,input:{sequence:input.sequence,offset:input.offset,bytes:input.bytes.slice()}});
        }catch(error){return Promise.reject(error);}
      },
      query:ref=>{try{return this.call('binary-query',this.boundStage(ref));}catch(error){return Promise.reject(error);}},
      seal:(ref,input)=>{try{return this.call('binary-seal',{ref:this.boundStage(ref),input:structuredClone(input)});}catch(error){return Promise.reject(error);}},
      commit:ref=>{try{return this.call('binary-commit',this.boundStage(ref));}catch(error){return Promise.reject(error);}},
      abort:ref=>{try{return this.call('binary-abort',this.boundStage(ref));}catch(error){return Promise.reject(error);}},
      openRead:async input=>{
        const captured=this.readInput(input);await this.recoverReadRequests();this.binaryActive();
        const state:ReadState={version:1,requestedReadId:crypto.randomUUID(),input:captured,phase:'opening'},key='binary-read/v1/'+state.requestedReadId;
        let head=await this.saveRead(null,state,key);
        const ref=this.boundRead(await this.call<BinaryReadRef>('binary-open-read',{requestedReadId:state.requestedReadId,input:captured}));this.binaryActive();
        if(ref.entryId!==captured.entryId||captured.expectedRevision!==undefined&&ref.entryRevision!==captured.expectedRevision||captured.expectedContentEvent!==undefined&&ref.selectedContentEvent!==captured.expectedContentEvent)throw binaryFailure('invalid_binary_response');
        head=await this.saveRead(head,{...state,phase:'opened',ref},key);this.binaryActive();this.liveReads.set(ref.readId,{key,ref});return {...ref};
      },
      read:async(inputRef,input)=>{
        const ref=this.boundRead(inputRef);if(!input||!Number.isInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>limits.maxChunkBytes||binaryLength(input.offset)>binaryLength(ref.length))throw binaryFailure('request_limit');
        const captured={offset:input.offset,maxBytes:input.maxBytes};
        const part=await this.call<Awaited<ReturnType<BinaryStreams['read']>>>('binary-read',{ref,input:captured});this.binaryActive();
        if(!(part.bytes instanceof Uint8Array)||part.bytes.length>captured.maxBytes||part.nextOffset!==String(binaryLength(captured.offset)+BigInt(part.bytes.length))||binaryLength(part.nextOffset)>binaryLength(ref.length)||part.eof!==(part.nextOffset===ref.length)||!part.bytes.length&&!part.eof)throw binaryFailure('invalid_binary_response');
        return {bytes:part.bytes.slice(),nextOffset:part.nextOffset,eof:part.eof};
      },
      closeRead:async input=>{
        const ref=this.boundRead(input),live=this.liveReads.get(ref.readId);if(!live||JSON.stringify(live.ref)!==JSON.stringify(ref))throw binaryFailure('read_checkpoint_missing');
        let head=await this.checkpointProvider!.load(live.key);
        if(!head?.encodedState){if(head?.deleted){this.liveReads.delete(ref.readId);return;}throw binaryFailure('invalid_binary_checkpoint');}
        const state=this.decodeRead(head);if(!state.ref||JSON.stringify(state.ref)!==JSON.stringify(ref))throw binaryFailure('owner_mismatch');
        if(state.phase!=='closing')head=await this.saveRead(head,{...state,phase:'closing'},head.key);
        await this.call<void>('binary-close-read',ref);await this.saveRead(head,null,head.key);this.liveReads.delete(ref.readId);
      },
    });
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
    this.workBlockBinding?.stop();
    this.releasing=true;this.workBlockDraining=true;
    document.removeEventListener('visibilitychange', this.visibility);
    this.releasePending = (async()=>{await this.workBlockBinding?.drain();this.workBlockDraining=false;while(this.binaryInFlight.size)await Promise.allSettled([...this.binaryInFlight]);await this.call<void>('release-client');this.close();})()
      .finally(() => { this.releasePending = undefined; });
    return this.releasePending;
  }
  /** Explicit synthetic session only; key/token stay in worker memory until revoke/close. */
  configureSyncFixture(credentials:BrowserSyncFixtureCredentials):Promise<void> {
    if(!credentials || !(credentials.keyBytes instanceof Uint8Array)||credentials.keyBytes.length!==32||
      typeof credentials.endpoint!=='string'||credentials.endpoint.length>2048||typeof credentials.bearerToken!=='string'||credentials.bearerToken.length>4096||
      ![credentials.realmId,credentials.vaultId,credentials.serverEpoch].every(value=>typeof value==='string'&&value.length<=128))
      return Promise.reject(new BrowserVaultError('invalid_sync_credentials','Invalid fixture sync credentials'));
    const enrollEmpty=credentials.enrollEmpty===true;
    return this.call<{workBlocks:boolean}|undefined>('sync-configure',credentials,true).then(async ready=>{
      this.assertDispatch('sync-configure');
      // An old unregistered fixture can acknowledge without capability metadata.
      // Only the exact positive H marker can install a service.
      if(ready!==undefined&&(!ready||typeof ready.workBlocks!=='boolean'))throw workBlockFailure('invalid_workblock_response');
      if(enrollEmpty&&!this.legacyFixture&&!this.binaryCapability){
        const limits=await this.call<BinaryStreamLimits>('binary-limits');this.binaryActive();
        this.installBinaryStreams(limits);await this.recoverReadRequests();
      }
      this.assertDispatch('sync-configure');
      if(ready?.workBlocks===true)this.installWorkBlocks();
    });
  }
  syncOnce():Promise<BrowserSyncSweep> {
    if(this.syncPending)return this.syncPending;
    this.syncPending=this.call<BrowserSyncSweep>('sync-once',undefined,true).finally(()=>{this.syncPending=undefined;});return this.syncPending;
  }
  revokeSync():Promise<void> {
    if(this.syncRevokePending)return this.syncRevokePending;
    this.syncRevokePending=this.call<void>('sync-revoke',undefined,true).finally(()=>{this.syncRevokePending=undefined;});return this.syncRevokePending;
  }
  inventory(): Promise<BrowserVaultRead[]> { return this.call('inventory'); }
  readEntry(path: string): Promise<BrowserVaultRead | null> { return this.call('read', path); }
  readEntryById(id:string):Promise<BrowserVaultRead|null>{return this.call('read-id',id);}
  readMetadata(path:string):Promise<BrowserVaultRead|null>{return this.call(this.legacyFixture?'read':'read-metadata',path);}
  readMetadataById(id:string):Promise<BrowserVaultRead|null>{return this.call(this.legacyFixture?'read-id':'read-metadata-id',id);}
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
  /** Persist the shared Rust FamilyCommand unchanged before explicit commit authorization. */
  async prepareFamily(intentId:string,commandJson:string):Promise<void> {
    if(this.recovery.size&&!this.recovery.has(intentId))throw new BrowserVaultError('recovery_required','Reconcile recovered outcomes before new family mutations');
    boundedUtf8(commandJson,32*1024*1024,'sync_input_too_large');
    await this.call('prepare-family',{intentId,commandJson});
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
    this.workBlockBinding?.stop();
    this.closed = true; document.removeEventListener('visibilitychange', this.visibility);
    this.worker.terminate(); this.listeners.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new BrowserVaultError('outcome_unknown', 'Worker closed before acknowledgement; original intent retained', {operation:request.operation}));
    }
    this.pending.clear();
  }
}
