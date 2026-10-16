import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';

async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
class SlowRenameAdapter extends MemoryAdapter {
  release!: () => void;
  gate = new Promise<void>(resolve => { this.release = resolve; });
  renames = 0;
  override async rename(from: string, to: string): Promise<void> { this.renames++; await this.gate; await super.rename(from, to); }
}
async function setup(t: TestContext, adapter = new MemoryAdapter()) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 800, bottom: 24, width: 800, height: 24, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const root = document.querySelector<HTMLElement>('#app')!, workspace = new Workspace(root, createEditor);
  t.after(async () => { try { if (adapter instanceof SlowRenameAdapter) adapter.release(); await workspace.destroy(); } finally { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } });
  await workspace.start({ adapter, id: 'test:note-focus', label: 'Test' });
  const title = () => workspace.activePane.element.querySelector<HTMLInputElement>('.note-title')!;
  const view = () => EditorView.findFromDOM(workspace.activePane.element.querySelector('.cm-editor')!)!;
  const enter = (target: EventTarget, extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event; };
  return { dom, root, workspace, adapter, title, view, enter };
}

test('title Enter waits for rename rebuild then focuses the current real CM for immediate typing', async t => {
  const adapter = new SlowRenameAdapter(), ui = await setup(t, adapter);
  await ui.workspace.newNote(); const title = ui.title(), oldView = ui.view();
  assert.equal(document.activeElement, title); title.value = 'Named'; ui.enter(title); ui.enter(title);
  assert.equal(title.readOnly, true, 'pending rename immediately locks the replaceable title input');
  await until(() => adapter.renames === 1, 'rename started');
  assert.equal(document.activeElement, title, 'focus remains in title while saving');
  adapter.release(); await until(() => ui.title().value === 'Named' && ui.view().hasFocus, 'new editor focus');
  assert.equal(ui.title().readOnly, false);
  assert.notEqual(ui.view(), oldView); assert.equal(oldView.dom.isConnected, false); assert.equal(adapter.renames, 1);
  ui.view().dispatch({ ...ui.view().state.replaceSelection('Ready to type'), userEvent: 'input.type' });
  await ui.workspace.flush(); assert.equal(await adapter.read('Named.md'), 'Ready to type');
});

test('unchanged title Enter focuses body; composition and failed names retain title', async t => {
  const ui = await setup(t, new MemoryAdapter({ 'Taken.md': '' }));
  await ui.workspace.newNote(); let title = ui.title();
  assert.equal(ui.enter(title, { isComposing: true }).defaultPrevented, false); assert.equal(document.activeElement, title);
  ui.enter(title); await until(() => ui.view().hasFocus, 'unchanged title body focus');
  title.focus(); title.value = 'Taken'; ui.enter(title);
  await until(() => !!ui.root.ownerDocument.querySelector('.notice'), 'rename error');
  assert.equal(document.activeElement, title); assert.equal(title.value, 'Taken'); assert.equal(title.readOnly, false, 'failed title can be corrected');
  assert.ok(ui.workspace.vault.entries.has('Untitled.md')); assert.ok(ui.workspace.vault.entries.has('Taken.md'));
});

test('a pending title rename does not steal focus after switching notes', async t => {
  const adapter = new SlowRenameAdapter({ 'Other.md': 'Other body' }), ui = await setup(t, adapter);
  await ui.workspace.newNote(); const title = ui.title(); title.value = 'Named'; ui.enter(title);
  await until(() => adapter.renames === 1, 'rename started');
  const navigation = ui.workspace.openNote('Other.md'); adapter.release(); await navigation;
  await until(() => ui.workspace.vault.entries.has('Named.md'), 'rename finished');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ui.title().value, 'Other'); assert.equal(ui.view().hasFocus, false);
});

test('palette new-note focus survives modal restoration and hidden titles go directly to body', async t => {
  const ui = await setup(t);
  ui.workspace.commandPalette();
  const command = document.querySelector<HTMLInputElement>('.command-input')!;
  command.value = 'Create new note'; command.dispatchEvent(new ui.dom.window.Event('input')); ui.enter(command);
  await until(() => !!ui.workspace.activePane.element.querySelector('.cm-editor'), 'created from palette');
  assert.equal(document.querySelector('.modal-container'), null); assert.equal(document.activeElement, ui.title());
  ui.enter(ui.title()); await until(() => ui.view().hasFocus, 'palette note body focus');
  (ui.workspace as any).settings.showInlineTitle = false;
  await ui.workspace.newNote(); assert.equal(ui.title().hidden, true); assert.equal(ui.view().hasFocus, true);
});

test('ordinary existing-note open does not request body focus or a new first-line caret', async t => {
  const ui = await setup(t, new MemoryAdapter({ 'Existing.md': '# Heading\nBody' }));
  const sidebar = ui.root.querySelector<HTMLButtonElement>('.sidebar-toolbar button')!; sidebar.focus();
  await ui.workspace.openNote('Existing.md');
  assert.equal(ui.view().hasFocus, false); assert.equal(document.activeElement, sidebar);
  assert.equal(ui.view().state.doc.toString(), '# Heading\nBody');
});

test('moving focus to another control while title saves cancels the delayed body focus', async t => {
  const adapter = new SlowRenameAdapter(), ui = await setup(t, adapter);
  await ui.workspace.newNote(); const title = ui.title(); title.value = 'Named'; ui.enter(title);
  await until(() => adapter.renames === 1, 'rename started');
  const sidebar = ui.root.querySelector<HTMLButtonElement>('.sidebar-toolbar button')!; sidebar.focus();
  adapter.release(); await until(() => ui.title().value === 'Named', 'rename rebuilt');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ui.view().hasFocus, false); assert.equal(document.activeElement, sidebar);
});


class SlowCreateAdapter extends MemoryAdapter {
  release!: () => void;
  gate = new Promise<void>(resolve => { this.release = resolve; });
  created = false;
  override async write(path: string, data: string): Promise<void> {
    if (path === 'Untitled.md') { this.created = true; await this.gate; }
    await super.write(path, data);
  }
}
test('a delayed new-note creation does not replace a newer note navigation request', async t => {
  const adapter = new SlowCreateAdapter({ 'Other.md': 'Other body' }), ui = await setup(t, adapter);
  const creating = ui.workspace.newNote(); await until(() => adapter.created, 'create pending');
  const navigating = ui.workspace.openNote('Other.md');
  adapter.release(); await Promise.all([creating, navigating]);
  assert.equal(ui.title().value, 'Other'); assert.equal(ui.view().hasFocus, false);
  assert.ok(ui.workspace.vault.entries.has('Untitled.md'), 'creation finishes without hijacking the newer destination');
});
