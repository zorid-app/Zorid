import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseCardsView } from '../src/bases/cards-view.ts';
import { createBaseListView } from '../src/bases/list-view.ts';
import { createBaseVirtualSurface } from '../src/bases/presentation-common.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';
import type { BaseQueryResult, BaseQueryRow } from '../src/bases/query.ts';

function row(path: string, values: Record<string, unknown> = {}): BaseQueryRow {
  return { path, values: Object.fromEntries(Object.entries({ 'file.name': path, ...values }).map(([key, value]) => [key, baseExpressionValue(value)])) };
}
function result(rows: BaseQueryRow[], properties: string[], view: Record<string, unknown> = {}): BaseQueryResult {
  return { version: 1, rows, groups: [{ key: null, rows }], groupOptions: [], properties, availableProperties: properties,
    view: { type: 'cards', name: 'View', ...view }, counts: { scanned: rows.length, matched: rows.length, afterGroupOrder: rows.length, afterSearch: rows.length, returned: rows.length }, diagnostics: [] };
}
function setup(t: TestContext) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const host = dom.window.document.querySelector<HTMLElement>('main')!;
  const click = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  return { dom, host, click };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 25));

for (const [name, create] of [['Cards', createBaseCardsView], ['List', createBaseListView]] as const) {
  test(`${name} rejected checkbox change restores last accepted value`, async t => {
    const { dom, host } = setup(t); let attempts = 0;
    const view = create(host, { result: result([row('A.md', { 'note.done': false })], ['note.done']), openFile() {},
      editProperty() { if (++attempts === 2) return Promise.reject(new Error('write rejected')); }, onError() {} });
    t.after(() => view.destroy());
    let input = host.querySelector<HTMLInputElement>('input')!;
    input.checked = true; input.dispatchEvent(new dom.window.Event('change')); await tick();
    assert.equal(host.querySelector<HTMLInputElement>('input')!.checked, true);
    input = host.querySelector<HTMLInputElement>('input')!;
    input.checked = false; input.dispatchEvent(new dom.window.Event('change')); await tick();
    assert.equal(attempts, 2);
    assert.equal(host.querySelector<HTMLInputElement>('input')!.checked, true, 'failed second write must retain the first accepted value');
  });

  test(`${name} keeps rejected text draft available for retry`, async t => {
    const { dom, host, click } = setup(t); const attempts: unknown[] = [];
    const view = create(host, { result: result([row('A.md', { 'note.title': 'Original' })], ['note.title']), openFile() {},
      editProperty(edit) { attempts.push(edit.value); if (attempts.length === 1) return Promise.reject(new Error('temporary failure')); }, onError() {} });
    t.after(() => view.destroy());
    click(host.querySelector('[data-property="note.title"]')!);
    const input = host.querySelector<HTMLInputElement>('input')!; input.value = 'Unsaved draft';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
    const draft = host.querySelector<HTMLInputElement>('input');
    assert.ok(draft, 'failure retains a recoverable input'); assert.equal(draft.value, 'Unsaved draft'); assert.equal(draft.disabled, false);
    draft.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
    assert.deepEqual(attempts, [{ type: 'string', value: 'Unsaved draft' }, { type: 'string', value: 'Unsaved draft' }]);
    assert.match(host.textContent!, /Unsaved draft/);
  });

  test(`${name} throwing custom disposer cannot strand sibling resources`, t => {
    const { host } = setup(t); let disposed = 0;
    const view = create(host, { result: result([row('A.md'), row('B.md'), row('C.md')], ['file.name']), openFile() {}, onError() {},
      renderProperty(element, context) { element.textContent = context.row.path; return () => { disposed++; if (context.row.path === 'A.md') throw new Error('widget cleanup failed'); }; } });
    t.after(() => { try { view.destroy(); } catch {} });
    assert.doesNotThrow(() => view.destroy()); assert.equal(disposed, 3); assert.equal(host.children.length, 0);
  });
}

test('late thumbnail resolution after scroll recycle cannot attach to newly mounted card', async t => {
  const { dom, host } = setup(t); const pending: { path: string; signal: AbortSignal; resolve: (resource: { url: string; dispose(): void }) => void }[] = [];
  const rows = Array.from({ length: 200 }, (_, index) => row(`N${index}.md`, { 'note.cover': 'cover.png' }));
  const view = createBaseCardsView(host, { result: result(rows, ['file.name'], { image: 'cover', cardSize: 200 }), openFile() {},
    loadThumbnail(request) { return new Promise(resolve => pending.push({ path: request.row.path, signal: request.signal, resolve })); } });
  t.after(() => view.destroy()); await tick();
  const original = pending.find(request => request.path === 'N0.md')!;
  const scroll = host.querySelector<HTMLElement>('.bases-virtual-scroll')!;
  scroll.scrollTop = 6000; scroll.dispatchEvent(new dom.window.Event('scroll')); await tick();
  assert.equal(original.signal.aborted, true);
  let released = 0; original.resolve({ url: 'blob:old', dispose() { released++; } }); await tick();
  assert.equal(released, 1); assert.equal(host.querySelector('img[src="blob:old"]'), null);
  scroll.scrollTop = 0; scroll.dispatchEvent(new dom.window.Event('scroll')); await tick();
  assert.equal(pending.filter(request => request.path === 'N0.md').length, 2);
  assert.equal(host.querySelector('img[src="blob:old"]'), null);
});

test('retired card links and controls cannot invoke host callbacks', async t => {
  const { dom, host, click } = setup(t); let opened = 0, edited = 0;
  const data = result([row('A.md', { 'note.title': 'Old' })], ['file.name', 'note.title']);
  const view = createBaseCardsView(host, { result: data, openFile() { opened++; }, editProperty() { edited++; } });
  t.after(() => view.destroy());
  const oldCard = host.querySelector<HTMLElement>('.bases-cards-item')!, oldLink = oldCard.querySelector('a')!;
  click(oldCard.querySelector('[data-property="note.title"]')!); const oldInput = oldCard.querySelector('input')!;
  view.update({ ...data, version: 2 }); click(oldLink); click(oldCard);
  oldInput.value = 'stale'; oldInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick();
  assert.equal(opened, 0); assert.equal(edited, 0); assert.match(host.textContent!, /Old/);
});

test('measured virtual row boundaries include exact viewport edges and maintain total height', async t => {
  const { dom, host } = setup(t); let callback!: ResizeObserverCallback;
  const observed = new Set<Element>();
  Object.defineProperty(dom.window, 'ResizeObserver', { value: class {
    constructor(cb: ResizeObserverCallback) { callback = cb; }
    observe(element: Element) { observed.add(element); } unobserve(element: Element) { observed.delete(element); } disconnect() { observed.clear(); }
  } });
  const surface = createBaseVirtualSurface(host, 'test-surface', () => Array.from({ length: 100 }, (_, index) => ({ key: String(index), height: 32,
    mount() { const element = dom.window.document.createElement('div'); element.textContent = String(index); return { element, dispose() {} }; } })));
  t.after(() => surface.destroy()); surface.refresh();
  const first = host.querySelector<HTMLElement>('[data-virtual-index="0"]')!;
  first.getBoundingClientRect = () => ({ height: 64 } as DOMRect);
  callback([{ target: first } as ResizeObserverEntry], {} as ResizeObserver); await tick();
  assert.equal(host.querySelector<HTMLElement>('.bases-virtual-content')!.style.height, '3232px');
  surface.element.scrollTop = 364; surface.element.dispatchEvent(new dom.window.Event('scroll')); await tick();
  assert.equal(host.querySelector('[data-virtual-index="0"]'), null, 'overscan starts exactly after taller first row');
  assert.equal(host.querySelector<HTMLElement>('[data-virtual-index="1"]')!.style.top, '64px');
  surface.element.scrollTop = 363; surface.element.dispatchEvent(new dom.window.Event('scroll')); await tick();
  assert.ok(host.querySelector('[data-virtual-index="0"]'), 'one pixel before boundary keeps intersecting row');
  surface.destroy(); assert.equal(observed.size, 0);
});

for (const [name, create] of [['Cards', createBaseCardsView], ['List', createBaseListView]] as const) {
  test(`${name} incomplete numeric draft cannot be mistaken for intentional null`, async t => {
    const { dom, host, click } = setup(t); const edits: unknown[] = [];
    const view = create(host, { result: result([row('A.md', { 'note.score': 7 })], ['note.score']), openFile() {}, editProperty(edit) { edits.push(edit.value); } });
    t.after(() => view.destroy()); click(host.querySelector('[data-property="note.score"]')!);
    const input = host.querySelector<HTMLInputElement>('input')!;
    input.value = '1e';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick();
    assert.deepEqual(edits, [], 'invalid numeric draft must not clear existing value');
    assert.equal(host.querySelector('input'), input, 'invalid draft stays available to correct');
    assert.equal(input.value, '1e');
    input.value = ''; input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick();
    assert.deepEqual(edits, [{ type: 'null' }], 'deliberately clearing valid numeric input writes typed null');
  });

  test(`${name} collapsed typed-null group stays distinct from false, zero and string null`, t => {
    const { host, click } = setup(t);
    const rows = ['Empty', 'False', 'Zero', 'Text'].map(name => row(`${name}.md`));
    const data = { ...result(rows, ['file.name']), groups: [null, false, 0, 'null'].map((key, index) => ({ key: baseExpressionValue(key), rows: [rows[index]] })) };
    const view = create(host, { result: data, openFile() {} }); t.after(() => view.destroy());
    click(host.querySelector('.bases-group-heading')!);
    const selector = name === 'Cards' ? '.bases-cards-item' : '.bases-list-item';
    assert.deepEqual([...host.querySelectorAll<HTMLElement>(selector)].map(node => node.dataset.path), ['False.md', 'Zero.md', 'Text.md']);
    view.update({ ...data, version: 2, groups: [...data.groups].reverse() });
    assert.deepEqual([...host.querySelectorAll<HTMLElement>(selector)].map(node => node.dataset.path), ['Text.md', 'Zero.md', 'False.md']);
    const last = [...host.querySelectorAll('.bases-group-heading')].at(-1)!;
    assert.equal(last.getAttribute('aria-expanded'), 'false'); click(last);
    assert.equal(host.querySelectorAll(selector).length, 4);
  });
}
