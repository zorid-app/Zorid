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
