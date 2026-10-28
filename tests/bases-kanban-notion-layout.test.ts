import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import { baseExpressionValue as value } from '../src/bases/expression.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

function fixture(properties = ['file.name']): BaseQueryResult {
  const rows = ['A.md', 'B.md'].map(path => ({ path, values: { 'file.name': value(path.slice(0, -3)), 'note.status': value('Todo') } }));
  return { version: 1, view: { name: 'Board', type: 'kanban', groupBy: { property: 'note.status', direction: 'ASC' } },
    properties, rows, groups: [{ key: value('Todo'), rows }, { key: value('Done'), rows: [] }], groupOptions: [], availableProperties: [],
    counts: { scanned: 2, matched: 2, afterGroupOrder: 2, afterSearch: 2, returned: 2 }, diagnostics: [] };
}
function setup() { const dom = new JSDOM('<main></main>'); return { dom, root: dom.window.document.querySelector('main')! }; }

test('compact board geometry keeps virtual cards and the following New page control in the same flow', () => {
  const { dom, root } = setup();
  const handle = createBaseKanbanView(root, { result: fixture(), openFile() {}, createItem: async () => {} });
  const columns = root.querySelectorAll<HTMLElement>('.bases-kanban-column');
  assert.equal(columns[0].style.width, '276px'); assert.equal(columns[1].style.left, '288px');
  const cards = columns[0].querySelectorAll<HTMLElement>('.bases-kanban-card');
  assert.equal(cards[0].style.height, '40px'); assert.equal(cards[1].style.top, '48px');
  const body = columns[0].querySelector<HTMLElement>('.bases-kanban-column-body')!;
  assert.deepEqual([...body.children].map(element => element.className), ['bases-kanban-column-space', 'bases-kanban-column-footer']);
  assert.equal(body.querySelector<HTMLElement>('.bases-kanban-column-space')!.style.height, '96px');
  body.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(body.querySelectorAll('.bases-kanban-column-footer').length, 1);
  assert.equal(body.querySelector('.bases-kanban-column-footer button')!.textContent, 'New page');
  handle.destroy();
});

test('configured widths and covers keep the card aspect ratio and property stride consistent', () => {
  const { root } = setup(), result = fixture(['file.name', 'note.status']);
  const handle = createBaseKanbanView(root, { result: { ...result, view: { ...result.view, columnWidth: 400, image: 'cover', imageAspectRatio: .5 } }, openFile() {} });
  const columns = root.querySelectorAll<HTMLElement>('.bases-kanban-column');
  assert.equal(columns[0].style.width, '400px'); assert.equal(columns[1].style.left, '412px');
  const cards = columns[0].querySelectorAll<HTMLElement>('.bases-kanban-card');
  assert.equal(cards[0].querySelector<HTMLElement>('.bases-kanban-card-cover')!.style.height, '192px');
  assert.equal(cards[0].style.height, '264px'); assert.equal(cards[1].style.top, '272px');
  assert.equal(cards[0].querySelectorAll('.bases-kanban-card-property').length, 2);
  handle.destroy();
});

test('group colors use explicit schema presentation and never infer status from text', () => {
  const { root } = setup(), result = fixture();
  const handle = createBaseKanbanView(root, { result, openFile() {}, getGroupAppearance: group => group === result.groups[0] ? { color: 'blue', category: 'in-progress' } : undefined });
  const columns = root.querySelectorAll<HTMLElement>('.bases-kanban-column');
  assert.equal(columns[0].dataset.color, 'blue'); assert.equal(columns[0].dataset.category, 'in-progress');
  assert.equal(columns[1].dataset.color, undefined); assert.equal(columns[1].dataset.category, undefined);
  assert.equal(columns[1].querySelector('.bases-kanban-column-name')!.textContent, 'Done');
  handle.destroy();
});

test('retained New page control creates against its current snapshot and is inert after replacement or destruction', async () => {
  const { dom, root } = setup(), versions: BaseQueryResult['version'][] = [];
  const handle = createBaseKanbanView(root, { result: fixture(), openFile() {}, createItem: async request => { versions.push(request.version); } });
  const old = root.querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!;
  old.click(); await Promise.resolve(); await Promise.resolve();
  handle.update({ ...fixture(), version: 2 }); old.click();
  const current = root.querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!;
  current.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  current.click(); await Promise.resolve(); await Promise.resolve(); handle.destroy(); current.click();
  assert.deepEqual(versions, [1, 2]);
});

test('initial and horizontally mounted columns fill the expanded viewport after installing their spacer', () => {
  const { dom, root } = setup(), initial = fixture();
  // A native shrink-to-content column initially contains only its 40px footer.
  // Installing the virtual row spacer expands its body to the bounded viewport.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains('bases-kanban-column-body')) return 0;
      const space = this.querySelector<HTMLElement>('.bases-kanban-column-space');
      return Math.min(400, (space ? parseFloat(space.style.height) : 0) + 40);
    },
  });
  const rows = Array.from({ length: 100 }, (_, index) => ({ path: `Task-${index}.md`, values: { 'file.name': value(`Task ${index}`) } }));
  const groups = Array.from({ length: 100 }, (_, index) => ({ key: value(`Column ${index}`), rows }));
  const handle = createBaseKanbanView(root, { result: { ...initial, rows, groups }, openFile() {}, createItem: async () => {} });
  const assertFilled = () => {
    for (const column of root.querySelectorAll<HTMLElement>('.bases-kanban-column')) {
      assert.ok(column.querySelector('[data-path="Task-8.md"]'), 'the last row intersecting the expanded 400px viewport must mount immediately');
      assert.ok(column.querySelectorAll('.bases-kanban-card').length < rows.length, 'virtualization remains bounded');
    }
  };
  assertFilled();
  const board = root.querySelector<HTMLElement>('.bases-kanban-view')!;
  board.scrollLeft = 10000; board.dispatchEvent(new dom.window.Event('scroll'));
  assertFilled();
  handle.destroy();
});

test('authoritative option labels replace opaque IDs in Board headers and accessible column names', async () => {
  const { root } = setup(), initial = fixture();
  const done = value('qu9qz58q1yvg');
  const group = { key: done, rows: initial.rows };
  let assigned: unknown;
  const handle = createBaseKanbanView(root, { result: { ...initial, groups: [group] }, openFile() {},
    getGroupAppearance: candidate => candidate === group ? { label: 'Done', color: 'green', category: 'done' } : undefined,
    requestMove: async request => { assigned = request.destination; },
  });
  assert.equal(root.querySelector('.bases-kanban-column-name')!.textContent, 'Done');
  assert.equal(root.querySelector('[role="listbox"]')!.getAttribute('aria-label'), 'Done');
  assert.doesNotMatch(root.textContent!, /qu9qz58q1yvg/);
  assert.equal(group.key, done, 'a display label must not replace the authoritative group value');
  assert.equal(await handle.move('A.md', done), false);
  assert.equal(assigned, undefined, 'display labeling does not manufacture a move between identical groups');
  handle.destroy();
});
