'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');
const {admitDesktopFixtureClient}=require('../desktop/client-admission.cjs');

const clientId='10000000-0000-4000-8000-000000000001';
const failure=(code,uncertain=false)=>Object.assign(new Error(code),{code,commitUncertain:uncertain});
function gate(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function settled(){for(let index=0;index<40;index++)await Promise.resolve();}
const frame=()=>({version:1,scope:{localStoreId:'authority',clientId},update:null,outcomes:[]});
function wire(op,value){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,op,value}));return {result:{documents:true,schemaVersion:1,bytes:bytes.length},bytes};}

/** Real service/admission and RustVaultService lease wrappers, with no native
 * process, timers, watcher, filesystem, or reducer simulation. The injected
 * scheduler double records only the documented owner lifecycle calls. Actual
 * effect selection, owner ACKs and the global request registry are tested at
 * their own module boundaries. */
function fixture({legacy=false,releaseFailures=0}={}){
  const host=Object.create(RustVaultService.prototype),events=[],requests=[],registrations=[];
  const lease={local_store_id:'authority',client_id:clientId,token:'10000000-0000-4000-8000-000000000002'};
  let active=null,owner=true,observeGate,prepareFailure,pollEnabled=false;
  host.capabilities=['documents','document_runtime'];host.root='/unused-runtime-admission';
  host.request=async(command,bytes=new Uint8Array(),reference,beforeDispatch)=>{
    beforeDispatch?.();
    requests.push({command,reference});events.push(`rpc:${command.method==='documents'?command.request.command.op:command.method}`);
    if(command.method==='claim_client'){active=lease;return {result:{lease}};}
    if(command.method==='release_client'){
      assert.deepEqual(command.reference,lease);
      if(releaseFailures-- >0)throw failure('release_unknown',true);
      active=null;return {result:{released:true,reference:command.reference}};
    }
    assert.deepEqual(reference,active,'all admitted RPCs retain the exact claimed native lease');
    if(command.method==='identity')return {result:{identity:{local_store_id:'authority',realm_id:null,vault_id:null}},bytes};
    if(command.method==='changes_after')return {result:{changes:[],next_cursor:'0',head_cursor:'0',has_more:false},bytes};
    if(command.method==='rescan')return {result:{complete:true,finished:true},bytes};
    if(command.method==='documents'){
      assert.equal(command.client_id,clientId);assert.equal(command.request.command.op,'runtime_observe');
      if(observeGate)await observeGate;
      return wire('runtime_observe',frame());
    }
    assert.fail(`Unexpected fake host operation: ${command.method}`);
  };
  const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000,...(legacy?{}:{documentRuntime:true})});
  // Replace only the OS execution seams; syncPolling and poll/pollNow are real.
  service.startPolling=()=>{pollEnabled=true;events.push('poll:start');};
  service.stopPolling=()=>{pollEnabled=false;events.push('poll:stop');};
  service.documentScheduler={
    addOwner(options){
      registrations.push(options);const subscribers=new Set();let retired=false;
      const finish=()=>{if(retired)return;retired=true;for(const slot of subscribers)slot.onRetire();subscribers.clear();};
      return {
        async observe(){options.assertActive();const result=await options.host.documentRuntime(clientId,'runtime_observe');options.assertActive();events.push('runtime:observe:done');return result;},
        async control(){assert.fail('this fixture does not implement a request registry');},
        async ackControl(){assert.fail('unexpected feature ACK');},async ackOutcome(){assert.fail('unexpected outcome ACK');},
        subscribe(listener,onRetire=()=>{}){const slot={listener,onRetire};subscribers.add(slot);return()=>subscribers.delete(slot);},
        async pause(){events.push('runtime:pause');},
        resume(){events.push('runtime:resume');},
        async prepareRelease(){
          events.push('runtime:prepare');options.assertActive();
          // An already-admitted native call must still pass the phase guard
          // after the source flush and before raw lease release.
          await options.host.identity();
          if(prepareFailure){const error=prepareFailure;prepareFailure=undefined;throw error;}
          events.push('runtime:retire');
        },
        release(){events.push('runtime:release');finish();},
        async revoke(){events.push('runtime:revoke');finish();},
      };
    },
    wake(){events.push('runtime:wake');},sourceHint(){events.push('runtime:hint');},async close(){events.push('runtime:close');},
  };
  const options={fixture:true,clientId,assertOwner(){if(!owner)throw failure('grant_retired');}};
  return {host,service,events,requests,registrations,lease,options,
    get active(){return active;},get polling(){return pollEnabled;},
    set owner(value){owner=value;},holdObserve(promise){observeGate=promise;},failPrepare(error){prepareFailure=error;},
  };
}
const releases=f=>f.requests.filter(row=>row.command.method==='release_client');
const runtimeCalls=f=>f.requests.filter(row=>row.command.method==='documents');
const count=(f,event)=>f.events.filter(value=>value===event).length;

test('runtime stays disabled by default and legacy admission does not register an owner',async()=>{
  const f=fixture({legacy:true}),context=await admitDesktopFixtureClient(f.service,f.options);
  assert.equal(f.service.documentRuntimeEnabled,false);assert.equal(Object.hasOwn(context,'documentRuntime'),false);
  assert.equal(f.registrations.length,0);assert.equal(f.polling,false);assert.equal(runtimeCalls(f).length,0);
  await context.release(()=>{});assert.equal(f.active,null);
});

test('explicit runtime selection rejects hosts missing either required capability',()=>{
  for(const capabilities of [[],['documents'],['document_runtime']]){
    assert.throws(()=>new CoreVaultFixtureService({capabilities,root:'/unused-runtime-admission'},{pollMs:750,rescanMs:30000,documentRuntime:true}),{code:'document_runtime_unavailable',message:'The desktop core does not support document indexing. Update Zorid and restart the app.'});
  }
});

test('owner polling survives zero listeners and uses the admitted guarded host and lease',async()=>{
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);
  assert.equal(f.registrations.length,1);assert.notEqual(f.registrations[0].host,f.host);
  assert.equal(f.service.runtimeOwner().host,f.registrations[0].host);
  assert.equal(f.service.listeners.size,0);assert.equal(f.polling,true);
  const unsubscribe=f.service.subscribe(()=>{});unsubscribe();
  assert.equal(f.service.listeners.size,0);assert.equal(f.polling,true,'feature unsubscribe must not stop admitted-owner polling');
  await f.service.poll();
  const pages=f.requests.filter(row=>row.command.method==='changes_after');assert.equal(pages.length,1);assert.deepEqual(pages[0].reference,f.lease);
  assert.equal(f.service.timer,undefined,'the test did not create an OS interval');
  f.owner=false;const before=f.requests.length;await f.service.poll();assert.equal(f.requests.length,before,'revoked guard rejects before an actual polling RPC');
  await context.retire();assert.equal(f.polling,false);
});

test('failed authoritative flush pauses then resumes without retiring or releasing native ownership',async()=>{
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);let retireCount=0;
  context.documentRuntime.subscribe(()=>{},()=>{retireCount++;});
  const failed=failure('flush_failed');
  await assert.rejects(context.release(admitted=>{admitted.assertActive();f.events.push('flush');throw failed;}),error=>error===failed);
  assert.ok(f.events.indexOf('runtime:pause')<f.events.indexOf('flush'));assert.ok(f.events.indexOf('flush')<f.events.indexOf('runtime:resume'));
  assert.equal(count(f,'runtime:prepare'),0);assert.equal(count(f,'runtime:retire'),0);assert.equal(retireCount,0);
  assert.equal(releases(f).length,0);assert.deepEqual(f.active,f.lease);assert.equal(f.polling,true);context.assertActive();
  assert.deepEqual(await context.documentRuntime.observe(),frame());
});

test('successful last-owner release prepares after flush and notifies only after raw native release ACK',async()=>{
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);let retireCount=0;
  context.documentRuntime.subscribe(()=>{},()=>{retireCount++;f.events.push('onRetire');assert.equal(f.active,null);});
  await context.release(admitted=>{admitted.assertActive();f.events.push('flush');});
  const order=['runtime:pause','flush','runtime:prepare','runtime:retire','rpc:release_client','runtime:release','onRetire'].map(event=>f.events.indexOf(event));
  assert.ok(order.every(index=>index>=0));for(let index=1;index<order.length;index++)assert.ok(order[index-1]<order[index]);
  assert.equal(retireCount,1);assert.equal(f.polling,false);assert.equal(f.service.documentRuntimeOwners.size,0);
  await context.release(()=>assert.fail('released context must not flush twice'));assert.equal(retireCount,1);assert.equal(releases(f).length,1);
});

test('uncertain native release retries the exact lease without repeating flush, preparation or retirement callback',async()=>{
  const f=fixture({releaseFailures:1}),context=await admitDesktopFixtureClient(f.service,f.options);let retireCount=0,flushes=0;
  context.documentRuntime.subscribe(()=>{},()=>{retireCount++;});
  await assert.rejects(context.release(()=>{flushes++;}),{code:'release_unknown',commitUncertain:true});
  assert.equal(flushes,1);assert.equal(count(f,'runtime:prepare'),1);assert.equal(count(f,'runtime:retire'),1);assert.equal(retireCount,0);
  assert.equal(count(f,'runtime:release'),0);assert.throws(()=>context.assertActive(),{code:'client_not_admitted'});
  await assert.rejects(context.documentRuntime.observe(),{code:'client_not_admitted'});
  await context.release(()=>assert.fail('uncertain release must not reflush'));
  assert.equal(flushes,1);assert.equal(count(f,'runtime:prepare'),1);assert.equal(count(f,'runtime:retire'),1);assert.equal(retireCount,1);
  assert.equal(releases(f).length,2);assert.strictEqual(releases(f)[0].command.reference,releases(f)[1].command.reference);assert.deepEqual(releases(f)[1].command.reference,f.lease);
});

test('release drains an accepted runtime method before entering the source flush or releasing the lease',async()=>{
  const barrier=gate(),f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);f.holdObserve(barrier.promise);
  const pending=context.documentRuntime.observe();let flushed=false;
  const closing=context.release(()=>{flushed=true;f.events.push('flush');});await settled();
  assert.equal(runtimeCalls(f).length,1);assert.equal(flushed,false);assert.equal(releases(f).length,0);
  await assert.rejects(context.documentRuntime.observe(),{code:'client_not_admitted'});
  barrier.resolve();assert.deepEqual(await pending,frame());await closing;
  assert.ok(f.events.indexOf('runtime:observe:done')<f.events.indexOf('flush'));assert.equal(f.active,null);
});

test('window retirement blocks new runtime calls and drains the accepted revoked reply before lease release',async()=>{
  const barrier=gate(),f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);let retireCount=0;
  context.documentRuntime.subscribe(()=>{},()=>{retireCount++;});f.holdObserve(barrier.promise);
  const pending=context.documentRuntime.observe();f.owner=false;
  const rejected=assert.rejects(pending,{code:'grant_retired'}),retiring=context.retire();await settled();
  assert.equal(count(f,'runtime:revoke'),1);assert.equal(retireCount,1);assert.equal(releases(f).length,0);
  await assert.rejects(context.documentRuntime.observe(),{code:'client_not_admitted'});assert.equal(runtimeCalls(f).length,1);
  barrier.resolve();await rejected;await retiring;
  assert.equal(releases(f).length,1);assert.equal(f.active,null);assert.equal(f.polling,false);
  assert.equal(count(f,'runtime:prepare'),0);assert.equal(count(f,'runtime:retire'),0);
  assert.ok(!f.requests.some(row=>['checkpoint_cas','commit_intent','acknowledge_intent'].includes(row.command.method)),'retirement leaves recovery and source records untouched');
  await context.retire();assert.equal(retireCount,1);
});

test('failed preparation after a successful flush allows only release retry without resuming public admission',async()=>{
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);let retireCount=0,flushes=0;
  context.documentRuntime.subscribe(()=>{},()=>{retireCount++;});f.failPrepare(failure('prepare_failed'));
  await assert.rejects(context.release(()=>{flushes++;}),{code:'prepare_failed'});
  assert.equal(flushes,1);assert.equal(retireCount,0);assert.equal(releases(f).length,0);assert.equal(count(f,'runtime:resume'),0);
  assert.throws(()=>context.assertActive(),{code:'client_not_admitted'});assert.deepEqual(f.active,f.lease);
  await assert.rejects(context.documentRuntime.observe(),{code:'client_not_admitted'});
  await context.release(()=>assert.fail('a successful source flush must not be repeated after a preparation error'));
  assert.equal(flushes,1);assert.equal(count(f,'runtime:prepare'),2);assert.equal(count(f,'runtime:retire'),1);assert.equal(retireCount,1);assert.equal(f.active,null);
});

/** Idle trusted-owner registration seam. The real lease wrapper runs both
 * admission/dispatch guards; the double only supplies synchronous revocation
 * notification, with no runtime or native request-registry policy. */
function pollingOwners(){
  const host=Object.create(RustVaultService.prototype),requests=[],states=new Map(),revocations=new Map();
  let scanDispatch,scanReply;
  host.capabilities=['documents','document_runtime'];host.root='/unused-runtime-owner-poll';
  host.request=async(command,bytes,reference,beforeDispatch)=>{
    if(command.method==='rescan'){
      if(scanDispatch)await scanDispatch;
      beforeDispatch?.();
      if(reference)throw failure('client_operation_unsupported'); // Actual native authorization policy.
      requests.push({command,reference});
      if(scanReply)await scanReply;
      return {result:{complete:true,reconciliation:{scanId:'scan',complete:true}}};
    }
    beforeDispatch?.();assert.equal(command.method,'changes_after');
    const state=states.get(reference?.client_id);assert.ok(state);assert.deepEqual(reference,state.lease);assert.equal(state.revoked,false);
    requests.push({command,reference});
    assert.ok(command.cursor==='6'||command.cursor==='7');
    const changes=command.cursor==='6'?[{cursor:'7',origin:{kind:'local_command',operation_id:'op'},requires_full_reload:false,entries:[]}]:[];
    return {result:{changes,next_cursor:'7',head_cursor:'7',has_more:false}};
  };
  const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000,documentRuntime:true});let polling=false;
  service.startPolling=()=>{polling=true;};service.stopPolling=()=>{polling=false;};
  service.documentScheduler={
    addOwner(options){
      const subscribers=new Set();let revoked=false;
      return {
        subscribe(listener,onRetire=()=>{}){const slot={listener,onRetire};subscribers.add(slot);return()=>subscribers.delete(slot);},
        revoke(){
          if(!revoked){revoked=true;revocations.set(options.clientId,(revocations.get(options.clientId)??0)+1);for(const slot of subscribers)slot.onRetire();subscribers.clear();}
          return Promise.resolve();
        },
      };
    },
    sourceHint(){},wake(){},
  };
  function add(id){
    const state={revoked:false,lease:{local_store_id:'authority',client_id:id,token:`lease-${id}`}};states.set(id,state);
    const assertActive=()=>{if(state.revoked)throw failure('grant_retired');};
    const guarded=host.withClientLease(state.lease,assertActive);
    const handle=service.registerDocumentRuntimeOwner({host:guarded,clientId:id,localStoreId:'authority',assertActive});
    return {handle,guarded,revokeGuard(){state.revoked=true;}};
  }
  return {service,requests,revocations,add,get polling(){return polling;},
    holdScanDispatch(promise){scanDispatch=promise;},holdScanReply(promise){scanReply=promise;}};
}

test('periodic maintenance rescan uses trusted authority while journal polling retains the admitted lease',async()=>{
  const f=pollingOwners(),owner=f.add(clientId);f.service.cursor='6';f.service.needsScan=true;
  await assert.rejects(owner.guarded.rescan(),{code:'client_operation_unsupported'});
  const events=[];f.service.listeners.add(event=>events.push(event));
  const reply=gate();f.holdScanReply(reply.promise);
  const first=f.service.poll();await settled();const second=f.service.poll();await settled();
  assert.equal(f.requests.length,1,'one serialized maintenance pass despite concurrent poll ticks');
  assert.equal(f.requests[0].command.method,'rescan');assert.equal(f.requests[0].reference,undefined);
  reply.resolve();await Promise.all([first,second]);
  assert.equal(f.service.reconciliation.complete,true);
  assert.deepEqual(f.requests.map(row=>row.command.method),['rescan','changes_after']);
  assert.equal(f.requests[1].reference.client_id,clientId);
  assert.equal(events.some(event=>event.code==='client_operation_unsupported'),false);
});

for(const boundary of ['queued','inflight'])test(`maintenance rescan rejects a retired owner at its ${boundary} boundary`,async()=>{
  const f=pollingOwners(),owner=f.add(clientId);f.service.cursor='6';f.service.needsScan=true;
  const wait=gate();if(boundary==='queued')f.holdScanDispatch(wait.promise);else f.holdScanReply(wait.promise);
  const events=[];f.service.listeners.add(event=>events.push(event));
  const pending=f.service.poll();await settled();owner.revokeGuard();wait.resolve();await pending;
  assert.equal(f.requests.length,boundary==='queued'?0:1);
  assert.equal(f.service.reconciliation,null,'stale result must not publish availability');
  assert.equal(events.some(event=>event.type==='reconciliation'),false);
  assert.equal(f.service.cursor,'6','stale owner must not continue the journal');
});

test('idle poll revokes a stale selected owner and continues the durable cursor through the other admitted lease',async()=>{
  const f=pollingOwners(),first=f.add(clientId),secondId='10000000-0000-4000-8000-000000000003',second=f.add(secondId);
  let firstRetired=0,secondRetired=0;first.handle.subscribe(()=>{},()=>{firstRetired++;});second.handle.subscribe(()=>{},()=>{secondRetired++;});
  f.service.cursor='6';first.revokeGuard();
  await f.service.poll();
  assert.equal(firstRetired,1);assert.equal(secondRetired,0);assert.equal(f.revocations.get(clientId),1);
  assert.equal(f.service.documentRuntimeOwners.size,1);assert.equal(f.service.runtimeOwner().host,second.guarded);assert.equal(f.polling,true);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].reference.client_id,secondId);assert.equal(f.requests[0].command.cursor,'6');assert.equal(f.service.cursor,'7');
  await f.service.poll();assert.equal(f.requests.length,2);assert.equal(f.requests[1].reference.client_id,secondId);assert.equal(f.requests[1].command.cursor,'7');
  assert.equal(firstRetired,1);assert.equal(f.revocations.get(clientId),1);assert.equal(f.service.timer,undefined);
});

test('idle polling stops when the last guarded owner is revoked and notifies retirement only once',async()=>{
  const f=pollingOwners(),owner=f.add(clientId);let retired=0;owner.handle.subscribe(()=>{},()=>{retired++;});
  assert.equal(f.polling,true);owner.revokeGuard();await f.service.poll();
  assert.equal(f.requests.length,0,'no revoked or unguarded polling RPC is admitted');
  assert.equal(f.polling,false);assert.equal(f.service.documentRuntimeOwners.size,0);assert.equal(f.service.runtimeOwner(),null);
  assert.equal(retired,1);assert.equal(f.revocations.get(clientId),1);
  await f.service.poll();await owner.handle.revoke();
  assert.equal(f.requests.length,0);assert.equal(retired,1);assert.equal(f.revocations.get(clientId),1);assert.equal(f.polling,false);assert.equal(f.service.timer,undefined);
});
