import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, redo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveCallouts, renderedCalloutRanges } from '../src/editor/live-callouts.ts';
import { liveMath, liveMathMarkdown } from '../src/editor/live-math.ts';
import { liveFences } from '../src/editor/live-fences.ts';
import { liveInline, liveInlineMarkdown } from '../src/editor/live-inline.ts';
import { liveTables } from '../src/editor/live-tables.ts';
import { liveTasks } from '../src/editor/live-tasks.ts';
import { liveLists } from '../src/editor/live-lists.ts';
import { liveEmbeds } from '../src/editor/live-embeds.ts';
import { liveProperties } from '../src/editor/live-properties.ts';
import { markdownFolding } from '../src/editor/folding.ts';

// DOM/state probes only: no claim about native selection or visual parity.
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


test('folded heading hides table and embed widgets and recreates both on unfold without source edits', t => {
  const source = '# Section\n\n| A | B |\n| --- | --- |\n| one | two |\n\n![[Picture.png]]\n\n# End\nText';
  let mounted = 0, destroyed = 0;
  const { editor, view, host, changes, cursor } = setup(t, source, 'live', {
    renderEmbed() { mounted++; const dom = document.createElement('div'); dom.textContent = 'embedded picture'; return { dom, destroy() { destroyed++; } }; },
  });
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 1);
  cursor(0); assert.ok(editor.fold!('fold'));
  assert.equal(host.querySelectorAll('.cm-live-table').length, 0);
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 0);
  assert.equal(mounted, destroyed, 'folded widgets release their resources');
  assert.ok(editor.fold!('unfold'));
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 1);
  assert.equal(editor.getValue(), source); assert.deepEqual(changes, []); assert.equal(undoDepth(view.state), 0);
});

test('secondary caret entering a folded table section unfolds without changing source', t => {
  const source = '# Section\n\n| A |\n| --- |\n| cell |\n\n# End\nText';
  const { editor, view, host } = setup(t, source);
  assert.ok(editor.fold!('fold'));
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(source.indexOf('cell'))], 0) });
  assert.equal(editor.getViewState!().folds!.folds.length, 0);
  assert.equal(host.querySelectorAll('.cm-live-table').length, 0, 'multiple carets expose table source');
  assert.ok([...host.querySelectorAll('.cm-line')].some(line => line.textContent === '| cell |'));
  assert.deepEqual(view.state.selection.ranges.map(range => range.head), [0, source.indexOf('cell')]);
  assert.equal(editor.getValue(), source);
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1, 'single caret restores the rendered table');
});

function combined(t: TestContext, source: string, makeEmbed?: (target: string) => HTMLElement) {
  const setupResult = setup(t, source), { view } = setupResult;
  const embeds: { target: string; destroyed: boolean }[] = [];
  const renderEmbed = (request: { target: string }) => {
    const dom = makeEmbed?.(request.target) ?? document.createElement('div'); if (!makeEmbed) dom.textContent = 'Rendered ' + request.target;
    const record = { target: request.target, destroyed: false }; embeds.push(record);
    return { dom, destroy() { record.destroyed = true; } };
  };
  view.contentDOM.blur();
  view.setState(EditorState.create({ doc: source, extensions: [
    markdown({ base: markdownLanguage, extensions: [liveInlineMarkdown, liveMathMarkdown] }), history(),
    EditorState.allowMultipleSelections.of(true), markdownFolding(), liveProperties(),
    liveCallouts({ renderEmbed }), liveTables(() => {}), liveEmbeds(renderEmbed), liveTasks(), liveLists(),
    liveMath({ excludes: renderedCalloutRanges, render(parent, tex) { parent.textContent = 'Math ' + tex; return { ready: Promise.resolve(true), dispose() {} }; } }),
    liveFences({ highlight: async () => [] }), liveInline(),
  ] }));
  const focusAt = async (position: number) => { view.focus(); view.dispatch({ selection: { anchor: position } }); await Promise.resolve(); };
  const click = (target: Element) => target.dispatchEvent(new setupResult.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { ...setupResult, embeds, focusAt, click };
}

test('callout task toggle with neighboring table, math and fence changes only its own marker and supports undo', async t => {
  const source = 'Before\n\n> [!note] Example\n> - [ ] task $x$\n>\n> | A | B |\n> | --- | --- |\n> | one | two |\n>\n> ```js\n> const x = 1;\n> ```\n\nAfter';
  const { view, focusAt, click } = combined(t, source);
  await focusAt(0);
  const callout = view.dom.querySelector('.cm-live-callout')!;
  assert.ok(callout, 'callout remains the enclosing block');
  assert.equal(callout.querySelectorAll('input[type=checkbox]').length, 1);
  assert.equal(callout.querySelectorAll('table').length, 1);
  assert.equal(callout.querySelectorAll('pre code').length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-live-math').length, 0, 'callout owns its inline math');
  click(callout.querySelector('input')!);
  assert.equal(view.state.doc.toString(), source.replace('[ ] task', '[x] task'));
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
  assert.ok(redo(view)); assert.equal(view.state.doc.toString(), source.replace('[ ] task', '[x] task'));
});

test('heading fold contains callout and display math replacements without leaking widgets', async t => {
  const source = '# Section\n\n> [!note] Title\n> Body $x$\n\n$$\ny\n$$\n\n# End\nText';
  const { editor, view, focusAt } = combined(t, source);
  await focusAt(0);
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-live-math-block').length, 1);
  assert.ok(editor.fold!('fold'));
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 0);
  assert.equal(view.dom.querySelectorAll('.cm-live-math').length, 0);
  assert.ok(editor.fold!('unfold'));
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-live-math-block').length, 1);
  assert.equal(view.state.doc.toString(), source); assert.equal(undoDepth(view.state), 0);
});

test('secondary callout caret reveals source and releases math ownership while first caret stays outside', async t => {
  const source = 'Before\n\n> [!note] Title\n> Body $x$\n\nAfter';
  const { view, focusAt } = combined(t, source);
  await focusAt(0);
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 1);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(source.indexOf('Title'))], 0) });
  await Promise.resolve();
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 0);
  assert.equal(view.dom.querySelectorAll('.cm-live-math').length, 1);
  assert.equal(view.state.selection.ranges.length, 2);
  assert.equal(view.state.doc.toString(), source);
});

test('callout source edit selects its entire quoted fence and table and leaves property prefix untouched', async t => {
  const prefix = '---\ntitle: "Callout $x$"\n---\n\n';
  const quoted = '> [!note] Title\n> ```js\n> const x = 1;\n> ```\n>\n> | A |\n> | --- |\n> | cell |';
  const source = prefix + quoted + '\n\nAfter';
  const { view, click, focusAt } = combined(t, source);
  await focusAt(source.length);
  assert.equal(view.contentDOM.textContent!.includes('title:'), false, 'property prefix stays hidden');
  click(view.dom.querySelector('.cm-callout-edit')!);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), quoted);
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 0);
  assert.ok(view.contentDOM.textContent!.includes('```js'), 'opening fence remains editable in selected callout');
  assert.ok(view.contentDOM.textContent!.includes('const x = 1;'));
  assert.equal(view.state.doc.toString(), source); assert.equal(undoDepth(view.state), 0);
});

test('pointer selection retains callout ownership until release then reveals nested math once', async t => {
  const source = 'Before\n\n> [!note] Title\n> $x$\n\nAfter';
  const { view, dom, focusAt } = combined(t, source);
  await focusAt(0);
  const callout = view.dom.querySelector('.cm-live-callout')!;
  callout.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  view.dispatch({ selection: { anchor: source.indexOf('Title') } });
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-live-math').length, 0);
  document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await new Promise(resolve => setTimeout(resolve, 85));
  assert.equal(view.dom.querySelectorAll('.cm-live-callout').length, 0);
  assert.equal(view.dom.querySelectorAll('.cm-live-math').length, 1);
  assert.equal(view.state.doc.toString(), source);
});

test('literal callout and task syntax inside a math block remains math through fold and undo', async t => {
  const source = '# Section\n\n$$\n> [!note] literal\n- [ ] literal\n| A | B |\n| --- | --- |\n$$\n\n# End\nText';
  const { editor, view, focusAt } = combined(t, source);
  await focusAt(0);
  assert.equal(view.dom.querySelectorAll('.cm-live-callout,.cm-live-table,input[type=checkbox]').length, 0);
  assert.equal(view.dom.querySelectorAll('.cm-live-math-block').length, 1);
  assert.ok(editor.fold!('fold')); assert.ok(editor.fold!('unfold'));
  const at = source.indexOf('literal');
  view.dispatch({ changes: { from: at, to: at + 7, insert: 'changed' }, userEvent: 'input.type' });
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
  assert.equal(view.dom.querySelectorAll('.cm-live-callout,.cm-live-table,input[type=checkbox]').length, 0);
});

test('fold-all from an active table cell keeps its latest edit undoable and leaves editor focus usable', async t => {
  const source = '# Section\n\n| A |\n| --- |\n| cell |\n\n# End\nText';
  const { editor, view, host, dom } = setup(t, source);
  host.querySelector('td')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const cell = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
  cell.focus(); cell.dispatch({ changes: { from: 0, insert: 'new ' }, userEvent: 'input.type' });
  await Promise.resolve();
  assert.ok(editor.getValue().includes('new cell'));
  assert.ok(editor.fold!('foldAll'));
  await Promise.resolve();
  assert.equal(host.querySelectorAll('.cm-live-table').length, 0);
  assert.equal(view.hasFocus, true, 'folding the focused child returns keyboard focus to the parent editor');
  assert.ok(undo(view)); assert.equal(editor.getValue(), source);
});


test('image lightbox click inside a callout preserves the enclosing rendered callout', async t => {
  const source = 'Before\n\n> [!note] Image\n> ![[picture.png]]\n\nAfter';
  let opened = 0;
  const { view, focusAt, click } = combined(t, source, () => {
    const image = document.createElement('img'); image.onclick = () => { opened++; }; return image;
  });
  await focusAt(0);
  const callout = view.dom.querySelector('.cm-live-callout')!;
  click(callout.querySelector('img')!);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(opened, 1);
  assert.equal(view.dom.querySelector('.cm-live-callout'), callout, 'image handler owns the click; callout must not activate source afterward');
  assert.equal(view.state.selection.main.head, 0);
  assert.equal(view.state.doc.toString(), source);
});
