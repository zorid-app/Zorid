import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdownInline } from '../src/ui/markdown-inline.ts';
import type { EmbedRequest } from '../src/ui/markdown.ts';
import { destroyMathRenders } from '../src/ui/reading-math.ts';

function render(source: string, withEmbeds = false) {
  const document = new JSDOM('<!doctype html><main></main>').window.document;
  const parent = document.querySelector('main')!;
  const opened: [string, string | undefined][] = [], embeds: EmbedRequest[] = [];
  renderMarkdownInline(parent, source, (target, kind) => opened.push([target, kind]), withEmbeds ? {
    embed(request) { embeds.push(request); const image = document.createElement('span'); image.className = 'test-embed'; image.textContent = request.label ?? request.target; return image; },
  } : {});
  // Parsing tests inspect the synchronous safe source placeholder. Cancel the
  // asynchronous engine load; real conversion is tested separately.
  destroyMathRenders(parent);
  return { parent, opened, embeds, document };
}

test('nested emphasis, strong, strike and highlight preserve their hierarchy', () => {
  const { parent } = render('***one*** __two *three*__ ~~four **five**~~ ==six *seven*==');
  assert.equal(parent.textContent, 'one two three four five six seven');
  assert.equal(parent.querySelector('em > strong')?.textContent, 'one');
  assert.equal(parent.querySelector('strong > em')?.textContent, 'three');
  assert.equal(parent.querySelector('s > strong')?.textContent, 'five');
  assert.equal(parent.querySelector('mark > em')?.textContent, 'seven');
  assert.equal(render('word_under_score * unmatched == bad== ====x====').parent.textContent,
    'word_under_score * unmatched == bad== ====x====');
});

test('escapes depend on backslash parity and consume punctuation only', () => {
  assert.equal(render(String.raw`\*literal\* \[x\] \==literal== \a`).parent.textContent, '*literal* [x] ==literal== \\a');
  const even = render(String.raw`\\*em* \\[[Note]]`);
  assert.equal(even.parent.querySelector('em')?.textContent, 'em');
  assert.equal(even.parent.querySelector('a')?.textContent, 'Note');
  assert.equal(even.parent.textContent, '\\em \\Note');
});

test('code delimiter runs and whitespace are parsed before other inline syntax', () => {
  const { parent, embeds } = render('`` `literal` ![[image]] %%visible%% `` / ` a\nb ` / `   ` / ```x``y```', true);
  assert.deepEqual([...parent.querySelectorAll('code')].map(node => node.textContent),
    ['`literal` ![[image]] %%visible%%', 'a b', '   ', 'x``y']);
  assert.equal(embeds.length, 0);
  assert.equal(render('unclosed `code **bold**').parent.querySelector('strong')?.textContent, 'bold');
});

test('Markdown links preserve nested labels, escaped destinations, titles and clicks', () => {
  const { parent, opened } = render('[**Go** *now*](folder/a\\(b\\).md "A &amp; B") [web](https://example.com/a?q=1&amp;x=2)');
  const local = parent.querySelector('a')!;
  assert.equal(local.querySelector('strong')?.textContent, 'Go');
  assert.equal(local.querySelector('em')?.textContent, 'now');
  assert.equal(local.title, 'A & B');
  local.click();
  assert.deepEqual(opened, [['folder/a(b).md', 'markdown']]);
  const external = parent.querySelector<HTMLAnchorElement>('.external-link')!;
  assert.equal(external.href, 'https://example.com/a?q=1&x=2');
  assert.equal(external.target, '_blank');
  assert.equal(external.rel, 'noopener noreferrer');
});

test('wikilinks normalize Unicode targets and treat aliases as plain text', () => {
  const { parent, opened } = render('[[ cafe\u0301\u00a0note#Section | **Alias** ]] [[Note#Heading#^block]]');
  const links = [...parent.querySelectorAll('a')];
  assert.equal(links[0].textContent, '**Alias**');
  assert.equal(links[0].querySelector('strong'), null);
  links[0].click();
  assert.deepEqual(opened, [['café note#Section', 'wiki']]);
  assert.equal(links[1].textContent, 'Note > Heading > ^block');
  assert.equal(render('[[未完成 😀').parent.textContent, '[[未完成 😀');
});

test('each image invokes its callback once, including nested formatting and comments', () => {
  const { parent, embeds } = render('**![[image.png|100]]** ![雪 😀](<images/a b.png> "title") %%![[hidden]]%% `![[code]]`', true);
  assert.deepEqual(embeds, [
    { target: 'image.png', kind: 'wiki', label: '100' },
    { target: 'images/a b.png', kind: 'markdown', label: '雪 😀' },
  ]);
  assert.equal(parent.querySelectorAll('.test-embed').length, 2);
  assert.equal(parent.querySelector('strong > .test-embed')?.textContent, '100');
  assert.equal(parent.querySelector('code')?.textContent, '![[code]]');
  assert.deepEqual(render('![**bold** *italic* `code` &amp;](image.png)', true).embeds,
    [{ target: 'image.png', kind: 'markdown', label: 'bold italic code &' }]);
});

test('comments disappear only outside code and escaped delimiters', () => {
  assert.equal(render('before %%**hidden**%% after').parent.textContent, 'before  after');
  assert.equal(render(String.raw`\%%literal%%`).parent.textContent, '%%literal%%');
  assert.equal(render('%% unclosed').parent.textContent, '%% unclosed');
  assert.equal(render('%%multiline\ncomment%%').parent.textContent, '%%multiline\ncomment%%');
});

test('raw HTML, entities, code and unsafe URLs cannot create active note DOM', () => {
  const { parent, embeds, opened } = render('<img src=x onerror="alert(1)"> &lt;script&gt; `</code><svg onload=x>` [bad](javascript:alert%281%29) ![bad](data:text/html,x) [encoded](java&#x73;cript:evil)', true);
  assert.equal(parent.querySelector('img,svg,script'), null);
  assert.ok(parent.textContent?.includes('<img src=x onerror="alert(1)"> <script>'));
  assert.equal(parent.querySelector('code')?.textContent, '</code><svg onload=x>');
  assert.equal(parent.querySelectorAll('a.unsupported-link').length, 3);
  for (const anchor of parent.querySelectorAll('a')) { assert.equal(anchor.hasAttribute('href'), false); anchor.click(); }
  assert.deepEqual(embeds, []); assert.deepEqual(opened, []);
});

test('unsupported document syntax remains literal and inline containers stay inline', () => {
  const source = '# title [reference][id] [^footnote]\n\n[id]: note.md';
  const { parent } = render(source);
  assert.equal(parent.textContent, source);
  assert.equal(parent.querySelector('h1,p,a'), null);
  assert.equal(render('😀 &amp; &#x1f680;').parent.textContent, '😀 & 🚀');
});

test('math follows nested formatting and link labels without interpreting TeX as Markdown', () => {
  const { parent, opened } = render('**$x_1$** *$a*b$* ==$x$== [value $y^2$](note.md) $$z$$');
  assert.equal(parent.querySelector('strong > .math-inline')?.textContent, 'x_1');
  assert.equal(parent.querySelector('em > .math-inline')?.textContent, 'a*b');
  assert.equal(parent.querySelector('mark > .math-inline')?.textContent, 'x');
  assert.equal(parent.querySelector('a > .math-inline')?.textContent, 'y^2');
  assert.equal(parent.querySelector('span.math-block')?.textContent, 'z');
  parent.querySelector('a')!.click();
  assert.deepEqual(opened, [['note.md', 'markdown']]);
});

test('code, escapes, wiki aliases, comments, destinations and image alt text own their dollar signs', () => {
  const { parent, embeds } = render('\\$escaped$ `$code$` [[Note|$alias$]] %%$hidden$%% [label](path/$destination$.md) ![$alt$](image.png) $visible$', true);
  assert.deepEqual([...parent.querySelectorAll('.math')].map(node => node.textContent), ['visible']);
  assert.equal(parent.querySelector('code')?.textContent, '$code$');
  assert.equal(parent.querySelector('.internal-link')?.textContent, '$alias$');
  assert.deepEqual(embeds, [{ target: 'image.png', kind: 'markdown', label: '$alt$' }]);
});

test('math boundary guards keep money, whitespace and incomplete syntax literal', () => {
  const source = '$5 and $10 / $ x$ / $x $ / $x$2 / $$unclosed / $$$x$$$';
  const { parent } = render(source);
  assert.equal(parent.querySelector('.math'), null);
  assert.equal(parent.textContent, source);
  const even = render(String.raw`\\$x$`);
  assert.equal(even.parent.textContent, '\\x');
  assert.equal(even.parent.querySelector('.math-inline')?.textContent, 'x');
});

test('autolinks and image placeholders use safe navigation and owning document', () => {
  const { parent, opened, document } = render('<https://example.com> user@example.com ![[note]]');
  assert.equal(parent.querySelectorAll('.external-link').length, 2);
  const placeholder = parent.querySelector<HTMLAnchorElement>('.embed-placeholder')!;
  assert.equal(placeholder.ownerDocument, document);
  placeholder.click(); assert.deepEqual(opened, [['note', 'wiki']]);
});
