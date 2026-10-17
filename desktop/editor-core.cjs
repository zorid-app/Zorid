'use strict';
// Guarded normal-editor selection for ONE explicitly configured disposable vault.
// No migration/initialization or renderer-chosen host/credentials/client identity.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {VaultService}=require('./vault-service.cjs');
const {admitDesktopFixtureClient}=require('./client-admission.cjs');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail=code=>Object.assign(new Error('Rust editor fixture operation failed.'),{code});
const methods=new Set(['readText','readTextById','planWrite','prepare','commit','query','listUnacknowledged','acknowledge']);
const checkpointMethods=new Set(['load','compareAndSwap','list','changes']);
function createEditorCoreManager(environment=process.env){
  if(environment.ZORID_EDITOR_RUST!=='1')return null;
  const config={root:environment.ZORID_FIXTURE_VAULT,executable:environment.ZORID_DESKTOP_HOST_BIN,
    fixtureSyncConfig:environment.ZORID_FIXTURE_SYNC_CONFIG,clientId:environment.ZORID_FIXTURE_CLIENT_ID};
  if(environment.ZORID_DESKTOP_FAMILY_FIXTURE==='1'||!['root','executable','fixtureSyncConfig'].every(key=>typeof config[key]==='string'&&path.isAbsolute(config[key]))||!uuid(config.clientId))throw fail('invalid_editor_core_configuration');
  let rootPromise, servicePromise, closePromise, closed=false;
  const contexts=new Map(), admissions=new Map(), released=new WeakMap(), services=new Set();
  const root=()=>rootPromise??=(fs.realpath(config.root));
  function checked(broker,record,expectedRoot,admissionId){
    broker.assertLive(record);
    const saved=contexts.get(record);
    if(closed||!saved||saved.id!==admissionId||saved.service.root!==expectedRoot)throw fail('durable_scope_changed');
    saved.check();return saved;
  }
  async function isCoreRoot(input){return await fs.realpath(input)===await root();}
  async function retire(broker,record){
    const pending=admissions.get(record);
    if(pending)await pending.catch(()=>{});
    const saved=contexts.get(record);if(!saved)return;
    contexts.delete(record);servicePromise=undefined;
    // The renderer is gone: retain its durable checkpoints/intents; no synthetic
    // successful flush/ACK. Child exit releases its kernel lease after draining.
    await saved.service.close();services.delete(saved.service);
    if(broker.vaults.get(saved.service.root)?.service===saved.service)broker.vaults.delete(saved.service.root);
  }
  return {
    isCoreRoot,
    owns(record){return !!record.vault&&services.has(record.vault.service);},
    async open(input){
      if(closed)throw fail('editor_core_closed');
      if(!await isCoreRoot(input))return VaultService.open(input);
      if(!servicePromise){
        servicePromise=VaultService.open(await root(),{coreFixture:{executable:config.executable,
          fixtureSyncConfig:config.fixtureSyncConfig,familyMode:true}}).then(async service=>{
            if(closed){await service.close();throw fail('editor_core_closed');}
            services.add(service);return service;
          });
        servicePromise.catch(()=>{servicePromise=undefined;});
      }
      return servicePromise;
    },
    requireReleased(record){if(contexts.has(record)||admissions.has(record))throw fail('durable_release_required');},
    async context(broker,record,expectedRoot){
      broker.assertLive(record);
      const entry=record.vault;
      if(!entry||entry.service.root!==expectedRoot)throw fail('durable_scope_changed');
      if(!services.has(entry.service))return null;
      if(record.id!=='main')throw fail('core_fixture_single_window');
      const existing=contexts.get(record);if(existing){existing.check();return {admissionId:existing.id,scope:existing.admission.scope};}
      const inFlight=admissions.get(record);if(inFlight)return inFlight;
      const generation=record.generation,service=entry.service;
      const check=()=>{
        broker.assertLive(record);
        if(closed||record.generation!==generation||record.vault!==entry||service.closed
          ||!broker.allowedURL(record.window.webContents.mainFrame.url))throw fail('durable_scope_changed');
      };
      check();
      const pending=(async()=>{
        const admission=await admitDesktopFixtureClient(service,{fixture:true,clientId:config.clientId,assertOwner:check});
        try {check();}
        catch(error){await service.close();services.delete(service);servicePromise=undefined;
          if(broker.vaults.get(service.root)?.service===service)broker.vaults.delete(service.root);throw error;}
        const saved={id:randomUUID(),admission,service,check};contexts.set(record,saved);
        return {admissionId:saved.id,scope:admission.scope};
      })();
      admissions.set(record,pending);
      try{return await pending;}finally{if(admissions.get(record)===pending)admissions.delete(record);}
    },
    async invoke(broker,record,event,expectedRoot,admissionId,method,args){
      broker.authenticate(event);
      const saved=checked(broker,record,expectedRoot,admissionId);
      if(typeof method!=='string'||!Array.isArray(args)||args.length>2)throw fail('invalid_durable_request');
      const captured=structuredClone(args);
      const prefix='checkpoints.';
      if(method.startsWith(prefix)){
        const name=method.slice(prefix.length);if(!checkpointMethods.has(name))throw fail('invalid_durable_request');
        return saved.admission.durableWrites.checkpoints[name](...captured);
      }
      if(!methods.has(method))throw fail('invalid_durable_request');
      return saved.admission.durableWrites[method](...captured);
    },
    async release(broker,record,event,expectedRoot,admissionId){
      broker.authenticate(event);
      const previous=released.get(record);
      if(previous?.id===admissionId&&previous.root===expectedRoot)return;
      const saved=checked(broker,record,expectedRoot,admissionId);
      // Renderer lifecycle owner has awaited its final checkpoint/flush before
      // requesting release. The admission layer drains already accepted RPCs.
      await saved.admission.release(()=>{});
      if(contexts.get(record)===saved)contexts.delete(record);
      released.set(record,{id:admissionId,root:expectedRoot});
    },
    retire,
    close(){
      if(closePromise)return closePromise;
      closed=true;
      closePromise=(async()=>{
        await Promise.allSettled([servicePromise,...admissions.values()].filter(Boolean));
        contexts.clear();await Promise.all([...services].map(service=>service.close()));services.clear();
      })();return closePromise;
    },
  };
}
module.exports={createEditorCoreManager};
