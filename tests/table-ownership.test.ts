import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveTables } from '../src/editor/live-tables.ts';
type Range = { from: number; to: number };
const exclude = StateEffect.define<readonly Range[]>();
const excludedField = StateField.define<readonly Range[]>({ create: () => [],
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(exclude)) value = effect.value; return value; } });
// Actual CM widgets and DOM events. Geometry stubs do not establish browser
// hover appearance, hit testing, touch, or reference runtime equivalence.
function setup(t: TestContext, value: string) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true, url: 'https://app.local/index.html' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, entry] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: entry });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!, changes: string[] = [];
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: value,
    extensions: [markdown({ base: markdownLanguage }), excludedField, liveTables(() => {}, [], state => state.field(excludedField))] }) });
  const editor = { destroy: () => view.destroy() };
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  const button = (kind: 'row' | 'column') => host.querySelector<HTMLButtonElement>(`.cm-table-add-${kind}`)!;
  const active = () => {
    const node = host.querySelector('.cm-live-table .cm-editor'); assert.ok(node);
    return EditorView.findFromDOM(node)!;
  };
  const activate = (row: number, column: number) => {
    const cell = host.querySelector<HTMLElement>(`.cm-live-table [data-row="${row}"][data-column="${column}"]`)!;
    assert.ok(cell);
    cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    return active();
  };
  return { dom, host, editor, view, changes, destroy, click, button, active, activate };
}



const table = '| A | B |\n| --- | --- |\n| one | two |';
const source = `Before\n\n${table}\n\nBetween\n\n${table}\n\nAfter`;

test('ownership-only transactions hide and restore a table while retaining unaffected table identity and cell selection', t => {
  const { view, host, dom } = setup(t, source);
  const [first, second] = [...host.querySelectorAll('.cm-live-table')];
  assert.ok(first); assert.ok(second);
  const cell = second.querySelector<HTMLElement>('td')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(second.querySelector('.cm-editor')!)!;
  child.dispatch({ selection: { anchor: 1, head: 2 } });
  const firstFrom = source.indexOf(table);
  view.dispatch({ effects: exclude.of([{ from: firstFrom + 1, to: firstFrom + 2 }]) });
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  assert.equal(host.querySelector('.cm-live-table'), second);
  assert.equal(child.state.selection.main.anchor, 1); assert.equal(child.state.selection.main.head, 2);
  assert.equal(child.hasFocus, true);
  view.dispatch({ effects: exclude.of([]) });
  assert.equal(host.querySelectorAll('.cm-live-table').length, 2);
  assert.equal(host.querySelectorAll('.cm-live-table')[1], second);
  assert.equal(view.state.doc.toString(), source);
});

test('unsorted overlapping exclusions merge and touching boundaries do not suppress tables', t => {
  const { view, host } = setup(t, source);
  const first = source.indexOf(table), second = source.lastIndexOf(table);
  view.dispatch({ effects: exclude.of([{ from: second, to: second + 2 }, { from: first - 2, to: first },
    { from: second + 1, to: second + 3 }, { from: first + table.length, to: first + table.length + 1 }]) });
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  const remaining = host.querySelector('.cm-live-table');
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(host.querySelector('.cm-live-table'), remaining);
});
