import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { MarkdownEmbeds } from '../src/ui/embeds.ts';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function setup(t: TestContext, seed: Record<string, string>, read?: (path: string) => Promise<string>) {
  const dom = new JSDOM('<main></main>', { url: 'https://zorid.test/' });
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const vault = new Vault(new MemoryAdapter({ 'Home.md': '', ...seed })); await vault.initialize();
  const views: { destroyed: number; node: HTMLElement }[] = [];
  const embeds = new MarkdownEmbeds({ vault, read, open() {}, pdfFactory(node) {
    const view = { destroyed: 0, node }; views.push(view);
    node.append(dom.window.document.createElement('canvas'));
    return { ready: Promise.resolve(), destroy() { view.destroyed++; }, goToPage() {}, setScale() {}, rotate() {}, showSearch() {}, applySubpath() {}, getSelectionSubpath() { return null; } };
  } });
  t.after(() => { embeds.destroy(); dom.window.close(); if (prior) Object.defineProperty(globalThis, 'document', prior); else Reflect.deleteProperty(globalThis, 'document'); });
  const parent = dom.window.document.querySelector('main')!;
  const render = (target: string, source = 'Home.md') => { const node = embeds.render({ target, kind: 'wiki' }, source); parent.append(node); return node; };
  return { dom, vault, embeds, views, parent, render, observers: () => (embeds as any).reconnectObservers.size };
}

test('unrelated topology keeps the exact parked PDF owner and installs no reconnect observer', async t => {
  const f = await setup(t, { 'Paper.pdf': '', 'Other.md': '' });
  const node = f.render('Paper.pdf'), canvas = node.querySelector('canvas'); node.remove();
  await f.vault.create('Unrelated.md', 'new'); await f.vault.rename('Unrelated.md', 'Elsewhere.md'); await f.vault.trash('Other.md'); await flush();
  assert.equal(f.views.length, 1); assert.equal(f.views[0].destroyed, 0); assert.equal(node.querySelector('canvas'), canvas); assert.equal(f.observers(), 0);
  f.parent.append(node); await flush(); assert.equal(f.views.length, 1);
});

test('repeated actual dependency changes defer one replacement until reattach', async t => {
  const f = await setup(t, { 'Paper.pdf': '' }); const node = f.render('Paper.pdf'); node.remove();
  await f.vault.modifyBinary('Paper.pdf', Uint8Array.of(1)); await f.vault.modifyBinary('Paper.pdf', Uint8Array.of(2)); await flush();
  assert.equal(f.views.length, 1); assert.equal(f.views[0].destroyed, 0); assert.equal(f.observers(), 1);
  f.parent.append(node); await flush();
  assert.equal(f.views.length, 2); assert.equal(f.views[0].destroyed, 1); assert.equal(f.observers(), 0);
  f.embeds.releaseEmbed(node); assert.equal(f.views[1].destroyed, 1);
});

test('a parked note invalidation suppresses an older pending read and loads fresh on attach', async t => {
  let finish!: (text: string) => void, reads = 0;
  const pending = new Promise<string>(resolve => finish = resolve);
  const f = await setup(t, { 'Note.md': '' }, async () => ++reads === 1 ? pending : 'Fresh text');
  const node = f.render('Note'); await flush(); node.remove();
  f.embeds.invalidate('Note.md'); finish('Stale text'); await flush();
  assert.equal(node.querySelector('.markdown-embed-content'), null); assert.equal(reads, 1);
  f.parent.append(node); await flush();
  assert.equal(node.querySelector('.markdown-embed-content')!.textContent, 'Fresh text'); assert.equal(reads, 2); assert.equal(f.observers(), 0);
});

test('missing and renamed dependencies refresh on attach, with no rebuild on unrelated names', async t => {
  const f = await setup(t, {}); const node = f.render('Missing'); node.remove();
  await f.vault.create('Other.md', 'Other'); assert.equal(f.observers(), 0);
  await f.vault.create('Missing.md', 'Found'); assert.equal(f.observers(), 1);
  f.parent.append(node); await flush(); assert.equal(node.querySelector('.markdown-embed-content')!.textContent, 'Found');
  node.remove(); await f.vault.rename('Missing.md', 'Renamed.md'); await flush();
  assert.equal(node.querySelector('.markdown-embed-content')!.textContent, 'Found');
  f.parent.append(node); await flush(); assert.match(node.textContent!, /File not found/); assert.equal(f.observers(), 0);
});

test('dirty parked owner release removes reconnect observer and never publishes after attach', async t => {
  const f = await setup(t, { 'Paper.pdf': '' }); const node = f.render('Paper.pdf'); node.remove();
  f.embeds.invalidate(); assert.equal(f.observers(), 1);
  f.embeds.releaseEmbed(node); assert.equal(f.observers(), 0); assert.equal(f.views[0].destroyed, 1);
  f.parent.append(node); await flush(); assert.equal(f.views.length, 1);
  f.embeds.destroy(); assert.equal(f.views[0].destroyed, 1);
});

test('new competing file resolution updates a parked shorthand embed', async t => {
  const f = await setup(t, { 'Far/Note.md': 'Far', 'Near/Source.md': '' });
  const node = f.render('Note', 'Near/Source.md'); await flush(); assert.equal(node.querySelector('.markdown-embed-content')!.textContent, 'Far'); node.remove();
  await f.vault.create('Near/Note.md', 'Near'); assert.equal(f.observers(), 1);
  f.parent.append(node); await flush(); assert.equal(node.querySelector('.markdown-embed-content')!.textContent, 'Near');
});
