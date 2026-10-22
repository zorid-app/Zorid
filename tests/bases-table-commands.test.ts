import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableEdit } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import { parseBaseTableTSV } from '../src/bases/table-clipboard.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true });
  const main = dom.window.document.querySelector('main')!;
  const rows = [0, 1, 2].map(i => ({ path: `${i}.md`, values: { 'file.name': { type: 'string' as const, value: String(i) }, 'note.text': { type: 'string' as const, value: `Text ${i}` }, 'note.score': { type: 'number' as const, value: i } } }));
  const result: BaseQueryResult = { version: 7, view: { type: 'table', name: 'Table', columnSize: { 'note.score': 170 } }, rows, groups: [{ key: null, rows }], properties: ['file.name', 'note.text', 'note.score'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 3, matched: 3, afterGroupOrder: 3, afterSearch: 3, returned: 3 } };
  const batches: readonly BaseTableEdit[][] = []; const writes = batches as BaseTableEdit[][];
  const patches: unknown[] = [];
  const view = createBaseTableView(main, { result, openFile() {}, editProperty: async () => {}, editProperties: async edits => { writes.push([...edits]); }, patchView: async patch => { patches.push(patch); }, ...extra });
  const cell = (row: number, property: string) => main.querySelector<HTMLElement>(`[data-path="${row}.md"][data-property="${property}"]`)!;
  const key = (element: Element, key: string, extra: KeyboardEventInit = {}) => { const e = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); element.dispatchEvent(e); return e; };
  const paste = (element: Element, values: Record<string, string>) => { const e = new dom.window.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'clipboardData', { value: { getData: (type: string) => values[type] ?? '' } }); element.dispatchEvent(e); return e; };
  const menu = (element: Element) => { element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]; };
  return { dom, main, view, result, batches, patches, cell, key, paste, menu, close() { view.destroy(); dom.window.close(); } };
}

test('TSV reads quoted rectangles without destroying tabs, line breaks or final empty cells', () => {
  assert.deepEqual(parseBaseTableTSV('"a\tb"\t"c""d"\r\n"first\nlast"\t'), [['a\tb', 'c"d'], ['first\nlast', '']]);
  assert.deepEqual(parseBaseTableTSV('a\tb\n'), [['a', 'b']]);
  assert.throws(() => parseBaseTableTSV('a\tb\nc'), /rectangular/);
  assert.throws(() => parseBaseTableTSV('"unfinished'), /Unclosed/);
});

test('paste validates complete rectangle before one host batch and leaves file cells read-only', async () => {
  const f = fixture(); f.cell(0, 'file.name').focus();
  f.paste(f.cell(0, 'file.name'), { 'text/plain': 'ignored\tChanged\t12\nignored\tOther\t13' }); await tick();
  assert.deepEqual(f.batches[0], [
    { version: 7, path: '0.md', property: 'note.text', value: { type: 'string', value: 'Changed' } },
    { version: 7, path: '0.md', property: 'note.score', value: { type: 'number', value: 12 } },
    { version: 7, path: '1.md', property: 'note.text', value: { type: 'string', value: 'Other' } },
    { version: 7, path: '1.md', property: 'note.score', value: { type: 'number', value: 13 } },
  ]);
  f.paste(f.cell(0, 'file.name'), { 'text/plain': 'ignored\tGood\t12\nignored\tBad\tinvalid' }); await tick();
  assert.equal(f.batches.length, 1); assert.match(f.main.textContent!, /valid number/); f.close();
});

test('selected rectangle broadcasts a single pasted value and clear skips file properties', async () => {
  const f = fixture(); f.cell(0, 'note.text').focus(); f.key(f.cell(0, 'note.text'), 'ArrowDown', { shiftKey: true });
  f.paste(f.cell(1, 'note.text'), { 'text/plain': 'Same' }); await tick();
  assert.equal(f.batches[0].length, 2); assert.ok(f.batches[0].every(e => e.value.type === 'string' && e.value.value === 'Same'));
  f.key(f.cell(1, 'note.text'), 'a', { metaKey: true }); f.key(f.cell(1, 'note.text'), 'Delete'); await tick();
  assert.equal(f.batches[1].length, 6); assert.ok(f.batches[1].every(e => e.property.startsWith('note.') && e.value.type === 'null')); f.close();
});

test('compatible raw Bases clipboard preserves lists and excludes formula/file source cells', async () => {
  const f = fixture(); f.cell(0, 'note.text').focus();
  f.paste(f.cell(0, 'note.text'), { 'obsidian/bases-cells': JSON.stringify([[{ type: 'note', data: ['One', 'Two'] }, { type: 'formula' }]]) }); await tick();
  assert.deepEqual(f.batches[0], [{ version: 7, path: '0.md', property: 'note.text', value: { type: 'list', value: [{ type: 'string', value: 'One' }, { type: 'string', value: 'Two' }] } }]); f.close();
});

test('pending batch blocks duplicate paste/clear; rejected host batch reports actual failure', async () => {
  let reject!: (error: Error) => void; let calls = 0;
  const f = fixture({ editProperties: async () => { calls++; await new Promise<void>((_, fail) => { reject = fail; }); } });
  f.cell(0, 'note.text').focus(); f.paste(f.cell(0, 'note.text'), { 'text/plain': 'one' });
  assert.equal(f.view.hasActiveEdits(), true); f.paste(f.cell(0, 'note.text'), { 'text/plain': 'two' }); f.key(f.cell(0, 'note.text'), 'Delete');
  assert.equal(calls, 1); reject(new Error('1 of 2 changes saved; retry remaining file.')); await tick();
  assert.equal(f.view.hasActiveEdits(), false); assert.match(f.main.textContent!, /1 of 2 changes saved/); f.close();
});

test('text inputs own paste, undo and composition while table history routes through host', async () => {
  let undo = 0, redo = 0;
  const f = fixture({ undo: () => { undo++; }, redo: () => { redo++; } }); f.cell(0, 'note.text').focus();
  f.key(f.cell(0, 'note.text'), 'z', { metaKey: true }); f.key(f.cell(0, 'note.text'), 'z', { metaKey: true, shiftKey: true }); await tick(); assert.equal(undo, 1); assert.equal(redo, 1);
  f.key(f.cell(0, 'note.text'), 'Enter'); const input = f.cell(0, 'note.text').querySelector('input')!;
  assert.equal(f.paste(input, { 'text/plain': 'native' }).defaultPrevented, false); f.key(input, 'z', { metaKey: true }); await tick(); assert.equal(undo, 1); f.close();
});

test('header click toggles sort; context menu uses reference actions and stale menu actions cannot save', async () => {
  const f = fixture({ requestEditProperty() {}, summaryOptions: [{ id: 'Sum', label: 'Sum' }], requestSummary() {} });
  const header = f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[1]; header.click(); await tick();
  assert.deepEqual(f.patches[0], { sort: [{ property: 'note.text', direction: 'ASC' }] });
  const menu = f.menu(header); assert.deepEqual(menu.map(item => item.textContent), ['Hide column', 'Summarize', 'Group by', 'Sort A to Z', 'Sort Z to A', 'Edit property']);
  f.view.update({ ...f.result, version: 8 }); menu[0].click(); await tick(); assert.equal(f.patches.length, 1); f.close();
});

test('resizer keyboard persists width and double-click resets custom width', async () => {
  const f = fixture(); const resize = f.main.querySelectorAll<HTMLElement>('[role=separator]')[2];
  f.key(resize, 'ArrowRight'); await tick(); assert.deepEqual(f.patches[0], { columnSize: { 'note.score': 180 } });
  resize.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); await tick(); assert.deepEqual(f.patches[1], { columnSize: {} }); f.close();
});

test('summary footer displays host-computed overall values without aggregating visible rows', () => {
  const f = fixture({ getSummary: (property, group) => property === 'note.score' && group === null ? { value: { type: 'number', value: 123456 }, label: 'Sum' } : undefined });
  const footer = f.main.querySelector('.zorid-bases-table-footer')!;
  assert.equal(footer.querySelector('[data-summary-property="note.score"]')!.textContent, '123456'); assert.equal(footer.querySelector('[data-summary-property="note.score"]')!.getAttribute('title'), 'Sum'); f.close();
});

test('rich widget drafts stay mounted across scrolling and every acquired widget disposes once', async () => {
  let mounted = 0, disposed = 0;
  const f = fixture({ renderProperty(element) { mounted++; const button = element.ownerDocument.createElement('button'); button.textContent = 'Edit'; button.addEventListener('click', () => { element.dataset.baseEditing = 'draft'; }); element.append(button); return () => { disposed++; }; } });
  const cell = f.cell(0, 'note.text'); cell.querySelector('button')!.click(); assert.equal(f.view.hasActiveEdits(), true);
  f.view.refreshLayout(); assert.equal(cell.isConnected, true); assert.equal(f.view.hasActiveEdits(), true);
  f.view.destroy(); assert.equal(disposed, mounted); f.dom.window.close();
});
