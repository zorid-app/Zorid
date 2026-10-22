import test from 'node:test';
import assert from 'node:assert/strict';
import { exportBaseResults } from '../src/bases/export.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const result: BaseQueryResult = {
  version: 1, view: { type: 'table', name: 'Table' },
  rows: [{ path: 'One.md', values: { 'file.name': { type: 'string', value: 'One' }, 'note.text': { type: 'string', value: 'a,"b"\n|c' } } }],
  properties: ['file.name', 'note.text'], availableProperties: ['file.name', 'note.text'], groups: [], groupOptions: [], diagnostics: [],
  counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 },
};
test('exports preserve multiline/quoted values and escape Markdown tables', () => {
  assert.equal(exportBaseResults(result, 'csv'), 'name,text\r\nOne,"a,""b""\n|c"');
  assert.equal(exportBaseResults(result, 'tsv'), 'name\ttext\r\nOne\t"a,""b""\n|c"');
  assert.equal(exportBaseResults(result, 'markdown'), '| name | text |\n| --- | --- |\n| One | a,"b"<br>\\|c |');
  assert.equal(exportBaseResults(result, 'paths'), 'One.md');
});
test('export never silently returns a partial materialization', () => {
  assert.throws(() => exportBaseResults({ ...result, counts: { ...result.counts, returned: 2 } }, 'csv'), /not fully materialized/);
  const rows = Array.from({ length: 1500 }, (_, i) => ({ path: `Note ${i}.md`, values: {} }));
  const exported = exportBaseResults({ ...result, rows, counts: { ...result.counts, returned: rows.length } }, 'paths');
  assert.equal(exported.split('\n').length, 1500);
  assert.ok(exported.endsWith('Note 1499.md'));
});
