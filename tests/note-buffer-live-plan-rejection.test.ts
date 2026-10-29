import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {planningBridge} from './helpers/desktop-note-planning.ts';
import {decodeDesktopNotePlan} from '../src/platform/desktop-note-plan.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';
import type {DurableWrites} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
const require=createRequire(import.meta.url);
const {desktopDurableWrites}=require('../desktop/durable-writes.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');

/** Use the actual desktop planning provider, not an invented conflict throw. */
async function fixture(t:test.TestContext){
  const original='Clean desktop baseline 😀\nExact committed editor version',peer='Peer committed text 😀\nIndependent CLI version';
  let revision='original-revision',content=original,checkpoint:Checkpoint|null=null,prepares=0;
  const row=()=>({entry:{id:'entry',revision,path:'Concurrent.md',kind:'file',deleted:false},has_content:true,bytes:Buffer.from(content),presentation:{id:'entry',ctime_ms:1,mtime_ms:2,size_bytes:Buffer.byteLength(content)}});
  const host={root:'/test-vault',identity:async()=>({local_store_id:'authority'}),readPath:async()=>row(),readPresentedById:async()=>row(),prepareIntent:async()=>{prepares++;throw new Error('Unexpected preparation');}};
  const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30_000});
  const provider=await desktopDurableWrites(service,{clientId:'client'});
  const scope={vaultId:'authority',clientId:'client'};
  const bridge=planningBridge(async(_name,_root,_admission,method,args)=>{
    assert.equal(method,'planWrite');
    try{return{ok:true,result:await provider.planWrite(args[0])};}
    catch(error){return{ok:false,error:{code:(error as {code?:string}).code??'durable_request_failed',commitUncertain:(error as {commitUncertain?:boolean}).commitUncertain===true}};}
  });
  const writes:DurableWrites={...provider,planWrite:async input=>decodeDesktopNotePlan(input,scope,await bridge.plan(input)),checkpoints:{scope,load:async()=>checkpoint?structuredClone(checkpoint):null,
    compareAndSwap:async change=>{assert.equal(change.expectedRevision,checkpoint?.revision??null);checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(Number(checkpoint?.sequence??'0')+1),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??''),encodedState:change.encodedState};return structuredClone(checkpoint);},
    list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})}};
  const adapter=new MemoryAdapter({'Concurrent.md':original});Object.assign(adapter,{durableWrites:writes,createText:async(path:string,text:string)=>{assert.equal(await adapter.stat(path),null);await adapter.write(path,text);}});
  const vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'Concurrent.md',{debounceMs:60_000});await buffer.load();t.after(()=>buffer.closeMetadataProjection());
  return{writes,buffer,vault,adapter,original,peer,get checkpoint(){return checkpoint;},get prepares(){return prepares;},async advance(){revision='peer-revision';content=peer;await adapter.write('Concurrent.md',peer);}};
}

test('actual desktop preflight rejects a changed saved baseline before preparing an intent',async t=>{
  const f=await fixture(t);await f.advance();
  await assert.rejects(f.writes.planWrite({operationId:'original-operation',path:'Concurrent.md',expectedEntryId:'entry',expectedRevision:'original-revision',expectedContent:f.original,content:'Desktop retained draft'}),error=>{
    assert.equal((error as {code:string}).code,'revision_conflict');
    assert.equal((error as {commitUncertain?:boolean}).commitUncertain,false);
    return true;
  });
  assert.equal(f.prepares,0);assert.equal(await f.adapter.read('Concurrent.md'),f.peer);
});

test('live preflight rejection exposes the retained conflict without changing its baseline or creating an intent',async t=>{
  const f=await fixture(t);const draft='Desktop retained draft 😀\nConcurrent typing ..';f.buffer.update(draft);await f.advance();
  await assert.rejects(f.buffer.flush());
  assert.equal(f.buffer.text,draft);assert.equal(await f.adapter.read('Concurrent.md'),f.peer);assert.equal(f.prepares,0);
  const state=JSON.parse(f.checkpoint!.encodedState!);assert.equal(state.draft,draft);assert.equal(state.base.content,f.original);assert.equal(state.base.revision,'original-revision');assert.equal(state.operation,undefined);
  // Red on the recorded source; green only after verified planning rejection is persisted.
  assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(state.conflict,true);
});

test('unknown planning failures and untyped error codes never manufacture a confirmed conflict',async t=>{
  for(const error of [new DurableWritePlanningError('planning_transport_lost',true),new DurableWritePlanningError('revision_conflict',true),new DurableWritePlanningError('client_not_admitted',false),Object.assign(new Error('not a verified envelope'),{code:'revision_conflict',commitUncertain:false})]){
    const f=await fixture(t);const draft='Retained pending draft';f.buffer.update(draft);f.writes.planWrite=async()=>{throw error;};
    await assert.rejects(f.buffer.flush());assert.equal(f.buffer.text,draft);assert.equal(f.buffer.hasRecoveryConflict,false);assert.equal(f.prepares,0);
    const state=JSON.parse(f.checkpoint!.encodedState!);assert.equal(state.conflict,false);assert.equal(state.draft,draft);assert.equal(state.operation,undefined);assert.equal(state.base.content,f.original);
  }
});
test('a verified live conflict is restart-visible without adopting the peer or minting another request',async t=>{
  const f=await fixture(t);f.buffer.update('Exact retained draft');await f.advance();await assert.rejects(f.buffer.flush());
  const before=f.checkpoint!.encodedState;await assert.rejects(f.buffer.flush(),/draft preserved/);assert.equal(f.checkpoint!.encodedState,before);assert.equal(f.prepares,0);
  const reopened=new NoteBuffer(f.vault,'Concurrent.md');await reopened.load();t.after(()=>reopened.closeMetadataProjection());assert.equal(reopened.hasRecoveryConflict,true);assert.equal(reopened.text,'Exact retained draft');assert.equal(reopened.savedDurableWitness?.revision,'original-revision');
});

test('commit-stage failures retain the original prepared request and never use planning-conflict classification',async t=>{
  const f=await fixture(t);const draft='Draft with pending intent';f.buffer.update(draft);
  let planned=0;const plan=f.writes.planWrite;f.writes.planWrite=input=>{planned++;return plan(input);};
  let prepared:any;const commits:unknown[]=[];
  f.writes.prepare=async plan=>prepared={state:'prepared',acknowledged:false,ref:{vaultId:plan.vaultId,clientId:plan.clientId,operationId:plan.operationId,entryId:plan.entryId,token:'original-token'}};
  f.writes.query=async()=>prepared;
  f.writes.commit=async ref=>{commits.push(structuredClone(ref));throw new DurableWritePlanningError('revision_conflict',false);};
  await assert.rejects(f.buffer.flush());const before=JSON.parse(f.checkpoint!.encodedState!);
  assert.equal(f.buffer.hasRecoveryConflict,false);assert.equal(before.conflict,false);assert.equal(before.draft,draft);assert.equal(before.operation.ref.token,'original-token');
  await assert.rejects(f.buffer.flush());const after=JSON.parse(f.checkpoint!.encodedState!);
  assert.deepEqual(after.operation,before.operation);assert.deepEqual(commits,[before.operation.ref,before.operation.ref]);assert.equal(planned,1);assert.equal(f.buffer.text,draft);
});
test('live planning conflict uses existing recovery-copy flow and preserves both exact versions',async t=>{
  const f=await fixture(t);const draft='Exact desktop recovery draft 😀';f.buffer.update(draft);await f.advance();await assert.rejects(f.buffer.flush());
  const result=await f.buffer.saveRecoveryCopy();assert.equal(result.resolved,true);
  assert.equal(await f.adapter.read(result.path),draft);assert.equal(await f.adapter.read('Concurrent.md'),f.peer);assert.equal(f.buffer.text,f.peer);assert.equal(f.buffer.hasRecoveryConflict,false);assert.equal(f.prepares,0);
});
