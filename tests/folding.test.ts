import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, foldedRanges, syntaxTree } from '@codemirror/language';
import { history, undo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { liveInlineMarkdown } from '../src/editor/live-inline.ts';
import { markdownFolding, markdownFoldingKeyboard, foldableMarkdownRanges, foldMarkdown, unfoldMarkdown, toggleMarkdownFold, foldAllMarkdown, unfoldAllMarkdown, foldMoreMarkdown, foldLessMarkdown, getMarkdownFoldState, restoreMarkdownFoldState } from '../src/editor/folding.ts';
const nativeMac = /Mac/.test(navigator.platform);
const state = (doc: string, options = {}) => EditorState.create({ doc, extensions: [markdown({ extensions: [liveInlineMarkdown] }), markdownFolding(options)] });
const ranges = (value: EditorState) => foldableMarkdownRanges(value).map(range => ({ ...range, text: value.sliceDoc(range.from, range.to) }));
const folds = (view: EditorView) => { const list: { from: number; to: number }[] = []; foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { list.push({ from, to }); }); return list; };
function setup(t: TestContext, value: string, live = false) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, entry] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: entry });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('main')!, changes: string[] = [];
  let destroyed = 0, rendered = 0;
  const handle = live ? createEditor(host, { value, mode: 'live', paths: () => [], open() {}, onChange: value => changes.push(value), renderEmbed: () => { rendered++; const child = document.createElement('div'); child.className = 'test-embed'; return { dom: child, destroy: () => { destroyed++; } }; } }) : null;
  const view = handle ? EditorView.findFromDOM(host.querySelector('.cm-editor')!)! : new EditorView({ parent: host, state: EditorState.create({ doc: value, extensions: [EditorState.allowMultipleSelections.of(true), markdown({ extensions: [liveInlineMarkdown] }), history()] }) });
  view.dispatch({ effects: StateEffect.appendConfig.of(markdownFolding()) }); view.focus();
  t.after(() => { if (handle) handle.destroy(); else view.destroy(); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { view, dom, host, changes, handle, get rendered() { return rendered; }, get destroyed() { return destroyed; } };
}

test('heading hierarchy includes nested sections and stops before equal/lower headings', () => {
  const value = state('# A\ntext\n## B\nchild\n# C\nlast');
  assert.deepEqual(ranges(value).map(({ line, text }) => ({ line, text })), [{ line: 1, text: '\ntext\n## B\nchild' }, { line: 3, text: '\nchild' }, { line: 5, text: '\nlast' }]);
  assert.deepEqual(ranges(state('# Alone')), []);
});

test('setext headings and list indentation preserve headers, blanks and tab widths', () => {
  assert.deepEqual(ranges(state('Title\n=====\nbody\nNext\n----\nend')).map(range => range.text), ['\n=====\nbody\nNext\n----\nend', '\n----\nend']);
  const value = state('- parent\n\n\t- child\n\t  continuation\n- sibling');
  assert.deepEqual(ranges(value).map(({ kind, line, text }) => ({ kind, line, text })), [
    { kind: 'list', line: 1, text: '\n\n\t- child\n\t  continuation' }, { kind: 'list', line: 3, text: '\n\t  continuation' },
  ]);
  assert.deepEqual(ranges(state('- parent\nlazy continuation\n- sibling')), []);
});

test('code, comments, escaped headings and properties do not manufacture fold controls', () => {
  const value = state('---\ntitle: x\n---\n```\n# fake\n  - fake\n    child\n```\n%% # hidden %%\n\\# escaped\nplain');
  assert.deepEqual(ranges(value), []);
  assert.deepEqual(ranges(state('# A\nbody\n- list\n  child', { headings: false })).map(range => range.kind), ['list']);
});

test('toggle folds a selected heading without source edits or new undo history', t => {
  const { view } = setup(t, '# A\nbody\n# B\nlast');
  view.dispatch({ selection: { anchor: 2 }, changes: { from: 2, insert: '!' }, userEvent: 'input.type' });
  const before = view.state.doc.toString(), depth = undoDepth(view.state);
  assert.ok(toggleMarkdownFold(view)); assert.equal(folds(view).length, 1);
  assert.equal(view.state.doc.toString(), before); assert.equal(undoDepth(view.state), depth);
  assert.ok(toggleMarkdownFold(view)); assert.equal(folds(view).length, 0);
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), '# A\nbody\n# B\nlast');
});

test('fold all preserves visible carets, relocates hidden endpoints and unfolding preserves direction', t => {
  const { view } = setup(t, '# A\nbody\n## Child\nmore\n# B\nend');
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(7, 5), EditorSelection.cursor(0)], 0) });
  assert.ok(foldAllMarkdown(view));
  assert.equal(view.state.selection.main.head, 3); assert.equal(view.state.selection.main.anchor, 3);
  assert.equal(view.state.selection.ranges.some(range => range.head === 0), true);
  assert.equal(folds(view).length, 3); assert.equal(undoDepth(view.state), 0);
  assert.ok(unfoldAllMarkdown(view)); assert.equal(folds(view).length, 0);
});

test('fold more chooses inner applicable region and fold less opens outer folded region', t => {
  const { view } = setup(t, '# A\n## B\nbody\n# C\nlast');
  view.dispatch({ selection: { anchor: 11 } });
  assert.ok(foldMoreMarkdown(view)); assert.equal(folds(view)[0].from, 8);
  assert.ok(foldMoreMarkdown(view)); assert.equal(folds(view).length, 2);
  assert.ok(foldLessMarkdown(view)); assert.equal(folds(view).length, 1); assert.equal(folds(view)[0].from, 8);
});

test('unrelated edits map folds; edits to hidden content or header unfold the touched region', t => {
  const { view } = setup(t, 'intro\n# A\nbody\n# B\nlast');
  view.dispatch({ selection: { anchor: 8 } }); foldMarkdown(view);
  const old = folds(view)[0]; view.dispatch({ changes: { from: 0, insert: 'X' } });
  assert.deepEqual(folds(view)[0], { from: old.from + 1, to: old.to + 1 });
  view.dispatch({ changes: { from: folds(view)[0].from + 2, insert: 'Y' } }); assert.equal(folds(view).length, 0);
  view.dispatch({ selection: { anchor: 8 } }); foldMarkdown(view);
  view.dispatch({ changes: { from: 7, to: 8, insert: '' } }); assert.equal(folds(view).length, 0);
});

test('moving any selection into a fold reveals it, including secondary cursor', t => {
  const { view } = setup(t, '# A\nbody\n# B\nlast'); foldMarkdown(view);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(6)], 0) });
  assert.equal(folds(view).length, 0);
});

test('saved folds round trip and malformed or incompatible snapshots do not mutate state', t => {
  const { view } = setup(t, '# A\nbody\n# B\nlast'); foldAllMarkdown(view);
  const saved = getMarkdownFoldState(view.state); unfoldAllMarkdown(view);
  assert.ok(restoreMarkdownFoldState(view, saved)); assert.equal(folds(view).length, 2);
  for (const bad of [null, {}, { ...saved, lines: 99 }, { ...saved, folds: [{ fromLine: -1, toLine: 3 }] }]) {
    assert.equal(restoreMarkdownFoldState(view, bad), false); assert.equal(folds(view).length, 2);
  }
});

test('inline accessible controls toggle without moving an unrelated caret and stale controls are inert', t => {
  const { view, dom, host } = setup(t, '# A\nbody\n# B\nlast');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const button = host.querySelector<HTMLButtonElement>('.cm-markdown-fold-toggle')!;
  assert.ok(button); assert.equal(button.getAttribute('aria-label'), 'Collapse heading');
  button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  button.click(); assert.equal(folds(view).length, 1); assert.equal(view.state.selection.main.head, view.state.doc.length);
  assert.equal(host.querySelector('.is-collapsed')?.getAttribute('aria-expanded'), 'false');
  const placeholder = host.querySelector<HTMLButtonElement>('.cm-markdown-fold-placeholder')!;
  placeholder.click(); assert.equal(folds(view).length, 0);
  placeholder.click(); assert.equal(folds(view).length, 0);
  const stale = host.querySelector<HTMLButtonElement>('.cm-markdown-fold-toggle')!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'plain' } }); stale.click(); assert.equal(folds(view).length, 0);
});

test('keyboard bindings are opt-in and preserve non-folding key behavior', t => {
  const { view, dom } = setup(t, '# A\nbody');
  const press = () => { const event = new dom.window.KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', keyCode: 219, ctrlKey: !nativeMac, shiftKey: !nativeMac, metaKey: nativeMac, altKey: nativeMac, bubbles: true, cancelable: true }); view.contentDOM.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(press(), false); view.dispatch({ effects: StateEffect.appendConfig.of(markdownFoldingKeyboard()) });
  assert.equal(press(), true); assert.equal(folds(view).length, 1);
});

test('folding live tables and embeds hides/restores widgets without source or history mutation', t => {
  const source = '# Section\n\n![[Note]]\n\n| A | B |\n| --- | --- |\n| x | y |\n\n> [!note] Callout\n> text\n\n# End\nlast';
  const fixture = setup(t, source, true), { view, host, changes } = fixture;
  assert.ok(host.querySelector('.cm-live-table')); assert.ok(host.querySelector('.test-embed'));
  const renderedBefore = fixture.rendered, destroyedBefore = fixture.destroyed;
  assert.ok(foldMarkdown(view)); assert.equal(folds(view).length, 1);
  assert.equal(host.querySelector('.cm-live-table'), null); assert.equal(host.querySelector('.test-embed'), null);
  assert.equal(fixture.destroyed, destroyedBefore + 1, 'hidden embed releases its owned resources');
  assert.equal(view.state.doc.toString(), source); assert.equal(undoDepth(view.state), 0); assert.deepEqual(changes, []);
  assert.ok(unfoldMarkdown(view)); assert.ok(host.querySelector('.cm-live-table')); assert.ok(host.querySelector('.test-embed'));
  assert.equal(fixture.rendered, renderedBefore + 1, 'unfold restores a fresh embed instance');
  assert.equal(view.state.doc.toString(), source); assert.equal(undoDepth(view.state), 0);
});

test('large documents only create visible controls and selection changes leave fold discovery stable', t => {
  const source = Array.from({ length: 1000 }, (_, index) => `# Heading ${index}\nbody ${index}\n`).join('\n');
  const { view, host } = setup(t, source);
  ensureSyntaxTree(view.state, view.state.doc.length, 100);
  view.dispatch({ selection: { anchor: 0 } });
  const before = foldableMarkdownRanges(view.state);
  view.dispatch({ selection: { anchor: 1 } });
  assert.deepEqual(foldableMarkdownRanges(view.state), before);
  assert.ok(host.querySelectorAll('.cm-markdown-fold-toggle').length < 50, 'controls follow viewport, not whole document');
});

test('advanced parser context does not make an older partial tree swallow later headings', () => {
  const source = '# A\n' + 'body\n'.repeat(10000) + '# B\nend';
  const initial = state(source);
  assert.ok(syntaxTree(initial).length < initial.doc.length);
  assert.ok(ensureSyntaxTree(initial, initial.doc.length, 1000));
  assert.deepEqual(foldableMarkdownRanges(initial), [], 'unpublished parse coverage cannot establish the first heading end');
  const published = initial.update({ selection: { anchor: 1 } }).state;
  assert.deepEqual(foldableMarkdownRanges(published).map(range => range.to), [source.indexOf('# B') - 1, source.length]);
});
