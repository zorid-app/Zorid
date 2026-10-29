import test from 'node:test';
import assert from 'node:assert/strict';
import {NoteLoadSupervisor} from '../src/ui/note-load-supervisor.ts';

const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
const fault=(code:string,source='host',cause?:unknown)=>Object.assign(new Error(code),{code,source,...(cause===undefined?{}:{cause})});
function gate<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test('typed transient IO retries the original closure after backoff and healthy completion does no work',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const supervisor=new NoteLoadSupervisor(),request=Object.freeze({expectedRevision:'old',nextRevision:'original-S1',encodedState:'Exact original body 🌱'}),seen:unknown[]=[],errors:unknown[]=[];
  let calls=0,successes=0;
  const result=supervisor.run(async()=>{seen.push(request);if(++calls===1)throw fault('storage_io_retryable');return request;},()=>{},
    {onError:error=>errors.push(error),onSuccess:()=>{successes++;}});
  await drain();assert.equal(supervisor.pending,true);assert.equal(calls,1);
  t.mock.timers.tick(499);await drain();assert.equal(calls,1);
  t.mock.timers.tick(1);assert.equal(await result,request);assert.deepEqual(seen,[request,request]);assert.equal(errors.length,1);assert.equal(successes,1);assert.equal(supervisor.pending,false);
  t.mock.timers.tick(90_000);await drain();assert.equal(calls,2);supervisor.stop();
});
