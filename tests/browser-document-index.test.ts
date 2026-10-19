import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {browserDocumentIndex} from '../src/core/browser-document-index.ts';
import type {BrowserDocumentIndexWasm,BrowserIndexHeader} from '../src/core/browser-document-index.ts';
import type {EntryState} from '../src/core/browser-vault.ts';

const authority='11111111-1111-4111-8111-111111111111';
const clone=<T>(v:T):T=>structuredClone(v);
const sha=(bytes:Uint8Array)=>[...createHash('sha256').update(bytes).digest()];
const range=(globalThis as any).IDBKeyRange;
(globalThis as any).IDBKeyRange={bound:(lower:string,upper:string)=>({lower,upper})};
/** Transaction/opaque-WASM doubles test host storage and transport only. No JS
 * parser, resolver or query evaluator stands in for Rust corpus parity. */
function fixture(options:{cacheRows?:number;cacheBytes?:number;cacheRowBytes?:number;evictions?:number;pauseCacheBindOnce?:boolean}={}){
  const records=new Map<string,Map<string,any>>(['control','metadata','presentation','content','sync_materialization_refs'].map(n=>[n,new Map()]));
  const seed=(store:string,key:string,value:any)=>records.get(store)!.set(key,clone(value));
  seed('control','local-store-id',{key:'local-store-id',value:authority});seed('control','sequence',{key:'sequence',value:'0'});
  const calls:{store:string;op:string;key?:any}[]=[],transactions:string[][]=[];let failCommit=false,denied=false,cacheReadUnavailable=false;let afterRead:((store:string,key:any)=>void)|undefined;
  const db:any={transaction(names:string[],mode:string,options:any){
    if(mode==='readwrite')assert.deepEqual(options,{durability:'strict'});transactions.push(names);
    const local=new Map(names.map(n=>[n,clone(records.get(n)!)])),writes=new Set<string>();let pending=0,aborted=false,completed=false,scheduled=false;
    const tx:any={durability:'strict',abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
      objectStore(name:string){assert.ok(local.has(name));
        const request=(op:string,key:any,action:()=>any)=>{const result:any={};calls.push({store:name,op,key});pending++;
          queueMicrotask(()=>{if(aborted)return;try{if(cacheReadUnavailable&&name==='control'&&op==='get'&&String(key).startsWith('document-parse-cache:v1/row/')){cacheReadUnavailable=false;throw new DOMException('fixture optional cache unavailable','UnknownError');}result.result=clone(action());if(op==='get')afterRead?.(name,key);result.onsuccess?.();}catch{tx.abort();}finally{pending--;schedule();}});return result;};
        const put=(row:any,add:boolean)=>request(add?'add':'put',row.key??row.id,()=>{assert.equal(mode,'readwrite');const key=row.key??row.id;if(add&&local.get(name)!.has(key))throw new Error('duplicate');local.get(name)!.set(key,clone(row));writes.add(name);return key;});
        return {get:(key:string)=>request('get',key,()=>local.get(name)!.get(key)),put:(row:any)=>put(row,false),add:(row:any)=>put(row,true),
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
    function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(aborted||completed||pending)return;if(failCommit&&mode==='readwrite'){failCommit=false;tx.abort();return;}completed=true;for(const n of writes)records.set(n,local.get(n)!);tx.oncomplete?.();});}schedule();return tx;
  }};
  let textExtractions=0,reuses=0,cacheBinds=0,pauseCacheBindOnce=!!options.pauseCacheBindOnce;const taskCalls:{sources:{id:string;source:string}[];options:any;snapshot:unknown}[]= [];
  const baseCalls:{id:string;text:string;facts:any[];options:any;viewName?:string|null}[]=[];
  class MockBuilder {
    header:BrowserIndexHeader;rows=new Map<string,any>();constructor(input:string){this.header=JSON.parse(input);this.header.entries=this.header.entries.map(({id,path,kind,revision,deleted})=>({id,path,kind,revision,deleted}));}
    free(){}headerJson(){return JSON.stringify(this.header);}beginPump(){}
    pendingJson(){return JSON.stringify(this.header.entries.filter(e=>e.kind==='file'&&!this.rows.has(e.id)).slice(0,32));}
    addText(id:string,bytes:Uint8Array){textExtractions++;this.rows.set(id,{metadata:null,digest:sha(bytes),textBytes:bytes.length,exclusion:null});}
    cacheKeyJson(id:string,bytes:Uint8Array){if(bytes.includes(0))return 'null';const entry=this.header.entries.find(e=>e.id===id)!,key={scope:this.header.source.localStoreId,mode:entry.path.toLowerCase().endsWith('.md')?'markdown':'plainText',digest:sha(bytes),bytes:bytes.length};return JSON.stringify({key,storageKey:createHash('sha256').update(JSON.stringify(key)).digest('hex')});}
    extractText(id:string,bytes:Uint8Array){this.addText(id,bytes);const {key}=JSON.parse(this.cacheKeyJson(id,bytes));const record=this.rows.get(id),factsChecksum=createHash('sha256').update(JSON.stringify({key,record})).digest('hex');return JSON.stringify({added:true,payload:JSON.stringify({fixtureVersion:1,key,record,factsChecksum})});}
    addCachedText(id:string,expected:string,payload:string){let value;try{value=JSON.parse(payload);}catch{return JSON.stringify({outcome:'corrupt',added:false});}if(value.fixtureVersion!==1)return JSON.stringify({outcome:'unsupported',added:false});const {key}=JSON.parse(expected);if(JSON.stringify(value.key)!==JSON.stringify(key)||value.factsChecksum!==createHash('sha256').update(JSON.stringify({key:value.key,record:value.record})).digest('hex'))return JSON.stringify({outcome:'corrupt',added:false});if(pauseCacheBindOnce){pauseCacheBindOnce=false;return JSON.stringify({outcome:'hit',added:false});}cacheBinds++;this.rows.set(id,clone(value.record));return JSON.stringify({outcome:'hit',added:true});}
    addBinary(id:string){this.rows.set(id,{metadata:null,digest:null,textBytes:0,exclusion:'binary'});}
    addUnreadable(id:string){this.rows.set(id,{metadata:null,digest:null,textBytes:0,exclusion:'unreadable'});}
    addPersisted(id:string,row:string){reuses++;this.rows.set(id,JSON.parse(row));}
    rowJson(id:string){return JSON.stringify(this.rows.get(id));}ready(){return this.header.entries.filter(e=>e.kind==='file').length===this.rows.size;}
    finish(){const header=this.header,rows=this.rows;assert.ok(this.ready());return {
      free(){},headerJson:()=>JSON.stringify(header),snapshotJson:()=>JSON.stringify(header.nextIndex),coverageComplete:()=>true,rowJson:(id:string)=>JSON.stringify(rows.get(id)),
      metadataJson:(id:string)=>JSON.stringify({fixture:'opaque-metadata-transport',id,snapshot:header.nextIndex}),
      tasksJson:(sources:string,options:string)=>{const captured=JSON.parse(sources);for(const source of captured)assert.deepEqual(sha(new TextEncoder().encode(source.source)),rows.get(source.id).digest);taskCalls.push({sources:captured,options:JSON.parse(options),snapshot:header.nextIndex});return JSON.stringify({fixture:'opaque-tasks-transport',snapshot:header.nextIndex});},
      baseJson:(id:string,bytes:Uint8Array,facts:string,options:string,viewName?:string|null)=>{assert.deepEqual(sha(bytes),rows.get(id).digest);baseCalls.push({id,text:new TextDecoder().decode(bytes),facts:JSON.parse(facts),options:JSON.parse(options),viewName});return JSON.stringify({fixture:'opaque-base-transport',snapshot:header.nextIndex});},
      resolveJson:()=>'{"fixture":"opaque-rust-transport"}',backlinksJson:()=>'{"fixture":"opaque-rust-transport"}',
      openLiteral(query:string,token:string){if(query==='fixture-page')assert.ok(token===''||token==='1');let position=0;const observed:string[]=[];const files=header.entries.filter(e=>e.kind==='file'&&rows.get(e.id)?.digest);return {
        free(){},nextReadJson:()=>JSON.stringify(files[position]??null),accept(bytes:Uint8Array){assert.deepEqual(sha(bytes),rows.get(files[position]!.id).digest);observed.push(new TextDecoder().decode(bytes));position++;},finishJson:()=>JSON.stringify({fixture:'projection-transport',observed,snapshot:header.nextIndex,...(query==='fixture-page'?{next:'1'}:{})}),
      };},
    };}
  }
  const policy={formatVersion:1,maxRows:options.cacheRows??100000,maxBytes:options.cacheBytes??64*1024*1024,maxRowBytes:options.cacheRowBytes??1024*1024,maxEvictionsPerWrite:options.evictions??32};
  const wasm={documentParseCachePolicyJson:()=>JSON.stringify(policy),documentParseCacheAdmissionJson:(input:string)=>{const {usage,replacedPayloadBytes:replaced,incomingPayloadBytes:incoming,evictedRows:evicted}=JSON.parse(input),rows=usage.rows-(replaced===null?0:1)+1,bytes=usage.bytes-(replaced??0)+incoming;return JSON.stringify(incoming>policy.maxRowBytes?'skipOversized':rows<=policy.maxRows&&bytes<=policy.maxBytes?'write':evicted===policy.maxEvictionsPerWrite?'skipEvictionLimit':'evictOldest');},documentIndexVersionsJson:()=>'{"schema":1,"extraction":"fixture","resolver":"fixture","query":"fixture"}',WasmDocumentIndexBuilder:MockBuilder} as unknown as BrowserDocumentIndexWasm;
  const open=(clientId='client-a')=>browserDocumentIndex({db,authorityId:authority,clientId,wasm,assertActive(){if(denied)throw Object.assign(new Error('retired'),{code:'owner_retired'});},
    readPublication(tx,done,abort){let entries:any[]|undefined,presentation:any[]|undefined,sequence:string|undefined;
      const finish=()=>{if(entries&&presentation&&sequence!==undefined)done({entries,presentation,sequence});};
      for(const store of ['metadata','presentation']){const list:any[]=[];const request=tx.objectStore(store).openCursor();request.onsuccess=()=>{try{const cursor=request.result;if(cursor){list.push(cursor.value);cursor.continue();}else{if(store==='metadata')entries=list;else presentation=list;finish();}}catch(error){abort(error);}};}
      const request=tx.objectStore('control').get('sequence');request.onsuccess=()=>{sequence=request.result.value;finish();};
    },
  });
  function file(id:string,text:string,opts:{path?:string;revision?:string;binary?:boolean;mtime?:number}={}){
    const bytes=new TextEncoder().encode(text),entry:EntryState={id,path:opts.path??id+'.md',kind:'file',revision:opts.revision??'r1',deleted:false},presentation={id,ctime_ms:1,mtime_ms:opts.mtime??1,size_bytes:bytes.length};
    seed('metadata',id,entry);seed('presentation',id,presentation);
    const content=opts.binary?{kind:'binary',reference:{selected_event:'binary1',manifest:{bytes:String(bytes.length)}}}:{kind:'text',metadata:{byte_length:String(bytes.length),digest:sha(bytes),witness:{identity:{entry_id:id},revision:entry.revision}}};
    seed('sync_materialization_refs',id,{id,status:'normal',entry,presentation,content});if(opts.binary)records.get('content')!.delete(id);else seed('content',id,{id,bytes});
  }
  const source=()=>clone(new Map([...records].filter(([n])=>n!=='control').map(([n,m])=>[n,m])));
  const build=async(index:ReturnType<typeof open>)=>{let stage=await index.begin();do{stage=await index.pump(stage.stageId);}while(!stage.ready);return index.publish(stage.stageId);};
  return {records,calls,transactions,file,open,build,source,seed,baseCalls,taskCalls,stats:()=>({textExtractions,reuses,cacheBinds}),sequence(value:string){seed('control','sequence',{key:'sequence',value});},delete(id:string){for(const store of ['metadata','presentation','content','sync_materialization_refs'])records.get(store)!.delete(id);},fail(){failCommit=true;},cacheUnavailable(){cacheReadUnavailable=true;},deny(){denied=true;},afterRead(action:(store:string,key:any)=>void){afterRead=action;}};
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
  await assert.rejects(b.discard(stage.stageId),{code:'index_stage_expired'});const before=structuredClone(f.records.get('control'));await a.discard(snapshot.generationEpoch);assert.deepEqual(f.records.get('control'),before);await assert.rejects(b.discard(snapshot.generationEpoch),{code:'index_stage_expired'});
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

test('fresh and explicitly rebuilt caches are uninitialized rather than corrupt',async()=>{
  const f=fixture(),index=f.open();let status=await index.status();assert.equal(status.snapshot,null);assert.equal(status.rebuildRequired,false);await index.initialize();status=await index.status();assert.equal(status.rebuildRequired,false);
  await index.rebuild();status=await index.status();assert.equal(status.rebuildRequired,false);assert.equal(status.current,false);await f.build(index);assert.equal((await index.status()).current,true);await index.close();
});

test('normal consumer close retires only its unpublished cache reservations',async()=>{
  const f=fixture();f.file('a','text');const a=f.open(),b=f.open('client-b');await f.build(a);const source=f.source(),stage=await a.begin();await a.pump(stage.stageId);await a.close();
  const status=await b.status();assert.equal(status.current,true);const next=await b.begin();await b.pump(next.stageId);await b.publish(next.stageId);assert.deepEqual(f.source(),source);await b.close();
});

test('own already-published discard validates its exact header before no-op success',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();const snapshot=await f.build(index),pin=await index.open();await index.discard(snapshot.generationEpoch);assert.deepEqual((await index.status()).snapshot,snapshot);assert.deepEqual((await index.search({pinId:pin.pinId,query:'opaque'}) as any).result.value.observed,['text']);
  const header=f.records.get('control')!.get('document-index:v1/g/'+snapshot.generationEpoch+'/header');header.value+=' ';await assert.rejects(index.discard(snapshot.generationEpoch),{code:'index_rebuild_required'});await index.close();
});

test('discard of an already-pruning own published locator makes no cache writes',async()=>{
  const f=fixture();f.file('a','text');const index=f.open(),foreign=f.open('client-b');const older=await f.build(index),current=await f.build(index),pin=await index.open();
  const control=f.records.get('control')!,catalog=control.get('document-index:v1/catalog');catalog.value.generations.find((g:any)=>g.id===older.generationEpoch).state='deleting';control.delete('document-index:v1/g/'+older.generationEpoch+'/header');
  const before=structuredClone(control);await index.discard(older.generationEpoch);assert.deepEqual(f.records.get('control'),before);await assert.rejects(foreign.discard(older.generationEpoch),{code:'index_stage_expired'});
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
  const facts=family();assert.equal(parseRows(f).length,1);
  f.seed('control','pending-checkpoint',{key:'pending-checkpoint',value:'unsent'});f.seed('control','receipt',{key:'receipt',value:'keep'});
  await index.rebuild();assert.deepEqual(family(),facts,'generation rebuild must not clear or rewrite facts');
  assert.equal((await index.status()).snapshot,null);assert.equal([...f.records.get('control')!.keys()].some(key=>key.startsWith('document-index:v1/g/')),false);
  await assert.rejects(index.search({pinId:old.pinId,query:'opaque'}),{code:'index_snapshot_expired'});
  const next=await prepared(index);assert.equal(next.progress.reused,0);assert.deepEqual(next.progress.parseCache,{hits:1,misses:0,unavailable:0,corrupt:0,unsupported:0});assert.notEqual(next.snapshot.generationEpoch,first.snapshot.generationEpoch);
  assert.deepEqual(f.stats(),{textExtractions:1,reuses:0,cacheBinds:1});assert.deepEqual(family(),facts,'a cache hit retains the exact facts/FIFO state');
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

test('completed cache hits remain observable when row-output budget defers insertion to another pump',async()=>{
  const f=fixture({pauseCacheBindOnce:true});f.file('a','same');const index=f.open();await prepared(index);f.file('b','same');f.sequence('1');let stage=await index.begin();stage=await index.pump(stage.stageId);assert.equal(stage.prepared,1);assert.equal(stage.ready,false);assert.equal(stage.progress.reused,1);assert.equal(stage.progress.parseCache.hits,1);stage=await index.pump(stage.stageId);assert.equal(stage.ready,true);assert.equal(stage.progress.parseCache.hits,2);assert.equal(stage.progress.parseCache.misses,0);await index.publish(stage.stageId);await index.close();
});
test('unsupported optional catalog and exhausted FIFO ordinal never fail supported indexing',async()=>{
  for(const value of [{formatVersion:999,authorityId:authority,rows:0,bytes:0,nextOrdinal:'0'},{formatVersion:1,authorityId:authority,rows:0,bytes:0,nextOrdinal:'18446744073709551615'}]){const f=fixture();f.file('a','text');f.seed('control','document-parse-cache:v1/catalog',{key:'document-parse-cache:v1/catalog',value});const source=f.source(),index=f.open();const stage=await prepared(index);assert.equal(stage.progress.parseCache[value.formatVersion===999?'unsupported':'misses'],1);assert.equal((await index.status()).current,true);assert.equal(parseRows(f).length,0);assert.deepEqual(f.source(),source);await index.close();}
});
