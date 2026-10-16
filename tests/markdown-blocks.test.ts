import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/ui/markdown.ts';
import { destroyMarkdown } from '../src/ui/markdown-lifecycle.ts';

function host() {
  const window = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.invalid/' }).window;
  const parent = window.document.querySelector('main')!;
  const copied: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (source: string) => { copied.push(source); } } });
  return { window, document: window.document, parent, copied };
}
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };

test('Reading fences retain exact content, first info word, matching markers and copied source', async () => {
  const { parent, copied } = host();
  renderMarkdown(parent, '  ````JS title\n  <div>$x$</div>\n  ```\n  ~~~~\n  ````\nAfter', () => {});
  const code = parent.querySelector('pre code')!;
  assert.equal(code.textContent, '<div>$x$</div>\n```\n~~~~');
  assert.equal((code as HTMLElement).dataset.language, 'js');
  assert.equal(parent.querySelectorAll('.math, pre div').length, 0);
  parent.querySelector<HTMLButtonElement>('button')!.click(); await flush();
  assert.deepEqual(copied, ['<div>$x$</div>\n```\n~~~~']);
  assert.equal(parent.lastElementChild?.textContent, 'After');
  destroyMarkdown(parent);
});

test('recursive list, quote and callout fences keep math literal with exact blank lines', () => {
  const { parent } = host();
  renderMarkdown(parent, '- item\n\n  ```\n  $list$\n\n  end\n  ```\n\n> ```\n> $quote$\n>\n> end\n> ```\n\n> [!note] Title\n> Body\n>\n> ```\n> $callout$\n> ```', () => {});
  assert.deepEqual([...parent.querySelectorAll('pre code')].map(node => node.textContent), ['$list$\n\nend', '$quote$\n\nend', '$callout$']);
  assert.equal(parent.querySelectorAll('.math').length, 0);
  assert.equal(parent.querySelector('.callout-title')?.textContent, 'Title');
  assert.equal(parent.querySelector('.callout p')?.textContent, 'Body');
  assert.equal(parent.querySelectorAll('button').length, 3);
  destroyMarkdown(parent);
});

test('parser-owned HTML and indented code cannot synthesize math or fenced blocks', () => {
  const { parent } = host();
  renderMarkdown(parent, '<div>\n```\n$x$\n```\n</div>\n\n    $indented$\n    ```\n    $$\n\nOutside', () => {});
  assert.equal(parent.querySelectorAll('.math, .zorid-code-block, div').length, 0);
  assert.ok(parent.textContent?.includes('$x$'));
  assert.ok(parent.textContent?.includes('$indented$'));
});

test('closed display blocks preserve TeX and incomplete blocks stay literal', () => {
  const { parent } = host();
  renderMarkdown(parent, 'Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter\n\n$$\n**unfinished**', () => {});
  assert.equal(parent.querySelectorAll('.math-block').length, 1);
  assert.equal(parent.querySelector('.math-block')?.textContent, '\n\\frac{a}{b}\n');
  assert.equal(parent.lastElementChild?.textContent, '$$\n**unfinished**');
  assert.equal(parent.querySelectorAll('strong').length, 0);
  destroyMarkdown(parent);
});

test('rerender disposes observers, copy events and pending math without stale DOM updates', async () => {
  const { parent, document, window } = host();
  let disconnected = 0;
  class Observer { constructor(_callback: unknown) {} observe() {} disconnect() { disconnected++; } }
  Object.defineProperty(window, 'IntersectionObserver', { value: Observer });
  renderMarkdown(parent, '```js\nconst x = 1;\n```\n\n$$\nx^2\n$$', () => {});
  const oldCode = parent.querySelector('pre')!, button = oldCode.querySelector('button')!;
  const oldMath = parent.querySelector('.math')!;
  await flush();
  const script = document.querySelector<HTMLScriptElement>('script[data-zorid-mathjax]')!;
  assert.ok(script);
  renderMarkdown(parent, 'Replacement', () => {});
  assert.equal(disconnected, 1);
  assert.equal(button.onclick, null);
  (window as unknown as { MathJax: unknown }).MathJax = {
    startup: { promise: Promise.resolve() },
    tex2chtmlPromise: async () => { const node = document.createElement('span'); node.textContent = 'Late'; return node; },
    chtmlStylesheet: () => document.createElement('style'),
  };
  script.dispatchEvent(new window.Event('load')); await flush();
  assert.equal(parent.textContent, 'Replacement');
  assert.equal(oldMath.textContent, '\nx^2\n');
  assert.equal(oldMath.classList.contains('is-loaded'), false);
  destroyMarkdown(parent); destroyMarkdown(parent);
});

test('all Reading output belongs to its destination document without a global document', () => {
  const { parent, document } = host();
  renderMarkdown(parent, '# Heading\n\n- item\n\n```\ncode\n```\n\n| A | B |\n| - | - |\n| one | two |', () => {});
  assert.ok(parent.querySelector('h1'));
  for (const node of parent.querySelectorAll('*')) assert.equal(node.ownerDocument, document);
  destroyMarkdown(parent);
});

test('paragraph ownership preserves multiline code spans and callout default titles', () => {
  const { parent } = host();
  renderMarkdown(parent, '`\n$x$\n`\n\n> [!note]\n> ```\n> $literal$\n> ```', () => {});
  assert.equal(parent.querySelector('p > code')?.textContent, '$x$');
  assert.equal(parent.querySelector('.callout-title')?.textContent, 'note');
  assert.equal(parent.querySelector('.callout pre code')?.textContent, '$literal$');
  assert.equal(parent.querySelectorAll('.math').length, 0);
  destroyMarkdown(parent);
});
