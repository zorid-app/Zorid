import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
import type { BasePropertyWidgetEdit } from '../src/bases/property-widgets.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

function setup() {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const values = { 'note.score': { type: 'number' as const, value: 9 }, 'note.label': { type: 'string' as const, value: 'Original' } };
  const row = { path: 'A.md', values };
  const result: BaseQueryResult = { version: 3, view: { type: 'table', name: 'Main' }, rows: [row], groups: [{ key: null, rows: [row] }], groupOptions: [], properties: Object.keys(values), availableProperties: Object.keys(values), counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [] };
  const writes: BasePropertyWidgetEdit[] = [];
  const view = createBaseTableView(document.querySelector('main')!, { result, openFile() {}, editProperty: async () => { throw new Error('The rich widget owns this edit'); },
    renderProperty: (element, presentation) => mountBasePropertyWidget(element, presentation, {
      getDefinition: key => ({ type: key === 'note.score' ? 'number' : 'text' }),
      commit: edit => { writes.push(edit); },
    }),
  });
  return { dom, document, writes, view, cell: (property: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-property="${property}"]`)!, close() { view.destroy(); dom.window.close(); } };
}

for (const property of ['note.score', 'note.label']) test(`a single click keeps the rich ${property} input focused so Escape cancels its draft`, () => {
  const { dom, document, writes, view, cell: findCell, close } = setup();
  try {
    const cell = findCell(property);
    cell.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
    cell.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    const input = cell.querySelector<HTMLInputElement>('input')!;
    assert.ok(input);
    assert.equal(document.activeElement, input, 'the table must not steal focus after the widget accepts the click');
    input.value = 'Unaccepted draft';
    document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(cell.querySelector('input'), null);
    assert.equal(cell.hasAttribute('data-base-editing'), false);
    assert.equal(cell.textContent, property === 'note.score' ? '9' : 'Original');
    assert.equal(document.activeElement, cell, 'cancellation restores grid navigation');
    assert.equal(view.hasActiveEdits(), false);
    assert.deepEqual(writes, []);
  } finally { close(); }
});

test('a captured Shift-click still selects rich cells without opening their widgets', () => {
  const { dom, document, writes, view, cell, close } = setup();
  try {
    cell('note.score').focus();
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true });
    cell('note.label').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'the range capture owns the activation');
    assert.equal(document.querySelectorAll('[role="gridcell"][aria-selected="true"]').length, 2);
    assert.equal(document.querySelector('input'), null);
    assert.equal(document.activeElement, cell('note.score'));
    assert.equal(view.hasActiveEdits(), false);
    assert.deepEqual(writes, []);
  } finally { close(); }
});
