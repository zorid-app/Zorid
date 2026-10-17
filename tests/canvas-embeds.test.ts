import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { MarkdownEmbeds } from '../src/ui/embeds.ts';
import { EditorView } from '@codemirror/view';
import { createEditor } from '../src/ui/editor.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';

const source = (x = 0) => JSON.stringify({ nodes: [{ id: 'a', type: 'text', x, y: 0, width: 100, height: 80, text: 'Private card body' }], edges: [], custom: { retained: true } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function setup(t: TestContext, read?: (path: string) => Promise<string>) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const adapter = new MemoryAdapter({ 'Home.md': '![[Board.canvas]]', 'Board.canvas': source(), 'Nested.md': '![[Board.canvas]]' });
  const vault = new Vault(adapter); await vault.initialize();
  const opened: string[][] = [];
  const embeds = new MarkdownEmbeds({ vault, read, open: (...args) => { opened.push(args); } });
  const parent = dom.window.document.querySelector('main')!;
  t.after(() => { embeds.destroy(); dom.window.close(); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  const mount = (target = 'Board.canvas') => { const node = embeds.render({ target, kind: 'wiki' }, 'Home.md'); parent.append(node); return node; };
  const click = (node: Element) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { dom, adapter, vault, embeds, parent, opened, mount, click };
}

test('Reading Canvas embeds render static navigation previews without changing either file', async t => {
  const f = await setup(t);
  renderMarkdown(f.parent, '![[Board.canvas]]', () => {}, undefined, { embed: request => f.embeds.render(request, 'Home.md') });
  await tick();
  const preview = f.parent.querySelector('.canvas-embed .zorid-canvas-embed-preview')!;
  assert.ok(preview); assert.ok(preview.classList.contains('interactive-child'));
  assert.equal(preview.querySelectorAll('rect[data-node-id="a"]').length, 1);
  assert.equal(preview.querySelector('.cm-editor, textarea'), null);
  assert.equal(preview.textContent?.includes('Private card body'), false);
  let bubbled = 0; f.parent.addEventListener('click', () => bubbled++);
  assert.equal(f.click(preview), false); assert.equal(bubbled, 0);
  assert.deepEqual(f.opened, [['Home.md', 'Board.canvas', 'wiki']]);
  assert.equal(await f.vault.read('Board.canvas'), source());
  assert.equal(await f.vault.read('Home.md'), '![[Board.canvas]]');
});

test('dependency refresh retires old navigation while unrelated topology preserves preview identity', async t => {
  const f = await setup(t), node = f.mount(); await tick();
  const old = node.querySelector('.zorid-canvas-embed-preview')!;
  await f.vault.create('Unrelated.md', ''); await tick();
  assert.equal(node.querySelector('.zorid-canvas-embed-preview'), old);
  await f.vault.modify('Board.canvas', source(20)); await tick();
  const next = node.querySelector('.zorid-canvas-embed-preview')!;
  assert.notEqual(next, old); assert.equal(next.querySelector('rect[data-node-id]')!.getAttribute('x'), '20');
  f.click(old); assert.equal(f.opened.length, 0);
  f.click(next); assert.equal(f.opened.length, 1);
  f.embeds.releaseEmbed(node); f.embeds.releaseEmbed(node);
  f.click(next); assert.equal(f.opened.length, 1); assert.equal(node.querySelector('svg'), null);
});

test('parked Canvas updates coalesce until reconnect and dispose removes navigation', async t => {
  let reads = 0; let current = source();
  const f = await setup(t, async () => { reads++; return current; });
  const node = f.mount(); await tick(); const preview = node.firstElementChild;
  node.remove(); current = source(40); f.embeds.invalidate('Board.canvas'); f.embeds.invalidate('Board.canvas');
  await tick(); assert.equal(reads, 1); assert.equal(node.firstElementChild, preview);
  f.parent.append(node); await tick(); await tick();
  assert.equal(reads, 2); assert.equal(node.querySelector('rect[data-node-id]')!.getAttribute('x'), '40');
  const live = node.firstElementChild!; f.embeds.destroy(); f.click(live); assert.equal(f.opened.length, 0);
});

test('stale and released deferred Canvas reads cannot mount or report into replacement owners', async t => {
  const pending: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const f = await setup(t, () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const node = f.mount(); await tick(); f.embeds.invalidate('Board.canvas'); await tick();
  assert.equal(pending.length, 2);
  pending[0].resolve(source(10)); await tick(); assert.equal(node.querySelector('svg'), null);
  pending[1].resolve(source(30)); await tick(); assert.equal(node.querySelector('rect[data-node-id]')!.getAttribute('x'), '30');
  f.embeds.invalidate('Board.canvas'); await tick(); f.embeds.releaseEmbed(node);
  pending[2].reject(new Error('late failure')); await tick();
  assert.equal(node.querySelector('svg, .embed-error'), null);
});

test('nested replacement and deletion release Canvas previews; invalid JSON remains read-only', async t => {
  const f = await setup(t), nested = f.mount('Nested'); await tick(); await tick();
  const old = nested.querySelector('.zorid-canvas-embed-preview')!; assert.ok(old);
  await f.vault.modify('Nested.md', 'Replacement'); await tick(); f.click(old); assert.equal(f.opened.length, 0);
  const node = f.mount(); await tick();
  await f.vault.modify('Board.canvas', '{broken'); await tick();
  assert.match(node.textContent!, /Unable to display Canvas preview/); assert.equal(await f.vault.read('Board.canvas'), '{broken');
  await f.vault.trash('Board.canvas'); await tick();
  assert.match(node.textContent!, /File not found/); assert.equal(node.querySelector('.zorid-canvas-embed-preview'), null);
});


test('Live Edit preview navigation keeps the Markdown and selection intact', async t => {
  const f = await setup(t);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: f.dom.window, navigator: f.dom.window.navigator,
    HTMLElement: f.dom.window.HTMLElement, Node: f.dom.window.Node, Text: f.dom.window.Text,
    Window: f.dom.window.Window, MutationObserver: f.dom.window.MutationObserver,
    getComputedStyle: f.dom.window.getComputedStyle.bind(f.dom.window),
  })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); }
  f.dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  f.dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  // Use the real editor and shared renderer, not a simulated preview widget.
  const value = 'before\n![[Board.canvas]]\nafter';
  const editor = createEditor(f.parent, { value, mode: 'live', paths: () => [], open() {}, onChange() {},
    renderEmbed: request => { const node = f.embeds.render(request, 'Home.md'); return { dom: node, destroy: () => f.embeds.releaseEmbed(node) }; } });
  try {
    await tick(); await tick();
    const view = EditorView.findFromDOM(f.parent.querySelector('.cm-editor')!)!;
    const selection = view.state.selection.toJSON();
    const preview = f.parent.querySelector('.zorid-canvas-embed-preview')!; assert.ok(preview);
    const down = new f.dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    preview.dispatchEvent(down); assert.equal(down.defaultPrevented, false);
    f.click(preview.querySelector('rect[data-node-id]')!);
    assert.deepEqual(f.opened, [['Home.md', 'Board.canvas', 'wiki']]);
    assert.equal(view.state.doc.toString(), value); assert.deepEqual(view.state.selection.toJSON(), selection);
    assert.equal(f.parent.querySelector('.cm-live-embed-edit'), null);
    assert.equal(f.parent.querySelector('.cm-live-embed')?.getAttribute('data-embed-type'), 'canvas');
  } finally {
    editor.destroy();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('failed Canvas reads leave loading state and retry through normal invalidation', async t => {
  let fail = true;
  const f = await setup(t, async () => { if (fail) throw new Error('Read unavailable'); return source(); });
  const node = f.mount(); await tick();
  assert.equal(node.querySelector('.embed-loading'), null);
  assert.match(node.querySelector('.embed-error')!.textContent!, /Read unavailable/);
  fail = false; f.embeds.invalidate('Board.canvas'); await tick();
  assert.equal(node.querySelector('.embed-error'), null); assert.ok(node.querySelector('.zorid-canvas-minimap'));
});
