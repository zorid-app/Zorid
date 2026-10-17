import {createDocumentService,documentSnapshot,documentSource,DocumentSemanticsError,documentErrorCode} from '../core/document-semantics.ts';
import type {DocumentService,DocumentSnapshotId,DocumentTransport} from '../core/document-semantics.ts';

export interface DesktopDocumentRequest {schemaVersion:1;command:Readonly<Record<string,unknown>>&{op:string}}
/** One instance per admitted desktop context. The invocation closure must retain
 * that admission and its normal release guard; it is not an unrestricted IPC. */
export interface DesktopDocumentBinding {readonly service:DocumentService;release():Promise<void>}
export function createDesktopDocumentService(invoke:(request:DesktopDocumentRequest)=>Promise<unknown>):DesktopDocumentBinding{
  const stages=new Map<string,DocumentSnapshotId>();let stageSequence=0n,pinSequence=0n;
  let opening:Promise<unknown>|undefined,pendingPin:string|undefined;
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new DocumentSemanticsError('invalid_document_response');return value as Record<string,unknown>;};
  let phase:'active'|'releasing'|'released'='active',releasing:Promise<void>|undefined;
  const pendingCalls=new Set<Promise<unknown>>(),pins=new Set<string>();
  const raw=(op:string,fields:Record<string,unknown>={})=>invoke({schemaVersion:1,command:{op,...fields}});
  const command=(op:string,fields:Record<string,unknown>={}):Promise<unknown>=>{
    if(phase!=='active')return Promise.reject(new DocumentSemanticsError('client_not_admitted'));
    const call=Promise.resolve().then(()=>raw(op,fields)).then(value=>{if(op==='open')pins.add(String(fields.pinId));else if(op==='close')pins.delete(String(fields.pinId));return value;});
    pendingCalls.add(call);void call.then(()=>pendingCalls.delete(call),()=>pendingCalls.delete(call));return call;
  };
  const snapshotFor=(id:string)=>{const snapshot=stages.get(id);if(!snapshot)throw new DocumentSemanticsError('stage_expired');return snapshot;};
  const transport:DocumentTransport={
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
    async pump(stageId){const snapshot=snapshotFor(stageId),row=object(await command('pump',{snapshot}));return {stageId,snapshot:row.snapshot,progress:{prepared:row.preparedDocuments,total:row.totalDocuments,reused:row.reusedDocuments,ready:row.ready}};},
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
    backlinks:({targetId,...input})=>command('backlinks',{...input,id:targetId,limit:input.limit??100}),
    base:input=>command('base',input),
  };
  return {service:createDocumentService(transport),release(){
    if(phase==='released')return Promise.resolve();if(releasing)return releasing;phase='releasing';
    releasing=(async()=>{
      // New semantic reads are blocked before draining admitted requests. Source
      // writes retain their existing save/release protocol in the binding.
      await Promise.allSettled([...pendingCalls]);
      for(const pinId of [...pins]){await raw('close',{pinId});pins.delete(pinId);}
      for(const [stageId,snapshot] of [...stages]){await raw('discard',{snapshot});stages.delete(stageId);}
      phase='released';
    })().finally(()=>{releasing=undefined;});return releasing;
  }};
}
/** Convenience for hosts whose containing admission owns all final cleanup. */
export function desktopDocumentService(invoke:(request:DesktopDocumentRequest)=>Promise<unknown>):DocumentService{return createDesktopDocumentService(invoke).service;}
