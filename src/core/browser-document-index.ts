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
interface Builder extends Free {headerJson():string;pendingJson():string;beginPump():void;addText(id:string,bytes:Uint8Array):void;addBinary(id:string):void;addUnreadable(id:string):void;addPersisted(id:string,row:string):void;rowJson(id:string):string;ready():boolean;finish():Generation}
interface Generation extends Free {headerJson():string;snapshotJson():string;rowJson(id:string):string;coverageComplete():boolean;metadataJson(id:string):string;baseJson(id:string,bytes:Uint8Array,facts:string,options:string,viewName?:string|null):string;resolveJson(id:string,destination:string):string;backlinksJson(id:string,token:string,limit:number):string;openLiteral(query:string,token:string,limit:number):LiteralPage}
interface LiteralPage extends Free {nextReadJson():string;accept(bytes:Uint8Array):void;finishJson():string}
export interface BrowserDocumentIndexWasm {documentIndexVersionsJson():string;WasmDocumentIndexBuilder:new(input:string)=>Builder}
export interface BrowserDocumentIndexHost {
  db:IDBDatabase;authorityId:string;clientId:string;wasm:BrowserDocumentIndexWasm;assertActive():void;
  readPublication(tx:IDBTransaction,done:(value:StreamingPublication)=>void,abort:(error:unknown)=>void):void;
}
export interface BrowserIndexStage {stageId:string;snapshot:BrowserIndexSnapshot;progress:{prepared:number;total:number;reused:number;ready:boolean};prepared:number;total:number;ready:boolean}
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
  base(input:{pinId:string;id:string;viewName?:string|null;options?:{viewIndex?:number;searchTerms?:string[];ignorePaths?:string[];clockMs?:number;timezone?:string;maxRows?:number;currentEntryId?:string;maxSteps?:number}}):Promise<unknown>;
  rebuild():Promise<void>;close():Promise<void>;
}
interface Catalog {rebuilding?:string;version:1;localStoreId:string;head:string|null;generations:Descriptor[];pins:{id:string;clientId:string;generation:string}[]}
interface Descriptor {id:string;clientId:string;state:'staging'|'published'|'deleting';snapshot:BrowserIndexSnapshot;sourceWatermark:string;coverageComplete:boolean;wasPublished:boolean;rows:number;bytes:number;metadataBytes:number}
interface CachedRow {sourceDescriptor:unknown;entry:EntryState;presentation:BrowserVaultPresentation;record:string;projection?:Uint8Array}
interface SourceCapture {publication:StreamingPublication;descriptors:{id:string;content:any}[]}
interface StoredHeader {rust:string;capture:SourceCapture}
interface Stage {failed?:boolean;capture:SourceCapture;id:string;header:BrowserIndexHeader;builder?:Builder;generation?:Generation;prepared:number;total:number;reused:number}
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
function inputText(value:unknown,maxBytes:number):string{if(typeof value!=='string'||value.length>maxBytes||size(value)>maxBytes)throw fail('index_invalid_request');for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw fail('index_invalid_request');}else if(code>=0xdc00&&code<=0xdfff)throw fail('index_invalid_request');}return value;}
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function json<T>(raw:string,max=LIMITS.header):T {if(typeof raw!=='string'||size(raw)>max)throw fail('index_rebuild_required');try{return JSON.parse(raw) as T;}catch{throw fail('index_rebuild_required');}}
function rust<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;let code='index_rebuild_required',details:unknown;try{const parsed=JSON.parse(String(error));if(typeof parsed.code==='string'&&parsed.code.startsWith('index_'))code=parsed.code;details=parsed.diagnostic;}catch{}throw new BrowserVaultError(code,'Shared Rust document engine rejected the operation',details,'rust');}}

export function browserDocumentIndex(host:BrowserDocumentIndexHost):BrowserDocumentIndex {
  const stages=new Map<string,Stage>(),pins=new Map<string,{generation:string;value:Generation;header:BrowserIndexHeader;capture:SourceCapture}>();
  let closed=false;
  const active=()=>{if(closed)throw fail('index_closed');host.assertActive();};
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
  const stageInfo=(stage:Stage):BrowserIndexStage=>{const ready=!!stage.generation;return {stageId:stage.id,snapshot:stage.header.nextIndex,prepared:stage.prepared,total:stage.total,ready,progress:{prepared:stage.prepared,total:stage.total,reused:stage.reused,ready}};};
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
    await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(!c.pins.some(p=>p.id===pinId&&p.clientId===host.clientId&&p.generation===pin.generation))throw fail('index_snapshot_expired');done();},abort));return pin.value;
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
      const stage:Stage={id,capture:capture.source,header:h,builder,prepared:0,total:h.entries.filter(e=>e.kind==='file').length,reused:0};if(rust(()=>builder.ready())){stage.generation=rust(()=>builder.finish());builder.free();stage.builder=undefined;}stages.set(id,stage);return stageInfo(stage);
    },
    async pump(stageId){
      const stage=liveStage(stageId);if(stage.generation)return stageInfo(stage);const builder=stage.builder!;try{rust(()=>builder.beginPump());
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
        let reused=false;try{
          // Unchanged witnesses and presentation reuse validated Rust facts and
          // the old immutable projection. A move receives a new witness/parse.
          if(stage.header.expectedIndex){
            const previousId=stage.header.expectedIndex.generationEpoch;
            try{const previous=await readRow(previousId,entry);if(equal(previous.presentation,source.presentation)&&equal(previous.sourceDescriptor,sourceDescriptor)){
              rust(()=>builder.addPersisted(entry.id,previous.record));reused=true;
            }}catch(error){if(error instanceof BrowserVaultError&&error.code==='index_pump_limit')throw error;/* Cache miss/corruption permits reparsing committed source. */}
          }
          if(!reused)rust(()=>bytes?builder.addText(entry.id,bytes):builder.addBinary(entry.id));
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
    async closePin(pinId){active();pins.get(pinId)?.value.free();pins.delete(pinId);await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.id!==pinId||p.clientId!==host.clientId);putCatalog(tx,c);done();},abort));},
    async search(input){const g=await assertPin(input.pinId),pin=pins.get(input.pinId)!;const page=rust(()=>g.openLiteral(inputText(input.query,4096),tokenForPin(input.pinId,input.cursor),pageLimit(input.limit)));try{
      for(;;){const entry=json<EntryState|null>(rust(()=>page.nextReadJson()));if(!entry)break;const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_rebuild_required');rust(()=>page.accept(row.projection!));}
      const result=pinPage(input.pinId,rust(()=>page.finishJson()));await assertPin(input.pinId);return result;
    }finally{page.free();}},
    async resolve(input){const g=await assertPin(input.pinId),result=json<unknown>(rust(()=>g.resolveJson(inputText(input.sourceId,128),inputText(input.destination,4096))));await assertPin(input.pinId);return result;},
    async backlinks(input){const g=await assertPin(input.pinId),result=pinPage(input.pinId,rust(()=>g.backlinksJson(inputText(input.targetId,128),tokenForPin(input.pinId,input.cursor),pageLimit(input.limit))));await assertPin(input.pinId);return result;},
    async metadata(input){const g=await assertPin(input.pinId),result=json<unknown>(rust(()=>g.metadataJson(inputText(input.id,128))));await assertPin(input.pinId);return result;},
    async base(input){const options=baseOptions(input.options),g=await assertPin(input.pinId),pin=pins.get(input.pinId)!,id=inputText(input.id,128),entry=pin.header.entries.find(e=>e.id===id&&e.kind==='file');if(!entry)throw fail('index_missing_source');
      const files=pin.header.entries.filter(e=>e.kind==='file');if(files.length>LIMITS.baseRecords)throw fail('index_input_limit');
      const presentations=new Map<string,BrowserVaultPresentation>();for(const row of pin.capture.publication.presentation){if(presentations.has(row.id))throw fail('index_rebuild_required');presentations.set(row.id,row);}
      const facts=[];let factsBytes=2;for(const e of files){const presentation=presentations.get(e.id);if(!presentation)throw fail('index_rebuild_required');
        const fact={witness:{entryId:e.id,revision:e.revision},size:presentation.size_bytes,ctimeMs:presentation.ctime_ms,mtimeMs:presentation.mtime_ms};factsBytes+=size(JSON.stringify(fact))+(facts.length?1:0);if(factsBytes>LIMITS.baseFacts)throw fail('index_input_limit');facts.push(fact);}
      const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_source_unavailable');const factsJson=JSON.stringify(facts);
      const viewName=input.viewName==null?undefined:inputText(input.viewName,1024);await assertPin(input.pinId);
      const result=json<unknown>(rust(()=>g.baseJson(id,row.projection!,factsJson,options,viewName)));await assertPin(input.pinId);return result;
    },
    async rebuild(){active();for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();for(const pin of pins.values())pin.value.free();pins.clear();
      // Explicit rebuild expires every old pin; fresh epochs prevent token ABA.
      recovery=undefined;const nonce=crypto.randomUUID();await run<void>('readwrite',['control'],(tx,done)=>{putCatalog(tx,{...empty(),rebuilding:nonce});done();});
      await cleanupPrefix(PREFIX+'g/');
      await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(c.rebuilding===nonce)putCatalog(tx,empty());done();},abort));
    },
    async close(){if(closed)return;for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();for(const pin of pins.values())pin.value.free();pins.clear();
      try{await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.clientId!==host.clientId);for(const g of c.generations)if(g.clientId===host.clientId&&g.state==='staging')g.state='deleting';putCatalog(tx,c);done();},abort));}catch{/* Cache cleanup never blocks source close. Explicit rebuild repairs derived state. */}finally{closed=true;}
    },
  };return api;
}
