import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {captureDocumentRequest}=createRequire(import.meta.url)('../desktop/document-semantics.cjs');
import {createDesktopDocumentService,createDesktopDocumentRuntime} from '../src/platform/desktop-document-semantics.ts';
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

const runtimeScope={localStoreId:'store',clientId:'client'};
const runtimeUpdate={lifetime:'runtime-life',revision:'9007199254740993',source,published:snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:true,hasForegroundDemand:false,error:null} as const;
const runtimeFrame=()=>({version:1,scope:runtimeScope,update:runtimeUpdate,outcomes:[]});
const runtimeWire=(value:unknown)=>({documentRuntime:true,schemaVersion:1,ok:true,value});

test('desktop runtime transport owns admission counters across facades and preserves strict plain IPC replies',async()=>{
  const calls:unknown[]=[],runtime=createDesktopDocumentRuntime({scope:runtimeScope,subscribe:()=>()=>{},invoke:async(method,args)=>{calls.push([method,args]);return runtimeWire(method==='documentRuntimeObserve'?runtimeFrame():true);}});
  assert.equal(runtime.transport.allocateSequence(),'1');assert.equal(runtime.transport.allocateRequestId(),'1');
  const unused=async()=>{throw new Error('legacy planner forbidden');};
  const first=createDesktopDocumentService(unused,runtime.transport),second=createDesktopDocumentService(unused,runtime.transport);
  assert.ok(first.service.maintenance);assert.ok(second.service.maintenance);
  assert.equal(runtime.transport.allocateSequence(),'2');assert.equal(runtime.transport.allocateRequestId(),'2');
  assert.deepEqual(await runtime.transport.observe(),runtimeFrame());
  await runtime.transport.ackControl({sequence:'18446744073709551615'});await runtime.transport.ackOutcome({lifetime:'runtime-life',id:'9007199254740993'});
  assert.deepEqual(calls,[['documentRuntimeObserve',[]],['documentRuntimeAckControl',[{sequence:'18446744073709551615'}]],['documentRuntimeAckOutcome',[{lifetime:'runtime-life',id:'9007199254740993'}]]]);
  await first.release();await second.release();runtime.retire();
});

test('desktop runtime ignores malformed envelopes and requires true ACK before retiring delivery ownership',async()=>{
  let value:unknown=runtimeWire(true);
  const runtime=createDesktopDocumentRuntime({scope:runtimeScope,subscribe:()=>()=>{},invoke:async()=>value});
  for(const malformed of [
    {documentRuntime:false,schemaVersion:1,ok:true,value:true}, {...runtimeWire(true),extra:true},
    {documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_busy',source:'host',commitUncertain:false,raw:'/secret'}},
    {documentRuntime:true,schemaVersion:1,ok:false,error:{code:'private path /secret',source:'host',commitUncertain:false}},
    runtimeWire({accepted:true}),
  ]){value=malformed;await assert.rejects(()=>runtime.transport.ackControl({sequence:'1'}),(error:any)=>error.code==='document_runtime_invalid_result');}
  value={documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_transport_lost',source:'host',commitUncertain:true}};
  await assert.rejects(()=>runtime.transport.observe(),(error:any)=>error.code==='document_runtime_transport_lost'&&error.commitUncertain===true);
  value=runtimeWire(true);await runtime.transport.ackOutcome({lifetime:'runtime-life',id:'1'});runtime.retire();
});

test('desktop runtime retirement is authoritative and once-only; unsubscribing removes only that receiver',()=>{
  const receivers:{changed:()=>void;retired:()=>void;stops:number}[]=[];
  const runtime=createDesktopDocumentRuntime({scope:runtimeScope,invoke:async()=>runtimeWire(runtimeFrame()),subscribe(changed,retired){const receiver={changed,retired,stops:0};receivers.push(receiver);return()=>receiver.stops++;}});
  let changed=0,retired=0;
  const stop=runtime.transport.subscribe(()=>changed++,()=>retired++);receivers[0].changed();assert.equal(changed,1);stop();receivers[0].changed();assert.equal(changed,1);assert.equal(retired,0);
  runtime.transport.subscribe(()=>changed++,()=>retired++);receivers[1].retired();receivers[1].retired();runtime.retire();
  assert.equal(retired,1);assert.equal(receivers[0].stops,1);assert.equal(receivers[1].stops,1);
  assert.throws(()=>runtime.transport.allocateSequence(),(error:any)=>error.code==='client_not_admitted');
  runtime.transport.subscribe(()=>assert.fail('retired change'),()=>retired++);assert.equal(retired,2);
});

test('desktop freshness cancels before admission without issuing a backend request and retires after final release',async()=>{
  let observes=0,controls=0;const runtime=createDesktopDocumentRuntime({scope:runtimeScope,subscribe:()=>()=>{},invoke:async(method)=>{if(method==='documentRuntimeObserve'){observes++;return runtimeWire(runtimeFrame());}controls++;return runtimeWire(true);}});
  const binding=createDesktopDocumentService(async()=>assert.fail('No low-level maintenance'),runtime.transport);
  const handle=binding.service.maintenance!.requestFreshness();assert.equal(typeof handle.cancel,'function');await handle.cancel();
  await assert.rejects(handle.result,(error:any)=>error.code==='document_runtime_cancelled');assert.equal(observes,0);assert.equal(controls,0);
  const listener=await binding.service.maintenance!.observeAndSubscribe(()=>{});assert.equal(listener.snapshot?.revision,'9007199254740993');
  await binding.release();runtime.retire();
  assert.throws(()=>binding.service.maintenance!.requestFreshness(),(error:any)=>error.code==='document_runtime_retired');
});

test('desktop lost admission ACK retries the exact sequence before cancelling and consumes same-revision outcomes',async()=>{
  const controls:any[]=[],acks:any[]=[];let admitted=0;
  const frame:any=runtimeFrame();
  const runtime=createDesktopDocumentRuntime({scope:runtimeScope,subscribe:()=>()=>{},invoke:async(method,args)=>{
    if(method==='documentRuntimeObserve')return runtimeWire(structuredClone(frame));
    if(method==='documentRuntimeControl'){
      const input=structuredClone(args[0]) as any;controls.push(input);
      if(input.command.kind==='request'){
        if(admitted++===0)return {documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_transport_lost',source:'host',commitUncertain:true}};
      }else frame.outcomes=[{lifetime:input.command.lifetime,outcome:{kind:'cancelled',id:input.command.id}}];
      return runtimeWire({...input,frame:structuredClone(frame)});
    }
    acks.push([method,structuredClone(args[0])]);return runtimeWire(true);
  }});
  const binding=createDesktopDocumentService(async()=>assert.fail('No legacy planner'),runtime.transport),handle=binding.service.maintenance!.requestFreshness();
  await assert.rejects(handle.result,(error:any)=>error.code==='document_runtime_transport_lost');
  await handle.cancel();assert.equal(controls.length,3);assert.deepEqual(controls[0],controls[1]);assert.equal(controls[2].command.kind,'cancel');
  assert.equal(controls[2].command.id,controls[0].command.id);assert.equal(controls[2].command.lifetime,controls[0].command.lifetime);assert.notEqual(controls[2].sequence,controls[0].sequence);
  assert.ok(acks.some(([method])=>method==='documentRuntimeAckOutcome'));assert.equal(frame.update.revision,'9007199254740993');
  await binding.release();runtime.retire();
});

const metadataPage=(cursor:string|null=null)=>({result:{snapshot,source,coverageComplete:true,value:{snapshot,next:null,scanComplete:cursor===null,coverageComplete:true,complete:cursor===null,mode:'reset',from:null,rows:[],removedEntryIds:[]}},cursor});
test('desktop metadata capability is opt-in before open and forwards bounded metadata_rows through the real codec',async()=>{
  for(const advertised of [undefined,false,true]){
    const calls:DesktopDocumentRequest[]=[];
    const binding=createDesktopDocumentService(async input=>{const captured=captureDocumentRequest(input);calls.push(captured);const c=captured.command;
      if(c.op==='open')return opened(c.pinId);if(c.op==='close')return true;if(c.op==='metadata_rows')return richWire(true,metadataPage());throw Error('Unexpected operation');
    },undefined,{metadataRowsAvailable:advertised});
    assert.equal(binding.service.metadataRowsAvailable===true,advertised===true);assert.equal(calls.length,0,'capability must not open a generation');
    const pin=await binding.service.open();assert.equal(typeof pin.metadataRows,advertised===true?'function':'undefined');
    if(advertised){const result=await pin.metadataRows!({limit:2});assert.equal(result.result.value.mode,'reset');assert.deepEqual(calls.at(-1)!.command,{op:'metadata_rows',pinId:'1',cursor:null,limit:2});}
    await binding.release();
  }
  assert.throws(()=>createDesktopDocumentService(undefined as any,undefined,{metadataRowsAvailable:true}),{code:'invalid_document_response'});
});

test('metadata NotReady and malformed plain IPC replies remain errors rather than a legacy fallback',async()=>{
  let reply:unknown=richWire(false,{code:'not_ready',commitUncertain:false});
  const binding=createDesktopDocumentService(async input=>input.command.op==='open'?opened(input.command.pinId):input.command.op==='close'?true:reply,undefined,{metadataRowsAvailable:true});
  const pin=await binding.service.open();await assert.rejects(pin.metadataRows!(),{code:'not_ready'});
  for(const malformed of [{...richWire(true,metadataPage()),documents:false},richWire(false,{code:'search_compile',commitUncertain:false,details:{diagnostic:{}}}),richWire(false,{code:'not_ready',commitUncertain:false,internal:'secret'})]){
    reply=malformed;await assert.rejects(pin.metadataRows!(),{code:'invalid_document_response'});
  }
  reply=metadataPage();assert.equal((await pin.metadataRows!()).cursor,null,'raw admitted fixtures retain their documented reply contract');await binding.release();
});

for(const outcome of ['success','rejection'])test(`release drains metadata ${outcome} and rejects its retired reply before closing the pin`,async()=>{
  const gate=deferred<unknown>(),entered=deferred<void>(),closed:string[]=[];let fail!:(error:unknown)=>void;
  const pending=outcome==='success'?gate.promise:new Promise<unknown>((_resolve,reject)=>{fail=reject;});
  const binding=createDesktopDocumentService(async input=>{const c=input.command;if(c.op==='open')return opened(c.pinId);if(c.op==='metadata_rows'){entered.resolve();return pending;}if(c.op==='close'){closed.push(String(c.pinId));return true;}throw Error('Unexpected operation');},undefined,{metadataRowsAvailable:true});
  const pin=await binding.service.open(),read=pin.metadataRows!();await entered.promise;const rejecting=assert.rejects(read,{code:'client_not_admitted'}),release=binding.release();assert.deepEqual(closed,[]);
  await assert.rejects(pin.metadataRows!(),{code:'client_not_admitted'});
  if(outcome==='success')gate.resolve(metadataPage());else fail({code:'cancelled'});await rejecting;await release;assert.deepEqual(closed,['1']);
});
