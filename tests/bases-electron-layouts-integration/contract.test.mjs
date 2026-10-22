import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixtureFiles} from './fixtures.mjs';
import {assertWikiPayload} from './drag.mjs';
const yaml = createRequire(new URL('../../package.json', import.meta.url))('yaml');

test('supplemental fixture has exactly four rank-ordered ordinary notes and four valid layouts', () => {
  const files = fixtureFiles(); assert.equal(files.size, 5);
  for (const [file, source] of files) { assert.ok(!file.startsWith('/') && !file.split('/').includes('..')); assert.equal(typeof source, 'string'); }
  const base = yaml.parse(files.get('Layouts.base'));
  assert.deepEqual(base.views.map(view => [view.type, view.name]), [['cards', 'Grouped cards'], ['list', 'Grouped list'], ['kanban', 'Board'], ['kanban', 'Computed board']]);
  for (const view of base.views) { assert.deepEqual(view.sort, [{property: 'rank', direction: 'ASC'}]); assert.deepEqual(view.groupOrder, ['Todo', 'Done', 'Later']); }
  assert.equal(base.views[3].groupBy.property, 'formula.bucket');
  const rows = [...files].filter(([file]) => file.endsWith('.md')).map(([file, source]) => ({path: file, ...yaml.parse(source.match(/^---\n([\s\S]*?)\n---/)[1])}));
  assert.deepEqual(rows.filter(row => row.status === 'Todo').map(row => [row.path, row.rank]), [['Items/Alpha.md', 1], ['Items/Gamma.md', 3]]);
  assert.deepEqual(rows.filter(row => row.status === 'Done').map(row => [row.path, row.rank]), [['Items/Beta.md', 2], ['Items/Delta.md', 4]]);
});

test('native file-payload oracle rejects browser document URLs, empty and ambiguous plain values', () => {
  assertWikiPayload({items: [{mimeType: 'text/plain', data: '[[Items/Alpha]]'}]}, '[[Items/Alpha]]');
  for (const items of [[], [{mimeType: 'text/uri-list', data: 'file:///dist/index.html#'}], [{mimeType: 'text/plain', data: 'file:///dist/index.html#'}], [{mimeType: 'text/plain', data: '[[Items/Alpha]]'}, {mimeType: 'text/plain', data: '[[Items/Alpha]]'}]]) {
    assert.throws(() => assertWikiPayload({items}, '[[Items/Alpha]]'));
  }
});
