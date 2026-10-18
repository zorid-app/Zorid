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

test('embed source action maps through body edits and retains the rendered view beside tasks', t => {
  const source = metadata + '- [ ] body\n![[Note]]\nend';
  const { editor, host, view, renders, click, cursor, destroy } = setup(t, source);
  cursor(source.length);
  editor.setValue(source.replace('- [ ] body', '- [ ] longer body'));
  const current = editor.getValue(), start = current.indexOf('![[Note]]');
  const retained=host.querySelector('.cm-live-embed');
  click(host.querySelector('.cm-live-embed-edit')!);
  assert.equal(view.state.selection.main.from, start); assert.equal(view.state.selection.main.to, start + '![[Note]]'.length);
  assert.ok(host.querySelector('.cm-live-embed')===retained); assert.equal(renders[0].destroys, 0);
  assert.ok(host.textContent?.includes('![[Note]]'));
  assert.equal(host.querySelectorAll('.task-list-item-checkbox').length, 1);
  assert.equal(editor.getValue(), current);
  cursor(current.length); assert.equal(renders.length, 1); assert.ok(host.querySelector('.cm-live-embed')===retained);
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

test('inactive editor rejects authored dispatches and widgets but accepts external snapshots', t => {
  const source = '- [ ] task\nend';
  const { editor, view, host, changes, click } = setup(t, source);
  view.dispatch({ selection: { anchor: source.length } });
  editor.insert('!');
  const authored = editor.getValue(), selection = view.state.selection;
  view.scrollDOM.scrollTop = 73;
  editor.setInteractionState!({ active: false });
  assert.equal(EditorView.findFromDOM(host.querySelector('.cm-editor')!), view);
  assert.equal(view.state.readOnly, true);
  assert.equal(view.state.facet(EditorView.editable), false);
  assert.ok(view.state.selection.eq(selection));
  assert.equal(view.scrollDOM.scrollTop, 73);
  editor.insert('blocked');
  view.dispatch({ changes: { from: 0, insert: 'blocked' }, filter: false });
  click(host.querySelector('.task-list-item-checkbox')!);
  assert.equal(editor.getValue(), authored);
  assert.deepEqual(changes, [authored]);
  editor.setValue(authored + '\nexternal');
  assert.equal(editor.getValue(), authored + '\nexternal');
  assert.deepEqual(changes, [authored]);
  editor.setInteractionState!({ active: true });
  assert.equal(view.state.readOnly, false);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), source + '\nexternal', 'history maps through external snapshot while inactive');
  assert.ok(redo(view));
  assert.equal(editor.getValue(), authored + '\nexternal');
});

test('live writer predicate rejects parent and child programmatic changes without divergence', t => {
  let writer = true;
  const source = '| A | B |\n| --- | --- |\n| one | two |';
  const { editor, view, host, dom, changes } = setup(t, source, { canMutate: () => writer });
  const cell = host.querySelector<HTMLElement>('.cm-live-table [data-row="1"][data-column="0"]')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  writer = false; // Live authority must hold even before readOnly refresh.
  child.dispatch({ changes: { from: 0, insert: 'blocked' }, filter: false });
  view.dispatch({ changes: { from: 0, insert: 'blocked' }, filter: false });
  editor.insert('blocked');
  assert.equal(child.state.doc.toString(), 'one');
  assert.equal(editor.getValue(), source);
  assert.deepEqual(changes, []);
  editor.setInteractionState!({ active: false });
  assert.equal(child.state.readOnly, true);
  assert.equal(child.state.facet(EditorView.editable), false);
  editor.setValue(source.replace('one', 'remote'));
  assert.equal(child.state.doc.toString(), 'remote');
  writer = true;
  editor.setInteractionState!({ active: true });
  assert.equal(child.state.readOnly, false);
  assert.equal(child.state.facet(EditorView.editable), true);
  child.dispatch({ changes: { from: 0, insert: 'ok' } });
  assert.equal(editor.getValue(), source.replace('one', 'okremote'));
});

test('captured formatting target cannot revive after an interaction epoch change', t => {
  const { editor, view } = setup(t, 'label');
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  view.focus();
  const captured = editor.captureCommandTarget!(() => true);
  assert.ok(captured);
  editor.setInteractionState!({ active: false });
  editor.setInteractionState!({ active: true });
  assert.equal(captured.run('editor-bold'), false);
  assert.equal(editor.getValue(), 'label');
  captured.dispose();
});

test('initial inactive editor never exposes an authoring surface or steals focus', t => {
  const { editor, view, changes, dom } = setup(t, 'prewarm', { interactionState: { active: false } });
  assert.equal(view.state.readOnly, true);
  assert.equal(view.state.facet(EditorView.editable), false);
  editor.focus();
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
  editor.insert('blocked');
  view.dispatch({ changes: { from: 0, insert: 'blocked' }, filter: false });
  assert.equal(editor.getValue(), 'prewarm');
  assert.deepEqual(changes, []);
  editor.setInteractionState!({ active: true });
  assert.equal(dom.window.document.activeElement, dom.window.document.body, 'activation does not raise keyboard');
  editor.focus();
  assert.equal(dom.window.document.activeElement, view.contentDOM);
  editor.setInteractionState!({ active: false });
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
});

test('temporary writer freeze keeps active focus while rejecting changes and preserving history', t => {
  let writer = true;
  const { editor, view, dom } = setup(t, 'text', { canMutate: () => writer });
  view.dispatch({ selection: { anchor: 4 } });
  editor.focus(); editor.insert('!');
  const selection = view.state.selection;
  writer = false;
  editor.setInteractionState!({ active: true });
  assert.equal(view.state.readOnly, true);
  assert.equal(view.state.facet(EditorView.editable), true);
  assert.equal(dom.window.document.activeElement, view.contentDOM);
  editor.insert('blocked');
  assert.equal(editor.getValue(), 'text!');
  writer = true;
  editor.setInteractionState!({ active: true });
  assert.ok(view.state.selection.eq(selection));
  assert.equal(dom.window.document.activeElement, view.contentDOM);
  assert.ok(undo(view)); assert.equal(editor.getValue(), 'text');
});

test('throwing writer predicate fails closed during construction and authored dispatch', t => {
  let throws = true;
  const { editor, view, changes } = setup(t, 'safe', { canMutate: () => { if (throws) throw new Error('retired'); return true; } });
  assert.equal(view.state.readOnly, true);
  editor.insert('blocked');
  view.dispatch({ changes: { from: 0, insert: 'blocked' }, filter: false });
  assert.equal(editor.getValue(), 'safe');
  assert.deepEqual(changes, []);
  throws = false;
  editor.setInteractionState!({ active: true });
  editor.insert('ok');
  assert.equal(editor.getValue(), 'oksafe');
});

test('lease refresh retires a delayed context-menu action even when document and selection match', async t => {
  const { editor, view, dom } = setup(t, 'label');
  let choose!: (id: string) => void;
  Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu: () => new Promise<string>(resolve => { choose = resolve; }) } });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(typeof choose, 'function');
  editor.setInteractionState!({ active: false });
  editor.setInteractionState!({ active: true });
  choose('format-format-bold');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(editor.getValue(), 'label');
});

test('inactive editor rejects undo and a whole batch containing an authored change', t => {
  const { editor, view, changes } = setup(t, 'one');
  editor.insert('two');
  editor.setInteractionState!({ active: false });
  const before = view.state;
  undo(view);
  const select = before.update({ selection: { anchor: 1 } });
  const edit = select.state.update({ changes: { from: 0, insert: 'blocked' }, filter: false });
  view.dispatch([select, edit]);
  assert.equal(view.state, before, 'rejected batch cannot partially move selection');
  assert.equal(editor.getValue(), 'twoone');
  assert.deepEqual(changes, ['twoone']);
});

test('inactive table preserves its child without queued focus restoration and updates editable during freeze', async t => {
  let writer = true;
  const source = '| A | B |\n| --- | --- |\n| one | two |';
  const { editor, host, dom } = setup(t, source, { canMutate: () => writer });
  const cell = host.querySelector<HTMLElement>('.cm-live-table [data-row="1"][data-column="0"]')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  const selection = child.state.selection;
  writer = false;
  editor.setInteractionState!({ active: false });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
  assert.equal(EditorView.findFromDOM(cell.querySelector('.cm-editor')!), child);
  assert.ok(child.state.selection.eq(selection));
  assert.equal(child.state.facet(EditorView.editable), false);
  editor.setInteractionState!({ active: true });
  assert.equal(child.state.readOnly, true);
  assert.equal(child.state.facet(EditorView.editable), true);
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
});

test('live writer loss blocks table structure before optimistic child teardown', t => {
  let writer = true;
  const source = '| A | B |\n| --- | --- |\n| one | two |';
  const { editor, host, dom, click } = setup(t, source, { canMutate: () => writer });
  const cell = host.querySelector<HTMLElement>('.cm-live-table [data-row="1"][data-column="0"]')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = cell.querySelector('.cm-editor');
  writer = false;
  click(host.querySelector('.cm-table-add-row')!);
  assert.equal(editor.getValue(), source);
  assert.equal(cell.querySelector('.cm-editor'), child);
});

test('native actions sample live writer authority and publish inactive state', t => {
  let writer = true;
  const { editor, view } = setup(t, 'label', { canMutate: () => writer, onNativeEditorState() {} });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  view.focus();
  assert.equal(editor.nativeState!().editable, true);
  writer = false;
  assert.equal(editor.nativeAction!('bold'), false);
  assert.equal(editor.nativeState!().editable, false);
  editor.setInteractionState!({ active: false });
  const revision = editor.nativeState!().navigationRevision;
  writer = true;
  editor.setInteractionState!({ active: true });
  assert.ok(editor.nativeState!().navigationRevision > revision);
  assert.equal(editor.getValue(), 'label');
});

test('two retained editors accept authored changes only for the current writer token', t => {
  let writer: 'first' | 'second' = 'first';
  const { editor: first, host, dom } = setup(t, 'first', { canMutate: () => writer === 'first' });
  const secondHost = dom.window.document.createElement('section'); host.after(secondHost);
  const changes: string[] = [];
  const second = createEditor(secondHost, { value: 'second', mode: 'source', paths: () => [], open() {}, onChange: value => changes.push(value),
    interactionState: { active: false }, canMutate: () => writer === 'second' });
  try {
    first.insert('A'); second.insert('blocked');
    writer = 'second'; // Revoke outgoing authority before refreshing either view.
    first.insert('blocked');
    first.setInteractionState!({ active: false });
    second.setInteractionState!({ active: true });
    second.insert('B'); first.insert('blocked');
    assert.equal(first.getValue(), 'Afirst');
    assert.equal(second.getValue(), 'Bsecond');
    assert.deepEqual(changes, ['Bsecond']);
  } finally { second.destroy(); }
});

test('same-active refresh recovers a child created during live predicate loss', t => {
  let writer = true;
  const source = '| A | B |\n| --- | --- |\n| one | two |';
  const { editor, host, dom, key } = setup(t, source, { canMutate: () => writer });
  writer = false;
  const cell = host.querySelector<HTMLElement>('.cm-live-table [data-row="1"][data-column="0"]')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.equal(child.state.readOnly, true);
  writer = true;
  editor.setInteractionState!({ active: true });
  assert.equal(child.state.readOnly, false);
  assert.equal(EditorView.findFromDOM(cell.querySelector('.cm-editor')!), child);
  child.dispatch({ selection: { anchor: 0, head: 3 } });
  key('Enter', true, child);
  assert.notEqual(editor.getValue(), source, 'child keyboard authoring resumes');
});

test('rapid deactivate/reactivate invalidates pending table selection focus restoration', async t => {
  const source = '| A | B |\n| --- | --- |\n| one | two |\n\nend';
  const { editor, view, dom, host } = setup(t, source);
  view.focus();
  view.dispatch({ selection: { anchor: source.indexOf('one') } });
  editor.setInteractionState!({ active: false });
  editor.setInteractionState!({ active: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
  assert.equal(host.querySelector('.cm-live-table .cm-editor'), null, 'retired callback cannot mount/focus child');
});

test('interaction-opted editor retires a surviving Cut role across revoke/reactivate', async t => {
  const { editor, view, dom } = setup(t, 'label', { canMutate: () => true });
  let cuts = 0, native = 0;
  dom.window.document.execCommand = () => { cuts++; return true; };
  Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu: async () => { native++; return null; } } });
  view.dispatch({ selection: { anchor: 0, head: 5 } }); view.focus();
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const cut = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button => button.textContent === 'Cut');
  assert.ok(cut); assert.equal(native, 0);
  editor.setInteractionState!({ active: false });
  editor.setInteractionState!({ active: true });
  cut.click(); await Promise.resolve();
  assert.equal(cuts, 0);
  assert.equal(editor.getValue(), 'label');
  assert.equal(dom.window.document.querySelector('[role=menu]'), null);
  assert.notEqual(dom.window.document.activeElement, view.contentDOM);
});
