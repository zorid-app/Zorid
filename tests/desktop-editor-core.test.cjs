'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {createRequire}=require('node:module');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({admission,options={}}={}){
  const opened=[],closed=deferred();
  const filename=path.resolve(__dirname,'../desktop/editor-core.cjs');
  const sourceRequire=createRequire(filename);
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,process,structuredClone,require(name){
    if(name==='node:fs/promises')return {realpath:async value=>value};
    if(name==='./vault-service.cjs')return {VaultService:{async open(root,configuration){
      const service={root,configuration,closed:false,subscribe(){return ()=>{};},async close(){this.closed=true;if(opened[0]===this)await closed.promise;}};
      opened.push(service);return service;
    }}};
    if(name==='./host-location.cjs')return {resolveDesktopHost:async()=>'/trusted/host'};
    if(name==='./client-admission.cjs')return {admitDesktopFixtureClient:admission?async()=>admission:assert.fail};
    // Unmocked dependencies resolve beside the evaluated production module.
    return sourceRequire(name);
  }});
  const manager=module.exports.createEditorCoreManager({},options);
  const broker=new WindowBroker({openVault:directory=>manager.open(directory),allowedURL:()=>true});
  let id=0;
  const window=()=>broker.register({webContents:{id:++id,mainFrame:{url:'https://zorid.test/'},isDestroyed:()=>false},isDestroyed:()=>false});
  return {manager,broker,window,opened,closed};
}
test('last-window retirement fences opens until close and preserves the rebound entry',async()=>{
  const f=fixture(),a=f.window(),b=f.window();
  await f.broker.select(a,'/vault');
  const old=f.opened[0];f.broker.remove(a);
  const retiring=f.manager.retire(f.broker,a,old);
  let selected=false;
  const opening=f.broker.select(b,'/vault').then(()=>{selected=true;});
  await tick();
  assert.equal(old.closed,true);assert.equal(selected,false);assert.equal(f.opened.length,1);
  f.closed.resolve();await retiring;await opening;
  assert.equal(f.opened.length,2);assert.notEqual(b.vault.service,old);
  assert.equal(f.broker.vaults.get('/vault'),b.vault);
  await f.manager.close();
});
test('selection that already received the retiring service retries rather than binding it',async()=>{
  const f=fixture(),a=f.window(),b=f.window(),received=deferred(),resume=deferred();
  await f.broker.select(a,'/vault');const old=f.opened[0];
  let delay=true;
  f.broker.openVault=async directory=>{const service=await f.manager.open(directory);if(delay){delay=false;received.resolve();await resume.promise;}return service;};
  const selection=f.broker.select(b,'/vault');await received.promise;
  f.broker.remove(a);const retiring=f.manager.retire(f.broker,a,old);
  resume.resolve();await tick();assert.equal(b.vault,null);
  f.closed.resolve();await retiring;await selection;
  assert.equal(b.vault.service,f.opened[1]);assert.equal(f.broker.vaults.get('/vault'),b.vault);
  await f.manager.close();
});
test('finishing old retirement cannot delete a replacement broker entry',async()=>{
  const f=fixture(),a=f.window();await f.broker.select(a,'/vault');
  const old=f.opened[0];f.broker.remove(a);const retiring=f.manager.retire(f.broker,a,old);
  await tick();const replacement={service:{root:'/vault'},members:new Set()};f.broker.vaults.set('/vault',replacement);
  f.closed.resolve();await retiring;assert.equal(f.broker.vaults.get('/vault'),replacement);
  await f.manager.close();
});

test('failed retirement keeps the root fenced instead of admitting an uncertain old owner',async()=>{
  const f=fixture(),a=f.window();await f.broker.select(a,'/vault');
  const old=f.opened[0];old.close=async()=>{throw Object.assign(new Error('close failed'),{code:'close_failed'});};
  f.broker.remove(a);await assert.rejects(f.manager.retire(f.broker,a,old),{code:'close_failed'});
  await assert.rejects(f.manager.open('/vault'),{code:'close_failed'});assert.equal(f.opened.length,1);
  await assert.rejects(f.manager.close(),{code:'close_failed'});
});

test('vault selection fences late durable admission before the destination is persisted',async()=>{
  const f=fixture(),a=f.window();await f.broker.select(a,'/vault');
  a.persistedVaultRoot='/vault';a.vaultSelectionPending=true;
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'durable_scope_changed'});
  f.closed.resolve();await f.manager.close();
});

test('runtime delivery is positive only behind the trusted coherent switch and complete guarded admission',async()=>{
  const admission={scope:{vaultId:'store',clientId:'client'},documentRuntime:{observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){return()=>{};}},async retire(){}};
  for(const enabled of [false,true]){
    const f=fixture({admission,options:{documentRuntime:enabled,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
    const context=await f.manager.context(f.broker,a,'/vault');assert.equal(context.documentMaintenance,enabled?true:undefined);assert.equal(f.opened[0].configuration.coreFixture.documentRuntime,enabled);
    f.closed.resolve();await f.manager.close();
  }
  for(const documentRuntime of [undefined,{observe(){}}]){
    let retired=0;const f=fixture({admission:{...admission,documentRuntime,async retire(){retired++;}},options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
    await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'unsupported_host_capability'});assert.equal(retired,1);f.closed.resolve();await f.manager.close();
  }
});

test('runtime IPC guards exact admission and controls; failed release retains receivers until authoritative retirement',async()=>{
  const frame={version:1,scope:{localStoreId:'store',clientId:'client'},update:null,outcomes:[]};
  let changed,retired,stops=0,failRelease=true,calls=0;const messages=[];
  const admission={scope:{vaultId:'store',clientId:'client'},documentRuntime:{
    async observe(){calls++;return frame;},async control(input){calls++;return {...input,frame};},async ackControl(){return true;},async ackOutcome(){return true;},
    subscribe(listener,onRetire){changed=listener;retired=onRetire;return()=>stops++;},
  },async release(){if(failRelease)throw new Error('lost release ACK');retired();},async retire(){retired();}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge:(_record,message)=>messages.push(structuredClone(message))}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
  const invoke=(method,args=[])=>f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,method,args);
  changed();changed();assert.deepEqual(messages.map(value=>Object.keys(value).sort()),[['admissionId','vault'],['admissionId','vault']]);
  const control={sequence:'18446744073709551615',command:{kind:'cancel',lifetime:'life',id:'9007199254740993'}};
  assert.deepEqual(await invoke('documentRuntimeControl',[control]),{...control,frame});
  await assert.rejects(invoke('documentRuntimeControl',[{sequence:'1',command:{kind:'retire'}}]),{code:'invalid_document_request'});
  await assert.rejects(invoke('documentRuntimeStep',[]),{code:'invalid_durable_request'});assert.equal(calls,1);
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault','foreign','documentRuntimeObserve',[]),{code:'durable_scope_changed'});
  await assert.rejects(f.manager.release(f.broker,a,event,'/vault',context.admissionId),/lost release ACK/);assert.equal(stops,0);assert.deepEqual(await invoke('documentRuntimeObserve'),frame);
  failRelease=false;await f.manager.release(f.broker,a,event,'/vault',context.admissionId);assert.equal(stops,1);assert.equal(messages.at(-1).retired,true);
  const count=messages.length;changed();retired();assert.equal(messages.length,count);
  await assert.rejects(invoke('documentRuntimeObserve'),{code:'durable_scope_changed'});f.closed.resolve();await f.manager.close();
});

test('late runtime observation cannot cross a changed window generation',async()=>{
  const pending=deferred();let changed;
  const admission={scope:{vaultId:'store',clientId:'client'},documentRuntime:{observe:()=>pending.promise,control(){},ackControl(){},ackOutcome(){},subscribe(listener){changed=listener;return()=>{};}},async retire(){}};
  const messages=[],f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge:(_record,message)=>messages.push(message)}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
  const observing=f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentRuntimeObserve',[]);a.generation++;
  changed();assert.equal(messages.length,0);pending.resolve({version:1,scope:{localStoreId:'store',clientId:'client'},update:null,outcomes:[]});
  await assert.rejects(observing,{code:'durable_scope_changed'});f.closed.resolve();await f.manager.close();
});

test('synchronous runtime retirement during admission cannot advertise a dead capability',async()=>{
  let retired=0,stopped=0;
  const admission={scope:{vaultId:'store',clientId:'client'},documentRuntime:{observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){onRetire();return()=>stopped++;}},async retire(){retired++;}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'client_not_admitted'});assert.equal(stopped,1);assert.equal(retired,1);f.closed.resolve();await f.manager.close();
});

test('an existing retired runtime context cannot be readmitted or dispatch another public command',async()=>{
  let retired;
  const admission={scope:{vaultId:'store',clientId:'client'},documentRuntime:{observe(){assert.fail('No revoked observation');},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){retired=onRetire;return()=>{};}},async retire(){}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};retired();
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'client_not_admitted'});
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentRuntimeObserve',[]),{code:'client_not_admitted'});f.closed.resolve();await f.manager.close();
});

test('authoritative runtime retirement before a lost release ACK preserves only exact release retry',async()=>{
  let retired,calls=0,stopped=0;
  const admission={scope:{vaultId:'store',clientId:'client'},documentRuntime:{observe(){assert.fail('No revoked observation');},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){retired=onRetire;return()=>stopped++;}},
    async release(){retired();if(++calls===1)throw new Error('outer release ACK lost');},async retire(){}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
  await assert.rejects(f.manager.release(f.broker,a,event,'/vault',context.admissionId),/outer release ACK lost/);assert.equal(stopped,0);
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'client_not_admitted'});
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentRuntimeObserve',[]),{code:'client_not_admitted'});
  await assert.rejects(f.manager.release(f.broker,a,event,'/vault','foreign'),{code:'durable_scope_changed'});
  await f.manager.release(f.broker,a,event,'/vault',context.admissionId);await f.manager.release(f.broker,a,event,'/vault',context.admissionId);
  assert.equal(calls,2);assert.equal(stopped,1);f.closed.resolve();await f.manager.close();
});

test('editor admission carries positive metadata capability before open and rejects a missing document method',async()=>{
  for(const advertised of [undefined,false,true]){
    const admission={scope:{vaultId:'store',clientId:'client'},metadataRowsAvailable:advertised,async documentCommand(){assert.fail('No pre-open metadata call');},async retire(){}};
    const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';const context=await f.manager.context(f.broker,a,'/vault');
    assert.equal(context.metadataRowsAvailable,advertised===true?true:undefined);assert.equal(context.documentSemantics,true);f.closed.resolve();await f.manager.close();
  }
  let retired=0;const f=fixture({admission:{scope:{vaultId:'store',clientId:'client'},metadataRowsAvailable:true,async retire(){retired++;}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'unsupported_host_capability'});assert.equal(retired,1);f.closed.resolve();await f.manager.close();
});
