import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createBrowserNormalizedSchema, browserNormalizedStores, browserNormalizedKeyPaths, normalizedTransact,
  addImmutableSource, getExactSource, addImmutableMetadata, putNormalizedMetadata, boundedMetadataPage,
  decimalU64, decimalOrder, nextDecimalU64, normalizedLimits,
} from '../src/core/browser-normalized-idb.ts';
import type { SourceInput, SourceHeader, NormalizedStore, MetadataValue } from '../src/core/browser-normalized-idb.ts';

const authority='11111111-1111-4111-8111-111111111111';
const sourceHeader:SourceHeader={realmId:'realm',vaultId:'vault',updateId:'update',descriptor:{payload_digest:[1,2],payload_bytes:3}};
const source:SourceInput={header:sourceHeader,payload:new Uint8Array([1,2,3])};
const sourceStores=['sync_source_headers','sync_source_payloads','sync_source_wires'] as const;
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
        finish(){if(aborted||completed||pending)return;if(hold){return;}if(fail){fail=false;tx.abort();return;}
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
            getAll(){assert.fail('byte-bearing aggregate scan is forbidden');},
            openCursor(range?:any,direction='next'){
              const result:any={};requests.push({store:name,operation:'cursor'});pending++;
              const rows=[...local.get(name)!.values()].sort((a,b)=>compare(keyOf(a,paths.get(name)!),keyOf(b,paths.get(name)!)))
                .filter(row=>!range||compare(keyOf(row,paths.get(name)!),range.lower)>=(range.open?1:0));
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
const add=(f:ReturnType<typeof fixture>,input:SourceInput=source,verify:(input:SourceInput)=>void=()=>{})=>
  f.run<boolean>(sourceStores,(tx,done,abort)=>addImmutableSource(tx,input,verify,done,abort));
const read=(f:ReturnType<typeof fixture>,kind:'payload'|'wire'='payload')=>
  f.run<any>(sourceStores,(tx,done,abort)=>getExactSource(tx,sourceHeader,kind,done,abort),'readonly');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

test('schema is additive, normalized and refuses to overwrite any existing normalized store',()=>{
  const f=fixture();assert.deepEqual([...f.paths.keys()].sort(),['control',...browserNormalizedStores].sort());
  assert.equal(f.paths.has('sync_source_chunks'),false);assert.deepEqual(f.paths.get('sync_source_payloads'),['realmId','vaultId','updateId']);
  assert.deepEqual(f.indexes.get('binary_stages'),[{name:'by_operation',path:['clientId','operationId'],unique:true}]);
  assert.throws(()=>createBrowserNormalizedSchema(f.db),{code:'storage_schema_mismatch'});
});
test('canonical u64 helpers preserve numeric order and reject coercions/overflow',()=>{
  for(const value of ['0','1','9007199254740993','18446744073709551615'])assert.equal(decimalU64(value),value);
  assert.deepEqual(['10','2','0','18446744073709551615'].map(decimalOrder).sort().map(value=>BigInt(value).toString()),['0','2','10','18446744073709551615']);
  for(const value of [0,1n,'','00','01','-1','1.0',' 1','18446744073709551616'])assert.throws(()=>decimalU64(value),{code:'invalid_decimal_u64'});
  assert.equal(nextDecimalU64('9007199254740992'),'9007199254740993');assert.throws(()=>nextDecimalU64('18446744073709551615'),{code:'sequence_exhausted'});
});
test('transaction authority/lease/strict fences run before user work',async()=>{
  for(const variant of ['authority','lease','durability']){
    const f=fixture();let called=false;
    if(variant==='lease')f.deny();if(variant==='durability')f.relax();
    await assert.rejects(f.run(sourceStores,(_tx,done)=>{called=true;done(undefined);},'readwrite',variant==='authority'?'different':authority),
      {code:variant==='authority'?'storage_authority_mismatch':variant==='lease'?'owner_retired':'strict_durability_unavailable'});
    assert.equal(called,false);
  }
});
test('candidate result waits for commit and an aborted commit never acknowledges staged rows',async()=>{
  const f=fixture();f.hold();let settled=false;
  const pending=add(f).then(value=>{settled=true;return value;});await flush();assert.equal(settled,false);assert.equal(f.row('sync_source_headers',['realm','vault','update']),undefined);
  f.finish();assert.equal(await pending,true);assert.ok(f.row('sync_source_headers',['realm','vault','update']));
  const g=fixture();g.failNextCommit();await assert.rejects(add(g),{code:'storage_failure'});assert.equal(g.row('sync_source_headers',['realm','vault','update']),undefined);
});
test('async transaction/verification callbacks abort rather than hold a transaction across await',async()=>{
  const f=fixture();await assert.rejects(f.run(sourceStores,async()=>{}),{code:'async_storage_callback'});
  await assert.rejects(add(f,source,async()=>{}),{code:'async_storage_callback'});assert.equal(f.row('sync_source_headers',['realm','vault','update']),undefined);
});
test('immutable source exact retry preserves bytes and changed payload/header cannot overwrite',async()=>{
  const f=fixture();let checks=0;assert.equal(await add(f,source,()=>{checks++;}),true);assert.equal(await add(f,source,()=>{checks++;}),false);assert.equal(checks,2);
  assert.deepEqual((await read(f)).bytes,new Uint8Array([1,2,3]));
  await assert.rejects(add(f,{...source,payload:new Uint8Array([1,2,4])}),{code:'immutable_source_conflict'});
  await assert.rejects(add(f,{...source,header:{...sourceHeader,descriptor:{different:true}}}),{code:'immutable_source_conflict'});
  assert.deepEqual((await read(f)).bytes,new Uint8Array([1,2,3]));
});
test('wire addition reuses one immutable payload and verifies binding against retained exact plaintext',async()=>{
  const f=fixture();await add(f);let verified=false;
  assert.equal(await add(f,{header:sourceHeader,wire:new Uint8Array([9,8])},input=>{assert.deepEqual(input.payload,new Uint8Array([1,2,3]));assert.deepEqual(input.wire,new Uint8Array([9,8]));verified=true;}),true);
  assert.equal(verified,true);assert.deepEqual((await read(f,'wire')).bytes,new Uint8Array([9,8]));assert.deepEqual((await read(f)).bytes,new Uint8Array([1,2,3]));
  await assert.rejects(add(f,{header:sourceHeader,wire:new Uint8Array([9,7])}),{code:'immutable_source_conflict'});
});
test('mandatory host verifier can reject before any source writes and supplied buffers are snapshotted',async()=>{
  const f=fixture();await assert.rejects(add(f,source,()=>{throw Object.assign(new Error('WASM rejected'),{code:'binding_rejected'});}),{code:'binding_rejected'});
  assert.equal(f.requests.some(row=>row.operation==='add'),false);
  const input={header:structuredClone(sourceHeader),payload:new Uint8Array([1,2,3])};
  await f.run(sourceStores,(tx,done,abort)=>{addImmutableSource(tx,input,()=>{},done,abort);input.payload.fill(8);input.header.descriptor={changed:true};});
  assert.deepEqual((await read(f)).bytes,new Uint8Array([1,2,3]));assert.deepEqual((await read(f)).header.descriptor,sourceHeader.descriptor);
});
test('payload/wire limits are separate and exact cap remains admitted',async()=>{
  const f=fixture();await add(f,{header:sourceHeader,payload:new Uint8Array(normalizedLimits.payload),wire:new Uint8Array(normalizedLimits.wire)});
  const g=fixture();for(const kind of ['payload','wire'] as const)await assert.rejects(add(g,{header:sourceHeader,[kind]:new Uint8Array(normalizedLimits[kind]+1)}),{code:'source_body_too_large'});
  assert.equal(g.requests.some(row=>row.operation==='add'),false);
});
test('missing and orphaned backing rows fail explicitly, without replacing or repairing them',async()=>{
  const f=fixture();assert.equal(await read(f),null);f.seed('sync_source_headers',['realm','vault','update'],sourceHeader);
  await assert.rejects(read(f),{code:'source_body_missing'});
  const g=fixture();g.seed('sync_source_wires',['realm','vault','update'],{realmId:'realm',vaultId:'vault',updateId:'update',bytes:new Uint8Array([9])});
  await assert.rejects(add(g),{code:'storage_corrupt'});assert.equal(g.row('sync_source_headers',['realm','vault','update']),undefined);
});
test('guard loss after authority read aborts source insertion at a later request callback',async()=>{
  const f=fixture();await assert.rejects(f.run(sourceStores,(tx,done,abort)=>{addImmutableSource(tx,source,()=>{},done,abort);f.deny();}),{code:'owner_retired'});
  assert.equal(f.row('sync_source_headers',['realm','vault','update']),undefined);
});
test('metadata immutable retry and mutable stage updates share strict transaction semantics',async()=>{
  const f=fixture(),record={realmId:'realm',vaultId:'vault',updateId:'r',descriptor:{kind:'chunk',bytes:3}};
  const insert=(row:MetadataValue)=>f.run(['sync_graph_records'],(tx,done,abort)=>addImmutableMetadata(tx,'sync_graph_records',row,done,abort));
  assert.equal(await insert(record),true);assert.equal(await insert(record),false);
  await assert.rejects(insert({...record,descriptor:{kind:'chunk',bytes:4}}),{code:'immutable_metadata_conflict'});
  const stage={clientId:'client',stageId:'stage',operationId:'operation',phase:'receiving'};
  await f.run(['binary_stages'],(tx,done,abort)=>putNormalizedMetadata(tx,'binary_stages',stage,()=>done(undefined),abort));
  await f.run(['binary_stages'],(tx,done,abort)=>putNormalizedMetadata(tx,'binary_stages',{...stage,phase:'sealed'},()=>done(undefined),abort));
  assert.equal(f.row('binary_stages',['client','stage']).phase,'sealed');
  await assert.rejects(f.run(['binary_stages'],(tx,done,abort)=>putNormalizedMetadata(tx,'binary_stages',{...stage,stageId:'other'},()=>done(undefined),abort)),{code:'storage_failure'});
});
test('metadata pagination is byte/count bounded and never fetches source body stores',async()=>{
  const f=fixture();for(let i=0;i<4;i++)f.seed('sync_graph_records',['realm','vault',String(i)],{realmId:'realm',vaultId:'vault',updateId:String(i),label:'é'.repeat(8)});
  const page=await f.run<any>(['sync_graph_records'],(tx,done,abort)=>boundedMetadataPage(tx,'sync_graph_records',{limit:2,maxBytes:1024},done,abort),'readonly');
  assert.equal(page.items.length,2);assert.equal(page.complete,false);assert.deepEqual(page.lastKey,['realm','vault','1']);
  const next=await f.run<any>(['sync_graph_records'],(tx,done,abort)=>boundedMetadataPage(tx,'sync_graph_records',{limit:2,maxBytes:1024,range:{lower:page.lastKey,open:true} as unknown as IDBKeyRange},done,abort),'readonly');
  assert.equal(next.items.length,2);assert.equal(next.complete,true);
  const byteBound=await f.run<any>(['sync_graph_records'],(tx,done,abort)=>boundedMetadataPage(tx,'sync_graph_records',{limit:100,maxBytes:page.bytes-1},done,abort),'readonly');
  assert.equal(byteBound.items.length,1);assert.ok(byteBound.bytes<=page.bytes-1);
  assert.equal(f.requests.some(row=>row.store==='sync_source_payloads'||row.store==='sync_source_wires'),false);
  await assert.rejects(f.run(['sync_graph_records'],(tx,done,abort)=>boundedMetadataPage(tx,'sync_graph_records',{limit:1,maxBytes:1},done,abort),'readonly'),{code:'storage_metadata_page_too_small'});
});
test('body bytes, huge metadata and malformed sequence ordering cannot hide in metadata rows',async()=>{
  const f=fixture();for(const value of [new Uint8Array([1]),new Date(),{body:new Uint8Array([1])},{body:'x'.repeat(normalizedLimits.metadataRow+1)},Array(2)]){
    await assert.rejects(f.run(['sync_graph_records'],(tx,done,abort)=>addImmutableMetadata(tx,'sync_graph_records',value as MetadataValue,done,abort)),error=>['invalid_storage_metadata','storage_metadata_too_large'].includes((error as any).code));
  }
  await assert.rejects(f.run(['binary_stage_chunks'],(tx,done,abort)=>addImmutableMetadata(tx,'binary_stage_chunks',{clientId:'c',stageId:'s',sequenceOrder:'01'},done,abort)),{code:'invalid_decimal_u64'});
  await assert.rejects(f.run(['sync_source_headers'],(tx,done,abort)=>boundedMetadataPage(tx,'sync_source_payloads' as any,{limit:1,maxBytes:100},done,abort),'readonly'),{code:'invalid_metadata_store'});
});

/** Largest whole-event batch fitting the existing files-v2 1 MiB plaintext cap.
 * All creates use distinct identities; manifests have <=128 bounded page refs.
 * The page bodies are legitimately missing dependencies, not invented proofs.
 * This is a storage-boundary fixture, not a Rust planner/runtime verification. */
// File-family payloads retain their 1 MiB bound; Text envelopes have a larger budget.
function upperEventDescriptor(){
  const digest=Array(32).fill(0);
  const event=(index:number,pages=128)=>({id:`create-${index}`,identity:{entry_id:`file-${index}`,bootstrap_id:`create-${index}`},parents:[],effect:{kind:'create',entry_kind:'file',location:{parent:null,name:`file-${index}.bin`},content:{kind:'binary',manifest:{bytes:pages,digest,pages:Array.from({length:pages},(_,page)=>({id:`page-${index}-${page}-`.padEnd(128,'x'),bytes:1,digest}))}}}});
  const events:ReturnType<typeof event>[]=[];
  const payload={family:'files',format_version:2,scope:{realm_id:'realm',vault_id:'vault'},id:'upper-batch',body:{kind:'events',events}};
  const encoded=()=>new TextEncoder().encode(JSON.stringify(payload));
  while(events.length<128){
    const index=events.length;events.push(event(index));
    if(encoded().byteLength<=1024*1024)continue;
    events.pop();let low=0,high=127;
    while(low<high){const count=Math.ceil((low+high)/2);events.push(event(index,count));const fits=encoded().byteLength<=1024*1024;events.pop();if(fits)low=count;else high=count-1;}
    if(low)events.push(event(index,low));break;
  }
  const bytes=encoded();
  const sha=(bytes:Uint8Array|string)=>[...createHash('sha256').update(bytes).digest()];
  const record={payload_bytes:bytes.byteLength,payload_digest:sha(bytes),body:structuredClone(payload.body)};
  // Independent fixture oracle in the portable struct's declared field order,
  // before transport string conversion. The storage normalizer never hashes or
  // reconstructs this supplied commitment. Rust/WASM validation is a later gate.
  const summary=sha(JSON.stringify(record));
  for(const event of record.body.events){const manifest=event.effect.content.manifest;(manifest as any).bytes=String(manifest.bytes);for(const page of manifest.pages)(page as any).bytes=String(page.bytes);}
  return {header:{realmId:'realm',vaultId:'vault',updateId:'upper-batch',descriptor:{kind:'files',scope:payload.scope,update_id:payload.id,record,summary_digest:summary}} as SourceHeader,payload:bytes,summary};
}
test('maximum bounded event descriptor fits one normalized metadata row and page',async()=>{
  const f=fixture(),input=upperEventDescriptor();
  const rowBytes=new TextEncoder().encode(JSON.stringify(input.header)).byteLength;
  assert.ok(input.payload.byteLength<=normalizedLimits.payload);
  assert.ok(rowBytes>1024*1024,'manifest decimal strings plus envelope can exceed the old entire page budget');
  assert.ok(rowBytes<=normalizedLimits.metadataRow);
  let nodes=0;const count=(value:any)=>{nodes++;if(value&&typeof value==='object')for(const child of Object.values(value))count(child);};count(input.header);
  assert.ok(nodes>65536,'valid event metadata exceeds the old unrelated node count');
  let verified=0;
  await add(f,input,()=>{verified++;});assert.equal(verified,1);
  const page=await f.run<any>(['sync_source_headers'],(tx,done,abort)=>boundedMetadataPage(tx,'sync_source_headers',{limit:2,maxBytes:normalizedLimits.metadataPage},done,abort),'readonly');
  assert.equal(page.items.length,1);assert.equal(page.complete,true);assert.ok(page.bytes<=normalizedLimits.metadataPage);
  assert.deepEqual(page.items[0].descriptor.summary_digest,input.summary,'canonical key sorting must preserve the supplied Rust commitment');
});
test('metadata row cap plus one byte rejects before immutable storage mutation',async()=>{
  const f=fixture(),row={realmId:'realm',vaultId:'vault',updateId:'over-limit',padding:''};
  const emptyBytes=new TextEncoder().encode(JSON.stringify(row)).byteLength;
  row.padding='x'.repeat(normalizedLimits.metadataRow+1-emptyBytes);
  assert.equal(new TextEncoder().encode(JSON.stringify(row)).byteLength,normalizedLimits.metadataRow+1);
  await assert.rejects(f.run(['sync_graph_records'],(tx,done,abort)=>addImmutableMetadata(tx,'sync_graph_records',row,done,abort)),{code:'storage_metadata_too_large'});
  assert.equal(f.row('sync_graph_records',['realm','vault','over-limit']),undefined);
});

test('terminal witness runs before settlement and throwing witness still settles conservatively',async()=>{
  for(const outcome of ['abort','complete'] as const)for(const throws of [false,true]){
    const order:string[]=[],sentinel=new Error('terminal hook failed');
    let tx:any;
    const db:any={transaction(){
      tx={durability:'strict',objectStore(){return {get(){const request:any={result:{value:authority}};queueMicrotask(()=>request.onsuccess());return request;}};}};
      return tx;
    }};
    const pending=normalizedTransact(db,{authorityId:authority,stores:['control'],mode:'readwrite',assertActive(){},onTerminal(value){
      order.push(value);if(throws)throw sentinel;
    }},(_tx,done)=>done('candidate'));
    const settled=pending.then(value=>{order.push('resolved');return value;},error=>{order.push('rejected');throw error;});
    await Promise.resolve();tx[outcome==='abort'?'onabort':'oncomplete']();
    // Simulate a native event microtask checkpoint before the next registered listener.
    queueMicrotask(()=>order.push('later listener'));
    if(throws)await assert.rejects(settled,error=>error===sentinel);
    else if(outcome==='abort')await assert.rejects(settled,{code:'storage_failure'});
    else assert.equal(await settled,'candidate');
    assert.deepEqual(order,[outcome,outcome==='complete'&&!throws?'resolved':'rejected','later listener']);
  }
});
