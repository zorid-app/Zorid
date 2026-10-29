import test from 'node:test';
import assert from 'node:assert/strict';
import {NoteDraftProtection} from '../src/ui/note-draft-protection.ts';
import type {NoteDraftCapture,NoteDraftProtectionOptions,NoteDraftProtectionStatus} from '../src/ui/note-draft-protection.ts';
import type {DraftCleanWitness} from '../src/ui/draft-protection.ts';
import type {IndependentDraftChange,IndependentDraftProvider,IndependentDraftReceipt,IndependentDraftRetirement} from '../src/core/independent-drafts.ts';

const scope={vaultId:'vault',clientId:'client',incarnationId:'current-renderer'};
const capture=(draft='Draft',generation=1):NoteDraftCapture=>({writer:'writer',snapshot:{generation,baseline:{entryId:'note',path:'One.md',revision:'base-r1',content:'Saved'},draft,checkpointRevision:null,pendingOperation:null}});
const error=(code='draft_storage_failure')=>Object.assign(Error('Journal unavailable'),{code});
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let n=0;n<50&&!check();n++)await drain();assert.ok(check());}
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
function receipt(request:IndependentDraftChange|IndependentDraftRetirement,deleted=false):IndependentDraftReceipt{return{...scope,entryId:request.entryId,writer:request.writer,generation:request.generation,revision:request.nextRevision,deleted};}
function fixture(extra:Partial<NoteDraftProtectionOptions>={}){
  const writes:IndependentDraftChange[]=[],retirements:IndependentDraftRetirement[]=[],statuses:NoteDraftProtectionStatus[]=[];
  let failed:unknown,writeGate:Promise<void>|undefined,retireGate:Promise<void>|undefined;
  const provider:IndependentDraftProvider={scope,read:async()=>null,list:async()=>[],
    async compareAndSwap(request){writes.push(request);if(writeGate)await writeGate;if(failed)throw failed;return receipt(request);},
    async retire(request){retirements.push(request);if(retireGate)await retireGate;return receipt(request,true);}};
  const helper=new NoteDraftProtection({provider,writesScope:scope,coreCovered:()=>false,onStatus:status=>statuses.push(status),...extra});
  return{helper,writes,retirements,statuses,fail(...args:[unknown?]){failed=args.length?args[0]:error();},holdWrite(gate:Promise<void>){writeGate=gate;},holdRetire(gate:Promise<void>){retireGate=gate;}};
}

test('capture owns immutable metadata, deduplicates exact captures, and never encodes on the editing stack',async()=>{
  let encodes=0;const f=fixture({encodePendingOperation:()=>{encodes++;return 'Encoded exact operation';}});f.helper.markInventory('ready');
  const input=capture('Exact lone surrogate \ud800'),operation=Object.freeze({phase:'prepared',body:'Operation body'});
  const submitted={...input,snapshot:{...input.snapshot,pendingOperation:operation}};
  const stringify=JSON.stringify;
  try{JSON.stringify=()=>{throw Error('No synchronous JSON');};f.helper.capture(submitted);f.helper.capture(submitted);assert.equal(encodes,0);assert.equal(f.writes.length,0);}finally{JSON.stringify=stringify;}
  assert.equal(f.helper.status.sequence,1);
  (submitted.snapshot.baseline as any).path='Changed.md';(submitted.snapshot as any).draft='Changed input';
  await f.helper.flush();assert.equal(encodes,1);assert.equal(f.writes[0].baseline.path,'One.md');assert.equal(f.writes[0].draft,'Exact lone surrogate \ud800');assert.equal(f.writes[0].pendingOperation,'Encoded exact operation');
  const previous=f.writes.length;await f.helper.flush();assert.equal(f.writes.length,previous);
  f.helper.capture({...input,snapshot:{...input.snapshot,baseline:{entryId:'note',path:'One.md',revision:'base-r1',content:'Saved'},pendingOperation:Object.freeze({phase:'prepared',body:'Operation body'})}});
  await f.helper.flush();assert.equal(f.helper.status.sequence,2);assert.equal(encodes,2,'a new frozen operation identity is a new capture');f.helper.stop();
});

test('backoff holds newer captures locally then retries the original uncertain CAS before latest',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.fail();f.helper.markInventory('ready');f.helper.capture(capture('First',1));
  await until(()=>!!f.helper.status.error);const first=f.writes[0];
  for(let generation=2;generation<=100;generation++)f.helper.capture(capture('Latest '+generation,generation));
  await drain();assert.equal(f.writes.length,1);assert.equal(f.helper.status.sequence,100);assert.equal(f.helper.status.currentProtected,false);assert.equal(f.helper.status.currentJournalAcknowledged,false);assert.equal(f.helper.status.pending,true);
  t.mock.timers.tick(499);await drain();assert.equal(f.writes.length,1);
  f.fail(undefined);t.mock.timers.tick(1);await until(()=>f.helper.status.currentProtected);
  assert.equal(f.writes[1],first);assert.deepEqual(f.writes.map(write=>[write.expectedRevision,write.nextRevision,write.draft]),[[null,'1','First'],[null,'1','First'],['1','2','Latest 100']]);
  assert.equal(f.helper.status.retryPending,false);assert.equal(f.helper.status.currentJournalAcknowledged,true);const count=f.writes.length;t.mock.timers.tick(300_000);await drain();assert.equal(f.writes.length,count,'healthy protection never polls');f.helper.stop();
});

test('one failure timer uses 500,1500,4000 then repeated 30 second retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.fail(error('draft_journal_busy'));f.helper.markInventory('ready');f.helper.capture(capture());await until(()=>!!f.helper.status.error);
  let expected=1;for(const delay of [500,1500,4000,30_000,30_000]){
    t.mock.timers.tick(delay-1);await drain();assert.equal(f.writes.length,expected);
    t.mock.timers.tick(1);expected++;await until(()=>f.writes.length===expected);await drain();assert.equal(f.helper.status.retryPending,true);
  }
  assert.ok(f.writes.every(write=>write===f.writes[0]));f.helper.stop();t.mock.timers.tick(300_000);await drain();assert.equal(f.writes.length,expected);
});

for(const code of ['draft_revision_conflict','invalid_draft_receipt','draft_protection_failed','io'])test(`terminal ${code} does not schedule an automatic journal retry`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.fail(error(code));f.helper.markInventory('ready');f.helper.capture(capture());await until(()=>!!f.helper.status.error);
  for(let n=2;n<8;n++)f.helper.capture(capture('New '+n,n));t.mock.timers.tick(300_000);await drain();assert.equal(f.writes.length,1);assert.equal(f.helper.status.retryPending,false);
  f.fail(undefined);f.helper.availability();await until(()=>f.helper.status.currentProtected);assert.equal(f.writes[1],f.writes[0]);assert.equal(f.writes.at(-1)!.draft,'New 7');f.helper.stop();
});

test('unknown inventory retries independently with no current capture and never means an empty inventory',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let attempts=0;let helper!:NoteDraftProtection;
  const f=fixture({retryInventory:async()=>{attempts++;if(attempts===1)throw error('draft_transport_lost');helper.markInventory('retained');}});helper=f.helper;
  helper.markInventory('unknown',error('draft_storage_failure'));assert.equal(helper.status.inventory,'unknown');assert.equal(helper.status.pending,true);assert.ok(helper.status.inventoryError);
  t.mock.timers.tick(500);await until(()=>attempts===1);await drain();assert.equal(helper.status.inventory,'unknown');assert.equal(f.writes.length,0);
  t.mock.timers.tick(1500);await until(()=>helper.status.inventory==='retained');assert.equal(helper.status.inventoryError,null);assert.equal(helper.status.pending,false);assert.equal(f.writes.length,0);helper.stop();
});

test('captures wait for successful inventory and explicit flush retries the retained request immediately',async()=>{
  let helper!:NoteDraftProtection;const gate=held<void>();
  const f=fixture({retryInventory:async()=>{await gate.promise;helper.markInventory('ready');}});helper=f.helper;
  helper.capture(capture('First',1));assert.equal(f.writes.length,0);const pending=helper.flush();await drain();assert.equal(f.writes.length,0);
  gate.resolve();await pending;assert.equal(f.writes.length,1);
  f.fail();helper.capture(capture('Second',2));await until(()=>!!helper.status.error);const failed=f.writes.at(-1)!;
  helper.capture(capture('Third',3));f.fail(undefined);await helper.flush();assert.equal(f.writes.at(-2),failed);assert.equal(f.writes.at(-1)!.draft,'Third');assert.equal(helper.status.currentProtected,true);helper.stop();
});

test('stop fences queued work, timers and late transport status without dropping a live core owner',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),gate=held<void>();f.holdWrite(gate.promise);f.helper.markInventory('ready');f.helper.capture(capture('In flight',1));await until(()=>f.writes.length===1);
  f.helper.capture(capture('Newer RAM',2));f.helper.stop();const notifications=f.statuses.length;gate.resolve();await drain();await drain();t.mock.timers.tick(300_000);await drain();
  assert.equal(f.writes.length,1);assert.equal(f.statuses.length,notifications);await assert.rejects(f.helper.flush(),{code:'draft_protection_stopped'});
  f.helper.capture(capture('Late',3));f.helper.availability();await drain();assert.equal(f.writes.length,1);
});

test('only strict latest core coverage suppresses redundant retries, never an older generation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let covered:NoteDraftCapture|undefined;
  const f=fixture({coreCovered:current=>!!covered&&current.writer===covered.writer&&current.snapshot.generation===covered.snapshot.generation&&current.snapshot.draft===covered.snapshot.draft&&current.snapshot.baseline.revision===covered.snapshot.baseline.revision});
  f.fail();f.helper.markInventory('ready');const first=capture('Same body',1),latest=capture('Same body',2);f.helper.capture(first);await until(()=>!!f.helper.status.error);f.helper.capture(latest);
  const before=f.writes.length;covered=first;f.helper.coreSettled();await drain();assert.equal(f.writes.length,before,'an older core acknowledgement must not bypass journal backoff');assert.equal(f.helper.status.currentProtected,false);assert.equal(f.helper.status.retryPending,true);
  covered=latest;f.helper.coreSettled();await drain();const attempts=f.writes.length;assert.equal(f.helper.status.currentProtected,true);assert.equal(f.helper.status.retryPending,false);
  t.mock.timers.tick(300_000);await drain();assert.equal(f.writes.length,attempts);assert.equal(f.retirements.length,0,'failed cleanup cannot retire an unacknowledged journal CAS');f.helper.stop();
});

test('real core commit protects its changed clean baseline before retiring the final clean token',async()=>{
  let covered=false;const f=fixture({coreCovered:()=>covered,getCleanWitness:current=>({entryId:'note',writer:current.writer,generation:current.snapshot.generation,content:current.snapshot.draft,revision:'core-r2'})});
  f.helper.markInventory('ready');const dirty=capture('Final exact body',4);
  f.helper.capture({...dirty,snapshot:{...dirty.snapshot,checkpointRevision:'old-checkpoint',pendingOperation:Object.freeze({ref:'original-core-operation'})}});
  await f.helper.flush();covered=true;
  const clean={...dirty,snapshot:{...dirty.snapshot,baseline:{...dirty.snapshot.baseline,revision:'core-r2',content:'Final exact body'},checkpointRevision:'confirmed-checkpoint',pendingOperation:null}};
  f.helper.capture(clean);await f.helper.flush();
  assert.equal(f.writes.length,2);assert.equal(f.writes[0].pendingOperation,'{"ref":"original-core-operation"}');
  assert.equal(f.writes[1].baseline.revision,'core-r2');assert.equal(f.writes[1].baseline.content,'Final exact body');assert.equal(f.writes[1].checkpointRevision,'confirmed-checkpoint');assert.equal(f.writes[1].pendingOperation,null);
  assert.equal(f.retirements.length,1);assert.equal(f.retirements[0].expectedRevision,f.writes[1].nextRevision);assert.equal(f.helper.status.protection?.retiredSequence,2);assert.equal(f.helper.status.currentJournalAcknowledged,true);f.helper.stop();
  const startup=fixture({coreCovered:()=>true});startup.helper.markInventory('ready');startup.helper.capture(clean);await startup.helper.flush();assert.equal(startup.writes.length,0);assert.equal(startup.retirements.length,0);assert.equal(startup.helper.status.currentProtected,true);assert.equal(startup.helper.status.currentJournalAcknowledged,false);startup.helper.stop();
});

test('core coverage with an older generic journal acknowledgement cannot authorize latest-capture cleanup',async()=>{
  let clean=false;const f=fixture({coreCovered:()=>clean});f.helper.markInventory('ready');f.helper.capture(capture('Earlier',1));await f.helper.flush();
  assert.equal(f.helper.status.protection?.acknowledgedSequence,1);f.fail();f.helper.capture(capture('Latest',2));await until(()=>!!f.helper.status.error);
  clean=true;f.helper.coreSettled();await assert.rejects(f.helper.flush(),{code:'draft_storage_failure'});
  assert.equal(f.helper.status.currentProtected,true);assert.equal(f.helper.status.protection?.acknowledgedSequence,1);assert.equal(f.helper.status.currentJournalAcknowledged,false);f.helper.stop();
});

test('a recovered transient journal error clears after exact clean core state is acknowledged and retired',async()=>{
  let clean=false;const f=fixture({coreCovered:()=>clean,getCleanWitness:current=>({entryId:'note',writer:current.writer,generation:current.snapshot.generation,content:current.snapshot.draft,revision:'core-r2'})});
  f.fail();f.helper.markInventory('ready');const dirty=capture('Saved final body',3);f.helper.capture(dirty);await until(()=>!!f.helper.status.error);
  const uncertain=f.writes[0];clean=true;f.fail(undefined);f.helper.capture({...dirty,snapshot:{...dirty.snapshot,baseline:{...dirty.snapshot.baseline,revision:'core-r2',content:dirty.snapshot.draft},checkpointRevision:'core-confirmed'}});
  await f.helper.flush();assert.equal(f.writes[1],uncertain);assert.equal(f.writes.at(-1)!.baseline.revision,'core-r2');assert.equal(f.retirements.length,1);assert.equal(f.helper.status.error,null);f.helper.stop();
});

test('a helper-owned witness failure clears only after the same exact clean journal acknowledgement retires',async()=>{
  let clean=false,failWitness=true;const failure=error();
  const f=fixture({coreCovered:()=>clean,getCleanWitness:current=>{if(failWitness)throw failure;return{entryId:'note',writer:current.writer,generation:current.snapshot.generation,content:current.snapshot.draft,revision:'core-r2'};}});
  f.helper.markInventory('ready');const dirty=capture('Saved final body',3);f.helper.capture(dirty);await f.helper.flush();clean=true;
  f.helper.capture({...dirty,snapshot:{...dirty.snapshot,baseline:{...dirty.snapshot.baseline,revision:'core-r2',content:dirty.snapshot.draft},checkpointRevision:'core-confirmed'}});
  await assert.rejects(f.helper.flush(),value=>value===failure);assert.equal(f.helper.status.error,failure);assert.equal(f.retirements.length,0);
  failWitness=false;await f.helper.flush();assert.equal(f.writes.length,2);assert.equal(f.retirements.length,1);assert.equal(f.helper.status.error,null);f.helper.stop();
});

test('clean retirement requires a fresh matching witness and newer input stays independently unprotected',async()=>{
  let coreClean=false,witness:DraftCleanWitness|undefined;
  const f=fixture({coreCovered:current=>coreClean&&current.snapshot.generation===1,getCleanWitness:()=>witness});f.helper.markInventory('ready');f.helper.capture(capture());await f.helper.flush();
  coreClean=true;witness={entryId:'note',writer:'writer',generation:2,content:'Draft',revision:'saved-r2'};f.helper.coreSettled();await drain();assert.equal(f.retirements.length,0);
  const gate=held<void>();f.holdRetire(gate.promise);witness={...witness,generation:1};f.helper.coreSettled();await until(()=>f.retirements.length===1);
  f.helper.capture(capture('New generation',2));assert.equal(f.helper.status.currentProtected,false);gate.resolve();await until(()=>f.helper.status.currentProtected);
  assert.equal(f.retirements.length,1);assert.equal(f.retirements[0].generation,1);assert.equal(f.writes.at(-1)!.generation,2);assert.equal(f.helper.status.sequence,2);f.helper.stop();
});

test('validated current-incarnation receipt seeds the original journal lineage and foreign scope fails closed',async()=>{
  const initialReceipt={...scope,entryId:'note',writer:'writer',generation:1,revision:'7',deleted:false};const f=fixture({initialReceipt});f.helper.markInventory('ready');f.helper.capture(capture('New',2));await f.helper.flush();
  assert.equal(f.writes[0].expectedRevision,'7');assert.equal(f.writes[0].nextRevision,'8');f.helper.stop();
  const foreign=fixture({initialReceipt:{...initialReceipt,incarnationId:'old-renderer'}});foreign.helper.markInventory('ready');foreign.helper.capture(capture('New',2));await assert.rejects(foreign.helper.flush(),{code:'invalid_draft_receipt'});assert.equal(foreign.writes.length,0);foreign.helper.stop();
  assert.throws(()=>new NoteDraftProtection({provider:{scope} as IndependentDraftProvider,writesScope:{vaultId:'foreign',clientId:'client'},coreCovered:()=>false}),{code:'draft_scope_mismatch'});
});
