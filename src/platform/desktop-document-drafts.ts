import {DocumentDraftError,documentDraftRequest,DOCUMENT_DRAFT_CHUNK_BYTES,DOCUMENT_DRAFT_PENDING_CALLS,DOCUMENT_DRAFT_PENDING_BYTES} from '../core/document-drafts.ts';
import type {DocumentDraftRequest,DocumentDraftScope,DocumentDraftTransport} from '../core/document-drafts.ts';
export interface DesktopDocumentDraftBinding {readonly transport:DocumentDraftTransport;release():Promise<void>;retire():void}
/** One admitted stdio client, independent of durable binary/save commands.
 * ContextBridge copies are bounded JS ownership, not native scratch grants. */
export function createDesktopDocumentDraftTransport(options:{
  readonly scope:DocumentDraftScope;
  readonly invoke:(request:DocumentDraftRequest,bytes:Uint8Array)=>Promise<unknown>;
  readonly subscribe:(listener:()=>void,onRetire:()=>void)=>()=>void;
}):DesktopDocumentDraftBinding{
  if(!options||typeof options.invoke!=='function'||typeof options.subscribe!=='function')throw new DocumentDraftError('invalid_document_response');
  let retired=false,pendingBytes=0;const pending=new Set<Promise<unknown>>(),slots=new Set<{stop:()=>void;onRetire:()=>void}>();
  const active=()=>{if(retired)throw new DocumentDraftError('client_not_admitted');};
  const retire=()=>{if(retired)return;retired=true;for(const slot of [...slots]){slots.delete(slot);try{slot.stop();}catch{/* Retire every admitted receiver. */}try{slot.onRetire();}catch{/* One observer cannot retain another. */}}};
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new DocumentDraftError('invalid_document_response');return value as Record<string,unknown>;};
  const exact=(row:Record<string,unknown>,keys:readonly string[])=>Object.keys(row).length===keys.length&&Object.keys(row).every(key=>keys.includes(key))&&keys.every(key=>{const descriptor=Object.getOwnPropertyDescriptor(row,key);return descriptor?.enumerable===true&&Object.hasOwn(descriptor,'value');});
  const transport:DocumentDraftTransport={scope:Object.freeze({...options.scope}),
    invoke(input,bytes=new Uint8Array()){
      active();const request=documentDraftRequest(input);
      if(!(bytes instanceof Uint8Array)||bytes.byteLength>DOCUMENT_DRAFT_CHUNK_BYTES||request.op!=='upload_chunk'&&bytes.byteLength!==0)throw new DocumentDraftError('draft_invalid_chunk');
      if(pending.size>=DOCUMENT_DRAFT_PENDING_CALLS||pendingBytes+bytes.byteLength>DOCUMENT_DRAFT_PENDING_BYTES)throw new DocumentDraftError('draft_capacity');
      const size=bytes.byteLength;pendingBytes+=size;
      let captured:Uint8Array;try{captured=new Uint8Array(bytes);}catch(error){pendingBytes-=size;throw error;}
      const call=(async()=>{
        let raw:unknown;try{active();raw=await options.invoke(request,captured);}catch{active();throw new DocumentDraftError('draft_io');}active();
        const row=object(raw);
        const ok=Object.getOwnPropertyDescriptor(row,'ok');
        if(!ok||!Object.hasOwn(ok,'value')||typeof ok.value!=='boolean'||!exact(row,['documentDrafts','schemaVersion','ok',ok.value?'value':'error'])||row.documentDrafts!==true||row.schemaVersion!==1)throw new DocumentDraftError('invalid_document_response');
        if(row.ok)return row.value;
        const error=object(row.error);if(!exact(error,['code','commitUncertain'])||typeof error.code!=='string'||!/^[a-z_]{1,64}$/.test(error.code)||typeof error.commitUncertain!=='boolean')throw new DocumentDraftError('invalid_document_response');
        throw Object.assign(new DocumentDraftError(error.code),{commitUncertain:error.commitUncertain,source:'host'});
      })();
      pending.add(call);const done=()=>{pending.delete(call);pendingBytes-=size;};void call.then(done,done);return call;
    },
    subscribe(listener,onRetire){
      active();if(typeof listener!=='function'||typeof onRetire!=='function')throw new DocumentDraftError('draft_invalid_request');
      const slot={stop:()=>{},onRetire};slots.add(slot);
      try{const stop=options.subscribe(()=>{if(!retired&&slots.has(slot))listener();},retire);if(typeof stop!=='function')throw new DocumentDraftError('invalid_document_response');slot.stop=stop;}catch(error){slots.delete(slot);throw error;}
      if(retired){slots.delete(slot);slot.stop();}
      return()=>{if(slots.delete(slot))slot.stop();};
    },
  };
  return {transport:Object.freeze(transport),retire,async release(){retire();await Promise.allSettled([...pending]);}};
}
