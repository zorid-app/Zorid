import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMarkdownSubpath } from '../src/core/subpath.ts';

test('whole-document selection retains exact text and defines exclusive line bounds', () => {
  assert.deepEqual(selectMarkdownSubpath('one\r\ntwo\r\n', ''), { content: 'one\r\ntwo\r\n', startLine: 0, endLine: 2 });
  assert.deepEqual(selectMarkdownSubpath('', '#'), { content: '', startLine: 0, endLine: 0 });
  assert.deepEqual(selectMarkdownSubpath('one', ''), { content: 'one', startLine: 0, endLine: 1 });
});

test('heading sections include nested headings and stop at the next peer', () => {
  const source = '# Title\n## Topic\nBody\n### Nested\nChild\n## Next\nOther';
  assert.deepEqual(selectMarkdownSubpath(source, '#topic'), { content: '## Topic\nBody\n### Nested\nChild\n', startLine: 1, endLine: 5 });
  assert.equal(selectMarkdownSubpath(source, '#missing'), null);
});

test('heading selection ignores frontmatter, fenced text and indented code headings', () => {
  const source = '---\n# Topic\n---\n# Topic\n```md\n# Next\n```\n    # Also not a heading\n# End\n';
  assert.deepEqual(selectMarkdownSubpath(source, '#Topic'), { content: '# Topic\n```md\n# Next\n```\n    # Also not a heading\n', startLine: 3, endLine: 8 });
});

test('fences require matching markers and closing length, and can remain unclosed', () => {
  const source = '# A\n````md\n```\n# Hidden\n~~~~\n````\n# B\n';
  assert.equal(selectMarkdownSubpath(source, '#Hidden'), null);
  assert.equal(selectMarkdownSubpath(source, '#A')?.endLine, 6);
  assert.equal(selectMarkdownSubpath('# A\n~~~\n# Hidden', '#Hidden'), null);
});

test('heading matching decodes URI once, normalizes case, and supports visible inline text', () => {
  const source = '# **Café** [notes](note.md) ###\r\nbody\r\n# Other';
  assert.equal(selectMarkdownSubpath(source, '#CAF%C3%89%20notes')?.content, '# **Café** [notes](note.md) ###\r\nbody\r\n');
  assert.equal(selectMarkdownSubpath('# 100% done\nvalue', '#100% done')?.startLine, 0);
  assert.equal(selectMarkdownSubpath('# A%20B\nvalue', '#A%2520B')?.startLine, 0);
  assert.equal(selectMarkdownSubpath('# A B\nvalue', '#a-b'), null);
});

test('duplicate headings pick the first and setext headings delimit sections', () => {
  const source = 'Title\n=====\nbody\n\nSubheading\n----------\nsub\n# Title\nlast';
  assert.deepEqual(selectMarkdownSubpath(source, '#title'), { content: 'Title\n=====\nbody\n\nSubheading\n----------\nsub\n', startLine: 0, endLine: 7 });
  assert.equal(selectMarkdownSubpath(source, '#Subheading')?.startLine, 4);
});

test('inline paragraph block IDs select the whole paragraph and hide the marker', () => {
  const source = '# Note\n\nFirst line\r\nsecond line ^Ab-12\r\n\r\nNext paragraph';
  assert.deepEqual(selectMarkdownSubpath(source, '#^Ab-12'), { content: 'First line\r\nsecond line\r\n', startLine: 2, endLine: 4 });
  assert.equal(selectMarkdownSubpath(source, '#^ab-12'), null);
  assert.equal(selectMarkdownSubpath(source, '#^bad_id'), null);
});

test('standalone IDs target the preceding paragraph without including marker or separator', () => {
  const source = 'Previous paragraph\n\nChosen first\nchosen second\n\n^selected\n\nAfter';
  assert.deepEqual(selectMarkdownSubpath(source, '#^selected'), { content: 'Chosen first\nchosen second\n', startLine: 2, endLine: 4 });
  assert.equal(selectMarkdownSubpath('^orphan\ntext', '#^orphan'), null);
});

test('standalone IDs select list, fence and table blocks', () => {
  const cases = [
    { block: '- One\n  continuation\n\n- Two\n', end: 4 },
    { block: '```ts\nconst value = 1;\n```\n', end: 3 },
    { block: '| A | B |\n| --- | --- |\n| 1 | 2 |\n', end: 3 },
    { block: '> quote\n> continuation\n', end: 2 },
    { block: '    code\n    more\n', end: 2 },
  ];
  for (const { block, end } of cases) {
    assert.deepEqual(selectMarkdownSubpath(`${block}\n^ref\n\nAfter`, '#^ref'), { content: block, startLine: 0, endLine: end });
  }
});

test('markers inside code, frontmatter, comments and inline code are not block IDs', () => {
  const source = '---\nkey: text ^yaml\n---\n```\nparagraph ^fence\n^fence-alone\n```\n\n    code ^indented\n\nText `literal ^inline`\n\n<!-- text ^comment -->\n\n%% hidden ^hidden %%\n';
  for (const id of ['yaml', 'fence', 'fence-alone', 'indented', 'inline', 'comment', 'hidden']) assert.equal(selectMarkdownSubpath(source, `#^${id}`), null, id);
});

test('standalone ID cannot skip an intervening block to bind an earlier paragraph', () => {
  assert.equal(selectMarkdownSubpath('Paragraph\n\n# Heading\n\n^wrong', '#^wrong'), null);
});

test('selection handles a large single note without scanning other documents', () => {
  const text = '# Start\n' + 'body\n'.repeat(20000) + '# Target\nselected\n# End\n';
  const result = selectMarkdownSubpath(text, '#Target');
  assert.equal(result?.content, '# Target\nselected\n');
  assert.equal(result?.startLine, 20001);
});
