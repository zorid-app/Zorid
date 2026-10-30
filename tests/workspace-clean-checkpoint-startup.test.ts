import test from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/ui/workspace.ts';
import {Vault} from '../src/core/vault.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {DurableWrites,DurableWriteRead} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

const initialCheckpointRevision='00000000-0000-0000-0000-000000000001';
function fixture(count=1){
  const scope={vaultId:'startup-vault',clientId:'startup-window'},records=new Map<string,DurableWriteRead>(),heads=new Map<string,Checkpoint>();
  const reads={body:0,checkpoint:0},scopeRequests={plans:0};
  for(let index=0;index<count;index++){
    const record:DurableWriteRead={entryId:`entry-${index}`,revision:'source-1',path:`Note ${index}.md`,content:`Saved note ${index}`,stat:{ctime:1,mtime:1,size:12}};
    records.set(record.entryId,record);const key=`note/v1/${record.entryId}`;
    const encodedState=JSON.stringify({version:1,writer:'previous-window',generation:0,base:record,draft:record.content,conflict:false});
    heads.set(key,{version:1,...scope,key,revision:initialCheckpointRevision,sequence:String(index+1),deleted:false,byteLength:Buffer.byteLength(encodedState,'utf8'),encodedState});
  }
  class Adapter extends MemoryAdapter{durableWrites!:DurableWrites;}
  const adapter=new Adapter(Object.fromEntries([...records.values()].map(row=>[row.path,row.content])));
  const unsupported=async():Promise<never>=>{throw Error('Unexpected startup write');};
  adapter.durableWrites={checkpoints:{scope,
    load:async key=>{reads.checkpoint++;return structuredClone(heads.get(key)??null);},
    list:async()=>({items:[...heads.values()],cursor:null,highWater:String(count)}),
    changes:async()=>({items:[],cursor:null,highWater:String(count)}),compareAndSwap:unsupported},
    readText:async path=>{reads.body++;return structuredClone([...records.values()].find(row=>row.path===path)??null);},
    readTextById:async id=>{reads.body++;return structuredClone(records.get(id)??null);},
    planWrite:async()=>{scopeRequests.plans++;return unsupported();},prepare:unsupported,commit:unsupported,query:unsupported,listUnacknowledged:async()=>[],acknowledge:unsupported,
  };
  const vault=new Vault(adapter);
  const owner={draftMetadataChanged(){},draftBufferStateChanged(){}};
  const recovery=Workspace.prototype as unknown as {recoverDurableBuffers(this:unknown,vault:Vault):Promise<Map<string,NoteBuffer>>};
  const recover=()=>recovery.recoverDurableBuffers.call(owner,vault);
  const state=(index=0)=>JSON.parse(heads.get(`note/v1/entry-${index}`)!.encodedState!);
  const setState=(raw:unknown,index=0)=>{const head=heads.get(`note/v1/entry-${index}`)!,encodedState=JSON.stringify(raw);heads.set(head.key,{...head,encodedState,byteLength:Buffer.byteLength(encodedState,'utf8')});};
  return{scope,records,heads,reads,scopeRequests,vault,recover,state,setState};
}

test('startup reads each clean checkpoint once without reading bodies or retaining unopened buffers',async()=>{
  const f=fixture(100),buffers=await f.recover();
  assert.equal(f.reads.body,0,'clean note history must not read every body before the workspace can open');
  assert.equal(f.reads.checkpoint,100,'clean checkpoint bodies need only one classification read');
  assert.equal(buffers.size,0,'unopened clean notes must not retain a NoteBuffer');
  assert.equal(f.scopeRequests.plans,0);
});

test('deferred clean note opens with current authoritative source and retained checkpoint identity',async()=>{
  const f=fixture(),recovered=await f.recover();assert.equal(recovered.size,0);
  const original=f.records.get('entry-0')!;f.records.set(original.entryId,{...original,revision:'source-2',content:'Changed externally'});
  const note=new NoteBuffer(f.vault,original.path);await note.load(original.entryId);
  assert.equal(note.text,'Changed externally');assert.equal(note.savedDurableWitness?.revision,'source-2');assert.equal(note.dirty,false);
  assert.equal(f.scopeRequests.plans,0);assert.equal(f.heads.get('note/v1/entry-0')!.revision,initialCheckpointRevision);
});

test('startup still recovers an unsaved draft without creating a write plan',async()=>{
  const f=fixture(),raw=f.state();raw.draft+='\nRetained unsaved body';raw.generation=1;f.setState(raw);
  const buffers=await f.recover(),note=buffers.get(raw.base.path)!;
  assert.equal(buffers.size,1);assert.equal(note.text,raw.draft);assert.equal(note.dirty,true);assert.equal(f.reads.body,2);assert.equal(f.scopeRequests.plans,0);
});

test('startup still recovers a conflicted checkpoint even when its source and draft match',async()=>{
  const f=fixture(),raw=f.state();raw.conflict=true;f.setState(raw);
  const note=(await f.recover()).get(raw.base.path)!;
  assert.equal(note.hasRecoveryConflict,true);assert.equal(note.text,raw.draft);assert.equal(f.reads.body,2);
});

test('startup still retains a planned operation even when its source and draft match',async()=>{
  const f=fixture(),raw=f.state();raw.operation={content:raw.draft,plan:{version:1,...f.scope,entryId:raw.base.entryId,operationId:'retained-operation',encodedPlan:'exact-plan'}};f.setState(raw);
  const note=(await f.recover()).get(raw.base.path)!;
  assert.equal(note.dirty,true);assert.equal(f.reads.body,2);assert.equal(f.scopeRequests.plans,0);
});

test('clean missing notes need no body read while missing unsaved notes still stop recovery',async()=>{
  const clean=fixture();clean.records.clear();assert.equal((await clean.recover()).size,0);assert.equal(clean.reads.body,0);
  const dirty=fixture(),raw=dirty.state();raw.draft+='\nRetained';dirty.setState(raw);dirty.records.clear();
  await assert.rejects(dirty.recover(),/entry is missing; draft retained/);
});

for(const kind of ['writer','generation','draft','conflict','path','revision'] as const)test(`malformed ${kind} state cannot bypass retained-checkpoint validation as clean`,async()=>{
  const f=fixture(),raw=f.state();
  if(kind==='writer')delete raw.writer;
  else if(kind==='generation')raw.generation=-1;
  else if(kind==='draft'){delete raw.draft;delete raw.base.content;}
  else if(kind==='conflict')raw.conflict=0;
  else delete raw.base[kind];
  f.setState(raw);const before=f.heads.get('note/v1/entry-0')!.encodedState;
  await assert.rejects(f.recover(),/malformed or unsupported checkpoint; retained/);
  assert.equal(f.heads.get('note/v1/entry-0')!.encodedState,before);assert.equal(f.scopeRequests.plans,0);
});
