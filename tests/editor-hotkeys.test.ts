import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { HotkeyPreferences } from '../src/ui/hotkeys.ts';
import { runEditorCommand } from '../src/editor/editor-commands.ts';
import { tableSelectionAt } from '../src/editor/live-tables.ts';
import { foldedRanges } from '@codemirror/language';
import type { EditorOptions } from '../src/ui/editor.ts';

// Real editor integration checks. Synthetic composition events exercise our
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

function preferences() {
  const data = new Map<string, string>();
  return new HotkeyPreferences({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } }, 'other');
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function press(view: EditorView, dom: JSDOM, key = 'F7', extra: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  view.contentDOM.dispatchEvent(event); return event;
}

test('all eight formatting commands reuse Unicode multiple-selection semantics', t => {
  const { view } = setup(t, 'alpha 中😀', 'source');
  for (const [id, marker] of [['bold', '**'], ['italic', '*'], ['strikethrough', '~~'], ['code', '`'], ['math', '$'], ['comment', '%%'], ['highlight', '==']]) {
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(5, 0), EditorSelection.range(6, 9)], 1) });
    assert.equal(runEditorCommand('editor-' + id, view), true);
    assert.equal(view.state.doc.toString(), `${marker}alpha${marker} ${marker}中😀${marker}`);
    assert.equal(view.state.selection.mainIndex, 1);
    assert.ok(undo(view)); assert.equal(view.state.doc.toString(), 'alpha 中😀');
  }
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '**alpha**' }, selection: { anchor: 2, head: 7 } });
  runEditorCommand('editor-clear-formatting', view);
  assert.equal(view.state.doc.toString(), 'alpha');
});

test('effective binding changes update the same view without changing selection/history', async t => {
  const source = preferences(); source.set('editor-bold', [{ key: 'F7', modifiers: [] }]);
  const { view, dom, editor } = setup(t, 'word', 'source', { hotkeys: source });
  view.dispatch({ changes: { from: 4, insert: '!' }, selection: { anchor: 0, head: 4 }, userEvent: 'input.type' });
  const selection = view.state.selection, depth = undoDepth(view.state), element = view.contentDOM;
  source.set('editor-bold', [{ key: 'F8', modifiers: [] }]); await flush();
  assert.equal(view.contentDOM, element); assert.ok(view.state.selection.eq(selection)); assert.equal(undoDepth(view.state), depth);
  assert.equal(press(view, dom, 'F7').defaultPrevented, false);
  assert.equal(press(view, dom, 'F8').defaultPrevented, true);
  assert.equal(editor.getValue(), '**word**!');
  assert.ok(undo(view)); assert.equal(editor.getValue(), 'word!');
  assert.ok(undo(view)); assert.equal(editor.getValue(), 'word');
});

test('composition defers parent and child reconfiguration until end and takes latest preferences', async t => {
  const source = preferences(); source.set('editor-bold', [{ key: 'F7', modifiers: [] }]);
  const { view, host, dom, editor } = setup(t, '| A | B |\n| --- | --- |\n| word | other |', 'live', { hotkeys: source });
  const child = cellEditor(host, dom), original = child.contentDOM;
  child.dispatch({ selection: { anchor: 0, head: 4 } });
  let effects = 0;
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => { if (update.transactions.some(tr => tr.reconfigured)) effects++; })) });
  effects = 0;
  child.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  source.set('editor-bold', [{ key: 'F8', modifiers: [] }]);
  source.set('editor-bold', [{ key: 'F9', modifiers: [] }]); await flush();
  assert.equal(effects, 0); assert.equal(child.contentDOM, original);
  child.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(effects, 1); assert.equal(child.contentDOM, original);
  assert.equal(press(child, dom, 'F8').defaultPrevented, false);
  assert.equal(press(child, dom, 'F9').defaultPrevented, true);
  assert.ok(editor.getValue().includes('**word**'));
});

test('cell formatting forwards history isolation to its owning note', t => {
  const source = preferences(); source.set('editor-bold', [{ key: 'F7', modifiers: [] }]);
  const { view, host, dom, editor } = setup(t, '| A | B |\n| --- | --- |\n| word | other |', 'live', { hotkeys: source });
  const child = cellEditor(host, dom);
  child.dispatch({ changes: { from: 4, insert: '!' }, selection: { anchor: 0, head: 4 }, userEvent: 'input.type' });
  press(child, dom);
  assert.ok(editor.getValue().includes('**word**!'));
  assert.ok(undo(view)); assert.ok(editor.getValue().includes('word!')); assert.equal(child.state.doc.toString(), 'word!');
  assert.ok(undo(view)); assert.ok(editor.getValue().includes('| word |'));
});

test('newly activated table cells read latest preferences and release their subscription', async t => {
  const source = preferences(); let subscribed = 0;
  const original = source.subscribe.bind(source);
  source.subscribe = listener => { subscribed++; const dispose = original(listener); return () => { subscribed--; dispose(); }; };
  const { host, dom, editor, destroy } = setup(t, '| A | B |\n| --- | --- |\n| word | other |', 'live', { hotkeys: source });
  assert.equal(subscribed, 1);
  source.set('editor-bold', [{ key: 'F8', modifiers: [] }]); await flush();
  const child = cellEditor(host, dom); assert.equal(subscribed, 2);
  child.dispatch({ selection: { anchor: 0, head: 4 } }); press(child, dom, 'F8');
  assert.ok(editor.getValue().includes('**word**'));
  destroy(); assert.equal(subscribed, 0);
  source.set('editor-bold', []); await flush();
});

test('all five fold commands target the parent while a table child owns focus', t => {
  const source = preferences(); source.set('editor-fold-all', [{ key: 'F7', modifiers: [] }]);
  const text = '# Section\n\n| A | B |\n| --- | --- |\n| word | other |\n\n# Next\nbody';
  const { view, host, dom } = setup(t, text, 'live', { hotkeys: source });
  const child = cellEditor(host, dom);
  press(child, dom); assert.ok(foldedRanges(view.state).size > 0); assert.equal(view.hasFocus, true);
  for (const id of ['editor-unfold', 'editor-fold', 'editor-toggle-fold', 'editor-unfold-all', 'editor-fold-all', 'editor-unfold-all']) {
    assert.equal(runEditorCommand(id, view), true);
  }
  assert.equal(foldedRanges(view.state).size, 0);
});

test('readonly, modal, completion and invalid event ownership consume without edits or fallback', t => {
  const source = preferences(); source.set('editor-bold', [{ key: 'F7', modifiers: [] }]);
  const { view, dom } = setup(t, 'word', 'source', { hotkeys: source });
  view.dispatch({ selection: { anchor: 0, head: 4 } });
  let fallback = 0;
  view.dispatch({ effects: StateEffect.appendConfig.of(keymap.of([{ key: 'F7', run: () => { fallback++; return true; } }])) });
  for (const kind of ['modal', 'menu', 'completion']) {
    const element = document.createElement('div');
    if (kind === 'modal') element.className = 'modal-overlay';
    if (kind === 'menu') element.setAttribute('role', 'menu');
    if (kind === 'completion') element.className = 'cm-tooltip-autocomplete';
    (kind === 'completion' ? view.dom : document.body).append(element);
    assert.equal(press(view, dom).defaultPrevented, true); element.remove();
  }
  assert.equal(press(view, dom, 'F7', { repeat: true }).defaultPrevented, true);
  assert.equal(press(view, dom, 'F7', { isComposing: true }).defaultPrevented, false);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  assert.equal(press(view, dom).defaultPrevented, true);
  assert.equal(fallback, 0); assert.equal(view.state.doc.toString(), 'word');
});


test('rectangular cell formatting targets selected source spans and preserves the rectangle', t => {
  const source = preferences(); source.set('editor-bold', [{ key: 'F7', modifiers: [] }]);
  const { view, host, dom, editor } = setup(t, '| A | B |\n| --- | --- |\n| word | other |', 'live', { hotkeys: source });
  const child = cellEditor(host, dom);
  child.dispatch({ selection: { anchor: child.state.doc.length } });
  press(child, dom, 'ArrowRight', { shiftKey: true });
  assert.equal(tableSelectionAt(view, child.contentDOM), true);
  assert.equal(child.state.readOnly, true);
  press(child, dom);
  assert.ok(editor.getValue().includes('| **word** | **other** |'));
  assert.equal(tableSelectionAt(view, child.contentDOM), true);
  assert.equal(view.state.selection.ranges.length, 2);
  assert.ok(undo(view)); assert.ok(editor.getValue().includes('| word | other |'));
});


test('removing a composing table child releases deferred parent binding updates', async t => {
  const source = preferences(); source.set('editor-bold', [{ key: 'F7', modifiers: [] }]);
  const { view, host, dom, editor } = setup(t, '| A | B |\n| --- | --- |\n| word | other |', 'live', { hotkeys: source });
  const child = cellEditor(host, dom);
  child.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  source.set('editor-bold', [{ key: 'F8', modifiers: [] }]); await flush();
  editor.setValue('replacement'); view.focus();
  await new Promise(resolve => setTimeout(resolve, 60));
  view.dispatch({ selection: { anchor: 0, head: 11 } });
  assert.equal(press(view, dom, 'F8').defaultPrevented, true);
  assert.equal(editor.getValue(), '**replacement**');
});

test('macOS Option-produced characters use CodeMirror virtual-letter matching and suppress repeats', t => {
  const source = new HotkeyPreferences({ getItem: () => null, setItem: () => {} }, 'mac');
  source.set('editor-bold', [{ key: 't', modifiers: ['Mod', 'Alt'] }]);
  const { view, dom } = setup(t, 'word', 'source', { hotkeys: source });
  view.dispatch({ selection: { anchor: 0, head: 4 } });
  const event = { metaKey: true, altKey: true, keyCode: 84, which: 84 };
  assert.equal(press(view, dom, '†', event).defaultPrevented, true);
  assert.equal(view.state.doc.toString(), '**word**');
  assert.ok(undo(view));
  assert.equal(press(view, dom, '†', { ...event, repeat: true }).defaultPrevented, true);
  assert.equal(view.state.doc.toString(), 'word');
  assert.equal(press(view, dom, '†', { metaKey: true, altKey: true }).defaultPrevented, false);
  assert.equal(view.state.doc.toString(), 'word');
});
