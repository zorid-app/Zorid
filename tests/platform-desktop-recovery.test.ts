import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformAdapter} from '../src/platform/index.ts';
import {Vault} from '../src/core/vault.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';

const scope={vaultId:'recovery-authority',clientId:'registered-window'};
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(check());}
async function fixture(t:TestContext){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:{admission:string;method:string;args:any[]}[]=[],receivers:{admission:string;retire:()=>void;stopped:boolean}[]=[],heads=new Map<string,any>(),plans=new Map<string,any>(),intents=new Map<string,any>();
 let recoveryCalls=0,releaseCalls=0,failCheckpoint=true,badScope=false,readGate:ReturnType<typeof held<any>>|undefined;
 const row={entryId:'one',revision:'file-1',path:'One.md',content:'Saved source',stat:{ctime:1,mtime:1,size:12}};
 const binding=(admissionId:string)=>({admissionId,scope:{...scope}});
 const bridge={getVault:async()=>({path:'/recovery-fixture',name:'Recovery'}),getDurableContext:async()=>binding('old-admission'),
 recoverDurableContext:async(_root:string,oldId:string)=>{recoveryCalls++;assert.equal(oldId,'old-admission');return{...binding('new-admission'),scope:badScope?{...scope,vaultId:'foreign'}:{...scope}};},
 releaseDurableContext:async()=>{releaseCalls++;},onChange:()=>()=>{},
 onDocumentRuntimeNudge:(_root:string,admission:string,_listener:()=>void,retire:()=>void)=>{const receiver={admission,retire,stopped:false};receivers.push(receiver);return()=>{receiver.stopped=true;};},
 durableInvoke:async(_root:string,admission:string,method:string,args:any[])=>{
  calls.push({admission,method,args:structuredClone(args)});const input=args[0];
  if(method==='readText'||method==='readTextById'){if(admission==='old-admission'&&readGate)return readGate.promise;return structuredClone(row);}
  if(method==='checkpoints.load')return structuredClone(heads.get(input)??null);
  if(method==='checkpoints.list'||method==='checkpoints.changes')return{items:[],cursor:null,highWater:'0'};
  if(method==='checkpoints.compareAndSwap'){
   if(admission==='old-admission'&&failCheckpoint)throw Error('Durable editor request failed; retain pending recovery state.');
   const prior=heads.get(input.key);if(prior?.revision===input.nextRevision){assert.equal(prior.encodedState,input.encodedState);return structuredClone(prior);}
   assert.equal(input.expectedRevision,prior?.revision??null);
   const next={version:1,...scope,key:input.key,revision:input.nextRevision,encodedState:input.encodedState,deleted:false,sequence:String(calls.length),byteLength:input.encodedState.length};heads.set(input.key,next);return structuredClone(next);
  }
  if(method==='planWrite'){plans.set(input.operationId,structuredClone(input));return{notePlanning:true,schemaVersion:1,ok:true,value:{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)}};}
  if(method==='prepare'){const ref={...scope,entryId:input.entryId,operationId:input.operationId,token:input.operationId};const intent={ref,state:'prepared',acknowledged:false};intents.set(ref.token,intent);return structuredClone(intent);}
  if(method==='query')return structuredClone(intents.get(input.token));
  if(method==='commit'){const plan=plans.get(input.operationId);assert.equal(row.revision,plan.expectedRevision);row.content=plan.content;row.revision='file-2';row.stat.size=row.content.length;const intent={ref:input,state:'committed',acknowledged:false,receipt:{operationId:input.operationId,entryId:input.entryId,revision:row.revision,sequence:'2'}};intents.set(input.token,intent);return structuredClone(intent);}
  if(method==='acknowledge')return;
  if(method==='listUnacknowledged')return[];
  throw Error('Unexpected '+method);
 }};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
 const platform=(await createPlatformAdapter())!;
 return{platform,bridge,calls,receivers,heads,plans,row,get recoveryCalls(){return recoveryCalls;},get releaseCalls(){return releaseCalls;},foreignScope(){badScope=true;},holdRead(){readGate=held();return readGate;},allowOldWrites(){failCheckpoint=false;}};
}

test('same NoteBuffer recovers its exact uncertain checkpoint before any new planning',async t=>{
 const f=await fixture(t),adapter=new MemoryAdapter({'One.md':f.row.content});Object.assign(adapter,{durableWrites:f.platform.adapter.durableWrites});const vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.dispose().catch(()=>{}));await buffer.load();buffer.update('Retained exact draft');await until(()=>!!buffer.error);
 const writes=f.platform.adapter.durableWrites!,first=f.calls.find(call=>call.method==='checkpoints.compareAndSwap')!;assert.ok(first);assert.ok(f.platform.recovery,'desktop recovery capability');
 const fresh=await f.platform.recovery!.recover();assert.equal(f.platform.adapter.durableWrites,writes,'retained NoteBuffer keeps its exact capability object');assert.deepEqual(fresh.adapter.durableWrites!.checkpoints.scope,scope);
 await buffer.flush();const replay=f.calls.find(call=>call.admission==='new-admission'&&call.method==='checkpoints.compareAndSwap')!;assert.deepEqual(replay.args[0],first.args[0]);assert.ok(f.calls.indexOf(replay)<f.calls.findIndex(call=>call.method==='planWrite'),'uncertain recovery checkpoint settles before fresh planning');
 assert.equal(buffer.text,'Retained exact draft');assert.equal(buffer.dirty,false);assert.equal(f.row.content,buffer.text);assert.equal(f.plans.size,1);await buffer.dispose();
});

test('owned retirement triggers recovery without more typing and ignores stale callbacks after success',async t=>{
 const f=await fixture(t);assert.ok(f.platform.recovery);let hints=0;const stop=f.platform.recovery!.subscribe(()=>{hints++;});const old=f.receivers.find(row=>row.admission==='old-admission')!;assert.ok(old);old.retire();assert.equal(hints,1);
 const [one,two]=await Promise.all([f.platform.recovery!.recover(),f.platform.recovery!.recover()]);assert.equal(one,two);assert.equal(f.recoveryCalls,1);old.retire();assert.equal(hints,1);assert.equal(old.stopped,true);await f.platform.release!();assert.equal(f.releaseCalls,0,'old release cannot release the new admission');stop();
});

test('a delayed old durable reply is discarded and renewed after the proxy rebind',async t=>{
 const f=await fixture(t),gate=f.holdRead();const pending=f.platform.adapter.durableWrites!.readTextById('one');assert.ok(f.platform.recovery);await f.platform.recovery!.recover();gate.resolve({...f.row,content:'Obsolete old process response'});assert.equal((await pending)!.content,'Saved source');assert.deepEqual(f.calls.filter(call=>call.method==='readTextById').map(call=>call.admission),['old-admission','new-admission']);
});

test('foreign recovery scope never retargets the retained durable capability',async t=>{
 const f=await fixture(t);assert.ok(f.platform.recovery);f.foreignScope();await assert.rejects(f.platform.recovery!.recover(),/scope|identity/i);assert.equal((await f.platform.adapter.durableWrites!.readTextById('one'))!.content,'Saved source');assert.equal(f.calls.at(-1)!.admission,'old-admission');
});


test('ordinary release also fences an already accepted old durable reply and coalesces duplicate release',async t=>{
 const f=await fixture(t),gate=f.holdRead(),pending=f.platform.adapter.durableWrites!.readTextById('one'),rejected=assert.rejects(pending,{code:'client_not_admitted'});
 await Promise.all([f.platform.release!(),f.platform.release!()]);assert.equal(f.releaseCalls,1);gate.resolve(f.row);await rejected;
});

test('a lost recovery reply retries the original retired admission and retargets only after validated acknowledgment',async t=>{
 const f=await fixture(t),recover=f.bridge.recoverDurableContext;let lose=true;
 f.bridge.recoverDurableContext=async(...args)=>{const reply=await recover(...args);if(lose){lose=false;throw Error('Lost recovery acknowledgment');}return reply;};
 assert.ok(f.platform.recovery);await assert.rejects(f.platform.recovery!.recover(),/Lost recovery/);assert.equal(f.calls.length,0);
 const fresh=await f.platform.recovery!.recover();assert.equal(f.recoveryCalls,2);assert.deepEqual(fresh.adapter.durableWrites!.checkpoints.scope,scope);
 assert.equal((await f.platform.adapter.durableWrites!.readTextById('one'))!.content,'Saved source');assert.equal(f.calls.at(-1)!.admission,'new-admission');
});
