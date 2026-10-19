/** Exact identity-free Rust ParseFacts decoding. No source parsing or authority binding. */
import type {DocumentMetadata,DocumentRange} from './document-semantics.ts';
export type DocumentParseFacts=Omit<DocumentMetadata,'entryId'|'contentRevision'>;
export const DOCUMENT_DRAFT_FACTS_WIRE_BYTES=16*1024*1024;
export class DocumentDraftFactsError extends Error {readonly code:'resource'|'invalid_facts';constructor(code:'resource'|'invalid_facts'='invalid_facts'){super('Invalid transient document facts');this.code=code;}}
function bad():never{throw new DocumentDraftFactsError();}
function row(v:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))bad();
  for(const k in v)if(Object.hasOwn(v,k)&&!keys.includes(k)&&!optional.includes(k))bad();
  for(const k of [...keys,...optional]){const d=Object.getOwnPropertyDescriptor(v,k);if(!d){if(keys.includes(k))bad();}else if(!Object.hasOwn(d,'value')||!d.enumerable)bad();}
  return v as Record<string,unknown>;
}

function str(v:unknown,empty=true):string{if(typeof v!=='string'||!empty&&!v.length)bad();for(let i=0;i<v.length;i++){const n=v.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const low=v.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))bad();}else if(n>=0xdc00&&n<=0xdfff)bad();}return v;}
function bytes(v:string):number{let n=0;for(const c of v){const p=c.codePointAt(0)!;n+=p<128?1:p<2048?2:p<65536?3:4;}return n;}
function uint(v:unknown,max=Number.MAX_SAFE_INTEGER):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)bad();return v;}
function bool(v:unknown):boolean{if(typeof v!=='boolean')bad();return v;}
function one<T extends string>(v:unknown,values:readonly T[]):T{if(!values.includes(v as T))bad();return v as T;}
function list(v:unknown,max=100000):unknown[]{if(!Array.isArray(v)||v.length>max)bad();return v;}
function pair(v:unknown,max:number):readonly[number,number]{const p=list(v,2);if(p.length!==2)bad();const a=uint(p[0],max),b=uint(p[1],max);if(a>b)bad();return [a,b];}
function plausible(b:number,u:number):void{if(u>b||b>u*3)bad();}
function range(v:unknown,length:{bytes:number;utf16:number}):DocumentRange{const r=row(v,['bytes','utf16']),b=pair(r.bytes,length.bytes),u=pair(r.utf16,length.utf16);for(let i=0;i<2;i++)plausible(b[i]!,u[i]!);plausible(b[1]-b[0],u[1]-u[0]);plausible(length.bytes-b[1],length.utf16-u[1]);return v as DocumentRange;}
function contains(a:DocumentRange,b:DocumentRange):boolean{return a.bytes[0]<=b.bytes[0]&&a.bytes[1]>=b.bytes[1]&&a.utf16[0]<=b.utf16[0]&&a.utf16[1]>=b.utf16[1];}
function width(r:DocumentRange,s:string):boolean{return r.bytes[1]-r.bytes[0]===bytes(s)&&r.utf16[1]-r.utf16[0]===s.length;}
function rangeKey(r:DocumentRange):string{return `${r.bytes[0]},${r.bytes[1]},${r.utf16[0]},${r.utf16[1]}`;}
function key(v:unknown):string{const s=str(v);if(!s.trim()||/[\u0000-\u001f\u007f]/.test(s))bad();return s;}
const diagnosticCodes=['frontmatter_unclosed','frontmatter_syntax','frontmatter_duplicate_key','frontmatter_mapping','frontmatter_tag','frontmatter_alias','frontmatter_value','frontmatter_resource','projection_non_string'] as const;
export const DOCUMENT_PARSE_FACTS_FIELDS=['schemaVersion','dialectVersion','sourceLength','frontmatter','properties','aliases','tags','tagOccurrences','headings','links','tasks','blocks','listItems','diagnostics'] as const;

/** Shape validator for already bounded plain JSON data. Committed callers first
 * run their descriptor-safe envelope walk; draft callers use prepare/decode. */
export function validateDocumentParseFacts(v:unknown,expected?:{readonly bytes:number;readonly utf16:number},committed=false):DocumentParseFacts{
  const m=row(v,[...DOCUMENT_PARSE_FACTS_FIELDS,...(committed?['entryId','contentRevision']:[])]);
  if(m.schemaVersion!==2||m.dialectVersion!=='zorid-markdown-1')bad();
  const l=row(m.sourceLength,['bytes','utf16']),length={bytes:uint(l.bytes,16*1024*1024),utf16:uint(l.utf16,16*1024*1024)};plausible(length.bytes,length.utf16);if(expected&&(length.bytes!==expected.bytes||length.utf16!==expected.utf16))bad();
  const fm=row(m.frontmatter,['state','range','bodyStart']),state=one(fm.state,['absent','valid','invalid','unclosed']),start=row(fm.bodyStart,['byte','utf16']),point={byte:uint(start.byte,length.bytes),utf16:uint(start.utf16,length.utf16)};
  range({bytes:[point.byte,point.byte],utf16:[point.utf16,point.utf16]},length);const front=fm.range===null?null:range(fm.range,length),properties=list(m.properties);
  if(state==='absent'?(front!==null||point.byte!==0||point.utf16!==0||properties.length!==0):state==='unclosed'?(front===null||point.byte!==0||point.utf16!==0||properties.length!==0):(front===null||point.byte!==front.bytes[1]||point.utf16!==front.utf16[1]||state==='invalid'&&properties.length!==0))bad();
  let nodes=1,expanded=0;const keys=new Set<string>();
  function value(v:unknown,depth:number):void{if(++nodes>100000||depth>64)bad();if(v===null||typeof v==='boolean')return;if(typeof v==='number'){if(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v))bad();return;}if(typeof v==='string'){expanded+=bytes(str(v));}else if(Array.isArray(v)){for(const c of list(v))value(c,depth+1);}else{const o=row(v,[],Object.keys(v??{}));for(const [k,c]of Object.entries(o)){expanded+=bytes(key(k));value(c,depth+1);}}if(expanded>8*1024*1024)bad();}
  for(const p of properties){const r=row(p,['key','value','type','keyRange']),k=key(r.key);if(keys.has(k))bad();keys.add(k);expanded+=bytes(k);one(r.type,['text','list','number','checkbox','date','datetime','tags','unknown']);const q=range(r.keyRange,length);if(q.bytes[0]===q.bytes[1])bad();value(r.value,1);}
  if(expanded>8*1024*1024)bad();
  for(const name of ['aliases','tags'])for(const s of list(m[name]))str(s);
  for(const t of list(m.tagOccurrences)){const r=row(t,['name','range']),name=str(r.name),q=range(r.range,length);if(!width(q,`#${name}`))bad();}
  for(const h of list(m.headings)){const r=row(h,['text','level','line','range']);str(r.text);if(uint(r.level,6)<1)bad();uint(r.line,length.bytes);range(r.range,length);}
  for(const link of list(m.links)){const r=row(link,['kind','embed','target','fragment','destination','range','targetRange','definitionRange']);one(r.kind,['wiki','markdown']);bool(r.embed);const target=str(r.target);str(r.fragment);str(r.destination);const outer=range(r.range,length),targetRange=range(r.targetRange,length),definition=r.definitionRange===null?null:range(r.definitionRange,length);if(!width(targetRange,target)||!contains(definition??outer,targetRange))bad();}
  const afterBody=(q:DocumentRange)=>q.bytes[0]>=point.byte&&q.utf16[0]>=point.utf16;
  const nonempty=(q:DocumentRange)=>q.bytes[0]<q.bytes[1]&&q.utf16[0]<q.utf16[1];
  let previous:DocumentRange|undefined;
  for(const b of list(m.blocks)){const r=row(b,['kind','range']);one(r.kind,['paragraph','heading','blockquote','code','html','table','thematicBreak']);const q=range(r.range,length);if(!nonempty(q)||!afterBody(q)||previous&&(previous.bytes[1]>q.bytes[0]||previous.utf16[1]>q.utf16[0]))bad();previous=q;}
  const items=new Map<string,string|null>(),stack:DocumentRange[]=[];previous=undefined;
  for(const item of list(m.listItems)){const r=row(item,['range','taskStatus']),q=range(r.range,length),status=r.taskStatus===null?null:str(r.taskStatus);if(!nonempty(q)||!afterBody(q)||previous&&(previous.bytes[0]>=q.bytes[0]||previous.utf16[0]>=q.utf16[0])||status!==null&&(status.length!==1||/[\r\n]/.test(status)))bad();while(stack.length&&stack.at(-1)!.bytes[1]<=q.bytes[0]){if(stack.at(-1)!.utf16[1]>q.utf16[0])bad();stack.pop();}if(stack.length&&!contains(stack.at(-1)!,q))bad();stack.push(q);items.set(rangeKey(q),status);previous=q;}
  const tasks=new Set<string>();
  for(const task of list(m.tasks)){const r=row(task,['status','checked','completed','text','line','range','statusRange','textRange','itemRange']),status=str(r.status),text=str(r.text);uint(r.line,length.bytes);if(status.length!==1||/[\r\n]/.test(status)||bool(r.checked)!==(status!==' ')||bool(r.completed)!==(status==='x'||status==='X'))bad();const q=range(r.range,length),sr=range(r.statusRange,length),tr=range(r.textRange,length),ir=range(r.itemRange,length),k=rangeKey(ir);if(!contains(ir,q)||!contains(ir,tr)||items.get(k)!==status||tasks.has(k)||!width(sr,status)||!width(tr,text)||q.bytes[1]-q.bytes[0]!==bytes(status)+2||q.utf16[1]-q.utf16[0]!==3||!contains(q,sr)||sr.bytes[0]!==q.bytes[0]+1||sr.utf16[0]!==q.utf16[0]+1||tr.bytes[0]<q.bytes[1]||tr.utf16[0]<q.utf16[1])bad();tasks.add(k);}
  for(const [k,status]of items)if(status!==null&&!tasks.has(k))bad();
  for(const diagnostic of list(m.diagnostics)){const r=row(diagnostic,['code','severity','range']);one(r.code,diagnosticCodes);one(r.severity,['error','warning']);range(r.range,length);}
  return v as DocumentParseFacts;
}

/** Declared logical units: object/array+validator indices 256 bytes, string
 * header 64 plus 2 per raw UTF16 unit, field/cell 64, primitive 32. These are
 * conservative component reservations, never a JS heap/RSS bound.
 * Scan before JSON.parse; raw quoted spelling overcharges escapes deliberately. */
export function documentDraftFactsAllocation(text:string):number{
  let charge=0,wire=0,depth=0,quoted=false,escaped=false,primitive=false;
  for(let i=0;i<text.length;i++){
    const c=text[i]!,unit=text.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){const low=text.charCodeAt(i+1);if(!(low>=0xdc00&&low<=0xdfff))bad();wire+=4;}
    else if(unit>=0xdc00&&unit<=0xdfff){const high=text.charCodeAt(i-1);if(!(high>=0xd800&&high<=0xdbff))bad();}
    else wire+=unit<128?1:unit<2048?2:3;
    if(wire>DOCUMENT_DRAFT_FACTS_WIRE_BYTES)throw new DocumentDraftFactsError('resource');
    if(quoted){charge+=2;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
    else if(c==='"'){primitive=false;quoted=true;charge+=64;}
    else if(c==='{'||c==='['){primitive=false;if(++depth>73)bad();charge+=256;}
    else if(c==='}'||c===']'){primitive=false;if(--depth<0)bad();}
    else if(c===':'||c===','){primitive=false;charge+=64;}
    else if(/\s/.test(c))primitive=false;
    else if(!primitive){primitive=true;charge+=32;}
    if(charge>96*1024*1024)throw new DocumentDraftFactsError('resource');
  }
  if(quoted||depth!==0)bad();return charge;
}
function decode(text:string,expected:{readonly bytes:number;readonly utf16:number}):DocumentParseFacts{
  const facts=validateDocumentParseFacts(JSON.parse(text),expected);
  function freeze(value:unknown):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
  freeze(facts);return facts;
}
/** One scan gates wire/depth/logical allocation before JSON.parse. The immutable
 * string is sealed into a single-use decoder, so callers reserve once and do not
 * duplicate the full preflight scan. Discarding the seal drops its borrowed text. */
export function prepareDocumentDraftFacts(text:string):Readonly<{allocation:number;decode(expected:{readonly bytes:number;readonly utf16:number}):DocumentParseFacts}>{
  const allocation=documentDraftFactsAllocation(text);let input:string|undefined=text;
  return Object.freeze({allocation,decode(expected){if(input===undefined)bad();const current=input;input=undefined;return decode(current,expected);}});
}
export function decodeDocumentDraftFacts(text:string,expected:{readonly bytes:number;readonly utf16:number}):DocumentParseFacts{
  return prepareDocumentDraftFacts(text).decode(expected);
}
