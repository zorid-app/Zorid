import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCoreAdapter } from '../src/platform/browser-core.ts';
import type { BrowserCoreBackend } from '../src/platform/browser-core.ts';
import type { BrowserVaultIntent, BrowserVaultRead } from '../src/core/browser-vault.ts';
import type { DurableWriteRef } from '../src/core/durable-writes.ts';
import { BrowserVaultError } from '../src/core/browser-vault.ts';

// Transport facade fake only: no duplicated Rust validation or IDB simulation.
function fixture() {
  const scope = Object.freeze({vaultId:'vault-a',clientId:'client-a'});
  const entry: BrowserVaultRead = {entry:{id:'entry-a',path:'Note.md',kind:'file',revision:'revision-a',deleted:false},
    presentation:{id:'entry-a',ctime_ms:1,mtime_ms:2,size_bytes:3},bytes:new TextEncoder().encode('old')};
  const rows = new Map<string,BrowserVaultIntent>();
  const calls: {operation:string;token?:string;json?:string}[] = [];
  let reads = 0, losePrepare = false, loseCommit = false, rejectCommit = false;
  let listing: (()=>Promise<void>) | undefined;
  let listingFailure: Error | undefined;
  const backend: BrowserCoreBackend = {
    durableScope:scope,
    checkpoints:{scope,async load(){return null;},async compareAndSwap(){throw new Error('Use real host fixture for checkpoint persistence');},async list(){return {items:[],cursor:null,highWater:'0'};},async changes(){return {items:[],cursor:null,highWater:'0'};}},
    async inventory() { return [structuredClone(entry)]; },
    async readEntry() { reads++; return structuredClone(entry); },
    async readEntryById(id) { reads++; return entry.entry.id===id && !entry.entry.deleted?structuredClone(entry):null; },
    async execute() { throw new Error('Legacy execute must not be used by durable wrapper'); },
    async prepare(token,json) {
      calls.push({operation:'prepare',token,json});
      const previous = rows.get(token);
      if (previous && previous.request_json !== json) throw new BrowserVaultError('intent_conflict','different request');
      if (!previous) rows.set(token,{client_id:scope.clientId,intent_id:token,operation_id:JSON.parse(json).operation_id,
        request_json:json,order:'1',acknowledged:false,status:'prepared'});
      if (losePrepare) { losePrepare=false; throw new BrowserVaultError('outcome_unknown','lost prepare response'); }
    },
    async commit(token) {
      calls.push({operation:'commit',token});
      const row=rows.get(token)!;
      if (rejectCommit) {
        row.status='rejected'; row.error={code:'revision_conflict',message:'stale',source:'rust'};
        throw new BrowserVaultError('revision_conflict','stale',undefined,'rust');
      }
      row.status='committed'; row.receipt=JSON.stringify({operation_id:row.operation_id,sequence:'9007199254740993',changes:[{before:entry.entry,after:{...entry.entry,id:JSON.parse(row.request_json).mutation.id,revision:'committed-revision',deleted:false}}]});
      if (loseCommit) { loseCommit=false; throw new BrowserVaultError('outcome_unknown','lost commit response'); }
      return row.receipt;
    },
    async intents() { if(listing) await listing(); if(listingFailure) throw listingFailure; return structuredClone([...rows.values()]); },
    async acknowledge(token,outcome) { calls.push({operation:'acknowledge',token,json:JSON.stringify(outcome)}); rows.get(token)!.acknowledged=true; },
    subscribe() { return ()=>{}; }, close() {},
  };
  const adapter=new BrowserCoreAdapter(backend,scope), durable=adapter.durableWrites!;
  return {scope,entry,rows,calls,backend,adapter,durable,
    plan:()=>durable.planWrite({operationId:'operation-a',path:'Note.md',expectedEntryId:'entry-a',expectedRevision:'revision-a',expectedContent:'old',content:'new'}),
    get reads(){return reads;}, losePrepare(){losePrepare=true;}, loseCommit(){loseCommit=true;}, rejectCommit(){rejectCommit=true;},
    listing(fn?:()=>Promise<void>){listing=fn;}, listingFailure(error?:Error){listingFailure=error;}};
}
test('durable capability requires authoritative runtime scope and remains optional for legacy adapters',()=>{
  const f=fixture();
  assert.equal(new BrowserCoreAdapter(f.backend).durableWrites,undefined);
  assert.throws(()=>new BrowserCoreAdapter(f.backend,{...f.scope,vaultId:'wrong-vault'}),{code:'intent_identity_mismatch'});
});
test('readText returns bytes and identity from one backend observation',async()=>{
  const f=fixture();
  const reading=f.durable.readText('Note.md');
  f.entry.entry.id='replacement'; f.entry.entry.revision='revision-b'; f.entry.bytes=new TextEncoder().encode('peer');
  assert.deepEqual(await reading,{content:'old',path:'Note.md',entryId:'entry-a',revision:'revision-a',stat:{ctime:1,mtime:2,size:3}});
  assert.equal(f.reads,1); assert.equal(f.calls.length,0);
});
test('same-byte recreation or revision change rejects planning before any intent is prepared',async()=>{
  const f=fixture(), observed=await f.durable.readText('Note.md');
  const input={operationId:'operation-a',path:'Note.md',expectedEntryId:observed.entryId,expectedRevision:observed.revision,expectedContent:observed.content,content:'new'};
  f.entry.entry.id='replacement';
  await assert.rejects(f.durable.planWrite(input),{code:'revision_conflict'});
  f.entry.entry.id=observed.entryId; f.entry.entry.revision='revision-b';
  await assert.rejects(f.durable.planWrite(input),{code:'revision_conflict'});
  assert.equal(f.calls.length,0,'same text never overrides identity/revision guards');
});
test('plan binds one coherent revision, preserves BOM/supplementary Unicode and prepares without commit',async()=>{
  const f=fixture(); f.entry.bytes=new TextEncoder().encode('\uFEFFold');
  const plan=await f.durable.planWrite({operationId:'operation-a',path:'Note.md',expectedEntryId:'entry-a',expectedRevision:'revision-a',expectedContent:'\uFEFFold',content:'\uFEFF😀new'});
  assert.equal(f.reads,1); assert.equal(f.calls.length,0); assert.equal(Object.isFrozen(plan),true);
  assert.deepEqual(JSON.parse(plan.encodedPlan).mutation,{type:'write',id:'entry-a',expected:'revision-a',content:Array.from(new TextEncoder().encode('\uFEFF😀new'))});
  const view=await f.durable.prepare(plan);
  assert.equal(view.state,'prepared'); assert.deepEqual(f.calls.map(call=>call.operation),['prepare']);
  assert.deepEqual(await f.durable.query(view.ref),view);
});
test('checkpoint failure before prepare or commit cannot execute a write',async()=>{
  const f=fixture(), plan=await f.plan();
  const checkpoint=()=>{throw new Error('quota');};
  assert.throws(()=>checkpoint(),/quota/);
  assert.equal(f.calls.length,0,'failed plan checkpoint has not prepared anything');
  const prepared=await f.durable.prepare(plan);
  assert.throws(()=>checkpoint(),/quota/);
  assert.equal((await f.durable.query(prepared.ref))?.state,'prepared');
  assert.deepEqual(f.calls.map(call=>call.operation),['prepare'],'failed ref checkpoint has not authorized commit');
});
test('lost prepare acknowledgement retries immutable persisted plan without another read or operation',async()=>{
  const f=fixture(), plan=await f.plan(); f.losePrepare();
  await assert.rejects(f.durable.prepare(plan),{code:'outcome_unknown'});
  f.entry.entry.revision='newer-revision'; f.entry.bytes=new TextEncoder().encode('peer');
  const restored=new BrowserCoreAdapter(f.backend,f.scope).durableWrites!;
  const view=await restored.prepare(JSON.parse(JSON.stringify(plan)));
  assert.equal(view.ref.operationId,'operation-a'); assert.equal(f.reads,1);
  assert.deepEqual(f.calls[0],f.calls[1]); assert.equal(view.state,'prepared');
});
test('lost commit acknowledgement reuses original ref, preserves decimal sequence, and requires exact explicit ack',async()=>{
  const f=fixture(), view=await f.durable.prepare(await f.plan()); f.loseCommit();
  await assert.rejects(f.durable.commit(view.ref),{code:'outcome_unknown'});
  const restored=new BrowserCoreAdapter(f.backend,f.scope).durableWrites!;
  const committed=await restored.commit(JSON.parse(JSON.stringify(view.ref)));
  assert.equal(committed.state,'committed'); if(committed.state!=='committed') throw new Error('missing receipt');
  assert.equal(committed.receipt.sequence,'9007199254740993');
  assert.deepEqual(f.calls.filter(call=>call.operation==='commit').map(call=>call.token),['operation-a','operation-a']);
  assert.equal((await restored.listUnacknowledged()).length,1,'commit response does not acknowledge consumer checkpoint');
  await assert.rejects(restored.acknowledge(view.ref,{status:'committed',operationId:'operation-a',sequence:'2'}),{code:'intent_outcome_mismatch'});
  await restored.acknowledge(view.ref,{status:'committed',...committed.receipt});
  assert.deepEqual(await restored.listUnacknowledged(),[]);
});
test('missing checkpointed refs never recreate intents; foreign identities never dispatch',async()=>{
  const f=fixture(), prepared=await f.durable.prepare(await f.plan()); f.rows.clear();
  assert.equal(await f.durable.query(prepared.ref),null);
  await assert.rejects(f.durable.commit(prepared.ref),{code:'intent_not_found'});
  await assert.rejects(f.durable.query({...prepared.ref,clientId:'foreign'}),{code:'intent_identity_mismatch'});
  assert.deepEqual(f.calls.map(call=>call.operation),['prepare']);
});
test('recreated local store rejects old plans and refs before host mutation even with the same client',async()=>{
  const f=fixture(), plan=await f.plan(), prepared=await f.durable.prepare(plan);
  const replacement=Object.freeze({...f.scope,vaultId:'new-local-authority'});
  const next=new BrowserCoreAdapter({...f.backend,durableScope:replacement,checkpoints:{...f.backend.checkpoints!,scope:replacement}},replacement).durableWrites!;
  await assert.rejects(next.prepare(plan),{code:'intent_identity_mismatch'});
  await assert.rejects(next.query(prepared.ref),{code:'intent_identity_mismatch'});
  await assert.rejects(next.commit(prepared.ref),{code:'intent_identity_mismatch'});
  assert.deepEqual(f.calls.map(call=>call.operation),['prepare']);
});
test('stable-ID reads follow renames and receipt witnesses remain historical after peer changes',async()=>{
  const f=fixture(), prepared=await f.durable.prepare(await f.plan());
  const committed=await f.durable.commit(prepared.ref);
  assert.equal(committed.state,'committed');if(committed.state!=='committed')throw new Error('missing receipt');
  assert.deepEqual(committed.receipt,{operationId:'operation-a',sequence:'9007199254740993',entryId:'entry-a',revision:'committed-revision'});
  f.entry.entry.path='Renamed.md';f.entry.entry.revision='peer-revision';f.entry.bytes=new TextEncoder().encode('peer');f.entry.presentation.size_bytes=4;
  assert.deepEqual(await f.durable.readTextById('entry-a'),{path:'Renamed.md',content:'peer',entryId:'entry-a',revision:'peer-revision',stat:{ctime:1,mtime:2,size:4}});
  assert.equal((await f.durable.query(prepared.ref))?.state,'committed');
  assert.equal(committed.receipt.revision,'committed-revision');
  f.entry.entry.deleted=true;assert.equal(await f.durable.readTextById('entry-a'),null);
});
test('ref and ack identities are copied before asynchronous lookups',async()=>{
  const f=fixture(), prepared=await f.durable.prepare(await f.plan());
  let release!:()=>void; f.listing(()=>new Promise(resolve=>{release=resolve;f.listing();}));
  const mutable={...prepared.ref}; const pending=f.durable.commit(mutable); mutable.token='other'; mutable.operationId='other'; release();
  const committed=await pending;
  assert.equal(committed.ref.token,'operation-a');
  if(committed.state!=='committed') throw new Error('missing receipt');
  f.listing(()=>new Promise(resolve=>{release=resolve;f.listing();}));
  const outcome={status:'committed' as const,...committed.receipt};
  const ack=f.durable.acknowledge(prepared.ref,outcome); outcome.sequence='wrong'; release(); await ack;
  assert.equal(f.calls.at(-1)?.token,'operation-a');
});
test('valid nonwrite intents need their own recovery consumer and cannot execute through durableWrites',async()=>{
  const f=fixture();
  f.rows.set('delete-token',{client_id:f.scope.clientId,intent_id:'delete-token',operation_id:'delete-op',order:'1',acknowledged:false,status:'prepared',request_json:JSON.stringify({operation_id:'delete-op',mutation:{type:'delete',id:'entry-a',expected:'revision-a',recursive:true}})});
  assert.deepEqual(await f.durable.listUnacknowledged(),[]);
  const ref:DurableWriteRef={...f.scope,token:'delete-token',operationId:'delete-op',entryId:'entry-a'};
  await assert.rejects(f.durable.commit(ref),{code:'intent_kind_unsupported'}); assert.equal(f.calls.length,0);
});
test('durable semantic rejection is queryable; postcommit lookup errors remain outcome_unknown',async()=>{
  const f=fixture(), prepared=await f.durable.prepare(await f.plan()); f.rejectCommit();
  const rejected=await f.durable.commit(prepared.ref); assert.equal(rejected.state,'rejected');
  if(rejected.state!=='rejected') throw new Error('missing rejection');
  await f.durable.acknowledge(prepared.ref,{status:'rejected',operationId:'operation-a',code:rejected.error.code});
  const g=fixture(), next=await g.durable.prepare(await g.plan());
  const original=g.backend.commit!;
  g.backend.commit=async token=>{const receipt=await original(token);g.listingFailure(new BrowserVaultError('invalid_operation_record','bad journal',undefined,'rust'));return receipt;};
  await assert.rejects(g.durable.commit(next.ref),{code:'outcome_unknown',source:'host'});
});
test('plan/ref mismatches, malformed UTF16 and oversized encoded plans fail before host mutation',async()=>{
  const f=fixture(), plan=await f.plan();
  await assert.rejects(f.durable.prepare({...plan,entryId:'other-entry'}),{code:'intent_identity_mismatch'});
  await assert.rejects(f.durable.prepare({...plan,encodedPlan:' '.repeat(8*1024*1024+1)}),{code:'encoded_plan_too_large'});
  for(const [expectedContent,content] of [['old','\ud800'],['\udfff','new']]) await assert.rejects(f.durable.planWrite({operationId:'bad',path:'Note.md',expectedEntryId:'entry-a',expectedRevision:'revision-a',expectedContent,content}),{code:'invalid_text'});
  assert.equal(f.calls.length,0);
  await f.adapter.close(); await assert.rejects(f.durable.prepare(plan),{code:'storage_closed'});
});
