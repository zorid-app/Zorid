import {BrowserVaultError} from './browser-vault.ts';
import type {EntryState} from './browser-vault.ts';

/** Generated interfaces deliberately pass Uint8Array objects by reference. Rust
 * reserves its source/result allocation before copying from the JS view. */
export interface PreviewOwner {clear():void;retireStage(id:string):void;free():void}
export interface PreviewReply {encodedLength():number;writeInto(target:Uint8Array):void;free():void}
export interface PreviewQuery {descriptorJson():string;prepareBase(source:Uint8Array):PreviewReply;cancel():void;free():void}
export interface PreviewValue {descriptorJson():string;sameCapture(other:PreviewValue):boolean;beginBase(request:string):PreviewQuery;free():void}
export interface PreviewBuilder {configurePreview(owner:PreviewOwner,nonce:string,stageId:string):void;commitPreviewRowsJson(batch:string):void;capturePreview():PreviewValue|undefined;retirePreview():void}
export interface PreviewWasm {WasmDocumentPreviewOwner?:{new(client:string,nonce:string):PreviewOwner;prototype:PreviewOwner};WasmDocumentPreview?:{prototype:PreviewValue};WasmDocumentPreviewQuery?:{prototype:PreviewQuery};WasmDocumentPreviewReply?:{prototype:PreviewReply}}
export interface PreviewCandidate {readonly stage:object;readonly value:PreviewValue;readonly stamp:object}
export interface PreviewReadReply {readonly length:number;writeInto(target:Uint8Array):void;validate():Promise<void>;free():void}
interface PreviewDescriptor {capture:{ownerNonce:string;stageId:string;serial:string};source:unknown;progress:{preparedFiles:number;totalFiles:number;pendingFiles:number}}
export interface PreviewHooks {
  assertActive():void;isLive(candidate:PreviewCandidate):boolean;capture():Promise<PreviewCandidate|undefined>;
  fence(candidate:PreviewCandidate,definition?:EntryState):Promise<void>;
  read(candidate:PreviewCandidate,definition:EntryState,sourceBytes:number):Promise<Uint8Array>;
  ordinarySlots():Promise<number>;
}
const failure=(code='index_preview_expired')=>new BrowserVaultError(code,'The prepared Bases preview is unavailable');
function parse<T>(raw:string,maximum=65536):T {if(typeof raw!=='string'||raw.length>maximum||new TextEncoder().encode(raw).byteLength>maximum)throw failure('index_preview_invalid');try{return JSON.parse(raw) as T;}catch{throw failure('index_preview_invalid');}}
export function browserPreviewCall<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;let code='index_preview_invalid';try{const value=parse<{code?:unknown}>(String(error));if(typeof value.code==='string'&&/^(preview_|base_|index_)[a-z_]+$/.test(value.code))code=value.code;}catch{/* Closed fallback. */}throw failure(code);}}
function previewId(input:unknown):string {if(typeof input!=='string'||!(/^[1-9][0-9]{0,19}$/).test(input)||BigInt(input)>18446744073709551615n)throw failure('index_invalid_request');return input;}
/** O(1) registered weak handles: captures remain owned only by the Rust producer
 * or an admitted query guard. Scalar descriptors never establish authority. */
export function createBrowserDocumentPreview(hooks:PreviewHooks) {
  const handles=new Map<string,{candidate:PreviewCandidate;descriptor:PreviewDescriptor}>();
  let highwater=0n,requested=false,busy=false,queryBusy=false,pendingOpen=0,pendingOpenId:string|undefined,pendingOpenCancelled=false;
  function local(id:string,binding:ReturnType<typeof handles.get>):asserts binding is NonNullable<typeof binding>{hooks.assertActive();if(!binding||handles.get(id)!==binding)throw failure();}
  function descriptor(candidate:PreviewCandidate):PreviewDescriptor{return parse(browserPreviewCall(()=>candidate.value.descriptorJson()));}
  async function admitted(id:string,binding:NonNullable<ReturnType<typeof handles.get>>,definition?:EntryState){local(id,binding);await hooks.fence(binding.candidate,definition);local(id,binding);}
  // Generated weak wrappers belong to the actual producer. Multiple registered
  // handles may reference its current candidate without retaining its backing.
  function clear(){handles.clear();requested=false;if(pendingOpenId!==undefined)pendingOpenCancelled=true;}
  function remove(id:string){handles.delete(id);}
  return {
    wantsCapture:()=>requested||handles.size>0,
    consumeRequest:()=>{requested=false;},
    slotCount:()=>{for(const [id,binding]of handles)if(!hooks.isLive(binding.candidate))remove(id);return handles.size+pendingOpen;},
    clear,
    async open(raw:{previewId:string}):Promise<unknown>{
      hooks.assertActive();const id=previewId(raw.previewId),prior=handles.get(id);
      if(prior){await admitted(id,prior);return {previewId:id,...prior.descriptor};}
      if(BigInt(id)<=highwater)throw failure();
      if(busy)throw failure('index_preview_busy');busy=true;pendingOpen=1;pendingOpenId=id;pendingOpenCancelled=false;
      const pendingActive=()=>{hooks.assertActive();if(pendingOpenId!==id||pendingOpenCancelled)throw failure();};
      try{
        // IDs are spent before async capture and are never rebound after failure.
        highwater=BigInt(id);requested=true;
        for(const [key,binding]of handles){try{await admitted(key,binding);}catch{remove(key);}}
        if(handles.size+await hooks.ordinarySlots()>=4)throw failure('index_preview_resource');
        pendingActive();const candidate=await hooks.capture();pendingActive();
        if(!candidate)return null;
        await hooks.fence(candidate);pendingActive();
        if(handles.size+await hooks.ordinarySlots()>=4)throw failure('index_preview_resource');
        pendingActive();await hooks.fence(candidate);pendingActive();
        const value=descriptor(candidate);pendingActive();if(!hooks.isLive(candidate))throw failure();handles.set(id,{candidate,descriptor:value});requested=false;
        return {previewId:id,...value};
      }finally{pendingOpen=0;pendingOpenId=undefined;pendingOpenCancelled=false;busy=false;}
    },
    async base(input:{previewId:string;id:string;viewName?:string|null;options?:unknown}):Promise<PreviewReadReply>{
      const id=previewId(input.previewId),binding=handles.get(id);local(id,binding);
      await admitted(id,binding);
      if(queryBusy)throw failure('index_preview_busy');queryBusy=true;
      let query:PreviewQuery;try{query=browserPreviewCall(()=>binding.candidate.value.beginBase(JSON.stringify(input)));}catch(error){queryBusy=false;throw error;}
      /* The single active bridge owns its borrowed reply until actual handoff. */
      let reply:PreviewReply|undefined,disposed=false;
      try{
        const context=parse<{definition:EntryState;sourceBytes:number}>(browserPreviewCall(()=>query.descriptorJson()));
        if(!context.definition||context.definition.kind!=='file'||context.definition.id!==input.id||!Number.isSafeInteger(context.sourceBytes)||context.sourceBytes<0||context.sourceBytes>262144)throw failure('index_preview_invalid');
        await admitted(id,binding,context.definition);
        const source=await hooks.read(binding.candidate,context.definition,context.sourceBytes);
        await admitted(id,binding,context.definition);
        if(!(source instanceof Uint8Array)||source.byteLength!==context.sourceBytes)throw failure('index_preview_expired');
        reply=browserPreviewCall(()=>query.prepareBase(source));await admitted(id,binding,context.definition);
        const length=browserPreviewCall(()=>reply!.encodedLength());if(!Number.isSafeInteger(length)||length<1||length>16*1024*1024)throw failure('index_preview_resource');
        const owned=reply;reply=undefined;
        return {length,writeInto(target){if(disposed)throw failure();local(id,binding);if(target.byteLength!==length)throw failure('index_invalid_request');browserPreviewCall(()=>owned.writeInto(target));local(id,binding);},async validate(){if(disposed)throw failure();await admitted(id,binding,context.definition);},free(){if(!disposed){disposed=true;try{owned.free();}finally{try{query.free();}finally{queryBusy=false;}}}}};
      }catch(error){try{reply?.free();query.cancel();query.free();}finally{queryBusy=false;}throw error;}
    },
    async close(raw:{previewId:string}){hooks.assertActive();const id=previewId(raw.previewId);if(BigInt(id)>highwater)throw failure();if(pendingOpenId===id){pendingOpenCancelled=true;requested=false;}remove(id);return {closed:true};},
  };
}
