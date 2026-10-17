import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/ui/markdown.ts';
import { applyCanvasProseLayout } from '../src/canvas/markdown-card-layout.ts';

function preview(source: string) {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  renderMarkdown(root, source, () => {}, undefined, { properties: false });
  applyCanvasProseLayout(root, source);
  return { root, close: () => dom.window.close() };
}

test('Canvas prose spacing follows actual source gaps rather than fixed paragraph margins', () => {
  const { root, close } = preview('# Canvas text check\n\nFirst paragraph.\n\n\nSecond paragraph.\nLast source line.\n');
  try {
    assert.ok(root.classList.contains('has-source-prose-layout'));
    assert.deepEqual([...root.children].map(child => (child as HTMLElement).style.getPropertyValue('--canvas-blank-lines')), ['0', '1', '2']);
    assert.equal(root.querySelector('h1')!.classList.contains('is-first-source-line'), true);
    assert.equal(root.children[2].textContent, 'Second paragraph.\nLast source line.');
    assert.equal(root.style.getPropertyValue('--canvas-trailing-lines'), '1');
  } finally { close(); }
});

test('adjacent heading and prose do not invent a missing blank line', () => {
  const { root, close } = preview('## Heading\nParagraph\n### Next\nMore');
  try {
    assert.ok(root.classList.contains('has-source-prose-layout'));
    assert.deepEqual([...root.children].map(child => (child as HTMLElement).style.getPropertyValue('--canvas-blank-lines')), ['0', '0', '0', '0']);
  } finally { close(); }
});

test('leading empty lines and CRLF keep their source line geometry', () => {
  const { root, close } = preview('\r\n\r\n# Heading\r\n\r\nBody');
  try {
    assert.ok(root.classList.contains('has-source-prose-layout'));
    assert.equal((root.children[0] as HTMLElement).style.getPropertyValue('--canvas-blank-lines'), '2');
    assert.equal(root.children[0].classList.contains('is-first-source-line'), false);
    assert.equal((root.children[1] as HTMLElement).style.getPropertyValue('--canvas-blank-lines'), '1');
  } finally { close(); }
});

test('rich blocks keep shared renderer ownership and their interactive nodes', () => {
  for (const source of ['# Heading\n\n- [ ] task', 'Before\n\n```js\ncode\n```', 'Before\n\n> quote', 'Setext\n===']) {
    const { root, close } = preview(source);
    try { assert.equal(root.classList.contains('has-source-prose-layout'), false, source); }
    finally { close(); }
  }
});

test('layout decoration preserves inline link nodes and does not retain stale source spacing after rerender', () => {
  const { root, close } = preview('# Heading\n\n[Target](Note.md)');
  try {
    const link = root.querySelector('a')!;
    applyCanvasProseLayout(root, '# Heading\n\n[Target](Note.md)');
    assert.equal(root.querySelector('a'), link);
    renderMarkdown(root, '> quote', () => {});
    applyCanvasProseLayout(root, '> quote');
    assert.equal(root.classList.contains('has-source-prose-layout'), false);
    assert.equal(root.style.getPropertyValue('--canvas-trailing-lines'), '');
  } finally { close(); }
});

test('display math inside a paragraph is excluded using the renderer-owned class', () => {
  const dom = new JSDOM('<main><p>Before <span class="math math-block">math</span> after</p></main>');
  try {
    const root = dom.window.document.querySelector('main')!;
    applyCanvasProseLayout(root, 'Before $$x$$ after');
    assert.equal(root.classList.contains('has-source-prose-layout'), false);
  } finally { dom.window.close(); }
});

test('inline constructs that collapse physical source lines keep shared Reading layout', () => {
  for (const source of ['Before `code\ncontinued` after', '[Label](Note.md\n"title")', '%%hidden%%\n\nBody']) {
    const { root, close } = preview(source);
    try { assert.equal(root.classList.contains('has-source-prose-layout'), false, source); }
    finally { close(); }
  }
});

test('hard line breaks remain one rendered break and retain prose layout', () => {
  const { root, close } = preview('First line  \nSecond line');
  try {
    assert.ok(root.classList.contains('has-source-prose-layout'));
    assert.equal(root.querySelectorAll('br').length, 1);
  } finally { close(); }
});
