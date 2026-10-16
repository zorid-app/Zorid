import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/ui/markdown.ts';
import { destroyMarkdown } from '../src/ui/markdown-lifecycle.ts';

function render(source: string) {
  const window = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.invalid/' }).window;
  const parent = window.document.querySelector('main')!;
  const changes: [number, boolean][] = [];
  renderMarkdown(parent, source, () => {}, (line, checked) => changes.push([line, checked]));
  return { parent, changes, window };
}

test('native mixed callout fixture renders inline math, display math and code in their own blocks', () => {
  const { parent } = render('> [!note] Mixed content\n> Inline $E=mc^2$.\n>\n> $$\n> a^2+b^2=c^2\n> $$\n>\n> ```js\n> const inside = true;\n> ```');
  assert.equal(parent.querySelector('.callout-title')?.textContent, 'Mixed content');
  assert.equal(parent.querySelector('.math-inline')?.textContent, 'E=mc^2');
  assert.ok(parent.querySelector('.callout > .callout-content'));
  assert.equal(parent.querySelector('.callout > .callout-content > .math-block')?.textContent, '\na^2+b^2=c^2\n');
  assert.equal(parent.querySelector('.callout > .callout-content > pre code')?.textContent, 'const inside = true;');
  assert.equal(parent.querySelectorAll('.math').length, 2);
  destroyMarkdown(parent);
});

test('nested quotes and quoted math inside a task keep original CRLF source line mapping', () => {
  const source = '---\ntitle: sample\n---\n\n> [!note]\n> > $$\n> > x > y\n> > $$\n>\n> - [ ] task\n>   > $$\n>   > z\n>   > $$'.replace(/\n/g, '\r\n');
  const { parent, changes } = render(source);
  assert.deepEqual([...parent.querySelectorAll('.math-block')].map(node => node.textContent), ['\nx > y\n', '\nz\n']);
  assert.ok(parent.querySelector('li > blockquote > .math-block'));
  parent.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  assert.deepEqual(changes, [[9, true]]);
  destroyMarkdown(parent);
});

test('quoted TeX owns Markdown-looking body, with no blank-line requirement and no embed callbacks', () => {
  const { parent } = render('> [!tip]\n> Before\n> $$\n> |x| < y ![[note]]\n>\n> \\frac{a}{b}\n> $$\n> After');
  assert.equal(parent.querySelector('.math-block')?.textContent, '\n|x| < y ![[note]]\n\n\\frac{a}{b}\n');
  assert.equal(parent.querySelectorAll('a, table').length, 0);
  assert.equal(parent.querySelectorAll('p').length, 2);
  destroyMarkdown(parent);
});

test('quote fences and incomplete math cannot close across sibling containers', () => {
  const { parent } = render('> ```\n> $$\n> literal\n> $$\n> ```\n> `$$ y $$`\n\n> $$\n> unfinished\n\nOutside\n\n- $$\n- $$');
  assert.equal(parent.querySelectorAll('.math').length, 0);
  assert.equal(parent.querySelector('pre code')?.textContent, '$$\nliteral\n$$');
  assert.equal(parent.querySelector('p code')?.textContent, '$$ y $$');
  assert.ok(parent.textContent?.includes('unfinished'));
  assert.ok(parent.textContent?.includes('Outside'));
  destroyMarkdown(parent);
});

test('quoted thematic breaks are not mistaken for nested frontmatter', () => {
  const { parent } = render('> ---\n> title: literal\n> ---\n> $$\n> x\n> $$');
  assert.equal(parent.querySelectorAll('.properties').length, 0);
  assert.ok(parent.textContent?.includes('title: literal'));
  assert.equal(parent.querySelector('.math-block')?.textContent, '\nx\n');
  destroyMarkdown(parent);
});

test('deep quoted input retains literal content after bounded recursive parsing', () => {
  const { parent } = render('> '.repeat(80) + '$$\n' + '> '.repeat(80) + 'x\n' + '> '.repeat(80) + '$$');
  assert.ok(parent.querySelector('.markdown-source-fallback'));
  assert.ok(parent.textContent?.includes('x'));
  assert.ok(parent.querySelectorAll('blockquote').length <= 32);
  destroyMarkdown(parent);
});

test('quote construction keeps the original async highlight parent until completion', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class Worker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown;
    postMessage(job: { id: number }) { queueMicrotask(() => this.onmessage?.({ data: { id: job.id, tokens: [{ from: 0, to: 5, classes: ['keyword'] }] } })); }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: Worker });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); else Reflect.deleteProperty(globalThis, 'Worker'); });
  const { parent } = render('> [!note]\n> ```js\n> const inside = true;\n> ```');
  for (let count = 0; count < 20; count++) await Promise.resolve();
  assert.equal(parent.querySelector('.callout pre .is-highlighted .token-keyword')?.textContent, 'const');
  destroyMarkdown(parent);
});

test('ordinary large top-level notes retain block rendering without a recursion fallback', () => {
  const { parent } = render('# Heading\n\n' + 'word '.repeat(200_001));
  assert.equal(parent.querySelector('h1')?.textContent, 'Heading');
  assert.equal(parent.querySelector('.markdown-source-fallback'), null);
  destroyMarkdown(parent);
});
