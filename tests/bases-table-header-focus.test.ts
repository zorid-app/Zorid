import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import type { BaseViewPatch } from '../src/bases/document.ts';

function fixture(extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<body><button id="outside">Outside</button><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, main = doc.querySelector('main')!;
  const rows = [{ path: 'One.md', values: { 'note.rating': { type: 'number' as const, value: 10 }, 'note.other': { type: 'string' as const, value: 'other' } } }];
  const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Library', columnSize: { 'note.rating': 170 } }, rows, groups: [{ key: null, rows }], properties: ['note.rating', 'note.other'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  const patches: BaseViewPatch[] = [];
  const table = createBaseTableView(main, { result, openFile() {}, patchView: async patch => { patches.push(patch); }, ...extra });
  const header = (property = 'note.rating') => [...main.querySelectorAll<HTMLElement>('[role="columnheader"]')].find(cell => cell.dataset.property === property)!;
  const separator = (property = 'note.rating') => header(property).querySelector<HTMLElement>('[role="separator"]')!;
  const key = (key: string) => doc.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { dom, doc, main, result, table, patches, header, separator, key, close() { table.destroy(); dom.window.close(); } };
}

test('same-view summary acknowledgement retains separator focus and subsequent keyboard resize', async () => {
  const f = fixture(); const old = f.separator(); old.focus();
  f.table.update({ ...f.result, version: 2, view: { ...f.result.view, summaries: { 'note.rating': 'Sum' } }, summaries: { 'note.rating': { type: 'number', value: 10 } } });
  assert.equal(old.isConnected, false); assert.equal(f.doc.activeElement, f.separator());
  f.key('ArrowRight'); await Promise.resolve(); assert.deepEqual(f.patches, [{ columnSize: { 'note.rating': 180 } }]); f.close();
});

test('same-view query refresh preserves the property header through column reordering', async () => {
  const f = fixture(); f.header().focus();
  f.table.update({ ...f.result, version: 2, properties: ['note.other', 'note.rating'] });
  assert.equal(f.doc.activeElement, f.header()); f.key('Enter'); await Promise.resolve();
  assert.deepEqual(f.patches, [], 'opening the column menu does not change ordering');
  const sort = [...f.doc.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(item=>item.textContent==='Sort A → Z')!;
  assert.ok(sort); sort.click(); await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(f.patches, [{ sort: [{ property: 'note.rating', direction: 'ASC' }] }]); f.close();
});

test('refresh never steals focus after the user leaves the table header', () => {
  const f = fixture(); f.separator().focus(); const outside = f.doc.querySelector<HTMLElement>('#outside')!; outside.focus();
  f.table.update({ ...f.result, version: 2 }); assert.equal(f.doc.activeElement, outside); f.close();
});

test('host callbacks moving focus during refresh prevent header restoration', () => {
  let outside: HTMLElement | undefined;
  const f = fixture({ getPropertyLabel(property) { outside?.focus(); return property; } }); outside = f.doc.querySelector<HTMLElement>('#outside')!; f.separator().focus();
  f.table.update({ ...f.result, version: 2 }); assert.equal(f.doc.activeElement, outside); f.close();
});

test('a removed property does not retarget header focus to the replacement column', () => {
  const f = fixture(); f.separator().focus();
  f.table.update({ ...f.result, version: 2, properties: ['note.other'] });
  assert.equal(f.doc.activeElement, f.doc.body); f.key('ArrowRight'); assert.deepEqual(f.patches, []); f.close();
});

test('a changed view identity does not transfer separator focus to the same named property', () => {
  const f = fixture(); f.separator().focus();
  f.table.update({ ...f.result, version: 2, view: { ...f.result.view, name: 'Different view' } });
  assert.equal(f.doc.activeElement, f.doc.body); f.key('ArrowRight'); assert.deepEqual(f.patches, []); f.close();
});

test('destroyed tables cannot restore retained header focus', () => {
  const f = fixture(); f.separator().focus(); f.table.destroy();
  f.table.update({ ...f.result, version: 2 }); assert.equal(f.doc.activeElement, f.doc.body); assert.deepEqual(f.patches, []); f.dom.window.close();
});
