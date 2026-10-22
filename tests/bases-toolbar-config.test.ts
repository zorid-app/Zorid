import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument } from '../src/bases/document.ts';
import type { BaseValue, BaseViewPatch } from '../src/bases/document.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { parseBaseExpression } from '../src/bases/expression.ts';
import { validateToolbarPatch, propertyExpression, buildFilterCondition } from '../src/bases/toolbar-config.ts';

const snapshot = { version: 1, files: [
  { path: 'A.md', properties: { score: 2, status: 'Todo', done: false, empty: '', 'odd.key"': 'quoted "value"' } },
  { path: 'B.md', properties: { score: 10, status: 'Done', done: true } },
] };
const view = { type: 'table', name: 'Table', order: ['file.name', 'score', 'formula.future'], sort: [{ property: 'formula.future', direction: 'ASC', extension: { keep: ['yes'] } }], groupBy: { property: 'formula.missing', direction: 'DESC', extension: true } };
const result = executeBaseQuery(BaseDocument.parse(JSON.stringify({ views: [view] })), snapshot);
const validate = (patch: BaseViewPatch) => validateToolbarPatch(result, patch);
const selected = (filters: BaseValue) => executeBaseQuery(BaseDocument.parse(JSON.stringify({ views: [{ type: 'table', name: 'Filtered', filters }] })), snapshot).rows.map(row => row.path);

test('toolbar accepts only its staged keys and produces detached data', () => {
  const patch: BaseViewPatch = { name: '  Renamed  ', type: 'kanban', order: ['file.name', 'score', 'formula.future'], sort: [{ property: 'score', direction: 'ASC', extension: { tags: ['keep'] } }] };
  const output = validate(patch);
  assert.equal(output.name, 'Renamed'); assert.equal(output.type, 'kanban');
  assert.deepEqual(output.order, ['file.name', 'note.score', 'formula.future']);
  assert.notEqual(output.sort, patch.sort);
  ((patch.sort as any)[0].extension.tags as string[]).push('later');
  assert.deepEqual((output.sort as any)[0].extension.tags, ['keep']);
  assert.equal(patch.name, '  Renamed  ');
  for (const key of ['columnSize', 'pluginOption', '__proto__']) assert.throws(() => validate(Object.fromEntries([[key, 1]])), /Unsupported/);
});

test('toolbar requires a nonblank name and a supported built-in type', () => {
  for (const name of ['', ' \n ', undefined, null, 1]) assert.throws(() => validate({ name }), /name/);
  for (const type of ['graph', '', undefined, null]) assert.throws(() => validate({ type }), /type/);
  for (const type of ['table', 'cards', 'list', 'kanban']) assert.equal(validate({ type }).type, type);
});

test('property order permits existing unknown keys but rejects new unknown and normalized duplicates', () => {
  assert.deepEqual(validate({ order: ['formula.future', 'status', 'file'] }).order, ['formula.future', 'note.status', 'file.file']);
  assert.deepEqual(validate({ order: [] }).order, []);
  for (const order of [['score', 'note.score'], ['formula.new'], [null], [''], ['note.'], undefined]) assert.throws(() => validate({ order }));
});

test('sort criteria retain nested extensions and aliases without ambiguous or duplicate keys', () => {
  const output = validate({ sort: [{ column: 'status', direction: 'DESC', future: { x: [1, 2] } }, view.sort[0]] });
  assert.deepEqual(output.sort, [{ column: 'note.status', direction: 'DESC', future: { x: [1, 2] } }, view.sort[0]]);
  assert.deepEqual(validate({ sort: [] }).sort, []);
  for (const sort of [
    [{ property: 'new', direction: 'ASC' }], [{ property: 'score', direction: 'asc' }],
    [{ property: 'score', direction: 'ASC' }, { column: 'note.score', direction: 'DESC' }],
    [{ property: 'score', column: 'status', direction: 'ASC' }], [null], undefined,
  ]) assert.throws(() => validate({ sort }));
});

test('group changes preserve extensions and permit only an accompanying manual-order reset', () => {
  assert.deepEqual(validate({ groupBy: { property: 'status', direction: 'ASC', future: ['a'] }, groupOrder: undefined }), { groupBy: { property: 'note.status', direction: 'ASC', future: ['a'] }, groupOrder: undefined });
  assert.deepEqual(validate({ groupBy: view.groupBy }).groupBy, view.groupBy);
  const removal = validate({ groupBy: undefined, groupOrder: undefined });
  assert.equal(Object.hasOwn(removal, 'groupBy'), true); assert.equal(removal.groupBy, undefined);
  assert.throws(() => validate({ groupOrder: undefined }), /grouping change/);
  assert.throws(() => validate({ groupBy: undefined, groupOrder: [] }), /active grouping/);
  assert.throws(() => validate({ groupBy: null }));
  assert.throws(() => validate({ groupBy: { column: 'status', direction: 'ASC' } }), /requires a property/);
  assert.throws(() => validate({ groupBy: { property: 'new', direction: 'ASC' } }));
});

test('nested filters preserve explicit empty groups and syntax errors never escape validation', () => {
  const filters = { and: ['score > 1', { or: [] }, { not: [{ and: [] }] }] };
  assert.deepEqual(validate({ filters }).filters, filters);
  assert.notEqual(validate({ filters }).filters, filters);
  assert.deepEqual(validate({ filters: undefined }), { filters: undefined });
  assert.equal(validate({ filters: '' }).filters, '');
  for (const invalid of ['score >', { and: [], or: [] }, { xor: [] }, { not: 'done' }, [], null, 1]) assert.throws(() => validate({ filters: invalid }));
  assert.deepEqual(selected({ and: [] }), ['A.md', 'B.md']);
  assert.deepEqual(selected({ or: [] }), []);
});

test('filter structure has bounded depth and total node count', () => {
  let filters: BaseValue = 'true';
  for (let i = 0; i < 32; i++) filters = { and: [filters] };
  assert.doesNotThrow(() => validate({ filters }));
  assert.throws(() => validate({ filters: { and: [filters] } }), /deep|depth/);
  assert.doesNotThrow(() => validate({ filters: { and: Array(999).fill('true') } }));
  assert.throws(() => validate({ filters: { and: Array(1000).fill('true') } }), /node limit/);
});

test('staged patches reject getters, cycles, sparse lists and nonfinite extension values', () => {
  let calls = 0;
  const patch = Object.defineProperty({}, 'name', { enumerable: true, get() { calls++; return 'bad'; } });
  assert.throws(() => validate(patch), /data properties/); assert.equal(calls, 0);
  const criterion = Object.defineProperty({ property: 'score', direction: 'ASC' }, 'extension', { enumerable: true, get() { calls++; return 1; } });
  assert.throws(() => validate({ sort: [criterion] }), /data properties/); assert.equal(calls, 0);
  const cycle: any = {}; cycle.self = cycle;
  assert.throws(() => validate({ sort: [{ property: 'score', direction: 'ASC', cycle }] }), /cyclic/);
  assert.throws(() => validate({ order: Array(2) }), /sparse/);
  const disguisedHole = Array(1); disguisedHole[4294967295] = 'score';
  assert.throws(() => validate({ order: disguisedHole }), /named properties/);
  assert.throws(() => validate({ sort: [{ property: 'score', direction: 'ASC', extension: Infinity }] }), /unsupported/);
});

test('property references quote the full key and keep prototype-like names as data', () => {
  assert.equal(propertyExpression('a.b'), 'note["a.b"]');
  assert.equal(propertyExpression('file.name'), 'file["name"]');
  assert.equal(propertyExpression('file'), 'file["file"]');
  assert.equal(propertyExpression('__proto__'), 'note["__proto__"]');
  for (const property of ['x"] || true || note["x', 'formula.a.b', 'note.odd.key"', 'new\nline']) assert.doesNotThrow(() => parseBaseExpression(propertyExpression(property)));
  assert.throws(() => propertyExpression('')); assert.throws(() => propertyExpression('formula.'));
});

test('filter conditions safely round-trip quoted values and operate through the query engine', () => {
  assert.deepEqual(selected(buildFilterCondition('odd.key"', 'eq', 'quoted "value"', 'text')), ['A.md']);
  assert.deepEqual(selected(buildFilterCondition('status', 'eq', 'x" || true || "', 'text')), []);
  assert.deepEqual(selected(buildFilterCondition('score', 'gt', '2', 'number')), ['B.md']);
  assert.deepEqual(selected(buildFilterCondition('status', 'contains', 'od', 'text')), ['A.md']);
  assert.deepEqual(selected(buildFilterCondition('done', 'eq', 'false', 'boolean')), ['A.md']);
  assert.deepEqual(selected(buildFilterCondition('empty', 'unset', '', 'text')), ['B.md']);
  assert.deepEqual(selected(buildFilterCondition('empty', 'set', '', 'text')), ['A.md']);
  assert.equal(buildFilterCondition('score', 'lt', '1e2', 'number'), 'note["score"] < 100');
  assert.equal(buildFilterCondition('status', 'neq', 'Done', 'text'), 'note["status"] != "Done"');
});

test('numeric and boolean filter literals cannot be silently coerced or interpreted as code', () => {
  for (const value of ['', ' ', ' 2', '2 ', '0xff', '1_000', 'NaN', 'Infinity', '1e999', 'true', '1 || true']) assert.throws(() => buildFilterCondition('score', 'eq', value, 'number'), /finite decimal/);
  for (const value of ['.5', '-2', '+2.5', '2e-3', '1.']) assert.doesNotThrow(() => parseBaseExpression(buildFilterCondition('score', 'eq', value, 'number')));
  for (const value of ['', 'TRUE', '1', 'false ']) assert.throws(() => buildFilterCondition('done', 'eq', value, 'boolean'), /true or false/);
  assert.throws(() => buildFilterCondition('score', 'bad' as any, '2', 'number'), /operator/);
});
