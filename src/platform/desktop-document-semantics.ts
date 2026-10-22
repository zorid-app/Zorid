import {createDocumentService,documentSnapshot,documentSource,DocumentSemanticsError,documentErrorCode} from '../core/document-semantics.ts';
import type {DocumentService,DocumentSnapshotId,DocumentTransport} from '../core/document-semantics.ts';
import {DocumentRuntimeError} from '../core/document-runtime.ts';
import type {DocumentRuntimeScope,DocumentRuntimeTransport} from '../core/document-runtime.ts';
import {documentPreviewClose,documentPreviewEnvelope} from '../core/document-preview.ts';
import type {DocumentDraftTransport} from '../core/document-drafts.ts';

export interface DesktopDocumentRequest {schemaVersion:1;command:Readonly<Record<string,unknown>>&{op:string}}
type RuntimeMethod='documentRuntimeObserve'|'documentRuntimeControl'|'documentRuntimeAckControl'|'documentRuntimeAckOutcome';
export interface DesktopDocumentRuntimeBinding {readonly transport:DocumentRuntimeTransport;retire():void}
/** Allocate once per admitted desktop context; facade reconstruction reuses this
 * transport, preserving both independent monotonic counters and release identity. */
export function createDesktopDocumentRuntime(options:{
  readonly scope:DocumentRuntimeScope;
  readonly invoke:(method:RuntimeMethod,args:readonly unknown[])=>Promise<unknown>;
  readonly subscribe:(listener:()=>void,onRetire:()=>void)=>()=>void;
}):DesktopDocumentRuntimeBinding{
  let sequence=0n,requestId=0n,retired=false;
  const subscriptions=new Set<{stop:()=>void;onRetire:()=>void}>();
  const active=()=>{if(retired)throw new DocumentRuntimeError('client_not_admitted');};
  const next=(value:bigint)=>{active();if(value===18446744073709551615n)throw new DocumentRuntimeError('document_runtime_capacity');return value+1n;};
  const retire=()=>{if(retired)return;retired=true;for(const item of [...subscriptions]){subscriptions.delete(item);try{item.stop();}catch{/* Retire every admitted receiver. */}try{item.onRetire();}catch{/* One receiver cannot prevent retiring another. */}}};
  const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new DocumentRuntimeError('document_runtime_invalid_result');return value as Record<string,unknown>;};
  const invoke=async(method:RuntimeMethod,args:readonly unknown[]):Promise<unknown>=>{
    active();const raw=await options.invoke(method,structuredClone(args));active();const row=object(raw);
    if(row.documentRuntime!==true||row.schemaVersion!==1||typeof row.ok!=='boolean'||!exact(row,['documentRuntime','schemaVersion','ok',row.ok?'value':'error']))throw new DocumentRuntimeError('document_runtime_invalid_result');
    if(row.ok)return row.value;
    const error=object(row.error);
    if(!exact(error,['code','source','commitUncertain'])||typeof error.code!=='string'||!/^[a-z_]{1,64}$/.test(error.code)||error.source!=='host'||typeof error.commitUncertain!=='boolean')throw new DocumentRuntimeError('document_runtime_invalid_result');
    throw Object.assign(new DocumentRuntimeError(error.code),{source:'host',commitUncertain:error.commitUncertain});
  };
  const ack=async(method:RuntimeMethod,input:unknown)=>{if(await invoke(method,[input])!==true)throw new DocumentRuntimeError('document_runtime_invalid_result');};
  const transport:DocumentRuntimeTransport={scope:Object.freeze({...options.scope}),
    allocateSequence:()=>String(sequence=next(sequence)),allocateRequestId:()=>String(requestId=next(requestId)),
    observe:()=>invoke('documentRuntimeObserve',[]),control:input=>invoke('documentRuntimeControl',[input]),
    ackControl:input=>ack('documentRuntimeAckControl',input),ackOutcome:input=>ack('documentRuntimeAckOutcome',input),
    subscribe(listener,onRetire){
      if(retired){onRetire();return()=>{};}
      const item={stop:()=>{},onRetire};subscriptions.add(item);
      try{const stop=options.subscribe(()=>{if(!retired&&subscriptions.has(item))listener();},retire);if(typeof stop!=='function')throw new DocumentRuntimeError('document_runtime_invalid_result');item.stop=stop;}
      catch(error){subscriptions.delete(item);throw error;}
      if(retired){subscriptions.delete(item);item.stop();}
      return()=>{if(subscriptions.delete(item))item.stop();};
    },
  };
  return {transport:Object.freeze(transport),retire};
}
/** One instance per admitted desktop context. The invocation closure must retain
 * that admission and its normal release guard; it is not an unrestricted IPC. */
export interface DesktopDocumentBinding {readonly service:DocumentService;release():Promise<void>}
export function createDesktopDocumentService(invoke:(request:DesktopDocumentRequest)=>Promise<unknown>,maintenance?:DocumentRuntimeTransport,capabilities:{readonly metadataRowsAvailable?:boolean;readonly propertyTargetsAvailable?:boolean;readonly draftsAvailable?:boolean;readonly drafts?:DocumentDraftTransport;readonly basePreviewAvailable?:boolean}={}):DesktopDocumentBinding{
  const metadataRowsAvailable=capabilities.metadataRowsAvailable===true;
  const propertyTargetsAvailable=capabilities.propertyTargetsAvailable===true;
  const basePreviewAvailable=capabilities.basePreviewAvailable===true;
  if(basePreviewAvailable&&(!maintenance||typeof invoke!=='function'))throw new DocumentSemanticsError('unsupported_host_capability');
  if(metadataRowsAvailable&&typeof invoke!=='function')throw new DocumentSemanticsError('invalid_document_response');
  const stages=new Map<string,DocumentSnapshotId>();let stageSequence=0n,pinSequence=0n;
  let opening:Promise<unknown>|undefined,pendingPin:string|undefined;
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new DocumentSemanticsError('invalid_document_response');return value as Record<string,unknown>;};
  let phase:'active'|'releasing'|'released'='active',releasing:Promise<void>|undefined;
  const pendingCalls=new Set<Promise<unknown>>(),pins=new Set<string>(),previews=new Set<string>();
  const raw=(op:string,fields:Record<string,unknown>={})=>invoke({schemaVersion:1,command:{op,...fields}}).then(value=>{
    // Direct admitted callbacks (including the native mobile binding) retain
    // their raw result contract. Only explicitly marked query IPC is unwrapped.
    if(!['rich_start','rich_prepare','rich_page','rich_close','metadata_rows','preview_open','preview_base','preview_close'].includes(op)||!value||typeof value!=='object'||!('documents'in value))return value;
    const row=object(value),exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
    if(row.documents!==true||row.schemaVersion!==1||typeof row.ok!=='boolean'||!exact(row,['documents','schemaVersion','ok',row.ok?'value':'error']))throw new DocumentSemanticsError('invalid_document_response');
    if(row.ok)return row.value;
    const error=object(row.error),hasDetails=Object.hasOwn(error,'details');
    if(!exact(error,['code','commitUncertain',...(hasDetails?['details']:[])])||typeof error.code!=='string'||!/^[a-z_]{1,64}$/.test(error.code)||typeof error.commitUncertain!=='boolean'||hasDetails&&(error.code!=='search_compile'||op==='metadata_rows'||op.startsWith('preview_')))throw new DocumentSemanticsError('invalid_document_response');
    // The common facade validates compile details against this exact query.
    throw Object.assign(new Error('Document query failed.'),{code:error.code,commitUncertain:error.commitUncertain,...(hasDetails?{details:error.details}:{})});
  });
  const command=(op:string,fields:Record<string,unknown>={}):Promise<unknown>=>{
    if(phase!=='active')return Promise.reject(new DocumentSemanticsError('client_not_admitted'));
    if(op==='preview_open')previews.add(String(fields.previewId));
    const call=Promise.resolve().then(()=>raw(op,fields)).then(value=>{
      // Keep late admitted previews owned for release cleanup before rejecting
      // their delivery. A close failure retains its exact ID for retry.
      if(op==='preview_open'&&value===null)previews.delete(String(fields.previewId));
      if(op==='preview_close'){documentPreviewClose(value);previews.delete(String(fields.previewId));}
      if((op==='metadata_rows'||op.startsWith('preview_'))&&phase!=='active')throw new DocumentSemanticsError('client_not_admitted');
      if(op==='open')pins.add(String(fields.pinId));else if(op==='close')pins.delete(String(fields.pinId));return value;
    },error=>{
      if(op==='preview_open'){
        const code=documentErrorCode(error),certain=!!error&&typeof error==='object'&&'commitUncertain'in error&&error.commitUncertain===false;
        // A malformed/uncertain acknowledgement may conceal a real capture.
        // Only proven empty or expired opens relinquish cleanup ownership.
        if(code==='index_preview_expired'||certain&&code!=='invalid_document_response')previews.delete(String(fields.previewId));
      }
      if((op==='metadata_rows'||op.startsWith('preview_'))&&phase!=='active')throw new DocumentSemanticsError('client_not_admitted');throw error;
    });
    pendingCalls.add(call);void call.then(()=>pendingCalls.delete(call),()=>pendingCalls.delete(call));return call;
  };
  const runtimeActive=()=>{if(phase!=='active')throw new DocumentRuntimeError('client_not_admitted');};
  const runtimeCall=<T>(action:()=>Promise<T>):Promise<T>=>{
    try{runtimeActive();const call=action();pendingCalls.add(call);void call.then(()=>pendingCalls.delete(call),()=>pendingCalls.delete(call));return call;}
    catch(error){return Promise.reject(error);}
  };
  const runtimeTransport:DocumentRuntimeTransport|undefined=maintenance?{...maintenance,
    allocateSequence:()=>{runtimeActive();return maintenance.allocateSequence();},allocateRequestId:()=>{runtimeActive();return maintenance.allocateRequestId();},
    observe:()=>runtimeCall(()=>maintenance.observe()),control:input=>runtimeCall(()=>maintenance.control(input)),
    ackControl:input=>runtimeCall(()=>maintenance.ackControl(input)),ackOutcome:input=>runtimeCall(()=>maintenance.ackOutcome(input)),
    subscribe(listener,onRetire){runtimeActive();return maintenance.subscribe(listener,onRetire);},
  }:undefined;
  const snapshotFor=(id:string)=>{const snapshot=stages.get(id);if(!snapshot)throw new DocumentSemanticsError('stage_expired');return snapshot;};
  const transport:DocumentTransport={
    ...(basePreviewAvailable?{basePreviewAvailable:true,
      previewOpen:(input:Parameters<NonNullable<DocumentTransport['previewOpen']>>[0])=>command('preview_open',input),
      previewBase:async(input:Parameters<NonNullable<DocumentTransport['previewBase']>>[0])=>{
        const value=await command('preview_base',{...input});
        // Native stdio replies retain the bounded raw envelope until this
        // renderer boundary. The common handle validates the exact capture.
        return value&&typeof value==='object'&&Object.hasOwn(value,'previewBytes')?documentPreviewEnvelope(value):value;
      },
      previewClose:(input:Parameters<NonNullable<DocumentTransport['previewClose']>>[0])=>command('preview_close',input),
    }:{}),
    ...(capabilities.draftsAvailable===true?{draftsAvailable:true,drafts:capabilities.drafts}:{}),
    ...(runtimeTransport?{maintenance:runtimeTransport}:{}),
    ...(metadataRowsAvailable?{metadataRowsAvailable:true,metadataRows:(input:Parameters<NonNullable<DocumentTransport['metadataRows']>>[0])=>command('metadata_rows',input)}:{}),
    async status(){
      const value=object(await command('status'));
      // The host supplies an exact source capture even before a cache exists.
      // No synthetic watermark is permitted for fresh or corrupt derived state.
      if('current'in value)return value;
      const source=documentSource(value.source);
      if(!['uninitialized','rebuild_required','building','ready'].includes(String(value.state)))throw new DocumentSemanticsError('invalid_document_response');
      if(value.state!=='ready')return {source,snapshot:null,coveredSource:null,current:false,rebuildRequired:value.state==='rebuild_required',coverageComplete:null};
      const snapshot=documentSnapshot(value.snapshot),coveredSource=documentSource({localStoreId:snapshot.localStoreId,watermark:value.coveredWatermark});
      if(value.observedSourceHead!==source.watermark)throw new DocumentSemanticsError('invalid_document_response');
      return {source,snapshot,coveredSource,current:coveredSource.localStoreId===source.localStoreId&&coveredSource.watermark===source.watermark,rebuildRequired:false,coverageComplete:value.coverageComplete};
    },
    async initialize(){await command('initialize');},async rebuild(){await command('rebuild');stages.clear();},
    async begin(){
      if(stages.size>=4)throw new DocumentSemanticsError('stage_limit');
      const row=object(await command('begin')),snapshot=documentSnapshot(row.snapshot),stageId=`desktop-stage-${++stageSequence}`;
      stages.set(stageId,snapshot);return {stageId,snapshot,progress:null};
    },
    async pump(stageId){const snapshot=snapshotFor(stageId),row=object(await command('pump',{snapshot}));return {stageId,snapshot:row.snapshot,progress:{prepared:row.preparedDocuments,total:row.totalDocuments,reused:row.reusedDocuments,ready:row.ready,...(row.parseCache===undefined?{}:{parseCache:row.parseCache})}};},
    async publish(stageId){const value=await command('publish',{snapshot:snapshotFor(stageId)});stages.delete(stageId);return value;},
    async discard(stageId){await command('discard',{snapshot:snapshotFor(stageId)});stages.delete(stageId);},
    open(){
      // An uncertain open retries the same sequence. Concurrent calls serialize
      // into independent pins once the preceding open has succeeded.
      if(opening)return opening.then(()=>transport.open());
      if(!pendingPin){if(pinSequence===18446744073709551615n)return Promise.reject(new DocumentSemanticsError('pin_sequence_exhausted'));pendingPin=String(++pinSequence);}
      const pinId=pendingPin;
      opening=command('open',{pinId}).then(value=>{pendingPin=undefined;return value;},error=>{if(documentErrorCode(error)==='snapshot_expired')pendingPin=undefined;throw error;}).finally(()=>{opening=undefined;});return opening;
    },
    async closePin(pinId){await command('close',{pinId});},
    metadata:input=>command('metadata',input),
    search:input=>command('search',{...input,limit:input.limit??100}),
    richStart:input=>command('rich_start',input),
    richPrepare:input=>command('rich_prepare',input),
    richPage:input=>command('rich_page',input),
    richClose:async input=>{await command('rich_close',input);},
    backlinks:({targetId,...input})=>command('backlinks',{...input,id:targetId,limit:input.limit??100}),
    tasks:input=>command('tasks',input),
    base:input=>command('base',input),
    ...(propertyTargetsAvailable?{propertyTargets:(input:Parameters<NonNullable<DocumentTransport['propertyTargets']>>[0])=>command('property_targets',input)}:{}),
  };
  return {service:createDocumentService(transport),release(){
    if(phase==='released')return Promise.resolve();if(releasing)return releasing;phase='releasing';
    releasing=(async()=>{
      // New semantic reads are blocked before draining admitted requests. Source
      // writes retain their existing save/release protocol in the binding.
      await Promise.allSettled([...pendingCalls]);
      for(const previewId of [...previews]){documentPreviewClose(await raw('preview_close',{previewId}));previews.delete(previewId);}
      for(const pinId of [...pins]){await raw('close',{pinId});pins.delete(pinId);}
      for(const [stageId,snapshot] of [...stages]){await raw('discard',{snapshot});stages.delete(stageId);}
      phase='released';
    })().finally(()=>{releasing=undefined;});return releasing;
  }};
}
/** Convenience for hosts whose containing admission owns all final cleanup. */
export function desktopDocumentService(invoke:(request:DesktopDocumentRequest)=>Promise<unknown>):DocumentService{return createDesktopDocumentService(invoke).service;}
