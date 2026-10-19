import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseController } from '../src/bases/controller.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { BaseClockHost } from '../src/bases/clock.ts';
import type { DocumentBaseRefreshHint, DocumentBaseResult, DocumentPin, DocumentService } from '../src/core/document-semantics.ts';
import type { VaultEntry } from '../src/core/types.ts';
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '1' };
const text = 'views:\n  - type: table\n    name: Timed\n  - type: table\n    name: Plain\n';
class Clock implements BaseClockHost {
  now = 0; zone = 'America/Toronto'; visible = true; captures: number[] = [];
  timers = new Set<{ at: number; run(): void }>(); wakes = new Set<() => void>(); retired: (() => void)[] = [];
  capture(zone?: string) { this.captures.push(this.now); return { clockMs: this.now, timezone: zone?.trim() || this.zone }; }
  isVisible() { return this.visible; }
  subscribeWake(run: () => void) { this.wakes.add(run); return () => { this.wakes.delete(run); }; }
  scheduleAt(at: number, run: () => void) { const timer = { at, run }; this.timers.add(timer); return () => { this.timers.delete(timer); this.retired.push(run); }; }
  wake() { for (const run of [...this.wakes]) run(); }
  tick(now: number) { this.now = now; for (const timer of [...this.timers]) if (timer.at <= now) { this.timers.delete(timer); timer.run(); } }
}
class Adapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  identify(entry: VaultEntry) { return { ...entry, entryId: entry.path, revision: 'r1' }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identify(entry) : null; }
}
async function settled(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await Promise.resolve(); assert.ok(check()); }
async function fixture(dependency: 'none' | 'day' | 'instant' = 'instant', query: { timezone?: string; now?: () => Date } = {}) {
  const clock = new Clock(), adapter = new Adapter({ 'Work.base': text });
  const calls: Parameters<DocumentPin['base']>[0][] = [], pins: { closed: number }[] = [];
  let metadataGate: Promise<void> | undefined;
  const definition = { id: 'Work.base', revision: 'r1', path: 'Work.base', kind: 'file' as const, deleted: false };
  const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
  adapter.documentSemantics = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => {
      const pin = { closed: 0 }; pins.push(pin);
      return { pinId: String(pins.length) as DocumentPin['pinId'], source, snapshot, coverageComplete: true,
        close: async () => { pin.closed++; }, search: unused, backlinks: unused,
        metadata: async () => { const gate = metadataGate; metadataGate = undefined; if (gate) await gate; return { source, snapshot, coverageComplete: true, value: { entry: definition, metadata: null, exclusion: null } }; },
        base: async input => {
          calls.push(input); const selected = input.options?.viewIndex ?? 0, kind = selected === 1 ? 'none' : dependency;
          const refreshHint: DocumentBaseRefreshHint = { dependency: kind, timezone: input.options!.timezone!, nextWakeMs: kind === 'none' ? null : input.options!.clockMs! + (kind === 'day' ? 5_000 : 1_000) };
          const result: DocumentBaseResult = { snapshotId: snapshot, view: { type: 'table', name: selected === 1 ? 'Plain' : 'Timed' }, rows: [], groups: [], groupOptions: [], properties: [], availableProperties: [], counts: { scanned: 1, matched: 0, afterGroupOrder: 0, afterSearch: 0, returned: 0 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 9, refreshHint };
          return { source, snapshot, coverageComplete: true, value: { definition, result } };
        },
      };
    },
  };
  const vault = new Vault(adapter); await vault.initialize();
  const controller = new BaseController({ vault, basePath: 'Work.base', query, clock, delayMs: 1000, mutations: { transform: unused } });
  await controller.refresh(); assert.equal(controller.state.error, null);
  return { clock, controller, calls, pins, holdMetadata() { let resolve!: () => void; metadataGate = new Promise<void>(done => { resolve = done; }); return resolve; } };
}
test('ordinary views have no temporal timer; local timezone changes refresh exactly on a wake', async () => {
  const f = await fixture('none'); try {
    assert.equal(f.clock.timers.size, 0); f.clock.now = 10_000; f.clock.wake(); await Promise.resolve(); assert.equal(f.calls.length, 1);
    f.clock.zone = 'Europe/Paris'; f.clock.wake(); await settled(() => f.calls.length === 2 && f.controller.state.result?.shared?.refreshHint?.timezone === 'Europe/Paris');
    assert.equal(f.calls[1].options!.timezone, 'Europe/Paris'); assert.equal(f.clock.timers.size, 0);
  } finally { f.controller.dispose(); }
});
test('day deadline is one-shot advice supplied by Rust; fresh invocation rearms its new hint', async () => {
  const f = await fixture('day'); try {
    assert.deepEqual([...f.clock.timers].map(t => t.at), [5_000]); f.clock.tick(4_999); assert.equal(f.calls.length, 1);
    f.clock.tick(5_000); await settled(() => f.calls.length === 2 && f.clock.timers.size === 1);
    assert.equal(f.calls[1].options!.clockMs, 5_000); assert.deepEqual([...f.clock.timers].map(t => t.at), [10_000]);
  } finally { f.controller.dispose(); }
});
test('hiding cancels temporal effects; visibility catches one missed deadline and dispose retires listeners', async () => {
  const f = await fixture();
  f.clock.visible = false; f.clock.wake(); assert.equal(f.clock.timers.size, 0);
  f.clock.tick(10_000); assert.equal(f.calls.length, 1);
  f.clock.visible = true; f.clock.wake(); await settled(() => f.calls.length === 2 && f.clock.timers.size === 1);
  assert.equal(f.calls[1].options!.clockMs, 10_000);
  f.controller.dispose(); assert.equal(f.clock.timers.size, 0); assert.equal(f.clock.wakes.size, 0);
  for (const run of f.clock.retired) run(); await Promise.resolve(); assert.equal(f.calls.length, 2); assert.ok(f.pins.every(p => p.closed === 1));
});
test('changing to ordinary view fences canceled callbacks and configured timezone ignores device changes', async () => {
  const f = await fixture('instant', { timezone: 'UTC' }); try {
    await f.controller.setView(1); assert.equal(f.clock.timers.size, 0); const calls = f.calls.length;
    f.clock.now = 10_000; f.clock.zone = 'Pacific/Auckland'; for (const run of f.clock.retired) run(); f.clock.wake(); await Promise.resolve();
    assert.equal(f.calls.length, calls); assert.ok(f.calls.every(c => c.options!.timezone === 'UTC'));
  } finally { f.controller.dispose(); }
});
test('invocation capture waits for retained metadata; fixed query clocks stay fixed without temporal loops', async () => {
  const f = await fixture('instant', { now: () => new Date(42) }); try {
    assert.equal(f.calls[0].options!.clockMs, 42); assert.equal(f.clock.timers.size, 0);
    const release = f.holdMetadata(), captureCount = f.clock.captures.length, pending = f.controller.refresh();
    await settled(() => f.pins.length === 2); f.clock.now = 9_000;
    assert.equal(f.clock.captures.length, captureCount); release(); await pending;
    assert.equal(f.clock.captures.at(-1), 9_000); assert.equal(f.calls[1].options!.clockMs, 42); assert.equal(f.clock.timers.size, 0);
  } finally { f.controller.dispose(); }
});

test('same-zone backwards clock wakes refresh affected views, while None and fixed clocks stay quiet', async () => {
  for (const dependency of ['day', 'instant'] as const) {
    const f = await fixture(dependency); try {
      f.clock.visible = false; f.clock.wake(); f.clock.now = -1_000;
      f.clock.visible = true; f.clock.wake();
      await settled(() => f.calls.length === 2 && f.clock.timers.size === 1);
      assert.equal(f.calls[1].options!.clockMs, -1_000);
      assert.equal(f.calls[1].options!.timezone, 'America/Toronto');
    } finally { f.controller.dispose(); }
  }
  for (const [dependency, query] of [['none', {}], ['day', { now: () => new Date(42) }]] as const) {
    const f = await fixture(dependency, query); try {
      f.clock.now = -1_000; f.clock.wake(); await Promise.resolve();
      assert.equal(f.calls.length, 1); assert.equal(f.clock.timers.size, 0);
    } finally { f.controller.dispose(); }
  }
});
