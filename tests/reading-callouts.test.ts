import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/ui/markdown.ts';
import { destroyMarkdown } from '../src/ui/markdown-lifecycle.ts';

function host(t: TestContext) {
  const dom = new JSDOM('<main class="markdown-preview"></main>', { url: 'http://localhost/' });
  const document = dom.window.document, parent = document.querySelector<HTMLElement>('main')!;
  t.after(() => { destroyMarkdown(parent); dom.window.close(); });
  const click = (node: Element) => node.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  return { dom, document, parent, click };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('Reading uses shared typed callout shell, safe formatted title, icon and metadata', t => {
  const { parent } = host(t);
  renderMarkdown(parent, '> [! Custom Type |wide]- **Title** <img src=x>\n> Body\n\n> [!note]\n> Default\n\n> plain quote', () => {});
  const first = parent.querySelector<HTMLElement>('.zorid-callout')!;
  assert.equal(first.tagName, 'DIV'); assert.equal(first.dataset.callout, 'custom-type'); assert.equal(first.dataset.calloutMetadata, 'wide');
  assert.equal(first.dataset.calloutFold, '-'); assert.ok(first.querySelector('.callout-icon svg'));
  assert.equal(first.querySelector('.callout-title-inner strong')?.textContent, 'Title'); assert.equal(first.querySelector('img'), null);
  assert.match(first.querySelector('.callout-title-inner')!.textContent!, /<img src=x>/);
  assert.equal(first.querySelector<HTMLElement>('.callout-content')?.hidden, true);
  assert.equal(parent.querySelectorAll('.callout-title-inner')[1].textContent, 'Note');
  assert.equal(parent.querySelector('blockquote')?.textContent, 'plain quote');
});

test('Reading fold controls toggle locally while title links and prevented events retain ownership', async t => {
  const { parent, click } = host(t), opened: string[] = [];
  renderMarkdown(parent, '> [!tip]+ [[Target|Title]]\n> Content', target => opened.push(target));
  const callout = parent.querySelector('.zorid-callout')!, body = callout.querySelector<HTMLElement>('.callout-content')!, title = callout.querySelector<HTMLElement>('.callout-title')!;
  click(title.querySelector('a')!); await tick(); assert.deepEqual(opened, ['Target']); assert.equal(body.hidden, false);
  title.addEventListener('click', event => event.preventDefault(), { once: true }); click(title); await tick(); assert.equal(body.hidden, false);
  click(title); await tick(); assert.equal(body.hidden, true);
  click(title.querySelector('button')!); assert.equal(body.hidden, false); assert.equal(title.querySelector('button')?.getAttribute('aria-expanded'), 'true');
});

test('Reading replacement cancels pending folds and releases stale fold buttons', async t => {
  const { parent, click } = host(t);
  renderMarkdown(parent, '> [!note]- Old\n> Content', () => {});
  const old = parent.querySelector('.zorid-callout')!, title = old.querySelector('.callout-title')!, button = title.querySelector('button')!, body = old.querySelector<HTMLElement>('.callout-content')!;
  click(title); renderMarkdown(parent, '> [!warning]+ New\n> Replacement', () => {}); await tick();
  assert.equal(old.isConnected, false); assert.equal(body.hidden, true);
  click(button); click(title); await tick(); assert.equal(body.hidden, true);
  assert.equal(parent.querySelector<HTMLElement>('.callout-content')?.hidden, false);
  destroyMarkdown(parent); destroyMarkdown(parent);
});

test('nested Reading callouts retain task source lines, display math and code ownership', t => {
  const { parent, dom } = host(t), changed: { line: number; checked: boolean }[] = [];
  const source = 'Prefix\n\n> [!note]- Outer\n> - [ ] outer\n>\n> > [!tip]+ Nested\n> > - [x] nested\n> >\n> > $$\n> > x^2\n> > $$\n> >\n> > ```tex\n> > $$literal$$\n> > ```';
  renderMarkdown(parent, source, () => {}, (line, checked) => changed.push({ line, checked }));
  assert.equal(parent.querySelectorAll('.zorid-callout').length, 2);
  const boxes = parent.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
  boxes[0].checked = true; boxes[0].dispatchEvent(new dom.window.Event('change'));
  boxes[1].checked = false; boxes[1].dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(changed, [{ line: 3, checked: true }, { line: 6, checked: false }]);
  assert.equal(parent.querySelector('.math-block')?.textContent, '\nx^2\n');
  assert.equal(parent.querySelector('.zorid-code-block code')?.textContent, '$$literal$$');
  assert.equal(parent.querySelector('.zorid-code-block .math'), null); assert.ok(parent.querySelector('.zorid-code-copy'));
});

test('Reading teardown keeps pending title/body math and code detached without late writes', async t => {
  const { parent, dom, document } = host(t); let disconnected = 0;
  Object.defineProperty(dom.window, 'IntersectionObserver', { value: class { observe() {} disconnect() { disconnected++; } } });
  renderMarkdown(parent, '> [!note]- $title$\n> $$\n> body\n> $$\n>\n> ```js\n> const value = 1\n> ```', () => {});
  const old = parent.querySelector('.zorid-callout')!, math = [...old.querySelectorAll('.math')], button = old.querySelector<HTMLButtonElement>('.zorid-code-copy')!;
  await flush(); const script = document.querySelector<HTMLScriptElement>('script[data-zorid-mathjax]')!; assert.ok(script);
  renderMarkdown(parent, 'Replacement', () => {});
  (dom.window as unknown as { MathJax: unknown }).MathJax = { startup: { promise: Promise.resolve() }, tex2chtmlPromise: async () => document.createElement('mjx-container'), chtmlStylesheet: () => null };
  script.dispatchEvent(new dom.window.Event('load')); await flush();
  assert.equal(parent.textContent, 'Replacement'); assert.equal(button.onclick, null); assert.equal(disconnected, 1);
  assert.deepEqual(math.map(node => node.textContent), ['title', '\nbody\n']); assert.ok(math.every(node => !node.classList.contains('is-loaded')));
});

test('failed Reading callout title construction disposes its math and folding owner', async t => {
  const { parent, document, click } = host(t);
  assert.throws(() => renderMarkdown(parent, '> [!note]- $title$ ![[bad.png]]\n> Body', () => {}, undefined, { embed() { throw new Error('Expected failed title embed'); } }));
  const callout = parent.querySelector('.zorid-callout')!, body = callout.querySelector<HTMLElement>('.callout-content')!;
  click(callout.querySelector('button')!); await flush();
  assert.equal(body.hidden, true); assert.equal(document.querySelector('script[data-zorid-mathjax]'), null);
});
