import {searchSpec,richToken,richPreparation,richPage as decodeRichPage,searchCompileDiagnostic} from './document-search-validation.ts';
import type {SearchSpec} from './document-search-types.ts';
import type {DocumentTaskOptions,DocumentParseCacheCounters,DocumentSnapshotId} from './document-semantics.ts';
import {browserDocumentParseCache} from './browser-document-parse-cache.ts';
import type {BrowserParseCachePolicy,BrowserParseCacheAdmission} from './browser-document-parse-cache.ts';
import {BrowserVaultError} from './browser-vault.ts';
import type {BrowserVaultPresentation, EntryState} from './browser-vault.ts';
import {decimalU64, normalizedTransact} from './browser-normalized-idb.ts';
import type {StreamingPublication} from './browser-sync-streaming.ts';

/** Disposable, local-only rows in the existing authority DB. Source writes never
 * consult these keys. No source envelopes, receipts or sync exports contain them. */
const PREFIX='document-index:v1/', CATALOG=PREFIX+'catalog';
const LIMITS=Object.freeze({header:16*1024*1024,row:16*1024*1024,text:16*1024*1024,records:100000,
  metadata:64*1024*1024,baseRecords:50000,baseFacts:8*1024*1024,projection:256*1024*1024,cache:512*1024*1024,pins:4,stages:4,generations:3});
const fail=(code:string,details?:unknown)=>new BrowserVaultError(code,'Disposable document index is unavailable; source files remain authoritative',details);
const size=(text:string)=>new TextEncoder().encode(text).byteLength;
function equal(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a)&&Array.isArray(b)&&a.length!==b.length)return false;
  const left=Object.keys(a).sort(),right=Object.keys(b).sort(),leftRow=a as Record<string,unknown>,rightRow=b as Record<string,unknown>;
  return left.length===right.length&&left.every((key,index)=>key===right[index]&&equal(leftRow[key],rightRow[key]));
}
interface Free {free():void}
export interface BrowserIndexSource {localStoreId:string;watermark:string}
export interface BrowserIndexSnapshot {localStoreId:string;generationEpoch:string;generation:string;versions:unknown}
export interface BrowserIndexHeader {source:{localStoreId:string;watermark:string};entries:EntryState[];expectedIndex:BrowserIndexSnapshot|null;nextIndex:BrowserIndexSnapshot}
interface Builder extends Free {headerJson():string;pendingJson():string;beginPump():void;addText(id:string,bytes:Uint8Array):void;cacheKeyJson(id:string,bytes:Uint8Array):string;addCachedText(id:string,key:string,payload:string):string;extractText(id:string,bytes:Uint8Array):string;addBinary(id:string):void;addUnreadable(id:string):void;addPersisted(id:string,row:string):void;rowJson(id:string):string;ready():boolean;finish():Generation}
interface Generation extends Free {headerJson():string;snapshotJson():string;rowJson(id:string):string;coverageComplete():boolean;metadataJson(id:string):string;tasksJson(sources:string,options:string):string;baseJson(id:string,bytes:Uint8Array,facts:string,options:string,viewName?:string|null):string;resolveJson(id:string,destination:string):string;backlinksJson(id:string,token:string,limit:number):string;openLiteral(query:string,token:string,limit:number):LiteralPage}
interface PreparationCache extends Free {clear():void;baseJson(generation:Generation,id:string,bytes:Uint8Array,facts:string,options:string,monotonicMs:number,viewName?:string|null):string}
interface LiteralPage extends Free {nextReadJson():string;accept(bytes:Uint8Array):void;finishJson():string}
interface RichPrepared extends Free {}
interface RichDrive extends Free {nextActionJson():string;accept(bytes:Uint8Array):void;finish():RichPrepared}
interface RichOwner extends Free {clear():void;startQuery(generation:Generation,spec:string,facts:string):string;prepareJson(query:string):string;openDrive(query:string,cursor:string):RichDrive;commitJson(prepared:RichPrepared):string;closeQuery(query:string):void}
export interface BrowserDocumentIndexWasm {documentIndexVersionsJson():string;documentParseCachePolicyJson():string;documentParseCacheAdmissionJson(input:string):string;WasmDocumentIndexBuilder:new(input:string)=>Builder;WasmDocumentIndexPreparationCache:new()=>PreparationCache;WasmDocumentRichSearchOwner:new(nonce:string)=>RichOwner}
export interface BrowserDocumentIndexHost {
  db:IDBDatabase;authorityId:string;clientId:string;wasm:BrowserDocumentIndexWasm;assertActive():void;
  readPublication(tx:IDBTransaction,done:(value:StreamingPublication)=>void,abort:(error:unknown)=>void):void;
}
export interface BrowserIndexStage {stageId:string;snapshot:BrowserIndexSnapshot;progress:{prepared:number;total:number;reused:number;ready:boolean;parseCache:DocumentParseCacheCounters};prepared:number;total:number;ready:boolean}
export interface BrowserIndexPin {pinId:string;snapshot:BrowserIndexSnapshot;source:BrowserIndexSource;coverageComplete:boolean}
export interface BrowserDocumentIndex {
  initialize():Promise<void>;discard(stageId:string):Promise<void>;
  status():Promise<{sourceWatermark:string;snapshot:BrowserIndexSnapshot|null;coveredWatermark:string|null;rebuildRequired:boolean;current:boolean;source:BrowserIndexSource;coveredSource:BrowserIndexSource|null;coverageComplete:boolean|null}>;
  begin():Promise<BrowserIndexStage>;pump(stageId:string):Promise<BrowserIndexStage>;publish(stageId:string):Promise<BrowserIndexSnapshot>;
  open():Promise<BrowserIndexPin>;closePin(pinId:string):Promise<void>;
  search(input:{pinId:string;query:string;cursor?:string;limit?:number}):Promise<unknown>;
  resolve(input:{pinId:string;sourceId:string;destination:string}):Promise<unknown>;
  backlinks(input:{pinId:string;targetId:string;cursor?:string;limit?:number}):Promise<unknown>;
  metadata(input:{pinId:string;id:string}):Promise<unknown>;
  tasks(input:{pinId:string;typeIds:string[];options?:DocumentTaskOptions}):Promise<unknown>;
  base(input:{pinId:string;id:string;viewName?:string|null;options?:{viewIndex?:number;searchTerms?:string[];ignorePaths?:string[];clockMs?:number;timezone?:string;maxRows?:number;currentEntryId?:string;maxSteps?:number}}):Promise<unknown>;
  richStart(input:{pinId:string;spec:SearchSpec}):Promise<unknown>;
  richPrepare(input:{pinId:string;queryId:string}):Promise<unknown>;
  richPage(input:{pinId:string;queryId:string;cursor:string}):Promise<unknown>;
  richClose(input:{pinId:string;queryId:string}):Promise<void>;
  rebuild():Promise<void>;close():Promise<void>;
}
interface Catalog {rebuilding?:string;version:1;localStoreId:string;head:string|null;generations:Descriptor[];pins:{id:string;clientId:string;generation:string}[]}
interface Descriptor {id:string;clientId:string;state:'staging'|'published'|'deleting';snapshot:BrowserIndexSnapshot;sourceWatermark:string;coverageComplete:boolean;wasPublished:boolean;rows:number;bytes:number;metadataBytes:number}
interface CachedRow {sourceDescriptor:unknown;entry:EntryState;presentation:BrowserVaultPresentation;record:string;projection?:Uint8Array}
interface SourceCapture {publication:StreamingPublication;descriptors:{id:string;content:any}[]}
interface StoredHeader {rust:string;capture:SourceCapture}
interface Stage {failed?:boolean;capture:SourceCapture;id:string;header:BrowserIndexHeader;builder?:Builder;generation?:Generation;prepared:number;total:number;reused:number;parseCache:{hits:number;misses:number;unavailable:number;corrupt:number;unsupported:number}}
type ParseCacheOutcome='hit'|'miss'|'unavailable'|'corrupt'|'unsupported';
const root=(id:string)=>PREFIX+'g/'+id+'/';
const rowKey=(id:string,entryId:string)=>root(id)+'row/'+entryId;
const headerKey=(id:string)=>root(id)+'header';
const hex=(bytes:Uint8Array)=>Array.from(bytes).map(n=>n.toString(16).padStart(2,'0')).join('');
const byteDigest=async(bytes:Uint8Array):Promise<string>=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)));
const digest=(value:string):Promise<string>=>byteDigest(new TextEncoder().encode(value));
function pageLimit(value:unknown):number{if(value===undefined)return 100;if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>1000)throw fail('index_invalid_budget');return value;}
function baseOptions(input:unknown):string {
  if(input===undefined)input={};if(!input||typeof input!=='object'||Array.isArray(input))throw fail('index_invalid_request');
  const value=input as Record<string,unknown>,allowed=new Set(['viewIndex','searchTerms','ignorePaths','clockMs','timezone','maxRows','currentEntryId','maxSteps']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw fail('index_invalid_request');
  const result:Record<string,unknown>={};
  for(const key of ['viewIndex','maxRows','clockMs','maxSteps'])if(value[key]!==undefined){const n=value[key];if(typeof n!=='number'||!Number.isSafeInteger(n)||(key!=='clockMs'&&n<0))throw fail('index_invalid_request');result[key]=n;}
  if(value.maxSteps!==undefined&&(Number(value.maxSteps)<1||Number(value.maxSteps)>2000000))throw fail('index_invalid_request');
  if(value.currentEntryId!==undefined){if(!validId(value.currentEntryId))throw fail('index_invalid_request');result.currentEntryId=value.currentEntryId;}
  const clock=value.clockMs===undefined?Date.now():value.clockMs;if(typeof clock!=='number'||!Number.isSafeInteger(clock))throw fail('index_invalid_request');result.clockMs=clock;
  result.maxRows=value.maxRows===undefined?1000:value.maxRows;
  if(value.timezone!==undefined)result.timezone=inputText(value.timezone,256);
  for(const key of ['searchTerms','ignorePaths'])if(value[key]!==undefined){const array=value[key];if(!Array.isArray(array)||array.length>1000)throw fail('index_input_limit');result[key]=array.map(item=>inputText(item,4096));}
  const raw=JSON.stringify(result);if(size(raw)>65536)throw fail('index_input_limit');return raw;
}
function taskOptions(input:unknown):string {
  if(input===undefined)input={};if(!input||typeof input!=='object'||Array.isArray(input))throw fail('index_invalid_request');
  const value=input as Record<string,unknown>,allowed=new Set(['filter','clockMs','timezone','showDone','maxRows']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw fail('index_invalid_request');
  const result:Record<string,unknown>={};
  if(value.filter!==undefined){if(!['all','today','unscheduled'].includes(value.filter as string))throw fail('index_invalid_request');result.filter=value.filter;}
  const clock=value.clockMs===undefined?Date.now():value.clockMs;if(typeof clock!=='number'||!Number.isSafeInteger(clock))throw fail('index_invalid_request');result.clockMs=clock;
  if(value.timezone!==undefined)result.timezone=inputText(value.timezone,128);
  if(value.showDone!==undefined){if(typeof value.showDone!=='boolean')throw fail('index_invalid_request');result.showDone=value.showDone;}
  if(value.maxRows!==undefined){if(typeof value.maxRows!=='number'||!Number.isInteger(value.maxRows)||value.maxRows<1||value.maxRows>10000)throw fail('index_invalid_request');result.maxRows=value.maxRows;}
  return JSON.stringify(result);
}
/** Bound task requests before structured-cloning them into the normal worker. */
export function captureBrowserTaskQuery(input:Parameters<BrowserDocumentIndex['tasks']>[0]):Parameters<BrowserDocumentIndex['tasks']>[0] {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['pinId','typeIds','options'].includes(key))||!validId(input.pinId)||!Array.isArray(input.typeIds)||input.typeIds.length>128||input.typeIds.some(id=>!validId(id))||new Set(input.typeIds).size!==input.typeIds.length)throw fail('index_invalid_request');
  return {pinId:input.pinId,typeIds:[...input.typeIds],options:JSON.parse(taskOptions(input.options)) as DocumentTaskOptions};
}
function inputText(value:unknown,maxBytes:number):string{if(typeof value!=='string'||value.length>maxBytes||size(value)>maxBytes)throw fail('index_invalid_request');for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw fail('index_invalid_request');}else if(code>=0xdc00&&code<=0xdfff)throw fail('index_invalid_request');}return value;}
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function json<T>(raw:string,max=LIMITS.header):T {if(typeof raw!=='string'||size(raw)>max)throw fail('index_rebuild_required');try{return JSON.parse(raw) as T;}catch{throw fail('index_rebuild_required');}}
function rust<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;let code='index_rebuild_required',details:unknown;try{const parsed=JSON.parse(String(error));if(typeof parsed.code==='string'&&parsed.code.startsWith('index_'))code=parsed.code;details=parsed.diagnostic;}catch{}throw new BrowserVaultError(code,'Shared Rust document engine rejected the operation',details,'rust');}}

const richFail=(code:string)=>new BrowserVaultError(code,'Rich document search is unavailable');
function captureRichRequest(input:unknown,keys:readonly string[]):Record<string,unknown>&{pinId:string} {
  if(!input||typeof input!=='object'||Array.isArray(input)||(Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null)||Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(input,key)))throw richFail('invalid_request');
  const row=input as Record<string,unknown>;let encoded:string;try{encoded=JSON.stringify(row);}catch{throw richFail('invalid_request');}if(size(encoded)>65536)throw richFail('search_resource');
  if(!validId(row.pinId))throw richFail('invalid_request');const result:Record<string,unknown>&{pinId:string}={pinId:row.pinId};
  for(const key of keys){if(key==='pinId')continue;try{result[key]=key==='spec'?searchSpec(row[key]):richToken(row[key]);}catch{throw richFail('invalid_request');}}
  return result;
}
function richRust<T>(action:()=>T,query:string):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;
  let parsed:{code?:unknown;diagnostic?:unknown};try{const raw=String(error);if(size(raw)>65536)throw error;parsed=JSON.parse(raw);}catch{throw fail('index_rebuild_required');}
  if(parsed.code==='search_compile'){let diagnostic;try{diagnostic=searchCompileDiagnostic(parsed.diagnostic,query);}catch{throw fail('index_rebuild_required');}throw new BrowserVaultError('search_compile','The search query could not be compiled',{diagnostic},'rust');}
  if(typeof parsed.code==='string'&&(['search_resource','search_busy','search_expired','cancelled','invalid_request'].includes(parsed.code)||parsed.code.startsWith('index_')))throw new BrowserVaultError(parsed.code,'Shared Rust document search rejected the operation',undefined,'rust');
  throw fail('index_rebuild_required');
}}
function richAction(raw:string,snapshot:BrowserIndexSnapshot,entries:ReadonlyMap<string,EntryState>):{kind:'yield'|'done'}|{kind:'readText';entry:EntryState;bytes:number} {
  const value=json<Record<string,unknown>>(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw fail('index_rebuild_required');
  if(value.kind==='yield'||value.kind==='done'){if(Object.keys(value).length!==1)throw fail('index_rebuild_required');return {kind:value.kind};}
  if(value.kind!=='readText'||Object.keys(value).length!==5||!['kind','entry','snapshot','digest','bytes'].every(key=>Object.hasOwn(value,key))||!equal(value.snapshot,snapshot))throw fail('index_rebuild_required');
  const entry=value.entry as EntryState;if(!entry||!equal(entries.get(entry.id),entry)||!Array.isArray(value.digest)||value.digest.length!==32||value.digest.some(n=>typeof n!=='number'||!Number.isInteger(n)||n<0||n>255)||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<0||Number(value.bytes)>LIMITS.text)throw fail('index_rebuild_required');
  return {kind:'readText',entry,bytes:Number(value.bytes)};
}
export function browserDocumentIndex(host:BrowserDocumentIndexHost):BrowserDocumentIndex {
  const stages=new Map<string,Stage>(),pins=new Map<string,{generation:string;value:Generation;header:BrowserIndexHeader;capture:SourceCapture}>();
  type Pin=ReturnType<typeof pins.get> & {};
  interface RichSession {value:RichOwner;alive:boolean}
  interface RichQueryBinding {pinId:string;pin:Pin;session:RichSession;core:string;spec:SearchSpec;entries:ReadonlyMap<string,EntryState>;retired:boolean;busy:boolean}
  const richQueries=new Map<string,RichQueryBinding>();let richOwner:RichSession|undefined;
  const releaseRich=()=>{const session=richOwner;richOwner=undefined;for(const query of richQueries.values())query.retired=true;richQueries.clear();if(session){session.alive=false;try{session.value.clear();}finally{session.value.free();}}};
  let closed=false,preparation:PreparationCache|undefined;
  const releasePreparation=()=>{const owned=preparation;preparation=undefined;owned?.free();};
  const active=()=>{if(closed)throw fail('index_closed');try{host.assertActive();}catch(error){try{releasePreparation();}catch{/* Preserve the owner/lease error. */}try{releaseRich();}catch{/* Preserve the owner/lease error. */}throw error;}};
  const monotonicMs=()=>{const value=Math.floor(performance.now());if(!Number.isSafeInteger(value)||value<0)throw fail('index_invalid_budget');return value;};
  const richSession=()=>{active();if(!richOwner)richOwner={value:new host.wasm.WasmDocumentRichSearchOwner(crypto.randomUUID()),alive:true};return richOwner;};
  function admittedRichPin(pinId:string,pin:Pin,session:RichSession){active();if(pins.get(pinId)!==pin||richOwner!==session||!session.alive)throw richFail('search_expired');}
  function admittedRichQuery(id:string,query:RichQueryBinding){admittedRichPin(query.pinId,query.pin,query.session);if(query.retired||richQueries.get(id)!==query)throw richFail('search_expired');}
  function getRichQuery(pinId:string,id:string){const query=richQueries.get(id);if(!query||query.pinId!==pinId)throw richFail('search_expired');admittedRichQuery(id,query);return query;}
  function retireRichQuery(id:string,query:RichQueryBinding){if(query.retired)return;if(query.session.alive&&richOwner===query.session)richRust(()=>query.session.value.closeQuery(query.core),query.spec.query);query.retired=true;richQueries.delete(id);}
  function quietRetireRich(id:string,query:RichQueryBinding){try{retireRichQuery(id,query);}catch{/* Preserve the failed operation's original admission/encoding error. */query.retired=true;richQueries.delete(id);}}
  async function assertRichQuery(id:string,query:RichQueryBinding){try{await assertPin(query.pinId);admittedRichQuery(id,query);}catch(error){quietRetireRich(id,query);throw error;}}
  function retireRichPin(pinId:string){for(const [id,query]of richQueries)if(query.pinId===pinId)retireRichQuery(id,query);}
  const parseCache=browserDocumentParseCache({db:host.db,authorityId:host.authorityId,assertActive:active,
    policy:json<BrowserParseCachePolicy>(rust(()=>host.wasm.documentParseCachePolicyJson())),
    admit:(usage,replaced,incoming,evicted)=>json<BrowserParseCacheAdmission>(rust(()=>host.wasm.documentParseCacheAdmissionJson(JSON.stringify({usage,replacedPayloadBytes:replaced,incomingPayloadBytes:incoming,evictedRows:evicted}))))});
  const countCache=(stage:Stage,outcome:ParseCacheOutcome)=>{const field=outcome==='hit'?'hits':outcome==='miss'?'misses':outcome;stage.parseCache[field]++;};
  const run=<T>(mode:IDBTransactionMode,stores:readonly string[],start:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void)=>void)=>
    normalizedTransact(host.db,{authorityId:host.authorityId,stores,mode,assertActive:active},start);
  const on=<T>(request:IDBRequest<T>,action:(result:T)=>void,abort:(error:unknown)=>void)=>{request.onsuccess=()=>{try{active();action(request.result);}catch(error){abort(error);}};};
  const empty=():Catalog=>({version:1,localStoreId:host.authorityId,head:null,generations:[],pins:[]});
  function catalog(value:any):Catalog {
    if(value===undefined)return empty();
    if(value?.key!==CATALOG||size(JSON.stringify(value))>16384)throw fail('index_rebuild_required');
    const c=value.value as Catalog;
    if(!c||c.version!==1||c.localStoreId!==host.authorityId||!Array.isArray(c.generations)||c.generations.length>LIMITS.generations+LIMITS.stages||!Array.isArray(c.pins)||c.pins.length>LIMITS.pins)throw fail('index_rebuild_required');
    const ids=new Set<string>();let bytes=0;
    for(const g of c.generations){if(!validId(g.id)||ids.has(g.id)||!validId(g.clientId)||!['staging','published','deleting'].includes(g.state)||g.snapshot?.localStoreId!==host.authorityId||g.snapshot?.generationEpoch!==g.id||g.snapshot?.generation!=='1'||typeof g.coverageComplete!=='boolean'||typeof g.wasPublished!=='boolean'||g.state==='published'&&!g.wasPublished||g.state==='staging'&&g.wasPublished||![g.rows,g.bytes,g.metadataBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||g.rows>LIMITS.records||g.bytes>LIMITS.projection||g.metadataBytes>LIMITS.metadata)throw fail('index_rebuild_required');decimalU64(g.sourceWatermark);ids.add(g.id);bytes+=g.bytes;}
    if(bytes>LIMITS.cache||c.head!==null&&!c.generations.some(g=>g.id===c.head&&g.state==='published'))throw fail('index_rebuild_required');
    const pinIds=new Set<string>();for(const p of c.pins){if(!validId(p.id)||pinIds.has(p.id)||!validId(p.clientId)||!c.generations.some(g=>g.id===p.generation&&g.state==='published'))throw fail('index_rebuild_required');pinIds.add(p.id);}
    return c;
  }
  const readCatalog=(tx:IDBTransaction,done:(value:Catalog)=>void,abort:(error:unknown)=>void)=>on(tx.objectStore('control').get(CATALOG),row=>done(catalog(row)),abort);
  const putCatalog=(tx:IDBTransaction,c:Catalog)=>{if(size(JSON.stringify(c))>16384)throw fail('index_cache_limit');tx.objectStore('control').put({key:CATALOG,value:c});};
  const head=(c:Catalog)=>c.generations.find(g=>g.id===c.head)?.snapshot??null;
  const checkedHeader=(raw:unknown):BrowserIndexHeader=>{
    const h=json<BrowserIndexHeader>(raw as string);
    if(h.source?.localStoreId!==host.authorityId||h.nextIndex?.localStoreId!==host.authorityId||!Array.isArray(h.entries)||h.entries.length>LIMITS.records)throw fail('index_rebuild_required');
    decimalU64(h.source.watermark);return h;
  };
  function captureSource(tx:IDBTransaction,done:(value:SourceCapture)=>void,abort:(error:unknown)=>void):void {
    host.readPublication(tx,publication=>{
      if(publication.entries.length>LIMITS.records)throw fail('index_generation_limit');
      const descriptors:{id:string;content:any}[]=[],entries=new Map(publication.entries.map(e=>[e.id,e])),presentation=new Map(publication.presentation.map(p=>[p.id,p]));let bytes=0,scanned=0;
      const request=tx.objectStore('sync_materialization_refs').openCursor();
      on(request,function next(cursor){if(!cursor){if(descriptors.length!==entries.size)throw fail('storage_corrupt',{invariant:'index_capture_inventory'});done({publication,descriptors});return;}
        if(++scanned>LIMITS.records)throw fail('index_generation_limit');const row=cursor.value,entry=entries.get(row?.id);if(entry){
          if(row.status!=='normal'||!equal(row.entry,entry)||!equal(row.presentation,presentation.get(entry.id))||entry.kind==='file'&&!['text','binary'].includes(row.content?.kind)||entry.kind==='folder'&&row.content!==null)throw fail('storage_corrupt',{invariant:'index_capture_descriptor',entryId:entry.id,normal:row.status==='normal',sameEntry:equal(row.entry,entry),samePresentation:equal(row.presentation,presentation.get(entry.id)),textMode:row.content?.kind==='text',binaryMode:row.content?.kind==='binary'});
          const descriptor={id:entry.id,content:row.content};bytes+=size(JSON.stringify(descriptor));if(bytes>LIMITS.header)throw fail('index_generation_limit');descriptors.push(descriptor);
        }cursor.continue();
      },abort);
    },abort);
  }
  function sourceFence(tx:IDBTransaction,h:BrowserIndexHeader,c:Catalog,expected:SourceCapture,done:()=>void,abort:(error:unknown)=>void):void {
    captureSource(tx,current=>{if(!equal(current,expected))throw fail('index_source_changed');if(!equal(head(c),h.expectedIndex))throw fail('index_head_changed');done();},abort);
  }
  const stageInfo=(stage:Stage):BrowserIndexStage=>{const ready=!!stage.generation;return {stageId:stage.id,snapshot:stage.header.nextIndex,prepared:stage.prepared,total:stage.total,ready,progress:{prepared:stage.prepared,total:stage.total,reused:stage.reused,ready,parseCache:{...stage.parseCache}}};};
  function liveStage(id:string):Stage {active();const stage=stages.get(id);if(!stage)throw fail('index_stage_expired');if(stage.failed)throw fail('index_rebuild_required');return stage;}
  async function readRow(generation:string,entry:EntryState):Promise<CachedRow> {
    const captured=await run<{value:CachedRow;digest:string}>('readonly',['control'],(tx,done,abort)=>on(tx.objectStore('control').get(rowKey(generation,entry.id)),row=>{
      const value=row?.value as CachedRow;
      if(!value||!equal(value.entry,entry)||typeof value.record!=='string'||size(value.record)>LIMITS.row||value.projection!==undefined&&(!(value.projection instanceof Uint8Array)||value.projection.length>LIMITS.text))throw fail('index_rebuild_required');done({value,digest:row.digest});
    },abort));
    if(captured.digest!==await digest(JSON.stringify({entry:captured.value.entry,presentation:captured.value.presentation,sourceDescriptor:captured.value.sourceDescriptor,record:captured.value.record})))throw fail('index_rebuild_required');
    return captured.value;
  }
  async function cleanupGeneration(id:string):Promise<void>{return cleanupPrefix(root(id));}
  async function cleanupPrefix(prefix:string):Promise<void>{
    // Exact derived prefix only, bounded cursor pages; never scans authority control.
    for(;;){const more=await run<boolean>('readwrite',['control'],(tx,done,abort)=>{
      let count=0;const request=tx.objectStore('control').openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));
      on(request,function next(cursor){if(!cursor){done(false);return;}if(count>=32){done(true);return;}
        count++;tx.objectStore('control').delete(cursor.primaryKey);cursor.continue();},abort);
    });if(!more)return;await new Promise<void>(resolve=>setTimeout(resolve,0));}
  }
  async function purge(id:string):Promise<void>{
    // Keep the descriptor and its byte reservation until every immutable row
    // is deleted; interruption cannot create unaccounted orphan projections.
    await cleanupGeneration(id);
    await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.generations=c.generations.filter(g=>g.id!==id||g.state!=='deleting');putCatalog(tx,c);done();},abort));
  }
  async function prune():Promise<void>{
    const removed=await run<string[]>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      const published=c.generations.filter(g=>g.state==='published'),drop:string[]=[];
      while(published.length>LIMITS.generations){const index=published.findIndex(g=>g.id!==c.head&&!c.pins.some(p=>p.generation===g.id));if(index<0)break;drop.push(published.splice(index,1)[0]!.id);}
      for(const g of c.generations)if(drop.includes(g.id))g.state='deleting';putCatalog(tx,c);done(c.generations.filter(g=>g.state==='deleting').map(g=>g.id));
    },abort));
    for(const id of removed)await purge(id);
  }
  let recovery:Promise<void>|undefined;
  function recover():Promise<void>{return recovery??= (async()=>{
    const removed=await run<string[]>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      const ids=c.generations.filter(g=>g.clientId===host.clientId&&g.state==='staging').map(g=>g.id);
      c.pins=c.pins.filter(p=>p.clientId!==host.clientId);for(const g of c.generations)if(ids.includes(g.id))g.state='deleting';putCatalog(tx,c);done(ids);
    },abort));for(const id of removed)await purge(id);
  })();}
  async function assertPin(pinId:string):Promise<Generation>{
    active();const pin=pins.get(pinId);if(!pin)throw fail('index_snapshot_expired');
    await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(!c.pins.some(p=>p.id===pinId&&p.clientId===host.clientId&&p.generation===pin.generation))throw fail('index_snapshot_expired');done();},abort));
    active();if(pins.get(pinId)!==pin)throw fail('index_snapshot_expired');return pin.value;
  }
  function tokenForPin(pinId:string,token:unknown):string {
    if(token===undefined)return '';const value=inputText(token,256),prefix=pinId+'/';
    if(!value.startsWith(prefix)||!/^[1-9][0-9]{0,19}$/.test(value.slice(prefix.length)))throw fail('index_snapshot_expired');return value.slice(prefix.length);
  }
  function envelope(pinId:string,value:unknown):unknown{const pin=pins.get(pinId);if(!pin)throw fail('index_snapshot_expired');return {snapshot:pin.header.nextIndex,source:pin.header.source,coverageComplete:rust(()=>pin.value.coverageComplete()),value};}
  function pinPage(pinId:string,raw:string):unknown {const page=json<Record<string,unknown>>(raw);let cursor:string|null=null;if(page.next!==null&&page.next!==undefined){if(typeof page.next!=='string')throw fail('index_rebuild_required');cursor=pinId+'/'+page.next;}page.next=null;return {result:envelope(pinId,page),cursor};}
  const api:BrowserDocumentIndex={
    initialize(){active();return recover();},
    async discard(stageId){active();if(!validId(stageId))throw fail('index_stage_expired');
      const result=await run<{publishedPruned?:true;published?:{header:string;digest:string;snapshot:BrowserIndexSnapshot}}>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{const stage=c.generations.find(g=>g.id===stageId);
        if(stage?.clientId!==undefined&&stage.clientId!==host.clientId)throw fail('index_stage_expired');
        if(stage?.wasPublished){on(tx.objectStore('control').get(headerKey(stageId)),row=>{
          if(row===undefined&&stage.state==='deleting'){done({publishedPruned:true});return;}
          if(typeof row?.value!=='string'||size(row.value)>3*LIMITS.header)throw fail('index_rebuild_required');done({published:{header:row.value,digest:row.digest,snapshot:stage.snapshot}});
        },abort);return;}
        if(stage){stage.state='deleting';putCatalog(tx,c);}done({});
      },abort));
      if(result.publishedPruned)return;
      if(result.published){const captured=result.published;if(captured.digest!==await digest(captured.header))throw fail('index_rebuild_required');
        const stored=json<StoredHeader>(captured.header,3*LIMITS.header),header=checkedHeader(stored.rust);
        if(!equal(header.nextIndex,captured.snapshot)||!equal(header.entries,stored.capture?.publication?.entries)||header.source.watermark!==stored.capture?.publication?.sequence)throw fail('index_rebuild_required');
        const validator=rust(()=>new host.wasm.WasmDocumentIndexBuilder(stored.rust));validator.free();
        await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{const stage=c.generations.find(g=>g.id===stageId);if(!stage){done();return;}
          if(stage.clientId!==host.clientId||!stage.wasPublished||!equal(stage.snapshot,captured.snapshot))throw fail('index_stage_expired');
          on(tx.objectStore('control').get(headerKey(stageId)),row=>{if(!row&&stage.state==='deleting'){done();return;}if(row?.value!==captured.header||row?.digest!==captured.digest)throw fail('index_rebuild_required');done();},abort);
        },abort));return;
      }
      const stage=stages.get(stageId);stage?.builder?.free();stage?.generation?.free();stages.delete(stageId);await purge(stageId);
    },
    async status(){
      const captured=await run<{source:SourceCapture;catalog?:Catalog;raw?:string;digest?:string}>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>{
        captureSource(tx,source=>on(tx.objectStore('control').get(CATALOG),row=>{let c:Catalog;try{c=catalog(row);}catch{done({source});return;}
          const g=c.generations.find(g=>g.id===c.head);if(!g){done({source,catalog:c});return;}
          on(tx.objectStore('control').get(headerKey(g.id)),row=>done({source,catalog:c,raw:row?.value,digest:row?.digest}),abort);
        },abort),abort);
      });
      const c=captured.catalog,g=c?.generations.find(g=>g.id===c.head),sourceWatermark=captured.source.publication.sequence;
      if(!g)return {sourceWatermark,snapshot:null,coveredWatermark:null,rebuildRequired:!c||!!c.rebuilding,current:false,source:{localStoreId:host.authorityId,watermark:sourceWatermark},coveredSource:null,coverageComplete:null};
      try{if(!captured.raw||captured.digest!==await digest(captured.raw))throw fail('index_rebuild_required');const stored=json<StoredHeader>(captured.raw,3*LIMITS.header);const h=checkedHeader(stored.rust);if(!equal(h.nextIndex.versions,json<unknown>(rust(()=>host.wasm.documentIndexVersionsJson())))||!equal(h.nextIndex,g.snapshot)||!equal(h.entries,stored.capture?.publication?.entries)||h.source.watermark!==stored.capture?.publication?.sequence)throw fail('index_rebuild_required');
        return {sourceWatermark,snapshot:g.snapshot,coveredWatermark:g.sourceWatermark,rebuildRequired:!!c?.rebuilding,current:equal(stored.capture,captured.source),source:{localStoreId:host.authorityId,watermark:sourceWatermark},coverageComplete:g.coverageComplete,coveredSource:{localStoreId:host.authorityId,watermark:g.sourceWatermark}};
      }catch{return {sourceWatermark,snapshot:null,coveredWatermark:null,rebuildRequired:true,current:false,source:{localStoreId:host.authorityId,watermark:sourceWatermark},coverageComplete:null,coveredSource:null};}
    },
    async begin(){
      active();await recover();if(stages.size>=1)throw fail('index_stage_limit');await prune();
      const capture=await run<{source:SourceCapture;catalog:Catalog}>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>{
        captureSource(tx,source=>readCatalog(tx,c=>done({source,catalog:c}),abort),abort);
      });
      if(capture.catalog.rebuilding)throw fail('index_rebuild_required');
      const id=crypto.randomUUID(),versions=json<unknown>(rust(()=>host.wasm.documentIndexVersionsJson()));
      const h:BrowserIndexHeader={source:{localStoreId:host.authorityId,watermark:capture.source.publication.sequence},entries:capture.source.publication.entries,expectedIndex:head(capture.catalog),nextIndex:{localStoreId:host.authorityId,generationEpoch:id,generation:'1',versions}};
      if(h.entries.length>LIMITS.records)throw fail('index_generation_limit');
      const header=JSON.stringify(h);if(size(header)>LIMITS.header)throw fail('index_generation_limit');
      const builder=rust(()=>new host.wasm.WasmDocumentIndexBuilder(header)),canonicalHeader=rust(()=>builder.headerJson()),storedHeader=JSON.stringify({rust:canonicalHeader,capture:capture.source} satisfies StoredHeader),headerDigest=await digest(storedHeader);
      try{await run<void>('readwrite',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>sourceFence(tx,h,c,capture.source,()=>{
        if(c.rebuilding)throw fail('index_rebuild_required');
        if(c.generations.filter(g=>g.state==='staging').length>=LIMITS.stages||c.generations.length>=LIMITS.generations+LIMITS.stages)throw fail('index_cache_limit');
        c.generations.push({id,clientId:host.clientId,state:'staging',snapshot:h.nextIndex,sourceWatermark:h.source.watermark,coverageComplete:false,wasPublished:false,rows:0,bytes:0,metadataBytes:0});
        tx.objectStore('control').add({key:headerKey(id),value:storedHeader,digest:headerDigest});putCatalog(tx,c);done();
      },abort),abort));}catch(error){builder.free();throw error;}
      const stage:Stage={id,capture:capture.source,header:h,builder,prepared:0,total:h.entries.filter(e=>e.kind==='file').length,reused:0,parseCache:{hits:0,misses:0,unavailable:0,corrupt:0,unsupported:0}};if(rust(()=>builder.ready())){stage.generation=rust(()=>builder.finish());builder.free();stage.builder=undefined;}stages.set(id,stage);return stageInfo(stage);
    },
    async pump(stageId){
      const stage=liveStage(stageId);
      // Cache outcomes describe this pump only; legacy reused remains unchanged.
      stage.parseCache={hits:0,misses:0,unavailable:0,corrupt:0,unsupported:0};
      if(stage.generation)return stageInfo(stage);const builder=stage.builder!;try{rust(()=>builder.beginPump());
      const pending=json<EntryState[]>(rust(()=>builder.pendingJson()));let sourceBytes=0;
      for(const entry of pending){
        const source=await run<{entry:EntryState;presentation:BrowserVaultPresentation;bytes?:Uint8Array}>('readonly',['control','metadata','presentation','content','sync_materialization_refs'],(tx,done,abort)=>{
          readCatalog(tx,c=>sourceFence(tx,stage.header,c,stage.capture,()=>{
            on(tx.objectStore('metadata').get(entry.id),row=>{if(!equal(row,entry))throw fail('index_source_changed');on(tx.objectStore('presentation').get(entry.id),presentation=>{
              if(!presentation||presentation.id!==entry.id||![presentation.ctime_ms,presentation.mtime_ms,presentation.size_bytes].every(n=>Number.isSafeInteger(n)&&n>=0))throw fail('storage_corrupt',{invariant:'index_source_presentation',entryId:entry.id});
              on(tx.objectStore('content').get(entry.id),content=>{if(content!==undefined&&(!(content.bytes instanceof Uint8Array)||content.bytes.length!==presentation.size_bytes))throw fail('storage_corrupt',{invariant:'index_source_inline',entryId:entry.id});const mode=stage.capture.descriptors.find(d=>d.id===entry.id)?.content?.kind;if(mode==='text'&&!content||mode==='binary'&&content)throw fail('storage_corrupt',{invariant:'index_source_mode',entryId:entry.id,textMode:mode==='text',binaryMode:mode==='binary',hasInline:!!content});done({entry,presentation,...(mode==='text'?{bytes:content.bytes}:{})});},abort);
            },abort);},abort);
          },abort),abort);
        });
        const bytes=source.bytes,sourceDescriptor=stage.capture.descriptors.find(d=>d.id===entry.id)?.content;
        if(bytes){const metadata=sourceDescriptor?.metadata;
          if(metadata?.byte_length!==String(bytes.length)||metadata.witness?.identity?.entry_id!==entry.id||metadata.witness?.revision!==entry.revision||!Array.isArray(metadata.digest)||metadata.digest.length!==32||!metadata.digest.every((n:unknown)=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=255)||hex(new Uint8Array(metadata.digest))!==await byteDigest(bytes))throw fail('storage_corrupt',{invariant:'index_source_text_commitment',entryId:entry.id,lengthMatches:metadata?.byte_length===String(bytes.length),identityMatches:metadata?.witness?.identity?.entry_id===entry.id,revisionMatches:metadata?.witness?.revision===entry.revision,digestArray:Array.isArray(metadata?.digest)});
        }
        if(sourceBytes>0&&bytes&&sourceBytes+bytes.length>1024*1024)break;
        let reused=false,cachePayload:string|undefined,cacheLocator:string|undefined;try{
          // Unchanged witnesses and presentation reuse validated Rust facts and
          // the old immutable projection. Changed identities bind content facts below.
          if(stage.header.expectedIndex){
            const previousId=stage.header.expectedIndex.generationEpoch;
            try{const previous=await readRow(previousId,entry);if(equal(previous.presentation,source.presentation)&&equal(previous.sourceDescriptor,sourceDescriptor)){
              rust(()=>builder.addPersisted(entry.id,previous.record));reused=true;
            }}catch(error){if(error instanceof BrowserVaultError&&error.code==='index_pump_limit')throw error;/* Cache miss/corruption permits reparsing committed source. */}
          }
          if(!reused){
            if(!bytes)rust(()=>builder.addBinary(entry.id));
            else {
              // Source descriptor, current entry/presentation and actual digest
              // were validated above. Rust preflights before key/lookup work.
              const expected=rust(()=>builder.cacheKeyJson(entry.id,bytes)),key=json<{storageKey:string}|null>(expected);
              if(key===null)rust(()=>builder.addText(entry.id,bytes));
              else {
                if(typeof key.storageKey!=='string'||!/^[0-9a-f]{64}$/.test(key.storageKey))throw fail('index_rebuild_required');
                const lookup=await parseCache.lookup(key.storageKey);let outcome:ParseCacheOutcome=lookup.outcome,added=false;
                if(lookup.outcome==='hit'){
                  const result=json<{outcome:ParseCacheOutcome;added:boolean}>(rust(()=>builder.addCachedText(entry.id,expected,lookup.payload)));
                  if(!['hit','corrupt','unsupported'].includes(result.outcome)||typeof result.added!=='boolean'||result.outcome!=='hit'&&result.added)throw fail('index_rebuild_required');
                  outcome=result.outcome;added=result.added;countCache(stage,outcome);
                  if(outcome==='hit'&&!added)throw fail('index_pump_limit');
                }else countCache(stage,outcome);
                if(!added){
                  const result=json<{payload:string|null;added:boolean}>(rust(()=>builder.extractText(entry.id,bytes)));
                  if(typeof result.added!=='boolean'||result.payload!==null&&typeof result.payload!=='string')throw fail('index_rebuild_required');
                  if(!result.added)throw fail('index_pump_limit');
                  if(result.payload!==null){cacheLocator=key.storageKey;cachePayload=result.payload;}
                }
              }
            }
          }
        }catch(error){if(error instanceof BrowserVaultError&&error.code==='index_pump_limit'&&sourceBytes>0)break;throw error;}
        const record=rust(()=>builder.rowJson(entry.id));if(size(record)>LIMITS.row)throw fail('index_generation_limit');
        const fields=json<{digest?:unknown;textBytes?:number;exclusion?:unknown}>(record,LIMITS.row);
        const projection=bytes&&fields.exclusion==null?bytes:undefined;
        const row:CachedRow={entry,presentation:source.presentation,sourceDescriptor,record,...(projection?{projection}:{})};
        const rowDigest=await digest(JSON.stringify({entry,presentation:source.presentation,sourceDescriptor,record}));
        await run<void>('readwrite',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>sourceFence(tx,stage.header,c,stage.capture,()=>{
          const d=c.generations.find(g=>g.id===stage.id&&g.state==='staging');if(!d)throw fail('index_stage_expired');
          d.rows++;d.bytes+=projection?.length??0;d.metadataBytes+=size(record);
          if(d.rows>LIMITS.records||d.bytes>LIMITS.projection||d.metadataBytes>LIMITS.metadata||c.generations.reduce((n,g)=>n+g.bytes,0)>LIMITS.cache)throw fail('index_cache_limit');
          tx.objectStore('control').add({key:rowKey(stage.id,entry.id),value:row,digest:rowDigest});putCatalog(tx,c);done();
        },abort),abort));stage.prepared++;if(reused)stage.reused++;sourceBytes+=bytes?.length??0;
        if(cacheLocator!==undefined&&cachePayload!==undefined)await parseCache.store(cacheLocator,cachePayload);
      }
      if(rust(()=>builder.ready())){stage.generation=rust(()=>builder.finish());builder.free();stage.builder=undefined;}
      return stageInfo(stage);
      }catch(error){stage.failed=true;throw error;}
    },
    async publish(stageId){const stage=liveStage(stageId);if(!stage.generation)throw fail('index_not_ready');
      const snapshot=json<BrowserIndexSnapshot>(rust(()=>stage.generation!.snapshotJson()));
      await run<void>('readwrite',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>sourceFence(tx,stage.header,c,stage.capture,()=>{
        const d=c.generations.find(g=>g.id===stage.id);if(!d||d.state!=='staging'||d.rows!==stage.total)throw fail('index_rebuild_required');d.state='published';d.wasPublished=true;d.coverageComplete=rust(()=>stage.generation!.coverageComplete());c.head=stage.id;putCatalog(tx,c);done();
      },abort),abort));stage.generation.free();stages.delete(stageId);await prune();return snapshot;
    },
    async open(){
      await recover();const pinId=crypto.randomUUID();const captured=await run<{id:string;header:string;digest:string;snapshot:BrowserIndexSnapshot}>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
        const g=c.generations.find(g=>g.id===c.head&&g.state==='published');if(!g)throw fail('index_not_ready');if(c.pins.length>=LIMITS.pins)throw fail('index_pin_limit');
        on(tx.objectStore('control').get(headerKey(g.id)),row=>{if(typeof row?.value!=='string'||size(row.value)>3*LIMITS.header)throw fail('index_rebuild_required');c.pins.push({id:pinId,clientId:host.clientId,generation:g.id});putCatalog(tx,c);done({id:g.id,header:row.value,digest:row.digest,snapshot:g.snapshot});},abort);
      },abort));
      if(captured.digest!==await digest(captured.header)){await api.closePin(pinId);throw fail('index_rebuild_required');}
      let builder:Builder|undefined;
      try{const stored=json<StoredHeader>(captured.header,3*LIMITS.header),h=checkedHeader(stored.rust);if(!equal(h.nextIndex,captured.snapshot)||!equal(h.entries,stored.capture?.publication?.entries)||h.source.watermark!==stored.capture?.publication?.sequence)throw fail('index_rebuild_required');builder=rust(()=>new host.wasm.WasmDocumentIndexBuilder(stored.rust));let count=0;for(const entry of h.entries){if(entry.kind!=='file')continue;if(count++%32===0)rust(()=>builder!.beginPump());const row=await readRow(captured.id,entry);try{rust(()=>builder!.addPersisted(entry.id,row.record));}catch(error){if(!(error instanceof BrowserVaultError)||error.code!=='index_pump_limit')throw error;rust(()=>builder!.beginPump());rust(()=>builder!.addPersisted(entry.id,row.record));}}
        const generation=rust(()=>builder!.finish());pins.set(pinId,{generation:captured.id,value:generation,header:h,capture:stored.capture});return {pinId,snapshot:captured.snapshot,source:h.source,coverageComplete:rust(()=>generation.coverageComplete())};
      }catch(error){await api.closePin(pinId);throw error;}finally{builder?.free();}
    },
    async closePin(pinId){active();retireRichPin(pinId);pins.get(pinId)?.value.free();pins.delete(pinId);await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.id!==pinId||p.clientId!==host.clientId);putCatalog(tx,c);done();},abort));},
    async search(input){const g=await assertPin(input.pinId),pin=pins.get(input.pinId)!;const page=rust(()=>g.openLiteral(inputText(input.query,4096),tokenForPin(input.pinId,input.cursor),pageLimit(input.limit)));try{
      for(;;){const entry=json<EntryState|null>(rust(()=>page.nextReadJson()));if(!entry)break;const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_rebuild_required');rust(()=>page.accept(row.projection!));}
      const result=pinPage(input.pinId,rust(()=>page.finishJson()));await assertPin(input.pinId);return result;
    }finally{page.free();}},
    async richStart(input){
      const captured=captureRichRequest(input,['pinId','spec']),pinId=captured.pinId;
      let spec:SearchSpec;try{spec=searchSpec(captured.spec);}catch{throw richFail('invalid_request');}
      const g=await assertPin(pinId);active();const pin=pins.get(pinId);if(!pin||pin.value!==g)throw fail('index_snapshot_expired');const session=richSession();
      const entries=new Map<string,EntryState>(),presentations=new Map<string,BrowserVaultPresentation>();
      for(const fact of pin.capture.publication.presentation){if(presentations.has(fact.id))throw fail('index_rebuild_required');presentations.set(fact.id,fact);}
      const facts:{entryId:string;revision:string;ctimeMs:number;mtimeMs:number}[]=[];let factsBytes=2;
      for(const entry of pin.header.entries){if(entry.kind!=='file')continue;const fact=presentations.get(entry.id);if(!fact||!Number.isSafeInteger(fact.ctime_ms)||!Number.isSafeInteger(fact.mtime_ms))throw fail('index_rebuild_required');
        const row={entryId:entry.id,revision:entry.revision,ctimeMs:fact.ctime_ms,mtimeMs:fact.mtime_ms};factsBytes+=size(JSON.stringify(row))+(facts.length?1:0);if(factsBytes>LIMITS.header||facts.length===LIMITS.records)throw richFail('search_resource');facts.push(row);entries.set(entry.id,entry);
      }
      admittedRichPin(pinId,pin,session);
      const core=richRust(()=>session.value.startQuery(g,JSON.stringify(spec),JSON.stringify(facts)),spec.query);
      let queryId:string;try{queryId=richToken(pinId+'/'+core);}catch{richRust(()=>session.value.closeQuery(core),spec.query);throw richFail('search_resource');}
      const query:RichQueryBinding={pinId,pin,session,core,spec,entries,retired:false,busy:false};richQueries.set(queryId,query);
      try{await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);return Object.freeze({queryId});}
      catch(error){quietRetireRich(queryId,query);throw error;}
    },
    async richPrepare(input){
      const captured=captureRichRequest(input,['pinId','queryId']),pinId=captured.pinId,queryId=captured.queryId as string;
      let query:RichQueryBinding;try{await assertPin(pinId);query=getRichQuery(pinId,queryId);}catch(error){const old=richQueries.get(queryId);if(old?.pinId===pinId)quietRetireRich(queryId,old);throw error;}if(query.busy)throw richFail('search_busy');
      const raw=richRust(()=>query.session.value.prepareJson(query.core),query.spec.query);
      let response:ReturnType<typeof richPreparation>;try{response=richPreparation(json<unknown>(raw,65536));}catch(error){if(error instanceof BrowserVaultError)throw error;throw fail('index_rebuild_required');}
      const result=response.state==='ready'?Object.freeze({state:'ready' as const,cursor:richToken(queryId+'/'+response.cursor)}):response;
      await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);return result;
    },
    async richPage(input){
      const captured=captureRichRequest(input,['pinId','queryId','cursor']),pinId=captured.pinId,queryId=captured.queryId as string,cursor=captured.cursor as string;
      let query:RichQueryBinding;try{await assertPin(pinId);query=getRichQuery(pinId,queryId);}catch(error){const old=richQueries.get(queryId);if(old?.pinId===pinId)quietRetireRich(queryId,old);throw error;}if(query.busy)throw richFail('search_busy');
      const prefix=queryId+'/';if(!cursor.startsWith(prefix)||cursor.length===prefix.length)throw richFail('search_expired');
      query.busy=true;let drive:RichDrive|undefined,prepared:RichPrepared|undefined,commitStarted=false;
      try{
        admittedRichQuery(queryId,query);drive=richRust(()=>query.session.value.openDrive(query.core,cursor.slice(prefix.length)),query.spec.query);
        for(;;){
          admittedRichQuery(queryId,query);const action=richAction(richRust(()=>drive!.nextActionJson(),query.spec.query),query.pin.header.nextIndex,query.entries);
          if(action.kind!=='readText')break;
          await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);
          const row=await readRow(query.pin.generation,action.entry);
          await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);
          if(!row.projection||row.projection.byteLength!==action.bytes)throw fail('index_source_unavailable');
          // The outstanding Rust request owns the digest and UTF8/NUL checks;
          // this descriptor is only an admitted host read, never an offset API.
          richRust(()=>drive!.accept(row.projection!),query.spec.query);
        }
        await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);
        prepared=richRust(()=>drive!.finish(),query.spec.query);
        // No await or mutable WASM borrow between the final local admission and
        // commit. A later failed admission never exposes this result/cursor.
        admittedRichQuery(queryId,query);
        commitStarted=true;const raw=richRust(()=>query.session.value.commitJson(prepared!),query.spec.query);
        const page=json<{result:unknown;cursor:unknown}>(raw,2*1024*1024);
        if(page.cursor!==null){let token:string;try{token=richToken(page.cursor);}catch{throw fail('index_rebuild_required');}page.cursor=richToken(queryId+'/'+token);}
        let result;try{result=decodeRichPage(page,{snapshot:query.pin.header.nextIndex as DocumentSnapshotId,source:query.pin.header.source,coverageComplete:richRust(()=>query.pin.value.coverageComplete(),query.spec.query),spec:query.spec});}catch(error){if(error instanceof BrowserVaultError)throw error;throw fail('index_rebuild_required');}
        await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);return result;
      }catch(error){if(commitStarted)quietRetireRich(queryId,query);throw error;}finally{prepared?.free();drive?.free();query.busy=false;}
    },
    async richClose(input){
      const captured=captureRichRequest(input,['pinId','queryId']),pinId=captured.pinId,queryId=captured.queryId as string;
      active();if(!queryId.startsWith(pinId+'/'))throw richFail('search_expired');const query=richQueries.get(queryId);
      // Same-pin unknown close is an idempotent cleanup acknowledgement, even
      // after a failed final pin fence retired it. It admits no query or read.
      if(!query)return;
      await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);retireRichQuery(queryId,query);
      try{await assertPin(pinId);}catch(error){quietRetireRich(queryId,query);throw error;}
    },
    async resolve(input){const g=await assertPin(input.pinId),result=json<unknown>(rust(()=>g.resolveJson(inputText(input.sourceId,128),inputText(input.destination,4096))));await assertPin(input.pinId);return result;},
    async backlinks(input){const g=await assertPin(input.pinId),result=pinPage(input.pinId,rust(()=>g.backlinksJson(inputText(input.targetId,128),tokenForPin(input.pinId,input.cursor),pageLimit(input.limit))));await assertPin(input.pinId);return result;},
    async metadata(input){const g=await assertPin(input.pinId),result=json<unknown>(rust(()=>g.metadataJson(inputText(input.id,128))));await assertPin(input.pinId);return result;},
    async tasks(input){
      // Capture bounded selectors/options before any await. Caller mutation must
      // not redirect an admitted read to current or unrelated configuration.
      const captured=captureBrowserTaskQuery(input),ids=captured.typeIds,options=JSON.stringify(captured.options),pinId=captured.pinId,g=await assertPin(pinId),pin=pins.get(pinId)!;
      const sources:{id:string;source:string}[]=[];let bytes=0;
      for(const id of ids){
        const entry=pin.header.entries.find(e=>e.id===id&&e.kind==='file');if(!entry)throw fail('index_missing_source');
        const row=await readRow(pin.generation,entry);await assertPin(pinId);
        if(!row.projection)throw fail('index_source_unavailable');
        bytes+=row.projection.byteLength;if(row.projection.byteLength>256*1024||bytes>1024*1024)throw fail('index_input_limit');
        let source:string;try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.projection);}catch{throw fail('index_source_unavailable');}
        sources.push({id,source});
      }
      const sourcesJson=JSON.stringify(sources);if(size(sourcesJson)>7*1024*1024)throw fail('index_input_limit');
      await assertPin(pinId);const result=json<unknown>(rust(()=>g.tasksJson(sourcesJson,options)));await assertPin(pinId);return result;
    },
    async base(input){
      // Capture caller-owned selectors before any await. Admission remains per
      // invocation; neither the pure-data cache nor an old result admits a pin.
      const pinId=inputText(input.pinId,128),id=inputText(input.id,128),options=baseOptions(input.options),viewName=input.viewName==null?undefined:inputText(input.viewName,1024);
      const g=await assertPin(pinId);active();const pin=pins.get(pinId);if(!pin||pin.value!==g)throw fail('index_snapshot_expired');
      const admitted=()=>{active();if(pins.get(pinId)!==pin)throw fail('index_snapshot_expired');};
      const entry=pin.header.entries.find(e=>e.id===id&&e.kind==='file');if(!entry)throw fail('index_missing_source');
      const files=pin.header.entries.filter(e=>e.kind==='file');if(files.length>LIMITS.baseRecords)throw fail('index_input_limit');
      const presentations=new Map<string,BrowserVaultPresentation>();for(const row of pin.capture.publication.presentation){if(presentations.has(row.id))throw fail('index_rebuild_required');presentations.set(row.id,row);}
      const facts=[];let factsBytes=2;for(const e of files){const presentation=presentations.get(e.id);if(!presentation)throw fail('index_rebuild_required');
        const fact={witness:{entryId:e.id,revision:e.revision},size:presentation.size_bytes,ctimeMs:presentation.ctime_ms,mtimeMs:presentation.mtime_ms};factsBytes+=size(JSON.stringify(fact))+(facts.length?1:0);if(factsBytes>LIMITS.baseFacts)throw fail('index_input_limit');facts.push(fact);}
      const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_source_unavailable');const factsJson=JSON.stringify(facts);
      await assertPin(pinId);
      // No await after acquiring this owner handle: close/rebuild cannot free it
      // during use. Rust rechecks retained bytes/UTF8 before lookup and after eval.
      admitted();const result=json<unknown>(rust(()=>{preparation??=new host.wasm.WasmDocumentIndexPreparationCache();return preparation.baseJson(g,id,row.projection!,factsJson,options,monotonicMs(),viewName);}));
      await assertPin(pinId);admitted();return result;
    },
    async rebuild(){active();releaseRich();releasePreparation();for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();for(const pin of pins.values())pin.value.free();pins.clear();
      // Explicit rebuild expires every old pin; fresh epochs prevent token ABA.
      recovery=undefined;const nonce=crypto.randomUUID();await run<void>('readwrite',['control'],(tx,done)=>{putCatalog(tx,{...empty(),rebuilding:nonce});done();});
      // Generation rebuild preserves the separate validated content-facts family.
      await cleanupPrefix(PREFIX+'g/');
      await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(c.rebuilding===nonce)putCatalog(tx,empty());done();},abort));
    },
    async close(){if(closed)return;releaseRich();releasePreparation();for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();for(const pin of pins.values())pin.value.free();pins.clear();
      try{await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.clientId!==host.clientId);for(const g of c.generations)if(g.clientId===host.clientId&&g.state==='staging')g.state='deleting';putCatalog(tx,c);done();},abort));}catch{/* Cache cleanup never blocks source close. Explicit rebuild repairs derived state. */}finally{closed=true;}
    },
  };return api;
}
