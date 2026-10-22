import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { readProperties } from '../src/core/properties.ts';
import type { DocumentService, DocumentBaseResult, DocumentBaseValue } from '../src/core/document-semantics.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';

const tick = () => new Promise<void>(done => setTimeout(done, 8));
async function until(check: () => boolean) { for (let i = 0; i < 120; i++) { if (check()) return; await tick(); } assert.ok(check()); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

for (const external of ['Rust', [1]]) test(`widget acknowledgement rejects a saved raw ${JSON.stringify(external)} replacing its own list`, async () => {
  class Adapter extends MemoryAdapter {
    documentSemantics?: DocumentService;
    revisions = new Map<string, number>();
    identify<T extends {path: string}>(row: T) { return {...row, entryId: row.path, revision: `r${this.revisions.get(row.path) ?? 1}`}; }
    override async list() { return (await super.list()).map(row => this.identify(row)); }
    override async stat(path: string) { const row = await super.stat(path); return row && this.identify(row); }
    override async write(path: string, text: string) { await super.write(path, text); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1); }
  }
  const chosen = typeof external === 'string' ? 'Rust' : '1';
  const base = 'views: [{type: table, name: Table, order: [topics]}]\n';
  const adapter = new Adapter({'Work.base': base, 'One.md': '---\ntopics: []\n---\nBody', 'Properties.yaml': 'properties:\n  topics:\n    type: multiselect\n    options: [{value: Rust}, {value: "1"}]\n'});
  const entered = deferred(), release = deferred(); let holdNext = false;
  const snapshot = {localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: {schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1'}}, source = {localStoreId: 'store', watermark: '1'};
  const entry = async (path: string) => { const row = (await adapter.stat(path))!; return {id: row.entryId, revision: row.revision, path, kind: 'file' as const, deleted: false}; };
  const unused = async (): Promise<never> => { throw new Error('Unexpected core effect'); };
  const value = (raw: unknown): DocumentBaseValue => Array.isArray(raw) ? {type: 'list', value: raw.map(value)} : typeof raw === 'number' ? {type: 'number', value: raw} : typeof raw === 'string' ? {type: 'string', value: raw} : {type: 'null'};
  adapter.documentSemantics = {
    status: async () => ({source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true}), initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => ({pinId: 'pin' as never, source, snapshot, coverageComplete: true, close: async () => {}, search: unused, backlinks: unused,
      metadata: async path => ({source, snapshot, coverageComplete: true, value: {entry: await entry(path), metadata: null, exclusion: null}}),
      base: async () => {
        const actor = await entry('One.md'), raw = readProperties(await adapter.read(actor.path)).find(item => item.key === 'topics')!.value;
        const result: DocumentBaseResult = {snapshotId: snapshot, view: BaseDocument.parse(base).views[0], rows: [{entryId: actor.id, revision: actor.revision, path: actor.path, values: {'note.topics': value(raw)}}], groups: [{key: null, keyId: null, entryIds: [actor.id]}], groupOptions: [], properties: ['note.topics'], availableProperties: ['note.topics'], counts: {scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1}, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1};
        if (holdNext) { holdNext = false; entered.resolve(); await release.promise; }
        return {source, snapshot, coverageComplete: true, value: {definition: await entry('Work.base'), result}};
      },
    }),
  };
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true}), host = dom.window.document.querySelector('main')!, buffers = new Map<string, NoteBuffer>(), errors: unknown[] = [];
  const session = createBaseSession(host, {vault, basePath: 'Work.base', validate() {}, openFile() {}, onError(error) { errors.push(error); }, buffers: {validate() {}, async getBuffer(path) {
    let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path); Object.defineProperty(buffer, 'savedDurableWitness', {get: () => ({path, entryId: path, revision: `r${adapter.revisions.get(path) ?? 1}`})}); buffers.set(path, buffer); } await buffer.load(); return buffer;
  }}});
  const key = (element: Element, key: string) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
  try {
    await session.ready; assert.ifError(session.state.error);
    key(host.querySelector('[data-property="note.topics"][role="gridcell"]')!, 'Enter');
    const input = dom.window.document.querySelector<HTMLInputElement>('.bases-property-popover input')!; assert.ok(input);
    holdNext = true; input.value = chosen; input.dispatchEvent(new dom.window.Event('input', {bubbles: true})); key(input, 'Enter'); await entered.promise;
    assert.deepEqual(readProperties(await vault.read('One.md'))[0].value, [chosen], 'own list write reached durable storage before the query acknowledgement');
    await vault.modify('One.md', `---\ntopics: ${JSON.stringify(external)}\n---\nBody`);
    await buffers.get('One.md')!.reload();
    const refresh = session.refresh(); release.resolve(); await refresh;
    await until(() => !dom.window.document.querySelector('.bases-property-popover input'));
    assert.equal(input.isConnected, false, 'an unrelated raw shape/type cannot become the next editor baseline');
    assert.deepEqual(readProperties(await vault.read('One.md'))[0].value, external); assert.deepEqual(errors, []);
    await until(() => !session.hasPendingChanges());
  } finally {
    release.resolve(); for (const input of dom.window.document.querySelectorAll('.bases-property-popover input')) key(input, 'Escape');
    await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close();
  }
});
