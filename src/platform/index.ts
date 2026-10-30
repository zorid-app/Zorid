import {captureHistoryList,captureHistoryRead,decodeHistory} from './desktop-recovery-history.ts';
import type {HistoryRequest} from './desktop-recovery-history.ts';
import {createDesktopDurableTransport} from './desktop-durable-transport.ts';
import {DatabaseMutationSupervisor} from './database-mutation-recovery.ts';
import {createDesktopIndependentDraftProvider} from './desktop-independent-drafts.ts';
import {createDatabaseService} from '../core/databases.ts';
import type {DatabaseService,DatabaseRequest,DatabaseResponse,DesktopDatabaseRequest} from '../core/databases.ts';
import {captureDatabaseRequest} from '../../desktop/databases.cjs';
import {decodeDesktopNotePlan,snapshotDesktopNoteWriteInput} from './desktop-note-plan.ts';
import {decodeWorkBlockEnvelope} from '../../desktop/workblocks.cjs';
import {createDesktopWorkBlocks,createDesktopBinaryStreams,createDesktopConditionalSavedSources} from './desktop.ts';
import {scheduleBinaryTransfer} from '../core/binary-transfer-queue.ts';
import {createDesktopDocumentService,createDesktopDocumentRuntime} from './desktop-document-semantics.ts';
import {createDesktopDocumentDraftTransport} from './desktop-document-drafts.ts';
import type {DocumentService} from '../core/document-semantics.ts';
import type { DurableWrites,DurableWriteRead } from '../core/durable-writes.ts';
import { decodeTextCreateReceipt } from '../core/text-create.ts';
import { normalizePath } from '../core/types.ts';
import type { TextCreateReceipt } from '../core/types.ts';
import type { VaultAdapter } from '../core/types';
import type { DesktopBridge, DesktopVault, DesktopReconciliation, DesktopDurableContext } from './bridge';

type ReadBudget={retries:number};
const historyReadRunners=new WeakMap<import('./bridge').RecoveryHistory,(request:HistoryRequest,budget:ReadBudget)=>Promise<unknown>>();
type AdapterReads=Required<Pick<VaultAdapter,'list'|'stat'|'read'|'readBinary'>>;
// Replacement layers share one caller's retry budget without exposing it to
// consumers or bypassing any layer's release and generation checks.
const adapterReadRunners=new WeakMap<VaultAdapter,(method:keyof AdapterReads,path:string|undefined,budget:ReadBudget)=>Promise<unknown>>();
const noteReadRunners=new WeakMap<DurableWrites,(method:'readText'|'readTextById',key:string,budget:ReadBudget)=>Promise<DurableWriteRead|null>>();
type SavedSourceMethod='captureSavedSource'|'releaseSavedSource'|'listSavedSourceRequests';
const savedSourceRunners=new WeakMap<DurableWrites,(method:SavedSourceMethod,input:unknown,budget:ReadBudget)=>Promise<unknown>>();
type EntryCommand=Extract<DatabaseRequest,{operationId:string}>;
type EntryHold={fingerprint:string;count:number};
type EntryCapsule={command:EntryCommand;fingerprint:string;attempt:number;io?:DatabaseMutationSupervisor;claims:number;holds:Set<EntryHold>;registrations:Set<Map<string,EntryCapsule>>;promise?:Promise<DatabaseResponse>;resolve?:(value:DatabaseResponse)=>void;reject?:(error:unknown)=>void;response?:DatabaseResponse;error?:unknown};
// A checked replacement adopts the SAME owner capsule. No nested promise,
// retry supervisor, or newly minted operation is introduced at a context hop.
const databaseCapsuleRunners=new WeakMap<DatabaseService,(capsule:EntryCapsule)=>Promise<DatabaseResponse>>();

export interface PlatformVault {
  /** Recovery preserves retained durable write identities; derived owners are rebuilt. */
  readonly recovery?:{
    subscribe(listener:()=>void|Promise<void>):()=>void;recover():Promise<PlatformVault>;
    /** Proof of prior admission alone never selects an edit for replay. */
    containsCapturedSetEntry(command:DatabaseRequest):boolean;
    /** The current unchanged widget claims its exact edit before recovery starts. */
    claimCapturedSetEntry(command:DatabaseRequest):()=>void;
    /** Hold a receipt through the owning widget's post-save refresh; no admission or replay. */
    holdCapturedSetEntry(command:DatabaseRequest):()=>void;
    /** A live collection control owns only its originally captured mutation. */
    containsCapturedDatabaseMutation?(command:DatabaseRequest):boolean;
    holdCapturedDatabaseMutation?(command:DatabaseRequest):()=>void;
    claimCapturedDatabaseMutation?(command:DatabaseRequest):()=>void;
  };
  readonly recoveryHistory?:import('./bridge').RecoveryHistory;
  readonly workBlocks?:import('../core/workblocks.ts').WorkBlockService;
  readonly documentSemantics?:DocumentService;
  readonly databases?:DatabaseService;
  nativeDocumentNavigation?:import('./mobile-native.ts').NativeDocumentNavigation;
  nativeWebRouting?:import('./mobile-web-routing.ts').NativeWebRouting;
  /** Presentation bridge only; native controls execute shared editor commands. */
  nativeEditor?: {
    setState(state:import('../ui/editor.ts').NativeEditorState):Promise<void>;
    subscribe(handler:(action:import('../ui/editor.ts').NativeEditorAction)=>void|Promise<void>,onStateRequest?:()=>void|Promise<void>):()=>void;
  };
  /** Native navigation owns the surrounding chrome; embed document content only. */
  editorOnly?: boolean;
  /** Native New note intent, applied once after durable admission/recovery. */
  createNoteOnOpen?: boolean;
  /** Native page selection, admitted together; paths alone do not identify a note. */
  initialPath?: string;
  initialEntryId?: string;
  /** Presentation history only; rejection must not fail editing or saving. */
  noteOpened?(path:string,entryId:string):Promise<void>;
  /** Reveal ready content or actionable UI; password/error never acknowledge a successful open. */
  presentationSettled?(input:{path:string;entryId:string;state:'ready'|'password'|'error'}):Promise<void>;
  mobileLifecycle?:import('./mobile-native.ts').MobileLifecycle; adapter: VaultAdapter; label: string; id: string; /** Await final consumer checkpoint/flush before release. */ release?(): Promise<void>; recoverCommands?():Promise<boolean>; legacyExport?():void; reconciliation?: {getStatus():DesktopReconciliation|null;subscribe(listener:(status:DesktopReconciliation)=>void):()=>void;retry():Promise<void>} }
async function desktopVault(bridge: DesktopBridge, info: DesktopVault, recoveredBinding?:DesktopDurableContext): Promise<PlatformVault> {
  let reconciliationStatus=info.reconciliation??null;
  const reconciliation=info.reconciliation&&bridge.retryReconciliation?{
    getStatus:()=>reconciliationStatus,
    subscribe:(listener:(status:DesktopReconciliation)=>void)=>{
      let changed=false,disposed=false;
      const stop=bridge.onChange(change=>{
        if(change.vault===info.path&&change.reconciliation){changed=true;reconciliationStatus=change.reconciliation;listener(change.reconciliation);}
      });
      // Catch a scan that finished between getVault and this subscription.
      void bridge.getVault().then(latest=>{if(!disposed&&!changed&&latest?.path===info.path&&latest.reconciliation){reconciliationStatus=latest.reconciliation;listener(latest.reconciliation);}}).catch(()=>{});
      return ()=>{disposed=true;stop();};
    },
    retry:async()=>{reconciliationStatus=await bridge.retryReconciliation!(info.path);},
  }:undefined;
  const transport=createDesktopDurableTransport(bridge);
  const binding = recoveredBinding??await transport.getDurableContext?.(info.path);
  const independentDrafts=binding&&Object.hasOwn(binding,'independentJournal')?createDesktopIndependentDraftProvider(bridge,info.path,binding.scope,binding.independentJournal):undefined;
  if(binding?.conditionalSavedSourceAvailable===true&&!independentDrafts)throw Object.assign(new Error('Incomplete conditional saved-source request capability: an independent draft journal is required.'),{code:'unsupported_host_capability',source:'protocol',commitUncertain:false});
  let durableWrites: DurableWrites | undefined;
  let release: (() => Promise<void>) | undefined;
  let recovery:PlatformVault['recovery'];
  let createText: ((path:string,content:string)=>Promise<void>) | undefined;
  let commands:Partial<VaultAdapter>={};
  let adapterReads:AdapterReads={
    list:()=>bridge.list(info.path),stat:path=>bridge.stat(info.path,path),
    read:path=>bridge.read(info.path,path),readBinary:path=>bridge.readBinary(info.path,path),
  };
  let recoveryHistory:import('./bridge').RecoveryHistory|undefined=bridge.recoveryList&&bridge.recoveryRead?{list:(entryId,options)=>bridge.recoveryList!(info.path,entryId,options),read:(entryId,snapshotId)=>bridge.recoveryRead!(info.path,entryId,snapshotId)}:undefined;
  let registerReadAdapter:((adapter:VaultAdapter)=>void)|undefined;
  let binary:ReturnType<typeof createDesktopBinaryStreams>|undefined;
  let databases:DatabaseService|undefined;
  let workBlocks:ReturnType<typeof createDesktopWorkBlocks>|undefined;
  let documents:ReturnType<typeof createDesktopDocumentService>|undefined;
  let documentRuntime:ReturnType<typeof createDesktopDocumentRuntime>|undefined;
  let drafts:ReturnType<typeof createDesktopDocumentDraftTransport>|undefined;
  if (binding) {
    if (!transport.durableInvoke || !transport.releaseDurableContext || !binding.admissionId || !binding.scope?.vaultId || !binding.scope.clientId) throw new Error('Incomplete durable desktop capability');
    const invoke = transport.durableInvoke, releaseContext = transport.releaseDurableContext;
    const admissionId = binding.admissionId, scope = Object.freeze({...binding.scope});
    let released = false,releasePending:Promise<void>|undefined,recovering:Promise<PlatformVault>|undefined,recovered:PlatformVault|undefined;
    let durableEpoch=0,retainedTarget:DurableWrites,recoveryNeeded=false,recoveryStop:(()=>void)|undefined;
    const recoveryListeners=new Set<()=>void|Promise<void>>();
    let retirementDelivery:Promise<void>|undefined;
    const deliverRetirement=(listener:()=>void|Promise<void>)=>{try{return Promise.resolve(listener());}catch(error){return Promise.reject(error);}};
    const markRetired=()=>{
      if(released||recovered)return Promise.resolve();recoveryNeeded=true;if(retirementDelivery)return retirementDelivery;
      let complete!:()=>void;const delivery=new Promise<void>(resolve=>{complete=resolve;});retirementDelivery=delivery;
      // Invoke immediately so owners can claim before any original rejection;
      // await their explicit handoff when a reversible preflight must unwind.
      void Promise.allSettled([...recoveryListeners].map(deliverRetirement)).then(()=>{if(retirementDelivery===delivery)retirementDelivery=undefined;complete();});
      return delivery;
    };
    const stopRecoveryReceiver=()=>{const stop=recoveryStop;recoveryStop=undefined;try{stop?.();}catch{/* A retired receiver cannot undo the backend acknowledgment. */}};
    const unavailable=(code:string,message:string)=>Object.assign(new Error(message),{code,source:'host',commitUncertain:true});
    let readClosing=false;
    const readWaiters=new Set<()=>void>();
    const wakeReads=()=>{for(const wake of readWaiters)wake();};
    const readActive=()=>{if(readClosing||releasePending||released&&!recovered)throw unavailable('client_not_admitted','This desktop read owner was released.');};
    const awaitRead=async<T>(pending:Promise<T>):Promise<T>=>{
      readActive();let cancel!:()=>void;
      const cancelled=new Promise<never>((_resolve,reject)=>{cancel=()=>{if(readClosing)reject(unavailable('client_not_admitted','This desktop read owner was released.'));};});
      readWaiters.add(cancel);
      try{const value=await Promise.race([pending,cancelled]);readActive();return value;}finally{readWaiters.delete(cancel);}
    };
    const retiredRead=(error:unknown)=>{
      if(!error||typeof error!=='object')return false;
      const value=error as {source?:unknown;code?:unknown;commitUncertain?:unknown};
      return value.source==='host'&&(['client_not_admitted','client_ownership_lost'].includes(String(value.code))||value.code==='host_exited'&&value.commitUncertain===true);
    };
    const waitForReadRecovery=async(error:unknown)=>{
      readActive();if(!recovery)throw error;
      let wake!:()=>void;const started=new Promise<void>(resolve=>{wake=resolve;});readWaiters.add(wake);
      try{
        // Subscribe before synchronous owner notification. Workspace claims its
        // exact edits before calling recover, possibly after cancelling a chooser.
        const delivery=markRetired();
        if(!recovering&&!recovered){
          if(!recoveryListeners.size)void recovery.recover().catch(()=>{});
          else await Promise.race([started,delivery]);
        }
        readActive();
        if(recovering)await awaitRead(recovering);else if(!recovered)throw error;
        readActive();
      }finally{readWaiters.delete(wake);}
    };
    const readOnly=async<T>(action:(budget:ReadBudget)=>Promise<T>,legacy=false,budget:ReadBudget={retries:0}):Promise<T>=>{
      const retry=(error:unknown)=>{if(budget.retries>=1)throw error;budget.retries++;};
      for(let attempt=0;attempt<2;attempt++){
        readActive();
        if(recovering){budget.retries=1;await awaitRead(recovering);}
        else if(recoveryNeeded&&!recovered){
          const error=unavailable('client_not_admitted','This desktop read admission retired.');retry(error);await waitForReadRecovery(error);
        }
        readActive();const epoch=durableEpoch,forwarded=!!recovered;
        try{
          const value=await awaitRead(action(budget));readActive();
          if(epoch===durableEpoch&&!recoveryNeeded)return value;
          if(attempt===0&&(recovering||recovered)){retry(unavailable('desktop_recovery_stale_reply','The read admission changed.'));if(recovering)await awaitRead(recovering);continue;}
          throw unavailable('desktop_recovery_stale_reply','The read admission changed while this result was pending.');
        }catch(error){
          readActive();if(attempt||forwarded||budget.retries>=1)throw error;
          if(epoch!==durableEpoch&&(recovering||recovered)){retry(error);if(recovering)await awaitRead(recovering);continue;}
          let proof=error;
          // Legacy IPC errors lose custom fields. Only after a failed read,
          // obtain an admitted, read-only health proof; healthy reads add no RPC.
          if(legacy&&!retiredRead(proof)&&!recovering&&!recoveryNeeded)try{await awaitRead(retainedTarget.listUnacknowledged());}catch(healthError){proof=healthError;}
          readActive();
          if(epoch!==durableEpoch&&(recovering||recovered)){retry(error);if(recovering)await awaitRead(recovering);continue;}
          if(!retiredRead(proof)&&!recoveryNeeded&&!recovering)throw error;
          retry(error);await waitForReadRecovery(error);
        }
      }
      throw unavailable('desktop_recovery_stale_reply','The desktop read could not settle in one admitted generation.');
    };
    const retainedCall=async<T>(method:keyof DurableWrites,args:unknown[]):Promise<T>=>{
      if(recovering)throw unavailable('desktop_recovery_pending','The desktop context is being recovered.');
      const target=retainedTarget,epoch=durableEpoch,action=target[method];
      if(typeof action!=='function')throw unavailable('unsupported_host_capability','The recovered capability is unavailable.');
      const value=await(action as (...args:unknown[])=>Promise<T>).apply(target,args);
      if(epoch!==durableEpoch)throw unavailable('desktop_recovery_stale_reply','The desktop context changed while this request was pending.');
      return value;
    };
    const retainedCheckpoint=async<T>(method:keyof Omit<DurableWrites['checkpoints'],'scope'>,args:unknown[]):Promise<T>=>{
      if(recovering)throw unavailable('desktop_recovery_pending','The desktop context is being recovered.');
      const target=retainedTarget,epoch=durableEpoch;
      const value=await(target.checkpoints[method] as (...args:unknown[])=>Promise<T>).apply(target.checkpoints,args);
      if(epoch!==durableEpoch)throw unavailable('desktop_recovery_stale_reply','The desktop context changed while this request was pending.');
      return value;
    };
    const call = <T>(method: string, ...args: unknown[]): Promise<T> => {
      if (released) return Promise.reject(Object.assign(new Error('Durable desktop context released'), {code:'client_not_admitted',source:'host'}));
      return invoke(info.path, admissionId, method, args) as Promise<T>;
    };
    type Input={kind:string;path:string;content?:string;expectedContent?:string;expectedEntryId?:string;expectedRevision?:string;data?:Uint8Array;destination?:string;force?:boolean};
    const pending=new Map<string,Input&{operationId:string;entryId:string}>();
    const execute=async(input:Input):Promise<void>=>{
      const key=`${input.kind}:${input.path}`, prior=pending.get(key);
      const same=(a:Input,b:Input)=>a.kind===b.kind&&a.path===b.path&&a.content===b.content&&a.expectedContent===b.expectedContent&&a.expectedEntryId===b.expectedEntryId&&a.expectedRevision===b.expectedRevision&&a.destination===b.destination&&a.force===b.force&&
        (!a.data&&!b.data||!!a.data&&!!b.data&&a.data.length===b.data.length&&a.data.every((byte,i)=>byte===b.data![i]));
      if(prior&&!same(prior,input))throw new Error('A different file operation is still pending for this path');
      const request=prior??{...input,...(input.data?{data:new Uint8Array(input.data)}:{}),operationId:crypto.randomUUID(),entryId:crypto.randomUUID()};
      pending.set(key,request);
      try{await call<void>('fileCommand',request);if(pending.get(key)===request)pending.delete(key);}
      catch(error){if(error&&typeof error==='object'&&'code'in error&&['invalid_request','not_found','revision_conflict','idempotency_conflict'].includes(String(error.code))&&(!('commitUncertain'in error)||!error.commitUncertain)&&pending.get(key)===request)pending.delete(key);throw error;}
    };
    createText=(path,content)=>execute({kind:'createText',path,content});
    commands={durableNamespace:true,
      ...(binding.textCreateReceiptsAvailable === true ? { captureTextCreate(rawPath:string,content:string) {
        const path=normalizePath(rawPath);
        if(typeof content!=='string')throw new Error('Text creation requires a string');
        const request=Object.freeze({kind:'createText',path,content,operationId:crypto.randomUUID(),entryId:crypto.randomUUID()}),key=`createText:${path}`;
        let receipt:TextCreateReceipt|undefined,inFlight:Promise<TextCreateReceipt>|undefined;
        return Object.freeze({path,text:content,operationId:request.operationId,entryId:request.entryId,run(){
          if(released)return Promise.reject(Object.assign(new Error('Durable desktop context released'),{code:'client_not_admitted',source:'host'}));
          if(receipt)return Promise.resolve(receipt);
          if(inFlight)return inFlight;
          const prior=pending.get(key);
          if(prior&&prior!==request)return Promise.reject(new Error('A different file operation is still pending for this path'));
          pending.set(key,request);
          const result=call<unknown>('createTextReceipt',request).then(raw=>{
            const committed=decodeTextCreateReceipt(raw,request);receipt=committed;
            if(pending.get(key)===request)pending.delete(key);
            return committed;
          },error=>{
            if(error&&typeof error==='object'&&'code'in error&&['invalid_request','not_found','revision_conflict','idempotency_conflict'].includes(String(error.code))&&(!('commitUncertain'in error)||!error.commitUncertain)&&pending.get(key)===request)pending.delete(key);
            throw error;
          });
          const tracked=result.finally(()=>{if(inFlight===tracked)inFlight=undefined;});inFlight=tracked;return tracked;
        }});
      }} : {}),
      write:(path,content)=>execute({kind:'writeText',path,content}),
      compareAndWrite:(path,expectedContent,content,expectedIdentity)=>execute({kind:'writeText',path,expectedContent,content,...(expectedIdentity?{expectedEntryId:expectedIdentity.entryId,expectedRevision:expectedIdentity.revision}:{})}),
      createBinary:(path,data)=>execute({kind:'createBinary',path,data}),
      writeBinary:(path,data)=>execute({kind:'writeBinary',path,data}),
      mkdir:path=>execute({kind:'mkdir',path}),rename:(path,destination,expectedIdentity)=>execute({kind:'move',path,destination,...(expectedIdentity!==undefined?{expectedEntryId:expectedIdentity.entryId,expectedRevision:expectedIdentity.revision}:{})}),
      trash:path=>execute({kind:'trash',path}),remove:(path,force)=>execute({kind:'delete',path,force}),
    };
    const originalWrites = Object.freeze<DurableWrites>({
      ...createDesktopConditionalSavedSources(async(method,input)=>{const value=await(method==='listSavedSourceRequests'?call(method):call(method,input));if(released)throw Object.assign(new Error('Durable desktop context released'),{code:'client_not_admitted',source:'host'});return value;},binding.conditionalSavedSourceAvailable===true),
      readText: path => call('readText',path), readTextById: id => call('readTextById',id),
      ...(binding.databases===true?{composeNote:(input:import('../core/durable-writes.ts').DurableNoteCompositionInput)=>call<import('../core/durable-writes.ts').DurableNoteComposition|null>('composeNote',input)}:{}),
      planWrite: async input => {const captured=snapshotDesktopNoteWriteInput(input);if(captured.conditionalSavedSource&&binding.conditionalSavedSourceAvailable!==true)return Promise.reject(Object.assign(new Error('Conditional saved-source capture is unavailable.'),{code:'unsupported_host_capability',source:'host',commitUncertain:false}));return call('planWrite',captured).then(reply=>decodeDesktopNotePlan(captured,scope,reply));}, prepare: plan => call('prepare',plan),
      commit: ref => call('commit',ref), query: ref => call('query',ref),
      listUnacknowledged: () => call('listUnacknowledged'), acknowledge: (ref,outcome) => call('acknowledge',ref,outcome),
      checkpoints: Object.freeze<DurableWrites['checkpoints']>({scope,load: key => call('checkpoints.load',key),
        compareAndSwap: change => call('checkpoints.compareAndSwap',change),
        list: options => call('checkpoints.list',options), changes: options => call('checkpoints.changes',options)}),
    });
    retainedTarget=originalWrites;
    const readNote=(method:'readText'|'readTextById',key:string,budget?:ReadBudget)=>readOnly(async shared=>{
      const runner=noteReadRunners.get(retainedTarget);
      const value=await(runner?runner(method,key,shared):retainedTarget[method](key));
      if(method==='readTextById'&&value!==null&&(!value||value.entryId!==key))throw Object.assign(new Error('The note read returned another entry identity.'),{code:'invalid_durable_response',source:'protocol',commitUncertain:false});
      return value;
    },false,budget);
    // Caller-owned immutable request identities make these exact operations
    // replayable after positive same-scope admission. Share the existing retry
    // budget across replacement proxies, just like identity-bound note reads.
    const savedSource=(method:SavedSourceMethod,input?:unknown,budget?:ReadBudget)=>readOnly(async shared=>{
      const runner=savedSourceRunners.get(retainedTarget);
      return runner?runner(method,input,shared):retainedCall(method,method==='listSavedSourceRequests'?[]:[input]);
    },false,budget);
    durableWrites=Object.freeze<DurableWrites>({
      readText:path=>readNote('readText',path) as Promise<DurableWriteRead>,readTextById:id=>readNote('readTextById',id),
      ...(originalWrites.composeNote?{composeNote:(input:import('../core/durable-writes.ts').DurableNoteCompositionInput)=>retainedCall<import('../core/durable-writes.ts').DurableNoteComposition|null>('composeNote',[input])}:{}),
      planWrite:input=>retainedCall('planWrite',[input]),prepare:plan=>retainedCall('prepare',[plan]),commit:ref=>retainedCall('commit',[ref]),query:ref=>retainedCall('query',[ref]),
      listUnacknowledged:()=>retainedCall('listUnacknowledged',[]),acknowledge:(ref,outcome)=>retainedCall('acknowledge',[ref,outcome]),
      ...createDesktopConditionalSavedSources((method,input)=>savedSource(method,input),binding.conditionalSavedSourceAvailable===true),
      checkpoints:Object.freeze<DurableWrites['checkpoints']>({scope,load:key=>retainedCheckpoint('load',[key]),compareAndSwap:change=>retainedCheckpoint('compareAndSwap',[change]),list:options=>retainedCheckpoint('list',[options]),changes:options=>retainedCheckpoint('changes',[options])}),
    });
    noteReadRunners.set(durableWrites,readNote);
    if(binding.recoveryHistoryAvailable===true){
      const runHistory=(request:HistoryRequest,budget?:ReadBudget):Promise<unknown>=>readOnly(async shared=>{
        const next=recovered?.recoveryHistory;
        if(next){const runner=historyReadRunners.get(next);if(!runner)throw Object.assign(new Error('Recovered history capability is unavailable.'),{code:'invalid_durable_response',source:'protocol',commitUncertain:false});return runner(request,shared);}
        const args=request.method==='recoveryList'?[request.entryId,request.options]:[request.entryId,request.snapshotId];
        return decodeHistory(request,await call(request.method,...args));
      },false,budget);
      recoveryHistory=Object.freeze({
        list:(entryId:string,options:Parameters<import('./bridge').RecoveryHistory['list']>[1])=>runHistory(captureHistoryList(entryId,options)) as ReturnType<import('./bridge').RecoveryHistory['list']>,
        read:(entryId:string,snapshotId:string)=>runHistory(captureHistoryRead(entryId,snapshotId)) as ReturnType<import('./bridge').RecoveryHistory['read']>,
      });historyReadRunners.set(recoveryHistory,runHistory);
    }

    savedSourceRunners.set(durableWrites,savedSource);
    let binaryDrained=false,documentsDrained=false,draftsDrained=false;
    const entryCapsules=new Map<string,EntryCapsule>();
    const entryClaims=new Map<EntryCapsule,number>();
    const entryHolds=new Map<string,EntryHold>();
    const captureEntry=(command:DatabaseRequest):DesktopDatabaseRequest=>captureDatabaseRequest({schemaVersion:1,command});
    const capsuleFor=(command:DatabaseRequest)=>{
      try{const captured=captureEntry(command);if(!('operationId'in captured.command))return;
        const capsule=entryCapsules.get(captured.command.operationId);return capsule?.fingerprint===JSON.stringify(captured)?capsule:undefined;
      }catch{return;}
    };
    const settleEntry=(capsule:EntryCapsule,error:unknown,response?:DatabaseResponse)=>{
      const resolve=capsule.resolve,reject=capsule.reject;capsule.promise=undefined;capsule.resolve=undefined;capsule.reject=undefined;
      if(response){
        const command=capsule.command;
        const saved='entryId'in command?response.entries.find(entry=>entry.entryId===command.entryId):undefined;
        // Native exact retries also retry publication. A pending projection is
        // an honest result for this attempt, never a permanently cached receipt.
        const complete=capsule.command.op==='set_entry'?saved&&!saved.pendingProjection&&!Object.keys(saved.problems??{}).length:!response.projection.pending&&!response.projection.issues.length;
        capsule.response=complete?structuredClone(response):undefined;
        capsule.error=undefined;resolve?.(response);
      }else{capsule.error=error;reject?.(error);}
    };
    const failEntries=(error:unknown)=>{for(const capsule of entryCapsules.values()){capsule.attempt++;capsule.io?.stop();capsule.io=undefined;if(capsule.promise)settleEntry(capsule,error);}};
    const heldEntry=(capsule:EntryCapsule)=>[...capsule.holds].some(hold=>hold.fingerprint===capsule.fingerprint&&hold.count>0);
    const repairingEntry=(capsule:EntryCapsule)=>!!recovery&&!!recovering&&heldEntry(capsule)&&(entryClaims.get(capsule)??0)>0;
    const afterRetirement=(capsule:EntryCapsule,attempt:number,reject:()=>void)=>{
      if(!recovery||!heldEntry(capsule)||!retirementDelivery||!recoveryListeners.size)return false;
      void retirementDelivery.then(()=>{if(capsule.attempt===attempt&&!repairingEntry(capsule))reject();});return true;
    };
    const forgetReceipt=(capsule:EntryCapsule,settled=false)=>{if(!capsule.claims&&!heldEntry(capsule)&&(capsule.response||settled)){for(const owners of capsule.registrations)if(owners.get(capsule.command.operationId)===capsule)owners.delete(capsule.command.operationId);capsule.registrations.clear();}};
    let replayEntries:((fresh:DatabaseService)=>void)|undefined;
    if(binding.databases===true){
      const original=createDatabaseService(request=>call('databaseCommand',request));
      const runEntry=(capsule:EntryCapsule,service:DatabaseService)=>{
        if(!capsule.promise){capsule.promise=new Promise<DatabaseResponse>((resolve,reject)=>{capsule.resolve=resolve;capsule.reject=reject;});
          // Recovery also resumes an already rejected command before its widget
          // joins again. Preserve rejection for that owner without an unhandled task.
          void capsule.promise.catch(()=>{});
        }
        const result=capsule.promise,attempt=++capsule.attempt,epoch=durableEpoch;
        capsule.io?.stop();const io=new DatabaseMutationSupervisor();capsule.io=io;
        const check=()=>{
          if(capsule.attempt!==attempt||entryCapsules.get(capsule.command.operationId)!==capsule
            ||(released||recoveryNeeded||!!releasePending||epoch!==durableEpoch))throw unavailable('client_not_admitted','This collection edit owner is no longer active.');
        };
        void io.run(()=>service.request(capsule.command),check).then(value=>{
          if(capsule.attempt!==attempt)return;
          if(epoch!==durableEpoch||recoveryNeeded){
            const reject=()=>settleEntry(capsule,unavailable('client_not_admitted','The desktop context was released before this edit was confirmed.'));
            if(releasePending||released)reject();else if(!repairingEntry(capsule)&&!afterRetirement(capsule,attempt,reject))reject();
            return;
          }
          settleEntry(capsule,undefined,value);forgetReceipt(capsule,true);
        },error=>{
          if(capsule.attempt!==attempt)return;
          const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
          const uncertain=error&&typeof error==='object'&&'commitUncertain'in error&&error.commitUncertain===true;
          const host=error&&typeof error==='object'&&'source'in error&&error.source==='host';
          const retired=host&&(['client_not_admitted','client_ownership_lost'].includes(code)||code==='host_exited'&&uncertain);
          const reject=()=>{settleEntry(capsule,error);if(!retired&&!uncertain&&!recoveryNeeded)entryCapsules.delete(capsule.command.operationId);};
          if(retired&&!releasePending&&!released)markRetired();
          if((retired||epoch!==durableEpoch||recoveryNeeded)&&!releasePending&&!released
            &&(repairingEntry(capsule)||afterRetirement(capsule,attempt,reject)))return;
          reject();
        }).finally(()=>{io.stop();if(capsule.io===io)capsule.io=undefined;}).catch(()=>{});
        return result;
      };
      replayEntries=fresh=>{for(const capsule of entryCapsules.values()){
        if((entryClaims.get(capsule)??0)>0){if(!capsule.response)databaseCapsuleRunners.get(fresh)!(capsule);}
        else{capsule.attempt++;capsule.io?.stop();settleEntry(capsule,unavailable('client_not_admitted','This edit was not selected by its owner for recovery.'));entryCapsules.delete(capsule.command.operationId);}
      }};
      databases=Object.freeze({request(command:DatabaseRequest):Promise<DatabaseResponse>{
        let captured:DesktopDatabaseRequest;try{captured=captureEntry(command);}catch(error){return Promise.reject(error);}
        const blocked=released||recoveryNeeded||!!recovering||!!releasePending;
        if('operationId'in captured.command){
          const prior=entryCapsules.get(captured.command.operationId),fingerprint=JSON.stringify(captured);
          if(prior&&prior.fingerprint===fingerprint){
            if(prior.promise)return prior.promise;
            if(prior.response)return Promise.resolve(structuredClone(prior.response));
            if(recovered&&prior.claims>0)return databaseCapsuleRunners.get(recovered.databases!)!(prior);
            if(!blocked)return runEntry(prior,original);
            return Promise.reject(prior.error??unavailable('client_not_admitted','This desktop context is no longer active.'));
          }
          if(blocked)return Promise.reject(unavailable('client_not_admitted','This desktop context is no longer active.'));
          if(prior)return Promise.reject(unavailable('idempotency_conflict','This edit differs from its originally captured request.'));
          const hold=entryHolds.get(captured.command.operationId);
          const capsule:EntryCapsule={command:captured.command,fingerprint,attempt:0,claims:0,holds:new Set(hold?[hold]:[]),registrations:new Set([entryCapsules])};entryCapsules.set(capsule.command.operationId,capsule);
          return runEntry(capsule,original);
        }
        if(blocked)return Promise.reject(unavailable('client_not_admitted','This desktop context is no longer active.'));
        const epoch=durableEpoch;return original.request(captured.command).then(value=>{
          if(epoch!==durableEpoch||released||recoveryNeeded)throw unavailable('client_not_admitted','The desktop context changed while this request was pending.');return value;
        });
      }});
      databaseCapsuleRunners.set(databases,capsule=>{
        if(released||recoveryNeeded||recovering||releasePending||capsule.claims<=0)return Promise.reject(unavailable('client_not_admitted','This collection edit has no active replacement owner.'));
        const prior=entryCapsules.get(capsule.command.operationId);
        if(prior&&prior!==capsule)return Promise.reject(unavailable('idempotency_conflict','The replacement context already owns another collection command.'));
        entryCapsules.set(capsule.command.operationId,capsule);capsule.registrations.add(entryCapsules);
        return runEntry(capsule,original);
      });
    }
    if(binding.workBlocks===true)workBlocks=createDesktopWorkBlocks(request=>call('workblockCommand',request).then(reply=>decodeWorkBlockEnvelope(request,reply)));
    if(binding.documentMaintenance===true){
      if(binding.documentSemantics!==true||!bridge.onDocumentRuntimeNudge)throw new Error('Incomplete document runtime capability');
      const subscribe=bridge.onDocumentRuntimeNudge.bind(bridge);
      documentRuntime=createDesktopDocumentRuntime({scope:{localStoreId:scope.vaultId,clientId:scope.clientId},invoke:(method,args)=>call(method,...args),
        subscribe:(listener,onRetire)=>subscribe(info.path,admissionId,listener,onRetire)});
    }
    if(binding.metadataRowsAvailable===true&&binding.documentSemantics!==true)throw new Error('Incomplete document metadata capability');
    if(binding.propertyTargetsAvailable===true&&binding.documentSemantics!==true)throw new Error('Incomplete property targets capability');
    if(binding.basePreviewAvailable===true&&(binding.documentSemantics!==true||binding.documentMaintenance!==true||!documentRuntime))throw new Error('Incomplete document preview capability');
    if(binding.draftsAvailable===true){
      if(binding.documentSemantics!==true||binding.documentMaintenance!==true||!documentRuntime||!bridge.onDocumentRuntimeNudge)throw new Error('Incomplete document draft capability');
      const subscribe=bridge.onDocumentRuntimeNudge.bind(bridge);
      drafts=createDesktopDocumentDraftTransport({scope:{localStoreId:scope.vaultId,clientId:scope.clientId},invoke:(request,bytes)=>call('documentDrafts',request,bytes),subscribe:(listener,onRetire)=>subscribe(info.path,admissionId,listener,onRetire)});
    }
    if(binding.documentSemantics)documents=createDesktopDocumentService(request=>call('documentCommand',request),documentRuntime?.transport,{metadataRowsAvailable:binding.metadataRowsAvailable===true,propertyTargetsAvailable:binding.propertyTargetsAvailable===true,basePreviewAvailable:binding.basePreviewAvailable===true,draftsAvailable:binding.draftsAvailable===true,drafts:drafts?.transport});
    if(binding.binaryLimits)binary=createDesktopBinaryStreams({scope,checkpoints:durableWrites.checkpoints,limits:binding.binaryLimits,assertActive:()=>{if(released||binaryDrained)throw new Error('Desktop binary context released');},invoke:bytes=>call<Uint8Array>('binaryCommand',bytes)});
    const holdDatabaseMutation=(command:DatabaseRequest)=>{
      const captured=captureEntry(command);if(!('operationId'in captured.command)||released||recoveryNeeded||recovering||releasePending)throw unavailable('client_not_admitted','This edit cannot acquire a receipt hold in a retired context.');
      const id=captured.command.operationId,fingerprint=JSON.stringify(captured),prior=entryHolds.get(id);
      if(prior&&prior.fingerprint!==fingerprint)throw unavailable('idempotency_conflict','This edit differs from its original receipt hold.');
      const hold=prior??{fingerprint,count:0};entryHolds.set(id,hold);hold.count++;capsuleFor(captured.command)?.holds.add(hold);let active=true;
      return()=>{if(!active)return;active=false;if(--hold.count===0&&entryHolds.get(id)===hold)entryHolds.delete(id);const capsule=capsuleFor(captured.command);if(capsule){if(!hold.count)capsule.holds.delete(hold);if(!heldEntry(capsule)&&!capsule.claims&&capsule.promise)capsule.io?.stop();forgetReceipt(capsule);}};
    };
    const claimDatabaseMutation=(command:DatabaseRequest)=>{
      const capsule=capsuleFor(command);if(!capsule||released)throw unavailable('client_not_admitted','This edit has no admitted recovery capsule.');
      capsule.claims++;entryClaims.set(capsule,(entryClaims.get(capsule)??0)+1);let active=true;
      return()=>{if(!active)return;active=false;capsule.claims--;const count=(entryClaims.get(capsule)??1)-1;if(count)entryClaims.set(capsule,count);else entryClaims.delete(capsule);if(!capsule.claims&&capsule.promise)capsule.io?.stop();forgetReceipt(capsule);};
    };
    const recoveryBridge=transport;
    if(recoveryBridge.recoverDurableContext){
      recoveryStop=bridge.onDocumentRuntimeNudge?.(info.path,admissionId,()=>{},markRetired);
      recovery=Object.freeze({
        containsCapturedDatabaseMutation:(command:DatabaseRequest)=>!!capsuleFor(command),
        holdCapturedDatabaseMutation:holdDatabaseMutation,
        claimCapturedDatabaseMutation:claimDatabaseMutation,
        containsCapturedSetEntry(command:DatabaseRequest){return command.op==='set_entry'&&!!capsuleFor(command);},
        holdCapturedSetEntry(command:DatabaseRequest){if(command.op!=='set_entry')throw unavailable('invalid_database_request','This is not a collection cell edit.');return holdDatabaseMutation(command);},
        claimCapturedSetEntry(command:DatabaseRequest){if(command.op!=='set_entry')throw unavailable('invalid_database_request','This is not a collection cell edit.');return claimDatabaseMutation(command);},
        subscribe(listener:()=>void|Promise<void>){
          if(typeof listener!=='function')throw new Error('Recovery listener required');
          if(released)return()=>{};
          recoveryListeners.add(listener);
          if(recoveryNeeded)queueMicrotask(()=>{if(!released&&recoveryListeners.has(listener))void deliverRetirement(listener).catch(()=>{/* Observation cannot undo recovery. */});});
          return()=>{recoveryListeners.delete(listener);};
        },
        recover(){
          if(recovered)return Promise.resolve(recovered);if(recovering)return recovering;
          if(released)return Promise.reject(unavailable('client_not_admitted','This desktop context has already been released.'));
          durableEpoch++;
          const repair=(async()=>{
            // A concurrent ordinary release finishes under its original identity.
            if(releasePending)try{await releasePending;}catch{/* Exact backend recovery adjudicates an uncertain release. */}
            const next=await recoveryBridge.recoverDurableContext!(info.path,admissionId);
            if(!next||typeof next.admissionId!=='string'||!next.admissionId||next.admissionId===admissionId||next.admissionId.length>128
              ||!next.scope||next.scope.vaultId!==scope.vaultId||next.scope.clientId!==scope.clientId
              ||Object.keys(next.scope).length!==2)throw unavailable('durable_recovery_scope_changed','The recovered desktop context has another identity or scope.');
            for(const capability of ['recoveryHistoryAvailable','conditionalSavedSourceAvailable','databases','documentSemantics','documentMaintenance','metadataRowsAvailable','propertyTargetsAvailable','basePreviewAvailable','draftsAvailable'] as const)
              if(binding[capability]===true&&next[capability]!==true)throw unavailable('durable_recovery_scope_changed','The recovered desktop context is missing an admitted capability.');
            const selected=await bridge.getVault();
            if(selected?.path!==info.path)throw unavailable('durable_recovery_scope_changed','The selected vault changed during recovery.');
            const fresh=await desktopVault(bridge,info,next),target=fresh.adapter.durableWrites;
            if(!target||target.checkpoints.scope.vaultId!==scope.vaultId||target.checkpoints.scope.clientId!==scope.clientId)throw unavailable('durable_recovery_scope_changed','The recovered desktop context has another durable scope.');
            // Retained note writes and explicitly claimed collection commands
            // cross this boundary. Native recovery positively retired old derived
            // owners; their closures never adopt replacement pin/runtime IDs.
            retainedTarget=target;recovered=fresh;released=true;recoveryNeeded=false;
            stopRecoveryReceiver();recoveryListeners.clear();
            documentRuntime?.retire();drafts?.retire();
            if(replayEntries&&fresh.databases)replayEntries(fresh.databases);
            return fresh;
          })().catch(error=>{failEntries(error);throw error;});
          recovering=repair;
          wakeReads();
          void repair.finally(()=>{if(recovering===repair)recovering=undefined;}).catch(()=>{});
          return repair;
        },
      });
    }
    const releaseOwned=async()=>{
      if(recovering){await recovering;return;}if(released)return;if(releasePending)return releasePending;
      const retiring=(async()=>{
        if(drafts&&!draftsDrained){await drafts.release();draftsDrained=true;}if(workBlocks)await workBlocks.release();
        if(binary&&!binaryDrained){await scheduleBinaryTransfer(binary.streams,()=>binary!.release());binaryDrained=true;}
        if(documents&&!documentsDrained){await documents.release();documentsDrained=true;}
        await releaseContext(info.path,admissionId);released=true;durableEpoch++;stopRecoveryReceiver();recoveryListeners.clear();documentRuntime?.retire();
        failEntries(unavailable('client_not_admitted','The desktop context was released.'));entryCapsules.clear();entryHolds.clear();entryClaims.clear();
      })();releasePending=retiring;
      try{await retiring;}catch(error){failEntries(error);throw error;}finally{if(releasePending===retiring)releasePending=undefined;}
    };
    release=async()=>{
      readClosing=true;wakeReads();
      try{await releaseOwned();}catch(error){if(!released&&!recovered&&!releasePending)readClosing=false;throw error;}
    };
    const directReads=adapterReads;
    const readAdapter=<K extends keyof AdapterReads>(method:K,path?:string,budget?:ReadBudget):ReturnType<AdapterReads[K]>=>readOnly(async shared=>{
      if(recovered){const runner=adapterReadRunners.get(recovered.adapter);if(runner)return runner(method,path,shared);}
      const target=recovered?.adapter??directReads;
      return method==='list'?target.list():target[method]!(path!);
    },true,budget) as ReturnType<AdapterReads[K]>;
    adapterReads={
      list:()=>readAdapter('list'),stat:path=>readAdapter('stat',path),
      read:path=>readAdapter('read',path),readBinary:path=>readAdapter('readBinary',path),
    };
    registerReadAdapter=adapter=>adapterReadRunners.set(adapter,(method,path,budget)=>readAdapter(method,path,budget));
  }
  const platform:PlatformVault={
    ...(release ? {release} : {}),
    ...(recovery?{recovery}:{}),
    ...(recoveryHistory?{recoveryHistory}:{}),
    ...(workBlocks?{workBlocks:workBlocks.service}:{}),
    ...(documents?{documentSemantics:documents.service}:{}),
    ...(databases?{databases}:{}),
    ...(reconciliation?{reconciliation}:{}),
    ...(binary?{recoverCommands:()=>scheduleBinaryTransfer(binary!.streams,()=>binary!.recover())}:{}),
    id: durableWrites ? `desktop-core:${durableWrites.checkpoints.scope.vaultId}:${durableWrites.checkpoints.scope.clientId}` : `desktop:${info.path}`,
    label: info.name,
    adapter: {
      ...(independentDrafts?{independentDrafts}:{}),
      ...(durableWrites ? {durableWrites} : {}),
      ...(documents?{documentSemantics:documents.service}:{}),
      ...(databases?{databases}:{}),
      ...(binary ? {binaryStreams:binary.streams} : {}),
      ...(createText ? {createText} : {}),
      ...adapterReads,
      write: (path, data) => bridge.write(info.path, path, data),
      ...(bridge.compareAndWrite ? { compareAndWrite: (path: string, expectedContent: string, contents: string) => bridge.compareAndWrite!(info.path, path, expectedContent, contents) } : {}),
      writeBinary: (path, data) => bridge.writeBinary(info.path, path, data),
      mkdir: path => bridge.mkdir(info.path, path),
      rename: async (from, to, expectedIdentity) => {
        if(expectedIdentity!==undefined)throw Object.assign(new Error('Witnessed rename requires an admitted durable command context'),{code:'revision_conflict'});
        await bridge.rename(info.path, from, to);
      },
      trash: path => bridge.trash(info.path, path),
      ...(bridge.remove ? { remove: (path: string, force: boolean) => bridge.remove!(info.path, path, force) } : {}),
      ...commands,
      subscribe: listener => bridge.onChange(change => { if (!change.vault || change.vault === info.path) listener(change.path ? [change.path] : undefined); }),
    },
  };
  registerReadAdapter?.(platform.adapter);return platform;
}

export async function pickDesktopVault(): Promise<PlatformVault | null> {
  const bridge = window.zorid;
  if (!bridge) return null;
  const info = await bridge.openVault();
  return info ? desktopVault(bridge, info) : null;
}

export async function createPlatformAdapter(): Promise<PlatformVault | null> {
  if (window.zorid) {
    const info = await window.zorid.getVault();
    return info ? desktopVault(window.zorid, info) : null;
  }
  const { Capacitor } = await import('@capacitor/core');
  if (Capacitor.isNativePlatform()) {
    if (Capacitor.getPlatform() === 'ios') {
      const { openNativeMobileVault } = await import('./mobile-native.ts');
      return openNativeMobileVault();
    }
    // Android retains its current adapter until the native/JNI binding is ready.
    const { MobileAdapter } = await import('./mobile');
    const adapter = new MobileAdapter();
    await adapter.initialize();
    return { adapter, label: 'Zorid', id: 'mobile:documents:Zorid' };
  }
  if (typeof __ZORID_CORE_FIXTURES__ !== 'undefined' && __ZORID_CORE_FIXTURES__) {
    const { browserCoreFixtureConfig, openBrowserCoreFixture } = await import('./browser-core-fixture');
    const config = browserCoreFixtureConfig(true, new URL(window.location.href), __ZORID_CORE_BUILD_ID__);
    if (config) return openBrowserCoreFixture(config);
  }
  const { openDefaultBrowserVault } = await import('./browser-default.ts');
  return openDefaultBrowserVault();
}
