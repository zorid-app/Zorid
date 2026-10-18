import {BrowserCoreRuntime} from '../../src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '../../src/platform/browser-client-admission.ts';
import {assert,equal,rejects,pageEvidence,changesEvidence,canonical,assertStrict,replayPreflightEvidence,transactionBeforeRpcEvidence,rowDiffs,abortedAtomicityEvidence} from './assertions.mjs';

import {observeNormalWorkers} from './observation-client.mjs';

// Every authored operation below crosses the actual admitted service. No storage
// apply, synthetic registry, private semantic RPC or alternate Worker is imported.
const report={status:'running',transport:'HTTP1 JSON fixture relay',groups:[],faults:[],ordering:[],atomicitySnapshots:[],remainingGates:[
  'Unrelated fence proof uses a normal file-family mutation, not a second managed collection; 1MiB budget is requested, not saturated',
  'No gRPC/protobuf, rendered UI, native/mobile or full browser matrix proof'],userAgent:navigator.userAgent};
let observation;
window.managedRecordsEvidence=report;
const names=new Set(),hosts=new Set();
const range={start_ms:'1000',end_ms:'2000',timezone:'UTC'};
const target=record=>({record,generation:'g_'+record});
const createInput=record=>({...target(record),operation:'g_'+record,range,title:'baseline'});
const mutation=(record,operation,revision,extra={})=>({...target(record),operation,expectedRevision:revision,...extra});
const query={fromMs:'0',untilMs:'3000',limit:64,byteLimit:1048576};
async function rows(name,store){
  assert(names.has(name),'Database is not owned by this fixture');
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store),r=tx.objectStore(store).getAll();let result;r.onsuccess=()=>result=r.result;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
// One readonly transaction captures keys AND values in every actual store, including
// control counters, collections, source/projection, outbox and cursor families.
async function durable(host,label='durable boundary'){
  assert(names.has(host.name),'Snapshot outside owned fixture DB');
  const entry={id:report.atomicitySnapshots.length+1,database:host.name,label,status:'capturing'};
  report.atomicitySnapshots.push(entry);
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(host.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{
    const snapshot=await new Promise((resolve,reject)=>{
      const all=[...db.objectStoreNames],tx=db.transaction(all,'readonly'),result={};
      for(const store of all){result[store]=[];const r=tx.objectStore(store).openCursor();r.onsuccess=()=>{const cursor=r.result;if(cursor){result[store].push(canonical({key:cursor.key,value:cursor.value}));cursor.continue();}};}
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error??new Error('Snapshot aborted'));
    });
    const previous=report.atomicitySnapshots.slice(0,entry.id-1).findLast(item=>item.database===host.name&&item.status==='captured');
    Object.assign(entry,{status:'captured',snapshot,previous:previous?.id??null,diffs:previous?rowDiffs(previous.snapshot,snapshot):[]});
    return snapshot;
  }catch(error){entry.status='failed';entry.error=String(error);throw error;}finally{db.close();}
}
async function start({name='zorid-core-vault:workblocks-proof-'+crypto.randomUUID(),clientId=crypto.randomUUID(),shared=false,timeoutMs=20000}={}){
  names.add(name);
  const runtime=await BrowserCoreRuntime.open({database:name,clientId,wasmModuleUrl:'/target/browser-wasm/generated/zorid_wasm.js',allowNewVault:true,timeoutMs,...(shared?{}:{initializeLocal:true})});
  const host={name,clientId,runtime,shared,timeoutMs,consumer:null,wb:null};hosts.add(host);
  try{
    if(shared)await runtime.configureSyncFixture(credentials());
    host.consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()});
    host.wb=host.consumer.workBlocks;
    assert(host.wb,'Normal admitted WorkBlock capability absent; H/P startup contract must be composed');
    return host;
  }catch(error){runtime.close();hosts.delete(host);throw error;}
}
async function close(host){try{await host.consumer.release(()=>{});}finally{host.runtime.close();hosts.delete(host);}}
async function reopen(host){const {name,clientId,shared,timeoutMs}=host;await close(host);return start({name,clientId,shared,timeoutMs});}
function credentials(extra={}){return {endpoint:location.origin,realmId:'replica-realm',vaultId:'replica-vault',serverEpoch:'replica-epoch',keyEpoch:1,bearerToken:'synthetic-replicas-only',keyBytes:new Uint8Array(32).fill(41),allowLoopbackHttp:true,enrollEmpty:true,...extra};}
const outcome=promise=>promise.then(value=>({value}),error=>({error:{code:error.code,source:error.source,commitUncertain:error.commitUncertain}}));
function abandon(host){host.runtime.close();hosts.delete(host);}
async function reacquire(host){for(let attempts=0;attempts<100;attempts++){try{return await start({name:host.name,clientId:host.clientId,shared:host.shared});}catch(error){if(error.code!=='client_already_owned')throw error;await new Promise(resolve=>setTimeout(resolve,20));}}throw new Error('Exact client lease did not reacquire');}
async function group(name,run){const begun=performance.now();try{const evidence=await run();report.groups.push({name,status:'passed',ms:Math.round(performance.now()-begun),evidence});}catch(error){report.groups.push({name,status:'failed',ms:Math.round(performance.now()-begun),error:String(error)});throw error;}}
async function local(){
  let h=await start();
  await group('normal admitted CRUD/ref lifecycle, immutable receipts, rejections and restart',async()=>{
    const input=createInput('crud'),created=await h.wb.create(input);
    let current=await h.wb.read(target('crud'));assert(current.created&&!current.deleted,'Create not readable');equal(current.revision,created.revision,'Create witness mismatch');
    const moved=await h.wb.move(mutation('crud','move',current.revision,{range:{...range,start_ms:'1100'}}));
    const titled=await h.wb.title(mutation('crud','title',moved.revision,{title:null}));
    const added=await h.wb.addRef(mutation('crud','add',titled.revision,{task:'missing_note'}));
    const remove=mutation('crud','remove',added.revision,{task:'missing_note'}),removed=await h.wb.removeRef(remove);
    const readded=await h.wb.addRef(mutation('crud','readd',removed.revision,{task:'missing_note'}));
    const beforeReplay=await durable(h);equal(await h.wb.removeRef(remove),removed,'Replay changed original remove receipt');equal(await h.wb.create(input),created,'Create replay changed receipt');equal(await durable(h),beforeReplay,'Replay wrote durable state');
    current=await h.wb.read(target('crud'));equal(current.block.taskRefs,['missing_note'],'Original remove retry erased later add');
    const beforeReject=await durable(h);
    const stale=await rejects(()=>h.wb.title(mutation('crud','stale',created.revision,{title:'stale'})),'stale_revision');
    assert(stale.commitUncertain===false,'Stale precommit failure reported uncertain');
    await rejects(()=>h.wb.create({...input,title:'collision'}),'operation_collision');
    await rejects(()=>h.wb.create({...createInput('other'),operation:input.operation,generation:input.generation}),'operation_collision');
    await rejects(()=>h.wb.move(mutation('crud','invalid',readded.revision,{range:{...range,end_ms:'0'}})),'invalid_workblock');
    equal(await durable(h),beforeReject,'Rejected mutation made partial journal/source/outbox/change writes');
    h=await reopen(h);equal(await h.wb.create(input),created,'Restart changed original create receipt');equal(await h.wb.removeRef(remove),removed,'Restart recomputed observed-remove tags');
    current=await h.wb.read(target('crud'));const deleted=await h.wb.delete(mutation('crud','delete',current.revision));current=await h.wb.read(target('crud'));assert(current.deleted&&current.block===null,'Deleted block exposed live value');
    const changes=changesEvidence(await h.wb.changes({after:'0',limit:64}),'0',64);changesEvidence(await h.wb.changes({after:changes.next,limit:64}),changes.next,64);
    return {created,moved,titled,added,removed,readded,deleted,stale,changes};
  });
  await group('bounded window scanning, byte nonconsumption, cursor/query/watermark fences',async()=>{
    // 66 deliberately bounds this proof while crossing the native 64-row limit.
    for(let i=0;i<66;i++)await h.wb.create(createInput('window_'+String(i).padStart(2,'0')));
    const first=pageEvidence(await h.wb.windowPage(query),query);assert(first.scanned===64&&first.incomplete,'64-row cap not exercised');
    let cursor=first.cursor,seen=[...first.blocks.map(x=>x.record)],pages=1;
    while(cursor){assert(pages++<5,'Bounded scan failed to finish');const q={...query,cursor},page=pageEvidence(await h.wb.windowPage(q),q);seen.push(...page.blocks.map(x=>x.record));cursor=page.cursor;}
    assert(seen.length===66&&new Set(seen).size===66,'Coverage skipped/duplicated a live record or included deleted crud');
    const q={...query,limit:1},one=pageEvidence(await h.wb.windowPage(q),q);assert(one.cursor,'No continuation');
    const next={...q,cursor:one.cursor},second=await h.wb.windowPage(next);equal(await h.wb.windowPage(next),second,'Repeated cursor changed page');
    // Use Rust-reported native snapshot byte counts as the oracle; do not
    // reconstruct native snapshot JSON or recalculate domain byte accounting.
    const partialQuery={...query,byteLimit:one.bytes+second.bytes-1},partial=pageEvidence(await h.wb.windowPage(partialQuery),partialQuery);
    assert(partial.scanned===1&&partial.bytes===one.bytes&&partial.incomplete,'Second byte-excluded row was consumed or first row was skipped');
    const resumed=pageEvidence(await h.wb.windowPage({...partialQuery,cursor:partial.cursor}),partialQuery);
    equal(resumed.blocks[0],second.blocks[0],'Byte-excluded row did not resume as the next live record');
    assert(typeof h.consumer.fileCommand==='function','Normal unrelated file-family command unavailable');
    await h.consumer.fileCommand({kind:'createText',operationId:crypto.randomUUID(),entryId:crypto.randomUUID(),path:'unrelated.md',content:'normal unrelated family update'});
    equal(await h.wb.windowPage(next),second,'Unrelated family/global sequence invalidated WorkBlock collection fence');

    await rejects(()=>h.wb.windowPage({...next,byteLimit:1000}),'invalid_request');
    await rejects(()=>h.wb.windowPage({...query,limit:65}),'limit');
    await rejects(()=>h.wb.windowPage({...query,untilMs:String(31*86400000+1)}),'invalid_workblock');
    await rejects(()=>h.wb.windowPage({...query,byteLimit:1}),'limit');
    const afterLimit=await h.wb.windowPage(q);equal(afterLimit.blocks,one.blocks,'Oversized first row consumed state');
    const foreign=await start();try{await rejects(()=>foreign.wb.windowPage(next),'cursor_expired');}finally{await close(foreign);}
    const stale=await h.wb.windowPage(q);await h.wb.create(createInput('watermark'));
    await rejects(()=>h.wb.windowPage({...q,cursor:stale.cursor}),'window_changed');
    const emptyQuery={...query,fromMs:'4000',untilMs:'5000'},empty=pageEvidence(await h.wb.windowPage(emptyQuery),emptyQuery);assert(empty.blocks.length===0&&empty.scanned>0,'Filtered rows did not count');
    const evictionBase=pageEvidence(await h.wb.windowPage(q),q),old=evictionBase.cursor;
    assert(typeof old==='string'&&old.length>0,'Eviction baseline has no continuation');
    equal(await h.wb.windowPage(q),evictionBase,'Same query/progress/watermark changed page or cursor');
    // Rust deduplicates identical query/after/watermark continuations. Distinct
    // valid bounds must allocate new slots without changing collection state.
    const eviction={original:old,watermark:evictionBase.watermark,allocations:[]},allocated=new Set([old]);
    for(let fromMs=1;fromMs<=9;fromMs++){
      const boundQuery={...q,fromMs:String(fromMs)},page=pageEvidence(await h.wb.windowPage(boundQuery),boundQuery);
      equal(page.watermark,evictionBase.watermark,'Eviction setup changed collection watermark');
      assert(typeof page.cursor==='string'&&page.cursor.length>0&&!allocated.has(page.cursor),'Distinct bound query did not allocate a distinct continuation');
      allocated.add(page.cursor);eviction.allocations.push({query:boundQuery,page});
    }
    await rejects(()=>h.wb.windowPage({...q,cursor:old}),'cursor_expired');
    const reopened=(await h.wb.windowPage(q)).cursor;h=await reopen(h);await rejects(()=>h.wb.windowPage({...q,cursor:reopened}),'cursor_expired');
    return {first,coverage:seen.length,pages,empty,partial,resumed,eviction};
  });
  await close(h);
}
const relay=()=>fetch('/__replica_relay').then(r=>r.json());
async function exchange(a,b){const results=[];for(const host of [a,b,a,b])results.push(await host.runtime.syncOnce());const outboxes=await Promise.all([rows(a.name,'sync_authored'),rows(b.name,'sync_authored')]);assert(outboxes.every(list=>list.every(row=>row.pending===0)),'Outboxes not empty');equal(await rows(a.name,'sync_cursors'),await rows(b.name,'sync_cursors'),'Shared cursor differs');return results;}
async function converged(a,b,record){equal(await a.wb.read(target(record)),await b.wb.read(target(record)),'Public candidates/revision/tombstone differ');const pick=async h=>(await rows(h.name,'managed_records')).filter(row=>row.record===record);const state=await pick(a);equal(state,await pick(b),'Canonical state/projection differ');return {read:await a.wb.read(target(record)),state};}
async function replicas(){
  let a=await start({shared:true}),b=await start({shared:true});assert(a.runtime.durableScope.vaultId!==b.runtime.durableScope.vaultId&&a.clientId!==b.clientId,'Shared local authority/lease');
  const own=new Map([[a.name,new Set()],[b.name,new Set()]]),receipts=[];
  async function author(h,method,input){const receipt=await h.wb[method](input);own.get(h.name).add(input.operation);receipts.push({name:h.name,method,input,receipt});return receipt;}
  await group('two normal Workers: encrypted offline field/ref/delete races, restart receipts and no echo',async()=>{
    for(const record of ['separate','conflict','range_conflict','refs','delete'])await author(a,'create',createInput(record));
    let refs=await a.wb.read(target('refs'));await author(a,'addRef',mutation('refs','refs_base',refs.revision,{task:'missing_note'}));
    await exchange(a,b);const networkBefore=await relay();
    let left=await a.wb.read(target('separate')),right=await b.wb.read(target('separate'));
    await author(a,'title',mutation('separate','separate_title',left.revision,{title:'left'}));await author(b,'move',mutation('separate','separate_move',right.revision,{range:{...range,start_ms:'1200'}}));
    left=await a.wb.read(target('conflict'));right=await b.wb.read(target('conflict'));
    await author(a,'title',mutation('conflict','conflict_left',left.revision,{title:'red'}));await author(b,'title',mutation('conflict','conflict_right',right.revision,{title:'blue'}));
    left=await a.wb.read(target('range_conflict'));right=await b.wb.read(target('range_conflict'));
    await author(a,'move',mutation('range_conflict','range_left',left.revision,{range:{...range,start_ms:'1100'}}));await author(b,'move',mutation('range_conflict','range_right',right.revision,{range:{...range,end_ms:'2200'}}));
    left=await a.wb.read(target('refs'));right=await b.wb.read(target('refs'));
    const removed=await author(a,'removeRef',mutation('refs','refs_remove',left.revision,{task:'missing_note'}));await author(a,'addRef',mutation('refs','refs_readd',removed.revision,{task:'missing_note'}));await author(b,'addRef',mutation('refs','refs_concurrent_add',right.revision,{task:'missing_note'}));
    left=await a.wb.read(target('delete'));right=await b.wb.read(target('delete'));
    await author(a,'delete',mutation('delete','delete_left',left.revision));await author(b,'title',mutation('delete','delete_edit',right.revision,{title:'retained edit'}));
    equal((await relay()).requests,networkBefore.requests,'Offline authoring performed network I/O');
    const originalJournals=await Promise.all([rows(a.name,'managed_local_operations'),rows(b.name,'managed_local_operations')]);
    a=await reopen(a);b=await reopen(b);equal(await Promise.all([rows(a.name,'managed_local_operations'),rows(b.name,'managed_local_operations')]),originalJournals,'Restart changed original receipt bytes');
    // Normal sync seals through WebCrypto/core and persists wire bytes. The relay
    // stores opaque bytes only; it does not fabricate records or encrypt updates.
    await exchange(a,b);const wireA=await rows(a.name,'sync_source_wires'),wireB=await rows(b.name,'sync_source_wires');
    const states={};for(const record of ['separate','conflict','range_conflict','refs','delete'])states[record]=await converged(a,b,record);
    equal(states.conflict.read.block.titles.map(x=>x.title).sort(),['blue','red'],'Same-title alternatives lost');
    equal(states.range_conflict.read.block.ranges.map(x=>x.operation).sort(),['range_left','range_right'],'Atomic same-range alternatives lost');
    equal(states.refs.read.block.taskRefs,['missing_note'],'Reference readdition lost');assert(states.delete.read.deleted&&states.delete.read.block===null,'Delete/edit resurrected');
    assert(states.separate.read.block.titles.some(x=>x.title==='left')&&states.separate.read.block.ranges.some(x=>x.range.start_ms==='1200'),'Separate fields lost');
    a=await reopen(a);b=await reopen(b);equal(await rows(a.name,'sync_source_wires'),wireA,'A restart changed sealed bytes');equal(await rows(b.name,'sync_source_wires'),wireB,'B restart changed sealed bytes');
    for(const item of receipts){const host=item.name===a.name?a:b;equal(await host.wb[item.method](item.input),item.receipt,'Exact receipt replay changed after merge/restart');}
    for(const h of [a,b])equal((await rows(h.name,'sync_authored')).map(row=>row.metadata.key.update_id).sort(),[...own.get(h.name)].sort(),'Receive echoed into authored ledger');
    const before=(await relay()).items;await exchange(a,b);equal((await relay()).items,before,'No-op exchange added wire items');
    return {authorities:[a.runtime.durableScope,b.runtime.durableScope],states,receipts,relay:await relay(),wireRows:[wireA.length,wireB.length]};
  });
  await group('normal encrypted receive rejects wrong key/scope and aborts a session-revoked held transaction',async()=>{
    await author(b,'create',createInput('negative_key'));await b.runtime.syncOnce();
    await a.runtime.revokeSync();await a.runtime.configureSyncFixture(credentials({keyBytes:new Uint8Array(32).fill(42)}));
    const beforeKey=await durable(a),wrongKey=await outcome(a.runtime.syncOnce());
    await durable(a,'after wrong-key receive settled');
    assert(wrongKey.error?.code==='sync_plan_rejected','Wrong key did not fail actual Rust authenticated opening');
    equal(await durable(a),beforeKey,'Wrong-key receive changed rows/cursor/source/outbox');
    await a.runtime.revokeSync();const beforeScope=await durable(a);
    const wrongScope=await outcome(a.runtime.configureSyncFixture(credentials({vaultId:'wrong_scope',enrollEmpty:false})));
    await durable(a,'after wrong-scope configuration settled');
    assert(wrongScope.error?.code==='sync_scope_conflict','Wrong-scope configuration did not fail closed');equal(await durable(a),beforeScope,'Wrong-scope configuration changed local data');
    await a.runtime.configureSyncFixture(credentials());await exchange(a,b);await converged(a,b,'negative_key');
    const input=createInput('negative_revoked');await author(b,'create',input);await b.runtime.syncOnce();
    const beforeRevoke=await durable(a),index=observation.events.length;
    await observation.command(a,'arm-hold',{operation:input.operation,point:'before-prepare',store:'managed_receipts'});
    const receiving=outcome(a.runtime.syncOnce());
    const held=await observation.event(a,'held-transaction',index,event=>event.operation===input.operation);
    report.faults.push({kind:'hold-real-encrypted-receive-callback',database:a.name,operation:input.operation,transaction:held.transaction,deliberate:true});
    await a.runtime.revokeSync();await observation.command(a,'release-hold');const revoked=await receiving;
    await durable(a,'after held receive revocation settled');
    assert(revoked.error?.code==='sync_session_revoked','Revoked receive returned success or wrong failure');
    const tx=await completedMutationTx(a,input.operation,index,'sync-once');assert(tx.outcome==='abort','Revoked session did not abort actual strict receive transaction');
    equal(await durable(a),beforeRevoke,'Revoked receive changed data/source/outbox/cursor');
    await a.runtime.configureSyncFixture(credentials());await exchange(a,b);const recovered=await converged(a,b,'negative_revoked');
    for(const h of [a,b])equal((await rows(h.name,'sync_authored')).map(row=>row.metadata.key.update_id).sort(),[...own.get(h.name)].sort(),'Fault recovery echoed received content');
    return {wrongKey,wrongScope,revoked,tx,recovered};
  });
  await close(a);await close(b);
}
try{
  report.provenance=await fetch('/__managed_fixture_provenance').then(r=>r.json());
  observation=observeNormalWorkers(report.provenance.observation.channel);
  await local();await faults();await replicas();
  await observation.until(()=>observation.events.filter(e=>e.event==='transaction-start'&&e.mode==='readwrite').every(start=>observation.events.some(end=>end.workerId===start.workerId&&end.event==='transaction'&&end.witness.id===start.id)),'all actual write transaction terminal witnesses');
  const writes=observation.events.filter(e=>e.event==='transaction'&&e.witness.mode==='readwrite').map(e=>e.witness);assertStrict(writes);
  assert(!observation.events.some(e=>['observer-error','hold-deadline'].includes(e.event)),'Observer failed or hold deadline released a fault');
  report.strict={count:writes.length,complete:writes.filter(x=>x.outcome==='complete').length,abort:writes.filter(x=>x.outcome==='abort').length};
  report.status='passed-subset';
}
catch(error){report.status='failed';report.error={code:error.code,message:error.message,stack:error.stack};}
finally{
  for(const host of [...hosts])try{await durable(host,'final boundary before cleanup');}catch(error){report.status='failed';report.snapshotError=String(error);}
  // Close even after an assertion failed; delete only databases named here.
  for(const host of [...hosts]){try{await close(host);}catch(error){host.runtime.close();report.cleanupError=String(error);report.status='failed';}}
  report.cleanup=[];
  for(const name of names){try{await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name),timer=setTimeout(()=>reject(new Error('Owned DB cleanup deadline')),5000);r.onsuccess=()=>{clearTimeout(timer);resolve();};r.onerror=()=>{clearTimeout(timer);reject(r.error);};});report.cleanup.push({name,deleted:true});}catch(error){report.status='failed';report.cleanup.push({name,error:String(error)});}}
  if(observation){report.observationEvents=observation.events;observation.cleanup();}
  report.finished=true;document.querySelector('#result').textContent=JSON.stringify(report,null,2);window.managedRecordsComplete=true;
}

/** Deliberate fault, restricted to an owned disposable DB: corrupt/restore one
 * current accepted-state row. Never creates history, receipt, command or source. */
async function replaceAcceptedState(host,record,replacement){
  assert(names.has(host.name),'Fault outside owned DB');
  await durable(host,'before accepted-state corruption/restore: '+record);
  const original=(await rows(host.name,'managed_records')).find(row=>row.record===record);assert(original,'Fault target missing');
  const changed={...original,state:replacement??new Uint8Array([255])};
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(host.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(['managed_records'],'readwrite',{durability:'strict'});assert(tx.durability==='strict','Fault injection storage is not strict');
    tx.objectStore('managed_records').put(changed);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  await durable(host,'after accepted-state corruption/restore: '+record);
  report.faults.push({kind:replacement?'restore-original-current-state':'corrupt-current-state',database:host.name,record,bytes:changed.state.byteLength,deliberate:true});
  return original.state;
}
async function holdMutation(host,input,point,location={}){
  await durable(host,'before '+point+' fault: '+input.operation);
  const index=observation.events.length;
  await observation.command(host,'arm-hold',{operation:input.operation,point,...location});
  const pending=outcome(host.wb.title(input)).then(async result=>{await durable(host,'after '+point+' mutation settled: '+input.operation);return result;});
  const held=await observation.event(host,'held-transaction',index,event=>event.operation===input.operation);
  equal(held.point,point,'Wrong native transaction boundary');
  report.faults.push({kind:'hold-real-native-IDB',database:host.name,operation:input.operation,point,transaction:held.transaction,deliberate:true});
  return {pending,held,index};
}
async function completedMutationTx(host,operation,index=0,rpc='workblock-command'){
  const terminal=await observation.event(host,'transaction',index,event=>event.witness.operation===operation&&event.witness.mode==='readwrite');
  const incoming=await observation.event(host,'rpc-in',index,event=>event.rpc===rpc&&(rpc!=='workblock-command'||event.operation===operation));
  const reply=await observation.event(host,'rpc-reply',index,event=>event.id===incoming.id);
  report.ordering.push(transactionBeforeRpcEvidence(terminal,reply));
  return terminal.witness;
}

function noStaleNotification(host,releaseOrdinal){
  assert(!observation.events.some(event=>observation.matches(host,event)&&event.event==='product-event'&&event.kind==='change'&&event.ordinal>releaseOrdinal),'Stale change notification after worker closing');
}
async function faults(){
  await group('journal replay precedes deliberately corrupt current state and source/quota reads',async()=>{
    const h=await start(),record='replay_fault';
    let state;
    try{
      const created=await h.wb.create(createInput(record));
      const added=await h.wb.addRef(mutation(record,'fault_add',created.revision,{task:'missing_note'}));
      const input=mutation(record,'fault_remove',added.revision,{task:'missing_note'}),removed=await h.wb.removeRef(input);
      await h.wb.addRef(mutation(record,'fault_readd',removed.revision,{task:'missing_note'}));
      await observation.command(h,'inspect');
      state=await replaceAcceptedState(h,record);
      const before=await durable(h),index=observation.events.length;
      equal(await h.wb.removeRef(input),removed,'Corrupt current state prevented exact committed replay');
      const witness=replayPreflightEvidence(await completedMutationTx(h,input.operation,index));
      equal(await durable(h),before,'Exact replay changed rows while current state was corrupt');
      await replaceAcceptedState(h,record,state);state=undefined;
      equal((await h.wb.read(target(record))).block.taskRefs,['missing_note'],'Original removal tags changed after corruption/retry');
      return {receipt:removed,witness,deliberateFault:'invalid UTF8 current state only; original row restored'};
    }finally{if(state)await replaceAcceptedState(h,record,state);await close(h);}
  });
  await group('admitted release drains held strict writes before cleanup and exact client reacquires',async()=>{
    let h=await start();const created=await h.wb.create(createInput('drain'));
    const input=mutation('drain','drain_title',created.revision,{title:'held'}),held=await holdMutation(h,input,'after-final-write');
    let released=false;const releasing=h.consumer.release(()=>{}).then(()=>{released=true;});
    await rejects(()=>h.wb.create(createInput('not_admitted')),'client_not_admitted');
    await observation.command(h,'inspect');assert(!released,'Admitted release returned before real transaction completed');
    await observation.command(h,'release-hold');const result=await held.pending;assert(result.value&&!result.error,'Drained admitted write failed');await releasing;
    const tx=await completedMutationTx(h,input.operation,held.index);assert(tx.outcome==='complete','Drained real write did not commit');
    const reply=await observation.event(h,'rpc-reply',held.index,event=>event.operation===input.operation);assert(!reply.held&&reply.ok,'Success returned with a held transaction');
    const completeEvent=observation.events.find(event=>event.event==='transaction'&&event.workerId===reply.workerId&&event.witness.id===tx.id);assert(completeEvent.ordinal<reply.ordinal,'Success acknowledgement preceded strict transaction completion');
    const old=h;hosts.delete(h);h=await reacquire(old);equal(await h.wb.title(input),result.value,'Drained receipt changed on reacquisition');await close(h);
    return {receipt:result.value,tx,reacquiredClient:old.clientId};
  });
  for(const point of ['before-prepare','common-authored','after-final-write'])await group('deliberate worker release during real '+point+' hold preserves exact outcome',async()=>{
    let h=await start();const created=await h.wb.create(createInput('owner_loss'));let retainedFacade;
    const input=mutation('owner_loss','owner_'+point.replaceAll('-','_'),created.revision,{title:point}),before=await durable(h);
    const held=await holdMutation(h,input,point,point==='common-authored'?{store:'sync_state',key:'authored-sequence'}:{});
    let releaseSettled=false;const release=observation.inject(h,'release-client').then(()=>{releaseSettled=true;});
    const closing=await observation.event(h,'rpc-in',held.index,event=>event.rpc==='release-client');
    await observation.command(h,'inspect');assert(!releaseSettled,'Worker acknowledged release before held strict transaction drained');
    await observation.command(h,'release-hold');const result=await held.pending;await release;
    const after=await durable(h,'after release-client settled: '+input.operation);
    const tx=await completedMutationTx(h,input.operation,held.index);assert(result.error,'Owner-loss mutation reported success');
    const old=h;
    if(point!=='after-final-write'){
      assert(tx.outcome==='abort','Pre-prepare guarded callback did not abort actual transaction');
      const evidence={database:h.name,operation:input.operation,point,before,after,diffs:rowDiffs(before,after),events:observation.events.slice(held.index).filter(event=>observation.matches(h,event))};
      report.faults.push({kind:'aborted-atomicity',...evidence});
      abortedAtomicityEvidence(evidence);
      if(point==='common-authored')for(const store of ['managed_records','managed_changes','sync_source_headers','sync_source_payloads'])assert(tx.writes.some(write=>write.store===store),'Fault missed staged common authored writes: '+store);
      assert(result.error.commitUncertain===false,'Proven precommit abort must be definite');
    }else{
      assert(tx.outcome==='complete','Final-write owner-loss case did not exercise actual late durable commit');
      assert(result.error.commitUncertain===true,'Late durable commit was misreported definite');
      assert((await rows(h.name,'managed_local_operations')).some(row=>row.operationId===input.operation),'Completed late transaction lost original receipt');
      // Deliberately keep the same parent runtime/facade after genuine worker
      // owner loss. This is explicit user-style retry, never an automatic rebase.
      const facade=h.wb,workerCount=observation.workers.length,beforeRetry=await durable(h),retryIndex=observation.events.length;
      const retry=await outcome(facade.title(input));
      const raw=await observation.event(h,'rpc-reply',retryIndex,event=>event.rpc==='workblock-command'&&event.operation===input.operation);
      assert(raw.ok===false&&raw.error?.code==='client_ownership_lost'&&raw.error.commitUncertain===false,'Explicit same-facade retry did not receive genuine definite predispatch rejection');
      assert(retry.error?.commitUncertain===true,'Definite retry rejection erased original retained uncertainty');
      const beforeChanged=observation.events.length;
      await rejects(()=>facade.title({...input,title:'changed input must not replace retained original'}),'operation_collision');
      await observation.command(h,'inspect');
      assert(!observation.events.slice(beforeChanged).some(event=>observation.matches(h,event)&&event.event==='rpc-in'&&event.rpc==='workblock-command'),'Changed retained request escaped to Worker');
      const sameIdCalls=observation.events.slice(retryIndex).filter(event=>observation.matches(h,event)&&event.event==='rpc-in'&&event.rpc==='workblock-command');
      assert(sameIdCalls.length===1&&sameIdCalls[0].operation===input.operation,'Facade automatically retried or invented a new operation identity');
      assert(!observation.events.slice(retryIndex).some(event=>observation.matches(h,event)&&event.event==='transaction-start'&&event.mode==='readwrite'),'Predispatch retry unexpectedly attempted a write transaction');
      assert(h.wb===facade&&observation.workers.length===workerCount,'Sticky retry replaced retained facade or normal Worker');
      equal(await durable(h),beforeRetry,'Definite retry/local collision changed durable data');
      retainedFacade={retry,raw,explicitRetryRpc:sameIdCalls[0],sameFacade:true,newWorker:false,localChangedRequestBlocked:true,noAutomaticMutation:true};
    }
    noStaleNotification(h,closing.ordinal);abandon(h);h=await reacquire(old);
    let recovered;
    if(point==='after-final-write'){
      const row=(await rows(h.name,'managed_local_operations')).find(row=>row.operationId===input.operation);
      const receipt=JSON.parse(new TextDecoder().decode(row.result)),beforeReplay=await durable(h),replayIndex=observation.events.length;
      recovered=await h.wb.title(input);await completedMutationTx(h,input.operation,replayIndex);equal(recovered,receipt,'Late commit recovery changed original receipt bytes');equal(await durable(h),beforeReplay,'Late recovery reauthored a row');
    }else equal(await h.wb.read(target('owner_loss')).then(x=>x.revision),created.revision,'Aborted mutation changed revision');
    await close(h);return {point,result,tx,retainedFacade,recovered,reacquiredClient:old.clientId};
  });
  await group('sync revocation during held local authoring preserves credential-independent durable save',async()=>{
    const h=await start({shared:true}),created=await h.wb.create(createInput('config_local'));
    const input=mutation('config_local','config_local_title',created.revision,{title:'no network credential required'});
    const beforeNetwork=await relay(),held=await holdMutation(h,input,'before-prepare');
    await h.runtime.revokeSync();await observation.command(h,'release-hold');const result=await held.pending;
    assert(result.value&&!result.error,'Sync credential revocation incorrectly rejected local authoring');
    equal((await relay()).requests,beforeNetwork.requests,'Local save used network during revoked configuration');
    assert((await rows(h.name,'sync_authored')).some(row=>row.metadata.key.update_id===input.operation&&row.pending===1),'Revoked-session local save lost durable common outbox');
    await h.runtime.configureSyncFixture(credentials());equal(await h.wb.title(input),result.value,'Reconfigure changed receipt');
    const tx=await completedMutationTx(h,input.operation,held.index);await close(h);return {receipt:result.value,tx};
  });
  await group('deliberate exact reply loss after commit remains uncertain and replays original receipt',async()=>{
    let h=await start({timeoutMs:3000});const input=createInput('lost_reply'),index=observation.events.length;
    await durable(h,'before deliberate exact reply loss');
    await observation.command(h,'drop-operation-reply',{operation:input.operation});
    const pending=outcome(h.wb.create(input));
    const dropped=await observation.event(h,'dropped-reply',index,event=>event.operation===input.operation);assert(dropped.ok,'Dropped a rejection instead of a committed receipt');
    report.faults.push({kind:'drop-exact-normal-worker-reply',database:h.name,operation:input.operation,deliberate:true});
    const result=await pending;await durable(h,'after deliberate exact reply loss');assert(result.error?.commitUncertain===true,'Lost committed reply was not uncertain');await completedMutationTx(h,input.operation,index);
    const journal=(await rows(h.name,'managed_local_operations')).find(row=>row.operationId===input.operation);assert(journal,'Lost-reply commit not durable');
    const before=await durable(h),old=h;abandon(h);h=await reacquire(old);
    const replayIndex=observation.events.length,recovered=await h.wb.create(input);await completedMutationTx(h,input.operation,replayIndex);equal(recovered,JSON.parse(new TextDecoder().decode(journal.result)),'Lost-reply restart changed original receipt');equal(await durable(h),before,'Lost-reply retry appended source/journal/change/outbox');
    await close(h);return {dropped,result,recovered};
  });
  await group('two normal same-authority clients catch a deliberately lost hint on foreground refresh',async()=>{
    const writer=await start(),reader=await start({name:writer.name});
    let delivered=0;const unsubscribe=reader.runtime.subscribe(()=>{delivered++;});
    try{
      await observation.inject(reader,'refresh');await reader.wb.changes({after:'0',limit:1});await observation.command(reader,'inspect');await observation.command(writer,'suppress-hints',{enabled:true});
      const index=observation.events.length,before=delivered,receipt=await writer.wb.create(createInput('lost_hint'));
      await observation.event(writer,'dropped-hint',index);await observation.command(reader,'inspect');equal(delivered,before,'Lost hint reached the other normal Worker');
      assert(document.visibilityState==='visible','Foreground fixture document is not visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await observation.until(()=>delivered>before,'foreground authoritative managed-change catch-up');
      equal((await reader.wb.read(target('lost_hint'))).revision,receipt.revision,'Foreground caught no durable WorkBlock');
      const caught=delivered;document.dispatchEvent(new Event('visibilitychange'));await observation.inject(reader,'refresh');await observation.command(reader,'inspect');equal(delivered,caught,'Foreground refresh repeated a durable notification');
      return {receipt,delivered:delivered-before,authorities:[writer.runtime.durableScope,reader.runtime.durableScope]};
    }finally{unsubscribe();await close(reader);await close(writer);}
  });
}
