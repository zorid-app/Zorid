'use strict';
const { desktopDurableWrites } = require('./durable-writes.cjs');
const { desktopTextCreates } = require('./text-create.cjs');
const { createDesktopDocumentSemantics } = require('./document-semantics.cjs');
const {captureDatabaseRequest,isDatabaseMutation}=require('./databases.cjs');
const {captureWorkBlockRequest}=require('./workblocks.cjs');
const { MAX_BINARY_FRAME } = require('./rust-vault-service.cjs');
const {captureDraftRequest,captureDraftBody,MAX_DRAFT_CHUNK}=require('./document-drafts.cjs');
const {AsyncLocalStorage}=require('node:async_hooks');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function fail(code, uncertain = false) { return Object.assign(new Error('Desktop fixture consumer is not admitted.'), { code, commitUncertain: uncertain }); }

/** Trusted main-process fixture entry point, never an IPC handler. clientId is a
 * fixed main-created fixture UUID, not a renderer parameter or production slot.
 * assertOwner must verify the selected WindowBroker record/grant generation.
 * Returns an injected editor context: {scope,durableWrites,assertActive,release}.
 */
async function admitDesktopFixtureClient(service, { fixture, clientId, assertOwner, expectedScope, captureDispatchOwner } = {}) {
  if (fixture !== true || !uuid(clientId) || typeof assertOwner !== 'function'||captureDispatchOwner!==undefined&&typeof captureDispatchOwner!=='function') throw fail('invalid_admission');
  const host = service.host;
  let phase = 'admitting', closing = null, flushed = false, releasePrepared = false, activeFlush = null, runtime = null, drafts = null,draftRetired=false;
  const pending = new Set();
  const dispatchOwners=new AsyncLocalStorage();
  function live() {
    if (service.closed || host.fatal || host.exited) throw fail('client_ownership_lost', true);
    assertOwner();
  }
  live();
  const reference = await host.claimClient(clientId);
  const releaseLease=()=>drafts?service.releaseDocumentDraftClient(reference):host.releaseClient(reference);
  try {
    live();
    // Recovery must verify the persistent authority before consumer admission
    // can inspect or replay any namespace recovery checkpoints in that store.
    if(expectedScope&&(reference.local_store_id!==expectedScope.vaultId||reference.client_id!==expectedScope.clientId))throw fail('durable_scope_changed');
    const shadow = Object.create(service);
    const guarded = host.withClientLease(reference, () => {
      if (!['admitting', 'active', 'flushing'].includes(phase)) throw fail('client_not_admitted');
      // This runs again at each actual RPC, including commit after query/prepare.
      live();
      dispatchOwners.getStore()?.();
    });
    Object.defineProperty(shadow, 'host', { value: guarded });
    const capability = await desktopDurableWrites(shadow, { clientId });
    if (capability.checkpoints.scope.vaultId !== reference.local_store_id || capability.checkpoints.scope.clientId !== reference.client_id) throw fail('client_scope_mismatch');
    let creates;
    if(service.familyMode){
      if(!host.capabilities?.includes('file_command'))throw fail('unsupported_host_capability');
      creates=desktopTextCreates(shadow,capability.checkpoints);
      await creates.recover();
    }
    live(); phase = 'active';
    const scope = capability.checkpoints.scope;
    function allowed(flushToken = null) {
      if (flushToken === null ? phase !== 'active' : phase !== 'flushing' || activeFlush !== flushToken) throw fail('client_not_admitted');
      live();
    }
    function invoke(action, flushToken) {
      try {
        allowed(flushToken);
        const owner=captureDispatchOwner?.();
        if(captureDispatchOwner&&typeof owner!=='function')throw fail('invalid_admission');
        // Carry the accepted document identity through provider awaits and
        // every queued Native dispatch, without replacing the client lease.
        const result = owner?dispatchOwners.run(owner,action):action();
        const tracked = Promise.resolve(result).finally(() => pending.delete(tracked));
        pending.add(tracked);
        return tracked;
      } catch (reason) { return Promise.reject(reason); }
    }
    function wrap(flushToken) {
      const methods = ['readText', 'readTextById', 'planWrite', 'prepare', 'commit', 'query', 'listUnacknowledged', 'acknowledge',
        ...(typeof capability.composeNote==='function'?['composeNote']:[]),
        ...(['captureSavedSource', 'releaseSavedSource', 'listSavedSourceRequests'].every(name=>typeof capability[name]==='function') ? ['captureSavedSource', 'releaseSavedSource', 'listSavedSourceRequests'] : [])];
      return Object.freeze({
        ...Object.fromEntries(methods.map(name => [name, (...args) => invoke(async() => {const value=await capability[name](...args);if(name==='commit')service.documentRuntimeSourceHint?.();if(name==='captureSavedSource'||name==='listSavedSourceRequests')live();return value;}, flushToken)])),
        checkpoints: Object.freeze({ scope,
          ...Object.fromEntries(['load', 'compareAndSwap', 'list', 'changes'].map(name => [name, (...args) => invoke(() => capability.checkpoints[name](...args), flushToken)])),
        }),
      });
    }
    let binaryPending=false;
    const binaryCommand=bytes=>{
      if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.byteLength>MAX_BINARY_FRAME)return Promise.reject(fail('request_limit'));
      if(binaryPending)return Promise.reject(fail('binary_busy'));
      binaryPending=true;
      return invoke(()=>guarded.binaryCommand(clientId,bytes),null).finally(()=>{binaryPending=false;});
    };
    const metadataRowsAvailable=host.capabilities?.includes('document_metadata_rows')===true;
    if(metadataRowsAvailable&&(!host.capabilities?.includes('documents')||typeof guarded.documentCommand!=='function'))throw fail('unsupported_host_capability');
    const propertyTargetsAvailable=host.capabilities?.includes('document_property_targets')===true;
    if(propertyTargetsAvailable&&(!host.capabilities?.includes('documents')||typeof guarded.documentCommand!=='function'))throw fail('unsupported_host_capability');
    const basePreviewAvailable=service.documentRuntimeEnabled===true&&host.capabilities?.includes('document_base_preview')===true;
    if(basePreviewAvailable&&(!host.capabilities?.includes('documents')||typeof guarded.documentCommand!=='function'||typeof service.registerDocumentRuntimeOwner!=='function'))throw fail('unsupported_host_capability');
    const documents=host.capabilities?.includes('documents')?createDesktopDocumentSemantics(guarded,clientId,reference.local_store_id,{metadataRowsAvailable,basePreviewAvailable,propertyTargetsAvailable}):null;
    const draftsAvailable=service.documentRuntimeEnabled===true&&host.capabilities?.includes('document_drafts')===true;
    if(draftsAvailable){
      if(!documents||typeof guarded.documentDrafts!=='function'||typeof service.registerDocumentDraftOwner!=='function'||typeof service.releaseDocumentDraftClient!=='function')throw fail('unsupported_host_capability');
      const owner=service.registerDocumentDraftOwner({host:guarded,clientId,localStoreId:reference.local_store_id,assertActive:live});
      if(!owner||!['notify','subscribe','revoke','release'].every(name=>typeof owner[name]==='function'))throw fail('unsupported_host_capability');
      drafts=owner;
    }
    let draftPending=0,draftBytes=0;
    const documentDrafts=drafts?Object.freeze({
      invoke:(input,bytes=new Uint8Array())=>invoke(()=>{
        if(draftRetired)throw fail('client_not_admitted');const request=captureDraftRequest(input);
        if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_DRAFT_CHUNK||request.op!=='upload_chunk'&&bytes.byteLength!==0)throw fail('draft_invalid_chunk');
        if(draftPending>=32||draftBytes+bytes.byteLength>32*MAX_DRAFT_CHUNK)throw fail('draft_capacity');
        const size=bytes.byteLength;draftPending++;draftBytes+=size;let body;
        try{body=captureDraftBody(request,bytes);}catch(error){draftPending--;draftBytes-=size;throw error;}
        return (async()=>{
          try{
            let result;try{result=await guarded.documentDrafts(clientId,request,body);}catch(error){if(draftRetired)throw fail('client_not_admitted');live();throw error;}
            if(draftRetired)throw fail('client_not_admitted');live();drafts.notify(request,result);return result;
          }finally{draftPending--;draftBytes-=size;}
        })();
      },null),
      subscribe:(listener,onRetire)=>{allowed();if(draftRetired)throw fail('client_not_admitted');return drafts.subscribe(listener,onRetire);},
    }):null;
    const databasesAvailable=host.capabilities?.includes('databases')===true;
    if(databasesAvailable&&typeof guarded.databaseCommand!=='function')throw fail('unsupported_host_capability');
    const databaseCommand=input=>invoke(async()=>{
      const request=captureDatabaseRequest(input);
      const value=await guarded.databaseCommand(clientId,request);
      try{live();}catch(error){
        if(isDatabaseMutation(request.command.op))throw Object.assign(new Error('Collection acknowledgement is uncertain.'),{code:'client_ownership_lost',commitUncertain:true});
        throw error;
      }
      if(isDatabaseMutation(request.command.op)){
        service.documentRuntimeSourceHint?.();
        // Schema/membership may change without a file event (or publication may
        // remain pending). Wake all admitted vault viewers after durable commit.
        service.databaseChanged?.();
      }
      return value;
    },null);
    const workblockCommand=input=>invoke(async()=>{
      const request=captureWorkBlockRequest(input);
      const value=await guarded.workblockCommand(clientId,request);
      // A late response to a revoked window must not revive a capability.
      try{live();}catch(error){
        // A committed response hidden by revocation still requires identical-ID
        // replay. Losing renderer admission cannot turn it into a rejection.
        if(!['read','window','changes'].includes(request.command.op))throw Object.assign(new Error('WorkBlock acknowledgement is uncertain.'),{code:'client_ownership_lost',commitUncertain:true});
        throw error;
      }
      return value;
    },null);
    const documentCommand=input=>invoke(async()=>{const value=await documents.invoke(input);live();return value;},null);
    if(service.documentRuntimeEnabled){
      const owner=service.registerDocumentRuntimeOwner({host:guarded,clientId,localStoreId:reference.local_store_id,assertActive:live});
      if((draftsAvailable||basePreviewAvailable)&&(!owner||!['observe','control','ackControl','ackOutcome','subscribe','pause','resume','prepareRelease','release','revoke'].every(name=>typeof owner[name]==='function')))throw fail('unsupported_host_capability');
      runtime=owner;
    }
    const documentRuntime=runtime?Object.freeze({
      observe:()=>invoke(()=>runtime.observe(),null),
      control:input=>invoke(()=>runtime.control(input),null),
      ackControl:input=>invoke(()=>runtime.ackControl(input),null),
      ackOutcome:input=>invoke(()=>runtime.ackOutcome(input),null),
      subscribe:(listener,onRetire)=>{allowed();return runtime.subscribe(listener,onRetire);},
    }):null;
    const writes = wrap(null);
    async function drain() { while (pending.size) await Promise.allSettled([...pending]); }
    const context = Object.freeze({
      scope, durableWrites: writes, assertActive: () => allowed(),
      async drainAccepted(){allowed();await drain();allowed();},
      ...(host.capabilities?.includes('conditional_saved_source_requests') === true ? {conditionalSavedSourceAvailable:true} : {}),
      ...(documents?{documentCommand}:{}),
      ...(metadataRowsAvailable?{metadataRowsAvailable:true}:{}),
      ...(propertyTargetsAvailable?{propertyTargetsAvailable:true}:{}),
      ...(basePreviewAvailable?{basePreviewAvailable:true}:{}),
      ...(documentDrafts?{draftsAvailable:true,documentDrafts}:{}),
      ...(documentRuntime?{documentRuntime}:{}),
      ...(host.capabilities?.includes('workblocks')?{workblockCommand}:{}),
      ...(databasesAvailable?{databaseCommand}:{}),
      ...(host.capabilities?.includes('binary_streams')?{binaryCommand,binaryLimits:host.binaryLimits}:{}),
      ...(creates?{createText:input=>invoke(async()=>{const value=await creates.create(input);service.documentRuntimeSourceHint?.();return value;},null),createTextReceipt:input=>invoke(async()=>{const value=await creates.createReceipt(input);service.documentRuntimeSourceHint?.();return value;},null),fileCommand:input=>invoke(async()=>{const value=await creates.execute(input);service.documentRuntimeSourceHint?.();return value;},null)}:{}),
      async abandonTerminatedHost() {
        // A dead transport cannot acknowledge lease release. Fence its old
        // capabilities, settle accepted calls and leave durable recovery intact.
        // A healthy/uncertain release must still use its exact release protocol.
        if (!host.fatal && !host.exited) throw fail('recovery_not_available');
        phase='retiring';activeFlush=null;draftRetired=true;drafts?.revoke();
        await runtime?.revoke();await drain();
        drafts?.release();documents?.forget();phase='released';
      },
      async retire() {
        // Window has gone away. Drain accepted calls and drop ownership only;
        // leave every checkpoint/intent intact for the same slot on restart.
        if(phase==='released')return;
        if(closing)await closing.catch(()=>{});
        phase='retiring';activeFlush=null;
        draftRetired=true;drafts?.revoke();
        await runtime?.revoke();
        await drain();await releaseLease();drafts?.release();documents?.forget();phase='released';
      },
      release(flushGate) {
        if (phase === 'released') return Promise.resolve();
        if (closing) return closing;
        if (typeof flushGate !== 'function') return Promise.reject(fail('flush_gate_required'));
        if (phase !== 'active' && phase !== 'release_unknown') return Promise.reject(fail('client_not_admitted'));
        const retryRelease = phase === 'release_unknown' && flushed;
        phase = 'flushing';
        closing = (async () => {
          if (!retryRelease) {
            try {
              // Stop external admission, settle accepted work, then let the
              // editor persist/flush through the dedicated gate capability.
              await runtime?.pause();
              await drain();
              const token = Symbol('flush-attempt');
              activeFlush = token;
              const flushContext = Object.freeze({ scope, durableWrites: wrap(token), assertActive: () => allowed(token) });
              let gateFailed = false, gateError;
              try {
                const result = flushGate(flushContext);
                if (result && typeof result.then === 'function') await result;
              } catch (reason) { gateFailed = true; gateError = reason; }
              finally { activeFlush = null; }
              // Revocation blocks new calls, including a retained capability
              // from this attempt. Already accepted calls still finish while
              // the native lease and dispatch guard remain in flushing phase.
              await drain();
              if (gateFailed) throw gateError;
              flushed = true;
            } catch (reason) { phase = 'active';try{runtime?.resume();}catch{}throw reason; }
          }
          // Retire only after a successful flush, while the original dispatch
          // guard still admits already-owned maintenance work. An uncertain
          // native release retries just the same lease; it never repeats a flush.
          if(!releasePrepared){
            try{await runtime?.prepareRelease();releasePrepared=true;}
            // Retire may already have been accepted. Keep this exact release
            // retry-only; never resume an irreversibly retired lifetime.
            catch(reason){phase='release_unknown';throw reason;}
          }
          phase = 'releasing';
          draftRetired=true;drafts?.revoke();
          try { await releaseLease();drafts?.release();runtime?.release();documents?.forget();phase='released'; }
          catch (reason) { phase = 'release_unknown'; throw reason; }
        })().finally(() => { closing = null; });
        return closing;
      },
    });
    return context;
  } catch (reason) {
    draftRetired=true;drafts?.revoke();
    await runtime?.revoke();
    phase = 'releasing';
    try { await releaseLease(); } catch { throw fail('admission_cleanup_unknown', true); }
    throw reason;
  }
}
module.exports = { admitDesktopFixtureClient };
