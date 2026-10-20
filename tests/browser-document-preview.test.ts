import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserVaultError} from '../src/core/browser-vault.ts';
import {createBrowserDocumentPreview} from '../src/core/browser-document-preview.ts';
import type {PreviewCandidate,PreviewHooks} from '../src/core/browser-document-preview.ts';
import type {EntryState} from '../src/core/browser-vault.ts';

function deferred<T>() {
  let resolve!:(value:T|PromiseLike<T>)=>void;
  let reject!:(reason?:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const error=(code:string)=>new BrowserVaultError(code,'Fixture authority rejected the preview');
const definition:EntryState={id:'base-a',path:'sample.base',kind:'file',revision:'r1',deleted:false};
async function waitForRead(stats:{reads:number}) {
  for(let turn=0;turn<100&&stats.reads===0;turn++)await Promise.resolve();
  assert.ok(stats.reads>0,'query reached its asynchronous point-read boundary');
}

/** These doubles expose resource ownership and async authority boundaries only.
 * They do not parse a Base definition or evaluate, filter, or sort any rows. */
function fixture() {
  const stats={captures:0,fences:0,definitionFences:0,reads:0,begins:0,prepared:0,
    cancelled:0,queriesFreed:0,repliesFreed:0,writes:0,valuesFreed:0};
  let active=true,ordinary=0,sourceBytes=4,replyLength=3;
  let queryDescriptor:unknown,prepareError:unknown,writeError:unknown;
  let nextCapture:Promise<PreviewCandidate|undefined>|undefined;
  let nextRead:Promise<Uint8Array>|undefined;
  let onDefinitionFence:((count:number)=>Promise<void>|void)|undefined;
  const requests:unknown[]=[],sources:Uint8Array[]=[];
  function candidate(serial:string):PreviewCandidate {
    const capture={ownerNonce:'owner-a',stageId:'stage-a',serial};
    const descriptor={capture,source:{localStoreId:'local-a',sequence:'0'},progress:{preparedFiles:1,totalFiles:3,pendingFiles:2}};
    const value={
      descriptorJson:()=>JSON.stringify(descriptor),
      sameCapture:(other:unknown)=>other===value,
      beginBase(raw:string) {
        stats.begins++;requests.push(JSON.parse(raw));
        return {
          descriptorJson:()=>JSON.stringify(queryDescriptor??{definition,sourceBytes}),
          prepareBase(bytes:Uint8Array) {
            stats.prepared++;sources.push(bytes);
            if(prepareError!==undefined)throw prepareError;
            return {
              encodedLength:()=>replyLength,
              writeInto(target:Uint8Array){stats.writes++;if(writeError!==undefined)throw writeError;target.fill(7);},
              free(){stats.repliesFreed++;},
            };
          },
          cancel(){stats.cancelled++;},
          free(){stats.queriesFreed++;},
        };
      },
      free(){stats.valuesFreed++;},
    };
    return {stage:{},stamp:{},value};
  }
  let current:PreviewCandidate|undefined=candidate('1');
  const hooks:PreviewHooks={
    assertActive(){if(!active)throw error('storage_closed');},
    isLive(value){return active&&value===current;},
    async capture(){stats.captures++;return nextCapture?await nextCapture:current;},
    async fence(value,entry){
      stats.fences++;hooks.assertActive();
      if(value!==current)throw error('index_preview_expired');
      if(entry)await onDefinitionFence?.(++stats.definitionFences);
      hooks.assertActive();if(value!==current)throw error('index_preview_expired');
    },
    async read(_value,entry,length){stats.reads++;assert.deepEqual(entry,definition);assert.equal(length,sourceBytes);return nextRead?await nextRead:new Uint8Array(length);},
    async ordinarySlots(){return ordinary;},
  };
  const registry=createBrowserDocumentPreview(hooks);
  return {registry,stats,requests,sources,hooks,candidate,
    open:(previewId='1')=>registry.open({previewId}),
    base:(previewId='1')=>registry.base({previewId,id:definition.id}),
    close:(previewId='1')=>registry.close({previewId}),
    current:()=>current,
    replace(value:PreviewCandidate|undefined){current=value;},
    revoke(){active=false;},
    ordinary(value:number){ordinary=value;},
    bytes(value:number){sourceBytes=value;},
    length(value:number){replyLength=value;},
    descriptor(value:unknown){queryDescriptor=value;},
    prepareError(value:unknown){prepareError=value;},
    writeError(value:unknown){writeError=value;},
    pendingCapture(value:Promise<PreviewCandidate|undefined>|undefined){nextCapture=value;},
    pendingRead(value:Promise<Uint8Array>|undefined){nextRead=value;},
    onDefinitionFence(value:typeof onDefinitionFence){onDefinitionFence=value;},
  };
}

test('preview IDs are canonical positive u64 decimals with their own highwater',async()=>{
  const f=fixture();
  for(const previewId of ['','0','01','-1','1.0',' 1','18446744073709551616'])
    await assert.rejects(f.open(previewId),{code:'index_invalid_request'});
  assert.equal(f.stats.captures,0);
  const opened=await f.open('18446744073709551615') as any;
  assert.equal(opened.previewId,'18446744073709551615');
  await f.close('18446744073709551615');
  await assert.rejects(f.open('1'),{code:'index_preview_expired'});
});

test('a null capture spends its ID and requests a future capture without retaining a slot',async()=>{
  const f=fixture(),value=f.current();f.replace(undefined);
  assert.equal(await f.open('7'),null);assert.equal(f.registry.slotCount(),0);assert.equal(f.registry.wantsCapture(),true);
  f.replace(value);
  await assert.rejects(f.open('7'),{code:'index_preview_expired'});
  await assert.rejects(f.open('6'),{code:'index_preview_expired'});
  assert.equal((await f.open('8') as any).previewId,'8');assert.equal(f.registry.slotCount(),1);
});

test('an existing live ID replays its exact capture without calling the producer again',async()=>{
  const f=fixture(),first=await f.open();
  assert.deepEqual(await f.open(),first);assert.equal(f.stats.captures,1);assert.equal(f.registry.slotCount(),1);
});

test('closed IDs are idempotent and a future close rejects without consuming history',async()=>{
  const f=fixture();await f.open();
  await assert.rejects(f.close('2'),{code:'index_preview_expired'});assert.equal(f.registry.slotCount(),1);
  assert.deepEqual(await f.close(),{closed:true});assert.deepEqual(await f.close(),{closed:true});
  await assert.rejects(f.open(),{code:'index_preview_expired'});await assert.rejects(f.base(),{code:'index_preview_expired'});
  assert.equal((await f.open('2') as any).previewId,'2');
});

test('ordinary pin 1 and preview 1 are unrelated but share the four-slot allowance',async()=>{
  const f=fixture();f.ordinary(1);
  for(const id of ['1','2','3'])assert.equal((await f.open(id) as any).previewId,id);
  await assert.rejects(f.open('4'),{code:'index_preview_resource'});assert.equal(f.registry.slotCount(),3);
  await f.close('1');assert.equal(f.registry.slotCount(),2);
  // The resource failure consumed ID 4; releasing the preview did not close pin 1.
  await assert.rejects(f.open('4'),{code:'index_preview_expired'});
  assert.equal((await f.open('5') as any).previewId,'5');
});

test('four weak preview handles fit when no ordinary pins are retained',async()=>{
  const f=fixture();for(const id of ['1','2','3','4'])await f.open(id);
  assert.equal(f.registry.slotCount(),4);await assert.rejects(f.open('5'),{code:'index_preview_resource'});
});

test('capture replacement expires old handles and prunes their weak slots',async()=>{
  const f=fixture(),old=await f.open();f.replace(f.candidate('2'));
  await assert.rejects(f.open(),{code:'index_preview_expired'});await assert.rejects(f.base(),{code:'index_preview_expired'});
  assert.equal(f.registry.slotCount(),0);
  const next=await f.open('2') as any;assert.notDeepEqual(next,old);assert.equal(next.capture.serial,'2');
  assert.equal(f.stats.valuesFreed,0,'the registry does not own producer wrappers');
});

test('open checks the combined slot cap again after an asynchronous capture',async()=>{
  const f=fixture(),gate=deferred<PreviewCandidate|undefined>();f.pendingCapture(gate.promise);
  const opening=f.open();await Promise.resolve();await Promise.resolve();
  assert.equal(f.stats.captures,1);
  f.ordinary(4);gate.resolve(f.current());
  await assert.rejects(opening,{code:'index_preview_resource'});assert.equal(f.registry.slotCount(),0);
});

test('open rejects a source that changes during its asynchronous authority check',async()=>{
  const f=fixture(),original=f.current()!,gate=deferred<PreviewCandidate|undefined>();f.pendingCapture(gate.promise);
  const opening=f.open();f.replace(f.candidate('2'));gate.resolve(original);
  await assert.rejects(opening,{code:'index_preview_expired'});assert.equal(f.registry.slotCount(),0);
});

test('a query keeps its exact request, point-read source object, and borrowed reply until free',async()=>{
  const f=fixture();await f.open();
  const bytes=new Uint8Array([1,2,3,4]);f.pendingRead(Promise.resolve(bytes));
  const reply=await f.registry.base({previewId:'1',id:definition.id,viewName:'All',options:{limit:2}});
  assert.deepEqual(f.requests,[{previewId:'1',id:definition.id,viewName:'All',options:{limit:2}}]);
  assert.equal(f.sources[0],bytes);assert.equal(f.stats.repliesFreed,0);assert.equal(f.stats.queriesFreed,0);
  const output=new Uint8Array(reply.length);reply.writeInto(output);assert.deepEqual([...output],[7,7,7]);await reply.validate();
  reply.free();reply.free();assert.equal(f.stats.repliesFreed,1);assert.equal(f.stats.queriesFreed,1);
});

test('the active query remains admitted through the borrowed reply handoff',async()=>{
  const f=fixture();await f.open();const reply=await f.base();
  await assert.rejects(f.base(),{code:'index_preview_busy'});assert.equal(f.stats.begins,1);
  await reply.validate();await assert.rejects(f.base(),{code:'index_preview_busy'});
  reply.free();const next=await f.base();next.free();assert.equal(f.stats.begins,2);
});

test('closing while a point read is pending discards the source and frees the query',async()=>{
  const f=fixture();await f.open();const gate=deferred<Uint8Array>();f.pendingRead(gate.promise);
  const reading=f.base();await waitForRead(f.stats);
  await f.close();gate.resolve(new Uint8Array(4));
  await assert.rejects(reading,{code:'index_preview_expired'});
  assert.equal(f.stats.prepared,0);assert.equal(f.stats.cancelled,1);assert.equal(f.stats.queriesFreed,1);
});

test('a source change during a pending point read prevents evaluation',async()=>{
  const f=fixture();await f.open();const gate=deferred<Uint8Array>();f.pendingRead(gate.promise);
  const reading=f.base();await waitForRead(f.stats);
  f.replace(f.candidate('2'));gate.resolve(new Uint8Array(4));
  await assert.rejects(reading,{code:'index_preview_expired'});assert.equal(f.stats.prepared,0);assert.equal(f.stats.queriesFreed,1);
});

test('the final asynchronous source fence discards an already prepared reply',async()=>{
  const f=fixture();await f.open();
  f.onDefinitionFence(count=>{if(count===3)f.replace(f.candidate('2'));});
  await assert.rejects(f.base(),{code:'index_preview_expired'});
  assert.equal(f.stats.prepared,1);assert.equal(f.stats.repliesFreed,1);assert.equal(f.stats.queriesFreed,1);
});

test('provider revocation during a pending read rejects completion and cleans the query',async()=>{
  const f=fixture();await f.open();const gate=deferred<Uint8Array>();f.pendingRead(gate.promise);
  const reading=f.base();await waitForRead(f.stats);f.revoke();gate.resolve(new Uint8Array(4));
  await assert.rejects(reading,{code:'storage_closed'});assert.equal(f.stats.prepared,0);assert.equal(f.stats.queriesFreed,1);
});

test('clearing handles during a pending read is safe and keeps the ID spent',async()=>{
  const f=fixture();await f.open();const gate=deferred<Uint8Array>();f.pendingRead(gate.promise);
  const reading=f.base();await waitForRead(f.stats);f.registry.clear();f.registry.clear();gate.resolve(new Uint8Array(4));
  await assert.rejects(reading,{code:'index_preview_expired'});assert.equal(f.registry.slotCount(),0);assert.equal(f.registry.wantsCapture(),false);
  await assert.rejects(f.open(),{code:'index_preview_expired'});assert.equal(f.stats.queriesFreed,1);
});

test('a borrowed reply cannot write or validate after close and still frees exactly once',async()=>{
  const f=fixture();await f.open();const reply=await f.base();await f.close();
  assert.throws(()=>reply.writeInto(new Uint8Array(reply.length)),{code:'index_preview_expired'});
  await assert.rejects(reply.validate(),{code:'index_preview_expired'});reply.free();reply.free();
  assert.equal(f.stats.writes,0);assert.equal(f.stats.repliesFreed,1);assert.equal(f.stats.queriesFreed,1);
});

test('a freed borrowed reply cannot be used again',async()=>{
  const f=fixture();await f.open();const reply=await f.base();reply.free();
  assert.throws(()=>reply.writeInto(new Uint8Array(reply.length)),{code:'index_preview_expired'});
  await assert.rejects(reply.validate(),{code:'index_preview_expired'});
});

test('a changed authority is rechecked immediately before actual reply handoff',async()=>{
  const f=fixture();await f.open();const reply=await f.base();f.replace(f.candidate('2'));
  await assert.rejects(reply.validate(),{code:'index_preview_expired'});reply.free();assert.equal(f.stats.repliesFreed,1);
});

test('source reads require the exact declared Uint8Array length',async()=>{
  for(const bytes of [new Uint8Array(3),new Uint8Array(5),[0,0,0,0] as unknown as Uint8Array]){
    const f=fixture();await f.open();f.pendingRead(Promise.resolve(bytes));
    await assert.rejects(f.base(),{code:'index_preview_expired'});assert.equal(f.stats.prepared,0);assert.equal(f.stats.queriesFreed,1);
  }
});

test('source budget accepts the boundary and rejects oversized or invalid descriptors before reading',async()=>{
  const f=fixture();await f.open();f.bytes(262144);const reply=await f.base();reply.free();assert.equal(f.sources[0]!.length,262144);
  for(const sourceBytes of [-1,1.5,262145,Number.MAX_SAFE_INTEGER+1]){
    const invalid=fixture();await invalid.open();invalid.bytes(sourceBytes);
    await assert.rejects(invalid.base(),{code:'index_preview_invalid'});assert.equal(invalid.stats.reads,0);assert.equal(invalid.stats.queriesFreed,1);
  }
});

test('a query descriptor cannot substitute another definition or a folder',async()=>{
  for(const entry of [{...definition,id:'other'},{...definition,kind:'folder'},null]){
    const f=fixture();await f.open();f.descriptor({definition:entry,sourceBytes:4});
    await assert.rejects(f.base(),{code:'index_preview_invalid'});assert.equal(f.stats.reads,0);assert.equal(f.stats.queriesFreed,1);
  }
});

test('reply transport accepts the 16 MiB limit without requiring a second serialization',async()=>{
  const f=fixture();await f.open();f.length(16*1024*1024);const reply=await f.base();
  assert.equal(reply.length,16*1024*1024);assert.equal(f.stats.writes,0);reply.free();
});

test('invalid or oversized reply lengths release the prepared reply and query',async()=>{
  for(const length of [0,-1,1.5,16*1024*1024+1,NaN,Infinity]){
    const f=fixture();await f.open();f.length(length);
    await assert.rejects(f.base(),{code:'index_preview_resource'});assert.equal(f.stats.repliesFreed,1);assert.equal(f.stats.queriesFreed,1);assert.equal(f.stats.cancelled,1);
  }
});

test('reply destination must have exactly the admitted length',async()=>{
  const f=fixture();await f.open();const reply=await f.base();
  assert.throws(()=>reply.writeInto(new Uint8Array(reply.length-1)),{code:'index_invalid_request'});
  assert.throws(()=>reply.writeInto(new Uint8Array(reply.length+1)),{code:'index_invalid_request'});
  assert.equal(f.stats.writes,0);reply.writeInto(new Uint8Array(reply.length));reply.free();
});

test('a WASM preparation resource error frees admission for a later query',async()=>{
  const f=fixture();await f.open();f.prepareError('{"code":"index_preview_resource"}');
  await assert.rejects(f.base(),{code:'index_preview_resource'});assert.equal(f.stats.queriesFreed,1);assert.equal(f.stats.cancelled,1);
  f.prepareError(undefined);const reply=await f.base();reply.free();assert.equal(f.stats.begins,2);
});

test('a failed borrowed write remains owned until caller cleanup',async()=>{
  const f=fixture();await f.open();const reply=await f.base();f.writeError('{"code":"index_preview_resource"}');
  assert.throws(()=>reply.writeInto(new Uint8Array(reply.length)),{code:'index_preview_resource'});
  await assert.rejects(f.base(),{code:'index_preview_busy'});reply.free();reply.free();assert.equal(f.stats.repliesFreed,1);assert.equal(f.stats.queriesFreed,1);
});

test('pending preview reserves the fourth combined slot across its final awaited fence',async()=>{
  const f=fixture();f.ordinary(3);const entered=deferred<void>(),finish=deferred<void>(),fence=f.hooks.fence;let visits=0;
  f.hooks.fence=async(...args)=>{await fence(...args);if(++visits===2){entered.resolve();await finish.promise;}};
  const opening=f.open();await entered.promise;
  // A concurrent ordinary pin admission consults this same count inside its
  // catalog write transaction, so it cannot take the reserved fourth slot.
  assert.equal(f.registry.slotCount(),1);assert.equal(3+f.registry.slotCount()<4,false);
  finish.resolve();assert.equal((await opening as any).previewId,'1');assert.equal(f.registry.slotCount(),1);
  await f.close();assert.equal(f.registry.slotCount(),0);
});


test('closing an allocated pending open prevents late registration or ID rebinding',async()=>{
  const f=fixture(),gate=deferred<PreviewCandidate|undefined>();f.pendingCapture(gate.promise);const opening=f.open();
  for(let turn=0;turn<100&&f.stats.captures===0;turn++)await Promise.resolve();assert.equal(f.stats.captures,1);
  assert.deepEqual(await f.close('1'),{closed:true});gate.resolve(f.current());await assert.rejects(opening,{code:'index_preview_expired'});assert.equal(f.registry.slotCount(),0);
  assert.deepEqual(await f.close('1'),{closed:true});await assert.rejects(f.open('1'),{code:'index_preview_expired'});f.pendingCapture(undefined);assert.equal((await f.open('2') as any).previewId,'2');
});
test('clear cancels its one pending open before capture admission resumes',async()=>{
  const f=fixture(),gate=deferred<number>();f.hooks.ordinarySlots=()=>gate.promise;const opening=f.open();assert.equal(f.registry.slotCount(),1);f.registry.clear();gate.resolve(0);
  await assert.rejects(opening,{code:'index_preview_expired'});assert.equal(f.stats.captures,0);assert.equal(f.registry.slotCount(),0);
});
