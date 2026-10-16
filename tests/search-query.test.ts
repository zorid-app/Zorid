import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSearchQuery, mergeSearchRanges, parseSearchQuery, prepareSearchDocument, SearchQueryError,
} from '../src/search/query.ts';
import type { SearchDocument, SearchMetadata } from '../src/search/query.ts';

const doc = (text: string, metadata?: SearchMetadata, path = 'notes/Example.md'): SearchDocument => ({ path, text, metadata });
const search = (query: string, text: string, metadata?: SearchMetadata) => compileSearchQuery(query).match(doc(text, metadata));

test('AST preserves implicit conjunction, OR precedence and scoped grouping', () => {
  const ast = parseSearchQuery('file:alpha OR content:(beta -gamma)');
  assert.equal(ast?.kind, 'or');
  assert.equal(ast?.kind === 'or' && ast.children[1].kind, 'scope');
  assert.ok(search('alpha beta OR gamma', 'gamma'));
  assert.equal(search('alpha beta OR gamma', 'alpha'), null);
  assert.ok(search('(alpha OR beta) gamma', 'beta gamma'));
  assert.equal(search('(alpha OR beta) gamma', 'beta'), null);
  assert.ok(search('-alpha', 'beta'));
  assert.deepEqual(search('-alpha', 'beta'), {});
  assert.equal(search('-alpha', 'alpha'), null);
});

test('plain text is literal, OR is case-sensitive, whitespace follows tokenizer rules', () => {
  assert.deepEqual(search('a.b', 'a.b axb'), { content: [[0, 3]] });
  assert.equal(search('a or b', 'a b'), null);
  assert.ok(search('a or b', 'a or b'));
  assert.equal(search('a\tb', 'a b'), null);
  assert.ok(search('a\tb', 'a\tb'));
  assert.ok(search('well-known', 'well-known'));
  assert.equal(search('well-known', 'well known'), null);
});

test('quotes have content word boundaries but file/path substring semantics', () => {
  assert.deepEqual(search('"cat"', 'cat concatenate cat_ cat2 2cat'), { content: [[0, 3], [16, 19]] });
  assert.equal(compileSearchQuery('file:"cat"').match(doc('', undefined, 'concatenate.md'))?.filename?.[0][0], 3);
  assert.ok(compileSearchQuery('path:"cat"').match(doc('', undefined, 'concatenate/Note.md')));
  assert.deepEqual(search('"é"', 'é café é_ é2'), { content: [[0, 1], [7, 8]] });
  assert.deepEqual(search('"cat!"', 'cat! cats!'), { content: [[0, 4]] });
});

test('quoted escapes, regex slash escapes and incomplete delimiters are preserved', () => {
  assert.ok(search(String.raw`"say \"hi\""`, 'say "hi"'));
  assert.ok(search('"a\\\\b"', 'a\\b'));
  assert.deepEqual(search('/a\\/b/', 'a/b'), { content: [[0, 3]] });
  assert.deepEqual(search('/a\\db/', 'a3b'), { content: [[0, 3]] });
  assert.deepEqual(search('"two words', 'two words'), { content: [[0, 9]] });
  assert.deepEqual(search('/ab', 'abc'), { content: [[0, 2]] });
  assert.ok(search('(alpha OR beta', 'beta'));
  assert.ok(search('alpha OR', 'alpha'));
  assert.ok(search('alpha ) absent', 'alpha'));
  assert.equal(search('file:', 'anything'), null);
  assert.equal(parseSearchQuery(''), null);
});

test('regex uses multiline and configurable case, omits zero-width matches and flags suffixes', () => {
  assert.deepEqual(search('/^b/', 'A\nB\nb'), { content: [[2, 3], [4, 5]] });
  assert.deepEqual(compileSearchQuery('/^b/', { caseSensitive: true }).match(doc('A\nB\nb')), { content: [[4, 5]] });
  assert.deepEqual(search('/(?=a)|a/', 'aa'), null);
  assert.equal(search('/a.b/', 'a\nb'), null);
  assert.equal(search('/alpha/i', 'alpha'), null); // i is an adjacent text term, not a flag.
  assert.deepEqual(search('//', 'anything'), {});
  assert.deepEqual(search('ignore-case:ALPHA match-case:Beta', 'alpha Beta beta'), { content: [[0, 5], [6, 10]] });
  assert.equal(search('match-case:alpha', 'Alpha'), null);
});

test('invalid regex, unknown operators and disallowed operands report structured errors', () => {
  const cases: [string, SearchQueryError['code']][] = [
    ['/(/', 'invalid-regex'], ['unknown:value', 'unknown-operator'], ['file:path:x', 'invalid-nesting'],
    ['line:task:x', 'invalid-nesting'], ['section:line:x', 'invalid-nesting'], ['[a:[b]]', 'invalid-nesting'],
    ['tag:"topic"', 'invalid-operand'], ['tag:/topic/', 'invalid-operand'], ['>/3/', 'invalid-operand'],
  ];
  for (const [query, code] of cases) assert.throws(() => compileSearchQuery(query), (error: unknown) => error instanceof SearchQueryError && error.code === code && Number.isInteger(error.position), query);
});

test('files default to md/canvas/base names while explicit file/path address attachments', () => {
  assert.ok(compileSearchQuery('Example').match(doc('')));
  assert.equal(compileSearchQuery('photo').match(doc('', undefined, 'media/photo.png')), null);
  assert.deepEqual(compileSearchQuery('file:photo').match(doc('', undefined, 'media/photo.png')), { filename: [[0, 5]] });
  assert.deepEqual(compileSearchQuery('path:media').match(doc('', undefined, 'media/photo.png')), { filepath: [[0, 5]] });
  assert.equal(compileSearchQuery('secret').match(doc('secret', undefined, 'data.base')), null);
  assert.deepEqual(compileSearchQuery('file:.md').match(doc('')), { filename: [[7, 10]] });
});

test('line scope requires conjunction in one line and exclusion produces navigable zero width', () => {
  assert.equal(search('line:(alpha beta)', 'alpha\nbeta'), null);
  assert.deepEqual(search('line:(alpha beta)', 'alpha\nbeta alpha'), { content: [[6, 10], [11, 16]] });
  assert.deepEqual(search('line:-alpha', 'alpha\nbeta'), { content: [[6, 6]] });
  assert.deepEqual(search('line:/\r$/', 'abc\r\ndef'), { content: [[3, 4]] });
});

test('block scope consumes metadata sections and individual list-item spans', () => {
  const text = 'alpha\nbeta\n- alpha\n- beta';
  const metadata: SearchMetadata = { sections: [{ type: 'paragraph', start: 0, end: 10 }, { type: 'list', start: 11, end: text.length }], listItems: [{ start: 11, end: 18 }, { start: 19, end: text.length }] };
  assert.deepEqual(search('block:(alpha beta)', text, metadata), { content: [[0, 5], [6, 10]] });
  assert.equal(search('block:alpha', text), null);
  assert.deepEqual(search('block:beta', text, metadata), { content: [[6, 10], [21, 25]] });
});

test('section intervals separate subheadings while nested section visits descendants', () => {
  const text = 'intro\n# Parent\nalpha\n## Child\nbeta\n### Deep\ngamma\n# Other\ndelta';
  const headings = [{ level: 1, line: 1 }, { level: 2, line: 3 }, { level: 3, line: 5 }, { level: 1, line: 7 }];
  const metadata = { headings };
  assert.equal(search('section:(alpha beta)', text, metadata), null);
  assert.deepEqual(search('section:(alpha section:beta)', text, metadata), { content: [[15, 20], [30, 34]] });
  assert.deepEqual(search('section:(alpha section:(beta section:gamma))', text, metadata), { content: [[15, 20], [30, 34], [44, 49]] });
  assert.ok(search('section:intro', text, metadata));
  assert.equal(search('section:(beta section:delta)', text, metadata), null);
  assert.ok(search('section:alpha', text, {}));
  assert.equal(search('section:section:alpha', text, {}), null);
  assert.equal(search('section:alpha', text, { headings: [] }), null);
});

test('tasks use metadata markers; every non-space marker is done; quoted empty selects all', () => {
  const text = '- [ ] todo\n- [x] done\n- [-] custom\n- ordinary';
  const metadata: SearchMetadata = { listItems: [{ start: 0, end: 10, task: ' ' }, { start: 11, end: 21, task: 'x' }, { start: 22, end: 34, task: '-' }, { start: 35, end: text.length }] };
  assert.deepEqual(search('task-todo:""', text, metadata), { content: [[0, 0]] });
  assert.deepEqual(search('task-done:""', text, metadata), { content: [[11, 11], [22, 22]] });
  assert.equal(search('task:', text, metadata), null);
  assert.deepEqual(search('task:custom', text, metadata), { content: [[28, 34]] });
  assert.equal(search('task:todo', text), null);
});

test('tag matches complete names and descendants case-insensitively from metadata only', () => {
  const text = '#Work #work/sub #workshop';
  const metadata: SearchMetadata = { tags: [{ tag: '#Work', start: 0, end: 5 }, { tag: '#work/sub', start: 6, end: 15 }, { tag: '#workshop', start: 16, end: 25 }], frontmatter: { Tags: ['work/child', 'other'] } };
  assert.deepEqual(search('match-case:tag:WORK', text, metadata), { content: [[0, 5], [6, 15]], properties: [{ key: 'Tags' }] });
  assert.equal(search('tag:wor', text, metadata), null);
  assert.equal(search('tag:work', text), null);
  assert.deepEqual(search('tag:work', text, { tags: ['work'] }), { content: [] });
  assert.equal(search('tag:work', '', { frontmatter: { tags: 'work, other' } }), null);
  assert.deepEqual(search('tag:work', '', { frontmatter: { tags: ['  #work  ', 'bad tag'] } }), { content: [], properties: [{ key: 'tags' }] });
});

test('properties distinguish quoted exact keys, unquoted partial keys and typed values', () => {
  const metadata: SearchMetadata = { frontmatter: { Status: 'active', 'Status Detail': 'pending', truth: true, falsity: false, empty: null, blank: '', number: 12, string: '12', items: ['active', 'inactive'], object: { active: true } } };
  assert.deepEqual(search('[status]', '', metadata), { properties: [{ key: 'Status' }, { key: 'Status Detail' }] });
  assert.deepEqual(search('match-case:["status"]', '', metadata), { properties: [{ key: 'Status' }] });
  assert.equal(search('match-case:[status]', '', metadata), null);
  assert.deepEqual(search('[truth:TRUE]', '', metadata), { properties: [{ key: 'truth', pos: [0, 4] }] });
  assert.ok(search('[falsity:FALSE]', '', metadata));
  assert.ok(search('[empty:EMPTY]', '', metadata));
  assert.equal(search('[blank:EMPTY]', '', metadata), null);
  assert.equal(search('[missing:EMPTY]', '', metadata), null);
  assert.ok(search('[number:>9]', '', metadata));
  assert.equal(search('[string:>9]', '', metadata), null); // lexical, not universal numeric coercion.
  assert.deepEqual(search('[items:"active"]', '', metadata), { properties: [{ key: 'items', subkey: [0], pos: [0, 6] }] });
  assert.equal(search('[Status:-absent]', '', metadata), null); // no content interval to produce a property record.
  assert.ok(search('[Status:(active -absent)]', '', metadata));
  assert.equal(search('[object:active]', '', metadata), null); // no recursive object traversal.
});

test('range merging, Boolean branches and astral offsets preserve UTF-16 coordinates', () => {
  assert.deepEqual(mergeSearchRanges([[5, 8], [0, 2], [2, 5], [12, 13]]), [[0, 8], [12, 13]]);
  assert.deepEqual(search('cat OR at', 'cat'), { content: [[0, 3]] });
  assert.deepEqual(search('😀 OR cat', '😀cat'), { content: [[0, 5]] });
  assert.deepEqual(search('cat', '😀cat\n😀cat'), { content: [[2, 5], [8, 11]] });
  assert.deepEqual(search('line:cat', '😀cat\n😀cat'), { content: [[2, 5], [8, 11]] });
});

test('compiled queries reuse patterns without state leakage across repeated documents', () => {
  const query = compileSearchQuery('/alpha/');
  for (let index = 0; index < 10; index++) {
    assert.deepEqual(query.match(doc('alpha alpha')), { content: [[0, 5], [6, 11]] });
    assert.equal(query.match(doc('beta')), null);
  }
  const document = prepareSearchDocument(doc('# A\nalpha\n## B\nbeta', { headings: [{ level: 1, line: 0 }, { level: 2, line: 2 }] }));
  assert.equal(document.lineRanges(), document.lineRanges());
  assert.equal(document.headingIntervals(), document.headingIntervals());
  assert.ok(compileSearchQuery('section:(alpha section:beta)').match(document));
  assert.ok(compileSearchQuery('line:beta').match(document));
});

test('required inputs permit cheap filename/property queries without content reads', () => {
  assert.deepEqual(compileSearchQuery('file:alpha OR path:notes').requiredInputs, { content: false, metadata: false });
  assert.deepEqual(compileSearchQuery('[status:active]').requiredInputs, { content: false, metadata: true });
  assert.deepEqual(compileSearchQuery('file:alpha task:""').requiredInputs, { content: true, metadata: true });
  assert.deepEqual(compileSearchQuery('match-case:alpha').requiredInputs, { content: true, metadata: false });
  assert.equal(compileSearchQuery('').match(doc('anything')), null);
});

test('content scope excludes filename hits and empty/inapplicable matchers remain distinct', () => {
  assert.equal(compileSearchQuery('content:Example').match(doc('body')), null);
  assert.ok(compileSearchQuery('Example').match(doc('body')));
  assert.deepEqual(search('""', 'body'), {});
  assert.deepEqual(search('"" beta', 'beta'), { content: [[0, 4]] });
  assert.deepEqual(search('EMPTY', 'body'), { content: [[0, 4]] });
  assert.equal(search('TRUE', 'body'), null);
  assert.equal(search('[missing]', 'body', { frontmatter: {} }), null);
  assert.ok(search('[status:active', '', { frontmatter: { status: 'active' } }));
});
