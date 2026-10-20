import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveTables } from '../src/editor/live-tables.ts';

test('a rejected owner edit restores the table cell and its coordinates before subsequent typing', t => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const source = '| A | B |\n| --- | --- |\n| one | two |';
  const host = document.querySelector<HTMLElement>('#host')!;
  const owner = new EditorView({ parent: host,
    state: EditorState.create({ doc: source, extensions: [markdown({ base: markdownLanguage }), history(), liveTables(() => {})] }),
    dispatchTransactions(transactions, target) {
      if (transactions.some(transaction => transaction.docChanged && transaction.newDoc.length > source.length + 1)) return;
      target.update(transactions);
    },
  });
  t.after(() => {
    owner.destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const cell = host.querySelector<HTMLElement>('[data-row="1"][data-column="0"]')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  child.dispatch({ selection: EditorSelection.single(1, 2) });
  const beforeChild = child.state, beforeOwner = owner.state;
  child.dispatch({ ...child.state.replaceSelection('long|rejected\ntext'), filter: false });
  assert.ok(owner.state === beforeOwner, 'owner rejects the edit without changing state');
  assert.ok(child.state === beforeChild, 'child restores its exact state after owner rejection');
  assert.equal(child.state.doc.toString(), 'one');
  assert.equal(undoDepth(owner.state), 0);
  assert.equal(undoDepth(child.state), 0);
  assert.equal(child.hasFocus, true);
  child.dispatch(child.state.replaceSelection('!'));
  assert.equal(owner.state.doc.toString(), source.replace('one', 'o!e'));
  assert.equal(child.state.doc.toString(), 'o!e');
  assert.equal(undoDepth(owner.state), 1);
  assert.ok(undo(owner));
  assert.equal(owner.state.doc.toString(), source);
  assert.equal(child.state.doc.toString(), 'one');
});
