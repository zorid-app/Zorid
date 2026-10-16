import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { createMarkdownListRenderer, renderMarkdownList } from '../src/ui/markdown-lists.ts';

function render(source: string, start = 0) {
  const document = new JSDOM('<!doctype html><main></main>').window.document;
  const parent = document.querySelector('main')!;
  const changes: [number, boolean][] = [];
  const consumed = renderMarkdownList(parent, source, start, (node, value) => node.append(document.createTextNode(value)),
    (line, checked) => changes.push([line, checked]));
  return { parent, consumed, changes };
}

test('nested mixed lists preserve hierarchy, ordered start and parser termination', () => {
  const { parent, consumed } = render('- parent\n  1) child\n     + grandchild\n  2) next\n- sibling\n\nOutside');
  assert.equal(consumed, 5);
  assert.equal(parent.children.length, 1);
  assert.equal(parent.firstElementChild?.tagName, 'UL');
  const top = parent.firstElementChild!;
  assert.equal(top.children.length, 2);
  const ordered = top.children[0].querySelector('ol')!;
  assert.equal(ordered.start, 1);
  assert.equal(ordered.children.length, 2);
  assert.equal(ordered.children[0].querySelector('ul > li')?.textContent, 'grandchild');
  assert.equal(top.children[1].textContent, 'sibling');
  assert.equal(parent.textContent?.includes('Outside'), false);
});

test('lazy continuation and loose paragraphs follow list syntax', () => {
  const tight = render('- first\ncontinuation\n  more\n- second');
  assert.equal(tight.consumed, 4);
  assert.equal(tight.parent.querySelectorAll('p').length, 0);
  assert.equal(tight.parent.querySelector('li')?.textContent, 'first\ncontinuation\nmore');
  const loose = render('- first\n\n  second paragraph\n\n- next\n\noutside');
  assert.equal(loose.consumed, 5);
  assert.deepEqual([...loose.parent.querySelectorAll('li > p')].map(node => node.textContent), ['first', 'second paragraph', 'next']);
});

test('task status, source line and local checkbox state survive nested quotes and CRLF', () => {
  const { parent, consumed, changes } = render('intro\r\n\r\n> 5. [X] upper\r\n>    - [?] custom [x] later\r\n>    - [ ] open\r\n>\r\n> tail\r\n\r\nAfter', 2);
  assert.equal(consumed, 5);
  assert.equal(parent.firstElementChild?.tagName, 'BLOCKQUOTE');
  assert.equal(parent.querySelector('ol')?.start, 5);
  const inputs = [...parent.querySelectorAll<HTMLInputElement>('input')];
  assert.deepEqual(inputs.map(input => [input.dataset.task, input.checked]), [['X', true], ['?', true], [' ', false]]);
  assert.deepEqual([...parent.querySelectorAll('li.is-checked')].map(node => (node as HTMLElement).dataset.task), ['X']);
  inputs[1].click();
  assert.deepEqual(changes, [[3, false]]);
  assert.equal(inputs[1].closest('li')?.getAttribute('data-task'), ' ');
  assert.equal(inputs[1].closest('li')?.classList.contains('is-checked'), false);
  inputs[2].click();
  assert.deepEqual(changes, [[3, false], [4, true]]);
  assert.equal(inputs[2].dataset.task, 'x');
  assert.equal(inputs[2].closest('li')?.classList.contains('is-checked'), true);
  assert.equal(parent.textContent?.includes('>'), false);
  assert.ok(parent.textContent?.includes('custom [x] later'));
});

test('code, escaped brackets and malformed task text never produce checkboxes', () => {
  const { parent, consumed } = render('- `[ ] inline`\n- \\[ ] escaped\n- [xx] malformed\n- [ ]suffix\n-     [ ] code\n\n      - [ ] more code\n\n  ```md\n  - [ ] fenced\n  ```\n\noutside');
  assert.equal(consumed, 11);
  assert.equal(parent.querySelectorAll('input').length, 0);
  assert.equal(parent.querySelectorAll('pre code').length, 2);
  assert.ok(parent.querySelectorAll('pre code')[0].textContent?.includes('- [ ] more code'));
  assert.equal(parent.querySelectorAll('pre code')[1].textContent, '- [ ] fenced');
});

test('non-list and nested interior starts return null without DOM mutations', () => {
  for (const [source, start] of [
    ['plain\n- task', 0], ['```md\n- [ ] code\n```', 1], ['    - [ ] code', 0],
    ['- parent\n  - child', 1], ['> quote only', 0], ['> [!note] title\n> - task', 0],
    ['- a', -1], ['- a', 2],
  ] as const) {
    const result = render(source, start);
    assert.equal(result.consumed, null, source);
    assert.equal(result.parent.children.length, 0);
  }
});

test('marker changes form separate lists while whitespace and empty items remain supported', () => {
  const source = '- dash\n+ plus\n\n7) ordered\n8)\n\n- [ ]';
  const first = render(source);
  assert.equal(first.consumed, 1);
  assert.equal(first.parent.querySelector('li')?.textContent, 'dash');
  const next = render(source, 1);
  assert.equal(next.consumed, 1);
  const ordered = render(source, 3);
  assert.equal(ordered.consumed, 2);
  assert.equal(ordered.parent.querySelectorAll('li').length, 2);
  assert.equal(ordered.parent.querySelector('ol')?.start, 7);
  const emptyTask = render(source, 6);
  assert.equal(emptyTask.parent.querySelectorAll('input').length, 1);
});

test('unsupported nested HTML remains escaped literal content', () => {
  const { parent } = render('- parent\n\n  <div onclick="alert(1)">\n  unsafe\n  </div>');
  assert.equal(parent.querySelectorAll('div').length, 0);
  assert.ok(parent.querySelector('.markdown-list-unsupported')?.textContent?.includes('<div onclick='));
});

test('document renderer parses once and reuses indexed roots without sharing DOM state', t => {
  const parse = t.mock.method(markdownLanguage.parser, 'parse');
  const source = '- [ ] first\r\n\r\nparagraph\r\n\r\n5. [X] second\r\n\r\n> - [?] third';
  const renderList = createMarkdownListRenderer(source);
  assert.equal(parse.mock.callCount(), 1);
  const document = new JSDOM('<!doctype html><main></main><aside></aside>').window.document;
  const main = document.querySelector('main')!, aside = document.querySelector('aside')!;
  const inline = (node: HTMLElement, value: string) => node.append(document.createTextNode(value));
  const changes: [number, boolean][] = [];
  const onChange = (line: number, checked: boolean) => changes.push([line, checked]);
  assert.equal(renderList(main, 0, inline, onChange), 1);
  assert.equal(renderList(main, 2, inline, onChange), null);
  assert.equal(renderList(main, 4, inline, onChange), 1);
  assert.equal(renderList(main, 6, inline, onChange), 1);
  assert.equal(renderList(aside, 0, inline, onChange), 1);
  assert.equal(parse.mock.callCount(), 1);
  main.querySelector<HTMLInputElement>('input')!.click();
  assert.deepEqual(changes, [[0, true]]);
  assert.equal(aside.querySelector<HTMLInputElement>('input')!.checked, false);
  assert.equal(main.querySelector('ol')?.start, 5);
  assert.equal(main.querySelector('blockquote input')?.getAttribute('data-task'), '?');
});
