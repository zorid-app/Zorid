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
  assert.deepEqual(created.map(item => { const { anchor, ...request } = item as { anchor: HTMLElement; [key: string]: unknown }; assert.ok(container.contains(anchor)); return request; }), Array(2).fill({ version: 1, property: 'note.status', group: value('Todo') }));
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

function columnDragEvent(dom: JSDOM, type: string) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, setDragImage() {}, dropEffect: '' } });
  return event;
}

test('live column preview moves existing columns, keeps source DOM and restores exact positions on cancel', () => {
  const { dom, container, result } = fixture(); let writes = 0;
  const view = createBaseKanbanView(container, { result, openFile() {}, requestGroupOrder: async () => { writes++; } });
  const [source, target] = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')];
  const heading = source.querySelector<HTMLElement>('.bases-kanban-column-header')!;
  heading.dispatchEvent(columnDragEvent(dom, 'dragstart')); target.dispatchEvent(columnDragEvent(dom, 'dragover'));
  assert.equal(source.style.left, '288px'); assert.equal(target.style.left, '0px');
  assert.ok(container.querySelector('.bases-kanban-column-drop-placeholder')); assert.equal(writes, 0);
  container.querySelector<HTMLElement>('.bases-kanban-view')!.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(container.contains(heading), 'scroll does not retire the native drag source');
  assert.deepEqual(result.groups.map(group => group.key), [value('Todo'), value('Done')]);
  heading.dispatchEvent(columnDragEvent(dom, 'dragend'));
  assert.equal(source.style.left, '0px'); assert.equal(target.style.left, '288px');
  assert.equal(container.querySelector('.bases-kanban-column-drop-placeholder'), null);
  view.destroy(); dom.window.close();
});

test('column drop keeps preview until host refresh and rolls back only its own failed operation', async () => {
  const { dom, container, result } = fixture(); let reject!: (error: unknown) => void; const errors: unknown[] = [], orders: unknown[] = [];
  const view = createBaseKanbanView(container, { result, openFile() {}, onPresentationError: error => errors.push(error), requestGroupOrder: request => {
    orders.push(request.order); return new Promise<void>((_resolve, no) => { reject = no; });
  } });
  const [source, target] = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')];
  const heading = source.querySelector<HTMLElement>('.bases-kanban-column-header')!;
  heading.dispatchEvent(columnDragEvent(dom, 'dragstart')); target.dispatchEvent(columnDragEvent(dom, 'dragover')); target.dispatchEvent(columnDragEvent(dom, 'drop')); heading.dispatchEvent(columnDragEvent(dom, 'dragend'));
  assert.deepEqual(orders, [['Done', 'Todo']]); assert.equal(source.style.left, '288px');
  assert.equal(container.querySelector('.bases-kanban-column-drop-placeholder'), null);
  reject(Error('Config conflict')); await tick();
  assert.equal(source.style.left, '0px'); assert.equal(target.style.left, '288px'); assert.equal(errors.length, 1);
  view.destroy(); dom.window.close();
});

test('new snapshots invalidate column previews and stale drop/failure cannot change current board', async () => {
  const { dom, container, result } = fixture(); let writes = 0, reject!: (error: unknown) => void; const errors: unknown[] = [];
  const view = createBaseKanbanView(container, { result, openFile() {}, onPresentationError: error => errors.push(error), requestGroupOrder: () => {
    writes++; return new Promise<void>((_resolve, no) => { reject = no; });
  } });
  const old = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')];
  old[0].querySelector('div')!.dispatchEvent(columnDragEvent(dom, 'dragstart')); old[1].dispatchEvent(columnDragEvent(dom, 'dragover'));
  view.update({ ...result, version: 2 }); old[1].dispatchEvent(columnDragEvent(dom, 'drop')); assert.equal(writes, 0);
  const current = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')];
  current[0].querySelector('div')!.dispatchEvent(columnDragEvent(dom, 'dragstart')); current[1].dispatchEvent(columnDragEvent(dom, 'drop'));
  assert.equal(writes, 1); view.update({ ...result, version: 3 }); reject(Error('obsolete failure')); await tick();
  assert.equal(errors.length, 0); assert.doesNotMatch(container.textContent!, /obsolete failure/);
  assert.equal(container.querySelector<HTMLElement>('.bases-kanban-column')!.style.left, '0px');
  view.destroy(); dom.window.close();
});

test('column ordering retains typed opaque identities and every saved alias; drafts prohibit drag', async () => {
  const { dom, container, result } = fixture(); const orders: unknown[] = [];
  const numeric = value(2), text = value('2');
  const source: BaseQueryResult = { ...result, shared: {} as NonNullable<BaseQueryResult['shared']>,
    view: { ...result.view, groupOrder: [2, '2', 'alias-two'] },
    groups: [{ key: numeric, sharedKeyId: 'numeric', rows: [result.rows[0]] }, { key: text, sharedKeyId: 'text', rows: [result.rows[1]] }],
    groupOptions: [{ key: numeric, sharedKeyId: 'numeric', count: 1, listed: true }, { key: text, sharedKeyId: 'text', count: 1, listed: true }, { key: text, sharedKeyId: 'text', count: 1, listed: true }] };
  const view = createBaseKanbanView(container, { result: source, openFile() {}, requestGroupOrder: async request => { orders.push(request.order); } });
  const columns = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')], heading = columns[0].querySelector('div')!;
  const property = container.querySelector<HTMLElement>('.bases-kanban-card-line')!; property.dataset.baseEditing = 'draft';
  const refused = columnDragEvent(dom, 'dragstart'); heading.dispatchEvent(refused); assert.equal(refused.defaultPrevented, true);
  property.removeAttribute('data-base-editing'); heading.dispatchEvent(columnDragEvent(dom, 'dragstart')); columns[1].dispatchEvent(columnDragEvent(dom, 'drop')); await tick();
  assert.deepEqual(orders, [['2', 'alias-two', 2]]);
  view.destroy(); dom.window.close();
});

test('column context menu uses a current renderer witness and cannot dispatch after snapshot replacement', async () => {
  const { dom, container, result } = fixture(); let nativeMenus = 0, writes = 0;
  Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu() { nativeMenus++; return Promise.resolve('hide'); } } });
  const view = createBaseKanbanView(container, { result, openFile() {}, requestGroupOrder: async () => { writes++; } });
  container.querySelector('.bases-kanban-column-header')!.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(nativeMenus, 0, 'the guarded menu uses renderer icons and validity checks');
  const hide = dom.window.document.querySelector<HTMLButtonElement>('.context-menu-item')!;
  assert.match(hide.textContent!, /Hide column/); view.update({ ...result, version: 2 }); hide.click(); await tick(); assert.equal(writes, 0);
  view.destroy(); dom.window.close();
});

test('horizontal scrolling during a column drag mounts distant destinations without replacing the grabbed node or aliases', async () => {
  const { dom, container, result } = fixture(); const orders: unknown[] = [];
  const keys = [value(2), value('2'), ...Array.from({ length: 6 }, (_, i) => value(`Column-${i + 2}`))];
  const groupKeys = keys.map((key, i) => ({ key, sharedKeyId: `identity-${i}`, rows: [result.rows[i % 2]] }));
  const source: BaseQueryResult = { ...result, shared: {} as NonNullable<BaseQueryResult['shared']>,
    view: { ...result.view, groupOrder: [2, '2', 'alias-two', ...Array.from({ length: 6 }, (_, i) => `Column-${i + 2}`)] },
    groups: groupKeys, groupOptions: groupKeys.flatMap((group, i) => [
      { key: group.key, sharedKeyId: group.sharedKeyId, count: 1, listed: true },
      ...(i === 1 ? [{ key: group.key, sharedKeyId: group.sharedKeyId, count: 1, listed: true }] : []),
    ]) };
  const view = createBaseKanbanView(container, { result: source, openFile() {}, requestGroupOrder: async request => { orders.push(request.order); } });
  const root = container.querySelector<HTMLElement>('.bases-kanban-view')!;
  Object.defineProperty(root, 'clientWidth', { value: 600 }); view.refreshLayout();
  const original = container.querySelector<HTMLElement>('.bases-kanban-column')!, heading = original.querySelector<HTMLElement>('.bases-kanban-column-header')!;
  const lastColumn = () => [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')].find(column => column.querySelector('.bases-kanban-column-header')!.textContent!.startsWith('Column-7'));
  assert.equal(lastColumn(), undefined); heading.dispatchEvent(columnDragEvent(dom, 'dragstart'));
  root.scrollLeft = 900; root.dispatchEvent(new dom.window.Event('scroll')); assert.ok(container.contains(heading));
  root.scrollLeft = 1900; root.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(container.querySelector('.is-being-dragged'), original); assert.ok(container.contains(heading));
  assert.ok(lastColumn(), 'newly visible far column is mounted during the native drag');
  assert.ok(container.querySelectorAll('.bases-kanban-column').length <= 6, 'only viewport plus grabbed column stay mounted');
  lastColumn()!.dispatchEvent(columnDragEvent(dom, 'dragover')); assert.equal(orders.length, 0);
  lastColumn()!.dispatchEvent(columnDragEvent(dom, 'drop')); heading.dispatchEvent(columnDragEvent(dom, 'dragend')); await tick();
  assert.deepEqual(orders, [['2', 'alias-two', 'Column-2', 'Column-3', 'Column-4', 'Column-5', 'Column-6', 'Column-7', 2]]);
  assert.deepEqual(source.view.groupOrder, [2, '2', 'alias-two', 'Column-2', 'Column-3', 'Column-4', 'Column-5', 'Column-6', 'Column-7']);
  view.destroy(); dom.window.close();
});

test('column-drag viewport refresh leaves an active widget draft and grabbed node untouched', () => {
  const { dom, container, result } = fixture(); let disposals = 0;
  const groups = Array.from({ length: 8 }, (_, i) => ({ key: value(`Column-${i}`), rows: [result.rows[i % 2]] }));
  const view = createBaseKanbanView(container, { result: { ...result, groups }, openFile() {}, requestGroupOrder: async () => {}, renderProperty(element) {
    element.textContent = 'value'; return () => disposals++;
  } });
  const root = container.querySelector<HTMLElement>('.bases-kanban-view')!, heading = container.querySelector<HTMLElement>('.bases-kanban-column-header')!;
  heading.dispatchEvent(columnDragEvent(dom, 'dragstart'));
  const editor = container.querySelector<HTMLElement>('.bases-kanban-card-line')!; editor.dataset.baseEditing = 'draft'; const before = disposals;
  root.scrollLeft = 1800; root.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(container.contains(editor)); assert.ok(container.contains(heading)); assert.equal(disposals, before);
  editor.removeAttribute('data-base-editing'); root.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(container.contains(heading)); assert.ok([...container.querySelectorAll('.bases-kanban-column-header')].some(item => item.textContent!.startsWith('Column-7')));
  heading.dispatchEvent(columnDragEvent(dom, 'dragend')); view.destroy(); dom.window.close();
});

test('a grabbed card also reaches a newly mounted distant column after horizontal scrolling', async () => {
  const { dom, container, result } = fixture(); const moves: unknown[] = [];
  const groups = Array.from({ length: 8 }, (_, i) => ({ key: value(`Column-${i}`), rows: i === 0 ? [result.rows[0]] : [] }));
  const view = createBaseKanbanView(container, { result: { ...result, groups }, openFile() {}, requestMove: async request => { moves.push(request.destination); } });
  const root = container.querySelector<HTMLElement>('.bases-kanban-view')!, grabbed = container.querySelector<HTMLElement>('.bases-kanban-card')!;
  grabbed.dispatchEvent(columnDragEvent(dom, 'dragstart')); root.scrollLeft = 1800; root.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(container.contains(grabbed)); assert.equal(container.querySelector('.is-being-dragged'), grabbed);
  const target = [...container.querySelectorAll('.bases-kanban-column')].find(column => column.querySelector('.bases-kanban-column-header')!.textContent!.startsWith('Column-7'))!;
  assert.ok(target); target.dispatchEvent(columnDragEvent(dom, 'dragover')); assert.ok(target.querySelector('.bases-kanban-card-drop-placeholder'));
  target.dispatchEvent(columnDragEvent(dom, 'drop')); await tick(); assert.deepEqual(moves, [value('Column-7')]);
  view.destroy(); dom.window.close();
});

test('vertical source-column scrolling pins the grabbed card while mounting later rows', () => {
  const { dom, container, result } = fixture();
  const rows = Array.from({ length: 30 }, (_, i) => ({ path: `Card-${i}.md`, values: { 'file.name': value(`Card-${i}`) } }));
  const view = createBaseKanbanView(container, { result: { ...result, properties: ['file.name'], rows, groups: [{ key: value('Todo'), rows }, { key: value('Done'), rows: [] }] }, openFile() {}, requestMove: async () => {} });
  const grabbed = container.querySelector<HTMLElement>('[data-path="Card-0.md"]')!, body = grabbed.closest<HTMLElement>('.bases-kanban-column-body')!;
  grabbed.dispatchEvent(columnDragEvent(dom, 'dragstart')); body.scrollTop = 500; body.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(container.contains(grabbed)); assert.ok(body.querySelector('[data-path="Card-24.md"]'));
  assert.equal(container.querySelectorAll('[data-path="Card-0.md"]').length, 1);
  grabbed.dispatchEvent(columnDragEvent(dom, 'dragend'));
  assert.equal(container.querySelector('[data-path="Card-0.md"]'), null, 'normal virtualization resumes after cancel');
  view.destroy(); dom.window.close();
});

test('host group write capability disables only unsafe column creation, source dragging and drop destinations', async () => {
  const { dom, container, result } = fixture(); const created: unknown[] = [], moved: unknown[] = [];
  const groups = result.groups.map((group, i) => ({ ...group, sharedKeyId: `group-${i}`, ...(i === 0 ? { editKey: 'Todo' } : {}) }));
  const source: BaseQueryResult = { ...result, shared: {} as NonNullable<BaseQueryResult['shared']>, groups };
  const view = createBaseKanbanView(container, { result: source, openFile() {}, isGroupWritable: group => Object.hasOwn(group, 'editKey'),
    createItem: async request => { created.push(request); }, requestMove: async request => { moved.push(request); } });
  const [safe, unsafe] = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')];
  assert.equal(safe.querySelector<HTMLButtonElement>('.bases-kanban-column-create')!.disabled, false);
  assert.equal(unsafe.querySelector<HTMLButtonElement>('.bases-kanban-column-create')!.disabled, true);
  assert.equal(unsafe.querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!.disabled, true);
  assert.equal(safe.querySelector<HTMLElement>('.bases-kanban-card')!.draggable, true);
  assert.equal(unsafe.querySelector<HTMLElement>('.bases-kanban-card')!.draggable, false);
  unsafe.querySelector<HTMLButtonElement>('.bases-kanban-column-create')!.click(); assert.equal(created.length, 0);
  assert.equal(await view.move('A.md', groups[1].key!), false); assert.equal(moved.length, 0);
  safe.querySelector('.bases-kanban-card')!.dispatchEvent(columnDragEvent(dom, 'dragstart'));
  const over = columnDragEvent(dom, 'dragover'); unsafe.dispatchEvent(over); assert.equal(over.defaultPrevented, false);
  assert.equal(unsafe.querySelector('.bases-kanban-card-drop-placeholder'), null);
  unsafe.dispatchEvent(columnDragEvent(dom, 'drop')); await tick(); assert.equal(moved.length, 0);
  view.destroy(); dom.window.close();
});

test('synthesized empty shared columns preserve additive capability metadata for the host predicate', async () => {
  const { dom, container, result } = fixture(); const created: unknown[] = [];
  const first = { ...result.groups[0], sharedKeyId: 'first', editKey: 'Todo' };
  const empty = { key: value('Empty'), sharedKeyId: 'empty', listed: true, count: 0, editKey: ['[[Exact.md]]', 'raw'] };
  const source: BaseQueryResult = { ...result, shared: {} as NonNullable<BaseQueryResult['shared']>, view: { ...result.view, groupOrder: ['Todo', 'Empty'] },
    groups: [first], groupOptions: [{ key: first.key!, sharedKeyId: 'first', listed: true, count: 1, editKey: 'Todo' }, empty] };
  const seen: unknown[] = [];
  const view = createBaseKanbanView(container, { result: source, openFile() {}, isGroupWritable: group => { if (group.sharedKeyId === 'empty') seen.push((group as unknown as { editKey: unknown }).editKey); return Object.hasOwn(group, 'editKey'); }, createItem: async request => { created.push(request.groupKeyId); } });
  const columns = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column')]; columns[1].querySelector<HTMLButtonElement>('.bases-kanban-column-create')!.click(); await tick();
  assert.deepEqual(created, ['empty']); assert.ok(seen.length); assert.ok(seen.every(raw => JSON.stringify(raw) === JSON.stringify(empty.editKey)));
  view.destroy(); dom.window.close();
});

test('shared column reorder uses core orderKey independently of editKey and refuses unavailable order values', async () => {
  const { dom, container, result } = fixture(); const orders: unknown[] = [];
  const rich = (name: string) => ({ type: 'namespace' as const, name, get() { throw Error('A rich display value must not be converted for config'); } });
  const groups = [{ key: rich('Author A'), sharedKeyId: 'author-a', orderKey: ['[[Author A.md]]', 'other'], editKey: 'wrong-for-order', rows: [result.rows[0]] },
    { key: rich('Author B'), sharedKeyId: 'author-b', orderKey: '[[Author B.md]]', rows: [result.rows[1]] }];
  const source: BaseQueryResult = { ...result, shared: {} as NonNullable<BaseQueryResult['shared']>, groups };
  const view = createBaseKanbanView(container, { result: source, openFile() {}, isGroupWritable: () => false, requestGroupOrder: async request => { orders.push(request.order); } });
  let headings = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column-header')];
  assert.equal(headings[0].draggable, true, 'configuration ordering is independent of note write capability');
  headings[0].dispatchEvent(columnDragEvent(dom, 'dragstart')); headings[1].dispatchEvent(columnDragEvent(dom, 'drop')); await tick();
  assert.deepEqual(orders, [['[[Author B.md]]', ['[[Author A.md]]', 'other']]]);
  view.update({ ...source, version: 2, groups: [{ ...groups[0] }, { key: groups[1].key, sharedKeyId: 'author-b', rows: groups[1].rows }] });
  headings = [...container.querySelectorAll<HTMLElement>('.bases-kanban-column-header')]; assert.ok(headings.every(heading => !heading.draggable));
  const refused = columnDragEvent(dom, 'dragstart'); headings[0].dispatchEvent(refused); assert.equal(refused.defaultPrevented, true);
  headings[1].dispatchEvent(columnDragEvent(dom, 'drop')); await tick(); assert.equal(orders.length, 1);
  view.destroy(); dom.window.close();
});
