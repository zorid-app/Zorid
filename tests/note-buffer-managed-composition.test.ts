import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {DurableWrites,DurableWriteRead,DurableWritePlan,DurableWriteInput,DurableWriteIntent} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';

const oldHeader='---\n_id: entry\n_type: Books\nStatus: Todo\n---\n';
const newHeader='---\n_id: entry\n_type: Books\nStatus: Done\n---\n';
const original=oldHeader+'Original body';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}

/** Native-side fixtures return a declared projection. This test exercises actual
 * NoteBuffer checkpoints, exact intent replay and committed read reconciliation;
 * native parsing/authority rules are tested at their Rust ownership boundary. */
async function fixture(){
  const scope={vaultId:'authority',clientId:'client'},checkpoints=new Map<string,Checkpoint>();
  const plans:{plan:DurableWritePlan;input:DurableWriteInput}[]=[],intents=new Map<string,DurableWriteIntent>();
  const adapter=new MemoryAdapter({'One.md':original}) as MemoryAdapter&{durableWrites:DurableWrites};
  let current:DurableWriteRead={entryId:'entry',revision:'r1',path:'One.md',content:original,stat:{ctime:1,mtime:1,size:original.length}};
  let commits=0,acks=0,composes=0,sequence=1,failCommit=false,failAck=false;
  let commitGate:Promise<void>|undefined,commitStarted:(()=>void)|undefined,composeGate:Promise<void>|undefined,composeStarted:(()=>void)|undefined;
  let tamperCommitted=false;
  const writes:DurableWrites={
    checkpoints:{scope,load:async key=>structuredClone(checkpoints.get(key)??null),compareAndSwap:async change=>{
      const old=checkpoints.get(change.key);
      if(old?.revision===change.nextRevision&&old.encodedState===change.encodedState)return structuredClone(old);
      assert.equal(change.expectedRevision,old?.revision??null);
      const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(Number(old?.sequence??'0')+1),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'')};
      checkpoints.set(change.key,row);return structuredClone(row);
    },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    readText:async()=>structuredClone(current),readTextById:async id=>id==='entry'?structuredClone(current):null,
    composeNote:async input=>{
      composes++;const captured=structuredClone(current);composeStarted?.();if(composeGate)await composeGate;
      return{current:captured,content:input.proposed.replace(oldHeader,newHeader)};
    },
    planWrite:async input=>{
      assert.ok(plans.length<3,'canonical reconciliation must not enter an automatic save loop');
      const content=input.content.replace(oldHeader,newHeader);
      const plan:DurableWritePlan={version:1,...scope,operationId:input.operationId,entryId:'entry',encodedPlan:JSON.stringify({content}),canonicalContent:content};
      plans.push({plan,input:structuredClone(input)});return structuredClone(plan);
    },
    prepare:async plan=>{
      const old=intents.get(plan.operationId);if(old)return structuredClone(old);
      const intent:DurableWriteIntent={state:'prepared',acknowledged:false,ref:{...scope,entryId:'entry',operationId:plan.operationId,token:plan.operationId}};
      intents.set(plan.operationId,intent);return structuredClone(intent);
    },
    query:async ref=>structuredClone(intents.get(ref.token)??null),
    commit:async ref=>{
      const old=intents.get(ref.token)!;if(old.state==='committed'||old.state==='rejected')return structuredClone(old);
      commitStarted?.();if(commitGate){const gate=commitGate;commitGate=undefined;await gate;}
      const held=plans.find(row=>row.plan.operationId===ref.operationId)!;
      commits++;sequence++;current={...current,revision:'r'+sequence,content:tamperCommitted?'Unexpected committed body':held.plan.canonicalContent!};
      current.stat={...current.stat,mtime:sequence,size:Buffer.byteLength(current.content)};
      await adapter.write(current.path,current.content);
      const outcome:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,sequence:String(sequence),entryId:'entry',revision:current.revision}};
      intents.set(ref.token,outcome);
      if(failCommit){failCommit=false;throw new Error('commit reply lost');}
      return structuredClone(outcome);
    },
    listUnacknowledged:async()=>[],
    acknowledge:async ref=>{
      acks++;if(failAck){failAck=false;throw new Error('ack reply lost');}
      const value=intents.get(ref.token)!;
      if(value.state==='committed'||value.state==='rejected')intents.set(ref.token,{...value,acknowledged:true});
    },
  };
  adapter.durableWrites=writes;const vault=new Vault(adapter);await vault.initialize();
  const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60_000});await buffer.load('entry');
  return{adapter,vault,buffer,writes,plans,get current(){return current;},get commits(){return commits;},get acks(){return acks;},get composes(){return composes;},state:()=>JSON.parse(checkpoints.get('note/v1/entry')!.encodedState!),
    holdCommit(){const started=deferred(),release=deferred();commitStarted=started.resolve;commitGate=release.promise;return{started:started.promise,release:release.resolve};},
    holdCompose(){const started=deferred(),release=deferred();composeStarted=started.resolve;composeGate=release.promise;return{started:started.promise,release:release.resolve};},
    loseCommitReply(){failCommit=true;},loseAckReply(){failAck=true;},tamper(){tamperCommitted=true;},
    async project(){sequence++;current={...current,revision:'r'+sequence,content:newHeader+'Original body'};current.stat={...current.stat,mtime:sequence,size:Buffer.byteLength(current.content)};await adapter.write(current.path,current.content);},
    async reopen(){const reopened=new NoteBuffer(vault,'One.md',{debounceMs:60_000});await reopened.load('entry');return reopened;}};
}
async function stop(buffer:NoteBuffer){await buffer.dispose().catch(()=>{});}

test('committed canonical properties replace the submitted generation without a second save',async()=>{
  const f=await fixture();f.buffer.update(oldHeader+'Editor body');await f.buffer.flush();
  assert.equal(f.current.content,newHeader+'Editor body');assert.equal(f.buffer.text,f.current.content);assert.equal(f.buffer.savedText,f.current.content);
  assert.equal(f.buffer.dirty,false);assert.equal(f.plans.length,1);assert.equal(f.commits,1);assert.equal(f.state().operation,undefined);await stop(f.buffer);
});

test('body typing during managed canonical commit survives and saves once against the canonical header',async()=>{
  const f=await fixture(),gate=f.holdCommit();f.buffer.update(oldHeader+'Submitted body');const saving=f.buffer.flush();await gate.started;
  f.buffer.update(oldHeader+'Body typed during write');gate.release();await saving;
  assert.equal(f.plans.length,2);assert.equal(f.plans[1].input.expectedContent,newHeader+'Submitted body');
  assert.equal(f.plans[1].input.content,newHeader+'Body typed during write');
  assert.equal(f.buffer.text,newHeader+'Body typed during write');assert.equal(f.buffer.savedText,f.buffer.text);assert.equal(f.buffer.dirty,false);await stop(f.buffer);
});

test('concurrent frontmatter typing is retained as a conflict instead of guessed during canonical reconciliation',async()=>{
  const f=await fixture(),gate=f.holdCommit();f.buffer.update(oldHeader+'Submitted body');const saving=f.buffer.flush();await gate.started;
  const typed=oldHeader.replace('Status: Todo','Status: My draft')+'Body typed during write';f.buffer.update(typed);gate.release();await assert.rejects(saving,/draft preserved/);
  assert.equal(f.buffer.text,typed);assert.equal(f.buffer.savedText,newHeader+'Submitted body');assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.plans.length,1);
  assert.equal(f.state().draft,typed);const reopened=await f.reopen();assert.equal(reopened.text,typed);assert.equal(reopened.hasRecoveryConflict,true);await stop(f.buffer);await stop(reopened);
});

test('lost commit acknowledgment reuses the persisted canonical plan rather than recomposing or reauthoring',async()=>{
  const f=await fixture();f.loseCommitReply();f.buffer.update(oldHeader+'Exact submitted body');await assert.rejects(f.buffer.flush());
  const held=f.state().operation;assert.equal(held.plan.canonicalContent,newHeader+'Exact submitted body');
  f.buffer.update(oldHeader+'Newer body after lost reply');await f.buffer.flush();
  assert.equal(f.commits,2);assert.equal(f.plans.length,2);assert.equal(f.plans[0].plan.operationId,held.ref.operationId);
  assert.equal(f.buffer.text,newHeader+'Newer body after lost reply');assert.equal(f.buffer.dirty,false);await stop(f.buffer);
});

test('reopen settles a lost canonical commit from the original checkpoint without another plan',async()=>{
  const f=await fixture();f.loseCommitReply();f.buffer.update(oldHeader+'Retained across restart');await assert.rejects(f.buffer.flush());
  const retained=f.state().operation.plan;const reopened=await f.reopen();
  assert.equal(reopened.text,newHeader+'Retained across restart');assert.equal(reopened.savedText,reopened.text);assert.equal(reopened.dirty,false);
  assert.equal(f.plans.length,1);assert.equal(f.commits,1);assert.deepEqual(f.plans[0].plan,retained);assert.equal(f.state().operation,undefined);
  await stop(reopened);await stop(f.buffer);
});

test('ACK retry does not reapply canonical changes over newer typing',async()=>{
  const f=await fixture();f.loseAckReply();f.buffer.update(oldHeader+'Submitted');await assert.rejects(f.buffer.flush(),/ack reply lost/);
  assert.equal(f.buffer.text,newHeader+'Submitted');assert.equal(f.state().operation.pendingAck.status,'committed');
  f.buffer.update(newHeader+'Typed after reconciliation');await f.buffer.flush();
  assert.equal(f.buffer.text,newHeader+'Typed after reconciliation');assert.equal(f.commits,2);assert.equal(f.plans.length,2);assert.equal(f.acks,3);await stop(f.buffer);
});

test('unexpected committed bytes never receive canonical reconciliation',async()=>{
  const f=await fixture();f.tamper();const draft=oldHeader+'Submitted body';f.buffer.update(draft);await assert.rejects(f.buffer.flush(),/draft preserved/);
  assert.equal(f.buffer.text,draft);assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.plans.length,1);await stop(f.buffer);
});

test('property setter refresh adopts coherent projection while preserving body edits typed during refresh',async()=>{
  const f=await fixture();await f.project();f.buffer.update(oldHeader+'Body before refresh');const gate=f.holdCompose();const refreshing=f.buffer.refreshManagedProjection();await gate.started;
  f.buffer.update(oldHeader+'Latest body during refresh');gate.release();await refreshing;
  assert.equal(f.buffer.text,newHeader+'Latest body during refresh');assert.equal(f.buffer.savedText,newHeader+'Original body');assert.equal(f.plans.length,0);
  await f.buffer.flush();assert.equal(f.current.content,newHeader+'Latest body during refresh');assert.equal(f.buffer.dirty,false);await stop(f.buffer);
});

test('property setter refresh preserves a conflicting header draft without authoring a write',async()=>{
  const f=await fixture();await f.project();f.buffer.update(oldHeader+'Before');const gate=f.holdCompose();const refreshing=f.buffer.refreshManagedProjection();await gate.started;
  const typed=oldHeader.replace('Status: Todo','Status: Unfinished draft')+'After';f.buffer.update(typed);gate.release();await assert.rejects(refreshing,/draft retained/);
  assert.equal(f.buffer.text,typed);assert.equal(f.buffer.savedText,original);assert.equal(f.plans.length,0);assert.equal(f.current.content,newHeader+'Original body');await stop(f.buffer);
});

test('definite managed-source planning conflict retains the original draft and does not keep replanning',async()=>{
  const f=await fixture();let attempts=0;f.writes.planWrite=async()=>{attempts++;throw new DurableWritePlanningError('collection_source_conflict',false);};
  const draft=oldHeader+'Retained invalid managed edit';f.buffer.update(draft);await assert.rejects(f.buffer.flush());
  assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.buffer.text,draft);assert.equal(f.buffer.savedText,original);
  await assert.rejects(f.buffer.flush(),/draft preserved/);assert.equal(attempts,1);assert.equal(f.state().operation,undefined);
  const reopened=await f.reopen();assert.equal(reopened.hasRecoveryConflict,true);assert.equal(reopened.text,draft);await stop(reopened);await stop(f.buffer);
});
