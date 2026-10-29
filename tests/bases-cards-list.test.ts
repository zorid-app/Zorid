import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseCardsView, baseCardsSettings } from '../src/bases/cards-view.ts';
import { createBaseListView, baseListSettings } from '../src/bases/list-view.ts';
import { BASE_NULL, baseExpressionValue } from '../src/bases/expression.ts';
import type { BaseQueryResult, BaseQueryRow } from '../src/bases/query.ts';

function row(path: string, values: Record<string, unknown> = {}): BaseQueryRow {
  return { path, values: Object.fromEntries(Object.entries({ 'file.name': path.replace(/\.md$/, ''), ...values }).map(([key, value]) => [key, baseExpressionValue(value)])) };
}
function result(rows = [row('A.md')], view: Record<string, unknown> = {}, properties = ['file.name']): BaseQueryResult {
  return { version: 1, view: { type: 'cards', name: 'Gallery', ...view } as BaseQueryResult['view'], rows,
    groups: [{ key: null, rows }], groupOptions: [], properties, availableProperties: properties,
    counts: { scanned: rows.length, matched: rows.length, afterGroupOrder: rows.length, afterSearch: rows.length, returned: rows.length }, diagnostics: [] };
}
function dom() {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  return { dom, container: dom.window.document.querySelector('main')!, win: dom.window };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

test('Cards and List read observed options without rewriting configuration', () => {
  assert.deepEqual(baseCardsSettings(result()), { cardSize: 200, image: null, imageFit: 'cover', imageAspectRatio: 1 });
  assert.deepEqual(baseCardsSettings(result([], { cardSize: 180, image: 'cover', imageFit: 'contain', imageAspectRatio: 0.5 })),
    { cardSize: 180, image: 'note.cover', imageFit: 'contain', imageAspectRatio: 0.5 });
  assert.equal(baseCardsSettings(result([], { cardSize: -1, imageAspectRatio: Infinity })).cardSize, 200);
  assert.deepEqual(baseListSettings(result([], { markers: 'invalid', separator: '' })), { markers: 'bullet', indentProperties: false, separator: ', ' });
  assert.deepEqual(baseListSettings(result([], { markers: 'number', indentProperties: true, separator: ' / ' })), { markers: 'number', indentProperties: true, separator: ' / ' });
});

test('Cards preserve property order, labels and original modifier/middle click events', () => {
  const { dom: d, container, win } = dom(); const opened: [string, MouseEvent | KeyboardEvent][] = [];
  const view = createBaseCardsView(container, { result: result([row('A.md', { 'note.status': 'Doing' })], {}, ['note.status', 'file.name']),
    openFile: (path, event) => opened.push([path, event]), getPropertyLabel: p => p === 'note.status' ? 'Stage' : 'Name' });
  const card = container.querySelector<HTMLElement>('.bases-cards-item')!;
  assert.deepEqual([...card.querySelectorAll('.bases-cards-label')].map(e => e.textContent), ['Stage', 'Name']);
  assert.equal(card.querySelector('.mod-title .bases-cards-line')!.textContent, 'Doing');
  const click = new win.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, shiftKey: true }); card.dispatchEvent(click);
  const middle = new win.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }); card.dispatchEvent(middle);
  assert.equal(opened.length, 2); assert.equal(opened[0][1], click); assert.equal(opened[1][1], middle);
  card.querySelector('a')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(opened.length, 3, 'link click does not also activate card');
  view.destroy(); d.window.close();
});

test('Cards retain text selection and focused property input instead of opening note', () => {
  const { dom: d, container, win } = dom(); let opened = 0;
  const view = createBaseCardsView(container, { result: result([row('A.md', { 'note.status': 'Doing' })], {}, ['file.name', 'note.status']), openFile: () => opened++, editProperty() {} });
  const card = container.querySelector<HTMLElement>('.bases-cards-item')!;
  const line = card.querySelector<HTMLElement>('[data-property="note.status"]')!;
  const selection = win.getSelection()!; const range = win.document.createRange(); range.selectNodeContents(line); selection.addRange(range);
  card.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); assert.equal(opened, 0);
  selection.removeAllRanges(); line.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  assert.equal(win.document.activeElement, line.querySelector('input'));
  card.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); assert.equal(opened, 0);
  view.destroy(); d.window.close();
});

test('List suppresses empty values, keeps false/zero and numbers only displayed rows per group', () => {
  const { dom: d, container } = dom();
  const data = result([row('A.md', { 'note.title': null, 'note.n': null }), row('B.md', { 'note.title': '', 'note.n': 0 }), row('C.md', { 'note.title': false })], { markers: 'number' }, ['note.title', 'note.n']);
  const view = createBaseListView(container, { result: data, openFile() {} });
  assert.deepEqual([...container.querySelectorAll('.list-number')].map(e => e.textContent), ['1.', '2.']);
  assert.deepEqual([...container.querySelectorAll('.bases-list-item')].map(e => (e as HTMLElement).dataset.path), ['B.md', 'C.md']);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 1);
  view.update({ ...data, view: { ...data.view, indentProperties: true } });
  assert.deepEqual([...container.querySelectorAll('.bases-list-item')].map(e => (e as HTMLElement).dataset.path), ['C.md']);
  view.destroy(); d.window.close();
});

test('List uses separator between nonempty values and nested bullets for indented children', () => {
  const { dom: d, container } = dom();
  const data = result([row('A.md', { 'note.a': 'One', 'note.empty': [], 'note.b': 'Two' })], { markers: 'none', separator: ' | ' }, ['file.name', 'note.a', 'note.empty', 'note.b']);
  const view = createBaseListView(container, { result: data, openFile() {}, showIndentationGuides: true });
  assert.equal(container.querySelector('.bases-list-item')!.textContent, 'A | One | Two');
  view.update({ ...data, view: { ...data.view, indentProperties: true } });
  assert.equal(container.querySelectorAll('.nested .list-bullet').length, 2);
  assert.equal(container.querySelectorAll('.bases-list-separator').length, 0);
  assert.equal(container.querySelectorAll('.bases-list-item-properties:not(.nested) .list-bullet').length, 0);
  view.destroy(); d.window.close();
});

test('Groups collapse independently and typed null remains a visible empty-key group', () => {
  const { dom: d, container, win } = dom(); const a = row('A.md'), b = row('B.md');
  const data = { ...result([a,b]), groups: [{ key: baseExpressionValue('Todo'), rows: [a] }, { key: BASE_NULL, rows: [b] }] };
  const view = createBaseCardsView(container, { result: data, openFile() {} });
  assert.equal(container.querySelectorAll('.bases-cards-item').length, 2);
  const heading = container.querySelector('.bases-group-heading')!;
  heading.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(container.querySelectorAll('.bases-cards-item').length, 1);
  assert.match(container.textContent!, /No value/);
  view.update({ ...data, version: 2 });
  assert.equal(container.querySelectorAll('.bases-cards-item').length, 1, 'collapse retained through query update');
  view.destroy(); d.window.close();
});

test('Cards thumbnail handles are aborted and released for update, scroll retirement and late resolution', async () => {
  const { dom: d, container } = dom();
  const pending: { resolve: (value: { url: string; dispose(): void }) => void; signal: AbortSignal }[] = [];
  let disposed = 0;
  const data = result([row('A.md', { 'note.cover': 'a.png' })], { image: 'cover' });
  const view = createBaseCardsView(container, { result: data, openFile() {}, loadThumbnail(request) {
    assert.equal(request.property, 'note.cover');
    return new Promise(resolve => pending.push({ resolve, signal: request.signal }));
  } });
  await tick(); view.update({ ...data, version: 2 }); await tick();
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ url: 'blob:stale', dispose() { disposed++; } }); await tick();
  assert.equal(disposed, 1); assert.equal(container.querySelectorAll('img').length, 0);
  pending[1].resolve({ url: 'blob:current', dispose() { disposed++; } }); await tick();
  assert.equal(container.querySelector('img')!.getAttribute('src'), 'blob:current');
  view.destroy(); assert.equal(pending[1].signal.aborted, true); assert.equal(disposed, 2);
  view.destroy(); assert.equal(disposed, 2); d.window.close();
});

test('Large List mounts a bounded viewport and disposes property widgets as scrolling advances', async () => {
  const { dom: d, container, win } = dom(); let mounted = 0; let disposed = 0;
  const data = result(Array.from({ length: 10_000 }, (_, i) => row(`Note ${i}.md`)));
  const view = createBaseListView(container, { result: data, openFile() {}, renderProperty(element, context) {
    mounted++; element.textContent = context.row.path; return () => { disposed++; };
  } });
  assert.ok(container.querySelectorAll('.bases-list-item').length < 40);
  const scroll = container.querySelector<HTMLElement>('.bases-virtual-scroll')!;
  scroll.scrollTop = 150_000; scroll.dispatchEvent(new win.Event('scroll')); await tick();
  assert.ok(disposed > 0); assert.ok(container.querySelectorAll('.bases-list-item').length < 45);
  assert.ok(container.textContent!.includes('Note 5000.md'));
  view.destroy(); assert.equal(mounted, disposed); d.window.close();
});

test('Primitive edits carry snapshot version, skip non-Markdown files and retire stale controls', async () => {
  const { dom: d, container, win } = dom(); const edits: unknown[] = [];
  const data = result([row('A.md', { 'note.done': false }), row('B.pdf', { 'note.done': false })], {}, ['file.name', 'note.done']);
  const view = createBaseCardsView(container, { result: data, openFile() {}, editProperty(edit) { edits.push(edit); } });
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(inputs[1].disabled, true);
  inputs[0].checked = true; inputs[0].dispatchEvent(new win.Event('change')); await tick();
  assert.deepEqual(edits, [{ version: 1, path: 'A.md', property: 'note.done', value: { type: 'boolean', value: true } }]);
  view.update({ ...data, version: 2 });
  inputs[0].dispatchEvent(new win.Event('change')); await tick(); assert.equal(edits.length, 1);
  view.destroy(); d.window.close();
});

test('Editable card property consumes first click, commits once, and supports another edit with new value', async () => {
  const { dom: d, container, win } = dom(); let opened = 0; const values: unknown[] = [];
  const view = createBaseCardsView(container, { result: result([row('A.md', { 'note.status': 'Todo' })], {}, ['file.name', 'note.status']),
    openFile() { opened++; }, editProperty(edit) { values.push(edit.value); } });
  const cell = container.querySelector<HTMLElement>('[data-property="note.status"]')!;
  cell.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const input = cell.querySelector('input')!; input.value = 'Doing';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); input.dispatchEvent(new win.Event('blur'));
  await tick(); assert.equal(opened, 0); assert.deepEqual(values, [{ type: 'string', value: 'Doing' }]);
  cell.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); assert.equal(cell.querySelector('input')!.value, 'Doing');
  cell.querySelector('input')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(cell.textContent, 'Doing'); view.destroy(); d.window.close();
});

test('Pending edit failures preserve drafts and defer newer snapshots until Escape', async () => {
  const { dom: d, container, win } = dom(); const failures: unknown[] = []; let reject!: (error: Error) => void;
  const data = result([row('A.md', { 'note.status': 'Todo' })], {}, ['file.name', 'note.status']);
  const view = createBaseListView(container, { result: data, openFile() {}, onError(error) { failures.push(error); },
    editProperty() { return new Promise((_resolve, fail) => { reject = fail; }); } });
  const edit = () => {
    const cell = container.querySelector<HTMLElement>('[data-property="note.status"]')!;
    cell.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const input = cell.querySelector('input')!; input.value = 'Changed'; input.dispatchEvent(new win.Event('blur')); return cell;
  };
  edit(); reject(new Error('write failed')); await tick(); assert.equal(failures.length, 1);
  const failed = container.querySelector<HTMLInputElement>('[data-property="note.status"] input')!;
  assert.equal(failed.value, 'Changed'); assert.equal(failed.disabled, false);
  assert.equal(failed.getAttribute('aria-invalid'), 'true');
  failed.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const old = edit(); view.update({ ...data, version: 2 }); reject(new Error('stale failed')); await tick();
  assert.equal(failures.length, 2); assert.equal(old.isConnected, true);
  assert.equal(old.querySelector('input')!.value, 'Changed');
  old.querySelector('input')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
  assert.equal(old.isConnected, false); assert.match(container.textContent!, /Todo/);
  view.destroy(); d.window.close();
});

test('Single observer tracks only mounted units and restores scroll anchor after measured height changes', async () => {
  const { dom: d, container, win } = dom();
  const observed = new Set<Element>(); let disconnected = false; let callback!: ResizeObserverCallback;
  class Observer {
    constructor(cb: ResizeObserverCallback) { callback = cb; }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); disconnected = true; }
  }
  Object.defineProperty(win, 'ResizeObserver', { value: Observer });
  const view = createBaseListView(container, { result: result(Array.from({ length: 1000 }, (_, i) => row(`N${i}.md`))), openFile() {} });
  assert.ok(observed.size < 40);
  const scroll = container.querySelector<HTMLElement>('.bases-virtual-scroll')!;
  scroll.scrollTop = 320; scroll.dispatchEvent(new win.Event('scroll')); await tick();
  const above = container.querySelector<HTMLElement>('[data-virtual-index="5"]')!;
  above.getBoundingClientRect = () => ({ height: 64 } as DOMRect);
  callback([{ target: above } as ResizeObserverEntry], {} as ResizeObserver); await tick();
  assert.equal(scroll.scrollTop, 354, 'expanding a 30px default row to 64px retains the visible note position');
  view.destroy(); assert.equal(observed.size, 0); assert.equal(disconnected, true); d.window.close();
});

test('Checkbox failed second write restores the last accepted state, not the original snapshot', async () => {
  const { dom: d, container, win } = dom(); let calls = 0;
  const view = createBaseListView(container, { result: result([row('A.md', { 'note.done': false })], {}, ['note.done']), openFile() {},
    editProperty() { if (++calls > 1) throw new Error('second write failed'); } });
  const input = container.querySelector<HTMLInputElement>('input')!;
  input.checked = true; input.dispatchEvent(new win.Event('change')); await tick(); assert.equal(input.checked, true);
  input.checked = false; input.dispatchEvent(new win.Event('change')); await tick(); assert.equal(input.checked, true);
  view.destroy(); d.window.close();
});

test('Failed text draft can be retried without losing edits', async () => {
  const { dom: d, container, win } = dom(); let calls = 0;
  const view = createBaseListView(container, { result: result([row('A.md', { 'note.status': 'Todo' })], {}, ['note.status']), openFile() {},
    editProperty() { if (++calls === 1) throw new Error('temporary failure'); } });
  const cell = container.querySelector<HTMLElement>('[data-property="note.status"]')!;
  cell.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const input = cell.querySelector('input')!; input.value = 'Saved draft';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
  assert.equal(cell.querySelector('input'), input); assert.equal(input.value, 'Saved draft');
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
  assert.equal(cell.textContent, 'Saved draft'); assert.equal(calls, 2);
  view.destroy(); d.window.close();
});

test('Null cards are blank, unchanged empty drafts do not write, unsupported values cannot crash views', async () => {
  const { dom: d, container, win } = dom(); let writes = 0;
  const data = result([row('A.md', { 'note.empty': null, 'note.blank': '' })], {}, ['note.empty', 'note.blank']);
  const view = createBaseCardsView(container, { result: data, openFile() {}, editProperty() { writes++; } });
  for (const property of ['note.empty', 'note.blank']) {
    const line = container.querySelector<HTMLElement>(`[data-property="${property}"]`)!;
    assert.equal(line.textContent, ''); line.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const input = line.querySelector('input')!; assert.equal(input.value, '');
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
  }
  assert.equal(writes, 0);
  const unsupported = { type: 'duration', years: 0, months: 0, days: 1, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 } as const;
  const file = { type: 'namespace', name: 'Folder/A.md', get() { throw new Error('must not call'); } } as const;
  const next = { ...data, properties: ['note.duration', 'file.file'], groups: [{ key: unsupported, rows: [{ path: 'Folder/A.md', values: { 'note.duration': unsupported, 'file.file': file } }] }] };
  view.update(next); assert.match(container.textContent!, /Error: Text conversion for duration/); assert.match(container.textContent!, /Folder\/A.md/);
  view.destroy(); d.window.close();
});

test('Invalid numeric drafts remain editable and never coerce whitespace to zero', async () => {
  const { dom: d, container, win } = dom(); let writes = 0;
  const view = createBaseListView(container, { result: result([row('A.md', { 'note.count': 1 })], {}, ['note.count']), openFile() {}, editProperty() { writes++; } });
  const line = container.querySelector<HTMLElement>('[data-property="note.count"]')!;
  line.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const input = line.querySelector('input')!;
  for (const invalid of ['bad', ' ']) {
    input.value = invalid; input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
    assert.equal(input.value, invalid); assert.equal(input.disabled, false); assert.equal(input.getAttribute('aria-invalid'), 'true');
  }
  assert.equal(writes, 0); view.destroy(); d.window.close();
});
