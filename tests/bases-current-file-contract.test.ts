import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BaseController } from '../src/bases/controller.ts';
import { SharedBaseQueryRunner } from '../src/bases/shared-query.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { VaultEntry } from '../src/core/types.ts';
import type { DocumentBaseResult, DocumentPin, DocumentService } from '../src/core/document-semantics.ts';
import type { DocumentPreviewHandle } from '../src/core/document-preview.ts';
import type { DocumentRuntimeObservation, DocumentRuntimeUpdate } from '../src/core/document-runtime.ts';
import type { BaseQueryOptions } from '../src/bases/query.ts';

const base = 'filters: this == null\nviews: [{type: table, name: Main, order: [file.name, score]}]\n';
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '1' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class IdentityAdapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  ids = new Map([['Work.base', 'base_id'], ['A.md', 'a_id'], ['B.md', 'b_id']]);
  reads: string[] = [];
  nextStat = new Map<string, ReturnType<typeof deferred<void>>>();
  identify(entry: VaultEntry): VaultEntry { return { ...entry, entryId: this.ids.get(entry.path)!, revision: 'r1' }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path), captured = entry ? this.identify(entry) : null, gate = this.nextStat.get(path); this.nextStat.delete(path); if (gate) await gate.promise; return captured; }
  override async read(path: string) { this.reads.push(path); return super.read(path); }
}
function payload(): DocumentBaseResult {
  return { snapshotId: snapshot, view: { type: 'table', name: 'Main', order: ['file.name', 'score'] }, rows: [], groups: [], groupOptions: [], properties: ['file.name', 'note.score'], availableProperties: ['note.score'],
    counts: { scanned: 3, matched: 0, afterGroupOrder: 0, afterSearch: 0, returned: 0 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1,
    summaryPreviews: { sum: { type: 'number', value: 3 } } };
}
async function fixture({ query, preview = false }: { query?: BaseQueryOptions; preview?: boolean } = {}) {
  const adapter = new IdentityAdapter({ 'Work.base': base, 'A.md': '---\nscore: 1\n---\nA\n', 'B.md': '---\nscore: 2\n---\nB\n' });
  const calls: Parameters<DocumentPin['base']>[0][] = [], previews: Parameters<DocumentPreviewHandle['base']>[0][] = [], pins: { closed: number }[] = [];
  const listeners = new Set<(value: DocumentRuntimeUpdate | null) => void>(), demand = deferred<DocumentRuntimeObservation>();
  let current = !preview, hook: (() => void) | undefined, previewCloses = 0, serial = 0;
  const unexpected = async (): Promise<never> => { throw Error('Unexpected index operation'); };
  const definition = () => ({ id: 'base_id', revision: 'r1', path: 'Work.base', kind: 'file' as const, deleted: false });
  const observation = (): DocumentRuntimeObservation => ({ source, published: current ? snapshot : null, current, rebuildRequired: false, coverageComplete: current ? true : null });
  const update = (): DocumentRuntimeUpdate => ({ lifetime: 'owner', revision: String(serial), source, published: current ? snapshot : null, freshness: current ? 'current' : 'lagging', phase: current ? 'idle' : 'indexing', progress: current ? null : { prepared: 1, total: 3, ready: false }, coverageComplete: current ? true : null, hasForegroundDemand: false, error: null });
  const service: DocumentService = {
    status: async () => ({ source, snapshot: current ? snapshot : null, coveredSource: current ? source : null, current, rebuildRequired: false, coverageComplete: current ? true : null }),
    initialize: unexpected, rebuild: unexpected, begin: unexpected, pump: unexpected, publish: unexpected, discard: unexpected,
    ...(preview ? {
      basePreviewAvailable: true,
      maintenance: { observeAndSubscribe: async (listener: (value: DocumentRuntimeUpdate | null) => void) => { listeners.add(listener); return { snapshot: update(), unsubscribe: () => { listeners.delete(listener); } }; }, requestFreshness: () => ({ result: demand.promise, cancel: async () => {} }) },
      openPreview: async () => {
        const { snapshotId: _snapshot, summaryPreviews: _previews, ...saved } = payload();
        const capture = { ownerNonce: 'owner', stageId: 'stage', serial: '1' }, progress = { preparedFiles: 1, totalFiles: 3, pendingFiles: 2 };
        return { previewId: '1', capture, source, progress,
          base: async (input: Parameters<DocumentPreviewHandle['base']>[0]) => { previews.push(input); return { previewId: '1', capture, source, definition: definition(), result: { ...saved, status: 'indexing' as const, complete: false as const, aggregatesComplete: false as const, countsScope: 'preparedSubset' as const, progress, preparedScanComplete: false, unavailablePreparedFiles: 1, unavailableFilterRows: 1, relationshipsAvailable: false as const, metadataComplete: false as const } }; },
          close: async () => { previewCloses++; },
        };
      },
    } : {}),
    open: async () => { const pin = { closed: 0 }; pins.push(pin); return { pinId: String(pins.length) as never, snapshot, source, coverageComplete: true, search: unexpected, backlinks: unexpected,
      metadata: async () => ({ snapshot, source, coverageComplete: true, value: { entry: definition(), metadata: null, exclusion: null } }),
      base: async input => { calls.push(input); const run = hook; hook = undefined; run?.(); return { snapshot, source, coverageComplete: true, value: { definition: definition(), result: payload() } }; }, close: async () => { pin.closed++; },
    }; },
  };
  adapter.documentSemantics = service;
  const vault = new Vault(adapter); await vault.initialize();
  const controller = new BaseController({ vault, basePath: 'Work.base', query: { now: () => new Date(42), timezone: 'UTC', ...query }, delayMs: 1000, mutations: { async transform() { throw Error('A context read never writes'); } } });
  return { adapter, vault, controller, service, calls, previews, pins, previewCloses: () => previewCloses, listeners,
    beforeNextBaseReturn(callback: () => void) { hook = callback; },
    publish() { current = true; serial++; demand.resolve(observation()); for (const listener of [...listeners]) listener(update()); },
  };
}
const currentOption = (input: { options?: object }) => Object.hasOwn(input.options ?? {}, 'currentEntryId');

test('shared null current context omits the selected entry in both saved query and summary advice', async () => {
  const f = await fixture({ query: { currentFilePath: null } });
  try {
    await f.controller.refresh(); assert.equal(f.controller.state.error, null); assert.equal(f.calls.length, 1); assert.equal(currentOption(f.calls[0]), false);
    assert.deepEqual(await f.controller.summaryPreviews('score'), { sum: { type: 'number', value: 3 } });
    assert.equal(f.calls.length, 2); assert.equal(currentOption(f.calls[1]), false); assert.equal(f.calls[1].options?.summaryPreviewProperty, 'note.score');
    assert.ok(f.pins.every(pin => pin.closed === 1));
  } finally { f.controller.dispose(); }
});

test('undefined context keeps standalone Base identity and setCurrentFilePath(null) clears a prior identity expectation', async () => {
  const f = await fixture();
  try {
    await f.controller.refresh(); assert.equal(f.calls[0].options?.currentEntryId, 'base_id');
    await f.controller.setCurrentFilePath('A.md', 'a_id'); assert.equal(f.calls.at(-1)?.options?.currentEntryId, 'a_id');
    await f.controller.setCurrentFilePath(null); assert.equal(f.controller.state.error, null); assert.equal(currentOption(f.calls.at(-1)!), false);
    assert.deepEqual(await f.controller.summaryPreviews('score'), { sum: { type: 'number', value: 3 } }); assert.equal(currentOption(f.calls.at(-1)!), false);
  } finally { f.controller.dispose(); }
});

test('a null preview context omits currentEntryId before later saved publication and closes all handles', async () => {
  const f = await fixture({ preview: true }), runner = new SharedBaseQueryRunner(); let seen = 0;
  try {
    const result = await runner.query({ service: f.service, definition: (await f.adapter.stat('Work.base'))!, current: null, entries: [...f.vault.entries.values()], query: { currentFilePath: null, now: () => new Date(42), timezone: 'UTC' }, version: 1, viewIndex: 0, isCurrent: () => true,
      onPreview() { seen++; f.publish(); } });
    assert.equal(seen, 1); assert.equal(result.shared?.metadataComplete, true); assert.equal(f.previews.length, 1); assert.equal(currentOption(f.previews[0]), false); assert.equal(currentOption(f.calls[0]), false);
    assert.equal(f.previewCloses(), 1); assert.equal(f.listeners.size, 0); assert.ok(f.pins.every(pin => pin.closed === 1));
  } finally { f.publish(); runner.dispose(); f.controller.dispose(); }
});

test('nonnull missing identity and inconsistent pinned identity still fail before opening shared resources', async () => {
  const f = await fixture(), runner = new SharedBaseQueryRunner();
  try {
    const definition = (await f.adapter.stat('Work.base'))!, actual = (await f.adapter.stat('A.md'))!;
    const input = { service: f.service, definition, current: { ...actual, revision: undefined }, entries: [...f.vault.entries.values()], query: {}, version: 1, viewIndex: 0, isCurrent: () => true };
    await assert.rejects(runner.query(input), /Saved entry identity/);
    await assert.rejects(runner.query({ ...input, current: actual, query: { currentFilePath: null } }), /current-file context/);
    await assert.rejects(runner.query({ ...input, current: actual, query: { currentFilePath: 'A.md', currentFileEntryId: 'replacement_id' } }), /current|identity|changed/i);
    assert.equal(f.pins.length, 0); assert.equal(f.calls.length, 0);
  } finally { runner.dispose(); f.controller.dispose(); }
});

test('a pinned current-file identity rejects a same-path replacement before the first query', async () => {
  const f = await fixture({ query: { currentFilePath: 'A.md', currentFileEntryId: 'a_id' } });
  try {
    f.adapter.ids.set('A.md', 'replacement_id'); await f.controller.refresh();
    assert.match(f.controller.state.error?.message ?? '', /current.*changed|pinned.*changed/i); assert.equal(f.calls.length, 0); assert.equal(f.controller.state.result, null);
  } finally { f.controller.dispose(); }
});

test('a pinned identity is rechecked after saved query completion before the result is published', async () => {
  const f = await fixture({ query: { currentFilePath: 'A.md', currentFileEntryId: 'a_id' } });
  try {
    f.beforeNextBaseReturn(() => f.adapter.ids.set('A.md', 'replacement_id'));
    await f.controller.refresh(); assert.equal(f.calls[0].options?.currentEntryId, 'a_id'); assert.match(f.controller.state.error?.message ?? '', /current.*changed|pinned.*changed/i); assert.equal(f.controller.state.result, null);
  } finally { f.controller.dispose(); }
});

test('same-path current-file replacement also prevents fresh footer advice from using a new note identity', async () => {
  const f = await fixture({ query: { currentFilePath: 'A.md', currentFileEntryId: 'a_id' } });
  try {
    await f.controller.refresh(); assert.equal(f.controller.state.error, null); f.adapter.ids.set('A.md', 'replacement_id');
    await assert.rejects(f.controller.summaryPreviews('score'), /current.*changed|pinned.*changed/i); assert.equal(f.calls.length, 1);
  } finally { f.controller.dispose(); }
});

test('setCurrentFile identity failure rejects without retargeting the previous current file', async () => {
  const f = await fixture();
  try {
    await f.controller.refresh(); f.adapter.ids.set('A.md', 'replacement_id');
    await assert.rejects(f.controller.setCurrentFilePath('A.md', 'a_id'), /current.*changed|pinned.*changed/i);
    assert.deepEqual(await f.controller.summaryPreviews('score'), { sum: { type: 'number', value: 3 } }); assert.equal(f.calls.at(-1)?.options?.currentEntryId, 'base_id');
  } finally { f.controller.dispose(); }
});

test('an identity-valid context change keeps ordinary Base parse failures in state instead of rejecting a local pin', async () => {
  const f = await fixture();
  try {
    await f.adapter.write('Work.base', 'views: [unterminated\n');
    await f.controller.setCurrentFilePath('A.md', 'a_id');
    assert.ok(f.controller.state.error, 'The normal refresh still reports the invalid Base source');
    assert.equal(f.calls.length, 0, 'An invalid Base is never replaced by a made-up query');
  } finally { f.controller.dispose(); }
});

test('a slower expected-identity preflight cannot overwrite a newer current-file selection', async () => {
  const f = await fixture(), gate = deferred<void>();
  try {
    await f.controller.refresh(); f.adapter.nextStat.set('A.md', gate);
    const older = f.controller.setCurrentFilePath('A.md', 'a_id'); void older.catch(() => {});
    await f.controller.setCurrentFilePath('B.md', 'b_id'); gate.resolve();
    await assert.rejects(older, /current.*changed/i); assert.equal(f.calls.at(-1)?.options?.currentEntryId, 'b_id'); assert.equal(f.calls.some(call => call.options?.currentEntryId === 'a_id'), false);
  } finally { gate.resolve(); f.controller.dispose(); }
});

test('an identity-bound setter never positively acknowledges replacement during its query read', async () => {
  const f = await fixture();
  try {
    await f.controller.refresh();
    f.beforeNextBaseReturn(() => f.adapter.ids.set('A.md', 'replacement_id'));
    await assert.rejects(f.controller.setCurrentFilePath('A.md', 'a_id'), /current.*changed|pinned.*changed/i);
    assert.match(f.controller.state.error?.message ?? '', /current.*changed|pinned.*changed/i);
  } finally { f.controller.dispose(); }
});

test('footer advice rechecks a pinned identity after the independent saved read completes', async () => {
  const f = await fixture({ query: { currentFilePath: 'A.md', currentFileEntryId: 'a_id' } });
  try {
    await f.controller.refresh(); f.beforeNextBaseReturn(() => f.adapter.ids.set('A.md', 'replacement_id'));
    await assert.rejects(f.controller.summaryPreviews('score'), /current.*changed|pinned.*changed/i);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options?.currentEntryId, 'a_id'); assert.ok(f.pins.every(pin => pin.closed === 1));
  } finally { f.controller.dispose(); }
});

test('an available identity guard also rejects replacement on an adapter without shared queries', async () => {
  const adapter = new IdentityAdapter({ 'Work.base': base, 'A.md': 'A\n' }); adapter.ids.set('A.md', 'replacement_id');
  const vault = new Vault(adapter); await vault.initialize();
  const controller = new BaseController({ vault, basePath: 'Work.base', query: { currentFilePath: 'A.md', currentFileEntryId: 'a_id' }, mutations: { async transform() { throw Error('No write'); } } });
  try { await controller.refresh(); assert.match(controller.state.error?.message ?? '', /current.*changed|pinned.*changed/i); assert.equal(controller.state.result, null); }
  finally { controller.dispose(); }
});

test('the actual session API distinguishes a blank null context from its standalone Base default', async () => {
  const adapter = new MemoryAdapter({ 'Work.base': base, 'A.md': 'A\n' }), vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), buffers = new Map<string, NoteBuffer>();
  const session = createBaseSession(dom.window.document.querySelector('main')!, { vault, basePath: 'Work.base', validate() {}, openFile() {}, buffers: { validate() {}, async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path); buffers.set(path, buffer); } await buffer.load(); return buffer; } } });
  try {
    await session.ready; assert.deepEqual(session.state.result?.rows.map(row => row.path), []);
    await session.setCurrentFile(null); assert.equal(session.state.error, null); assert.deepEqual(session.state.result?.rows.map(row => row.path), ['A.md', 'Work.base']);
    await session.setCurrentFile('A.md'); assert.deepEqual(session.state.result?.rows.map(row => row.path), []);
  } finally { await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); }
});
