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

test('failed autosave stays visible and idle until explicit retry settles the exact uncertain checkpoint',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();f.note.update('Exact typed draft 😀\n');await advance(t,10);
  const error=f.note.error,failed=f.calls.at(-1)!,calls=f.calls.length;assert.ok(error);assert.equal(f.note.dirty,true);assert.equal(f.plans.length,1);
  await advance(t,300_000);assert.equal(f.calls.length,calls);assert.equal(f.commits.length,0);assert.equal(f.note.error,error);assert.equal(f.note.text,'Exact typed draft 😀\n');
  await f.note.flush();assert.deepEqual(f.calls[calls],failed,'explicit retry settles the same uncertain CAS');assert.equal(await f.adapter.read('One.md'),f.note.text);assert.equal(f.note.dirty,false);assert.equal(f.note.error,null);
  const healthy=f.calls.length;await advance(t,300_000);assert.equal(f.calls.length,healthy);await f.note.dispose();
});

for(const [code,source] of [['storage_busy','host'],['storage_io_retryable','host'],['storage_capacity','host'],['filesystem_io_retryable','host'],['lock_timeout','host'],['durable_transport_lost','transport']] as const)test(`normal ${source} ${code} failure does not schedule a retry`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(),error=Object.assign(Error('Temporary provider failure'),{code,source});f.failCommit(error);f.note.update('Actual native fault draft');await advance(t,10);
  const original=f.commits[0];assert.equal(f.note.error?.cause,error);f.failCommit(undefined);await advance(t,300_000);assert.equal(f.commits.length,1);assert.equal(f.note.dirty,true);
  await f.note.flush();assert.equal(f.note.error,null);assert.equal(f.note.dirty,false);assert.equal(f.plans.length,1);assert.deepEqual(f.commits,[original,original]);assert.equal(await f.adapter.read('One.md'),'Actual native fault draft');await f.note.dispose();
});

test('explicit retry queries a lost commit reply before considering any other plan',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.loseCommit();f.note.update('Submitted body');await advance(t,10);
  const ref=JSON.parse(f.head!.encodedState!).operation.ref,boundary=f.events.length;assert.deepEqual(f.commits,[ref]);assert.equal(f.note.dirty,true);await advance(t,300_000);assert.equal(f.events.length,boundary);
  await f.note.flush();assert.equal(f.events[boundary],'query');assert.equal(f.plans.length,1);assert.deepEqual(f.commits,[ref]);assert.equal(f.note.savedText,'Submitted body');assert.equal(f.note.dirty,false);await f.note.dispose();
});

for(const code of ['client_not_admitted','durable_scope_changed','revision_conflict','permission_denied','EACCES','corrupt','corrupt_storage','storage_io','filesystem_io','checkpoint_storage','storage_failed','filesystem_failed','file_sync_failed','crypto_failed','protocol_failed','invalid_response'])test(`normal failure ${code} remains retained without idle IO`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(),error=Object.assign(Error('Provider failure'),{code});f.failCommit(error);f.note.update('Retained terminal draft');await advance(t,10);await advance(t,300_000);
  assert.equal(f.commits.length,1);assert.equal(f.note.error?.cause,error);assert.equal(f.note.dirty,true);assert.equal(f.note.text,'Retained terminal draft');f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});
for(const source of ['renderer','main','protocol'])test(`${source} provenance cannot cause a normal failed save to repeat`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCommit(Object.assign(Error('Untrusted failure'),{code:'storage_io_retryable',source}));f.note.update('Retained untrusted draft');await advance(t,10);await advance(t,300_000);
  assert.equal(f.commits.length,1);assert.equal(f.note.dirty,true);assert.equal(f.note.text,'Retained untrusted draft');f.failCommit(undefined);await f.note.dispose();
});

test('successful A drains newer B through the same serialized save loop',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.note.update('First draft');await advance(t,10);f.note.update('Later typing');await advance(t,10);assert.equal(f.maxCommits,1);
  release();await drain();await advance(t,10);assert.equal(f.note.dirty,false);assert.equal(f.note.savedText,'Later typing');assert.equal(await f.adapter.read('One.md'),'Later typing');assert.equal(f.maxCommits,1);assert.equal(f.plans.length,2);await f.note.dispose();
});

test('a new authored edit uses normal debounce and settles failed A before writing B',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCommit(transient());f.note.update('Failed A');await advance(t,10);const ref=f.commits[0];f.failCommit(undefined);await advance(t,300_000);assert.equal(f.commits.length,1);
  f.note.update('Newly typed B');await advance(t,9);assert.equal(f.commits.length,1);await advance(t,1);assert.deepEqual(f.commits.slice(0,2),[ref,ref]);assert.equal(f.plans.length,2);assert.equal(f.maxCommits,1);assert.equal(f.note.savedText,'Newly typed B');await f.note.dispose();
});

for(const lifecycle of ['dispose','rename','relocate','metadata-retirement'] as const)test(`${lifecycle} does not turn a failed save into an idle retry`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCommit(transient());f.note.update('Retained at retirement');await advance(t,10);
  if(lifecycle==='dispose')await assert.rejects(f.note.dispose());else if(lifecycle==='rename')await assert.rejects(f.note.rename('Renamed.md'));else if(lifecycle==='relocate')await assert.rejects(f.note.relocate('Renamed.md'));else await f.note.closeMetadataProjection();
  const attempts=f.commits.length;await advance(t,300_000);assert.equal(f.commits.length,attempts);assert.equal(f.note.dirty,true);assert.equal(f.note.text,'Retained at retirement');f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});

test('failed explicit query retains the same ref for another explicit retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.loseCommit();f.note.update('Committed body awaiting reply');await advance(t,10);
  const ref=JSON.parse(f.head!.encodedState!).operation.ref,query=f.writes.query,refs:DurableWriteRef[]=[];let loseQuery=true;
  f.writes.query=async input=>{refs.push(structuredClone(input));if(loseQuery){loseQuery=false;throw transient();}return query(input);};
  await assert.rejects(f.note.flush());await advance(t,300_000);assert.equal(refs.length,1);assert.equal(f.note.dirty,true);await f.note.flush();assert.equal(f.note.dirty,false);assert.equal(f.plans.length,1);assert.equal(f.commits.length,1);assert.ok(refs.length>=2);for(const value of refs)assert.deepEqual(value,ref);await f.note.dispose();
});

test('cyclic uncertainty causes remain retained without a timer or classifier walk',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(),error=Object.assign(Error('Uncertain request'),{code:'outcome_unknown',cause:undefined as unknown});error.cause=error;f.failCommit(error);f.note.update('Retained with cyclic cause');await advance(t,10);await advance(t,300_000);
  assert.equal(f.commits.length,1);assert.equal(f.note.dirty,true);f.failCommit(undefined);await f.note.dispose();
});

test('retirement during a held failing autosave retains draft and never schedules another attempt',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.failCommit(transient());f.note.update('Retained during closing');await advance(t,10);
  const closing=f.note.dispose();release();await assert.rejects(closing);const attempts=f.commits.length;await advance(t,300_000);assert.equal(f.commits.length,attempts);assert.equal(f.maxCommits,1);assert.equal(f.note.dirty,true);f.failCommit(undefined);await f.note.dispose();
});

test('reverting an unsubmitted legacy draft leaves no automatic work',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const adapter=new MemoryAdapter({'One.md':'Original'}),vault=new Vault(adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md',{debounceMs:10});await note.load();let guards=0,blocked=false;
  note.update('Draft',{validateWrite(){guards++;if(blocked)throw transient();}});blocked=true;await advance(t,10);assert.ok(note.error);note.update('Original');assert.equal(note.dirty,false);const before=guards;await advance(t,300_000);assert.equal(guards,before);assert.equal(await adapter.read('One.md'),'Original');await note.dispose();
});

for(const code of ['io','client_not_admitted'])test(`first ${code} failure notification truthfully exposes retained dirty/error`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const observations:{dirty:boolean;text:string;error:Error|null}[]=[];let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture(()=>{if(f?.note.error)observations.push({dirty:f.note.dirty,text:f.note.text,error:f.note.error});});f.failCommit(Object.assign(Error('Save unavailable'),{code}));f.note.update('Exact first-failure draft');await advance(t,10);
  assert.ok(observations.length);assert.equal(observations[0].dirty,true);assert.equal(observations[0].text,'Exact first-failure draft');assert.ok(observations[0].error);f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});

for(const kind of ['public','navigation'] as const)test(`${kind} flush failure rejects and stays idle until an explicit save`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();f.note.update('Owned flush draft');await assert.rejects(kind==='public'?f.note.flush():f.note.flushForNavigation());const failed=f.calls.at(-1)!,boundary=f.calls.length;
  await advance(t,300_000);assert.equal(f.calls.length,boundary);assert.equal(f.commits.length,0);assert.equal(f.note.dirty,true);assert.ok(f.note.error);await f.note.flush();assert.deepEqual(f.calls[boundary],failed);assert.equal(f.plans.length,1);assert.equal(f.note.dirty,false);await f.note.dispose();
});

test('legacy explicit retry retains its prior failure until its actual write succeeds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});class Adapter extends MemoryAdapter{writes=0;override async write(path:string,content:string){if(++this.writes===1)throw transient();await gate;return super.write(path,content);}}
  const adapter=new Adapter({'One.md':'Original'}),vault=new Vault(adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md',{debounceMs:10});await note.load();note.update('Legacy draft');await advance(t,10);const error=note.error;await advance(t,300_000);assert.equal(adapter.writes,1);
  const saving=note.flush();try{await drain();assert.equal(adapter.writes,2);assert.equal(note.error,error);assert.equal(note.dirty,true);}finally{release();await saving;await note.dispose();}assert.equal(await adapter.read('One.md'),'Legacy draft');assert.equal(note.dirty,false);assert.equal(note.error,null);
});

test('a newer edit whose debounce fired during held failed A still gets one ordinary save',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.failCommit(transient());
  f.note.update('Held A');await advance(t,10);const original=f.commits[0];f.note.update('Queued B');await advance(t,10);assert.equal(f.commits.length,1);
  release();await drain();assert.ok(f.note.error);f.failCommit(undefined);await advance(t,10);
  assert.equal(f.note.dirty,false);assert.equal(f.note.savedText,'Queued B');assert.equal(f.maxCommits,1);assert.deepEqual(f.commits.slice(0,2),[original,original]);assert.equal(f.plans.length,2);
  const attempts=f.commits.length;await advance(t,300000);assert.equal(f.commits.length,attempts);await f.note.dispose();
});

test('when internal A success already selected B and B fails, its debounce cannot retry B',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));const commit=f.writes.commit;let rejectB=true,calls=0;
  f.writes.commit=async ref=>{if(++calls>1&&rejectB)f.failCommit(transient());return commit(ref);};f.note.update('Held A');await advance(t,10);f.note.update('Attempted B');await advance(t,10);release();await drain();assert.ok(f.note.error);assert.equal(f.note.savedText,'Held A');assert.equal(f.note.text,'Attempted B');assert.equal(f.commits.length,2);
  await advance(t,300000);assert.equal(f.commits.length,2);assert.equal(f.note.dirty,true);rejectB=false;f.failCommit(undefined);await f.note.flush();assert.equal(f.note.savedText,'Attempted B');assert.equal(f.maxCommits,1);await f.note.dispose();
});

test('a queued newer debounce is consumed once even if settling A fails again',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.failCommit(transient());f.note.update('Held A');await advance(t,10);const ref=f.commits[0];f.note.update('Queued B');await advance(t,10);release();await drain();await advance(t,10);
  assert.deepEqual(f.commits,[ref,ref]);const attempts=f.commits.length;await advance(t,300000);assert.equal(f.commits.length,attempts);assert.equal(f.note.dirty,true);assert.equal(f.note.text,'Queued B');f.failCommit(undefined);await f.note.flush();assert.equal(f.note.savedText,'Queued B');await f.note.dispose();
});

test('repeated delivery of unchanged held A does not authorize a failed-save retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:()=>void;f.holdCommit(new Promise<void>(resolve=>{release=resolve;}));f.failCommit(transient());f.note.update('Held A');await advance(t,10);f.note.update('Held A');await advance(t,10);release();await drain();await advance(t,300000);
  assert.equal(f.commits.length,1);assert.equal(f.note.dirty,true);f.failCommit(undefined);await f.note.flush();await f.note.dispose();
});

test('unchanged A delivered during a held uncertain checkpoint does not schedule another attempt',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();f.note.update('Uncertain A');await advance(t,10);const original=f.calls.at(-1)!,cas=f.writes.checkpoints.compareAndSwap,requests:CheckpointChange[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  f.writes.checkpoints.compareAndSwap=async change=>{requests.push(structuredClone(change));if(requests.length===1)throw transient();await held;throw transient();};
  // The update's own checkpoint fails first; the autosave then holds its exact uncertain CAS.
  f.note.update('Uncertain A');await advance(t,10);assert.equal(requests.length,2);f.note.update('Uncertain A');await advance(t,10);release();await drain();
  const boundary=requests.length;assert.equal(boundary,3,'two explicit updates plus the held autosave have drained');await advance(t,300000);assert.equal(requests.length,boundary);
  for(const request of requests)assert.deepEqual(request,original);assert.equal(f.note.dirty,true);assert.equal(f.commits.length,0);f.writes.checkpoints.compareAndSwap=cas;await f.note.flush();assert.equal(f.plans.length,1);await f.note.dispose();
});

test('unchanged legacy intent delivered during held reconciliation does not schedule another read',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});class Adapter extends MemoryAdapter{fail=true;override async write(path:string,content:string){if(this.fail)throw transient();return super.write(path,content);}}
  const adapter=new Adapter({'One.md':'Original'}),vault=new Vault(adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md',{debounceMs:10});await note.load();note.update('Uncertain A');await advance(t,10);assert.ok(note.error);const reload=vault.reload.bind(vault);let release!:()=>void,reads=0;const held=new Promise<void>(resolve=>{release=resolve;});
  vault.reload=async()=>{reads++;await held;throw transient();};note.update('Uncertain A');await advance(t,10);assert.equal(reads,1);note.update('Uncertain A');await advance(t,10);release();await drain();await advance(t,300000);
  assert.equal(reads,1);assert.equal(note.dirty,true);assert.equal(note.text,'Uncertain A');vault.reload=reload;adapter.fail=false;await note.flush();await note.dispose();
});

test('a genuinely newer B debounce survives an already uncertain A checkpoint failure',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();f.failCheckpoint();f.note.update('Uncertain A');await advance(t,10);const original=f.calls.at(-1)!,cas=f.writes.checkpoints.compareAndSwap,requests:CheckpointChange[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  f.writes.checkpoints.compareAndSwap=async change=>{requests.push(structuredClone(change));await held;throw transient();};f.note.update('Uncertain A');await advance(t,10);f.note.update('New B');await advance(t,10);assert.equal(requests.length,1);release();await drain();assert.ok(f.note.error);f.writes.checkpoints.compareAndSwap=cas;await advance(t,10);
  assert.deepEqual(requests[0],original);assert.equal(f.note.dirty,false);assert.equal(f.note.savedText,'New B');assert.equal(f.plans.length,2);const attempts=f.commits.length;await advance(t,300000);assert.equal(f.commits.length,attempts);await f.note.dispose();
});
