'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {captureDocumentRequest,decodeDocumentReply,createDesktopDocumentSemantics,MAX_DOCUMENT_RESPONSE}=require('../desktop/document-semantics.cjs');
const request=(op,fields={})=>({schemaVersion:1,command:{op,...fields}});
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'9007199254740993',versions:{schema:1,extraction:'zorid-markdown-1:metadata-1',resolver:'resolver-1',query:'literal-1'}};
const source={localStoreId:'store',watermark:'9007199254740993'};
const entry={id:'note',revision:'revision',path:'😀.md',kind:'file',deleted:false};
function wire(op,value){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,op,value}));return[{documents:true,schemaVersion:1,bytes:bytes.length},bytes];}
function metadata(id='note'){return{snapshot,source,coverageComplete:true,value:{entry:{...entry,id},metadata:{entryId:id,contentRevision:'revision',properties:[{key:'config',value:{Title:'first',title:'second'}}]},exclusion:null}};}

test('semantic requests snapshot bounded known fields without accepting native capabilities',()=>{
  const input=request('base',{pinId:'1',id:'base',options:{searchTerms:['old'],clockMs:0,currentEntryId:'current-note',maxSteps:17}}),captured=captureDocumentRequest(input);
  input.command.options.searchTerms[0]='changed';
  assert.deepEqual(captured.command.options.searchTerms,['old']);
  assert.equal(captured.command.options.currentEntryId,'current-note');assert.equal(captured.command.options.maxSteps,17);
  for(const input of [
    request('metadata',{pinId:'1',id:'note',metadata:{}}),
    request('search',{pinId:'1',query:'a\nb',limit:1}),
    request('search',{pinId:'1',query:'x',limit:1001}),
    request('search',{pinId:'1',query:'x',limit:1,cursor:{snapshot}}),
    ...['bad:identity','0','01','18446744073709551616'].map(pinId=>request('open',{pinId})),
    request('base',{pinId:'1',id:'base',options:{currentRecord:{}}}),
    ...[0,-1,1.5,2000001].map(maxSteps=>request('base',{pinId:'1',id:'base',options:{maxSteps}})),
    request('base',{pinId:'1',id:'base',options:{currentEntryId:'bad:path'}}),
    request('base',{pinId:'1',id:'base',options:{searchTerms:['x'.repeat(4097)]}}),
    request('resume',{snapshot:{...snapshot,generation:'01'}}),
    request('discard',{snapshot:{...snapshot,generation:'01'}}),
    {schemaVersion:2,command:{op:'status'}},
  ])assert.throws(()=>captureDocumentRequest(input),error=>!!error.code);
});

test('typed semantic body validates marker, operation, Unicode metadata identity and page flags',()=>{
  const input=request('metadata',{pinId:'1',id:'note'}),value=metadata(),[marker,bytes]=wire('metadata',value);
  assert.deepEqual(decodeDocumentReply(input,marker,bytes),value);
  assert.deepEqual(Object.keys(decodeDocumentReply(input,marker,bytes).value.metadata.properties[0].value),['Title','title']);
  for(const [badMarker,badBytes] of [
    [{...marker,bytes:1},bytes],
    [{...marker,extra:true},bytes],
    wire('open',value),
    wire('metadata',metadata('other')),
    [{documents:true,schemaVersion:1,bytes:MAX_DOCUMENT_RESPONSE+1},Buffer.alloc(1)],
    [{documents:true,schemaVersion:1,bytes:1},Buffer.from([255])],
  ])assert.throws(()=>decodeDocumentReply(input,badMarker,badBytes),{code:'invalid_document_response'});
  assert.equal(decodeDocumentReply(request('discard',{snapshot}),...wire('discard',true)),true);
  for(const state of ['uninitialized','building','rebuild_required']){
    assert.deepEqual(decodeDocumentReply(request('status'),...wire('status',{source,state})),{source,state});
    assert.throws(()=>decodeDocumentReply(request('status'),...wire('status',{state})),{code:'invalid_document_response'});
  }
  const ready={source,state:'ready',snapshot,coveredWatermark:'9007199254740992',observedSourceHead:source.watermark,coverageComplete:true};
  assert.deepEqual(decodeDocumentReply(request('status'),...wire('status',ready)),ready);
  assert.throws(()=>decodeDocumentReply(request('status'),...wire('status',{...ready,observedSourceHead:'1'})),{code:'invalid_document_response'});
  const page={snapshot,hits:[],next:null,scanComplete:true,coverageComplete:false,complete:false,sourceBytes:0,documents:0};
  const search=request('search',{pinId:'1',query:'x',cursor:null,limit:1});
  assert.equal(decodeDocumentReply(search,...wire('search',{result:{snapshot,source,coverageComplete:false,value:page},cursor:null})).result.value.complete,false);
  for(const invalid of [{...page,complete:true},{...page,sourceBytes:16*1024*1024+1},{...page,documents:33},{...page,documents:undefined}])
    assert.throws(()=>decodeDocumentReply(search,...wire('search',{result:{snapshot,source,coverageComplete:false,value:invalid},cursor:null})),{code:'invalid_document_response'});
});

test('admitted semantic controller enforces pin identity across asynchronous replies',async()=>{
  let reply,observed;
  const controller=createDesktopDocumentSemantics({async documentCommand(client,input){observed={client,input};return reply;}},'client','store');
  reply={pinId:'1',snapshot,source,coverageComplete:true};
  await controller.invoke(request('open',{pinId:'1'}));
  reply=metadata();
  assert.equal((await controller.invoke(request('metadata',{pinId:'1',id:'note'}))).value.entry.id,'note');
  assert.equal(observed.client,'client');
  // Field insertion order is not identity. The typed identity is compared by fields.
  const reordered={versions:snapshot.versions,generation:snapshot.generation,generationEpoch:'epoch',localStoreId:'store'};
  reply={...metadata(),snapshot:reordered};
  await controller.invoke(request('metadata',{pinId:'1',id:'note'}));
  reply={...metadata(),source:{...source,watermark:'9007199254740994'}};
  await assert.rejects(controller.invoke(request('metadata',{pinId:'1',id:'note'})),{code:'invalid_document_response'});
  reply={...metadata(),snapshot:{...snapshot,generationEpoch:'foreign'}};
  await assert.rejects(controller.invoke(request('metadata',{pinId:'1',id:'note'})),{code:'invalid_document_response'});
  reply=true;
  await controller.invoke(request('close',{pinId:'1'}));
  await assert.rejects(controller.invoke(request('metadata',{pinId:'1',id:'note'})),{code:'snapshot_expired'});
});

test('semantic admission captures arguments, drains accepted queries and rejects stale owner replies',async()=>{
  const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
  const {admitDesktopFixtureClient}=require('../desktop/client-admission.cjs');
  const host=Object.create(RustVaultService.prototype),clientId='10000000-0000-4000-8000-000000000001';
  const lease={local_store_id:'store',client_id:clientId,token:'10000000-0000-4000-8000-000000000002'};
  host.capabilities=['documents'];
  let active=false,owner=true,gate=null,captured;
  host.request=async(command,bytes,reference)=>{
    if(command.method==='claim_client'){active=true;return{result:{lease}};}
    if(command.method==='release_client'){active=false;return{result:{released:true,reference:command.reference}};}
    assert.deepEqual(reference,lease);
    if(command.method==='identity')return{result:{identity:{local_store_id:'store',realm_id:null,vault_id:null}},bytes:new Uint8Array()};
    assert.equal(command.method,'documents');captured=command.request;
    const op=command.request.command.op;
    if(gate)await gate;
    const value=op==='open'?{pinId:'1',snapshot,source,coverageComplete:true}:metadata();
    const [result,body]=wire(op,value);return{result,bytes:body};
  };
  const service={host,closed:false};
  const options={fixture:true,clientId,assertOwner(){if(!owner)throw Object.assign(new Error('retired'),{code:'grant_retired'});}};
  const context=await admitDesktopFixtureClient(service,options);
  await context.documentCommand(request('open',{pinId:'1'}));
  let finish;gate=new Promise(resolve=>{finish=resolve;});
  const input=request('metadata',{pinId:'1',id:'note'}),pending=context.documentCommand(input);
  input.command.id='mutated';assert.equal(captured.command.id,'note');
  let entered=false;const releasing=context.release(()=>{entered=true;});
  await assert.rejects(context.documentCommand(request('status')),{code:'client_not_admitted'});
  assert.equal(entered,false);assert.equal(active,true);
  finish();await pending;await releasing;assert.equal(active,false);
  await assert.rejects(context.documentCommand(request('status')),{code:'client_not_admitted'});
  gate=null;
  const second=await admitDesktopFixtureClient(service,options);
  await second.documentCommand(request('open',{pinId:'1'}));
  gate=new Promise(resolve=>{finish=resolve;});
  const stale=second.documentCommand(request('metadata',{pinId:'1',id:'note'}));
  owner=false;finish();await assert.rejects(stale,{code:'grant_retired'});
  await second.retire();assert.equal(active,false);
});

test('shared codec runs without Buffer with identical UTF-8 limits and owner validation',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),module={exports:{}};
  const text=fs.readFileSync(require.resolve('../desktop/document-semantics.cjs'),'utf8');
  vm.runInNewContext(text,{module,TextEncoder,TextDecoder,Uint8Array,structuredClone,Buffer:undefined});
  const portable=module.exports;
  const accepted=request('search',{pinId:'1',query:'😀'.repeat(1024),limit:1});
  assert.equal(JSON.stringify(portable.captureDocumentRequest(accepted)),JSON.stringify(captureDocumentRequest(accepted)));
  assert.throws(()=>portable.captureDocumentRequest({...accepted,command:{...accepted.command,query:accepted.command.query+'a'}}),{code:'invalid_query'});
  const base=request('base',{pinId:'1',id:'base',options:{searchTerms:['你'.repeat(1365)],ignorePaths:['😀'.repeat(1024)],timezone:'你'.repeat(42),clockMs:0}});
  assert.equal(JSON.stringify(portable.captureDocumentRequest(base)),JSON.stringify(captureDocumentRequest(base)));
  assert.throws(()=>portable.captureDocumentRequest(request('base',{pinId:'1',id:'base',options:{timezone:'你'.repeat(43)}})),{code:'invalid_document_request'});
  assert.throws(()=>portable.captureDocumentRequest(request('base',{pinId:'1',id:'base',options:{searchTerms:Array(17).fill('😀'.repeat(1024))}})),{code:'request_limit'});
  const controller=portable.createDesktopDocumentSemantics({async documentCommand(_client,input){const op=input.command.op;const value=op==='open'?{pinId:'1',snapshot,source,coverageComplete:true}:op==='close'?true:metadata();return portable.decodeDocumentReply(input,...wire(op,value));}},'client','store');
  await controller.invoke(request('open',{pinId:'1'}));
  const result=await controller.invoke(request('metadata',{pinId:'1',id:'note'}));
  assert.equal(result.value.entry.path,'😀.md');assert.equal(JSON.stringify(Object.keys(result.value.metadata.properties[0].value)),JSON.stringify(['Title','title']));
  await controller.invoke(request('close',{pinId:'1'}));await assert.rejects(controller.invoke(request('metadata',{pinId:'1',id:'note'})),{code:'snapshot_expired'});
});
