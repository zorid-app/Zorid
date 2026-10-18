import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compileSearchQuery, SearchQueryError } from '../src/search/query.ts';
import type { SearchDocument, SearchMatch } from '../src/search/query.ts';

const fixtureURL = new URL('./fixtures/document-semantics/search/s1-language.json', import.meta.url);
interface Case {
  id: string; query: string; document: SearchDocument;
  currentRustLiteral: { hits: { line: number; range: { bytes: [number, number]; utf16: [number, number] } }[] };
  target: { kind: 'match'; value: SearchMatch | null }
    | { kind: 'error'; category: SearchQueryError['code'] }
    | { kind: 'unsupported'; category: 'unsupported-regex'; legacyComparison: SearchMatch;
        rewrite: null | { query: string; expected: SearchMatch; scope: string } };
}
const fixture: { formatVersion: number; cases: Case[]; baseOracles: { file: string; sha256: string; caseIds: string[] }[] } = JSON.parse(await readFile(fixtureURL, 'utf8'));

test('S1 language fixtures preserve exact hand-counted UTF-8/UTF-16 source witnesses', () => {
  assert.equal(fixture.formatVersion, 1);
  assert.equal(fixture.cases.length, 19, 'Review added semantic expectations explicitly');
  assert.equal(new Set(fixture.cases.map(item => item.id)).size, fixture.cases.length);
  for (const item of fixture.cases) {
    const bytes = Buffer.from(item.document.text, 'utf8');
    for (const hit of item.currentRustLiteral.hits) {
      assert.equal(bytes.subarray(...hit.range.bytes).toString('utf8'), item.query, item.id);
      assert.equal(item.document.text.slice(...hit.range.utf16), item.query, item.id);
      assert.equal(Buffer.byteLength(item.document.text.slice(0, hit.range.utf16[0])), hit.range.bytes[0], item.id);
      assert.equal(item.document.text.slice(0, hit.range.utf16[0]).split('\n').length - 1, hit.line, item.id);
    }
  }
});

for (const item of fixture.cases) {
  test(`S1 target contract — TypeScript comparison only: ${item.id}`, () => {
    if (item.target.kind === 'error') {
      const category = item.target.category;
      assert.throws(() => compileSearchQuery(item.query), error => error instanceof SearchQueryError && error.code === category);
      return;
    }
    if (item.target.kind === 'unsupported') {
      // This deliberately records the legacy JS capability. It does not assert
      // that current TS rejects it or that shared Rust search already exists.
      assert.equal(item.target.category, 'unsupported-regex');
      assert.deepEqual(compileSearchQuery(item.query).match(item.document), item.target.legacyComparison);
      if (item.target.rewrite) {
        assert.ok(item.target.rewrite.scope.length > 0);
        assert.deepEqual(compileSearchQuery(item.target.rewrite.query).match(item.document), item.target.rewrite.expected);
        assert.deepEqual(item.target.rewrite.expected, item.target.legacyComparison);
      }
      return;
    }
    const compiled = compileSearchQuery(item.query);
    for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(compiled.match(item.document), item.target.value, item.id);
  });
}

test('S1 Bases matrix pins reviewed oracle bytes and named case identities', async () => {
  for (const oracle of fixture.baseOracles) {
    const bytes = await readFile(new URL(oracle.file, fixtureURL));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), oracle.sha256,
      `${oracle.file}: review oracle changes; do not refresh expectations from an evaluator`);
    const corpus = JSON.parse(bytes.toString('utf8')) as { cases: { id: string; expected: unknown }[] };
    const ids = new Set(corpus.cases.map(item => item.id));
    assert.equal(ids.size, corpus.cases.length);
    for (const id of oracle.caseIds) {
      const item = corpus.cases.find(item => item.id === id);
      assert.ok(item && Object.hasOwn(item, 'expected'), `${oracle.file}: missing approved oracle ${id}`);
    }
  }
});
