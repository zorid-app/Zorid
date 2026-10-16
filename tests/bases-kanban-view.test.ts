import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import type { BaseKanbanMoveRequest } from '../src/bases/kanban-view.ts';
import { baseExpressionValue as value } from '../src/bases/expression.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

function snapshot(version: number = 1, property = 'note.status'): BaseQueryResult {
  const a = { path: 'A.md', values: { 'note.status': value('Todo') } }, b = { path: 'B.md', values: { 'note.status': value('Done') } };
  return { version, view: { name: 'Board', type: 'kanban', groupBy: { property, direction: 'ASC' } }, rows: [a, b], groups: [{ key: value('Todo'), rows: [a] }, { key: value('Done'), rows: [b] }, { key: value(null), rows: [] }], groupOptions: [], properties: ['file.name', 'note.status'], availableProperties: [], counts: { scanned: 2, matched: 2, afterGroupOrder: 2, afterSearch: 2, returned: 2 }, diagnostics: [] };
}
function setup() { const dom = new JSDOM('<div id="view"></div>'); return { dom, el: dom.window.document.querySelector<HTMLElement>('#view')! }; }
function deferred() { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('renders empty typed-null groups and safe property text, forwards opening events', () => {
  const { dom, el } = setup(); const opened: string[] = [];
  const result = snapshot(); const view = createBaseKanbanView(el, { result, openFile: path => opened.push(path) });
  assert.equal(el.querySelectorAll('.bases-kanban-column').length, 3);
  assert.match(el.textContent!, /No value/);
  el.querySelector<HTMLElement>('[data-path="A.md"]')!.click();
  assert.deepEqual(opened, ['A.md']); assert.equal(el.querySelector('[data-path="A.md"]')?.getAttribute('aria-selected'), 'true');
  el.querySelector('[data-path="B.md"]')!.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true }));
  assert.deepEqual(opened, ['A.md', 'B.md']); view.destroy(); assert.equal(el.childElementCount, 0);
});

test('pending move previews destination until authoritative query and rejects duplicate writes', async () => {
  const { el } = setup(), done = deferred(); const requests: BaseKanbanMoveRequest[] = [];
  const initial = snapshot();
  const view = createBaseKanbanView(el, { result: initial, openFile() {}, requestMove: request => { requests.push(request); return done.promise; } });
  const moving = view.move('A.md', value('Done'));
  assert.equal(el.querySelector('[data-path="A.md"]')?.getAttribute('aria-busy'), 'true');
  assert.match(el.querySelector('[data-path="A.md"]')!.closest('section')!.querySelector('.bases-kanban-column-header')!.textContent!, /Done/);
  assert.deepEqual(initial.groups[0].rows.map(row => row.path), ['A.md']);
  assert.deepEqual(initial.groups[1].rows.map(row => row.path), ['B.md']);
  assert.deepEqual([...el.querySelector('[data-path="A.md"]')!.closest('section')!.querySelectorAll<HTMLElement>('.bases-kanban-card')].map(el => el.dataset.path), ['A.md', 'B.md']);
  assert.equal(await view.move('A.md', value(null)), false); assert.equal(requests.length, 1);
  assert.equal(requests[0].version, 1); assert.equal(requests[0].property, 'note.status');
  done.resolve(); assert.equal(await moving, true);
  assert.equal(el.querySelector('[data-path="A.md"]')?.getAttribute('aria-busy'), 'true');
  const next = snapshot(2); const moved = { ...next, groups: [{ ...next.groups[0], rows: [] }, { ...next.groups[1], rows: next.rows }, next.groups[2]] };
  view.update(moved); assert.equal(el.querySelector('[data-path="A.md"]')?.getAttribute('aria-busy'), 'false');
  view.destroy();
});

test('failure restores interaction and reports error without changing source', async () => {
  const { el } = setup(); const errors: unknown[] = [];
  const view = createBaseKanbanView(el, { result: snapshot(), openFile() {}, requestMove: async () => { throw Error('Disk full'); }, onError: error => errors.push(error) });
  assert.equal(await view.move('A.md', value(null)), false);
  assert.equal(errors.length, 1); assert.match(el.querySelector('[role="status"]')!.textContent!, /Disk full/);
  assert.equal(el.querySelector('[data-path="A.md"]')?.getAttribute('aria-busy'), 'false');
  assert.match(el.querySelector('[data-path="A.md"]')!.closest('section')!.textContent!, /Todo/);
  view.destroy();
});

test('stale errors after regroup or destroy never modify new state or call onError', async () => {
  for (const action of ['regroup', 'destroy']) {
    const { el } = setup(), done = deferred(); let errors = 0;
    const view = createBaseKanbanView(el, { result: snapshot(), openFile() {}, requestMove: () => done.promise, onError: () => errors++ });
    const moving = view.move('A.md', value('Done'));
    if (action === 'regroup') view.update(snapshot(2, 'note.priority')); else view.destroy();
    done.reject(Error('old failure')); assert.equal(await moving, false); assert.equal(errors, 0);
    assert.doesNotMatch(el.textContent!, /old failure/); view.destroy();
  }
});

test('list-valued group moves retain one composite value; null remains typed', async () => {
  const { el } = setup(); const original = snapshot(); const list = value(['a', 'b']); let request: BaseKanbanMoveRequest | undefined;
  const result = { ...original, groups: [original.groups[0], { key: list, rows: [] }, original.groups[2]] };
  const view = createBaseKanbanView(el, { result, openFile() {}, requestMove: async input => { request = input; } });
  assert.equal(await view.move('A.md', value(['a', 'b'])), true); assert.deepEqual(request?.destination, list);
  view.update({ ...result, version: 2, groups: [{ ...result.groups[0], rows: [] }, { key: list, rows: [original.rows[0]] }, result.groups[2]] });
  assert.equal(await view.move('A.md', value(null)), true); assert.deepEqual(request?.destination, value(null)); view.destroy();
});

test('read-only, formula, non-folder file groups, and non-Markdown property rows cannot mutate', async () => {
  for (const property of ['formula.status', 'file.ext', 'note.status']) {
    const { el } = setup(); let writes = 0;
    const view = createBaseKanbanView(el, { result: snapshot(1, property), openFile() {}, readOnly: property === 'note.status', requestMove: async () => { writes++; } });
    assert.equal(await view.move('A.md', value('Done')), false); assert.equal(writes, 0);
    assert.equal(el.querySelector<HTMLElement>('[data-path="A.md"]')!.draggable, false); view.destroy();
  }
  const { el } = setup(); const source = snapshot(), row = { path: 'Pic.png', values: {} }; let writes = 0;
  const result = { ...source, rows: [row], groups: [{ key: value('Todo'), rows: [row] }, source.groups[1]] };
  const view = createBaseKanbanView(el, { result, openFile() {}, requestMove: async () => { writes++; } });
  assert.equal(await view.move('Pic.png', value('Done')), false);
  view.update({ ...result, view: { ...result.view, groupBy: { property: 'file.folder', direction: 'ASC' } } });
  assert.equal(await view.move('Pic.png', value('Done')), true); assert.equal(writes, 1); view.destroy();
});

test('virtual rendering stays bounded for many columns and cards and responds to scroll', () => {
  const { dom, el } = setup(), source = snapshot();
  const rows = Array.from({ length: 1000 }, (_, i) => ({ path: `Note-${i}.md`, values: {} }));
  const groups = Array.from({ length: 100 }, (_, i) => ({ key: value(`Column-${i}`), rows }));
  const view = createBaseKanbanView(el, { result: { ...source, rows, groups }, openFile() {} });
  assert.ok(el.querySelectorAll('.bases-kanban-column').length < 7);
  assert.ok(el.querySelectorAll('.bases-kanban-card').length < 100);
  const body = el.querySelector<HTMLElement>('.bases-kanban-column-body')!; body.scrollTop = 15000; body.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(!body.querySelector('[data-path="Note-0.md"]')); assert.ok(body.querySelector('.bases-kanban-card'));
  const root = el.querySelector<HTMLElement>('.bases-kanban-view')!; root.scrollLeft = 10000; root.dispatchEvent(new dom.window.Event('scroll'));
  assert.doesNotMatch(el.querySelector('.bases-kanban-column-header')!.textContent!, /^Column-0/);
  view.destroy();
});

test('selection survives updates for existing paths and clears when removed', () => {
  const { dom, el } = setup(); const opened: string[] = [], result = snapshot();
  const view = createBaseKanbanView(el, { result, openFile: path => opened.push(path) });
  el.querySelector<HTMLElement>('[data-path="A.md"]')!.click(); view.update(snapshot(2));
  assert.equal(el.querySelector('[data-path="A.md"]')?.getAttribute('aria-selected'), 'true');
  view.update({ ...result, version: 3, groups: [result.groups[1]], rows: [result.rows[1]] });
  el.querySelector('.bases-kanban-view')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(opened, ['A.md']); view.destroy();
});


test('pending preview survives unrelated query updates but rolls back after rejection', async () => {
  const { el } = setup(), done = deferred();
  const view = createBaseKanbanView(el, { result: snapshot(), openFile() {}, requestMove: () => done.promise });
  const moving = view.move('A.md', value('Done'));
  view.update(snapshot(2));
  assert.match(el.querySelector('[data-path="A.md"]')!.closest('section')!.querySelector('.bases-kanban-column-header')!.textContent!, /Done/);
  done.reject(Error('Conflict')); assert.equal(await moving, false);
  assert.match(el.querySelector('[data-path="A.md"]')!.closest('section')!.querySelector('.bases-kanban-column-header')!.textContent!, /Todo/);
  view.destroy();
});

test('hidden target cancels preview and stale failure without leaving source invisible', async () => {
  const { el } = setup(), done = deferred(); let errors = 0;
  const initial = snapshot();
  const view = createBaseKanbanView(el, { result: initial, openFile() {}, requestMove: () => done.promise, onError: () => errors++ });
  const moving = view.move('A.md', value('Done'));
  view.update({ ...initial, version: 2, groups: [initial.groups[0]] });
  assert.ok(el.querySelector('[data-path="A.md"]'));
  done.reject(Error('Old failure')); assert.equal(await moving, false); assert.equal(errors, 0); view.destroy();
});

test('dragging only accepts the same board snapshot and routes through the move transaction', async () => {
  const { dom, el } = setup(); const requests: BaseKanbanMoveRequest[] = [];
  const view = createBaseKanbanView(el, { result: snapshot(), openFile() {}, requestMove: async request => { requests.push(request); } });
  const dragStart = () => {
    const event = new dom.window.Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, effectAllowed: '' } });
    el.querySelector('[data-path="A.md"]')!.dispatchEvent(event);
  };
  const drop = () => [...el.querySelectorAll('.bases-kanban-column')].find(column => column.querySelector('.bases-kanban-column-header')!.textContent!.startsWith('Done'))!.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
  drop(); assert.equal(requests.length, 0); // External text is never an internal move.
  dragStart(); view.update(snapshot(2)); drop(); assert.equal(requests.length, 0);
  dragStart(); drop(); await Promise.resolve();
  assert.equal(requests.length, 1); assert.equal(requests[0].version, 2); assert.deepEqual(requests[0].destination, value('Done'));
  view.destroy();
});

test('late rejection after authoritative move does not roll back or report an obsolete error', async () => {
  const { el } = setup(), done = deferred(); let errors = 0;
  const initial = snapshot();
  const view = createBaseKanbanView(el, { result: initial, openFile() {}, requestMove: () => done.promise, onError: () => errors++ });
  const moving = view.move('A.md', value('Done'));
  view.update({ ...initial, version: 2, groups: [{ ...initial.groups[0], rows: [] }, { ...initial.groups[1], rows: initial.rows }] });
  done.reject(Error('Late response'));
  assert.equal(await moving, false); assert.equal(errors, 0);
  assert.match(el.querySelector('[data-path="A.md"]')!.closest('section')!.querySelector('.bases-kanban-column-header')!.textContent!, /Done/);
  assert.equal(el.querySelector('[data-path="A.md"]')!.getAttribute('aria-busy'), 'false'); view.destroy();
});

test('retained cards and columns cannot dispatch actions after update or destruction', async () => {
  const { dom, el } = setup(); let opens = 0, moves = 0;
  const view = createBaseKanbanView(el, { result: snapshot(), openFile: () => opens++, requestMove: async () => { moves++; } });
  const old = el.querySelector<HTMLElement>('[data-path="A.md"]')!;
  view.update(snapshot(2)); old.click(); old.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1 }));
  const drag = new dom.window.Event('dragstart', { cancelable: true }); Object.defineProperty(drag, 'dataTransfer', { value: { setData() {} } });
  old.dispatchEvent(drag); assert.equal(drag.defaultPrevented, true);
  [...el.querySelectorAll('.bases-kanban-column')].find(column => column.querySelector('.bases-kanban-column-header')!.textContent!.startsWith('Done'))!.dispatchEvent(new dom.window.Event('drop')); await Promise.resolve();
  assert.equal(moves, 0); assert.equal(opens, 0);
  const current = el.querySelector<HTMLElement>('[data-path="A.md"]')!; view.destroy(); current.click(); current.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1 })); assert.equal(opens, 0);
});

test('shrinking data clamps virtual scroll so remaining cards stay visible', () => {
  const { dom, el } = setup(), initial = snapshot();
  const rows = Array.from({ length: 1000 }, (_, i) => ({ path: `N${i}.md`, values: {} }));
  const groups = Array.from({ length: 100 }, (_, i) => ({ key: value(`C${i}`), rows }));
  const view = createBaseKanbanView(el, { result: { ...initial, rows, groups }, openFile() {} });
  const root = el.querySelector<HTMLElement>('.bases-kanban-view')!; root.scrollLeft = 10000; root.dispatchEvent(new dom.window.Event('scroll'));
  view.update({ ...initial, version: 2, rows: rows.slice(0, 1), groups: [{ key: value('C0'), rows: rows.slice(0, 1) }] });
  assert.equal(root.scrollLeft, 0); assert.ok(el.querySelector('[data-path="N0.md"]')); view.destroy();
});

test('dragend clears its operation after virtual unmount but cannot clear a newer drag', async () => {
  const { dom, el } = setup(); let moves = 0;
  const view = createBaseKanbanView(el, { result: snapshot(), openFile() {}, requestMove: async () => { moves++; } });
  function start(card: Element) { const event = new dom.window.Event('dragstart', { cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { setData() {} } }); card.dispatchEvent(event); }
  const original = el.querySelector('[data-path="A.md"]')!; start(original);
  el.querySelector('.bases-kanban-view')!.dispatchEvent(new dom.window.Event('scroll'));
  original.dispatchEvent(new dom.window.Event('dragend'));
  [...el.querySelectorAll('.bases-kanban-column')].find(column => column.querySelector('.bases-kanban-column-header')!.textContent!.startsWith('Done'))!.dispatchEvent(new dom.window.Event('drop')); await Promise.resolve(); assert.equal(moves, 0);
  const second = el.querySelector('[data-path="A.md"]')!; start(second);
  original.dispatchEvent(new dom.window.Event('dragend'));
  [...el.querySelectorAll('.bases-kanban-column')].find(column => column.querySelector('.bases-kanban-column-header')!.textContent!.startsWith('Done'))!.dispatchEvent(new dom.window.Event('drop')); await Promise.resolve(); assert.equal(moves, 1);
  view.destroy();
});

test('scroll restoration creates its spacer before native-like scroll clamping', () => {
  const { dom, el } = setup(); const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return positions.get(this) ?? 0; },
    set(this: HTMLElement, top: number) {
      const height = parseFloat(this.querySelector<HTMLElement>('.bases-kanban-column-space')?.style.height ?? '0');
      positions.set(this, Math.max(0, Math.min(top, height - 560)));
    },
  });
  const rows = Array.from({ length: 1000 }, (_, i) => ({ path: `N${i}.md`, values: {} }));
  const view = createBaseKanbanView(el, { result: { ...snapshot(), rows, groups: [{ key: value('Todo'), rows }] }, openFile() {} });
  const body = el.querySelector<HTMLElement>('.bases-kanban-column-body')!;
  body.scrollTop = 12000; body.dispatchEvent(new dom.window.Event('scroll'));
  el.querySelector('.bases-kanban-view')!.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(el.querySelector<HTMLElement>('.bases-kanban-column-body')!.scrollTop, 12000); view.destroy();
});


test('normalizes bare property requests and preserves empty manually ordered columns', async () => {
  const { el } = setup(); let request: BaseKanbanMoveRequest | undefined; const initial = snapshot(1, 'status');
  const view = createBaseKanbanView(el, { result: { ...initial, view: { ...initial.view, groupOrder: ['Empty', 'Todo'] }, groups: [initial.groups[0]], groupOptions: [{ key: value('Empty'), count: 0, listed: true }, { key: value('Todo'), count: 1, listed: true }, { key: value('Hidden'), count: 1, listed: false }] }, openFile() {}, requestMove: async input => { request = input; } });
  assert.deepEqual([...el.querySelectorAll('.bases-kanban-column-header')].map(header => header.childNodes[0].textContent), ['Empty', 'Todo']);
  assert.equal(await view.move('A.md', value('Empty')), true); assert.equal(request?.property, 'note.status'); view.destroy();
});

test('automatic Kanban places empty-value column first without changing query order', () => {
  const { el } = setup(), initial = snapshot();
  const view = createBaseKanbanView(el, { result: initial, openFile() {} });
  assert.match(el.querySelector('.bases-kanban-column-header')!.textContent!, /^No value/);
  assert.deepEqual(initial.groups[0].key, value('Todo')); view.destroy();
});
