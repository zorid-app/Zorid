import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserNormalizedSchema, normalizedTransact, decimalOrder, addImmutableSource, getExactSource } from '../src/core/browser-normalized-idb.ts';
import { createBrowserManagedSchema, browserManagedStores, browserManagedIndexes, selectManagedRetryPage, readManagedRetrySource, createBrowserManagedRecords } from '../src/core/browser-managed-records.ts';
import type { ManagedReceiptHead } from '../src/core/browser-managed-records.ts';
const savedRange=globalThis.IDBKeyRange;
globalThis.IDBKeyRange={bound(lower:any,upper:any,lowerOpen=false,upperOpen=false){return {lower,upper,lowerOpen,upperOpen};}} as any;
test.after(()=>{globalThis.IDBKeyRange=savedRange;});
const authority='11111111-1111-4111-8111-111111111111';
const sourceHeader:SourceHeader={realmId:'realm',vaultId:'vault',updateId:'update',descriptor:{payload_digest:[1,2],payload_bytes:3}};
const source:SourceInput={header:sourceHeader,payload:new Uint8Array([1,2,3])};
const sourceStores=['sync_source_headers','sync_source_payloads','sync_source_wires'] as const;
const compare=(a:any,b:any):number=>Array.isArray(a)!==Array.isArray(b)?(Array.isArray(a)?1:-1):Array.isArray(a)&&Array.isArray(b)?a.reduce((n,v,i)=>n||compare(v,b[i]),0)||a.length-b.length:a===b?0:a<b?-1:1;
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
            index(indexName:string){
              const descriptor=indexes.get(name)?.find(value=>value.name===indexName);if(!descriptor)throw new Error('missing index');
              return {openCursor(range?:any){return cursorRequest(descriptor.path,range);}};
            },
            openCursor(range?:any,direction='next'){return cursorRequest(paths.get(name)!,range,direction);},
          };
          function cursorRequest(path:string|string[],range?:any,direction='next'){
              const result:any={};requests.push({store:name,operation:'cursor'});pending++;
              const rows=[...local.get(name)!.values()].sort((a,b)=>compare(keyOf(a,path),keyOf(b,path)))
                .filter(row=>!range||(compare(keyOf(row,path),range.lower)>=(range.lowerOpen?1:0)&&compare(keyOf(row,path),range.upper)<=(range.upperOpen?-1:0)));
              if(direction==='prev')rows.reverse();let index=0;
              const step=()=>{if(aborted)return;let continued=false;const row=rows[index];
                result.result=row===undefined?null:{value:structuredClone(row),primaryKey:structuredClone(keyOf(row,paths.get(name)!)),continue(){if(continued)throw new Error('cursor already continued');continued=true;index++;pending++;queueMicrotask(step);}};
                result.onsuccess?.();pending--;schedule();};
              queueMicrotask(step);return result;
            }
        },
      };
      function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;tx.finish();});}
      transactions.push(tx);schedule();return tx;
    },
  };
  createBrowserNormalizedSchema(db);createBrowserManagedSchema(db);
  const run=<T>(stores:readonly string[],action:Parameters<typeof normalizedTransact<T>>[2],mode:IDBTransactionMode='readwrite',owner=authority)=>
    normalizedTransact<T>(db,{authorityId:owner,stores,mode,assertActive(){if(denied)throw Object.assign(new Error('retired'),{code:'owner_retired'});}},action);
  return {db,records,paths,indexes,requests,transactions,run,
    deny(){denied=true;},relax(){strict=false;},hold(){hold=true;},finish(){hold=false;for(const tx of transactions)tx.finish();},failNextCommit(){fail=true;},
    row(store:string,key:any){return records.get(store)!.get(JSON.stringify(key));},
    seed(store:string,key:any,row:any){records.get(store)!.set(JSON.stringify(key),structuredClone(row));},
  };
}
const collection={realmId:'realm',vaultId:'vault',owner:'app:tasks',collection:'items.v1'};
const eligible=(status:string)=>!['accepted','integrity_conflict','invalid_operation'].includes(status);
function receipt(id:string,bytes=1,status='waiting_dependencies'):ManagedReceiptHead {
  return {...collection,updateId:id,record:'record:+1',generation:'generation.1',restores:null,revision:'receipt-1',status,payloadBytes:String(bytes)};
}
function seedReceipt(f:ReturnType<typeof fixture>,row:ManagedReceiptHead){f.seed('managed_receipts',[row.realmId,row.vaultId,row.updateId],row);}
function host(f:ReturnType<typeof fixture>){return {db:f.db,authorityId:authority,assertActive(){}};}
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};

test('fresh schema declares compound identities, nonunique commitments and stable retry ordering',()=>{
  const f=fixture();assert.equal(browserManagedStores.length,6);
  assert.deepEqual(f.paths.get('managed_records'),['realmId','vaultId','owner','collection','record','generation']);
  assert.deepEqual(f.indexes.get('managed_operation_sources'),[{name:'by_operation',path:[...browserManagedIndexes.managed_operation_sources[0].keyPath],unique:false}]);
  assert.throws(()=>createBrowserManagedSchema(f.db),{code:'storage_schema_mismatch'});
});

test('retry count is 16 and exclusive continuation advances beyond waiting prefix',async()=>{
  const f=fixture();for(let i=1;i<=17;i++)seedReceipt(f,receipt(String(i).padStart(3,'0')));
  const first=await selectManagedRetryPage(host(f),collection,null,eligible);
  assert.equal(first.heads.length,16);assert.equal(first.next,'016');assert.equal(first.exhausted,false);assert.equal(first.inputBytes,'16');
  const last=await selectManagedRetryPage(host(f),collection,first.next,eligible);
  assert.deepEqual(last.heads.map(row=>row.updateId),['017']);assert.equal(last.next,null);assert.equal(last.exhausted,true);
  assert.ok(f.requests.every(row=>row.store!=='sync_source_payloads'));
});

test('metadata length stops before fetching excluded body, exact 1 MiB is admitted',async()=>{
  const f=fixture();seedReceipt(f,receipt('a',700*1024));seedReceipt(f,receipt('b',400*1024));
  const first=await selectManagedRetryPage(host(f),collection,null,eligible);
  assert.deepEqual(first.heads.map(row=>row.updateId),['a']);assert.equal(first.next,'a');assert.equal(first.exhausted,false);
  const second=await selectManagedRetryPage(host(f),collection,first.next,eligible);
  assert.equal(second.inputBytes,String(400*1024));assert.equal(second.exhausted,true);
  const other=fixture();seedReceipt(other,receipt('a',1024*1024));
  assert.equal((await selectManagedRetryPage(host(other),collection,null,eligible)).inputBytes,'1048576');
  assert.ok(f.requests.every(row=>row.operation!=='get' || row.store==='control'));
});

test('retry delegates eligibility and isolates collection ranges, retaining decimal lengths',async()=>{
  const f=fixture();seedReceipt(f,receipt('a',1,'accepted'));seedReceipt(f,receipt('b',1,'invalid_operation'));
  seedReceipt(f,receipt('c',1,'capacity'));seedReceipt(f,{...receipt('d'),collection:'other'});
  const page=await selectManagedRetryPage(host(f),collection,null,eligible);
  assert.deepEqual(page.heads.map(row=>row.updateId),['c']);assert.equal(page.inputBytes,'1');
  await assert.rejects(selectManagedRetryPage(host(f),collection,null,async()=>true as any),{code:'async_storage_callback'});
});

test('retry metadata corruption fails closed before any body or writes',async()=>{
  const f=fixture();seedReceipt(f,{...receipt('a'),payloadBytes:'01'});
  await assert.rejects(selectManagedRetryPage(host(f),collection,null,eligible),{code:'invalid_decimal_u64'});
  assert.ok(f.requests.every(row=>row.operation!=='put'&&row.operation!=='add'&&row.store!=='sync_source_payloads'));
});

test('retry exact source fetch uses one payload lookup and validates full payload length',async()=>{
  const f=fixture();await f.run(['sync_source_headers','sync_source_payloads','sync_source_wires'],(tx,done,abort)=>addImmutableSource(tx,source,()=>{},done,abort));
  f.requests.length=0;
  const result=await readManagedRetrySource(host(f),receipt('update',3));assert.deepEqual(result.bytes,source.payload);
  assert.equal(f.requests.filter(row=>row.store==='sync_source_payloads'&&row.operation==='get').length,1);
  await assert.rejects(readManagedRetrySource(host(f),receipt('update',2)),{code:'storage_corrupt'});
});

const encode=(text:string)=>new TextEncoder().encode(text),decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const scope={realm:'realm',vault:'vault',owner:'app:tasks',collection:'items.v1',record:'record:+1',generation:'generation.1',restores:null};
const registration=encode(JSON.stringify({realm:'realm',vault:'vault',owner:'app:tasks',schema:{collection:'items.v1',version:1,policy:'local',fields:{}}}));
const input={scope,operation:'local:1',expectedRevision:new Uint8Array(32),command:encode('{"value":9223372036854775807}')};
function engine(f:ReturnType<typeof fixture>,synced=false){
  for(const name of ['sync_state','sync_authored','sync_envelopes','sync_cursors'])f.db.createObjectStore(name,{keyPath:'key'});
  let denied=false,status='accepted',conflicts:string[]=[],plans=0,frees=0,prepareHook:()=>void=()=>{};
  const active=()=>{if(denied)throw Object.assign(new Error('retired'),{code:'owner_retired'});};
  const request=(reg:any,scopeJson:string,operation:string,expected:Uint8Array,command:Uint8Array)=>encode(JSON.stringify([JSON.parse(scopeJson),[...expected],decode(command)]));
  const meta=(id:string)=>({key:{realm_id:'realm',vault_id:'vault',update_id:id},family:'records',format_version:1,payload_bytes:3,payload_digest:Array(32).fill(0),text_binding:null});
  const makePlan=(factsJson:string,operation:string,update:string,command?:Uint8Array)=>{
    plans++;const facts=JSON.parse(factsJson),requestBytes=command?request(null,JSON.stringify(facts.scope),operation,new Uint8Array(facts.local.expected_revision),command):undefined;
    const classification=status,bindings=encode(JSON.stringify([{operation,update:command&&!synced?operation:update,content:'{"integer":9223372036854775807}'}]));
    prepareHook();
    return {checkPreconditions(actual:string){if(actual!==factsJson)throw new Error('stale');},
      resultJson(){return JSON.stringify({status:classification,revision:Array(32).fill(1),conflicting_updates:conflicts,replay_result:null,payload_bytes:3});},
      nextState(){return classification==='accepted'?encode('{"state":9223372036854775807}'):undefined;},
      projection(){return classification==='accepted'?encode('{"value":-9223372036854775808}'):undefined;},
      payload(){return command&&synced?new Uint8Array([1,2,3]):undefined;},
      payloadMetadataJson(){return command&&synced?JSON.stringify(meta(update)):undefined;},
      localRequest(){return requestBytes;},operationBindings(){return bindings;},free(){frees++;}};
  };
  const guardRead=(request:any,callback:(row:any)=>void,abort:any)=>{request.onsuccess=()=>{try{active();callback(request.result);}catch(error){abort(error);}};};
  const common={storedSource(tx:any,key:any,done:any,abort:any){getExactSource(tx,key,'payload',source=>{if(!source){done(null);return;}guardRead(tx.objectStore('sync_authored').get([key.realmId,key.vaultId,key.updateId]),authored=>done({source,authored:!!authored}),abort);},abort);},stores:['sync_state','sync_authored','sync_envelopes','sync_cursors','sync_source_headers','sync_source_payloads','sync_source_wires'],
    readContext(tx:any,_scope:any,done:any,abort:any){guardRead(tx.objectStore('sync_cursors').get(['realm','vault']),row=>done(row?.value??null),abort);},
    authored(tx:any,metadataJson:string,payload:Uint8Array,done:any,abort:any){
      const metadata=JSON.parse(metadataJson),key=['realm','vault',metadata.key.update_id];
      addImmutableSource(tx,{header:{realmId:'realm',vaultId:'vault',updateId:metadata.key.update_id,descriptor:{metadata}},payload},()=>{},()=>{
        tx.objectStore('sync_authored').add({key,metadata,pending:1});done();
      },abort);
    },
    received(tx:any,value:any,done:any,abort:any){
      const metadata=JSON.parse(value.metadataJson),key=['realm','vault',metadata.key.update_id];
      guardRead(tx.objectStore('sync_envelopes').get(key),row=>{
        if(row){
          guardRead(tx.objectStore('sync_source_payloads').get(key),payload=>{
            assert.deepEqual(payload.bytes,value.payload);
            guardRead(tx.objectStore('sync_source_wires').get(key),wire=>{
              assert.deepEqual(wire.bytes,value.wire);
              if(value.delivery)tx.objectStore('sync_cursors').put({key:['realm','vault'],value:value.delivery});
              done({duplicate:true,authored:row.direction==='authored'});
            },abort);
          },abort);return;
        }
        if(value.duplicateOnly){done({duplicate:false,authored:false});return;}
        addImmutableSource(tx,{header:{realmId:'realm',vaultId:'vault',updateId:metadata.key.update_id,descriptor:{metadata}},payload:value.payload,wire:value.wire},()=>{},()=>{
          tx.objectStore('sync_envelopes').add({key,metadata,direction:'received'});
          if(value.delivery)tx.objectStore('sync_cursors').put({key:['realm','vault'],value:value.delivery});
          done({duplicate:false,authored:false});
        },abort);
      },abort);
    },
    retainedSession(){return {assertActive:active,async open(receipt:any){active();return incoming(receipt.updateId);}};},
  };
  const wasm={validateRecordsRegistration(){},validateRecordsAccepted(){},validateRecordsStoredOperation(){},
    validateRecordsStoredBinding(_scope:string,_op:string,_update:string,content:Uint8Array){assert.equal(decode(content),'{"integer":9223372036854775807}');},
    recordsStoredReadSet(){return JSON.stringify({scope,operations:['op:remote']});},
    validateRecordsStoredReplay(_scope:string,operation:string,request:Uint8Array,result:Uint8Array){const parsed=JSON.parse(decode(result));if(parsed.operation!==operation||typeof parsed.sequence!=='string'||!(/^[1-9][0-9]*$/).test(parsed.sequence)||BigInt(parsed.sequence)>9223372036854775807n)throw new Error('invalid replay');},canonicalRecordsLocalRequest:request,
    finalizeRecordsLocalResult(operation:string,revision:Uint8Array,sequence:string){return encode(`{"operation":${JSON.stringify(operation)},"revision":${JSON.stringify([...revision])},"sequence":${JSON.stringify(sequence)}}`);},
    prepareRecordsLocal(facts:string,command:Uint8Array){return makePlan(facts,JSON.parse(facts).local.operation,JSON.parse(facts).local.operation.replace(':','_'),command);},
    recordsSnapshot(){return {free(){},nextState(){return encode('{"state":9223372036854775807}');},projection(){return encode('{"value":-9223372036854775808}');},resultJson(){return '{}';}};},recordsRetryEligible:eligible};
  function incoming(id='remote_1'){
    return {recordsReadSetJson(){return JSON.stringify({scope,operations:['op:remote']});},metadataJson(){return JSON.stringify(meta(id));},
      exactPlaintext(){return new Uint8Array([1,2,3]);},exactWire(){return new Uint8Array([4,5,6]);},
      prepareRecords(facts:string){return makePlan(facts,'op:remote',id);},free(){}};
  }
  const adapter=createBrowserManagedRecords({db:f.db,authorityId:authority,assertActive:active,wasm,common});
  return {adapter,incoming,deny(){denied=true;},allow(){denied=false;},setStatus(value:string){status=value;},setConflicts(value:string[]){conflicts=value;},
    afterPrepare(hook:()=>void){prepareHook=hook;},counts(){return {plans,frees};}};
}

test('Local/Cache exact replay precedes newer accepted state/quota checks and changed identities fail',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  const first=await e.adapter.apply(token,input);assert.equal(first.replay,false);assert.equal(decode(first.result).endsWith('"sequence":"1"}'),true);
  assert.equal(f.records.get('sync_authored')!.size,0);assert.equal(f.records.get('sync_source_headers')!.size,0);
  // Simulate subsequent accepted work and even corrupt state: exact replay never reads it.
  f.seed('managed_records',[...Object.values(collection),scope.record,scope.generation],{...collection,record:scope.record,generation:scope.generation,state:new Uint8Array([255]),projection:new Uint8Array([255])});
  f.requests.length=0;
  const again=await e.adapter.apply(token,input);assert.deepEqual(again.result,first.result);assert.equal(again.replay,true);
  assert.ok(f.requests.every(row=>row.store!=='managed_records'&&row.store!=='managed_operation_sources'));
  for(const changed of [{...input,command:encode('{"value":2}')},{...input,scope:{...scope,record:'other'}},{...input,expectedRevision:new Uint8Array(32).fill(2)}]){
    await assert.rejects(e.adapter.apply(token,changed),{code:'managed_operation_collision'});
  }
  assert.deepEqual(e.counts(),{plans:1,frees:1});
});

test('strict local commit holds all state/commitments/replay/change/common outbox until completion; failed commit rolls back',async()=>{
  const f=fixture(),e=engine(f,true),token=await e.adapter.register(collection,registration);
  f.hold();let settled=false;const pending=e.adapter.apply(token,input).then(value=>{settled=true;return value;});await flush();
  assert.equal(settled,false);for(const name of ['managed_records','managed_operation_sources','managed_local_operations','managed_changes','sync_authored','sync_source_headers'])assert.equal(f.records.get(name)!.size,0);
  f.finish();const result=await pending;assert.equal(result.localDurable,true);
  assert.equal(f.records.get('managed_records')!.size,1);assert.equal(f.records.get('sync_authored')!.size,1);
  assert.equal(decode([...f.records.get('managed_records')!.values()][0].projection),'{"value":-9223372036854775808}');
  const snapshot=structuredClone(f.records);f.failNextCommit();
  await assert.rejects(e.adapter.apply(token,{...input,operation:'local:2'}));assert.deepEqual(f.records,snapshot);
  assert.deepEqual(e.counts(),{plans:2,frees:2});
});

test('registration replacement invalidates old private handle and cross-adapter token fails',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  const same=await e.adapter.register(collection,registration);await e.adapter.apply(same,input);
  await e.adapter.register(collection,encode(decode(registration).replace('"version":1','"version":2')));
  await assert.rejects(e.adapter.apply(token,input),{code:'stale_managed_registration'});
  await assert.rejects(e.adapter.apply({dispose(){}},input),{code:'invalid_managed_handle'});
});

test('receive commits complete state/source/receipt/cursor atomically; quiet duplicate survives unusable accepted bytes',async()=>{
  const f=fixture(),e=engine(f);await e.adapter.register(collection,registration);
  const update=e.incoming(),first=await e.adapter.receive(update,{epoch:'server',position:'9007199254740993'});
  assert.equal(first.changed,true);assert.equal(f.records.get('managed_receipts')!.size,1);assert.equal(f.records.get('sync_authored')!.size,0);
  const acceptedKey=[...Object.values(collection),scope.record,scope.generation];f.seed('managed_records',acceptedKey,{...collection,record:scope.record,generation:scope.generation,state:new Uint8Array([255]),projection:new Uint8Array([255])});
  const plans=e.counts().plans;
  const duplicate=await e.adapter.receive(update,{epoch:'server',position:'9007199254740994'});
  assert.deepEqual(duplicate,{duplicate:true,status:'accepted',changed:false});assert.equal(e.counts().plans,plans);
  assert.equal(f.row('sync_cursors',['realm','vault']).value.position,'9007199254740994');assert.equal(f.records.get('managed_changes')!.size,1);
});

test('received final abort leaves all family rows and common cursor unchanged',async()=>{
  const f=fixture(),e=engine(f);await e.adapter.register(collection,registration);
  const token=await e.adapter.prepareReceive(e.incoming(),{epoch:'server',position:'1'}),before=structuredClone(f.records);
  f.failNextCommit();await assert.rejects(f.run([...browserManagedStores,'sync_state','sync_authored','sync_envelopes','sync_cursors','sync_source_headers','sync_source_payloads','sync_source_wires'],(tx,done,abort)=>e.adapter.commitReceive(tx,token,false,done,abort)));
  token.dispose();assert.deepEqual(f.records,before);assert.deepEqual(e.counts(),{plans:1,frees:1});
});

test('prepared receive rejects changed matching commitment with unchanged accepted state',async()=>{
  const f=fixture(),e=engine(f);await e.adapter.register(collection,registration);
  const token=await e.adapter.prepareReceive(e.incoming());
  const row={...collection,record:scope.record,generation:scope.generation,operationId:'op:remote',updateId:'fork',content:encode('{"integer":2}')};
  f.seed('managed_operation_sources',[...Object.values(collection),scope.record,scope.generation,'op:remote','fork'],row);
  await assert.rejects(f.run([...browserManagedStores,'sync_state','sync_authored','sync_envelopes','sync_cursors','sync_source_headers','sync_source_payloads','sync_source_wires'],(tx,done,abort)=>e.adapter.commitReceive(tx,token,false,done,abort)),{code:'managed_snapshot_conflict'});
  token.dispose();assert.equal(f.records.get('managed_receipts')!.size,0);assert.equal(f.records.get('sync_source_payloads')!.size,0);
});

test('revocation after final guarded callback can commit but suppress response; exact reacquired replay proves outcome',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  f.hold();const pending=e.adapter.apply(token,input);await flush();e.deny();f.finish();
  await assert.rejects(pending,{code:'owner_retired'});assert.equal(f.records.get('managed_local_operations')!.size,1);
  e.allow();const replay=await e.adapter.apply(token,input);assert.equal(replay.replay,true);assert.equal(f.records.get('managed_changes')!.size,1);
});

test('prepared cursor change aborts receipt state source and shared delivery as one unit',async()=>{
  const f=fixture(),e=engine(f);await e.adapter.register(collection,registration);
  const token=await e.adapter.prepareReceive(e.incoming(),{epoch:'server',position:'2'});
  f.seed('sync_cursors',['realm','vault'],{key:['realm','vault'],value:{epoch:'server',position:'1'}});
  const before=structuredClone(f.records);
  await assert.rejects(f.run([...browserManagedStores,'sync_state','sync_authored','sync_envelopes','sync_cursors','sync_source_headers','sync_source_payloads','sync_source_wires'],(tx,done,abort)=>e.adapter.commitReceive(tx,token,false,done,abort)),{code:'managed_snapshot_conflict'});
  token.dispose();assert.deepEqual(f.records,before);
});

test('Rust conflict IDs quarantine earlier invalid_operation as well as waiting receipts, retaining accepted state',async()=>{
  const f=fixture(),e=engine(f);await e.adapter.register(collection,registration);
  await e.adapter.receive(e.incoming('accepted'));
  const accepted=structuredClone(f.records.get('managed_records'));
  e.setStatus('invalid_operation');await e.adapter.receive(e.incoming('invalid'));
  e.setStatus('waiting_dependencies');await e.adapter.receive(e.incoming('waiting'));
  e.setStatus('integrity_conflict');e.setConflicts(['accepted','invalid','waiting','fork']);
  await e.adapter.receive(e.incoming('fork'));
  assert.deepEqual(f.records.get('managed_records'),accepted);
  for(const id of ['invalid','waiting','fork'])assert.equal(f.row('managed_receipts',['realm','vault',id]).status,'integrity_conflict');
  assert.equal(f.row('managed_receipts',['realm','vault','accepted']).status,'accepted');
});

test('durable retry continuation advances16 then wraps17; each activation leaves relay cursor unchanged',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  e.setStatus('waiting_dependencies');
  for(let i=1;i<=17;i++)await e.adapter.receive(e.incoming(String(i).padStart(3,'0')),{epoch:'server',position:String(i)});
  assert.equal(f.records.get('managed_records')!.size,0);
  const cursor=structuredClone(f.records.get('sync_cursors'));
  const changes=f.records.get('managed_changes')!.size;
  f.requests.length=0;const waiting=await e.adapter.retryPage(token);assert.equal(waiting.examined,16);assert.equal(waiting.next,'016');assert.equal(waiting.changed,false);assert.equal(f.requests.filter(row=>row.store==='sync_source_payloads'&&row.operation==='get').length,16);
  assert.equal(f.records.get('managed_changes')!.size,changes);
  e.setStatus('accepted');
  const last=await e.adapter.retryPage(token);assert.equal(last.examined,1);assert.equal(last.next,null);assert.equal(last.exhausted,true);
  const wrapped=await e.adapter.retryPage(token);assert.equal(wrapped.examined,16);assert.equal(wrapped.changed,true);
  assert.deepEqual(f.records.get('sync_cursors'),cursor);assert.equal(f.records.get('managed_records')!.size,1);
  assert.equal(f.records.get('managed_changes')!.size,34);
});

test('decimal sequence beyond Number precision remains exact and signed-i64 exhaustion rolls back',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  const count=f.row('control','managed-records-usage:v1');count.sequence='9007199254740992';f.seed('control',count.key,count);
  const committed=await e.adapter.apply(token,input);
  assert.equal(decode(committed.result).endsWith('"sequence":"9007199254740993"}'),true);
  assert.deepEqual((await e.adapter.changes(token,'9007199254740992')).map(row=>row.sequence),['9007199254740993']);
  const exhausted=f.row('control',count.key);exhausted.sequence='9223372036854775807';f.seed('control',count.key,exhausted);
  const before=structuredClone(f.records);
  await assert.rejects(e.adapter.apply(token,{...input,operation:'next'}),{code:'managed_change_capacity'});assert.deepEqual(f.records,before);
});

test('lease loss while transaction remains abortable rolls back, relaxed writes fail closed',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  const before=structuredClone(f.records);e.afterPrepare(()=>e.deny());
  await assert.rejects(e.adapter.apply(token,input),{code:'owner_retired'});assert.deepEqual(f.records,before);
  e.allow();e.afterPrepare(()=>{});f.relax();
  await assert.rejects(e.adapter.apply(token,input),{code:'strict_durability_unavailable'});assert.deepEqual(f.records,before);
});

test('startup validates canonical replay and source-backed content; same-length canonical corruption fails',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);
  await e.adapter.apply(token,input);await e.adapter.validate();
  const binding=[...f.records.get('managed_operation_sources')!.values()][0],key=[...Object.values(collection),scope.record,scope.generation,binding.operationId,binding.updateId];
  const changed={...binding,content:encode('{"integer":9223372036854775806}')};assert.equal(changed.content.byteLength,binding.content.byteLength);
  f.seed('managed_operation_sources',key,changed);await assert.rejects(e.adapter.validate());
  f.seed('managed_operation_sources',key,binding);await e.adapter.validate();
  const local=[...f.records.get('managed_local_operations')!.values()][0],corrupt={...local,result:encode(decode(local.result).replace('"sequence":"1"','"sequence":"0"'))};
  assert.equal(local.result.byteLength,corrupt.result.byteLength);f.seed('managed_local_operations',[...Object.values(collection),input.operation],corrupt);
  f.requests.length=0;await assert.rejects(e.adapter.apply(token,input));assert.ok(f.requests.every(row=>row.store!=='managed_records'));
  await assert.rejects(e.adapter.validate());
});

test('startup reverse binding checks reject deleted commitment even if aggregate counters are recomputed',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);await e.adapter.apply(token,input);
  f.records.get('managed_operation_sources')!.clear();const count=f.row('control','managed-records-usage:v1');count.usage.operation_bytes='0';f.seed('control',count.key,count);
  await assert.rejects(e.adapter.validate(),{code:'storage_corrupt'});
});

test('startup source-to-binding proof rejects missing waiting commitment with otherwise matching counters',async()=>{
  const f=fixture(),e=engine(f);await e.adapter.register(collection,registration);e.setStatus('waiting_dependencies');await e.adapter.receive(e.incoming());await e.adapter.validate();
  f.records.get('managed_operation_sources')!.clear();const count=f.row('control','managed-records-usage:v1');count.usage.operation_bytes='0';f.seed('control',count.key,count);
  await assert.rejects(e.adapter.validate(),{code:'storage_corrupt'});
});

test('startup binds Local/Cache replay metadata restores to the exact accepted source scope',async()=>{
  const f=fixture(),e=engine(f),token=await e.adapter.register(collection,registration);await e.adapter.apply(token,input);await e.adapter.validate();
  const key=[...Object.values(collection),input.operation],local=f.row('managed_local_operations',key);f.seed('managed_local_operations',key,{...local,restores:'invented-prior'});
  await assert.rejects(e.adapter.validate(),{code:'storage_corrupt'});
});
