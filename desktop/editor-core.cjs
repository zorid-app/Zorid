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
const {captureSavedSourceWitness,captureSavedSourceId,captureSavedSourceValue}=require('./conditional-saved-source.cjs');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail=code=>Object.assign(new Error('Rust vault operation failed.'),{code});
const runtimeUnavailable=()=>Object.assign(new Error('The desktop core does not support document indexing. Update Zorid and restart the app.'),{code:'document_runtime_unavailable'});
const methods=new Set(['readText','readTextById','composeNote','planWrite','prepare','commit','query','listUnacknowledged','acknowledge']);
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
  // Trusted startup requires core scheduling; missing delivery must not select
  // the foreground compatibility path.
  const documentRuntime=options.documentRuntime===true;
  if(documentRuntime&&typeof options.onDocumentRuntimeNudge!=='function')throw runtimeUnavailable();
  const contexts=new Map(), admissions=new Map(), released=new WeakMap(), services=new Set(), openings=new Map(), retirements=new Map(), recovering=new Map(), replacements=new Map(), recoveryStates=new WeakMap();
  const describe=saved=>({admissionId:saved.id,scope:saved.admission.scope,...(saved.admission.createTextReceipt?{textCreateReceiptsAvailable:true}:{}),...(saved.admission.conditionalSavedSourceAvailable===true?{conditionalSavedSourceAvailable:true}:{}),...(saved.admission.documentCommand?{documentSemantics:true}:{}),...(saved.admission.metadataRowsAvailable===true?{metadataRowsAvailable:true}:{}),...(saved.admission.propertyTargetsAvailable===true?{propertyTargetsAvailable:true}:{}),...(saved.admission.basePreviewAvailable===true?{basePreviewAvailable:true}:{}),...(saved.admission.draftsAvailable===true?{draftsAvailable:true}:{}),...(documentRuntime&&runtimeAvailable(saved.admission)?{documentMaintenance:true}:{}),...(saved.admission.workblockCommand?{workBlocks:true}:{}),...(saved.admission.databaseCommand?{databases:true}:{}),...(saved.admission.binaryLimits?{binaryLimits:saved.admission.binaryLimits}:{})});
  const executable=()=>require('./host-location.cjs').resolveDesktopHost({...options,override:config.executable});
  const terminated=service=>!!(service?.host?.fatal||service?.host?.exited);
  function openService(canonical){
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
  }
  function replaceTerminatedService(broker,entry,service){
    if(entry.service!==service)return terminated(entry.service)?replaceTerminatedService(broker,entry,entry.service):Promise.resolve(entry.service);
    const previous=replacements.get(service);if(previous)return previous;
    const pending=(async()=>{
      if(!terminated(service))throw fail('recovery_not_available');
      // Closing waits for the failed process to exit before a fresh native host
      // can claim the same persistent clients. No old lease is revived.
      await service.close();
      if(closed)throw fail('editor_core_closed');
      if(entry.service!==service)return entry.service;
      const oldOpening=openings.get(service.root);
      if(oldOpening&&await oldOpening===service&&openings.get(service.root)===oldOpening)openings.delete(service.root);
      const next=await openService(service.root);
      if(closed)throw fail('editor_core_closed');
      if(entry.service!==service)throw fail('durable_scope_changed');
      entry.unsubscribe?.();entry.unsubscribe=null;entry.service=next;services.delete(service);
      if(entry.members.size)entry.unsubscribe=next.subscribe(change=>broker.broadcast(entry,change));
      return next;
    })();
    replacements.set(service,pending);entry.retiring=pending;
    const clear=()=>{if(replacements.get(service)===pending)replacements.delete(service);if(entry.retiring===pending)delete entry.retiring;};
    void pending.then(clear,clear);return pending;
  }
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
      return openService(canonical);
    },
    async recover(broker,record,event,expectedRoot,admissionId){
      broker.authenticate(event);
      const previous=recovering.get(record);
      if(previous){if(previous.root!==expectedRoot||previous.id!==admissionId)throw fail('durable_scope_changed');previous.check();return previous.promise;}
      const current=contexts.get(record),entry=record.vault;
      let state=recoveryStates.get(record);
      if(!state||state.id!==admissionId){
        if(closed||!current||current.id!==admissionId||current.service.root!==expectedRoot||current.entry!==entry||current.generation!==record.generation)throw fail('durable_scope_changed');
        const dead=terminated(current.service);
        if(dead?typeof current.admission.abandonTerminatedHost!=='function':!current.runtimeRetired&&!current.draftsRetired)throw fail('recovery_not_available');
        state={id:admissionId,root:expectedRoot,saved:current,scope:{...current.admission.scope},retired:false,replacementId:null};
        recoveryStates.set(record,state);
      }
      const {saved,scope}=state;
      const check=()=>{broker.authenticate(event);if(closed||state.root!==expectedRoot||record.vault!==saved.entry||record.generation!==saved.generation||record.vaultSelectionPending||record.persistedVaultRoot!==expectedRoot||record.clientSlot?.clientId!==scope.clientId)throw fail('durable_scope_changed');};
      check();
      if(current&&current!==saved){
        if(state.replacementId&&current.id!==state.replacementId)throw fail('durable_scope_changed');
        current.check();
        if(current.admission.scope.vaultId!==scope.vaultId||current.admission.scope.clientId!==scope.clientId)throw fail('durable_scope_changed');
        state.replacementId=current.id;return describe(current);
      }
      const pending=(async()=>{
        check();
        if(!state.retired){
          if(terminated(saved.service))await saved.admission.abandonTerminatedHost();
          else await saved.admission.release(()=>{});
          state.retired=true;
        }
        check();
        const service=terminated(saved.service)?await replaceTerminatedService(broker,entry,saved.service):saved.service;check();
        saved.stopRuntime?.();saved.stopDrafts?.();
        if(contexts.has(record)&&contexts.get(record)!==saved)throw fail('durable_scope_changed');
        contexts.delete(record);
        released.set(record,{id:admissionId,root:expectedRoot,service:saved.service,admission:saved.admission});
        // Never replay source operations. The renderer retains its exact pending
        // checkpoint revision and write reference across this lease replacement.
        admissions.delete(record);
        const next=await this.context(broker,record,expectedRoot,scope);check();
        if(contexts.get(record)?.service!==service)throw fail('durable_scope_changed');
        state.replacementId=next.admissionId;return next;
      })();
      recovering.set(record,{root:expectedRoot,id:admissionId,promise:pending,check});admissions.set(record,pending);
      void pending.finally(()=>{if(recovering.get(record)?.promise===pending)recovering.delete(record);if(admissions.get(record)===pending)admissions.delete(record);}).catch(()=>{});
      return pending;
    },
    requireReleased(record){if(contexts.has(record)||admissions.has(record))throw fail('durable_release_required');},
    async context(broker,record,expectedRoot,recoveryScope){
      broker.assertLive(record);
      const entry=record.vault;
      if(record.vaultSelectionPending||!entry||entry.service.root!==expectedRoot)throw fail('durable_scope_changed');
      if(!fixture&&record.persistedVaultRoot!==expectedRoot)throw fail('client_registry_unsettled');
      if(!services.has(entry.service))return null;
      const existing=contexts.get(record);if(existing){existing.check();return describe(existing);}
      const inFlight=admissions.get(record);if(inFlight)return inFlight;
      const recoveringState=recoveryStates.get(record);
      if(recoveringState&&!recoveringState.replacementId&&recoveringState.root===expectedRoot&&recoveringState.saved.entry===entry&&recoveringState.saved.generation===record.generation)recoveryScope??=recoveringState.scope;
      const generation=record.generation,service=entry.service;
      const check=()=>{
        broker.assertLive(record);
        if(closed||record.vaultSelectionPending||record.generation!==generation||record.vault!==entry||service.closed
          ||!broker.allowedURL(record.window.webContents.mainFrame.url))throw fail('durable_scope_changed');
      };
      check();
      const pending=(async()=>{
        const admission=await admitDesktopFixtureClient(service,{fixture:true,clientId:fixture&&record.id==='main'?config.clientId:record.clientSlot?.clientId,assertOwner:check,...(recoveryScope?{expectedScope:recoveryScope}:{})});
        try {check();if(recoveryScope&&(admission.scope.vaultId!==recoveryScope.vaultId||admission.scope.clientId!==recoveryScope.clientId))throw fail('durable_scope_changed');}
        catch(error){await admission.retire();throw error;}
        const saved={id:randomUUID(),admission,service,entry,generation,check:(allowRetired=false)=>{check();if((saved.runtimeRetired||saved.draftsRetired)&&!allowRetired)throw fail('client_not_admitted');}};contexts.set(record,saved);
        try{
          if(admission.conditionalSavedSourceAvailable===true&&!['captureSavedSource','releaseSavedSource'].every(name=>typeof admission.durableWrites?.[name]==='function'))throw fail('unsupported_host_capability');
          if(documentRuntime&&(!runtimeAvailable(admission)||typeof admission.documentCommand!=='function'))throw runtimeUnavailable();
          if(admission.metadataRowsAvailable===true&&typeof admission.documentCommand!=='function')throw fail('unsupported_host_capability');
          if(admission.basePreviewAvailable===true&&(!documentRuntime||!runtimeAvailable(admission)||typeof options.onDocumentRuntimeNudge!=='function'||typeof admission.documentCommand!=='function'))throw fail('unsupported_host_capability');
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
      if(method==='databaseCommand'){
        if(args.length!==1||!saved.admission.databaseCommand)throw fail('invalid_durable_request');
        return saved.admission.databaseCommand(args[0]);
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
      if(method==='captureSavedSource'||method==='releaseSavedSource'){
        if(args.length!==1||saved.admission.conditionalSavedSourceAvailable!==true||typeof saved.admission.durableWrites?.[method]!=='function')throw fail('invalid_durable_request');
        // Validate and snapshot this small control record before any clone or
        // await; physical source text is never a caller-authored capture input.
        const input=method==='captureSavedSource'?captureSavedSourceWitness(args[0]):captureSavedSourceId(args[0]);
        const value=await saved.admission.durableWrites[method](input);
        checked(broker,record,expectedRoot,admissionId);
        if(contexts.get(record)!==saved)throw fail('durable_scope_changed');
        return method==='captureSavedSource'?captureSavedSourceValue(value,input):undefined;
      }
      const captured=structuredClone(args);
      if(method==='createText'||method==='createTextReceipt'||method==='fileCommand'){
        if(captured.length!==1||!saved.admission[method])throw fail('invalid_durable_request');
        return saved.admission[method](captured[0]);
      }
      const prefix='checkpoints.';
      if(method.startsWith(prefix)){
        const name=method.slice(prefix.length);if(!checkpointMethods.has(name))throw fail('invalid_durable_request');
        return saved.admission.durableWrites.checkpoints[name](...captured);
      }
      if(!methods.has(method)||typeof saved.admission.durableWrites[method]!=='function')throw fail('invalid_durable_request');
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
