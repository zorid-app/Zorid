import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserBinaryCommands } from '../src/platform/browser-binary-commands.ts';
import { BrowserVaultError } from '../src/core/browser-vault.ts';
import type { BinaryStreams, BinaryStageRequest, BinaryStageRef, BinaryStageStatus } from '../src/core/binary-streams.ts';
import type { Checkpoint, DurableCheckpoints } from '../src/core/durable-checkpoints.ts';

const scope={vaultId:'store',clientId:'client'},sha='0'.repeat(64);
const request:BinaryStageRequest={operationId:'operation',target:{kind:'create',entryId:'entry',path:'Note.bin'},expectedLength:'3'};
function fixture(){
  const heads=new Map<string,Checkpoint>(),stages=new Map<string,{request:BinaryStageRequest;status:BinaryStageStatus}>(),events:string[]=[];
  let sequence=0,failCAS=0,loseCAS=0,loseBegin=false,loseSeal=false,loseCommit=false,rejectCommit=false,temporaryCommit=false,queryFail=false,loseAbort=false,active=true;
  let loadGate:(()=>Promise<void>)|undefined;
  const checkpoints:DurableCheckpoints={scope,
    async load(key){if(loadGate)await loadGate();return structuredClone(heads.get(key)??null);},
    async compareAndSwap(change){const state=JSON.parse(change.encodedState!);events.push('checkpoint:'+state.phase);if(failCAS&&--failCAS===0)throw new Error('checkpoint failed');assert.equal(heads.get(change.key)?.revision??null,change.expectedRevision);const head:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(++sequence),deleted:false,byteLength:change.encodedState!.length,encodedState:change.encodedState};heads.set(change.key,head);if(loseCAS&&--loseCAS===0)throw new Error('checkpoint reply lost');return structuredClone(head);},
    async list(){return {items:structuredClone([...heads.values()]),cursor:null,highWater:String(sequence)};},async changes(){return {items:[],cursor:null,highWater:String(sequence)};},
  };
  const backend:BinaryStreams={limits:{maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'1048576'},
    async begin(input){events.push('begin');const old=stages.get(input.operationId);if(old){assert.deepEqual(input,old.request);return structuredClone(old.status.ref);}const ref={localStoreId:'store',clientId:'client',operationId:input.operationId,stageId:'stage-'+input.operationId};stages.set(input.operationId,{request:structuredClone(input),status:{ref,phase:'receiving',acceptedLength:'0',nextSequence:0}});if(loseBegin){loseBegin=false;throw new Error('begin reply lost');}return structuredClone(ref);},
    async append(ref,input){events.push('append');const row=stages.get(ref.operationId)!;const next=String(BigInt(input.offset)+BigInt(input.bytes.length));row.status.acceptedLength=next;row.status.nextSequence=input.sequence+1;return {sequence:input.sequence,offset:input.offset,bytes:input.bytes.length,digest:sha,acceptedLength:next};},
    async query(ref){events.push('query');if(queryFail)throw new Error('query failed');return structuredClone(stages.get(ref.operationId)!.status);},
    async seal(ref,input){events.push('seal');const row=stages.get(ref.operationId)!;row.status.phase='sealed';row.status.finalized={length:input.finalLength,sha256:sha};if(loseSeal){loseSeal=false;throw new Error('seal reply lost');}return structuredClone(row.status.finalized);},
    async commit(ref){events.push('commit');const row=stages.get(ref.operationId)!;
      if(row.status.outcome?.status==='committed')return row.status.outcome.receipt;
      if(temporaryCommit){row.status.phase='commit_requested';throw new Error('temporary failure');}
      if(rejectCommit){row.status.phase='rejected';row.status.outcome={status:'rejected',error:{code:'revision_conflict',message:'old event',source:'rust',details:{expected:'old-event'}}};throw new BrowserVaultError('revision_conflict','old event',undefined,'rust');}
      const target=row.request.target,receipt=JSON.stringify({operation_id:ref.operationId,sequence:String(++sequence),changes:[{before:null,after:{id:target.entryId,path:target.kind==='create'?target.path:'Existing.bin',kind:'file',deleted:false,revision:'result-revision'}}]});
      row.status.phase='committed';row.status.outcome={status:'committed',receipt};if(loseCommit){loseCommit=false;throw new Error('commit reply lost');}return receipt;
    },
    async abort(ref){events.push('abort');stages.get(ref.operationId)!.status.phase='aborted';if(loseAbort){loseAbort=false;throw new Error('abort reply lost');}},
    async openRead(input){events.push('openRead');return {localStoreId:'store',clientId:'client',readId:'read',entryId:input.entryId,entryRevision:input.expectedRevision??'read-revision',selectedContentEvent:input.expectedContentEvent??'read-event',length:'3'};},
    async read(_ref,input){events.push('read');const bytes=Uint8Array.from([1,2,3]).subarray(Number(input.offset),Number(input.offset)+input.maxBytes);const nextOffset=String(BigInt(input.offset)+BigInt(bytes.length));return {bytes,nextOffset,eof:nextOffset==='3'};},async closeRead(){events.push('closeRead');},
  };
  const consumer=()=>createBrowserBinaryCommands({backend,scope,checkpoints,assertActive(){if(!active)throw new BrowserVaultError('client_ownership_lost','retired');}});
  return {heads,stages,events,backend,checkpoints,consumer,
    state(){return JSON.parse([...heads.values()][0].encodedState!);},failCheckpoint(n:number){failCAS=n;},loseCheckpoint(n:number){loseCAS=n;},loseBegin(){loseBegin=true;},loseSeal(){loseSeal=true;},loseCommit(){loseCommit=true;},rejectCommit(){rejectCommit=true;},temporaryCommit(){temporaryCommit=true;},queryFail(value=true){queryFail=value;},loseAbort(){loseAbort=true;},retire(){active=false;},loadGate(value?:()=>Promise<void>){loadGate=value;}};
}
async function sealed(f:ReturnType<typeof fixture>){const consumer=f.consumer(),ref=await consumer.streams.begin(request);await consumer.streams.append(ref,{sequence:0,offset:'0',bytes:Uint8Array.from([1,2,3])});await consumer.streams.seal(ref,{finalLength:'3',expectedDigest:sha});return {consumer,ref};}

test('begin, EOF and authorization checkpoints precede backend effects; outcome precedes return',async()=>{
  const f=fixture(),{consumer,ref}=await sealed(f);const receipt=await consumer.streams.commit(ref);
  assert.deepEqual(f.events,['checkpoint:receiving','begin','checkpoint:receiving','append','checkpoint:seal_requested','seal','checkpoint:sealed','checkpoint:commit_requested','commit','checkpoint:committed']);
  assert.equal(f.state().outcome.receipt,receipt);const before=f.events.length;assert.equal(await f.consumer().streams.commit(ref),receipt);assert.equal(f.events.length,before);
  assert.equal(f.state().request.target.kind,'create');assert.equal('bytes'in f.state(),false);assert.doesNotMatch([...f.heads.values()][0].encodedState!,/base64/);
});
test('initial checkpoint failure cannot begin a stage; lost begin reply retains original operation',async()=>{
  const f=fixture();f.failCheckpoint(1);await assert.rejects(f.consumer().streams.begin(request),/checkpoint failed/);assert.equal(f.stages.size,0);
  f.loseBegin();await assert.rejects(f.consumer().streams.begin(request),/begin reply lost/);assert.equal(f.state().ref,undefined);const events=f.events.length;assert.equal(await f.consumer().recover(),false);assert.equal(f.events.length,events);
  const ref=await f.consumer().streams.begin(request);assert.equal(ref.operationId,request.operationId);assert.equal(f.stages.size,1);
  await assert.rejects(f.consumer().streams.begin({...request,target:{kind:'create',entryId:'replacement',path:'Note.bin'}}),{code:'idempotency_conflict'});
});
test('receiving/sealed/seal-requested stages remain inert during recovery',async()=>{
  for(const kind of ['receiving','seal_requested','sealed']as const){const f=fixture(),consumer=f.consumer(),ref=await consumer.streams.begin(request);if(kind!=='receiving'){if(kind==='seal_requested')f.loseSeal();try{await consumer.streams.seal(ref,{finalLength:'0'});}catch{assert.equal(kind,'seal_requested');}}
    const before=f.events.length;assert.equal(await f.consumer().recover(),false);assert.equal(f.events.length,before);assert.equal(f.state().phase,kind);
  }
});
test('same operation never adopts changed original revision or selected content event',async()=>{
  const f=fixture(),input:BinaryStageRequest={operationId:'operation',target:{kind:'write',entryId:'entry',expectedRevision:'old-revision',expectedContentEvent:'old-event'},expectedLength:'3'};
  const ref=await f.consumer().streams.begin(input);input.target={kind:'write',entryId:'entry',expectedRevision:'peer',expectedContentEvent:'peer-event'};
  assert.deepEqual(f.state().request.target,{kind:'write',entryId:'entry',expectedRevision:'old-revision',expectedContentEvent:'old-event'});
  await assert.rejects(f.consumer().streams.begin(input),{code:'idempotency_conflict'});assert.equal(ref.operationId,'operation');
});
test('caller chunk/ref snapshots occur before awaits and no all-file call queue forms',async()=>{
  const f=fixture(),consumer=f.consumer(),ref=await consumer.streams.begin(request);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.loadGate(()=>gate);
  let observed:Uint8Array|undefined;const append=f.backend.append;f.backend.append=async(stage,input)=>{observed=input.bytes.slice();return append(stage,input);};
  const bytes=Uint8Array.from([1,2,3]),input={sequence:0,offset:'0',bytes},writing=consumer.streams.append(ref,input);bytes.fill(42);input.offset='999';ref.stageId='wrong';
  await assert.rejects(consumer.streams.query({...ref,stageId:'stage-operation'}),{code:'binary_busy'});release();await writing;assert.deepEqual(observed,Uint8Array.from([1,2,3]));assert.equal(bytes[0],42);
  await assert.rejects(consumer.streams.append({...ref,stageId:'stage-operation'},{sequence:1,offset:'3',bytes:new Uint8Array(131073)}),{code:'request_limit'});
});
test('lost seal reply reuses exact EOF request and query can adopt inert sealed result',async()=>{
  const f=fixture(),consumer=f.consumer(),ref=await consumer.streams.begin(request);f.loseSeal();await assert.rejects(consumer.streams.seal(ref,{finalLength:'3',expectedDigest:sha}),/seal reply lost/);
  assert.equal(f.state().phase,'seal_requested');await assert.rejects(f.consumer().streams.seal(ref,{finalLength:'4'}),{code:'idempotency_conflict'});
  assert.equal((await f.consumer().streams.query(ref)).phase,'sealed');assert.equal(f.state().phase,'sealed');assert.equal(f.events.filter(value=>value==='commit').length,0);
});
test('failed authorization checkpoint cannot commit; terminal checkpoint failure resumes same authorized stage',async()=>{
  const f=fixture(),{consumer,ref}=await sealed(f);f.failCheckpoint(1);await assert.rejects(consumer.streams.commit(ref),/checkpoint failed/);assert.equal(f.events.includes('commit'),false);
  f.failCheckpoint(2);await assert.rejects(f.consumer().streams.commit(ref),/checkpoint failed/);assert.equal(f.state().phase,'commit_requested');assert.equal(await f.consumer().recover(),true);assert.equal(f.state().phase,'committed');assert.equal(f.events.filter(value=>value==='commit').length,1);
});
test('lost commit reply resolves exact retained receipt, while uncertain query leaves authorization intact',async()=>{
  const f=fixture(),{consumer,ref}=await sealed(f);f.loseCommit();const receipt=await consumer.streams.commit(ref);assert.equal(f.state().outcome.receipt,receipt);
  const other=fixture(),prepared=await sealed(other);other.temporaryCommit();other.queryFail();await assert.rejects(prepared.consumer.streams.commit(prepared.ref),/temporary failure/);assert.equal(other.state().phase,'commit_requested');assert.equal(other.state().outcome,undefined);
});
test('only retained stage rejection becomes terminal and recover does not replay it',async()=>{
  const f=fixture(),{consumer,ref}=await sealed(f);f.rejectCommit();await assert.rejects(consumer.streams.commit(ref),{code:'revision_conflict'});assert.deepEqual(f.state().outcome.error.details,{expected:'old-event'});
  const before=f.events.length;assert.equal(await f.consumer().recover(),false);await assert.rejects(f.consumer().streams.commit(ref),{code:'revision_conflict'});assert.equal(f.events.length,before);
});
test('explicit abort is checkpointed, remains inert on recovery, and cannot abort authorized stages',async()=>{
  const f=fixture(),consumer=f.consumer(),ref=await consumer.streams.begin(request);f.loseAbort();await assert.rejects(consumer.streams.abort(ref),/abort reply lost/);assert.equal(f.state().phase,'abort_requested');const before=f.events.length;assert.equal(await f.consumer().recover(),false);assert.equal(f.events.length,before);await f.consumer().streams.abort(ref);assert.equal(f.state().phase,'aborted');assert.ok(f.events.indexOf('checkpoint:abort_requested')<f.events.indexOf('abort'));
  const authorized=fixture(),prepared=await sealed(authorized);authorized.temporaryCommit();await assert.rejects(prepared.consumer.streams.commit(prepared.ref));await assert.rejects(prepared.consumer.streams.abort(prepared.ref),{code:'invalid_stage_state'});
});
test('scope and original stage binding fail before backend effects; invalid synchronous ref does not wedge later calls',async()=>{
  const f=fixture(),consumer=f.consumer(),ref=await consumer.streams.begin(request),before=f.events.length;
  for(const wrong of [{...ref,clientId:'other'},{...ref,localStoreId:'other'},{...ref,stageId:'other'}])await assert.rejects(consumer.streams.commit(wrong));assert.equal(f.events.length,before);
  assert.equal((await consumer.streams.query(ref)).phase,'receiving');assert.throws(()=>createBrowserBinaryCommands({backend:f.backend,scope:{...scope,clientId:'other'},checkpoints:f.checkpoints,assertActive(){}}),{code:'owner_mismatch'});
});
test('read forwarding snapshots observations and bounds one chunk; retirement fences queued checkpoint continuations',async()=>{
  const f=fixture(),consumer=f.consumer(),input={entryId:'entry',expectedRevision:'r',expectedContentEvent:'e'},pinning=consumer.streams.openRead(input);input.entryId='replacement';const pin=await pinning;assert.equal(pin.entryId,'entry');
  const part=await consumer.streams.read(pin,{offset:'0',maxBytes:2});assert.deepEqual(part,{bytes:Uint8Array.from([1,2]),nextOffset:'2',eof:false});await assert.rejects(consumer.streams.read(pin,{offset:'0',maxBytes:131073}),{code:'request_limit'});await consumer.streams.closeRead(pin);
  const ref=await consumer.streams.begin(request);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.loadGate(()=>gate);const pending=consumer.streams.append(ref,{sequence:0,offset:'0',bytes:Uint8Array.of(1)});f.retire();release();await assert.rejects(pending,{code:'client_ownership_lost'});assert.equal(f.events.includes('append'),false);
});
test('tampered checkpoints and foreign receipts fail closed without authorizing another target',async()=>{
  const f=fixture(),{consumer,ref}=await sealed(f);f.backend.commit=async()=>JSON.stringify({operation_id:'different',sequence:'1',changes:[]});await assert.rejects(consumer.streams.commit(ref),{code:'invalid_binary_response'});assert.equal(f.state().phase,'commit_requested');
  const head=[...f.heads.values()][0],state=f.state();state.ref.stageId='foreign';f.heads.set(head.key,{...head,encodedState:JSON.stringify(state)});await assert.rejects(f.consumer().streams.query(ref),{code:'stage_checkpoint_missing'});
});
test('lost durable checkpoint replies load the saved ref/outcome rather than allocate or commit again',async()=>{
  const f=fixture();f.loseCheckpoint(2);await assert.rejects(f.consumer().streams.begin(request),/checkpoint reply lost/);const ref=await f.consumer().streams.begin(request);assert.equal(f.events.filter(value=>value==='begin').length,1);
  await f.consumer().streams.seal(ref,{finalLength:'0'});f.loseCheckpoint(2);await assert.rejects(f.consumer().streams.commit(ref),/checkpoint reply lost/);const receipt=f.state().outcome.receipt;assert.equal(await f.consumer().streams.commit(ref),receipt);assert.equal(f.events.filter(value=>value==='commit').length,1);
});
