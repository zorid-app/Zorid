import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import type { BaseViewPatch } from '../src/bases/document.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(view: BaseQueryResult['view'] = { type: 'table', name: 'Main' }, longText = false) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document, main = doc.querySelector('main')!;
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains('zorid-bases-table-measure') ? { ...originalRect.call(this), width: (this.textContent?.length ?? 0) * 8 } : originalRect.call(this); };
  const rows = longText ? [{ path: 'Long.md', values: { 'file.name': { type: 'string' as const, value: 'Long' }, 'note.status': { type: 'string' as const, value: 'x'.repeat(100) } } }] : [];
  const result: BaseQueryResult = { version: 1, view, rows, groups: [{ key: null, rows }], properties: ['file.name', 'note.status'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: rows.length, matched: rows.length, afterGroupOrder: rows.length, afterSearch: rows.length, returned: rows.length } };
  const patches: BaseViewPatch[] = [], table = createBaseTableView(main, { result, openFile() {}, getPropertyLabel: property => property === 'file.name' ? 'Name' : 'Status', patchView: async patch => { patches.push(patch); } });
  const widths = () => main.querySelector<HTMLElement>('.zorid-bases-table-header')!.style.gridTemplateColumns.split(' ').map(value => Number.parseFloat(value));
  return { dom, doc, main, result, table, patches, widths, close() { table.destroy(); dom.window.close(); } };
}

test('empty tables reserve a readable Name column and useful property width', () => {
  const f = fixture(); try {
    const [name, status] = f.widths(); assert.ok(name >= 260, 'Name must not shrink to its short header text'); assert.ok(status >= 180, 'an empty property needs space for future values');
    assert.equal(f.main.querySelector('[data-property="file.name"] .zorid-bases-table-title-type')!.getAttribute('aria-hidden'), 'true');
  } finally { f.close(); }
});

test('saved positive widths remain authoritative even below the new defaults', () => {
  const f = fixture({ type: 'table', name: 'Narrow saved', columnSize: { 'file.name': 40, 'note.status': 90 } }); try { assert.deepEqual(f.widths(), [40, 90]); } finally { f.close(); }
});

test('content can enlarge an automatic column while retaining its existing maximum', () => {
  const f = fixture(undefined, true); try { assert.equal(f.widths()[1], 300); } finally { f.close(); }
});

test('reset sizing still clears only the saved column and returns to readable automatic sizing', async () => {
  const f = fixture({ type: 'table', name: 'Saved widths', columnSize: { 'file.name': 80, 'note.status': 90 } }); try {
    f.main.querySelector('[data-property="file.name"] [role="separator"]')!.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); await tick();
    assert.deepEqual(f.patches, [{ columnSize: { 'note.status': 90 } }]);
    f.table.update({ ...f.result, version: 2, view: { ...f.result.view, columnSize: { 'note.status': 90 } } }); assert.ok(f.widths()[0] >= 260); assert.equal(f.widths()[1], 90);
  } finally { f.close(); }
});
