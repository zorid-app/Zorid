import test from 'node:test';
import assert from 'node:assert/strict';
import {openBrowserStreamingVault} from '../src/core/browser-streaming-vault.ts';

const clientId='fixture-client',scope={realm_id:'realm',vault_id:'vault'};
const clone=<T>(value:T):T=>structuredClone(value);
const keyOf=(row:any,path:string|string[])=>Array.isArray(path)?path.map(key=>row[key]):row[path];
const compare=(a:any,b:any):number=>Array.isArray(a)&&Array.isArray(b)?a.reduce((n,v,i)=>n||compare(v,b[i]),0)||a.length-b.length:a===b?0:a<b?-1:1;
/** Deterministic host transaction double: writes publish only on complete,
 * readwrite requires strict durability, and aggregate getAll is forbidden.
 * Opaque WASM doubles do not model authentication, CRDTs or actual browser IDB. */
function databaseFixture(oldVersion=0){
  type Definition={keyPath:string|string[];indexes:Map<string,{keyPath:string|string[];unique:boolean}>};
  const records=new Map<string,Map<string,any>>(),definitions=new Map<string,Definition>();
  let closed=false;
  const matches=(key:any,range:any)=>!range||((range.lower===undefined||compare(key,range.lower)>=(range.lowerOpen?1:0))&&(range.upper===undefined||compare(key,range.upper)<=(range.upperOpen?-1:0)));
  const schemaStore=(name:string)=>({
    createIndex(index:string,keyPath:string|string[],options:any={}){definitions.get(name)!.indexes.set(index,{keyPath,unique:options.unique===true});},
    add(row:any){const copy=clone(row);records.get(name)!.set(JSON.stringify(keyOf(copy,definitions.get(name)!.keyPath)),copy);return {};},
  });
  const db:any={version:oldVersion,
    get objectStoreNames(){return Object.assign([...records.keys()],{contains:(name:string)=>records.has(name)});},
    createObjectStore(name:string,options:any){assert.equal(records.has(name),false);records.set(name,new Map());definitions.set(name,{keyPath:clone(options.keyPath),indexes:new Map()});return schemaStore(name);},
    close(){closed=true;},
    transaction(names:string[],mode:string,options?:any){
      assert.equal(closed,false);if(mode==='readwrite')assert.deepEqual(options,{durability:'strict'});
      const local=new Map(names.map(name=>{assert.ok(records.has(name),name);return [name,clone(records.get(name)!)];}));
      let pending=0,complete=false,aborted=false,scheduled=false;const modified=new Set<string>();
      const tx:any={durability:'strict',
        abort(){if(aborted||complete)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
        objectStore(name:string){
          assert.ok(local.has(name));const definition=definitions.get(name)!;
          function request(action:()=>any){
            assert.equal(aborted||complete,false);const result:any={};pending++;
            queueMicrotask(()=>{if(aborted)return;try{result.result=clone(action());result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{pending--;schedule();}});return result;
          }
          function write(row:any,add:boolean){assert.equal(mode,'readwrite');const copy=clone(row),key=keyOf(copy,definition.keyPath);return request(()=>{
            const values=local.get(name)!;if(add&&values.has(JSON.stringify(key)))throw new Error('duplicate key');
            for(const index of definition.indexes.values())if(index.unique)for(const [oldKey,old]of values)if(oldKey!==JSON.stringify(key)&&compare(keyOf(old,index.keyPath),keyOf(copy,index.keyPath))===0)throw new Error('duplicate index');
            values.set(JSON.stringify(key),copy);modified.add(name);return key;
          });}
          function remove(key:any){assert.equal(mode,'readwrite');return request(()=>{local.get(name)!.delete(JSON.stringify(key));modified.add(name);});}
          function cursor(range:any,indexPath=definition.keyPath,direction='next'){
            const result:any={};pending++;const rows=[...local.get(name)!.values()].filter(row=>matches(keyOf(row,indexPath),range)).sort((a,b)=>compare(keyOf(a,indexPath),keyOf(b,indexPath)));if(direction==='prev')rows.reverse();let position=0;
            const step=()=>{if(aborted)return;let continued=false;const row=rows[position];result.result=row===undefined?null:{value:clone(row),primaryKey:clone(keyOf(row,definition.keyPath)),continue(){continued=true;position++;queueMicrotask(step);},delete(){return remove(keyOf(row,definition.keyPath));}};
              try{result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{if(!continued){pending--;schedule();}}};queueMicrotask(step);return result;
          }
          return {keyPath:clone(definition.keyPath),autoIncrement:false,indexNames:[...definition.indexes.keys()],
            createIndex:schemaStore(name).createIndex,
            get:(key:any)=>request(()=>local.get(name)!.get(JSON.stringify(key))),
            getKey:(key:any)=>request(()=>local.get(name)!.has(JSON.stringify(key))?key:undefined),
            add:(row:any)=>write(row,true),put:(row:any)=>write(row,false),delete:remove,
            openCursor:(range?:any,direction?:string)=>cursor(range,definition.keyPath,direction),
            getAll(){assert.fail('getAll is forbidden');},
            index(indexName:string){const index=definition.indexes.get(indexName);assert.ok(index,indexName);return {...index,multiEntry:false,
              get:(key:any)=>request(()=>[...local.get(name)!.values()].find(row=>compare(keyOf(row,index.keyPath),key)===0)),
              count:(key:any)=>request(()=>[...local.get(name)!.values()].filter(row=>compare(keyOf(row,index.keyPath),key)===0).length),
              openCursor:(range?:any,direction?:string)=>cursor(range,index.keyPath,direction),
            };},
          };
        },
      };
      function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(aborted||complete||pending)return;complete=true;for(const name of modified)records.set(name,local.get(name)!);tx.oncomplete?.();});}
      schedule();return tx;
    },
  };
  if(oldVersion){db.createObjectStore('legacy-data',{keyPath:'id'}).add({id:'retained-note',bytes:Uint8Array.of(1,2,3)});}
  const indexedDB={open(_name:string,version:number){const request:any={result:db};queueMicrotask(()=>{
    if(version>db.version){let aborted=false;request.transaction={objectStore:schemaStore,abort(){aborted=true;}};request.onupgradeneeded?.({oldVersion:db.version});if(aborted){request.error=new Error('upgrade aborted');request.onerror?.();return;}db.version=version;}
    request.onsuccess?.();
  });return request;}};
  return {indexedDB,db,records,definitions,seed(store:string,row:any){records.get(store)!.set(JSON.stringify(keyOf(row,definitions.get(store)!.keyPath)),clone(row));},row(store:string,key:any){return clone(records.get(store)!.get(JSON.stringify(key)));}};
}
function wasmFixture(){
  let plans=0,disposed=0;
  const unused=()=>{throw new Error('unexpected opaque planner call');};
  const wasm:any={validateSnapshot(){},planMutation:unused,checkIdempotency:unused,
    WasmAuthoredMetadataBatch:class{},WasmBinaryBuilder:class{},
    validateFamilyCommand:unused,checkFamilyCommandReplay:unused,validateAuthoredSyncPayload:unused,validateSyncWire:unused,encodeFilePayload:unused,materializeTextState:unused,createEmptyTextState:unused,rebindTextState:unused,
    WasmMetadataStateBuilder:class{
      constructor(_scope:string,_revision:string){}
      finish(){return {free(){},namespaceViewJson(){return JSON.stringify({namespace:{pending:[]}});},verificationSession(){return {nextChunkJson(){return undefined;},finish(){return {free(){}};},free(){}};},
        openBinaryRead(){plans++;return {length(){return '0';},chunkCount(){return 0;},chunkJson:unused,verifyPayload:unused,free(){disposed++;}};},
      };}
      free(){}
    },
  };
  return {wasm,plans:()=>plans,disposed:()=>disposed};
}
async function withFixture(action:(f:ReturnType<typeof databaseFixture>)=>Promise<void>,oldVersion=0){
  const saved=new Map(['indexedDB','IDBKeyRange'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),f=databaseFixture(oldVersion);
  try{Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:f.indexedDB});Object.defineProperty(globalThis,'IDBKeyRange',{configurable:true,value:{only:(value:any)=>({lower:value,upper:value}),bound:(lower:any,upper:any)=>({lower,upper})}});await action(f);}
  finally{for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}
}

test('published pin close replays after a lost ACK; reused requested ID gets a new physical pin immune to stale close',async()=>withFixture(async f=>{
  const mocked=wasmFixture(),vault=await openBrowserStreamingVault({name:'zorid-core-vault:pin-fixture',clientId,assertActive(){},wasm:mocked.wasm});
  try{
    assert.equal(f.db.version,8);assert.equal(f.definitions.get('binary_reads')!.indexes.get('by_pin')!.unique,true);
    f.seed('sync_state',{key:'config',value:{...scope,key_epoch:1,replica_id:'replica',incarnation_id:'incarnation'}});
    f.seed('sync_state',{key:'metadata-head',value:{scope,version:'graph',record_count:0,activity_count:0}});
    const entry={id:'entry',path:'empty.bin',kind:'file',revision:'revision',deleted:false},presentation={id:'entry',ctime_ms:0,mtime_ms:0,size_bytes:0};
    f.seed('metadata',entry);f.seed('presentation',presentation);
    f.seed('sync_materialization_refs',{id:'entry',status:'normal',entry,presentation,content:{kind:'binary',reference:{scope,entry:{entry_id:'entry'},selected_event:'event'}}});
    const streams=await vault.binaryStreams(),input={entryId:'entry',expectedRevision:'revision',expectedContentEvent:'event'},requested='same-request';
    const first=await vault.openBinaryRead(requested,input);assert.notEqual(first.readId,requested);assert.deepEqual(await vault.openBinaryRead(requested,input),first);assert.equal(mocked.plans(),1);
    await assert.rejects(async()=>{await streams.closeRead(first);throw Object.assign(new Error('simulated lost close ACK'),{code:'outcome_unknown'});},{code:'outcome_unknown'});
    assert.equal(f.row('binary_reads',[clientId,requested]),undefined);assert.equal(mocked.disposed(),1);
    await streams.closeRead(first);assert.equal(mocked.disposed(),1,'exact close retry is idempotent');
    const second=await vault.openBinaryRead(requested,input);assert.notEqual(second.readId,first.readId);assert.equal(mocked.plans(),2);
    await streams.closeRead(first);assert.equal(f.row('binary_reads',[clientId,requested]).pinId,second.readId);assert.deepEqual(await vault.openBinaryRead(requested,input),second);
    await assert.rejects(vault.closeBinaryReadRequest(requested,{...input,entryId:'other'}),{code:'idempotency_conflict'});assert.equal(f.row('binary_reads',[clientId,requested]).pinId,second.readId);
    await vault.closeBinaryReadRequest(requested,input);assert.equal(f.row('binary_reads',[clientId,requested]),undefined);assert.equal(mocked.disposed(),2);
  }finally{vault.close();}
}));
for(const oldVersion of [6,7])test(`fresh schema eight preserves format ${oldVersion} when its upgrade is rejected`,async()=>withFixture(async f=>{
  const before=clone(f.records);await assert.rejects(openBrowserStreamingVault({name:'zorid-core-vault:old-fixture',clientId,assertActive(){},wasm:wasmFixture().wasm}),{code:'storage_schema_mismatch'});assert.equal(f.db.version,oldVersion);assert.deepEqual(f.records,before);
},oldVersion));

for(const corruption of ['missing','extra'])test(`fresh managed schema inventory rejects ${corruption} index on reopen`,async()=>withFixture(async f=>{
  const options={name:'zorid-core-vault:managed-inventory',clientId,assertActive(){},wasm:wasmFixture().wasm};
  const vault=await openBrowserStreamingVault(options),receipt=f.definitions.get('managed_receipts')!;
  if(corruption==='missing')receipt.indexes.delete('by_retry');else receipt.indexes.set('extra',{keyPath:'status',unique:false});
  await assert.rejects(openBrowserStreamingVault(options),{code:'storage_schema_mismatch'});
  vault.close();
}));
