'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {captureDocumentRuntimeRequest:request,captureDocumentRuntimeReply:reply,MAX_DOCUMENT_REQUEST}=require('../desktop/document-semantics.cjs');
const max='18446744073709551615',scope={localStoreId:'store',clientId:'client'};
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:max,versions:{schema:2,extraction:'v1',resolver:'v1',query:'v1'}};
const source={localStoreId:'store',watermark:max};
const update={lifetime:'life',revision:max,source,published:snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:true,hasForegroundDemand:false,error:null};
const observation={source,published:snapshot,current:true,rebuildRequired:false,coverageComplete:true};
const frame=()=>({version:1,scope:{...scope},update:structuredClone(update),outcomes:[]});
const control=()=>({sequence:max,command:{kind:'request',lifetime:'life',id:max,maxPumps:128,maxRestarts:2,forceRebuild:true}});
const decode=(value,method='documentRuntimeObserve',args=[])=>reply(method,args,value,scope);

test('desktop runtime admits only exact own-demand controls and keeps u64 counters as decimal strings',()=>{
  const value=control(),captured=request('documentRuntimeControl',[value]);value.command.maxPumps=1;
  assert.equal(captured[0].command.maxPumps,128);assert.equal(captured[0].sequence,max);
  assert.deepEqual(request('documentRuntimeControl',[{sequence:'1',command:{kind:'cancel',lifetime:'life',id:'0'}}]),[{sequence:'1',command:{kind:'cancel',lifetime:'life',id:'0'}}]);
  for(const invalid of [
    {sequence:'01',command:control().command},{sequence:'18446744073709551616',command:control().command},
    {sequence:9007199254740992,command:control().command},{...control(),extra:true},
    {sequence:'1',command:{...control().command,maxPumps:129}},{sequence:'1',command:{...control().command,maxRestarts:3}},
    {sequence:'1',command:{kind:'wake',monotonicMs:1}},{sequence:'1',command:{kind:'retire'}},
    {sequence:'1',command:{kind:'complete',result:{current:true}}},{sequence:'1',command:{kind:'step',effectId:'1'}},
    {sequence:'1',command:{kind:'cancel',lifetime:'life',id:'1',clientId:'other'}},
  ])assert.throws(()=>request('documentRuntimeControl',[invalid]),{code:'invalid_document_request'});
  for(const method of ['documentRuntimeStep','documentRuntimeContinue','documentRuntimeRetire'])assert.throws(()=>request(method,[]),{code:'invalid_document_request'});
});

test('desktop runtime rejects unknown reports, foreign scopes and invalid counter/ACK shapes',()=>{
  assert.deepEqual(decode(frame()),frame());
  for(const value of [
    {...frame(),scope:{...scope,clientId:'foreign'}},{...frame(),inFlight:null},
    {...frame(),update:{...update,revision:9007199254740992}},
    {...frame(),update:{...update,source:{...source,watermark:'01'}}},
    {...frame(),update:{...update,progress:{prepared:2,total:1,ready:false}}},
    {...frame(),outcomes:[{lifetime:'life',outcome:{kind:'finished',id:'1',observation:{...observation,current:true,published:null}}}]},
    {...frame(),outcomes:[{lifetime:'life',outcome:{kind:'retired',id:'1',raw:'/secret'}}]},
    {...frame(),outcomes:Array.from({length:33},(_,id)=>({lifetime:'life',outcome:{kind:'cancelled',id:String(id)}}))},
  ])assert.throws(()=>decode(value),{code:'invalid_document_response'});
  const input=control(),ack={sequence:input.sequence,command:input.command,frame:frame()};
  assert.deepEqual(decode(ack,'documentRuntimeControl',[input]),ack);
  assert.throws(()=>decode({...ack,sequence:'1'},'documentRuntimeControl',[input]),{code:'invalid_document_response'});
  assert.throws(()=>decode({...ack,command:{...input.command,id:'1'}},'documentRuntimeControl',[input]),{code:'invalid_document_response'});
  assert.equal(decode(true,'documentRuntimeAckControl',[{sequence:'1'}]),true);
  assert.throws(()=>decode({accepted:true},'documentRuntimeAckOutcome',[{lifetime:'life',id:'1'}]),{code:'invalid_document_response'});
});

test('32 maximum-width retained outcomes fit the unchanged 64KiB runtime frame bound without truncation',()=>{
  const wide='x'.repeat(128),wideScope={localStoreId:wide,clientId:wide};
  const wideSource={localStoreId:wide,watermark:max};
  const wideSnapshot={localStoreId:wide,generationEpoch:wide,generation:max,versions:{schema:4294967295,extraction:wide,resolver:wide,query:wide}};
  const wideObservation={source:wideSource,published:wideSnapshot,current:true,rebuildRequired:false,coverageComplete:true};
  const value={version:1,scope:wideScope,update:{...update,lifetime:wide,source:wideSource,published:wideSnapshot,progress:{prepared:4294967295,total:4294967295,ready:true}},outcomes:Array.from({length:32},(_,index)=>({lifetime:wide,outcome:{kind:'finished',id:String(BigInt(max)-BigInt(index)),observation:wideObservation}}))};
  assert.ok(Buffer.byteLength(JSON.stringify(value))<MAX_DOCUMENT_REQUEST);
  assert.equal(reply('documentRuntimeObserve',[],value,wideScope).outcomes.length,32);
  const duplicate=structuredClone(value);duplicate.outcomes[1]=duplicate.outcomes[0];assert.throws(()=>reply('documentRuntimeObserve',[],duplicate,wideScope),{code:'invalid_document_response'});
});
