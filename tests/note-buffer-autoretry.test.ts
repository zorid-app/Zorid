import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {Checkpoint,CheckpointChange} from '../src/core/durable-checkpoints.ts';
import type {DurableWrites,DurableWriteRead,DurableWriteIntent,DurableWriteRef,DurableWritePlan} from '../src/core/durable-writes.ts';

const transient=()=>Object.assign(new Error('Temporary storage failure'),{code:'io'});
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function advance(t:TestContext,ms:number){t.mock.timers.tick(ms);await drain();}
async function fixture(onState?:()=>void){
  const scope={vaultId:'retry-authority',clientId:'retry-client'},adapter=new MemoryAdapter({'One.md':'Original exact body\n'});
  let current:DurableWriteRead={entryId:'entry',revision:'r1',path:'One.md',content:await adapter.read('One.md'),stat:{ctime:1,mtime:1,size:20}},head:Checkpoint|null=null;
  const calls:CheckpointChange[]=[],plans:DurableWritePlan[]=[],events:string[]=[],commits:DurableWriteRef[]=[];
  const intents=new Map<string,DurableWriteIntent>();
  let failCheckpoint=false,loseCommit=false,failCommit:unknown,commitGate:Promise<void>|undefined;
  let activeCommits=0,maxCommits=0,commitRevision=1;
  const writes:DurableWrites={checkpoints:{scope,load:async()=>head&&structuredClone(head),compareAndSwap:async change=>{
    calls.push(structuredClone(change));
    if(head?.revision===change.nextRevision){assert.equal(head.encodedState,change.encodedState);return structuredClone(head);}
    assert.equal(change.expectedRevision,head?.revision??null);
    head={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(calls.length),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'','utf8')};
    if(failCheckpoint&&JSON.parse(change.encodedState!).operation?.plan){failCheckpoint=false;throw transient();}
    return structuredClone(head);
  },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
  readText:async()=>structuredClone(current),readTextById:async()=>structuredClone(current),
  planWrite:async input=>{events.push('plan');const plan:DurableWritePlan={version:1,...scope,operationId:input.operationId,entryId:'entry',encodedPlan:JSON.stringify(input)};plans.push(plan);return structuredClone(plan);},
  prepare:async plan=>{events.push('prepare');const ref={...scope,operationId:plan.operationId,entryId:'entry',token:plan.operationId};const value:DurableWriteIntent={ref,state:'prepared',acknowledged:false};intents.set(ref.token,value);return structuredClone(value);},
  query:async ref=>{events.push('query');return structuredClone(intents.get(ref.token)??null);},
  commit:async ref=>{events.push('commit');commits.push(structuredClone(ref));activeCommits++;maxCommits=Math.max(maxCommits,activeCommits);
    try{if(commitGate)await commitGate;if(failCommit)throw failCommit;
      const content=JSON.parse(plans.find(plan=>plan.operationId===ref.operationId)!.encodedPlan).content;
      current={...current,revision:'r'+(++commitRevision),content,stat:{...current.stat,mtime:2,size:Buffer.byteLength(content)}};await adapter.write(current.path,content);
      const value:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:'entry',revision:current.revision,sequence:String(commitRevision)}};intents.set(ref.token,value);
      if(loseCommit){loseCommit=false;throw transient();}return structuredClone(value);
    }finally{activeCommits--;}
  },listUnacknowledged:async()=>[],acknowledge:async()=>{events.push('ack');}};
  Object.assign(adapter,{durableWrites:writes});const vault=new Vault(adapter);await vault.initialize();
  const note=new NoteBuffer(vault,'One.md',{debounceMs:10,onState});await note.load('entry');
  return{note,vault,adapter,writes,calls,plans,events,commits,get head(){return head;},get maxCommits(){return maxCommits;},
    failCheckpoint(){failCheckpoint=true;},loseCommit(){loseCommit=true;},failCommit(error:unknown){failCommit=error;},holdCommit(gate:Promise<void>){commitGate=gate;}};
}

test('transient autosave failure recovers without more typing and retries its exact uncertain checkpoint',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();
  f.note.update('Exact typed draft 😀\n');await advance(t,10);
  assert.ok(f.note.error);assert.equal(f.note.dirty,true);assert.equal(f.note.autosaveRetryPending,true);
  const failed=f.calls.at(-1)!;assert.equal(f.plans.length,1);
  await advance(t,499);assert.equal(f.commits.length,0);
  await advance(t,1);
  assert.deepEqual(f.calls[f.calls.indexOf(failed)+1],failed,'retry must settle the exact uncertain CAS identity');
  assert.equal(await f.adapter.read('One.md'),'Exact typed draft 😀\n');assert.equal(f.note.dirty,false);assert.equal(f.note.error,null);assert.equal(f.note.autosaveRetryPending,false);
  const calls=f.calls.length;await advance(t,60_000);assert.equal(f.calls.length,calls,'clean idle must do no checkpoint or save work');await f.note.dispose();
});

for(const [code,source] of [['storage_busy','host'],['storage_io_retryable','host'],['storage_capacity','host'],['filesystem_io_retryable','host'],['lock_timeout','host'],['durable_transport_lost','transport']] as const)test(`actual ${source} ${code} resumes the retained save automatically`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();
  f.failCommit(Object.assign(new Error('Durable editor request failed; retain pending recovery state.'),{code,source}));
  f.note.update('Actual native fault draft');await advance(t,10);
  assert.equal(f.note.autosaveRetryPending,true);const original=f.commits[0];
  f.failCommit(undefined);await advance(t,500);
  assert.equal(f.note.dirty,false);assert.equal(f.note.error,null);assert.equal(f.plans.length,1);
  assert.deepEqual(f.commits,[original,original]);assert.equal(await f.adapter.read('One.md'),'Actual native fault draft');await f.note.dispose();
});

test('lost commit reply resumes its retained intent through query before considering another plan',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.loseCommit();f.note.update('Submitted body');await advance(t,10);
  const held=JSON.parse(f.head!.encodedState!).operation.ref;assert.deepEqual(f.commits,[held]);assert.equal(f.note.dirty,true);
  const boundary=f.events.length;await advance(t,500);
  assert.equal(f.events[boundary],'query');assert.equal(f.plans.length,1);assert.deepEqual(f.commits,[held]);assert.equal(f.note.savedText,'Submitted body');assert.equal(f.note.dirty,false);await f.note.dispose();
});

test('transient retries keep the same intent at a capped interval and recover without user action',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();const error=transient();f.failCommit(error);f.note.update('Retained draft');await advance(t,10);
  for(const delay of [500,1500,4000]){assert.equal(f.note.autosaveRetryPending,true);await advance(t,delay);}
  assert.equal(f.commits.length,4);assert.equal(f.note.autosaveRetryPending,true);assert.equal(f.note.error?.cause,error);assert.equal(f.note.dirty,true);
  await advance(t,29_999);assert.equal(f.commits.length,4,'the capped retry must not spin');
  await advance(t,1);assert.equal(f.commits.length,5);assert.equal(f.note.autosaveRetryPending,true);
  await advance(t,30_000);assert.equal(f.commits.length,6);
  assert.equal(new Set(f.commits.map(ref=>JSON.stringify(ref))).size,1,'all retries retain the original intent');
  f.failCommit(undefined);await advance(t,30_000);
  assert.equal(f.note.dirty,false);assert.equal(f.note.error,null);assert.equal(await f.adapter.read('One.md'),'Retained draft');
  const attempts=f.commits.length,calls=f.calls.length;await advance(t,90_000);
  assert.equal(f.commits.length,attempts);assert.equal(f.calls.length,calls,'healthy idle must do no work');await f.note.dispose();
});

for(const code of ['client_not_admitted','durable_scope_changed','revision_conflict','permission_denied','EACCES','corrupt','corrupt_storage','storage_io','filesystem_io','checkpoint_storage','storage_failed','filesystem_failed','file_sync_failed','crypto_failed','protocol_failed','invalid_response'])test(`autosave does not retry terminal ${code}`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();const error=Object.assign(new Error('Durable editor request failed; retain pending recovery state.'),{code});f.failCommit(error);f.note.update('Retained terminal draft');await advance(t,10);
  assert.equal(f.note.autosaveRetryPending,false);await advance(t,60_000);assert.equal(f.commits.length,1);assert.equal(f.note.error?.cause,error);assert.equal(f.note.dirty,true);
  f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});

for(const source of ['renderer','main'])test(`unrecognized ${source} provenance cannot authorize transient save retries`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();
  f.failCommit(Object.assign(new Error('Storage unavailable'),{code:'storage_io_retryable',source}));f.note.update('Retained untrusted draft');await advance(t,10);
  assert.equal(f.note.autosaveRetryPending,false);await advance(t,90_000);assert.equal(f.commits.length,1);
  f.failCommit(undefined);await f.note.dispose();
});

for(const code of ['io','outcome_unknown'])test(`protocol ${code} never enters the continued transient retry loop`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();
  const error=Object.assign(new Error('Protocol response failed'),{code,source:'protocol'});
  f.failCommit(error);f.note.update('Protocol draft retained');await advance(t,10);
  assert.equal(f.note.autosaveRetryPending,false);await advance(t,300_000);
  assert.equal(f.commits.length,1);assert.equal(f.note.dirty,true);assert.equal(f.note.text,'Protocol draft retained');
  f.failCommit(undefined);await f.note.dispose();
});

test('typing during an automatic retry keeps one save loop and persists the latest draft',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCommit(transient());f.note.update('First draft');await advance(t,10);
  let release!:()=>void;f.failCommit(undefined);f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));await advance(t,500);
  f.note.update('Later typing');await advance(t,10);assert.equal(f.maxCommits,1);
  release();await drain();await advance(t,10);assert.equal(f.note.dirty,false);assert.equal(f.note.savedText,'Later typing');assert.equal(await f.adapter.read('One.md'),'Later typing');assert.equal(f.maxCommits,1);await f.note.dispose();
});

for(const lifecycle of ['dispose','rename','relocate','metadata-retirement'] as const)test(`${lifecycle} cancels pending automatic retries`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCommit(transient());f.note.update('Retained at retirement');await advance(t,10);
  assert.equal(f.note.autosaveRetryPending,true);
  if(lifecycle==='dispose')await assert.rejects(f.note.dispose());
  else if(lifecycle==='rename')await assert.rejects(f.note.rename('Renamed.md'));
  else if(lifecycle==='relocate')await assert.rejects(f.note.relocate('Renamed.md'));
  else await f.note.closeMetadataProjection();
  const attempts=f.commits.length;assert.equal(f.note.autosaveRetryPending,false);await advance(t,60_000);assert.equal(f.commits.length,attempts);assert.equal(f.note.dirty,true);assert.equal(f.note.text,'Retained at retirement');
  f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});

test('a lost retained-intent query reply retries the same ref without another plan or commit',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.loseCommit();f.note.update('Committed body awaiting reply');await advance(t,10);
  const ref=JSON.parse(f.head!.encodedState!).operation.ref,query=f.writes.query,refs:DurableWriteRef[]=[];
  let loseQuery=true;f.writes.query=async input=>{refs.push(structuredClone(input));if(loseQuery){loseQuery=false;throw transient();}return query(input);};
  await advance(t,500);assert.equal(f.note.dirty,true);assert.equal(f.note.autosaveRetryPending,true);assert.equal(f.plans.length,1);
  await advance(t,1500);assert.equal(f.note.dirty,false);assert.equal(f.plans.length,1);assert.equal(f.commits.length,1);assert.ok(refs.length>=2);for(const value of refs)assert.deepEqual(value,ref);await f.note.dispose();
});

test('cyclic uncertainty causes cannot spin the retry classifier or reschedule autosave',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();const cause=Object.assign(new Error('Uncertain request'),{code:'outcome_unknown',cause:undefined as unknown});cause.cause=cause;
  f.failCommit(cause);f.note.update('Retained with cyclic cause');await advance(t,10);await advance(t,60_000);
  assert.equal(f.commits.length,1);assert.equal(f.note.autosaveRetryPending,false);assert.equal(f.note.dirty,true);f.failCommit(undefined);await f.note.dispose();
});

test('explicit successful retry cancels its pending automatic retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCommit(transient());f.note.update('Manual retry body');await advance(t,10);
  f.failCommit(undefined);await f.note.flush();const calls=f.calls.length,attempts=f.commits.length;assert.equal(f.note.autosaveRetryPending,false);await advance(t,60_000);
  assert.equal(f.commits.length,attempts);assert.equal(f.calls.length,calls);await f.note.dispose();
});

test('retirement while autosave is running cancels further automatic retries and retains the draft',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.failCommit(transient());f.note.update('Retained during closing');await advance(t,10);
  const closing=f.note.dispose();release();await assert.rejects(closing);const attempts=f.commits.length;await advance(t,60_000);
  assert.equal(f.commits.length,attempts);assert.equal(f.maxCommits,1);assert.equal(f.note.autosaveRetryPending,false);assert.equal(f.note.dirty,true);f.failCommit(undefined);await f.note.dispose();
});

test('reverting an unsubmitted legacy draft clears retry state and leaves no automatic work',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const adapter=new MemoryAdapter({'One.md':'Original'}),vault=new Vault(adapter);await vault.initialize();
  const note=new NoteBuffer(vault,'One.md',{debounceMs:10});await note.load();let guards=0,blocked=false;
  note.update('Draft',{validateWrite(){guards++;if(blocked)throw transient();}});blocked=true;await advance(t,10);assert.equal(note.autosaveRetryPending,true);
  note.update('Original');assert.equal(note.dirty,false);assert.equal(note.autosaveRetryPending,false);const before=guards;await advance(t,60_000);assert.equal(guards,before);assert.equal(await adapter.read('One.md'),'Original');await note.dispose();
});

for(const code of ['io','client_not_admitted'])test(`first ${code} autosave error notification exposes truthful recovery state`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const observations:boolean[]=[];let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture(()=>{if(f?.note.error)observations.push(f.note.autosaveRetryPending);});f.failCommit(Object.assign(new Error('Save unavailable'),{code}));f.note.update('Exact first-failure draft');await advance(t,10);
  assert.ok(observations.length>0);assert.equal(observations[0],code==='io','the initial failure notification must already distinguish bounded recovery from terminal rejection');
  f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});

test('public flush failure rejects its caller but recovers automatically without more typing',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();f.note.update('Owned public-flush draft');
  await assert.rejects(f.note.flush());const failed=f.calls.at(-1)!;await advance(t,500);
  assert.equal(await f.adapter.read('One.md'),'Owned public-flush draft');assert.equal(f.note.dirty,false);assert.equal(f.note.error,null);
  assert.deepEqual(f.calls[f.calls.indexOf(failed)+1],failed);assert.equal(f.plans.length,1);await f.note.dispose();
});

test('legacy retry retains its prior failure while the next submitted write is still pending',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  class Adapter extends MemoryAdapter {writes=0;override async write(path:string,content:string){if(++this.writes===1)throw transient();await gate;return super.write(path,content);}}
  const adapter=new Adapter({'One.md':'Original'}),vault=new Vault(adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md',{debounceMs:10});await note.load();note.update('Legacy draft');await advance(t,10);const error=note.error;
  try{await advance(t,500);assert.equal(adapter.writes,2);assert.equal(note.error,error,'a baseline readback is not a successful save of the pending draft');assert.equal(note.autosaveRetryPending,true);assert.equal(note.dirty,true);}
  finally{release();await drain();await note.dispose();}
  assert.equal(await adapter.read('One.md'),'Legacy draft');assert.equal(note.dirty,false);assert.equal(note.error,null);
});

for(const autoRetry of [true,false])test(`public flush autoRetry=${autoRetry} classifies its first failure notification and respects drain policy`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const observations:boolean[]=[];let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture(()=>{if(f?.note.error)observations.push(f.note.autosaveRetryPending);});f.failCheckpoint();f.note.update('Preflight draft');await assert.rejects(f.note.flush({autoRetry}));
  assert.equal(observations[0],autoRetry);assert.equal(f.note.autosaveRetryPending,autoRetry);await advance(t,500);
  assert.equal(f.note.dirty,!autoRetry);assert.equal(f.commits.length,autoRetry?1:0);await f.note.flush();await f.note.dispose();
});

test('navigation preflight failure keeps its draft and recovers automatically after returning to the editor',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();f.note.update('Navigation draft');await assert.rejects(f.note.flushForNavigation());await advance(t,500);
  assert.equal(f.note.dirty,false);assert.equal(await f.adapter.read('One.md'),'Navigation draft');assert.equal(f.plans.length,1);await f.note.dispose();
});

test('retiring an in-flight public save cancels its later recovery scheduling',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.failCommit(transient());f.note.update('Public save at retirement');
  const saving=f.note.flush();await drain();await f.note.closeMetadataProjection();release();await assert.rejects(saving);const attempts=f.commits.length;await advance(t,60_000);
  assert.equal(f.note.autosaveRetryPending,false);assert.equal(f.commits.length,attempts);assert.equal(f.note.dirty,true);f.failCommit(undefined);await f.note.dispose();
});
