import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { MarkdownEmbeds } from '../src/ui/embeds.ts';

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function setup(t: TestContext, seed: Record<string, string>) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.invalid/' });
  const { document } = dom.window;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let disconnected = 0;
  class Observer { observe() {} disconnect() { disconnected++; } }
  Object.defineProperty(dom.window, 'IntersectionObserver', { value: Observer });
  const vault = new Vault(new MemoryAdapter({ 'Home.md': '', ...seed })); await vault.initialize();
  const embeds = new MarkdownEmbeds({ vault, open() {} });
  t.after(() => {
    embeds.destroy(); dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  });
  const pending: { source: string; resolve: (output: HTMLElement) => void }[] = [];
  async function loadEngine() {
    await flush();
    const script = document.querySelector<HTMLScriptElement>('script[data-zorid-mathjax]'); assert.ok(script);
    (dom.window as unknown as { MathJax: unknown }).MathJax = {
      startup: { promise: Promise.resolve() },
      tex2chtmlPromise: (source: string) => new Promise<HTMLElement>(resolve => pending.push({ source, resolve })),
      chtmlStylesheet: () => document.createElement('style'),
    };
    script.dispatchEvent(new dom.window.Event('load')); await flush();
  }
  async function resolveNext() {
    assert.ok(pending.length); const job = pending.shift()!;
    const output = document.createElement('mjx-container'); output.textContent = `Rendered ${job.source}`;
    job.resolve(output); await flush();
  }
  const node = embeds.render({ target: 'Note', kind: 'wiki' }, 'Home.md');
  document.querySelector('main')!.append(node); await flush();
  return { dom, document, vault, embeds, node, loadEngine, resolveNext, pending, get disconnected() { return disconnected; } };
}
const original = '```js\nlet x = 1;\n```\n\n$old$';

test('embed refresh disposes old code and in-flight math before replacement', async t => {
  const f = await setup(t, { 'Note.md': original });
  const oldMath = f.node.querySelector('.math')!, button = f.node.querySelector<HTMLButtonElement>('button')!;
  await f.loadEngine(); assert.equal(f.pending[0].source, 'old');
  await f.vault.modify('Note.md', '$fresh$'); await flush();
  assert.equal(f.disconnected, 1); assert.equal(button.onclick, null);
  await f.resolveNext();
  assert.equal(oldMath.textContent, 'old'); assert.equal(oldMath.classList.contains('is-loaded'), false);
  assert.equal(f.pending[0].source, 'fresh'); await f.resolveNext();
  assert.equal(f.node.querySelector('.math')!.textContent, 'Rendered fresh');
});

test('explicit widget release cancels detached math and code while sibling owns updates', async t => {
  const f = await setup(t, { 'Note.md': original, 'Keep.md': 'Kept' });
  const sibling = f.embeds.render({ target: 'Keep', kind: 'wiki' }, 'Home.md'); f.node.after(sibling); await flush();
  const oldMath = f.node.querySelector('.math')!, button = f.node.querySelector<HTMLButtonElement>('button')!;
  await f.loadEngine(); f.node.remove(); f.embeds.releaseEmbed(f.node); f.embeds.releaseEmbed(f.node);
  await f.resolveNext();
  assert.equal(oldMath.textContent, 'old'); assert.equal(button.onclick, null); assert.equal(f.disconnected, 1);
  await f.vault.modify('Keep.md', 'Still owned'); await flush();
  assert.equal(sibling.querySelector('.markdown-embed-content')!.textContent, 'Still owned');
});

test('parent replacement releases nested note renderers and pending math', async t => {
  const f = await setup(t, { 'Note.md': '![[Child]]', 'Child.md': original });
  const child = f.node.querySelector<HTMLElement>('[data-embed-target="Child"]')!;
  const oldMath = child.querySelector('.math')!, button = child.querySelector<HTMLButtonElement>('button')!;
  await f.loadEngine();
  await f.vault.modify('Note.md', 'Parent replacement'); await flush(); await f.resolveNext();
  assert.equal(f.node.querySelector('.markdown-embed-content')!.textContent, 'Parent replacement');
  assert.equal(oldMath.textContent, 'old'); assert.equal(button.onclick, null); assert.equal(f.disconnected, 1);
  await f.vault.modify('Child.md', '$orphan$'); await flush();
  assert.equal(child.querySelector('.math'), oldMath); assert.equal(f.pending.length, 0);
});

test('missing-file fallback releases previously rendered async resources', async t => {
  const f = await setup(t, { 'Note.md': original });
  const oldMath = f.node.querySelector('.math')!, button = f.node.querySelector<HTMLButtonElement>('button')!;
  await f.loadEngine(); await f.vault.trash('Note.md'); await flush(); await f.resolveNext();
  assert.match(f.node.textContent!, /File not found/);
  assert.equal(oldMath.textContent, 'old'); assert.equal(button.onclick, null); assert.equal(f.disconnected, 1);
});

test('failed detached Markdown construction disposes partial code and math output', async t => {
  const f = await setup(t, { 'Note.md': 'Initial' });
  let partial: HTMLElement | undefined;
  const append = f.dom.window.HTMLElement.prototype.append;
  t.mock.method(f.dom.window.HTMLElement.prototype, 'append', function(this: HTMLElement, ...items: (Node | string)[]) {
    if (this.classList.contains('markdown-embed-content') && this.querySelector('.math') && items.some(item => typeof item !== 'string' && item.textContent === 'break here')) {
      partial = this; throw new Error('Rendering failed');
    }
    return append.apply(this, items);
  });
  await f.vault.modify('Note.md', `${original}\n\nbreak here`); await flush();
  assert.ok(partial); assert.match(f.node.textContent!, /Rendering failed/);
  assert.equal(partial.querySelector<HTMLButtonElement>('button')!.onclick, null);
  assert.equal(f.disconnected, 1); assert.equal(partial.querySelector('.math')!.classList.contains('is-loaded'), false);
  assert.equal(f.document.querySelector('script[data-zorid-mathjax]'), null, 'disposed math never starts its deferred engine load');
});
