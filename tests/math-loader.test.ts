import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadMathEngine, mathPackages } from '../src/ui/math-renderer.ts';

test('loader starts locally once per document and waits for asynchronous startup before using conversion APIs', async t => {
  const dom = new JSDOM('<!doctype html><head></head>', { url: 'https://app.local/sub/index.html' }); t.after(() => dom.window.close());
  const document = dom.window.document;
  const first = loadMathEngine(document), duplicate = loadMathEngine(document); assert.equal(first, duplicate);
  const script = document.querySelector('script')!;
  assert.equal(script.src, 'https://app.local/sub/lib/mathjax/tex-chtml-nofont.js');
  const owner = dom.window as unknown as { MathJax: any }, config = owner.MathJax;
  assert.equal(config.loader.paths.fonts, 'https://app.local/sub/lib/mathjax/fonts');
  assert.deepEqual(config.loader.load, ['ui/safe', ...mathPackages.map(name => `[tex]/${name}`)]);
  assert.equal(config.output.font, 'mathjax-tex'); assert.deepEqual(config.output.fontExtensions, ['mathjax-mhchem']);
  assert.equal(config.startup.typeset, false); assert.equal(config.options.safeOptions.safeProtocols.file, false);
  assert.deepEqual(config.tex.inlineMath, []); assert.equal(config.tex.processEnvironments, false);
  let ready!: () => void;
  owner.MathJax = { startup: { promise: new Promise<void>(resolve => { ready = resolve; }) } };
  script.dispatchEvent(new dom.window.Event('load'));
  owner.MathJax.tex2chtmlPromise = async (source: string, options: { display: boolean }) => {
    const node = document.createElement('mjx-container'); node.textContent = source; node.dataset.display = String(options.display); return node;
  };
  owner.MathJax.chtmlStylesheet = () => document.createElement('style'); ready();
  const engine = await first, node = await engine.convert('x', true);
  assert.equal(node.textContent, 'x'); assert.equal(node.dataset.display, 'true'); assert.equal(engine.stylesheet()?.tagName, 'STYLE');
});

test('failed local script and failed startup clean up and permit a later retry', async t => {
  const dom = new JSDOM('<!doctype html><head></head>', { url: 'file:///app/index.html' }); t.after(() => dom.window.close());
  const document = dom.window.document;
  const failed = loadMathEngine(document); document.querySelector('script')!.dispatchEvent(new dom.window.Event('error'));
  await assert.rejects(failed, /Unable to load/); assert.equal(document.querySelector('script'), null);
  const retry = loadMathEngine(document); assert.notEqual(retry, failed);
  (dom.window as unknown as { MathJax: unknown }).MathJax = { startup: { promise: Promise.reject(new Error('startup failure')) } };
  document.querySelector('script')!.dispatchEvent(new dom.window.Event('load'));
  await assert.rejects(retry, /startup failure/); assert.equal(document.querySelector('script'), null);
});
