import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';
import { createMobileDocumentEditorHost } from '../src/ui/mobile-document-editor-host.ts';
import type { MobileDocumentEditorHost, MobileDocumentEditorHostOptions, MobileDocumentEditorSnapshot } from '../src/ui/mobile-document-editor-host.ts';

// Actual createEditor/CM instances and synthetic DOM. No browser geometry,
// native focus/keyboard, storage, or consuming router acceptance is implied.
function setup(t: TestContext) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
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
  const hosts: MobileDocumentEditorHost[] = [], changes: string[] = [];
  let writer: string | undefined, current = true;
  const parent = dom.window.document.querySelector<HTMLElement>('main')!;
  const create = (id: string, content = id, overrides: Partial<MobileDocumentEditorHostOptions> = {}) => {
    const slot = dom.window.document.createElement('section'); parent.append(slot);
    const host = createMobileDocumentEditorHost({ parent: slot, visitId: id, snapshot: snapshot(id, content),
      canMutate: () => writer === id, isCurrent: () => current,
      editorOptions: { mode: 'live', paths: () => [], open() {} }, onChange: text => changes.push(id + ':' + text), ...overrides });
    hosts.push(host); return host;
  };
  const view = (host: MobileDocumentEditorHost) => EditorView.findFromDOM(host.element.querySelector('.cm-editor')!)!;
  const activate = (host: MobileDocumentEditorHost) => { writer = host.visitId; host.setInteractionState({ active: true }); };
  t.after(() => {
    for (const host of hosts) host.destroy();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { dom, parent, create, view, activate, changes, setWriter: (id?: string) => { writer = id; }, retire: () => { current = false; } };
}
function snapshot(entryId: string, content: string, revision = 'rev1'): MobileDocumentEditorSnapshot {
  return { route: { kind: 'document', entryId, path: entryId + '.md', revision, recovery: 'none' }, content };
}

test('two actual editors construct passive with supplied rendering and no authored callback or focus', t => {
  const f = setup(t); let factories = 0, cleanups = 0;
  const host = f.create('A', '# supplied', {
    beforeEditor(scroll) { const title = scroll.ownerDocument.createElement('input'); title.className = 'note-title'; scroll.append(title); return () => { cleanups++; }; },
    editorFactory(parent, options) {
      factories++; assert.deepEqual(options.interactionState, { active: false }); assert.equal(options.canMutate!(), false);
      options.onChange('constructor callback'); return createEditor(parent, options);
    },
  });
  const other = f.create('B', 'second');
  assert.equal(factories, 1); assert.equal(f.parent.querySelectorAll('.cm-editor').length, 2);
  assert.equal(f.view(host).state.readOnly, true); assert.equal(f.view(other).state.facet(EditorView.editable), false);
  assert.equal(host.editor.getValue(), '# supplied'); assert.ok(host.element.querySelector('.note-title'));
  host.editor.insert('blocked'); other.editor.insert('blocked');
  assert.deepEqual(f.changes, []); assert.equal(f.dom.window.document.activeElement, f.dom.window.document.body);
  host.destroy(); host.destroy(); assert.equal(cleanups, 1);
  assert.ok(other.element.isConnected); assert.equal(other.editor.getValue(), 'second');
});

test('only the live writer authors, while canceled freeze retains actual instances, undo, cursor and both scrolls', t => {
  const f = setup(t), first = f.create('A', 'alpha'), second = f.create('B', 'beta');
  const a = f.view(first), b = f.view(second);
  f.activate(first); a.dispatch({ selection: { anchor: 5 } }); first.editor.focus(); first.editor.insert('!');
  const selection = a.state.selection;
  const outer = first.element.querySelector<HTMLElement>('.note-scroll')!; outer.scrollTop = 70; outer.scrollLeft = 9;
  a.scrollDOM.scrollTop = 31; a.scrollDOM.scrollLeft = 4;
  f.setWriter(); first.setInteractionState({ active: true }); second.setInteractionState({ active: false });
  assert.equal(f.dom.window.document.activeElement, a.contentDOM); assert.equal(a.state.readOnly, true);
  first.editor.insert('blocked'); b.dispatch({ changes: { from: 0, insert: 'blocked' }, filter: false });
  f.activate(first); // Cancel: restore the same source writer, with no recreation.
  assert.equal(f.view(first), a); assert.equal(f.view(second), b); assert.ok(a.state.selection.eq(selection));
  assert.equal(outer.scrollTop, 70); assert.equal(outer.scrollLeft, 9); assert.equal(a.scrollDOM.scrollTop, 31); assert.equal(a.scrollDOM.scrollLeft, 4);
  assert.ok(undo(a)); assert.equal(first.editor.getValue(), 'alpha'); assert.ok(redo(a));
  f.setWriter('B'); first.setInteractionState({ active: false }); second.setInteractionState({ active: true });
  assert.equal(f.dom.window.document.activeElement, f.dom.window.document.body, 'activation never focuses destination');
  first.editor.insert('blocked'); second.editor.insert('B');
  assert.equal(first.editor.getValue(), 'alpha!'); assert.equal(second.editor.getValue(), 'Bbeta');
  assert.deepEqual(f.changes, ['A:alpha!', 'A:alpha', 'A:alpha!', 'B:Bbeta']);
});

test('external same-entry snapshot preserves retained editor/undo and ignores rename path as identity', t => {
  const f = setup(t), host = f.create('A', 'alpha'), view = f.view(host);
  f.activate(host); view.dispatch({ selection: { anchor: 5 } }); host.editor.insert('!');
  f.setWriter(); host.setInteractionState({ active: false });
  const external = snapshot('A', 'alpha!\nremote', 'rev2');
  host.synchronize({ ...external, route: { ...external.route, path: 'renamed.md' } });
  assert.equal(f.view(host), view); assert.equal(host.editor.getValue(), 'alpha!\nremote');
  assert.deepEqual(f.changes, ['A:alpha!']);
  f.activate(host); assert.ok(undo(view)); assert.equal(host.editor.getValue(), 'alpha\nremote');
  assert.throws(() => host.synchronize(snapshot('B', 'wrong identity')), /identity/);
  assert.equal(host.editor.getValue(), 'alpha\nremote');
});

test('retired/stale host rejects old callbacks and synchronization without touching another view', t => {
  const f = setup(t); let callback!: EditorOptions['onChange'];
  const host = f.create('A', 'alpha', { editorFactory(parent, options) { callback = options.onChange; return createEditor(parent, options); } });
  const other = f.create('B', 'beta'); f.activate(host);
  callback('old value'); assert.deepEqual(f.changes, [], 'callback must match actual current editor value');
  f.setWriter(); callback('alpha'); assert.deepEqual(f.changes, []);
  f.retire(); assert.throws(() => host.synchronize(snapshot('A', 'late')), /stale/);
  assert.throws(() => host.setInteractionState({ active: true }), /stale/);
  host.destroy(); callback('alpha'); host.setInteractionState({ active: true });
  assert.throws(() => host.synchronize(snapshot('A', 'late')), /stale/);
  assert.deepEqual(f.changes, []); assert.equal(other.editor.getValue(), 'beta');
});

test('stale asynchronous transfer cannot author after a freeze and canceled resume', async t => {
  const f = setup(t); let resolve!: (value: string) => void, imports = 0;
  const host = f.create('A', 'alpha', { editorOptions: { mode: 'live', paths: () => [], open() {}, transfers: {
    importFile: () => { imports++; return new Promise<string>(yes => { resolve = yes; }); },
  } } });
  f.activate(host); const view = f.view(host), file = new f.dom.window.File([], 'photo.png', { type: 'image/png' });
  const event = new f.dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', files: [file], items: [{ kind: 'file', getAsFile: () => file }] } });
  view.contentDOM.dispatchEvent(event); await new Promise<void>(yes => setImmediate(yes));
  assert.equal(imports, 1);
  f.setWriter(); host.setInteractionState({ active: true }); f.activate(host);
  resolve('![[photo.png]]'); await new Promise<void>(yes => setImmediate(yes));
  assert.equal(host.editor.getValue(), 'alpha'); assert.deepEqual(f.changes, []);
});

test('factory without passive support cleans only its wrapper and hook', t => {
  const f = setup(t); let destroyed = 0, cleanup = 0;
  assert.throws(() => f.create('bad', 'body', { beforeEditor: () => () => { cleanup++; }, editorFactory: () => ({
    getValue: () => 'body', setValue() {}, insert() {}, focus() {}, destroy() { destroyed++; },
  }) }), /passive interaction/);
  assert.equal(destroyed, 1); assert.equal(cleanup, 1); assert.equal(f.parent.querySelector('.tab-view-content'), null);
});

test('failed scoped cleanup is retryable while callbacks are retired immediately', t => {
  const f = setup(t); let attempts = 0;
  const host = f.create('A', 'alpha', { beforeEditor: () => () => { if (++attempts === 1) throw new Error('cleanup'); } });
  assert.throws(() => host.destroy(), /cleanup failed/);
  assert.equal(host.element.isConnected, false);
  host.destroy(); host.destroy(); assert.equal(attempts, 2);
});
