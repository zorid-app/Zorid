import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { SearchQuery, openSearchPanel, searchPanelOpen, getSearchQuery, setSearchQuery } from '@codemirror/search';
import { undoDepth, undo } from '@codemirror/commands';
import { noteFindPanel } from '../src/editor/find-panel.ts';
import { createEditor } from '../src/ui/editor.ts';
import { runEditorCommand } from '../src/editor/editor-commands.ts';

// Actual CodeMirror integration with DOM geometry shims. This does not establish
// painted layout, native keyboard/IME or Reading-mode behavior.
function setup(t: TestContext, text: string, readOnly = false, plain = false, external = false) {
  const dom = new JSDOM('<!doctype html><body><div id="find-host"></div><div id="host"></div></body>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!, changes: string[] = [];
  const findHost = document.querySelector<HTMLElement>('#find-host')!, panelRoot = external ? findHost : host;
  let view: EditorView;
  const editor = plain ? (() => { view = new EditorView({ parent: host, doc: text, extensions: [noteFindPanel()] }); return { destroy: () => view.destroy(), getValue: () => view.state.doc.toString() }; })() : createEditor(host, { value: text, mode: 'source', paths: () => [], open() {}, onChange: value => changes.push(value), canMutate: () => !readOnly, ...(external ? { findPanelHost: findHost, onNativeEditorState() {} } : {}) });
  view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let destroyed = false;
  const destroy = () => { if (!destroyed) { editor.destroy(); destroyed = true; } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const press = (target: Element, key: string, extra: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event;
  };
  const field = () => panelRoot.querySelector<HTMLInputElement>('input[name="search"]')!;
  const input = (text: string) => { field().value = text; field().dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, data: text })); };
  const button = (label: string) => { const node = panelRoot.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(node, label); return node; };
  const count = () => panelRoot.querySelector('.zorid-find-count')!.textContent;
  const option = (name: string, checked: boolean) => { const node = panelRoot.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; node.checked = checked; node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  return { dom, host, findHost, editor, view, changes, destroy, press, field, input, button, count, option };
}

test('primary-F opens the top panel with seeded selection; navigation wraps and close restores focus without edits', t => {
  const f = setup(t, 'one 😀 one\none'), primary = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };
  f.view.dispatch({ selection: { anchor: 0, head: 3 } }); f.view.focus();
  assert.equal(f.press(f.view.contentDOM, 'f', primary).defaultPrevented, true);
  assert.equal(searchPanelOpen(f.view.state), true);
  assert.ok(f.host.querySelector('.cm-panels-top .cm-search.zorid-find-panel'));
  assert.ok(f.host.querySelector('.zorid-find-field > svg[aria-hidden="true"]'));
  assert.ok(f.button('Next match').querySelector('svg[aria-hidden="true"]'));
  assert.equal(f.field().value, 'one'); assert.equal(document.activeElement, f.field()); assert.equal(f.count(), '1 / 3');
  const depth = undoDepth(f.view.state);
  assert.equal(f.press(f.field(), 'Enter').defaultPrevented, true); assert.equal(f.count(), '2 / 3');
  f.press(f.field(), 'Enter'); assert.equal(f.count(), '3 / 3');
  f.press(f.field(), 'Enter'); assert.equal(f.count(), '1 / 3');
  f.press(f.field(), 'Enter', { shiftKey: true }); assert.equal(f.count(), '3 / 3');
  f.press(f.field(), 'g', primary); assert.equal(f.count(), '1 / 3');
  f.press(f.field(), 'F3', { shiftKey: true }); assert.equal(f.count(), '3 / 3');
  const selection = f.view.state.selection;
  f.press(f.field(), 'Escape');
  assert.equal(searchPanelOpen(f.view.state), false); assert.equal(document.activeElement, f.view.contentDOM);
  assert.ok(f.view.state.selection.eq(selection)); assert.equal(undoDepth(f.view.state), depth);
  assert.deepEqual(f.changes, []); assert.equal(f.editor.getValue(), 'one 😀 one\none');
});

test('find uses unsaved document changes, real options, external query updates and multiple matches per line', t => {
  const f = setup(t, 'cat Cat concatenate\ncat 😀 cat'); openSearchPanel(f.view); f.input('cat');
  assert.equal(f.count(), '0 / 5'); assert.equal(getSearchQuery(f.view.state).caseSensitive, false);
  f.button('Search options').click(); assert.equal(f.button('Search options').getAttribute('aria-expanded'), 'true');
  f.option('word', true); assert.equal(f.count(), '0 / 4');
  f.option('case', true); assert.equal(f.count(), '0 / 3');
  const before = undoDepth(f.view.state);
  f.view.dispatch({ changes: { from: f.view.state.doc.length, insert: ' cat' }, userEvent: 'input.type' });
  assert.equal(f.count(), '0 / 4'); assert.equal(undoDepth(f.view.state), before + 1);
  f.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '😀|Cat', regexp: true, caseSensitive: true })) });
  assert.equal(f.field().value, '😀|Cat'); assert.equal(f.count(), '0 / 2');
  assert.equal(f.host.querySelector<HTMLInputElement>('input[name="regexp"]')!.checked, true);
  f.input('['); assert.equal(f.host.querySelector('.cm-search')!.getAttribute('data-state'), 'invalid');
  assert.equal(f.field().getAttribute('aria-invalid'), 'true'); assert.equal(f.count(), 'Invalid regex'); assert.equal(f.button('Next match').disabled, true);
  f.option('regexp', false); f.input('not present'); assert.equal(f.count(), '0 / 0');
  assert.equal(f.host.querySelector('.cm-search')!.getAttribute('data-state'), 'no-match');
  f.input(''); assert.equal(f.host.querySelector<HTMLElement>('.zorid-find-count')!.hidden, true);
});

test('pointer navigation retains input focus and IME composition cannot commit or navigate early', t => {
  const f = setup(t, '猫 猫 cat'); openSearchPanel(f.view); f.input('cat');
  f.field().dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  f.field().value = '猫'; f.field().dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true, isComposing: true }));
  f.view.dispatch({ selection: { anchor: 1 } });
  assert.equal(f.field().value, '猫', 'an unrelated CM update must preserve the input composition');
  const compositionSelection = f.view.state.selection;
  f.press(f.field(), 'Enter', { isComposing: true }); f.button('Next match').click();
  assert.equal(getSearchQuery(f.view.state).search, 'cat'); assert.ok(f.view.state.selection.eq(compositionSelection));
  f.field().dispatchEvent(new f.dom.window.CompositionEvent('compositionend', { bubbles: true }));
  assert.equal(getSearchQuery(f.view.state).search, '猫'); assert.equal(f.count(), '0 / 2');
  const down = new f.dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  f.button('Next match').dispatchEvent(down); assert.equal(down.defaultPrevented, true);
  f.button('Next match').click(); assert.equal(f.count(), '2 / 2'); assert.equal(document.activeElement, f.field());
  f.button('Close find').click(); assert.equal(document.activeElement, f.view.contentDOM); assert.equal(searchPanelOpen(f.view.state), false);
});

test('existing replace and select-all behavior remains available without replacing editor/history', t => {
  const f = setup(t, 'cat cat'); openSearchPanel(f.view); f.input('cat');
  f.button('Search options').click(); f.button('Select all matches').click();
  assert.deepEqual(f.view.state.selection.ranges.map(range => [range.from, range.to]), [[0, 3], [4, 7]]);
  f.button('Show replace').click();
  const replacement = f.host.querySelector<HTMLInputElement>('input[name="replace"]')!;
  assert.equal(document.activeElement, replacement); replacement.value = 'dog'; replacement.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  f.button('Replace all matches').click(); assert.equal(f.editor.getValue(), 'dog dog');
  assert.ok(undo(f.view)); assert.equal(f.editor.getValue(), 'cat cat');
});

test('read-only find remains usable and never exposes replacement writes', t => {
  const f = setup(t, 'cat cat', true); openSearchPanel(f.view); f.input('cat');
  assert.equal(f.count(), '0 / 2'); f.button('Next match').click(); assert.equal(f.count(), '1 / 2');
  assert.equal(f.button('Show replace').hidden, true); assert.equal(f.button('Replace all matches').disabled, true);
  f.button('Replace all matches').click(); assert.equal(f.editor.getValue(), 'cat cat'); assert.deepEqual(f.changes, []);
});

test('large occurrence counts are explicit lower bounds and destroyed panels ignore retained controls', t => {
  const f = setup(t, 'a '.repeat(10_002)); openSearchPanel(f.view); f.input('a');
  assert.equal(f.count(), '0 / 10,000+'); assert.match(f.host.querySelector('.zorid-find-count')!.getAttribute('aria-label')!, /more than 10,000/);
  const retained = f.button('Next match'); f.destroy();
  assert.doesNotThrow(() => retained.click());
});


test('overlapping backward matches never claim a false current occurrence number', t => {
  const f = setup(t, 'aaa'); openSearchPanel(f.view); f.input('aa');
  f.button('Previous match').click();
  assert.deepEqual([f.view.state.selection.main.from, f.view.state.selection.main.to], [1, 3]);
  assert.equal(f.count(), '— / 1');
  assert.match(f.host.querySelector('.zorid-find-count')!.getAttribute('aria-label')!, /outside the counted non-overlapping/);
});
test('select-all discloses the existing CM cap instead of offering a silent no-op', t => {
  const f = setup(t, 'a '.repeat(1001), false, true); openSearchPanel(f.view); f.input('a');
  assert.equal(f.count(), '0 / 1,001'); assert.equal(f.button('Select all matches').disabled, true);
  const before = f.view.state.selection;
  f.press(f.field(), 'Enter', { altKey: true });
  assert.ok(f.view.state.selection.eq(before)); assert.equal(f.button('Search options').getAttribute('aria-expanded'), 'true');
  assert.match(f.host.querySelector('.zorid-find-limit-help')!.textContent!, /up to 1,000/);
});
test('large no-match notes skip count scanning without disabling valid-query navigation', t => {
  const original = SearchQuery.prototype.getCursor; let scans = 0;
  SearchQuery.prototype.getCursor = function (...args) { scans++; return original.apply(this, args); };
  t.after(() => { SearchQuery.prototype.getCursor = original; });
  const f = setup(t, 'x\n'.repeat(140_000), false, true); openSearchPanel(f.view); f.input('absent');
  assert.equal(scans, 0); assert.equal(f.count(), '— / —');
  assert.equal(f.host.querySelector('.cm-search')!.getAttribute('data-state'), 'uncounted');
  assert.equal(f.button('Next match').disabled, false); assert.equal(f.button('Previous match').disabled, false);
  assert.equal(f.button('Select all matches').disabled, true);
  assert.match(f.host.querySelector('.zorid-find-count')!.getAttribute('aria-label')!, /unavailable for this large note/);
});
test('selection and replace-field changes reuse counted matches; document changes recount', t => {
  const original = SearchQuery.prototype.getCursor; let scans = 0;
  SearchQuery.prototype.getCursor = function (...args) { scans++; return original.apply(this, args); };
  t.after(() => { SearchQuery.prototype.getCursor = original; });
  const f = setup(t, 'cat cat'); openSearchPanel(f.view); f.input('cat'); const counted = scans;
  f.button('Next match').click(); f.button('Previous match').click();
  f.button('Search options').click(); f.button('Show replace').click();
  const replacement = f.host.querySelector<HTMLInputElement>('input[name="replace"]')!;
  replacement.value = 'dog'; replacement.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  assert.equal(scans, counted);
  f.view.dispatch({ changes: { from: f.view.state.doc.length, insert: ' cat' } }); assert.equal(scans, counted + 1);
});


test('workspace panel host keeps CM ownership, focus, command guards and teardown outside editor DOM', t => {
  const f = setup(t, 'cat cat', false, false, true);
  f.view.dispatch({ selection: { anchor: 0, head: 3 } }); f.view.focus();
  const depth = undoDepth(f.view.state), content = f.view.contentDOM;
  openSearchPanel(f.view);
  assert.ok(f.findHost.querySelector('.cm-panels-top .cm-search.zorid-find-panel'));
  assert.equal(f.host.querySelector('.cm-search'), null);
  assert.equal(document.activeElement, f.field()); assert.equal(f.count(), '1 / 2');
  f.button('Next match').click(); assert.equal(f.count(), '2 / 2');
  // Focusing the body while Find remains open must retain all existing guards.
  f.view.focus(); assert.equal(searchPanelOpen(f.view.state), true);
  assert.equal(runEditorCommand('editor-bold', f.view), true);
  assert.equal(f.editor.nativeAction!('bold'), false);
  assert.equal(f.editor.captureCommandTarget!(() => true), null);
  assert.equal(f.editor.getValue(), 'cat cat'); assert.equal(undoDepth(f.view.state), depth);
  f.field().focus(); f.press(f.field(), 'Escape');
  assert.equal(searchPanelOpen(f.view.state), false); assert.equal(document.activeElement, content);
  assert.equal(f.findHost.querySelector('.cm-panels'), null);
  openSearchPanel(f.view); const retained = f.button('Next match'); f.destroy();
  assert.equal(f.findHost.querySelector('.cm-panels'), null);
  assert.doesNotThrow(() => retained.click()); assert.deepEqual(f.changes, []);
});
