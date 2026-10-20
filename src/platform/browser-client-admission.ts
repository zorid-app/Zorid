import {DocumentPreviewError,type DocumentPreviewTransport} from '../core/document-preview.ts';
import {DocumentDraftError,type DocumentDraftTransport} from '../core/document-drafts.ts';
import type {WorkBlockService} from '../core/workblocks.ts';
import {workBlockFailure} from './browser-workblocks.ts';
import type {DocumentRuntimeTransport} from '../core/document-runtime.ts';
import type {BrowserDocumentIndexProvider} from './browser-core.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import type { CheckpointScope, DurableCheckpoints } from '../core/durable-checkpoints.ts';
import type { DurableWrites } from '../core/durable-writes.ts';
import type { BrowserCoreRuntime } from './browser-core-runtime.ts';
import type { BrowserCoreBackend } from './browser-core.ts';
import type { BinaryStreams } from '../core/binary-streams.ts';
import {scheduleBinaryTransfer} from '../core/binary-transfer-queue.ts';
import { createBrowserBinaryCommands } from './browser-binary-commands.ts';
import { browserDurableWrites } from './browser-durable-writes.ts';
import { createBrowserFileCommands } from './browser-file-commands.ts';
import type { BrowserFileCommandInput } from './browser-file-commands.ts';

export interface BrowserFlushContext {
  readonly scope: CheckpointScope;
  readonly durableWrites: DurableWrites;
  assertActive(): void;
}
export interface BrowserClientContext extends BrowserFlushContext {
  readonly documentIndex?:BrowserDocumentIndexProvider;
  readonly binaryStreams?:BinaryStreams;
  readonly workBlocks?:WorkBlockService;
  fileCommand?(input:BrowserFileCommandInput):Promise<void>;
  recoverCommands?():Promise<boolean>;
  release(flushGate: (context: BrowserFlushContext) => void | Promise<void>): Promise<void>;
}
const admittedRuntimes = new WeakSet<BrowserCoreRuntime>();
const failure = (code: string) => new BrowserVaultError(code, 'Browser fixture consumer is not admitted');

/** Scope comes from the lock-owning worker. The platform owner selects and
 * persists a tab slot before admission, then drains/flushes before release. */
export function admitBrowserClient(runtime: BrowserCoreRuntime,
  options: { assertOwner: () => void }): BrowserClientContext {
  if (typeof options?.assertOwner !== 'function') throw failure('invalid_admission');
  if (admittedRuntimes.has(runtime)) throw failure('client_already_admitted');
  let flushToken: symbol | undefined;
  let phase: 'active' | 'flushing' | 'releasing' | 'release_unknown' | 'released' = 'active';
  let closing: Promise<void> | undefined, flushed = false;
  const pending = new Set<Promise<unknown>>();
  const assertOwner = options.assertOwner;
  function live() { runtime.assertActive(); assertOwner(); }
  live();
  const authoritative = runtime.durableScope;
  if (!authoritative || !runtime.checkpoints) throw failure('client_scope_mismatch');
  const provider = runtime.checkpoints;
  if (provider.scope.vaultId !== authoritative.vaultId || provider.scope.clientId !== authoritative.clientId) throw failure('client_scope_mismatch');
  const scope = Object.freeze({ vaultId: authoritative.vaultId, clientId: authoritative.clientId });
  // A broken positive capability must not become a legacy parser fallback.
  const metadataProvider=runtime.documentIndex;
  if(metadataProvider?.basePreviewAvailable===true&&![metadataProvider.previewOpen,metadataProvider.previewBase,metadataProvider.previewClose].every(method=>typeof method==='function'))throw new DocumentPreviewError();
  if(metadataProvider?.draftsAvailable===true&&(!metadataProvider.drafts||typeof metadataProvider.drafts.invoke!=='function'||typeof metadataProvider.drafts.subscribe!=='function'||metadataProvider.drafts.scope?.localStoreId!==scope.vaultId||metadataProvider.drafts.scope?.clientId!==scope.clientId))throw new DocumentDraftError('document_runtime_unavailable');
  if(metadataProvider?.metadataRowsAvailable===true&&typeof metadataProvider.metadataRows!=='function')throw failure('invalid_document_response');
  // Every underlying RPC rechecks the captured owner after provider awaits.
  function dispatch<T>(action: () => T): T {
    if (phase !== 'active' && phase !== 'flushing') throw failure('client_not_admitted');
    live(); return action();
  }
  const checkpoints = Object.freeze<DurableCheckpoints>({ scope,
    load: key => dispatch(() => provider.load(key)),
    compareAndSwap: input => dispatch(() => provider.compareAndSwap(input)),
    list: input => dispatch(() => provider.list(input)),
    changes: input => dispatch(() => provider.changes(input)),
  });
  const backend: BrowserCoreBackend = {
    durableScope: scope, checkpoints,
    ...(runtime.documentIndex?{documentIndex:Object.freeze({
      ...(metadataProvider?.basePreviewAvailable===true?{basePreviewAvailable:true,...guardPreview(metadataProvider as BrowserDocumentIndexProvider&DocumentPreviewTransport,async action=>dispatch(action),()=>dispatch(()=>undefined))}:{}),
      ...(metadataProvider?.draftsAvailable===true?{draftsAvailable:true,drafts:guardDrafts(metadataProvider.drafts!,async action=>dispatch(action),()=>dispatch(()=>undefined))}:{}),
      ...(metadataProvider?.metadataRowsAvailable===true?{metadataRowsAvailable:true,metadataRows:(input:Parameters<NonNullable<BrowserDocumentIndexProvider['metadataRows']>>[0])=>dispatch(()=>metadataProvider.metadataRows!(input))}:{}),
      ...(runtime.documentIndex!.maintenance?{maintenance:guardMaintenance(runtime.documentIndex!.maintenance,async action=>dispatch(action),()=>dispatch(()=>undefined))}:{}),
      initialize:()=>dispatch(()=>runtime.documentIndex!.initialize()),discard:(id:string)=>dispatch(()=>runtime.documentIndex!.discard(id)),
      status:()=>dispatch(()=>runtime.documentIndex!.status()),begin:()=>dispatch(()=>runtime.documentIndex!.begin()),
      pump:(id:string)=>dispatch(()=>runtime.documentIndex!.pump(id)),publish:(id:string)=>dispatch(()=>runtime.documentIndex!.publish(id)),
      open:()=>dispatch(()=>runtime.documentIndex!.open()),closePin:(id:string)=>dispatch(()=>runtime.documentIndex!.closePin(id)),
      search:(input:Parameters<NonNullable<typeof runtime.documentIndex>['search']>[0])=>dispatch(()=>runtime.documentIndex!.search(input)),
      richStart:(input:Parameters<NonNullable<typeof runtime.documentIndex>['richStart']>[0])=>dispatch(()=>runtime.documentIndex!.richStart(input)),
      richPrepare:(input:Parameters<NonNullable<typeof runtime.documentIndex>['richPrepare']>[0])=>dispatch(()=>runtime.documentIndex!.richPrepare(input)),
      richPage:(input:Parameters<NonNullable<typeof runtime.documentIndex>['richPage']>[0])=>dispatch(()=>runtime.documentIndex!.richPage(input)),
      richClose:(input:Parameters<NonNullable<typeof runtime.documentIndex>['richClose']>[0])=>dispatch(()=>runtime.documentIndex!.richClose(input)),
      metadata:(input:Parameters<NonNullable<typeof runtime.documentIndex>['metadata']>[0])=>dispatch(()=>runtime.documentIndex!.metadata(input)),
      tasks:(input:Parameters<NonNullable<typeof runtime.documentIndex>['tasks']>[0])=>dispatch(()=>runtime.documentIndex!.tasks(input)),
      base:(input:Parameters<NonNullable<typeof runtime.documentIndex>['base']>[0])=>dispatch(()=>runtime.documentIndex!.base(input)),
      resolve:(input:Parameters<NonNullable<typeof runtime.documentIndex>['resolve']>[0])=>dispatch(()=>runtime.documentIndex!.resolve(input)),
      backlinks:(input:Parameters<NonNullable<typeof runtime.documentIndex>['backlinks']>[0])=>dispatch(()=>runtime.documentIndex!.backlinks(input)),
      rebuild:()=>dispatch(()=>runtime.documentIndex!.rebuild()),
    })}:{}),
    inventory: () => dispatch(() => runtime.inventory()),
    readEntry: path => dispatch(() => runtime.readEntry(path)),
    readEntryById: id => dispatch(() => runtime.readEntryById(id)),
    ...(typeof runtime.readMetadata==='function'?{readMetadata:(path:string)=>dispatch(()=>runtime.readMetadata(path))}:{}),
    ...(typeof runtime.readMetadataById==='function'?{readMetadataById:(id:string)=>dispatch(()=>runtime.readMetadataById(id))}:{}),
    execute: (id, json) => dispatch(() => runtime.execute(id, json)),
    prepare: (id, json) => dispatch(() => runtime.prepare(id, json)),
    ...(typeof runtime.prepareFamily==='function'?{prepareFamily:(id:string,json:string)=>dispatch(()=>runtime.prepareFamily(id,json))}:{}),
    commit: id => dispatch(() => runtime.commit(id)),
    intents: () => dispatch(() => runtime.intents()),
    acknowledge: (id, outcome) => dispatch(() => runtime.acknowledge(id, outcome)),
    subscribe: listener => dispatch(() => runtime.subscribe(listener)),
    close: () => runtime.close(),
  };
  const capability = browserDurableWrites(backend, scope, () => phase === 'released');
  function allowed(token?: symbol) {
    if (phase !== (token ? 'flushing' : 'active') || token && token !== flushToken) throw failure('client_not_admitted');
    live();
  }
  function invoke<T>(action: () => Promise<T>, token?: symbol): Promise<T> {
    try {
      allowed(token);
      const result = action(); // Snapshot provider arguments before the first await.
      const tracked = Promise.resolve(result).finally(() => pending.delete(tracked));
      pending.add(tracked); return tracked;
    } catch (error) { return Promise.reject(error); }
  }
  function wrap(token?: symbol): DurableWrites {
    return Object.freeze<DurableWrites>({
      readText: path => invoke(() => capability.readText(path), token),
      readTextById: id => invoke(() => capability.readTextById(id), token),
      planWrite: input => invoke(() => capability.planWrite(input), token),
      prepare: plan => invoke(() => capability.prepare(plan), token),
      commit: ref => invoke(() => capability.commit(ref), token),
      query: ref => invoke(() => capability.query(ref), token),
      listUnacknowledged: () => invoke(() => capability.listUnacknowledged(), token),
      acknowledge: (ref, outcome) => invoke(() => capability.acknowledge(ref, outcome), token),
      checkpoints: Object.freeze<DurableCheckpoints>({ scope,
        load: key => invoke(() => checkpoints.load(key), token),
        compareAndSwap: input => invoke(() => checkpoints.compareAndSwap(input), token),
        list: input => invoke(() => checkpoints.list(input), token),
        changes: input => invoke(() => checkpoints.changes(input), token),
      }),
    });
  }
  const durableWrites = wrap();
  const commands=backend.prepareFamily?createBrowserFileCommands({
    checkpoints,readEntry:path=>backend.readEntry(path),...(backend.readMetadata?{readMetadata:(path:string)=>backend.readMetadata!(path)}:{}),prepareFamily:backend.prepareFamily,
    commit:id=>backend.commit!(id),intents:()=>backend.intents(),acknowledge:(id,outcome)=>backend.acknowledge(id,outcome),
  },()=>dispatch(()=>undefined)):undefined;
  const raw=runtime.binaryStreams;
  const binary=raw?createBrowserBinaryCommands({backend:{
    limits:raw.limits,
    begin:input=>dispatch(()=>raw.begin(input)),append:(ref,input)=>dispatch(()=>raw.append(ref,input)),
    query:ref=>dispatch(()=>raw.query(ref)),seal:(ref,input)=>dispatch(()=>raw.seal(ref,input)),
    commit:ref=>dispatch(()=>raw.commit(ref)),abort:ref=>dispatch(()=>raw.abort(ref)),
    openRead:input=>dispatch(()=>raw.openRead(input)),read:(ref,input)=>dispatch(()=>raw.read(ref,input)),closeRead:ref=>dispatch(()=>raw.closeRead(ref)),
  },scope,checkpoints,assertActive:()=>dispatch(()=>undefined)}):undefined;
  const binaryStreams=binary?Object.freeze<BinaryStreams>({limits:binary.streams.limits,
    begin:input=>invoke(()=>binary.streams.begin(input)),append:(ref,input)=>invoke(()=>binary.streams.append(ref,input)),
    query:ref=>invoke(()=>binary.streams.query(ref)),seal:(ref,input)=>invoke(()=>binary.streams.seal(ref,input)),
    commit:ref=>invoke(()=>binary.streams.commit(ref)),abort:ref=>invoke(()=>binary.streams.abort(ref)),
    openRead:input=>invoke(()=>binary.streams.openRead(input)),read:(ref,input)=>invoke(()=>binary.streams.read(ref,input)),closeRead:ref=>invoke(()=>binary.streams.closeRead(ref)),
  }):undefined;
  const documentIndex=backend.documentIndex?Object.freeze<BrowserDocumentIndexProvider>({
    ...(backend.documentIndex.basePreviewAvailable===true?{basePreviewAvailable:true,...guardPreview(backend.documentIndex as BrowserDocumentIndexProvider&DocumentPreviewTransport,action=>invoke(action),()=>dispatch(()=>undefined))}:{}),
    ...(backend.documentIndex.draftsAvailable===true?{draftsAvailable:true,drafts:guardDrafts(backend.documentIndex.drafts!,action=>invoke(action),()=>dispatch(()=>undefined))}:{}),
    ...(backend.documentIndex.metadataRowsAvailable===true?{metadataRowsAvailable:true,metadataRows:(input:Parameters<NonNullable<BrowserDocumentIndexProvider['metadataRows']>>[0])=>invoke(()=>backend.documentIndex!.metadataRows!(input))}:{}),
    ...(backend.documentIndex.maintenance?{maintenance:guardMaintenance(backend.documentIndex.maintenance,action=>invoke(action),()=>allowed())}:{}),
    initialize:()=>invoke(()=>backend.documentIndex!.initialize()),discard:id=>invoke(()=>backend.documentIndex!.discard(id)),
    status:()=>invoke(()=>backend.documentIndex!.status()),begin:()=>invoke(()=>backend.documentIndex!.begin()),
    pump:id=>invoke(()=>backend.documentIndex!.pump(id)),publish:id=>invoke(()=>backend.documentIndex!.publish(id)),
    open:()=>invoke(()=>backend.documentIndex!.open()),closePin:id=>invoke(()=>backend.documentIndex!.closePin(id)),
    tasks:input=>invoke(()=>backend.documentIndex!.tasks(input)),
    metadata:input=>invoke(()=>backend.documentIndex!.metadata(input)),base:input=>invoke(()=>backend.documentIndex!.base(input)),
    search:input=>invoke(()=>backend.documentIndex!.search(input)),resolve:input=>invoke(()=>backend.documentIndex!.resolve(input)),
    richStart:input=>invoke(()=>backend.documentIndex!.richStart(input)),
    richPrepare:input=>invoke(()=>backend.documentIndex!.richPrepare(input)),
    richPage:input=>invoke(()=>backend.documentIndex!.richPage(input)),
    richClose:input=>invoke(()=>backend.documentIndex!.richClose(input)),
    backlinks:input=>invoke(()=>backend.documentIndex!.backlinks(input)),rebuild:()=>invoke(()=>backend.documentIndex!.rebuild()),
  }):undefined;
  let workBlocks:WorkBlockService|undefined;
  function workBlock<T>(action:()=>Promise<T>,mutation=false):Promise<T>{
    return invoke(async()=>{const value=await action();try{live();}catch{throw workBlockFailure('client_ownership_lost',mutation);}return value;});
  }
  function admittedWorkBlocks():WorkBlockService|undefined{
    if(workBlocks)return workBlocks;
    const rawWorkBlocks=runtime.workBlocks;
    if(!rawWorkBlocks)return;
    allowed();
    workBlocks=Object.freeze<WorkBlockService>({
    create:i=>workBlock(()=>rawWorkBlocks.create(i),true),read:i=>workBlock(()=>rawWorkBlocks.read(i)),windowPage:i=>workBlock(()=>rawWorkBlocks.windowPage(i)),
    move:i=>workBlock(()=>rawWorkBlocks.move(i),true),title:i=>workBlock(()=>rawWorkBlocks.title(i),true),addRef:i=>workBlock(()=>rawWorkBlocks.addRef(i),true),
    removeRef:i=>workBlock(()=>rawWorkBlocks.removeRef(i),true),delete:i=>workBlock(()=>rawWorkBlocks.delete(i),true),changes:i=>workBlock(()=>rawWorkBlocks.changes(i)),
    });
    return workBlocks;
  }
  runtime.installAdmissionGuard(() => dispatch(() => undefined));
  admittedRuntimes.add(runtime);
  async function drain() { while (pending.size) await Promise.allSettled([...pending]); }
  return Object.freeze({ scope, durableWrites, ...(documentIndex?{documentIndex}:{}), assertActive: () => allowed(),
    ...(commands?{fileCommand:(input:BrowserFileCommandInput)=>invoke(()=>commands.execute(input))}:{}),
    ...(binaryStreams?{binaryStreams}:{}),
    get workBlocks(){return admittedWorkBlocks();},
    ...(commands||binary?{recoverCommands:()=>invoke(async()=>{const files=commands?await commands.recover():false;const stages=binary&&binaryStreams?await scheduleBinaryTransfer(binaryStreams,()=>binary.recover()):false;return files||stages;})}:{}),
    release(flushGate: (context: BrowserFlushContext) => void | Promise<void>): Promise<void> {
      if (phase === 'released') return Promise.resolve();
      if (closing) return closing;
      if (typeof flushGate !== 'function') return Promise.reject(failure('flush_gate_required'));
      if (phase !== 'active' && phase !== 'release_unknown') return Promise.reject(failure('client_not_admitted'));
      const retry = phase === 'release_unknown' && flushed;
      phase = retry ? 'releasing' : 'flushing';
      closing = (async () => {
        if (!retry) {
          try {
            await drain();
            const token = Symbol('flush'); flushToken = token;
            const flushContext = Object.freeze({scope, durableWrites:wrap(token), assertActive:()=>allowed(token)});
            let gateFailed = false, gateError: unknown;
            try {
              const result = flushGate(flushContext);
              if (result && typeof result.then === 'function') await result;
            } catch (error) { gateFailed = true; gateError = error; }
            finally { flushToken = undefined; }
            // Revoke new flush calls immediately, but keep accepted operations
            // admitted until their later RPCs settle, even when the gate failed.
            await drain();
            if (gateFailed) throw gateError;
            live(); flushed = true;
          } catch (error) { phase = 'active'; throw error; }
        }
        phase = 'releasing';
        try { await runtime.releaseClient(); phase = 'released'; }
        catch (error) { phase = 'release_unknown'; throw error; }
      })().finally(() => { closing = undefined; });
      return closing;
    },
  });
}

/** Explicit fixture entry remains available for reproducible bounded fixtures. */
export function admitBrowserFixtureClient(runtime:BrowserCoreRuntime,options:{fixture:true;assertOwner:()=>void}):BrowserClientContext{
  if(options?.fixture!==true)throw failure('invalid_admission');
  return admitBrowserClient(runtime,options);
}

/** Preserve the complete positive transport through both reconstruction layers.
 * ACK calls finish on the RPC tail; the facade's final result never joins it. */
function guardMaintenance(raw:DocumentRuntimeTransport,perform:<T>(action:()=>Promise<T>)=>Promise<T>,guard:()=>void):DocumentRuntimeTransport {
  const call=<T>(action:()=>Promise<T>)=>perform(async()=>{const value=await action();guard();return value;});
  return Object.freeze<DocumentRuntimeTransport>({scope:raw.scope,
    allocateSequence:()=>{guard();return raw.allocateSequence();},allocateRequestId:()=>{guard();return raw.allocateRequestId();},
    observe:()=>call(()=>raw.observe()),control:input=>call(()=>raw.control(input)),
    ackControl:input=>call(()=>raw.ackControl(input)),ackOutcome:input=>call(()=>raw.ackOutcome(input)),
    subscribe:(receiver,onRetire)=>{guard();return raw.subscribe(()=>{try{guard();}catch{return;}receiver();},onRetire);},
  });
}

/** Each reconstruction keeps the actual leased scope and fences both fulfilment
 * and rejection after provider awaits. Accepted calls join the consumer drain. */
function guardDrafts(raw:DocumentDraftTransport,perform:<T>(action:()=>Promise<T>)=>Promise<T>,guard:()=>void):DocumentDraftTransport {
  return Object.freeze<DocumentDraftTransport>({scope:raw.scope,
    invoke:(request,bytes)=>perform(async()=>{try{return await raw.invoke(request,bytes);}finally{guard();}}),
    subscribe:(receiver,onRetire)=>{guard();return raw.subscribe(()=>{try{guard();}catch{return;}receiver();},onRetire);},
  });
}

function guardPreview(raw:DocumentPreviewTransport,perform:<T>(action:()=>Promise<T>)=>Promise<T>,guard:()=>void):DocumentPreviewTransport{
  const call=<T>(action:()=>Promise<T>)=>perform(async()=>{try{return await action();}finally{guard();}});
  return Object.freeze<DocumentPreviewTransport>({previewOpen:input=>call(()=>raw.previewOpen(input)),previewBase:input=>call(()=>raw.previewBase(input)),previewClose:input=>call(()=>raw.previewClose(input))});
}
