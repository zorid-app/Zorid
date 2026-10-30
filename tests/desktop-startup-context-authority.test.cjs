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
// Construct genuine validated Native errors through the production frame decoder.
function nativeFault(code,commitUncertain=false){
  const host=Object.create(RustVaultService.prototype);let error;
  Object.assign(host,{prefix:Buffer.alloc(8),prefixUsed:0,frame:null,frameUsed:0,pending:{requestId:'1',command:{method:'claim_client'},reject(value){error=value;}}});
  const header=Buffer.from(JSON.stringify({version:1,request_id:'1',ok:false,error:{code,commit_uncertain:commitUncertain}})),prefix=Buffer.alloc(8);prefix.writeUInt32BE(header.length,0);
  host.receive(Buffer.concat([prefix,header]));assert.ok(error);return error;
}
async function fixture({claim,identity,release,checkpoint,replacement,closeHost}={}){
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
    if(command.method==='checkpoint_list')return checkpoint?checkpoint():{result:{items:[],cursor:null,highWater:'0'}};
    throw new Error(`unexpected ${command.method}`);
  };
  const filename=path.resolve(__dirname,'../desktop/editor-core.cjs'),sourceRequire=createRequire(filename),coreModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:coreModule,exports:coreModule.exports,process,structuredClone,setTimeout,clearTimeout,require(name){
    if(name==='node:fs/promises')return{realpath:async value=>value};
    if(name==='./vault-service.cjs')return{VaultService:{async open(directory){
      const serviceHost=services.length&&replacement?replacement():host;
      const service=new CoreVaultFixtureService(serviceHost,{pollMs:750,rescanMs:30000});
      service.root=directory;service.familyMode=true;service.subscribe=()=>()=>{};service.close=async()=>{service.closed=true;await closeHost?.(serviceHost);};services.push(service);return service;
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
  const event=target=>({sender:target.window.webContents,senderFrame:target.window.webContents.mainFrame});
  const context=(target=record)=>mainModule.exports.contextWithIndependentJournal(target,event(target),root,check=>manager.context(broker,target,root,undefined,check));
  return{manager,broker,record,host,calls,references,services,context,main:mainModule.exports,get active(){return active;},close:()=>manager.close()};
}

for(const code of ['storage_busy','storage_io_retryable','storage_capacity','filesystem_io_retryable','lock_timeout'])test(`first Main context repairs definite preclaim ${code} without exposing a second claim owner`,async()=>{
  let first=true;const f=await fixture({claim({next}){if(first){first=false;throw nativeFault(code);}return next();}});
  try{const value=await f.context();assert.equal(value.scope.vaultId,'authority');assert.equal(f.calls.filter(x=>x==='claim_client').length,2);assert.equal(f.calls.filter(x=>x==='checkpoint_list').length,1);}finally{await f.close();}
});

test('unknown claim ACK retains the first attempt and never blindly claims the healthy shared host again',async()=>{
  let first=true;const f=await fixture({claim({next}){const value=next();if(first){first=false;throw fault('timeout',true);}return value;}});
  try{await assert.rejects(f.context(),{code:'timeout'});await assert.rejects(f.context());assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.includes('checkpoint_list'),false);assert.ok(f.active);}finally{await f.close();}
});

test('postclaim unknown cleanup retains the exact release reference before any further claim',async()=>{
  let failed=false,releaseFailed=false;const f=await fixture({checkpoint(){if(!failed){failed=true;throw nativeFault('storage_io_retryable');}return{result:{items:[],cursor:null,highWater:'0'}};},release({next}){if(!releaseFailed){releaseFailed=true;throw fault('timeout',true);}return next();}});
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
  const f=await fixture({claim({next}){const value=next();value.result.lease.local_store_id='foreign';return value;}});
  try{await assert.rejects(f.context(),{code:'durable_scope_changed'});assert.equal(f.active,null);assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.includes('checkpoint_list'),false);}finally{await f.close();}
});


test('terminal construction is retained separately from unknown cleanup and never readmitted',async()=>{
  let releaseFailed=false;const f=await fixture({checkpoint(){throw nativeFault('permission_denied');},release({next}){if(!releaseFailed){releaseFailed=true;throw fault('timeout',true);}return next();}});
  try{
    await assert.rejects(f.context(),{code:'permission_denied'});
    await assert.rejects(f.context(),{code:'permission_denied'});
    assert.equal(f.references.length,2);assert.deepEqual(f.references[0],f.references[1]);assert.equal(f.active,null);
    assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.filter(x=>x==='checkpoint_list').length,1);
  }finally{await f.close();}
});

test('a locally generated five-code error is not trusted Native proof for automatic retry',async()=>{
  const f=await fixture({claim(){throw fault('storage_busy');}});
  try{await assert.rejects(f.context(),{code:'storage_busy'});assert.equal(f.calls.filter(x=>x==='claim_client').length,1);}finally{await f.close();}
});


test('successful cached context accepts normal same-URL renderer reload on the same Native lease',async()=>{
  const f=await fixture();try{
    const before=await f.context();f.main.revokeIndependentJournal(f.record);f.record.window.webContents.mainFrame={url:'https://zorid.test/'};
    const after=await f.context();assert.notEqual(after.independentJournal.token,before.independentJournal.token);assert.notEqual(after.admissionId,before.admissionId);
    assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.filter(x=>x==='identity').length,1);assert.equal(f.calls.filter(x=>x==='checkpoint_list').length,1);
  }finally{await f.close();}
});

for(const change of ['selection','frame','close'])test(`failed-admission backoff cancels promptly for ${change}`,async()=>{
  const entered=deferred();const f=await fixture({claim(){entered.resolve();throw nativeFault('storage_busy');}});
  const pending=f.context(),rejected=assert.rejects(pending);await entered.promise;
  const started=performance.now();
  if(change==='selection')f.record.vaultSelectionPending=true;
  else if(change==='frame')f.record.window.webContents.mainFrame={url:'https://zorid.test/'};
  else await f.close();
  try{await rejected;assert.ok(performance.now()-started<400,'cancellation does not wait a long retry interval');assert.equal(f.calls.filter(x=>x==='claim_client').length,1);}finally{await f.close();}
});

test('safe startup retry remains one coalesced Main request beyond three temporary failures',async()=>{
  let failures=4;const f=await fixture({claim({next}){if(failures-->0)throw nativeFault('storage_busy');return next();}});
  try{const [a,b]=await Promise.all([f.context(),f.context()]);assert.equal(a.admissionId,b.admissionId);assert.equal(a.independentJournal.token,b.independentJournal.token);assert.equal(f.calls.filter(x=>x==='claim_client').length,5);}finally{await f.close();}
});

function replacementHost(store,calls){
  const host=Object.create(RustVaultService.prototype);host.capabilities=['file_command'];const leases=new Map();
  host.request=async(command,bytes,reference,beforeDispatch)=>{
    beforeDispatch?.();calls.push(`replacement:${command.method}`);
    if(command.method==='identity')return{result:{identity:{local_store_id:store,realm_id:null,vault_id:null}}};
    if(command.method==='claim_client'){const lease={local_store_id:store,client_id:command.client_id,token:'20000000-0000-4000-8000-000000000001'};leases.set(command.client_id,lease);return{result:{lease}};}
    if(command.method==='checkpoint_list'){assert.deepEqual(reference,leases.get(reference.client_id));return{result:{items:[],cursor:null,highWater:'0'}};}
    if(command.method==='release_client'){assert.deepEqual(command.reference,leases.get(command.reference.client_id));return{result:{released:true}};}
    throw new Error(`unexpected replacement ${command.method}`);
  };return host;
}

for(const store of ['authority','changed'])test(`unknown claim repair waits actual old-host close and validates ${store} replacement before claim`,async()=>{
  const closeEntered=deferred(),exit=deferred(),replacementCalls=[];let f;
  f=await fixture({claim({next,host}){next();host.fatal=fault('host_timeout',true);throw host.fatal;},
    replacement:()=>replacementHost(store,replacementCalls),
    async closeHost(host){if(host===f.host){closeEntered.resolve();await exit.promise;host.exited=true;}}
  });
  const pending=f.context();const observed=pending.then(value=>({value}),error=>({error}));
  try{
    await closeEntered.promise;assert.equal(f.services.length,1);assert.deepEqual(replacementCalls,[]);exit.resolve();const result=await observed;
    if(store==='authority'){assert.equal(result.value.scope.vaultId,'authority');assert.deepEqual(replacementCalls,['replacement:identity','replacement:claim_client','replacement:checkpoint_list']);}
    else{assert.equal(result.error.code,'durable_scope_changed');assert.deepEqual(replacementCalls,['replacement:identity']);}
    assert.equal(f.host.exited,true);assert.equal(f.calls.filter(x=>x==='claim_client').length,1);
  }finally{exit.resolve();await observed;await f.close();}
});


test('positively closed unknown-claim attempt survives a transient replacement-open failure',async()=>{
  const calls=[];let attempts=0,f;
  f=await fixture({claim({next,host}){next();host.fatal=fault('host_timeout',true);throw host.fatal;},
    replacement(){if(++attempts===1)throw nativeFault('storage_busy');return replacementHost('authority',calls);},
    async closeHost(host){if(host===f.host)host.exited=true;}
  });
  try{const value=await f.context();assert.equal(value.scope.vaultId,'authority');assert.equal(attempts,2);assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(calls.filter(x=>x==='replacement:claim_client').length,1);}finally{await f.close();}
});

test('two initial owners replace one terminated shared host after its close barrier',async()=>{
  const entered=deferred(),exit=deferred(),calls=[];let f,opens=0;
  f=await fixture({claim({next,host}){next();host.fatal=fault('host_timeout',true);throw host.fatal;},
    replacement(){opens++;return replacementHost('authority',calls);},
    async closeHost(host){if(host===f.host){entered.resolve();await exit.promise;host.exited=true;}}
  });
  const other=f.broker.register({webContents:{id:2,mainFrame:{url:'https://zorid.test/'},isDestroyed:()=>false},isDestroyed:()=>false});
  other.clientSlot={slotId:'second',clientId:'10000000-0000-4000-8000-000000000003'};f.broker.bind(other,f.record.vault);other.persistedVaultRoot=root;
  const work=Promise.all([f.context(),f.context(other)]);
  try{await entered.promise;assert.equal(opens,0);exit.resolve();const [a,b]=await work;assert.equal(opens,1);assert.equal(a.scope.vaultId,b.scope.vaultId);assert.notEqual(a.scope.clientId,b.scope.clientId);assert.equal(f.record.vault.service,other.vault.service);assert.equal(calls.filter(x=>x==='replacement:claim_client').length,2);}finally{exit.resolve();await work;await f.close();}
});

for(const method of ['claimClient','identity'])test(`queued ${method} checks its original frame before any Native bytes leave`,async()=>{
  const gate=deferred(),frames=[],host=Object.create(RustVaultService.prototype),frame={};let currentFrame=frame;
  Object.assign(host,{sequence:0n,queuedCount:0,queuedBytes:0,tail:gate.promise,ready:Promise.resolve(),markActivity(){},child:{stdin:{write:bytes=>frames.push(bytes)}},expect(){assert.fail('a revoked request cannot expect a Native reply');}});
  const check=()=>{if(currentFrame!==frame)throw fault('durable_scope_changed');};
  const work=method==='claimClient'?host.claimClient(clientId,check):host.identity(check);
  currentFrame={};gate.resolve();await assert.rejects(work,{code:'durable_scope_changed'});await host.tail;
  assert.deepEqual(frames,[]);assert.equal(host.queuedCount,0);
});


test('actual old-host exit clears only terminal cleanup ownership without readmitting its rejected construction',async()=>{
  let f;f=await fixture({checkpoint(){throw nativeFault('permission_denied');},release(){throw fault('host_timeout',true);},async closeHost(host){host.exited=true;}});
  try{
    await assert.rejects(f.context(),{code:'permission_denied'});assert.throws(()=>f.manager.requireReleased(f.record),{code:'durable_release_required'});
    f.host.fatal=fault('host_exited',true);const prior=f.record.vault.service;
    await f.manager.retire(f.broker,f.record,prior);assert.doesNotThrow(()=>f.manager.requireReleased(f.record));
    assert.equal(f.calls.filter(x=>x==='claim_client').length,1);assert.equal(f.calls.filter(x=>x==='release_client').length,1);assert.equal(f.services.length,1);
  }finally{await f.close();}
});


test('fatal and closed flags without actual exit cannot abandon terminal cleanup ownership',async()=>{
  const f=await fixture({checkpoint(){throw nativeFault('permission_denied');},release(){throw fault('host_timeout',true);}});
  try{
    await assert.rejects(f.context(),{code:'permission_denied'});f.host.fatal=fault('host_exited',true);
    await assert.rejects(f.manager.retire(f.broker,f.record,f.record.vault.service),{code:'recovery_not_available'});
    assert.throws(()=>f.manager.requireReleased(f.record),{code:'durable_release_required'});assert.equal(f.calls.filter(x=>x==='claim_client').length,1);
  }finally{await f.close();}
});
