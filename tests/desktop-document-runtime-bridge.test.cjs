'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');

function preload(invoke){
  let bridge;const ipc=new EventEmitter();ipc.invoke=invoke;
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'),'utf8'),{require(name){
    assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:ipc,webUtils:{}};
  }});
  return {bridge,ipc};
}
const copy=value=>structuredClone(value);

test('runtime controls cross contextBridge as bounded plain error envelopes',async()=>{
  let reply={ok:true,result:{accepted:true}},lost=false;
  const {bridge}=preload(async()=>{if(lost)throw new Error('/private/vault/native details');return reply;});
  for(const method of ['documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome']){
    assert.deepEqual(copy(await bridge.durableInvoke('/vault','admission',method,[])),{documentRuntime:true,schemaVersion:1,ok:true,value:{accepted:true}});
  }
  reply={ok:false,error:{code:'document_runtime_busy',commitUncertain:false,private:'/secret'}};
  assert.deepEqual(copy(await bridge.durableInvoke('/vault','admission','documentRuntimeControl',[])),{documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_busy',commitUncertain:false,source:'host'}});
  reply={ok:false,error:{code:'bad path /secret',commitUncertain:false}};
  assert.deepEqual(copy(await bridge.durableInvoke('/vault','admission','documentRuntimeControl',[])),{documentRuntime:true,schemaVersion:1,ok:false,error:{code:'invalid_document_response',commitUncertain:true,source:'host'}});
  lost=true;
  assert.deepEqual(copy(await bridge.durableInvoke('/vault','admission','documentRuntimeAckOutcome',[])),{documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_transport_lost',commitUncertain:true,source:'host'}});
});

test('dedicated runtime receiver is installed synchronously, scopes admission and removes independently of vault changes',()=>{
  const {bridge,ipc}=preload(async()=>({ok:true,result:true})),received=[],changes=[];let retirements=0;
  const stopChanges=bridge.onChange(change=>changes.push(change));
  const stop=bridge.onDocumentRuntimeNudge('/vault','admission',()=>received.push(true),()=>retirements++);
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'old'});
  ipc.emit('zorid:document-runtime',{}, {vault:'/other',admissionId:'admission'});
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'admission',extra:true});
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'admission'});
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'admission'});
  assert.deepEqual(received,[true,true]);assert.deepEqual(changes,[]);
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'admission',retired:true});
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'admission',retired:true});
  ipc.emit('zorid:document-runtime',{}, {vault:'/vault',admissionId:'admission'});assert.equal(retirements,1);assert.equal(received.length,2);
  stop();stop();assert.equal(ipc.listenerCount('zorid:change'),1);stopChanges();
  assert.throws(()=>bridge.onDocumentRuntimeNudge('/vault','',()=>{}),{name:'TypeError'});
});
