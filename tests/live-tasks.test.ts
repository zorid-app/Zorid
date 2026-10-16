import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { history, undo, redo } from '@codemirror/commands';
import { liveTasks } from '../src/editor/live-tasks.ts';

function setup(t: TestContext, doc: string) {
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
    extensions: [markdown(), liveTasks(), history(), EditorState.allowMultipleSelections.of(true),
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

test('task status widgets preserve source and distinguish checked from done styling', t => {
  const source = '- [ ] unchecked\n- [x] done\n- [X] DONE\n- [-] custom\n- [?] question';
  const { view, inputs } = setup(t, source);
  assert.equal(view.state.doc.toString(), source);
  assert.deepEqual(inputs().map(input => [input.dataset.task, input.checked]), [[' ', false], ['x', true], ['X', true], ['-', true], ['?', true]]);
  assert.deepEqual([...view.dom.querySelectorAll('.cm-task-done')].map(line => line.getAttribute('data-task')), ['x', 'X']);
});

test('each pointer toggle changes one status char, retaining multiselection and undo', t => {
  const source = '> 1. [X] parent [z]\n>    - [?] child\n- [ ] end';
  const { view, inputs, toggle, transactions } = setup(t, source);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(source.indexOf('parent') + 3, source.indexOf('parent')), EditorSelection.cursor(source.length)], 1) });
  const before = view.state.selection;
  toggle(inputs()[1]);
  assert.equal(view.state.doc.toString(), source.replace('[?]', '[ ]'));
  assert.ok(view.state.selection.eq(before));
  const last = transactions.at(-1)!;
  assert.equal(last.annotation(Transaction.userEvent), undefined);
  assert.equal(last.selection, undefined);
  const changes: unknown[] = []; last.changes.iterChanges((from, to, _a, _b, inserted) => changes.push([from, to, inserted.toString()]));
  assert.deepEqual(changes, [[source.indexOf('?'), source.indexOf('?') + 1, ' ']]);
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
  assert.ok(redo(view)); assert.equal(view.state.doc.toString(), source.replace('[?]', '[ ]'));
  toggle(inputs()[2]); assert.ok(view.state.doc.toString().endsWith('- [x] end'));
});

test('list syntax gating excludes code, escapes and task-like prose', t => {
  const source = 'plain [ ]\n\n```md\n- [ ] fenced\n```\n\n    - [ ] indented code\n\n- `[ ] inline`\n- \\[ ] escaped\n- regular [ ] later\n- [ ] task\n\t- [-] nested';
  const { inputs } = setup(t, source);
  assert.deepEqual(inputs().map(input => input.dataset.task), [' ', '-']);
});

test('marker selection reveals source, body caret keeps checkbox, blur restores marker widget', t => {
  const source = '- [ ] first\n- [x] second';
  const { view, inputs } = setup(t, source);
  view.focus();
  view.dispatch({ selection: { anchor: source.indexOf('first') } });
  assert.equal(inputs().length, 2);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.range(source.indexOf('[x]'), source.indexOf('[x]') + 3)]) });
  assert.equal(inputs().length, 0);
  assert.ok(view.contentDOM.textContent?.includes('[ ]'));
  view.contentDOM.blur();
  // Focus redraw is asynchronously scheduled by CM; force a state update too.
  view.dispatch({ selection: { anchor: source.length } });
  assert.equal(inputs().length, 2);
});

test('mousedown retains caret and reused widget resolves moved source position', t => {
  const source = '- [ ] task\nplain';
  const { view, inputs, toggle, dom } = setup(t, source);
  view.focus();
  view.dispatch({ selection: { anchor: source.length } });
  const mounted = inputs()[0];
  const event = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  inputs()[0].parentElement!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.ok(view.hasFocus);
  view.dispatch({ changes: { from: 0, insert: 'external\n' } });
  assert.equal(inputs()[0], mounted);
  toggle(inputs()[0]);
  assert.equal(view.state.doc.toString(), 'external\n- [x] task\nplain');
  assert.equal(view.state.selection.main.head, view.state.doc.length);
  assert.ok(view.hasFocus);
});

test('external status and marker edits are read from current source', t => {
  const source = '1) [ ] task [x] later\n    + [X] nested';
  const { view, inputs, toggle } = setup(t, source);
  assert.deepEqual(inputs().map(input => input.dataset.task), [' ', 'X']);
  view.dispatch({ changes: { from: source.indexOf('[ ]') + 1, to: source.indexOf('[ ]') + 2, insert: '?' } });
  assert.ok(inputs()[0].checked);
  toggle(inputs()[0]);
  assert.equal(view.state.doc.toString(), source);
  toggle(inputs()[1]);
  assert.equal(view.state.doc.toString(), source.replace('[X]', '[ ]'));
  const stale = inputs()[0];
  view.dispatch({ changes: { from: 3, insert: '\\' } });
  const escaped = view.state.doc.toString();
  assert.equal(inputs().length, 1);
  toggle(stale);
  assert.equal(view.state.doc.toString(), escaped);
});

test('all single-character non-space statuses are checked without completed text styling', t => {
  const statuses = ['\t', '_', '/', '!', '[', ']', 'é'];
  const { inputs, view, toggle } = setup(t, statuses.map(status => `- [${status}] task`).join('\n'));
  assert.deepEqual(inputs().map(input => input.dataset.task), statuses);
  assert.ok(inputs().every(input => input.checked));
  assert.equal(view.dom.querySelectorAll('.cm-task-done').length, 0);
  for (let index = 0; index < statuses.length; index++) toggle(inputs()[index]);
  assert.equal(view.state.doc.toString(), statuses.map(() => '- [ ] task').join('\n'));
});

test('frontmatter, HTML blocks and malformed markers stay literal', t => {
  const source = '---\nitems: |\n  - [x] property\n---\n\n<div>\n- [ ] html\n</div>\n\n<!--\n- [ ] comment\n-->\n\n- [xx] too many\n- [] empty\n- [ ]suffix\n- [ ]';
  const { inputs } = setup(t, source);
  assert.deepEqual(inputs().map(input => input.dataset.task), [' ']);
});

test('focused marker boundaries reveal source for every selection direction', t => {
  const source = '- [ ] first\n- [x] second';
  const { view, inputs } = setup(t, source);
  view.focus();
  for (const anchor of [source.indexOf('[ ]'), source.indexOf('[ ]') + 3]) {
    view.dispatch({ selection: { anchor } });
    assert.equal(inputs().length, 1);
    assert.equal(inputs()[0].dataset.task, 'x');
  }
  view.dispatch({ selection: EditorSelection.range(source.length, 0) });
  assert.equal(inputs().length, 0);
});

test('removed widgets and readonly state cannot mutate source', t => {
  const source = '- [ ] task';
  const { view, inputs, toggle, readonly } = setup(t, source);
  const old = inputs()[0];
  view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
  assert.ok(inputs()[0].disabled);
  toggle(inputs()[0]); assert.equal(view.state.doc.toString(), source);
  toggle(old); assert.equal(view.state.doc.toString(), source);
  view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(false)) });
  assert.equal(inputs()[0].disabled, false);
  const stale = inputs()[0];
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'plain' } });
  toggle(stale); assert.equal(view.state.doc.toString(), 'plain');
});

test('native checkbox activation toggles source and destroyed editors ignore retained controls', t => {
  const source = '- [ ] task\nother';
  const { view, inputs, toggle, dom } = setup(t, source);
  view.focus();
  view.dispatch({ selection: { anchor: source.length } });
  const before = view.state.selection;
  inputs()[0].dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  inputs()[0].click();
  assert.equal(view.state.doc.toString(), source.replace('[ ]', '[x]'));
  assert.ok(view.hasFocus);
  assert.ok(view.state.selection.eq(before));
  const retained = inputs()[0], after = view.state.doc.toString();
  view.destroy();
  toggle(retained);
  assert.equal(view.state.doc.toString(), after);
});
