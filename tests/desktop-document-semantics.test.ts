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

const richSpec={query:'file:note',caseSensitive:false,sort:'nameAsc',context:'line',explain:false} as const;
const richWire=(ok:boolean,value:unknown)=>({documents:true,schemaVersion:1,ok,...(ok?{value}:{error:value})});
const emptyRichPage=()=>({result:{snapshot,source,coverageComplete:true,value:{snapshot,next:null,scanComplete:true,coverageComplete:true,complete:true,dialect:'zorid-search-rust-unicode-1',spec:richSpec,explanation:null,files:[],totals:{files:{relation:'exact',value:0},occurrences:{relation:'exact',value:0}},coverage:{candidateFiles:0,evaluatedFiles:0,unavailableFiles:0,scanComplete:true,queryCoverageComplete:true},outputComplete:true,work:{documents:0,sourceBytes:0,units:0}}},cursor:null});
test('desktop rich forwarding unwraps marked IPC data and closes query before pin',async()=>{
  const seen:unknown[]=[];let preparing=true;
  const binding=createDesktopDocumentService(async input=>{
    const c=captureDocumentRequest(structuredClone(input)).command;seen.push(c);
    if(c.op==='open')return opened(c.pinId);
    if(c.op==='rich_start')return richWire(true,{queryId:'q'});
    if(c.op==='rich_prepare'){if(preparing){preparing=false;return richWire(true,{state:'preparing'});}return richWire(true,{state:'ready',cursor:'c'});}
    if(c.op==='rich_page')return richWire(true,emptyRichPage());
    if(c.op==='rich_close')return richWire(true,true);
    if(c.op==='close')return true;
    throw Error('Unexpected operation');
  });
  assert.equal(binding.service.richSearchAvailable,true);
  const pin=await binding.service.open(),query=await pin.richSearch!({spec:richSpec});
  assert.equal(query.queryId,'q');assert.deepEqual(await query.prepare(),{state:'preparing'});const ready=await query.prepare();assert.equal(ready.state,'ready');
  if(ready.state==='ready')assert.equal((await query.page(ready.cursor)).result.value.totals.files.value,0);
  await pin.close();await binding.release();
  assert.deepEqual(seen,[{op:'open',pinId:'1'},{op:'rich_start',pinId:'1',spec:richSpec},{op:'rich_prepare',pinId:'1',queryId:'q'},{op:'rich_prepare',pinId:'1',queryId:'q'},{op:'rich_page',pinId:'1',queryId:'q',cursor:'c'},{op:'rich_close',pinId:'1',queryId:'q'},{op:'close',pinId:'1'}]);
});

test('desktop IPC rich errors preserve typed compile diagnostics and reject malformed markers',async()=>{
  const diagnostic={code:'unsupported-regex',queryRange:{bytes:[0,3],utf16:[0,3]},message:'Unsupported expression'};
  let reply:unknown=richWire(false,{code:'search_compile',commitUncertain:false,details:{diagnostic}});
  const binding=createDesktopDocumentService(async input=>input.command.op==='open'?opened(input.command.pinId):input.command.op==='close'?true:reply);
  const pin=await binding.service.open();
  await assert.rejects(()=>pin.richSearch!({spec:richSpec}),error=>{assert.equal((error as any).code,'search_compile');assert.deepEqual((error as any).diagnostic,diagnostic);return true;});
  for(const malformed of [
    {...richWire(true,{queryId:'q'}),documents:false},
    {...richWire(true,{queryId:'q'}),extra:true},
    richWire(false,{code:'search_resource',commitUncertain:false,details:{raw:'/private/internal'}}),
    richWire(false,{code:'search_compile',commitUncertain:false,details:{diagnostic:{...diagnostic,extra:true}}}),
  ]){reply=malformed;await assert.rejects(()=>pin.richSearch!({spec:richSpec}),error=>(error as any).code==='invalid_document_response');}
  await binding.release();
});
