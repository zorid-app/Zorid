import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo, redo } from '@codemirror/commands';
import { liveTasks } from '../src/editor/live-tasks.ts';
import { liveLists } from '../src/editor/live-lists.ts';

function setup(t: TestContext, doc: string, showIndentGuide = true) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { pretendToBeVisual: true });
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
  const rect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const readonly = new Compartment(), transactions: Transaction[] = [];
  const view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc,
    extensions: [markdown({base: markdownLanguage}), liveLists({showIndentGuide}), liveTasks(), history(), EditorState.allowMultipleSelections.of(true),
      readonly.of(EditorState.readOnly.of(false)), EditorView.updateListener.of(update => transactions.push(...update.transactions))] }) });
  t.after(() => {
    view.destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const inputs = () => [...view.dom.querySelectorAll<HTMLInputElement>('.task-list-item-checkbox')];
  const toggle = (input: HTMLInputElement) => { input.checked = !input.checked; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { view, inputs, toggle, dom, readonly, transactions };
}

test('unordered bullets receive circle marks; task prefixes disappear and ordered markers remain', t => {
  const source = '- bullet\n- [ ] open\n- [?] custom\n\n3. [X] ordered\n4. item';
  const { view, inputs } = setup(t, source);
  assert.equal(view.state.doc.toString(), source);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 1);
  assert.deepEqual([...view.dom.querySelectorAll('.cm-list-number')].map(node => node.textContent), ['3.', '4.']);
  assert.deepEqual(inputs().map(input => [input.dataset.task, input.checked]), [[' ', false], ['?', true], ['X', true]]);
  const taskLines = [...view.dom.querySelectorAll<HTMLElement>('.cm-task-line')];
  assert.deepEqual(taskLines.map(line => line.textContent), [' open', ' custom', '3.  ordered']);
  assert.equal(view.dom.querySelectorAll('.cm-task-done').length, 1);
});

test('prefix and task markers reveal together for focused multiple and reversed selections', t => {
  const source = '- [ ] first\n- second\n- third';
  const { view, inputs } = setup(t, source);
  view.focus();
  view.dispatch({ selection: { anchor: source.indexOf('first') } });
  assert.equal(inputs().length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 2);
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(inputs().length, 0);
  assert.ok(view.contentDOM.textContent?.includes('- [ ] first'));
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(5, 0), EditorSelection.cursor(source.indexOf('- second'))]) });
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 1);
  view.contentDOM.blur();
  view.dispatch({ selection: { anchor: source.length } });
  assert.equal(inputs().length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 2);
});

test('nested and quoted list indentation marks tabs and four-space units without changing source', t => {
  const source = '> - parent\n>     - [ ] child\n>     \t- grandchild\n>       continuation\n\n- two\n  - no full guide unit';
  const { view } = setup(t, source);
  assert.equal(view.state.doc.toString(), source);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 4);
  const lines = [...view.dom.querySelectorAll('.cm-list-line')];
  assert.deepEqual(lines.map(line => line.querySelectorAll('.cm-list-indent').length), [0, 1, 2, 1, 0, 0]);
  assert.ok(view.contentDOM.textContent?.includes('>'));
});

test('guide option suppresses guides without disabling bullets or task controls', t => {
  const { view, inputs } = setup(t, '- parent\n\t- [ ] nested', false);
  assert.equal(view.dom.querySelectorAll('.cm-list-indent').length, 0);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 1);
  assert.equal(inputs().length, 1);
});

test('syntax exclusion covers frontmatter, code, tables and escaped task prefixes', t => {
  const source = '---\nitems: |\n  - [ ] property\n---\n\n```md\n- [ ] fenced\n```\n\n    - [ ] code\n\n| a | b |\n| - | - |\n| - [ ] table | x |\n\n- `[ ] inline`\n- \\[ ] escaped\n-     [ ] code child\n- [ ] actual';
  const { view, inputs } = setup(t, source);
  assert.equal(inputs().length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 3);
  assert.equal(view.dom.querySelectorAll('.cm-list-indent').length, 0);
  assert.ok(view.contentDOM.textContent?.includes('- [ ] fenced'));
  assert.ok(view.contentDOM.textContent?.includes('- [ ] table'));
});

test('task source positions remain current after suppressed prefixes move and undo', t => {
  const source = '- [ ] first\n\t- [?] child';
  const { view, inputs } = setup(t, source);
  view.dispatch({ changes: { from: 0, insert: 'before\n\n' } });
  inputs()[1].click();
  assert.equal(view.state.doc.toString(), 'before\n\n- [ ] first\n\t- [ ] child');
  assert.ok(undo(view));
  assert.equal(view.state.doc.toString(), 'before\n\n' + source);
  inputs()[0].click();
  assert.ok(view.state.doc.toString().includes('- [x] first'));
});

test('pointer selection freezes marker geometry, maps changes and refreshes latest selection after release', async t => {
  const source = '- [ ] first\n- second';
  const { view, inputs, dom } = setup(t, source);
  view.focus(); view.dispatch({ selection: { anchor: source.length } });
  // Block CM's jsdom coordinate hit testing while keeping the capture phase.
  const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  const stop = (event: Event) => event.preventDefault();
  view.contentDOM.addEventListener('mousedown', stop);
  view.contentDOM.dispatchEvent(down);
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(inputs().length, 1);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 1);
  view.dispatch({ changes: { from: 0, insert: 'before\n' } });
  inputs()[0].click();
  assert.equal(view.state.doc.toString(), 'before\n- [x] first\n- second');
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  const target = view.state.doc.toString().indexOf('- second');
  view.dispatch({ selection: { anchor: target } });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(view.state.selection.main.head, target);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 0);
  assert.equal(inputs().length, 1);
});

test('composition keeps list and task markers stable until composition end', async t => {
  const { view, inputs, dom } = setup(t, '- [ ] task\n- item');
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(inputs().length, 1);
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(inputs().length, 0);
  assert.ok(view.contentDOM.textContent?.includes('- [ ] task'));
});

test('destroying with a pending release cancels callbacks', async t => {
  const { view, dom, transactions } = setup(t, '- [ ] task');
  view.contentDOM.addEventListener('mousedown', event => event.preventDefault());
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  const count = transactions.length;
  view.destroy();
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(transactions.length, count);
});

test('empty nested task items have a checkbox without a visible dash and preserve exact source', t => {
  const source = '- parent\n\t- [ ]\n\t- [?]';
  const { view, inputs } = setup(t, source);
  assert.equal(inputs().length, 2);
  assert.equal(view.dom.querySelectorAll('.cm-list-bullet').length, 1);
  for (const line of view.dom.querySelectorAll('.cm-task-line')) {
    assert.equal(line.textContent?.includes('-'), false);
    assert.equal(line.textContent?.includes('['), false);
  }
  assert.equal(view.state.doc.toString(), source);
  inputs()[0].click();
  assert.equal(view.state.doc.toString(), '- parent\n\t- [x]\n\t- [?]');
});
