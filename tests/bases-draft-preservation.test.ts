import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseCardsView } from '../src/bases/cards-view.ts';
import { createBaseListView } from '../src/bases/list-view.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 25));
function result(version = 1, value: unknown = 'Original', count = 1, grouped = false): BaseQueryResult {
  const rows = Array.from({ length: count }, (_, i) => ({ path: `Note${i}.md`, values: { 'note.value': baseExpressionValue(value) } }));
  return { version, view: { type: 'list', name: 'View' }, rows, groups: [{ key: grouped ? baseExpressionValue('Group') : null, rows }],
    groupOptions: [], properties: ['note.value'], availableProperties: ['note.value'], diagnostics: [],
    counts: { scanned: count, matched: count, afterGroupOrder: count, afterSearch: count, returned: count } };
}
for (const [name, create] of [['Cards', createBaseCardsView], ['List', createBaseListView]] as const) {
  function setup() {
    const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true });
    const host = dom.window.document.querySelector<HTMLElement>('main')!;
    const begin = () => {
      const cell = host.querySelector<HTMLElement>('[data-property="note.value"]')!;
      cell.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      return cell.querySelector<HTMLInputElement>('input')!;
    };
    const key = (input: HTMLInputElement, key: string) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    return { dom, host, begin, key };
  }
  test(`${name} queues only latest result and preserves original draft write revision`, async t => {
    const { dom, host, begin, key } = setup(); t.after(() => dom.window.close());
    const writes: unknown[] = [], states: boolean[] = [];
    const view = create(host, { result: result(), openFile() {}, onEditStateChange: active => states.push(active),
      editProperty(edit) { writes.push(edit); throw new Error('stale property version'); } }); t.after(() => view.destroy());
    const input = begin(); input.value = 'Draft'; input.setSelectionRange(1, 4);
    view.update(result(2, 'Second')); view.update(result(3, 'Third'));
    assert.equal(view.hasActiveEdits(), true); assert.equal(input.isConnected, true); assert.equal(input.selectionStart, 1);
    key(input, 'Enter'); await tick();
    assert.deepEqual(writes, [{ version: 1, path: 'Note0.md', property: 'note.value', value: { type: 'string', value: 'Draft' } }]);
    assert.equal(input.value, 'Draft'); assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(view.hasActiveEdits(), true);
    key(input, 'Escape'); await tick();
    assert.equal(view.hasActiveEdits(), false); assert.equal(input.isConnected, false); assert.match(host.textContent!, /Third/);
    assert.deepEqual(states, [true, false]);
  });
  test(`${name} unfocused failed drafts survive resize, group collapse and scroll recycling`, async t => {
    const { dom, host, begin, key } = setup(); t.after(() => dom.window.close());
    const view = create(host, { result: result(1, 'Original', 1000, true), openFile() {}, editProperty() { throw new Error('write failed'); } }); t.after(() => view.destroy());
    const input = begin(); input.value = 'Unsent'; key(input, 'Enter'); await tick();
    dom.window.document.querySelector<HTMLButtonElement>('#outside')!.focus(); await tick();
    view.refreshLayout(); dom.window.dispatchEvent(new dom.window.Event('resize'));
    host.querySelector('.bases-group-heading')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const scroll = host.querySelector<HTMLElement>('.bases-virtual-scroll')!;
    scroll.scrollTop = 10_000; scroll.dispatchEvent(new dom.window.Event('scroll')); await tick();
    assert.equal(input.isConnected, true); assert.equal(input.value, 'Unsent'); assert.equal(view.hasActiveEdits(), true);
    assert.notEqual(dom.window.document.activeElement, input);
    key(input, 'Escape'); await tick(); assert.equal(input.isConnected, false); assert.equal(view.hasActiveEdits(), false);
    assert.equal(host.querySelector('.bases-group-heading')!.getAttribute('aria-expanded'), 'false');
  });
  test(`${name} composing blur waits for final text and keeps queued result intact until save settles`, async t => {
    const { dom, host, begin, key } = setup(); t.after(() => dom.window.close());
    const writes: unknown[] = []; let resolve!: () => void;
    const view = create(host, { result: result(), openFile() {}, editProperty(edit) { writes.push(edit); return new Promise<void>(done => { resolve = done; }); } }); t.after(() => view.destroy());
    const input = begin(); input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })); input.value = '中';
    view.update(result(2, 'Refreshed')); view.refreshLayout(); input.dispatchEvent(new dom.window.Event('blur')); key(input, 'Enter'); key(input, 'Escape');
    assert.equal(input.isConnected, true); assert.deepEqual(writes, []); assert.equal(view.hasActiveEdits(), true);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中文' })); input.value = '中文';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await tick();
    assert.deepEqual(writes, [{ version: 1, path: 'Note0.md', property: 'note.value', value: { type: 'string', value: '中文' } }]);
    assert.equal(input.disabled, true); key(input, 'Escape'); assert.equal(view.hasActiveEdits(), true);
    resolve(); await tick(); assert.equal(view.hasActiveEdits(), false); assert.equal(input.isConnected, false); assert.match(host.textContent!, /Refreshed/);
  });
  test(`${name} pending checkbox retains owner until async callback and DOM restoration finish`, async t => {
    const { dom, host } = setup(); t.after(() => dom.window.close()); let resolve!: () => void;
    const states: boolean[] = [];
    const view = create(host, { result: result(1, false), openFile() {}, onEditStateChange: active => states.push(active),
      editProperty() { return new Promise<void>(done => { resolve = done; }); } }); t.after(() => view.destroy());
    const input = host.querySelector<HTMLInputElement>('input')!; input.checked = true; input.dispatchEvent(new dom.window.Event('change'));
    view.update(result(2, true)); view.refreshLayout(); assert.equal(view.hasActiveEdits(), true); assert.equal(input.isConnected, true);
    await tick(); resolve(); await tick();
    assert.equal(view.hasActiveEdits(), false); assert.equal(input.isConnected, false); assert.equal(host.querySelector<HTMLInputElement>('input')!.checked, true);
    assert.deepEqual(states, [true, false]);
  });
  test(`${name} edit-state callback never reports idle while remounted custom widget owns a draft`, async t => {
    const { dom, host } = setup(); t.after(() => dom.window.close()); const states: boolean[] = [];
    const view = create(host, { result: result(), openFile() {}, onEditStateChange: active => states.push(active),
      renderProperty(element) { element.dataset.baseEditing = 'draft'; } }); t.after(() => view.destroy());
    await tick(); view.update(result(2));
    host.querySelector('[data-property]')!.removeAttribute('data-base-editing'); await tick();
    assert.equal(view.hasActiveEdits(), true); assert.deepEqual(states, [true]);
  });
  test(`${name} failed custom widget mount cannot leave a permanent draft marker`, async t => {
    const { dom, host } = setup(); t.after(() => dom.window.close()); let failures = 0;
    const view = create(host, { result: result(), openFile() {}, onError() { failures++; },
      renderProperty(element, context) {
        if (context.version === 1) { element.dataset.baseEditing = 'draft'; throw new Error('widget mount failed'); }
        element.textContent = 'Recovered';
      } }); t.after(() => view.destroy());
    assert.equal(view.hasActiveEdits(), false); assert.equal(failures, 1);
    view.update(result(2)); await tick(); assert.match(host.textContent!, /Recovered/); assert.equal(view.hasActiveEdits(), false);
  });
  test(`${name} custom property widgets can mark drafts and release deferred changes`, async t => {
    const { dom, host } = setup(); t.after(() => dom.window.close());
    const view = create(host, { result: result(), openFile() {}, renderProperty(element, context) {
      element.textContent = String(context.version); if (context.version === 1) element.dataset.baseEditing = 'draft';
    } }); t.after(() => view.destroy());
    const cell = host.querySelector<HTMLElement>('[data-property]')!;
    assert.equal(view.hasActiveEdits(), true); view.update(result(2)); assert.equal(cell.isConnected, true);
    cell.removeAttribute('data-base-editing'); await tick(); assert.equal(cell.isConnected, false); assert.match(host.textContent!, /2/);
  });
}
