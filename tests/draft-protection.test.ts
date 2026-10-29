import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftProtection} from '../src/ui/draft-protection.ts';
import type {DraftJournalChange,DraftJournalRetirement,DraftJournalReceipt,DraftProtectionSnapshot} from '../src/ui/draft-protection.ts';

const scope={vaultId:'vault',clientId:'client',incarnationId:'renderer-lifetime'};
function held<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const snapshot=(draft='Typed draft',generation=1):DraftProtectionSnapshot=>({generation,baseline:{entryId:'note',path:'One.md',revision:'file-before',content:'Saved source'},draft,checkpointRevision:null,pendingOperation:null});
const options=(transport:any)=>({transport:{retire:async(request:DraftJournalRetirement)=>receipt(request,true),...transport},entryId:'note',writer:'canonical-checkpoint-lineage'});
function receipt(request:DraftJournalChange|DraftJournalRetirement,deleted=false):DraftJournalReceipt{return{...scope,entryId:request.entryId,writer:request.writer,revision:request.nextRevision,generation:request.generation,deleted};}

test('journal acknowledgement does not wait for a held Rust save queue',async()=>{
  const rust=held();let rustSettled=false;void rust.promise.then(()=>{rustSettled=true;});
  const requests:DraftJournalChange[]=[],protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);return receipt(request);}}));
  const sequence=protection.offer(snapshot()),ack=await protection.flushThrough(sequence);
  assert.equal(requests.length,1);assert.equal(ack!.sequence,sequence);assert.equal(ack!.receipt.revision,'1');assert.equal(rustSettled,false);rust.resolve();
});

async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(check());}

test('offer captures strings and metadata immediately without synchronous encoding or transport',async()=>{
  const requests:DraftJournalChange[]=[],protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);return receipt(request);}}));
  const input=snapshot('Lone surrogate \ud800 remains exact') as any,original=JSON.stringify;
  let sequence:number;
  try{JSON.stringify=()=>{throw Error('No JSON on capture stack');};sequence=protection.offer(input);assert.equal(requests.length,0);}finally{JSON.stringify=original;}
  input.baseline.path='Changed after capture.md';input.draft='Changed after capture';input.generation=9;
  await protection.flushThrough(sequence!);
  assert.equal(requests[0].baseline.path,'One.md');assert.equal(requests[0].draft,'Lone surrogate \ud800 remains exact');assert.equal(requests[0].generation,1);
  assert.equal(Object.isFrozen(requests[0]),true);assert.equal(Object.isFrozen(requests[0].baseline),true);
});

test('one in-flight snapshot plus latest unsent bounds the queue and protects coalesced barriers',async()=>{
  const gate=held<DraftJournalReceipt>(),requests:DraftJournalChange[]=[];
  let active=0,maximum=0;
  const protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);active++;maximum=Math.max(maximum,active);
    try{return requests.length===1?await gate.promise:receipt(request);}finally{active--;}}}));
  const first=protection.offer(snapshot('Draft 1',1));await until(()=>requests.length===1);
  let sequence=first;for(let generation=2;generation<=100;generation++)sequence=protection.offer(snapshot(`Draft ${generation}`,generation));
  const barrier=protection.flushThrough(sequence),coalesced=protection.flushThrough(50);
  assert.equal(requests.length,1);gate.resolve(receipt(requests[0]));
  assert.equal((await barrier)!.sequence,100);assert.equal((await coalesced)!.sequence,100);
  assert.deepEqual(requests.map(request=>[request.draft,request.expectedRevision,request.nextRevision]),[['Draft 1',null,'1'],['Draft 100','1','2']]);
  assert.equal(maximum,1);assert.equal(protection.status.pending,false);
});

test('local snapshot sequence advances independently from edit generation and journal revision',async()=>{
  const requests:DraftJournalChange[]=[],protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);return receipt(request);}}));
  const first=protection.offer(snapshot('Same body',7));await protection.flushThrough(first);
  const second=protection.offer({...snapshot('Same body',7),checkpointRevision:'Rust-CAS-confirmed'});await protection.flushThrough(second);
  assert.equal(second,2);assert.deepEqual(requests.map(request=>[request.generation,request.nextRevision]),[[7,'1'],[7,'2']]);
});

test('lost journal acknowledgement retries the exact retained CAS before newer captured input',async()=>{
  const requests:DraftJournalChange[]=[],lost=Object.assign(Error('Journal ACK lost'),{commitUncertain:true});
  const protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);if(requests.length===1)throw lost;return receipt(request);}}));
  const first=protection.offer(snapshot('First exact draft',1));await assert.rejects(protection.flushThrough(first),error=>error===lost);
  assert.equal(protection.status.acknowledgedSequence,0);assert.equal(protection.status.error,lost);
  const second=protection.offer(snapshot('Newer RAM draft',2));const ack=await protection.flushThrough(second);
  assert.equal(requests[1],requests[0]);assert.deepEqual(requests.map(request=>[request.expectedRevision,request.nextRevision,request.draft]),[[null,'1','First exact draft'],[null,'1','First exact draft'],['1','2','Newer RAM draft']]);
  assert.equal(ack!.sequence,second);assert.equal(protection.status.error,null);
});

test('storage failure does not spin, drop a competing candidate or silently rebase',async()=>{
  const requests:DraftJournalChange[]=[],conflict=Object.assign(Error('Competing writer'),{code:'draft_revision_conflict',commitUncertain:false});
  const protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);throw conflict;}}));
  const first=protection.offer(snapshot('Losing candidate',1));await assert.rejects(protection.flushThrough(first),error=>error===conflict);
  for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);
  const second=protection.offer(snapshot('Newer losing candidate',2));await assert.rejects(protection.flushThrough(second),error=>error===conflict);
  assert.equal(requests.length,2);assert.equal(requests[1],requests[0]);assert.equal(protection.status.sequence,second);assert.equal(protection.status.acknowledgedSequence,0);
});

test('malformed or foreign receipts never acknowledge or replace an uncertain request',async()=>{
  for(const changed of [{entryId:'other'},{writer:'other'},{incarnationId:'other'},{clientId:'other'},{vaultId:'other'},{revision:'2'},{generation:2},{deleted:true},{extra:'untrusted'}]){
    const requests:DraftJournalChange[]=[],protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);return requests.length===1?{...receipt(request),...changed}:receipt(request);}}));
    const first=protection.offer(snapshot());await assert.rejects(protection.flushThrough(first),{code:'invalid_draft_receipt'});
    assert.equal(protection.status.acknowledgedSequence,0);await protection.flushThrough(first);assert.equal(requests[1],requests[0]);
  }
});

test('flushThrough is an exact close barrier and status never claims a domain save',async()=>{
  const gate=held<DraftJournalReceipt>(),requests:DraftJournalChange[]=[],protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){requests.push(request);return gate.promise;}}));
  assert.equal(await protection.flushThrough(0),null);const sequence=protection.offer(snapshot());let closed=false;
  const closing=protection.flushThrough(sequence).then(()=>{closed=true;});await until(()=>requests.length===1);assert.equal(closed,false);assert.equal(protection.status.pending,true);
  assert.equal('saved' in protection.status,false);assert.equal('dirty' in protection.status,false);
  gate.resolve(receipt(requests[0]));await closing;assert.equal(closed,true);assert.equal(protection.status.acknowledgedSequence,sequence);
  await assert.rejects(protection.flushThrough(sequence+1),{code:'invalid_draft_sequence'});
});

const clean=(draft='Typed draft',generation=1)=>({entryId:'note',writer:'canonical-checkpoint-lineage',generation,content:draft,revision:'confirmed-file-after'});
test('only the current verified journal acknowledgement and matching confirmed save can retire its snapshot',async()=>{
  const retired:DraftJournalRetirement[]=[],protection=new DraftProtection(options({scope,
    async compareAndSwap(request:DraftJournalChange){return receipt(request);},async retire(request:DraftJournalRetirement){retired.push(request);return receipt(request,true);}}));
  const sequence=protection.offer(snapshot()),ack=(await protection.flushThrough(sequence))!;
  assert.equal(await protection.retireKnownClean(ack,clean()),true);
  assert.deepEqual(retired,[{entryId:'note',writer:'canonical-checkpoint-lineage',incarnationId:scope.incarnationId,generation:1,expectedRevision:'1',nextRevision:'2'}]);
});

test('stale, forged, wrong-lineage or mismatched clean witnesses never retire a candidate',async()=>{
  let retireCalls=0;const protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){return receipt(request);},
    async retire(request:DraftJournalRetirement){retireCalls++;return receipt(request,true);}}));
  const sequence=protection.offer(snapshot()),ack=(await protection.flushThrough(sequence))!;
  assert.equal(await protection.retireKnownClean({...ack},clean()),false);
  for(const changed of [{entryId:'other'},{writer:'other'},{generation:2},{content:'Not the saved draft'},{revision:''}])assert.equal(await protection.retireKnownClean(ack,{...clean(),...changed}),false);
  const later=protection.offer(snapshot('Newer input',2));await protection.flushThrough(later);
  assert.equal(await protection.retireKnownClean(ack,clean()),false);assert.equal(retireCalls,0);
});

test('matching body and generation cannot retire any non-null conditional operation capture',async()=>{
  for(const pendingOperation of ['', 'exact uncertain operation',Object.freeze({phase:'conditional-plan'})]){
    let retired=0;const protection=new DraftProtection({...options({scope,async compareAndSwap(request:DraftJournalChange){return receipt(request);},
      async retire(request:DraftJournalRetirement){retired++;return receipt(request,true);}}),encodePendingOperation:()=>'{"phase":"conditional-plan"}'});
    const sequence=protection.offer({...snapshot(),pendingOperation}),ack=(await protection.flushThrough(sequence))!;
    assert.equal(await protection.retireKnownClean(ack,clean()),false);assert.equal(retired,0);
  }
});

test('a new offer cancels cleanup that has not yet issued without deleting either candidate',async()=>{
  const requests:DraftJournalChange[]=[],retired:DraftJournalRetirement[]=[],protection=new DraftProtection(options({scope,
    async compareAndSwap(request:DraftJournalChange){requests.push(request);return receipt(request);},async retire(request:DraftJournalRetirement){retired.push(request);return receipt(request,true);}}));
  const first=protection.offer(snapshot()),ack=(await protection.flushThrough(first))!,cleanup=protection.retireKnownClean(ack,clean());
  const second=protection.offer(snapshot('Later edit',2));assert.equal(await cleanup,false);await protection.flushThrough(second);
  assert.equal(retired.length,0);assert.equal(requests[1].expectedRevision,'1');assert.equal(requests[1].nextRevision,'2');assert.equal(requests[1].draft,'Later edit');
});

test('an edit during issued cleanup survives its tombstone and is protected by the following CAS',async()=>{
  const gate=held<DraftJournalReceipt>(),writes:DraftJournalChange[]=[],retired:DraftJournalRetirement[]=[],protection=new DraftProtection(options({scope,
    async compareAndSwap(request:DraftJournalChange){writes.push(request);return receipt(request);},async retire(request:DraftJournalRetirement){retired.push(request);return gate.promise;}}));
  const first=protection.offer(snapshot()),ack=(await protection.flushThrough(first))!,cleanup=protection.retireKnownClean(ack,clean());await until(()=>retired.length===1);
  const second=protection.offer(snapshot('New draft while old cleanup waits',2)),protectedLater=protection.flushThrough(second);
  assert.equal(writes.length,1);assert.equal(protection.status.pending,true);gate.resolve(receipt(retired[0],true));assert.equal(await cleanup,true);
  assert.equal((await protectedLater)!.sequence,second);assert.deepEqual(writes.map(request=>[request.expectedRevision,request.nextRevision]),[[null,'1'],['2','3']]);
  assert.equal(writes[1].draft,'New draft while old cleanup waits');assert.equal(protection.status.retiredSequence,first);assert.equal(protection.status.acknowledgedSequence,second);
});

test('lost retirement acknowledgement retries the exact tombstone before any newer CAS',async()=>{
  const events:string[]=[],writes:DraftJournalChange[]=[],retired:DraftJournalRetirement[]=[],lost=Error('Retirement ACK lost');
  const protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){writes.push(request);events.push(`write:${request.nextRevision}`);return receipt(request);},
    async retire(request:DraftJournalRetirement){retired.push(request);events.push(`retire:${request.nextRevision}`);if(retired.length===1)throw lost;return receipt(request,true);}}));
  const first=protection.offer(snapshot()),ack=(await protection.flushThrough(first))!;await assert.rejects(protection.retireKnownClean(ack,clean()),error=>error===lost);
  assert.equal(protection.status.retiredSequence,0);assert.equal(protection.status.error,lost);
  const second=protection.offer(snapshot('Newest input',2));await protection.flushThrough(second);
  assert.equal(retired[1],retired[0]);assert.deepEqual(events,['write:1','retire:2','retire:2','write:3']);assert.equal(writes[1].draft,'Newest input');
});

test('pending operation encoding is deferred and cached per immutable captured phase',async()=>{
  const phase=Object.freeze({operationId:'exact-op',content:'Large immutable submitted body'}),encoded:Readonly<object>[]=[],writes:DraftJournalChange[]=[];
  const protection=new DraftProtection({...options({scope,async compareAndSwap(request:DraftJournalChange){writes.push(request);return receipt(request);}}),
    encodePendingOperation:capture=>{encoded.push(capture);return JSON.stringify(capture);}});
  const first=protection.offer({...snapshot(),pendingOperation:phase});assert.equal(encoded.length,0);await protection.flushThrough(first);
  const second=protection.offer({...snapshot('Later typing',2),pendingOperation:phase});await protection.flushThrough(second);
  assert.equal(encoded.length,1);assert.equal(encoded[0],phase);assert.equal(writes[0].pendingOperation,writes[1].pendingOperation);
  assert.equal(typeof writes[0].pendingOperation,'string');
});

test('lost ACK retains exact encoded old phase while a newer operation phase waits separately',async()=>{
  const firstPhase=Object.freeze({operationId:'original',phase:'prepared'}),nextPhase=Object.freeze({operationId:'original',phase:'commit-uncertain'});
  const encoded:Readonly<object>[]=[],writes:DraftJournalChange[]=[],lost=Error('Lost CAS ACK');
  const protection=new DraftProtection({...options({scope,async compareAndSwap(request:DraftJournalChange){writes.push(request);if(writes.length===1)throw lost;return receipt(request);}}),
    encodePendingOperation:capture=>{encoded.push(capture);return JSON.stringify(capture);}});
  const first=protection.offer({...snapshot(),pendingOperation:firstPhase});await assert.rejects(protection.flushThrough(first),error=>error===lost);
  const second=protection.offer({...snapshot('Later input',2),pendingOperation:nextPhase});await protection.flushThrough(second);
  assert.deepEqual(encoded,[firstPhase,nextPhase]);assert.equal(writes[1],writes[0]);assert.equal(writes[1].pendingOperation,JSON.stringify(firstPhase));assert.equal(writes[2].pendingOperation,JSON.stringify(nextPhase));
});

test('mutable operation captures are rejected and encoder failure retains the latest immutable candidate',async()=>{
  const encoded:Readonly<object>[]=[],writes:DraftJournalChange[]=[],phase=Object.freeze({ref:'exact-ref'});let failing=true;
  const protection=new DraftProtection({...options({scope,async compareAndSwap(request:DraftJournalChange){writes.push(request);return receipt(request);}}),
    encodePendingOperation:capture=>{encoded.push(capture);if(failing)throw Error('Cannot encode retained phase');return JSON.stringify(capture);}});
  assert.throws(()=>protection.offer({...snapshot(),pendingOperation:{mutable:true}}),{code:'invalid_draft_operation_capture'});
  assert.equal(protection.status.sequence,0);const sequence=protection.offer({...snapshot(),pendingOperation:phase});
  await assert.rejects(protection.flushThrough(sequence),/Cannot encode/);assert.equal(writes.length,0);assert.equal(protection.status.pending,true);assert.equal(protection.status.acknowledgedSequence,0);
  failing=false;await protection.flushThrough(sequence);assert.deepEqual(encoded,[phase,phase]);assert.equal(writes[0].pendingOperation,JSON.stringify(phase));
});

test('invalid generations and foreign initial heads cannot enter the protection lineage',()=>{
  const transport={scope,async compareAndSwap(request:DraftJournalChange){return receipt(request);}},protection=new DraftProtection(options(transport));
  for(const generation of [-1,-0,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>protection.offer(snapshot('Invalid generation',generation)),{code:'invalid_draft_generation'});
  assert.equal(protection.status.sequence,0);
  const valid=receipt({...snapshot(),entryId:'note',writer:'canonical-checkpoint-lineage',expectedRevision:null,nextRevision:'4'} as DraftJournalChange);
  assert.throws(()=>new DraftProtection({...options(transport),initialReceipt:{...valid,incarnationId:'foreign'}}),{code:'invalid_draft_receipt'});
});

test('an explicit confirmed initial head advances sequentially without reading or rebasing storage',async()=>{
  const writes:DraftJournalChange[]=[],initial=receipt({...snapshot(),entryId:'note',writer:'canonical-checkpoint-lineage',expectedRevision:'3',nextRevision:'4'} as DraftJournalChange);
  const protection=new DraftProtection({...options({scope,async compareAndSwap(request:DraftJournalChange){writes.push(request);return receipt(request);}}),initialReceipt:initial});
  await protection.flushThrough(protection.offer(snapshot('Restored next capture',2)));assert.equal(writes[0].expectedRevision,'4');assert.equal(writes[0].nextRevision,'5');
});

test('negative-zero clean generation is not accepted as a confirmed cleanup witness',async()=>{
  let retired=0;const protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){return receipt(request);},
    async retire(request:DraftJournalRetirement){retired++;return receipt(request,true);}}));
  const sequence=protection.offer(snapshot('Generation zero',0)),ack=(await protection.flushThrough(sequence))!;
  assert.equal(await protection.retireKnownClean(ack,clean('Generation zero',-0)),false);assert.equal(retired,0);
});

test('two coordinators cannot overwrite competing candidates in the same incarnation and lineage',async()=>{
  let head:DraftJournalChange|undefined;const attempted:DraftJournalChange[]=[],transport={scope,
    async compareAndSwap(request:DraftJournalChange){attempted.push(request);
      if(head&&JSON.stringify(head)!==JSON.stringify(request))throw Object.assign(Error('Competing candidate retained'),{code:'draft_revision_conflict'});
      head=request;return receipt(request);
    }};
  const first=new DraftProtection(options(transport)),second=new DraftProtection(options(transport));
  await first.flushThrough(first.offer(snapshot('Protected first candidate')));
  const sequence=second.offer(snapshot('Competing second candidate'));await assert.rejects(second.flushThrough(sequence),{code:'draft_revision_conflict'});
  const later=second.offer(snapshot('Newest second candidate',2));await assert.rejects(second.flushThrough(later),{code:'draft_revision_conflict'});
  assert.equal(head!.draft,'Protected first candidate');assert.equal(attempted[2],attempted[1]);assert.equal(attempted[1].draft,'Competing second candidate');assert.equal(second.status.acknowledgedSequence,0);
});

test('malformed retirement receipt never clears a protected candidate or consumes its exact retry',async()=>{
  const retired:DraftJournalRetirement[]=[],protection=new DraftProtection(options({scope,async compareAndSwap(request:DraftJournalChange){return receipt(request);},
    async retire(request:DraftJournalRetirement){retired.push(request);return receipt(request,retired.length!==1);}}));
  const sequence=protection.offer(snapshot()),ack=(await protection.flushThrough(sequence))!;
  await assert.rejects(protection.retireKnownClean(ack,clean()),{code:'invalid_draft_receipt'});assert.equal(protection.status.retiredSequence,0);
  assert.equal(await protection.retireKnownClean(ack,clean()),true);assert.equal(retired[1],retired[0]);assert.equal(protection.status.retiredSequence,sequence);
});

test('exhausted revision counter fails explicitly while retaining the offered candidate',async()=>{
  let writes=0;const initial=receipt({...snapshot(),entryId:'note',writer:'canonical-checkpoint-lineage',expectedRevision:null,nextRevision:'18446744073709551615'} as DraftJournalChange);
  const protection=new DraftProtection({...options({scope,async compareAndSwap(request:DraftJournalChange){writes++;return receipt(request);}}),initialReceipt:initial});
  const sequence=protection.offer(snapshot('Still retained'));
  await assert.rejects(protection.flushThrough(sequence),{code:'draft_revision_exhausted'});assert.equal(writes,0);assert.equal(protection.status.pending,true);assert.equal(protection.status.acknowledgedSequence,0);
});
