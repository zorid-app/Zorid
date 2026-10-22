import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
import { mountBaseProperty } from '../src/bases/presentation-common.ts';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function widget(checkbox = false) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), element = dom.window.document.querySelector<HTMLElement>('main')!;
  let ready = true, writes = 0, release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const value = checkbox ? { type: 'boolean' as const, value: false } : { type: 'number' as const, value: 1 };
  const row = { path: 'One.md', values: { 'note.rating': value } };
  const dispose = mountBasePropertyWidget(element, { row, value, property: 'note.rating', version: 1 }, { getDefinition: () => ({ type: checkbox ? 'checkbox' : 'number' }), canBegin: () => ready, commit: async () => { writes++; await pending; } });
  const key = (key: string) => element.querySelector('input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { element, dom, key, release, set ready(value: boolean) { ready = value; }, get writes() { return writes; }, dispose, close() { release(); dispose(); dom.window.close(); } };
}
test('a mounted widget consults live admission for each new numeric edit and retains Escape while blocked', () => {
  const f = widget(); try {
    f.ready = false; f.element.click(); assert.equal(f.element.querySelector('input'), null);
    f.element.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(f.element.querySelector('input'), null);
    f.ready = true; f.element.click(); const input = f.element.querySelector('input')!; input.value = '5'; f.ready = false;
    input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); assert.equal(input.value, '5'); assert.equal(input.disabled, false);
    f.key('Escape'); assert.equal(f.element.querySelector('input'), null); assert.equal(f.writes, 0);
  } finally { f.close(); }
});
test('new checkbox submissions use live admission and restore their displayed saved value', async () => {
  const f = widget(true); try {
    f.ready = false; const checkbox = f.element.querySelector('input')!; checkbox.click(); await tick(); assert.equal(f.writes, 0); assert.equal(checkbox.checked, false);
    checkbox.checked = true; checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); await tick(); assert.equal(f.writes, 0); assert.equal(checkbox.checked, false);
    f.ready = true; checkbox.click(); assert.equal(f.writes, 1); f.ready = false; f.release(); await tick(); assert.equal(f.element.querySelector<HTMLInputElement>('input')!.checked, true);
  } finally { f.close(); }
});
test('a started draft and accepted pending write survive admission closing without losing its value', async () => {
  const f = widget(); try {
    f.element.click(); const input = f.element.querySelector('input')!; input.value = '5'; f.ready = false;
    f.key('Enter'); assert.equal(f.writes, 1); assert.equal(input.value, '5'); assert.equal(input.disabled, true);
    f.release(); await tick(); assert.equal(f.element.textContent, '5'); assert.equal(f.element.hasAttribute('data-base-editing'), false);
    f.dispose(); f.element.click(); assert.equal(f.writes, 1); assert.equal(f.element.dataset.basePropertyEditable, undefined);
  } finally { f.close(); }
});
test('table gates new primitive/rich edits, paste and clear while header resizing remains independent', async () => {
  for (const rich of [false, true]) {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
    const row = { path: 'One.md', values: { 'note.rating': { type: 'number' as const, value: 1 } } };
    const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Table' }, rows: [row], groups: [{ key: null, rows: [row] }], properties: ['note.rating'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
    let ready = false, writes = 0, patches = 0;
    const view = createBaseTableView(host, { result, openFile() {}, canBeginPropertyEdit: () => ready, editProperty: async () => { writes++; }, editProperties: async () => { writes++; }, patchView: async () => { patches++; }, ...(rich ? { renderProperty(element: HTMLElement) { const begin = () => element.append(dom.window.document.createElement('input')); element.addEventListener('click', begin); element.addEventListener('dblclick', begin); return () => { element.removeEventListener('click', begin); element.removeEventListener('dblclick', begin); }; } } : {}) });
    try {
      const cell = host.querySelector<HTMLElement>('[role=gridcell]')!; cell.focus(); cell.click(); cell.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      cell.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); assert.equal(cell.querySelector('input'), null);
      const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '5' } }); cell.dispatchEvent(paste);
      cell.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); await tick(); assert.equal(writes, 0);
      host.querySelector('[role=separator]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick(); assert.equal(patches, 1, 'the property admission gate must not strand accepted resize intents');
      ready = true;
    } finally { view.destroy(); dom.window.close(); }
  }
});

test('primitive Cards and List fallback gates new drafts without blocking an already accepted draft', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), element = dom.window.document.querySelector<HTMLElement>('main')!;
  const row = { path: 'One.md', values: { 'note.rating': { type: 'number' as const, value: 1 } } };
  const result: BaseQueryResult = { version: 1, view: { type: 'list', name: 'List' }, rows: [row], groups: [{ key: null, rows: [row] }], properties: ['note.rating'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  let ready = false, writes = 0;
  const dispose = mountBaseProperty(element, row, 'note.rating', result, { result, openFile() {}, canBeginPropertyEdit: () => ready, editProperty: async edit => { writes++; assert.deepEqual(edit.value, { type: 'number', value: 5 }); } }, () => true);
  try {
    element.click(); element.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); assert.equal(element.querySelector('input'), null);
    ready = true; element.click(); const input = element.querySelector('input')!; assert.ok(input); input.value = '5'; ready = false;
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick(); assert.equal(writes, 1); assert.equal(element.textContent, '5');
    element.click(); assert.equal(element.querySelector('input'), null);
  } finally { dispose(); dom.window.close(); }
});

test('a retained failed checkbox can retry its own draft while new admission is closed by that draft', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), element = dom.window.document.querySelector<HTMLElement>('main')!;
  const row = { path: 'One.md', values: { 'note.done': { type: 'boolean' as const, value: false } } }; let writes = 0;
  const dispose = mountBasePropertyWidget(element, { row, property: 'note.done', value: row.values['note.done'], version: 1 }, {
    getDefinition: () => ({ type: 'checkbox' }), canBegin: () => !element.hasAttribute('data-base-editing'),
    commit: async edit => { writes++; assert.deepEqual(edit.value, { type: 'boolean', value: true }); if (writes === 1) throw new Error('fixture first write failed'); },
  });
  try {
    element.querySelector<HTMLInputElement>('input')!.click(); await tick();
    assert.equal(writes, 1); assert.equal(element.dataset.baseEditing, 'draft'); assert.equal(element.querySelector<HTMLInputElement>('input')!.checked, false); assert.equal(element.querySelector<HTMLInputElement>('input')!.disabled, false);
    element.querySelector<HTMLInputElement>('input')!.click(); await tick(); assert.equal(writes, 2); assert.equal(element.querySelector<HTMLInputElement>('input')!.checked, true); assert.equal(element.hasAttribute('data-base-editing'), false);
  } finally { dispose(); dom.window.close(); }
});
