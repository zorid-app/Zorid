import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBrowserNormalizedSchema,normalizedTransact} from '../src/core/browser-normalized-idb.ts';
import {createBrowserBinaryStageStore,BINARY_STAGE_USAGE_KEY} from '../src/core/browser-binary-stage-store.ts';
import type {BrowserBinaryStageStoreOptions,BrowserBinaryStageWasm} from '../src/core/browser-binary-stage-store.ts';
import type {BinaryStageRequest} from '../src/core/binary-streams.ts';
// A deterministic transaction fixture and mock WASM boundary exercise persistence only.
// Actual Rust/WASM integrity and browser durability are separate integration gates.
Object.defineProperty(globalThis,'IDBKeyRange',{configurable:true,value:{bound(lower:any,upper:any,open=false,upperOpen=false){return{lower,upper,open,upperOpen};}}});
const authority='11111111-1111-4111-8111-111111111111';
const compare=(a:any,b:any):number=>Array.isArray(a)&&Array.isArray(b)?a.reduce((n,v,i)=>n||compare(v,b[i]),0)||a.length-b.length:a===b?0:a<b?-1:1;
const keyOf=(row:any,path:string|string[])=>Array.isArray(path)?path.map(key=>row[key]):row[path];
/** Transaction fixture stages writes and delivers the result only on complete. It deliberately
 * has no getAll implementation. These are foundation unit checks, not actual-browser evidence. */
function fixture(){
  const records=new Map<string,Map<string,any>>([['control',new Map([[JSON.stringify('local-store-id'),{key:'local-store-id',value:authority}]])]]);
  const paths=new Map<string,string|string[]>([['control','key']]);
  const indexes=new Map<string,Array<{name:string,path:string|string[],unique:boolean}>>();
  const requests:{store:string;operation:string;key?:any}[]=[];
  const transactions:any[]=[];
  let strict=true, hold=false, fail=false, denied=false;
  const db:any={objectStoreNames:{contains(name:string){return records.has(name);}},
    createObjectStore(name:string,options:any){
      records.set(name,new Map());paths.set(name,options.keyPath);indexes.set(name,[]);
      return {createIndex(index:string,path:string|string[],options:any){indexes.get(name)!.push({name:index,path,unique:options.unique});}};
    },
    transaction(names:string[],mode:string,options?:any){
      assert.ok(names.includes('control'));assert.equal(new Set(names).size,names.length);
      if(mode==='readwrite')assert.deepEqual(options,{durability:'strict'});
      const local=new Map(names.map(name=>{if(!records.has(name))throw new Error('missing store');return[name,structuredClone(records.get(name)!)];}));
      const modified=new Set<string>();let pending=0,aborted=false,completed=false,scheduled=false;
      const tx:any={durability:strict?'strict':'relaxed',names,mode,
        abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
        finish(){if(aborted||completed||pending)return;if(hold){return;}if(fail&&mode==='readwrite'){fail=false;tx.abort();return;}
          completed=true;for(const name of modified)records.set(name,local.get(name)!);tx.oncomplete?.();},
        objectStore(name:string){
          if(!local.has(name))throw new Error('store not in transaction');
          const request=(operation:string,key:any,operationFn:()=>any)=>{
            if(aborted||completed)throw new Error('inactive transaction');
            const result:any={};requests.push({store:name,operation,key:structuredClone(key)});pending++;
            queueMicrotask(()=>{if(aborted)return;try{result.result=structuredClone(operationFn());result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{pending--;schedule();}});return result;
          };
          const write=(row:any,add:boolean)=>{
            if(mode!=='readwrite')throw new Error('readonly write');
            const copy=structuredClone(row),key=keyOf(copy,paths.get(name)!);
            return request(add?'add':'put',key,()=>{
              const values=local.get(name)!;
              if(add&&values.has(JSON.stringify(key)))throw new Error('duplicate key');
              for(const index of indexes.get(name)??[])if(index.unique){
                const indexKey=keyOf(copy,index.path);if(indexKey.some?.((part:any)=>part===undefined))continue;
                for(const [existingKey,existing] of values)if(existingKey!==JSON.stringify(key)&&compare(keyOf(existing,index.path),indexKey)===0)throw new Error('unique index');
              }
              values.set(JSON.stringify(key),copy);modified.add(name);return key;
            });
          };
          return {get(key:any){return request('get',key,()=>local.get(name)!.get(JSON.stringify(key)));},
            add(row:any){return write(row,true);},put(row:any){return write(row,false);},
            getKey(key:any){return request('getKey',key,()=>local.get(name)!.has(JSON.stringify(key))?key:undefined);},
            index(index:string){const spec=indexes.get(name)!.find(row=>row.name===index)!;return{get(key:any){return request('index-get',key,()=>[...local.get(name)!.values()].find(row=>compare(keyOf(row,spec.path),key)===0));}};},
            getAll(){assert.fail('byte-bearing aggregate scan is forbidden');},
            openCursor(range?:any,direction='next'){
              const result:any={};requests.push({store:name,operation:'cursor'});pending++;
              const rows=[...local.get(name)!.values()].sort((a,b)=>compare(keyOf(a,paths.get(name)!),keyOf(b,paths.get(name)!)))
                .filter(row=>!range||(compare(keyOf(row,paths.get(name)!),range.lower)>=(range.open?1:0)&&(!range.upper||compare(keyOf(row,paths.get(name)!),range.upper)<=(range.upperOpen?-1:0))));
              if(direction==='prev')rows.reverse();let index=0;
              const step=()=>{if(aborted)return;let continued=false;const row=rows[index];
                result.result=row===undefined?null:{value:structuredClone(row),primaryKey:structuredClone(keyOf(row,paths.get(name)!)),continue(){continued=true;index++;queueMicrotask(step);}};
                result.onsuccess?.();if(!continued){pending--;schedule();}};
              queueMicrotask(step);return result;
            },
          };
        },
      };
      function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;tx.finish();});}
      transactions.push(tx);schedule();return tx;
    },
  };
  createBrowserNormalizedSchema(db);
  const run=<T>(stores:readonly string[],action:Parameters<typeof normalizedTransact<T>>[2],mode:IDBTransactionMode='readwrite',owner=authority)=>
    normalizedTransact<T>(db,{authorityId:owner,stores,mode,assertActive(){if(denied)throw Object.assign(new Error('retired'),{code:'owner_retired'});}},action);
  return {db,records,paths,indexes,requests,transactions,run,
    deny(){denied=true;},relax(){strict=false;},hold(){hold=true;},finish(){hold=false;for(const tx of transactions)tx.finish();},failNextCommit(){fail=true;},
    row(store:string,key:any){return records.get(store)!.get(JSON.stringify(key));},
    seed(store:string,key:any,row:any){records.get(store)!.set(JSON.stringify(key),structuredClone(row));},
  };
}
const encode=(value:any)=>new TextEncoder().encode(JSON.stringify(value));
const hash=(bytes:Uint8Array)=>[...createHash('sha256').update(bytes).digest()];
const encodedEqual=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
function mockWasm(){
  const chunkData=(value:any):Uint8Array=>Array.isArray(value)?new Uint8Array(value):new Uint8Array(value.length).fill(value.fill);
  const metrics={restoredChunks:0,restoredPages:0,pushes:0};
  function decoded(exact:Uint8Array){const value=JSON.parse(new TextDecoder().decode(exact));assert.deepEqual(encode(value),exact);return value;}
  class Record {
    exact:Uint8Array;value:any;
    constructor(value:any){this.value=structuredClone(value);this.exact=encode(value);}
    descriptorJson(){const value=this.value,body=value.body.kind==='chunk'?{kind:'chunk',bytes:chunkData(value.body.bytes).length,digest:hash(chunkData(value.body.bytes))}:value.body;
      const record={payload_bytes:this.exact.length,payload_digest:hash(this.exact),body};return JSON.stringify({scope:value.scope,update_id:value.id,record,summary_digest:hash(encode(record))});}
    payloadBytes(){return this.exact.slice();}chunkBytes(){return this.value.body.kind==='chunk'?chunkData(this.value.body.bytes):undefined;}free(){}
  }
  class Builder {
    scope:any;length=0;pending:any[]=[];pages:any[]=[];hasher=createHash('sha256');ids=new Set<string>();short=false;finished=false;
    constructor(raw:string){this.scope=JSON.parse(raw);}
    payload(id:string,body:any){return new Record({family:'files',format_version:2,scope:this.scope,id,body});}
    pushChunk(id:string,bytes:Uint8Array){
      assert.equal(this.finished,false);assert.ok(!this.short&&bytes.length>0&&bytes.length<=131072&&this.pending.length<128&&!this.ids.has(id));
      const record=this.payload(id,{kind:'chunk',bytes:bytes.every(byte=>byte===bytes[0])?{fill:bytes[0],length:bytes.length}:[...bytes]});this.ids.add(id);this.pending.push({id,bytes:bytes.length,digest:hash(bytes)});this.hasher.update(bytes);this.length+=bytes.length;this.short=bytes.length<131072;metrics.pushes++;return record;
    }
    flushPage(id:string){assert.ok(!this.finished&&this.pending.length>0&&!this.ids.has(id));const page={chunks:structuredClone(this.pending)},record=this.payload(id,{kind:'page',page});
      this.pages.push({id,bytes:String(this.pending.reduce((sum,row)=>sum+row.bytes,0)),digest:hash(encode(page))});this.ids.add(id);this.pending=[];return record;}
    restoreChunkPayload(id:string,exact:Uint8Array){const value=decoded(exact);assert.equal(value.id,id);assert.deepEqual(value.scope,this.scope);assert.equal(value.body.kind,'chunk');metrics.restoredChunks++;return this.pushChunk(id,chunkData(value.body.bytes));}
    restorePagePayload(id:string,exact:Uint8Array){const value=decoded(exact);assert.equal(value.id,id);assert.deepEqual(value.scope,this.scope);assert.equal(value.body.kind,'page');assert.deepEqual(value.body.page.chunks,this.pending);metrics.restoredPages++;return this.flushPage(id);}
    statusJson(){return JSON.stringify({accepted_length:String(this.length),pending_chunks:this.pending.length});}
    finish(){assert.ok(!this.finished&&this.pending.length===0);this.finished=true;const manifest={bytes:String(this.length),digest:[...this.hasher.digest()],pages:structuredClone(this.pages)};return{manifestJson:()=>JSON.stringify(manifest),free(){}};}
    free(){this.finished=true;}
  }
  class Batch {
    scope:any;constructor(raw:string){this.scope=JSON.parse(raw);}pushRecord(record:Record){return this.pushPayload(record.payloadBytes());}
    pushPayload(exact:Uint8Array){const value=decoded(exact);assert.deepEqual(value.scope,this.scope);const checked=JSON.parse(new Record(value).descriptorJson());return JSON.stringify({...checked,payload_bytes:checked.record.payload_bytes,payload_digest:checked.record.payload_digest});}free(){}
  }
  return {wasm:{WasmBinaryBuilder:Builder,WasmAuthoredMetadataBatch:Batch} as BrowserBinaryStageWasm,metrics};
}
const limits={maxFileBytes:'67108864',maxChunkBytes:131072,maxPayloadBytes:1048576,maxStages:4096,maxActiveStages:8,maxSourceBytes:'536870912',maxChunkRecords:4096,maxPageRecords:256};
const initialUsage={version:1,stages:0,activeStages:0,sourcePayloadBytes:'0',chunkRecords:0,pageRecords:0};
const stageRequest=(operationId='operation',length?:string):BinaryStageRequest=>({operationId,target:{kind:'create',entryId:'entry',path:'file.bin'},...(length===undefined?{}:{expectedLength:length})});
function stageFixture(policy:Partial<typeof limits>={}){
  const f=fixture(),w=mockWasm();let counter=0,admitted=true;
  f.seed('control',BINARY_STAGE_USAGE_KEY,{key:BINARY_STAGE_USAGE_KEY,value:initialUsage});
  const options:BrowserBinaryStageStoreOptions={db:f.db,authorityId:authority,scope:{realmId:'realm',vaultId:'vault'},clientId:'client',assertActive(){if(!admitted)throw Object.assign(new Error('retired'),{code:'client_ownership_lost'});},limits:{...limits,...policy},wasm:w.wasm,allocateId:()=>`allocation-${++counter}`};
  return {...f,...w,options,store:createBrowserBinaryStageStore(options),retire(){admitted=false;},usage:()=>f.row('control',BINARY_STAGE_USAGE_KEY).value};
}

test('begin is owner-bound and exact-idempotent; missing shared accounting never infers zero',async()=>{
  const f=stageFixture(),request=stageRequest('begin','3'),a=await f.store.begin(request),b=await f.store.begin(request);
  assert.deepEqual(a,b);assert.equal(f.usage().stages,1);assert.equal(f.usage().activeStages,1);
  await assert.rejects(f.store.begin({...request,expectedLength:'4'}),{code:'binary_operation_conflict'});
  await assert.rejects(f.store.query({...a,clientId:'other'}),{code:'binary_owner_mismatch'});
  const g=stageFixture();g.records.get('control')!.delete(JSON.stringify(BINARY_STAGE_USAGE_KEY));await assert.rejects(g.store.begin(stageRequest()),{code:'binary_usage_unavailable'});
});
test('append writes one shared plaintext source, immutable allocation and cursor atomically with no visibility/outbox',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('append','3')),data=new Uint8Array([1,2,3]);
  const pending=f.store.append(ref,{sequence:0,offset:'0',bytes:data});data.fill(9);const receipt=await pending;
  assert.equal(receipt.acceptedLength,'3');assert.equal(receipt.digest,createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex'));
  assert.equal((await f.store.query(ref)).nextSequence,1);assert.equal(f.records.get('sync_source_payloads')!.size,1);assert.equal(f.records.get('binary_stage_chunks')!.size,1);
  const header=[...f.records.get('sync_source_headers')!.values()][0];assert.equal(header.descriptor.version,1);assert.equal(header.descriptor.metadata.family,'files');assert.equal(header.descriptor.activity,null);
  assert.equal(f.records.get('sync_graph_records')!.size,0);assert.equal(f.records.get('sync_materialization_refs')!.size,0);assert.equal(f.records.has('outbox'),false);
  assert.equal(f.requests.some(row=>row.operation==='getAll'),false);assert.equal(f.usage().chunkRecords,1);
});
test('exact append retry returns original receipt and rejects changed bytes, sequence and offset',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('retry','3')),input={sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])};
  const first=await f.store.append(ref,input),usage=structuredClone(f.usage());assert.deepEqual(await f.store.append(ref,input),first);assert.deepEqual(f.usage(),usage);
  await assert.rejects(f.store.append(ref,{...input,bytes:new Uint8Array([1,2,4])}),{code:'binary_chunk_conflict'});
  await assert.rejects(f.store.append(ref,{sequence:2,offset:'3',bytes:new Uint8Array([1])}),{code:'binary_chunk_conflict'});
  assert.equal((await f.store.query(ref)).acceptedLength,'3');
});
test('normal appends retain builder cache; restart restores each durable source once',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('cache',String(131072*2+3))),chunk=new Uint8Array(131072).fill(5);
  await f.store.append(ref,{sequence:0,offset:'0',bytes:chunk});await f.store.append(ref,{sequence:1,offset:'131072',bytes:chunk});assert.equal(f.metrics.restoredChunks,0);
  f.store.dispose();const resumed=createBrowserBinaryStageStore(f.options);await resumed.append(ref,{sequence:2,offset:'262144',bytes:new Uint8Array([1,2,3])});assert.equal(f.metrics.restoredChunks,2);
  assert.equal((await resumed.query(ref)).acceptedLength,'262147');resumed.dispose();
});
test('aborted append transaction retains old cursor and invalidates its preview builder',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('failed','3'));f.failNextCommit();
  await assert.rejects(f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])}),{code:'storage_failure'});
  assert.equal((await f.store.query(ref)).acceptedLength,'0');assert.equal(f.records.get('sync_source_payloads')!.size,0);assert.equal(f.usage().chunkRecords,0);
  await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});assert.equal((await f.store.query(ref)).acceptedLength,'3');
});
test('seal records exact parameters, verifies durable bytes, and keeps sealed stages inert',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('seal','3'));await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});
  const result=await f.store.seal(ref,{finalLength:'3'});assert.equal(result.sha256,createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex'));assert.equal(f.metrics.restoredChunks,1);
  assert.equal((await f.store.query(ref)).phase,'sealed');assert.equal(f.usage().pageRecords,1);assert.equal(f.usage().activeStages,1);assert.equal(f.records.get('sync_graph_records')!.size,0);
  assert.deepEqual(await f.store.seal(ref,{finalLength:'3'}),result);await assert.rejects(f.store.seal(ref,{finalLength:'3',expectedDigest:'0'.repeat(64)}),{code:'binary_seal_conflict'});
  await assert.rejects(f.store.append(ref,{sequence:1,offset:'3',bytes:new Uint8Array([4])}),{code:'binary_stage_not_receiving'});
});
test('failed seal verification leaves requested parameters durable and never marks sealed',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('bad-source','3'));await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});
  const body=[...f.records.get('sync_source_payloads')!.values()][0],key=[body.realmId,body.vaultId,body.updateId];f.records.get('sync_source_payloads')!.delete(JSON.stringify(key));
  await assert.rejects(f.store.seal(ref,{finalLength:'3'}),{code:'source_body_missing'});const head=f.row('binary_stages',['client',ref.stageId]);assert.equal(head.phase,'receiving');assert.deepEqual(head.sealRequested,{finalLength:'3'});assert.equal(head.finalized,null);
  await assert.rejects(f.store.seal(ref,{finalLength:'3',expectedDigest:'0'.repeat(64)}),{code:'binary_seal_conflict'});assert.equal(f.usage().pageRecords,0);
});
test('wrong whole digest leaves a recoverable requested seal and no tail source',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('digest','1'));await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([7])});
  await assert.rejects(f.store.seal(ref,{finalLength:'1',expectedDigest:'0'.repeat(64)}),{code:'binary_content_mismatch'});assert.equal((await f.store.query(ref)).phase,'receiving');assert.equal(f.usage().pageRecords,0);
});
test('empty source seals without chunk/page and owning handoff never authorizes a commit',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('empty','0')),sealed=await f.store.seal(ref,{finalLength:'0'});
  assert.equal(sealed.sha256,createHash('sha256').digest('hex'));assert.equal(f.usage().chunkRecords,0);assert.equal(f.usage().pageRecords,0);
  const handoff=await f.store.takeSealed(ref);assert.equal(handoff.sourceRefs.length,0);assert.equal((await f.store.query(ref)).phase,'sealed');assert.equal(f.usage().activeStages,1);handoff.built.free();handoff.batch.free();
});
test('sealed source handoff survives reload and pins exact immutable headers and payload existence',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('handoff','3'));await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});await f.store.seal(ref,{finalLength:'3'});f.store.dispose();
  const resumed=createBrowserBinaryStageStore(f.options),handoff=await resumed.takeSealed(ref);assert.equal(handoff.sourceRefs.length,2);assert.equal(JSON.parse(handoff.built.manifestJson()).bytes,'3');assert.equal((await resumed.query(ref)).phase,'sealed');handoff.built.free();handoff.batch.free();
  const body=[...f.records.get('sync_source_payloads')!.values()][0];f.records.get('sync_source_payloads')!.delete(JSON.stringify([body.realmId,body.vaultId,body.updateId]));await assert.rejects(resumed.takeSealed(ref),{code:'source_body_missing'});
});
test('active/total quotas and shared exact-payload budget fail closed without freeing retained bytes',async()=>{
  const f=stageFixture({maxActiveStages:1,maxStages:2}),first=await f.store.begin(stageRequest('one'));
  await assert.rejects(f.store.begin(stageRequest('two')),{code:'binary_quota_exceeded'});await f.store.abort(first);await f.store.abort(first);const second=await f.store.begin(stageRequest('two'));await f.store.abort(second);
  await assert.rejects(f.store.begin(stageRequest('three')),{code:'binary_quota_exceeded'});assert.equal(f.usage().stages,2);assert.equal(f.usage().activeStages,0);
  const g=stageFixture({maxSourceBytes:'1'}),ref=await g.store.begin(stageRequest('bytes','1'));await assert.rejects(g.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1])}),{code:'binary_quota_exceeded'});assert.equal((await g.store.query(ref)).acceptedLength,'0');assert.equal(g.records.get('sync_source_payloads')!.size,0);
  const h=stageFixture(),owned=await h.store.begin(stageRequest('retained','1'));await h.store.append(owned,{sequence:0,offset:'0',bytes:new Uint8Array([1])});const before=h.usage().sourcePayloadBytes;await h.store.abort(owned);assert.equal(h.usage().sourcePayloadBytes,before);assert.equal(h.records.get('sync_source_payloads')!.size,1);
});
test('retirement preserves stages, and parent-authorized commit_requested cannot be aborted',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('owner','0'));await f.store.seal(ref,{finalLength:'0'});
  const head=f.row('binary_stages',['client',ref.stageId]);head.phase='commit_requested';head.generation=String(BigInt(head.generation)+1n);f.seed('binary_stages',['client',ref.stageId],head);
  await assert.rejects(f.store.abort(ref),{code:'binary_stage_not_abortable'});const handoff=await f.store.takeSealed(ref);assert.equal(handoff.stageGeneration,head.generation);handoff.built.free();handoff.batch.free();
  f.store.dispose();await assert.rejects(f.store.query(ref),{code:'client_ownership_lost'});assert.equal(f.row('binary_stages',['client',ref.stageId]).phase,'commit_requested');
});
test('full page emissions use distinct ordinal keys and exact retry survives page boundaries',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('page-boundary',String(128*131072+1))),bytes=new Uint8Array(131072).fill(7);
  let first:any;
  for(let sequence=0;sequence<128;sequence++){const receipt=await f.store.append(ref,{sequence,offset:String(sequence*131072),bytes});if(sequence===127)first=receipt;}
  assert.equal(f.usage().chunkRecords,128);assert.equal(f.usage().pageRecords,1);assert.equal(f.records.get('binary_stage_chunks')!.size,129);
  assert.deepEqual(await f.store.append(ref,{sequence:127,offset:String(127*131072),bytes}),first);
  const tail=await f.store.append(ref,{sequence:128,offset:String(128*131072),bytes:new Uint8Array([8])});
  assert.deepEqual(await f.store.append(ref,{sequence:128,offset:String(128*131072),bytes:new Uint8Array([8])}),tail);
  const row=f.row('binary_stages',['client',ref.stageId]);assert.equal(row.emissionCount,130);
  await f.store.seal(ref,{finalLength:String(128*131072+1)});assert.equal(f.usage().pageRecords,2);assert.equal(f.metrics.restoredChunks,129);assert.equal(f.metrics.restoredPages,1);
});
test('strict durability and late ownership loss never acknowledge writes or erase recovery state',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('durability','1'));f.relax();
  await assert.rejects(f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1])}),{code:'strict_durability_unavailable'});assert.equal(f.row('binary_stages',['client',ref.stageId]).acceptedLength,'0');
  const g=stageFixture(),owned=await g.store.begin(stageRequest('late-owner','1'));g.hold();const append=g.store.append(owned,{sequence:0,offset:'0',bytes:new Uint8Array([1])});
  await new Promise(resolve=>setImmediate(resolve));g.retire();g.finish();await assert.rejects(append,{code:'client_ownership_lost'});assert.equal(g.row('binary_stages',['client',owned.stageId]).acceptedLength,'0');
});
test('malformed durable stage metadata is rejected without mutation',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('corrupt'));
  const original=structuredClone(f.row('binary_stages',['client',ref.stageId])),bad=structuredClone(original);delete bad.finalized;f.seed('binary_stages',['client',ref.stageId],bad);
  await assert.rejects(f.store.query(ref),{code:'storage_corrupt'});assert.deepEqual(f.row('binary_stages',['client',ref.stageId]),bad);
  f.seed('binary_stages',['client',ref.stageId],original);await assert.rejects(f.store.begin({...stageRequest('extra'),extra:'unexpected'} as any),{code:'invalid_binary_request'});
});
test('failed final seal transaction retains requested parameters and never publishes its tail page',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('seal-commit-failure','1'));await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1])});
  const prototype=f.options.wasm.WasmBinaryBuilder.prototype,finish=prototype.finish;
  prototype.finish=function(){const built=finish.call(this);f.failNextCommit();return built;};
  await assert.rejects(f.store.seal(ref,{finalLength:'1'}),{code:'storage_failure'});prototype.finish=finish;
  const durable=f.row('binary_stages',['client',ref.stageId]);assert.equal(durable.phase,'receiving');assert.deepEqual(durable.sealRequested,{finalLength:'1'});assert.equal(durable.finalized,null);assert.equal(f.usage().pageRecords,0);assert.equal(f.records.get('sync_source_payloads')!.size,1);
  await f.store.seal(ref,{finalLength:'1'});assert.equal((await f.store.query(ref)).phase,'sealed');assert.equal(f.usage().pageRecords,1);
});
test('final seal transaction rechecks exact durable source header pins after verification',async()=>{
  const f=stageFixture(),ref=await f.store.begin(stageRequest('pin-race','1'));await f.store.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1])});
  const original=[...f.records.get('sync_source_headers')!.values()][0],key=[original.realmId,original.vaultId,original.updateId],prototype=f.options.wasm.WasmBinaryBuilder.prototype,finish=prototype.finish;
  prototype.finish=function(){const built=finish.call(this),changed=structuredClone(original);changed.descriptor.summary_digest[0]^=1;f.seed('sync_source_headers',key,changed);return built;};
  await assert.rejects(f.store.seal(ref,{finalLength:'1'}),{code:'storage_corrupt'});prototype.finish=finish;
  assert.equal(f.row('binary_stages',['client',ref.stageId]).phase,'receiving');assert.equal(f.usage().pageRecords,0);assert.equal(f.records.get('sync_source_payloads')!.size,1);
});
