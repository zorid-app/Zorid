import {openBrowserStreamingVault} from '../../src/core/browser-streaming-vault.ts';
const report={status:'running',groups:[],remainingGates:['Product registry is empty: no product UI or public plugin activation','Full managed-records/browser campaign and native/mobile remain separate'],events:[]};
window.managedRecordsEvidence=report;
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,test,message){const end=Date.now()+10000;while(Date.now()<end){const value=await read();if(test(value))return value;await pause(20);}throw new Error(message);}
const enc=value=>new TextEncoder().encode(JSON.stringify(value));
const scope={realm_id:'host-realm',vault_id:'host-vault'};
const recordScope=(record,generation)=>({realm:scope.realm_id,vault:scope.vault_id,owner:'host-fixture',collection:'lifecycle',record,generation,restores:null});
const command=(kind,title)=>({command:kind,actions:[{action:'Write',field:'title',cell:{state:'Value',value:{type:'String',value:title}}}]});
let wasm,key;
function wire(id,record,parents,kind='Create'){
  const s=recordScope(record,kind==='Create'?id:parents[0]),payload=enc({family:'records',format_version:1,id,scope:s,operations:[{id,parents,scope:s,schema_version:1,command:command(kind,id)}]});
  return key.seal(JSON.stringify({envelope_version:1,purpose:'vault_update',suite:'xchacha20poly1305',...scope,update_id:id,key_epoch:1,
    origin_device_id:'host-fixture',document_format_version:1,required_features:[],optional_extensions:{}}),payload);
}
const names=new Set(),workers=new Set();
async function connect(name){
  return openBrowserStreamingVault({name,wasm,clientId:crypto.randomUUID(),assertActive(){},managedRecordsSession:()=>({key,sessionToken:key,assertActive(){}})});
}
async function seed(name,items){
  names.add(name);const vault=await connect(name);try{await vault.sync.enroll({...scope,key_epoch:1});for(const [id,bytes] of items)await vault.sync.receive(id,bytes,key);}finally{vault.close();}
}
async function rows(name,store){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store),r=tx.objectStore(store).getAll();let value;r.onsuccess=()=>value=r.result;tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
const status=async(name,id)=>(await rows(name,'managed_receipts')).find(row=>row.updateId===id)?.status;
function start(name,clientId=crypto.randomUUID()){
  const worker=new Worker(new URL('../../src/platform/browser-core-worker.ts',import.meta.url),{type:'module'});workers.add(worker);
  const pending=new Map(),events=[];
  worker.onmessage=({data})=>{if(data.event){events.push(data);report.events.push({name,...data});return;}const task=pending.get(data.id);if(task){pending.delete(data.id);clearTimeout(task.timer);data.ok?task.resolve(data.result):task.reject(Object.assign(new Error(JSON.stringify(data.error)),data.error));}};
  worker.onerror=event=>{for(const task of pending.values())task.reject(new Error(event.message));};
  const call=(operation,payload)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>reject(new Error('RPC deadline '+operation)),15000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,operation,payload});});
  return {worker,events,clientId,call,async open(){return call('open',{database:name,clientId,allowNewVault:true,wasmModuleUrl:'/target/browser-wasm/generated/zorid_wasm.js'});},
    async configure(){return call('sync-configure',{endpoint:location.origin,...{realmId:scope.realm_id,vaultId:scope.vault_id,serverEpoch:'host-epoch',keyEpoch:1,bearerToken:'synthetic-test-only',keyBytes:new Uint8Array(32).fill(37),allowLoopbackHttp:true}});},
    async release(){await call('release-client');worker.terminate();workers.delete(worker);}};
}
async function group(name,run){const evidence=await run();report.groups.push({name,status:'passed',evidence});}
async function main(){
  report.provenance=await fetch('/__managed_fixture_provenance').then(r=>r.json());
  wasm=await import('/target/browser-wasm/generated/zorid_wasm.js');await wasm.default();key=new wasm.WasmVaultKey(new Uint8Array(32).fill(37));
  const name='zorid-core-vault:host-lifecycle-'+crypto.randomUUID();
  await seed(name,[['startup-parent',wire('startup-parent','startup',[])],['a-child',wire('a-child','parent-recovery',['z-parent'],'Patch')]]);
  assert(await status(name,'startup-parent')==='missing_registration','Seed bypassed trusted registration');
  let h=start(name);await h.open();await h.configure();
  await group('startup registers fixed first-party collection and recovers retained encrypted receipt',async()=>{
    await until(()=>status(name,'startup-parent'),s=>s==='accepted','Startup did not recover');
    await until(()=>status(name,'a-child'),s=>s==='waiting_dependencies','Missing child was not classified');
    assert((await rows(name,'managed_collections')).length===1,'Registry was not singular');
    return {parent:await status(name,'startup-parent'),child:await status(name,'a-child'),registrations:h.events.filter(e=>e.event==='fixture-registration').length};
  });
  await group('normal network receive triggers retained child recovery on existing local queue',async()=>{
    const bytes=wire('z-parent','parent-recovery',[]);
    await fetch('/__host_relay',{method:'POST',body:JSON.stringify([{sequence:'1',envelope_base64:btoa(String.fromCharCode(...bytes))}])});
    const swept=await h.call('sync-once');
    await until(()=>status(name,'a-child'),s=>s==='accepted','Parent receive did not trigger child retry');
    const cursor=(await rows(name,'sync_cursors'))[0].value;
    assert(cursor.after==='1','Retry changed shared delivery cursor');
    assert((await rows(name,'sync_authored')).length===0,'Received retry echoed into authored outbox');
    return {swept,cursor,child:await status(name,'a-child')};
  });
  await group('foreground refresh catches durable changes with no BroadcastChannel hint',async()=>{
    await h.call('refresh');await pause(40);
    const observer=await connect(name);try{await observer.sync.receive('foreground',wire('foreground','foreground',[]),key);}finally{observer.close();}
    const count=()=>h.events.filter(e=>e.event==='fixture-durable-changes').flatMap(e=>e.changes).filter(row=>row.operationId==='foreground').length;
    assert(count()===0,'External fixture unexpectedly emitted a worker hint');
    await h.call('refresh');await until(async()=>count(),n=>n===1,'Foreground did not catch missed change');
    await h.call('refresh');await pause(40);assert(count()===1,'Foreground duplicated durable notification');return {deliveries:count()};
  });
  await group('release fences maintenance and exact client lease reacquires on worker restart',async()=>{
    const observer=await connect(name);try{await observer.sync.receive('shutdown',wire('shutdown','shutdown',[]),key);}finally{observer.close();}
    const refresh=h.call('refresh').catch(error=>assert(error.code==='client_not_admitted','Unexpected releasing guard'));
    const release=h.call('release-client');await Promise.all([refresh,release]);
    const after=(await rows(name,'managed_changes')).length,delivered=h.events.filter(e=>e.event==='fixture-durable-changes').length;
    await pause(80);assert((await rows(name,'managed_changes')).length===after,'Writes continued after release');
    assert(h.events.filter(e=>e.event==='fixture-durable-changes').length===delivered,'Stale notification after release');
    await h.call('refresh').then(()=>{throw new Error('Closed client refreshed');},error=>assert(error.code==='client_ownership_lost','Unexpected closed guard'));
    const previous=h;previous.worker.terminate();workers.delete(previous.worker);h=start(name,previous.clientId);await h.open();await h.configure();
    await until(async()=>h.events.some(e=>e.event==='fixture-durable-changes'&&e.changes.some(row=>row.operationId==='shutdown')),Boolean,'Restart missed durable changes');
    const errors=report.events.filter(e=>['storage-error','managed-records-error'].includes(e.event));assert(errors.length===0,'Worker maintenance errors: '+JSON.stringify(errors));
    await h.release();return {changes:after,reacquiredClient:previous.clientId,errors};
  });
  await group('release drains a held real strict transaction and suppresses stale durable notification',async()=>{
    const name='zorid-core-vault:host-drain-'+crypto.randomUUID();await seed(name,[['drain-create',wire('drain-create','drain',[])]]);
    const h=start(name);await h.open();
    let releasing,completedBeforeAck=false;
    h.worker.addEventListener('message',({data})=>{
      if(data.event==='fixture-held-write')releasing=h.call('release-client').then(()=>{completedBeforeAck=h.events.some(e=>e.event==='fixture-held-finished');});
    });
    await h.configure();await until(async()=>!!releasing,Boolean,'No in-flight strict transaction');await releasing;
    assert(completedBeforeAck,'Release acknowledged before held transaction completed/aborted');
    assert(!h.events.some(e=>e.event==='fixture-durable-changes'&&e.changes.some(row=>row.status==='accepted')),'Closed host emitted stale accepted notification');
    const outcome=h.events.find(e=>e.event==='fixture-held-finished').outcome;
    h.worker.terminate();workers.delete(h.worker);
    const afterRelease=await status(name,'drain-create'),reopened=start(name,h.clientId);await reopened.open();await reopened.configure();
    await until(()=>status(name,'drain-create'),value=>value==='accepted','Reacquisition did not prove durable outcome');await reopened.release();
    return {outcome,afterRelease,afterReopen:await status(name,'drain-create'),completedBeforeAck};
  });
}
try{await main();report.status='passed-subset';}catch(error){report.status='failed';report.error={code:error.code,details:error.details,message:error.message,stack:error.stack};}
finally{
  for(const worker of workers)worker.terminate();workers.clear();key?.free();
  report.cleanup=[];for(const name of names){try{await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);setTimeout(()=>reject(new Error('delete timeout')),5000);});report.cleanup.push({name,deleted:true});}catch(error){report.status='failed';report.error={message:String(error)};}}
  report.finished=true;document.querySelector('#result').textContent=JSON.stringify(report,null,2);window.managedRecordsComplete=true;
}
