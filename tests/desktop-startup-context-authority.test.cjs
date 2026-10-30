'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');
const {createDraftJournalAdmissionManager}=require('../desktop/draft-journal-admission.cjs');
const clientId='10000000-0000-4000-8000-000000000001';
const root='/startup-authority-fixture';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const fault=(code,commitUncertain=false)=>Object.assign(new Error(code),{code,commitUncertain});
async function fixture({claim,identity,release}={}){
  const calls=[],references=[],services=[];let active=null,serial=0;
  const host=Object.create(RustVaultService.prototype);
  host.capabilities=['file_command'];
  host.request=async(command,bytes,reference,beforeDispatch)=>{
    beforeDispatch?.();calls.push(command.method);
    if(command.method==='claim_client'){
      const next=()=>{if(active)throw fault('client_in_use');active={local_store_id:'authority',client_id:command.client_id,token:`10000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`};return{result:{lease:active}};};
      return claim?claim({next,host,calls}):next();
    }
    if(command.method==='release_client'){
      references.push(command.reference);
      const next=()=>{assert.deepEqual(command.reference,active,'release must use the exact retained lease');active=null;return{result:{released:true}};};
      return release?release({next,host,calls,reference:command.reference}):next();
    }
    if(reference)assert.deepEqual(reference,active,'leased calls carry the Native admitted reference');
    if(command.method==='identity')return identity?identity({host,calls,reference}):{result:{identity:{local_store_id:'authority',realm_id:null,vault_id:null}}};
    if(command.method==='checkpoint_list')return{result:{items:[],cursor:null,highWaterMark:'0'}};
    throw new Error(`unexpected ${command.method}`);
  };
  const filename=path.resolve(__dirname,'../desktop/editor-core.cjs'),sourceRequire=createRequire(filename),coreModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:coreModule,exports:coreModule.exports,process,structuredClone,setTimeout,clearTimeout,require(name){
    if(name==='node:fs/promises')return{realpath:async value=>value};
    if(name==='./vault-service.cjs')return{VaultService:{async open(directory){
      const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000});
      service.root=directory;service.familyMode=true;service.subscribe=()=>()=>{};service.close=async()=>{service.closed=true;};services.push(service);return service;
    }}};
    if(name==='./host-location.cjs')return{resolveDesktopHost:async()=>'/trusted/host'};
    return sourceRequire(name);
  }});
  const manager=coreModule.exports.createEditorCoreManager({});
  const broker=new WindowBroker({openVault:directory=>manager.open(directory),allowedURL:url=>url==='https://zorid.test/'});
  const record=broker.register({webContents:{id:1,mainFrame:{url:'https://zorid.test/'},isDestroyed:()=>false},isDestroyed:()=>false});
  record.clientSlot={slotId:'main',clientId};await broker.select(record,root);record.persistedVaultRoot=root;
  const journal=createDraftJournalAdmissionManager({broker,journal:{bind(){return{revoke(){}};}}});
  const mainFile=path.resolve(__dirname,'../desktop/main.cjs'),mainRequire=createRequire(mainFile),mainModule={exports:{}};
  const prefix=fs.readFileSync(mainFile,'utf8').split("const { createContextMenuController }")[0];
  vm.runInNewContext(`${prefix}\nconst broker=fixtureBroker;independentJournalManager=fixtureJournal;module.exports={contextWithIndependentJournal,revokeIndependentJournal};`,{
    module:mainModule,exports:mainModule.exports,process,fixtureBroker:broker,fixtureJournal:journal,require(name){
      if(name==='electron')return{app:{isPackaged:false}};
      if(name==='./editor-core.cjs')return{createEditorCoreManager:()=>manager};
      return mainRequire(name);
    }});
  const event=()=>({sender:record.window.webContents,senderFrame:record.window.webContents.mainFrame});
  const context=()=>mainModule.exports.contextWithIndependentJournal(record,event(),root,check=>manager.context(broker,record,root,undefined,check));
  return{manager,broker,record,host,calls,references,context,main:mainModule.exports,get active(){return active;},close:()=>manager.close()};
}

for(const code of ['storage_busy','storage_io_retryable','storage_capacity','filesystem_io_retryable','lock_timeout'])test(`first Main context repairs definite preclaim ${code} without exposing a second claim owner`,async()=>{
  let first=true;const f=await fixture({claim({next}){if(first){first=false;throw fault(code);}return next();}});
  try{const value=await f.context();assert.equal(value.scope.vaultId,'authority');assert.equal(f.calls.filter(x=>x==='claim_client').length,2);assert.equal(f.calls.filter(x=>x==='checkpoint_list').length,1);}finally{await f.close();}
});

test('unknown claim ACK retains the first attempt and never blindly claims the healthy shared host again',async()=>{
  let first=true;const f=await fixture({claim({next}){const value=next();if(first){first=false;throw fault('timeout',true);}return value;}});
  try{await assert.rejects(f.context(),{code:'timeout'});await assert.rejects(f.context());assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.includes('checkpoint_list'),false);assert.ok(f.active);}finally{await f.close();}
});

test('postclaim unknown cleanup retains the exact release reference before any further claim',async()=>{
  let failed=false,releaseFailed=false;const f=await fixture({identity(){if(!failed){failed=true;throw fault('storage_io_retryable');}return{result:{identity:{local_store_id:'authority',realm_id:null,vault_id:null}}};},release({next}){if(!releaseFailed){releaseFailed=true;throw fault('timeout',true);}return next();}});
  try{
    await f.context().catch(()=>{});
    const value=await f.context();assert.equal(value.scope.vaultId,'authority');
    assert.deepEqual(f.references[0],f.references[1]);assert.equal(f.calls.filter(x=>x==='claim_client').length,2);
    assert.ok(f.calls.indexOf('release_client')<f.calls.lastIndexOf('claim_client'));
  }finally{await f.close();}
});

test('same Main binding and journal grant survive an outer IPC ACK loss without readmission',async()=>{
  const f=await fixture();try{const lost=await f.context(),retried=await f.context();assert.equal(retried.admissionId,lost.admissionId);assert.equal(retried.independentJournal.token,lost.independentJournal.token);assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.filter(x=>x==='checkpoint_list').length,1);}finally{await f.close();}
});

test('same-URL frame replacement during claim cannot leave a cached stale admission',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({async claim({next}){const value=next();entered.resolve();await gate.promise;return value;}});
  try{
    const old=f.context();await entered.promise;f.record.window.webContents.mainFrame={url:'https://zorid.test/'};gate.resolve();await assert.rejects(old);
    assert.equal(f.active,null,'old document claim is positively released');assert.equal(f.calls.includes('checkpoint_list'),false,'old document cannot inspect namespace recovery');
    const fresh=await f.context();assert.equal(fresh.scope.clientId,clientId);assert.equal(f.calls.filter(x=>x==='claim_client').length,2);
  }finally{gate.resolve();await f.close();}
});

for(const code of ['permission_denied','storage_corrupt','invalid_protocol','durable_scope_changed'])test(`terminal ${code} is never converted to automatic claim retry`,async()=>{
  const f=await fixture({claim(){throw fault(code);}});try{await assert.rejects(f.context(),{code});assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.includes('checkpoint_list'),false);}finally{await f.close();}
});

for(const change of ['selection','slot','epoch'])test(`initial claim is fenced after captured ${change} changes`,async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({async claim({next}){const value=next();entered.resolve();await gate.promise;return value;}});
  try{
    const old=f.context();await entered.promise;
    if(change==='selection')f.record.vaultSelectionPending=true;
    else if(change==='slot')f.record.clientSlot={...f.record.clientSlot};
    else f.main.revokeIndependentJournal(f.record);
    gate.resolve();await assert.rejects(old);
    assert.equal(f.active,null);assert.equal(f.calls.includes('checkpoint_list'),false);
  }finally{gate.resolve();await f.close();}
});

test('foreign authority identity fails before namespace recovery and is never retried',async()=>{
  const f=await fixture({identity(){return{result:{identity:{local_store_id:'foreign',realm_id:null,vault_id:null}}};}});
  try{await assert.rejects(f.context(),{code:'client_scope_mismatch'});assert.equal(f.active,null);assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.includes('checkpoint_list'),false);}finally{await f.close();}
});
