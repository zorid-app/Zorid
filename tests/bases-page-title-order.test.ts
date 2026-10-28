import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { baseExpressionValue as value } from '../src/bases/expression.ts';
import { basePresentationProperties } from '../src/bases/presentation-common.ts';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import { createBaseListView } from '../src/bases/list-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const configuredOrder = Object.freeze(['note.Notes', 'file.name']);
function result(type: 'kanban' | 'list', properties: readonly string[] = configuredOrder): BaseQueryResult {
  const row = { path: 'Acceptance record.md', entryId: 'page-id', revision: 'page-revision', values: { 'note.Notes': value('Pasted'), 'file.name': value('Acceptance record') } };
  return { version: 1, view: { name: 'Pages', type, ...(type === 'kanban' ? { groupBy: { property: 'note.Status', direction: 'ASC' as const } } : {}) },
    rows: [row], groups: [{ key: type === 'kanban' ? value('Done') : null, rows: [row] }], groupOptions: [], properties, availableProperties: configuredOrder,
    counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [] };
}

test('preferred page property changes only presentation order and never adds a hidden title', () => {
  assert.deepEqual(basePresentationProperties(configuredOrder, 'file.name'), ['file.name', 'note.Notes']);
  assert.deepEqual(configuredOrder, ['note.Notes', 'file.name']);
  assert.equal(basePresentationProperties(configuredOrder), configuredOrder);
  const hidden = Object.freeze(['note.Notes']);
  assert.equal(basePresentationProperties(hidden, 'file.name'), hidden);
});

for (const type of ['kanban', 'list'] as const) {
  test(`${type} keeps collection Name primary after reorder, retaining other properties and file identity`, () => {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
    const snapshot = result(type), opened: unknown[] = [];
    const options = { result: snapshot, pageTitleProperty: 'file.name', openFile: (path: string, _event: MouseEvent | KeyboardEvent, witness: unknown) => { opened.push({ path, witness }); } };
    const handle = type === 'kanban' ? createBaseKanbanView(host, options) : createBaseListView(host, options);
    const primary = host.querySelector(type === 'kanban' ? '.bases-kanban-card-property.mod-title .bases-kanban-card-line' : '.bases-list-property.is-title .bases-list-property-value')!;
    assert.equal(primary.textContent, 'Acceptance record');
    assert.match(host.textContent!, /Pasted/);
    assert.deepEqual(snapshot.properties, ['note.Notes', 'file.name']);
    assert.equal(snapshot.properties, configuredOrder);
    const item = host.querySelector<HTMLElement>(type === 'kanban' ? '.bases-kanban-card' : '.bases-list-item')!;
    item.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    if (type === 'kanban') {
      item.focus(); item.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    assert.deepEqual(opened.at(-1), { path: 'Acceptance record.md', witness: { entryId: 'page-id', revision: 'page-revision' } });
    handle.destroy(); dom.window.close();
  });

  test(`${type} legacy first-property semantics and hidden Name remain unchanged`, () => {
    const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main')!;
    const snapshot = result(type);
    const create = type === 'kanban' ? createBaseKanbanView : createBaseListView;
    const legacy = create(host, { result: snapshot, openFile() {} });
    const titleSelector = type === 'kanban' ? '.bases-kanban-card-property.mod-title .bases-kanban-card-line' : '.bases-list-property.is-title .bases-list-property-value';
    assert.equal(host.querySelector(titleSelector)!.textContent, 'Pasted');
    legacy.destroy();
    const hidden = create(host, { result: result(type, ['note.Notes']), pageTitleProperty: 'file.name', openFile() {} });
    assert.equal(host.querySelector(titleSelector)!.textContent, 'Pasted');
    assert.doesNotMatch(host.textContent!, /Acceptance record/);
    hidden.destroy(); dom.window.close();
  });
}

test('explicit nested List retains its configured parent and absent-parent suppression', () => {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main')!;
  const initial = result('list'), snapshot = { ...initial, view: { ...initial.view, indentProperties: true } };
  const handle = createBaseListView(host, { result: snapshot, pageTitleProperty: 'file.name', openFile() {} });
  assert.equal(host.querySelector('.bases-list-item-properties > .bases-list-property .bases-list-property-value')!.textContent, 'Pasted');
  const row = { ...initial.rows[0], values: { ...initial.rows[0].values, 'note.Notes': value(null) } };
  handle.update({ ...snapshot, version: 2, rows: [row], groups: [{ key: null, rows: [row] }] });
  assert.equal(host.querySelector('.bases-list-item'), null);
  handle.destroy(); dom.window.close();
});
