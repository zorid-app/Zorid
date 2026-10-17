import {BrowserVaultError} from './browser-vault.ts';
import type {BrowserVaultPresentation, EntryState} from './browser-vault.ts';
import {decimalU64, normalizedTransact} from './browser-normalized-idb.ts';
import type {StreamingPublication} from './browser-sync-streaming.ts';

/** Disposable, local-only rows in the existing authority DB. Source writes never
 * consult these keys. No source envelopes, receipts or sync exports contain them. */
const PREFIX='document-index:v1/', CATALOG=PREFIX+'catalog';
const LIMITS=Object.freeze({header:16*1024*1024,row:16*1024*1024,text:16*1024*1024,records:100000,
  metadata:64*1024*1024,projection:256*1024*1024,cache:512*1024*1024,pins:4,stages:4,generations:3});
const fail=(code:string)=>new BrowserVaultError(code,'Disposable document index is unavailable; source files remain authoritative');
const size=(text:string)=>new TextEncoder().encode(text).byteLength;
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
interface Free {free():void}
export interface BrowserIndexSnapshot {localStoreId:string;generationEpoch:string;generation:string;versions:unknown}
export interface BrowserIndexHeader {source:{localStoreId:string;watermark:string};entries:EntryState[];expectedIndex:BrowserIndexSnapshot|null;nextIndex:BrowserIndexSnapshot}
interface Builder extends Free {headerJson():string;pendingJson():string;beginPump():void;addText(id:string,bytes:Uint8Array):void;addBinary(id:string):void;addUnreadable(id:string):void;addPersisted(id:string,row:string):void;rowJson(id:string):string;ready():boolean;finish():Generation}
interface Generation extends Free {headerJson():string;snapshotJson():string;rowJson(id:string):string;coverageComplete():boolean;resolveJson(id:string,destination:string):string;backlinksJson(id:string,token:string,limit:number):string;openLiteral(query:string,token:string,limit:number):LiteralPage}
interface LiteralPage extends Free {nextReadJson():string;accept(bytes:Uint8Array):void;finishJson():string}
export interface BrowserDocumentIndexWasm {documentIndexVersionsJson():string;WasmDocumentIndexBuilder:new(input:string)=>Builder}
export interface BrowserDocumentIndexHost {
  db:IDBDatabase;authorityId:string;clientId:string;wasm:BrowserDocumentIndexWasm;assertActive():void;
  readPublication(tx:IDBTransaction,done:(value:StreamingPublication)=>void,abort:(error:unknown)=>void):void;
}
export interface BrowserIndexStage {stageId:string;prepared:number;total:number;ready:boolean}
export interface BrowserIndexPin {pinId:string;snapshot:BrowserIndexSnapshot}
export interface BrowserDocumentIndex {
  status():Promise<{sourceWatermark:string;snapshot:BrowserIndexSnapshot|null;coveredWatermark:string|null;rebuildRequired:boolean;current:boolean}>;
  begin():Promise<BrowserIndexStage>;pump(stageId:string):Promise<BrowserIndexStage>;publish(stageId:string):Promise<BrowserIndexSnapshot>;
  open():Promise<BrowserIndexPin>;closePin(pinId:string):Promise<void>;
  search(input:{pinId:string;query:string;token?:string;limit?:number}):Promise<unknown>;
  resolve(input:{pinId:string;sourceId:string;destination:string}):Promise<unknown>;
  backlinks(input:{pinId:string;targetId:string;token?:string;limit?:number}):Promise<unknown>;
  rebuild():Promise<void>;close():Promise<void>;
}
interface Catalog {rebuilding?:string;version:1;localStoreId:string;head:string|null;generations:Descriptor[];pins:{id:string;clientId:string;generation:string}[]}
interface Descriptor {id:string;clientId:string;state:'staging'|'published';snapshot:BrowserIndexSnapshot;sourceWatermark:string;rows:number;bytes:number;metadataBytes:number}
interface CachedRow {sourceDescriptor:unknown;entry:EntryState;presentation:BrowserVaultPresentation;record:string;projection?:Uint8Array}
interface SourceCapture {publication:StreamingPublication;descriptors:{id:string;content:any}[]}
interface StoredHeader {rust:string;capture:SourceCapture}
interface Stage {failed?:boolean;capture:SourceCapture;id:string;header:BrowserIndexHeader;builder?:Builder;generation?:Generation;prepared:number;total:number}
const root=(id:string)=>PREFIX+'g/'+id+'/';
const rowKey=(id:string,entryId:string)=>root(id)+'row/'+entryId;
const headerKey=(id:string)=>root(id)+'header';
const hex=(bytes:Uint8Array)=>Array.from(bytes).map(n=>n.toString(16).padStart(2,'0')).join('');
const byteDigest=async(bytes:Uint8Array):Promise<string>=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)));
const digest=(value:string):Promise<string>=>byteDigest(new TextEncoder().encode(value));
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function json<T>(raw:string,max=LIMITS.header):T {if(typeof raw!=='string'||size(raw)>max)throw fail('index_rebuild_required');try{return JSON.parse(raw) as T;}catch{throw fail('index_rebuild_required');}}
function rust<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;let code='index_rebuild_required';try{const parsed=JSON.parse(String(error));if(typeof parsed.code==='string'&&parsed.code.startsWith('index_'))code=parsed.code;}catch{}throw fail(code);}}

export function browserDocumentIndex(host:BrowserDocumentIndexHost):BrowserDocumentIndex {
  const stages=new Map<string,Stage>(),pins=new Map<string,{generation:string;value:Generation}>();
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
    for(const g of c.generations){if(!validId(g.id)||ids.has(g.id)||!validId(g.clientId)||!['staging','published'].includes(g.state)||g.snapshot?.localStoreId!==host.authorityId||![g.rows,g.bytes,g.metadataBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||g.rows>LIMITS.records||g.bytes>LIMITS.projection||g.metadataBytes>LIMITS.metadata)throw fail('index_rebuild_required');decimalU64(g.sourceWatermark);ids.add(g.id);bytes+=g.bytes;}
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
      on(request,function next(cursor){if(!cursor){if(descriptors.length!==entries.size)throw fail('storage_corrupt');done({publication,descriptors});return;}
        if(++scanned>LIMITS.records)throw fail('index_generation_limit');const row=cursor.value,entry=entries.get(row?.id);if(entry){
          if(row.status!=='normal'||!equal(row.entry,entry)||!equal(row.presentation,presentation.get(entry.id))||entry.kind==='file'&&!['text','binary'].includes(row.content?.kind)||entry.kind==='folder'&&row.content!==null)throw fail('storage_corrupt');
          const descriptor={id:entry.id,content:row.content};bytes+=size(JSON.stringify(descriptor));if(bytes>LIMITS.header)throw fail('index_generation_limit');descriptors.push(descriptor);
        }cursor.continue();
      },abort);
    },abort);
  }
  function sourceFence(tx:IDBTransaction,h:BrowserIndexHeader,c:Catalog,expected:SourceCapture,done:()=>void,abort:(error:unknown)=>void):void {
    captureSource(tx,current=>{if(!equal(current,expected))throw fail('index_source_changed');if(!equal(head(c),h.expectedIndex))throw fail('index_head_changed');done();},abort);
  }
  const stageInfo=(stage:Stage):BrowserIndexStage=>({stageId:stage.id,prepared:stage.prepared,total:stage.total,ready:!!stage.generation||rust(()=>stage.builder!.ready())});
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
  async function prune():Promise<void>{
    const removed=await run<string[]>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      const published=c.generations.filter(g=>g.state==='published'),drop:string[]=[];
      while(published.length>LIMITS.generations){const index=published.findIndex(g=>g.id!==c.head&&!c.pins.some(p=>p.generation===g.id));if(index<0)break;drop.push(published.splice(index,1)[0]!.id);}
      c.generations=c.generations.filter(g=>!drop.includes(g.id));putCatalog(tx,c);done(drop);
    },abort));
    for(const id of removed)await cleanupGeneration(id);
  }
  let recovery:Promise<void>|undefined;
  function recover():Promise<void>{return recovery??= (async()=>{
    const removed=await run<string[]>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      const ids=c.generations.filter(g=>g.clientId===host.clientId&&g.state==='staging').map(g=>g.id);
      c.pins=c.pins.filter(p=>p.clientId!==host.clientId);c.generations=c.generations.filter(g=>!ids.includes(g.id));putCatalog(tx,c);done(ids);
    },abort));for(const id of removed)await cleanupGeneration(id);
  })();}
  async function assertPin(pinId:string):Promise<Generation>{
    active();const pin=pins.get(pinId);if(!pin)throw fail('index_snapshot_expired');
    await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(!c.pins.some(p=>p.id===pinId&&p.clientId===host.clientId&&p.generation===pin.generation))throw fail('index_snapshot_expired');done();},abort));return pin.value;
  }
  const api:BrowserDocumentIndex={
    async status(){
      const captured=await run<{source:SourceCapture;catalog?:Catalog;raw?:string;digest?:string}>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>{
        captureSource(tx,source=>on(tx.objectStore('control').get(CATALOG),row=>{let c:Catalog;try{c=catalog(row);}catch{done({source});return;}
          const g=c.generations.find(g=>g.id===c.head);if(!g){done({source,catalog:c});return;}
          on(tx.objectStore('control').get(headerKey(g.id)),row=>done({source,catalog:c,raw:row?.value,digest:row?.digest}),abort);
        },abort),abort);
      });
      const c=captured.catalog,g=c?.generations.find(g=>g.id===c.head),sourceWatermark=captured.source.publication.sequence;
      try{if(!g||!captured.raw||captured.digest!==await digest(captured.raw))throw fail('index_rebuild_required');const stored=json<StoredHeader>(captured.raw,3*LIMITS.header);checkedHeader(stored.rust);
        return {sourceWatermark,snapshot:g.snapshot,coveredWatermark:g.sourceWatermark,rebuildRequired:!!c?.rebuilding,current:equal(stored.capture,captured.source)};
      }catch{return {sourceWatermark,snapshot:null,coveredWatermark:null,rebuildRequired:true,current:false};}
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
        c.generations.push({id,clientId:host.clientId,state:'staging',snapshot:h.nextIndex,sourceWatermark:h.source.watermark,rows:0,bytes:0,metadataBytes:0});
        tx.objectStore('control').add({key:headerKey(id),value:storedHeader,digest:headerDigest});putCatalog(tx,c);done();
      },abort),abort));}catch(error){builder.free();throw error;}
      const stage:Stage={id,capture:capture.source,header:h,builder,prepared:0,total:h.entries.filter(e=>e.kind==='file').length};stages.set(id,stage);return stageInfo(stage);
    },
    async pump(stageId){
      const stage=liveStage(stageId);if(stage.generation)return stageInfo(stage);const builder=stage.builder!;try{rust(()=>builder.beginPump());
      const pending=json<EntryState[]>(rust(()=>builder.pendingJson()));let sourceBytes=0;
      for(const entry of pending){
        const source=await run<{entry:EntryState;presentation:BrowserVaultPresentation;bytes?:Uint8Array}>('readonly',['control','metadata','presentation','content','sync_materialization_refs'],(tx,done,abort)=>{
          readCatalog(tx,c=>sourceFence(tx,stage.header,c,stage.capture,()=>{
            on(tx.objectStore('metadata').get(entry.id),row=>{if(!equal(row,entry))throw fail('index_source_changed');on(tx.objectStore('presentation').get(entry.id),presentation=>{
              if(!presentation||presentation.id!==entry.id||![presentation.ctime_ms,presentation.mtime_ms,presentation.size_bytes].every(n=>Number.isSafeInteger(n)&&n>=0))throw fail('storage_corrupt');
              on(tx.objectStore('content').get(entry.id),content=>{if(content!==undefined&&(!(content.bytes instanceof Uint8Array)||content.bytes.length!==presentation.size_bytes))throw fail('storage_corrupt');const mode=stage.capture.descriptors.find(d=>d.id===entry.id)?.content?.kind;if(mode==='text'&&!content||mode==='binary'&&content)throw fail('storage_corrupt');done({entry,presentation,...(mode==='text'?{bytes:content.bytes}:{})});},abort);
            },abort);},abort);
          },abort),abort);
        });
        const bytes=source.bytes,sourceDescriptor=stage.capture.descriptors.find(d=>d.id===entry.id)?.content;
        if(bytes){const metadata=sourceDescriptor?.metadata;
          if(metadata?.byte_length!==String(bytes.length)||metadata.witness?.identity?.entry_id!==entry.id||metadata.witness?.revision!==entry.revision||!Array.isArray(metadata.digest)||metadata.digest.length!==32||!metadata.digest.every((n:unknown)=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=255)||hex(new Uint8Array(metadata.digest))!==await byteDigest(bytes))throw fail('storage_corrupt');
        }
        if(sourceBytes>0&&bytes&&sourceBytes+bytes.length>1024*1024)break;
        try{
          // Unchanged witnesses and presentation reuse validated Rust facts and
          // the old immutable projection. A move receives a new witness/parse.
          let reused=false;
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
        },abort),abort));stage.prepared++;sourceBytes+=bytes?.length??0;
      }
      if(rust(()=>builder.ready())){stage.generation=rust(()=>builder.finish());builder.free();stage.builder=undefined;}
      return stageInfo(stage);
      }catch(error){stage.failed=true;throw error;}
    },
    async publish(stageId){const stage=liveStage(stageId);if(!stage.generation)throw fail('index_not_ready');
      const snapshot=json<BrowserIndexSnapshot>(rust(()=>stage.generation!.snapshotJson()));
      await run<void>('readwrite',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>sourceFence(tx,stage.header,c,stage.capture,()=>{
        const d=c.generations.find(g=>g.id===stage.id);if(!d||d.state!=='staging'||d.rows!==stage.total)throw fail('index_rebuild_required');d.state='published';c.head=stage.id;putCatalog(tx,c);done();
      },abort),abort));stage.generation.free();stages.delete(stageId);await prune();return snapshot;
    },
    async open(){
      await recover();const pinId=crypto.randomUUID();const captured=await run<{id:string;header:string;digest:string;snapshot:BrowserIndexSnapshot}>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
        const g=c.generations.find(g=>g.id===c.head&&g.state==='published');if(!g)throw fail('index_not_ready');if(c.pins.length>=LIMITS.pins)throw fail('index_pin_limit');
        on(tx.objectStore('control').get(headerKey(g.id)),row=>{if(typeof row?.value!=='string'||size(row.value)>3*LIMITS.header)throw fail('index_rebuild_required');c.pins.push({id:pinId,clientId:host.clientId,generation:g.id});putCatalog(tx,c);done({id:g.id,header:row.value,digest:row.digest,snapshot:g.snapshot});},abort);
      },abort));
      if(captured.digest!==await digest(captured.header)){await api.closePin(pinId);throw fail('index_rebuild_required');}
      let builder:Builder|undefined;
      try{const stored=json<StoredHeader>(captured.header,3*LIMITS.header),h=checkedHeader(stored.rust);builder=rust(()=>new host.wasm.WasmDocumentIndexBuilder(stored.rust));let count=0;for(const entry of h.entries){if(entry.kind!=='file')continue;if(count++%32===0)rust(()=>builder!.beginPump());const row=await readRow(captured.id,entry);rust(()=>builder!.addPersisted(entry.id,row.record));}
        const generation=rust(()=>builder!.finish());pins.set(pinId,{generation:captured.id,value:generation});return {pinId,snapshot:captured.snapshot};
      }catch(error){await api.closePin(pinId);throw error;}finally{builder?.free();}
    },
    async closePin(pinId){active();pins.get(pinId)?.value.free();pins.delete(pinId);await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.id!==pinId||p.clientId!==host.clientId);putCatalog(tx,c);done();},abort));},
    async search(input){const g=await assertPin(input.pinId),pin=pins.get(input.pinId)!;const page=rust(()=>g.openLiteral(input.query,input.token??'',input.limit??100));try{
      for(;;){const entry=json<EntryState|null>(rust(()=>page.nextReadJson()));if(!entry)break;const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_rebuild_required');rust(()=>page.accept(row.projection!));}
      await assertPin(input.pinId);return json<unknown>(rust(()=>page.finishJson()));
    }finally{page.free();}},
    async resolve(input){const g=await assertPin(input.pinId);return json<unknown>(rust(()=>g.resolveJson(input.sourceId,input.destination)));},
    async backlinks(input){const g=await assertPin(input.pinId);return json<unknown>(rust(()=>g.backlinksJson(input.targetId,input.token??'',input.limit??100)));},
    async rebuild(){active();for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();for(const pin of pins.values())pin.value.free();pins.clear();
      // Explicit rebuild expires every old pin; fresh epochs prevent token ABA.
      recovery=undefined;const nonce=crypto.randomUUID();await run<void>('readwrite',['control'],(tx,done)=>{putCatalog(tx,{...empty(),rebuilding:nonce});done();});
      await cleanupPrefix(PREFIX+'g/');
      await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(c.rebuilding===nonce)putCatalog(tx,empty());done();},abort));
    },
    async close(){if(closed)return;for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();for(const pin of pins.values())pin.value.free();pins.clear();
      try{await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.clientId!==host.clientId);putCatalog(tx,c);done();},abort));}catch{/* Cache cleanup never blocks source close. Explicit rebuild repairs derived state. */}finally{closed=true;}
    },
  };return api;
}
