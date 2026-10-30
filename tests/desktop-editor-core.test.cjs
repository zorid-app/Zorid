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
function fixture({admission,admissionFactory,options={}}={}){
  const opened=[],closed=deferred();
  const filename=path.resolve(__dirname,'../desktop/editor-core.cjs');
  const sourceRequire=createRequire(filename);
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,process,structuredClone,require(name){
    if(name==='node:fs/promises')return {realpath:async value=>value};
    if(name==='./vault-service.cjs')return {VaultService:{async open(root,configuration){
      const service={root,configuration,host:{fatal:null,exited:false},closed:false,subscribe(){return ()=>{};},async close(){this.closed=true;if(opened[0]===this)await closed.promise;}};
      opened.push(service);return service;
    }}};
    if(name==='./host-location.cjs')return {resolveDesktopHost:async()=>'/trusted/host'};
    if(name==='./client-admission.cjs')return {admitDesktopFixtureClient:admissionFactory??(admission?async()=>admission:assert.fail)};
    // Unmocked dependencies resolve beside the evaluated production module.
    return sourceRequire(name);
  }});
  const manager=module.exports.createEditorCoreManager({},options);
  const broker=new WindowBroker({openVault:directory=>manager.open(directory),allowedURL:()=>true});
  let id=0;
  const window=()=>broker.register({webContents:{id:++id,mainFrame:{url:'https://zorid.test/'},isDestroyed:()=>false},isDestroyed:()=>false});
  return {manager,broker,window,opened,closed};
}
function bindJournal(f,record,context,assertCurrent=()=>{}){
  const grant={token:'10000000-0000-4000-8000-000000000007',scope:{...context.scope,incarnationId:'10000000-0000-4000-8000-000000000008'}};
  f.manager.bindIndependentJournal(f.broker,record,'/vault',context.admissionId,grant,assertCurrent);
  return grant;
}
test('creation receipts are advertised only by admitted consumers and use the scoped existing IPC route',async()=>{
  const calls=[],receipt={operation_id:'operation',sequence:'1',changes:[]};
  const admission={scope:{vaultId:'store',clientId:'client'},async createTextReceipt(input){calls.push(input);return receipt;},async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    assert.equal(context.textCreateReceiptsAvailable,true);
    const input={operationId:'operation',entryId:'entry',path:'New.md',content:'literal'};
    assert.deepEqual(await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'createTextReceipt',[input]),receipt);
    assert.deepEqual(calls,[input]);assert.notEqual(calls[0],input,'IPC arguments are detached');
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault','foreign','createTextReceipt',[input]),{code:'durable_scope_changed'});
    assert.equal(calls.length,1);
  }finally{f.closed.resolve();await f.manager.close();}
});
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
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){return()=>{};}},async retire(){}};
  for(const enabled of [false,true]){
    const f=fixture({admission,options:{documentRuntime:enabled,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
    const context=await f.manager.context(f.broker,a,'/vault');assert.equal(context.documentMaintenance,enabled?true:undefined);assert.equal(f.opened[0].configuration.coreFixture.documentRuntime,enabled);
    f.closed.resolve();await f.manager.close();
  }
  for(const documentRuntime of [{observe(){}}]){
    let retired=0;const f=fixture({admission:{...admission,documentRuntime,async retire(){retired++;}},options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
    await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'document_runtime_unavailable'});assert.equal(retired,1);f.closed.resolve();await f.manager.close();
  }
});

test('runtime IPC guards exact admission and controls; failed release retains receivers until authoritative retirement',async()=>{
  const frame={version:1,scope:{localStoreId:'store',clientId:'client'},update:null,outcomes:[]};
  let changed,retired,stops=0,failRelease=true,calls=0;const messages=[];
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{
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
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{observe:()=>pending.promise,control(){},ackControl(){},ackOutcome(){},subscribe(listener){changed=listener;return()=>{};}},async retire(){}};
  const messages=[],f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge:(_record,message)=>messages.push(message)}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
  const observing=f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentRuntimeObserve',[]);a.generation++;
  changed();assert.equal(messages.length,0);pending.resolve({version:1,scope:{localStoreId:'store',clientId:'client'},update:null,outcomes:[]});
  await assert.rejects(observing,{code:'durable_scope_changed'});f.closed.resolve();await f.manager.close();
});

test('synchronous runtime retirement during admission cannot advertise a dead capability',async()=>{
  let retired=0,stopped=0;
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){onRetire();return()=>stopped++;}},async retire(){retired++;}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'client_not_admitted'});assert.equal(stopped,1);assert.equal(retired,1);f.closed.resolve();await f.manager.close();
});

test('an existing retired runtime context cannot be readmitted or dispatch another public command',async()=>{
  let retired;
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{observe(){assert.fail('No revoked observation');},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){retired=onRetire;return()=>{};}},async retire(){}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};retired();
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'client_not_admitted'});
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentRuntimeObserve',[]),{code:'client_not_admitted'});f.closed.resolve();await f.manager.close();
});

test('authoritative runtime retirement before a lost release ACK preserves only exact release retry',async()=>{
  let retired,calls=0,stopped=0;
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{observe(){assert.fail('No revoked observation');},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){retired=onRetire;return()=>stopped++;}},
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

test('draft admission uses scoped existing nudge channel and never exposes trusted work',async()=>{
  let changed,retired,stops=0;const calls=[],messages=[];
  const admission={scope:{vaultId:'store',clientId:'client'},draftsAvailable:true,documentRuntime:{observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){return()=>{};}},documentCommand(){},documentDrafts:{async invoke(request,bytes){calls.push({request,bytes});return {result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};},subscribe(listener,onRetire){changed=listener;retired=onRetire;return()=>stops++;}},async retire(){retired();}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge:(_record,message)=>messages.push(structuredClone(message))}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};assert.equal(context.draftsAvailable,true);
  changed();assert.deepEqual(messages,[{vault:'/vault',admissionId:context.admissionId}]);
  await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentDrafts',[{op:'snapshot'},new Uint8Array()]);assert.equal(calls.length,1);
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentWork',[{op:'next_turn'}]),{code:'invalid_durable_request'});
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault','foreign','documentDrafts',[{op:'snapshot'},new Uint8Array()]),{code:'durable_scope_changed'});
  retired();await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'documentDrafts',[{op:'snapshot'},new Uint8Array()]),{code:'client_not_admitted'});assert.equal(messages.at(-1).retired,true);
  f.closed.resolve();await f.manager.close();assert.equal(stops,1);
});
test('positive draft admission fails closed without complete methods or scoped notifications',async()=>{
  for(const broken of [{documentDrafts:undefined},{documentCommand:undefined},{noChannel:true},{gateOff:true}]){
    let retired=0;const admission={scope:{vaultId:'store',clientId:'client'},draftsAvailable:true,documentRuntime:{observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){return()=>{};}},documentCommand(){},documentDrafts:{invoke(){},subscribe(){return()=>{};}},async retire(){retired++;},...broken};
    const f=fixture({admission,options:broken.noChannel?{}:{documentRuntime:!broken.gateOff,onDocumentRuntimeNudge(){}}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
    const code=Object.hasOwn(broken,'documentCommand')?'document_runtime_unavailable':'unsupported_host_capability';
    await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code});assert.equal(retired,1);f.closed.resolve();await f.manager.close();
  }
});


test('requested runtime rejects an older admission and retries without caching its rejected context',async()=>{
  let retired=0,releases=0,subscribed=0,stopped=0;
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},async release(){releases++;},async retire(){retired++;}};
  const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();
  await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const rejection={code:'document_runtime_unavailable',message:'The desktop core does not support document indexing. Update Zorid and restart the app.'};
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),rejection);
  await assert.rejects(f.manager.context(f.broker,a,'/vault'),rejection);
  assert.equal(retired,2);assert.equal(releases,0);
  admission.documentRuntime={observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){subscribed++;return()=>stopped++;}};
  const context=await f.manager.context(f.broker,a,'/vault');
  assert.equal(context.documentSemantics,true);assert.equal(context.documentMaintenance,true);assert.equal(subscribed,1);
  assert.equal((await f.manager.context(f.broker,a,'/vault')).admissionId,context.admissionId);assert.equal(subscribed,1);
  await f.manager.release(f.broker,a,{sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame},'/vault',context.admissionId);
  assert.equal(releases,1);assert.equal(retired,2);assert.equal(stopped,1);
  f.closed.resolve();await f.manager.close();
});

test('requested runtime rejects missing scoped delivery before opening a service',()=>{
  for(const onDocumentRuntimeNudge of [undefined,null,{}])assert.throws(()=>fixture({options:{documentRuntime:true,onDocumentRuntimeNudge}}),{code:'document_runtime_unavailable',message:'The desktop core does not support document indexing. Update Zorid and restart the app.'});
});

test('explicitly disabled runtime preserves a compatibility admission without scoped delivery',async()=>{
  let releases=0;
  const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},async release(){releases++;},async retire(){}};
  const f=fixture({admission,options:{documentRuntime:false}}),a=f.window();
  await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const context=await f.manager.context(f.broker,a,'/vault');
  assert.equal(context.documentSemantics,true);assert.equal(context.documentMaintenance,undefined);
  assert.equal(f.opened[0].configuration.coreFixture.documentRuntime,false);
  await f.manager.release(f.broker,a,{sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame},'/vault',context.admissionId);
  assert.equal(releases,1);f.closed.resolve();await f.manager.close();
});

test('requested runtime requires document commands and every runtime method before subscribing',async()=>{
  const complete={observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){assert.fail('Rejected admission must not subscribe');}};
  for(const missing of ['documentCommand',...Object.keys(complete)]){
    let retired=0;
    const admission={scope:{vaultId:'store',clientId:'client'},documentCommand(){},documentRuntime:{...complete},async retire(){retired++;}};
    if(missing==='documentCommand')delete admission.documentCommand;else delete admission.documentRuntime[missing];
    const f=fixture({admission,options:{documentRuntime:true,onDocumentRuntimeNudge(){}}}),a=f.window();
    await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
    await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'document_runtime_unavailable'});assert.equal(retired,1);
    f.closed.resolve();await f.manager.close();
  }
});


test('physical-source IPC uses a positively admitted complete triple and snapshots bounded request control',async()=>{
  const calls=[],witness={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Books/Note.md'}};
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(input){calls.push(input);return{...input,source:'score: 7'};},
    async releaseSavedSource(input){calls.push(input);},async listSavedSourceRequests(){return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    bindJournal(f,a,context);
    assert.equal(context.conditionalSavedSourceAvailable,true);
    const value=await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[witness]);
    assert.equal(value.source,'score: 7');assert.notEqual(calls[0],witness);assert.ok(Object.isFrozen(calls[0]));
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[{...witness,source:'forged'}]),{code:'invalid_saved_source'});
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault','foreign','captureSavedSource',[witness]),{code:'durable_scope_changed'});
    await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'releaseSavedSource',['capture']);
    assert.deepEqual(calls,[witness,'capture']);
  }finally{f.closed.resolve();await f.manager.close();}
});

test('positive physical-source admission rejects an incomplete pair instead of advertising a fake capability',async()=>{
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{async captureSavedSource(){}},async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{await assert.rejects(f.manager.context(f.broker,a,'/vault'),{code:'unsupported_host_capability'});}
  finally{f.closed.resolve();await f.manager.close();}
});

test('a late physical-source response is rejected after its broker generation changes',async()=>{
  const gate=deferred(),witness={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Note.md'}};
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(input){await gate.promise;return{...input,source:'private old vault'};},async releaseSavedSource(){},async listSavedSourceRequests(){return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    bindJournal(f,a,context);
    const pending=f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[witness]);
    a.generation++;gate.resolve();
    await assert.rejects(pending,{code:'durable_scope_changed'});
  }finally{f.closed.resolve();await f.manager.close();}
});

test('pending source inventory is scoped, argument-free and strictly decoded before publication',async()=>{
  const row={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Note.md'},legacy:false};
  let rows=[row],calls=0;
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(){assert.fail('inventory cannot capture');},async releaseSavedSource(){assert.fail('inventory cannot release');},
    async listSavedSourceRequests(){calls++;return rows;},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    const result=await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'listSavedSourceRequests',[]);
    assert.deepEqual(result,[row]);assert.notEqual(result[0],row);assert.ok(Object.isFrozen(result));
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'listSavedSourceRequests',[{}]),{code:'invalid_durable_request'});
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault','foreign','listSavedSourceRequests',[]),{code:'durable_scope_changed'});
    assert.equal(calls,1);
    rows=[{...row,source:'private'}];
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'listSavedSourceRequests',[]),{code:'invalid_saved_source'});
    rows=Array(9).fill(row);
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'listSavedSourceRequests',[]),{code:'invalid_saved_source'});
  }finally{f.closed.resolve();await f.manager.close();}
});

test('late pending source inventory cannot cross a changed broker generation',async()=>{
  const gate=deferred();
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(){},async releaseSavedSource(){},async listSavedSourceRequests(){await gate.promise;return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    const pending=f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'listSavedSourceRequests',[]);
    a.generation++;gate.resolve();
    await assert.rejects(pending,{code:'durable_scope_changed'});
  }finally{f.closed.resolve();await f.manager.close();}
});

test('source capture cannot dispatch before the current independent journal grant is bound',async()=>{
  let captures=0;
  const request={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Note.md'}};
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(input){captures++;return{...input,source:'physical'};},async releaseSavedSource(){},async listSavedSourceRequests(){return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[request]),{code:'draft_admission_denied'});
    assert.equal(captures,0);
  }finally{f.closed.resolve();await f.manager.close();}
});

test('journal binding requires the exact core scope and rechecks its live owner before capture',async()=>{
  let captures=0,live=true;
  const request={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Note.md'}};
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(input){captures++;return{...input,source:'physical'};},async releaseSavedSource(){},async listSavedSourceRequests(){return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    const grant={token:'10000000-0000-4000-8000-000000000007',scope:{...context.scope,incarnationId:'10000000-0000-4000-8000-000000000008'}};
    for(const scope of [{...grant.scope,vaultId:'foreign'},{...grant.scope,clientId:'foreign'}]){
      assert.throws(()=>f.manager.bindIndependentJournal(f.broker,a,'/vault',context.admissionId,{...grant,scope},()=>{}),{code:'draft_admission_denied'});
    }
    bindJournal(f,a,context,()=>{if(!live)throw Object.assign(new Error('revoked'),{code:'draft_lease_revoked'});});
    assert.equal((await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[request])).captureId,request.captureId);
    live=false;
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[request]),{code:'draft_lease_revoked'});
    assert.equal(captures,1);
    assert.deepEqual(await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'listSavedSourceRequests',[]),[]);
    await f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'releaseSavedSource',[request.captureId]);
  }finally{f.closed.resolve();await f.manager.close();}
});

test('a capture reply cannot cross replacement of its bound independent journal grant',async()=>{
  const gate=deferred(),request={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Note.md'}};
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(input){await gate.promise;return{...input,source:'physical'};},async releaseSavedSource(){},async listSavedSourceRequests(){return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    bindJournal(f,a,context);
    const pending=f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[request]);
    const grant=bindJournal(f,a,context);
    f.manager.bindIndependentJournal(f.broker,a,'/vault',context.admissionId,{...grant,token:'10000000-0000-4000-8000-000000000009'},()=>{});
    gate.resolve();
    await assert.rejects(pending,{code:'durable_scope_changed'});
  }finally{f.closed.resolve();await f.manager.close();}
});

test('rebinding the same live journal grant does not invalidate an in-flight capture',async()=>{
  const gate=deferred(),request={captureId:'10000000-0000-4000-8000-000000000003',logicalWitness:{entryId:'entry',revision:'rev',path:'Note.md'}};
  const admission={scope:{vaultId:'store',clientId:'client'},conditionalSavedSourceAvailable:true,durableWrites:{
    async captureSavedSource(input){await gate.promise;return{...input,source:'physical'};},async releaseSavedSource(){},async listSavedSourceRequests(){return [];},
  },async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    bindJournal(f,a,context);
    const pending=f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'captureSavedSource',[request]);
    bindJournal(f,a,context);gate.resolve();
    assert.equal((await pending).captureId,request.captureId);
  }finally{f.closed.resolve();await f.manager.close();}
});

test('a different journal document rotates only the admission identity and fences the old renderer',async()=>{
  let retired=0,queries=0,captureOwner;
  const admission={scope:{vaultId:'store',clientId:'client'},durableWrites:{async query(){queries++;return null;}},async retire(){retired++;}};
  const f=fixture({admissionFactory:async(_service,options)=>{captureOwner=options.captureDispatchOwner;return admission;}}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
    const grant=bindJournal(f,a,context);
    const oldDispatchCheck=captureOwner();
    const effective=f.manager.bindIndependentJournal(f.broker,a,'/vault',context.admissionId,{...grant,token:'10000000-0000-4000-8000-000000000009'},()=>{});
    assert.equal(typeof effective,'string');assert.notEqual(effective,context.admissionId);
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'query',[{}]),{code:'durable_scope_changed'});
    assert.throws(oldDispatchCheck,{code:'durable_scope_changed'});
    assert.doesNotThrow(captureOwner());
    await f.manager.invoke(f.broker,a,event,'/vault',effective,'query',[{}]);
    assert.equal(queries,1);assert.equal(retired,0);
  }finally{f.closed.resolve();await f.manager.close();}
});

test('journal quiescence drains accepted Core work only for the exact live bound owner',async()=>{
  const gate=deferred();let drains=0;
  const admission={scope:{vaultId:'store',clientId:'client'},durableWrites:{},async drainAccepted(){drains++;await gate.promise;},async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame},grant=bindJournal(f,a,context);
    for(const wrong of [{...grant,token:'10000000-0000-4000-8000-000000000009'},{...grant,scope:{...grant.scope,clientId:'foreign'}}]){
      await assert.rejects(f.manager.quiesceJournalOwner(f.broker,a,'/vault',wrong),{code:'draft_admission_denied'});
    }
    assert.equal(drains,0);
    let settled=false;
    const pending=f.manager.quiesceJournalOwner(f.broker,a,'/vault',grant).then(()=>{settled=true;});
    await tick();assert.equal(settled,false);assert.equal(drains,1);
    await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',context.admissionId,'drainAccepted',[]),{code:'invalid_durable_request'});
    gate.resolve();await pending;assert.equal(settled,true);
  }finally{f.closed.resolve();await f.manager.close();}
});

for(const change of ['grant','generation','revoked','root'])test(`journal quiescence cannot certify a changed owner after draining: ${change}`,async()=>{
  const gate=deferred();let live=true;
  const admission={scope:{vaultId:'store',clientId:'client'},durableWrites:{},async drainAccepted(){await gate.promise;},async retire(){}};
  const f=fixture({admission}),a=f.window();await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  try{
    const context=await f.manager.context(f.broker,a,'/vault'),grant=bindJournal(f,a,context,()=>{if(!live)throw Object.assign(new Error('revoked'),{code:'draft_lease_revoked'});});
    const pending=f.manager.quiesceJournalOwner(f.broker,a,'/vault',grant);
    if(change==='grant')f.manager.bindIndependentJournal(f.broker,a,'/vault',context.admissionId,{...grant,token:'10000000-0000-4000-8000-000000000009'},()=>{});
    if(change==='generation')a.generation++;
    if(change==='revoked')live=false;
    if(change==='root')a.vault.service.root='/other';
    gate.resolve();
    await assert.rejects(pending,{code:change==='revoked'?'draft_lease_revoked':'durable_scope_changed'});
  }finally{f.closed.resolve();await f.manager.close();}
});


test('terminal host recovery replaces the shared service and preserves the exact registered durable scope',async()=>{
  const admissions=[],requests=[],scope={vaultId:'store',clientId:'registered-client'};
  const f=fixture({admissionFactory:async(service,options)=>{
    const admitted={scope:{...scope},durableWrites:{async query(ref){requests.push({service,ref:structuredClone(ref)});return {state:'prepared',ref};}},
      async abandonTerminatedHost(){assert.ok(service.host.fatal||service.host.exited);this.abandoned=true;},async retire(){},async release(){assert.fail('A dead lease must not be released through its transport');}};
    admissions.push({admitted,service,options});return admitted;
  }}),a=f.window(),b=f.window();a.clientSlot={clientId:scope.clientId};b.clientSlot={clientId:'other-client'};
  await f.broker.select(a,'/vault');a.persistedVaultRoot='/vault';
  const before=await f.manager.context(f.broker,a,'/vault'),event={sender:a.window.webContents,senderFrame:a.window.webContents.mainFrame};
  f.broker.bind(b,a.vault);b.persistedVaultRoot='/vault';const old=f.opened[0];old.host.fatal=Object.assign(new Error('Transport ended'),{code:'host_exited'});old.host.exited=true;f.closed.resolve();
  const [recovered,duplicate]=await Promise.all([f.manager.recover(f.broker,a,event,'/vault',before.admissionId),f.manager.recover(f.broker,a,event,'/vault',before.admissionId)]);
  assert.equal(recovered.admissionId,duplicate.admissionId);assert.notEqual(recovered.admissionId,before.admissionId);assert.deepEqual(recovered.scope,before.scope);
  assert.equal(f.opened.length,2);assert.equal(a.vault,b.vault);assert.equal(a.vault.service,f.opened[1]);assert.equal(admissions[0].admitted.abandoned,true);assert.equal(admissions[1].options.clientId,scope.clientId);
  const originalRef={vaultId:'store',clientId:scope.clientId,operationId:'original-operation',token:'original-intent'};
  assert.equal(requests.length,0,'Recovery never plans, prepares, queries or commits pending writes');
  await assert.rejects(f.manager.invoke(f.broker,a,event,'/vault',before.admissionId,'query',[originalRef]),{code:'durable_scope_changed'});
  await f.manager.invoke(f.broker,a,event,'/vault',recovered.admissionId,'query',[originalRef]);assert.deepEqual(requests[0].ref,originalRef);
  assert.equal(requests[0].service,f.opened[1]);await f.manager.close();
});

function recoveryFixture({runtime=false}={}){
  const made=[],calls=[],retireCallbacks=new Map();let rejectAdmission=false,killHostOnFailure=false,changedStore=false,releaseError=false;
  const f=fixture({options:{documentRuntime:runtime,onDocumentRuntimeNudge(){}},admissionFactory:async(service,options)=>{
    if(rejectAdmission){rejectAdmission=false;if(killHostOnFailure){killHostOnFailure=false;service.host.fatal={code:'host_exited'};service.host.exited=true;}throw Object.assign(new Error('Admission interrupted'),{code:'temporarily_unavailable'});}
    const admission={scope:{vaultId:changedStore?'different-store':'store',clientId:options.clientId},durableWrites:{async query(ref){calls.push(['query',structuredClone(ref)]);return ref;}},
      async abandonTerminatedHost(){calls.push(['abandon',options.clientId]);},async release(){calls.push(['release',options.clientId]);if(releaseError)throw Object.assign(new Error('release ACK lost'),{code:'host_timeout',commitUncertain:true});},async retire(){calls.push(['retire',options.clientId]);}};
    if(runtime){admission.documentCommand=()=>{};admission.documentRuntime={observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(_listener,onRetire){retireCallbacks.set(admission,onRetire);return()=>{};}};}
    made.push({admission,service});return admission;
  }});
  const owner=async(clientId)=>{const record=f.window();record.clientSlot={clientId};await f.broker.select(record,'/vault');record.persistedVaultRoot='/vault';const context=await f.manager.context(f.broker,record,'/vault');const event={sender:record.window.webContents,senderFrame:record.window.webContents.mainFrame};return {record,context,event,recover:()=>f.manager.recover(f.broker,record,event,'/vault',context.admissionId)};};
  return {...f,made,calls,owner,retireCallbacks,failNextAdmission({killHost=false}={}){rejectAdmission=true;killHostOnFailure=killHost;},changeStore(){changedStore=true;},failRelease(value){releaseError=value;}};
}
for(const concurrent of [false,true])test(`two admitted windows recover one dead shared host ${concurrent?'concurrently':'sequentially'}`,async()=>{
  const f=recoveryFixture(),a=await f.owner('client-a'),b=await f.owner('client-b');
  const old=f.opened[0];old.host.fatal={code:'host_exited'};old.host.exited=true;f.closed.resolve();
  const next=concurrent?await Promise.all([a.recover(),b.recover()]):[await a.recover(),await b.recover()];
  assert.equal(f.opened.length,2);assert.equal(a.record.vault.service,b.record.vault.service);
  assert.equal(next[0].scope.clientId,'client-a');assert.equal(next[1].scope.clientId,'client-b');assert.equal(next[0].scope.vaultId,'store');
  await f.manager.release(f.broker,a.record,a.event,'/vault',a.context.admissionId);
  assert.equal((await f.manager.context(f.broker,a.record,'/vault')).admissionId,next[0].admissionId,'Old cleanup ACK does not release replacement');
  assert.equal((await a.recover()).admissionId,next[0].admissionId,'Lost outer recovery reply retries the same new admission');
  assert.equal(f.made.length,4);await f.manager.close();
});
test('interrupted fresh admission retries without a third host or repeating old lease retirement',async()=>{
  const f=recoveryFixture(),a=await f.owner('client-a');f.opened[0].host.fatal={code:'host_exited'};f.closed.resolve();f.failNextAdmission();
  await assert.rejects(a.recover(),{code:'temporarily_unavailable'});const next=await a.recover();
  assert.equal(next.scope.clientId,'client-a');assert.equal(f.opened.length,2);assert.deepEqual(f.calls,[['abandon','client-a']]);await f.manager.close();
});
test('recovery never admits changed store scope and does not expose the replacement writer',async()=>{
  const f=recoveryFixture(),a=await f.owner('client-a');f.opened[0].host.fatal={code:'host_exited'};f.closed.resolve();f.changeStore();
  await assert.rejects(a.recover(),{code:'durable_scope_changed'});await assert.rejects(f.manager.context(f.broker,a.record,'/vault'),{code:'durable_scope_changed'});
  assert.equal(f.calls.some(call=>call[0]==='query'),false);await f.manager.close();
});
test('healthy runtime retirement retries its exact release before a fresh admission and leaves another client alive',async()=>{
  const f=recoveryFixture({runtime:true}),a=await f.owner('client-a'),b=await f.owner('client-b');
  f.retireCallbacks.get(f.made[0].admission)();f.failRelease(true);
  await assert.rejects(a.recover(),{code:'host_timeout'});assert.equal(f.made.length,2);assert.equal(f.opened.length,1);
  assert.equal((await f.manager.context(f.broker,b.record,'/vault')).admissionId,b.context.admissionId);
  f.failRelease(false);const next=await a.recover();assert.notEqual(next.admissionId,a.context.admissionId);assert.equal(f.opened.length,1);assert.equal(f.made.length,3);
  assert.deepEqual(f.calls,[['release','client-a'],['release','client-a']]);f.closed.resolve();await f.manager.close();
});
test('recovery rejects healthy active, foreign admission and changed owner generation without host mutation',async()=>{
  const f=recoveryFixture(),a=await f.owner('client-a');
  await assert.rejects(a.recover(),{code:'recovery_not_available'});
  await assert.rejects(f.manager.recover(f.broker,a.record,a.event,'/vault','foreign'),{code:'durable_scope_changed'});
  f.opened[0].host.fatal={code:'host_exited'};a.record.generation++;
  await assert.rejects(a.recover(),{code:'durable_scope_changed'});assert.equal(f.opened.length,1);assert.deepEqual(f.calls,[]);f.closed.resolve();await f.manager.close();
});


test('the original recovery request can replace a second host lost during interrupted fresh admission',async()=>{
  const f=recoveryFixture(),a=await f.owner('client-a');f.opened[0].host.fatal={code:'host_exited'};f.closed.resolve();f.failNextAdmission({killHost:true});
  await assert.rejects(a.recover(),{code:'temporarily_unavailable'});assert.equal(f.opened.length,2);assert.equal(f.opened[1].host.exited,true);
  const next=await a.recover();assert.equal(f.opened.length,3);assert.deepEqual(next.scope,a.context.scope);assert.equal(f.opened[1].closed,true);
  assert.deepEqual(f.calls,[['abandon','client-a']],'Original admission is abandoned once without source replay');await f.manager.close();
});
