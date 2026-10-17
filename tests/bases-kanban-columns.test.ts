import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BaseDocument } from '../src/bases/document.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { baseExpressionValue as value } from '../src/bases/expression.ts';
import { createBaseKanbanColumns } from '../src/bases/kanban-columns.ts';
import type { BaseKanbanGroupOrderRequest } from '../src/bases/kanban-columns.ts';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';

const source = 'pluginRoot: { keep: yes }\nviews:\n - type: kanban\n   name: Board\n   pluginView: { keep: true }\n   groupBy: { property: status, direction: ASC, extra: preserve }\n   groupOrder: [Todo, Done]\n';
const files = [{ path: 'Alpha.md', properties: { status: 'In progress' } }, { path: 'Beta.md', properties: { status: 'Done' } }];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function setup(config = source, reject = false) {
  const dom = new JSDOM('<main></main><button>Group</button>'), doc = dom.window.document;
  const el = doc.querySelector<HTMLElement>('main')!, button = doc.querySelector<HTMLButtonElement>('button')!;
  const base = BaseDocument.parse(config); let version = 1; const requests: BaseKanbanGroupOrderRequest[] = [];
  const result = () => executeBaseQuery(base, { version, files });
  const handle = createBaseKanbanColumns(el, { result: result(), async requestGroupOrder(request) {
    requests.push(request); if (reject) throw Error('Save failed');
    const groupBy = base.views[0].groupBy as Record<string, any>;
    base.updateView(0, { groupOrder: request.order, ...(request.direction ? { groupBy: { ...groupBy, direction: request.direction } } : {}) });
    version++; handle.update(result());
  } });
  const row = (label: string) => [...doc.querySelectorAll<HTMLElement>('.bases-columns-row')].find(row => row.querySelector('.bases-columns-name')!.textContent === label)!;
  handle.open(button);
  return { dom, doc, el, button, base, requests, handle, row };
}

test('shows hidden groups and saves only order; restores Alpha without modifying its note', async () => {
  const { doc, row, handle, requests, base } = setup();
  assert.deepEqual([...doc.querySelectorAll('.bases-columns-name')].map(el => el.textContent), ['Todo', 'Done', 'In progress']);
  assert.equal(row('In progress').querySelector<HTMLInputElement>('input')!.checked, false);
  row('In progress').click(); await settle();
  assert.deepEqual(requests[0], { version: 1, property: 'note.status', order: ['Todo', 'Done', 'In progress'] });
  assert.equal(row('In progress').querySelector<HTMLInputElement>('input')!.checked, true);
  assert.deepEqual(base.getRoot('pluginRoot'), { keep: 'yes' }); assert.deepEqual(base.views[0].pluginView, { keep: true });
  assert.equal(files[0].properties.status, 'In progress'); handle.destroy();
});

test('checkbox click hides one group, Hide all and Show all persist explicit visibility', async () => {
  const { doc, row, handle, requests } = setup();
  row('Done').querySelector<HTMLInputElement>('input')!.click(); await settle(); assert.deepEqual(requests[0].order, ['Todo']);
  doc.querySelector<HTMLButtonElement>('.bases-columns-toggle')!.click(); await settle(); assert.deepEqual(requests[1].order, []);
  assert.equal(doc.querySelector('.bases-columns-toggle')!.textContent, 'Show all');
  doc.querySelector<HTMLButtonElement>('.bases-columns-toggle')!.click(); await settle();
  assert.deepEqual(new Set(requests[2].order), new Set(['Todo', 'Done', 'In progress'])); handle.destroy();
});

test('Alt-arrow reorders checked rows and preserves focus', async () => {
  const { dom, doc, row, handle, requests } = setup(); const done = row('Done'); done.focus();
  done.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })); await settle();
  assert.deepEqual(requests[0].order, ['Done', 'Todo']);
  assert.equal(doc.activeElement?.querySelector('.bases-columns-name')?.textContent, 'Done'); handle.destroy();
});

test('dragging row grip reorders without accepting external drops', async () => {
  const { dom, row, handle, requests } = setup();
  row('Todo').dispatchEvent(new dom.window.Event('drop', { cancelable: true })); assert.equal(requests.length, 0);
  const start = new dom.window.Event('dragstart', { cancelable: true }); Object.defineProperty(start, 'dataTransfer', { value: { setData() {} } });
  row('Done').querySelector('.bases-columns-grip')!.dispatchEvent(start);
  row('Todo').dispatchEvent(new dom.window.Event('drop', { cancelable: true })); await settle();
  assert.deepEqual(requests[0].order, ['Done', 'Todo']); handle.destroy();
});

test('automatic sorting removes groupOrder and manual restores it during same open menu', async () => {
  const { dom, doc, handle, requests, base } = setup();
  let select = doc.querySelector<HTMLSelectElement>('select')!; select.value = 'DESC'; select.dispatchEvent(new dom.window.Event('change')); await settle();
  assert.equal(requests[0].order, undefined); assert.equal(requests[0].direction, 'DESC'); assert.equal(base.views[0].groupOrder, undefined);
  assert.equal((base.views[0].groupBy as any).extra, 'preserve');
  select = doc.querySelector('select')!; select.value = 'MANUAL'; select.dispatchEvent(new dom.window.Event('change')); await settle();
  assert.deepEqual(requests[1].order, ['Todo', 'Done']); handle.destroy();
});

test('failed save restores checkboxes, reports error, allows retry', async () => {
  const { doc, row, handle, requests } = setup(source, true);
  row('In progress').click(); await settle();
  assert.equal(row('In progress').querySelector<HTMLInputElement>('input')!.checked, false);
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /Save failed/);
  row('In progress').click(); await settle(); assert.equal(requests.length, 2); handle.destroy();
});

test('pending config save blocks duplicates; late failure after closing stays inert', async () => {
  const dom = new JSDOM('<main></main><button>Group</button>'), doc = dom.window.document;
  let reject!: (error: unknown) => void, writes = 0, errors = 0;
  const result = executeBaseQuery(BaseDocument.parse(source), { version: 1, files });
  const handle = createBaseKanbanColumns(doc.querySelector('main')!, { result, requestGroupOrder: () => { writes++; return new Promise((_, fail) => { reject = fail; }); }, onError: () => errors++ });
  handle.open(doc.querySelector('button')!);
  const hidden = doc.querySelector<HTMLElement>('.bases-columns-row.mod-hidden')!; hidden.click(); hidden.click(); assert.equal(writes, 1);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  reject(Error('old')); await settle(); assert.equal(errors, 0); assert.equal(doc.querySelector('[role="dialog"]'), null); handle.destroy();
});

test('retained controls and drag cleanup are inert after destruction', () => {
  const { dom, doc, row, handle, requests } = setup(); const done = row('Done'), select = doc.querySelector<HTMLSelectElement>('select')!;
  handle.destroy(); done.click(); select.value = 'ASC'; select.dispatchEvent(new dom.window.Event('change'));
  done.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true })); assert.equal(requests.length, 0); assert.equal(doc.querySelector('[role="dialog"]'), null);
});

test('header hide API retains all other automatic groups in displayed null-first order', async () => {
  const { handle, requests } = setup(source.replace('   groupOrder: [Todo, Done]\n', ''));
  assert.equal(await handle.hide(value('Done')), true); assert.deepEqual(requests[0].order, ['In progress']); handle.destroy();
});

test('Kanban exposes Edit columns only with writable configuration host', () => {
  const dom = new JSDOM('<main></main>'), el = dom.window.document.querySelector<HTMLElement>('main')!;
  const result = executeBaseQuery(BaseDocument.parse(source), { version: 1, files });
  const readonly = createBaseKanbanView(el, { result, openFile() {}, readOnly: true, requestGroupOrder: async () => {} });
  assert.equal(el.querySelector('.bases-kanban-edit-columns'), null); readonly.destroy();
  const writable = createBaseKanbanView(el, { result, openFile() {}, requestGroupOrder: async () => {} });
  el.querySelector<HTMLButtonElement>('.bases-kanban-edit-columns')!.click(); assert.ok(dom.window.document.querySelector('[role="dialog"]'));
  writable.destroy(); assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
});

test('retained controls cannot save after menu close or after another menu opens', async () => {
  const { dom, doc, row, button, handle, requests } = setup();
  const oldRow = row('Done'), oldSelect = doc.querySelector<HTMLSelectElement>('select')!;
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  oldSelect.value = 'DESC'; oldSelect.dispatchEvent(new dom.window.Event('change')); oldRow.click(); await settle(); assert.equal(requests.length, 0);
  handle.open(button); oldSelect.dispatchEvent(new dom.window.Event('change')); oldRow.click(); await settle(); assert.equal(requests.length, 0); handle.destroy();
});

test('failed manual restore retains remembered columns for retry', async () => {
  const dom = new JSDOM('<main></main><button>Group</button>'), doc = dom.window.document, base = BaseDocument.parse(source);
  let version = 1, writes = 0; const orders: (readonly unknown[] | undefined)[] = [];
  const query = () => executeBaseQuery(base, { version, files });
  const handle = createBaseKanbanColumns(doc.querySelector('main')!, { result: query(), async requestGroupOrder(request) {
    writes++; orders.push(request.order); if (writes === 2) throw Error('Unavailable');
    base.updateView(0, { groupOrder: request.order }); version++; handle.update(query());
  } });
  handle.open(doc.querySelector('button')!);
  for (const mode of ['ASC', 'MANUAL', 'MANUAL']) {
    const select = doc.querySelector<HTMLSelectElement>('select')!; select.value = mode; select.dispatchEvent(new dom.window.Event('change')); await settle();
  }
  assert.deepEqual(orders, [undefined, ['Todo', 'Done'], ['Todo', 'Done']]); assert.deepEqual(base.views[0].groupOrder, ['Todo', 'Done']); handle.destroy();
});

test('old drop target cannot cancel a new menu drag operation', async () => {
  const { dom, doc, row, button, handle, requests } = setup(); const oldTarget = row('Todo');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); handle.open(button);
  const start = new dom.window.Event('dragstart', { cancelable: true }); Object.defineProperty(start, 'dataTransfer', { value: { setData() {} } });
  row('Done').querySelector('.bases-columns-grip')!.dispatchEvent(start);
  oldTarget.dispatchEvent(new dom.window.Event('drop', { cancelable: true }));
  row('Todo').dispatchEvent(new dom.window.Event('drop', { cancelable: true })); await settle();
  assert.deepEqual(requests[0].order, ['Done', 'Todo']); handle.destroy();
});
