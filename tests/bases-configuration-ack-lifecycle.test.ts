import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseSession } from '../src/bases/session.ts';
import { baseEditAdmissionReceipt, recordBaseEditAdmission } from '../src/bases/edit-admission-diagnostics.ts';
import { projectSharedBasePreview } from '../src/bases/shared-query.ts';
import type { BaseControllerState } from '../src/bases/controller.ts';
import type { DocumentBasePreviewResult } from '../src/core/document-preview.ts';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { readProperties } from '../src/core/properties.ts';
import type { BaseViewPatch } from '../src/bases/document.ts';
import type { DurableWrites, DurableWriteInput, DurableWriteRead, DurableWriteIntent } from '../src/core/durable-writes.ts';
import type { Checkpoint } from '../src/core/durable-checkpoints.ts';
import type { DocumentService, DocumentBaseResult } from '../src/core/document-semantics.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const base = '# keep\nplugin: {retain: true}\nviews:\n  - type: table\n    name: First\n    order: [file.name, rating]\n    columnSize: {note.rating: 91}\n    pluginView: {z: 1, a: [two, 3]}\n  - {type: list, name: Second}\n';
const note = '---\nrating: 1\nuntouched: [a, b]\n---\nKeep body.\n';
async function fixture() {
  const records = new Map<string, DurableWriteRead>();
  for (const [path, content] of Object.entries({ 'Work.base': base, 'One.md': note })) records.set(path, { path, content, entryId: path, revision: 'r1', stat: { ctime: 1, mtime: 1, size: content.length } });
  let generation = 1, queries = 0, fail: boolean | Error = false, baseWrites = 0, noteWrites = 0;
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites; documentSemantics!: DocumentService;
    override async list() { return (await super.list()).map(entry => { const row = records.get(entry.path); return row ? { ...entry, ...row.stat, entryId: row.entryId, revision: row.revision } : entry; }); }
    override async stat(path: string) { const entry = await super.stat(path), row = records.get(path); return entry && row ? { ...entry, ...row.stat, entryId: row.entryId, revision: row.revision } : entry; }
  }
  const adapter = new Adapter({ 'Work.base': base, 'One.md': note }), scope = { vaultId: 'fixture-authority', clientId: 'fixture-client' };
  const checkpoints = new Map<string, Checkpoint>(), inputs = new Map<string, DurableWriteInput>(), intents = new Map<string, DurableWriteIntent>();
  const unused = async (): Promise<never> => { throw new Error('Unexpected fixture effect'); };
  adapter.durableWrites = {
    checkpoints: { scope, load: async key => structuredClone(checkpoints.get(key) ?? null), compareAndSwap: async change => {
      assert.equal(change.expectedRevision, checkpoints.get(change.key)?.revision ?? null);
      const row: Checkpoint = { version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: String(generation), deleted: false, byteLength: 0 };
      checkpoints.set(change.key, row); return structuredClone(row);
    }, list: unused, changes: unused },
    readText: async path => structuredClone(records.get(path)!), readTextById: async id => structuredClone([...records.values()].find(row => row.entryId === id) ?? null),
    planWrite: async input => { const current = records.get(input.path)!; assert.equal(input.expectedEntryId, current.entryId); assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedContent, current.content); inputs.set(input.operationId, structuredClone(input)); return { version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input) }; },
    prepare: async plan => { const row: DurableWriteIntent = { state: 'prepared', acknowledged: false, ref: { ...scope, operationId: plan.operationId, entryId: plan.entryId, token: plan.operationId } }; intents.set(row.ref.token, row); return structuredClone(row); },
    commit: async ref => {
      if (fail) throw fail instanceof Error ? fail : new Error('fixture disk full'); const input = inputs.get(ref.operationId)!, current = records.get(input.path)!;
      assert.equal(input.expectedEntryId, current.entryId); assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedContent, current.content);
      const next = { ...current, content: input.content, revision: `r${++generation}`, stat: { ...current.stat, mtime: generation, size: input.content.length } }; records.set(input.path, next); await adapter.write(input.path, next.content);
      if (input.path === 'Work.base') baseWrites++; else noteWrites++;
      const row: DurableWriteIntent = { state: 'committed', acknowledged: false, ref, receipt: { operationId: ref.operationId, entryId: ref.entryId, revision: next.revision, sequence: String(generation) } }; intents.set(ref.token, row); return structuredClone(row);
    }, query: async ref => structuredClone(intents.get(ref.token) ?? null), listUnacknowledged: async () => [], acknowledge: async ref => { const row = intents.get(ref.token)!; if (row.state === 'committed' || row.state === 'rejected') intents.set(ref.token, { ...row, acknowledged: true }); },
  };
  const snapshot = () => ({ localStoreId: 'fixture-store', generationEpoch: 'fixture-epoch', generation: String(generation), versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } });
  const source = () => ({ localStoreId: 'fixture-store', watermark: String(generation) });
  adapter.documentSemantics = {
    status: async () => ({ source: source(), snapshot: snapshot(), coveredSource: source(), current: true, rebuildRequired: false, coverageComplete: true }), initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => {
      const saved = structuredClone(records), snap = snapshot(), watermark = source();
      const entry = (path: string) => { const row = saved.get(path)!; return { id: row.entryId, revision: row.revision, path, kind: 'file' as const, deleted: false }; };
      return { pinId: 'fixture-pin' as never, source: watermark, snapshot: snap, coverageComplete: true, close: async () => {}, search: unused, backlinks: unused,
        metadata: async path => ({ source: watermark, snapshot: snap, coverageComplete: true, value: { entry: entry(path), metadata: null, exclusion: null } }),
        base: async input => {
          queries++; const actor = entry('One.md'), raw = readProperties(saved.get(actor.path)!.content).find(item => item.key === 'rating')!.value as number;
          const selected = BaseDocument.parse(saved.get('Work.base')!.content).views[input.options?.viewIndex ?? 0];
          const result: DocumentBaseResult = { snapshotId: snap, view: selected, rows: [{ entryId: actor.id, revision: actor.revision, path: actor.path, values: { 'note.rating': { type: 'number', value: raw } } }], groups: [{ key: null, keyId: null, entryIds: [actor.id] }], groupOptions: [], properties: ['note.rating'], availableProperties: ['note.rating'], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1 };
          return { source: watermark, snapshot: snap, coverageComplete: true, value: { definition: entry('Work.base'), result } };
        },
      };
    },
  };
  const vault = new Vault(adapter); await vault.initialize(); const buffers = new Map<string, NoteBuffer>(), saved = gate(), release = gate(); let held = false;
  const getBuffer = async (path: string) => { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); if (path === 'Work.base') { const flush = buffer.flush.bind(buffer); buffer.flush = async () => { await flush(); if (!held) { held = true; saved.resolve(); await release.promise; } }; } } await buffer.load(); return buffer; };
  const publishedAdmission: boolean[] = [];
  let controller!: BaseController; controller = new BaseController({ vault, basePath: 'Work.base', delayMs: 1000, mutations: createBaseMutationHost({ validate() {}, getBuffer }), onChange(state) { if (!state.updating && state.result && !state.error) publishedAdmission.push(controller.canBeginPropertyEdit); } });
  await controller.refresh(); await getBuffer('One.md');
  return { adapter, vault, controller, records, getBuffer, publishedAdmission,
    async session(onBufferChange?: () => void) {
      controller.dispose(); const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!, errors: unknown[] = [];
      const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile() {}, buffers: { validate() {}, getBuffer, onBufferChange() { onBufferChange?.(); } }, onError(error) { errors.push(error); } }); await session.ready;
      return { session, host, dom, errors, key(element: Element, key: string) { element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); } };
    }, saved: saved.promise, release: release.resolve, fail(value: boolean | Error) { fail = value; }, get queries() { return queries; }, get baseWrites() { return baseWrites; }, get noteWrites() { return noteWrites; },
    async external(path: string, content: string, replacement = false) { const row = records.get(path)!; records.set(path, { ...row, entryId: replacement ? `${path}:replacement` : row.entryId, revision: `external${++generation}`, content, stat: { ...row.stat, mtime: generation, size: content.length } }); await adapter.write(path, content); await vault.reload([path]); },
    async close() { release.resolve(); fail = false; controller.dispose(); for (const buffer of buffers.values()) { try { await buffer.dispose(); } catch {} } },
  };
}

test('configuration lifecycle stays busy through a duplicate Base notification and admits only the fresh cell', async () => {
  const f = await fixture(), ui = await f.session();
  const content = () => ui.host.querySelector<HTMLElement>('.bases-session-content')!;
  const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(check()); };
  try {
    ui.key(ui.host.querySelector('[role="separator"]')!, 'Home'); await f.saved; await ui.session.refresh();
    await f.vault.reload(['Work.base']);
    assert.equal(content().getAttribute('aria-busy'), 'true');
    const cell = ui.host.querySelector<HTMLElement>('[data-path="One.md"][data-property="note.rating"]')!;
    assert.equal(cell.getAttribute('aria-disabled'), 'true'); cell.click(); ui.key(cell, 'Enter');
    assert.equal(cell.querySelector('input'), null, 'a pending configuration cannot expose a committable old numeric editor');
    assert.equal(f.noteWrites, 0); f.release();
    await until(() => content().getAttribute('aria-busy') === 'false');
    const fresh = ui.host.querySelector<HTMLElement>('[data-path="One.md"][data-property="note.rating"]')!;
    assert.equal(fresh.getAttribute('aria-disabled'), 'false'); fresh.click(); const input = fresh.querySelector<HTMLInputElement>('input')!;
    assert.ok(input); input.value = '5'; ui.key(input, 'Enter'); await until(() => content().getAttribute('aria-busy') === 'false');
    assert.equal(f.baseWrites, 1); assert.equal(f.noteWrites, 1); assert.deepEqual(ui.errors, []);
    assert.deepEqual(Object.fromEntries(readProperties(await f.vault.read('One.md')).map(item => [item.key, item.value])), { rating: 5, untouched: ['a', 'b'] }); assert.match(await f.vault.read('One.md'), /Keep body\./);
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Work.base')).views[0].columnSize, {});
  } finally { f.release(); await ui.session.close(); ui.dom.window.close(); await f.close(); }
});

test('controller new-edit readiness follows coherent publication, invalidation, request, error, preview and disposal', async () => {
  const f = await fixture(); try {
    assert.equal(f.controller.canBeginPropertyEdit, true); assert.equal(f.publishedAdmission.at(-1), true, 'readiness must not latch on refresh finally while a coherent result is already published');
    await f.vault.reload(['Work.base']); assert.equal(f.controller.canBeginPropertyEdit, false); await f.controller.refresh(); assert.equal(f.controller.canBeginPropertyEdit, true);
    const first = f.controller.refresh(), second = f.controller.refresh(); assert.equal(f.controller.canBeginPropertyEdit, false); await first; await second; assert.equal(f.controller.canBeginPropertyEdit, true);
    const status = f.adapter.documentSemantics.status; f.adapter.documentSemantics.status = async () => { throw new Error('fixture query unavailable'); };
    await f.controller.refresh(); assert.match(f.controller.state.error!.message, /fixture query unavailable/); assert.equal(f.controller.canBeginPropertyEdit, false);
    f.adapter.documentSemantics.status = status; await f.controller.refresh(); assert.equal(f.controller.canBeginPropertyEdit, true);
    const raw = f.controller.state.result!.shared!;
    const preview = projectSharedBasePreview({ ...raw, status: 'indexing', complete: false, aggregatesComplete: false, countsScope: 'preparedSubset', progress: { preparedFiles: 1, totalFiles: 2, pendingFiles: 1 }, preparedScanComplete: false, unavailablePreparedFiles: 0, unavailableFilterRows: 0 } as DocumentBasePreviewResult, f.controller.state.version, [...f.vault.entries.values()]);
    // Isolated getter branch fixture: a real projected preview has no saved edit authority.
    const access = f.controller as unknown as { current: BaseControllerState; settled: BaseControllerState }, current = access.current, settled = access.settled;
    access.current = access.settled = { ...current, result: preview }; assert.equal(f.controller.canBeginPropertyEdit, false); access.current = current; access.settled = settled;
    f.controller.dispose(); assert.equal(f.controller.canBeginPropertyEdit, false);
  } finally { await f.close(); }
});

test('configuration recovery wrappers retain the original reported Error and passive receipt', async () => {
  const f = await fixture();
  const original = recordBaseEditAdmission(new Error('fixture configuration save rejected'), { guard: 'controller', phase: 'durable-validation', reason: 'identity', submittedVersion: 1, currentVersion: 1, hasResult: true, queryError: false, updating: false });
  const receipt = baseEditAdmissionReceipt(original), ui = await f.session(() => { throw original; });
  try {
    ui.key(ui.host.querySelector('[role="separator"]')!, 'Home');
    for (let i = 0; i < 300 && !ui.errors.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(ui.errors[0], original, 'the original buffer validation Error must reach onError before recovery UI wraps it');
    assert.deepEqual(JSON.parse(ui.host.querySelector<HTMLElement>('.bases-session')!.dataset.baseLastEditRejection!), receipt);
    assert.equal(f.baseWrites, 0); assert.equal(f.noteWrites, 0); assert.equal(ui.host.querySelector('.bases-session-content')!.getAttribute('aria-busy'), 'false');
  } finally { f.fail(false); f.release(); await ui.session.close(); ui.dom.window.close(); await f.close(); }
});
