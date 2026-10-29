'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createLazyDraftJournal}=require('../desktop/lazy-draft-journal.cjs');
const {openDraftJournal}=require('../desktop/draft-journal.cjs');
const scope={vaultId:'vault',clientId:'client',incarnationId:'current'};
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function clock(){
  let time=0,serial=0;const pending=new Map(),callbacks=[];
  return{now:()=>time,setTimeout(fn,delay){const token=++serial;pending.set(token,{fn,at:time+delay});callbacks.push(fn);return token;},clearTimeout(token){pending.delete(token);},
    get pending(){return pending.size;},get callbacks(){return callbacks;},
    async advance(ms){const until=time+ms;for(;;){const next=[...pending].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>until)break;time=next[1].at;pending.delete(next[0]);next[1].fn();await settle();}time=until;await settle();},
    async next(){const at=Math.min(...[...pending.values()].map(value=>value.at));assert.ok(Number.isFinite(at),'expected one pending idle timer');await this.advance(at-time);},
  };
}
function fakeOwner(maintain){return{bind:()=>({list:async()=>[],read:async()=>null,compareAndSwap:async value=>value,retire:async value=>value,revoke(){}}),maintain,close:async()=>{}};}

test('GC waits for initial grace and every RPC quiet window, dispatches one unit per turn and never delays foreground calls',async()=>{
  const time=clock(),calls=[];const owner=fakeOwner(async options=>{calls.push({at:time.now(),options});return{examined:1,removed:0,done:calls.length===2,errors:[]};});
  const proxy=createLazyDraftJournal(async()=>owner,{clock:time}),lease=proxy.bind(scope,()=>{});assert.equal(time.pending,0);await lease.list();assert.equal(time.pending,1);
  await time.advance(4999);assert.equal(calls.length,0);await lease.read({entryId:'entry',writer:'writer'});await time.advance(1);assert.equal(calls.length,0);await time.advance(249);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].options,{maxUnits:1});assert.equal(time.pending,1);await time.advance(24);assert.equal(calls.length,1);await time.advance(1);assert.equal(calls.length,2);assert.equal(time.pending,0);await proxy.close();
});

test('successful current retire does not request a scan, while duplicate revoke is coalesced',async()=>{
  const time=clock();let calls=0;const proxy=createLazyDraftJournal(async()=>fakeOwner(async()=>{calls++;return{examined:0,removed:0,done:true,errors:[]};}),{clock:time}),lease=proxy.bind(scope,()=>{});
  await lease.list();await time.advance(5000);assert.equal(calls,1);await lease.retire({generation:1});await time.advance(10000);assert.equal(calls,1);
  lease.revoke();lease.revoke();assert.equal(time.pending,1);await time.advance(250);assert.equal(calls,2);assert.equal(time.pending,0);await proxy.close();
});

test('proxy foreground calls never await the idle pass and continued work pauses until RPCs finish',async()=>{
  const time=clock(),gc=gate(),read=gate();let calls=0;
  const owner=fakeOwner(async()=>{calls++;if(calls===1)await gc.promise;return{examined:1,removed:0,done:calls===2,errors:[]};}),bind=owner.bind;
  // Isolate proxy scheduling here; actual storage separately serializes a
  // foreground call behind at most the single already-issued storage unit.
  owner.bind=(...args)=>({...bind(...args),read:async()=>{await read.promise;return null;}});
  const proxy=createLazyDraftJournal(async()=>owner,{clock:time}),lease=proxy.bind(scope,()=>{});await lease.list();await time.advance(5000);assert.equal(calls,1);
  assert.deepEqual(await lease.compareAndSwap({draft:'Foreground exact bytes'}),{draft:'Foreground exact bytes'});
  const pending=lease.read({entryId:'entry',writer:'writer'});gc.resolve();await settle();assert.equal(time.pending,0);await time.advance(10000);assert.equal(calls,1);
  read.resolve();await pending;await time.advance(249);assert.equal(calls,1);await time.advance(1);assert.equal(calls,2);await proxy.close();
});

for(const timing of ['between','during'])test(`a pass-start epoch preserves ${timing}-unit revokes as one additional pass`,async()=>{
  const time=clock(),held=gate();let calls=0;const proxy=createLazyDraftJournal(async()=>fakeOwner(async()=>{calls++;if(calls===2)await held.promise;return{examined:1,removed:0,done:calls>=2,errors:[]};}),{clock:time});
  const one=proxy.bind(scope,()=>{}),two=proxy.bind({...scope,incarnationId:'second'},()=>{}),three=proxy.bind({...scope,incarnationId:'third'},()=>{});await one.list();await two.list();await three.list();
  await time.advance(5000);assert.equal(calls,1);
  if(timing==='between'){one.revoke();two.revoke();three.revoke();await time.advance(250);}else{await time.advance(25);one.revoke();two.revoke();three.revoke();}
  assert.equal(calls,2);held.resolve();await settle();
  assert.equal(time.pending,1);await time.advance(250);assert.equal(calls,3,'all midpass revokes need one fresh cursor pass');assert.equal(time.pending,0);await proxy.close();
});

for(const mode of ['throw','reported'])test(`GC ${mode} failures wait for real activity rather than retrying idle`,async()=>{
  const time=clock(),diagnostics=[];let calls=0;const proxy=createLazyDraftJournal(async()=>fakeOwner(async()=>{calls++;if(calls===1){if(mode==='throw')throw Object.assign(Error('/private/failure'),{code:'EIO'});return{examined:1,removed:0,done:false,errors:['draft_storage_corrupt']};}return{examined:0,removed:0,done:true,errors:[]};}),{clock:time,onMaintenanceError:value=>diagnostics.push(value)}),lease=proxy.bind(scope,()=>{});
  await lease.list();await time.advance(5000);assert.equal(calls,1);assert.deepEqual(diagnostics,[[mode==='throw'?'draft_storage_failure':'draft_storage_corrupt']]);assert.equal(time.pending,0);await time.advance(600000);assert.equal(calls,1);
  assert.deepEqual(await lease.list(),[]);await time.advance(250);assert.equal(calls,2);await proxy.close();
});

test('close cancels stale callbacks and joins only the already-issued GC unit before storage close',async()=>{
  const time=clock(),held=gate();let calls=0,storeClosed=false;const owner=fakeOwner(async()=>{calls++;await held.promise;return{examined:1,removed:0,done:false,errors:[]};});owner.close=async()=>{storeClosed=true;};
  const proxy=createLazyDraftJournal(async()=>owner,{clock:time}),lease=proxy.bind(scope,()=>{});await lease.list();const stale=time.callbacks[0];await time.advance(5000);assert.equal(calls,1);
  let finished=false;const closing=proxy.close().then(()=>{finished=true;});await settle();assert.equal(finished,false);assert.equal(time.pending,0);stale();assert.equal(calls,1);await assert.rejects(lease.list(),{code:'draft_lease_revoked'});
  held.resolve();await closing;assert.equal(storeClosed,true);await time.advance(600000);assert.equal(calls,1);
});

test('legacy storage owners without maintain never schedule maintenance',async()=>{
  const time=clock(),owner=fakeOwner();delete owner.maintain;const proxy=createLazyDraftJournal(async()=>owner,{clock:time}),lease=proxy.bind(scope,()=>{});await lease.list();lease.revoke();assert.equal(time.pending,0);await proxy.close();
});

const change={entryId:'entry',writer:'writer',generation:1,expectedRevision:null,nextRevision:'1',baseline:{entryId:'entry',path:'Note.md',revision:'source',content:'Original'},draft:'Protected bytes',checkpointRevision:null,pendingOperation:null};
async function realFixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-idle-journal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return path.join(root,'journal');}
async function runPass(time,state){
  for(let turn=0;turn<300;turn++){
    if(time.pending)await time.next();
    for(let spin=0;spin<1000&&state.running;spin++)await new Promise(resolve=>setImmediate(resolve));await settle();
    if(!time.pending&&!state.running)return;
  }
  assert.fail('idle maintenance did not reach a bounded completed pass');
}
function observed(owner,state){return{...owner,async maintain(options){state.calls++;state.running++;try{const result=await owner.maintain(options);state.results.push(result);return result;}finally{state.running--;}}};}

test('first lazy open reclaims a prior main-process tombstone using actual storage units',async t=>{
  const directory=await realFixture(t),prior=await openDraftJournal(directory),old=prior.bind({...scope,incarnationId:'old'});await old.compareAndSwap(change);await old.retire({entryId:'entry',writer:'writer',generation:1,expectedRevision:'1',nextRevision:'2'});await prior.close();
  assert.equal((await fs.readdir(path.join(directory,'branches'))).length,1);
  const time=clock(),state={calls:0,running:0,results:[]},proxy=createLazyDraftJournal(async()=>observed(await openDraftJournal(directory),state),{clock:time}),lease=proxy.bind(scope,()=>{});t.after(()=>proxy.close());
  assert.deepEqual(await lease.list({entryId:'entry'}),[]);assert.equal(state.calls,0);await runPass(time,state);
  assert.equal((await fs.readdir(path.join(directory,'branches'))).length,0);assert.equal((await fs.readdir(path.join(directory,'retired-trash'))).length,0);assert.equal(state.results.reduce((sum,result)=>sum+result.removed,0),1);
});

test('an active issuer uncertain cross-incarnation retirement survives idle GC and exact retry until revoke',async t=>{
  const directory=await realFixture(t),journal=await openDraftJournal(directory),old=journal.bind({...scope,incarnationId:'old'});await old.compareAndSwap(change);old.revoke();
  const time=clock(),state={calls:0,running:0,results:[]},wrapped=observed(journal,state),bind=wrapped.bind;let loseReply=true;
  wrapped.bind=(scope,check)=>{const current=bind(scope,check);return{...current,retire:async request=>{const receipt=await current.retire(request);if(loseReply){loseReply=false;throw Object.assign(Error('Lost owned retirement reply'),{code:'draft_transport_lost',commitUncertain:true});}return receipt;}};};
  const proxy=createLazyDraftJournal(async()=>wrapped,{clock:time}),lease=proxy.bind(scope,()=>{});t.after(()=>proxy.close());
  const request={incarnationId:'old',entryId:'entry',writer:'writer',generation:1,expectedRevision:'1',nextRevision:'2'};
  await assert.rejects(lease.retire(request),{code:'draft_transport_lost',commitUncertain:true});
  await runPass(time,state);assert.equal((await fs.readdir(path.join(directory,'branches'))).length,1);const receipt=await lease.retire(request);assert.equal(receipt.revision,'2');assert.equal(receipt.deleted,true);
  lease.revoke();await runPass(time,state);assert.equal((await fs.readdir(path.join(directory,'branches'))).length,0);
});
