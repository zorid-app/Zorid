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

for(const[code,source]of[['storage_busy','host'],['storage_io_retryable','host'],['storage_capacity','host'],['filesystem_io_retryable','host'],['lock_timeout','host'],['durable_transport_lost','transport']] as const)test(`only trusted ${source} ${code} may enter transient backoff`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor();let calls=0;
  const result=supervisor.run(async()=>{if(++calls===1)throw fault(code,source);return 'original result';});await drain();
  t.mock.timers.tick(499);await drain();assert.equal(calls,1);t.mock.timers.tick(1);assert.equal(await result,'original result');assert.equal(calls,2);
});

test('backoff caps at thirty seconds without changing the original IO closure',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor(),original=Object.freeze({token:'retained-ref'});let calls=0,healthy=false;
  const result=supervisor.run(async()=>{calls++;if(!healthy)throw fault('storage_busy');return original;});await drain();
  for(const[delay,total]of[[500,2],[1500,3],[4000,4],[30000,5],[30000,6]]){t.mock.timers.tick(delay-1);await drain();assert.equal(calls,total-1);t.mock.timers.tick(1);await drain();assert.equal(calls,total);}
  healthy=true;t.mock.timers.tick(30000);assert.equal(await result,original);assert.equal(calls,7);assert.equal(supervisor.pending,false);
});

for(const[code,source]of[['storage_io_retryable','protocol'],['storage_io_retryable','renderer'],['storage_io_retryable','main'],['durable_transport_lost','host'],['storage_busy','transport'],['storage_io','host'],['corrupt_storage','host'],['revision_conflict','host'],['invalid_durable_response','protocol'],['host_exited','transport']])test(`terminal or untrusted ${source} ${code} never retries`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor(),error=fault(code,source);let calls=0,reported=0;
  await assert.rejects(supervisor.run(async()=>{calls++;throw error;},()=>{},{onError:()=>{reported++;}}),value=>value===error);
  supervisor.wake();supervisor.admissionAvailable();t.mock.timers.tick(90_000);await drain();assert.equal(calls,1);assert.equal(reported,0);assert.equal(supervisor.pending,false);
});

test('the recognized Vault wrapper keeps leaf provenance and never masks terminal causes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor();let calls=0;
  const result=supervisor.run(async()=>{if(++calls===1)throw fault('outcome_unknown','host',fault('filesystem_io_retryable'));return 'settled';});await drain();t.mock.timers.tick(500);assert.equal(await result,'settled');
  for(const error of[fault('outcome_unknown','protocol',fault('storage_busy')),fault('unknown_wrapper','host',fault('storage_busy')),fault('outcome_unknown','host',fault('storage_busy','protocol')),fault('storage_busy','host',fault('corrupt_storage'))]){
    await assert.rejects(supervisor.run(async()=>{throw error;}),value=>value===error);
  }
  const accessor=fault('storage_busy');Object.defineProperty(accessor,'cause',{get(){assert.fail('must not invoke cause accessors');}});
  const attempt=supervisor.run(async()=>{throw accessor;}),rejected=assert.rejects(attempt,value=>value===accessor);
  await drain();if(supervisor.pending)supervisor.stop();await rejected;
});

test('owner validation failures are terminal even when their code resembles retryable IO',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor(),stale=fault('storage_busy');let calls=0,checks=0;
  await assert.rejects(supervisor.run(async()=>{calls++;return 'late';},()=>{if(++checks===2)throw stale;}),value=>value===stale);
  t.mock.timers.tick(90_000);await drain();assert.equal(calls,1);assert.equal(supervisor.pending,false);
});

test('cancelling a held IO rejects promptly, denies late success, and permits a new run',async()=>{
  const supervisor=new NoteLoadSupervisor(),controller=new AbortController(),held=gate<string>();let successes=0;
  const result=supervisor.run(()=>held.promise,()=>{},{signal:controller.signal,onSuccess:()=>{successes++;}}),rejected=assert.rejects(result,{code:'note_load_cancelled'});
  controller.abort();await rejected;held.resolve('obsolete body');await drain();assert.equal(successes,0);assert.equal(supervisor.pending,false);
  assert.equal(await supervisor.run(async()=>'fresh body'),'fresh body');
});

test('aborting backoff clears its timer, and a late rejected IO is observed after stop',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor(),controller=new AbortController();let calls=0;
  const pending=supervisor.run(async()=>{calls++;throw fault('storage_busy');},()=>{},{signal:controller.signal}),rejected=assert.rejects(pending,{code:'note_load_cancelled'});await drain();
  controller.abort();await rejected;t.mock.timers.tick(90_000);await drain();assert.equal(calls,1);
  const held=gate<string>(),late=supervisor.run(()=>held.promise),stopped=assert.rejects(late,{code:'note_load_cancelled'});supervisor.stop();await stopped;held.reject(fault('storage_busy'));await drain();
  await assert.rejects(supervisor.run(async()=>'never'),{code:'note_load_cancelled'});
});

for(const code of['host_exited','client_not_admitted','client_ownership_lost','desktop_recovery_pending','desktop_recovery_stale_reply'])test(`${code} waits for a positive admission event with no health polling`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor();let calls=0;
  const pending=supervisor.run(async()=>{if(++calls===1)throw fault(code);return 'same owned request';});await drain();assert.equal(supervisor.pending,true);
  supervisor.wake();t.mock.timers.tick(90_000);await drain();assert.equal(calls,1,'transient wake and elapsed time cannot grant admission');
  supervisor.admissionAvailable();assert.equal(await pending,'same owned request');assert.equal(calls,2);
});

test('a positive admission hint racing a failed held request is not lost',async()=>{
  const supervisor=new NoteLoadSupervisor(),held=gate<string>();let calls=0;
  const pending=supervisor.run(async()=>++calls===1?held.promise:'same S1');supervisor.admissionAvailable();held.reject(fault('client_not_admitted'));
  assert.equal(await pending,'same S1');assert.equal(calls,2);
});

test('an admission event delivered by the failure observer also prevents a lost wake',async()=>{
  const supervisor=new NoteLoadSupervisor();let calls=0;
  const pending=supervisor.run(async()=>{if(++calls===1)throw fault('host_exited');return 'same ref';},()=>{},{onError:()=>supervisor.admissionAvailable()});
  assert.equal(await pending,'same ref');assert.equal(calls,2);
});

test('stop cancels an admission wait and concurrent closures cannot share one supervisor',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const supervisor=new NoteLoadSupervisor();let calls=0;
  const pending=supervisor.run(async()=>{calls++;throw fault('host_exited');}),rejected=assert.rejects(pending,{code:'note_load_cancelled'});await drain();
  await assert.rejects(supervisor.run(async()=>'unrelated request'),{code:'note_load_in_progress'});
  supervisor.stop();await rejected;supervisor.admissionAvailable();supervisor.wake();t.mock.timers.tick(90_000);await drain();assert.equal(calls,1);assert.equal(supervisor.pending,false);
});
