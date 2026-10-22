import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseCardsView } from '../src/bases/cards-view.ts';
import { createBaseListView } from '../src/bases/list-view.ts';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import { baseExpressionValue as value } from '../src/bases/expression.ts';
import type { BaseQueryResult, BaseQueryRow } from '../src/bases/query.ts';
import type { BaseRowOpenWitness } from '../src/bases/presentation-common.ts';

const path = 'Folder/Topic#literal.md';
function snapshot(identity: Partial<Pick<BaseQueryRow, 'entryId' | 'revision'>> = { entryId: 'entry-original', revision: 'revision-original' }, version = 1): BaseQueryResult {
  const row = { path, ...identity, values: { 'file.name': value('Topic#literal'), 'file.file': value(path), 'note.status': value('Todo') } };
  return { version, view: { type: 'kanban', name: 'Files', groupBy: { property: 'status', direction: 'ASC' } }, rows: [row], groups: [{ key: value('Todo'), rows: [row] }],
    groupOptions: [], properties: ['file.name', 'file.file'], availableProperties: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [] };
}
const layouts = [
  ['Cards', createBaseCardsView, '.bases-cards-item'],
  ['List', createBaseListView, '.bases-list-item'],
  ['Kanban', createBaseKanbanView, '.bases-kanban-card'],
] as const;

for (const [name, create, selector] of layouts) {
  test(`${name} direct file properties forward exact row witness and literal hash path once`, () => {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), container = dom.window.document.querySelector('main')!;
    const opened: { path: string; event: MouseEvent | KeyboardEvent; witness?: BaseRowOpenWitness }[] = [];
    const view = create(container, { result: snapshot(), openFile: (path, event, witness) => opened.push({ path, event, witness }) });
    const row = container.querySelector(selector)!;
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    row.querySelector('[data-property="file.name"] a')!.dispatchEvent(click);
    const middle = new dom.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    row.querySelector('[data-property="file.file"] a')!.dispatchEvent(middle);
    assert.deepEqual(opened, [click, middle].map(event => ({ path, event, witness: { entryId: 'entry-original', revision: 'revision-original' } })));
    assert.ok(opened.every(open => !Object.hasOwn(open.witness!, 'subpath')));
    view.destroy(); dom.window.close();
  });

  test(`${name} stale detached file links cannot reopen a replacement at the same path`, () => {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), container = dom.window.document.querySelector('main')!;
    const opened: unknown[] = [];
    const view = create(container, { result: snapshot(), openFile: (path, _event, witness) => opened.push({ path, witness }) });
    const retired = container.querySelector('a')!;
    view.update(snapshot({ entryId: 'entry-replacement', revision: 'revision-replacement' }, 2));
    retired.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); assert.equal(opened.length, 0);
    container.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(opened, [{ path, witness: { entryId: 'entry-replacement', revision: 'revision-replacement' } }]);
    view.destroy(); dom.window.close();
  });

  test(`${name} legacy rows retain path fallback without inventing partial identity or subpath`, () => {
    for (const identity of [{}, { entryId: 'only-id' }, { revision: 'only-revision' }]) {
      const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), container = dom.window.document.querySelector('main')!;
      const opened: unknown[] = [];
      const view = create(container, { result: snapshot(identity), openFile: (path, _event, witness) => opened.push({ path, witness }) });
      container.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.deepEqual(opened, [{ path, witness: undefined }]); view.destroy(); dom.window.close();
    }
  });
}

for (const [name, create, selector] of [layouts[0], layouts[2]]) {
  test(`${name} background pointer and keyboard opening retain captured row identity`, () => {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), container = dom.window.document.querySelector('main')!;
    const opened: { path: string; event: MouseEvent | KeyboardEvent; witness?: BaseRowOpenWitness }[] = [];
    const view = create(container, { result: snapshot(), openFile: (path, event, witness) => opened.push({ path, event, witness }) });
    const card = container.querySelector<HTMLElement>(selector)!; card.focus();
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }); card.dispatchEvent(click);
    const middle = new dom.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }); card.dispatchEvent(middle);
    const enter = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', metaKey: true }); card.dispatchEvent(enter);
    assert.deepEqual(opened, [click, middle, enter].map(event => ({ path, event, witness: { entryId: 'entry-original', revision: 'revision-original' } })));
    view.update(snapshot({ entryId: 'entry-original', revision: 'revision-new' }, 2));
    assert.ok(opened.every(open => open.witness!.revision === 'revision-original'), 'host admission keeps the original witness across later refreshes');
    view.destroy(); dom.window.close();
  });
}
