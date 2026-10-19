import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserDocumentRuntimeHost,createBrowserDocumentRuntimeChannel} from '../src/platform/browser-document-runtime-host.ts';
import type {BrowserDocumentIndexMaintenance,DocumentRuntimeReduction,DocumentRuntimeSnapshot,DocumentRuntimeOutcome} from '../src/core/browser-document-runtime.ts';
const source={localStoreId:'store',watermark:'7'};
const update={lifetime:'runtime',revision:'1',source,published:null,freshness:'lagging' as const,phase:'observing' as const,progress:null,coverageComplete:null,hasForegroundDemand:false,error:null};
const issued=(id:string)=>({lifetime:'runtime',effectId:id,priority:'background' as const,targetSource:source,effect:{kind:'observe' as const}});
const pause=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>resolve=yes);return {promise,resolve};};
function fixture(){
  const tasks=new Map<number,{fn:()=>void;delay:number}>(),commands:any[]=[],steps:string[]=[],changes:any[]=[],errors:unknown[]=[];
  let serial=0,denied=false,closed=0,barrier:Promise<void>|undefined,throwStep=false;
  let nextStep:{inFlight:DocumentRuntimeSnapshot['inFlight'];execution:DocumentRuntimeReduction['execution'];outcomes:readonly DocumentRuntimeOutcome[]}|undefined;
  let listener:((state:DocumentRuntimeSnapshot,outcomes:readonly DocumentRuntimeOutcome[])=>void)|undefined;
  let tail=Promise.resolve();const events:string[]=[];
  function local<T>(operation:()=>Promise<T>):Promise<T>{const result=tail.then(operation);tail=result.then(()=>{},()=>{});return result;}
  let state:DocumentRuntimeSnapshot={update,inFlight:null,lastStep:null,execution:'waitForWake'};
  const reduction=(outcomes:readonly DocumentRuntimeOutcome[]=[]):DocumentRuntimeReduction=>({effect:state.inFlight,update:state.update,execution:state.execution,requestOutcomes:outcomes});
  const maintenance:BrowserDocumentIndexMaintenance={
    command(command){if(command.kind==='request')assert.deepEqual(Object.keys(command).sort(),['forceRebuild','id','kind','maxPumps','maxRestarts']);commands.push(command);if(command.kind==='wake')state={...state,inFlight:issued('1'),execution:'dispatch'};
      if(command.kind==='continue')state={...state,inFlight:null,execution:'waitForWake'};
      if(command.kind==='retire')state={...state,execution:'quiesced'};return reduction();},
    async step(token){steps.push(token.effectId);events.push('effect'+token.effectId);await barrier;const selected=nextStep;nextStep=undefined;const result:DocumentRuntimeReduction={...reduction(),effect:selected?.inFlight??null,execution:selected?.execution??'waitForWake',requestOutcomes:selected?.outcomes??[]};state={...state,inFlight:result.effect,execution:result.execution,lastStep:{...token,reduction:result}};if(throwStep){throwStep=false;throw new Error('original IO failed');}return result;},
    update:()=>state.update,snapshot:()=>state,async close(){closed++;},
  };
  const host=createBrowserDocumentRuntimeHost({maintenance,assertActive(){if(denied)throw new Error('lease lost');},local,changed:(snapshot,outcomes)=>{changes.push({snapshot,outcomes});listener?.(snapshot,outcomes);},failed:error=>errors.push(error),now:()=>17,
    schedule:(fn,delay)=>{const id=++serial;tasks.set(id,{fn,delay});return id as any;},cancelTimer:timer=>{tasks.delete(timer as any);}});
  async function turn(delay=0){const pair=[...tasks].find(([,task])=>task.delay===delay);assert.ok(pair,'one scheduled task');tasks.delete(pair[0]);pair[1].fn();for(let n=0;n<12;n++)await Promise.resolve();}
  return {host,maintenance,tasks,commands,steps,changes,errors,turn,events,foreground(name:string){return local(async()=>{events.push(name);});},listen(value:typeof listener){listener=value;},next(value:NonNullable<typeof nextStep>){nextStep=value;},state:()=>state,set(value:Partial<DocumentRuntimeSnapshot>){state={...state,...value};},hold(promise:Promise<void>){barrier=promise;},throwStep(){throwStep=true;},deny(){denied=true;},closed:()=>closed};
}
test('owner is lazy, independent of feature listeners and executes only one effect per later task',async()=>{
  const f=fixture();assert.equal(f.tasks.size,0);assert.deepEqual(f.commands,[]);f.host.start();assert.deepEqual(f.commands,[{kind:'wake',monotonicMs:17}]);assert.equal(f.steps.length,0);
  await f.turn();assert.deepEqual(f.steps,['1']);assert.equal([...f.tasks.values()].some(t=>t.delay===0),false);await f.turn(30000);assert.equal(f.steps.length,1);await f.turn();assert.deepEqual(f.steps,['1','1']);await f.host.drain();assert.equal(f.closed(),1);assert.equal(f.tasks.size,0);
});
test('actual current execution wins over the stale last-step Yield ACK and avoids idle Continue loops',async()=>{
  const f=fixture();f.host.start();await f.turn();const last=f.state().lastStep!;f.set({lastStep:{...last,reduction:{...last.reduction,execution:'yield'}},execution:'waitForWake'});f.host.sourceHint();assert.equal(f.commands.at(-1).kind,'sourceHint');assert.equal([...f.tasks.values()].filter(t=>t.delay===0).length,0);await f.host.drain();
});
test('current core Yield continues once on a later task without inferring work from phase',async()=>{
  const f=fixture();f.host.start();await f.turn();f.set({execution:'yield'});f.host.sourceHint();assert.equal(f.steps.length,1);await f.turn();assert.equal(f.commands.at(-1).kind,'continue');assert.equal(f.steps.length,1);assert.equal([...f.tasks.values()].some(t=>t.delay===0),false);await f.host.drain();
});
test('retire stops new work and repair while accepted effect drains before executor close',async()=>{
  const f=fixture(),barrier=pause();f.hold(barrier.promise);f.host.start();await f.turn();assert.equal(f.host.executing(),true);let drained=false;const drain=f.host.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(f.closed(),0);assert.equal(drained,false);assert.equal(f.tasks.size,0);barrier.resolve();await drain;assert.equal(f.host.executing(),false);assert.equal(f.closed(),1);assert.equal(f.steps.length,1);
});
test('thrown effect adopts only actual saved ACK outcomes and does not invent progress',async()=>{
  const f=fixture();f.throwStep();f.host.start();await f.turn();assert.equal(f.errors.length,1);assert.equal(f.changes.at(-1).snapshot,f.state());assert.equal(f.state().execution,'waitForWake');assert.equal([...f.tasks.values()].some(t=>t.delay===0),false);await f.host.drain();
});
function channelFixture(){
  const f=fixture();let nudges=0;f.host.start();const channel=createBrowserDocumentRuntimeChannel({scope:{localStoreId:'store',clientId:'client'},assertActive(){},host:f.host,nudge(){nudges++;}});
  const request=(id:string,sequence=id)=>({sequence,command:{kind:'request' as const,lifetime:'runtime',id,maxPumps:8,maxRestarts:1,forceRebuild:false}});
  return {...f,channel,request,nudges:()=>nudges};
}
test('control ACK replay is immutable, separate from outcome ACK, with scalar replay floors',async()=>{
  const f=channelFixture(),input=f.request('1'),ack=f.channel.control(input);assert.equal(f.channel.control(structuredClone(input)),ack);assert.ok(Object.isFrozen(ack));assert.throws(()=>f.channel.control(f.request('2')),{code:'document_runtime_busy'});f.channel.ackControl({sequence:'1'});f.channel.ackControl({sequence:'1'});assert.throws(()=>f.channel.control(input),{code:'document_runtime_expired'});
  f.channel.adopt(f.state(),[{kind:'cancelled',id:'1'}]);assert.equal(f.channel.observe().outcomes.length,1);assert.equal(f.nudges(),1);assert.equal(f.channel.observe().update?.revision,'1');f.channel.ackOutcome({lifetime:'runtime',id:'1'});f.channel.ackOutcome({lifetime:'runtime',id:'1'});assert.equal(f.channel.observe().outcomes.length,0);assert.throws(()=>f.channel.control(f.request('1','2')),{code:'document_runtime_expired'});await f.host.drain();
});
test('one global32 slot bound includes terminal-unacknowledged outcomes, cancel only affects its own ID',async()=>{
  const f=channelFixture();for(let id=1;id<=32;id++){f.channel.control(f.request(String(id)));f.channel.ackControl({sequence:String(id)});}f.channel.adopt(f.state(),[{kind:'cancelled',id:'1'}]);assert.throws(()=>f.channel.control(f.request('33')),{code:'document_runtime_capacity'});f.channel.ackOutcome({lifetime:'runtime',id:'1'});f.channel.control(f.request('33'));f.channel.ackControl({sequence:'33'});
  f.channel.control({sequence:'34',command:{kind:'cancel',lifetime:'runtime',id:'2'}});assert.deepEqual(f.commands.at(-1),{kind:'cancelRequest',id:'2'});assert.equal(f.channel.observe().outcomes.length,0);await f.host.drain();
});
test('feature channel rejects forged owner controls, foreign lifetimes, malformed ACKs and unsafe counters',async()=>{
  const f=channelFixture();for(const command of [{kind:'retire'},{kind:'complete',proof:true},{...f.request('1').command,lifetime:'foreign'},{...f.request('1').command,maxPumps:129},{...f.request('1').command,id:'01'}])assert.throws(()=>f.channel.control({sequence:'1',command}));
  assert.throws(()=>f.channel.control({...f.request('1'),extra:true}),{code:'invalid_request'});assert.throws(()=>f.channel.ackControl({sequence:'18446744073709551616'}),{code:'invalid_request'});assert.throws(()=>f.channel.ackOutcome({lifetime:'foreign',id:'1'}),{code:'document_runtime_expired'});assert.deepEqual(f.commands,[{kind:'wake',monotonicMs:17}]);await f.host.drain();
});

test('a foreground operation joins FIFO between distinct background effect tasks',async()=>{
  const f=fixture();f.host.start();f.next({inFlight:issued('2'),execution:'dispatch',outcomes:[]});await f.turn();assert.deepEqual(f.steps,['1']);await f.foreground('save');await f.foreground('query');await f.turn();assert.deepEqual(f.events,['effect1','save','query','effect2']);await f.host.drain();
});
test('lost failed step reply recovers32 actual outcomes and next descriptor once without fabricated failures',async()=>{
  const f=channelFixture();f.listen((snapshot,outcomes)=>f.channel.adopt(snapshot,outcomes));for(let id=1;id<=32;id++){f.channel.control(f.request(String(id)));f.channel.ackControl({sequence:String(id)});}
  const outcomes:DocumentRuntimeOutcome[]=Array.from({length:32},(_,index)=>({kind:'failed',id:String(index+1),failure:'unavailable'}));
  f.next({inFlight:issued('2'),execution:'dispatch',outcomes});f.throwStep();await f.turn();assert.equal(f.errors.length,1);assert.deepEqual(f.channel.observe().outcomes.map(row=>row.outcome),outcomes);assert.deepEqual(f.steps,['1']);assert.equal(f.state().inFlight?.effectId,'2');
  await f.turn();assert.deepEqual(f.steps,['1','2']);assert.equal(f.channel.observe().outcomes.length,32);for(let id=1;id<=32;id++)f.channel.ackOutcome({lifetime:'runtime',id:String(id)});assert.equal(f.channel.observe().outcomes.length,0);await f.host.drain();
});

test('authoritative lifetime replacement expires32 delivery slots and held control ACK without resetting highwaters',async()=>{
  const f=channelFixture();for(let id=1;id<=32;id++){f.channel.control(f.request(String(id)));if(id<32)f.channel.ackControl({sequence:String(id)});}f.channel.adopt(f.state(),[{kind:'cancelled',id:'1'}]);assert.equal(f.channel.observe().outcomes.length,1);
  f.set({update:{...f.state().update,lifetime:'replacement'}});assert.equal(f.channel.observe().outcomes.length,0);assert.throws(()=>f.channel.control(f.request('32')),{code:'document_runtime_expired'});
  for(let id=33;id<=64;id++){const input=f.request(String(id));f.channel.control({...input,command:{...input.command,lifetime:'replacement'}});f.channel.ackControl({sequence:String(id)});}assert.throws(()=>f.channel.control({...f.request('65'),command:{...f.request('65').command,lifetime:'replacement'}}),{code:'document_runtime_capacity'});await f.host.drain();
});

test('release may fail the accepted optional effect honestly but drains it before executor close',async()=>{
  const f=fixture(),barrier=pause();f.host.start();f.hold(barrier.promise);f.throwStep();await f.turn();let drained=false;const closing=f.host.drain().then(()=>{drained=true;});f.deny();await Promise.resolve();assert.equal(drained,false);assert.equal(f.closed(),0);barrier.resolve();await closing;assert.equal(f.steps.length,1);assert.ok(f.errors.length>=1);assert.equal(f.closed(),1);assert.equal(f.tasks.size,0);
});

/** Scripted core selections exercise host execution only: the fixture, rather
 * than the host, names the lane, Continue result and exact close-ready turn. */
function compositeFixture(){
  type Turn={lane:'draft'|'committed';id:string;outcomes?:readonly DocumentRuntimeOutcome[];fail?:boolean};
  const tasks=new Map<number,{fn:()=>void;delay:number}>(),selected:Turn[]=[],events:string[]=[],errors:unknown[]=[],changes:DocumentRuntimeOutcome[][]=[];
  let serial=0,closing=false,closed=0,releases=0,draftNudges=0,insideLocal=false,failClose=false;
  let tail=Promise.resolve(),lastSettled:ReturnType<typeof ticket>|null=null;
  const ticket=(turn:Turn)=>({incarnation:'work',lane:turn.lane,lifetime:turn.lane==='draft'?'draft-life':'runtime',id:turn.id});
  const state:DocumentRuntimeSnapshot={update,inFlight:null,lastStep:null,execution:'waitForWake'};
  const reduction=(outcomes:readonly DocumentRuntimeOutcome[]=[]):DocumentRuntimeReduction=>({effect:null,update,execution:'waitForWake',requestOutcomes:outcomes});
  const frame=()=>({work:{selected:selected[0]?ticket(selected[0]):null,last_settled:lastSettled,closing,close_ready:closing&&selected.length===0},turn:null});
  const maintenance:BrowserDocumentIndexMaintenance={
    draftsAvailable:true,command(input){events.push('command:'+input.kind);assert.notEqual(input.kind,'continue','Continue policy belongs to the composite core');assert.notEqual(input.kind,'retire','F retirement must release the actual draft client');return reduction();},
    async step(){assert.fail('legacy CIO execution must not bypass the composite selection');},
    snapshot:()=>state,update:()=>update,workSnapshot:frame,
    async workTurn(adopt){assert.equal(insideLocal,true);const turn=selected[0];if(!turn)return {state:closing?'quiesced':'waiting',reductions:[]};
      events.push('select:'+turn.lane+':'+turn.id);const continued=turn.outcomes?reduction(turn.outcomes):undefined;
      if(continued)adopt?.(continued);events.push('execute:'+turn.lane+':'+turn.id);
      if(turn.fail){turn.fail=false;throw new Error('actual cleanup effect failed');}
      selected.shift();lastSettled=ticket(turn);return {state:'ready',reductions:continued?[continued]:[]};
    },
    releaseDrafts(){releases++;if(!closing){closing=true;selected.push({lane:'draft',id:'101'},{lane:'committed',id:'102'},{lane:'draft',id:'103'});}return {...frame(),committed:reduction([{kind:'retired',id:'99'}])};},
    async close(){assert.equal(insideLocal,false,'drain must not hold the local queue while waiting for future cleanup tasks');assert.equal(frame().work.close_ready,true,'actual core close-ready must precede owner free');events.push('close');if(failClose){failClose=false;throw new Error('actual close failed');}closed++;},
  };
  const local=<T>(operation:()=>Promise<T>)=>{const accepted=tail.then(async()=>{insideLocal=true;try{return await operation();}finally{insideLocal=false;}});tail=accepted.then(()=>{},()=>{});return accepted;};
  const host=createBrowserDocumentRuntimeHost({maintenance,assertActive(){},local,changed(_snapshot,outcomes){events.push('adopt:'+outcomes.map(row=>row.id).join(','));changes.push([...outcomes]);},failed(error){errors.push(error);},draftChanged(){draftNudges++;},now:()=>17,
    schedule:(fn,delay)=>{const id=++serial;tasks.set(id,{fn,delay});return id as any;},cancelTimer:timer=>{tasks.delete(timer as any);}});
  async function turn(){const task=[...tasks].find(([,row])=>row.delay===0);assert.ok(task,'one future task must be scheduled');tasks.delete(task[0]);task[1].fn();for(let count=0;count<24;count++)await Promise.resolve();}
  const immediate=()=>[...tasks.values()].filter(row=>row.delay===0).length;
  return {host,maintenance,tasks,events,changes,errors,turn,immediate,add(...turns:Turn[]){selected.push(...turns);},foreground(){return local(async()=>{events.push('foreground');});},failFirst(){selected[0].fail=true;},failClose(){failClose=true;},closed:()=>closed,releases:()=>releases,draftNudges:()=>draftNudges};
}
test('composite host wakes without listeners and executes exactly one core-selected draft or CIO turn per future task',async()=>{
  const f=compositeFixture();f.host.start();assert.equal(f.immediate(),0);
  f.add({lane:'draft',id:'1'},{lane:'committed',id:'2',outcomes:[{kind:'cancelled',id:'31'}]},{lane:'draft',id:'3'});
  f.host.draftsChanged!();assert.equal(f.immediate(),1);assert.equal(f.events.some(row=>row.startsWith('execute:')),false);
  await f.turn();assert.deepEqual(f.events.filter(row=>row.startsWith('execute:')),['execute:draft:1']);assert.equal(f.immediate(),1);
  await f.foreground();await f.turn();assert.deepEqual(f.events.filter(row=>row.startsWith('execute:')),['execute:draft:1','execute:committed:2']);
  assert.ok(f.events.indexOf('foreground')<f.events.indexOf('execute:committed:2'));
  assert.ok(f.events.indexOf('adopt:31')<f.events.indexOf('execute:committed:2'),'actual Continue outcomes are adopted before CIO begins');
  await f.turn();assert.equal(f.immediate(),1);assert.equal(f.draftNudges(),4);
  await f.turn();assert.equal(f.immediate(),0);assert.equal(f.events.filter(row=>row.startsWith('execute:')).length,3);assert.equal(f.draftNudges(),4,'Waiting observation does not emit a draft nudge');assert.deepEqual(f.changes.flat().map(row=>row.id),['31']);
  const draining=f.host.drain();await f.turn();await f.turn();await f.turn();await draining;assert.equal(f.closed(),1);
});
test('composite release retains the owner through multiple future Drop turns and drains outside the local queue',async()=>{
  const f=compositeFixture();f.host.start();let drained=false;const closing=f.host.drain().then(()=>{drained=true;});
  assert.equal(f.releases(),1);assert.equal(f.closed(),0);assert.equal(f.immediate(),1);assert.equal(f.tasks.size,1,'repair is cancelled while cleanup remains alive');
  assert.deepEqual(f.changes.flat().map(row=>row.id),['99'],'release adopts only its actual committed report');
  assert.throws(()=>f.host.draftsChanged!(),{code:'document_runtime_retired'});
  for(let count=0;count<2;count++){await f.turn();assert.equal(drained,false);assert.equal(f.closed(),0);assert.equal(f.immediate(),1);}
  await f.turn();await closing;assert.equal(drained,true);assert.equal(f.closed(),1);assert.equal(f.tasks.size,0);assert.equal(f.releases(),1);
  assert.deepEqual(f.events.filter(row=>row.startsWith('execute:')),['execute:draft:101','execute:committed:102','execute:draft:103']);
});
test('failed actual cleanup reports rejection, keeps the selected ticket and permits later drain retry',async()=>{
  const f=compositeFixture();f.host.start();const first=f.host.drain();f.failFirst();const rejected=assert.rejects(first,/actual cleanup effect failed/);
  await f.turn();await rejected;assert.equal(f.closed(),0);assert.equal(f.errors.length,1);assert.equal(f.immediate(),1,'actual still-selected cleanup work remains scheduled');
  const retry=f.host.drain();await f.turn();await f.turn();await f.turn();await retry;
  assert.equal(f.closed(),1);assert.equal(f.releases(),1);assert.equal(f.events.filter(row=>row==='execute:draft:101').length,2,'retry follows the actual retained core ticket');
});
test('failed final close stays retryable after actual close-ready without recreating or freeing the owner early',async()=>{
  const f=compositeFixture();f.host.start();f.failClose();const first=f.host.drain(),rejected=assert.rejects(first,/actual close failed/);
  await f.turn();await f.turn();await f.turn();await rejected;assert.equal(f.closed(),0);assert.equal(f.immediate(),0);
  await f.host.drain();assert.equal(f.closed(),1);assert.equal(f.releases(),1);assert.equal(f.events.filter(row=>row==='close').length,2);
});
