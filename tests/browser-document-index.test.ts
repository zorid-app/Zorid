import {BrowserVaultError} from '../src/core/browser-vault.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {browserDocumentIndex,createBrowserDocumentIndexBackend} from '../src/core/browser-document-index.ts';
import type {BrowserDocumentIndexWasm,BrowserIndexHeader} from '../src/core/browser-document-index.ts';
import type {EntryState} from '../src/core/browser-vault.ts';

const authority='11111111-1111-4111-8111-111111111111';
const clone=<T>(v:T):T=>structuredClone(v);
const sha=(bytes:Uint8Array)=>[...createHash('sha256').update(bytes).digest()];
const range=(globalThis as any).IDBKeyRange;
(globalThis as any).IDBKeyRange={bound:(lower:string,upper:string)=>({lower,upper})};
/** Transaction/opaque-WASM doubles test host storage and transport only. No JS
 * parser, resolver or query evaluator stands in for Rust corpus parity. */
function fixture(options:{cacheRows?:number;cacheBytes?:number;cacheRowBytes?:number;evictions?:number;pauseCacheBindOnce?:boolean;richRead?:boolean;richCompile?:boolean;richInvalidPage?:boolean;metadataRows?:boolean;metadataDelta?:boolean;propertyTargets?:boolean;preview?:boolean}={}){
  const records=new Map<string,Map<string,any>>(['control','metadata','presentation','content','sync_materialization_refs',...(options.preview?['sync_state']:[])].map(n=>[n,new Map()]));
  const seed=(store:string,key:string,value:any)=>records.get(store)!.set(key,clone(value));
  seed('control','local-store-id',{key:'local-store-id',value:authority});seed('control','sequence',{key:'sequence',value:'0'});
  if(options.preview){seed('sync_state','config',{key:'config',value:{realm_id:'realm',vault_id:'vault',key_epoch:1,replica_id:'replica',incarnation_id:'incarnation'}});seed('sync_state','metadata-head',{key:'metadata-head',value:{scope:{realm_id:'realm',vault_id:'vault'},version:'head1',counts:{records:0,activities:0}}});}
  const calls:{store:string;op:string;key?:any}[]=[],transactions:string[][]=[];let failCommit=false,denied=false,fatal=false,cacheReadUnavailable=false;let afterRead:((store:string,key:any)=>void)|undefined,afterCommit:(()=>void)|undefined;
  const db:any={transaction(names:string[],mode:string,options:any){
    if(mode==='readwrite')assert.deepEqual(options,{durability:'strict'});transactions.push(names);
    const local=new Map(names.map(n=>[n,clone(records.get(n)!)])),writes=new Set<string>();let pending=0,aborted=false,completed=false,scheduled=false;
    const tx:any={durability:'strict',abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
      objectStore(name:string){assert.ok(local.has(name));
        const request=(op:string,key:any,action:()=>any)=>{const result:any={};calls.push({store:name,op,key});pending++;
          queueMicrotask(()=>{if(aborted)return;try{if(cacheReadUnavailable&&name==='control'&&op==='get'&&String(key).startsWith('document-parse-cache:v1/row/')){cacheReadUnavailable=false;throw new DOMException('fixture optional cache unavailable','UnknownError');}result.result=clone(action());if(op==='get')afterRead?.(name,key);result.onsuccess?.();}catch{tx.abort();}finally{pending--;schedule();}});return result;};
        const put=(row:any,add:boolean)=>request(add?'add':'put',row.key??row.id,()=>{assert.equal(mode,'readwrite');const key=row.key??row.id;if(add&&local.get(name)!.has(key))throw new Error('duplicate');local.get(name)!.set(key,clone(row));writes.add(name);return key;});
        return {getKey:(key:string)=>request('getKey',key,()=>local.get(name)!.has(key)?key:undefined),get:(key:string)=>request('get',key,()=>local.get(name)!.get(key)),put:(row:any)=>put(row,false),add:(row:any)=>put(row,true),
          getAll(){assert.fail('aggregate source/control scan is forbidden');},
          delete:(key:string)=>request('delete',key,()=>{local.get(name)!.delete(key);writes.add(name);}),
          openKeyCursor(bounds?:any){return this.openCursor(bounds);},
          openCursor(bounds?:any){if(name==='control')assert.ok(['document-index:v1/g/','document-parse-cache:v1/row/','document-parse-cache:v1/oldest/'].some(prefix=>bounds?.lower?.startsWith(prefix)),'control cursor must have an exact derived prefix');
            calls.push({store:name,op:'cursor',key:bounds});const result:any={};pending++;let rows:[string,any][]|undefined,pos=0;
            // A cursor request executes after prior queued delete/put requests.
            // Taking its rows at request creation observes pre-delete FIFO state.
            const step=()=>{if(aborted)return;rows??=[...local.get(name)!].filter(([key])=>!bounds||key>=bounds.lower&&key<=bounds.upper).sort(([a],[b])=>a<b?-1:1);let continued=false;const row=rows[pos];result.result=row?{primaryKey:row[0],value:clone(row[1]),continue(){continued=true;pos++;queueMicrotask(step);},delete(){return request('delete',row[0],()=>{local.get(name)!.delete(row[0]);writes.add(name);});}}:null;
              try{result.onsuccess?.();}catch{tx.abort();}finally{if(!continued){pending--;schedule();}}};queueMicrotask(step);return result;
          },
        };
      },
    };
    function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(aborted||completed||pending)return;if(failCommit&&mode==='readwrite'){failCommit=false;tx.abort();return;}completed=true;for(const n of writes)records.set(n,local.get(n)!);if(mode==='readwrite')afterCommit?.();tx.oncomplete?.();});}schedule();return tx;
  }};
  let textExtractions=0,reuses=0,cacheBinds=0,pauseCacheBindOnce=!!options.pauseCacheBindOnce;const taskCalls:{sources:{id:string;source:string}[];options:any;snapshot:unknown}[]= [];
  const propertyTargetCalls:{facts:any[];options:any}[]=[];
  const baseCalls:{id:string;text:string;facts:any[];options:any;viewName?:string|null}[]=[];
  const preparationCalls:{monotonicMs:number;generation:unknown}[]=[],preparationStats={created:0,freed:0,cleared:0};let afterBase:(()=>void)|undefined;
  class MockBuilder {
    preview:any;freed=false;
    configurePreview(owner:MockPreviewOwner,nonce:string,stageId:string){this.preview={owner,nonce,stageId,receipts:new Set<string>()};}
    commitPreviewRowsJson(raw:string){if(previewResource)throw JSON.stringify({code:'index_preview_resource'});for(const row of JSON.parse(raw)){assert.deepEqual(row.entry,this.header.entries.find(entry=>entry.id===row.entry.id));assert.ok(this.rows.has(row.entry.id));assert.equal(this.preview.receipts.has(row.entry.id),false);this.preview.receipts.add(row.entry.id);previewStats.receipts++;}}
    capturePreview(){if(this.freed){previewStats.freedBuilderTouches++;throw new Error('freed generated builder');}const p=this.preview;if(!p)return;assert.equal(p.receipts.size,this.rows.size);p.owner.retireStage(p.stageId);const capture={alive:true,owner:p.owner,stage:p.stageId,nonce:p.nonce,serial:String(++previewStats.serial),header:this.header,rows:new Map(this.rows)};p.owner.latest=capture;previewStats.captures++;afterPreviewCapture?.();return new MockPreviewValue(capture);}
    retirePreview(){if(this.preview)this.preview.owner.retireStage(this.preview.stageId);}
    header:BrowserIndexHeader;rows=new Map<string,any>();constructor(input:string){this.header=JSON.parse(input);this.header.entries=this.header.entries.map(({id,path,kind,revision,deleted})=>({id,path,kind,revision,deleted}));}
    free(){this.freed=true;}headerJson(){return JSON.stringify(this.header);}beginPump(){}
    pendingJson(){return JSON.stringify(this.header.entries.filter(e=>e.kind==='file'&&!this.rows.has(e.id)).slice(0,32));}
    addText(id:string,bytes:Uint8Array){textExtractions++;this.rows.set(id,{metadata:null,digest:sha(bytes),textBytes:bytes.length,exclusion:null});}
    cacheKeyJson(id:string,bytes:Uint8Array){if(bytes.includes(0))return 'null';const entry=this.header.entries.find(e=>e.id===id)!,key={scope:this.header.source.localStoreId,mode:entry.path.toLowerCase().endsWith('.md')?'markdown':'plainText',digest:sha(bytes),bytes:bytes.length};return JSON.stringify({key,storageKey:createHash('sha256').update(JSON.stringify(key)).digest('hex')});}
    extractText(id:string,bytes:Uint8Array){this.addText(id,bytes);const {key}=JSON.parse(this.cacheKeyJson(id,bytes));const record=this.rows.get(id),factsChecksum=createHash('sha256').update(JSON.stringify({key,record})).digest('hex');return JSON.stringify({added:true,payload:JSON.stringify({fixtureVersion:1,key,record,factsChecksum})});}
    addCachedText(id:string,expected:string,payload:string){let value;try{value=JSON.parse(payload);}catch{return JSON.stringify({outcome:'corrupt',added:false});}if(value.fixtureVersion!==1)return JSON.stringify({outcome:'unsupported',added:false});const {key}=JSON.parse(expected);if(JSON.stringify(value.key)!==JSON.stringify(key)||value.factsChecksum!==createHash('sha256').update(JSON.stringify({key:value.key,record:value.record})).digest('hex'))return JSON.stringify({outcome:'corrupt',added:false});if(pauseCacheBindOnce){pauseCacheBindOnce=false;return JSON.stringify({outcome:'hit',added:false});}cacheBinds++;this.rows.set(id,clone(value.record));return JSON.stringify({outcome:'hit',added:true});}
    addBinary(id:string){this.rows.set(id,{metadata:null,digest:null,textBytes:0,exclusion:'binary'});}
    addUnreadable(id:string){this.rows.set(id,{metadata:null,digest:null,textBytes:0,exclusion:'unreadable'});}
    addPersisted(id:string,row:string){reuses++;this.rows.set(id,JSON.parse(row));}
    rowJson(id:string){return JSON.stringify(this.rows.get(id));}ready(){if(this.freed){previewStats.freedBuilderTouches++;throw new Error('freed generated builder');}return this.header.entries.filter(e=>e.kind==='file').length===this.rows.size;}
    finish(){const header=this.header,rows=this.rows;assert.ok(this.ready());return {
      free(){},headerJson:()=>JSON.stringify(header),snapshotJson:()=>JSON.stringify(header.nextIndex),coverageComplete:()=>{metadataStats.coverageReads++;return true;},rowJson:(id:string)=>JSON.stringify(rows.get(id)),
      metadataJson:(id:string)=>JSON.stringify({fixture:'opaque-metadata-transport',id,snapshot:header.nextIndex}),
      tasksJson:(sources:string,options:string)=>{const captured=JSON.parse(sources);for(const source of captured)assert.deepEqual(sha(new TextEncoder().encode(source.source)),rows.get(source.id).digest);taskCalls.push({sources:captured,options:JSON.parse(options),snapshot:header.nextIndex});return JSON.stringify({fixture:'opaque-tasks-transport',snapshot:header.nextIndex});},
      baseJson:(id:string,bytes:Uint8Array,facts:string,options:string,viewName?:string|null)=>{assert.deepEqual(sha(bytes),rows.get(id).digest);baseCalls.push({id,text:new TextDecoder().decode(bytes),facts:JSON.parse(facts),options:JSON.parse(options),viewName});return JSON.stringify({fixture:'opaque-base-transport',snapshot:header.nextIndex});},
      ...(options.propertyTargets?{propertyTargetsJson:(facts:string,raw:string)=>{const selected=JSON.parse(raw),source=selected.propertyDefinitionsSource;if(source)assert.deepEqual(sha(new TextEncoder().encode(source.source)),rows.get(source.id).digest);propertyTargetCalls.push({facts:JSON.parse(facts),options:selected});return JSON.stringify({fixture:'opaque-property-targets',snapshot:header.nextIndex});}}:{}),
      resolveJson:()=>'{"fixture":"opaque-rust-transport"}',backlinksJson:()=>'{"fixture":"opaque-rust-transport"}',
      openLiteral(query:string,token:string){if(query==='fixture-page')assert.ok(token===''||token==='1');let position=0;const observed:string[]=[];const files=header.entries.filter(e=>e.kind==='file'&&rows.get(e.id)?.digest);return {
        free(){},nextReadJson:()=>JSON.stringify(files[position]??null),accept(bytes:Uint8Array){assert.deepEqual(sha(bytes),rows.get(files[position]!.id).digest);observed.push(new TextDecoder().decode(bytes));position++;},finishJson:()=>JSON.stringify({fixture:'projection-transport',observed,snapshot:header.nextIndex,...(query==='fixture-page'?{next:'1'}:{})}),
      };},
    };}
  }
  class MockPreparationCache {
    constructor(){preparationStats.created++;}
    clear(){preparationStats.cleared++;}
    free(){preparationStats.freed++;}
    baseJson(generation:any,id:string,bytes:Uint8Array,facts:string,options:string,monotonicMs:number,viewName?:string|null){
      assert.ok(Number.isSafeInteger(monotonicMs)&&monotonicMs>=0);preparationCalls.push({monotonicMs,generation});
      const result=generation.baseJson(id,bytes,facts,options,viewName);afterBase?.();return result;
    }
  }
  // This double chooses read/output shapes, never evaluates a query. Real
  // matching/count/sort/snippet semantics remain in the Rust hosted/client gates.
  const richCalls:{spec:any;facts:any[];header:any}[]=[],richStats={created:0,cleared:0,freed:0,closed:0,drivesFreed:0,preparedFreed:0,accepted:0};let afterRichCommit:(()=>void)|undefined;
  class MockRichOwner {
    queries=new Map<string,any>();serial=0;
    constructor(nonce:string){assert.ok(nonce);richStats.created++;}
    clear(){richStats.cleared++;this.queries.clear();}
    free(){richStats.freed++;}
    startQuery(generation:any,specJson:string,factsJson:string){const spec=JSON.parse(specJson),facts=JSON.parse(factsJson),header=JSON.parse(generation.headerJson());richCalls.push({spec,facts,header});
      // Mirror the real binding's identity/order guard with an independent UTF8 oracle.
      const canonical=header.entries.filter((entry:any)=>entry.kind==='file').sort((a:any,b:any)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))||Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
      assert.deepEqual(facts.map((fact:any)=>[fact.entryId,fact.revision]),canonical.map((entry:any)=>[entry.id,entry.revision]));
      if(options.richCompile)throw JSON.stringify({code:'search_compile',diagnostic:{code:'invalid-operand',queryRange:{bytes:[0,1],utf16:[0,1]},message:'Expected operand'}});
      const id='q'+(++this.serial);this.queries.set(id,{generation,header,spec});return id;}
    prepareJson(query:string){if(!this.queries.has(query))throw JSON.stringify({code:'search_expired'});return JSON.stringify({state:'ready',cursor:'c'+query});}
    closeQuery(query:string){richStats.closed++;this.queries.delete(query);}
    openDrive(query:string,cursor:string){const q=this.queries.get(query);if(!q||cursor!=='c'+query)throw JSON.stringify({code:'search_expired'});let position=0;const reads=options.richRead?q.header.entries.filter((e:any)=>e.kind==='file'&&JSON.parse(q.generation.rowJson(e.id)).digest):[];
      return {free(){richStats.drivesFreed++;},nextActionJson:()=>{const entry=reads[position];return JSON.stringify(entry?{kind:'readText',snapshot:q.header.nextIndex,entry,digest:JSON.parse(q.generation.rowJson(entry.id)).digest,bytes:JSON.parse(q.generation.rowJson(entry.id)).textBytes}:{kind:'done'});},
        accept(bytes:Uint8Array){if(JSON.stringify(sha(bytes))!==JSON.stringify(JSON.parse(q.generation.rowJson(reads[position].id)).digest))throw JSON.stringify({code:'index_source_changed'});richStats.accepted++;position++;},
        finish(){return {query,q,free(){richStats.preparedFreed++;}};},
      };}
    commitJson(prepared:any){const q=prepared.q,header=q.header,count=header.entries.filter((e:any)=>e.kind==='file').length;
      const page={result:{snapshot:header.nextIndex,source:header.source,coverageComplete:true,value:{snapshot:header.nextIndex,next:null,scanComplete:true,coverageComplete:true,complete:true,dialect:'zorid-search-rust-unicode-1',spec:q.spec,explanation:null,files:[],totals:{files:{relation:'exact',value:0},occurrences:{relation:'exact',value:0}},coverage:{candidateFiles:count,evaluatedFiles:count,unavailableFiles:0,scanComplete:true,queryCoverageComplete:true},outputComplete:true,work:{documents:count,sourceBytes:0,units:1}}},cursor:null};
      if(options.richInvalidPage)(page.result.value as any).unknown=true;afterRichCommit?.();return JSON.stringify(page);}
  }
  // Opaque checkpoint/transport double only. It does not parse source or select
  // real reset/delta changes; the shared Rust pager has its own corpus gates.
  const metadataStats={created:0,freed:0,retired:0,pages:0,live:0,coverageReads:0};let metadataInvalid=false,metadataThrow=false,afterMetadataPage:(()=>void)|undefined;
  class MockMetadataScan {
    header:any;origin={};ordinal=0;retirement={value:false};freed=false;baseline:any=null;limit:number;
    constructor(destination:any,limit:number){this.header=JSON.parse(destination.headerJson());this.limit=limit;metadataStats.created++;metadataStats.live++;}
    static withBaseline(destination:any,baseline:any,limit:number){const scan=new MockMetadataScan(destination,limit);if(options.metadataDelta)scan.baseline=JSON.parse(baseline.headerJson()).nextIndex;return scan;}
    live(){assert.equal(this.freed,false);if(this.retirement.value)throw JSON.stringify({code:'index_snapshot_expired'});}
    fork(){this.live();const next=new MockMetadataScan({headerJson:()=>JSON.stringify(this.header)},this.limit);next.origin=this.origin;next.ordinal=this.ordinal;next.retirement=this.retirement;next.baseline=this.baseline;return next;}
    sameCheckpoint(other:MockMetadataScan){this.live();other.live();return this.origin===other.origin&&this.ordinal===other.ordinal;}
    isNextCheckpointOf(other:MockMetadataScan){this.live();other.live();return this.origin===other.origin&&this.ordinal===other.ordinal+1;}
    usesBaseline(){this.live();return this.baseline!==null;}
    pageJson(cursor:string){this.live();metadataStats.pages++;if(metadataThrow){metadataThrow=false;throw JSON.stringify({code:'index_output_limit'});}const rows=this.header.entries.slice(this.ordinal*this.limit,(this.ordinal+1)*this.limit).map((entry:any)=>entry.kind==='folder'?{kind:'folder',entry}:{kind:'file',value:{entry,metadata:null,exclusion:null}}),scanComplete=(this.ordinal+1)*this.limit>=this.header.entries.length;
      const value:any={snapshot:this.header.nextIndex,next:null,scanComplete,coverageComplete:true,complete:scanComplete,mode:this.baseline?'delta':'reset',from:this.baseline,rows,removedEntryIds:[]};if(metadataInvalid)value.unknown=true;
      const encoded=JSON.stringify({result:{snapshot:this.header.nextIndex,source:this.header.source,coverageComplete:true,value},cursor:scanComplete?null:cursor});this.ordinal++;afterMetadataPage?.();return encoded;
    }
    retire(){assert.equal(this.freed,false);metadataStats.retired++;this.retirement.value=true;}
    free(){assert.equal(this.freed,false);this.freed=true;metadataStats.freed++;metadataStats.live--;}
  }
  const previewStats={receipts:0,captures:0,serial:0,queries:0,queryFreed:0,replies:0,replyFreed:0,freedBuilderTouches:0};let previewResource=false,afterPreviewCapture:(()=>void)|undefined;
  class MockPreviewOwner {latest:any;constructor(_client:string,_nonce:string){}clear(){if(this.latest)this.latest.alive=false;this.latest=undefined;}retireStage(id:string){if(this.latest?.stage===id)this.clear();}free(){this.clear();}}
  class MockPreviewValue {freed=false;readonly capture:any;constructor(capture:any){this.capture=capture;}free(){this.freed=true;}sameCapture(other:MockPreviewValue){return !this.freed&&!other.freed&&this.capture.alive&&other.capture.alive&&this.capture===other.capture;}descriptorJson(){const c=this.capture;return JSON.stringify({capture:{ownerNonce:c.nonce,stageId:c.stage,serial:c.serial},source:c.header.source,progress:{preparedFiles:c.rows.size,totalFiles:c.header.entries.filter((entry:any)=>entry.kind==='file').length,pendingFiles:c.header.entries.filter((entry:any)=>entry.kind==='file').length-c.rows.size}});}beginBase(raw:string){assert.ok(this.sameCapture(this));const input=JSON.parse(raw);return new MockPreviewQuery(this.capture,input);}}
  class MockPreviewQuery {readonly capture:any;readonly input:any;constructor(capture:any,input:any){this.capture=capture;this.input=input;previewStats.queries++;}descriptorJson(){const definition=this.capture.header.entries.find((entry:any)=>entry.id===this.input.id);if(!definition||!this.capture.rows.has(definition.id))throw JSON.stringify({code:'index_source_unavailable'});return JSON.stringify({definition,sourceBytes:this.capture.rows.get(definition.id).textBytes});}prepareBase(bytes:Uint8Array){assert.equal(this.capture.alive,true);assert.deepEqual(sha(bytes),this.capture.rows.get(this.input.id).digest);return new MockPreviewReply();}cancel(){}free(){previewStats.queryFreed++;}}
  class MockPreviewReply {constructor(){previewStats.replies++;}encodedLength(){return 1;}writeInto(bytes:Uint8Array){bytes[0]=17;}free(){previewStats.replyFreed++;}}
  const policy={formatVersion:1,maxRows:options.cacheRows??100000,maxBytes:options.cacheBytes??64*1024*1024,maxRowBytes:options.cacheRowBytes??1024*1024,maxEvictionsPerWrite:options.evictions??32};
  const wasm={...(options.propertyTargets?{WasmDocumentIndexGeneration:{prototype:{propertyTargetsJson(){}}}}:{}),documentParseCachePolicyJson:()=>JSON.stringify(policy),documentParseCacheAdmissionJson:(input:string)=>{const {usage,replacedPayloadBytes:replaced,incomingPayloadBytes:incoming,evictedRows:evicted}=JSON.parse(input),rows=usage.rows-(replaced===null?0:1)+1,bytes=usage.bytes-(replaced??0)+incoming;return JSON.stringify(incoming>policy.maxRowBytes?'skipOversized':rows<=policy.maxRows&&bytes<=policy.maxBytes?'write':evicted===policy.maxEvictionsPerWrite?'skipEvictionLimit':'evictOldest');},documentIndexVersionsJson:()=>'{"schema":1,"extraction":"fixture","resolver":"fixture","query":"fixture"}',WasmDocumentIndexBuilder:MockBuilder,WasmDocumentIndexPreparationCache:MockPreparationCache,WasmDocumentRichSearchOwner:MockRichOwner} as unknown as BrowserDocumentIndexWasm;
  // This double exposes reservation inputs/outputs for transaction assertions.
  // Arithmetic and actual WASM wire semantics have independent Rust gates.
  const allocationCalls:any[]=[];wasm.documentIndexAllocateJson=(input:string)=>{const clock=JSON.parse(input);allocationCalls.push(clone(clock));if(clock.allocated==='18446744073709551615')throw JSON.stringify({code:'index_rebuild_required'});return JSON.stringify({localStoreId:clock.localStoreId,generationEpoch:clock.generationEpoch,generation:String(BigInt(clock.allocated)+1n),versions:JSON.parse(wasm.documentIndexVersionsJson())});};
  if(options.metadataRows)wasm.WasmDocumentMetadataRowsScan=MockMetadataScan;
  if(options.preview)Object.assign(wasm,{WasmDocumentPreviewOwner:MockPreviewOwner,WasmDocumentPreview:MockPreviewValue,WasmDocumentPreviewQuery:MockPreviewQuery,WasmDocumentPreviewReply:MockPreviewReply});
  const backend=(clientId='client-a')=>createBrowserDocumentIndexBackend({db,authorityId:authority,clientId,wasm,assertActive(){if(fatal)throw new BrowserVaultError('storage_closed','fatal host close');if(denied)throw Object.assign(new Error('retired'),{code:'owner_retired'});},
    readPublication(tx,done,abort){let entries:any[]|undefined,presentation:any[]|undefined,sequence:string|undefined;
      const finish=()=>{if(entries&&presentation&&sequence!==undefined)done({entries,presentation,sequence});};
      for(const store of ['metadata','presentation']){const list:any[]=[];const request=tx.objectStore(store).openCursor();request.onsuccess=()=>{try{const cursor=request.result;if(cursor){list.push(cursor.value);cursor.continue();}else{if(store==='metadata')entries=list;else presentation=list;finish();}}catch(error){abort(error);}};}
      const request=tx.objectStore('control').get('sequence');request.onsuccess=()=>{sequence=request.result.value;finish();};
    },
  });
  const open=(clientId='client-a')=>backend(clientId).index;
  function file(id:string,text:string,opts:{path?:string;revision?:string;binary?:boolean;mtime?:number}={}){
    const bytes=new TextEncoder().encode(text),entry:EntryState={id,path:opts.path??id+'.md',kind:'file',revision:opts.revision??'r1',deleted:false},presentation={id,ctime_ms:1,mtime_ms:opts.mtime??1,size_bytes:bytes.length};
    seed('metadata',id,entry);seed('presentation',id,presentation);
    const content=opts.binary?{kind:'binary',reference:{selected_event:'binary1',manifest:{bytes:String(bytes.length)}}}:{kind:'text',metadata:{byte_length:String(bytes.length),digest:sha(bytes),witness:{identity:{entry_id:id},revision:entry.revision}}};
    seed('sync_materialization_refs',id,{id,status:'normal',entry,presentation,content});if(opts.binary)records.get('content')!.delete(id);else seed('content',id,{id,bytes});
  }
  const source=()=>clone(new Map([...records].filter(([n])=>n!=='control').map(([n,m])=>[n,m])));
  const build=async(index:ReturnType<typeof open>)=>{let stage=await index.begin();do{stage=await index.pump(stage.stageId);}while(!stage.ready);return index.publish(stage.stageId);};
  const descriptor=(snapshot:{generationEpoch:string;generation:string})=>records.get('control')!.get('document-index:v1/catalog').value.generations.find((g:any)=>g.snapshot.generationEpoch===snapshot.generationEpoch&&g.snapshot.generation===snapshot.generation);
  return {records,calls,transactions,file,open,backend,wasm,build,source,seed,descriptor,allocationCalls,previewStats,afterPreviewCapture(action:()=>void){afterPreviewCapture=action;},previewResource(value:boolean){previewResource=value;},metadataStats,metadataInvalid(value:boolean){metadataInvalid=value;},metadataThrow(){metadataThrow=true;},afterMetadataPage(action?:()=>void){afterMetadataPage=action;},richCalls,richStats,afterRichCommit(action:()=>void){afterRichCommit=action;},baseCalls,propertyTargetCalls,taskCalls,preparationCalls,preparationStats,afterBase(action:()=>void){afterBase=action;},stats:()=>({textExtractions,reuses,cacheBinds}),sequence(value:string){seed('control','sequence',{key:'sequence',value});},delete(id:string){for(const store of ['metadata','presentation','content','sync_materialization_refs'])records.get(store)!.delete(id);},fail(){failCommit=true;},cacheUnavailable(){cacheReadUnavailable=true;},deny(){denied=true;},allow(){denied=false;},fatal(){fatal=true;},afterCommit(action?:()=>void){afterCommit=action;},afterRead(action:(store:string,key:any)=>void){afterRead=action;}};
}

test('strict derived publication retains source bytes and uses no aggregate control scan',async()=>{
  const f=fixture();f.file('a','hello');const source=f.source(),index=f.open();await f.build(index);
  const status=await index.status();assert.equal(status.current,true);assert.equal(status.coveredWatermark,'0');assert.equal(status.rebuildRequired,false);assert.deepEqual(f.source(),source);
  const pin=await index.open();const page=await index.search({pinId:pin.pinId,query:'opaque'}) as any;assert.deepEqual(page.result.value.observed,['hello']);assert.deepEqual(page.result.snapshot,pin.snapshot);assert.equal(page.cursor,null);
  assert.ok(f.transactions.every(names=>names.includes('control')));await index.close();
});
test('old pinned generation reads retained projection across edit, move and delete',async()=>{
  const f=fixture();f.file('a','old');const index=f.open();await f.build(index);const old=await index.open();
  f.file('a','new',{path:'moved.md',revision:'r2'});f.sequence('1');await f.build(index);const fresh=await index.open();
  f.delete('a');f.sequence('2');await f.build(index);
  assert.deepEqual((await index.search({pinId:old.pinId,query:'opaque'}) as any).result.value.observed,['old']);assert.deepEqual((await index.search({pinId:fresh.pinId,query:'opaque'}) as any).result.value.observed,['new']);
  assert.equal((await index.status()).current,true);await index.close();
});
test('source and canonical Rust entry DTO key order does not change the retained witness',async()=>{
  const f=fixture();f.file('a','text');const prior=f.records.get('metadata')!.get('a'),entry={id:prior.id,path:prior.path,kind:prior.kind,deleted:prior.deleted,revision:prior.revision};
  f.seed('metadata','a',entry);f.seed('sync_materialization_refs','a',{...f.records.get('sync_materialization_refs')!.get('a'),entry});
  const index=f.open(),source=f.source();const snapshot=await f.build(index);assert.equal((await index.status()).current,true);const pin=await index.open();
  assert.deepEqual((await index.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['text']);assert.deepEqual(pin.snapshot,snapshot);assert.deepEqual(f.source(),source);await index.close();
});

test('presentation-only change with unchanged local watermark rejects publication',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();const stage=await index.begin();await index.pump(stage.stageId);
  f.file('a','text',{mtime:7});await assert.rejects(index.publish(stage.stageId),{code:'index_source_changed'});assert.equal((await index.status()).snapshot,null);await index.close();
});
test('two independently prepared publishers CAS the same index head',async()=>{
  const f=fixture();f.file('a','text');const a=f.open(),b=f.open('client-b'),sa=await a.begin(),sb=await b.begin();await a.pump(sa.stageId);await b.pump(sb.stageId);await a.publish(sa.stageId);
  await assert.rejects(b.publish(sb.stageId),{code:'index_head_changed'});await a.close();await b.close();
});
test('authored binary mode stays excluded even for valid UTF8 bytes',async()=>{
  const f=fixture();f.file('a','ordinary UTF8',{binary:true});const index=f.open();await f.build(index);const pin=await index.open();
  assert.equal(f.stats().textExtractions,0);assert.deepEqual((await index.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,[]);await index.close();
});
test('same-entry priority stays distinct from content facts reuse after a move',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);await f.build(index);assert.equal(f.stats().textExtractions,1);assert.equal(f.stats().reuses,1);
  f.file('a','text',{path:'move.md'});await f.build(index);assert.equal(f.stats().textExtractions,1);assert.equal(f.stats().cacheBinds,1);await index.close();
});
test('cache corruption requires explicit rebuild and rebuild expires pins without changing source',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),source=f.source();
  const cache=[...f.records.get('control')!].find(([key])=>key.startsWith('document-index:v1/g/')&&key.includes('/row/'))!;cache[1].value.record='{"metadata":null}';
  await assert.rejects(index.open(),{code:'index_rebuild_required'});await index.rebuild();await assert.rejects(index.search({pinId:pin.pinId,query:'opaque'}),{code:'index_snapshot_expired'});
  assert.deepEqual(f.source(),source);await f.build(index);assert.equal((await index.status()).current,true);await index.close();
});
test('source content digest mismatch fails before Rust extraction',async()=>{
  const f=fixture();f.file('a','text');f.seed('content','a',{id:'a',bytes:new TextEncoder().encode('evil')});const index=f.open(),stage=await index.begin();
  await assert.rejects(index.pump(stage.stageId),{code:'storage_corrupt',details:{invariant:'index_source_text_commitment',entryId:'a',lengthMatches:true,identityMatches:true,revisionMatches:true,digestArray:true}});assert.equal(f.stats().textExtractions,0);await index.close();
});
test('bounded pin limit and cross-client nonce ownership reject fabricated pins',async()=>{
  const f=fixture();f.file('a','text');const a=f.open(),b=f.open('client-b');await f.build(a);const pins=[];for(let i=0;i<4;i++)pins.push(await a.open());
  await assert.rejects(a.open(),{code:'index_pin_limit'});await assert.rejects(b.search({pinId:pins[0]!.pinId,query:'opaque'}),{code:'index_snapshot_expired'});await a.closePin(pins[0]!.pinId);await a.open();await a.close();await b.close();
});
test('corrupt catalog rebuild sweeps only exact derived prefixes',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);f.seed('control','unrelated',{key:'unrelated',value:'preserved'});f.seed('control','document-index:v1/catalog',{key:'document-index:v1/catalog',value:{bad:true}});
  assert.equal((await index.status()).rebuildRequired,true);await index.rebuild();assert.equal(f.records.get('control')!.get('unrelated').value,'preserved');await f.build(index);await index.close();
});

test('a pump processes at most 32 files and aborted staging preserves the previous head',async()=>{
  const f=fixture();for(let i=0;i<40;i++)f.file('f'+String(i).padStart(2,'0'),'body');const index=f.open();let stage=await index.begin();stage=await index.pump(stage.stageId);assert.equal(stage.prepared,32);assert.equal(stage.ready,false);stage=await index.pump(stage.stageId);assert.equal(stage.prepared,40);const snapshot=await index.publish(stage.stageId);
  const next=await index.begin();f.fail();await assert.rejects(index.pump(next.stageId),{code:'storage_failure'});await assert.rejects(index.publish(next.stageId),{code:'index_rebuild_required'});assert.deepEqual((await index.status()).snapshot,snapshot);await index.close();
});
test('restart drops only its own stale pins and stages, retaining the published cache',async()=>{
  const f=fixture();f.file('a','text');const first=f.open();await f.build(first);await first.open();await first.begin();
  // A real worker lifetime lease prevents both instances being active. Here the
  // second fixture stands for a fresh worker after abrupt first-worker loss.
  const second=f.open();const pin=await second.open();assert.deepEqual((await second.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['text']);const stage=await second.begin();assert.ok(stage.stageId);await second.close();
});

test('continuations are bound to the exact random pin nonce',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const a=await index.open(),b=await index.open();const page=await index.search({pinId:a.pinId,query:'fixture-page'}) as any;
  assert.equal(page.cursor,a.pinId+'/1');await index.search({pinId:a.pinId,query:'fixture-page',cursor:page.cursor});
  await assert.rejects(index.search({pinId:b.pinId,query:'fixture-page',cursor:page.cursor}),{code:'index_snapshot_expired'});await index.close();
});

test('discard is idempotent and removes only the owning unpublished stage',async()=>{
  const f=fixture();f.file('a','text');const a=f.open(),b=f.open('client-b');await a.initialize();await a.initialize();const snapshot=await f.build(a),pin=await a.open(),stage=await a.begin();await a.pump(stage.stageId);
  await assert.rejects(b.discard(stage.stageId),{code:'index_stage_expired'});const before=structuredClone(f.records.get('control'));await a.discard(f.descriptor(snapshot).id);assert.deepEqual(f.records.get('control'),before);await assert.rejects(b.discard(f.descriptor(snapshot).id),{code:'index_stage_expired'});
  await a.discard(stage.stageId);await a.discard(stage.stageId);assert.deepEqual((await a.status()).snapshot,snapshot);assert.deepEqual((await a.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['text']);
  const next=await a.begin();assert.ok(next.stageId);await a.discard(next.stageId);await a.close();await b.close();
});
test('empty namespace stage is ready to publish without an extra pump',async()=>{
  const f=fixture(),index=f.open();await index.initialize();const stage=await index.begin();assert.equal(stage.ready,true);assert.equal(stage.progress.total,0);await index.publish(stage.stageId);assert.equal((await index.status()).current,true);await index.close();
});

test('Base transport keeps retained definition and facts and captures one validated operation clock',async()=>{
  const f=fixture();f.file('base','old definition',{path:'Links.base'});const index=f.open();await f.build(index);const pin=await index.open();
  f.file('base','new definition',{path:'Links.base',revision:'r2',mtime:9});const before=Date.now();await index.base({pinId:pin.pinId,id:'base',viewName:'Links'});const after=Date.now();
  assert.equal(f.baseCalls[0]!.text,'old definition');assert.equal(f.baseCalls[0]!.facts[0].witness.revision,'r1');assert.equal(f.baseCalls[0]!.facts[0].mtimeMs,1);assert.ok(f.baseCalls[0]!.options.clockMs>=before&&f.baseCalls[0]!.options.clockMs<=after);assert.equal(f.baseCalls[0]!.options.maxRows,1000);
  await index.base({pinId:pin.pinId,id:'base',options:{clockMs:0,maxRows:0}});assert.equal(f.baseCalls[1]!.options.clockMs,0);assert.equal(f.baseCalls[1]!.options.maxRows,0);
  await index.base({pinId:pin.pinId,id:'base',options:{maxRows:7}});assert.equal(f.baseCalls[2]!.options.maxRows,7);
  for(const options of [{clockMs:NaN},{clockMs:Infinity},{viewIndex:NaN},{maxRows:Infinity}])await assert.rejects(index.base({pinId:pin.pinId,id:'base',options}),{code:'index_invalid_request'});
  assert.equal(f.baseCalls.length,3);await index.close();
});

// The mock observes owner/transport lifetime only; actual reusable preparation,
// source validation, hit classification and TTL are checked in Rust/real WASM.
test('Base preparation owner survives fresh pins but not rebuild or owner close',async()=>{
  const f=fixture();f.file('base','definition',{path:'Links.base'});const index=f.open();await f.build(index);
  assert.equal(f.preparationStats.created,0);const first=await index.open();await index.base({pinId:first.pinId,id:'base',options:{clockMs:0}});
  const source=f.source();await index.closePin(first.pinId);assert.equal(f.preparationStats.freed,0);
  const fresh=await index.open();await index.base({pinId:fresh.pinId,id:'base',options:{clockMs:42},viewName:'Other'});
  assert.equal(f.preparationStats.created,1);assert.equal(f.preparationCalls.length,2);assert.notEqual(f.preparationCalls[0]!.generation,f.preparationCalls[1]!.generation);
  assert.equal(f.baseCalls[1]!.options.clockMs,42);assert.equal(f.baseCalls[1]!.viewName,'Other');assert.deepEqual(f.source(),source);
  await index.rebuild();assert.equal(f.preparationStats.freed,1);await assert.rejects(index.base({pinId:fresh.pinId,id:'base'}),{code:'index_snapshot_expired'});
  await f.build(index);const rebuilt=await index.open();await index.base({pinId:rebuilt.pinId,id:'base'});assert.equal(f.preparationStats.created,2);
  await index.close();await index.close();assert.equal(f.preparationStats.freed,2);assert.deepEqual(f.source(),source);
});
test('Base cache does not replace current pin admission before or after evaluation',async()=>{
  const f=fixture();f.file('base','definition',{path:'Links.base'});const index=f.open();await f.build(index);const pin=await index.open();
  await index.base({pinId:pin.pinId,id:'base'});await index.closePin(pin.pinId);
  await assert.rejects(index.base({pinId:pin.pinId,id:'base'}),{code:'index_snapshot_expired'});assert.equal(f.preparationCalls.length,1);
  const fresh=await index.open();f.afterBase(()=>f.deny());await assert.rejects(index.base({pinId:fresh.pinId,id:'base'}),{code:'owner_retired'});
  assert.equal(f.preparationStats.freed,1);await index.close();assert.equal(f.preparationStats.freed,1);
});
test('close or rebuild during pending Base admission cannot recreate the owner cache',async()=>{
  for(const action of ['close','rebuild'] as const){
    const f=fixture();f.file('base','definition',{path:'Links.base'});const index=f.open();await f.build(index);const pin=await index.open();await index.base({pinId:pin.pinId,id:'base'});
    const source=f.source();let ending:Promise<void>|undefined;
    f.afterRead((store,key)=>{if(!ending&&store==='control'&&key==='document-index:v1/catalog')ending=index[action]();});
    await assert.rejects(index.base({pinId:pin.pinId,id:'base'}),(error:any)=>['index_closed','index_snapshot_expired'].includes(error.code));
    await ending;assert.ok(ending);assert.equal(f.preparationStats.created,1);assert.equal(f.preparationStats.freed,1);assert.equal(f.preparationCalls.length,1);assert.deepEqual(f.source(),source);await index.close();
  }
});
test('Base selectors are captured before asynchronous admission and TTL clock is independent',async()=>{
  const f=fixture();f.file('base','definition',{path:'Links.base'});const index=f.open();await f.build(index);const pin=await index.open();
  const request={pinId:pin.pinId,id:'base',viewName:'Original',options:{clockMs:0,searchTerms:['needle']}};
  f.afterRead((store,key)=>{if(store==='control'){request.pinId='changed';request.id='other';request.viewName='Other';request.options.clockMs=-1;request.options.searchTerms[0]='different';}});
  await index.base(request);assert.equal(f.baseCalls[0]!.id,'base');assert.equal(f.baseCalls[0]!.viewName,'Original');assert.equal(f.baseCalls[0]!.options.clockMs,0);assert.deepEqual(f.baseCalls[0]!.options.searchTerms,['needle']);
  assert.ok(f.preparationCalls[0]!.monotonicMs>=0);assert.equal(f.preparationStats.created,1);await index.close();
});

test('fresh and explicitly rebuilt caches are uninitialized rather than corrupt',async()=>{
  const f=fixture(),index=f.open();let status=await index.status();assert.equal(status.snapshot,null);assert.equal(status.rebuildRequired,false);await index.initialize();status=await index.status();assert.equal(status.rebuildRequired,false);
  await index.rebuild();status=await index.status();assert.equal(status.rebuildRequired,false);assert.equal(status.current,false);await f.build(index);assert.equal((await index.status()).current,true);await index.close();
});

test('normal consumer close retires only its unpublished cache reservations',async()=>{
  const f=fixture();f.file('a','text');const a=f.open(),b=f.open('client-b');await f.build(a);const source=f.source(),stage=await a.begin();await a.pump(stage.stageId);await a.close();
  const status=await b.status();assert.equal(status.current,true);const next=await b.begin();await b.pump(next.stageId);await b.publish(next.stageId);assert.deepEqual(f.source(),source);await b.close();
});

test('own already-published discard validates its exact header before no-op success',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();const snapshot=await f.build(index),pin=await index.open();await index.discard(f.descriptor(snapshot).id);assert.deepEqual((await index.status()).snapshot,snapshot);assert.deepEqual((await index.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['text']);
  const header=f.records.get('control')!.get('document-index:v1/g/'+f.descriptor(snapshot).id+'/header');header.value+=' ';await assert.rejects(index.discard(f.descriptor(snapshot).id),{code:'index_rebuild_required'});await index.close();
});

test('discard of an already-pruning own published locator makes no cache writes',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),foreign=f.open('client-b');const older=await f.build(index),current=await f.build(index),pin=await index.open();
  const control=f.records.get('control')!,catalog=control.get('document-index:v1/catalog');const olderId=f.descriptor(older).id;catalog.value.generations.find((g:any)=>g.id===olderId).state='deleting';control.delete('document-index:v1/g/'+olderId+'/header');
  const before=structuredClone(control);await index.discard(olderId);assert.deepEqual(f.records.get('control'),before);await assert.rejects(foreign.discard(olderId),{code:'index_stage_expired'});
  assert.deepEqual((await index.status()).snapshot,current);assert.deepEqual((await index.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['text']);await foreign.close();await index.close();
});

test.after(()=>{(globalThis as any).IDBKeyRange=range;});


test('Tasks transport reads exact retained Type YAML across edits, moves, deletes and reopen',async()=>{
  const f=fixture(),oldYaml='\ufeffversion: 1\nlabel: 舊 Task\n';f.file('type',oldYaml,{path:'Types/Task.yaml'});f.file('task','task body');
  const index=f.open();await f.build(index);const old=await index.open();
  f.file('type','new YAML',{path:'Moved.yaml',revision:'r2'});f.sequence('1');await f.build(index);const fresh=await index.open();
  f.delete('type');f.sequence('2');await f.build(index);
  await index.tasks({pinId:old.pinId,typeIds:['type'],options:{filter:'today',clockMs:0,timezone:'America/Toronto'}});
  await index.tasks({pinId:fresh.pinId,typeIds:['type']});
  assert.equal(f.taskCalls[0]!.sources[0]!.source,oldYaml,'BOM and Unicode retained losslessly');assert.equal(f.taskCalls[1]!.sources[0]!.source,'new YAML');
  assert.deepEqual(f.taskCalls[0]!.snapshot,old.snapshot);assert.deepEqual(f.taskCalls[0]!.options,{filter:'today',clockMs:0,timezone:'America/Toronto'});
  await index.close();
  const reopened=f.open(),pin=await reopened.open();await assert.rejects(reopened.tasks({pinId:pin.pinId,typeIds:['type']}),{code:'index_missing_source'});
  await reopened.tasks({pinId:pin.pinId,typeIds:[]});assert.deepEqual(f.taskCalls.at(-1)!.sources,[]);await reopened.close();
});
test('Tasks bounds selectors/options/projection bytes and rejects unavailable sources before Rust',async()=>{
  const f=fixture();f.file('type','type');f.file('binary','binary',{binary:true});f.file('large','x'.repeat(256*1024+1));
  const index=f.open();await f.build(index);const pin=await index.open(),before=f.calls.length;
  for(const input of [{typeIds:['type','type']},{typeIds:Array.from({length:129},(_,i)=>'t'+i)},{typeIds:['../Task.yaml']},{typeIds:['type'],options:null},{typeIds:['type'],options:{clockMs:null}},{typeIds:['type'],options:{maxRows:0}},{typeIds:['type'],options:{showDone:'true'}},{typeIds:['type'],options:{configuration:{}}},{typeIds:['type'],options:{timezone:'x'.repeat(129)}}]){
    await assert.rejects(index.tasks({pinId:pin.pinId,...input} as any),{code:'index_invalid_request'});
  }
  assert.equal(f.calls.length,before,'invalid request never reads index storage');
  await assert.rejects(index.tasks({pinId:pin.pinId,typeIds:['binary']}),{code:'index_source_unavailable'});
  await assert.rejects(index.tasks({pinId:pin.pinId,typeIds:['large']}),{code:'index_input_limit'});
  assert.deepEqual(f.taskCalls,[]);await index.close();
});
test('Tasks total source budget is enforced before Rust evaluation',async()=>{
  const f=fixture();for(let i=0;i<5;i++)f.file('type'+i,'x'.repeat(220*1024));const index=f.open();await f.build(index);const pin=await index.open();
  await assert.rejects(index.tasks({pinId:pin.pinId,typeIds:['type0','type1','type2','type3','type4']}),{code:'index_input_limit'});
  assert.deepEqual(f.taskCalls,[]);await index.close();
});
test('Tasks pin ownership/expiry and request mutation cannot redirect retained source reads',async()=>{
  const f=fixture();f.file('type','original');f.file('other','other');const a=f.open(),b=f.open('client-b');await f.build(a);const pin=await a.open();
  await assert.rejects(b.tasks({pinId:pin.pinId,typeIds:['type']}),{code:'index_snapshot_expired'});
  const input={pinId:pin.pinId,typeIds:['type'],options:{clockMs:0}};const read=a.tasks(input);input.typeIds[0]='other';input.options.clockMs=99;await read;
  assert.deepEqual(f.taskCalls[0]!.sources,[{id:'type',source:'original'}]);assert.equal(f.taskCalls[0]!.options.clockMs,0);
  await a.closePin(pin.pinId);await assert.rejects(a.tasks({pinId:pin.pinId,typeIds:['type']}),{code:'index_snapshot_expired'});
  const next=await a.open();await a.rebuild();await assert.rejects(a.tasks({pinId:next.pinId,typeIds:['type']}),{code:'index_snapshot_expired'});await a.close();await b.close();
});
test('Tasks rechecks pin/session after asynchronous retained projection fetch',async()=>{
  const f=fixture();f.file('type','original');const index=f.open();await f.build(index);const pin=await index.open();
  let fetched=false;f.afterRead((store,key)=>{if(store==='control'&&String(key).endsWith('/row/type')){fetched=true;f.deny();}});
  await assert.rejects(index.tasks({pinId:pin.pinId,typeIds:['type']}),{code:'owner_retired'});assert.equal(fetched,true);assert.deepEqual(f.taskCalls,[]);
});


/** The WASM double above supplies opaque facts/policy. These assertions cover
 * host identity, persistence, counters and fencing, not real Rust parser parity. */
const parseRows=(f:ReturnType<typeof fixture>)=>[...f.records.get('control')!.values()].filter(row=>typeof row.key==='string'&&row.key.startsWith('document-parse-cache:v1/row/'));
async function prepared(index:ReturnType<ReturnType<typeof fixture>['open']>){let stage=await index.begin();while(!stage.ready)stage=await index.pump(stage.stageId);await index.publish(stage.stageId);return stage;}
test('different entries share facts, then same-entry rows remain the preferred reuse path',async()=>{
  const f=fixture();f.file('a','identical');const index=f.open();let stage=await prepared(index);assert.deepEqual(stage.progress.parseCache,{hits:0,misses:1,unavailable:0,corrupt:0,unsupported:0});
  f.file('b','identical',{revision:'r2'});f.sequence('1');stage=await prepared(index);assert.equal(stage.progress.reused,1);assert.deepEqual(stage.progress.parseCache,{hits:1,misses:0,unavailable:0,corrupt:0,unsupported:0});assert.deepEqual(f.stats(),{textExtractions:1,reuses:1,cacheBinds:1});assert.equal(parseRows(f).length,1);
  stage=await prepared(index);assert.equal(stage.progress.reused,2);assert.equal(stage.progress.parseCache.hits,0);assert.equal(stage.progress.parseCache.misses,0);await index.close();
});
test('persisted facts survive host reopen while changed content and extraction mode miss',async()=>{
  const f=fixture();f.file('a','same');const first=f.open();await prepared(first);await first.close();
  f.file('a','same',{revision:'r2',path:'renamed.md'});f.sequence('1');const reopened=f.open();let stage=await prepared(reopened);assert.equal(stage.progress.parseCache.hits,1);assert.equal(stage.progress.reused,0);
  f.file('a','same',{revision:'r3',path:'renamed.txt'});f.sequence('2');stage=await prepared(reopened);assert.equal(stage.progress.parseCache.misses,1);
  f.file('a','different',{revision:'r4',path:'renamed.md'});f.sequence('3');stage=await prepared(reopened);assert.equal(stage.progress.parseCache.misses,1);assert.equal(f.stats().textExtractions,3);await reopened.close();
});
test('corrupt and unsupported optional facts re-extract with a single disjoint lookup outcome',async()=>{
  for(const outcome of ['corrupt','unsupported']){const f=fixture();f.file('a','text');const index=f.open();await prepared(index);const row=parseRows(f)[0],ordinal=row.ordinal;
    row.payload=outcome==='corrupt'?row.payload.replace(/("factsChecksum":")[0-9a-f]/,'$1z'):row.payload.replace('"fixtureVersion":1','"fixtureVersion":2');
    f.file('a','text',{revision:'r2'});f.sequence('1');const stage=await prepared(index);assert.equal(stage.progress.parseCache[outcome],1);assert.equal(stage.progress.parseCache.misses,0);assert.equal(stage.progress.parseCache.hits,0);assert.equal(f.stats().textExtractions,2);assert.equal(parseRows(f)[0].ordinal,ordinal,'replacement retains FIFO position');await index.close();
  }
});
test('Rust-supplied capacity drives FIFO eviction, and hits do not promote a row',async()=>{
  const f=fixture({cacheRows:2});f.file('a','first');f.file('b','second');const index=f.open();await prepared(index);const oldest=parseRows(f).find(row=>JSON.parse(row.payload).key.digest.toString()===sha(new TextEncoder().encode('first')).toString())!;
  f.file('a','first',{revision:'r2'});f.sequence('1');await prepared(index);assert.equal(parseRows(f).find(row=>row.key===oldest.key)!.ordinal,oldest.ordinal);
  f.file('c','third');f.sequence('2');await prepared(index);assert.equal(parseRows(f).length,2);assert.equal(parseRows(f).some(row=>row.key===oldest.key),false);assert.equal(f.records.get('control')!.get('document-parse-cache:v1/catalog').value.rows,2);await index.close();
});
test('an oversized optional payload skips cache while its supported index row publishes',async()=>{
  const f=fixture({cacheRowBytes:16});f.file('a','text');const index=f.open();const stage=await prepared(index);assert.equal(stage.progress.prepared,1);assert.equal(stage.progress.parseCache.misses,1);assert.equal(parseRows(f).length,0);assert.equal((await index.status()).current,true);await index.close();
});
test('cache lookup cannot swallow retired admission or replace the final source fence',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await prepared(index);f.file('a','text',{revision:'r2'});f.sequence('1');const stage=await index.begin();let changed=false;
  f.afterRead((store,key)=>{if(!changed&&store==='control'&&String(key).startsWith('document-parse-cache:v1/row/')){changed=true;f.file('a','later',{revision:'r3'});f.sequence('2');}});
  await assert.rejects(index.pump(stage.stageId),{code:'index_source_changed'});assert.equal((await index.status()).coveredWatermark,'0');await index.close();
  const g=fixture();g.file('a','text');const other=g.open();await prepared(other);g.file('a','text',{revision:'r2'});g.sequence('1');const pending=await other.begin();g.afterRead((store,key)=>{if(store==='control'&&String(key).startsWith('document-parse-cache:v1/row/'))g.deny();});await assert.rejects(other.pump(pending.stageId),{code:'owner_retired'});await other.close();
});
test('generation rebuild expires pins and reuses preserved facts without touching source or pending data',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();const first=await prepared(index),old=await index.open(),source=f.source();
  const family=()=>clone(new Map([...f.records.get('control')!].filter(([key])=>key.startsWith('document-parse-cache:v1/'))));
  // Opening the old pin hydrates persisted rows and already increments mock reuses.
  const facts=family(),before=f.stats();assert.equal(parseRows(f).length,1);
  f.seed('control','pending-checkpoint',{key:'pending-checkpoint',value:'unsent'});f.seed('control','receipt',{key:'receipt',value:'keep'});
  await index.rebuild();assert.deepEqual(family(),facts,'generation rebuild must not clear or rewrite facts');
  assert.equal((await index.status()).snapshot,null);assert.equal([...f.records.get('control')!.keys()].some(key=>key.startsWith('document-index:v1/g/')),false);
  await assert.rejects(index.search({pinId:old.pinId,query:'opaque'}),{code:'index_snapshot_expired'});
  const next=await prepared(index);assert.equal(next.progress.reused,0);assert.deepEqual(next.progress.parseCache,{hits:1,misses:0,unavailable:0,corrupt:0,unsupported:0});assert.notEqual(next.snapshot.generationEpoch,first.snapshot.generationEpoch);
  assert.deepEqual(f.stats(),{textExtractions:before.textExtractions,reuses:before.reuses,cacheBinds:before.cacheBinds+1});assert.deepEqual(family(),facts,'a cache hit retains the exact facts/FIFO state');
  const fresh=await index.open();assert.notEqual(fresh.pinId,old.pinId);assert.deepEqual((await index.search({pinId:fresh.pinId,query:'opaque'}) as any).result.value.observed,['text']);
  await assert.rejects(index.search({pinId:old.pinId,query:'opaque'}),{code:'index_snapshot_expired'});
  assert.equal(f.records.get('control')!.get('pending-checkpoint').value,'unsent');assert.equal(f.records.get('control')!.get('receipt').value,'keep');assert.deepEqual(f.source(),source);await index.close();
});

test('unavailable optional lookup re-extracts without also incrementing miss',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await prepared(index);f.file('a','text',{revision:'r2'});f.sequence('1');f.cacheUnavailable();const stage=await prepared(index);assert.deepEqual(stage.progress.parseCache,{hits:0,misses:0,unavailable:1,corrupt:0,unsupported:0});assert.equal(f.stats().textExtractions,2);await index.close();
});
test('an optional write abandons admission after the Rust-supplied victim bound',async()=>{
  const f=fixture({cacheRows:100,cacheBytes:4096,cacheRowBytes:2048});f.file('a','text');
  for(let i=0;i<40;i++){const key=i.toString(16).padStart(64,'0'),ordinal=String(i),payload='x'.repeat(i<38?1:2000),bytes=payload.length;f.seed('control','document-parse-cache:v1/row/'+key,{key:'document-parse-cache:v1/row/'+key,locator:key,ordinal,bytes,payload});const ordered='document-parse-cache:v1/oldest/'+ordinal.padStart(20,'0')+'/'+key;f.seed('control',ordered,{key:ordered,locator:key,ordinal,bytes});}
  f.seed('control','document-parse-cache:v1/catalog',{key:'document-parse-cache:v1/catalog',value:{formatVersion:1,authorityId:authority,rows:40,bytes:4038,nextOrdinal:'40'}});const source=f.source(),index=f.open();const stage=await prepared(index);assert.equal(stage.progress.prepared,1);assert.equal(stage.progress.parseCache.misses,1);assert.equal(parseRows(f).length,8);const usage=f.records.get('control')!.get('document-parse-cache:v1/catalog').value;assert.equal(usage.rows,8);assert.equal(usage.bytes,4006);assert.equal((await index.status()).current,true);assert.deepEqual(f.source(),source);await index.close();
});
test('impossible FIFO usage is corrupt optional state, never reset to an invented zero',async()=>{
  const f=fixture({cacheRows:1});f.file('a','text');f.seed('control','document-parse-cache:v1/catalog',{key:'document-parse-cache:v1/catalog',value:{formatVersion:1,authorityId:authority,rows:1,bytes:1,nextOrdinal:'1'}});const index=f.open();await prepared(index);assert.equal(parseRows(f).length,0);assert.equal(f.records.get('control')!.get('document-parse-cache:v1/catalog').value.rows,1);assert.equal((await index.status()).current,true);await index.close();
});

test('completed cache hits count per pump when row-output budget defers insertion',async()=>{
  const f=fixture({pauseCacheBindOnce:true});f.file('a','same');const index=f.open();await prepared(index);f.file('b','same');f.sequence('1');let stage=await index.begin();
  const zero={hits:0,misses:0,unavailable:0,corrupt:0,unsupported:0},one={...zero,hits:1},observations=[];
  assert.deepEqual(stage.progress.parseCache,zero);
  stage=await index.pump(stage.stageId);observations.push(stage.progress.parseCache);assert.equal(stage.prepared,1);assert.equal(stage.ready,false);assert.equal(stage.progress.reused,1);assert.deepEqual(stage.progress.parseCache,one);
  stage=await index.pump(stage.stageId);observations.push(stage.progress.parseCache);assert.equal(stage.ready,true);assert.equal(stage.progress.reused,1);assert.deepEqual(stage.progress.parseCache,one);
  stage=await index.pump(stage.stageId);observations.push(stage.progress.parseCache);assert.equal(stage.ready,true);assert.equal(stage.progress.reused,1);assert.deepEqual(stage.progress.parseCache,zero);
  assert.deepEqual(observations,[one,one,zero],'later pumps must not mutate earlier progress snapshots');assert.equal(observations.reduce((sum,row)=>sum+row.hits,0),2,'both completed lookup attempts count, including the deferred insertion');
  await index.publish(stage.stageId);await index.close();
});
test('multi-pump cache outcomes sum explicitly without accumulating in stage progress',async()=>{
  const f=fixture();for(let i=0;i<33;i++)f.file('note-'+i,'same');const source=f.source(),index=f.open();let stage=await index.begin();
  const zero={hits:0,misses:0,unavailable:0,corrupt:0,unsupported:0};assert.deepEqual(stage.progress.parseCache,zero);
  stage=await index.pump(stage.stageId);const first=stage.progress.parseCache;assert.equal(stage.ready,false);assert.equal(stage.prepared,32);assert.equal(stage.progress.reused,0);assert.deepEqual(first,{...zero,hits:31,misses:1});
  stage=await index.pump(stage.stageId);const second=stage.progress.parseCache;assert.equal(stage.ready,true);assert.equal(stage.prepared,33);assert.equal(stage.progress.reused,0);assert.deepEqual(second,{...zero,hits:1});
  stage=await index.pump(stage.stageId);assert.deepEqual(stage.progress.parseCache,zero);assert.deepEqual(first,{...zero,hits:31,misses:1});assert.equal(first.hits+second.hits,32);assert.equal(first.misses+second.misses,1);
  assert.deepEqual(f.stats(),{textExtractions:1,reuses:0,cacheBinds:32});await index.publish(stage.stageId);assert.deepEqual(f.source(),source);await index.close();
});
test('unsupported optional catalog and exhausted FIFO ordinal never fail supported indexing',async()=>{
  for(const value of [{formatVersion:999,authorityId:authority,rows:0,bytes:0,nextOrdinal:'0'},{formatVersion:1,authorityId:authority,rows:0,bytes:0,nextOrdinal:'18446744073709551615'}]){const f=fixture();f.file('a','text');f.seed('control','document-parse-cache:v1/catalog',{key:'document-parse-cache:v1/catalog',value});const source=f.source(),index=f.open();const stage=await prepared(index);assert.equal(stage.progress.parseCache[value.formatVersion===999?'unsupported':'misses'],1);assert.equal((await index.status()).current,true);assert.equal(parseRows(f).length,0);assert.deepEqual(f.source(),source);await index.close();}
});

const richSpec={query:'needle',caseSensitive:false,sort:'nameAsc' as const,context:'line' as const,explain:false};
async function richReady(index:ReturnType<ReturnType<typeof fixture>['open']>,pinId:string){const {queryId}=await index.richStart({pinId,spec:richSpec}) as {queryId:string};const ready=await index.richPrepare({pinId,queryId}) as {state:'ready';cursor:string};assert.equal(ready.state,'ready');return {queryId,cursor:ready.cursor};}
test('rich facts follow Rust path order across inventory, BMP and astral paths on an immutable pin',async()=>{
  const f=fixture();
  f.file('a','needle',{path:'Z.md',revision:'za',mtime:91});
  f.file('b','needle',{path:'\u{10000}.md',revision:'astral',mtime:22});
  f.file('c','needle',{path:'\uE000.md',revision:'bmp',mtime:33});
  f.file('d','needle',{path:'A.md',revision:'ascii',mtime:44});
  f.file('e','binary',{path:'image.png',revision:'binary',mtime:55,binary:true});
  const source=f.source(),index=f.open();await f.build(index);const pin=await index.open();
  const expected=[['d','ascii',44],['a','za',91],['e','binary',55],['c','bmp',33],['b','astral',22]];
  for(let attempt=0;attempt<2;attempt++){
    const ready=await richReady(index,pin.pinId);
    assert.deepEqual(f.richCalls[attempt].facts.map(row=>[row.entryId,row.revision,row.mtimeMs]),expected);
    await index.richClose({pinId:pin.pinId,queryId:ready.queryId});
  }
  assert.deepEqual(f.source(),source);
  f.file('a','new needle',{path:'0.md',revision:'new',mtime:999});f.sequence('1');await f.build(index);
  const retained=await richReady(index,pin.pinId);
  assert.deepEqual(f.richCalls[2].facts.map(row=>[row.entryId,row.revision,row.mtimeMs]),expected);
  await index.richClose({pinId:pin.pinId,queryId:retained.queryId});await index.close();
});
test('rich metadata-only pages use retained facts, strict shared envelope and zero projection reads',async()=>{
  const f=fixture();f.file('a','old',{mtime:7});f.file('image','binary',{path:'image.png',binary:true});const index=f.open();await f.build(index);const pin=await index.open(),source=f.source();
  f.file('a','new',{revision:'r2',mtime:99});const before=f.calls.length;const ready=await richReady(index,pin.pinId);const page=await index.richPage({pinId:pin.pinId,...ready}) as any;
  assert.equal(page.result.value.complete,true);assert.equal(page.cursor,null);assert.equal(f.richStats.accepted,0);assert.equal(f.calls.slice(before).some(call=>call.op==='get'&&String(call.key).includes('/row/')),false);
  assert.deepEqual(f.richCalls[0].facts.map(row=>[row.entryId,row.revision,row.mtimeMs]),[['a','r1',7],['image','r1',1]]);assert.equal(f.richCalls[0].facts.some(row=>'path'in row),false);
  assert.equal(f.richStats.drivesFreed,1);assert.equal(f.richStats.preparedFreed,1);await index.richClose({pinId:pin.pinId,queryId:ready.queryId});await index.richClose({pinId:pin.pinId,queryId:ready.queryId});assert.equal(f.richStats.closed,1);await index.close();
});
test('rich retained reads accept exact old projection and free drive/prepared handles',async()=>{
  const f=fixture({richRead:true});f.file('a','old needle');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);f.file('a','new needle',{revision:'r2'});f.sequence('1');await f.build(index);
  const page=await index.richPage({pinId:pin.pinId,...ready}) as any;assert.deepEqual(page.result.snapshot,pin.snapshot);assert.equal(f.richStats.accepted,1);assert.equal(f.richStats.drivesFreed,1);assert.equal(f.richStats.preparedFreed,1);await index.close();
});
test('rich caller mutation, foreign query/cursor and retired pin cannot redirect an operation',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),other=await index.open();
  const input={pinId:pin.pinId,spec:{...richSpec}};const pending=index.richStart(input);input.spec.query='changed';const {queryId}=await pending as {queryId:string};assert.equal(f.richCalls[0].spec.query,'needle');
  const ready=await index.richPrepare({pinId:pin.pinId,queryId}) as {cursor:string};await assert.rejects(index.richPrepare({pinId:other.pinId,queryId}),{code:'search_expired'});await assert.rejects(index.richPage({pinId:pin.pinId,queryId,cursor:other.pinId+'/not-this-query'}),{code:'search_expired'});
  await index.closePin(pin.pinId);await assert.rejects(index.richPage({pinId:pin.pinId,queryId,cursor:ready.cursor}),{code:'index_snapshot_expired'});assert.equal(f.richStats.closed,1);await index.close();
});
test('rich read rejects lease retirement before accept, preserves error and frees pending drive',async()=>{
  const f=fixture({richRead:true});f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);let fetched=false;
  f.afterRead((store,key)=>{if(store==='control'&&String(key).endsWith('/row/a')){fetched=true;f.deny();}});
  await assert.rejects(index.richPage({pinId:pin.pinId,...ready}),{code:'owner_retired'});assert.equal(fetched,true);assert.equal(f.richStats.accepted,0);assert.equal(f.richStats.drivesFreed,1);assert.equal(f.richStats.freed,1);assert.equal(f.richStats.cleared,1);
});
test('rich pin-close during retained fetch retires query without resurrecting owner or accepting source',async()=>{
  const f=fixture({richRead:true});f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);let close:Promise<void>|undefined;
  f.afterRead((store,key)=>{if(!close&&store==='control'&&String(key).endsWith('/row/a'))close=index.closePin(pin.pinId);});
  await assert.rejects(index.richPage({pinId:pin.pinId,...ready}),error=>['index_snapshot_expired','search_expired'].includes((error as any).code));await close;assert.equal(f.richStats.accepted,0);assert.equal(f.richStats.drivesFreed,1);assert.equal(f.richStats.created,1);assert.equal(f.richStats.closed,1);await index.close();
});
test('rich final post-commit admission cannot expose a retired reply; resources still drain',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);f.afterRichCommit(()=>f.deny());
  await assert.rejects(index.richPage({pinId:pin.pinId,...ready}),{code:'owner_retired'});assert.equal(f.richStats.preparedFreed,1);assert.equal(f.richStats.drivesFreed,1);assert.equal(f.richStats.freed,1);
});
test('rich strict decoder rejects invalid output and Rust source errors remain fatal',async()=>{
  for(const corrupt of [false,true]){const f=fixture(corrupt?{richRead:true}:{richInvalidPage:true});f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);
    if(corrupt){const row=[...f.records.get('control')!.values()].find(row=>typeof row.key==='string'&&row.key.endsWith('/row/a'));row.value.projection=new TextEncoder().encode('xxxx');}
    await assert.rejects(index.richPage({pinId:pin.pinId,...ready}),{code:corrupt?'index_source_changed':'index_rebuild_required'});assert.equal(f.richStats.drivesFreed,1);await index.close();}
});
test('rich compile diagnostics preserve stable code and exact query range through BrowserVaultError',async()=>{
  const f=fixture({richCompile:true});f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open();
  await assert.rejects(index.richStart({pinId:pin.pinId,spec:{...richSpec,query:'!'}}),error=>{assert.equal((error as any).code,'search_compile');assert.equal((error as any).source,'rust');assert.deepEqual((error as any).details,{diagnostic:{code:'invalid-operand',queryRange:{bytes:[0,1],utf16:[0,1]},message:'Expected operand'}});return true;});await index.close();
});
test('rich rebuild clears owner, expires old query and starts with a fresh session',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);await index.rebuild();assert.equal(f.richStats.cleared,1);assert.equal(f.richStats.freed,1);
  await assert.rejects(index.richPrepare({pinId:pin.pinId,queryId:ready.queryId}),{code:'index_snapshot_expired'});await f.build(index);const next=await index.open();await richReady(index,next.pinId);assert.equal(f.richStats.created,2);await index.close();assert.equal(f.richStats.freed,2);
});

test('rich pending admission teardown never recreates an owner after close/rebuild',async()=>{
  for(const action of ['close','rebuild'] as const){const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open();await richReady(index,pin.pinId);let ending:Promise<void>|undefined;const source=f.source();
    f.afterRead((store,key)=>{if(!ending&&store==='control'&&key==='document-index:v1/catalog')ending=index[action]();});
    await assert.rejects(index.richStart({pinId:pin.pinId,spec:richSpec}),error=>['index_closed','index_snapshot_expired'].includes((error as any).code));await ending;
    assert.equal(f.richStats.created,1);assert.equal(f.richStats.freed,1);assert.equal(f.richCalls.length,1);assert.deepEqual(f.source(),source);await index.close();}
});
test('rich external catalog expiry after commit retires exact query and close retry remains reachable',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),ready=await richReady(index,pin.pinId);
  f.afterRichCommit(()=>{const row=f.records.get('control')!.get('document-index:v1/catalog');row.value.pins=[];});
  await assert.rejects(index.richPage({pinId:pin.pinId,...ready}),{code:'index_snapshot_expired'});assert.equal(f.richStats.closed,1);assert.equal(f.richStats.preparedFreed,1);assert.equal(f.richStats.drivesFreed,1);
  await index.richClose({pinId:pin.pinId,queryId:ready.queryId});assert.equal(f.richStats.closed,1);await index.closePin(pin.pinId);await index.close();
});

/** Selects a single effect for the real IDB backend adapter; it is deliberately
 * not a JS copy of the Rust lifecycle transition policy. */
function maintenanceScript(f:ReturnType<typeof fixture>){
  let effect:any={kind:'observe'},id=0,replay:string|undefined;const completions:any[]=[];let freed=0,created=0;
  const report=()=>JSON.stringify({effect:null,update:{lifetime:'runtime',revision:String(id)},requestOutcomes:[],execution:'waitForWake'});
  f.wasm.WasmDocumentRuntimeOwner=class {
    constructor(){created++;}commandJson(){return report();}updateJson(){return JSON.stringify({lifetime:'runtime',revision:String(id)});}
    snapshotJson(){return JSON.stringify({update:{lifetime:'runtime',revision:String(id)},inFlight:null,lastStep:null});}
    replayJson(){return replay;}issued(lifetime:string,selected:string){assert.equal(lifetime,'runtime');assert.equal(selected,String(id));return {descriptorJson:()=>JSON.stringify({lifetime,effectId:selected,effect,priority:'background',targetSource:null}),completeJson(raw:string){completions.push(JSON.parse(raw));return replay=report();},free(){}};}
    free(){freed++;}
  };
  return {completions,freed:()=>freed,created:()=>created,select(next:any){effect=next;id++;replay=undefined;return {lifetime:'runtime',effectId:String(id)};}};
}
test('internal maintenance uses exact captured stage source/progress and retains facts/source bytes',async()=>{
  const f=fixture();f.file('a','original');const script=maintenanceScript(f),{index,maintenance}=f.backend();const source=f.source();assert.equal(maintenance.update(),null);maintenance.command({kind:'continue'});
  await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage;assert.deepEqual(stage.source,{localStoreId:authority,watermark:'0'});assert.equal(stage.progress.prepared,0);
  await maintenance.step(script.select({kind:'pump',snapshot:stage.snapshot}));assert.deepEqual(script.completions.at(-1).stage.progress,{prepared:1,total:1,ready:true});
  const catalog=f.records.get('control')!.get('document-index:v1/catalog');assert.equal(catalog.value.generations[0].rows,1);
  await maintenance.step(script.select({kind:'recoverStage'}));assert.equal(script.completions.at(-1).stage.progress.ready,true);
  await maintenance.step(script.select({kind:'publish',snapshot:stage.snapshot}));assert.deepEqual(script.completions.at(-1).snapshot,stage.snapshot);assert.equal((await index.status()).current,true);assert.deepEqual(f.source(),source);
  await index.close();assert.equal(script.freed(),1);
});
test('failed live builder is unavailable recovery, never fabricated progress or source deletion',async()=>{
  const f=fixture();f.file('a','original');const script=maintenanceScript(f),{index,maintenance}=f.backend(),source=f.source();maintenance.command({kind:'continue'});
  await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage;f.fail();await assert.rejects(maintenance.step(script.select({kind:'pump',snapshot:stage.snapshot})));
  await assert.rejects(maintenance.step(script.select({kind:'recoverStage'})),{code:'document_runtime_unavailable'});assert.equal(script.completions.at(-1).kind,'failed');assert.equal(script.completions.at(-1).failure,'unavailable');assert.deepEqual(f.source(),source);await index.close();
});
test('browser no-resume startup recovers None without deleting a foreign client stage',async()=>{
  const f=fixture();f.file('a','original');const script=maintenanceScript(f),foreign=f.open('foreign'),stage=await foreign.begin();const {index,maintenance}=f.backend();maintenance.command({kind:'continue'});
  await maintenance.step(script.select({kind:'initialize'}));await maintenance.step(script.select({kind:'recoverStage'}));assert.deepEqual(script.completions.at(-1),{kind:'recovered',stage:null});
  const catalog=f.records.get('control')!.get('document-index:v1/catalog');assert.ok(catalog.value.generations.some((g:any)=>g.id===stage.stageId&&g.clientId==='foreign'&&g.state==='staging'));await index.close();await foreign.close();
});

test('public rebuild drains an accepted maintenance pump before builder release and creates a new lazy lifetime',async()=>{
  const f=fixture();f.file('a','original');const script=maintenanceScript(f),{index,maintenance}=f.backend(),source=f.source();maintenance.command({kind:'continue'});await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage;
  let rebuilt:Promise<void>|undefined;f.afterRead((store)=>{if(store==='content'&&!rebuilt){rebuilt=index.rebuild();assert.equal(script.freed(),0);assert.throws(()=>maintenance.command({kind:'continue'}),{code:'document_runtime_busy'});}});
  await maintenance.step(script.select({kind:'pump',snapshot:stage.snapshot}));await rebuilt;assert.equal(script.freed(),1);assert.equal(script.created(),1);assert.deepEqual(f.source(),source);
  maintenance.command({kind:'continue'});assert.equal(script.created(),2);await maintenance.step(script.select({kind:'observe'}));assert.equal(script.completions.at(-1).observation.published,null);await index.close();assert.equal(script.freed(),2);
});
test('public normal close acknowledges only after the accepted maintenance effect drains',async()=>{
  const f=fixture();f.file('a','original');const script=maintenanceScript(f),{index,maintenance}=f.backend(),source=f.source();maintenance.command({kind:'continue'});await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage;
  let closing:Promise<void>|undefined;const rejected:Promise<void>[]=[];f.afterRead((store)=>{if(store==='content'&&!closing){closing=index.close();assert.equal(script.freed(),0);assert.throws(()=>maintenance.command({kind:'continue'}),{code:'document_runtime_retired'});rejected.push(assert.rejects(index.open(),{code:'index_closed'}),assert.rejects(index.richStart({pinId:'unadmitted',spec:richSpec}),{code:'index_closed'}));}});
  await maintenance.step(script.select({kind:'pump',snapshot:stage.snapshot}));await closing;await Promise.all(rejected);assert.equal(script.freed(),1);assert.equal(script.completions.at(-1).stage.progress.prepared,1);assert.deepEqual(f.source(),source);
});
test('fatal host revocation during an await cannot recreate maintenance or accept late progress',async()=>{
  const f=fixture();f.file('a','original');const script=maintenanceScript(f),{index,maintenance}=f.backend(),source=f.source();maintenance.command({kind:'continue'});await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage;
  f.afterRead(store=>{if(store==='content')f.fatal();});await assert.rejects(maintenance.step(script.select({kind:'pump',snapshot:stage.snapshot})),{code:'storage_closed'});await index.close();assert.equal(script.created(),1);assert.equal(script.freed(),1);assert.equal(script.completions.at(-1).failure,'fatal');assert.deepEqual(f.source(),source);assert.throws(()=>maintenance.command({kind:'continue'}),{code:'document_runtime_retired'});
});

test('maintenance typed snapshot boundary rejects invalid actual versions without relabeling or source writes',async()=>{
  const f=fixture();f.file('a','exact source');const source=f.source();f.wasm.documentIndexVersionsJson=()=>'{"schema":"invalid","extraction":"fixture","resolver":"fixture","query":"fixture"}';
  const script=maintenanceScript(f),{index,maintenance}=f.backend();maintenance.command({kind:'continue'});await assert.rejects(maintenance.step(script.select({kind:'begin'})),{code:'invalid_wasm_result'});assert.equal(script.completions.at(-1).kind,'failed');assert.equal(script.completions.at(-1).failure,'invalidData');assert.deepEqual(f.source(),source);await index.close();
});
test('maintenance rejects a foreign captured snapshot before source IO and preserves the actual stage',async()=>{
  const f=fixture();f.file('a','exact source');const source=f.source(),script=maintenanceScript(f),{index,maintenance}=f.backend();maintenance.command({kind:'continue'});await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage;
  const reads=f.calls.filter(row=>row.store==='content').length;await assert.rejects(maintenance.step(script.select({kind:'pump',snapshot:{...stage.snapshot,localStoreId:'foreign'}})),{code:'index_stage_expired'});assert.equal(f.calls.filter(row=>row.store==='content').length,reads);assert.deepEqual(f.source(),source);await maintenance.step(script.select({kind:'recoverStage'}));assert.deepEqual(script.completions.at(-1).stage.snapshot,stage.snapshot);await index.close();
});

async function metadataFixture(options:{metadataDelta?:boolean;propertyTargets?:boolean;preview?:boolean}={},count=3){
  const f=fixture({metadataRows:true,...options});for(let n=0;n<count;n++)f.file('entry-'+n,'opaque source '+n,{path:`Note ${n}.txt`});
  const index=f.open();await f.build(index);const pin=await index.open();return {...f,index,pin};
}
test('metadata support is positive before first open and NotReady never becomes unsupported',async()=>{
  const f=fixture({metadataRows:true}),index=f.open();assert.equal(index.metadataRowsAvailable,true);assert.equal(typeof index.metadataRows,'function');
  await assert.rejects(index.open(),{code:'index_not_ready'});assert.equal(index.metadataRowsAvailable,true);await index.close();
  const legacy=fixture().open();assert.equal(legacy.metadataRowsAvailable,false);await legacy.close();
  for(const partial of [class {},class {static withBaseline(){}}]){const malformed=fixture({metadataRows:true});malformed.wasm.WasmDocumentMetadataRowsScan=partial as any;assert.throws(()=>malformed.open(),{code:'index_rebuild_required'});assert.equal(malformed.metadataStats.created,0);}
  for(const method of ['fork','pageJson','sameCheckpoint','isNextCheckpointOf','usesBaseline','retire','free']){const malformed=fixture({metadataRows:true}),Full=malformed.wasm.WasmDocumentMetadataRowsScan!;class Partial extends Full {}Object.defineProperty(Partial.prototype,method,{value:undefined});malformed.wasm.WasmDocumentMetadataRowsScan=Partial;assert.throws(()=>malformed.open(),{code:'index_rebuild_required'});assert.equal(malformed.metadataStats.created,0);}
});
test('metadata pages read only pin registrations and reuse cached coverage across every page',async()=>{
  const f=await metadataFixture(),before=f.stats(),coverage=f.metadataStats.coverageReads,source=f.source();f.calls.length=0;f.transactions.length=0;
  const rows:any[]=[];let cursor:string|undefined;
  do{const page=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1,...(cursor?{cursor}:{})}) as any;rows.push(...page.result.value.rows);cursor=page.cursor??undefined;}while(cursor);
  assert.deepEqual(rows.map(row=>row.value.entry.id),['entry-0','entry-1','entry-2']);assert.equal(f.metadataStats.coverageReads,coverage);assert.deepEqual(f.stats(),before);assert.deepEqual(f.source(),source);
  assert.ok(f.calls.every(call=>call.store==='control'&&call.op==='get'&&['local-store-id','document-index:v1/catalog'].includes(call.key)));assert.ok(f.transactions.every(names=>names.length===1&&names[0]==='control'));
  await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata transport retains structural folders without pretending they have file facts',async()=>{
  const f=fixture({metadataRows:true});f.file('file','text',{path:'Folder/Note.txt'});const entry={id:'folder',path:'Folder',kind:'folder',revision:'r1',deleted:false},presentation={id:'folder',ctime_ms:1,mtime_ms:1,size_bytes:0};
  f.seed('metadata','folder',entry);f.seed('presentation','folder',presentation);f.seed('sync_materialization_refs','folder',{id:'folder',status:'normal',entry,presentation,content:null});
  const index=f.open();await f.build(index);const pin=await index.open(),page=await index.metadataRows!({pinId:pin.pinId}) as any;
  assert.deepEqual(page.result.value.rows.find((row:any)=>row.kind==='folder'),{kind:'folder',entry});assert.equal(page.cursor,null);await index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata initial and continuation retries preserve exact opaque successor and page bytes',async()=>{
  const f=await metadataFixture(),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any;
  assert.deepEqual(await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}),first);
  const second=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}) as any;
  assert.deepEqual(await f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor,limit:1}),second);
  const last=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:second.cursor}) as any;assert.equal(last.cursor,null);assert.equal(last.result.value.rows[0].value.entry.id,'entry-2');await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata bounds and continuation profile failures do not advance any checkpoint',async()=>{
  const f=await metadataFixture(),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any;
  for(const input of [{cursor:first.cursor,limit:2},{cursor:first.cursor,baseline:{pinId:f.pin.pinId,snapshot:f.pin.snapshot}},{cursor:'unknown'},{limit:33},{limit:0},{limit:1.5},{unexpected:true}])await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,...input} as any));
  const next=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}) as any;assert.equal(next.result.value.rows[0].value.entry.id,'entry-1');await f.index.close();
});
test('metadata encoding and strict decoder failures preserve original retry checkpoints',async()=>{
  const f=await metadataFixture(),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any,live=f.metadataStats.live;
  f.metadataThrow();await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_output_limit'});assert.equal(f.metadataStats.live,live);
  f.metadataInvalid(true);await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_rebuild_required'});assert.equal(f.metadataStats.live,live);f.metadataInvalid(false);
  const next=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}) as any;assert.equal(next.result.value.rows[0].value.entry.id,'entry-1');await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata keeps at most eight checkpoints per destination and evicts without retiring surviving forks',async()=>{
  const f=await metadataFixture({},12),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any;let page=first;
  for(let n=0;n<8;n++){page=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:page.cursor}) as any;assert.ok(f.metadataStats.live<=8);}
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});
  const next=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:page.cursor}) as any;assert.equal(next.result.value.rows[0].value.entry.id,[...f.records.get('metadata')!.keys()].sort()[9]);await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata uses the existing four total pin registrations and scopes cursors to their destination',async()=>{
  const f=await metadataFixture(),pins=[f.pin,await f.index.open(),await f.index.open(),await f.index.open()];await assert.rejects(f.index.open(),{code:'index_pin_limit'});
  const first=await f.index.metadataRows!({pinId:pins[0]!.pinId,limit:1}) as any;await assert.rejects(f.index.metadataRows!({pinId:pins[1]!.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});
  assert.equal((f.records.get('control')!.get('document-index:v1/catalog').value.pins as any[]).length,4);await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata rejects wrong expected baseline snapshots and foreign client registrations',async()=>{
  const f=await metadataFixture({metadataDelta:true}),baseline=await f.index.open();
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:baseline.pinId,snapshot:{...baseline.snapshot,generation:'2'} as any}}),{code:'index_invalid_target'});
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:'missing',snapshot:{...baseline.snapshot,localStoreId:'foreign'} as any}}),{code:'index_invalid_target'});
  const foreign=f.open('client-b'),foreignPin=await foreign.open();await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:foreignPin.pinId,snapshot:foreignPin.snapshot as any}}),{code:'index_invalid_target'});
  await foreign.close();await f.index.close();
});
test('metadata unavailable initial history resets while a used baseline is fenced for its entire transfer',async()=>{
  const f=await metadataFixture({metadataDelta:true}),baseline=await f.index.open();
  const reset=await f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:'missing',snapshot:baseline.snapshot as any},limit:1}) as any;assert.equal(reset.result.value.mode,'reset');
  const delta=await f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:baseline.pinId,snapshot:baseline.snapshot as any},limit:1}) as any;assert.equal(delta.result.value.mode,'delta');
  await f.index.closePin(baseline.pinId);await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:delta.cursor}),{code:'index_snapshot_expired'});
  const next=await f.index.metadataRows!({pinId:f.pin.pinId,cursor:reset.cursor}) as any;assert.equal(next.result.value.mode,'reset');await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata pure-selected reset drops unused baseline and survives its later explicit close',async()=>{
  const f=await metadataFixture(),baseline=await f.index.open(),first=await f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:baseline.pinId,snapshot:baseline.snapshot as any},limit:1}) as any;
  assert.equal(first.result.value.mode,'reset');assert.equal(first.result.value.from,null);await f.index.closePin(baseline.pinId);
  assert.equal((await f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}) as any).result.value.rows[0].value.entry.id,'entry-1');await f.index.close();
});
test('metadata final destination catalog fence rejects an already encoded response',async()=>{
  const f=await metadataFixture(),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any,live=f.metadataStats.live;
  f.afterMetadataPage(()=>{const row=clone(f.records.get('control')!.get('document-index:v1/catalog'));row.value.pins=row.value.pins.filter((p:any)=>p.id!==f.pin.pinId);f.seed('control','document-index:v1/catalog',row);});
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});assert.equal(f.metadataStats.live,live);await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata final used-baseline catalog fence rejects an already encoded delta response',async()=>{
  const f=await metadataFixture({metadataDelta:true}),baseline=await f.index.open(),first=await f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:baseline.pinId,snapshot:baseline.snapshot as any},limit:1}) as any,live=f.metadataStats.live;
  f.afterMetadataPage(()=>{const row=clone(f.records.get('control')!.get('document-index:v1/catalog'));row.value.pins=row.value.pins.filter((p:any)=>p.id!==baseline.pinId);f.seed('control','document-index:v1/catalog',row);});
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});assert.equal(f.metadataStats.live,live);await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata owner revocation after encoding cannot publish a late checkpoint or recreate it',async()=>{
  const f=await metadataFixture(),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any;f.afterMetadataPage(()=>f.deny());
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'owner_retired'});assert.equal(f.metadataStats.live,0);const created=f.metadataStats.created;
  // Revocation synchronously closes maintenance; later public calls hit the
  // existing closed-phase gate before they can recreate a checkpoint.
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_closed'});assert.equal(f.metadataStats.created,created);await f.index.close();
});
test('metadata rebuild and close retire every retained checkpoint and reject late continuations',async()=>{
  const f=await metadataFixture(),first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any;await f.index.rebuild();assert.equal(f.metadataStats.live,0);
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});await f.index.close();await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_closed'});
});
test('metadata rejects concurrent direct calls for one destination without advancing twice',async()=>{
  const f=await metadataFixture(),pending=f.index.metadataRows!({pinId:f.pin.pinId,limit:1});
  await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,limit:1}),{code:'index_busy'});const first=await pending as any;
  assert.deepEqual(await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}),first);await f.index.close();assert.equal(f.metadataStats.live,0);
});
test('metadata explicit used-baseline close during final handoff rejects late data and frees forks',async()=>{
  const f=await metadataFixture({metadataDelta:true}),baseline=await f.index.open(),first=await f.index.metadataRows!({pinId:f.pin.pinId,baseline:{pinId:baseline.pinId,snapshot:baseline.snapshot as any},limit:1}) as any;let closing:Promise<void>|undefined;
  f.afterMetadataPage(()=>{closing=f.index.closePin(baseline.pinId);});await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});await closing;
  assert.equal(f.metadataStats.live,0);f.afterMetadataPage();await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});await f.index.close();
});


const allocationCatalogKey='document-index:v1/catalog';
const allocationCatalog=(f:ReturnType<typeof fixture>)=>f.records.get('control')!.get(allocationCatalogKey).value;
function seedAllocationCatalog(f:ReturnType<typeof fixture>,change:(catalog:any)=>void){const row=clone(f.records.get('control')!.get(allocationCatalogKey));change(row.value);f.seed('control',allocationCatalogKey,row);}
const parseFamily=(f:ReturnType<typeof fixture>)=>clone([...f.records.get('control')!].filter(([key])=>key.startsWith('document-parse-cache:v1/')));

// These tests cover host reservation/transaction/lifetime behavior. The opaque
// WASM double does not establish real Rust delta selection or browser IDB races.
test('stable index epoch advances semantic generations while physical row identities stay distinct',async()=>{
  const f=fixture();f.file('a','retained text');const source=f.source(),index=f.open();
  const first=await f.build(index),physicalFirst=f.descriptor(first).id,pin=await index.open(),before=f.stats();
  const second=await f.build(index),physicalSecond=f.descriptor(second).id;
  assert.equal(first.generation,'1');assert.equal(second.generation,'2');assert.equal(second.generationEpoch,first.generationEpoch);
  assert.notEqual(physicalFirst,physicalSecond);assert.notEqual(physicalFirst,first.generationEpoch);assert.notEqual(physicalSecond,second.generationEpoch);
  assert.equal(allocationCatalog(f).head,physicalSecond);assert.equal(allocationCatalog(f).allocated,'2');
  assert.equal(f.stats().textExtractions,before.textExtractions);assert.equal(f.stats().reuses,before.reuses+1);
  assert.deepEqual((await index.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['retained text']);assert.deepEqual(pin.snapshot,first);assert.deepEqual(f.source(),source);
  await index.close();
});
test('discarded and failed stage reservations survive normal close and provider replacement',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),first=await f.build(index),discarded=await index.begin();
  assert.equal(discarded.snapshot.generation,'2');await index.discard(discarded.stageId);
  const failed=await index.begin();assert.equal(failed.snapshot.generation,'3');f.fail();await assert.rejects(index.pump(failed.stageId),{code:'storage_failure'});
  await index.close();assert.equal(allocationCatalog(f).allocated,'3');
  const replacement=f.open(),next=await replacement.begin();assert.equal(next.snapshot.generation,'4');assert.equal(next.snapshot.generationEpoch,first.generationEpoch);
  assert.deepEqual((await replacement.status()).snapshot,first);assert.equal(allocationCatalog(f).head,f.descriptor(first).id);await replacement.close();
});
test('reservation transaction abort leaves the allocation clock and durable headers untouched',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await index.initialize();const initial=clone(allocationCatalog(f));
  f.afterCommit(()=>{f.afterCommit();f.fail();});
  await assert.rejects(index.begin(),{code:'storage_failure'});
  assert.deepEqual(allocationCatalog(f),initial);assert.equal(allocationCatalog(f).allocated,'0');
  assert.equal([...f.records.get('control')!.keys()].some(key=>key.startsWith('document-index:v1/g/')),false);assert.equal(f.allocationCalls.at(-1).allocated,'0');
  const retry=await index.begin();assert.equal(retry.snapshot.generation,'1');assert.equal(retry.snapshot.generationEpoch,initial.epoch);await index.close();
});
test('durable reservation followed by owner loss consumes the generation despite a rejected begin reply',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await index.initialize();const epoch=allocationCatalog(f).epoch;
  f.afterCommit(()=>{if(allocationCatalog(f).allocated==='1'){f.afterCommit();f.deny();}});
  await assert.rejects(index.begin(),{code:'owner_retired'});assert.equal(allocationCatalog(f).allocated,'1');assert.equal(allocationCatalog(f).generations.length,1);
  await index.close();f.allow();const replacement=f.open(),next=await replacement.begin();assert.equal(next.snapshot.generation,'2');assert.equal(next.snapshot.generationEpoch,epoch);await replacement.close();
});
test('pump commit abort cannot turn a builder-only row into published or recovered facts',async()=>{
  const f=fixture();f.file('a','text');const source=f.source(),script=maintenanceScript(f),{index,maintenance}=f.backend();maintenance.command({kind:'continue'});
  await maintenance.step(script.select({kind:'begin'}));const stage=script.completions.at(-1).stage,physical=f.descriptor(stage.snapshot).id;
  f.fail();await assert.rejects(index.pump(physical),{code:'storage_failure'});assert.equal(f.stats().textExtractions,1,'double already accepted the row before the IDB abort');
  assert.equal(f.records.get('control')!.has('document-index:v1/g/'+physical+'/row/a'),false);assert.equal(f.descriptor(stage.snapshot).rows,0);assert.equal(allocationCatalog(f).head,null);
  await assert.rejects(index.pump(physical),{code:'index_rebuild_required'});await assert.rejects(index.publish(physical),{code:'index_rebuild_required'});
  await assert.rejects(maintenance.step(script.select({kind:'recoverStage'})),{code:'document_runtime_unavailable'});
  assert.deepEqual(f.source(),source);assert.equal(allocationCatalog(f).allocated,'1');await index.close();
});
test('prune failure after publication preserves the committed head and consumed allocation',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),first=await f.build(index),stage=await index.begin();await index.pump(stage.stageId);
  f.afterCommit(()=>{if(allocationCatalog(f).head===stage.stageId){f.afterCommit();f.fail();}});
  await assert.rejects(index.publish(stage.stageId),{code:'storage_failure'});
  assert.equal(allocationCatalog(f).head,stage.stageId);assert.equal(allocationCatalog(f).allocated,'2');assert.deepEqual((await index.status()).snapshot,stage.snapshot);
  const next=await index.begin();assert.equal(next.snapshot.generation,'3');assert.equal(next.snapshot.generationEpoch,first.generationEpoch);await index.close();
});
test('modeled competing durable reservation rejects an obsolete allocator proposal despite unchanged head and source',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await index.initialize();const initial=clone(allocationCatalog(f)),source=f.source(),allocate=f.wasm.documentIndexAllocateJson;let competing=false;
  f.wasm.documentIndexAllocateJson=(input:string)=>{
    const proposal=allocate(input);
    if(!competing){competing=true;const clock=JSON.parse(input);seedAllocationCatalog(f,c=>{c.allocated=String(BigInt(clock.allocated)+1n);});}
    return proposal;
  };
  // Model a different owner having committed and then pruned its reservation.
  // The double does not claim actual cross-worker IndexedDB serialization.
  await assert.rejects(index.begin(),{code:'index_head_changed'});
  assert.equal(allocationCatalog(f).allocated,'1');assert.equal(allocationCatalog(f).head,initial.head);assert.deepEqual(allocationCatalog(f).generations,[]);assert.deepEqual(f.source(),source);
  assert.equal([...f.records.get('control')!.keys()].some(key=>key.startsWith('document-index:v1/g/')),false,'the obsolete proposal never installs a stage header');
  f.wasm.documentIndexAllocateJson=allocate;const next=await index.begin();assert.equal(next.snapshot.generation,'2');assert.equal(next.snapshot.generationEpoch,initial.epoch);
  assert.equal(allocationCatalog(f).generations.length,1);assert.equal(f.descriptor(next.snapshot).id,next.stageId);await index.close();
});
test('pruning old generations and discarding the highest reservation never rewinds the clock',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();let current=await f.build(index);const epoch=current.generationEpoch;
  for(let n=2;n<=6;n++){current=await f.build(index);assert.equal(current.generation,String(n));}
  assert.ok(allocationCatalog(f).generations.length<=3);assert.equal(allocationCatalog(f).allocated,'6');
  const highest=await index.begin();assert.equal(highest.snapshot.generation,'7');await index.discard(highest.stageId);assert.equal(allocationCatalog(f).allocated,'7');
  const next=await index.begin();assert.equal(next.snapshot.generation,'8');assert.equal(next.snapshot.generationEpoch,epoch);assert.deepEqual((await index.status()).snapshot,current);await index.close();
});
test('explicit rebuild expires old pin cursors and resets only the generation clock with a fresh epoch',async()=>{
  const f=await metadataFixture({},3),source=f.source(),beforeParse=parseFamily(f),oldEpoch=f.pin.snapshot.generationEpoch,first=await f.index.metadataRows!({pinId:f.pin.pinId,limit:1}) as any;
  assert.ok(first.cursor);assert.ok(beforeParse.length>0);await f.index.rebuild();const rebuilt=allocationCatalog(f);
  assert.notEqual(rebuilt.epoch,oldEpoch);assert.equal(rebuilt.allocated,'0');assert.equal(rebuilt.head,null);assert.deepEqual(rebuilt.generations,[]);assert.deepEqual(rebuilt.pins,[]);
  assert.deepEqual(f.source(),source);assert.deepEqual(parseFamily(f),beforeParse);await assert.rejects(f.index.metadataRows!({pinId:f.pin.pinId,cursor:first.cursor}),{code:'index_snapshot_expired'});
  const next=await f.index.begin();assert.equal(next.snapshot.generation,'1');assert.equal(next.snapshot.generationEpoch,rebuilt.epoch);await f.index.close();
});
test('legacy catalog version one requires explicit derived rebuild instead of inferring a clock',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const source=f.source();
  seedAllocationCatalog(f,c=>{c.version=1;delete c.allocated;delete c.epoch;});
  assert.equal((await index.status()).rebuildRequired,true);await assert.rejects(index.begin(),{code:'index_rebuild_required'});await assert.rejects(index.open(),{code:'index_rebuild_required'});
  await index.rebuild();assert.equal(allocationCatalog(f).version,2);assert.equal(allocationCatalog(f).allocated,'0');const next=await f.build(index);assert.equal(next.generation,'1');assert.deepEqual(f.source(),source);await index.close();
});
test('malformed decimal allocation clocks fail closed until explicit rebuild',async()=>{
  for(const allocated of ['-1','01','18446744073709551616',7,null,undefined]){
    const f=fixture();f.file('a','text');const index=f.open();await index.initialize();const source=f.source();seedAllocationCatalog(f,c=>{c.allocated=allocated;});
    assert.equal((await index.status()).rebuildRequired,true);await assert.rejects(index.begin(),{code:'index_rebuild_required'});assert.equal(f.allocationCalls.length,0);
    await index.rebuild();assert.equal(allocationCatalog(f).allocated,'0');assert.equal((await index.begin()).snapshot.generation,'1');assert.deepEqual(f.source(),source);await index.close();
  }
});
test('different physical descriptors cannot claim the same stable semantic generation',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),snapshot=await f.build(index),physical=f.descriptor(snapshot).id;
  seedAllocationCatalog(f,c=>{c.generations.push({...clone(c.generations[0]),id:crypto.randomUUID()});});
  assert.equal((await index.status()).rebuildRequired,true);await assert.rejects(index.open(),{code:'index_rebuild_required'});await assert.rejects(index.begin(),{code:'index_rebuild_required'});
  assert.equal(allocationCatalog(f).head,physical);await index.rebuild();assert.equal(allocationCatalog(f).allocated,'0');assert.equal((await index.begin()).snapshot.generation,'1');await index.close();
});
test('allocation beyond JavaScript safe integer remains decimal-exact and maximum exhaustion cannot wrap',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await index.initialize();seedAllocationCatalog(f,c=>{c.allocated='9007199254740992';});const epoch=allocationCatalog(f).epoch;
  const stage=await index.begin();assert.equal(stage.snapshot.generation,'9007199254740993');assert.equal(allocationCatalog(f).allocated,'9007199254740993');assert.equal(f.allocationCalls.at(-1).allocated,'9007199254740992');await index.discard(stage.stageId);
  seedAllocationCatalog(f,c=>{c.allocated='18446744073709551615';});const before=clone(allocationCatalog(f));await assert.rejects(index.begin(),{code:'index_rebuild_required'});
  assert.deepEqual(allocationCatalog(f),before);assert.equal(f.allocationCalls.at(-1).allocated,'18446744073709551615');assert.equal(allocationCatalog(f).epoch,epoch);await index.close();
});


// The following doubles verify source/registration/bridge admission only. Actual
// Rust Base query and partial-result semantics have independent WASM gates.
test('preview bootstraps committed keys without restoring rows and remains readable until publication',async()=>{
  const f=fixture({preview:true});for(let n=0;n<33;n++)f.file('f'+String(n).padStart(2,'0'),'text '+n,{path:n===0?'view.base':undefined});const index=f.open();
  assert.equal(await index.previewOpen!({previewId:'1'}),null);let stage=await index.begin();stage=await index.pump(stage.stageId);assert.equal(stage.prepared,32);assert.equal(stage.ready,false);
  f.calls.length=0;const opened=await index.previewOpen!({previewId:'2'}) as any;assert.equal(opened.progress.preparedFiles,32);assert.equal(opened.progress.pendingFiles,1);assert.equal(f.previewStats.receipts,32);
  assert.equal(f.calls.some(call=>call.op==='get'&&String(call.key).includes('/row/')),false,'bootstrap must not load parser rows or projections');
  f.calls.length=0;const before=f.stats();const reply=await index.previewBase!({previewId:'2',id:'f00'});const bytes=new Uint8Array(reply.length);reply.writeInto(bytes);await reply.validate();reply.free();assert.deepEqual([...bytes],[17]);assert.deepEqual(f.stats(),before);
  assert.equal(f.calls.some(call=>call.op==='cursor'),false);assert.ok(f.calls.every(call=>['control','sync_state'].includes(call.store)));
  stage=await index.pump(stage.stageId);assert.equal(stage.ready,true);await assert.rejects(index.previewBase!({previewId:'2',id:'f00'}),{code:'index_preview_expired'});
  const latest=await index.previewOpen!({previewId:'3'}) as any;assert.equal(latest.progress.pendingFiles,0);const finalReply=await index.previewBase!({previewId:'3',id:'f00'});await finalReply.validate();finalReply.free();
  await index.publish(stage.stageId);await assert.rejects(index.previewBase!({previewId:'3',id:'f00'}),{code:'index_preview_expired'});const pin=await index.open();await index.closePin(pin.pinId);await index.close();
});
for(const changed of ['sequence','head','incarnation'] as const)test('preview rejects changed '+changed+' without a whole-source recapture',async()=>{
  const f=fixture({preview:true});f.file('a','definition',{path:'view.base'});for(let n=0;n<32;n++)f.file('z'+n,'text');const index=f.open(),stage=await index.begin();await index.pump(stage.stageId);await index.previewOpen!({previewId:'1'});f.calls.length=0;
  if(changed==='sequence')f.sequence('1');else{const key=changed==='head'?'metadata-head':'config',row=clone(f.records.get('sync_state')!.get(key));if(changed==='head')row.value.version='head2';else row.value.incarnation_id='other';f.seed('sync_state',key,row);}
  await assert.rejects(index.previewBase!({previewId:'1',id:'a'}),{code:'index_preview_expired'});assert.equal(f.previewStats.queries,0);assert.equal(f.calls.some(call=>call.op==='cursor'),false);await index.close();
});
test('preview rejects writer changes after definition point read and frees accepted query',async()=>{
  const f=fixture({preview:true});f.file('a','definition',{path:'view.base'});for(let n=0;n<32;n++)f.file('z'+n,'text');const index=f.open(),stage=await index.begin();await index.pump(stage.stageId);await index.previewOpen!({previewId:'1'});
  f.afterRead((store,key)=>{if(store==='control'&&String(key).endsWith('/row/a'))f.sequence('1');});await assert.rejects(index.previewBase!({previewId:'1',id:'a'}),{code:'index_preview_expired'});assert.equal(f.previewStats.queries,1);assert.equal(f.previewStats.queryFreed,1);assert.equal(f.previewStats.replies,0);await index.close();
});
test('optional preview receipt resource failure never fails committed indexing progress',async()=>{
  const f=fixture({preview:true});for(let n=0;n<33;n++)f.file('f'+n,'text');const index=f.open(),stage=await index.begin();await index.previewOpen!({previewId:'1'});f.previewResource(true);
  const progress=await index.pump(stage.stageId);assert.equal(progress.prepared,32);assert.equal(f.descriptor(progress.snapshot).rows,32);assert.equal(progress.ready,false);await assert.rejects(index.previewOpen!({previewId:'2'}),{code:'index_preview_resource'});
  f.previewResource(false);const ready=await index.pump(stage.stageId);assert.equal(ready.ready,true);await index.publish(stage.stageId);assert.equal((await index.status()).current,true);await index.close();
});
test('failed committed-row transaction retires previews and never admits ahead-of-commit builder facts',async()=>{
  const f=fixture({preview:true});f.file('a','text');const index=f.open(),stage=await index.begin();await index.previewOpen!({previewId:'1'});f.fail();await assert.rejects(index.pump(stage.stageId));assert.equal(f.previewStats.receipts,0);assert.equal(f.descriptor(stage.snapshot).rows,0);
  await assert.rejects(index.previewBase!({previewId:'1',id:'a'}),{code:'index_preview_expired'});await index.discard(stage.stageId);await index.close();
});
test('partial generated preview capability fails closed before stage allocation',()=>{
  const f=fixture({preview:true});for(const key of ['WasmDocumentPreview','WasmDocumentPreviewQuery','WasmDocumentPreviewReply'] as const){const original=f.wasm[key];delete f.wasm[key];assert.throws(()=>f.open(),{code:'index_rebuild_required'});f.wasm[key]=original as any;}assert.equal(f.allocationCalls.length,0);
});

test('factory preview capability stays boolean and legacy methods remain absent',async()=>{
  const legacy=fixture().open();assert.equal(legacy.basePreviewAvailable,false);assert.equal(legacy.previewOpen,undefined);await legacy.close();
  const supported=fixture({preview:true}).open();assert.equal(supported.basePreviewAvailable,true);assert.equal(typeof supported.previewOpen,'function');assert.equal(typeof supported.previewBase,'function');assert.equal(typeof supported.previewClose,'function');await supported.close();
});
test('optional capture retirement rechecks owner and actual stage before touching its old builder',async()=>{
  const f=fixture({preview:true});f.file('a','text');const index=f.open(),stage=await index.begin();await index.previewOpen!({previewId:'1'});let closing:Promise<void>|undefined;
  f.afterPreviewCapture(()=>{f.deny();closing=index.close();});await assert.rejects(index.pump(stage.stageId),{code:'owner_retired'});await closing;
  assert.equal(f.previewStats.freedBuilderTouches,0);await assert.rejects(index.previewOpen!({previewId:'2'}),{code:'index_closed'});
});

test('rebuild during bootstrap cannot capture through a freed still-source-active builder',async()=>{
  const f=fixture({preview:true});for(let n=0;n<33;n++)f.file('f'+n,'text');const index=f.open(),stage=await index.begin();await index.pump(stage.stageId);let rebuilding:Promise<void>|undefined,started=false;
  f.afterRead((store,key)=>{if(!started&&store==='control'&&key==='sequence'){started=true;rebuilding=index.rebuild();}});
  await assert.rejects(index.previewOpen!({previewId:'1'}),error=>error instanceof BrowserVaultError&&['index_preview_expired','index_stage_expired'].includes(error.code));await rebuilding;
  assert.equal(started,true);assert.equal(f.previewStats.freedBuilderTouches,0);assert.equal((await index.status()).rebuildRequired,false);await index.close();
});

// These checks exercise the storage seam only. Opaque WASM doubles do not
// establish parser/query parity or actual browser transaction behavior.
test('pump point fences avoid whole-source recapture for each selected row',async()=>{
  const f=fixture();for(let n=0;n<33;n++)f.file('f'+String(n).padStart(2,'0'),'text');
  const index=f.open();let stage=await index.begin();f.calls.length=0;
  do{stage=await index.pump(stage.stageId);}while(!stage.ready);
  assert.equal(stage.prepared,33);
  assert.equal(f.calls.filter(call=>['metadata','presentation','sync_materialization_refs'].includes(call.store)&&call.op==='cursor').length,0,
    'A pump must fence selected rows rather than cursor-scan the entire authority for every row');
  assert.equal(f.calls.filter(call=>call.store==='sync_materialization_refs'&&call.op==='get').length,66,
    'Every selected row must be point-fenced both when read and in its derived-row writer');
  await index.publish(stage.stageId);assert.equal((await index.status()).current,true);await index.close();
});

for(const changed of ['revision','presentation','missing-descriptor','hidden-descriptor','wrong-descriptor-id'] as const)
test('pump point fence rejects selected '+changed+' with unchanged source sequence',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),stage=await index.begin();
  if(changed==='revision')f.file('a','text',{revision:'r2'});
  else if(changed==='presentation')f.file('a','text',{mtime:7});
  else if(changed==='missing-descriptor')f.records.get('sync_materialization_refs')!.delete('a');
  else {const row=clone(f.records.get('sync_materialization_refs')!.get('a'));if(changed==='hidden-descriptor')row.status='recovery';else row.id='foreign';f.seed('sync_materialization_refs','a',row);}
  await assert.rejects(index.pump(stage.stageId),(error:unknown)=>error instanceof BrowserVaultError&&['index_source_changed','storage_corrupt'].includes(error.code));
  assert.equal(f.descriptor(stage.snapshot).rows,0);assert.equal(f.records.get('control')!.has('document-index:v1/g/'+stage.stageId+'/row/a'),false);
  await index.discard(stage.stageId);await index.close();
});

test('pump point writer rejects raw same-length body tamper after selected read without a sequence change',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),stage=await index.begin();let changed=false;
  f.afterRead((store,key)=>{if(!changed&&store==='content'&&key==='a'){changed=true;const row=clone(f.records.get('content')!.get('a'));row.bytes[0]^=1;f.seed('content','a',row);}});
  await assert.rejects(index.pump(stage.stageId),(error:unknown)=>error instanceof BrowserVaultError&&['index_source_changed','storage_corrupt'].includes(error.code));
  assert.equal(changed,true);assert.equal(f.descriptor(stage.snapshot).rows,0);
  assert.equal(f.records.get('control')!.has('document-index:v1/g/'+stage.stageId+'/row/a'),false);
  await index.discard(stage.stageId);await index.close();
});

for(const changed of ['sequence','index-head','raw-body','descriptor','presentation'] as const)
test('pump point writer rechecks '+changed+' after optional cache lookup',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);
  f.file('a','text',{revision:'r2'});f.sequence('1');const stage=await index.begin();let changedOnce=false;
  f.afterRead((store,key)=>{if(changedOnce||store!=='control'||!String(key).startsWith('document-parse-cache:v1/row/'))return;changedOnce=true;
    if(changed==='sequence')f.sequence('2');
    else if(changed==='index-head'){const row=clone(f.records.get('control')!.get('document-index:v1/catalog'));row.value.head=null;f.seed('control',row.key,row);}
    else if(changed==='raw-body'){const row=clone(f.records.get('content')!.get('a'));row.bytes[0]^=1;f.seed('content','a',row);}
    else if(changed==='presentation')f.file('a','text',{revision:'r2',mtime:7});
    else {const row=clone(f.records.get('sync_materialization_refs')!.get('a'));row.content.metadata.digest[0]^=1;f.seed('sync_materialization_refs','a',row);}
  });
  await assert.rejects(index.pump(stage.stageId),(error:unknown)=>error instanceof BrowserVaultError&&['index_source_changed','index_head_changed','storage_corrupt'].includes(error.code));
  assert.equal(changedOnce,true);assert.equal(f.descriptor(stage.snapshot).rows,0);
  assert.equal(f.records.get('control')!.has('document-index:v1/g/'+stage.stageId+'/row/a'),false);
  await index.discard(stage.stageId);await index.close();
});

test('pump point admission does not replace full publication rejection of unrelated same-sequence tamper',async()=>{
  const f=fixture();f.file('a','first');f.file('b','second');const index=f.open(),previous=await f.build(index);
  const previousHead=f.records.get('control')!.get('document-index:v1/catalog').value.head;
  let stage=await index.begin();do{stage=await index.pump(stage.stageId);}while(!stage.ready);
  f.file('b','second',{mtime:99});const authorityAfterTamper=f.source();
  await assert.rejects(index.publish(stage.stageId),{code:'index_source_changed'});
  const catalog=f.records.get('control')!.get('document-index:v1/catalog').value,status=await index.status();
  assert.equal(catalog.head,previousHead);assert.deepEqual(status.snapshot,previous);assert.equal(status.current,false);
  assert.equal(f.descriptor(stage.snapshot).state,'staging');assert.deepEqual(f.source(),authorityAfterTamper);
  await index.discard(stage.stageId);await index.close();
});

for(const changed of ['metadata','presentation','materialization'] as const)
test('new partial preview rejects unrelated same-sequence '+changed+' tamper',async()=>{
  const f=fixture({preview:true});for(let n=0;n<33;n++)f.file('f'+String(n).padStart(2,'0'),'text');
  const index=f.open(),stage=await index.begin(),progress=await index.pump(stage.stageId);
  assert.equal(progress.prepared,32);assert.equal(progress.ready,false);assert.equal(f.previewStats.captures,0);
  // f32 is outside the prepared prefix. It cannot be protected by a selected
  // row fence, and the preview stamp deliberately keeps the same sequence/head.
  if(changed==='metadata')f.file('f32','text',{path:'changed.md',revision:'r2'});
  else if(changed==='presentation')f.file('f32','text',{mtime:7});
  else {const row=clone(f.records.get('sync_materialization_refs')!.get('f32'));row.content.metadata.digest[0]^=1;f.seed('sync_materialization_refs','f32',row);}
  const authority=f.source();
  await assert.rejects(index.previewOpen!({previewId:'1'}),{code:'index_source_changed'});
  assert.equal(f.previewStats.captures,0);assert.equal(f.previewStats.queries,0);
  assert.equal(f.descriptor(stage.snapshot).rows,32);assert.deepEqual(f.source(),authority);
  await index.discard(stage.stageId);await index.close();
});

test('ordinary note property targets attach exact saved settings from the retained generation without a Base',async()=>{
  const f=fixture({propertyTargets:true}),settings='properties:\n  author:\n    type: relation\n';
  f.file('settings',settings,{path:'Properties.yaml'});f.file('author','---\ntype: author\n---\n');
  const index=f.open();assert.equal(index.propertyTargetsAvailable,true);await f.build(index);const pin=await index.open();
  await index.propertyTargets!({pinId:pin.pinId,options:{currentEntryId:'author',clockMs:0}});
  assert.equal(f.propertyTargetCalls.length,1);assert.deepEqual(f.propertyTargetCalls[0].options.propertyDefinitionsSource,{id:'settings',source:settings});
  assert.equal(f.propertyTargetCalls[0].options.maxRows,10000);assert.equal(f.propertyTargetCalls[0].options.currentEntryId,'author');
  f.file('settings','properties: {}\n',{path:'Properties.yaml',revision:'r2'});f.sequence('1');
  await index.propertyTargets!({pinId:pin.pinId,options:{clockMs:0}});assert.equal(f.propertyTargetCalls[1].options.propertyDefinitionsSource.source,settings);
  await assert.rejects(index.propertyTargets!({pinId:pin.pinId,options:{propertyDefinitionsSource:{id:'settings',source:'properties: {}\n'}}}),{code:'index_property_source_mismatch'});
  await index.closePin(pin.pinId);await assert.rejects(index.propertyTargets!({pinId:pin.pinId}),{code:'index_snapshot_expired'});
  await index.close();
});

test('Base transport captures inline source summary preview and safe seeded randomness beyond64KiB',async()=>{
  const f=fixture(),source=`# ${'\\"'.repeat(40000)}\nviews: []\n`,note=`# Note\n\n\`\`\`base\n${source}\`\`\`\n`;
  f.file('note',note);const index=f.open();await f.build(index);const pin=await index.open();
  const inline={source,startByte:8,endByte:note.length-1};
  const groupKey=`opaque:[${'é'.repeat(40000)}]`;
  const input={pinId:pin.pinId,id:'note',options:{inlineSource:inline,summaryPreviewProperty:'note.rating',summaryPreviewGroupKeyId:groupKey,randomSeed:9007199254740991,clockMs:0}};
  const pending=index.base(input);inline.source='changed';await pending;
  assert.equal(f.baseCalls[0].options.inlineSource.source,source);assert.equal(f.baseCalls[0].options.summaryPreviewProperty,'note.rating');assert.equal(f.baseCalls[0].options.summaryPreviewGroupKeyId,groupKey);assert.equal(f.baseCalls[0].options.randomSeed,9007199254740991);
  for(const options of [{inlineSource:null},{propertyDefinitionsSource:null},{randomSeed:null},{randomSeed:-1},{randomSeed:9007199254740992},{summaryPreviewProperty:null},{summaryPreviewGroupKeyId:null},{summaryPreviewGroupKeyId:'missing-property'}])await assert.rejects(index.base({pinId:pin.pinId,id:'note',options:options as any}),{code:'index_invalid_request'});
  await index.closePin(pin.pinId);await index.close();
});


test('retired global registry is ordinary browser data and explicit global attachments are rejected',async()=>{
  const f=fixture({propertyTargets:true});
  f.file('settings','properties: [this is not a valid registry]\n',{path:'Properties.yaml'});
  f.file('note','---\nscore: 7\n---\nbody');f.file('base','views: [{type: list, name: Notes, source: {kind: untyped}}]\n',{path:'Notes.base'});
  const index=f.open();await f.build(index);const pin=await index.open();
  try {
    await index.propertyTargets!({pinId:pin.pinId,options:{currentEntryId:'note',clockMs:0}});
    await index.base({pinId:pin.pinId,id:'base',options:{clockMs:0}});
    assert.equal(f.propertyTargetCalls[0].options.propertyDefinitionsSource,undefined);
    assert.equal(f.baseCalls[0].options.propertyDefinitionsSource,undefined);
    for(const call of [()=>index.propertyTargets!({pinId:pin.pinId,options:{propertyDefinitionsSource:{id:'settings',source:'properties: {}'}}}),()=>index.base({pinId:pin.pinId,id:'base',options:{propertyDefinitionsSource:{id:'settings',source:'properties: {}'}}})])await assert.rejects(call(),{code:'index_unsupported_property_definitions'});
    assert.equal(f.propertyTargetCalls.length,1);assert.equal(f.baseCalls.length,1);
  } finally {await index.closePin(pin.pinId);await index.close();}
});
