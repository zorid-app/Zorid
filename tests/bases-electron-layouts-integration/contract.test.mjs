import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {crc32, inflateSync} from 'node:zlib';
import {fixtureFiles, hoverTextFiles, hoverImage, hoverImagePath} from './fixtures.mjs';
import {assertWikiPayload} from './drag.mjs';
const yaml = createRequire(new URL('../../package.json', import.meta.url))('yaml');

test('supplemental fixture has exactly four rank-ordered ordinary notes and four valid layouts', () => {
  const files = fixtureFiles(); assert.equal(files.size, 9);
  for (const [file, source] of files) { assert.ok(!file.startsWith('/') && !file.split('/').includes('..')); assert.ok(typeof source === 'string' || Buffer.isBuffer(source)); }
  const base = yaml.parse(files.get('Layouts.base'));
  assert.deepEqual(base.views.map(view => [view.type, view.name]), [['cards', 'Grouped cards'], ['list', 'Grouped list'], ['kanban', 'Board'], ['kanban', 'Computed board']]);
  for (const view of base.views) { assert.deepEqual(view.sort, [{property: 'rank', direction: 'ASC'}]); assert.deepEqual(view.groupOrder, ['Todo', 'Done', 'Later']); }
  assert.equal(base.views[3].groupBy.property, 'formula.bucket');
  const rows = [...files].filter(([file]) => file.startsWith('Items/') && file.endsWith('.md')).map(([file, source]) => ({path: file, ...yaml.parse(source.match(/^---\n([\s\S]*?)\n---/)[1])}));
  assert.deepEqual(rows.filter(row => row.status === 'Todo').map(row => [row.path, row.rank]), [['Items/Alpha.md', 1], ['Items/Gamma.md', 3]]);
  assert.deepEqual(rows.filter(row => row.status === 'Done').map(row => [row.path, row.rank]), [['Items/Beta.md', 2], ['Items/Delta.md', 4]]);
});
test('hover fixture preserves reference002 source and separates binary resource membership', () => {
  const files = fixtureFiles(), hover = yaml.parse(files.get('Hover.base')), media = yaml.parse(files.get('MediaHover.base'));
  assert.equal(hover.filters, 'file.inFolder("HoverCases")'); assert.deepEqual(hover.views, [{type: 'table', name: 'Hover', order: ['file.name', 'note.kind']}]);
  assert.equal(files.get('HoverCases/HoverTarget.md'), '---\nkind: hover-fixture\n---\n# Hover target\n\nA **preview** paragraph for the owned reference hover.\n\nA second paragraph for entering the editor.\n');
  assert.equal(media.filters, 'file.inFolder("HoverMedia")'); assert.equal(hoverTextFiles.size, 3);
  assert.deepEqual(files.get(hoverImagePath), hoverImage); assert.equal(hoverImage.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(hoverImage.readUInt32BE(16), 1); assert.equal(hoverImage.readUInt32BE(20), 1);
  for (let offset = 8; offset < hoverImage.length;) { const length = hoverImage.readUInt32BE(offset), kind = hoverImage.toString('ascii', offset + 4, offset + 8); assert.equal(crc32(hoverImage.subarray(offset + 4, offset + 8 + length)), hoverImage.readUInt32BE(offset + 8 + length), kind + ' CRC'); if (kind === 'IDAT') assert.equal(inflateSync(hoverImage.subarray(offset + 8, offset + 8 + length)).length, 3); offset += length + 12; }
});

test('native file-payload oracle rejects browser document URLs, empty and ambiguous plain values', () => {
  assertWikiPayload({items: [{mimeType: 'text/plain', data: '[[Items/Alpha]]'}]}, '[[Items/Alpha]]');
  for (const items of [[], [{mimeType: 'text/uri-list', data: 'file:///dist/index.html#'}], [{mimeType: 'text/plain', data: 'file:///dist/index.html#'}], [{mimeType: 'text/plain', data: '[[Items/Alpha]]'}, {mimeType: 'text/plain', data: '[[Items/Alpha]]'}]]) {
    assert.throws(() => assertWikiPayload({items}, '[[Items/Alpha]]'));
  }
});
