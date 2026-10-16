import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { frontmatterMarkdown } from '../src/editor/frontmatter-syntax.ts';
import { liveMathMarkdown } from '../src/editor/live-math.ts';
import { liveInlineMarkdown } from '../src/editor/live-inline.ts';
import { bodyStart, liveProperties } from '../src/editor/live-properties.ts';

function state(doc: string) {
  return EditorState.create({doc, extensions: [markdown({base: markdownLanguage,
    extensions: [frontmatterMarkdown, liveInlineMarkdown, liveMathMarkdown]}), liveProperties()]});
}
function nodes(value: EditorState, name: string) {
  const result: {from:number; to:number}[] = [];
  syntaxTree(value).iterate({enter(node) { if (node.name === name) result.push({from:node.from, to:node.to}); }});
  return result;
}
for (const delimiter of ['$$', '```']) test(`frontmatter literal ${delimiter} cannot consume later Markdown blocks`, () => {
  const source = `---\nexample: |\n  ${delimiter}\n---\n\n$x$\n\n\`\`\`js\nconst x = 1\n\`\`\`\n\n$$\ny\n$$`;
  const value = state(source), start = bodyStart(value);
  assert.ok(start > 0);
  assert.equal(nodes(value, 'ZoridFrontmatter').length, 1);
  assert.deepEqual(nodes(value, 'ZoridMathInline').map(range => value.sliceDoc(range.from, range.to)), ['$x$']);
  assert.deepEqual(nodes(value, 'FencedCode').map(range => value.sliceDoc(range.from, range.to)), ['```js\nconst x = 1\n```']);
  assert.deepEqual(nodes(value, 'ZoridMathBlock').map(range => value.sliceDoc(range.from, range.to)), ['$$\ny\n$$']);
  assert.equal(value.doc.toString(), source);
});
test('metadata grammar supports BOM, comments and alternate closing delimiter', () => {
  const source = '\uFEFF--- # properties\nvalue: |\n  ```\n... # end\n\n$x$';
  const value = state(source);
  assert.ok(bodyStart(value) > 0);
  assert.equal(nodes(value, 'ZoridMathInline').length, 1);
  assert.equal(nodes(value, 'ZoridFrontmatter')[0].from, 0);
});
test('invalid and unclosed metadata stays visible without interpreting literal Markdown inside it', () => {
  for (const source of ['---\nbad: [\n---\n$x$', '---\nvalue: |\n  $$\n$x$']) {
    const value = state(source);
    assert.equal(bodyStart(value), 0, 'property panel does not conceal invalid YAML');
    assert.equal(nodes(value, 'ZoridFrontmatter').length, 1);
    assert.equal(value.doc.toString(), source);
  }
});
test('later horizontal rules and code-owned delimiter lines remain Markdown', () => {
  const value = state('Intro\n\n---\n\n```\n---\n```');
  assert.equal(nodes(value, 'ZoridFrontmatter').length, 0);
  assert.equal(nodes(value, 'HorizontalRule').length, 1);
  assert.equal(nodes(value, 'FencedCode').length, 1);
});
test('incremental edits opening and closing metadata update body ownership without changing offsets', () => {
  const source = '---\nvalue: |\n  $$\n---\n\n$x$';
  const initial = state(source), close = source.indexOf('\n---', 3) + 1;
  const opened = initial.update({changes:{from:close,to:close+3,insert:'end'}}).state;
  assert.equal(bodyStart(opened), 0); assert.equal(nodes(opened, 'ZoridMathInline').length, 0);
  const restored = opened.update({changes:{from:close,to:close+3,insert:'---'}}).state;
  assert.equal(restored.doc.toString(), source);
  assert.equal(nodes(restored, 'ZoridMathInline')[0].from, source.indexOf('$x$'));
});
