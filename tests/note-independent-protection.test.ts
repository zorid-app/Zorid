import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {DurableWrites,DurableWriteRead,DurableWriteInput,DurableWriteIntent} from '../src/core/durable-writes.ts';
import type {Checkpoint,CheckpointChange} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftChange,IndependentDraftRetirement,IndependentDraftRead,IndependentDraftReceipt} from '../src/core/independent-drafts.ts';

function held<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(check());}
const scope={vaultId:'protected-vault',clientId:'same-client'},initial:DurableWriteRead={entryId:'entry',revision:'file-1',path:'One.md',content:'Saved source',stat:{ctime:1,mtime:1,size:12}};
async function fixture(t:TestContext){
  const adapter=new MemoryAdapter({'One.md':initial.content}),heads=new Map<string,Checkpoint>(),drafts=new Map<string,Exclude<IndependentDraftRead,null>>();
  const checkpointCalls:CheckpointChange[]=[],journalCalls:(IndependentDraftChange|IndependentDraftRetirement)[]=[],plans=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>();
  let current=structuredClone(initial),commits=0,journalFail=false,cleanJournalGate:ReturnType<typeof held>|undefined;
  function context(incarnationId:string){
    let active=true,checkpointGate:ReturnType<typeof held>|undefined,afterApply=false;
    const assertLive=()=>{if(!active)throw Object.assign(Error('Old owner retired'),{code:'client_not_admitted',source:'host'});};
    const writes:DurableWrites={
      checkpoints:{scope,load:async key=>structuredClone(heads.get(key)??null),compareAndSwap:async change=>{
        assertLive();checkpointCalls.push(structuredClone(change));
        const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
        if(!uuid(change.nextRevision)||change.expectedRevision!==null&&!uuid(change.expectedRevision))throw Object.assign(Error('Invalid canonical checkpoint request'),{code:'checkpoint_invalid'});
        if(checkpointGate&&!afterApply)await checkpointGate.promise;assertLive();
        const old=heads.get(change.key);if(old?.revision===change.nextRevision&&old.encodedState===change.encodedState)return structuredClone(old);
        if(change.expectedRevision!==(old?.revision??null))throw Object.assign(Error('Canonical revision changed'),{code:'checkpoint_conflict'});
        const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(Number(old?.sequence??0)+1),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'')};heads.set(change.key,row);
        if(checkpointGate&&afterApply)await checkpointGate.promise;assertLive();return structuredClone(row);
      },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
      readText:async()=>{assertLive();return structuredClone(current);},readTextById:async id=>{assertLive();return id===current.entryId?structuredClone(current):null;},
      planWrite:async input=>{assertLive();plans.set(input.operationId,structuredClone(input));return{version:1,...scope,entryId:input.expectedEntryId,operationId:input.operationId,encodedPlan:JSON.stringify(input)};},
      prepare:async plan=>{assertLive();const intent:DurableWriteIntent={ref:{...scope,entryId:plan.entryId,operationId:plan.operationId,token:plan.operationId},state:'prepared',acknowledged:false};intents.set(plan.operationId,intent);return structuredClone(intent);},
      query:async ref=>{assertLive();return structuredClone(intents.get(ref.operationId)??null);},commit:async ref=>{assertLive();commits++;const input=plans.get(ref.operationId)!;assert.equal(input.expectedRevision,current.revision);assert.equal(input.expectedContent,current.content);
        current={...current,content:input.content,revision:`file-${commits+1}`,stat:{...current.stat,size:input.content.length}};await adapter.write('One.md',current.content);
        const intent:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,revision:current.revision,sequence:String(commits)}};intents.set(ref.operationId,intent);return structuredClone(intent);},
      acknowledge:async(ref)=>{assertLive();const intent=intents.get(ref.operationId)!;if(intent.state==='committed'||intent.state==='rejected')intents.set(ref.operationId,{...intent,acknowledged:true});},listUnacknowledged:async()=>[],
      captureSavedSource:async witness=>({captureId:'original-capture',logicalWitness:{...witness},source:current.content}),releaseSavedSource:async()=>{},
    };
    const journalScope={...scope,incarnationId},branch=(entryId:string,writer:string,incarnation=incarnationId)=>`${incarnation}:${entryId}:${writer}`;
    const receipt=(request:IndependentDraftChange|IndependentDraftRetirement,deleted:boolean):IndependentDraftReceipt=>({...journalScope,incarnationId:'incarnationId'in request?request.incarnationId:incarnationId,entryId:request.entryId,writer:request.writer,revision:request.nextRevision,generation:request.generation,deleted});
    const provider:IndependentDraftProvider={scope:journalScope,
      async compareAndSwap(request){if(!active)throw Object.assign(Error('Journal owner retired'),{code:'draft_lease_revoked'});if(journalFail)throw Object.assign(Error('Profile storage unavailable'),{code:'draft_storage_failure'});journalCalls.push(structuredClone(request));const key=branch(request.entryId,request.writer),old=drafts.get(key);
        if(cleanJournalGate&&request.pendingOperation===null&&request.baseline.content===request.draft)await cleanJournalGate.promise;
        if(old?.revision===request.nextRevision){assert.equal('draft'in old?old.draft:undefined,request.draft);return receipt(request,false);}
        assert.equal(request.expectedRevision,old?.revision??null);const saved={...receipt(request,false),deleted:false as const,baseline:structuredClone(request.baseline),draft:request.draft,checkpointRevision:request.checkpointRevision,pendingOperation:request.pendingOperation};drafts.set(key,saved);return receipt(request,false);
      },async retire(request){journalCalls.push(structuredClone(request));const key=branch(request.entryId,request.writer,request.incarnationId),old=drafts.get(key);if(old?.deleted&&old.revision===request.nextRevision)return receipt(request,true);assert.equal(request.expectedRevision,old?.revision);const saved=receipt(request,true);drafts.set(key,{...saved,deleted:true});return saved;},
      async list(options){if(journalFail)throw Object.assign(Error('Profile storage unavailable'),{code:'draft_storage_failure'});return [...drafts.values()].filter(row=>!row.deleted&&(!options||row.entryId===options.entryId)).map(({vaultId,clientId,incarnationId,entryId,writer,revision,generation,deleted})=>({vaultId,clientId,incarnationId,entryId,writer,revision,generation,deleted}));},
      async read(address){return structuredClone(drafts.get(branch(address.entryId,address.writer,address.incarnationId))??null);},
    };
    const owned=Object.create(adapter) as MemoryAdapter&{durableWrites:DurableWrites;independentDrafts:IndependentDraftProvider};owned.durableWrites=writes;owned.independentDrafts=provider;
    return{writes,provider,owned,holdCheckpoint(applied=false){afterApply=applied;return checkpointGate=held();},clearCheckpoint(){checkpointGate=undefined;},retire(){active=false;}};
  }
  const first=context('first-renderer'),vault=new Vault(first.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});await buffer.load('entry');
  t.after(()=>buffer.closeMetadataProjection());
  return{first,buffer,vault,heads,drafts,checkpointCalls,journalCalls,context,holdCleanJournal(){return cleanJournalGate=held();},failJournal(fail=true){journalFail=fail;},get current(){return current;},get commits(){return commits;}};
}

test('accepted later typing is journal-protected while the canonical Rust checkpoint remains held',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First draft');await until(()=>f.checkpointCalls.length===1);
  f.buffer.update('Later draft survives Rust');await (f.buffer as any).flushDraftProtection();
  const candidates=[...f.drafts.values()].filter(row=>!row.deleted);assert.equal(candidates.length,1);assert.equal((candidates[0] as any).draft,'Later draft survives Rust');
  assert.equal(f.heads.size,0);assert.equal(f.current.content,'Saved source');assert.equal(f.buffer.dirty,true);assert.equal(f.commits,0);
  gate.resolve();await f.buffer.dispose();
});

test('a new renderer reconciles the exact held checkpoint before recovering later protected typing',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('Checkpointed first draft');await until(()=>f.checkpointCalls.length===1);
  f.buffer.update('Protected later RAM draft');await (f.buffer as any).flushDraftProtection();
  const original=structuredClone(f.checkpointCalls[0]);await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('replacement-renderer'),vault=new Vault(next.owned);await vault.initialize();const reopened=new NoteBuffer(vault,'One.md',{debounceMs:60000});
  t.after(()=>reopened.closeMetadataProjection());await reopened.load('entry');
  assert.equal(reopened.text,'Protected later RAM draft');assert.equal(reopened.savedText,'Saved source');assert.equal(reopened.dirty,true);assert.equal(f.commits,0);
  assert.deepEqual(f.checkpointCalls[1],original,'recovery must reuse the exact old expected/next revision and bytes before any later CAS');
  gate.resolve();await reopened.dispose();assert.equal([...f.drafts.values()].filter(row=>!row.deleted).length,0,'known-clean source and current branches both retire after real current journal acknowledgement');
});

test('a committed checkpoint with a lost ACK is reconciled under the same original request',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint(true);f.buffer.update('Storage already admitted first draft');await until(()=>f.heads.size===1);
  f.buffer.update('Later independent draft');await f.buffer.flushDraftProtection();const original=structuredClone(f.checkpointCalls[0]);
  await f.buffer.closeMetadataProjection();f.first.retire();const next=f.context('replacement-lost-ack'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,'Later independent draft');assert.deepEqual(f.checkpointCalls[1],original);assert.equal(f.commits,0);gate.resolve();await buffer.dispose();
});

test('a foreign canonical advance prevents journal candidate adoption or checkpoint replay',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('Protected pending draft');await until(()=>f.checkpointCalls.length===1);await f.buffer.flushDraftProtection();
  const foreign={version:1,writer:'foreign-canonical-lineage',generation:7,base:initial,draft:'Canonical writer draft retained',conflict:false};
  const encodedForeign=JSON.stringify(foreign);
  f.heads.set('note/v1/entry',{version:1,...scope,key:'note/v1/entry',revision:crypto.randomUUID(),sequence:'2',deleted:false,byteLength:Buffer.byteLength(encodedForeign),encodedState:encodedForeign});
  await f.buffer.closeMetadataProjection();f.first.retire();const next=f.context('foreign-guard'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,foreign.draft);assert.equal(buffer.draftProtectionStatus?.inventory,'retained');assert.equal(f.checkpointCalls.length,1);assert.equal(f.commits,0);
  assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.draft==='Protected pending draft'));gate.resolve();await buffer.dispose();
});

test('an unresolved conditional operation is captured exactly and never auto-adopted as an ordinary draft',async t=>{
  const f=await fixture(t),capture=(await f.buffer.captureConditionalSavedSource({entryId:'entry',revision:'file-1',path:'One.md'}))!,gate=f.first.holdCheckpoint();
  f.buffer.update('Conditional submitted text',{conditionalSavedSource:capture});await until(()=>f.checkpointCalls.length===1);f.buffer.update('Later ordinary typing');await f.buffer.flushDraftProtection();
  const candidate=[...f.drafts.values()].find(row=>!row.deleted)!;assert.equal(candidate.deleted,false);const capsule=JSON.parse(candidate.pendingOperation!);
  assert.equal(capsule.operation.input.content,'Conditional submitted text');assert.equal(capsule.operation.input.conditionalSavedSource.captureId,capture.captureId);assert.equal(capsule.operation.content,'Conditional submitted text');
  assert.equal(capsule.checkpoint.encodedState,f.checkpointCalls[0].encodedState);assert.equal(candidate.draft,'Later ordinary typing');
  await f.buffer.closeMetadataProjection();f.first.retire();const next=f.context('conditional-retained'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,initial.content);assert.equal(buffer.draftProtectionStatus?.inventory,'retained');assert.equal(f.checkpointCalls.length,1);assert.equal(f.commits,0);gate.resolve();await buffer.dispose();
});

test('competing protected lineages remain retained instead of choosing one or creating replay identities',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First protected candidate');await until(()=>f.checkpointCalls.length===1);await f.buffer.flushDraftProtection();
  const first=[...f.drafts.values()].find(row=>!row.deleted)!;f.drafts.set('different-renderer:entry:competing-writer',{...structuredClone(first),incarnationId:'different-renderer',writer:'competing-writer',draft:'Competing candidate'} as any);
  await f.buffer.closeMetadataProjection();f.first.retire();const next=f.context('competition-guard'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,initial.content);assert.equal(buffer.draftProtectionStatus?.inventory,'retained');assert.equal(f.checkpointCalls.length,1);assert.equal(f.commits,0);gate.resolve();await buffer.dispose();
});

test('unchanged deliveries create no redundant independent offers and accepted edit capture never serializes bodies',async t=>{
  const f=await fixture(t),original=JSON.stringify;
  try{JSON.stringify=()=>{throw Error('No JSON on accepted edit stack');};f.buffer.update('New accepted body');}finally{JSON.stringify=original;}
  await f.buffer.flushDraftProtection();await until(()=>f.heads.size===1);await f.buffer.flushDraftProtection();
  const calls=f.journalCalls.length,sequence=f.buffer.draftProtectionStatus!.sequence;
  f.buffer.update('New accepted body');await f.buffer.flushDraftProtection();assert.equal(f.buffer.draftProtectionStatus!.sequence,sequence);assert.equal(f.journalCalls.length,calls);await f.buffer.dispose();
});

test('journal failure stays separate from core saving and exact clean core coverage permits normal close',async t=>{
  const f=await fixture(t);f.failJournal();f.buffer.update('Saved despite journal storage failure');await assert.rejects(f.buffer.flushDraftProtection(),{code:'draft_storage_failure'});
  assert.equal(f.buffer.error,null);assert.equal(f.buffer.dirty,true);await f.buffer.dispose();
  assert.equal(f.current.content,'Saved despite journal storage failure');assert.equal(f.buffer.dirty,false);assert.equal(f.buffer.error,null);assert.equal(f.buffer.draftProtectionStatus?.retryPending,false);
});

test('close waits for the final canonical clean journal phase rather than only its earlier raw snapshot',async t=>{
  const f=await fixture(t),gate=f.holdCleanJournal();f.buffer.update('Closing exact body');await f.buffer.flushDraftProtection();
  let closed=false;const closing=f.buffer.dispose().then(()=>{closed=true;});await until(()=>f.current.content==='Closing exact body');
  await until(()=>f.journalCalls.some(row=>'baseline'in row&&row.baseline.content===row.draft&&row.pendingOperation===null));
  assert.equal(closed,false);gate.resolve();await closing;assert.equal(closed,true);assert.equal([...f.drafts.values()].filter(row=>!row.deleted).length,0);
});

test('late inventory availability recovers a pure checkpoint capsule without capturing the placeholder writer',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First old-frame draft');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Recovered after profile becomes available');await f.buffer.flushDraftProtection();
  await f.buffer.closeMetadataProjection();f.first.retire();f.failJournal();const next=f.context('late-profile-recovery'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,initial.content);assert.equal(buffer.draftProtectionStatus?.inventory,'unknown');
  f.failJournal(false);buffer.draftProtectionAvailable();await until(()=>buffer.text==='Recovered after profile becomes available');
  await buffer.flushDraftProtection();assert.equal(buffer.draftProtectionStatus?.error,null);assert.equal(buffer.draftProtectionStatus?.currentJournalAcknowledged,true);
  buffer.update('Later editing on recovered lineage');await buffer.flushDraftProtection();assert.equal(buffer.draftProtectionStatus?.error,null);
  gate.resolve();await buffer.dispose();
});

test('malformed canonical revision in a candidate stays retained without poisoning new core checkpoints',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('Retained raw candidate');await until(()=>f.checkpointCalls.length===1);await f.buffer.flushDraftProtection();
  const candidate=[...f.drafts.values()].find(row=>!row.deleted)!;const capsule=JSON.parse(candidate.pendingOperation!);capsule.checkpoint.nextRevision='not-a-uuid';(candidate as any).pendingOperation=JSON.stringify(capsule);
  await f.buffer.closeMetadataProjection();f.first.retire();const next=f.context('malformed-candidate'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,initial.content);assert.equal(f.checkpointCalls.length,1,'malformed candidate must never reach canonical transport');
  buffer.update('Fresh accepted edit');await buffer.flush();assert.equal(f.current.content,'Fresh accepted edit');assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.draft==='Retained raw candidate'));
  gate.resolve();await buffer.dispose();
});

test('a failed own tombstone read keeps inventory unknown and an explicit barrier rejoins its replacement helper',async t=>{
  const f=await fixture(t);f.buffer.update('First saved generation');await f.buffer.dispose();const tombstone=[...f.drafts.values()].find(row=>row.deleted)!;
  const read=f.first.provider.read;let unread=true;f.first.provider.read=async address=>{if(unread)throw Object.assign(Error('Temporary head read failure'),{code:'draft_storage_failure'});return read(address);};
  const buffer=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  assert.equal(buffer.draftProtectionStatus?.inventory,'unknown');assert.equal((buffer.draftProtectionStatus?.inventoryError as any)?.code,'draft_storage_failure');
  buffer.update('New generation after head read heals');unread=false;await buffer.flushDraftProtection();
  assert.equal(buffer.draftProtectionStatus?.currentJournalAcknowledged,true);assert.equal(buffer.draftProtectionStatus?.error,null);
  assert.ok(f.journalCalls.some(row=>'baseline'in row&&row.draft==='New generation after head read heals'&&row.expectedRevision===tombstone.revision));await buffer.dispose();
});

test('availability never overlays an unread old draft after this renderer accepts new typing',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('Old protected candidate');await until(()=>f.checkpointCalls.length===1);await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  f.failJournal();const next=f.context('edited-before-inventory'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  buffer.update('Current renderer accepted typing');f.failJournal(false);await buffer.flushDraftProtection();assert.equal(buffer.text,'Current renderer accepted typing');assert.equal(buffer.draftProtectionStatus?.inventory,'retained');
  assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.draft==='Old protected candidate'));gate.resolve();await buffer.dispose();
});

test('older clean Core coverage cannot waive protection failure or report a blocked newer close complete',async t=>{
  const f=await fixture(t);f.buffer.update('Confirmed first generation');await f.buffer.flush();await f.buffer.flushDraftProtection();
  const gate=f.first.holdCheckpoint();f.failJournal();f.buffer.update('Unconfirmed newer generation');await until(()=>f.checkpointCalls.some(row=>row.encodedState?.includes('Unconfirmed newer generation')));
  let closed=false;const closing=f.buffer.dispose().then(()=>{closed=true;}),rejected=assert.rejects(closing,/Core checkpoint still blocked/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(f.current.content,'Confirmed first generation');assert.equal(f.buffer.dirty,true);
  gate.reject(Error('Core checkpoint still blocked'));await rejected;assert.equal(closed,false);assert.equal(f.buffer.dirty,true);
  f.first.clearCheckpoint();f.failJournal(false);await f.buffer.flushDraftProtection();await f.buffer.dispose();assert.equal(f.current.content,'Unconfirmed newer generation');
});

test('a newer generation never authorizes deleting an older prior-incarnation candidate by timestamp',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First checkpoint draft');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Second protected candidate');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('newer-than-source'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  buffer.update('Third accepted generation');gate.resolve();await buffer.dispose();assert.equal(f.current.content,'Third accepted generation');
  assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.incarnationId==='first-renderer'&&row.draft==='Second protected candidate'));
  assert.equal(f.journalCalls.filter(row=>'incarnationId'in row&&row.incarnationId==='first-renderer').length,0);
});

test('opening a fresh clean note creates no independent body copy or retirement',async t=>{
  const f=await fixture(t);await f.buffer.flushDraftProtection();assert.equal(f.journalCalls.length,0);assert.equal(f.buffer.draftProtectionStatus?.sequence,0);assert.equal(f.buffer.dirty,false);await f.buffer.dispose();assert.equal(f.journalCalls.length,0,'clean metadata-only checkpoint on close needs no redundant body journal');
});

test('a lost acknowledgement of the recovery CAS retries exactly instead of adopting an empty placeholder',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First pending checkpoint');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Later protected recovery body');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('recovery-ack-loss'),cas=next.writes.checkpoints.compareAndSwap;let lose=true;
  next.writes.checkpoints.compareAndSwap=async change=>{const result=await cas(change);if(lose){lose=false;throw Object.assign(Error('Recovery acknowledgement lost'),{code:'outcome_unknown',commitUncertain:true});}return result;};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  assert.equal(buffer.text,'Later protected recovery body');await until(()=>f.checkpointCalls.length>=2);await new Promise(resolve=>setImmediate(resolve));assert.equal(buffer.error,null);assert.equal(buffer.pendingCanonicalRecovery,true);
  t.mock.timers.tick(500);await until(()=>!buffer.pendingCanonicalRecovery);assert.deepEqual(f.checkpointCalls[1],f.checkpointCalls[0]);assert.deepEqual(f.checkpointCalls[2],f.checkpointCalls[0]);assert.equal(f.commits,0);gate.resolve();await buffer.dispose();
});

test('repeated recovery ACK loss keeps validated D2 editable and protects D3 before any Core save',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First canonical proposal');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Latest raw draft');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('repeated-recovery-loss'),cas=next.writes.checkpoints.compareAndSwap;let lose=2;
  next.writes.checkpoints.compareAndSwap=async change=>{const result=await cas(change);if(lose-->0)throw Object.assign(Error('Repeated recovery ACK loss'),{code:'outcome_unknown',commitUncertain:true});return result;};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,'Latest raw draft');assert.equal(buffer.error,null);assert.equal(buffer.pendingCanonicalRecovery,true);assert.equal(f.current.content,initial.content);
  buffer.update('D3 remains independently protected');await buffer.flushDraftProtection();assert.equal(f.current.content,initial.content);assert.equal(f.commits,0);
  assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.draft==='D3 remains independently protected'));
  await until(()=>f.checkpointCalls.length>=2);await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(500);
  await until(()=>f.checkpointCalls.length>=3);await new Promise(resolve=>setImmediate(resolve));assert.equal(buffer.error,null);t.mock.timers.tick(1500);await until(()=>!buffer.pendingCanonicalRecovery);
  assert.equal(buffer.text,'D3 remains independently protected');
  const original=f.checkpointCalls[0];for(const call of f.checkpointCalls.filter(call=>call.nextRevision===original.nextRevision))assert.deepEqual(call,original);
  gate.resolve();await buffer.dispose();assert.equal(f.current.content,'D3 remains independently protected');
});

test('later availability resumes a failed candidate CAS without seeding the placeholder lineage',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),oldGate=f.first.holdCheckpoint();f.buffer.update('First old checkpoint');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Protected latest across availability');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  f.failJournal();const next=f.context('late-cas-retry'),cas=next.writes.checkpoints.compareAndSwap;let lose=2;
  next.writes.checkpoints.compareAndSwap=async change=>{const result=await cas(change);if(lose-->0)throw Object.assign(Error('Late recovery ACK unavailable'),{code:'outcome_unknown',commitUncertain:true});return result;};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  f.failJournal(false);buffer.draftProtectionAvailable();await until(()=>buffer.text==='Protected latest across availability');assert.equal(buffer.error,null);
  await until(()=>f.checkpointCalls.length>=2);await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(500);
  await until(()=>f.checkpointCalls.length>=3);await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1500);await until(()=>!buffer.pendingCanonicalRecovery);
  await buffer.flushDraftProtection();assert.equal(buffer.draftProtectionStatus?.error,null);
  oldGate.resolve();await buffer.dispose();
});

test('typing during late candidate reconciliation survives its older CAS receipt and is never overlaid',async t=>{
  const f=await fixture(t),oldGate=f.first.holdCheckpoint();f.buffer.update('Older checkpoint input');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Older protected raw candidate');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  f.failJournal();const next=f.context('typed-during-adoption'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  const replay=next.holdCheckpoint();f.failJournal(false);buffer.draftProtectionAvailable();await until(()=>f.checkpointCalls.length===2);
  buffer.update('Accepted while old checkpoint reply waits');replay.resolve();await buffer.flushDraftProtection();
  assert.equal(buffer.text,'Accepted while old checkpoint reply waits');assert.equal(buffer.draftProtectionStatus?.inventory,'ready');assert.equal(f.commits,0);
  assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.draft==='Older protected raw candidate'));oldGate.resolve();await buffer.dispose();
});

test('a protocol or terminal Core error is not promoted to an automatic reconciliation retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First proposal');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Latest candidate');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('protocol-reconciliation'),cas=next.writes.checkpoints.compareAndSwap;let invalid=true;
  next.writes.checkpoints.compareAndSwap=async change=>{const result=await cas(change);if(invalid)throw Object.assign(Error('Untrusted Core reply'),{code:'outcome_unknown',commitUncertain:true,source:'protocol'});return result;};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');await until(()=>!!buffer.error);assert.equal((buffer.error as any).code,'outcome_unknown');assert.equal(buffer.pendingCanonicalRecovery,false);assert.equal(f.checkpointCalls.length,2);
  buffer.update('Raw typing remains protected but planning stays blocked');await buffer.flushDraftProtection();assert.equal(f.checkpointCalls.length,2);assert.equal(f.commits,0);
  buffer.draftProtectionAvailable();await new Promise(resolve=>setImmediate(resolve));assert.equal(buffer.pendingCanonicalRecovery,false);assert.equal(f.checkpointCalls.length,2);
  t.mock.timers.tick(120000);await new Promise(resolve=>setImmediate(resolve));assert.equal(buffer.autosaveRetryPending,false);assert.equal(f.checkpointCalls.length,2);assert.equal(buffer.pendingCanonicalRecovery,false);
  invalid=false;gate.resolve();await buffer.dispose();assert.equal(f.current.content,'Raw typing remains protected but planning stays blocked');
});

for(const [code,retry] of [['storage_busy',true],['storage_io_retryable',true],['checkpoint_storage',false],['storage_io',false],['filesystem_io',false],['corrupt_storage',false]] as const)test(`candidate replay ${code} respects the typed native retry contract`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),oldGate=f.first.holdCheckpoint();f.buffer.update('Older exact S1');await until(()=>f.checkpointCalls.length===1);
  f.buffer.update('Protected D2');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const original=structuredClone(f.checkpointCalls[0]),next=f.context('typed-native-retry'),cas=next.writes.checkpoints.compareAndSwap;
  let failing=true,attempts=0;const requests:CheckpointChange[]=[];
  next.writes.checkpoints.compareAndSwap=async change=>{attempts++;requests.push(structuredClone(change));if(failing)throw Object.assign(Error('Native checkpoint unavailable'),{code,source:'host',commitUncertain:true});return cas(change);};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');await until(()=>attempts===1);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(buffer.text,'Protected D2');assert.equal(buffer.pendingCanonicalRecovery,retry);
  buffer.update('D3 protected during native fault');await buffer.flushDraftProtection();
  if(retry){
    assert.equal(buffer.error,null);t.mock.timers.tick(499);await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
    failing=false;t.mock.timers.tick(1);await until(()=>!buffer.pendingCanonicalRecovery);assert.deepEqual(requests[0],original);assert.deepEqual(requests[1],original);
  }else{
    await until(()=>!!buffer.error);buffer.draftProtectionAvailable();t.mock.timers.tick(120000);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(attempts,1);assert.equal(buffer.pendingCanonicalRecovery,false);assert.equal(f.commits,0);failing=false;
  }
  oldGate.resolve();await buffer.dispose();assert.equal(f.current.content,'D3 protected during native fault');
});

test('a held pure replay leaves D2 usable and D3 journal acknowledgement independent from the Core tail',async t=>{
  const f=await fixture(t),oldGate=f.first.holdCheckpoint();f.buffer.update('Older S1');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Protected D2');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('held-replay'),replay=next.holdCheckpoint(),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  assert.equal(buffer.text,'Protected D2');assert.equal(buffer.pendingCanonicalRecovery,true);assert.equal(buffer.error,null);
  buffer.update('D3 while S1 remains held');await buffer.flushDraftProtection();assert.equal(f.commits,0);assert.equal(f.current.content,initial.content);
  const captured=[...f.drafts.values()].find(row=>!row.deleted&&row.incarnationId==='held-replay')!;assert.equal(captured.draft,'D3 while S1 remains held');
  const capsule=JSON.parse(captured.pendingOperation!);assert.deepEqual(capsule.checkpoint,f.checkpointCalls[0]);assert.equal(captured.checkpointRevision,f.checkpointCalls[0].expectedRevision);
  let saved=false;const saving=buffer.flush().then(()=>{saved=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(saved,false);assert.equal(f.commits,0);
  replay.resolve();await saving;assert.equal(f.current.content,'D3 while S1 remains held');assert.equal(buffer.pendingCanonicalRecovery,false);oldGate.resolve();await buffer.dispose();
});

test('typed host retirement waits for ordinary admission repair instead of polling or claiming a new lease',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),oldGate=f.first.holdCheckpoint();f.buffer.update('Older S1');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Protected D2');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('ordinary-admission-repair'),cas=next.writes.checkpoints.compareAndSwap;let dead=true,attempts=0;
  next.writes.checkpoints.compareAndSwap=async change=>{attempts++;if(dead)throw Object.assign(Error('Host retired'),{code:'host_exited',source:'host',commitUncertain:true});return cas(change);};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');await until(()=>attempts===1);
  buffer.update('D3 during ordinary admission repair');await buffer.flushDraftProtection();await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(120000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(attempts,1);assert.equal(buffer.error,null);assert.equal(buffer.pendingCanonicalRecovery,true);assert.equal(f.commits,0);
  dead=false;buffer.draftProtectionAvailable();await until(()=>!buffer.pendingCanonicalRecovery);await until(()=>f.commits===1);assert.equal(f.current.content,'D3 during ordinary admission repair');oldGate.resolve();await buffer.dispose();
});

test('lost prior-candidate retirement ACK preserves and retries its exact original receipt-derived request',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First proposal');await until(()=>f.checkpointCalls.length===1);f.buffer.update('Second protected candidate');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const next=f.context('source-cleanup-retry'),retire=next.provider.retire,requests:IndependentDraftRetirement[]=[];let lose=true;
  next.provider.retire=async request=>{const result=await retire(request);if(request.incarnationId==='first-renderer'){requests.push(structuredClone(request));if(lose){lose=false;throw Object.assign(Error('Prior cleanup ACK lost'),{code:'draft_transport_lost',commitUncertain:true});}}return result;};
  const vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');gate.resolve();
  await buffer.flush();await buffer.flushDraftProtection();assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);assert.equal([...f.drafts.values()].filter(row=>!row.deleted).length,0);await buffer.dispose();
});

async function historicalFixture(t:TestContext){
  const f=await fixture(t),oldGate=f.first.holdCheckpoint();f.buffer.update('D1 older checkpoint');await until(()=>f.checkpointCalls.length===1);f.buffer.update('D2 historical raw branch');await f.buffer.flushDraftProtection();await f.buffer.closeMetadataProjection();f.first.retire();
  const middle=f.context('middle-renderer'),vault=new Vault(middle.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  buffer.update('D3 confirmed source');await buffer.flush();await buffer.flushDraftProtection();assert.equal(f.current.content,'D3 confirmed source');
  const gate=middle.holdCheckpoint();buffer.update('D4 current eligible draft');await until(()=>f.checkpointCalls.some(call=>call.encodedState?.includes('D4 current eligible draft')));await buffer.flushDraftProtection();
  await buffer.closeMetadataProjection();middle.retire();
  return Object.assign(f,{middle,oldGate,gate});
}

test('a single causally eligible D4 restores while older same-writer D2 bytes remain retained',async t=>{
  const f=await historicalFixture(t),next=f.context('history-filtered'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());
  await buffer.load('entry');assert.equal(buffer.text,'D4 current eligible draft');assert.equal(buffer.savedText,'D3 confirmed source');assert.equal(buffer.draftProtectionStatus?.inventory,'ready');
  assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.incarnationId==='first-renderer'&&row.draft==='D2 historical raw branch'));
  f.oldGate.resolve();f.gate.resolve();await buffer.dispose();assert.ok([...f.drafts.values()].some(row=>!row.deleted&&row.draft==='D2 historical raw branch'));
});

test('multiple eligible same-writer branches never gain a winner from generation or timestamps',async t=>{
  const f=await historicalFixture(t),current=[...f.drafts.values()].find(row=>!row.deleted&&row.incarnationId==='middle-renderer')!;
  f.drafts.set(`equally-current:entry:${current.writer}`,{...structuredClone(current),incarnationId:'equally-current'});
  const calls=f.checkpointCalls.length,next=f.context('ambiguous-current'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  assert.equal(buffer.text,'D3 confirmed source');assert.equal(buffer.draftProtectionStatus?.inventory,'retained');assert.equal(f.checkpointCalls.length,calls);f.oldGate.resolve();f.gate.resolve();await buffer.dispose();
});

test('an unresolved historical source operation cannot be waived to select a newer raw branch',async t=>{
  const f=await historicalFixture(t),historical=[...f.drafts.values()].find(row=>!row.deleted&&row.incarnationId==='first-renderer')!;
  const capsule=JSON.parse(historical.pendingOperation!);capsule.operation={content:'Unknown conditional operation'};(historical as any).pendingOperation=JSON.stringify(capsule);
  const next=f.context('unknown-history-op'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  assert.equal(buffer.text,'D3 confirmed source');assert.equal(buffer.draftProtectionStatus?.inventory,'retained');f.oldGate.resolve();f.gate.resolve();await buffer.dispose();
});

test('multiple both-null same-writer candidates remain ambiguous even with matching bytes',async t=>{
  const f=await fixture(t),gate=f.first.holdCheckpoint();f.buffer.update('First S1');await until(()=>f.checkpointCalls.length===1);f.buffer.update('D2 raw candidate');await f.buffer.flushDraftProtection();
  const first=[...f.drafts.values()].find(row=>!row.deleted)!;f.drafts.set(`equally-unknown:entry:${first.writer}`,{...structuredClone(first),incarnationId:'equally-unknown'});await f.buffer.closeMetadataProjection();f.first.retire();
  const calls=f.checkpointCalls.length,next=f.context('ambiguous-null'),vault=new Vault(next.owned);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});t.after(()=>buffer.closeMetadataProjection());await buffer.load('entry');
  assert.equal(buffer.text,initial.content);assert.equal(buffer.draftProtectionStatus?.inventory,'retained');assert.equal(f.checkpointCalls.length,calls);gate.resolve();await buffer.dispose();
});
