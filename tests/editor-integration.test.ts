import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';
import type { EmbedRequest } from '../src/ui/markdown.ts';

// Full createEditor extension stack. Geometry shims do not establish browser
// hit-testing, native selection, accessibility or pixel-level target parity.
function setup(t: TestContext, value: string, overrides: Partial<EditorOptions> = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true });
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
  const host = document.querySelector<HTMLElement>('main')!, changes: string[] = [];
  const renders: { request: EmbedRequest; node: HTMLElement; destroys: number }[] = [];
  const editor = createEditor(host, { value, mode: 'live', paths: () => [], onChange: text => changes.push(text), open() {},
    renderEmbed(request) {
      const node = document.createElement('span'); node.textContent = `Rendered ${request.target}`;
      const record = { request, node, destroys: 0 }; renders.push(record);
      return { dom: node, destroy() { record.destroys++; } };
    }, ...overrides });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let closed = false;
  const destroy = () => { if (!closed) { closed = true; editor.destroy(); } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const cursor = (anchor: number) => view.dispatch({ selection: { anchor } });
  const key = (key: string, shiftKey = false, target = view) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, code: key, shiftKey, bubbles: true, cancelable: true });
    target.contentDOM.dispatchEvent(event); assert.ok(event.defaultPrevented, `${shiftKey ? 'Shift-' : ''}${key} handled`);
  };
  const click = (node: Element) => node.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  return { editor, view, host, dom, changes, renders, destroy, cursor, key, click };
}

const metadata = '---\ntitle: Example\ncover: "![[metadata.png]]"\ntasks:\n  - "[x] metadata"\n---\n';

test('integrated checkbox click preserves hidden metadata, preview, embed identity and undo', t => {
  const source = metadata + '- [?] **task**\n![[photo.png]]\nend';
  const { editor, view, host, changes, renders, cursor, click } = setup(t, source);
  cursor(source.length);
  const widget = host.querySelector('.cm-live-embed');
  const checkbox = host.querySelector<HTMLInputElement>('.task-list-item-checkbox')!;
  assert.ok(checkbox); assert.ok(checkbox.checked); assert.equal(host.querySelectorAll('.task-list-item-checkbox').length, 1);
  assert.equal(renders.length, 1); assert.equal(renders[0].request.target, 'photo.png');
  assert.equal(host.querySelector('.cm-strong')?.textContent, 'task');
  assert.ok(!host.textContent?.includes('title: Example'));
  const selection = view.state.selection;
  click(checkbox);
  assert.equal(editor.getValue(), source.replace('[?]', '[ ]'));
  assert.ok(view.state.selection.eq(selection));
  assert.equal(host.querySelector('.cm-live-embed'), widget); assert.equal(renders[0].destroys, 0);
  assert.deepEqual(changes, [source.replace('[?]', '[ ]')]);
  assert.ok(undo(view)); assert.equal(editor.getValue(), source);
  assert.ok(redo(view)); assert.equal(editor.getValue(), source.replace('[?]', '[ ]'));
  assert.equal(renders.length, 1);
});

test('integrated Enter resets task status and nested empty task dedents without losing metadata', t => {
  const source = metadata + '> - parent\n> \t- [X] done';
  const { editor, view, cursor, key, host } = setup(t, source);
  cursor(source.length); key('Enter');
  assert.equal(editor.getValue(), source + '\n> \t- [ ] ');
  assert.ok(!host.textContent?.includes('cover:'));
  assert.ok(undo(view)); assert.equal(editor.getValue(), source);
  editor.setValue(metadata + '- parent\n\t- [x] '); cursor(editor.getValue().length); key('Enter');
  assert.equal(editor.getValue(), metadata + '- parent\n- [x] ');
});

test('integrated Tab and Shift-Tab preserve quote prefixes and selected-line boundary', t => {
  const source = metadata + '> - parent\n> \t- child\n> - last';
  const { editor, view, key, host } = setup(t, source);
  const end = source.indexOf('> - last');
  view.dispatch({ selection: EditorSelection.single(end, metadata.length) });
  key('Tab');
  assert.equal(editor.getValue(), metadata + '> \t- parent\n> \t\t- child\n> - last');
  assert.ok(view.state.selection.main.anchor > view.state.selection.main.head);
  assert.ok(!host.textContent?.includes('title:'));
  assert.ok(undo(view)); assert.equal(editor.getValue(), source);
  assert.ok(redo(view)); assert.equal(editor.getValue(), metadata + '> \t- parent\n> \t\t- child\n> - last');
  key('Tab', true); assert.equal(editor.getValue(), source);
  // Rapid indentation and dedentation may share a CM history event. This test
  // checks the source edits; it makes no claim about target undo grouping.
});

test('external metadata edits retain embed renderer identity and task source addressing', t => {
  const source = metadata + '- [ ] body\n![[one.png]]\nend';
  const { editor, host, changes, renders, cursor, click, destroy } = setup(t, source);
  cursor(source.length);
  const widget = host.querySelector('.cm-live-embed'), input = host.querySelector<HTMLInputElement>('.task-list-item-checkbox')!;
  const external = source.replace('title: Example', 'title: A longer external title');
  editor.setValue(external);
  assert.deepEqual(changes, []); assert.equal(host.querySelector('.cm-live-embed'), widget); assert.equal(renders.length, 1);
  click(input);
  assert.equal(editor.getValue(), external.replace('- [ ] body', '- [x] body'));
  assert.equal(changes.length, 1);
  editor.setValue(editor.getValue().replace('one.png', 'two.png'));
  assert.equal(renders[0].destroys, 1); assert.equal(renders[1].request.target, 'two.png');
  assert.equal(changes.length, 1);
  destroy(); assert.ok(renders.every(render => render.destroys === 1)); assert.equal(host.querySelector('.cm-editor'), null);
});

test('embed source action maps through body edits and releases/remounts once beside tasks', t => {
  const source = metadata + '- [ ] body\n![[Note]]\nend';
  const { editor, host, view, renders, click, cursor, destroy } = setup(t, source);
  cursor(source.length);
  editor.setValue(source.replace('- [ ] body', '- [ ] longer body'));
  const current = editor.getValue(), start = current.indexOf('![[Note]]');
  click(host.querySelector('.cm-live-embed-edit')!);
  assert.equal(view.state.selection.main.from, start); assert.equal(view.state.selection.main.to, start + '![[Note]]'.length);
  assert.equal(host.querySelector('.cm-live-embed'), null); assert.equal(renders[0].destroys, 1);
  assert.equal(host.querySelectorAll('.task-list-item-checkbox').length, 1);
  assert.equal(editor.getValue(), current);
  cursor(current.length); assert.equal(renders.length, 2); assert.ok(host.querySelector('.cm-live-embed'));
  destroy(); assert.ok(renders.every(render => render.destroys === 1));
});

test('source mode keeps frontmatter, tasks and embeds literal while retaining custom list keys', t => {
  const source = metadata + '![[photo.png]]\n- [X] done';
  const { editor, host, renders, cursor, key } = setup(t, source, { mode: 'source', listOptions: { useTab: false, tabSize: 8 } });
  assert.equal(renders.length, 0); assert.equal(host.querySelector('.task-list-item-checkbox'), null);
  assert.ok(host.textContent?.includes('title: Example')); assert.ok(host.textContent?.includes('![[photo.png]]'));
  cursor(source.length); key('Enter'); assert.equal(editor.getValue(), source + '\n- [ ] ');
  key('Tab'); assert.equal(editor.getValue(), source + '\n    - [ ] ');
});

test('table cell Tab navigation wins over list indentation while nearby embeds remain mounted', t => {
  const table = '| A | B |\n| --- | --- |\n| - [x] task | value |';
  const source = metadata + table + '\n\n![[photo.png]]\nend';
  const { editor, host, dom, renders, key } = setup(t, source);
  const embed = host.querySelector('.cm-live-embed');
  const cell = host.querySelector<HTMLElement>('.cm-live-table [data-row="1"][data-column="0"]')!;
  assert.ok(cell);
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.equal(child.state.doc.toString(), '- [x] task');
  key('Tab', false, child);
  const next = EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!)!;
  assert.equal(next.state.doc.toString(), 'value');
  assert.equal(editor.getValue(), source);
  assert.equal(host.querySelector('.cm-live-embed'), embed); assert.equal(renders.length, 1); assert.equal(renders[0].destroys, 0);
});
