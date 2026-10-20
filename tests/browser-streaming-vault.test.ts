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
  let closed=false;const writes:{store:string;operation:string;key:any}[]=[];
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
      const listeners=new Map<string,Array<()=>void>>();
      const tx:any={durability:'strict',addEventListener(name:string,callback:()=>void){listeners.set(name,[...(listeners.get(name)??[]),callback]);},
        abort(){if(aborted||complete)return;aborted=true;queueMicrotask(()=>{for(const callback of listeners.get('abort')??[])callback();tx.onabort?.();});},
        objectStore(name:string){
          assert.ok(local.has(name));const definition=definitions.get(name)!;
          function request(action:()=>any){
            assert.equal(aborted||complete,false);const result:any={};pending++;
            queueMicrotask(()=>{if(aborted)return;try{result.result=clone(action());result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{pending--;schedule();}});return result;
          }
          function write(row:any,add:boolean){assert.equal(mode,'readwrite');const copy=clone(row),key=keyOf(copy,definition.keyPath);writes.push({store:name,operation:add?'add':'put',key:clone(key)});return request(()=>{
            const values=local.get(name)!;if(add&&values.has(JSON.stringify(key)))throw new Error('duplicate key');
            for(const index of definition.indexes.values())if(index.unique)for(const [oldKey,old]of values)if(oldKey!==JSON.stringify(key)&&compare(keyOf(old,index.keyPath),keyOf(copy,index.keyPath))===0)throw new Error('duplicate index');
            values.set(JSON.stringify(key),copy);modified.add(name);return key;
          });}
          function remove(key:any){assert.equal(mode,'readwrite');writes.push({store:name,operation:'delete',key:clone(key)});return request(()=>{local.get(name)!.delete(JSON.stringify(key));modified.add(name);});}
          function cursor(range:any,indexPath=definition.keyPath,direction='next'){
            const result:any={};pending++;const rows=[...local.get(name)!.values()].filter(row=>matches(keyOf(row,indexPath),range)).sort((a,b)=>compare(keyOf(a,indexPath),keyOf(b,indexPath)));if(direction==='prev')rows.reverse();let position=0;
            const step=()=>{if(aborted)return;let continued=false;const row=rows[position];result.result=row===undefined?null:{value:clone(row),primaryKey:clone(keyOf(row,definition.keyPath)),continue(){continued=true;position++;queueMicrotask(step);},delete(){return remove(keyOf(row,definition.keyPath));}};
              try{result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{if(!continued){pending--;schedule();}}};queueMicrotask(step);return result;
          }
          return {keyPath:clone(definition.keyPath),autoIncrement:false,indexNames:[...definition.indexes.keys()],
            createIndex:schemaStore(name).createIndex,
            get:(key:any)=>request(()=>local.get(name)!.get(JSON.stringify(key))),
            getKey:(key:any)=>request(()=>local.get(name)!.has(JSON.stringify(key))?key:undefined),
            count:()=>request(()=>local.get(name)!.size),
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
      function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(aborted||complete||pending)return;complete=true;for(const name of modified)records.set(name,local.get(name)!);for(const callback of listeners.get('complete')??[])callback();tx.oncomplete?.();});}
      schedule();return tx;
    },
  };
  if(oldVersion){db.createObjectStore('legacy-data',{keyPath:'id'}).add({id:'retained-note',bytes:Uint8Array.of(1,2,3)});}
  const indexedDB={open(_name:string,version:number){const request:any={result:db};queueMicrotask(()=>{
    if(version>db.version){let aborted=false;request.transaction={objectStore:schemaStore,abort(){aborted=true;}};request.onupgradeneeded?.({oldVersion:db.version});if(aborted){request.error=new Error('upgrade aborted');request.onerror?.();return;}db.version=version;}
    request.onsuccess?.();
  });return request;}};
  return {indexedDB,db,records,definitions,writes,seed(store:string,row:any){records.get(store)!.set(JSON.stringify(keyOf(row,definitions.get(store)!.keyPath)),clone(row));},row(store:string,key:any){return clone(records.get(store)!.get(JSON.stringify(key)));}};
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

test('normal mutation skips unchanged publication metadata but still repairs inline content',async()=>withFixture(async f=>{
  // Opaque planner output drives the real vault intent/engine transaction path.
  // This checks host publication writes, not Rust classification or CRDT parity.
  const text=new TextEncoder().encode('text'),identity={...scope,entry_id:'note',bootstrap_id:'bootstrap'};
  const old=[{id:'note',path:'note.md',kind:'file',revision:'text-revision',deleted:false},{id:'folder',path:'folder',kind:'folder',revision:'folder-revision',deleted:false}];
  const presentation=old.map(entry=>({id:entry.id,ctime_ms:10,mtime_ms:20,size_bytes:entry.kind==='file'?text.length:0}));
  const classified=old.map(entry=>({identity:{entry_id:entry.id},outcome:{status:'normal',path:entry.path,kind:entry.kind,content:entry.kind==='file'?{kind:'text',content:{byte_length:String(text.length),witness:{kind:'text',identity,revision:entry.revision}}}:null}}));
  const mocked=wasmFixture(),wasm=mocked.wasm,digest=Array(32).fill(2),summary=Array(32).fill(3);
  wasm.validateFamilyCommand=(raw:string)=>raw;
  wasm.checkIdempotency=(raw:string)=>{const value=JSON.parse(raw);return JSON.stringify(value.record?{status:'replay',result:value.record.result}:{status:'new'});};
  wasm.validateAuthoredSyncPayload=()=>{};
  wasm.WasmMetadataStateBuilder=class{
    version:string;constructor(_scope:string,version:string){this.version=version;}restoreRecord(){}restoreActivity(){}free(){}
    finish(){const version=this.version;return {free(){},metadataHeadJson:()=>JSON.stringify({scope,version,record_count:0,activity_count:0}),
      mutationRequirements:()=>JSON.stringify({update_count:1,text:'none'}),
      prepareMutation(raw:string){const input=JSON.parse(raw),a=input.allocation,id=a.update_ids[0],request=input.command.request;
        const after={id:request.mutation.id,path:'new-folder',kind:'folder',deleted:false,revision:a.metadata_revision};
        const metadata={key:{...scope,update_id:id},family:'files',format_version:2,payload_digest:digest,payload_bytes:1,text_binding:null},record={payload_bytes:1,payload_digest:digest};
        const output={record_delta_count:1,activity_delta_count:0,payload_count:1,allocated_update_ids:[id],changes:[{before:null,after}]};
        const rows=[...classified,{identity:{entry_id:after.id},outcome:{status:'normal',path:after.path,kind:'folder',content:null}}];
        const plan={free(){},resultJson:()=>JSON.stringify(output),nextState:()=>({free(){},metadataHeadJson:()=>JSON.stringify({scope,version:a.graph_revision,record_count:1,activity_count:0})}),
          recordDeltaJson:()=>JSON.stringify({update_id:id,record,summary_digest:summary}),payloadMetadataJson:()=>JSON.stringify(metadata),payloadBytes:()=>Uint8Array.of(7),
          checkPreconditions(actual:any){assert.equal(actual.metadataHeadJson(),JSON.stringify({scope,version,record_count:0,activity_count:0}));},
          classify:()=>({length:()=>rows.length,entryJson:(index:number)=>JSON.stringify(rows[index]),textBytes:()=>text.slice(),free(){}})};
        return {free(){},payloadCount:()=>1,payloadMetadataJson:plan.payloadMetadataJson,payloadBytes:plan.payloadBytes,
          verificationSession:()=>({free(){},nextChunkJson:()=>undefined,finish:()=>({free(){}})}),finalize:()=>plan};
      }};}
  };
  const vault=await openBrowserStreamingVault({name:'zorid-core-vault:publication-writes',clientId,assertActive(){},wasm,now:()=>30});
  try{
    f.seed('sync_state',{key:'config',value:{...scope,key_epoch:1,replica_id:'replica',incarnation_id:'incarnation'}});
    f.seed('sync_state',{key:'metadata-head',value:{scope,version:'graph',record_count:0,activity_count:0}});
    f.seed('sync_text',{key:JSON.stringify([scope.realm_id,scope.vault_id,'note','bootstrap']),state:{identity,version:'text-revision',snapshot:[],actors:{}}});
    for(let index=0;index<old.length;index++){
      const entry=old[index],stat=presentation[index],content=entry.kind==='file'?{kind:'text',metadata:classified[index].outcome.content!.content}:null;
      f.seed('metadata',entry);f.seed('presentation',stat);f.seed('sync_materialization_refs',{id:entry.id,status:'normal',fingerprint:JSON.stringify(classified[index]),entry,presentation:stat,content,reason:classified[index].outcome});
      // Revision/retained descriptor equality does not establish inline bytes.
      f.seed('content',{id:entry.id,bytes:Uint8Array.of(9,9,9,9)});
    }
    f.writes.length=0;
    const receipt=JSON.parse(await vault.mutate(JSON.stringify({operation_id:'mkdir',mutation:{type:'create',id:'new',path:'new-folder',kind:'folder',content:null}})));
    assert.equal(receipt.sequence,'1');assert.equal(receipt.changes[0].after.id,'new');
    for(const store of ['metadata','presentation'])assert.deepEqual(f.writes.filter(row=>row.store===store),[{store,operation:'put',key:'new'}]);
    assert.deepEqual(f.writes.filter(row=>row.store==='content'),[{store:'content',operation:'put',key:'note'},{store:'content',operation:'delete',key:'folder'},{store:'content',operation:'delete',key:'new'}]);
    assert.deepEqual(f.row('content','note').bytes,text);assert.equal(f.row('content','folder'),undefined);
    for(let index=0;index<old.length;index++){assert.deepEqual(f.row('metadata',old[index].id),old[index]);assert.deepEqual(f.row('presentation',old[index].id),presentation[index]);}
    assert.equal((await vault.readEntry('note.md'))?.entry.revision,'text-revision');assert.deepEqual((await vault.readEntry('note.md'))?.bytes,text);
  }finally{vault.close();}
}));
