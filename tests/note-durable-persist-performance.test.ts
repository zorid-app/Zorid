import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableNoteState } from '../src/ui/note-durable-state.ts';
import type { Vault } from '../src/core/vault.ts';
import type { Checkpoint, CheckpointChange } from '../src/core/durable-checkpoints.ts';
import type { DurableWrites, DurableWriteRead } from '../src/core/durable-writes.ts';

function fixture() {
  const scope={vaultId:'performance-vault',clientId:'performance-window'};
  let observed:DurableWriteRead={entryId:'one',revision:'source-1',path:'One.md',content:'Original body',stat:{ctime:1,mtime:1,size:13}};
  let head:Checkpoint|null=null,sequence=0,loseReply=false,failBeforeCommit=false,gate:Promise<void>|undefined;
  const calls:CheckpointChange[]=[];
  const unavailable=async():Promise<never>=>{throw Error('Unexpected note write');};
  const writes={checkpoints:{scope,load:async()=>head&&structuredClone(head),
    async compareAndSwap(change:CheckpointChange) {
      calls.push(structuredClone(change));
      if(gate)await gate;
      if(failBeforeCommit){failBeforeCommit=false;throw Error('Checkpoint unavailable');}
      if(head?.revision===change.nextRevision){assert.equal(head.encodedState,change.encodedState);return structuredClone(head);}
      if((head?.revision??null)!==change.expectedRevision)throw Error('Checkpoint ownership conflict');
      head={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(++sequence),deleted:false,byteLength:change.encodedState?.length??0};
      if(loseReply){loseReply=false;throw Error('Lost checkpoint reply');}
      return structuredClone(head);
    },list:async()=>({items:head?[head]:[],cursor:null,highWater:String(sequence)}),changes:async()=>({items:[],cursor:null,highWater:String(sequence)})},
    readText:async()=>structuredClone(observed),readTextById:async()=>structuredClone(observed),
    planWrite:unavailable,prepare:unavailable,commit:unavailable,query:unavailable,listUnacknowledged:async()=>[],acknowledge:unavailable,
  } satisfies DurableWrites;
  const vault={readDurableText:writes.readText,readDurableTextById:writes.readTextById} as unknown as Vault;
  const state=new DurableNoteState(vault,writes,()=>{});
  return {state,vault,writes,calls,get head(){return head;},
    seedClean(){head={version:1,...scope,key:'note/v1/one',revision:'checkpoint-existing',sequence:'1',deleted:false,byteLength:0,encodedState:JSON.stringify({version:1,writer:'existing-writer',generation:0,base:observed,draft:observed.content,conflict:false})};sequence=1;},
    retainOperation(){
      const raw=JSON.parse(head!.encodedState!),plan={version:1,...scope,entryId:'one',operationId:'operation-one',encodedPlan:'opaque retained plan'};
      const ref={...scope,entryId:'one',operationId:plan.operationId,token:'retained-intent'};
      raw.operation={plan,ref,content:observed.content};head={...head!,encodedState:JSON.stringify(raw)};return ref;
    },
    advanceSource(){observed={...observed,revision:'source-2',content:'External body'};},
    loseReply(){loseReply=true;},failBeforeCommit(){failBeforeCommit=true;},hold(value:Promise<void>){gate=value;},
    changeOwner(){head={...head!,revision:'foreign-revision'};},
  };
}

test('repeated clean navigation writes only its first recovery checkpoint',async()=>{
  const f=fixture();await f.state.load('One.md');
  for(let index=0;index<100;index++)await f.state.flush(()=>{});
  assert.equal(f.calls.length,1,'unchanged navigation must not create redundant durable transactions');
  assert.equal(JSON.parse(f.head!.encodedState!).draft,'Original body');
});

test('recovered clean checkpoint is already confirmed and needs no navigation write',async()=>{
  const f=fixture();f.seedClean();await f.state.load('One.md');
  await f.state.flush(()=>{});await f.state.preserveDraft();
  assert.equal(f.calls.length,0);
});

test('changed external baseline still persists its newly adopted source',async()=>{
  const f=fixture();f.seedClean();f.advanceSource();await f.state.load('One.md');
  await f.state.flush(()=>{});await f.state.flush(()=>{});
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.head!.encodedState!).base.revision,'source-2');
});

test('preserving the same dirty generation joins its confirmed recovery state',async()=>{
  const f=fixture();await f.state.load('One.md');f.state.update('Unsaved body');
  await f.state.preserveDraft();await f.state.preserveDraft();
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.head!.encodedState!).draft,'Unsaved body');
  f.state.update('Unsaved body');await f.state.preserveDraft();
  assert.equal(f.calls.length,2,'a new generation is a distinct recovery state even with equal text');
});

for(const outcome of ['lost-reply','not-committed'] as const)test(`uncertain ${outcome} retries its exact checkpoint identity without an extra successor`,async()=>{
  const f=fixture();await f.state.load('One.md');outcome==='lost-reply'?f.loseReply():f.failBeforeCommit();
  await assert.rejects(f.state.flush(()=>{}),/checkpoint|Checkpoint/);
  await f.state.flush(()=>{});
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.state.error,null);
});

test('typing while a checkpoint is pending persists the later generation separately',async()=>{
  const f=fixture();await f.state.load('One.md');let release!:()=>void;
  f.hold(new Promise<void>(resolve=>{release=resolve;}));
  const initial=f.state.flush(()=>{});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,1);f.state.update('Later typed body');release();
  await initial;await f.state.preserveDraft();
  assert.equal(f.calls.length,2);assert.equal(JSON.parse(f.calls[0].encodedState!).draft,'Original body');
  assert.equal(JSON.parse(f.calls[1].encodedState!).draft,'Later typed body');
  assert.equal(f.calls[1].expectedRevision,f.calls[0].nextRevision);
});

test('changed state still detects a foreign checkpoint writer and retains its draft',async()=>{
  const f=fixture();await f.state.load('One.md');await f.state.flush(()=>{});f.changeOwner();
  f.state.update('Retained after conflict');
  await assert.rejects(f.state.preserveDraft(),/ownership conflict/);
  assert.equal(f.state.text,'Retained after conflict');assert.equal(f.calls[1].expectedRevision,f.calls[0].nextRevision);
});

test('recovered operation rechecks checkpoint ownership before querying or committing an intent',async()=>{
  const f=fixture();f.seedClean();const ref=f.retainOperation(),writes:DurableWrites=f.writes;
  let queries=0,commits=0;
  const load=writes.checkpoints.load;
  writes.checkpoints.load=async key=>{const head=await load(key);f.changeOwner();return head;};
  writes.query=async()=>{queries++;return{ref,state:'prepared',acknowledged:false};};
  Object.assign(f.vault,{commitDurableWrite:async()=>{commits++;return{ref,state:'rejected',acknowledged:false,error:{operationId:ref.operationId,code:'rejected',message:'Rejected'}};}});
  await assert.rejects(f.state.load('One.md'),/ownership conflict/);
  assert.equal(queries,0,'checkpoint ownership must authorize intent continuation');
  assert.equal(commits,0,'a foreign checkpoint owner must block commit');
});
