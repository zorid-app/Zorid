import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { EditorHandle } from '../src/ui/editor.ts';

async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
async function setup(t: TestContext) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.test/' }), doc = dom.window.document;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const media = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: doc, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, matchMedia: media })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const registry = new Map<string, Set<Range>>();
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry } }); Object.defineProperty(dom.window, 'Highlight', { value: class extends Set<Range> { priority = 0; } });
  dom.window.matchMedia = media as any; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const source = '# Own heading\n\ncat **cat** [cat](Other.md)', adapter = new MemoryAdapter({ 'Note.md': source, 'Other.md': 'other text' });
  const workspace = new Workspace(doc.querySelector('main')!, (parent, options): EditorHandle => {
    const input = doc.createElement('textarea'); input.value = options.value; parent.append(input);
    return { getValue: () => input.value, setValue: value => input.value = value, focus: () => input.focus(), destroy: () => input.remove(), insert: value => { input.value += value; options.onChange(input.value); } };
  });
  let destroyed = false;
  const destroy = async () => { if (!destroyed) { await workspace.destroy(); destroyed = true; } };
  t.after(async () => { try { await destroy(); } finally { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } });
  await workspace.start({ adapter, id: 'reading-find', label: 'test' }); await workspace.openNote('Note.md'); await (workspace as any).toggleReading();
  const primary = (workspace as any).hotkeys.platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
  const press = (target: Element, key: string, extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event; };
  const field = () => workspace.activePane.element.querySelector<HTMLInputElement>('.zorid-reading-find input[name="search"]')!;
  const input = (text: string) => { field().value = text; field().dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { dom, doc, workspace, adapter, registry, source, primary, press, field, input, destroy };
}

test('Workspace routes primary-F to Reading without switching mode, writing source or replacing the preview', async t => {
  const f = await setup(t), pane = f.workspace.activePane, preview = pane.element.querySelector<HTMLElement>('.markdown-preview')!, link = preview.querySelector('a')!;
  assert.equal(f.press(preview, 'f', { ...f.primary, isComposing: true }).defaultPrevented, false);
  assert.equal(f.press(preview, 'f', f.primary).defaultPrevented, true); await settle(); f.input('cat');
  assert.equal(f.doc.activeElement, f.field()); assert.equal(pane.element.querySelector('.zorid-find-count')!.textContent, '0 / 3');
  assert.equal(pane.element.querySelector('.markdown-preview'), preview); assert.equal(preview.querySelector('a'), link); assert.equal(pane.editor, undefined);
  f.press(f.field(), 'Enter'); assert.equal(pane.element.querySelector('.zorid-find-count')!.textContent, '1 / 3');
  f.press(f.field(), 'Escape'); assert.equal(f.registry.size, 0); assert.equal(f.doc.activeElement, preview);
  assert.equal(f.workspace.buffers.get('Note.md')!.text, f.source); assert.equal(f.workspace.buffers.get('Note.md')!.dirty, false); assert.equal(await f.adapter.read('Note.md'), f.source);
});

test('Reading refresh sees current buffer text and cached panes release/reacquire only their own ranges', async t => {
  const f = await setup(t), pane = f.workspace.activePane, find = pane.readingFind!;
  find.open(); await settle(); f.input('cat'); const firstNames = [...f.registry.keys()];
  f.workspace.buffers.get('Note.md')!.update('new cat'); pane.refreshPreview!(); await settle(); assert.equal(pane.element.querySelector('.zorid-find-count')!.textContent, '0 / 1');
  await f.workspace.openNote('Other.md', true); await settle(); assert.equal(f.registry.size, 0); assert.equal(pane.readingFind, undefined);
  await f.workspace.openNote('Note.md'); await settle(); assert.equal(pane.readingFind, find); assert.equal(f.field().value, 'cat');
  assert.equal(pane.element.querySelector('.zorid-find-count')!.textContent, '0 / 1'); assert.deepEqual([...f.registry.keys()], firstNames);
  await (f.workspace as any).toggleReading(); assert.equal(f.registry.size, 0); assert.equal(f.doc.querySelector('style[data-reading-find]'), null); assert.equal(pane.readingFind, undefined);
});

test('split panes keep independent Reading searches; closing or changing vault releases all owned highlights', async t => {
  const f = await setup(t), first = f.workspace.activePane; first.readingFind!.open(); await settle(); f.input('cat');
  await (f.workspace as any).split('right'); const second = f.workspace.activePane;
  if (!second.readingFind) await (f.workspace as any).toggleReading(); second.readingFind!.open(); await settle(); f.input('cat');
  assert.equal(f.registry.size, 4); assert.notEqual(first.readingFind, second.readingFind);
  await (f.workspace as any).closeTab(second, second.tabs.find(tab => tab.id === second.active)); await settle(); assert.equal(f.registry.size, 2);
  await f.workspace.openVault({ adapter: new MemoryAdapter({ 'New.md': 'new' }), id: 'new-vault', label: 'new' });
  assert.equal(f.registry.size, 0); assert.equal(f.doc.querySelector('style[data-reading-find]'), null);
});

test('Workspace destroy cancels Reading ranges and leaves no find controls or style registrations', async t => {
  const f = await setup(t); f.workspace.activePane.readingFind!.open(); await settle(); f.input('cat'); assert.equal(f.registry.size, 2);
  await f.destroy(); assert.equal(f.registry.size, 0); assert.equal(f.doc.querySelector('style[data-reading-find]'), null); assert.equal(f.doc.querySelector('.zorid-reading-find'), null);
});
