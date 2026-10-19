'use strict';
// All normal desktop vaults use Rust. Configuration and client ownership remain
// main-process authorities; no renderer-chosen executable or client identity.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {MAX_BINARY_FRAME}=require('./rust-vault-service.cjs');
const {VaultService}=require('./vault-service.cjs');
const {admitDesktopFixtureClient}=require('./client-admission.cjs');
const {captureDocumentRuntimeRequest,captureDocumentRuntimeReply}=require('./document-semantics.cjs');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail=code=>Object.assign(new Error('Rust vault operation failed.'),{code});
const methods=new Set(['readText','readTextById','planWrite','prepare','commit','query','listUnacknowledged','acknowledge']);
const checkpointMethods=new Set(['load','compareAndSwap','list','changes']);
const runtimeMethods={documentRuntimeObserve:'observe',documentRuntimeControl:'control',documentRuntimeAckControl:'ackControl',documentRuntimeAckOutcome:'ackOutcome'};
const runtimeAvailable=admission=>admission.documentRuntime&&['observe','control','ackControl','ackOutcome','subscribe'].every(name=>typeof admission.documentRuntime[name]==='function');
function createEditorCoreManager(environment=process.env, options={}){
  if(environment.ZORID_DESKTOP_FAMILY_FIXTURE==='1')return null;
  const config={root:environment.ZORID_FIXTURE_VAULT,executable:environment.ZORID_DESKTOP_HOST_BIN,
    fixtureSyncConfig:environment.ZORID_FIXTURE_SYNC_CONFIG,clientId:environment.ZORID_FIXTURE_CLIENT_ID};
  const fixture=environment.ZORID_EDITOR_RUST==='1'&&!!config.root;
  if(fixture&&(!['root','executable','fixtureSyncConfig'].every(key=>typeof config[key]==='string'&&path.isAbsolute(config[key]))||!uuid(config.clientId)))throw fail('invalid_editor_core_configuration');
  let closePromise,closed=false;
  // A trusted integration switch, never a renderer-provided option. The host
  // capability remains absent while the legacy frontend planner is active.
  const documentRuntime=options.documentRuntime===true&&typeof options.onDocumentRuntimeNudge==='function';
  const contexts=new Map(), admissions=new Map(), released=new WeakMap(), services=new Set(), openings=new Map(), retirements=new Map();
  const describe=saved=>({admissionId:saved.id,scope:saved.admission.scope,...(saved.admission.documentCommand?{documentSemantics:true}:{}),...(saved.admission.metadataRowsAvailable===true?{metadataRowsAvailable:true}:{}),...(saved.admission.draftsAvailable===true?{draftsAvailable:true}:{}),...(documentRuntime&&runtimeAvailable(saved.admission)?{documentMaintenance:true}:{}),...(saved.admission.workblockCommand?{workBlocks:true}:{}),...(saved.admission.binaryLimits?{binaryLimits:saved.admission.binaryLimits}:{})});
  const executable=()=>require('./host-location.cjs').resolveDesktopHost({...options,override:config.executable});
  function checked(broker,record,expectedRoot,admissionId,allowRetired=false){
    broker.assertLive(record);
    const saved=contexts.get(record);
    if(closed||!saved||saved.id!==admissionId||saved.service.root!==expectedRoot)throw fail('durable_scope_changed');
    saved.check(allowRetired);return saved;
  }
  async function isCoreRoot(input){await fs.realpath(input);return true;}
  function retire(broker,record,selectedService){
    const initial=contexts.get(record)??released.get(record)??(selectedService?{service:selectedService}:null);
    if(!initial)return Promise.resolve();
    const service=initial.service,root=service.root,entry=broker.vaults.get(root);
    const previous=retirements.get(root);
    // Install before any await: open/selection must not borrow a service whose
    // last owner is draining. Other live members keep their existing service.
    const pending=(async()=>{
      if(previous)await previous;
      const admission=admissions.get(record);
      if(admission)await admission.catch(()=>{});
      const saved=contexts.get(record)??released.get(record)??initial;
      released.delete(record);contexts.delete(record);
      saved.stopRuntime?.();saved.stopDrafts?.();
      if(saved.admission)await saved.admission.retire();
      const current=broker.vaults.get(root);
      if(current?.service===service&&current.members.size||[...contexts.values()].some(value=>value.service===service))return;
      // Remove only this service's cache entries. A newer entry must survive an
      // older retirement, even if a caller has already rebound this root.
      const opening=openings.get(root);
      if(opening&&await opening===service&&openings.get(root)===opening)openings.delete(root);
      await service.close();services.delete(service);
      if(broker.vaults.get(root)===entry&&entry?.service===service)broker.vaults.delete(root);
    })();
    retirements.set(root,pending);
    if(entry?.service===service&&!entry.members.size)entry.retiring=pending;
    void pending.then(()=>{
      if(retirements.get(root)===pending)retirements.delete(root);
      if(entry?.retiring===pending)delete entry.retiring;
    },()=>{ /* Failed drain remains fenced until process shutdown/restart. */ });
    return pending;
  }

  return {
    isCoreRoot,
    owns(record){return !!record.vault&&services.has(record.vault.service);},
    async open(input){
      if(closed)throw fail('editor_core_closed');
      const canonical=await fs.realpath(input);
      while(retirements.has(canonical)){await retirements.get(canonical);if(closed)throw fail('editor_core_closed');}
      if(!openings.has(canonical)){
        const pending=(async()=>{
          const fixtureSelected=fixture&&canonical===await fs.realpath(config.root);
          const service=await VaultService.open(canonical,{coreFixture:{executable:await executable(),
            ...(fixtureSelected?{fixtureSyncConfig:config.fixtureSyncConfig}:{initializeLocal:true}),familyMode:true,documentRuntime}});
          if(closed){await service.close();throw fail('editor_core_closed');}
          services.add(service);return service;
        })();
        openings.set(canonical,pending);pending.catch(()=>{if(openings.get(canonical)===pending)openings.delete(canonical);});
      }
      return openings.get(canonical);
    },
    requireReleased(record){if(contexts.has(record)||admissions.has(record))throw fail('durable_release_required');},
    async context(broker,record,expectedRoot){
      broker.assertLive(record);
      const entry=record.vault;
      if(record.vaultSelectionPending||!entry||entry.service.root!==expectedRoot)throw fail('durable_scope_changed');
      if(!fixture&&record.persistedVaultRoot!==expectedRoot)throw fail('client_registry_unsettled');
      if(!services.has(entry.service))return null;
      const existing=contexts.get(record);if(existing){existing.check();return describe(existing);}
      const inFlight=admissions.get(record);if(inFlight)return inFlight;
      const generation=record.generation,service=entry.service;
      const check=()=>{
        broker.assertLive(record);
        if(closed||record.vaultSelectionPending||record.generation!==generation||record.vault!==entry||service.closed
          ||!broker.allowedURL(record.window.webContents.mainFrame.url))throw fail('durable_scope_changed');
      };
      check();
      const pending=(async()=>{
        const admission=await admitDesktopFixtureClient(service,{fixture:true,clientId:fixture&&record.id==='main'?config.clientId:record.clientSlot?.clientId,assertOwner:check});
        try {check();}
        catch(error){await admission.retire();throw error;}
        const saved={id:randomUUID(),admission,service,check:(allowRetired=false)=>{check();if((saved.runtimeRetired||saved.draftsRetired)&&!allowRetired)throw fail('client_not_admitted');}};contexts.set(record,saved);
        try{
          if(admission.metadataRowsAvailable===true&&typeof admission.documentCommand!=='function')throw fail('unsupported_host_capability');
          if(admission.draftsAvailable===true){
            if(!documentRuntime||!runtimeAvailable(admission)||typeof options.onDocumentRuntimeNudge!=='function'||!admission.documentCommand||!admission.documentDrafts||!['invoke','subscribe'].every(name=>typeof admission.documentDrafts[name]==='function'))throw fail('unsupported_host_capability');
            const publish=retired=>{
              try{
                if(contexts.get(record)!==saved||saved.draftsRetired)return;
                if(retired){broker.assertLive(record);if(record.vaultSelectionPending||record.vault!==entry||record.generation!==generation||!broker.allowedURL(record.window.webContents.mainFrame.url))return;saved.draftsRetired=true;}
                else check();
                options.onDocumentRuntimeNudge(record,{vault:expectedRoot,admissionId:saved.id,...(retired?{retired:true}:{})});
              }catch{/* Only this admitted receiver may observe hints. */}
            };
            const stopDrafts=admission.documentDrafts.subscribe(()=>publish(false),()=>publish(true));
            if(typeof stopDrafts!=='function')throw fail('invalid_document_response');saved.stopDrafts=stopDrafts;saved.check();
          }
          if(documentRuntime){
            if(!runtimeAvailable(admission))throw fail('unsupported_host_capability');
            const publish=retired=>{
              try{
                if(contexts.get(record)!==saved||saved.runtimeRetired)return;
                if(retired){
                  broker.assertLive(record);
                  if(record.vaultSelectionPending||record.vault!==entry||record.generation!==generation||!broker.allowedURL(record.window.webContents.mainFrame.url))return;
                  saved.runtimeRetired=true;
                }else check();
                options.onDocumentRuntimeNudge(record,{vault:expectedRoot,admissionId:saved.id,...(retired?{retired:true}:{})});
              }catch{/* A revoked window cannot receive a late derived-state hint. */}
            };
            const stopRuntime=admission.documentRuntime.subscribe(()=>publish(false),()=>publish(true));
            if(typeof stopRuntime!=='function')throw fail('invalid_document_response');
            saved.stopRuntime=stopRuntime;
            saved.check();
          }
        }catch(error){if(contexts.get(record)===saved)contexts.delete(record);try{saved.stopRuntime?.();saved.stopDrafts?.();}finally{await admission.retire();}throw error;}
        return describe(saved);
      })();
      admissions.set(record,pending);
      try{return await pending;}finally{if(admissions.get(record)===pending)admissions.delete(record);}
    },
    async invoke(broker,record,event,expectedRoot,admissionId,method,args){
      broker.authenticate(event);
      const saved=checked(broker,record,expectedRoot,admissionId);
      if(typeof method!=='string'||!Array.isArray(args)||args.length>2)throw fail('invalid_durable_request');
      if(Object.hasOwn(runtimeMethods,method)){
        if(!documentRuntime||!runtimeAvailable(saved.admission)||args.length!==(method==='documentRuntimeObserve'?0:1))throw fail('invalid_durable_request');
        const captured=captureDocumentRuntimeRequest(method,args);
        const value=await saved.admission.documentRuntime[runtimeMethods[method]](...captured);
        checked(broker,record,expectedRoot,admissionId);
        if(contexts.get(record)!==saved)throw fail('durable_scope_changed');
        return captureDocumentRuntimeReply(method,captured,value,{localStoreId:saved.admission.scope.vaultId,clientId:saved.admission.scope.clientId});
      }
      if(method==='workblockCommand'){
        if(args.length!==1||!saved.admission.workblockCommand)throw fail('invalid_durable_request');
        return saved.admission.workblockCommand(args[0]);
      }
      if(method==='documentCommand'){
        if(args.length!==1||!saved.admission.documentCommand)throw fail('invalid_durable_request');
        return saved.admission.documentCommand(args[0]);
      }
      if(method==='documentDrafts'){
        if(args.length!==2||saved.admission.draftsAvailable!==true||typeof saved.admission.documentDrafts?.invoke!=='function')throw fail('invalid_durable_request');
        const value=await saved.admission.documentDrafts.invoke(args[0],args[1]);checked(broker,record,expectedRoot,admissionId);
        if(contexts.get(record)!==saved)throw fail('durable_scope_changed');return value;
      }
      if(method==='binaryCommand'){
        if(args.length!==1||!(args[0] instanceof Uint8Array)||!args[0].length||args[0].byteLength>MAX_BINARY_FRAME||!saved.admission.binaryCommand)throw fail('invalid_durable_request');
        // Admission snapshots the one bounded protobuf frame synchronously.
        return saved.admission.binaryCommand(args[0]);
      }
      const captured=structuredClone(args);
      if(method==='createText'||method==='fileCommand'){
        if(captured.length!==1||!saved.admission[method])throw fail('invalid_durable_request');
        return saved.admission[method](captured[0]);
      }
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
      // Authoritative retirement may precede a lost outer release ACK. Keep
      // exact release retry available without readmitting public operations.
      const saved=checked(broker,record,expectedRoot,admissionId,true);
      // Renderer lifecycle owner has awaited its final checkpoint/flush before
      // requesting release. The admission layer drains already accepted RPCs.
      await saved.admission.release(()=>{});
      saved.stopRuntime?.();saved.stopDrafts?.();
      if(contexts.get(record)===saved)contexts.delete(record);
      released.set(record,{id:admissionId,root:expectedRoot,service:saved.service,admission:saved.admission});
    },
    retire,
    close(){
      if(closePromise)return closePromise;
      closed=true;
      closePromise=(async()=>{
        await Promise.allSettled([...openings.values(),...admissions.values(),...retirements.values()].filter(Boolean));
        for(const saved of contexts.values()){saved.stopRuntime?.();saved.stopDrafts?.();}contexts.clear();await Promise.all([...services].map(service=>service.close()));services.clear();
      })();return closePromise;
    },
  };
}
module.exports={createEditorCoreManager};
