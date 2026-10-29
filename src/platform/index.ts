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
import type { DurableWrites } from '../core/durable-writes.ts';
import { decodeTextCreateReceipt } from '../core/text-create.ts';
import { normalizePath } from '../core/types.ts';
import type { TextCreateReceipt } from '../core/types.ts';
import type { VaultAdapter } from '../core/types';
import type { DesktopBridge, DesktopVault, DesktopReconciliation, DesktopDurableContext } from './bridge';

export interface PlatformVault {
  /** Recovery preserves retained durable write identities; derived owners are rebuilt. */
  readonly recovery?:{
    subscribe(listener:()=>void):()=>void;recover():Promise<PlatformVault>;
    /** Proof of prior admission alone never selects an edit for replay. */
    containsCapturedSetEntry(command:DatabaseRequest):boolean;
    /** The current unchanged widget claims its exact edit before recovery starts. */
    claimCapturedSetEntry(command:DatabaseRequest):()=>void;
    /** Hold a receipt through the owning widget's post-save refresh; no admission or replay. */
    holdCapturedSetEntry(command:DatabaseRequest):()=>void;
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
  const binding = recoveredBinding??await bridge.getDurableContext?.(info.path);
  let durableWrites: DurableWrites | undefined;
  let release: (() => Promise<void>) | undefined;
  let recovery:PlatformVault['recovery'];
  let createText: ((path:string,content:string)=>Promise<void>) | undefined;
  let commands:Partial<VaultAdapter>={};
  let binary:ReturnType<typeof createDesktopBinaryStreams>|undefined;
  let databases:DatabaseService|undefined;
  let workBlocks:ReturnType<typeof createDesktopWorkBlocks>|undefined;
  let documents:ReturnType<typeof createDesktopDocumentService>|undefined;
  let documentRuntime:ReturnType<typeof createDesktopDocumentRuntime>|undefined;
  let drafts:ReturnType<typeof createDesktopDocumentDraftTransport>|undefined;
  if (binding) {
    if (!bridge.durableInvoke || !bridge.releaseDurableContext || !binding.admissionId || !binding.scope?.vaultId || !binding.scope.clientId) throw new Error('Incomplete durable desktop capability');
    const invoke = bridge.durableInvoke.bind(bridge), releaseContext = bridge.releaseDurableContext.bind(bridge);
    const admissionId = binding.admissionId, scope = Object.freeze({...binding.scope});
    let released = false,releasePending:Promise<void>|undefined,recovering:Promise<PlatformVault>|undefined,recovered:PlatformVault|undefined;
    let durableEpoch=0,retainedTarget:DurableWrites,recoveryNeeded=false,recoveryStop:(()=>void)|undefined;
    const recoveryListeners=new Set<()=>void>();
    const markRetired=()=>{if(released||recovered)return;recoveryNeeded=true;for(const listener of [...recoveryListeners])try{listener();}catch{/* One view cannot block recovery delivery. */}};
    const stopRecoveryReceiver=()=>{const stop=recoveryStop;recoveryStop=undefined;try{stop?.();}catch{/* A retired receiver cannot undo the backend acknowledgment. */}};
    const unavailable=(code:string,message:string)=>Object.assign(new Error(message),{code,source:'host',commitUncertain:true});
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
      ...createDesktopConditionalSavedSources(async(method,input)=>{const value=await call(method,input);if(released)throw Object.assign(new Error('Durable desktop context released'),{code:'client_not_admitted',source:'host'});return value;},binding.conditionalSavedSourceAvailable===true),
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
    durableWrites=Object.freeze<DurableWrites>({
      readText:path=>retainedCall('readText',[path]),readTextById:id=>retainedCall('readTextById',[id]),
      ...(originalWrites.composeNote?{composeNote:(input:import('../core/durable-writes.ts').DurableNoteCompositionInput)=>retainedCall<import('../core/durable-writes.ts').DurableNoteComposition|null>('composeNote',[input])}:{}),
      planWrite:input=>retainedCall('planWrite',[input]),prepare:plan=>retainedCall('prepare',[plan]),commit:ref=>retainedCall('commit',[ref]),query:ref=>retainedCall('query',[ref]),
      listUnacknowledged:()=>retainedCall('listUnacknowledged',[]),acknowledge:(ref,outcome)=>retainedCall('acknowledge',[ref,outcome]),
      captureSavedSource:input=>retainedCall('captureSavedSource',[input]),releaseSavedSource:input=>retainedCall('releaseSavedSource',[input]),
      checkpoints:Object.freeze<DurableWrites['checkpoints']>({scope,load:key=>retainedCheckpoint('load',[key]),compareAndSwap:change=>retainedCheckpoint('compareAndSwap',[change]),list:options=>retainedCheckpoint('list',[options]),changes:options=>retainedCheckpoint('changes',[options])}),
    });
    let binaryDrained=false,documentsDrained=false,draftsDrained=false;
    type EntryCommand=Extract<DatabaseRequest,{op:'set_entry'}>;
    type EntryCapsule={command:EntryCommand;fingerprint:string;attempt:number;claims:number;promise?:Promise<DatabaseResponse>;resolve?:(value:DatabaseResponse)=>void;reject?:(error:unknown)=>void;response?:DatabaseResponse;error?:unknown};
    const entryCapsules=new Map<string,EntryCapsule>();
    const entryHolds=new Map<string,{fingerprint:string;count:number}>();
    const captureEntry=(command:DatabaseRequest):DesktopDatabaseRequest=>captureDatabaseRequest({schemaVersion:1,command});
    const capsuleFor=(command:DatabaseRequest)=>{
      try{const captured=captureEntry(command);if(captured.command.op!=='set_entry')return;
        const capsule=entryCapsules.get(captured.command.operationId);return capsule?.fingerprint===JSON.stringify(captured)?capsule:undefined;
      }catch{return;}
    };
    const settleEntry=(capsule:EntryCapsule,error:unknown,response?:DatabaseResponse)=>{
      const resolve=capsule.resolve,reject=capsule.reject;capsule.promise=undefined;capsule.resolve=undefined;capsule.reject=undefined;
      if(response){
        const saved=response.entries.find(entry=>entry.entryId===capsule.command.entryId);
        // Native exact retries also retry publication. A pending projection is
        // an honest result for this attempt, never a permanently cached receipt.
        capsule.response=saved&&!saved.pendingProjection&&!Object.keys(saved.problems??{}).length?structuredClone(response):undefined;
        capsule.error=undefined;resolve?.(response);
      }else{capsule.error=error;reject?.(error);}
    };
    const failEntries=(error:unknown)=>{for(const capsule of entryCapsules.values()){capsule.attempt++;if(capsule.promise)settleEntry(capsule,error);}};
    const heldEntry=(capsule:EntryCapsule)=>{const hold=entryHolds.get(capsule.command.operationId);return hold?.fingerprint===capsule.fingerprint&&hold.count>0;};
    const forgetReceipt=(capsule:EntryCapsule)=>{if(!capsule.claims&&!heldEntry(capsule)&&capsule.response&&entryCapsules.get(capsule.command.operationId)===capsule)entryCapsules.delete(capsule.command.operationId);};
    let replayEntries:((fresh:DatabaseService)=>void)|undefined;
    if(binding.databases===true){
      const original=createDatabaseService(request=>call('databaseCommand',request));
      const runEntry=(capsule:EntryCapsule,service:DatabaseService,replay=false)=>{
        if(!capsule.promise){capsule.promise=new Promise<DatabaseResponse>((resolve,reject)=>{capsule.resolve=resolve;capsule.reject=reject;});
          // Recovery also resumes an already rejected command before its widget
          // joins again. Preserve rejection for that owner without an unhandled task.
          void capsule.promise.catch(()=>{});
        }
        const result=capsule.promise,attempt=++capsule.attempt,epoch=durableEpoch;
        void service.request(capsule.command).then(value=>{
          if(capsule.attempt!==attempt)return;
          if(!replay&&(epoch!==durableEpoch||recoveryNeeded)){
            if(releasePending||released)settleEntry(capsule,unavailable('client_not_admitted','The desktop context was released before this edit was confirmed.'));
            return;
          }
          settleEntry(capsule,undefined,value);if(!replay&&!heldEntry(capsule)&&!capsule.claims)entryCapsules.delete(capsule.command.operationId);
        },error=>{
          if(capsule.attempt!==attempt)return;
          if(!replay&&(epoch!==durableEpoch||recoveryNeeded)&&!releasePending&&!released)return;
          const code=error&&typeof error==='object'&&'code'in error?String(error.code):'',retired=['client_not_admitted','client_ownership_lost'].includes(code);
          const uncertain=error&&typeof error==='object'&&'commitUncertain'in error&&error.commitUncertain===true;
          settleEntry(capsule,error);
          if(!replay&&!retired&&!uncertain&&!recoveryNeeded)entryCapsules.delete(capsule.command.operationId);
          if(!replay&&retired&&!releasePending&&!released)markRetired();
        });
        return result;
      };
      replayEntries=fresh=>{for(const capsule of entryCapsules.values()){
        if(capsule.claims>0){if(!capsule.response)runEntry(capsule,fresh,true);}
        else{capsule.attempt++;settleEntry(capsule,unavailable('client_not_admitted','This edit was not selected by its owner for recovery.'));entryCapsules.delete(capsule.command.operationId);}
      }};
      databases=Object.freeze({request(command:DatabaseRequest):Promise<DatabaseResponse>{
        let captured:DesktopDatabaseRequest;try{captured=captureEntry(command);}catch(error){return Promise.reject(error);}
        const blocked=released||recoveryNeeded||!!recovering||!!releasePending;
        if(captured.command.op==='set_entry'){
          const prior=entryCapsules.get(captured.command.operationId),fingerprint=JSON.stringify(captured);
          if(prior&&prior.fingerprint===fingerprint){
            if(prior.promise)return prior.promise;
            if(prior.response)return Promise.resolve(structuredClone(prior.response));
            if(recovered&&prior.claims>0)return runEntry(prior,recovered.databases!,true);
            if(!blocked)return runEntry(prior,original);
            return Promise.reject(prior.error??unavailable('client_not_admitted','This desktop context is no longer active.'));
          }
          if(blocked)return Promise.reject(unavailable('client_not_admitted','This desktop context is no longer active.'));
          if(prior)return Promise.reject(unavailable('idempotency_conflict','This edit differs from its originally captured request.'));
          const capsule:EntryCapsule={command:captured.command,fingerprint,attempt:0,claims:0};entryCapsules.set(capsule.command.operationId,capsule);
          return runEntry(capsule,original);
        }
        if(blocked)return Promise.reject(unavailable('client_not_admitted','This desktop context is no longer active.'));
        const epoch=durableEpoch;return original.request(captured.command).then(value=>{
          if(epoch!==durableEpoch||released||recoveryNeeded)throw unavailable('client_not_admitted','The desktop context changed while this request was pending.');return value;
        });
      }});
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
    const recoveryBridge=bridge as DesktopBridge&{recoverDurableContext?:(root:string,priorAdmissionId:string)=>Promise<DesktopDurableContext>};
    if(recoveryBridge.recoverDurableContext){
      recoveryStop=bridge.onDocumentRuntimeNudge?.(info.path,admissionId,()=>{},markRetired);
      recovery=Object.freeze({
        containsCapturedSetEntry(command:DatabaseRequest){return !!capsuleFor(command);},
        holdCapturedSetEntry(command:DatabaseRequest){
          const captured=captureEntry(command);if(captured.command.op!=='set_entry'||released||recoveryNeeded||recovering||releasePending)throw unavailable('client_not_admitted','This edit cannot acquire a receipt hold in a retired context.');
          const id=captured.command.operationId,fingerprint=JSON.stringify(captured),prior=entryHolds.get(id);
          if(prior&&prior.fingerprint!==fingerprint)throw unavailable('idempotency_conflict','This edit differs from its original receipt hold.');
          const hold=prior??{fingerprint,count:0};entryHolds.set(id,hold);hold.count++;let active=true;
          return()=>{if(!active)return;active=false;if(--hold.count===0&&entryHolds.get(id)===hold)entryHolds.delete(id);const capsule=capsuleFor(captured.command);if(capsule)forgetReceipt(capsule);};
        },
        claimCapturedSetEntry(command:DatabaseRequest){
          const capsule=capsuleFor(command);if(!capsule||released)throw unavailable('client_not_admitted','This edit has no admitted recovery capsule.');
          capsule.claims++;let active=true;
          return()=>{if(!active)return;active=false;capsule.claims--;forgetReceipt(capsule);};
        },
        subscribe(listener:()=>void){
          if(typeof listener!=='function')throw new Error('Recovery listener required');
          if(released)return()=>{};
          recoveryListeners.add(listener);
          if(recoveryNeeded)queueMicrotask(()=>{if(!released&&recoveryListeners.has(listener))try{listener();}catch{/* Observation cannot undo recovery. */}});
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
            for(const capability of ['conditionalSavedSourceAvailable','databases','documentSemantics','documentMaintenance','metadataRowsAvailable','propertyTargetsAvailable','basePreviewAvailable','draftsAvailable'] as const)
              if(binding[capability]===true&&next[capability]!==true)throw unavailable('durable_recovery_scope_changed','The recovered desktop context is missing an admitted capability.');
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
          void repair.finally(()=>{if(recovering===repair)recovering=undefined;}).catch(()=>{});
          return repair;
        },
      });
    }
    release=async()=>{
      if(recovering){await recovering;return;}if(released)return;if(releasePending)return releasePending;
      const retiring=(async()=>{
        if(drafts&&!draftsDrained){await drafts.release();draftsDrained=true;}if(workBlocks)await workBlocks.release();
        if(binary&&!binaryDrained){await scheduleBinaryTransfer(binary.streams,()=>binary!.release());binaryDrained=true;}
        if(documents&&!documentsDrained){await documents.release();documentsDrained=true;}
        await releaseContext(info.path,admissionId);released=true;durableEpoch++;stopRecoveryReceiver();recoveryListeners.clear();documentRuntime?.retire();
        failEntries(unavailable('client_not_admitted','The desktop context was released.'));entryCapsules.clear();entryHolds.clear();
      })();releasePending=retiring;
      try{await retiring;}catch(error){failEntries(error);throw error;}finally{if(releasePending===retiring)releasePending=undefined;}
    };
  }
  return {
    ...(release ? {release} : {}),
    ...(recovery?{recovery}:{}),
    ...(bridge.recoveryList&&bridge.recoveryRead?{recoveryHistory:{list:(entryId,options)=>bridge.recoveryList!(info.path,entryId,options),read:(entryId,snapshotId)=>bridge.recoveryRead!(info.path,entryId,snapshotId)}}:{}),
    ...(workBlocks?{workBlocks:workBlocks.service}:{}),
    ...(documents?{documentSemantics:documents.service}:{}),
    ...(databases?{databases}:{}),
    ...(reconciliation?{reconciliation}:{}),
    ...(binary?{recoverCommands:()=>scheduleBinaryTransfer(binary!.streams,()=>binary!.recover())}:{}),
    id: durableWrites ? `desktop-core:${durableWrites.checkpoints.scope.vaultId}:${durableWrites.checkpoints.scope.clientId}` : `desktop:${info.path}`,
    label: info.name,
    adapter: {
      ...(durableWrites ? {durableWrites} : {}),
      ...(documents?{documentSemantics:documents.service}:{}),
      ...(databases?{databases}:{}),
      ...(binary ? {binaryStreams:binary.streams} : {}),
      ...(createText ? {createText} : {}),
      list: () => bridge.list(info.path),
      stat: path => bridge.stat(info.path, path),
      read: path => bridge.read(info.path, path),
      readBinary: path => bridge.readBinary(info.path, path),
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
