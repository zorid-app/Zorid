const report={status:'running',transport:'HTTP JSON v1 reference fixture',groups:[],replicas:[],remainingGates:[
  'Dedicated fixture Workers exercise real adapters; normal product Worker authoring API and active consumer remain absent',
  'Whole Phase1, full quota/browser matrices, production relay, native and mobile acceptance remain open'],userAgent:navigator.userAgent};
window.managedRecordsEvidence=report;
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const equal=(a,b,message)=>assert(JSON.stringify(a)===JSON.stringify(b),message);
const names=new Set(),workers=new Set();
function start(name,clientId=crypto.randomUUID()){
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'}),pending=new Map();workers.add(worker);
  worker.onmessage=({data})=>{if(data.event)return;const task=pending.get(data.id);if(task){pending.delete(data.id);clearTimeout(task.timer);data.ok?task.resolve(data.result):task.reject(Object.assign(new Error(data.error.message),data.error));}};
  worker.onerror=event=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error(event.message));}pending.clear();};
  const call=(operation,payload)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>reject(new Error('Replica RPC deadline '+operation)),15000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,operation,payload});});
  return {name,clientId,worker,call,async open(){return call('open',{name,clientId,endpoint:location.origin});},async close(){await call('close');worker.terminate();workers.delete(worker);}};
}
async function raw(name,store){
  assert(names.has(name),'Read outside fixture-owned DB');
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store),request=tx.objectStore(store).getAll();let rows;request.onsuccess=()=>rows=request.result;tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
const relay=()=>fetch('/__replica_relay').then(response=>response.json());
const snapshot=(host,record)=>host.call('snapshot',record);
async function converged(a,b,record){
  const [left,right]=await Promise.all([snapshot(a,record),snapshot(b,record)]);
  equal(left.state,right.state,record+' full canonical state differs');equal(left.projection,right.projection,record+' canonical projection differs');equal(left.metadata,right.metadata,record+' causal revision differs');
  assert(!left.unresolved.length&&!right.unresolved.length,record+' has unresolved receipts');
  return {state:left.state,projection:left.projection,metadata:left.metadata};
}
async function exchange(a,b){
  const results=[];results.push(await a.call('once'));results.push(await b.call('once'));results.push(await a.call('once'));
  const [ia,ib]=await Promise.all([a.call('inspect'),b.call('inspect')]);
  assert(!ia.pending.length&&!ib.pending.length,'Exchange left pending authored updates');equal(ia.cursor,ib.cursor,'Replicas did not consume the same relay prefix');
  assert(ia.transactions.begun===ia.transactions.strict&&ib.transactions.begun===ib.transactions.strict,'Non-strict write observed');return {results,cursor:ia.cursor};
}
async function group(name,run){const start=performance.now();const evidence=await run();report.groups.push({name,status:'passed',ms:Math.round(performance.now()-start),evidence});}
async function reopen(host){const {name,clientId}=host;await host.close();const next=start(name,clientId);await next.open();return next;}
async function main(){
  report.provenance=await fetch('/__managed_fixture_provenance').then(response=>response.json());
  const prefix='zorid-core-vault:replicas-'+crypto.randomUUID(),aname=prefix+'-a',bname=prefix+'-b';names.add(aname);names.add(bname);
  let a=start(aname),b=start(bname);const [ia,ib]=await Promise.all([a.open(),b.open()]);
  assert(aname!==bname&&ia.authorityId!==ib.authorityId&&a.clientId!==b.clientId,'Replicas share database authority/client');
  report.replicas=[{name:aname,clientId:a.clientId,authorityId:ia.authorityId},{name:bname,clientId:b.clientId,authorityId:ib.authorityId}];
  await group('shared initial history then independent offline field edits converge with durable sealed outboxes and replay',async()=>{
    await a.call('mutate',{operation:'separate-root'});await exchange(a,b);await converged(a,b,'separate');
    const before=await relay();
    const [left,right]=await Promise.all([a.call('mutate',{operation:'separate-left'}),b.call('mutate',{operation:'separate-right'})]);
    equal((await relay()).requests,before.requests,'Offline mutations used the network');assert(left.localDurable&&right.localDurable,'Offline edits did not return durable receipts');
    const [pendingA,pendingB]=await Promise.all([a.call('inspect'),b.call('inspect')]);equal(pendingA.pending,['separate-left'],'A outbox missing offline edit');equal(pendingB.pending,['separate-right'],'B outbox missing offline edit');
    const sealed=await a.call('seal-pending');equal(await a.call('seal-pending'),sealed,'Seal retry changed retained ciphertext');
    const stored=await raw(aname,'sync_source_wires');assert(stored.some(row=>JSON.stringify([...row.bytes])===JSON.stringify(sealed[0].wire)),'Sealed wire was not durable in IDB');
    a=await reopen(a);equal(await a.call('seal-pending'),sealed,'Reopen changed durable sealed outbox');
    const transfer=await exchange(a,b),state=await converged(a,b,'separate'),projection=JSON.parse(state.projection);
    assert(projection.fields.left[0].cell.value.value==='left-offline'&&projection.fields.right[0].cell.value.value==='right-offline','Independent fields were lost');
    const changesBefore=(await raw(aname,'managed_changes')).length,authoredBefore=(await raw(aname,'sync_authored')).length;
    const replay=await a.call('mutate',{operation:'separate-left',expected:left.expected});assert(replay.replay,'Exact lost-response retry did not replay');equal(replay.result,left.result,'Replay changed original result');
    equal((await raw(aname,'managed_changes')).length,changesBefore,'Replay appended a change');equal((await raw(aname,'sync_authored')).length,authoredBefore,'Replay appended an authored row');
    await a.call('duplicate',{id:sealed[0].id,wire:sealed[0].wire});await b.call('duplicate',{id:sealed[0].id,wire:sealed[0].wire});
    equal(await converged(a,b,'separate'),state,'Duplicate changed canonical outcome');equal((await raw(aname,'managed_changes')).length,changesBefore,'Duplicate appended a change');
    return {pendingA:pendingA.pending,pendingB:pendingB.pending,sealedBytes:sealed[0].wire.length,replayResult:replay.result,transfer,...state};
  });
  await group('same-field offline conflict retains both candidates and deterministic display converges',async()=>{
    await a.call('mutate',{operation:'conflict-root'});await exchange(a,b);
    await Promise.all([a.call('mutate',{operation:'conflict-left'}),b.call('mutate',{operation:'conflict-right'})]);await exchange(a,b);
    const state=await converged(a,b,'conflict'),candidates=JSON.parse(state.projection).fields.title;
    equal(candidates.map(row=>row.operation),['conflict-left','conflict-right'],'Concurrent candidates were dropped or reordered');
    equal(candidates.map(row=>row.cell.value.value),['red-offline','blue-offline'],'Conflict values were dropped');
    // Shared engine contract orders ascending by operation ID, last is display winner.
    const display=candidates.at(-1).cell.value.value;assert(display==='blue-offline','Unexpected deterministic display winner');
    const before=state;a=await reopen(a);b=await reopen(b);equal(await converged(a,b,'conflict'),before,'Conflict changed on independent reopen');
    return {candidates,display,...state};
  });
  await group('offline delete/edit race retains tombstone and complete history without resurrection',async()=>{
    await a.call('mutate',{operation:'race-root'});await exchange(a,b);
    await Promise.all([a.call('mutate',{operation:'race-delete'}),b.call('mutate',{operation:'race-edit'})]);await exchange(a,b);
    const state=await converged(a,b,'race'),projection=JSON.parse(state.projection),history=JSON.parse(state.state).operations;
    assert(projection.created&&projection.deleted,'Concurrent edit resurrected deleted generation');
    equal(history.map(row=>row.id),['race-delete','race-edit','race-root'],'Delete/edit history lost');
    assert(projection.fields.title.some(row=>row.cell.value.value==='edited-offline'),'Concurrent edit history discarded');
    await a.call('mutate',{operation:'race-after'}).then(()=>{throw new Error('Post-delete authoring succeeded');},error=>assert(error.message.includes('Deleted'),'Unexpected post-delete rejection: '+error.message));
    a=await reopen(a);b=await reopen(b);equal(await converged(a,b,'race'),state,'Delete/edit tombstone/history changed after reopen');
    return {deleted:projection.deleted,history:history.map(row=>row.id),...state};
  });
  await group('Local and Cache stay device-local with no new outbox, duplicate receives never echo',async()=>{
    const authoredBefore=(await raw(aname,'sync_authored')).length,sourceBefore=(await raw(aname,'sync_source_payloads')).length,relayBefore=(await relay()).items.length;
    const local=await a.call('mutate',{operation:'local-root'}),cache=await a.call('mutate',{operation:'cache-root'});
    equal((await raw(aname,'sync_authored')).length,authoredBefore,'Local/Cache created outbox rows');equal((await raw(aname,'sync_source_payloads')).length,sourceBefore,'Local/Cache created sync source bodies');
    await exchange(a,b);equal((await relay()).items.length,relayBefore,'Local/Cache uploaded ciphertext');
    const own={local:await snapshot(a,'local'),cache:await snapshot(a,'cache')};assert(JSON.parse(own.local.projection).created&&JSON.parse(own.cache.projection).created,'Local/Cache not durably created');
    assert(!JSON.parse((await snapshot(b,'local')).projection).created&&!JSON.parse((await snapshot(b,'cache')).projection).created,'Local/Cache crossed replicas');
    a=await reopen(a);equal(await snapshot(a,'local'),own.local,'Local changed after reopen');equal(await snapshot(a,'cache'),own.cache,'Cache changed after reopen');
    for(const [operation,original] of [['local-root',local],['cache-root',cache]]){const replay=await a.call('mutate',{operation,expected:original.expected});assert(replay.replay,'Local/Cache did not replay');equal(replay.result,original.result,'Local/Cache replay changed');}
    const authoredA=await raw(aname,'sync_authored'),authoredB=await raw(bname,'sync_authored');
    equal(authoredA.map(row=>row.metadata.key.update_id).sort(),['conflict-left','conflict-root','race-delete','race-root','separate-left','separate-root'],'A authored received echo');
    equal(authoredB.map(row=>row.metadata.key.update_id).sort(),['conflict-right','race-edit','separate-right'],'B authored received echo');
    const finalA=await a.call('inspect'),finalB=await b.call('inspect');assert(!finalA.pending.length&&!finalB.pending.length,'Final outbox not empty');
    await a.close();await b.close();return {authoredA:authoredA.length,authoredB:authoredB.length,relayItems:relayBefore,localResult:local.result,cacheResult:cache.result,finalA,finalB};
  });
  report.relay=await relay();
}
try{await main();report.status='passed-subset';}catch(error){report.status='failed';report.error={code:error.code,message:error.message,stack:error.stack};}
finally{
  for(const worker of workers)worker.terminate();workers.clear();report.cleanup=[];
  for(const name of names){try{await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name),timer=setTimeout(()=>reject(new Error('Database deletion deadline')),5000);request.onsuccess=()=>{clearTimeout(timer);resolve();};request.onerror=()=>{clearTimeout(timer);reject(request.error);};});report.cleanup.push({name,deleted:true});}catch(error){report.status='failed';report.error={message:String(error)};}}
  report.finished=true;document.querySelector('#result').textContent=JSON.stringify(report,null,2);window.managedRecordsComplete=true;
}
