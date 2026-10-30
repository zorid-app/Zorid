import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead,ConditionalSavedSourceCapture} from '../src/core/durable-writes.ts';
import type {IndependentDraftProvider,IndependentDraftRead} from '../src/core/independent-drafts.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

const logical='---\nscore: 9\n---\nLogical body';
const physical='---\nscore: 7\n---\nPhysical body';
async function fixture(){
  const scope={vaultId:'vault',clientId:'client'},checkpoints=new Map<string,Checkpoint>();
  const captures=new Map<string,ConditionalSavedSourceCapture>(),intents=new Map<string,DurableWriteIntent>(),intentInputs=new Map<string,{input:DurableWriteInput;source?:string}>();
  const requestIds:string[]=[];
  const planned:DurableWriteInput[]=[],prepared:string[]=[],committed:string[]=[],released:string[]=[];
  let saved=physical,captureCount=0,current:DurableWriteRead={entryId:'entry',revision:'r1',path:'One.md',content:logical,stat:{ctime:1,mtime:1,size:logical.length}};
  let onPlan:((input:DurableWriteInput)=>Promise<void>)|undefined,onCommit:(()=>Promise<void>)|undefined,onCheckpoint:(()=>Promise<void>)|undefined,onRelease:(()=>Promise<void>)|undefined;
  const adapter=new MemoryAdapter({'One.md':physical}) as MemoryAdapter&{durableWrites:DurableWrites};
  const writes:DurableWrites={
    checkpoints:{scope,load:async key=>structuredClone(checkpoints.get(key)??null),compareAndSwap:async change=>{
      if(onCheckpoint)await onCheckpoint();
      const old=checkpoints.get(change.key);if(old?.revision===change.nextRevision&&old.encodedState===change.encodedState)return structuredClone(old);
      assert.equal(change.expectedRevision,old?.revision??null);
      const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(Number(old?.sequence??0)+1),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'')};
      checkpoints.set(change.key,row);return structuredClone(row);
    },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    readText:async()=>structuredClone(current),readTextById:async id=>id===current.entryId?structuredClone(current):null,
    captureSavedSource:async request=>{captureCount++;requestIds.push(request.captureId);const capture={captureId:request.captureId,logicalWitness:{...request.logicalWitness},source:saved};captures.set(capture.captureId,capture);return structuredClone(capture);},
    releaseSavedSource:async id=>{if(onRelease)await onRelease();released.push(id);captures.delete(id);},
    listSavedSourceRequests:async()=>[...captures.values()].map(({captureId,logicalWitness})=>({captureId,logicalWitness,legacy:false})),
    planWrite:async input=>{planned.push(structuredClone(input));if(onPlan)await onPlan(input);return{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)};},
    prepare:async plan=>{prepared.push(plan.encodedPlan);const old=intents.get(plan.operationId);if(old)return structuredClone(old);
      const input=JSON.parse(plan.encodedPlan) as DurableWriteInput,capture=input.conditionalSavedSource?captures.get(input.conditionalSavedSource.captureId):undefined;
      const intent:DurableWriteIntent={state:'prepared',acknowledged:false,ref:{...scope,operationId:plan.operationId,entryId:plan.entryId,token:plan.operationId}};
      intentInputs.set(plan.operationId,{input,source:capture?.source});intents.set(plan.operationId,intent);return structuredClone(intent);
    },
    commit:async ref=>{committed.push(ref.token);if(onCommit)await onCommit();const held=intentInputs.get(ref.operationId)!,input=held.input;
      let outcome:DurableWriteIntent;
      if(input.conditionalSavedSource&&held.source!==saved)outcome={ref,state:'rejected',acknowledged:false,error:{operationId:ref.operationId,code:'conditional_source_changed',message:'Saved source changed'}};
      else{assert.equal(input.expectedContent,current.content);assert.equal(input.expectedRevision,current.revision);current={...current,content:input.content,revision:`r${Number(current.revision.slice(1))+1}`};saved=input.content;await adapter.write('One.md',saved);outcome={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,revision:current.revision,sequence:current.revision.slice(1)}};}
      intents.set(ref.token,outcome);return structuredClone(outcome);
    },
    query:async ref=>structuredClone(intents.get(ref.token)??null),listUnacknowledged:async()=>[],acknowledge:async ref=>{const intent=intents.get(ref.token)!;if(intent.state==='committed'||intent.state==='rejected')intents.set(ref.token,{...intent,acknowledged:true});},
  };
  const journalScope={...scope,incarnationId:'owned-renderer'},journal=new Map<string,Exclude<IndependentDraftRead,null>>();
  const provider:IndependentDraftProvider={scope:journalScope,list:async options=>[...journal.values()].filter(row=>!row.deleted&&(!options||row.entryId===options.entryId)),read:async address=>journal.get(address.writer)??null,
    compareAndSwap:async request=>{const old=journal.get(request.writer);assert.equal(request.expectedRevision,old?.revision??null);const row={...journalScope,entryId:request.entryId,writer:request.writer,revision:request.nextRevision,generation:request.generation,deleted:false as const,baseline:request.baseline,draft:request.draft,checkpointRevision:request.checkpointRevision,pendingOperation:request.pendingOperation};journal.set(request.writer,row);const{baseline,draft,checkpointRevision,pendingOperation,...receipt}=row;return receipt;},
    retire:async request=>{const row={...journalScope,entryId:request.entryId,writer:request.writer,revision:request.nextRevision,generation:request.generation,deleted:true as const};journal.set(request.writer,row);return row;}};
  Object.assign(adapter,{independentDrafts:provider});adapter.durableWrites=writes;const vault=new Vault(adapter);await vault.initialize();
  const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});await buffer.load();
  return{buffer,vault,writes,requestIds,planned,prepared,committed,released,captures,checkpoints,get saved(){return saved;},get capturesTaken(){return captureCount;},get current(){return current;},state:()=>JSON.parse(checkpoints.get('note/v1/entry')!.encodedState!),setPlan(fn:typeof onPlan){onPlan=fn;},setCommit(fn:typeof onCommit){onCommit=fn;},setCheckpoint(fn:typeof onCheckpoint){onCheckpoint=fn;},setRelease(fn:typeof onRelease){onRelease=fn;},external(text:string){saved=text;},async advanceLogical(text:string){current={...current,content:text,revision:'peer-revision'};saved=text;await adapter.write('One.md',text);},async reopen(){const reopened=new NoteBuffer(vault,'One.md',{debounceMs:60000});await reopened.load();return reopened;}};
}
const witness={entryId:'entry',revision:'r1',path:'One.md'};
async function stop(buffer:NoteBuffer){try{await buffer.dispose();}catch{ /* conflict remains intentionally retained */ }}

test('capture observes physical source separately and may be abandoned without a draft or plan',async()=>{
  const f=await fixture();const capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  assert.equal(capture.source,physical);assert.equal(f.buffer.savedText,logical);assert.equal(f.buffer.text,logical);assert.deepEqual(f.buffer.savedDurableWitness,witness);
  assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'unattached');assert.equal(f.planned.length,0);assert.equal(f.buffer.dirty,false);
  await f.buffer.releaseConditionalSavedSource(capture);assert.deepEqual(f.released,[capture.captureId]);assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'settled');await stop(f.buffer);
});

test('foreign, stale and already attached captures cannot mutate the shared draft',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  assert.throws(()=>f.buffer.update('bad',{conditionalSavedSource:structuredClone(capture)}),/another buffer/);assert.equal(f.buffer.text,logical);
  await assert.rejects(f.buffer.captureConditionalSavedSource({...witness,revision:'wrong'}),/another logical baseline/);assert.equal(f.capturesTaken,1);
  f.buffer.update('conditional',{conditionalSavedSource:capture});assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'pending');
  assert.throws(()=>f.buffer.update('bad',{conditionalSavedSource:capture}),/already attached/);assert.equal(f.buffer.text,'conditional');
  await f.buffer.flush();assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'settled');assert.equal(f.current.content,'conditional');assert.equal(f.planned[0].expectedContent,logical);assert.equal(f.planned[0].conditionalSavedSource!.captureId,capture.captureId);assert.equal('source' in f.planned[0].conditionalSavedSource!,false);await stop(f.buffer);
});

test('superseded capture releases the unattached proof and cannot adopt physical text',async()=>{
  const f=await fixture();let valid=true;const acquire=f.writes.captureSavedSource!;f.writes.captureSavedSource=async w=>{const capture=await acquire(w);valid=false;return capture;};
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness,()=>{if(!valid)throw new Error('retired');}),/retired/);
  assert.deepEqual(f.released,[f.requestIds[0]]);assert.equal(f.buffer.text,logical);assert.deepEqual(f.buffer.savedDurableWitness,witness);assert.equal(f.planned.length,0);await stop(f.buffer);
});

test('conditional planning checkpoints the original request and retries the identical input after a lost reply',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;let first=true;
  f.setPlan(async input=>{if(!input.conditionalSavedSource)return;const saved=f.state().operation;assert.deepEqual(saved.input,input);assert.equal(saved.plan,undefined);if(first){first=false;throw new DurableWritePlanningError('planning_transport_lost',true);}});
  f.buffer.update('conditional',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
  const original=f.state().operation.input;f.buffer.update('newer typing');await f.buffer.flush();
  assert.deepEqual(f.planned[0],original);assert.deepEqual(f.planned[1],original);assert.equal(f.capturesTaken,1);assert.equal(f.planned[2].content,'newer typing');assert.equal(f.planned[2].conditionalSavedSource,undefined);
  assert.equal(f.buffer.text,'newer typing');assert.equal(f.buffer.savedText,'newer typing');assert.deepEqual(f.released,[capture.captureId]);await stop(f.buffer);
});

test('unknown planning survives reopening with the exact input and does not recapture physical source',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setPlan(async()=>{throw new DurableWritePlanningError('planning_transport_lost',true);});f.buffer.update('conditional',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
  const original=f.state().operation.input;f.setPlan(undefined);const reopened=await f.reopen();await reopened.flush();
  assert.deepEqual(f.planned[1],original);assert.equal(f.capturesTaken,1);assert.equal(reopened.text,'conditional');assert.equal(reopened.savedText,'conditional');await stop(reopened);
});

test('a persisted plan and retained ref are never recomputed after commit uncertainty or restart',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setCommit(async()=>{throw new Error('commit reply lost');});f.buffer.update('conditional',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
  const original=f.state().operation;assert.ok(original.plan);assert.ok(original.ref);f.buffer.update('newer body');await f.buffer.flushForNavigation().catch(()=>{});
  f.setCommit(undefined);const reopened=await f.reopen();await reopened.flush();
  assert.equal(f.planned.filter(p=>p.conditionalSavedSource).length,1);assert.equal(f.prepared.filter(encoded=>JSON.parse(encoded).conditionalSavedSource).length,1);assert.deepEqual(f.committed.slice(0,2),[original.ref.token,original.ref.token]);assert.equal(reopened.text,'newer body');assert.equal(f.capturesTaken,1);await stop(reopened);
});

test('checkpoint failure forbids conditional planning, while retry preserves its original input and newer draft',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setCheckpoint(async()=>{throw new Error('checkpoint unavailable');});f.buffer.update('conditional',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush(),/checkpoint unavailable/);assert.equal(f.planned.length,0);assert.equal(f.prepared.length,0);
  f.buffer.update('newer draft');f.setCheckpoint(undefined);await f.buffer.flush();assert.equal(f.planned[0].content,'conditional');assert.equal(f.planned[1].content,'newer draft');assert.equal(f.capturesTaken,1);await stop(f.buffer);
});

test('a physical race rejects before logical authorship, preserves newer typing and remains recovery-visible',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.buffer.update('conditional',{conditionalSavedSource:capture});f.buffer.update('newer local typing');f.external('external changed score');
  await assert.rejects(f.buffer.flush(),/draft preserved/);assert.equal(f.current.content,logical);assert.equal(f.current.revision,'r1');assert.equal(f.saved,'external changed score');assert.equal(f.buffer.text,'newer local typing');assert.equal(f.buffer.savedText,logical);assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.state().draft,'newer local typing');assert.equal(f.state().operation,undefined);assert.deepEqual(f.released,[capture.captureId]);
  const reopened=await f.reopen();assert.equal(reopened.hasRecoveryConflict,true);assert.equal(reopened.text,'newer local typing');await assert.rejects(reopened.flush(),/draft preserved/);assert.equal(f.planned.length,1);await stop(f.buffer);await stop(reopened);
});

test('expired unprepared capture is a definite visible conflict, not permission to mint another request',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setPlan(async()=>{throw new DurableWritePlanningError('source_capture_expired',false);});f.buffer.update('conditional',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
  assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.buffer.text,'conditional');assert.equal(f.state().operation,undefined);await assert.rejects(f.buffer.flush(),/draft preserved/);assert.equal(f.planned.length,1);assert.deepEqual(f.released,[capture.captureId]);await stop(f.buffer);
});

test('terminal release failure retains the settled request and retries release without replan or reauthorship',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;let first=true;
  f.setRelease(async()=>{if(first){first=false;throw new Error('release reply lost');}});f.buffer.update('conditional',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush(),/release reply lost/);
  const original=f.state().operation;assert.equal(original.pendingAck.status,'committed');f.buffer.update('newer typing');await f.buffer.flush();
  assert.equal(f.committed.filter(id=>id===original.ref.token).length,1);assert.equal(f.planned.filter(input=>input.conditionalSavedSource).length,1);assert.equal(f.buffer.text,'newer typing');assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'settled');await stop(f.buffer);
});

test('browser providers without the capability retain their existing logical save path',async()=>{
  const f=await fixture();delete f.writes.captureSavedSource;delete f.writes.releaseSavedSource;delete f.writes.listSavedSourceRequests;
  assert.equal(await f.buffer.captureConditionalSavedSource(witness),undefined);f.buffer.update('ordinary browser draft');await f.buffer.flush();assert.equal(f.planned[0].conditionalSavedSource,undefined);assert.equal(f.saved,'ordinary browser draft');await stop(f.buffer);
});

test('typing during an awaited conditional commit retains the newer draft and saves it after the guarded original',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
  f.setCommit(async()=>{if(first){first=false;enter();await gate;}});
  f.buffer.update('guarded original',{conditionalSavedSource:capture});const saving=f.buffer.flush();await entered;
  f.buffer.update('body typed while commit was pending');release();await saving;
  assert.equal(f.planned[0].content,'guarded original');assert.equal(f.planned[1].content,'body typed while commit was pending');assert.equal(f.planned[1].conditionalSavedSource,undefined);
  assert.equal(f.buffer.text,'body typed while commit was pending');assert.equal(f.saved,f.buffer.text);assert.equal(f.buffer.dirty,false);await stop(f.buffer);
});

test('a definite planning rejection with failed release survives reopening without repeating planning',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setPlan(async()=>{throw new DurableWritePlanningError('source_capture_expired',false);});f.setRelease(async()=>{throw new Error('release unavailable');});
  f.buffer.update('retained rejected draft',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush(),/release unavailable/);
  assert.equal(f.state().operation.planningRejected,'source_capture_expired');assert.equal(f.state().conflict,true);
  f.setRelease(undefined);const reopened=await f.reopen();await assert.rejects(reopened.flush(),/draft preserved/);
  assert.equal(f.planned.length,1);assert.equal(f.state().operation,undefined);assert.equal(reopened.text,'retained rejected draft');assert.equal(reopened.hasRecoveryConflict,true);await stop(reopened);
});

test('malformed saved conditional input or an explicit lost plan fails closed before provider calls',async()=>{
  for(const corrupt of [(op:any)=>{op.input.conditionalSavedSource.logicalWitness.revision='other';},(op:any)=>{op.plan=null;}]){
    const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
    f.setPlan(async()=>{throw new Error('planning unavailable');});f.buffer.update('retained original',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
    const checkpoint=f.checkpoints.get('note/v1/entry')!,saved=JSON.parse(checkpoint.encodedState!);corrupt(saved.operation);const encodedState=JSON.stringify(saved);f.checkpoints.set(checkpoint.key,{...checkpoint,encodedState,byteLength:Buffer.byteLength(encodedState)});
    await assert.rejects(f.reopen(),/invalid saved/);assert.equal(f.planned.length,1);assert.equal(f.prepared.length,0);
  }
});

test('an incomplete optional capability fails closed instead of manufacturing a physical capture',async()=>{
  const f=await fixture();delete f.writes.releaseSavedSource;
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness),/capability is incomplete/);assert.equal(f.capturesTaken,0);assert.equal(f.buffer.text,logical);assert.equal(f.planned.length,0);await stop(f.buffer);
});

test('an abandoned capture with an uncertain release is released before acquiring another proof',async()=>{
  const f=await fixture();let valid=true,first=true;const acquire=f.writes.captureSavedSource!;
  f.writes.captureSavedSource=async w=>{const capture=await acquire(w);valid=false;return capture;};
  f.setRelease(async()=>{if(first){first=false;throw new Error('release reply lost');}});
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness,()=>{if(!valid)throw new Error('retired');}),/release reply lost/);
  f.writes.captureSavedSource=acquire;
  const capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  assert.deepEqual(f.released,[f.requestIds[0]]);assert.equal(capture.captureId,f.requestIds[1]);assert.equal(f.captures.size,1);
  await f.buffer.releaseConditionalSavedSource(capture);await stop(f.buffer);
});

test('an unattached capture cannot be attached while its release is in flight',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;let release!:()=>void;
  f.setRelease(()=>new Promise<void>(resolve=>{release=resolve;}));const dropping=f.buffer.releaseConditionalSavedSource(capture);
  assert.throws(()=>f.buffer.update('unsafe',{conditionalSavedSource:capture}),/release is pending/);assert.equal(f.buffer.text,logical);assert.equal(f.planned.length,0);
  release();await dropping;assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'settled');await stop(f.buffer);
});

test('restart preserves a reverted newest draft and its original baseline while a conditional input is retained',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setPlan(async()=>{throw new Error('planning reply lost');});f.buffer.update('conditional original',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
  const original=f.state().operation.input;
  f.buffer.update(logical);await assert.rejects(f.buffer.flush());await f.advanceLogical('Peer committed content');
  const reopened=await f.reopen();assert.equal(reopened.text,logical);assert.equal(reopened.savedText,logical);assert.deepEqual(reopened.savedDurableWitness,witness);assert.equal(reopened.hasRecoveryConflict,true);
  assert.deepEqual(f.state().operation.input,original);assert.equal(f.capturesTaken,1);assert.equal(f.planned.length,2);
  f.setPlan(async()=>{throw new DurableWritePlanningError('revision_conflict',false);});await assert.rejects(reopened.flush());
  assert.deepEqual(f.planned[2],original);assert.equal(reopened.text,logical);assert.equal(reopened.savedText,logical);assert.equal(f.saved,'Peer committed content');await stop(reopened);
});

test('retained conditional input must match its saved baseline before any provider retry',async()=>{
  for(const corrupt of [(op:any)=>{op.input.expectedContent='Invented baseline';},(op:any)=>{op.input.path='Elsewhere.md';op.input.conditionalSavedSource.logicalWitness.path='Elsewhere.md';},(op:any)=>{op.input.expectedRevision='other';op.input.conditionalSavedSource.logicalWitness.revision='other';}]){
    const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
    f.setPlan(async()=>{throw new Error('planning reply lost');});f.buffer.update('retained draft',{conditionalSavedSource:capture});await assert.rejects(f.buffer.flush());
    const checkpoint=f.checkpoints.get('note/v1/entry')!,saved=JSON.parse(checkpoint.encodedState!);corrupt(saved.operation);const encodedState=JSON.stringify(saved);f.checkpoints.set(checkpoint.key,{...checkpoint,encodedState,byteLength:Buffer.byteLength(encodedState)});
    await assert.rejects(f.reopen(),/retained baseline/);assert.equal(f.planned.length,1);assert.equal(f.prepared.length,0);
  }
});

test('successful buffer retirement releases all unattached captures',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  await f.buffer.dispose();assert.deepEqual(f.released,[capture.captureId]);assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'settled');assert.equal(f.captures.size,0);
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness),/disposed/);assert.equal(f.capturesTaken,1);
});

test('buffer retirement joins an already pending release and rejects new capture admission while closing',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;let finish!:()=>void,calls=0,disposed=false;
  f.setRelease(()=>{calls++;return new Promise<void>(resolve=>{finish=resolve;});});
  const releasing=f.buffer.releaseConditionalSavedSource(capture),closing=f.buffer.dispose().then(()=>{disposed=true;});
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness),/closing/);await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(disposed,false);assert.equal(calls,1);finish();await releasing;await closing;assert.equal(disposed,true);assert.equal(calls,1);
});

test('retirement cleanup failure is retryable and cannot leave an unreleased proof behind a successful close',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setRelease(async()=>{throw new Error('release unavailable');});await assert.rejects(f.buffer.dispose(),/release unavailable/);assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'unattached');
  f.setRelease(undefined);await f.buffer.dispose();assert.deepEqual(f.released,[capture.captureId]);assert.equal(f.captures.size,0);
});

test('a capture crossing retirement is abandoned and released before the buffer can close',async()=>{
  const f=await fixture();let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  const acquire=f.writes.captureSavedSource!;f.writes.captureSavedSource=async w=>{const capture=await acquire(w);enter();await gate;return capture;};
  const acquiring=f.buffer.captureConditionalSavedSource(witness);await entered;const closing=f.buffer.dispose();finish();
  await assert.rejects(acquiring,/closing/);await closing;assert.deepEqual(f.released,[f.requestIds[0]]);assert.equal(f.planned.length,0);assert.equal(f.captures.size,0);
});

test('failed retirement does not release a pending conditional guard or lose its original input',async()=>{
  const f=await fixture(),capture=(await f.buffer.captureConditionalSavedSource(witness))!;
  f.setPlan(async()=>{throw new Error('planning reply lost');});f.buffer.update('conditional original',{conditionalSavedSource:capture});await assert.rejects(f.buffer.dispose(),/planning reply lost/);
  const original=f.state().operation.input;assert.deepEqual(f.released,[]);assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'pending');
  f.setPlan(undefined);await f.buffer.dispose();assert.deepEqual(f.planned[1],original);assert.deepEqual(f.released,[capture.captureId]);assert.equal(f.saved,'conditional original');
});

test('retirement retries a release for an abandoned post-validation capture',async()=>{
  const f=await fixture();let valid=true;const acquire=f.writes.captureSavedSource!;f.writes.captureSavedSource=async w=>{const capture=await acquire(w);valid=false;return capture;};
  f.setRelease(async()=>{throw new Error('release reply lost');});await assert.rejects(f.buffer.captureConditionalSavedSource(witness,()=>{if(!valid)throw new Error('retired');}),/release reply lost/);
  f.setRelease(undefined);await f.buffer.dispose();assert.deepEqual(f.released,[f.requestIds[0]]);assert.equal(f.captures.size,0);
});
