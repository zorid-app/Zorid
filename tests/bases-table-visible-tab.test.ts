import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableView } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra: Partial<BaseTableOptions> = {}, rich = false) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const doc = dom.window.document, main = doc.querySelector('main')!;
  const rows = ['A', 'B', 'C'].map(name => ({ path: `${name}.md`, entryId: name, revision: 'r1',
    values: { 'file.name': { type: 'string' as const, value: name }, 'note.text': { type: 'string' as const, value: `${name} text` } } }));
  const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Grouped' }, rows,
    groups: rows.map(row => ({ key: { type: 'string' as const, value: row.entryId }, rows: [row] })),
    properties: ['file.name', 'note.text'], availableProperties: [], groupOptions: [], diagnostics: [],
    counts: { scanned: 3, matched: 3, afterGroupOrder: 3, afterSearch: 3, returned: 3 } };
  let accept!: () => void, pending = false, writes = 0;
  let view!: BaseTableView;
  view = createBaseTableView(main, { result, openFile() {},
    // Summaries and headings are visible items, but never Tab destinations.
    getSummary: () => ({ value: { type: 'number', value: 1 } }),
    ...(rich ? { editProperty: async () => {}, canBeginPropertyEdit: () => !pending,
      renderProperty(element, presentation) {
        return mountBasePropertyWidget(element, presentation, {
          getDefinition: () => ({ type: 'text' }), canBegin: () => !pending,
          commit(edit) {
            writes++; pending = true;
            return new Promise<void>(resolve => { accept = resolve; })
              .then(() => ({ version: 2, row: edit.row, value: edit.value }))
              .finally(() => { pending = false; });
          },
          onEditorComplete: (element, presentation, intent) => view.completePropertyEdit(element, presentation, intent),
        });
      },
    } : {}), ...extra });
  const cell = (group: number, property = 'file.name') => main.querySelector<HTMLElement>(`[role="gridcell"][data-group="${group}"][data-property="${property}"]`)!;
  const key = (target: Element, key: string, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event;
  };
  const collapse = (group: number) => main.querySelector<HTMLButtonElement>(`[data-group-button="${group}"]`)!.click();
  const copied = (target: Element) => {
    let text: string | undefined;
    const event = new dom.window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData(type: string, value: string) { if (type === 'text/plain') text = value; } } });
    target.dispatchEvent(event); return text;
  };
  return { dom, doc, main, view, cell, key, collapse, copied, get writes() { return writes; }, accept: () => accept(),
    close() { view.destroy(); dom.window.close(); } };
}

test('Tab and Shift+Tab wrap through visible group rows, skipping collapsed rows and summaries', () => {
  const f = fixture(); try {
    f.collapse(1); f.cell(0, 'note.text').focus();
    f.key(f.doc.activeElement!, 'Tab');
    assert.equal(f.doc.activeElement, f.cell(2));
    assert.equal(f.copied(f.doc.activeElement!), 'C');
    f.key(f.doc.activeElement!, 'Tab');
    assert.equal(f.doc.activeElement, f.cell(2, 'note.text'));
    f.key(f.doc.activeElement!, 'Tab', true);
    assert.equal(f.doc.activeElement, f.cell(2));
    f.key(f.doc.activeElement!, 'Tab', true);
    assert.equal(f.doc.activeElement, f.cell(0, 'note.text'));
    assert.equal(f.copied(f.doc.activeElement!), 'A text');
    assert.equal(f.main.querySelectorAll('[role="gridcell"][data-path][tabindex="0"]').length, 1);
    assert.equal(f.main.querySelectorAll('[data-base-editing]').length, 0);
  } finally { f.close(); }
});

test('leading and trailing collapsed groups do not absorb Tab boundary selection', () => {
  const f = fixture(); try {
    f.collapse(0); f.collapse(2); f.cell(1).focus();
    f.key(f.doc.activeElement!, 'Tab', true);
    assert.equal(f.doc.activeElement, f.cell(1));
    assert.equal(f.copied(f.doc.activeElement!), 'B');
    f.key(f.doc.activeElement!, 'Tab');
    assert.equal(f.doc.activeElement, f.cell(1, 'note.text'));
    f.key(f.doc.activeElement!, 'Tab');
    assert.equal(f.doc.activeElement, f.cell(1, 'note.text'));
    assert.equal(f.copied(f.doc.activeElement!), 'B text');
    assert.equal(f.main.querySelectorAll('[role="gridcell"][data-path][tabindex="0"]').length, 1);
  } finally { f.close(); }
});

test('accepted property Tab handoff skips a collapsed group without entering the next title editor', async () => {
  const f = fixture({}, true); try {
    f.collapse(1); f.cell(0, 'note.text').click();
    const input = f.cell(0, 'note.text').querySelector<HTMLInputElement>('input')!;
    input.value = 'Accepted'; f.key(input, 'Tab');
    assert.equal(f.writes, 1); assert.equal(input.disabled, true);
    f.accept(); await tick();
    assert.equal(f.doc.activeElement, f.cell(2));
    assert.equal(f.main.querySelectorAll('[data-base-editing]').length, 0);
    assert.equal(f.cell(2).querySelector('input'), null);
  } finally { f.close(); }
});

test('accepted title Shift+Tab handoff skips a collapsed group and retains the destination selection', async () => {
  let accept!: () => void, writes = 0;
  const f = fixture({ renameFile: () => { writes++; return new Promise<void>(resolve => { accept = resolve; }); } }); try {
    f.collapse(1); f.cell(2).click();
    const input = f.cell(2).querySelector<HTMLInputElement>('input')!;
    input.value = 'Renamed'; f.key(input, 'Tab', true);
    assert.equal(writes, 1); accept(); await tick();
    assert.equal(f.doc.activeElement, f.cell(0, 'note.text'));
    assert.equal(f.copied(f.doc.activeElement!), 'A text');
    assert.equal(f.main.querySelectorAll('[data-base-editing]').length, 0);
  } finally { f.close(); }
});
