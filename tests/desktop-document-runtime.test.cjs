'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DocumentRuntimeScheduler,captureRuntimeRequest,decodeRuntimeReply,validRuntimeReply,MAX_RUNTIME_BYTES}=require('../desktop/document-runtime.cjs');

const clone=value=>structuredClone(value);
const scope=clientId=>({localStoreId:'store',clientId});
const update=(revision='0')=>({lifetime:'life',revision,source:null,published:null,freshness:'unknown',phase:'idle',progress:null,coverageComplete:null,hasForegroundDemand:false,error:null});
const issued=effectId=>({lifetime:'life',effectId,priority:'background',targetSource:null,effect:{kind:'observe'}});
const snapshot=(effectId=null,revision='0')=>({update:update(revision),inFlight:effectId===null?null:issued(effectId),lastStep:null,execution:effectId===null?'waitForWake':'dispatch'});
const frame=(clientId='client-a',outcomes=[])=>({version:1,scope:scope(clientId),update:update(),outcomes:clone(outcomes)});
const request=(sequence='1',id='9007199254740993')=>({sequence,command:{kind:'request',lifetime:'life',id,maxPumps:8,maxRestarts:1,forceRebuild:false}});
function gate(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}

/** Each row is a fixed host reply, not a second implementation of core policy,
 * lease/client request mapping, outcome ownership, or the native 32-slot cap. */
function fixture(options={}){
  const deferred=new Map(),calls=[],errors=[],deniedClients=new Set();
  let nextTurn=0,current=clone(options.initial??snapshot()),denied=false;
  const ownerReplies=[...(options.ownerReplies??[])],stepReplies=[...(options.stepReplies??[])];
  let ownerFailure=options.ownerFailure,ownerAckFailure=options.ownerAckFailure,stepGate,publicGate,retireGate,ownerReceipt,stepFailure,snapshotFailure,stepReceipt;
  let publicFrame=frame();
  const host={
    async documentRuntime(clientId,op,args){
      const row={clientId,op,args:clone(args)};calls.push(row);
      if(op==='runtime_snapshot'){if(snapshotFailure){const error=snapshotFailure;snapshotFailure=undefined;throw error;}return {snapshot:clone(current)};}
      if(op==='runtime_owner'){
        if(ownerReceipt){assert.deepEqual(args,{sequence:ownerReceipt.sequence,command:ownerReceipt.command});return clone(ownerReceipt);}
        if(args.command.kind==='retire'&&retireGate)await retireGate;
        if(args.command.kind==='retire')current=clone(options.retireReply??{...snapshot(),update:{...update(),phase:'releasing'},execution:'quiesced'});
        else if(ownerReplies.length)current=clone(ownerReplies.shift());
        const reply={...clone(args),snapshot:clone(current)};
        if(ownerFailure){ownerReceipt=clone(reply);const error=ownerFailure;ownerFailure=undefined;throw error;}
        return reply;
      }
      if(op==='runtime_owner_ack'){
        if(ownerAckFailure){const error=ownerAckFailure;ownerAckFailure=undefined;throw error;}
        if(ownerReceipt?.sequence===args.sequence)ownerReceipt=undefined;
        return true;
      }
      if(op==='runtime_step'){
        if(stepReceipt&&JSON.stringify(args)===JSON.stringify(stepReceipt.args))return {snapshot:clone(stepReceipt.snapshot)};
        if(!current.inFlight)throw Object.assign(new Error('Document runtime has no issued effect'),{code:'document_runtime_idle'});
        assert.deepEqual(args,{lifetime:current.inFlight.lifetime,effectId:current.inFlight.effectId});
        if(stepGate)await stepGate;
        assert.ok(stepReplies.length,'unexpected extra IO effect');
        current=clone(stepReplies.shift());
        if(stepFailure){
          // Native intentionally retains no step ACK after quiescence. An
          // identical terminal retry returns NoEffect, not a fabricated replay.
          if(current.execution!=='quiesced')stepReceipt={args:clone(args),snapshot:clone(current)};
          const error=stepFailure;stepFailure=undefined;throw error;
        }
        return {snapshot:clone(current)};
      }
      if(op==='runtime_observe'){if(publicGate)await publicGate;return {...clone(publicFrame),scope:scope(clientId)};}
      if(op==='runtime_control'){if(publicGate)await publicGate;return {...clone(args),frame:{...clone(publicFrame),scope:scope(clientId)},snapshot:clone(current)};}
      if(op==='runtime_ack'||op==='runtime_outcome_ack')return true;
      assert.fail(`Unexpected host runtime operation: ${op}`);
    },
    async foreground(){calls.push({op:'foreground'});},
  };
  const scheduler=new DocumentRuntimeScheduler({
    defer(callback){const id=++nextTurn;deferred.set(id,callback);return id;},
    cancel(id){deferred.delete(id);},now:()=>17,onError:error=>{errors.push(error);},
  });
  function addOwner(clientId='client-a'){
    return scheduler.addOwner({host,clientId,localStoreId:'store',assertActive(){if(denied||deniedClients.has(clientId))throw Object.assign(new Error('lease lost'),{code:'client_ownership_lost'});}});
  }
  // Advance microtasks only. Production turns stay under the explicit fake
  // defer queue; there is no real timer, process, app, build, or filesystem IO.
  async function settled(){for(let index=0;index<40;index++)await Promise.resolve();}
  async function turn(){assert.ok(deferred.size,'expected a deferred owner turn');const [id,callback]=deferred.entries().next().value;deferred.delete(id);callback();await settled();}
  async function drain(maximum=64){for(let count=0;deferred.size&&count<maximum;count++)await turn();assert.equal(deferred.size,0,'owner must reach a bounded wait boundary');}
  return {scheduler,host,calls,errors,addOwner,turn,drain,settled,
    queued:()=>deferred.size,deny(){denied=true;},holdStep(promise){stepGate=promise;},holdPublic(promise){publicGate=promise;},
    denyOwner(clientId){deniedClients.add(clientId);},
    holdRetire(promise){retireGate=promise;},failOwnerAck(error){ownerAckFailure=error;},failStep(error){stepFailure=error;},failSnapshot(error){snapshotFailure=error;},
    setFrame(value){publicFrame=clone(value);},setSnapshot(value){current=clone(value);},
  };
}
const ownerCommands=f=>f.calls.filter(row=>row.op==='runtime_owner');
const steps=f=>f.calls.filter(row=>row.op==='runtime_step');
const retired=f=>ownerCommands(f).filter(row=>row.args.command.kind==='retire');
function assertPublic(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    assert.ok(!['snapshot','inFlight','lastStep','effect','effectId','targetSource','requestOutcomes'].includes(key),`private scheduler field leaked: ${key}`);
    assertPublic(item);
  }
}

test('an admitted owner starts and executes background effects with zero feature subscribers',async()=>{
  const f=fixture({ownerReplies:[snapshot('1')],stepReplies:[snapshot()]});f.addOwner();
  assert.equal(f.calls.length,0,'admission schedules rather than performing synchronous IO');
  await f.drain();
  assert.equal(ownerCommands(f)[0].args.command.kind,'wake');
  assert.deepEqual(ownerCommands(f)[0].args.command.monotonicMs,'17');
  assert.deepEqual(steps(f).map(row=>row.args),[{lifetime:'life',effectId:'1'}]);
  assert.deepEqual(f.errors,[]);
});

test('one selected IO effect per deferred turn leaves foreground host work ahead of the next step',async()=>{
  const f=fixture({ownerReplies:[snapshot('1')],stepReplies:[snapshot('2','1'),snapshot(null,'2')]});f.addOwner();
  for(let count=0;steps(f).length===0&&count<8;count++)await f.turn();
  assert.equal(steps(f).length,1);assert.ok(f.queued()>0,'next effect must wait for another host turn');
  await f.host.foreground();await f.drain();
  assert.deepEqual(f.calls.filter(row=>row.op==='runtime_step'||row.op==='foreground').map(row=>row.op),['runtime_step','foreground','runtime_step']);
  assert.deepEqual(steps(f).map(row=>row.args.effectId),['1','2']);
});

test('repeated source hints and real wakes coalesce without turning idle state into a polling loop',async()=>{
  const f=fixture();f.addOwner();await f.drain();
  const before=ownerCommands(f).length;
  for(let index=0;index<20;index++)f.scheduler.sourceHint();
  await f.drain();
  assert.deepEqual(ownerCommands(f).slice(before).map(row=>row.args.command.kind),['sourceHint']);
  const afterHint=ownerCommands(f).length;
  for(let index=0;index<20;index++)f.scheduler.wake();
  await f.drain();
  assert.deepEqual(ownerCommands(f).slice(afterHint).map(row=>row.args.command.kind),['wake']);
  const callCount=f.calls.length;await f.settled();
  assert.equal(f.calls.length,callCount);assert.equal(f.queued(),0);assert.equal(steps(f).length,0);
});

test('a wake received during an accepted step is retained until that step finishes',async()=>{
  const barrier=gate(),f=fixture({ownerReplies:[snapshot('1'),snapshot()],stepReplies:[snapshot()]});
  f.holdStep(barrier.promise);f.addOwner();
  for(let count=0;steps(f).length===0&&count<8;count++)await f.turn();
  assert.equal(steps(f).length,1);
  f.scheduler.wake();f.scheduler.wake();await f.settled();
  assert.equal(ownerCommands(f).length,1,'no concurrent owner command may overtake an accepted effect');
  barrier.resolve();await f.settled();await f.drain();
  assert.deepEqual(ownerCommands(f).map(row=>row.args.command.kind),['wake','wake']);
});

test('current execution controls scheduling even when the retained last-step report says yield',async()=>{
  const reduction={effect:null,update:update(),requestOutcomes:[],execution:'yield'};
  const retained={lifetime:'life',effectId:'9007199254740993',reduction};
  const yielded={...snapshot(),execution:'yield',lastStep:retained};
  const waiting={...snapshot(),lastStep:retained};
  const f=fixture({ownerReplies:[yielded,waiting]});f.addOwner();await f.drain();
  assert.deepEqual(ownerCommands(f).map(row=>row.args.command.kind),['wake','continue']);
  assert.equal(steps(f).length,0);assert.deepEqual(f.errors,[]);assert.equal(f.queued(),0);
});

test('lost owner-control acceptance retries its exact sequence and payload before accepting a new command',async()=>{
  const failure=Object.assign(new Error('lost owner acceptance'),{code:'transport_error'}),f=fixture({ownerFailure:failure,ownerReplies:[snapshot('9007199254740993')],stepReplies:[snapshot()]});f.addOwner();
  await f.drain();
  const blockedCalls=f.calls.length;f.scheduler.sourceHint();await f.drain();
  assert.equal(f.calls.length,blockedCalls,'a source hint must not unblock a failed transport operation');
  assert.equal(ownerCommands(f).length,1);
  f.scheduler.wake();await f.drain();
  const commands=ownerCommands(f);assert.ok(commands.length>=2);
  assert.deepEqual(commands[1].args,commands[0].args,'retry must not allocate another global owner sequence');
  const acknowledgment=f.calls.findIndex(row=>row.op==='runtime_owner_ack'&&row.args.sequence===commands[0].args.sequence);
  const later=f.calls.findIndex(row=>row.op==='runtime_owner'&&row.args.sequence!==commands[0].args.sequence);
  assert.ok(acknowledgment>=0);if(later>=0)assert.ok(acknowledgment<later);
  assert.deepEqual(steps(f).map(row=>row.args.effectId),['9007199254740993']);
});

test('lost owner ACK preserves the outstanding control identity instead of replaying under a new sequence',async()=>{
  const f=fixture({ownerAckFailure:Object.assign(new Error('lost owner ACK'),{code:'transport_error'})});f.addOwner();
  await f.drain();f.scheduler.wake();await f.drain();
  const first=ownerCommands(f)[0],acks=f.calls.filter(row=>row.op==='runtime_owner_ack');
  assert.ok(acks.length>=2);assert.equal(acks[0].args.sequence,first.args.sequence);assert.equal(acks[1].args.sequence,first.args.sequence);
  for(const row of ownerCommands(f).filter(row=>row.args.sequence===first.args.sequence))assert.deepEqual(row.args,first.args);
});

test('feature observation, controls and subscription delivery never expose private effect snapshots',async()=>{
  const f=fixture(),owner=f.addOwner(),notifications=[];
  owner.subscribe(value=>notifications.push(value));await f.drain();
  // Keep a selected private effect in a read-only host reply. Public observe
  // and control still return only client-scoped frames, never this capability.
  f.setSnapshot(snapshot('9007199254740993'));
  const observed=await owner.observe();assert.deepEqual(observed,frame());assertPublic(observed);
  const input=request(),controlled=await owner.control(input);
  assert.deepEqual(controlled,{...input,frame:frame()});assertPublic(controlled);
  for(const value of notifications)assertPublic(value);
});

test('new owned outcomes nudge subscribers even when the update lifetime and revision are unchanged',async()=>{
  const f=fixture(),owner=f.addOwner(),notifications=[];owner.subscribe(value=>notifications.push(value));await f.drain();
  const first=await owner.control(request());assert.equal(first.frame.update.revision,'0');
  assert.equal(await owner.ackControl({sequence:'1'}),true,'preserve the validated host acknowledgement for the renderer boundary');
  const count=notifications.length;
  f.setFrame(frame('client-a',[{lifetime:'life',outcome:{kind:'cancelled',id:'9007199254740993'}}]));
  const second=await owner.control(request('2'));
  assert.equal(second.frame.update.revision,first.frame.update.revision);
  assert.ok(notifications.length>count,'revision-only deduplication must not hide an outcome');
  assert.equal(await owner.ackControl({sequence:'2'}),true);
  assert.equal(await owner.ackOutcome({lifetime:'life',id:'9007199254740993'}),true,'preserve outcome acknowledgement for the renderer boundary');
  assert.ok(f.calls.some(row=>row.op==='runtime_outcome_ack'&&row.args.id==='9007199254740993'));
});

test('releasing one of two admitted clients preserves the shared native owner and the remaining client',async()=>{
  const f=fixture(),first=f.addOwner(),second=f.addOwner('client-b');await f.drain();
  const preparing=first.prepareRelease();await f.drain();await preparing;first.release();
  assert.equal(retired(f).length,0);
  f.scheduler.wake();await f.drain();
  assert.equal(ownerCommands(f).at(-1).clientId,'client-b');
  assert.deepEqual((await second.observe()).scope,scope('client-b'));
});

test('pause suppresses derived dispatch and resume restores a wake without retiring the runtime',async()=>{
  const f=fixture(),owner=f.addOwner();await f.drain();
  const paused=owner.pause();await f.drain();await paused;
  const before=f.calls.length;f.scheduler.wake();await f.drain();assert.equal(f.calls.length,before);
  // A rejected source flush belongs to the admission/service integration test.
  // Its caller may resume this paused handle; no successful flush is fabricated.
  owner.resume();await f.drain();
  assert.equal(retired(f).length,0);assert.equal(ownerCommands(f).at(-1).args.command.kind,'wake');
});

function wire(op,value){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,op,value}));return [{documents:true,schemaVersion:1,bytes:bytes.length},bytes];}
const privateRequest=(op,args={})=>({schemaVersion:1,command:{op,...args}});

test('private runtime requests capture exact wide counters and reject extra authority or completion fields',()=>{
  const maximum='18446744073709551615',args={sequence:maximum,command:{kind:'wake',monotonicMs:'9007199254740993'}};
  const captured=captureRuntimeRequest('runtime_owner',args);
  args.command.monotonicMs='1';assert.equal(captured.command.monotonicMs,'9007199254740993');assert.equal(captured.sequence,maximum);
  assert.deepEqual(captureRuntimeRequest('runtime_step',{lifetime:'life',effectId:maximum}),{lifetime:'life',effectId:maximum});
  for(const [op,input] of [
    ['runtime_snapshot',{snapshot:snapshot()}],
    ['runtime_owner',{sequence:'1',command:{kind:'complete',lifetime:'life',effectId:'1',result:{kind:'done'}}}],
    ['runtime_owner',{sequence:'1',command:{kind:'sourceHint',source:{localStoreId:'store',watermark:'1'}}}],
    ['runtime_owner',{sequence:'1',command:{kind:'request',id:'1',maxPumps:8,maxRestarts:1,forceRebuild:false}}],
    ['runtime_step',{lifetime:'life',effectId:'1',snapshot:snapshot()}],
    ['runtime_step',{lifetime:'bad:identity',effectId:'1'}],
    ['runtime_owner_ack',{sequence:'1',extra:true}],
    ['runtime_unknown',{}],
  ])assert.throws(()=>captureRuntimeRequest(op,input),error=>typeof error.code==='string',`${op} must reject caller-authored state`);
  for(const value of [1,Number.MAX_SAFE_INTEGER,'','01','-1','1.0','1e3','18446744073709551616']){
    assert.throws(()=>captureRuntimeRequest('runtime_step',{lifetime:'life',effectId:value}),error=>typeof error.code==='string');
    assert.throws(()=>captureRuntimeRequest('runtime_owner_ack',{sequence:value}),error=>typeof error.code==='string');
    assert.throws(()=>captureRuntimeRequest('runtime_owner',{sequence:'1',command:{kind:'wake',monotonicMs:value}}),error=>typeof error.code==='string');
  }
});

test('private runtime transport rejects malformed frames and preserves u64 strings without numeric rounding',()=>{
  const input=privateRequest('runtime_snapshot'),value={snapshot:snapshot('18446744073709551615','9007199254740993')};
  const [marker,body]=wire('runtime_snapshot',value);
  assert.deepEqual(decodeRuntimeReply(input,marker,body),value);
  assert.equal(validRuntimeReply({request:input},marker,body),true);
  assert.deepEqual(decodeRuntimeReply(input,...wire('runtime_snapshot',{snapshot:null})),{snapshot:null});
  const retiring={snapshot:{...value.snapshot,update:{...value.snapshot.update,phase:'releasing'},execution:'waitForWake'}};
  assert.deepEqual(decodeRuntimeReply(input,...wire('runtime_snapshot',retiring)),retiring,'Retire retains its already-issued effect until completion');
  for(const [badMarker,badBody] of [
    [{...marker,bytes:marker.bytes+1},body],
    [{...marker,extra:true},body],
    [{...marker,documents:false},body],
    [{...marker,schemaVersion:2},body],
    [{...marker,bytes:MAX_RUNTIME_BYTES+1},Buffer.alloc(1)],
    [{documents:true,schemaVersion:1,bytes:1},Buffer.from([255])],
    wire('runtime_step',value),
    wire('runtime_snapshot',{...value,extra:true}),
    wire('runtime_snapshot',{snapshot:{...value.snapshot,unexpected:true}}),
    wire('runtime_snapshot',{snapshot:{...value.snapshot,execution:'finished'}}),
    wire('runtime_snapshot',{snapshot:{...value.snapshot,execution:undefined}}),
    wire('runtime_snapshot',{snapshot:{...value.snapshot,update:{...value.snapshot.update,revision:'01'}}}),
    wire('runtime_snapshot',{snapshot:{...value.snapshot,inFlight:{...value.snapshot.inFlight,effectId:9007199254740992}}}),
    wire('runtime_snapshot',{snapshot:{...value.snapshot,inFlight:{...value.snapshot.inFlight,effect:{kind:'complete'}}}}),
  ]){
    assert.throws(()=>decodeRuntimeReply(input,badMarker,badBody),error=>typeof error.code==='string');
    assert.equal(validRuntimeReply({request:input},badMarker,badBody),false);
  }
  const acknowledgment=privateRequest('runtime_owner_ack',{sequence:'9007199254740993'});
  assert.equal(decodeRuntimeReply(acknowledgment,...wire('runtime_owner_ack',true)),true);
  assert.throws(()=>decodeRuntimeReply(acknowledgment,...wire('runtime_owner_ack',{ok:true})),error=>typeof error.code==='string');
});

test('last-owner prepare-release retires and drains work, while final release alone notifies retirement',async()=>{
  const barrier=gate(),f=fixture({ownerReplies:[snapshot('1')],stepReplies:[snapshot()]});f.holdStep(barrier.promise);
  const owner=f.addOwner();let retireCount=0;owner.subscribe(()=>{},()=>{retireCount++;});
  for(let count=0;steps(f).length===0&&count<8;count++)await f.turn();
  let prepared=false;const preparing=owner.prepareRelease().then(()=>{prepared=true;});await f.settled();
  assert.equal(prepared,false,'accepted effect must drain before owner preparation completes');
  barrier.resolve();await f.settled();await f.drain();await preparing;
  assert.equal(retired(f).length,1);assert.equal(retireCount,0,'native release ACK still belongs to the admitted client');
  const before=f.calls.length;owner.release();assert.equal(f.calls.length,before,'final acknowledged release performs no RPC');assert.equal(retireCount,1);
  owner.release();await owner.revoke();assert.equal(retireCount,1);
  const count=f.calls.length;f.scheduler.wake();f.scheduler.sourceHint();await f.drain();assert.equal(f.calls.length,count);
});

test('last-owner preparation drains an issued effect retained by a waitForWake retirement snapshot',async()=>{
  const barrier=gate(),pending={...snapshot('9007199254740993'),update:{...update(),phase:'releasing'},execution:'waitForWake'};
  const quiesced={...snapshot(),update:{...update(),phase:'releasing'},execution:'quiesced'};
  const f=fixture({ownerReplies:[snapshot('9007199254740993')],retireReply:pending,stepReplies:[quiesced]});
  f.holdStep(barrier.promise);const owner=f.addOwner();let retireCount=0;
  owner.subscribe(()=>{},()=>{retireCount++;});
  await f.turn();assert.equal(steps(f).length,0,'the next deferred effect has not started');
  let prepared=false;const preparing=owner.prepareRelease().then(()=>{prepared=true;});await f.settled();
  assert.equal(retired(f).length,1);assert.deepEqual(steps(f).map(row=>row.args),[{lifetime:'life',effectId:'9007199254740993'}]);
  assert.equal(prepared,false);assert.equal(retireCount,0);
  barrier.resolve();await preparing;await f.drain();
  assert.equal(prepared,true);assert.equal(retireCount,0);
  const before=f.calls.length;owner.release();assert.equal(f.calls.length,before);assert.equal(retireCount,1);
});

test('two paused owners preparing concurrently perform exactly one final Retire and drain before removal',async()=>{
  const barrier=gate(),pending={...snapshot('9007199254740993'),update:{...update(),phase:'releasing'},execution:'waitForWake'};
  const quiesced={...snapshot(),update:{...update(),phase:'releasing'},execution:'quiesced'};
  const f=fixture({ownerReplies:[snapshot('9007199254740993')],retireReply:pending,stepReplies:[quiesced]});
  f.holdStep(barrier.promise);const first=f.addOwner(),second=f.addOwner('client-b');let firstRetired=0,secondRetired=0;
  first.subscribe(()=>{},()=>{firstRetired++;});second.subscribe(()=>{},()=>{secondRetired++;});
  await f.turn();await Promise.all([first.pause(),second.pause()]);
  const preparingFirst=first.prepareRelease(),preparingSecond=second.prepareRelease();await f.settled();
  assert.equal(retired(f).length,1,'all other releasing owners count toward final retirement before lease removal');
  assert.deepEqual(steps(f).map(row=>row.args),[{lifetime:'life',effectId:'9007199254740993'}]);
  assert.equal(firstRetired,0);assert.equal(secondRetired,0);
  barrier.resolve();await Promise.all([preparingFirst,preparingSecond]);await f.drain();
  assert.equal(retired(f).length,1);assert.equal(steps(f).length,1);
  assert.equal(firstRetired,0);assert.equal(secondRetired,0);
  first.release();assert.equal(firstRetired,1);assert.equal(secondRetired,0);
  second.release();assert.equal(firstRetired,1);assert.equal(secondRetired,1);
});

test('admitting a third owner during an awaited Retire cannot dispatch a concurrent owner command',async()=>{
  const barrier=gate(),pending={...snapshot('9007199254740993'),update:{...update(),phase:'releasing'},execution:'waitForWake'};
  const quiesced={...snapshot(),update:{...update(),phase:'releasing'},execution:'quiesced'};
  const f=fixture({ownerReplies:[snapshot('9007199254740993')],retireReply:pending,stepReplies:[quiesced]});
  const first=f.addOwner(),second=f.addOwner('client-b');await f.turn();await Promise.all([first.pause(),second.pause()]);
  f.holdRetire(barrier.promise);
  const preparingFirst=first.prepareRelease(),preparingSecond=second.prepareRelease();await f.settled();
  assert.equal(retired(f).length,1);const commands=ownerCommands(f).length;
  const third=f.addOwner('client-c');f.scheduler.wake();await f.settled();await f.drain();
  assert.equal(ownerCommands(f).length,commands,'new admission must share the existing retirement execution lane');
  assert.equal(steps(f).length,0,'Retire reply has not yet delivered the retained token');
  barrier.resolve();await Promise.all([preparingFirst,preparingSecond]);
  assert.equal(retired(f).length,1);assert.equal(steps(f).length,1);
  first.release();second.release();await third.revoke();await f.drain();
});

test('lost Retire ACK retries the original owner sequence without issuing another Retire or Wake',async()=>{
  const f=fixture(),owner=f.addOwner();await f.drain();let retireCount=0;
  owner.subscribe(()=>{},()=>{retireCount++;});f.failOwnerAck(Object.assign(new Error('lost retirement ACK'),{code:'transport_error'}));
  await assert.rejects(owner.prepareRelease(),{code:'transport_error'});
  assert.equal(retired(f).length,1);assert.equal(retireCount,0);
  const original=retired(f)[0],before=f.calls.length;f.scheduler.wake();await f.drain();assert.equal(f.calls.length,before);
  await owner.prepareRelease();
  assert.equal(retired(f).length,1,'retrying a retained ACK must not allocate a fresh Retire command');
  const acknowledgments=f.calls.filter(row=>row.op==='runtime_owner_ack'&&row.args.sequence===original.args.sequence);
  assert.equal(acknowledgments.length,2);assert.equal(ownerCommands(f).at(-1).args.command.kind,'retire');
  assert.equal(retireCount,0);owner.release();assert.equal(retireCount,1);
});

test('release before the first Wake retains the native-created retirement lifetime across a lost Retire ACK',async()=>{
  const terminal={update:{...update(),lifetime:'lazy-retirement-life',phase:'releasing'},inFlight:null,lastStep:null,execution:'quiesced'};
  const f=fixture({retireReply:terminal,ownerAckFailure:Object.assign(new Error('lost first retirement ACK'),{code:'transport_error'})});
  const owner=f.addOwner();let retireCount=0;owner.subscribe(()=>{},()=>{retireCount++;});
  assert.equal(f.calls.length,0,'the initial deferred Wake has not created a runtime');
  await assert.rejects(owner.prepareRelease(),{code:'transport_error'});
  assert.deepEqual(ownerCommands(f).map(row=>row.args.command.kind),['retire']);assert.equal(retireCount,0);
  const original=retired(f)[0];await owner.prepareRelease();
  assert.deepEqual(ownerCommands(f).map(row=>row.args.command.kind),['retire'],'retry must keep the accepted native lifetime without a new Wake or Retire');
  assert.deepEqual(f.calls.filter(row=>row.op==='runtime_owner_ack').map(row=>row.args.sequence),[original.args.sequence,original.args.sequence]);
  assert.equal(steps(f).length,0);assert.equal(retireCount,0);
  const before=f.calls.length;owner.release();assert.equal(f.calls.length,before);assert.equal(retireCount,1);
});

test('lost terminal step and snapshot replies retry the same token then repair from exact quiescence without a step ACK',async()=>{
  const token={lifetime:'life',effectId:'9007199254740993'};
  const pending={...snapshot(token.effectId),update:{...update(),phase:'releasing'},execution:'waitForWake'};
  const completedUpdate={...update('1'),phase:'releasing'};
  const quiesced={update:completedUpdate,inFlight:null,lastStep:null,execution:'quiesced'};
  const f=fixture({ownerReplies:[snapshot(token.effectId)],retireReply:pending,stepReplies:[quiesced]});
  const owner=f.addOwner();let retireCount=0;owner.subscribe(()=>{},()=>{retireCount++;});await f.turn();await owner.pause();
  f.failStep(Object.assign(new Error('lost completed step reply'),{code:'transport_error'}));
  f.failSnapshot(Object.assign(new Error('lost recovery snapshot'),{code:'transport_error'}));
  await assert.rejects(owner.prepareRelease(),{code:'transport_error'});
  assert.equal(retired(f).length,1);assert.deepEqual(steps(f).map(row=>row.args),[token]);assert.equal(retireCount,0);
  const before=f.calls.length;f.scheduler.wake();await f.drain();assert.equal(f.calls.length,before);
  await owner.prepareRelease();
  assert.equal(retired(f).length,1);assert.deepEqual(steps(f).map(row=>row.args),[token,token]);
  assert.equal(f.calls.filter(row=>row.op==='runtime_snapshot').length,2,'the NoEffect retry requires a new read-only terminal proof');
  assert.equal(ownerCommands(f).at(-1).args.command.kind,'retire');assert.equal(retireCount,0);
  owner.release();assert.equal(retireCount,1);
});

test('foreign-lifetime or nonreleasing quiescence cannot acknowledge a lost retirement step',async()=>{
  const token={lifetime:'life',effectId:'9007199254740993'};
  const pending={...snapshot(token.effectId),update:{...update(),phase:'releasing'},execution:'waitForWake'};
  for(const badUpdate of [{...update('1'),lifetime:'other-life',phase:'releasing'},{...update('1'),phase:'idle'}]){
    const terminal={update:badUpdate,inFlight:null,lastStep:null,execution:'quiesced'};
    const f=fixture({ownerReplies:[snapshot(token.effectId)],retireReply:pending,stepReplies:[terminal]});
    const owner=f.addOwner();let retireCount=0;owner.subscribe(()=>{},()=>{retireCount++;});await f.turn();await owner.pause();
    const lost=Object.assign(new Error('lost completed step reply'),{code:'transport_error'});f.failStep(lost);
    await assert.rejects(owner.prepareRelease(),error=>error===lost,'quiescence alone must not prove this retirement completed');
    assert.equal(retireCount,0);assert.equal(retired(f).length,1);assert.deepEqual(steps(f).map(row=>row.args),[token]);
    assert.equal(f.calls.filter(row=>row.op==='runtime_snapshot').length,1);
    await assert.rejects(owner.prepareRelease(),error=>typeof error.code==='string','a previously rejected terminal snapshot must not become proof on the next release retry');
    assert.equal(retireCount,0);assert.equal(retired(f).length,1);
    for(const row of steps(f))assert.deepEqual(row.args,token,'any retirement retry must preserve the original issued token');
    const before=f.calls.length;f.scheduler.wake();await f.drain();assert.equal(f.calls.length,before);
  }
});

test('revoking the in-flight owner transfers through the remaining lease snapshot before another effect',async()=>{
  const barrier=gate(),f=fixture({ownerReplies:[snapshot('9007199254740993')],stepReplies:[snapshot('9007199254740994','1'),snapshot(null,'2')]});
  f.holdStep(barrier.promise);const first=f.addOwner(),second=f.addOwner('client-b');let firstRetired=0,secondRetired=0;
  first.subscribe(()=>{},()=>{firstRetired++;});second.subscribe(()=>{},()=>{secondRetired++;});
  for(let count=0;steps(f).length===0&&count<8;count++)await f.turn();
  assert.equal(steps(f).length,1);assert.equal(steps(f)[0].clientId,'client-a');
  f.denyOwner('client-a');barrier.resolve();await f.settled();await f.drain();
  const execution=f.calls.filter(row=>row.op==='runtime_step'||row.op==='runtime_snapshot');
  assert.deepEqual(execution.map(row=>({clientId:row.clientId,op:row.op,args:row.args})),[
    {clientId:'client-a',op:'runtime_step',args:{lifetime:'life',effectId:'9007199254740993'}},
    {clientId:'client-b',op:'runtime_snapshot',args:{}},
    {clientId:'client-b',op:'runtime_step',args:{lifetime:'life',effectId:'9007199254740994'}},
  ]);
  assert.equal(firstRetired,1);assert.equal(secondRetired,0);
  await first.revoke();assert.equal(firstRetired,1);await second.revoke();
});

test('a revoked guarded owner cannot dispatch IO or publish a successful feature reply',async()=>{
  const f=fixture(),owner=f.addOwner();let retireCount=0;owner.subscribe(()=>{},()=>{retireCount++;});f.deny();
  await f.drain();assert.equal(steps(f).length,0);
  await assert.rejects(owner.observe(),{code:'client_not_admitted'});
  await assert.rejects(owner.control(request()),{code:'client_not_admitted'});
  assert.equal(retireCount,1);
  const count=f.calls.length;const revoked=owner.revoke();await f.drain();await revoked;
  f.scheduler.wake();await f.drain();assert.equal(f.calls.length,count);assert.equal(retireCount,1);
});

test('ownership lost while a feature control awaits the host rejects the late reply without adopting its effect',async()=>{
  const barrier=gate(),f=fixture(),owner=f.addOwner();await f.drain();
  let retireCount=0;owner.subscribe(()=>{},()=>{retireCount++;});
  f.setSnapshot(snapshot('9007199254740993'));f.holdPublic(barrier.promise);
  const pending=owner.control(request());await f.settled();
  assert.ok(f.calls.some(row=>row.op==='runtime_control'));
  f.deny();barrier.resolve();
  await assert.rejects(pending,{code:'client_ownership_lost'});
  await f.drain();assert.equal(steps(f).length,0);assert.equal(retireCount,1);
  await owner.revoke();assert.equal(retireCount,1);
});

// Fixed private native replies: this fixture never selects a lane/phase or
// implements priorities. Each callback is one explicit main-owned turn.
function compositeFixture(replies,{releaseReplies=[]}={}){
  const queued=new Map(),calls=[],errors=[];let next=0;
  const host={async documentWork(request){calls.push(clone(request));assert.ok(replies.length,'unexpected extra trusted turn');const row=replies.shift();assert.equal(request.op,row.op);if(row.ticket)assert.deepEqual(request.ticket,row.ticket);if(row.error)throw row.error;return clone(row.value);},async releaseClient(reference){calls.push({op:'release_client',reference});assert.ok(releaseReplies.length,'unexpected release retry');const row=releaseReplies.shift();if(row.error)throw row.error;return row.value;}};
  const scheduler=new DocumentRuntimeScheduler({workHost:host,defer(callback){const id=++next;queued.set(id,callback);return id;},cancel(id){queued.delete(id);},onError:error=>errors.push(error)});
  const owner=scheduler.addDraftOwner({clientId:'client-a',localStoreId:'store',assertActive(){}});
  async function settled(){for(let i=0;i<60;i++)await Promise.resolve();}
  async function turn(){assert.ok(queued.size,'expected deferred trusted work');const [id,callback]=queued.entries().next().value;queued.delete(id);callback();await settled();}
  async function drain(){for(let i=0;queued.size&&i<24;i++)await turn();assert.equal(queued.size,0);}
  return {scheduler,owner,calls,errors,turn,drain,settled,queued:()=>queued.size};
}
const draftTicket=id=>({incarnation:'incarnation',lane:'draft',lifetime:'draft-owner',id});
const privateWork=(selected=null,last_settled=null,closing=false,close_ready=false)=>({selected,last_settled,closing,close_ready});
const workReply=(work,turn=null)=>({work,turn:turn===null?null:{state:turn}});
const draftMutationReply={result:{state:{},transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};
test('draft work runs autonomously without listeners and yields between exact selected steps',async()=>{
  const a=draftTicket('1'),b=draftTicket('2');
  const f=compositeFixture([
    {op:'next_turn',value:workReply(privateWork(a),'ready')},
    {op:'step',ticket:a,value:workReply(privateWork(null,a))},
    {op:'next_turn',value:workReply(privateWork(b,a),'ready')},
    {op:'step',ticket:b,value:workReply(privateWork(null,b))},
    {op:'next_turn',value:workReply(privateWork(null,b),'waiting')},
  ]);
  f.owner.notify({op:'request'},draftMutationReply);assert.equal(f.calls.length,0);await f.turn();assert.equal(f.calls.length,1);
  await f.turn();assert.deepEqual(f.calls[1],{op:'step',ticket:a});assert.ok(f.queued());
  f.calls.push({op:'foreground'});await f.drain();assert.deepEqual(f.calls.map(c=>c.op),['next_turn','step','foreground','next_turn','step','next_turn']);assert.deepEqual(f.errors,[]);
});
test('draft observational hints never make an idle owner poll or recursively wake',async()=>{
  const f=compositeFixture([{op:'next_turn',value:workReply(privateWork(),'waiting')}]);let hints=0;
  f.owner.subscribe(()=>{hints++;f.owner.notify({op:'snapshot'},draftMutationReply);f.owner.notify({op:'progress'},draftMutationReply);f.owner.notify({op:'facts_read'},{result:{job:draftTicket('1')}});});
  f.owner.notify({op:'request'},draftMutationReply);await f.drain();assert.equal(f.calls.length,1);assert.ok(hints>=1);assert.equal(f.queued(),0);assert.deepEqual(f.errors,[]);
});
test('revoked listener-free release retries only after actual settled work and final close-ready',async()=>{
  const a=draftTicket('1'),draining={code:'document_drafts_draining'},reference={client_id:'client-a',token:'lease'};
  const f=compositeFixture([
    {op:'next_turn',value:workReply(privateWork(a,null,true),'ready')},
    {op:'step',ticket:a,value:workReply(privateWork(null,a,true,true))},
  ],{releaseReplies:[{error:draining},{value:{released:true}}]});
  f.owner.revoke();let done=false;const release=f.scheduler.releaseDraftClient(reference).then(()=>{done=true;});await f.settled();
  assert.equal(done,false);assert.equal(f.calls.filter(c=>c.op==='release_client').length,1);await f.turn();assert.equal(f.calls.filter(c=>c.op==='release_client').length,1,'selection is not completed Drop');
  await f.turn();await release;assert.equal(done,true);assert.equal(f.calls.filter(c=>c.op==='release_client').length,2);assert.deepEqual(f.calls.at(-1),{op:'release_client',reference});assert.deepEqual(f.errors,[]);
});
test('lost composite step acknowledgement recovers only the exact actual settled ticket',async()=>{
  for(const exact of [true,false]){
    const a=draftTicket('1'),f=compositeFixture([
      {op:'next_turn',value:workReply(privateWork(a),'ready')},
      {op:'step',ticket:a,error:{code:'timeout'}},
      {op:'snapshot',value:workReply(privateWork(null,exact?a:draftTicket('2')))},
      ...(exact?[{op:'next_turn',value:workReply(privateWork(null,a),'waiting')}]:[]),
    ]);
    f.owner.notify({op:'request'},draftMutationReply);await f.drain();assert.equal(f.errors.length,exact?0:1);if(!exact)assert.equal(f.errors[0].code,'timeout');
  }
});
test('cold F-capable close observes no owner and never creates or pumps one',async()=>{
  const f=compositeFixture([{op:'snapshot',value:workReply(null)}]);f.owner.revoke();await f.scheduler.close();assert.deepEqual(f.calls,[{op:'snapshot'}]);assert.equal(f.queued(),0);
});
test('composite close continues trusted turns after all draft observers are revoked',async()=>{
  const a=draftTicket('1'),f=compositeFixture([
    {op:'close',value:workReply(privateWork(a,null,true))},
    {op:'step',ticket:a,value:workReply(privateWork(null,a,true,true))},
  ]);
  f.owner.notify({op:'request'},draftMutationReply);f.owner.revoke();let done=false;const closed=f.scheduler.close().then(()=>{done=true;});await f.settled();assert.equal(done,false);await f.drain();await closed;assert.equal(done,true);assert.deepEqual(f.calls.map(c=>c.op),['close','step']);assert.deepEqual(f.errors,[]);
});

function addCompositeLegacy(f,{wake=snapshot(),read,step=snapshot()}={}){
  const host={async documentRuntime(clientId,op,args){
    f.calls.push({op,clientId,args:clone(args)});
    if(op==='runtime_owner')return {...clone(args),snapshot:clone(wake)};
    if(op==='runtime_owner_ack')return true;
    if(op==='runtime_snapshot')return {snapshot:clone(read?await read:wake)};
    if(op==='runtime_step')return {snapshot:clone(step)};
    assert.fail(`Unexpected leased operation: ${op}`);
  }};
  return f.scheduler.addOwner({host,clientId:'legacy-client',localStoreId:'store',assertActive(){}});
}
test('last leased observer loss cannot block listener-free trusted Drop already awaited by release',async()=>{
  const a=draftTicket('1'),held=gate(),f=compositeFixture([
    {op:'next_turn',value:workReply(privateWork(a),'ready')},
    {op:'step',ticket:a,value:workReply(privateWork(null,a,true,true))},
  ],{releaseReplies:[{error:{code:'document_drafts_draining'}},{value:{released:true}}]});
  const legacy=addCompositeLegacy(f,{read:held.promise});await f.turn();f.owner.notify({op:'cancel'},draftMutationReply);await f.turn();await f.turn();
  assert.equal(f.calls.at(-1).op,'runtime_snapshot');f.owner.revoke();const retired=legacy.revoke();let released=false;
  const release=f.scheduler.releaseDraftClient({client_id:'client-a',token:'lease'}).then(()=>{released=true;});await f.settled();assert.equal(released,false);
  held.resolve(snapshot());await retired;await f.settled();await f.drain();await release;
  assert.equal(released,true);assert.equal(f.calls.filter(c=>c.op==='step').length,1);assert.equal(f.calls.filter(c=>c.op==='runtime_snapshot').length,1);assert.deepEqual(f.errors.map(e=>e.code),['client_not_admitted']);
});
test('unrelated native errors still block trusted work even if the leased observer is revoked',async()=>{
  const a=draftTicket('1');let reject;const held=new Promise((_resolve,no)=>{reject=no;}),f=compositeFixture([{op:'next_turn',value:workReply(privateWork(a),'ready')}],{releaseReplies:[{error:{code:'document_drafts_draining'}}]});
  const legacy=addCompositeLegacy(f,{read:held});await f.turn();f.owner.notify({op:'cancel'},draftMutationReply);await f.turn();await f.turn();f.owner.revoke();const retired=legacy.revoke();
  const release=f.scheduler.releaseDraftClient({client_id:'client-a',token:'lease'}),rejected=assert.rejects(release,{code:'timeout'});await f.settled();reject({code:'timeout'});await retired;await rejected;await f.settled();assert.equal(f.queued(),0);assert.equal(f.calls.filter(c=>c.op==='step').length,0);assert.deepEqual(f.errors.map(e=>e.code),['timeout']);
});
test('fresh native committed lifetime clears retired composite only after actual null work snapshot',async()=>{
  const a=draftTicket('1'),f=compositeFixture([
    {op:'next_turn',value:workReply(privateWork(a,null,true),'ready')},
    {op:'step',ticket:a,value:workReply(privateWork(null,a,true,true))},
    {op:'snapshot',value:workReply(null)},
  ],{releaseReplies:[{error:{code:'document_drafts_draining'}},{value:{released:true}}]});
  f.owner.revoke();const release=f.scheduler.releaseDraftClient({client_id:'client-a',token:'lease'});await f.settled();await f.drain();await release;assert.equal(f.scheduler.composite,true);
  const fresh={...snapshot('9'),update:{...update(),lifetime:'fresh-life'},inFlight:{...issued('9'),lifetime:'fresh-life'}},idle={...snapshot(),update:{...update(),lifetime:'fresh-life'}};
  addCompositeLegacy(f,{wake:fresh,step:idle});await f.drain();assert.equal(f.scheduler.composite,false);
  const operations=f.calls.map(c=>c.op);assert.ok(operations.lastIndexOf('snapshot')<operations.indexOf('runtime_step'));assert.deepEqual(f.calls.find(c=>c.op==='runtime_step').args,{lifetime:'fresh-life',effectId:'9'});assert.equal(f.calls.filter(c=>c.op==='next_turn').length,1);assert.deepEqual(f.errors,[]);
});
