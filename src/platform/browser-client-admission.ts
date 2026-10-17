import { BrowserVaultError } from '../core/browser-vault.ts';
import type { CheckpointScope, DurableCheckpoints } from '../core/durable-checkpoints.ts';
import type { DurableWrites } from '../core/durable-writes.ts';
import type { BrowserCoreRuntime } from './browser-core-runtime.ts';
import type { BrowserCoreBackend } from './browser-core.ts';
import { browserDurableWrites } from './browser-durable-writes.ts';

export interface BrowserFlushContext {
  readonly scope: CheckpointScope;
  readonly durableWrites: DurableWrites;
  assertActive(): void;
}
export interface BrowserClientContext extends BrowserFlushContext {
  release(flushGate: (context: BrowserFlushContext) => void | Promise<void>): Promise<void>;
}
const admittedRuntimes = new WeakSet<BrowserCoreRuntime>();
const failure = (code: string) => new BrowserVaultError(code, 'Browser fixture consumer is not admitted');

/** Fixture-only injection. Scope is read from the lock-owning worker runtime,
 * never supplied by the caller. Production persistent tab-slot selection and
 * editor lifecycle integration are separate gates.
 */
export function admitBrowserFixtureClient(runtime: BrowserCoreRuntime,
  options: { fixture: true; assertOwner: () => void }): BrowserClientContext {
  if (options?.fixture !== true || typeof options.assertOwner !== 'function') throw failure('invalid_admission');
  if (admittedRuntimes.has(runtime)) throw failure('client_already_admitted');
  let flushToken: symbol | undefined;
  let phase: 'active' | 'flushing' | 'releasing' | 'release_unknown' | 'released' = 'active';
  let closing: Promise<void> | undefined, flushed = false;
  const pending = new Set<Promise<unknown>>();
  const assertOwner = options.assertOwner;
  function live() { runtime.assertActive(); assertOwner(); }
  live();
  const authoritative = runtime.durableScope;
  if (!authoritative || !runtime.checkpoints) throw failure('client_scope_mismatch');
  const provider = runtime.checkpoints;
  if (provider.scope.vaultId !== authoritative.vaultId || provider.scope.clientId !== authoritative.clientId) throw failure('client_scope_mismatch');
  const scope = Object.freeze({ vaultId: authoritative.vaultId, clientId: authoritative.clientId });
  // Every underlying RPC rechecks the captured owner after provider awaits.
  function dispatch<T>(action: () => T): T {
    if (phase !== 'active' && phase !== 'flushing') throw failure('client_not_admitted');
    live(); return action();
  }
  const checkpoints = Object.freeze<DurableCheckpoints>({ scope,
    load: key => dispatch(() => provider.load(key)),
    compareAndSwap: input => dispatch(() => provider.compareAndSwap(input)),
    list: input => dispatch(() => provider.list(input)),
    changes: input => dispatch(() => provider.changes(input)),
  });
  const backend: BrowserCoreBackend = {
    durableScope: scope, checkpoints,
    inventory: () => dispatch(() => runtime.inventory()),
    readEntry: path => dispatch(() => runtime.readEntry(path)),
    readEntryById: id => dispatch(() => runtime.readEntryById(id)),
    execute: (id, json) => dispatch(() => runtime.execute(id, json)),
    prepare: (id, json) => dispatch(() => runtime.prepare(id, json)),
    commit: id => dispatch(() => runtime.commit(id)),
    intents: () => dispatch(() => runtime.intents()),
    acknowledge: (id, outcome) => dispatch(() => runtime.acknowledge(id, outcome)),
    subscribe: listener => dispatch(() => runtime.subscribe(listener)),
    close: () => runtime.close(),
  };
  const capability = browserDurableWrites(backend, scope, () => phase === 'released');
  function allowed(token?: symbol) {
    if (phase !== (token ? 'flushing' : 'active') || token && token !== flushToken) throw failure('client_not_admitted');
    live();
  }
  function invoke<T>(action: () => Promise<T>, token?: symbol): Promise<T> {
    try {
      allowed(token);
      const result = action(); // Snapshot provider arguments before the first await.
      const tracked = Promise.resolve(result).finally(() => pending.delete(tracked));
      pending.add(tracked); return tracked;
    } catch (error) { return Promise.reject(error); }
  }
  function wrap(token?: symbol): DurableWrites {
    return Object.freeze<DurableWrites>({
      readText: path => invoke(() => capability.readText(path), token),
      readTextById: id => invoke(() => capability.readTextById(id), token),
      planWrite: input => invoke(() => capability.planWrite(input), token),
      prepare: plan => invoke(() => capability.prepare(plan), token),
      commit: ref => invoke(() => capability.commit(ref), token),
      query: ref => invoke(() => capability.query(ref), token),
      listUnacknowledged: () => invoke(() => capability.listUnacknowledged(), token),
      acknowledge: (ref, outcome) => invoke(() => capability.acknowledge(ref, outcome), token),
      checkpoints: Object.freeze<DurableCheckpoints>({ scope,
        load: key => invoke(() => checkpoints.load(key), token),
        compareAndSwap: input => invoke(() => checkpoints.compareAndSwap(input), token),
        list: input => invoke(() => checkpoints.list(input), token),
        changes: input => invoke(() => checkpoints.changes(input), token),
      }),
    });
  }
  const durableWrites = wrap();
  runtime.installAdmissionGuard(() => dispatch(() => undefined));
  admittedRuntimes.add(runtime);
  async function drain() { while (pending.size) await Promise.allSettled([...pending]); }
  return Object.freeze({ scope, durableWrites, assertActive: () => allowed(),
    release(flushGate: (context: BrowserFlushContext) => void | Promise<void>): Promise<void> {
      if (phase === 'released') return Promise.resolve();
      if (closing) return closing;
      if (typeof flushGate !== 'function') return Promise.reject(failure('flush_gate_required'));
      if (phase !== 'active' && phase !== 'release_unknown') return Promise.reject(failure('client_not_admitted'));
      const retry = phase === 'release_unknown' && flushed;
      phase = retry ? 'releasing' : 'flushing';
      closing = (async () => {
        if (!retry) {
          try {
            await drain();
            const token = Symbol('flush'); flushToken = token;
            const flushContext = Object.freeze({scope, durableWrites:wrap(token), assertActive:()=>allowed(token)});
            let gateFailed = false, gateError: unknown;
            try {
              const result = flushGate(flushContext);
              if (result && typeof result.then === 'function') await result;
            } catch (error) { gateFailed = true; gateError = error; }
            finally { flushToken = undefined; }
            // Revoke new flush calls immediately, but keep accepted operations
            // admitted until their later RPCs settle, even when the gate failed.
            await drain();
            if (gateFailed) throw gateError;
            live(); flushed = true;
          } catch (error) { phase = 'active'; throw error; }
        }
        phase = 'releasing';
        try { await runtime.releaseClient(); phase = 'released'; }
        catch (error) { phase = 'release_unknown'; throw error; }
      })().finally(() => { closing = undefined; });
      return closing;
    },
  });
}
