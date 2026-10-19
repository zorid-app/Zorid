/** Strict body-free DTO validation; Rust owns extraction and delta selection. */
import {validateDocumentParseFacts,DOCUMENT_PARSE_FACTS_FIELDS} from './document-draft-facts.ts';
import type {DocumentEntry,DocumentMetadata,DocumentMetadataRow,DocumentMetadataRowsInput,DocumentMetadataRowsPage,DocumentPage,DocumentSnapshotId,DocumentSourceId} from './document-semantics.ts';
export const METADATA_ROWS_LIMIT=32,METADATA_ROWS_BYTES=16*1024*1024;
export class DocumentMetadataValidationError extends Error {constructor(){super('Invalid document metadata projection');}}
function bad():never{throw new DocumentMetadataValidationError();}
function row(v:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))bad();
  for(const k in v)if(Object.hasOwn(v,k)&&!keys.includes(k)&&!optional.includes(k))bad();
  for(const k of [...keys,...optional]){const d=Object.getOwnPropertyDescriptor(v,k);if(!d){if(keys.includes(k))bad();}else if(!Object.hasOwn(d,'value')||!d.enumerable)bad();}
  return v as Record<string,unknown>;
}

function str(v:unknown,empty=true):string{if(typeof v!=='string'||!empty&&!v.length)bad();for(let i=0;i<v.length;i++){const n=v.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const low=v.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))bad();}else if(n>=0xdc00&&n<=0xdfff)bad();}return v;}
function bytes(v:string):number{let n=0;for(const c of v){const p=c.codePointAt(0)!;n+=p<128?1:p<2048?2:p<65536?3:4;}return n;}
// DocumentValue is untagged JSON. Page/result/rows/file/metadata/property
// wrappers put a property's root at raw depth9; restore permits typed depth64
// starting at1. Thus legal deepest values reach72;73 leaves one level for the
// typed validator to reject. No tagged Bases value is part of this DTO.
const MAX_WIRE_DEPTH=9+64;
function encoded(value:unknown,cap:number,request=false):void{
  let remaining=cap;
  const ancestors=new Set<object>();
  function take(n:number):void{if(n>remaining)bad();remaining-=n;}
  function string(s:string):void{
    take(2);
    for(let i=0;i<s.length;i++){
      const c=s.charCodeAt(i);
      if(c===34||c===92||c===8||c===9||c===10||c===12||c===13)take(2);
      else if(c<32)take(6);
      else if(c<128)take(1);
      else if(c<2048)take(2);
      else if(c>=0xd800&&c<=0xdbff){const low=s.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))bad();take(4);}
      else{if(c>=0xdc00&&c<=0xdfff)bad();take(3);}
    }
  }
  function data(o:object,k:string):unknown{const d=Object.getOwnPropertyDescriptor(o,k);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)bad();return d.value;}
  function walk(v:unknown,depth:number):void{
    if(depth>MAX_WIRE_DEPTH)bad();
    if(v===null){take(4);return;}
    if(typeof v==='string'){string(v);return;}
    if(typeof v==='number'){if(!Number.isFinite(v))bad();take(String(v).length);return;}
    if(typeof v==='boolean'){take(v?4:5);return;}
    if(typeof v!=='object')bad();
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)bad();
    // Never execute serialization hooks, including non-enumerable ones.
    for(const owner of [v,prototype])if(owner){const hook=Object.getOwnPropertyDescriptor(owner,'toJSON');if(hook&&(!Object.hasOwn(hook,'value')||typeof hook.value==='function'))bad();}
    if(ancestors.has(v))bad();ancestors.add(v);take(1);
    let count=0;
    for(const k in v){
      if(!Object.hasOwn(v,k))continue;
      const child=data(v,k);
      if(array){if(k!==String(count)||child===undefined)bad();if(count)take(1);walk(child,depth+1);count++;}
      else{if(child===undefined){if(request&&depth===0&&['baseline','cursor','limit'].includes(k))continue;bad();}if(count++)take(1);string(k);take(1);walk(child,depth+1);}
    }
    if(array&&count!==(v as unknown[]).length)bad();
    take(1);ancestors.delete(v);
  }
  try{walk(value,0);}catch{bad();}
}

function id(v:unknown):string{const s=str(v,false);if(!/^[A-Za-z0-9_-]{1,128}$/.test(s))bad();return s;}
function uint(v:unknown,max=Number.MAX_SAFE_INTEGER):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)bad();return v;}
function bool(v:unknown):boolean{if(typeof v!=='boolean')bad();return v;}
function one<T extends string>(v:unknown,values:readonly T[]):T{if(!values.includes(v as T))bad();return v as T;}
function list(v:unknown,max=100000):unknown[]{if(!Array.isArray(v)||v.length>max)bad();return v;}
function decimal(v:unknown,positive=false):string{const s=str(v,false);if(!/^(0|[1-9][0-9]*)$/.test(s)||s.length>20||BigInt(s)>18446744073709551615n||positive&&s==='0')bad();return s;}
function snapshot(v:unknown):DocumentSnapshotId{const s=row(v,['localStoreId','generationEpoch','generation','versions']),ver=row(s.versions,['schema','extraction','resolver','query']);id(s.localStoreId);id(s.generationEpoch);decimal(s.generation,true);if(uint(ver.schema,0xffffffff)===0)bad();for(const k of ['extraction','resolver','query'])if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(str(ver[k],false)))bad();return v as DocumentSnapshotId;}
function source(v:unknown):DocumentSourceId{const s=row(v,['localStoreId','watermark']);id(s.localStoreId);decimal(s.watermark);return v as DocumentSourceId;}
function sameSnapshot(a:DocumentSnapshotId,b:DocumentSnapshotId):boolean{return a.localStoreId===b.localStoreId&&a.generationEpoch===b.generationEpoch&&a.generation===b.generation&&a.versions.schema===b.versions.schema&&a.versions.extraction===b.versions.extraction&&a.versions.resolver===b.versions.resolver&&a.versions.query===b.versions.query;}
function sameSource(a:DocumentSourceId,b:DocumentSourceId):boolean{return a.localStoreId===b.localStoreId&&a.watermark===b.watermark;}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;}
export function metadataRowsToken(v:unknown):string{const s=str(v,false);if(bytes(s)>256)bad();return s;}
export function metadataRowsRequest(value:unknown):DocumentMetadataRowsInput{const input=value===undefined?{}:value;encoded(input,64*1024,true);const r=row(input,[],['baseline','cursor','limit']);const cursor=r.cursor===undefined||r.cursor===null?undefined:metadataRowsToken(r.cursor);const limit=r.limit===undefined?undefined:uint(r.limit,METADATA_ROWS_LIMIT);if(limit===0)bad();let baseline:DocumentMetadataRowsInput['baseline'];if(r.baseline!==undefined){const b=row(r.baseline,['pinId','snapshot']),s=snapshot(b.snapshot);if(cursor!==undefined)bad();baseline={pinId:id(b.pinId) as NonNullable<DocumentMetadataRowsInput['baseline']>['pinId'],snapshot:{...s,versions:{...s.versions}}};}return freeze({...(baseline?{baseline}:{}),...(cursor===undefined?{}:{cursor:cursor as NonNullable<DocumentMetadataRowsInput['cursor']>}),...(limit===undefined?{}:{limit})});}

function entry(v:unknown,kind:'file'|'folder'):DocumentEntry{const e=row(v,['id','revision','path','kind','deleted']);id(e.id);id(e.revision);const p=str(e.path,false),segments=p.split('/');if(e.kind!==kind||e.deleted!==false||p.startsWith('/')||p.includes('\\')||/[\u0000-\u001f\u007f-\u009f]/.test(p)||segments.some(s=>!s||s==='.'||s==='..')||segments[0]!.toLowerCase()==='.zorid'||/^[A-Za-z]:/.test(p))bad();return v as DocumentEntry;}
function metadata(v:unknown,e:DocumentEntry):DocumentMetadata{
  try{
    const m=row(v,['entryId','contentRevision'],DOCUMENT_PARSE_FACTS_FIELDS);
    if(id(m.entryId)!==e.id||id(m.contentRevision)!==e.revision)bad();
    return validateDocumentParseFacts(v,undefined,true) as DocumentMetadata;
  }catch{bad();}
}
function documentMetadataRow(v:unknown):DocumentMetadataRow{const r=row(v,['entry','metadata','exclusion']),e=entry(r.entry,'file');if(r.exclusion!==null)one(r.exclusion,['binary','unreadable','sourceLimit','extractionLimit']);if(r.metadata!==null){if(r.exclusion!==null)bad();metadata(r.metadata,e);}return v as DocumentMetadataRow;}
export interface MetadataRowsExpectation {readonly snapshot:DocumentSnapshotId;readonly source:DocumentSourceId;readonly coverageComplete:boolean;readonly limit:number;readonly baseline?:DocumentSnapshotId;readonly continuation?:{readonly mode:'reset'|'delta';readonly from:DocumentSnapshotId|null}}
export function metadataRowsPage(v:unknown,expected:MetadataRowsExpectation):DocumentPage<DocumentMetadataRowsPage>{
  encoded(v,METADATA_ROWS_BYTES);const outer=row(v,['result','cursor']),result=row(outer.result,['snapshot','source','coverageComplete','value']),p=row(result.value,['snapshot','next','scanComplete','coverageComplete','complete','mode','from','rows','removedEntryIds']);
  const to=snapshot(result.snapshot),src=source(result.source);if(!sameSnapshot(to,expected.snapshot)||!sameSource(src,expected.source)||to.localStoreId!==src.localStoreId||bool(result.coverageComplete)!==expected.coverageComplete||!sameSnapshot(snapshot(p.snapshot),to)||bool(p.coverageComplete)!==expected.coverageComplete||p.next!==null)bad();
  const scan=bool(p.scanComplete),coverage=bool(p.coverageComplete),mode=one(p.mode,['reset','delta']),from=p.from===null?null:snapshot(p.from);if(bool(p.complete)!==(scan&&coverage)||(outer.cursor===null)!==scan)bad();if(outer.cursor!==null)metadataRowsToken(outer.cursor);
  if(mode==='reset'){if(from!==null)bad();}else{if(from===null||!expected.baseline&&!expected.continuation||from.localStoreId!==to.localStoreId||from.generationEpoch!==to.generationEpoch||!sameSnapshot({...from,generation:to.generation},to))bad();const wanted=expected.continuation?.from??expected.baseline;if(!wanted||!sameSnapshot(from,wanted))bad();}
  if(expected.continuation&&(mode!==expected.continuation.mode||(from===null)!==(expected.continuation.from===null)||from!==null&&expected.continuation.from!==null&&!sameSnapshot(from,expected.continuation.from)))bad();
  const rows=list(p.rows,METADATA_ROWS_LIMIT),removed=list(p.removedEntryIds,METADATA_ROWS_LIMIT);if(rows.length+removed.length>expected.limit||uint(expected.limit,METADATA_ROWS_LIMIT)<1||mode==='reset'&&removed.length)bad();const ids=new Set<string>(),paths=new Set<string>();
  for(const item of rows){const r=row(item,['kind'],['value','entry']);let e:DocumentEntry;if(r.kind==='file'){row(r,['kind','value']);const file=documentMetadataRow(r.value);if(coverage&&file.exclusion!==null&&file.exclusion!=='binary')bad();e=file.entry;}else if(r.kind==='folder'){row(r,['kind','entry']);e=entry(r.entry,'folder');}else return bad();if(ids.has(e.id)||paths.has(e.path))bad();ids.add(e.id);paths.add(e.path);}
  for(const item of removed){const removedId=id(item);if(ids.has(removedId))bad();ids.add(removedId);}
  return freeze(v as DocumentPage<DocumentMetadataRowsPage>);
}
