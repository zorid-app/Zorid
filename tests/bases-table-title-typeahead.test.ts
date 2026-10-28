import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableRename } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(property = 'file.name', extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true }), doc = dom.window.document, main = doc.querySelector('main')!;
  const row = { path: 'Original.md', entryId: 'entry', revision: 'saved-r1', values: { [property]: { type: 'string' as const, value: 'Original' }, 'note.text': { type: 'string' as const, value: 'Other' } } };
  const result: BaseQueryResult = { version: 7, view: { type: 'table', name: 'Main' }, rows: [row], groups: [{ key: null, rows: [row] }], properties: [property, 'note.text'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  const writes: BaseTableRename[] = [];
  const table = createBaseTableView(main, { result, openFile() {}, renameFile: async edit => { writes.push(edit); }, ...extra });
  const cell = (name = property) => main.querySelector<HTMLElement>(`[role="gridcell"][data-property="${name}"]`)!;
  const key = (target: Element, key: string, init: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }); target.dispatchEvent(event); return event; };
  return { dom, doc, main, row, result, table, writes, cell, key, input: () => cell().querySelector<HTMLInputElement>('input')!, close() { table.destroy(); dom.window.close(); } };
}

for (const property of ['file.name', 'file.file']) test(`${property} starts a replacement title from a printable key without writing`, () => {
  const f = fixture(property); try {
    f.cell().focus(); const event = f.key(f.cell(), 'N', { shiftKey: true }); assert.equal(event.defaultPrevented, true);
    assert.equal(f.input().value, 'N'); assert.equal(f.input().selectionStart, 1); assert.equal(f.input().selectionEnd, 1); assert.equal(f.doc.activeElement, f.input()); assert.deepEqual(f.writes, []);
    f.key(f.input(), 'Escape'); assert.equal(f.cell().querySelector('input'), null); assert.match(f.cell().textContent!, /Original/); assert.deepEqual(f.writes, []);
  } finally { f.close(); }
});

test('typing after Tab selection replaces the title and Enter commits its saved identity once', async () => {
  let accept!: () => void;
  const writes: BaseTableRename[] = [], f = fixture('file.name', { renameFile: edit => { writes.push(edit); return new Promise<void>(resolve => { accept = resolve; }); } }); try {
    f.cell('note.text').focus(); f.key(f.cell('note.text'), 'Tab', { shiftKey: true }); assert.equal(f.doc.activeElement, f.cell());
    f.key(f.cell(), 'R'); f.input().value = 'Renamed'; f.key(f.input(), 'Enter'); f.key(f.input(), 'Enter');
    assert.deepEqual(writes, [{ version: 7, path: 'Original.md', name: 'Renamed', witness: { entryId: 'entry', revision: 'saved-r1' } }]);
    accept(); await tick(); assert.equal(f.doc.activeElement, f.cell()); assert.equal(f.cell().querySelector('input'), null);
    f.key(f.cell(), 'S'); assert.equal(f.input().value, 'S'); assert.equal(writes.length, 1);
  } finally { f.close(); }
});

test('seeded title saves on blur through the existing rename path and preserves outside focus', async () => {
  const f = fixture(); try {
    f.cell().focus(); f.key(f.cell(), 'Z'); const outside = f.doc.querySelector<HTMLElement>('#outside')!; outside.focus(); await tick();
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].name, 'Z'); assert.equal(f.doc.activeElement, outside);
  } finally { f.close(); }
});

test('native editor key events are left to the active input and are never seeded again', () => {
  const f = fixture(); try {
    f.cell().focus(); f.key(f.cell(), 'A'); const input = f.input(), native = f.key(input, 'b');
    assert.equal(native.defaultPrevented, false); assert.equal(f.input(), input); assert.equal(input.value, 'A'); assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('modifier shortcuts, dead keys and composition never begin a replacement title', () => {
  const f = fixture(); try {
    f.cell().focus();
    for (const [key, init] of [['c', { ctrlKey: true }], ['c', { metaKey: true }], ['e', { altKey: true }], ['a', { isComposing: true }], ['Dead', {}]] as const) {
      f.key(f.cell(), key, init); assert.equal(f.cell().querySelector('input'), null, key);
    }
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('range selection and an active property draft own printable keys before edit admission', () => {
  const f = fixture(); try {
    f.cell().focus(); f.key(f.cell(), 'ArrowRight', { shiftKey: true }); const ranged = f.doc.activeElement!;
    assert.equal(f.key(ranged, 'x').defaultPrevented, true); assert.equal(f.main.querySelector('input'), null); assert.equal(f.main.querySelectorAll('[aria-selected="true"]').length, 2);
    f.key(ranged, 'Escape'); f.cell('note.text').dataset.baseEditing = 'draft'; f.cell().focus(); assert.equal(f.key(f.cell(), 'x').defaultPrevented, true); assert.equal(f.cell().querySelector('input'), null); assert.equal(f.cell('note.text').dataset.baseEditing, 'draft');
  } finally { f.close(); }
});

test('pending admission and absent rename capability cannot start a replacement editor', () => {
  const pending = fixture('file.name', { canBeginPropertyEdit: () => false }); try { pending.cell().focus(); assert.equal(pending.key(pending.cell(), 'x').defaultPrevented, true); assert.equal(pending.input(), null); } finally { pending.close(); }
  const readonly = fixture('file.name', { renameFile: undefined }); try { readonly.cell().focus(); assert.equal(readonly.key(readonly.cell(), 'x').defaultPrevented, false); assert.equal(readonly.input(), null); } finally { readonly.close(); }
});

test('a complete single Unicode character seeds once with its caret at the end', () => {
  const f = fixture(); try { f.cell().focus(); f.key(f.cell(), '📝'); assert.equal(f.input().value, '📝'); assert.equal(f.input().selectionStart, 2); assert.equal(f.input().selectionEnd, 2); } finally { f.close(); }
});

test('Shift Space retains row selection rather than replacing the title', () => {
  const f = fixture(); try { f.cell().focus(); f.key(f.cell(), ' ', { shiftKey: true }); assert.equal(f.input(), null); assert.equal(f.main.querySelectorAll('[aria-selected="true"]').length, 2); } finally { f.close(); }
});
