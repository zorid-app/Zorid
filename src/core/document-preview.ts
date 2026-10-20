import type {DocumentBaseOptions,DocumentBaseResult,DocumentBaseRefreshHint,DocumentEntry,DocumentSourceId} from './document-semantics.ts';
export const DOCUMENT_PREVIEW_REQUEST_BYTES=64*1024,DOCUMENT_PREVIEW_RESPONSE_BYTES=16*1024*1024;
export interface DocumentPreviewCapture {readonly ownerNonce:string;readonly stageId:string;readonly serial:string}
export interface DocumentPreviewProgress {readonly preparedFiles:number;readonly totalFiles:number;readonly pendingFiles:number}
export interface DocumentPreviewOpen {readonly previewId:string;readonly capture:DocumentPreviewCapture;readonly source:DocumentSourceId;readonly progress:DocumentPreviewProgress}
export interface DocumentBasePreviewResult extends Omit<DocumentBaseResult,'snapshotId'|'refreshHint'> {
  readonly status:'indexing';readonly complete:false;readonly aggregatesComplete:false;readonly countsScope:'preparedSubset';
  readonly progress:DocumentPreviewProgress;readonly preparedScanComplete:boolean;readonly unavailablePreparedFiles:number;readonly unavailableFilterRows:number;
  readonly refreshHint:DocumentBaseRefreshHint|null;
}
export interface DocumentPreviewRead {readonly previewId:string;readonly capture:DocumentPreviewCapture;readonly source:DocumentSourceId;readonly definition:DocumentEntry;readonly result:DocumentBasePreviewResult}
export interface DocumentPreviewQueryInput {readonly id:string;readonly viewName?:string|null;readonly options?:DocumentBaseOptions}
export interface DocumentPreviewIdInput {readonly previewId:string}
export interface DocumentPreviewBaseInput extends DocumentPreviewQueryInput {readonly previewId:string}
export type DocumentPreviewBaseRequest=DocumentPreviewBaseInput;
export interface DocumentPreviewTransport {
  previewOpen(input:{readonly previewId:string}):Promise<unknown>;
  previewBase(input:DocumentPreviewBaseRequest):Promise<unknown>;
  previewClose(input:{readonly previewId:string}):Promise<unknown>;
}
/** Coalescing labels are readonly display identity, never storage authority. */
export interface DocumentPreviewHandle extends DocumentPreviewOpen {base(input:DocumentPreviewQueryInput):Promise<DocumentPreviewRead>;close():Promise<void>}
export interface DocumentPreviewService {openPreview():Promise<DocumentPreviewHandle|null>}
export class DocumentPreviewError extends Error {readonly code:string;constructor(code='invalid_document_response'){super('Document preview is unavailable.');this.name='DocumentPreviewError';this.code=code;}}
function bad(code='invalid_document_response'):never{throw new DocumentPreviewError(code);}
function row(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return bad();
  for(const key in value)if(Object.hasOwn(value,key)&&!required.includes(key)&&!optional.includes(key))bad();
  for(const key of [...required,...optional]){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor){if(required.includes(key))bad();}else if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))bad();}
  return value as Record<string,unknown>;
}
function text(value:unknown,empty=true):string{if(typeof value!=='string'||!empty&&!value.length)bad();for(let index=0;index<value.length;index++){const unit=value.charCodeAt(index);if(unit>=0xd800&&unit<=0xdbff){const low=value.charCodeAt(++index);if(!(low>=0xdc00&&low<=0xdfff))bad();}else if(unit>=0xdc00&&unit<=0xdfff)bad();}return value;}
const id=(value:unknown):string=>{const result=text(value,false);return /^[A-Za-z0-9_-]{1,128}$/.test(result)?result:bad();};
function decimal(value:unknown):string{const result=text(value,false);if(!/^[1-9][0-9]{0,19}$/.test(result)||BigInt(result)>18446744073709551615n)bad();return result;}
function uint(value:unknown,max=Number.MAX_SAFE_INTEGER):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max||Object.is(value,-0))bad();return value;}
function bool(value:unknown):boolean{if(typeof value!=='boolean')bad();return value;}
function list(value:unknown,max=100000):unknown[]{if(!Array.isArray(value)||value.length>max)bad();return value;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Count the encoded wire without creating a whole JSON string or executing
 * getters/toJSON. Tagged recursive Bases values need several wire levels. */
export function documentPreviewBound(value:unknown,maximum:number,request=false):void{
  let remaining=maximum;const ancestors=new Set<object>();
  const take=(size:number)=>{if(size>remaining)bad();remaining-=size;};
  function string(value:string){take(2);for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code===34||code===92||code===8||code===9||code===10||code===12||code===13)take(2);else if(code<32)take(6);else if(code<128)take(1);else if(code<2048)take(2);else if(code>=0xd800&&code<=0xdbff){const low=value.charCodeAt(++index);if(!(low>=0xdc00&&low<=0xdfff))bad();take(4);}else{if(code>=0xdc00&&code<=0xdfff)bad();take(3);}}}
  function walk(value:unknown,depth:number){
    if(depth>400)bad();if(value===null){take(4);return;}if(typeof value==='string'){string(value);return;}if(typeof value==='boolean'){take(value?4:5);return;}if(typeof value==='number'){if(!Number.isFinite(value))bad();take(String(value).length);return;}if(typeof value!=='object')bad();
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)bad();
    for(const owner of [value,prototype])if(owner){const hook=Object.getOwnPropertyDescriptor(owner,'toJSON');if(hook&&(!Object.hasOwn(hook,'value')||typeof hook.value==='function'))bad();}
    if(ancestors.has(value))bad();ancestors.add(value);take(1);let count=0;
    for(const key in value){if(!Object.hasOwn(value,key))continue;const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))bad();const child=descriptor.value;
      if(array){if(key!==String(count)||child===undefined)bad();if(count)take(1);walk(child,depth+1);count++;}
      else{if(child===undefined){if(request)continue;bad();}if(count++)take(1);string(key);take(1);walk(child,depth+1);}}
    if(array&&count!==(value as unknown[]).length)bad();take(1);ancestors.delete(value);
  }
  try{walk(value,0);}catch(error){if(error instanceof DocumentPreviewError)throw error;bad();}
}
function progress(value:unknown):DocumentPreviewProgress{const data=row(value,['preparedFiles','totalFiles','pendingFiles']),preparedFiles=uint(data.preparedFiles,0xffffffff),totalFiles=uint(data.totalFiles,0xffffffff),pendingFiles=uint(data.pendingFiles,0xffffffff);if(preparedFiles+pendingFiles!==totalFiles)bad();return value as DocumentPreviewProgress;}
function capture(value:unknown):DocumentPreviewCapture{const data=row(value,['ownerNonce','stageId','serial']);id(data.ownerNonce);id(data.stageId);decimal(data.serial);return value as DocumentPreviewCapture;}
function source(value:unknown):DocumentSourceId{const data=row(value,['localStoreId','watermark']);id(data.localStoreId);if(data.watermark!=='0')decimal(data.watermark);return value as DocumentSourceId;}
const sameCapture=(a:DocumentPreviewCapture,b:DocumentPreviewCapture)=>a.ownerNonce===b.ownerNonce&&a.stageId===b.stageId&&a.serial===b.serial;
const sameSource=(a:DocumentSourceId,b:DocumentSourceId)=>a.localStoreId===b.localStoreId&&a.watermark===b.watermark;
function path(value:unknown):string{const result=text(value,false),segments=result.split('/');if(result.startsWith('/')||result.includes('\\')||/[\u0000-\u001f\u007f-\u009f]/.test(result)||segments.some(part=>!part||part==='.'||part==='..')||segments[0]!.toLowerCase()==='.zorid'||/^[A-Za-z]:/.test(result))bad();return result;}
function entry(value:unknown):DocumentEntry{const data=row(value,['id','revision','path','kind','deleted']);id(data.id);id(data.revision);path(data.path);if(data.kind!=='file'||data.deleted!==false)bad();return value as DocumentEntry;}
function property(value:unknown,depth=0):void{if(depth>128)bad();if(value===null||typeof value==='boolean')return;if(typeof value==='number'){if(!Number.isFinite(value))bad();return;}if(typeof value==='string'){text(value);return;}if(Array.isArray(value)){for(const child of list(value))property(child,depth+1);return;}const object=row(value,[],Object.keys(value??{}));for(const [key,child] of Object.entries(object)){text(key);property(child,depth+1);}}
function baseValue(value:unknown,depth=0):void{
  if(depth>128)bad();const tag=row(value,['type'],['value','path','target','display','external','timestamp','hasTime','years','months','weeks','days','hours','minutes','seconds','milliseconds','code','message']).type;
  if(tag==='null'){row(value,['type']);return;}
  if(tag==='boolean'||tag==='number'||tag==='string'||tag==='list'||tag==='object'){const data=row(value,['type','value']);if(tag==='boolean')bool(data.value);if(tag==='number'&&(typeof data.value!=='number'||!Number.isFinite(data.value)))bad();if(tag==='string')text(data.value);if(tag==='list')for(const child of list(data.value))baseValue(child,depth+1);if(tag==='object'){const seen=new Set<string>();for(const item of list(data.value)){const pair=list(item,2);if(pair.length!==2)bad();const key=text(pair[0]);if(seen.has(key))bad();seen.add(key);baseValue(pair[1],depth+1);}}return;}
  if(tag==='file'){text(row(value,['type','path']).path);return;}
  if(tag==='link'){const data=row(value,['type','path','target','display','external']);text(data.path);bool(data.external);if(data.display!==null)text(data.display);if(data.target!==null){const witness=row(data.target,['entryId','revision']);id(witness.entryId);id(witness.revision);}return;}
  if(tag==='date'){const data=row(value,['type','timestamp','hasTime']);if(typeof data.timestamp!=='number'||!Number.isSafeInteger(data.timestamp))bad();bool(data.hasTime);return;}
  if(tag==='duration'){const fields=['years','months','weeks','days','hours','minutes','seconds','milliseconds'];const data=row(value,['type',...fields]);for(const field of fields)if(typeof data[field]!=='number'||!Number.isFinite(data[field]))bad();return;}
  if(tag==='error'){const data=row(value,['type','code','message']);text(data.code,false);text(data.message);return;}bad();
}
function range(value:unknown){const data=row(value,['bytes','utf16']);for(const key of ['bytes','utf16']){const pair=list(data[key],2);if(pair.length!==2||uint(pair[0],16*1024*1024)>uint(pair[1],16*1024*1024))bad();}}
function options(value:unknown):DocumentBaseOptions{
  const data=row(value,[],['viewIndex','searchTerms','ignorePaths','clockMs','timezone','maxRows','currentEntryId','maxSteps']);const result:Record<string,unknown>={};
  for(const [key,child]of Object.entries(data)){if(child===undefined)continue;
    if(key==='viewIndex')uint(child,0xffffffff);if(key==='maxRows')uint(child,10000);if(key==='maxSteps'&&uint(child,2000000)===0)bad();if(key==='currentEntryId')id(child);
    if(key==='clockMs'&&(typeof child!=='number'||!Number.isSafeInteger(child)||child< -62167219200000||child>253402300799999))bad();
    if(key==='timezone'){text(child,false);if((child as string).length>128||new TextEncoder().encode(child as string).length>128)bad();}
    if(key==='searchTerms'||key==='ignorePaths')result[key]=list(child,1000).map(item=>text(item));else result[key]=child;
  }return result as DocumentBaseOptions;
}
export function documentPreviewRequest(op:'preview_open'|'preview_base'|'preview_close',value:unknown):{previewId:string}|DocumentPreviewBaseRequest{
  try{if(!['preview_open','preview_base','preview_close'].includes(op))bad();documentPreviewBound(value,DOCUMENT_PREVIEW_REQUEST_BYTES,true);const input=row(value,op==='preview_base'?['previewId','id']:['previewId'],op==='preview_base'?['viewName','options']:[]),previewId=decimal(input.previewId);if(op!=='preview_base')return freeze({previewId});
    const result:DocumentPreviewBaseRequest={previewId,id:id(input.id),...(input.viewName===undefined?{}:{viewName:input.viewName===null?null:text(input.viewName)}),...(input.options===undefined?{}:{options:options(input.options)})};return freeze(result);
  }catch{bad('invalid_request');}
}
export function documentPreviewOpen(value:unknown,previewId:string):DocumentPreviewOpen|null{documentPreviewBound(value,DOCUMENT_PREVIEW_RESPONSE_BYTES);if(value===null)return null;const data=row(value,['previewId','capture','source','progress']);if(decimal(data.previewId)!==previewId)bad();capture(data.capture);source(data.source);progress(data.progress);return freeze(value as DocumentPreviewOpen);}
export function documentPreviewClose(value:unknown):void{documentPreviewBound(value,DOCUMENT_PREVIEW_RESPONSE_BYTES);if(row(value,['closed']).closed!==true)bad();}
export function documentPreviewBase(value:unknown,expected:DocumentPreviewOpen,input:DocumentPreviewBaseRequest):DocumentPreviewRead{
  documentPreviewBound(value,DOCUMENT_PREVIEW_RESPONSE_BYTES);const data=row(value,['previewId','capture','source','definition','result']);if(decimal(data.previewId)!==expected.previewId||!sameCapture(capture(data.capture),expected.capture)||!sameSource(source(data.source),expected.source)||entry(data.definition).id!==input.id)bad();
  const result=row(data.result,['status','complete','aggregatesComplete','countsScope','progress','preparedScanComplete','unavailablePreparedFiles','unavailableFilterRows','view','rows','groups','groupOptions','properties','availableProperties','counts','diagnostics','stepsUsed','relationshipsAvailable','metadataIssues','metadataComplete','refreshHint']);
  if(result.status!=='indexing'||result.complete!==false||result.aggregatesComplete!==false||result.countsScope!=='preparedSubset'||result.relationshipsAvailable!==false||result.metadataComplete!==false)bad();
  const current=progress(result.progress);if(current.preparedFiles!==expected.progress.preparedFiles||current.totalFiles!==expected.progress.totalFiles||current.pendingFiles!==expected.progress.pendingFiles)bad();bool(result.preparedScanComplete);uint(result.unavailablePreparedFiles,current.preparedFiles);uint(result.unavailableFilterRows,current.preparedFiles);uint(result.stepsUsed,2000000);property(result.view);
  const rows=list(result.rows,10000),seen=new Set<string>();for(const value of rows){const item=row(value,['entryId','revision','path','values']),entryId=id(item.entryId);if(seen.has(entryId))bad();seen.add(entryId);id(item.revision);path(item.path);const values=row(item.values,[],Object.keys(item.values??{}));for(const [key,value]of Object.entries(values)){text(key);baseValue(value);}}
  for(const value of list(result.groups,5000)){const item=row(value,['keyId','key','entryIds']);if(item.keyId!==null)text(item.keyId,false);if(item.key!==null)baseValue(item.key);for(const entryId of list(item.entryIds,50000))id(entryId);}
  for(const value of list(result.groupOptions,5000)){const item=row(value,['keyId','key','count','listed']);text(item.keyId,false);baseValue(item.key);uint(item.count,50000);bool(item.listed);}
  for(const field of ['properties','availableProperties'])for(const value of list(result[field]))text(value);
  const counts=row(result.counts,['scanned','matched','afterGroupOrder','afterSearch','returned']),scanned=uint(counts.scanned,50000),matched=uint(counts.matched,scanned),ordered=uint(counts.afterGroupOrder,matched),searched=uint(counts.afterSearch,ordered);if(uint(counts.returned,searched)!==rows.length||rows.length>(input.options?.maxRows??1000))bad();
  for(const value of list(result.diagnostics)){const item=row(value,['phase','entryId','path','property','code','message']);for(const field of ['phase','path','code','message'])text(item[field]);id(item.entryId);if(item.property!==null)text(item.property);}
  for(const value of list(result.metadataIssues)){const item=row(value,['witness','exclusion','diagnostics','propertiesUnavailable']),witness=row(item.witness,['entryId','revision']);id(witness.entryId);id(witness.revision);if(item.exclusion!==null&&!['binary','unreadable','sourceLimit','extractionLimit'].includes(item.exclusion as string))bad();bool(item.propertiesUnavailable);for(const value of list(item.diagnostics)){const diagnostic=row(value,['code','severity','range']);text(diagnostic.code,false);if(diagnostic.severity!=='error'&&diagnostic.severity!=='warning')bad();range(diagnostic.range);}}
  if(result.refreshHint!==null){const hint=row(result.refreshHint,['dependency','timezone','nextWakeMs']);if(!['none','day','instant'].includes(hint.dependency as string))bad();if(text(hint.timezone,false).length>128||new TextEncoder().encode(hint.timezone as string).length>128)bad();if(hint.nextWakeMs!==null&&(typeof hint.nextWakeMs!=='number'||!Number.isSafeInteger(hint.nextWakeMs)||hint.nextWakeMs< -62167219200000||hint.nextWakeMs>253402300799999||hint.nextWakeMs<=(input.options?.clockMs??0)||hint.dependency==='none'))bad();}
  return freeze(value as DocumentPreviewRead);
}
/** Transferred raw envelope. Size is checked before UTF8 decode/JSON.parse. */
export function documentPreviewEnvelope(value:unknown):unknown{const frame=row(value,['previewBytes']),bytes=frame.previewBytes;if(!(bytes instanceof Uint8Array)||!(bytes.buffer instanceof ArrayBuffer)||bytes.byteOffset!==0||bytes.byteLength!==bytes.buffer.byteLength||bytes.byteLength>DOCUMENT_PREVIEW_RESPONSE_BYTES)bad();let decoded:unknown;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{bad();}documentPreviewBound(decoded,DOCUMENT_PREVIEW_RESPONSE_BYTES);const outer=row(decoded,['schemaVersion','op','value']);if(outer.schemaVersion!==1||outer.op!=='preview_base')bad();return outer.value;}
const allocators=new WeakMap<DocumentPreviewTransport,{next:bigint;calls:number}>();
export function createDocumentPreviewService(transport:DocumentPreviewTransport):DocumentPreviewService{
  if(!transport||![transport.previewOpen,transport.previewBase,transport.previewClose].every(method=>typeof method==='function'))bad();let allocator=allocators.get(transport);if(!allocator){allocator={next:0n,calls:0};allocators.set(transport,allocator);}const owned=allocator;
  // Bound retained control snapshots separately from backend capture/query and
  // platform raw-output allowances. Admission precedes argument copying.
  const invoke=<T>(action:()=>Promise<T>):Promise<T>=>{if(owned.calls>=8)return Promise.reject(new DocumentPreviewError('document_preview_capacity'));owned.calls++;try{return Promise.resolve(action()).finally(()=>{owned.calls--;});}catch(error){owned.calls--;return Promise.reject(error);}};
  return Object.freeze({openPreview:()=>invoke(async()=>{if(owned.next>=18446744073709551615n)bad('document_preview_capacity');const previewId=String(++owned.next),captured=documentPreviewOpen(await transport.previewOpen({previewId}),previewId);if(!captured)return null;
    let closed=false,closing:Promise<void>|undefined;const pending=new Set<Promise<unknown>>();const live=()=>{if(closed||closing)bad('document_preview_closed');};
    return Object.freeze({...captured,base(input:DocumentPreviewQueryInput){const action=invoke(async()=>{let request:DocumentPreviewBaseRequest;try{live();documentPreviewBound(input,DOCUMENT_PREVIEW_REQUEST_BYTES,true);const supplied=row(input,['id'],['viewName','options']),provided=supplied.options===undefined?{}:options(supplied.options);request=documentPreviewRequest('preview_base',{previewId,id:supplied.id,...(supplied.viewName===undefined?{}:{viewName:supplied.viewName}),options:{...provided,clockMs:provided.clockMs??Date.now(),maxRows:provided.maxRows??1000}}) as DocumentPreviewBaseRequest;}catch(error){throw error instanceof DocumentPreviewError&&error.code==='invalid_document_response'?new DocumentPreviewError('invalid_request'):error;}
      let value:unknown;try{value=await transport.previewBase(request);}catch(error){live();throw error;}live();return documentPreviewBase(value,captured,request);
    });const tracked=action.finally(()=>pending.delete(tracked));pending.add(tracked);return tracked;},close(){if(closed)return Promise.resolve();if(closing)return closing;closing=Promise.resolve().then(async()=>{while(pending.size)await Promise.allSettled([...pending]);await invoke(async()=>{documentPreviewClose(await transport.previewClose({previewId}));});closed=true;}).finally(()=>{closing=undefined;});return closing;}});
  })});
}

export const previewRequest=documentPreviewRequest;
export function decodePreviewEnvelope(bytes:Uint8Array):DocumentPreviewRead{const value=documentPreviewEnvelope({previewBytes:bytes}),data=row(value,['previewId','capture','source','definition','result']),body=row(data.result,['progress'],['status','complete','aggregatesComplete','countsScope','preparedScanComplete','unavailablePreparedFiles','unavailableFilterRows','view','rows','groups','groupOptions','properties','availableProperties','counts','diagnostics','stepsUsed','relationshipsAvailable','metadataIssues','metadataComplete','refreshHint']);const expected=documentPreviewOpen({previewId:data.previewId,capture:data.capture,source:data.source,progress:body.progress},decimal(data.previewId))!;return documentPreviewBase(value,expected,{previewId:expected.previewId,id:entry(data.definition).id,options:{maxRows:10000,clockMs:-62167219200000}});}
