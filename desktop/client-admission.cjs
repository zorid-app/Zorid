'use strict';
const { desktopDurableWrites } = require('./durable-writes.cjs');
const { desktopTextCreates } = require('./text-create.cjs');
const { createDesktopDocumentSemantics } = require('./document-semantics.cjs');
const {captureWorkBlockRequest}=require('./workblocks.cjs');
const { MAX_BINARY_FRAME } = require('./rust-vault-service.cjs');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function fail(code, uncertain = false) { return Object.assign(new Error('Desktop fixture consumer is not admitted.'), { code, commitUncertain: uncertain }); }

/** Trusted main-process fixture entry point, never an IPC handler. clientId is a
 * fixed main-created fixture UUID, not a renderer parameter or production slot.
 * assertOwner must verify the selected WindowBroker record/grant generation.
 * Returns an injected editor context: {scope,durableWrites,assertActive,release}.
 */
async function admitDesktopFixtureClient(service, { fixture, clientId, assertOwner } = {}) {
  if (fixture !== true || !uuid(clientId) || typeof assertOwner !== 'function') throw fail('invalid_admission');
  const host = service.host;
  let phase = 'admitting', closing = null, flushed = false, releasePrepared = false, activeFlush = null, runtime = null;
  const pending = new Set();
  function live() {
    if (service.closed || host.fatal || host.exited) throw fail('client_ownership_lost', true);
    assertOwner();
  }
  live();
  const reference = await host.claimClient(clientId);
  try {
    live();
    const shadow = Object.create(service);
    const guarded = host.withClientLease(reference, () => {
      if (!['admitting', 'active', 'flushing'].includes(phase)) throw fail('client_not_admitted');
      // This runs again at each actual RPC, including commit after query/prepare.
      live();
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
        const result = action(); // Snapshot provider args synchronously, before any await.
        const tracked = Promise.resolve(result).finally(() => pending.delete(tracked));
        pending.add(tracked);
        return tracked;
      } catch (reason) { return Promise.reject(reason); }
    }
    function wrap(flushToken) {
      const methods = ['readText', 'readTextById', 'planWrite', 'prepare', 'commit', 'query', 'listUnacknowledged', 'acknowledge'];
      return Object.freeze({
        ...Object.fromEntries(methods.map(name => [name, (...args) => invoke(async() => {const value=await capability[name](...args);if(name==='commit')service.documentRuntimeSourceHint?.();return value;}, flushToken)])),
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
    const documents=host.capabilities?.includes('documents')?createDesktopDocumentSemantics(guarded,clientId,reference.local_store_id):null;
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
      runtime=service.registerDocumentRuntimeOwner({host:guarded,clientId,localStoreId:reference.local_store_id,assertActive:live});
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
      ...(documents?{documentCommand}:{}),
      ...(documentRuntime?{documentRuntime}:{}),
      ...(host.capabilities?.includes('workblocks')?{workblockCommand}:{}),
      ...(host.capabilities?.includes('binary_streams')?{binaryCommand,binaryLimits:host.binaryLimits}:{}),
      ...(creates?{createText:input=>invoke(async()=>{const value=await creates.create(input);service.documentRuntimeSourceHint?.();return value;},null),fileCommand:input=>invoke(async()=>{const value=await creates.execute(input);service.documentRuntimeSourceHint?.();return value;},null)}:{}),
      async retire() {
        // Window has gone away. Drain accepted calls and drop ownership only;
        // leave every checkpoint/intent intact for the same slot on restart.
        if(phase==='released')return;
        if(closing)await closing.catch(()=>{});
        phase='retiring';activeFlush=null;
        await runtime?.revoke();
        await drain();await host.releaseClient(reference);documents?.forget();phase='released';
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
          try { await host.releaseClient(reference);runtime?.release();documents?.forget();phase='released'; }
          catch (reason) { phase = 'release_unknown'; throw reason; }
        })().finally(() => { closing = null; });
        return closing;
      },
    });
    return context;
  } catch (reason) {
    await runtime?.revoke();
    phase = 'releasing';
    try { await host.releaseClient(reference); } catch { throw fail('admission_cleanup_unknown', true); }
    throw reason;
  }
}
module.exports = { admitDesktopFixtureClient };
