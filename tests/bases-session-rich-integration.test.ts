import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { DocumentBaseResult, DocumentService, DocumentBaseValue } from '../src/core/document-semantics.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { baseEditablePropertyValue, baseImageSourceValue } from '../src/bases/view-actions.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 8));
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await tick(); } assert.ok(await check()); }
class Adapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  revisions = new Map<string, number>();
  identify<T extends { path: string }>(row: T) { return { ...row, entryId: row.path, revision: `r${this.revisions.get(row.path) ?? 1}` }; }
  override async list() { return (await super.list()).map(row => this.identify(row)); }
  override async stat(path: string) { const row = await super.stat(path); return row && this.identify(row); }
  override async write(path: string, text: string) { await super.write(path, text); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1); }
}
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } }, source = { localStoreId: 'store', watermark: '1' };
const summaryBase = 'views:\n  - type: table\n    name: Table\n    order: [file.name, score, projects]\n    summaries: {score: Sum}\n  - type: cards\n    name: Cards\n    summaries: {score: Sum}\n';
async function fixture(base = summaryBase, omitRaw = false) {
  const adapter = new Adapter({ 'Work.base': base, 'One.md': '---\nscore: 10\nprojects: ["[[Projects/A|My alias]]", "[[Unknown|Keep me]]"]\n---\nBody', 'Properties.yaml': 'properties:\n  projects:\n    type: relation\n    relation: {multiple: true}\n' });
  const definition = async () => { const row = (await adapter.stat('Work.base'))!; return { id: row.entryId, revision: row.revision, path: row.path, kind: 'file' as const, deleted: false }; };
  const unused = async (): Promise<never> => { throw new Error('Unexpected core operation'); };
  // A transport fixture, not a TS evaluator: the core owns summary values and
  // rich presentation; only saved view selection and raw YAML are echoed here.
  adapter.documentSemantics = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => ({ pinId: 'pin' as never, source, snapshot, coverageComplete: true, close: async () => {}, search: unused, backlinks: unused,
      metadata: async id => { const row = (await adapter.stat(id))!; return { source, snapshot, coverageComplete: true, value: { entry: { id: row.entryId, revision: row.revision, path: row.path, kind: 'file' as const, deleted: false }, metadata: null, exclusion: null } }; },
      base: async input => {
        const doc = BaseDocument.parse(await adapter.read('Work.base')), view = doc.views[input.options?.viewIndex ?? 0];
        const text = await adapter.read('One.md'), raw = parse(text.match(/^---\n([\s\S]*?)\n---/)![1]) as { score: number; projects: string[] };
        const identity = (await adapter.stat('One.md'))!;
        const projects: DocumentBaseValue = { type: 'list', value: raw.projects.map(() => ({ type: 'link', path: 'Projects/A', display: 'Rendered label', external: false })) };
        const selections = (view.summaries ?? {}) as Record<string, string>;
        const result: DocumentBaseResult = { snapshotId: snapshot, view, rows: [{ entryId: identity.entryId, revision: identity.revision, path: 'One.md', values: { 'file.name': { type: 'string', value: 'One' }, 'note.score': { type: 'number', value: 10 }, 'note.projects': projects }, ...(!omitRaw ? { editValues: { 'note.projects': { type: 'list', value: raw.projects.map(value => ({ type: 'string' as const, value })) } } } : {}) }],
          groups: [{ key: null, keyId: null, entryIds: ['One.md'] }], groupOptions: [], properties: ['file.name', 'note.score', 'note.projects'], availableProperties: ['file.name', 'note.score', 'note.projects'], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1,
          summaries: Object.fromEntries(Object.keys(selections).map(key => [`note.${key.replace(/^note\./, '')}`, { type: 'number' as const, value: 10 }])), summaryPreviews: { Sum: { type: 'number', value: 10 }, Empty: { type: 'number', value: 0 } },
        };
        return { source, snapshot, coverageComplete: true, value: { definition: await definition(), result } };
      },
    }),
  };
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!, buffers = new Map<string, NoteBuffer>(), errors: unknown[] = [], opened: {path:string;witness?:{entryId:string;revision:string}}[] = [];
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile(path,_event,witness) {opened.push({path,witness});}, onError(error) { errors.push(error); }, getRelationTargets: () => [{ path: 'Projects/B.md', label: 'B', value: '[[Projects/B]]', entryId: 'b', revision: 'r1' }, { path: 'Projects/C.md', label: 'C', value: '[[Projects/C]]', entryId: 'c', revision: 'r1' }],
    buffers: { validate() {}, async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path); Object.defineProperty(buffer, 'savedDurableWitness', { get: () => ({ path, entryId: path, revision: `r${adapter.revisions.get(path) ?? 1}` }) }); buffers.set(path, buffer); } await buffer.load(); return buffer; } },
  }); await session.ready; assert.ifError(session.state.error);
  const key = (element: Element, key: string, extra = {}) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  return { vault, dom, host, session, errors, opened, key, async cleanup() { for (const input of dom.window.document.querySelectorAll('.bases-property-popover input,[data-base-editing] input')) key(input, 'Escape'); const back = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]'); back?.click(); await until(() => !session.hasPendingChanges()); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); } };
}

test('raw editing adapter accepts inert values and rejects rich values without saved source', () => {
  const link = { type: 'namespace', name: 'Rendered' } as BaseExpressionValue;
  assert.equal(baseEditablePropertyValue({ path: 'One.md', values: { 'note.x': link } }, 'note.x'), undefined);
  const raw = { type: 'string', value: '[[Target|Alias]]' } as const;
  assert.equal(baseEditablePropertyValue({ path: 'One.md', values: { 'note.x': link }, editValues: { 'note.x': raw } }, 'note.x'), raw);
  assert.deepEqual(baseEditablePropertyValue({ path: 'One.md', values: {} }, 'note.missing'), { type: 'null' });
});

test('session relation chips retain raw aliases through repeated own acknowledged writes', async () => {
  const f = await fixture();
  try {
    const cell = f.host.querySelector<HTMLElement>('[data-property="note.projects"][role="gridcell"]')!; f.key(cell, 'Enter');
    for (const label of ['B', 'C']) {
      const input = f.dom.window.document.querySelector<HTMLInputElement>('.bases-property-popover input')!; assert.ok(input);
      input.value = label; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(input, 'Enter');
      await until(async () => (await f.vault.read('One.md')).includes(`[[Projects/${label}]]`)); await tick();
      assert.ok(f.dom.window.document.querySelector('.bases-property-popover input'), 'own acknowledged refresh keeps the chip editor alive');
    }
    const saved = parse((await f.vault.read('One.md')).match(/^---\n([\s\S]*?)\n---/)![1]);
    assert.deepEqual(saved.projects, ['[[Projects/A|My alias]]', '[[Unknown|Keep me]]', '[[Projects/B]]', '[[Projects/C]]']); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('session refuses editing formatted relation values when persisted source is unavailable', async () => {
  const f = await fixture(summaryBase, true);
  try {
    const cell = f.host.querySelector<HTMLElement>('[data-property="note.projects"][role="gridcell"]')!; f.key(cell, 'Enter');
    assert.ok(cell.matches('[data-base-edit-unavailable]') || cell.querySelector('[data-base-edit-unavailable]')); assert.equal(f.dom.window.document.querySelector('.bases-property-popover'), null);
    assert.match(await f.vault.read('One.md'), /My alias/);
  } finally { await f.cleanup(); }
});

test('summary editor seeds builtins, saves rename/expression live, and deletes selections in every view', async () => {
  const f = await fixture();
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.score"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Edit Sum"]'));
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]') || f.errors.length > 0); assert.deepEqual(f.errors, []);
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries'), { Sum: 'values.sum().round(2)' });
    const name = f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="Summary name"]')!;
    name.value = 'Revenue'; name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(name, 'Enter');
    await until(async () => Object.hasOwn((BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries') ?? {}) as object, 'Revenue'));
    assert.ok(BaseDocument.parse(await f.vault.read('Work.base')).views.every(view => (view.summaries as Record<string, string>).score === 'Revenue'));
    const expression = f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!;
    expression.focus(); expression.value = 'values.length'; expression.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    await until(async () => (BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries') as Record<string, string>).Revenue === 'values.length');
    assert.equal(f.dom.window.document.querySelector('.bases-summary-editor button[type="submit"]'), null);
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Summary actions"]')!.click();
    [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Delete summary')!.click();
    await until(() => !f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const saved = BaseDocument.parse(await f.vault.read('Work.base')); assert.deepEqual(saved.getRoot('summaries'), {}); assert.ok(saved.views.every(view => !Object.values(view.summaries ?? {}).includes('Revenue'))); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('view keyboard shortcuts wrap and preserve active property drafts', async () => {
  const f = await fixture();
  try {
    const root = f.host.querySelector('.bases-session')!;
    f.key(root, 'PageUp', { ctrlKey: true, shiftKey: true }); await until(() => f.session.state.result?.view.name === 'Cards');
    f.key(root, 'PageDown', { ctrlKey: true, shiftKey: true }); await until(() => f.session.state.result?.view.name === 'Table');
    f.key(root, 'PageUp', { ctrlKey: true, shiftKey: true, isComposing: true }); await tick(); assert.equal(f.session.state.result?.view.name, 'Table');
    const cell = f.host.querySelector<HTMLElement>('[data-property="note.score"][role="gridcell"]')!; f.key(cell, 'Enter');
    const input = cell.querySelector<HTMLInputElement>('input')!; input.value = '21';
    f.key(input, 'PageDown', { ctrlKey: true, shiftKey: true }); await tick();
    assert.equal(f.session.state.result?.view.name, 'Table'); assert.equal(input.value, '21'); assert.match(String(f.errors.at(-1)), /Finish or cancel/); f.key(input, 'Escape');
  } finally { await f.cleanup(); }
});

test('Add summary selects a unique empty draft, saves on name blur, and Escape returns to its chooser', async () => {
  const f = await fixture(`summaries: {new summary: values.length}\n${summaryBase}`);
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.score"]')!.click(); await until(() => !!f.dom.window.document.querySelector('.zorid-bases-summary-add'));
    [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('.zorid-bases-summary-add')].find(button => button.textContent === 'Add summary')!.click();
    await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const configured = BaseDocument.parse(await f.vault.read('Work.base'));
    assert.deepEqual(configured.views[0].summaries, { 'note.score': 'new summary 2' });
    assert.deepEqual(configured.getRoot('summaries'), { 'new summary': 'values.length' }, 'untouched new draft has no root expression yet');
    const name = f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="Summary name"]')!;
    assert.equal(name.value, 'new summary 2'); name.value = 'Discarded'; name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(name, 'Escape'); await tick();
    assert.equal(name.value, 'new summary 2'); assert.equal(f.dom.window.document.querySelector('[aria-label="Summary name"]'), name);
    f.key(f.dom.window.document.querySelector('[aria-label="Summary expression"]')!, 'Escape');
    await until(() => !!f.dom.window.document.querySelector('[aria-label="Summarize"]'));
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries'), { 'new summary': 'values.length' }); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('a summary draft rejects an intervening configuration change and can discard its retained edits', async () => {
  const f = await fixture();
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.score"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Edit Sum"]'));
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const expression = f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!; expression.focus(); expression.value = 'values.length'; expression.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    const external = BaseDocument.parse(await f.vault.read('Work.base')); external.updateRoot({ externalSetting: 'kept' }); await f.vault.modify('Work.base', external.toString()); await f.session.refresh();
    await until(() => !!f.dom.window.document.querySelector('.bases-summary-editor [role="alert"]')?.textContent);
    assert.match(f.dom.window.document.querySelector('.bases-summary-editor [role="alert"]')!.textContent!, /Base changed/); assert.equal(expression.value, 'values.length');
    assert.equal((BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries') as Record<string, string>).Sum, 'values.sum().round(2)');
    [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button => button.textContent === 'Cancel changes')!.click(); await until(() => !f.dom.window.document.querySelector('[aria-label="Summary expression"]'));
    assert.equal(BaseDocument.parse(await f.vault.read('Work.base')).getRoot('externalSetting'), 'kept');
  } finally { await f.cleanup(); }
});


test('file title opening forwards its captured row identity and image acquisition preserves target namespaces', async () => {
  const f = await fixture();
  try {
    const title = f.host.querySelector<HTMLElement>('[data-property="file.name"][role="gridcell"] a')!; assert.ok(title); title.click();
    assert.deepEqual(f.opened, [{path:'One.md',witness:{entryId:'One.md',revision:'r1'}}]);
    const image = {type:'namespace',name:'image',presentation:{kind:'image',value:'Cover.png',target:{entryId:'cover',revision:'r4'}},get(){return {type:'null'};}} as BaseExpressionValue;
    assert.equal(baseImageSourceValue({type:'list',value:[{type:'string',value:'Other.png'},image]},'Cover.png'),image);
    assert.deepEqual(baseImageSourceValue(image,'Different.png'),{type:'string',value:'Different.png'});
  } finally {await f.cleanup();}
});
