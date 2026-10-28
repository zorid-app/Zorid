import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseSession } from '../src/bases/session.ts';
import { sharedBaseCoverage } from '../src/bases/shared-query.ts';
import type { BaseClockHost } from '../src/bases/clock.ts';
import type { DocumentBaseResult, DocumentPin, DocumentService } from '../src/core/document-semantics.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { VaultEntry } from '../src/core/types.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '1' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function settled(check: () => boolean) { for (let i = 0; i < 400 && !check(); i++) await Promise.resolve(); assert.ok(check()); }
class Adapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  identify(entry: VaultEntry) { return { ...entry, entryId: entry.path, revision: 'r1' }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identify(entry) : null; }
}
async function fixture(initialVisible = true) {
  const adapter = new Adapter({ 'Work.base': 'views:\n  - type: table\n    name: Table\n    order: [status]\n', 'One.md': '---\nstatus: saved\n---\nbody\n' });
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const buffers = new Map<string, NoteBuffer>(), listeners = new Set<() => void>();
  const state = { calls: 0, coverage: true, metadata: true, fail: false, empty: false, visible: initialVisible, next: undefined as ReturnType<typeof deferred> | undefined };
  const definition = { id: 'Work.base', revision: 'r1', path: 'Work.base', kind: 'file' as const, deleted: false };
  const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
  adapter.documentSemantics = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: state.coverage }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => {
      const complete = state.coverage, metadataComplete = state.metadata;
      return { pinId: 'pin' as DocumentPin['pinId'], snapshot, source, coverageComplete: complete, close: async () => {}, search: unused, backlinks: unused,
        metadata: async () => ({ source, snapshot, coverageComplete: complete, value: { entry: definition, metadata: null, exclusion: null } }),
        base: async () => {
          state.calls++; const gate = state.next; state.next = undefined; if (gate) await gate.promise;
          if (state.fail) throw new Error('Saved results unavailable');
          const rows: DocumentBaseResult['rows'] = state.empty ? [] : [{ entryId: 'One.md', revision: 'r1', path: 'One.md', values: { 'note.status': { type: 'string', value: 'saved' } } }];
          const result: DocumentBaseResult = { snapshotId: snapshot, view: { type: 'table', name: 'Table' }, rows, groups: rows.length ? [{ keyId: null, key: null, entryIds: ['One.md'] }] : [], groupOptions: [], properties: ['note.status'], availableProperties: ['note.status'], counts: { scanned: 2, matched: rows.length, afterGroupOrder: rows.length, afterSearch: rows.length, returned: rows.length }, diagnostics: [], relationshipsAvailable: true, metadataComplete, metadataIssues: [], stepsUsed: 9, refreshHint: { dependency: 'none', timezone: 'UTC', nextWakeMs: null } };
          return { source, snapshot, coverageComplete: complete, value: { definition, result } };
        },
      };
    },
  };
  const vault = new Vault(adapter); await vault.initialize();
  const clock: BaseClockHost = { capture: () => ({ clockMs: 0, timezone: 'UTC' }), isVisible: () => true, scheduleAt: () => { throw new Error('None must not schedule'); }, subscribeWake: () => () => {} };
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile() {}, clock,
    visibility: { isVisible: () => state.visible, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    buffers: { validate() {}, async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); } return buffer; } },
  });
  await session.ready;
  const key = (node: Element, value: string) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  return { state, session, host, key, listeners, hold() { const gate = deferred(); state.next = gate; return gate; }, visible(value: boolean) { state.visible = value; for (const run of [...listeners]) run(); },
    status: () => host.querySelector('.bases-session-status')!.textContent,
    busy: () => host.querySelector('.bases-session-content')!.getAttribute('aria-busy'),
    async cleanup() { for (const input of host.querySelectorAll('input,textarea')) key(input, 'Escape'); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); },
  };
}
test('refresh reports activity separately and retains the exact coherent mounted result until completion', async () => {
  const f = await fixture(); try {
    const before = f.session.state, table = f.host.querySelector('.zorid-bases-table'), gate = f.hold(), pending = f.session.refresh();
    assert.equal(f.session.state.updating, true); assert.equal(f.session.state.result, before.result); assert.equal(f.status(), ''); assert.equal(f.busy(), 'true');
    await settled(() => f.state.calls === 2); assert.equal(f.host.querySelector('.zorid-bases-table'), table);
    gate.resolve(); await pending;
    assert.equal(f.session.state, before, 'no-op returns the existing settled state'); assert.equal(f.host.querySelector('.zorid-bases-table'), table); assert.equal(f.status(), ''); assert.equal(f.busy(), 'false');
  } finally { await f.cleanup(); }
});
test('a focused draft and prior rows survive an updating refresh and its failure', async () => {
  const f = await fixture(); try {
    const before = f.session.state.result, cell = f.host.querySelector('[data-property="note.status"][role="gridcell"]')!;
    f.key(cell, 'Enter'); const input = cell.querySelector('input')!; input.value = 'unsaved local draft'; input.focus();
    const gate = f.hold(), pending = f.session.refresh(); await settled(() => f.state.calls === 2);
    assert.equal(input.isConnected, true); assert.equal(input.value, 'unsaved local draft'); assert.equal(f.status(), '');
    f.state.fail = true; gate.resolve(); await pending;
    assert.equal(f.session.state.updating, false); assert.equal(f.session.state.result, before); assert.equal(f.status(), 'Saved results unavailable'); assert.equal(f.busy(), 'false'); assert.equal(input.isConnected, true); assert.equal(input.value, 'unsaved local draft');
  } finally { await f.cleanup(); }
});
test('coverage comes from the admitted outer snapshot and metadata facts, including empty rows', async () => {
  const f = await fixture(); try {
    assert.deepEqual(sharedBaseCoverage(f.session.state.result!), { generationComplete: true, metadataComplete: true });
    f.state.coverage = false; f.state.metadata = false; f.state.empty = true; await f.session.refresh();
    assert.equal(f.session.state.result!.rows.length, 0); assert.equal(f.status(), 'Some saved files are unavailable in these results.'); assert.doesNotMatch(f.status()!, /Indexing|complete/i);
    f.state.coverage = true; await f.session.refresh(); assert.equal(f.status(), 'Some saved properties are unavailable in these results.');
    f.state.metadata = true; await f.session.refresh(); assert.equal(f.status(), '');
    const coverage = sharedBaseCoverage(f.session.state.result!)!; assert.equal(Object.isFrozen(coverage), true); assert.deepEqual(coverage, { generationComplete: true, metadataComplete: true });
  } finally { await f.cleanup(); }
});
test('injected pane visibility defers first admission, cancels busy display, and refreshes on activation', async () => {
  const f = await fixture(false); try {
    assert.equal(f.state.calls, 0); assert.equal(f.session.state.result, null);
    f.visible(true); await settled(() => f.state.calls === 1 && f.session.state.result !== null);
    const before = f.session.state.result, gate = f.hold(), pending = f.session.refresh(); await settled(() => f.state.calls === 2);
    assert.equal(f.busy(), 'true'); f.visible(false); assert.equal(f.session.state.updating, false); assert.equal(f.busy(), 'false');
    gate.resolve(); await pending; assert.equal(f.session.state.result, before); assert.equal(f.state.calls, 2);
    f.visible(true); await settled(() => f.state.calls === 3 && !f.session.state.updating);
  } finally { await f.cleanup(); assert.equal(f.listeners.size, 0); }
});
