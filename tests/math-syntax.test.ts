import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { mathInlineMarkdown, mathMarkdown, mathSpan } from '../src/editor/math-syntax.ts';
import type { MathSpan } from '../src/editor/math-syntax.ts';
import { liveInlineMarkdown } from '../src/editor/live-inline.ts';

function parse(source: string) {
  const state = EditorState.create({ doc: source, extensions: markdown({ base: markdownLanguage,
    extensions: [liveInlineMarkdown, mathMarkdown] }) });
  const tree = ensureSyntaxTree(state, source.length, 1000) ?? syntaxTree(state);
  const spans: MathSpan[] = [];
  tree.iterate({ enter(node) {
    const span = mathSpan(node.node, (from, to) => state.doc.sliceString(from, to));
    if (span) spans.push(span);
  } });
  return { state, tree, spans };
}

test('inline and display math preserve exact source ranges and TeX', () => {
  const source = 'A $x^2$ and $$\\frac{a}{b}$$.';
  const { spans } = parse(source);
  assert.deepEqual(spans, [
    { from: 2, to: 7, contentFrom: 3, contentTo: 6, tex: 'x^2', display: false, block: false, closed: true },
    { from: 12, to: 27, contentFrom: 14, contentTo: 25, tex: '\\frac{a}{b}', display: true, block: false, closed: true },
  ]);
});

test('single dollars require nonspace edges, same-line closure and no following digit', () => {
  for (const source of ['$ x$', '$x $', '$x$2', '$x\ny$', '$x', '$', '$$x', '$$$x$$$']) {
    assert.equal(parse(source).spans.length, 0, source);
  }
  assert.equal(parse('$5 + 3$').spans[0].tex, '5 + 3');
  assert.equal(parse('$$ x $$').spans[0].tex, ' x ');
});

test('escaped dollars stay literal and escaped inner dollars do not close math', () => {
  assert.equal(parse('\\$x$').spans.length, 0);
  assert.equal(parse('$x\\$y$').spans[0].tex, 'x\\$y');
  assert.equal(parse('$x\\\\$').spans[0].tex, 'x\\\\');
  assert.equal(parse('$$x\\$$y$$').spans[0].tex, 'x\\$$y');
});

test('code, HTML attributes, comments and wiki tokens retain ownership', () => {
  const excluded = ['`$x$`', '```tex\n$x$\n```', '    $x$', '<div>\n$x$\n</div>',
    '<!-- $x$ -->', '<span title="$x$">', '[[Note $x$|$y$]]', '![[Note $x$]]', '%% $x$ %%', '[label](https://x.test/$x$)'];
  for (const source of excluded) assert.equal(parse(source).spans.length, 0, source);
  assert.equal(parse('**$x$**').spans[0].tex, 'x');
});

test('standalone display block owns blank lines and nested Markdown literally', () => {
  const source = 'before\n$$\na + b\n\n**c** + `$x$`\n$$\nafter $z$';
  const { spans, tree } = parse(source);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0], { from: 7, to: 33, contentFrom: 9, contentTo: 31,
    tex: '\na + b\n\n**c** + `$x$`\n', display: true, block: true, closed: true });
  assert.equal(spans[1].tex, 'z');
  assert.doesNotMatch(tree.toString(), /StrongEmphasis|InlineCode/);
});

test('incomplete display block is preserved and explicitly marked unclosed', () => {
  const { spans } = parse('$$\nx + y\n\nz');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].closed, false);
  assert.equal(spans[0].tex, '\nx + y\n\nz');
  assert.equal(parse('$$').spans[0].closed, false);
});

test('standalone indentation and unsupported fence/container syntax stay bounded', () => {
  assert.equal(parse('  $$ \n x\n $$\t').spans[0].closed, true);
  for (const source of ['    $$\n    x\n    $$', '$$$\nx\n$$$', '> $$\n> x\n> $$', '- $$\n  x\n  $$']) {
    assert.equal(parse(source).spans.length, 0, source);
  }
});

test('editing the closing fence changes incomplete ownership without source mutation', () => {
  const initial = parse('$$\nx\n');
  const complete = initial.state.update({ changes: { from: initial.state.doc.length, insert: '$$' } }).state;
  const tree = ensureSyntaxTree(complete, complete.doc.length, 1000)!;
  const span = mathSpan(tree.topNode.firstChild!, (from, to) => complete.doc.sliceString(from, to));
  assert.equal(span?.closed, true);
  assert.equal(span?.tex, '\nx\n');
  assert.equal(complete.doc.toString(), '$$\nx\n$$');
  assert.equal(mathSpan(tree.topNode, () => ''), null);
});

test('inline-only math grammar never registers display blocks or interrupts multiline code', () => {
  const parser = markdown({ base: markdownLanguage, extensions: mathInlineMarkdown }).language.parser;
  for (const source of ['`\n$$\ny\n$$\n`', '``\n$$\n$x$\n$$\n``']) {
    assert.match(parser.parse(source).toString(), /InlineCode/);
    assert.doesNotMatch(parser.parse(source).toString(), /ZoridMath/);
  }
  assert.doesNotMatch(parser.parse('$$\ny\n$$').toString(), /ZoridMathBlock/);
  assert.match(parser.parse('**$x$** $$y$$').toString(), /ZoridMathInline/);
  assert.match(parser.parse('**$x$** $$y$$').toString(), /ZoridMathDisplay/);
  assert.match(parse('$$\ny\n$$').tree.toString(), /ZoridMathBlock/);
});
