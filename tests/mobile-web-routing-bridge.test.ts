import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeWebRoutingChannel} from '../src/platform/mobile-web-routing-bridge.ts';
import type {WebRouteState,WebRouteResult,WebRouteProgress} from '../src/platform/mobile-web-routing.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
async function until(check:()=>boolean){for(let n=0;n<100;n++){if(check())return;await new Promise<void>(yes=>setImmediate(yes));}assert.fail('bridge fixture timed out');}
async function fixture(){
  const handlers=new Map<string,(value:unknown)=>void>(),states:WebRouteState[]=[],results:WebRouteResult[]=[],frames=new Map<number,()=>void>();
  let frameId=0,current=true,stateGate:Promise<void>|undefined,resultGate:Promise<void>|undefined,failState=false,failResult=false,removals=0;
  const scope={localStoreId:'Store_A',clientId:crypto.randomUUID()},webSessionId=crypto.randomUUID(),tabId=crypto.randomUUID();
  const channel=await createNativeWebRoutingChannel({
    async addListener(name,handler){handlers.set(name,handler);return{async remove(){removals++;handlers.delete(name);}};},
    async webRouteState(state){states.push(state);if(stateGate)await stateGate;if(failState)throw new Error('state delivery lost');},
    async webRouteResult(result){results.push(result);if(resultGate)await resultGate;if(failResult)throw new Error('result receipt lost');},
  },scope,()=>current,{request(run){const id=++frameId;frames.set(id,run);return id;},cancel(id){frames.delete(id as number);}});
  const state=(version='1'):WebRouteState=>({...scope,webSessionId,version,status:'ready',presentation:'native',selectedTabId:tabId,tabs:[{id:tabId,title:'Home',route:{kind:'home'},canBack:false,canForward:false}]});
  return{channel,scope,states,results,state,handlers,frames,webSessionId,
    emit(name:string,value:unknown){handlers.get(name)?.(value);},frame(){for(const [id,run]of frames){frames.delete(id);run();}},
    current(value:boolean){current=value;},holdState(promise:Promise<void>|undefined){stateGate=promise;},holdResult(promise:Promise<void>|undefined){resultGate=promise;},failState(value:boolean){failState=value;},failResult(value:boolean){failResult=value;},get removals(){return removals;}};
}

test('channel pins actual store/client/session and captures immutable bounded state before native await',async()=>{
  const f=await fixture(),input=f.state();await f.channel.service.publish(input);input.tabs[0].title='changed by caller';
  assert.equal(f.states[0].tabs[0].title,'Home');assert.ok(Object.isFrozen(f.states[0].tabs[0].route));
  for(const change of [{clientId:crypto.randomUUID()},{localStoreId:'OtherStore'},{webSessionId:crypto.randomUUID()}])await assert.rejects(f.channel.service.publish({...f.state('2'),...change}),/scope changed/);
  await f.channel.close();assert.equal(f.removals,2);
});

test('applied result waits latest committed state receipt and lost publication can retry without route rollback',async()=>{
  const f=await fixture();await f.channel.service.publish(f.state());const pending=gate();f.holdState(pending.promise);
  const publish=f.channel.service.publish(f.state('2'));await until(()=>f.states.length===2);
  const packet:WebRouteResult={id:crypto.randomUUID(),webSessionId:f.webSessionId,status:'applied',version:'2'};
  const result=f.channel.service.result(packet);assert.equal(f.results.length,0);pending.resolve();await publish;await result;assert.equal(f.results.length,1);
  f.holdState(undefined);f.failState(true);await assert.rejects(f.channel.service.publish(f.state('3')));
  let delivered=false;const retained=f.channel.service.result({...packet,id:crypto.randomUUID(),version:'3'}).then(()=>{delivered=true;});await new Promise<void>(yes=>setImmediate(yes));assert.equal(delivered,false);
  await assert.rejects(f.channel.service.publish(f.state('1')),/regressed/,'an old retry cannot replace newest desired state');
  f.failState(false);await f.channel.service.publish(f.state('3'));await retained;assert.equal(delivered,true);await f.channel.close();
});

test('latest-only animation uses accepted gesture identity and no per-frame state/result calls',async()=>{
  const f=await fixture(),gestureId=crypto.randomUUID(),progress:Readonly<WebRouteProgress>[]=[];
  f.channel.service.subscribe(async()=>{},packet=>{progress.push(packet);});
  await f.channel.service.publish({...f.state(),gesture:{id:gestureId,direction:-1,phase:'tracking'}});
  const event=(sequence:string,fraction:number)=>({webSessionId:f.webSessionId,gestureId,sequence,fraction});
  f.emit('webRouteProgress',event('1',0.1));f.emit('webRouteProgress',event('3',0.7));f.emit('webRouteProgress',event('2',0.4));
  f.emit('webRouteProgress',{...event('4',0.9),gestureId:crypto.randomUUID()});assert.equal(progress.length,0);assert.equal(f.frames.size,1);
  f.frame();assert.deepEqual(progress.map(p=>[p.sequence,p.fraction]),[['3',0.7]]);assert.equal(f.states.length,1);assert.equal(f.results.length,0);
  await f.channel.close();
});

test('command handler can publish and return result without storage/publication queue deadlock',async()=>{
  const f=await fixture();await f.channel.service.publish(f.state());
  f.channel.service.subscribe(async command=>{
    assert.ok(Object.isFrozen(command.action));await f.channel.service.publish(f.state('2'));
    await f.channel.service.result({id:command.id,webSessionId:f.webSessionId,status:'applied',version:'2'});
  },()=>{});
  f.emit('webRouteCommand',{id:crypto.randomUUID(),webSessionId:f.webSessionId,expectedVersion:'1',action:{type:'newTab'}});
  await until(()=>f.results.length===1);await f.channel.close();
});

test('close drains admitted command/result and cancels pending animation before host lease retirement',async()=>{
  const f=await fixture(),pending=gate(),gestureId=crypto.randomUUID();await f.channel.service.publish({...f.state(),gesture:{id:gestureId,direction:1,phase:'tracking'}});
  let entered=false,completed=false;f.channel.service.subscribe(async()=>{entered=true;await pending.promise;completed=true;},()=>assert.fail('retired frame'));
  f.emit('webRouteCommand',{id:crypto.randomUUID(),webSessionId:f.webSessionId,expectedVersion:'1',action:{type:'newTab'}});await until(()=>entered);
  f.emit('webRouteProgress',{webSessionId:f.webSessionId,gestureId,sequence:'1',fraction:0.5});assert.equal(f.frames.size,1);
  let closed=false;const closing=f.channel.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(f.frames.size,0);
  pending.resolve();await closing;assert.equal(completed,true);await assert.rejects(f.channel.service.publish(f.state('2')),/unavailable/);
});
test('lost applied result receipt retains exact packet and retries without rerunning a router command',async()=>{
  const f=await fixture();await f.channel.service.publish(f.state());f.failResult(true);
  const packet:WebRouteResult={id:crypto.randomUUID(),webSessionId:f.webSessionId,status:'applied',version:'1'};
  let delivered=false;const pending=f.channel.service.result(packet).then(()=>{delivered=true;});await until(()=>f.results.length===1);assert.equal(delivered,false);
  f.failResult(false);await f.channel.service.result({...packet});await pending;assert.equal(f.results.length,2);assert.deepEqual(f.results[0],f.results[1]);await f.channel.close();
});
test('closing fences and rejects retained unpublished receipts rather than hanging release',async()=>{
  const f=await fixture();await f.channel.service.publish(f.state());f.failState(true);await assert.rejects(f.channel.service.publish(f.state('2')));
  const result=f.channel.service.result({id:crypto.randomUUID(),webSessionId:f.webSessionId,status:'applied',version:'2'});
  const rejected=assert.rejects(result,/retired/);await f.channel.close();await rejected;assert.equal(f.results.length,0);
});
