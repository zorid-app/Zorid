'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DocumentRuntimeScheduler}=require('../desktop/document-runtime.cjs');
const clone=value=>structuredClone(value);
const versions={schema:1,extraction:'metadata-2',resolver:'resolver-1',query:'query-1'};
const source=watermark=>({localStoreId:'store',watermark});
const stage=generation=>({localStoreId:'store',generationEpoch:'epoch',generation,versions});
function state(kind=null,{id='1',watermark='1',generation='1',priority='background',foreground=false,releasing=false}={}){
  const token=kind?{lifetime:'life',effectId:id,priority,targetSource:source(watermark),
    effect:['pump','publish','discard'].includes(kind)?{kind,snapshot:stage(generation)}:{kind}}:null;
  return {update:{lifetime:'life',revision:id,source:source(watermark),published:null,freshness:'lagging',
    phase:releasing?'releasing':kind==='publish'?'publishing':'indexing',
    progress:kind==='publish'?{prepared:10,total:10,ready:true}:null,
    coverageComplete:null,hasForegroundDemand:foreground,error:null},inFlight:token,lastStep:null,
    execution:kind?'dispatch':releasing?'quiesced':'waitForWake'};
}
const ticket=(id='1',lane='committed')=>({incarnation:'incarnation',lane,lifetime:lane==='committed'?'life':'draft-life',id});
const work=(selected=null,{closing=false,ready=false,settled=null}={})=>({selected,last_settled:settled,closing,close_ready:ready});
const reply=(value,turn=null)=>({work:value,turn:turn===null?null:{state:turn}});

/** Fixed native replies; no stage, priority, retry or freshness policy is
 * implemented by this fixture. Only production deferred turns are advanced. */
function fixture({initial=state(),steps=[],ownerReplies=[],composite=false,workReplies=[],retire=state(null,{releasing:true})}={}){
  let pending=true,current=clone(initial),readFailure=null,readGate=null,sequence=0;
  const calls=[],errors=[],queued=new Map();
  const host={
    async documentRuntime(clientId,op,args){
      calls.push({op,clientId,args:clone(args)});
      if(op==='runtime_snapshot'){const value=clone(current);if(readGate)await readGate;if(readFailure)throw readFailure;return {snapshot:value};}
      if(op==='runtime_owner'){
        if(args.command.kind==='retire')current=clone(retire);
        else if(ownerReplies.length)current=clone(ownerReplies.shift());
        return {...clone(args),snapshot:clone(current)};
      }
      if(op==='runtime_owner_ack')return true;
      if(op==='runtime_control')return {...clone(args),snapshot:clone(current),frame:{version:1,scope:{clientId,localStoreId:'store'},update:clone(current.update),outcomes:[]}};
      if(op==='runtime_step'){
        assert.deepEqual(args,{lifetime:current.inFlight.lifetime,effectId:current.inFlight.effectId});
        calls.at(-1).effect=clone(current.inFlight);
        assert.ok(steps.length,'unexpected native effect');current=clone(steps.shift());return {snapshot:clone(current)};
      }
      assert.fail(`Unexpected runtime op ${op}`);
    },
    async documentWork(request){
      calls.push(clone(request));assert.ok(workReplies.length,'unexpected work turn');
      const next=workReplies.shift();assert.equal(request.op,next.op);
      if(next.ticket)assert.deepEqual(request.ticket,next.ticket);
      if(next.runtimeSnapshot)current=clone(next.runtimeSnapshot);
      return clone(next.value);
    },
  };
  const scheduler=new DocumentRuntimeScheduler({
    ...(composite?{workHost:host}:{}),isSourceImportPending:()=>pending,
    defer(callback){const id=++sequence;queued.set(id,callback);return id;},cancel(id){queued.delete(id);},
    now:()=>17,onError:error=>errors.push(error),
  });
  const addOwner=()=>scheduler.addOwner({host,clientId:'client',localStoreId:'store',assertActive(){}});
  const addDraft=(assertActive=()=>{})=>scheduler.addDraftOwner({clientId:'draft-client',localStoreId:'store',assertActive});
  async function settled(){for(let i=0;i<80;i++)await Promise.resolve();}
  async function turn(){assert.ok(queued.size,'expected a deferred turn');const [id,callback]=queued.entries().next().value;queued.delete(id);callback();await settled();}
  async function drain(){for(let i=0;queued.size&&i<64;i++)await turn();assert.equal(queued.size,0,'must wait without polling');}
  return {scheduler,host,calls,errors,addOwner,addDraft,turn,drain,settled,
    queued:()=>queued.size,setPending(value){pending=value;},setState(value){current=clone(value);},failRead(value){readFailure=value;},holdRead(value){readGate=value;}};
}
const effectSteps=f=>f.calls.filter(call=>call.op==='runtime_step');
const workSteps=f=>f.calls.filter(call=>call.op==='step');
function activateDraft(f){const owner=f.addDraft();owner.notify({op:'cancel'},{result:{state:{}}});return owner;}

test('pending source import executes zero background Begin or Pump and does not spin',async()=>{
  for(const kind of ['begin','pump']){
    const f=fixture({initial:state(kind),steps:[state()]});const owner=f.addOwner();await f.drain();
    assert.equal(effectSteps(f).length,0,`${kind} must wait for source import`);
    for(let i=0;i<20;i++)f.scheduler.sourceImportProgress();
    await f.drain();assert.equal(effectSteps(f).length,0);
    assert.equal(f.calls.filter(call=>call.op==='runtime_owner'&&call.args.command.kind==='sourceHint').length,1);
    assert.equal(f.scheduler.needsRetry(),false);assert.deepEqual(f.errors,[]);
    f.setPending(false);f.scheduler.sourceImportProgress();await f.drain();
    assert.deepEqual(effectSteps(f).map(call=>call.args),[{lifetime:'life',effectId:'1'}]);
    owner.release();await f.scheduler.close();
  }
});

test('foreground demand overrides the hold even for an already issued background Pump',async()=>{
  const f=fixture({initial:state('pump'),steps:[state()]});const owner=f.addOwner();await f.drain();
  assert.equal(effectSteps(f).length,0);
  f.setState(state('pump',{foreground:true}));
  await owner.control({sequence:'1',command:{kind:'request',lifetime:'life',id:'1',maxPumps:8,maxRestarts:1,forceRebuild:false}});
  await f.drain();assert.equal(effectSteps(f).length,1);assert.deepEqual(f.errors,[]);
  owner.release();await f.scheduler.close();
});

test('explicit foreground priority, ready Publish and Discard remain executable during import',async()=>{
  for(const [kind,priority] of [['begin','foreground'],['pump','foreground'],['publish','background'],['discard','background'],['observe','background']]){
    const f=fixture({initial:state(kind,{priority}),steps:[state()]});const owner=f.addOwner();await f.drain();
    assert.equal(effectSteps(f).length,1,`${priority} ${kind}`);assert.deepEqual(f.errors,[]);
    owner.release();await f.scheduler.close();
  }
});

test('resume delivers the coalesced source hint and preserves exact native stale-stage cleanup/publication identities',async()=>{
  const held=state('pump'),sameTokenNewHead={...held,update:{...held.update,source:source('2'),revision:'2'}};
  const f=fixture({initial:held,ownerReplies:[held,sameTokenNewHead],steps:[
    state('discard',{id:'2',watermark:'2'}),state('observe',{id:'3',watermark:'2'}),
    state('begin',{id:'4',watermark:'2',generation:'2'}),state('pump',{id:'5',watermark:'2',generation:'2'}),
    state('publish',{id:'6',watermark:'2',generation:'2'}),state(null,{id:'7',watermark:'2'}),
  ]});const owner=f.addOwner();await f.drain();assert.equal(effectSteps(f).length,0);
  f.setPending(false);f.scheduler.sourceImportProgress();await f.drain();
  assert.equal(f.calls.filter(call=>call.op==='runtime_owner').at(-1).args.command.kind,'sourceHint');
  const hint=f.calls.findIndex(call=>call.op==='runtime_owner'&&call.args.command.kind==='sourceHint');
  assert.ok(hint<f.calls.findIndex(call=>call.op==='runtime_step'));
  assert.deepEqual(effectSteps(f).map(call=>call.args.effectId),['1','2','3','4','5','6']);
  assert.deepEqual(effectSteps(f).filter(call=>call.effect.effect.kind==='publish').map(call=>call.effect.effect.snapshot),[stage('2')]);
  owner.release();await f.scheduler.close();
});

test('Retire drains its already issued Pump while import is pending',async()=>{
  const f=fixture({initial:state('pump'),retire:state('pump',{releasing:true}),steps:[state(null,{releasing:true})]});
  const owner=f.addOwner();await f.drain();assert.equal(effectSteps(f).length,0);
  await owner.prepareRelease();assert.equal(effectSteps(f).length,1);
  owner.release();await f.scheduler.close();assert.deepEqual(f.errors,[]);
});

test('composite-only committed tickets use one exact guarded descriptor read and wait without polling',async()=>{
  const selected=ticket(),f=fixture({composite:true,initial:state('begin'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'step',ticket:selected,value:reply(work(null,{settled:selected}))},
    {op:'next_turn',value:reply(work(),'waiting')},
  ]});const owner=activateDraft(f);await f.drain();
  assert.equal(workSteps(f).length,0);
  assert.equal(f.calls.filter(call=>call.op==='runtime_snapshot').length,1);
  assert.equal(f.calls.find(call=>call.op==='runtime_snapshot').clientId,'draft-client');
  f.setPending(false);f.scheduler.sourceImportProgress();await f.drain();
  assert.deepEqual(workSteps(f).map(call=>call.ticket),[selected]);assert.deepEqual(f.errors,[]);
  owner.revoke();
});

test('composite foreground, ready publication, cleanup and draft Drop tickets are never import-gated',async()=>{
  for(const [kind,options,lane] of [['pump',{foreground:true},'committed'],['begin',{priority:'foreground'},'committed'],['pump',{releasing:true},'committed'],['publish',{},'committed'],['discard',{},'committed'],['pump',{},'draft']]){
    const selected=ticket('1',lane),f=fixture({composite:true,initial:state(kind,options),workReplies:[
      {op:'next_turn',value:reply(work(selected),'ready')},
      {op:'step',ticket:selected,value:reply(work(null,{settled:selected}))},
      {op:'next_turn',value:reply(work(),'waiting')},
    ]});const owner=activateDraft(f);await f.drain();
    assert.equal(workSteps(f).length,1,`${lane} ${kind}`);assert.deepEqual(f.errors,[]);owner.revoke();
  }
});

test('an active committed owner supplies the exact composite descriptor through its existing snapshot path',async()=>{
  const selected=ticket(),f=fixture({composite:true,initial:state('pump'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'step',ticket:selected,runtimeSnapshot:state(),value:reply(work(null,{settled:selected}))},
    {op:'next_turn',value:reply(work(),'waiting')},
  ]});const committed=f.addOwner(),draft=activateDraft(f);await f.drain();
  assert.equal(workSteps(f).length,0);
  assert.ok(f.calls.some(call=>call.op==='runtime_snapshot'&&call.clientId==='client'));
  assert.ok(!f.calls.some(call=>call.op==='runtime_snapshot'&&call.clientId==='draft-client'));
  f.setPending(false);f.scheduler.sourceImportProgress();await f.drain();
  assert.deepEqual(workSteps(f).map(call=>call.ticket),[selected]);assert.deepEqual(f.errors,[]);
  committed.release();draft.revoke();
});

test('a descriptor from another effect cannot invent a background pause for the selected ticket',async()=>{
  const selected=ticket(),f=fixture({composite:true,initial:state('pump',{id:'9'}),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'step',ticket:selected,value:reply(work(null,{settled:selected}))},
    {op:'next_turn',value:reply(work(),'waiting')},
  ]});const owner=activateDraft(f);await f.drain();
  assert.deepEqual(workSteps(f).map(call=>call.ticket),[selected]);
  assert.equal(f.calls.filter(call=>call.op==='runtime_snapshot').length,1);
  assert.equal(f.scheduler.current,null,'workHost observations never become another owner snapshot');
  assert.deepEqual(f.errors,[]);owner.revoke();
});

test('a foreign-store descriptor is held without adopting its identity or losing the selected ticket',async()=>{
  const foreign=state('pump');foreign.update.source.localStoreId='foreign';foreign.inFlight.targetSource.localStoreId='foreign';foreign.inFlight.effect.snapshot.localStoreId='foreign';
  const selected=ticket(),f=fixture({composite:true,initial:foreign,workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
  ]});const owner=activateDraft(f);await f.drain();
  assert.equal(workSteps(f).length,0);assert.equal(f.scheduler.current,null);
  assert.deepEqual(f.scheduler.work.selected,selected);assert.equal(f.scheduler.needsRetry(),false);
  assert.deepEqual(f.errors.map(error=>error.code),['client_scope_mismatch']);owner.revoke();
});

test('descriptor lookup rechecks the draft owner after an asynchronous read before trusting metadata',async()=>{
  let releaseRead,active=true,checks=0;
  const read=new Promise(resolve=>{releaseRead=resolve;}),selected=ticket();
  const f=fixture({composite:true,initial:state('pump'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
  ]});f.holdRead(read);
  const owner=f.addDraft(()=>{checks++;if(!active)throw {code:'client_ownership_lost'};});
  owner.notify({op:'cancel'},{result:{state:{}}});
  await f.turn();await f.turn();assert.equal(f.calls.filter(call=>call.op==='runtime_snapshot').length,1);
  active=false;releaseRead();await f.settled();await f.drain();
  assert.equal(checks,3,'notify, before read, after read');assert.equal(workSteps(f).length,0);
  assert.equal(f.scheduler.current,null);assert.deepEqual(f.scheduler.work.selected,selected);
  assert.equal(f.scheduler.needsRetry(),false);owner.revoke();
});

test('a progress hint during descriptor lookup prevents an older background observation from hiding foreground demand',async()=>{
  let releaseRead;const read=new Promise(resolve=>{releaseRead=resolve;}),selected=ticket();
  const f=fixture({composite:true,initial:state('pump'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'step',ticket:selected,value:reply(work(null,{settled:selected}))},
    {op:'next_turn',value:reply(work(),'waiting')},
  ]});f.holdRead(read);const owner=activateDraft(f);
  await f.turn();await f.turn();
  assert.equal(f.calls.filter(call=>call.op==='runtime_snapshot').length,1);
  f.setState(state('pump',{foreground:true}));f.scheduler.sourceImportProgress();
  releaseRead();await f.settled();await f.drain();
  assert.equal(f.calls.filter(call=>call.op==='runtime_snapshot').length,2);
  assert.deepEqual(workSteps(f).map(call=>call.ticket),[selected]);
  assert.deepEqual(f.errors,[]);owner.revoke();
});

test('failed composite descriptor read holds the exact ticket without poisoning transport retry or spinning',async()=>{
  const selected=ticket(),f=fixture({composite:true,initial:state('pump'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'step',ticket:selected,value:reply(work(null,{settled:selected}))},
    {op:'next_turn',value:reply(work(),'waiting')},
  ]});f.failRead({code:'temporary_snapshot_failure'});const owner=activateDraft(f);await f.drain();
  assert.equal(workSteps(f).length,0);assert.equal(f.scheduler.needsRetry(),false);
  assert.deepEqual(f.scheduler.work.selected,selected);assert.equal(f.calls.filter(call=>call.op==='runtime_snapshot').length,1);
  f.failRead(null);f.setPending(false);f.scheduler.sourceImportProgress();await f.drain();
  assert.deepEqual(workSteps(f).map(call=>call.ticket),[selected]);owner.revoke();
});

test('composite close bypasses a held background Pump and joins actual close-ready cleanup',async()=>{
  const selected=ticket(),f=fixture({composite:true,initial:state('pump'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'close',value:reply(work(selected,{closing:true}))},
    {op:'step',ticket:selected,value:reply(work(null,{closing:true,ready:true,settled:selected}))},
  ]});activateDraft(f);await f.drain();assert.equal(workSteps(f).length,0);
  const closing=f.scheduler.close();await f.settled();await f.drain();await closing;
  assert.equal(workSteps(f).length,1);assert.equal(f.scheduler.closed,true);assert.deepEqual(f.errors,[]);
});

test('native client Drop drain can pass an already selected background Pump without source completion',async()=>{
  const selected=ticket(),drop=ticket('2','draft'),f=fixture({composite:true,initial:state('pump'),workReplies:[
    {op:'next_turn',value:reply(work(selected),'ready')},
    {op:'step',ticket:selected,value:reply(work(null,{settled:selected}))},
    {op:'next_turn',value:reply(work(drop),'ready')},
    {op:'step',ticket:drop,value:reply(work(null,{settled:drop}))},
    {op:'next_turn',value:reply(work(),'waiting')},
  ]});const owner=activateDraft(f);await f.drain();assert.equal(workSteps(f).length,0);
  let releases=0;f.host.releaseClient=async()=>{if(++releases<=2)throw {code:'document_drafts_draining'};return {released:true};};
  const release=f.scheduler.releaseDraftClient({client_id:'draft-client',token:'lease'});
  await f.settled();await f.drain();await release;
  assert.deepEqual(workSteps(f).map(call=>call.ticket),[selected,drop]);assert.equal(releases,3);
  assert.deepEqual(f.errors,[]);owner.revoke();
});
