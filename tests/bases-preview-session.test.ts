import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseSession } from '../src/bases/session.ts';
import { sharedBasePreview } from '../src/bases/shared-query.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { DocumentBaseResult, DocumentService } from '../src/core/document-semantics.ts';
import type { DocumentBasePreviewResult } from '../src/core/document-preview.ts';
import type { DocumentRuntimeObservation, DocumentRuntimeUpdate } from '../src/core/document-runtime.ts';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 600 && !check(); i++) await Promise.resolve(); assert.ok(check()); }
class Adapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  override async list() { return (await super.list()).map(row => ({ ...row, entryId: row.path, revision: 'r1' })); }
  override async stat(path: string) { const row = await super.stat(path); return row ? { ...row, entryId: row.path, revision: 'r1' } : null; }
}
async function fixture(type: string, empty = false) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const source = { localStoreId: 'store', watermark: '1' }, snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
  const definition = { id: 'Work.base', revision: 'r1', path: 'Work.base', kind: 'file' as const, deleted: false };
  const view = { type, name: 'View', order: ['status'], ...(type === 'kanban' ? { groupBy: { property: 'status', direction: 'ASC' } } : {}) };
  const group = { type: 'string' as const, value: 'ready' };
  const raw: DocumentBaseResult = { snapshotId: snapshot, view, rows: [{ entryId: 'One.md', revision: 'r1', path: 'One.md', values: { 'note.status': group, 'note.done': { type: 'boolean', value: false } } }], groups: [{ key: group, keyId: 'ready', entryIds: ['One.md'] }], groupOptions: [{ key: group, keyId: 'ready', listed: true, count: 1 }], properties: ['note.status', 'note.done'], availableProperties: ['note.status', 'note.done'], counts: { scanned: 2, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1, refreshHint: null };
  const { snapshotId: _snapshot, ...values } = raw;
  const preview: DocumentBasePreviewResult = { ...values, ...(empty ? { rows: [], groups: [], counts: { scanned: 1, matched: 0, afterGroupOrder: 0, afterSearch: 0, returned: 0 } } : {}), status: 'indexing', complete: false, aggregatesComplete: false, countsScope: 'preparedSubset', progress: { preparedFiles: 1, totalFiles: 3, pendingFiles: 2 }, preparedScanComplete: false, unavailablePreparedFiles: 1, unavailableFilterRows: 1, relationshipsAvailable: false, metadataComplete: false };
  const adapter = new Adapter({ 'Work.base': `views:\n  - type: ${type}\n    name: View\n    order: [status]\n${type === 'kanban' ? '    groupBy: {property: status, direction: ASC}\n' : ''}`, 'One.md': '---\nstatus: ready\n---\n' });
  let current = false, writes = 0, closes = 0;
  const demand = deferred<DocumentRuntimeObservation>(), listeners = new Set<(value: DocumentRuntimeUpdate | null) => void>(), opens: string[] = [], openedFiles: string[] = [];
  const update = (): DocumentRuntimeUpdate => ({ lifetime: 'owner', revision: current ? '2' : '1', source, published: current ? snapshot : null, freshness: current ? 'current' : 'lagging', phase: current ? 'idle' : 'indexing', progress: current ? null : { prepared: 1, total: 3, ready: false }, coverageComplete: current ? true : null, hasForegroundDemand: false, error: null });
  const unused = async (): Promise<never> => { throw new Error('No renderer core effects'); };
  adapter.documentSemantics = {
    basePreviewAvailable: true, maintenance: { observeAndSubscribe: async listener => { listeners.add(listener); return { snapshot: update(), unsubscribe: () => { listeners.delete(listener); } }; }, requestFreshness: () => ({ result: demand.promise, cancel: async () => {} }) },
    status: async () => ({ source, snapshot: current ? snapshot : null, coveredSource: current ? source : null, current, rebuildRequired: false, coverageComplete: current ? true : null }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    openPreview: async () => { const previewId = String(opens.length + 1), capture = { ownerNonce: 'owner', stageId: 'stage', serial: previewId }; opens.push(previewId); return { previewId, capture, source, progress: preview.progress, base: async () => ({ previewId, capture, source, definition, result: preview }), close: async () => { closes++; } }; },
    open: async () => ({ pinId: 'pin' as never, snapshot, source, coverageComplete: true, close: async () => {}, search: unused, backlinks: unused, metadata: async () => ({ source, snapshot, coverageComplete: true, value: { entry: definition, metadata: null, exclusion: null } }), base: async () => ({ source, snapshot, coverageComplete: true, value: { definition, result: raw } }) }),
  };
  const vault = new Vault(adapter); await vault.initialize();
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile(path) { openedFiles.push(path); }, query: { now: () => new Date(42) },
    buffers: { validate() {}, getBuffer: async () => { writes++; throw new Error('No preview mutation may acquire a buffer'); } },
  });
  await until(() => !!session.state.result);
  const key = (node: Element, key: string) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { host, dom, session, key, opens, openedFiles, writes: () => writes, status: () => host.querySelector('.bases-session-status')!.textContent!,
    publish() { current = true; demand.resolve({ source, published: snapshot, current: true, rebuildRequired: false, coverageComplete: true }); for (const listener of [...listeners]) listener(update()); },
    async cleanup() { for (const input of host.querySelectorAll('input,textarea')) key(input, 'Escape'); await session.close(); await session.ready; assert.equal(listeners.size, 0); assert.equal(closes, opens.length); dom.window.close(); },
  };
}
for (const type of ['table', 'cards', 'list', 'kanban']) test(`${type} previews disable actual edit affordances and rebind the same view after publication`, async () => {
  const f = await fixture(type);
  try {
    assert.ok(sharedBasePreview(f.session.state.result!)); assert.match(f.status(), /1 of 3 files indexed; 2 remaining/); assert.match(f.status(), /Read-only preview/); assert.match(f.status(), /Counts and aggregates cover indexed notes only/); assert.match(f.status(), /not been checked yet/); assert.match(f.status(), /1 file is unavailable/); assert.match(f.status(), /1 note could not be checked against the filters/);
    const content = f.host.querySelector('.bases-session-content')!, old = content.firstElementChild;
    assert.ok(old); assert.equal(content.querySelector('input:not([type="checkbox"]),textarea,[contenteditable="true"]'), null); for (const checkbox of content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) assert.equal(checkbox.disabled, true); assert.equal(content.querySelector('[draggable="true"]'), null);
    assert.equal(f.host.querySelector('button[aria-label="View options"]'), null); assert.equal(f.dom.window.document.querySelector('[role="dialog"]'), null);
    for (const node of content.querySelectorAll('[role="gridcell"],.bases-rendered-value,.bases-kanban-card,.bases-cards-item')) { f.key(node, 'Enter'); node.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true })); node.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }
    assert.equal(content.querySelector('input:not([type="checkbox"]),textarea,[contenteditable="true"]'), null); for (const checkbox of content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) assert.equal(checkbox.disabled, true); assert.equal(f.writes(), 0);
    f.publish(); await f.session.ready; assert.equal(sharedBasePreview(f.session.state.result!), undefined); assert.notEqual(content.firstElementChild, old, 'same-type readonly transition must rebuild callback owners');
    assert.equal(f.host.querySelector<HTMLButtonElement>('button[aria-label="View options"]')!.disabled, false);
    // A retained retired node cannot recover its old callbacks or mutate the result.
    old!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(f.writes(), 0);
    if (type === 'table') { const cell = content.querySelector('[role="gridcell"][data-property="note.status"]')!; f.key(cell, 'Enter'); assert.ok(cell.querySelector('input'), 'published table regains its editor'); f.key(cell.querySelector('input')!, 'Escape'); }
    if (type === 'kanban') assert.ok(content.querySelector('[draggable="true"]'), 'published Kanban regains permitted moves');
  } finally { await f.cleanup(); }
});
test('a zero-row preview uses prepared-subset empty wording instead of a global empty claim', async () => {
  const f = await fixture('table', true);
  try {
    assert.equal(f.session.state.result!.counts.returned, 0); assert.match(f.host.querySelector('.bases-session-content')!.textContent!, /No matches in indexed notes yet/); assert.doesNotMatch(f.host.textContent!, /No results/); assert.match(f.status(), /2 remaining/); assert.equal(f.session.state.result!.shared && 'snapshotId' in f.session.state.result!.shared, false);
    f.publish(); await f.session.ready; assert.equal(f.session.state.result!.rows.length, 1); assert.ok(f.host.querySelector('.zorid-bases-table')); assert.equal(f.status(), '');
  } finally { await f.cleanup(); }
});
