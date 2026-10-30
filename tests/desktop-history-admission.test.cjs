'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');
const {admitDesktopFixtureClient}=require('../desktop/client-admission.cjs');
const clientId='10000000-0000-4000-8000-000000000001',lease={local_store_id:'store',client_id:clientId,token:'10000000-0000-4000-8000-000000000002'};
const version={snapshotId:'2',entryId:'entry',path:'Note.md',capturedAtMs:100,byteLength:3};
function fixture(){
 const calls=[],host=Object.create(RustVaultService.prototype);let current=true,readGate;
 host.request=async(command,bytes,reference,beforeDispatch)=>{
  if(command.method==='recovery_read'&&readGate){readGate.enter();await readGate.promise;}
  beforeDispatch?.();calls.push({command:structuredClone(command),reference});
  if(command.method==='claim_client')return{result:{lease}};
  if(command.method==='release_client')return{result:{released:true,reference:command.reference}};
  if(command.method==='identity')return{result:{identity:{local_store_id:'store',realm_id:null,vault_id:null}}};
  assert.deepEqual(reference,lease,'each history read must carry its exact admitted Native lease');
  if(command.method==='recovery_list')return{result:{versions:[version]}};
  if(command.method==='recovery_read')return{result:{version},bytes:Buffer.from('old')};
  throw Error('Unexpected '+command.method);
 };
 const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000});
 return{host,service,calls,holdRead(value){readGate=value;},options:{fixture:true,clientId,assertOwner(){if(!current)throw Object.assign(Error('retired'),{code:'grant_retired'});}},retire(){current=false;}};
}
test('admitted history methods carry Native lease, exact snapshot and detached cursor',async()=>{
 const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);
 assert.equal(context.recoveryHistoryAvailable,true);const cursor={captured_at_ms:101,snapshot_id:'3'};
 const page=await context.recoveryList('entry',{limit:20,before:cursor});assert.equal(page.versions[0].snapshotId,'2');cursor.snapshot_id='9';
 assert.equal(f.calls.find(row=>row.command.method==='recovery_list').command.before.snapshot_id,'3');
 assert.equal((await context.recoveryRead('entry','2')).content,'old');
 f.retire();await assert.rejects(context.recoveryRead('entry','2'),{code:'grant_retired'});
 assert.equal(f.calls.filter(row=>row.command.method==='recovery_read').length,1);
 await context.retire();
});
test('preload typed history invocation preserves host error provenance and rejects unknown methods',async()=>{
 let bridge,context;const calls=[];
 context=vm.createContext({require:()=>({contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{async invoke(...args){calls.push(structuredClone(args));return vm.runInContext('({ok:false,error:{code:"storage_busy",commitUncertain:false}})',context);}},webUtils:{}})});
 vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../desktop/preload.cjs'),'utf8'),context);context.bridge=bridge;
 const reply=await vm.runInContext('bridge.durableRequest({kind:"invoke",vault:"/fixture",admissionId:"admitted",method:"recoveryRead",args:["entry","2"]})',context);
 assert.equal(reply.error.source,'host');assert.equal(reply.error.code,'storage_busy');assert.deepEqual(calls[0],['zorid:durableInvoke','/fixture','admitted','recoveryRead',['entry','2']]);
 const denied=await vm.runInContext('bridge.durableRequest({kind:"invoke",vault:"/fixture",admissionId:"admitted",method:"historyWrite",args:[]})',context);assert.equal(denied.error.source,'protocol');assert.equal(calls.length,1);
});


test('actual Core history rejects foreign admissions and an old frame before its queued Native body read',async()=>{
 const {createRequire}=require('node:module'),{WindowBroker}=require('../desktop/window-broker.cjs'),f=fixture();
 f.service.root='/fixture';f.service.close=async()=>{f.service.closed=true;f.host.exited=true;};
 const filename=path.resolve(__dirname,'../desktop/editor-core.cjs'),sourceRequire=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,process,structuredClone,setTimeout,clearTimeout,require(name){
  if(name==='node:fs/promises')return{realpath:async value=>value};if(name==='./host-location.cjs')return{resolveDesktopHost:async()=>'/trusted/host'};if(name==='./vault-service.cjs')return{VaultService:{open:async()=>f.service}};return sourceRequire(name);
 }});
 const manager=module.exports.createEditorCoreManager({}),broker=new WindowBroker({openVault:root=>manager.open(root),allowedURL:()=>true});
 const record=broker.register({webContents:{id:1,mainFrame:{url:'https://zorid.test/'},isDestroyed:()=>false},isDestroyed:()=>false});record.clientSlot={clientId};await broker.select(record,'/fixture');record.persistedVaultRoot='/fixture';
 const context=await manager.context(broker,record,'/fixture'),event={sender:record.window.webContents,senderFrame:record.window.webContents.mainFrame};let release;
 try{
  assert.equal(context.recoveryHistoryAvailable,true);await assert.rejects(manager.invoke(broker,record,event,'/fixture','foreign','recoveryRead',['entry','2']),{code:'durable_scope_changed'});
  let enter;const entered=new Promise(resolve=>{enter=resolve;});f.holdRead({promise:new Promise(resolve=>{release=resolve;}),enter});
  const work=manager.invoke(broker,record,event,'/fixture',context.admissionId,'recoveryRead',['entry','2']),rejected=assert.rejects(work,{code:'durable_scope_changed'});await entered;
  record.window.webContents.mainFrame={url:'https://zorid.test/'};release();await rejected;
  assert.equal(f.calls.filter(row=>row.command.method==='recovery_read').length,0,'the obsolete frame cannot dispatch a Native history body read');
 }finally{release?.();await manager.close();}
});
