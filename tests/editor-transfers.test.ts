import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';
import type { TransferOptions } from '../src/editor/transfers.ts';

// Synthetic DOM paste events exercise the installed transfer plugin and real
// CodeMirror transactions. File bytes are supplied by arrayBuffer fixtures;
// these tests establish neither OS clipboard behavior nor layout hit testing.
function setup(t: TestContext, value: string, options: Partial<TransferOptions> = {}, mode: 'source' | 'live' = 'source', editorOptions: Partial<EditorOptions> = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true });
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
  const host = document.querySelector<HTMLElement>('#host')!;
  const imports: { name: string; type: string; nativePath?: string; bytes: number[] }[] = [];
  const changes: string[] = [], errors: unknown[] = [];
  const editor = createEditor(host, { value, mode, paths: () => [], open() {}, onChange: text => changes.push(text),
    transfers: { async importFile(file) {
      imports.push({ name: file.name, type: file.type, nativePath: file.nativePath, bytes: [...await file.read()] });
      return `![[${file.name}]]`;
    }, onError: error => errors.push(error), ...options }, ...editorOptions });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const file = (name: string, bytes: number[], type = 'image/png'): File => {
    const result = new dom.window.File([], name, { type });
    Object.defineProperty(result, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    return result as unknown as File;
  };
  const paste = (data: Record<string, string> = {}, files: File[] = [], target = view.contentDOM) => {
    const transfer = { getData: (type: string) => data[type] ?? '', files,
      types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
      items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })) };
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    target.dispatchEvent(event);
    return { event, transfer };
  };
  return { dom, host, editor, view, imports, changes, errors, destroy, file, paste };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('file paste preserves byte values and native metadata, then inserts at the current selection', async t => {
  const gate = deferred<string>();
  const received: { name: string; type: string; nativePath?: string; bytes: number[] }[] = [];
  const { file, paste, view, editor, changes } = setup(t, 'alpha omega', {
    nativePath: () => '/fixtures/photo.png',
    async importFile(file) {
      received.push({ name: file.name, type: file.type, nativePath: file.nativePath, bytes: [...await file.read()] });
      return gate.promise;
    },
  });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  const { event, transfer } = paste({}, [file('photo.png', [0, 255, 137, 10])]);
  assert.equal(event.defaultPrevented, true);
  transfer.items.length = 0; transfer.files.length = 0; // Native transfer store no longer readable.
  await settle();
  assert.deepEqual(received, [{ name: 'photo.png', type: 'image/png', nativePath: '/fixtures/photo.png', bytes: [0, 255, 137, 10] }]);
  assert.equal(editor.getValue(), 'alpha omega');
  view.dispatch({ selection: { anchor: 6, head: 11 } });
  gate.resolve('![[photo.png]]'); await settle();
  assert.equal(editor.getValue(), 'alpha ![[photo.png]]');
  assert.deepEqual(changes, ['alpha ![[photo.png]]']);
  assert.equal(undo(view), true);
  assert.equal(editor.getValue(), 'alpha omega');
  assert.equal(received.length, 1, 'text undo does not repeat the importer');
});

test('file batches import sequentially and add exactly two newlines between embeds', async t => {
  const gates = [deferred<string>(), deferred<string>()], started: string[] = [];
  const { file, paste, view, editor } = setup(t, 'beforeafter', {
    importFile(file) { const index = started.length; started.push(file.name); return gates[index].promise; },
  });
  view.dispatch({ selection: { anchor: 6 } });
  paste({}, [file('one.png', [1]), file('two.png', [2])]);
  await settle(); assert.deepEqual(started, ['one.png']);
  gates[0].resolve('![[one.png]]'); await settle();
  assert.deepEqual(started, ['one.png', 'two.png']);
  assert.equal(editor.getValue(), 'before![[one.png]]\n\nafter');
  gates[1].resolve('![[two.png]]'); await settle();
  assert.equal(editor.getValue(), 'before![[one.png]]\n\n![[two.png]]after');
});

test('a second file paste waits for the pending batch instead of racing its insertion', async t => {
  const first = deferred<string>(), started: string[] = [];
  const { file, paste, editor } = setup(t, '', {
    async importFile(file) { started.push(file.name); return started.length === 1 ? first.promise : '![[second.png]]'; },
  });
  paste({}, [file('first.png', [1])]);
  paste({}, [file('second.png', [2])]);
  await settle(); assert.deepEqual(started, ['first.png']);
  first.resolve('![[first.png]]'); await settle();
  assert.deepEqual(started, ['first.png', 'second.png']);
  assert.equal(editor.getValue(), '![[first.png]]![[second.png]]');
});

test('text/markdown wins over plain text, HTML and file data in the same paste event', async t => {
  const { file, paste, view, editor, imports, changes } = setup(t, 'replace me');
  view.dispatch({ selection: { anchor: 0, head: 10 } });
  const { event } = paste({ 'text/markdown': '**Markdown**', 'text/plain': 'plain', 'text/html': '<b>HTML</b>' }, [file('unused.png', [1])]);
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(editor.getValue(), '**Markdown**');
  assert.deepEqual(imports, []);
  assert.deepEqual(changes, ['**Markdown**']);
  assert.equal(undo(view), true);
  assert.equal(editor.getValue(), 'replace me');
});

test('a URL paste wraps every selected label and preserves multiple selection cursors', t => {
  const { paste, view, editor } = setup(t, 'one two');
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]) });
  const { event } = paste({ 'text/plain': 'https://example.test/path' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(editor.getValue(), '[one](https://example.test/path) [two](https://example.test/path)');
  assert.equal(view.state.selection.ranges.length, 2);
  assert.ok(view.state.selection.ranges.every(range => range.empty));
  assert.equal(undo(view), true);
  assert.equal(editor.getValue(), 'one two');
});

test('corresponding URL lines wrap their matching selected labels in document order', t => {
  const { paste, view, editor } = setup(t, 'one two');
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)], 1) });
  paste({ 'text/plain': 'https://one.test\r\nmailto:two@example.test' });
  assert.equal(editor.getValue(), '[one](https://one.test) [two](mailto:two@example.test)');
  assert.equal(view.state.selection.mainIndex, 1);
});

test('a URL over a multiline selection uses ordinary text paste instead of a link label', t => {
  const { paste, view, editor } = setup(t, 'one\ntwo');
  view.dispatch({ selection: { anchor: 0, head: 7 } });
  paste({ 'text/plain': 'https://example.test' });
  assert.equal(editor.getValue(), 'https://example.test');
});

test('a completed import cannot insert into a destroyed editor or start remaining files', async t => {
  const gate = deferred<string>(), started: string[] = [];
  const { file, paste, destroy, editor, changes, errors } = setup(t, 'original', {
    importFile(file) { started.push(file.name); return gate.promise; },
  });
  paste({}, [file('first.png', [1]), file('second.png', [2])]);
  await settle(); assert.deepEqual(started, ['first.png']);
  destroy(); gate.resolve('![[first.png]]'); await settle();
  assert.equal(editor.getValue(), 'original');
  assert.deepEqual(started, ['first.png']);
  assert.deepEqual(changes, []); assert.deepEqual(errors, []);
});

test('a late failed import from a destroyed editor does not report into a closed owner', async t => {
  const gate = deferred<string>();
  const { file, paste, destroy, editor, errors } = setup(t, 'original', { importFile: () => gate.promise });
  paste({}, [file('image.png', [1])]); await settle();
  destroy(); gate.reject(new Error('late failure')); await settle();
  assert.equal(editor.getValue(), 'original');
  assert.deepEqual(errors, []);
});

test('an earlier capture handler can prevent transfer handling without importing files', async t => {
  const { dom, file, paste, editor, imports } = setup(t, 'original');
  dom.window.document.addEventListener('paste', event => event.preventDefault(), { capture: true, once: true });
  const { event } = paste({ 'text/markdown': 'replacement' }, [file('image.png', [1])]); await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(editor.getValue(), 'original');
  assert.deepEqual(imports, []);
});

test('failed import reports once without changing text and does not poison later pastes', async t => {
  const failure = new Error('write failed'); let calls = 0;
  const { file, paste, editor, errors } = setup(t, '', {
    async importFile() { if (++calls === 1) throw failure; return '![[retry.png]]'; },
  });
  paste({}, [file('failed.png', [1])]); await settle();
  assert.equal(editor.getValue(), ''); assert.deepEqual(errors, [failure]);
  paste({}, [file('retry.png', [2])]); await settle();
  assert.equal(editor.getValue(), '![[retry.png]]'); assert.deepEqual(errors, [failure]);
});

const tableNote = 'Before\n\n| A | B |\n| --- | --- |\n| alpha | beta |\n\nAfter';
function activateCell(host: HTMLElement, dom: JSDOM, column: number) {
  const cell = host.querySelector<HTMLElement>(`.cm-live-table [data-row="1"][data-column="${column}"]`)!;
  assert.ok(cell);
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.ok(child); return child;
}

test('Markdown paste captured from a nested table editor encodes pipes and line breaks once', t => {
  const { host, dom, paste, editor, view, changes } = setup(t, tableNote, {}, 'live');
  const child = activateCell(host, dom, 0);
  child.dispatch({ selection: { anchor: 0, head: child.state.doc.length } });
  const { event } = paste({ 'text/markdown': 'left|right\nnext' }, [], child.contentDOM);
  assert.equal(event.defaultPrevented, true);
  assert.equal(child.state.doc.toString(), 'left|right\nnext');
  assert.equal(editor.getValue(), tableNote.replace('alpha', 'left\\|right<br>next'));
  assert.equal(changes.length, 1);
  assert.equal(undo(view), true);
  assert.equal(editor.getValue(), tableNote);
});

test('pending file paste follows the current active table cell when import completes', async t => {
  const gate = deferred<string>();
  const { host, dom, paste, file, editor } = setup(t, tableNote, { importFile: () => gate.promise }, 'live');
  const first = activateCell(host, dom, 0);
  first.dispatch({ selection: { anchor: 0, head: first.state.doc.length } });
  paste({}, [file('image.png', [1])], first.contentDOM); await settle();
  const second = activateCell(host, dom, 1);
  second.dispatch({ selection: { anchor: 0, head: second.state.doc.length } });
  gate.resolve('![[image.png|200]]'); await settle();
  assert.equal(editor.getValue(), tableNote.replace('beta', '![[image.png\\|200]]'));
  assert.equal(second.state.doc.toString(), '![[image.png|200]]');
  assert.equal(host.querySelectorAll('.cm-live-table td').length, 2);
});


test('search inputs own paste and file drag events without changing the note selection', async t => {
  const { view, host, dom, paste, file, editor, imports } = setup(t, 'original note');
  view.dispatch({ selection: { anchor: 0, head: 8 } });
  openSearchPanel(view);
  const field = host.querySelector<HTMLInputElement>('.cm-search input[name="search"]')!;
  assert.ok(field); field.focus();
  for (const data of [{ 'text/plain': 'https://example.test' }, { 'text/markdown': '**query**' }, {}]) {
    const { event } = paste(data, [file('image.png', [42])], field);
    assert.equal(event.defaultPrevented, false);
  }
  for (const type of ['dragover', 'drop']) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file('image.png', [42])], items: [] } });
    field.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  await settle();
  assert.equal(editor.getValue(), 'original note');
  assert.deepEqual(imports, []);
});

test('native controls inside editor content retain their own clipboard handling', async t => {
  const { view, paste, file, editor, imports } = setup(t, 'original note');
  const input = document.createElement('input');
  view.contentDOM.append(input);
  view.dispatch({ selection: { anchor: 0, head: 8 } });
  const { event } = paste({ 'text/markdown': '**query**' }, [file('image.png', [42])], input);
  assert.equal(event.defaultPrevented, false);
  await settle();
  assert.equal(editor.getValue(), 'original note');
  assert.deepEqual(imports, []);
});


test('HTML paste converts before files and respects the current conversion preference', async t => {
  let enabled = true;
  const { paste, file, editor, imports, view } = setup(t, '', { autoConvertHtml: () => enabled });
  paste({ 'text/html': '<p>Rich <strong>text</strong></p>', 'text/plain': 'Rich text' }, [file('image.png', [42])]);
  assert.equal(editor.getValue(), 'Rich **text**');
  assert.equal(undo(view), true);
  enabled = false;
  paste({ 'text/html': '<strong>formatted</strong>', 'text/plain': 'plain' });
  assert.equal(editor.getValue(), 'plain');
  await settle();
  assert.deepEqual(imports, []);
});

test('own-copy marker with plain text bypasses conflicting Markdown and HTML formats', t => {
  const { paste, editor, view } = setup(t, '');
  paste({ 'text/html': '<!-- obsidian --><strong>rendered</strong>', 'text/plain': 'original', 'text/markdown': '**different**' });
  assert.equal(editor.getValue(), 'original');
  assert.equal(undo(view), true);
  paste({ 'text/html': '<!-- obsidian --><strong>rendered</strong>', 'text/markdown': '**different**' });
  assert.equal(editor.getValue(), '**different**', 'marker without plain text does not discard Markdown');
});

test('an image-only HTML fragment with files imports the binary and ignores its source URL', async t => {
  const { paste, file, editor, imports } = setup(t, '');
  paste({ 'text/html': '<!--StartFragment--><img src="file:///outside/image.png">' }, [file('image.png', [0, 255])]);
  await settle();
  assert.equal(editor.getValue(), '![[image.png]]');
  assert.deepEqual(imports[0].bytes, [0, 255]);
});

test('HTML conversion remains inert and falls back to plain text for excluded content', t => {
  const { paste, editor } = setup(t, '');
  paste({ 'text/html': '<script>throw new Error("executed")</script>', 'text/plain': 'safe fallback' });
  assert.equal(editor.getValue(), 'safe fallback');
});

test('inactive editor cannot start file imports or converted paste authoring', async t => {
  const { editor, paste, file, imports, changes, view, dom } = setup(t, 'original');
  editor.setInteractionState!({ active: false });
  paste({}, [file('blocked.png', [1])]);
  paste({ 'text/html': '<b>blocked</b>', 'text/plain': 'blocked' });
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  const dropped = file('drop.png', [2]);
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [dropped], items: [{ kind: 'file', getAsFile: () => dropped }] } });
  view.contentDOM.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  await settle();
  assert.deepEqual(imports, []);
  assert.equal(editor.getValue(), 'original');
  assert.deepEqual(changes, []);
});

test('revoke and reactivate invalidates in-flight and queued file batches', async t => {
  const gate = deferred<string>(), started: string[] = [];
  const { editor, paste, file, changes } = setup(t, 'original', {
    importFile(file) { started.push(file.name); return gate.promise; },
  });
  paste({}, [file('first.png', [1]), file('second.png', [2])]);
  paste({}, [file('queued.png', [3])]);
  await settle();
  assert.deepEqual(started, ['first.png']);
  editor.setInteractionState!({ active: false });
  editor.setInteractionState!({ active: true });
  gate.resolve('![[first.png]]');
  await settle();
  assert.deepEqual(started, ['first.png'], 'retain dispatched import but start no stale queued imports');
  assert.equal(editor.getValue(), 'original');
  assert.deepEqual(changes, []);
});


test('live writer loss before queued import starts prevents storage dispatch without a setter', async t => {
  let writer = true;
  const started: string[] = [];
  const { editor, paste, file } = setup(t, 'original', {
    async importFile(file) { started.push(file.name); return '![[late.png]]'; },
  }, 'source', { canMutate: () => writer });
  paste({}, [file('late.png', [1])]);
  writer = false;
  await settle();
  assert.deepEqual(started, []);
  assert.equal(editor.getValue(), 'original');
});

for (const inactive of [false, true]) test(`writer-denied transfer handling preserves search and native-control defaults (inactive=${inactive})`, t => {
  const { editor, view, dom, paste, file, imports } = setup(t, 'body', {}, 'source', { canMutate: () => false });
  if (inactive) editor.setInteractionState!({ active: false });
  openSearchPanel(view);
  const search = view.dom.querySelector<HTMLInputElement>('.cm-search input')!;
  assert.ok(search);
  const control = dom.window.document.createElement('input'); view.contentDOM.append(control);
  for (const target of [search, control]) {
    assert.equal(paste({ 'text/plain': 'input text' }, [], target).event.defaultPrevented, false);
    const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    const dropped = file('control.png', [1]);
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [dropped], items: [{ kind: 'file', getAsFile: () => dropped }] } });
    target.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, false);
  }
  assert.equal(editor.getValue(), 'body');
  assert.deepEqual(imports, []);
});
