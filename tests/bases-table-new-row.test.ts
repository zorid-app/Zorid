import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true }), doc = dom.window.document, main = doc.querySelector('main')!;
  const row = { path: 'Existing.md', entryId: 'existing', revision: 'r1', values: { 'file.name': { type: 'string' as const, value: 'Existing' } } };
  const created = { path: 'New page.md', entryId: 'created', revision: 'created-r1', values: { 'file.name': { type: 'string' as const, value: 'New page' } } };
  const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Main' }, rows: [row], groups: [{ key: null, rows: [row] }], properties: ['file.name'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  const view = createBaseTableView(main, { result, openFile() {}, renameFile: async () => {}, ...extra });
  const publish = () => view.update({ ...result, version: 2, rows: [row, created], groups: [{ key: null, rows: [row, created] }] });
  return { dom, doc, main, row, created, result, view, publish, button: () => main.querySelector<HTMLButtonElement>('.zorid-bases-table-new')!, close() { view.destroy(); dom.window.close(); } };
}

test('New page resolves a published saved identity into inline title editing', async () => {
  let anchor: HTMLElement | undefined;
  const f = fixture({ onNew: async button => { anchor = button; f.publish(); return { path: f.created.path, entryId: f.created.entryId }; } }); try {
    f.button().click(); await tick(); assert.equal(anchor, f.button());
    const input = f.main.querySelector<HTMLInputElement>('[data-path="New page.md"] input')!; assert.ok(input); assert.equal(input.value, 'New page'); assert.equal(f.doc.activeElement, input); assert.equal(f.view.hasActiveEdits(), true);
    assert.equal(f.button().disabled, false); assert.equal(f.button().hasAttribute('aria-busy'), false); assert.equal(f.main.querySelector('[role=grid]')!.getAttribute('aria-rowcount'), '4');
  } finally { f.close(); }
});

test('local pending creation suppresses duplicate clicks without blocking query publication', async () => {
  let accept!: () => void, calls = 0;
  const f = fixture({ onNew: async () => { calls++; await new Promise<void>(resolve => { accept = resolve; }); f.publish(); return { path: f.created.path, entryId: f.created.entryId }; } }); try {
    f.button().click(); f.button().dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(calls, 1); assert.equal(f.button().disabled, true); assert.equal(f.view.hasActiveEdits(), false);
    accept(); await tick(); assert.ok(f.main.querySelector('[data-path="New page.md"] input'));
  } finally { f.close(); }
});

test('new-row title admission requires the exact expected identity and a current saved revision', () => {
  const f = fixture(); try {
    assert.equal(f.view.editFileTitle(f.row.path, 'replacement'), false); assert.equal(f.view.editFileTitle('Missing.md', 'existing'), false);
    assert.equal(f.view.editFileTitle(f.row.path, f.row.entryId), true); assert.ok(f.main.querySelector('[data-path="Existing.md"] input'));
  } finally { f.close(); }
});

test('a path-only creation acknowledgement does not edit an unproven row', async () => {
  const f = fixture({ onNew: async () => { f.publish(); return { path: f.created.path }; } }); try {
    f.button().click(); await tick(); assert.equal(f.main.querySelector('input'), null);
  } finally { f.close(); }
});

test('leaving the table while creating prevents delayed inline focus', async () => {
  let accept!: () => void;
  const f = fixture({ onNew: async () => { await new Promise<void>(resolve => { accept = resolve; }); f.publish(); return { path: f.created.path, entryId: f.created.entryId }; } }); try {
    f.button().click(); const outside = f.doc.querySelector<HTMLElement>('#outside')!; outside.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true })); outside.focus(); accept(); await tick();
    assert.equal(f.doc.activeElement, outside); assert.equal(f.main.querySelector('input'), null);
  } finally { f.close(); }
});

test('changing view identity during creation does not edit a matching file in the other view', async () => {
  let accept!: () => void;
  const f = fixture({ onNew: async () => { await new Promise<void>(resolve => { accept = resolve; }); return { path: f.created.path, entryId: f.created.entryId }; } }); try {
    f.button().click(); f.view.update({ ...f.result, version: 2, view: { type: 'table', name: 'Different' }, rows: [f.created], groups: [{ key: null, rows: [f.created] }] }); accept(); await tick(); assert.equal(f.main.querySelector('input'), null);
  } finally { f.close(); }
});

test('creation failure retains a usable New page action and reports the error', async () => {
  const f = fixture({ onNew: async () => { throw new Error('Cannot create row'); } }); try {
    f.button().click(); await tick(); assert.equal(f.button().disabled, false); assert.match(f.main.textContent!, /Cannot create row/); assert.equal(f.main.querySelector('input'), null);
  } finally { f.close(); }
});

test('without a creation capability the New page row is absent', () => {
  const f = fixture(); try { assert.equal(f.main.querySelector('.zorid-bases-table-new-row'), null); assert.equal(f.main.querySelector('[role=grid]')!.getAttribute('aria-rowcount'), '2'); } finally { f.close(); }
});
