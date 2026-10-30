import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import type {DatabaseService,DatabaseCollection} from '../src/core/databases.ts';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { DocumentService, DocumentBaseResult } from '../src/core/document-semantics.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';

const initial = 'views: [{id: aaaaaaaaaaaa, type: table, name: Table, source: {kind: collection, id: abcdefghijkl}, order: [scorevalueid], summaries: {scorevalueid: Sum}, summaryDefinitions: {Sum: values.sum()}}]\n';
const note = '---\nscore: 10\n---\nExact body\n';
const tick = () => new Promise<void>(done => setTimeout(done, 5));
async function until(check: () => boolean | Promise<boolean>, label: string) { const end = Date.now() + 3000; while (!await check()) { assert.ok(Date.now() < end, label); await tick(); } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(enhanced = true) {
  class Adapter extends MemoryAdapter {
    documentSemantics?: DocumentService;databases?:DatabaseService; revision = 1; fail = false;attempts=0;
    override async list() { return (await super.list()).map(entry => ({ ...entry, entryId: entry.path, revision: entry.path === 'Work.base' ? `r${this.revision}` : 'r1' })); }
    override async stat(path: string) { return (await this.list()).find(entry => entry.path === path) ?? null; }
    override async write(path: string, text: string) { if(path==='Work.base')this.attempts++;if (path === 'Work.base' && this.fail) throw Error('Summary storage unavailable'); await super.write(path, text); if (path === 'Work.base') this.revision++; }
  }
  const adapter = new Adapter({ 'Work.base': initial, 'One.md': note });
  const collection:DatabaseCollection={id:'abcdefghijkl',name:'Summary fixture',revision:'schema-r1',deleted:false,properties:[{id:'scorevalueid',name:'Score',datatype:'number',options:[]}]};
  adapter.databases={async request(command){assert.equal(command.op,'get');return{collections:[collection],entries:[{entryId:'One.md',collectionId:collection.id,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{scorevalueid:10},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};}} as DatabaseService;
  const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } }, source = { localStoreId: 'store', watermark: '1' };
  const definition = () => ({ id: 'Work.base', revision: `r${adapter.revision}`, path: 'Work.base', kind: 'file' as const, deleted: false });
  const unused = async (): Promise<never> => { throw Error('Unexpected index effect'); };
  // Literal typed service-boundary data admits a real footer/editor. This is
  // session lifecycle coverage, not a claim that this fixture evaluates Rust.
  adapter.documentSemantics = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => ({ pinId: 'pin' as never, source, snapshot, coverageComplete: true, close: async () => {}, search: unused, backlinks: unused,
      metadata: async () => ({ source, snapshot, coverageComplete: true, value: { entry: definition(), metadata: null, exclusion: null } }),
      base: async () => {
        const view = BaseDocument.parse(await adapter.read('Work.base')).views[0];
        const result: DocumentBaseResult = { snapshotId: snapshot, view, rows: [{ entryId: 'One.md', revision: 'r1', path: 'One.md', values: { 'note.scorevalueid': { type: 'number', value: 10 } } }],
          groups: [{ key: null, keyId: null, entryIds: ['One.md'] }], groupOptions: [], properties: ['note.scorevalueid'], availableProperties: ['note.scorevalueid'],
          counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1,
          summaries: { 'note.scorevalueid': { type: 'number', value: 10 } }, summaryPreviews: { Sum: { type: 'number', value: 10 } } };
        return { source, snapshot, coverageComplete: true, value: { definition: definition(), result } };
      },
    }),
  };
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main><button id="outside">Pin context</button>', { pretendToBeVisual: true }), doc = dom.window.document, host = doc.querySelector('main')!;
  const globals = ['window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'HTMLElement', 'Node', 'Window'] as const;
  const previous = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  if (enhanced) for (const name of globals) { const value = dom.window[name]; Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === 'function' && ['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'].includes(name) ? value.bind(dom.window) : value }); }
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect(); dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const buffers = new Map<string, NoteBuffer>(), releases: (() => void)[] = [];
  const getBuffer = async (path: string) => { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path); Object.defineProperty(buffer, 'savedDurableWitness', { get: () => ({ path, entryId: path, revision: path === 'Work.base' ? `r${adapter.revision}` : 'r1' }) }); buffers.set(path, buffer); } await buffer.load(); return buffer; };
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile() {}, buffers: { validate() {}, getBuffer } });
  await session.ready;
  host.querySelector<HTMLElement>('[data-summary-property="note.scorevalueid"]')!.click();
  await until(() => !!doc.querySelector('[aria-label="Edit Sum"]'), 'The real summary picker opens');
  doc.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click();
  await until(() => !!doc.querySelector('textarea[aria-label="Summary expression"]'), 'The real summary editor opens');
  const expression = doc.querySelector<HTMLTextAreaElement>('textarea[aria-label="Summary expression"]')!, name = doc.querySelector<HTMLInputElement>('input[aria-label="Summary name"]')!;
  const panel = doc.querySelector<HTMLElement>('.bases-summary-editor')!, content = enhanced ? doc.querySelector<HTMLElement>('.cm-content[aria-label="Summary expression"]')! : expression;
  const view = enhanced ? EditorView.findFromDOM(content) : undefined; if (enhanced) assert.ok(view);
  assert.equal(panel.parentElement, doc.body, 'The summary is an actual body portal, not a pane descendant'); assert.equal(expression.value, 'values.sum()'); assert.equal(await adapter.read('Work.base'), initial);
  const editExpression = (value: string) => { if (view) { view.focus(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length }, userEvent: 'input.type' }); } else { expression.focus(); expression.value = value; expression.dispatchEvent(new dom.window.Event('input', { bubbles: true })); } };
  const button = (label: string) => [...doc.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button => button.textContent === label && !button.hidden);
  return { adapter, doc, host, dom, session, expression, name, panel, content, buffers, getBuffer, editExpression, button,
    gate() { const gate = { started: deferred(), release: deferred() }; releases.push(gate.release.resolve); return gate; },
    async cleanup() {
      releases.forEach(release => release()); adapter.fail = false;
      if(panel.querySelector('[role="alert"]')?.textContent)await session.flush().catch(()=>{});
      const cancel = button('Cancel changes'); if (cancel) cancel.click();
      if (panel.isConnected && session.hasPendingChanges()) { name.focus(); name.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }
      await until(() => !session.hasPendingChanges(), 'No retained summary draft is discarded during cleanup');
      await session.close(); for (const buffer of buffers.values()) await buffer.dispose();
      dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

for (const enhanced of [false, true]) test(`clean ${enhanced ? 'enhanced' : 'native'} summary portal stays open for default flush and closes for an explicit context transition`, async () => {
  const f = await fixture(enhanced);
  try {
    assert.equal(f.session.hasPendingChanges(), false); await f.session.flush(); assert.equal(f.panel.isConnected, true, 'Ordinary flush retains a clean summary panel');
    await f.session.flush({ dismissCleanPanels: true }); assert.equal(f.panel.isConnected, false, 'An explicit context transition removes the clean body portal'); assert.equal(f.host.querySelector('.bases-session')?.isConnected, true);
    assert.equal(await f.adapter.read('Work.base'), initial); assert.equal(await f.adapter.read('One.md'), note); assert.equal(f.adapter.revision, 1);
  } finally { await f.cleanup(); }
});

test('context flush refuses a dirty Summary name without dismissing its portal, value or focus', async () => {
  const f = await fixture();
  try {
    f.name.focus(); f.name.value = 'Retained name'; f.name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    await assert.rejects(f.session.flush({ dismissCleanPanels: true }), /Finish or cancel/);
    assert.equal(f.panel.isConnected, true); assert.equal(f.name.value, 'Retained name'); assert.equal(f.doc.activeElement, f.name); assert.equal(f.session.hasPendingChanges(), true);
    assert.equal(await f.adapter.read('Work.base'), initial); assert.equal(await f.adapter.read('One.md'), note);
  } finally { await f.cleanup(); }
});

test('context flush preserves a dirty Summary expression before its ordinary autosave is admitted', async () => {
  const f = await fixture();
  try {
    f.editExpression('values.length');
    await assert.rejects(f.session.flush({ dismissCleanPanels: true }), /Finish or cancel/);
    assert.equal(f.panel.isConnected, true); assert.equal(f.expression.value, 'values.length'); assert.equal(f.doc.activeElement, f.content); assert.equal(f.session.hasPendingChanges(), true);
    assert.equal(await f.adapter.read('Work.base'), initial); assert.equal(await f.adapter.read('One.md'), note);
  } finally { await f.cleanup(); }
});

test('context dismissal preserves a raw whitespace Summary name while ordinary flush keeps its existing normalization behavior', async () => {
  const f = await fixture();
  try {
    f.name.focus(); f.name.value = ' Sum '; f.name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    await f.session.flush(); assert.equal(f.panel.isConnected, true); assert.equal(f.name.value, ' Sum ', 'Ordinary flush does not discard raw text');
    await assert.rejects(f.session.flush({ dismissCleanPanels: true }), /Finish or cancel/);
    assert.equal(f.panel.isConnected, true); assert.equal(f.name.value, ' Sum '); assert.equal(f.doc.activeElement, f.name);
    assert.equal(await f.adapter.read('Work.base'), initial); assert.equal(await f.adapter.read('One.md'), note);
  } finally { await f.cleanup(); }
});

test('a terminal summary save retains its editable input through a context-transition flush', async () => {
  const f = await fixture();
  try {
    f.adapter.fail = true; f.editExpression('values.length');
    await until(() => !!f.panel.querySelector('[role="alert"]')?.textContent, 'The real terminal shared-buffer failure keeps editable input');
    const attempts=f.adapter.attempts;f.doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click();await tick();assert.equal(f.adapter.attempts,attempts,'Back dispatches no persistence attempt');assert.equal(f.doc.querySelector('.bases-configuration-review'),null);assert.equal(f.expression.disabled,false);assert.equal(await f.adapter.read('Work.base'),initial);
    await assert.rejects(f.session.flush({ dismissCleanPanels: true }), /Summary storage unavailable/);
    assert.equal(f.panel.isConnected, true); assert.equal(f.expression.value, 'values.length'); assert.equal(f.expression.disabled,false);assert.equal(f.button('Review retained changes'),undefined); assert.equal(f.session.hasPendingChanges(), true);
    assert.equal(await f.adapter.read('Work.base'), initial); assert.equal(await f.adapter.read('One.md'), note);
  } finally { await f.cleanup(); }
});

test('context-transition dismissal waits for the accepted real summary save acknowledgement', async () => {
  const f = await fixture(), buffer = await f.getBuffer('Work.base'), flush = buffer.flush.bind(buffer), gate = f.gate(); let held = false, transitioning: Promise<void> | undefined;
  try {
    buffer.flush = async () => { await flush(); if (!held && buffer.savedText.includes('values.length')) { held = true; gate.started.resolve(); await gate.release.promise; } };
    f.editExpression('values.length'); await gate.started.promise;
    const expected = BaseDocument.parse(initial); expected.editViewSummary(0,'Sum', 'Sum', 'values.length');
    assert.equal(await f.adapter.read('Work.base'), expected.toString(), 'The real save wrote bytes before the acknowledgement tail was held');
    let complete = false; transitioning = f.session.flush({ dismissCleanPanels: true }).then(() => { complete = true; });
    await tick(); assert.equal(complete, false); assert.equal(f.panel.isConnected, true, 'Pending persistence owns the portal until its original acknowledgement');
    gate.release.resolve(); await transitioning;
    assert.equal(f.panel.isConnected, false); assert.equal(f.session.hasPendingChanges(), false); assert.equal(await f.adapter.read('Work.base'), expected.toString()); assert.equal(f.adapter.revision, 2); assert.equal(await f.adapter.read('One.md'), note);
  } finally { gate.release.resolve(); await transitioning?.catch(() => {}); buffer.flush = flush; await f.cleanup(); }
});
