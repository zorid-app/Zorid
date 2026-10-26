import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseController } from '../src/bases/controller.ts';
import { SharedBaseQueryRunner, projectSharedBasePreview, sharedBasePreview, sharedBaseWitness, sharedBaseCapture } from '../src/bases/shared-query.ts';
import { createBaseViewActions } from '../src/bases/view-actions.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import { DocumentSemanticsError } from '../src/core/document-semantics.ts';
import type { DocumentBaseResult, DocumentService } from '../src/core/document-semantics.ts';
import type { DocumentBasePreviewResult, DocumentPreviewHandle } from '../src/core/document-preview.ts';
import type { DocumentRuntimeObservation, DocumentRuntimeUpdate } from '../src/core/document-runtime.ts';
import type { VaultEntry } from '../src/core/types.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
const source = { localStoreId: 'store', watermark: '1' };
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const definition = { id: 'Work.base', revision: 'r1', path: 'Work.base', kind: 'file' as const, deleted: false };
const entry: VaultEntry = { entryId: definition.id, revision: definition.revision, path: definition.path, type: 'file', size: 1, ctime: 0, mtime: 0 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 600 && !check(); i++) await Promise.resolve(); assert.ok(check()); }
function saved(): DocumentBaseResult {
  return { snapshotId: snapshot, view: { type: 'table', name: 'Table', order: ['note.status'] }, rows: [{ entryId: 'One.md', revision: 'r1', path: 'One.md', values: { 'note.status': { type: 'string', value: 'Rust only' } } }], groups: [{ key: null, keyId: null, entryIds: ['One.md'] }], groupOptions: [], properties: ['note.status'], availableProperties: ['note.status'], counts: { scanned: 2, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1, refreshHint: null };
}
function partial(empty = false): DocumentBasePreviewResult {
  const { snapshotId: _snapshot, ...value } = saved();
  return { ...value, ...(empty ? { rows: [], groups: [], counts: { scanned: 1, matched: 0, afterGroupOrder: 0, afterSearch: 0, returned: 0 } } : {}), status: 'indexing', complete: false, aggregatesComplete: false, countsScope: 'preparedSubset', progress: { preparedFiles: 1, totalFiles: 3, pendingFiles: 2 }, preparedScanComplete: false, unavailablePreparedFiles: 1, unavailableFilterRows: 1, relationshipsAvailable: false, metadataComplete: false };
}
function fixture() {
  let current = false, revision = 0, nextId = 0, nullOpen = false, pendingDefinition = false, closeFailures = 0;
  let heldRead: ReturnType<typeof deferred<void>> | undefined, heldOpen: ReturnType<typeof deferred<void>> | undefined, heldClose: ReturnType<typeof deferred<void>> | undefined, heldObserver: ReturnType<typeof deferred<void>> | undefined;
  const gates = new Set<ReturnType<typeof deferred<void>>>();
  const hold = () => { const gate = deferred<void>(); gates.add(gate); return gate; };
  const demand = deferred<DocumentRuntimeObservation>(), listeners = new Set<(value: DocumentRuntimeUpdate | null) => void>();
  const previews: { id: string; reads: Parameters<DocumentPreviewHandle['base']>[0][]; closes: number }[] = [];
  const state = { registrations: 0, demands: 0, cancellations: 0, pins: 0, pinCloses: 0, previewResult: partial() };
  const update = (): DocumentRuntimeUpdate => ({ lifetime: 'owner', revision: String(revision), source, published: current ? snapshot : null, freshness: current ? 'current' : 'lagging', phase: current ? 'idle' : 'indexing', progress: current ? null : { prepared: 1, total: 3, ready: false }, coverageComplete: current ? true : null, hasForegroundDemand: false, error: null });
  const observation = (): DocumentRuntimeObservation => ({ source, published: current ? snapshot : null, current, rebuildRequired: false, coverageComplete: current ? true : null });
  const unexpected = async (): Promise<never> => { throw new Error('No renderer pumping or legacy evaluator is allowed'); };
  const service: DocumentService = {
    basePreviewAvailable: true,
    maintenance: { observeAndSubscribe: async listener => { state.registrations++; listeners.add(listener); const snapshot = update(), gate = heldObserver; heldObserver = undefined; if (gate) await gate.promise; return { snapshot, unsubscribe: () => { listeners.delete(listener); } }; }, requestFreshness: () => { state.demands++; return { result: demand.promise, cancel: async () => { state.cancellations++; } }; } },
    status: async () => ({ source, snapshot: current ? snapshot : null, coveredSource: current ? source : null, current, rebuildRequired: false, coverageComplete: current ? true : null }),
    initialize: unexpected, rebuild: unexpected, begin: unexpected, pump: unexpected, publish: unexpected, discard: unexpected,
    openPreview: async () => {
      const id = String(++nextId), gate = heldOpen; heldOpen = undefined; if (gate) await gate.promise;
      if (nullOpen) return null;
      const row = { id, reads: [] as Parameters<DocumentPreviewHandle['base']>[0][], closes: 0 }; previews.push(row);
      const capture = { ownerNonce: 'owner', stageId: 'stage', serial: id };
      return { previewId: id, capture, source, progress: state.previewResult.progress,
        base: async input => { row.reads.push(input); const read = heldRead; heldRead = undefined; if (read) await read.promise; if (pendingDefinition) throw new DocumentSemanticsError('index_preview_not_ready'); return { previewId: id, capture, source, definition, result: { ...state.previewResult, ...(input.options?.viewIndex === 1 ? { view: { type: 'cards', name: 'Cards' } } : {}) } }; },
        close: async () => { row.closes++; if (closeFailures) { closeFailures--; throw new Error('Close ACK failed'); } const close = heldClose; heldClose = undefined; if (close) await close.promise; },
      };
    },
    open: async () => { state.pins++; return { pinId: 'pin' as never, snapshot, source, coverageComplete: true, close: async () => { state.pinCloses++; }, search: unexpected, backlinks: unexpected, metadata: async () => ({ snapshot, source, coverageComplete: true, value: { entry: definition, metadata: null, exclusion: null } }), base: async input => ({ snapshot, source, coverageComplete: true, value: { definition, result: { ...saved(), ...(input.options?.viewIndex === 1 ? { view: { type: 'cards', name: 'Cards' } } : {}) } } }) }; },
  };
  const emit = () => { revision++; for (const listener of [...listeners]) listener(update()); };
  return { service, state, previews, listeners, emit,
    retire() { for (const listener of [...listeners]) listener(null); },
    budget() { demand.resolve(observation()); }, lag() { current = false; emit(); }, publish() { current = true; demand.resolve(observation()); emit(); },
    failCloseOnce() { closeFailures = 1; },
    null(value: boolean) { nullOpen = value; }, pending(value: boolean) { pendingDefinition = value; },
    holdObserver() { heldObserver = hold(); return heldObserver; },
    holdRead() { heldRead = hold(); return heldRead; }, holdOpen() { heldOpen = hold(); return heldOpen; }, holdClose() { heldClose = hold(); return heldClose; },
    releaseGates() { for (const gate of gates) gate.resolve(); },
  };
}
function query(f: ReturnType<typeof fixture>, runner: SharedBaseQueryRunner, onPreview: (result: BaseQueryResult) => void, onPreviewStatus?: (message: string) => void) {
  return runner.query({ service: f.service, definition: entry, current: entry, entries: [entry], query: { now: () => new Date(42), timezone: 'UTC' }, viewIndex: 0, version: 7, isCurrent: () => true, onPreview, onPreviewStatus });
}
test('preview projection retains exact prepared-subset evidence without snapshot or saved mutation witnesses', () => {
  const raw = partial(true), result = projectSharedBasePreview(raw, 7, []);
  assert.equal(result.rows.length, 0); assert.equal(result.shared?.counts.returned, 0); assert.equal('snapshotId' in result.shared!, false);
  assert.deepEqual(sharedBasePreview(result), raw); assert.equal(sharedBasePreview(result)?.complete, false); assert.equal(sharedBasePreview(result)?.aggregatesComplete, false);
  assert.throws(() => sharedBaseWitness(result, 'One.md'), /read-only/); assert.throws(() => sharedBaseWitness(result, 'Work.base'), /read-only/);
  assert.ok(Object.isFrozen(result.shared));
});
test('null capture and pending definition stay explicit and retry only after actual owner updates', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), rows: BaseQueryResult[] = [], messages: string[] = [];
  f.null(true); const pending = query(f, runner, value => rows.push(value), value => messages.push(value));
  try {
    await until(() => messages.some(value => /waiting/.test(value))); assert.equal(rows.length, 0);
    f.budget(); await until(() => f.state.registrations === 2 && messages.length >= 2); const before = messages.length;
    for (let i = 0; i < 20; i++) await Promise.resolve(); assert.equal(messages.length, before); assert.equal(f.state.demands, 1);
    f.null(false); f.pending(true); f.emit(); await until(() => messages.some(value => /Base or its current file/.test(value))); assert.equal(rows.length, 0);
    f.pending(false); f.emit(); await until(() => rows.length > 0); assert.equal(rows.at(-1)?.rows[0].values['note.status'].type, 'string');
    f.publish(); const complete = await pending; assert.equal(sharedBasePreview(complete), undefined); assert.equal(f.state.pins, 1); assert.equal(f.state.pinCloses, 1);
    assert.equal(f.listeners.size, 0); assert.ok(f.previews.every(row => row.closes === 1));
  } finally { f.releaseGates(); runner.dispose(); await pending.catch(() => {}); }
});
test('same-count actual progress replaces a capture atomically and preserves invocation options', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), rows: BaseQueryResult[] = [];
  const pending = query(f, runner, value => rows.push(value));
  try {
    await until(() => rows.length > 0); f.budget(); await until(() => f.state.registrations === 2); await until(() => !f.previews.at(-1) || f.previews.at(-1)!.reads.length > 0);
    const before = rows.length, captures = f.previews.length, held = f.holdRead(); f.state.previewResult = partial(true); f.emit(); await until(() => f.previews.length > captures && f.previews.at(-1)!.reads.length === 1);
    assert.equal(rows.at(-1)!.rows.length, 1); held.resolve(); await until(() => rows.length > before); assert.equal(rows.at(-1)!.rows.length, 0);
    const request = f.previews.at(-1)!.reads[0]; assert.equal(request.id, definition.id); assert.equal(request.options?.currentEntryId, definition.id); assert.equal(request.options?.clockMs, 42); assert.equal(request.options?.timezone, 'UTC');
    assert.equal(rows.at(-1)!.counts.returned, 0); assert.equal(sharedBasePreview(rows.at(-1)!)?.progress.pendingFiles, 2);
    f.publish(); await pending;
  } finally { f.releaseGates(); runner.dispose(); await pending.catch(() => {}); }
});
test('publication drains a pending preview and late preview data cannot replace saved results', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), held = f.holdRead(), rows: BaseQueryResult[] = [];
  const pending = query(f, runner, value => rows.push(value));
  try {
    await until(() => f.previews.some(row => row.reads.length)); f.publish(); await until(() => f.previews[0].closes === 1); assert.equal(f.state.pins, 0);
    held.resolve(); const complete = await pending; assert.equal(rows.length, 0); assert.equal(sharedBasePreview(complete), undefined); assert.equal(sharedBaseWitness(complete, 'One.md')?.entryId, 'One.md');
  } finally { f.releaseGates(); runner.dispose(); await pending.catch(() => {}); }
});
test('cancelled late open is closed and cannot publish after controller ownership retires', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), held = f.holdOpen(), rows: BaseQueryResult[] = [];
  const pending = query(f, runner, value => rows.push(value)); void pending.catch(() => {});
  await until(() => f.state.demands === 1); runner.dispose(); held.resolve(); await assert.rejects(pending);
  await until(() => f.previews.every(row => row.closes === 1)); assert.equal(rows.length, 0); assert.equal(f.state.pins, 0); assert.equal(f.listeners.size, 0);
});
test('a pending exact preview close ACK blocks the next opening', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), rows: BaseQueryResult[] = [];
  const first = query(f, runner, value => rows.push(value)); void first.catch(() => {}); await until(() => rows.length > 0);
  const held = f.holdClose(); runner.cancel(); const second = query(f, runner, value => rows.push(value)); void second.catch(() => {});
  await until(() => f.previews[0].closes === 1); const before = f.previews.length;
  for (let i = 0; i < 30; i++) await Promise.resolve(); assert.equal(f.previews.length, before);
  held.resolve(); await until(() => f.previews.length > before); runner.dispose(); await Promise.allSettled([first, second]);
});
test('malformed positive capability fails closed, while absent preview keeps the published path', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(); (f.service as { openPreview?: unknown }).openPreview = undefined;
  await assert.rejects(query(f, runner, () => {}), /capability is incomplete/); assert.equal(f.state.demands, 0);
  (f.service as { basePreviewAvailable?: boolean }).basePreviewAvailable = false; f.publish(); const complete = await query(f, runner, () => { throw new Error('Legacy preview callback'); });
  assert.equal(sharedBasePreview(complete), undefined); assert.equal(f.previews.length, 0); runner.dispose();
});
class IdentityAdapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  override async list() { return (await super.list()).map(row => ({ ...row, entryId: row.path, revision: 'r1' })); }
  override async stat(path: string) { const row = await super.stat(path); return row ? { ...row, entryId: row.path, revision: 'r1' } : null; }
}
async function controllerFixture(clock?: import('../src/bases/clock.ts').BaseClockHost) {
  const f = fixture(), adapter = new IdentityAdapter({ 'Work.base': 'views:\n  - type: table\n    name: Table\n    order: [status]\n  - type: cards\n    name: Cards\n', 'One.md': '---\nstatus: renderer value\n---\n' }); adapter.documentSemantics = f.service;
  const vault = new Vault(adapter); await vault.initialize(); let mutations = 0; const states: BaseQueryResult[] = [];
  const controller = new BaseController({ vault, basePath: 'Work.base', delayMs: 1000, onChange: value => { if (value.result) states.push(value.result); }, ...(clock ? { clock } : { query: { now: () => new Date(42) } }), mutations: { async transform() { mutations++; }, async rename() { mutations++; } } });
  return { ...f, vault, controller, states, mutations: () => mutations };
}
async function propertiesControllerFixture() {
  const f = await controllerFixture(), settingsSource = 'properties:\n  status: {type: select, options: [{value: Todo}, {value: Done}]}\n';
  await f.vault.adapter.write('Properties.yaml', settingsSource); await f.vault.reload();
  const open = f.service.open, reads: string[] = [];
  f.service.open = async () => {
    const pin = await open();
    return { ...pin,
      metadata: async id => {
        reads.push(id);
        return id === 'Properties.yaml' ? { snapshot, source, coverageComplete: true, value: {
          entry: { id, path: id, revision: 'r1', kind: 'file', deleted: false }, metadata: null, exclusion: null,
        } } : pin.metadata(id);
      },
      base: async input => {
        assert.deepEqual(input.options?.propertyDefinitionsSource, { id: 'Properties.yaml', source: settingsSource });
        return pin.base(input);
      },
    };
  };
  return { ...f, reads };
}
test('a Base with Properties.yaml automatically renders after bounded demand precedes actual publication', async () => {
  const f = await propertiesControllerFixture(), pending = f.controller.refresh();
  try {
    await until(() => f.state.demands === 1); f.budget();
    await until(() => f.state.registrations === 2 || !!f.controller.state.error);
    assert.equal(f.controller.state.error, null, 'bounded indexing is pending work, not a terminal Base error');
    assert.equal(f.controller.state.updating, true);
    assert.equal(f.state.pins, 0); assert.equal(f.previews.length, 0, 'property definitions must not enable unsupported previews');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(f.state.demands, 1, 'wait for actual publication without more foreground demands');
    f.publish(); await pending;
    assert.equal(f.controller.state.error, null); assert.equal(f.controller.state.updating, false);
    assert.deepEqual(f.controller.state.result?.rows.map(row => row.path), ['One.md']);
    assert.deepEqual(f.reads, ['Work.base', 'Properties.yaml']);
    assert.equal(f.listeners.size, 0); assert.equal(f.state.pinCloses, 1); assert.equal(f.previews.length, 0);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});
for (const outcome of ['cancelled', 'retired'] as const) test(`a Properties.yaml publication wait releases its subscription when ${outcome}`, async () => {
  const f = await propertiesControllerFixture(), pending = f.controller.refresh();
  try {
    await until(() => f.state.demands === 1); f.budget(); await until(() => f.state.registrations === 2);
    if (outcome === 'cancelled') f.controller.dispose(); else f.retire();
    const before = f.controller.state;
    await pending;
    assert.equal(f.listeners.size, 0); assert.equal(f.state.pins, 0); assert.equal(f.previews.length, 0);
    if (outcome === 'cancelled') assert.equal(f.controller.state, before);
    else assert.match(f.controller.state.error?.message ?? '', /could not finish indexing/);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});
test('late publication-wait registration releases its exact listener after cancellation', async () => {
  const f = await propertiesControllerFixture(), pending = f.controller.refresh();
  try {
    await until(() => f.state.demands === 1);
    const registration = f.holdObserver(); f.budget(); await until(() => f.state.registrations === 2);
    f.controller.dispose(); await pending; const retired = f.controller.state;
    // A callback can arrive before the cancelled registration returns its
    // cleanup handle. Neither event may revive the disposed controller.
    f.publish(); registration.resolve(); await until(() => f.listeners.size === 0);
    assert.equal(f.controller.state, retired); assert.equal(f.state.pins, 0); assert.equal(f.previews.length, 0);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});
test('preview controller and direct view actions reject writes, configuration and rename', async () => {
  const f = await controllerFixture(), pending = f.controller.refresh();
  try {
    await until(() => !!f.controller.state.result); const version = f.controller.state.version;
    assert.ok(sharedBasePreview(f.controller.state.result!)); const actions = createBaseViewActions(f.controller, { validate() {}, canRename: true });
    await assert.rejects(f.controller.editProperty({ version, path: 'One.md', property: 'status', value: 'forbidden' }), /read-only/);
    await assert.rejects(f.controller.updateView(version, { name: 'Forbidden' }), /read-only/);
    await assert.rejects(f.controller.renameFile(version, 'One.md', 'Other.md'), /read-only/);
    await assert.rejects(actions.editProperty({ version, path: 'One.md', property: 'status', value: { type: 'string', value: 'forbidden' } }), /read-only/);
    assert.equal(actions.canMove(f.controller.state.result!), false); assert.equal(f.mutations(), 0);
    f.publish(); await pending; assert.equal(sharedBasePreview(f.controller.state.result!), undefined); assert.ok(f.controller.state.version > version);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});
test('prior coherent published rows remain installed during a later indexing refresh', async () => {
  const f = await controllerFixture(); f.publish(); await f.controller.refresh(); const before = f.controller.state.result, count = f.previews.length;
  // A new demand still follows the published path; a less-complete preview is never installed.
  const gate = deferred<DocumentRuntimeObservation>(); f.service.maintenance!.requestFreshness = () => ({ result: gate.promise, cancel: async () => {} });
  f.lag(); const pending = f.controller.refresh(); try {
    await until(() => f.controller.state.updating); assert.equal(f.controller.state.result, before); assert.equal(f.previews.length, count);
    f.publish(); gate.resolve({ source, published: snapshot, current: true, rebuildRequired: false, coverageComplete: true }); await pending; assert.equal(f.previews.length, count);
  } finally { f.controller.dispose(); gate.resolve({ source, published: snapshot, current: true, rebuildRequired: false, coverageComplete: true }); await pending; }
});
test('view changes retire late first-build replies before the new view is rendered', async () => {
  const f = await controllerFixture(), held = f.holdRead(), pending = f.controller.refresh();
  try {
    await until(() => f.previews.some(row => row.reads.length)); const changed = f.controller.setView(1);
    held.resolve(); await until(() => f.controller.state.result?.view.name === 'Cards');
    assert.ok(f.states.every(result => result.view.name === 'Cards'));
    f.publish(); await Promise.all([pending, changed]); assert.equal(f.controller.state.result?.view.name, 'Cards'); assert.equal(f.listeners.size, 0);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});

test('a source change retires its pending preview before another definition can be rendered', async () => {
  const f = await controllerFixture(), held = f.holdRead(), pending = f.controller.refresh();
  try {
    await until(() => f.previews.some(row => row.reads.length));
    await f.vault.modify('One.md', 'changed externally');
    // The source epoch fence applies even before another preview is requested.
    held.resolve(); await pending; assert.equal(f.controller.state.result, null); assert.equal(f.states.length, 0);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});
test('a clock invocation uses one captured clock and ignores a retired clock reply', async () => {
  let now = 10, wake: (() => void) | undefined;
  const clock: import('../src/bases/clock.ts').BaseClockHost = { capture: () => ({ clockMs: now, timezone: 'UTC' }), isVisible: () => true,
    scheduleAt: () => { throw new Error('Preview clocks cannot arm a published timer'); }, subscribeWake(callback) { wake = callback; return () => { wake = undefined; }; } };
  const f = await controllerFixture(clock), held = f.holdRead(), pending = f.controller.refresh();
  try {
    await until(() => f.previews.some(row => row.reads.length)); assert.equal(f.previews[0].reads[0].options?.clockMs, 10);
    now = 20; wake!(); held.resolve();
    await until(() => f.previews.some(row => row.reads.some(input => input.options?.clockMs === 20)));
    assert.ok(f.states.every(result => sharedBaseCapture(result)?.clockMs !== 10), 'retired old-clock reply was never published');
    assert.equal(f.previews[0].reads[0].options?.clockMs, 10, 'retained request does not borrow a mutable clock');
    f.publish(); await pending; assert.equal(sharedBasePreview(f.controller.state.result!), undefined);
  } finally { f.releaseGates(); f.controller.dispose(); await pending; }
});

test('a failed preview close keeps the same handle and retries before opening a replacement', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), rows: BaseQueryResult[] = [], messages: string[] = [];
  const pending = query(f, runner, value => rows.push(value), value => messages.push(value));
  try {
    await until(() => rows.length > 0); f.failCloseOnce(); const before = f.previews.length; f.emit();
    await until(() => messages.some(value => /temporarily unavailable/.test(value))); assert.equal(f.previews.length, before); assert.equal(f.previews[0].closes, 1);
    f.emit(); await until(() => f.previews.length > before); assert.equal(f.previews[0].closes, 2);
    f.publish(); await pending;
  } finally { f.releaseGates(); runner.dispose(); await pending.catch(() => {}); }
});

test('retirement after an admitted demand stops the invocation while retaining an inert preview DTO', async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), rows: BaseQueryResult[] = [];
  const pending = query(f, runner, value => rows.push(value)); void pending.catch(() => {});
  try {
    await until(() => rows.length > 0); f.budget(); await until(() => f.state.registrations === 2);
    const displayed = rows.at(-1)!; f.retire(); await assert.rejects(pending, /could not finish indexing/);
    assert.ok(sharedBasePreview(displayed)); assert.equal('snapshotId' in displayed.shared!, false); assert.throws(() => sharedBaseWitness(displayed, 'One.md'), /read-only/);
    assert.equal(f.state.demands, 1); assert.equal(f.state.pins, 0); assert.equal(f.listeners.size, 0); assert.ok(f.previews.every(row => row.closes === 1));
  } finally { f.releaseGates(); runner.dispose(); await pending.catch(() => {}); }
});

for (const outcome of ['published', 'retired'] as const) test(`a ${outcome} callback during observer registration wins over its older returned snapshot`, async () => {
  const f = fixture(), runner = new SharedBaseQueryRunner(), rows: BaseQueryResult[] = [];
  const pending = query(f, runner, value => rows.push(value)); void pending.catch(() => {});
  try {
    await until(() => rows.length > 0); const registration = f.holdObserver(); f.budget(); await until(() => f.state.registrations === 2);
    if (outcome === 'published') f.publish(); else f.retire();
    registration.resolve();
    // Bounded public postconditions make a lost callback fail rather than hang.
    if (outcome === 'published') { await until(() => f.state.pins === 1); const result = await pending; assert.equal(sharedBasePreview(result), undefined); }
    else { await until(() => f.listeners.size === 0); await assert.rejects(pending, /could not finish indexing/); assert.equal(f.state.pins, 0); }
    assert.equal(f.state.demands, 1); assert.equal(f.listeners.size, 0);
  } finally { f.releaseGates(); runner.dispose(); await pending.catch(() => {}); }
});
