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
function fixture(){
  const records=new Map<string,Map<string,any>>(['control','metadata','presentation','content','sync_materialization_refs'].map(n=>[n,new Map()]));
  const seed=(store:string,key:string,value:any)=>records.get(store)!.set(key,clone(value));
  seed('control','local-store-id',{key:'local-store-id',value:authority});seed('control','sequence',{key:'sequence',value:'0'});
  const calls:{store:string;op:string;key?:any}[]=[],transactions:string[][]=[];let failCommit=false,denied=false;
  const db:any={transaction(names:string[],mode:string,options:any){
    if(mode==='readwrite')assert.deepEqual(options,{durability:'strict'});transactions.push(names);
    const local=new Map(names.map(n=>[n,clone(records.get(n)!)])),writes=new Set<string>();let pending=0,aborted=false,completed=false,scheduled=false;
    const tx:any={durability:'strict',abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
      objectStore(name:string){assert.ok(local.has(name));
        const request=(op:string,key:any,action:()=>any)=>{const result:any={};calls.push({store:name,op,key});pending++;
          queueMicrotask(()=>{if(aborted)return;try{result.result=clone(action());result.onsuccess?.();}catch{tx.abort();}finally{pending--;schedule();}});return result;};
        const put=(row:any,add:boolean)=>request(add?'add':'put',row.key??row.id,()=>{assert.equal(mode,'readwrite');const key=row.key??row.id;if(add&&local.get(name)!.has(key))throw new Error('duplicate');local.get(name)!.set(key,clone(row));writes.add(name);return key;});
        return {get:(key:string)=>request('get',key,()=>local.get(name)!.get(key)),put:(row:any)=>put(row,false),add:(row:any)=>put(row,true),
          getAll(){assert.fail('aggregate source/control scan is forbidden');},
          delete:(key:string)=>request('delete',key,()=>{local.get(name)!.delete(key);writes.add(name);}),
          openKeyCursor(bounds?:any){return this.openCursor(bounds);},
          openCursor(bounds?:any){if(name==='control')assert.ok(bounds?.lower?.startsWith('document-index:v1/g/'),'control cursor must have an exact derived prefix');
            calls.push({store:name,op:'cursor',key:bounds});const result:any={};pending++;const rows=[...local.get(name)!].filter(([key])=>!bounds||key>=bounds.lower&&key<=bounds.upper).sort(([a],[b])=>a<b?-1:1);let pos=0;
            const step=()=>{if(aborted)return;let continued=false;const row=rows[pos];result.result=row?{primaryKey:row[0],value:clone(row[1]),continue(){continued=true;pos++;queueMicrotask(step);},delete(){return request('delete',row[0],()=>{local.get(name)!.delete(row[0]);writes.add(name);});}}:null;
              try{result.onsuccess?.();}catch{tx.abort();}finally{if(!continued){pending--;schedule();}}};queueMicrotask(step);return result;
          },
        };
      },
    };
    function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(aborted||completed||pending)return;if(failCommit&&mode==='readwrite'){failCommit=false;tx.abort();return;}completed=true;for(const n of writes)records.set(n,local.get(n)!);tx.oncomplete?.();});}schedule();return tx;
  }};
  let textExtractions=0,reuses=0;const baseCalls:{id:string;text:string;facts:any[];options:any;viewName?:string|null}[]=[];
  class MockBuilder {
    header:BrowserIndexHeader;rows=new Map<string,any>();constructor(input:string){this.header=JSON.parse(input);}
    free(){}headerJson(){return JSON.stringify(this.header);}beginPump(){}
    pendingJson(){return JSON.stringify(this.header.entries.filter(e=>e.kind==='file'&&!this.rows.has(e.id)).slice(0,32));}
    addText(id:string,bytes:Uint8Array){textExtractions++;this.rows.set(id,{metadata:null,digest:sha(bytes),textBytes:bytes.length,exclusion:null});}
    addBinary(id:string){this.rows.set(id,{metadata:null,digest:null,textBytes:0,exclusion:'binary'});}
    addUnreadable(id:string){this.rows.set(id,{metadata:null,digest:null,textBytes:0,exclusion:'unreadable'});}
    addPersisted(id:string,row:string){reuses++;this.rows.set(id,JSON.parse(row));}
    rowJson(id:string){return JSON.stringify(this.rows.get(id));}ready(){return this.header.entries.filter(e=>e.kind==='file').length===this.rows.size;}
    finish(){const header=this.header,rows=this.rows;assert.ok(this.ready());return {
      free(){},headerJson:()=>JSON.stringify(header),snapshotJson:()=>JSON.stringify(header.nextIndex),coverageComplete:()=>true,rowJson:(id:string)=>JSON.stringify(rows.get(id)),
      metadataJson:(id:string)=>JSON.stringify({fixture:'opaque-metadata-transport',id,snapshot:header.nextIndex}),
      baseJson:(id:string,bytes:Uint8Array,facts:string,options:string,viewName?:string|null)=>{assert.deepEqual(sha(bytes),rows.get(id).digest);baseCalls.push({id,text:new TextDecoder().decode(bytes),facts:JSON.parse(facts),options:JSON.parse(options),viewName});return JSON.stringify({fixture:'opaque-base-transport',snapshot:header.nextIndex});},
      resolveJson:()=>'{"fixture":"opaque-rust-transport"}',backlinksJson:()=>'{"fixture":"opaque-rust-transport"}',
      openLiteral(query:string,token:string){if(query==='fixture-page')assert.ok(token===''||token==='1');let position=0;const observed:string[]=[];const files=header.entries.filter(e=>e.kind==='file'&&rows.get(e.id)?.digest);return {
        free(){},nextReadJson:()=>JSON.stringify(files[position]??null),accept(bytes:Uint8Array){assert.deepEqual(sha(bytes),rows.get(files[position]!.id).digest);observed.push(new TextDecoder().decode(bytes));position++;},finishJson:()=>JSON.stringify({fixture:'projection-transport',observed,snapshot:header.nextIndex,...(query==='fixture-page'?{next:'1'}:{})}),
      };},
    };}
  }
  const wasm={documentIndexVersionsJson:()=>'{"schema":1,"extraction":"fixture","resolver":"fixture","query":"fixture"}',WasmDocumentIndexBuilder:MockBuilder} as unknown as BrowserDocumentIndexWasm;
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
  return {records,calls,transactions,file,open,build,source,seed,baseCalls,stats:()=>({textExtractions,reuses}),sequence(value:string){seed('control','sequence',{key:'sequence',value});},delete(id:string){for(const store of ['metadata','presentation','content','sync_materialization_refs'])records.get(store)!.delete(id);},fail(){failCommit=true;},deny(){denied=true;}};
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
test('unchanged exact source witnesses reuse Rust records while moves re-extract',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);await f.build(index);assert.equal(f.stats().textExtractions,1);assert.equal(f.stats().reuses,1);
  f.file('a','text',{path:'move.md'});await f.build(index);assert.equal(f.stats().textExtractions,2);await index.close();
});
test('cache corruption requires explicit rebuild and rebuild expires pins without changing source',async()=>{
  const f=fixture();f.file('a','text');const index=f.open();await f.build(index);const pin=await index.open(),source=f.source();
  const cache=[...f.records.get('control')!].find(([key])=>key.includes('/row/'))!;cache[1].value.record='{"metadata":null}';
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
