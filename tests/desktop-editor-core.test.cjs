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
function fixture(){
  const opened=[],closed=deferred();
  const filename=path.resolve(__dirname,'../desktop/editor-core.cjs');
  const sourceRequire=createRequire(filename);
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,process,structuredClone,require(name){
    if(name==='node:fs/promises')return {realpath:async value=>value};
    if(name==='./vault-service.cjs')return {VaultService:{async open(root){
      const service={root,closed:false,subscribe(){return ()=>{};},async close(){this.closed=true;if(opened[0]===this)await closed.promise;}};
      opened.push(service);return service;
    }}};
    if(name==='./host-location.cjs')return {resolveDesktopHost:async()=>'/trusted/host'};
    if(name==='./client-admission.cjs')return {admitDesktopFixtureClient:assert.fail};
    // Unmocked dependencies resolve beside the evaluated production module.
    return sourceRequire(name);
  }});
  const manager=module.exports.createEditorCoreManager({});
  const broker=new WindowBroker({openVault:directory=>manager.open(directory),allowedURL:()=>true});
  let id=0;
  const window=()=>broker.register({webContents:{id:++id,isDestroyed:()=>false},isDestroyed:()=>false});
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
