import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import { baseExpressionValue as value } from '../src/bases/expression.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

function fixture() {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const container = dom.window.document.querySelector('main')!;
  const a = { path: 'A.md', values: { 'file.name': value('A'), 'note.status': value('Todo'), 'note.done': value(false) } };
  const b = { path: 'B.md', values: { 'file.name': value('B'), 'note.status': value('Done'), 'note.done': value(true) } };
  const result: BaseQueryResult = { version: 1, view: { type: 'kanban', name: 'Board', groupBy: { property: 'status', direction: 'ASC' } }, rows: [a,b],
    groups: [{ key: value('Todo'), rows: [a] }, { key: value('Done'), rows: [b] }], groupOptions: [], properties: ['note.status', 'file.name', 'note.done'], availableProperties: [], counts: { scanned: 2, matched: 2, afterGroupOrder: 2, afterSearch: 2, returned: 2 }, diagnostics: [] };
  return { dom, container, result };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Kanban uses first configured property as title and shared typed widgets without duplicating filename', () => {
  const { dom, container, result } = fixture();
  const view = createBaseKanbanView(container, { result, openFile() {}, getPropertyLabel: property => property === 'note.done' ? 'Completed' : property });
  const card = container.querySelector('[data-path="A.md"]')!;
  assert.equal(card.querySelector('.mod-title .bases-kanban-card-line')!.textContent, 'Todo');
  assert.equal(card.querySelectorAll('[data-property="file.name"] a').length, 1);
  assert.equal(card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
  assert.match(card.textContent!, /Completed/);
  view.destroy(); dom.window.close();
});

test('Kanban preserves link/modifier opening and leaves text selection and input clicks to their owners', () => {
  const { dom, container, result } = fixture(); const opened: (MouseEvent | KeyboardEvent)[] = [];
  const view = createBaseKanbanView(container, { result, openFile: (_path, event) => opened.push(event) });
  const card = container.querySelector<HTMLElement>('[data-path="A.md"]')!;
  const selection = dom.window.getSelection()!, range = dom.window.document.createRange();
  range.selectNodeContents(card.querySelector('.mod-title')!); selection.addRange(range); card.click();
  assert.equal(opened.length, 0); selection.removeAllRanges();
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }); card.dispatchEvent(event);
  assert.equal(opened[0], event);
  card.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(opened.length, 2, 'link opens once instead of bubbling into card action');
  card.querySelector('input')!.click(); assert.equal(opened.length, 2);
  view.destroy(); dom.window.close();
});

test('Kanban header and footer creation preserve exact group key and snapshot; read-only exposes neither', async () => {
  const { dom, container, result } = fixture(); const created: unknown[] = [];
  const view = createBaseKanbanView(container, { result, openFile() {}, createItem: async request => { created.push(request); } });
  container.querySelector<HTMLElement>('.bases-kanban-column-create')!.click(); await tick();
  container.querySelector<HTMLElement>('.bases-kanban-column-footer button')!.click(); await tick();
  assert.deepEqual(created, Array(2).fill({ version: 1, property: 'note.status', group: value('Todo') }));
  const retained = container.querySelector<HTMLElement>('.bases-kanban-column-create')!;
  view.update({ ...result, version: 2 }); retained.click(); await tick(); assert.equal(created.length, 2);
  view.destroy();
  const readOnly = createBaseKanbanView(container, { result, openFile() {}, readOnly: true, createItem: async request => { created.push(request); } });
  assert.equal(container.querySelector('.bases-kanban-column-create'), null);
  assert.equal(container.querySelector('.bases-kanban-column-footer'), null);
  readOnly.destroy(); dom.window.close();
});

test('Kanban image leases use half-height default and dispose late resources after retirement', async () => {
  const { dom, container, result } = fixture(); const pending: { signal: AbortSignal; resolve(value: { url: string; dispose(): void }): void }[] = [];
  let released = 0;
  const view = createBaseKanbanView(container, { result: { ...result, view: { ...result.view, image: 'cover', imageFit: 'contain' } }, openFile() {},
    loadThumbnail: request => new Promise(resolve => pending.push({ signal: request.signal, resolve })) });
  await tick(); assert.equal(pending.length, 2);
  assert.equal(container.querySelector<HTMLElement>('.bases-kanban-card-cover')!.style.height, '140px');
  pending[0].resolve({ url: 'blob:cover', dispose: () => released++ }); await tick();
  assert.equal(container.querySelector<HTMLImageElement>('img')!.style.objectFit, 'contain');
  view.destroy(); assert.equal(released, 1); assert.ok(pending.every(item => item.signal.aborted));
  pending[1].resolve({ url: 'blob:late', dispose: () => released++ }); await tick(); assert.equal(released, 2);
  dom.window.close();
});

test('Kanban defers snapshots and viewport recycling while a property has an active draft', async () => {
  const { dom, container, result } = fixture(); let releases = 0;
  const view = createBaseKanbanView(container, { result, openFile() {}, renderProperty(element, property) {
    element.textContent = String(property.version);
    return () => releases++;
  } });
  const editor = container.querySelector<HTMLElement>('.bases-kanban-card-line')!;
  editor.setAttribute('data-base-editing', 'true'); assert.equal(view.hasActiveEdits(), true);
  view.update({ ...result, version: 2 }); view.refreshLayout();
  assert.ok(container.contains(editor)); assert.equal(releases, 0);
  editor.removeAttribute('data-base-editing'); await tick();
  assert.equal(view.hasActiveEdits(), false); assert.ok(!container.contains(editor));
  assert.equal(container.querySelector('.bases-kanban-card-line')!.textContent, '2'); assert.equal(releases, 6);
  view.destroy(); assert.equal(releases, 12); dom.window.close();
});

test('Kanban header dragging sends persisted column ordering and rejects stale detached targets', async () => {
  const { dom, container, result } = fixture(); const orders: unknown[] = [];
  const view = createBaseKanbanView(container, { result, openFile() {}, requestGroupOrder: async request => { orders.push(request); } });
  const headers = [...container.querySelectorAll('.bases-kanban-column-header')];
  function start(element: Element) { const event = new dom.window.Event('dragstart', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { setData() {} } }); element.dispatchEvent(event); }
  start(headers[0]); headers[1].dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(orders, [{ version: 1, property: 'note.status', order: ['Done', 'Todo'] }]);
  view.update({ ...result, version: 2 }); start(headers[0]); headers[1].dispatchEvent(new dom.window.Event('drop', { bubbles: true })); await tick(); assert.equal(orders.length, 1);
  view.destroy(); dom.window.close();
});

test('Kanban retains logical card focus across refreshes and keyboard moves ignore owned property inputs', async () => {
  const { dom, container, result } = fixture(); const moves: unknown[] = []; let opens = 0;
  const view = createBaseKanbanView(container, { result, openFile() { opens++; }, requestMove: async request => { moves.push(request); } });
  container.querySelector<HTMLElement>('[data-path="A.md"]')!.focus();
  view.update({ ...result, version: 2 });
  assert.equal((dom.window.document.activeElement as HTMLElement).dataset.path, 'A.md');
  dom.window.document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }));
  await tick(); assert.equal(moves.length, 1);
  assert.deepEqual((moves[0] as { destination: unknown }).destination, value('Done'));
  const input = container.querySelector('input')!;
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(opens, 0);
  view.destroy(); dom.window.close();
});

test('Kanban drag feedback previews sorted insertion without changing data or dispatching a write', () => {
  const { dom, container, result } = fixture(); let writes = 0;
  const view = createBaseKanbanView(container, { result, openFile() {}, requestMove: async () => { writes++; } });
  const source = container.querySelector<HTMLElement>('[data-path="A.md"]')!, destination = container.querySelector('[data-path="B.md"]')!.closest('section')!;
  let ghost: unknown;
  const start = new dom.window.Event('dragstart', { cancelable: true });
  Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, setDragImage(element: unknown) { ghost = element; } } }); source.dispatchEvent(start);
  assert.equal(ghost, source); assert.equal(source.classList.contains('is-being-dragged'), true);
  const over = new dom.window.Event('dragover', { bubbles: true, cancelable: true }); destination.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true); assert.ok(destination.querySelector('.bases-kanban-card-drop-placeholder'));
  assert.equal(writes, 0); assert.deepEqual(result.groups[1].rows.map(row => row.path), ['B.md']);
  source.dispatchEvent(new dom.window.Event('dragend'));
  assert.equal(container.querySelector('.bases-kanban-card-drop-placeholder'), null);
  assert.equal(source.classList.contains('is-being-dragged'), false);
  assert.equal(container.querySelector<HTMLElement>('[data-path="B.md"]')!.style.top, '0px');
  view.destroy(); dom.window.close();
});
