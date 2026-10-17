'use strict';
const { desktopDurableWrites } = require('./durable-writes.cjs');
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
  let phase = 'admitting', closing = null, flushed = false, activeFlush = null;
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
        ...Object.fromEntries(methods.map(name => [name, (...args) => invoke(() => capability[name](...args), flushToken)])),
        checkpoints: Object.freeze({ scope,
          ...Object.fromEntries(['load', 'compareAndSwap', 'list', 'changes'].map(name => [name, (...args) => invoke(() => capability.checkpoints[name](...args), flushToken)])),
        }),
      });
    }
    const writes = wrap(null);
    async function drain() { while (pending.size) await Promise.allSettled([...pending]); }
    const context = Object.freeze({
      scope, durableWrites: writes, assertActive: () => allowed(),
      release(flushGate) {
        if (phase === 'released') return Promise.resolve();
        if (closing) return closing;
        if (typeof flushGate !== 'function') return Promise.reject(fail('flush_gate_required'));
        if (phase !== 'active' && phase !== 'release_unknown') return Promise.reject(fail('client_not_admitted'));
        const retryRelease = phase === 'release_unknown' && flushed;
        phase = retryRelease ? 'releasing' : 'flushing';
        closing = (async () => {
          if (!retryRelease) {
            try {
              // Stop external admission, settle accepted work, then let the
              // editor persist/flush through the dedicated gate capability.
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
            } catch (reason) { phase = 'active'; throw reason; }
          }
          phase = 'releasing';
          try { await host.releaseClient(reference); phase = 'released'; }
          catch (reason) { phase = 'release_unknown'; throw reason; }
        })().finally(() => { closing = null; });
        return closing;
      },
    });
    return context;
  } catch (reason) {
    phase = 'releasing';
    try { await host.releaseClient(reference); } catch { throw fail('admission_cleanup_unknown', true); }
    throw reason;
  }
}
module.exports = { admitDesktopFixtureClient };
