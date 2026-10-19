import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {captureDocumentRequest}=createRequire(import.meta.url)('../desktop/document-semantics.cjs');
import {createDesktopDocumentService} from '../src/platform/desktop-document-semantics.ts';
import type {DesktopDocumentRequest} from '../src/platform/desktop-document-semantics.ts';
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}};
const source={localStoreId:'store',watermark:'2'};
const opened=(pinId:unknown)=>({pinId,snapshot,source,coverageComplete:true});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('admitted document binding owns independent pins and releases only its handles',async()=>{
  const closed:string[]=[],requests:DesktopDocumentRequest[]=[];
  const value={properties:[{key:'first',value:{z:1,a:2}}]};
  const binding=createDesktopDocumentService(async request=>{requests.push(request);const c=request.command;
    if(c.op==='open')return opened(c.pinId);
    if(c.op==='close'){closed.push(String(c.pinId));return true;}
    if(c.op==='metadata')return {snapshot,source,coverageComplete:true,value};
    throw Error('Unexpected operation');
  });
  const pins=await Promise.all(Array.from({length:4},()=>binding.service.open()));
  assert.deepEqual(pins.map(pin=>pin.pinId),['1','2','3','4']);
  await pins[1].close();assert.deepEqual(closed,['2']);
  const read=await pins[3].metadata('entry');assert.equal(read.value,value);assert.deepEqual(Object.keys(value.properties[0].value),['z','a']);
  await binding.release();assert.deepEqual(closed,['2','1','3','4']);await binding.release();assert.equal(closed.length,4);
  assert.equal(requests.every(request=>request.schemaVersion===1),true);
  await assert.rejects(()=>pins[0].metadata('entry'),error=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='client_not_admitted'));
});

test('release drains a pending open before retiring its pin and blocks new reads',async()=>{
  const pending=deferred<unknown>(),entered=deferred<void>(),closed:string[]=[];
  const binding=createDesktopDocumentService(async request=>{const c=request.command;
    if(c.op==='open'){entered.resolve();return pending.promise;}
    if(c.op==='close'){closed.push(String(c.pinId));return true;}throw Error('Unexpected operation');
  });
  const opening=binding.service.open();await entered.promise;const release=binding.release();
  await assert.rejects(()=>binding.service.status(),error=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='client_not_admitted'));
  assert.deepEqual(closed,[]);pending.resolve(opened('1'));await opening;await release;assert.deepEqual(closed,['1']);
});

test('uncertain pin cleanup retries exact handles before discarding owned stage',async()=>{
  const operations:string[]=[];let fail=true;
  const binding=createDesktopDocumentService(async request=>{const c=request.command;operations.push(c.op+('pinId'in c?':'+c.pinId:''));
    if(c.op==='open')return opened(c.pinId);if(c.op==='begin')return {snapshot};
    if(c.op==='close'&&fail){fail=false;throw {code:'transport_error'};}
    if(c.op==='close'||c.op==='discard')return true;throw Error('Unexpected operation');
  });
  await binding.service.open();await binding.service.begin();await assert.rejects(()=>binding.release());
  assert.deepEqual(operations,['open:1','begin','close:1']);await binding.release();
  assert.deepEqual(operations,['open:1','begin','close:1','close:1','discard']);
});

// IPC preserves own undefined keys; exercise the actual strict main-process codec.
test('normal Base adapter omits unset scalar options before strict IPC capture',async()=>{
  const optionsSeen:unknown[]=[];
  const binding=createDesktopDocumentService(async input=>{
    const request=captureDocumentRequest(structuredClone(input));
    const c=request.command;
    if(c.op==='open')return opened(c.pinId);
    if(c.op==='close')return true;
    if(c.op==='base'){optionsSeen.push(c.options);return {snapshot,source,coverageComplete:true,value:{}};}
    throw Error('Unexpected operation');
  });
  const pin=await binding.service.open();
  await pin.base({id:'base',options:{clockMs:0,maxRows:17,maxSteps:undefined,currentEntryId:undefined,viewIndex:undefined,timezone:undefined}});
  await pin.base({id:'base',options:{clockMs:42,viewIndex:0,maxSteps:1,currentEntryId:'entry',timezone:'UTC'}});
  assert.deepEqual(optionsSeen,[{clockMs:0,maxRows:17},{clockMs:42,viewIndex:0,maxSteps:1,currentEntryId:'entry',timezone:'UTC',maxRows:1000}]);
  await binding.release();
});

test('desktop pump preserves native parse-cache metrics as immutable service progress and supports older hosts',async()=>{
  const counters={hits:3,misses:1,unavailable:0,corrupt:1,unsupported:0};
  let includeMetrics=true;
  const binding=createDesktopDocumentService(async request=>{
    if(request.command.op==='begin')return {snapshot};
    if(request.command.op==='discard')return true;
    if(request.command.op==='pump')return {snapshot,preparedDocuments:7,reusedDocuments:2,totalDocuments:10,ready:false,...(includeMetrics?{parseCache:counters}:{})};
    throw Error('Unexpected operation');
  });
  const stage=await binding.service.begin(),current=await binding.service.pump(stage.stageId);
  assert.deepEqual(current.progress,{prepared:7,total:10,reused:2,ready:false,parseCache:{...counters}});
  assert.equal(Object.isFrozen(current.progress!.parseCache),true);
  assert.notEqual(current.progress!.parseCache,counters);
  assert.equal(Object.isFrozen(counters),false,'the caller-owned native response is not frozen or mutated');
  counters.hits=99;assert.equal(current.progress!.parseCache!.hits,3);
  includeMetrics=false;const legacy=await binding.service.pump(stage.stageId);
  assert.deepEqual(legacy.progress,{prepared:7,total:10,reused:2,ready:false});
  assert.equal(Object.hasOwn(legacy.progress!,'parseCache'),false);
  await binding.release();
});
