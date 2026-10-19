import {openBrowserStreamingVault} from '../core/browser-streaming-vault.ts';
import type {BrowserStreamingVault,BrowserStreamingVaultOptions} from '../core/browser-streaming-vault.ts';
import type {BinaryStreams} from '../core/binary-streams.ts';
import {createBrowserDocumentRuntimeHost,createBrowserDocumentRuntimeChannel} from './browser-document-runtime-host.ts';
import { BrowserSyncWorker } from './browser-sync-worker.ts';
import type { BrowserSyncCodec } from './browser-sync-worker.ts';
import { openBrowserVault, BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserVault, BrowserVaultWasm } from '../core/browser-vault.ts';
import { afterDurableCommit } from './browser-core-events.ts';
import { claimBrowserClient } from './browser-client-lease.ts';
import type { BrowserClientLease } from './browser-client-lease.ts';
import { createBrowserManagedRecordsHost } from './browser-managed-records-host.ts';
import { createBrowserManagedRecordConsumers } from './browser-managed-records-registry.ts';
import { createBrowserWorkBlocksHost } from './browser-workblocks-host.ts';
import type { BrowserWorkBlocksWasm } from './browser-workblocks-host.ts';

// DOM builds and worker builds share this file without mixing lib.dom/lib.webworker.
const port = self as unknown as {onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void};
let vault: BrowserVault | undefined, clientId = '', channel: BroadcastChannel | undefined;
let sequence = '0', queue: Promise<unknown> = Promise.resolve();
let recovery = new Set<string>();
let lease: BrowserClientLease | undefined, released = false;
let sync:BrowserSyncWorker|undefined;
let storageFailed=false,closing=false;
let binary:BinaryStreams|undefined;
let managed:ReturnType<typeof createBrowserManagedRecordsHost>|undefined;
let workBlocks:ReturnType<typeof createBrowserWorkBlocksHost>|undefined;
let documentRuntime:ReturnType<typeof createBrowserDocumentRuntimeHost>|undefined;
let documentChannel:ReturnType<typeof createBrowserDocumentRuntimeChannel>|undefined;
const assertManagedActive=()=>{assertOwner();if(closing)throw new BrowserVaultError('client_not_admitted','Browser client is releasing');};
let releasingCleanup=false;
const assertVaultActive=()=>{assertOwner();if(closing&&!releasingCleanup)throw new BrowserVaultError('client_not_admitted','Browser client is releasing');};
const detached=new Set<Promise<unknown>>();
const streaming=()=>vault&&'validateStorage'in vault?vault as BrowserStreamingVault:undefined;
function storageDiagnostic(details:unknown):Record<string,string|boolean>|undefined {
  if(!details||typeof details!=='object'||Array.isArray(details))return;
  const row=details as Record<string,unknown>,names=new Set(['index_capture_inventory','index_capture_descriptor','index_source_presentation','index_source_inline','index_source_mode','index_source_text_commitment']);
  if(typeof row.invariant!=='string'||!names.has(row.invariant))return;
  const result:Record<string,string|boolean>={invariant:row.invariant};
  if(typeof row.entryId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(row.entryId))result.entryId=row.entryId;
  for(const key of ['normal','sameEntry','samePresentation','textMode','binaryMode','hasInline','lengthMatches','identityMatches','revisionMatches','digestArray'])if(typeof row[key]==='boolean')result[key]=row[key];
  return result;
}
function failStorage(code:string,details?:unknown):void {
  if(closing||storageFailed||!['storage_closed','storage_corrupt','client_ownership_lost'].includes(code))return;
  storageFailed=true;documentRuntime?.retire();workBlocks?.stop();managed?.stop();sync?.revoke();channel?.close();vault?.close();
  try{const diagnostic=storageDiagnostic(details);port.postMessage({event:'storage-error',code,...(diagnostic?{details:diagnostic}:{})});}catch{/* Worker transport already failed. */}
}
function local<T>(operation:()=>Promise<T>):Promise<T> {
  const result=queue.catch(()=>undefined).then(()=>{assertOwner();return operation();});
  queue=result.catch(()=>undefined);return result;
}
function assertOwner(): void {
  if (released || storageFailed || !lease) throw new BrowserVaultError('client_ownership_lost', 'Worker no longer owns this consumer');
  lease.assertActive();
}
async function refresh(assertSession?:()=>void): Promise<void> {
  if (!vault || released) return;
  assertOwner();
  const next = await vault.changesSince(sequence);
  assertOwner();
  assertSession?.();
  if (next.sequence !== sequence) { port.postMessage({event:'change',paths:next.paths}); sequence = next.sequence; documentRuntime?.sourceHint(); }
  void managed?.trigger();
}
async function execute(intentId: string): Promise<string> {
  const receipt = await vault!.executeIntent(clientId, intentId);
  // A hint is only emitted after strict commit. Other tabs read authoritative
  // storage; no data or sequence from an incoming BroadcastChannel is trusted.
  return afterDurableCommit(intentId,receipt,async () => { await refresh(); channel?.postMessage({changed:true}); });
}
async function dispatch(operation: string, payload: any): Promise<unknown> {
  if (operation === 'open') {
    if (vault) throw new BrowserVaultError('already_open', 'Worker already owns a vault');
    if (payload?.allowNewVault !== true || typeof payload?.clientId !== 'string') throw new BrowserVaultError('invalid_open', 'Explicit vault and client identity required');
    const moduleUrl = new URL(payload.wasmModuleUrl, self.location.href);
    if (moduleUrl.origin !== self.location.origin) throw new BrowserVaultError('invalid_wasm_url', 'WASM must be a same-origin application asset');
    const wasm = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleUrl.href) as BrowserVaultWasm & {default(): Promise<unknown>};
    await wasm.default();
    clientId=payload.clientId;
    vault=payload.legacyFixture===true?await openBrowserVault({name:payload.database,wasm}):await openBrowserStreamingVault({name:payload.database,wasm:wasm as unknown as BrowserStreamingVaultOptions['wasm'],clientId,assertActive:assertVaultActive,
      managedRecordsSession:()=>{assertManagedActive();return sync?.recordsSession();}});
    try {
      // Open only reads the persisted authority. No intent replay/checkpoint access
      // occurs before this lifetime lease; no IDB transaction spans the wait.
      lease = await claimBrowserClient(self.navigator.locks, {vaultId:vault.authorityId,clientId}, error => {
        failStorage(error.code);
      });
      assertOwner();
      if(payload.initializeLocal===true){
        const status=await vault.sync.inspect();
        if(!status.scope)await vault.sync.enroll({realm_id:`local_${vault.authorityId}`,vault_id:`vault_${vault.authorityId}`,key_epoch:1});
        assertOwner();
      }
      if(streaming()){await streaming()!.validateStorage();await streaming()!.cleanupReadPins();binary=await streaming()!.binaryStreams().catch(error=>{if(payload.initializeLocal!==true&&error instanceof BrowserVaultError&&error.code==='not_enrolled')return undefined;throw error;});assertOwner();}
      sync = new BrowserSyncWorker({storage:vault.sync,wasm:wasm as unknown as BrowserSyncCodec,assertOwner:assertManagedActive,local,fatal:failStorage,
        changed:async assertSession=>{assertSession();await refresh(assertSession);assertSession();channel?.postMessage({changed:true});}});
      channel = new BroadcastChannel(`zorid-core:${payload.database}`);
      const records=streaming()?.managedRecords;
      if(payload.legacyFixture!==true){
        if(!records)throw new BrowserVaultError('workblocks_unavailable','Managed WorkBlock storage is unavailable');
        workBlocks=createBrowserWorkBlocksHost({records:records as unknown as Parameters<typeof createBrowserWorkBlocksHost>[0]['records'],wasm:wasm as unknown as BrowserWorkBlocksWasm,
          assertActive:assertManagedActive,scope:async()=>{const inspected=await vault!.sync.inspect();assertManagedActive();return inspected.scope;},
          committed:async()=>{assertManagedActive();port.postMessage({event:'change',paths:[]});channel?.postMessage({changed:true});await refresh();assertManagedActive();void managed?.trigger();}});
      }
      if(records)managed=createBrowserManagedRecordsHost({records,consumers:workBlocks?createBrowserManagedRecordConsumers(wasm as unknown as BrowserWorkBlocksWasm,{opened:handle=>workBlocks!.opened(handle),changed:()=>{}}):[],local,assertActive:assertManagedActive,
        scope:async()=>{const inspected=await vault!.sync.inspect();return inspected.scope;},hasSession:()=>!!sync?.recordsSession(),
        notify:()=>{assertManagedActive();port.postMessage({event:'change',paths:[]});channel?.postMessage({changed:true});},
        failed:error=>{const code=error instanceof BrowserVaultError?error.code:'managed_host_failed';failStorage(code);
          if(['sync_session_revoked','records_retry_key_unavailable','managed_snapshot_conflict','sync_snapshot_conflict'].includes(code))return;
          if(!closing&&!storageFailed){storageFailed=true;documentRuntime?.retire();workBlocks?.stop();managed?.stop();sync?.revoke();channel?.close();vault?.close();port.postMessage({event:'storage-error',code});}}});
      // Open already holds the local tail; do not recursively queue and await.
      await managed?.initializeOnLocalTail();assertManagedActive();
      if(payload.initializeLocal===true&&payload.legacyFixture!==true&&!workBlocks?.ready)throw new BrowserVaultError('workblocks_unavailable','Compiled WorkBlock consumer was not registered');
      let recoveredCommit = false;
      for (const intent of await vault.intents(clientId)) if (!intent.acknowledged && ['commit_requested','committed'].includes(intent.status)) {
        try { assertOwner(); await vault.executeIntent(clientId, intent.intent_id); recoveredCommit = true; }
        catch (error) { if (!(error instanceof BrowserVaultError && error.source === 'rust')) throw error; }
      }
      sequence = JSON.parse(await vault.snapshot()).sequence;
      if (recoveredCommit) channel.postMessage({changed:true});
      channel.onmessage = () => {
        // Serialize hints with operations; lost hints are repaired on visibility.
        queue = queue.then(()=>refresh()).catch(error => port.postMessage({event:'storage-error', code:error.code ?? 'storage_failure'}));
      };
      recovery = new Set((await vault.intents(clientId)).filter(intent => !intent.acknowledged && intent.status !== 'prepared').map(intent=>intent.intent_id));
      assertManagedActive();
      void managed?.trigger();
      const maintenance=streaming()?.documentMaintenance;
      if(payload.documentMaintenance===true&&!maintenance)throw new BrowserVaultError('document_runtime_unavailable','Document maintenance WASM is unavailable');
      if(payload.documentMaintenance===true&&maintenance){
        documentRuntime=createBrowserDocumentRuntimeHost({maintenance,assertActive:assertOwner,local,
          changed:(snapshot,outcomes)=>documentChannel?.adopt(snapshot,outcomes),
          failed:error=>{const code=error instanceof BrowserVaultError?error.code:'document_runtime_unavailable';failStorage(code);}});
        documentChannel=createBrowserDocumentRuntimeChannel({scope:{localStoreId:vault.authorityId,clientId},assertActive:assertManagedActive,host:documentRuntime,
          nudge:()=>{if(!closing&&!storageFailed)port.postMessage({event:'document-runtime-nudge'});}});
        // First IO joins a later host task after this opening admission returns.
        documentRuntime.start();
      }
      const index=streaming()?.documentIndex;
      if(index?.metadataRowsAvailable===true&&typeof index.metadataRows!=='function')throw new BrowserVaultError('index_rebuild_required','Invalid metadata page capability');
      return {ready:true, sequence, authorityId:vault.authorityId, recovery:[...recovery],...(binary?{binaryLimits:binary.limits}:{}),documentIndexAvailable:!!index,...(index?.metadataRowsAvailable===true?{metadataRowsAvailable:true}:{}),...(documentChannel?{documentMaintenance:true}:{}),...(workBlocks?.ready?{workBlocks:true}:{})};
    } catch (error) {
      try{documentRuntime?.retire();await documentRuntime?.drain();}catch{/* Preserve the original opening failure after accepted work settles. */}
      documentChannel=undefined;documentRuntime=undefined;
      workBlocks?.stop();managed?.stop();await workBlocks?.drain();await managed?.drain();sync?.revoke(); channel?.close(); channel = undefined; vault.close(); vault = undefined;
      if (lease) { try { await lease.release(); } catch { /* Original open failure remains uncertain. */ } }
      throw error;
    }
  }
  if (!vault) throw new BrowserVaultError('not_open', 'Open worker vault first');
  if (operation === 'release-client') {
    if (released) return; // Exact retry after a lost release acknowledgement.
    assertOwner();
    await documentRuntime?.drain();
    await workBlocks?.drain();
    await managed?.drain();
    await Promise.allSettled([...detached]);
    releasingCleanup=true;
    try{if(streaming()){await streaming()!.documentIndex?.close();await streaming()!.cleanupReadPins();}}
    finally{releasingCleanup=false;}
    // Serialized behind all earlier dispatches, including timed-out RPCs/hints.
    sync?.revoke(); channel?.close(); channel = undefined; vault.close();
    await lease!.release(); released = true; return;
  }
  assertOwner();
  if(operation.startsWith('document-runtime-')){
    assertManagedActive();if(!documentChannel||!documentRuntime)throw new BrowserVaultError('document_runtime_unavailable','Document maintenance is not enabled');
    switch(operation){
      case 'document-runtime-observe':return documentChannel.observe();
      case 'document-runtime-control':return documentChannel.control(payload);
      case 'document-runtime-ack-control':return documentChannel.ackControl(payload);
      case 'document-runtime-ack-outcome':return documentChannel.ackOutcome(payload);
      default:throw new BrowserVaultError('invalid_operation','Unknown document maintenance operation');
    }
  }
  if(operation==='workblock-command'){assertManagedActive();if(!workBlocks?.ready)throw new BrowserVaultError('workblocks_unavailable','WorkBlock service is unavailable');return workBlocks.execute(payload);}
  if(operation.startsWith('document-index-')){
    const index=streaming()?.documentIndex;if(!index)throw new BrowserVaultError('index_unavailable','Shared document index WASM is unavailable');
    switch(operation){
      case 'document-index-initialize':return index.initialize();
      case 'document-index-discard':return index.discard(payload);
      case 'document-index-status':return index.status();
      case 'document-index-begin':return index.begin();
      case 'document-index-pump':return index.pump(payload);
      case 'document-index-publish':return index.publish(payload);
      case 'document-index-open':return index.open();
      case 'document-index-close-pin':return index.closePin(payload);
      case 'document-index-search':return index.search(payload);
      case 'document-index-rich-start':return index.richStart(payload);
      case 'document-index-rich-prepare':return index.richPrepare(payload);
      case 'document-index-rich-page':return index.richPage(payload);
      case 'document-index-rich-close':return index.richClose(payload);
      case 'document-index-metadata':return index.metadata(payload);
      case 'document-index-metadata-rows':
        if(index.metadataRowsAvailable!==true||typeof index.metadataRows!=='function')throw new BrowserVaultError('index_unavailable','Committed metadata pages are unavailable');
        return index.metadataRows(payload);
      case 'document-index-tasks':return index.tasks(payload);
      case 'document-index-base':return index.base(payload);
      case 'document-index-resolve':return index.resolve(payload);
      case 'document-index-backlinks':return index.backlinks(payload);
      case 'document-index-rebuild':return index.rebuild();
      default:throw new BrowserVaultError('invalid_operation','Unknown document index operation');
    }
  }
  switch (operation) {
    case 'inventory': return vault.inventory();
    case 'read': return vault.readEntry(payload);
    case 'read-id':return vault.readEntryById(payload);
    case 'read-metadata':return streaming()?streaming()!.readMetadata(payload):vault.readEntry(payload);
    case 'read-metadata-id':return streaming()?streaming()!.readMetadataById(payload):vault.readEntryById(payload);
    case 'binary-limits':if(streaming()){binary??=await streaming()!.binaryStreams();return binary.limits;}break;
    case 'binary-begin':if(binary)return binary.begin(payload);break;
    case 'binary-append':if(binary)return binary.append(payload.ref,payload.input);break;
    case 'binary-query':if(binary)return binary.query(payload);break;
    case 'binary-seal':if(binary)return binary.seal(payload.ref,payload.input);break;
    case 'binary-commit':if(binary)return afterDurableCommit(payload.operationId,await binary.commit(payload),async()=>{await refresh();channel?.postMessage({changed:true});});break;
    case 'binary-abort':if(binary)return binary.abort(payload);break;
    case 'binary-open-read':if(streaming())return streaming()!.openBinaryRead(payload.requestedReadId,payload.input);break;
    case 'binary-read':if(binary)return binary.read(payload.ref,payload.input);break;
    case 'binary-close-read':if(binary)return binary.closeRead(payload);break;
    case 'binary-close-request':if(streaming())return streaming()!.closeBinaryReadRequest(payload.requestedReadId,payload.input);break;
    case 'checkpoint-load':return vault.checkpoints(clientId).load(payload);
    case 'checkpoint-cas':return vault.checkpoints(clientId).compareAndSwap(payload);
    case 'checkpoint-list':return vault.checkpoints(clientId).list(payload);
    case 'checkpoint-changes':return vault.checkpoints(clientId).changes(payload);
    case 'prepare':
      if (recovery.size && !recovery.has(payload.intentId)) throw new BrowserVaultError('recovery_required', 'Reconcile recovered intent outcomes before new mutations', {intent_ids:[...recovery]});
      return vault.prepareIntent(clientId, payload.intentId, payload.requestJson);
    case 'prepare-family':
      if(recovery.size&&!recovery.has(payload.intentId))throw new BrowserVaultError('recovery_required','Reconcile recovered outcomes before new family mutations');
      return vault.prepareFamilyIntent(clientId,payload.intentId,payload.commandJson);
    case 'execute':
      if (recovery.size && !recovery.has(payload)) throw new BrowserVaultError('recovery_required', 'Reconcile recovered outcomes before authorizing another mutation', {intent_ids:[...recovery]});
      return execute(payload);
    case 'intents': return vault.intents(clientId);
    case 'acknowledge':
      await vault.acknowledgeIntent(clientId,payload.intentId,payload.outcome); recovery.delete(payload.intentId); return;
    case 'refresh':await refresh();documentRuntime?.wake();return;
    default: throw new BrowserVaultError('invalid_operation', 'Unknown browser worker operation');
  }
  throw new BrowserVaultError('binary_streams_unavailable','This worker has no admitted binary stream capability');
}
port.onmessage = ({data}) => {
  const {id, operation, payload} = data;
  // Revoke before queued storage dispatch. Network work never occupies the local-operation tail.
  if (operation === 'release-client') {closing=true;documentRuntime?.retire();workBlocks?.stop();managed?.stop();sync?.revoke();}
  if(typeof operation==='string'&&operation.startsWith('binary-')){
    const task=(async()=>{try{if(closing)throw new BrowserVaultError('client_not_admitted','Browser client is releasing');assertOwner();const result=await dispatch(operation,payload);
      const transfer=operation==='binary-read'&&result&&typeof result==='object'&&'bytes'in result&&result.bytes instanceof Uint8Array&&result.bytes.buffer instanceof ArrayBuffer?[result.bytes.buffer]:undefined;
      (port.postMessage as (value:unknown,transfer?:Transferable[])=>void)({id,ok:true,result},transfer);
    }catch(error){const failure=error instanceof BrowserVaultError?error:new BrowserVaultError('storage_failure','Binary worker operation failed');port.postMessage({id,ok:false,error:{code:failure.code,message:failure.message,details:failure.details,source:failure.source}});failStorage(failure.code,failure.details);}})();
    detached.add(task);void task.finally(()=>detached.delete(task));return;
  }
  if (['sync-configure','sync-once','sync-revoke'].includes(operation)) {
    void (async()=>{
      try {
        assertManagedActive();if(!sync)throw new BrowserVaultError('not_open','Open worker vault first');
        let result:unknown;
        if(operation==='sync-configure'){
          const configured=sync.configure(payload);
          if(payload){payload.bearerToken='';if(payload.keyBytes instanceof Uint8Array)payload.keyBytes.fill(0);}
          await configured;assertManagedActive();
          const session=sync.recordsSession();
          if(!session)throw new BrowserVaultError('sync_session_revoked','Sync configuration was revoked');
          // configure is detached; join the existing local tail exactly once.
          // Registration itself runs directly on that tail, never recursively.
          result=await local(async()=>{
            assertManagedActive();session.assertActive();
            await managed?.initializeOnLocalTail();
            assertManagedActive();session.assertActive();
            return {workBlocks:workBlocks?.ready===true};
          });
          assertManagedActive();session.assertActive();
          void managed?.trigger();
        }else result=operation==='sync-once'?await sync.once():sync.revoke();
        port.postMessage({id,ok:true,result});
      } catch(error) {
        const code=error instanceof BrowserVaultError?error.code:'sync_failed';
        failStorage(code);
        try {port.postMessage({id,ok:false,error:{code,message:'Browser sync operation failed'}});}catch{}
      } finally {
        if(operation==='sync-configure'&&payload){payload.bearerToken='';if(payload.keyBytes instanceof Uint8Array)payload.keyBytes.fill(0);}
      }
    })();
    return;
  }
  queue = queue.catch(() => undefined).then(async () => {
    try { port.postMessage({id, ok:true, result:await dispatch(operation, payload)}); }
    catch (error) {
      const failure = error instanceof BrowserVaultError ? error : new BrowserVaultError('storage_failure', error instanceof Error ? error.message : String(error));
      try { port.postMessage({id, ok:false, error:{code:failure.code, message:failure.message, details:failure.details, source:failure.source,...(operation==='workblock-command'?{commitUncertain:(failure as BrowserVaultError&{commitUncertain?:boolean}).commitUncertain===true}:{})}}); }
      catch { /* Lost response remains outcome_unknown; do not poison later dispatch. */ }
      failStorage(failure.code,failure.details);
    }
  });
};
