import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { tableSelectionAt, tableSelectionRanges, tableSelectionAnnotation } from '../src/editor/live-tables.ts';
import { formatMenuForEditor } from '../src/editor/format-menu.ts';
import type { FormatMenuItem } from '../src/editor/format-menu.ts';
// Actual CM widgets and DOM events. Geometry stubs do not establish browser
// hover appearance, hit testing, touch, or reference runtime equivalence.
function setup(t: TestContext, value: string) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true });
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
  const editor = createEditor(host, { value, mode: 'live', paths: () => [], open() {}, onChange: value => changes.push(value) });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
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



const source = '| A | B |\n| --- | --- |\n| word | other |';
function rectangle(f: ReturnType<typeof setup>) {
  const child = f.activate(1, 0);
  child.dispatch({ selection: { anchor: child.state.doc.length } });
  child.contentDOM.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
  assert.ok(tableSelectionAt(f.view, child.contentDOM));
  return child;
}
function bold(f: ReturnType<typeof setup>, child: EditorView) {
  const find = (items: FormatMenuItem[]): (() => boolean) | undefined => {
    for (const item of items) {
      if ('id' in item && item.id === 'format-bold' && 'run' in item) return item.run;
      if ('submenu' in item) { const result = find(item.submenu); if (result) return result; }
    }
  };
  const action = find(formatMenuForEditor(f.view, { ranges: () => tableSelectionRanges(f.view, child.contentDOM), annotations: [tableSelectionAnnotation] }));
  assert.ok(action); assert.equal(action(), true);
}

test('annotated rectangle formatting retains the widget, child, ranges and repeat-command ownership', async t => {
  const f = setup(t, source), child = rectangle(f), table = f.host.querySelector('.cm-live-table');
  bold(f, child);
  assert.equal(f.editor.getValue(), source.replace('word', '**word**').replace('other', '**other**'));
  assert.equal(f.host.querySelector('.cm-live-table'), table);
  assert.ok(child.dom.isConnected); assert.ok(tableSelectionAt(f.view, child.contentDOM));
  assert.equal(f.view.state.selection.ranges.length, 2);
  f.view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.lineWrapping) }); await Promise.resolve();
  assert.equal(f.host.querySelector('.cm-live-table'), table); assert.ok(tableSelectionAt(f.view, child.contentDOM));
  f.view.dispatch({ changes: { from: 0, insert: 'prefix\n\n' } }); await Promise.resolve();
  assert.equal(f.host.querySelector('.cm-live-table'), table); assert.ok(child.dom.isConnected);
  assert.ok(tableSelectionAt(f.view, child.contentDOM));
  bold(f, child); assert.equal(f.editor.getValue(), 'prefix\n\n' + source);
  assert.ok(tableSelectionAt(f.view, child.contentDOM));
  assert.equal(undo(f.view), true);
});

test('ordinary multicursor selection still reveals source after a rectangle-owned formatting transaction', async t => {
  const f = setup(t, source + '\n\nafter'), child = rectangle(f);
  bold(f, child);
  const text = f.editor.getValue(), selection = EditorSelection.create([EditorSelection.cursor(text.indexOf('word')), EditorSelection.cursor(text.length)], 1);
  f.view.dispatch({ selection }); await Promise.resolve();
  assert.equal(f.host.querySelector('.cm-live-table'), null);
  assert.deepEqual(f.view.state.selection.toJSON(), selection.toJSON());
});

test('the real rectangle context-menu bold action retains its selected cells after native reply', async t => {
  const f = setup(t, source), child = rectangle(f);
  let choose!: (id: string | null) => void;
  Object.defineProperty(f.dom.window, 'zorid', { value: { showContextMenu: () => new Promise<string | null>(resolve => { choose = resolve; }) } });
  child.contentDOM.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  choose('format-format-bold'); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.editor.getValue(), source.replace('word', '**word**').replace('other', '**other**'));
  assert.ok(child.dom.isConnected); assert.ok(child.hasFocus); assert.ok(tableSelectionAt(f.view, child.contentDOM));
});
