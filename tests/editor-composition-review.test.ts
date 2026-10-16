import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { deleteCharBackward, deleteCharForward, undo, redo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';

// Independent integration checks. Synthetic composition events exercise our
// listener lifecycle, not native IME candidate windows or browser DOM input.
// Geometry shims do not prove clicks, painted selection or native caret parity.
function setup(t: TestContext, value: string, mode: 'live' | 'source' = 'live', completion: Partial<EditorOptions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
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
  const emptyRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!;
  const changes: string[] = [];
  const opened: string[] = [];
  const editor = createEditor(host, { value, mode, paths: () => ['Note.md'], onChange: text => changes.push(text), open: target => opened.push(target), ...completion });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  assert.ok(view, 'find real CodeMirror instance from its DOM');
  view.focus();
  view.dispatch({ selection: view.state.selection });
  let destroyed = false;
  const destroy = () => { if (!destroyed) { editor.destroy(); destroyed = true; } };
  t.after(() => {
    destroy();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const line = (index: number) => [...host.querySelectorAll<HTMLElement>('.cm-line')][index];
  const cursor = (position: number) => view.dispatch({ selection: { anchor: position } });
  return { editor, view, host, changes, opened, line, cursor, dom, destroy };
}


function cellEditor(host: HTMLElement, dom: JSDOM) {
  const cell = host.querySelector<HTMLElement>('.cm-live-table td')!;
  assert.ok(cell);
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.ok(child);
  return child;
}

for (const text of ['😀', '👩‍💻', '🇨🇦']) test(`table forward deletion retains valid Unicode and parent undo for ${text}`, t => {
  const source = `before\n\n| A | B |\n| --- | --- |\n| ${text}z | other |\n\nafter`;
  const { view, editor, host, dom } = setup(t, source);
  const child = cellEditor(host, dom);
  child.dispatch({ selection: { anchor: 0 } });
  assert.ok(deleteCharForward(child));
  assert.equal(child.state.doc.toString(), 'z');
  assert.equal(editor.getValue(), source.replace(`${text}z`, 'z'));
  assert.ok(undo(view));
  assert.equal(editor.getValue(), source);
  assert.equal(child.state.doc.toString(), `${text}z`);
  assert.ok(redo(view));
  assert.equal(child.state.doc.toString(), 'z');
});

test('table composition transactions preserve one child, escaped source mapping and owner history', async t => {
  const source = 'before\n\n| A | B |\n| --- | --- |\n| old | other |\n\nafter';
  const { view, editor, host, dom } = setup(t, source);
  const child = cellEditor(host, dom), childDOM = child.contentDOM;
  child.dispatch({ selection: EditorSelection.single(0, 3) });
  childDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  child.dispatch({ ...child.state.replaceSelection('に'), userEvent: 'input.type.compose' });
  child.dispatch({ changes: { from: 0, to: 1, insert: '日本|😀' }, selection: { anchor: 5 }, userEvent: 'input.type.compose' });
  assert.equal(host.querySelector('.cm-live-table .cm-content'), childDOM);
  assert.equal(editor.getValue(), source.replace('old', '日本\\|😀'));
  assert.equal(view.state.selection.main.head, editor.getValue().indexOf('日本') + '日本\\|😀'.length);
  childDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '日本|😀' }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(child.state.doc.toString(), '日本|😀');
  assert.equal(undoDepth(view.state), 1);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), source);
  assert.equal(child.state.doc.toString(), 'old');
});

test('reversed selection spanning list, embed and table replaces exact source then undo restores widgets', async t => {
  const source = 'start\n- [ ] task😀\n\n![[photo.png]]\n\n| A | B |\n| --- | --- |\n| 中 | 🇨🇦 |\n\nend';
  let destroyed = 0;
  const { view, editor, host } = setup(t, source, 'live', { renderEmbed: () => ({ dom: document.createElement('div'), destroy() { destroyed++; } }) });
  assert.ok(host.querySelector('.cm-live-embed')); assert.ok(host.querySelector('.cm-live-table'));
  const start = source.indexOf('- [ ]'), end = source.indexOf('\nend');
  view.dispatch({ selection: EditorSelection.single(end, start) });
  await Promise.resolve();
  editor.insert('replacement👩‍💻');
  assert.equal(editor.getValue(), source.slice(0, start) + 'replacement👩‍💻' + source.slice(end));
  assert.equal(destroyed, 1);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), source);
  assert.ok(host.querySelector('.cm-live-embed')); assert.ok(host.querySelector('.cm-live-table'));
  assert.equal(view.state.selection.main.anchor, end);
  assert.equal(view.state.selection.main.head, start);
});

test('embed source reveal and emoji target edits keep undo source exact', t => {
  const source = 'before\n![[😀.png]]\nafter';
  const { view, editor, host, dom } = setup(t, source, 'live', { renderEmbed: () => ({ dom: document.createElement('div'), destroy() {} }) });
  const button = host.querySelector('.cm-live-embed-edit')!;
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const position = source.indexOf('😀') + 2;
  view.dispatch({ selection: { anchor: position } });
  assert.ok(deleteCharBackward(view));
  assert.equal(editor.getValue(), source.replace('😀', ''));
  assert.ok(undo(view));
  assert.equal(editor.getValue(), source);
  assert.equal(view.state.selection.main.head, position);
});

test('secondary selection survives main selection entering a rendered table cell', async t => {
  const source = 'before\n\n| A | B |\n| --- | --- |\n| alpha | beta |\n\nafter';
  const { view, editor } = setup(t, source);
  const tablePosition = source.indexOf('alpha') + 2;
  const selection = EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(tablePosition)], 1);
  view.dispatch({ selection });
  await Promise.resolve();
  assert.deepEqual(view.state.selection.toJSON(), selection.toJSON(), 'cell activation must not discard a second caret');
  editor.insert('!');
  assert.equal(editor.getValue(), source.slice(0, 2) + '!' + source.slice(2, tablePosition) + '!' + source.slice(tablePosition));
});

test('table secondary caret with main caret outside retains both edits and undo', async t => {
  const source = 'before\n\n| A | B |\n| --- | --- |\n| alpha | beta |\n\nafter';
  const { view, editor } = setup(t, source);
  const tablePosition = source.indexOf('alpha') + 2;
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(tablePosition)], 0) });
  await Promise.resolve();
  editor.insert('!');
  assert.equal(editor.getValue(), source.slice(0, 2) + '!' + source.slice(2, tablePosition) + '!' + source.slice(tablePosition));
  assert.ok(undo(view));
  assert.equal(editor.getValue(), source);
  assert.equal(view.state.selection.ranges.length, 2);
});
