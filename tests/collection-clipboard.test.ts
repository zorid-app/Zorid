import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionClipboardValue, prepareCollectionClipboardEdits } from '../src/databases/collection-clipboard.ts';
import type { DatabaseCollection, DatabaseProperty } from '../src/core/databases.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';

const str = (value: string): BaseExpressionValue => ({ type: 'string', value });
const list = (...values: string[]): BaseExpressionValue => ({ type: 'list', value: values.map(str) });
const options = [{ id: 'choice-red', name: 'Red, warm' }, { id: 'choice-blue', name: 'Blue' }];
const fields: DatabaseProperty[] = [
  { id: 'text', name: 'Text', datatype: 'text', options: [] },
  { id: 'number', name: 'Amount', datatype: 'number', options: [] },
  { id: 'checkbox', name: 'Ready', datatype: 'checkbox', options: [] },
  { id: 'date', name: 'Day', datatype: 'date', options: [] },
  { id: 'datetime', name: 'Time', datatype: 'datetime', options: [] },
  { id: 'select', name: 'Color', datatype: 'select', options },
  { id: 'multi-select', name: 'Colors', datatype: 'multi-select', options },
  { id: 'status', name: 'Status', datatype: 'status', options: [{ id: 'status-working', name: 'In progress', category: 'working' }, { id: 'status-done', name: 'Done', category: 'done' }] },
];
const collection: DatabaseCollection = { id: 'collection', name: 'Clipboard test', revision: 'schema-r1', deleted: false, properties: fields };
const convert = (property: string, value: BaseExpressionValue) => collectionClipboardValue(collection, `note.${property}`, value);

test('all eight collection datatypes convert clipboard strings into persisted typed values', () => {
  assert.deepEqual(convert('text', str('Exact\ntext, spaces  ')), str('Exact\ntext, spaces  '));
  assert.deepEqual(convert('number', str(' -1.25e2 ')), { type: 'number', value: -125 });
  assert.deepEqual(convert('checkbox', str('false')), { type: 'boolean', value: false });
  assert.deepEqual(convert('date', str('2028-02-29')), str('2028-02-29'));
  assert.deepEqual(convert('datetime', str('2026-10-28T12:34:56.123456789+05:30')), str('2026-10-28T12:34:56.123456789+05:30'));
  assert.deepEqual(convert('select', str('Blue')), str('choice-blue'));
  assert.deepEqual(convert('multi-select', str('["Red, warm","Blue"]')), list('choice-red', 'choice-blue'));
  assert.deepEqual(convert('status', str('Done')), str('status-done'));
});

test('already typed scalars, nulls, empty lists and exact datetime spelling are retained', () => {
  const values: [string, BaseExpressionValue][] = [['text', Object.freeze(str(''))], ['number', Object.freeze({ type: 'number', value: 0 })], ['checkbox', Object.freeze({ type: 'boolean', value: false })], ['date', Object.freeze(str('2026-10-28'))], ['datetime', Object.freeze(str('2026-10-28T12:34:56.123456789-04:00'))], ['select', Object.freeze(str('choice-blue'))], ['status', Object.freeze(str('status-done'))], ['multi-select', Object.freeze(list())], ['multi-select', Object.freeze(list('choice-red', 'choice-blue'))]];
  for (const [property, value] of values) assert.equal(convert(property, value), value, property);
  const nullValue: BaseExpressionValue = Object.freeze({ type: 'null' });
  for (const field of fields) assert.equal(convert(field.id, nullValue), nullValue, field.id);
});

test('blank non-text clipboard cells clear nullable values without inventing empty arrays', () => {
  for (const field of fields.filter(field => field.datatype !== 'text')) assert.deepEqual(convert(field.id, str('')), { type: 'null' }, field.id);
  assert.deepEqual(convert('multi-select', str('[]')), list());
});

test('multi-select accepts newline labels and mixed stable identities without splitting commas', () => {
  assert.deepEqual(convert('multi-select', str('Red, warm\nBlue')), list('choice-red', 'choice-blue'));
  assert.deepEqual(convert('multi-select', list('choice-red', 'Blue')), list('choice-red', 'choice-blue'));
  assert.deepEqual(convert('multi-select', str('Red, warm')), list('choice-red'));
});

test('unknown or ambiguous option labels and identities reject rather than choose a target', () => {
  for (const property of ['select', 'status', 'multi-select']) assert.throws(() => convert(property, str('Missing')), /not configured/);
  const ambiguous: DatabaseCollection = { ...collection, properties: [{ id: 'select', name: 'Ambiguous', datatype: 'select', options: [{ id: 'first', name: 'second' }, { id: 'second', name: 'Other' }] }] };
  assert.throws(() => collectionClipboardValue(ambiguous, 'note.select', str('second')), /ambiguous/);
  const duplicateLabels: DatabaseCollection = { ...ambiguous, properties: [{ ...ambiguous.properties[0], datatype: 'multi-select', options: [{ id: 'first', name: 'Same' }, { id: 'second', name: 'Same' }] }] };
  assert.throws(() => collectionClipboardValue(duplicateLabels, 'note.select', list('Same')), /ambiguous/);
});

test('invalid numbers, booleans and dates are rejected before core mutation', () => {
  for (const value of ['3x', 'NaN', 'Infinity', '0x10', '9007199254740992']) assert.throws(() => convert('number', str(value)), /Amount:/, value);
  for (const value of ['yes', 'TRUE', ' true ']) assert.throws(() => convert('checkbox', str(value)), /Ready:/, value);
  for (const value of ['2026-02-29', '2026-13-01', '2026-10-28T00:00']) assert.throws(() => convert('date', str(value)), /Day:/, value);
  for (const value of ['2026-10-28', '2026-10-28T24:01', '2026-10-28T12:34+01:99']) assert.throws(() => convert('datetime', str(value)), /Time:/, value);
});

test('pretyped values still obey the target schema and collection storage representation', () => {
  assert.throws(() => convert('text', { type: 'number', value: 5 }), /Expected text/);
  assert.throws(() => convert('number', { type: 'number', value: Number.NaN }), /finite number/);
  assert.throws(() => convert('number', { type: 'number', value: Number.MAX_SAFE_INTEGER + 1 }), /exactly representable/);
  assert.throws(() => convert('checkbox', { type: 'number', value: 1 }), /Expected true or false/);
  assert.throws(() => convert('date', { type: 'date', timestamp: 0, hasTime: false }), /valid date/);
  assert.throws(() => convert('datetime', { type: 'date', timestamp: 0, hasTime: true }), /valid date/);
  assert.throws(() => convert('select', list('choice-blue')), /one configured option/);
  assert.throws(() => convert('multi-select', { type: 'list', value: [{ type: 'number', value: 1 }] }), /list of configured options/);
  assert.throws(() => convert('multi-select', list('choice-blue', 'Blue')), /duplicate options/);
  assert.throws(() => convert('multi-select', list(...Array(129).fill('choice-blue'))), /list of configured options/);
});

test('target lookup requires a unique field identity and an available collection', () => {
  assert.throws(() => collectionClipboardValue(collection, 'note.Missing', str('value')), /property is missing/);
  assert.throws(() => collectionClipboardValue(collection, 'Amount', str('5')), /property is missing/);
  assert.throws(() => collectionClipboardValue({ ...collection, deleted: true }, 'note.text', str('value')), /unavailable/);
  assert.throws(() => collectionClipboardValue({ ...collection, properties: [fields[0], fields[0]] }, 'note.text', str('value')), /ambiguous/);
  assert.deepEqual(collectionClipboardValue(collection, 'number', str('5')), { type: 'number', value: 5 });
});

test('complete batch validation retains every command witness and never mutates input', () => {
  const input = Object.freeze([{ version: 8, path: 'First.md', property: 'note.number', value: Object.freeze(str('12')) }, { version: 8, path: 'Second.md', property: 'note.checkbox', value: Object.freeze(str('true')) }].map(Object.freeze));
  const prepared = prepareCollectionClipboardEdits(collection, input);
  assert.deepEqual(prepared, [{ version: 8, path: 'First.md', property: 'note.number', value: { type: 'number', value: 12 } }, { version: 8, path: 'Second.md', property: 'note.checkbox', value: { type: 'boolean', value: true } }]);
  assert.equal(input[0].value.type, 'string'); assert.notEqual(prepared, input); assert.notEqual(prepared[0], input[0]);
});

test('an invalid later cell prevents every mutation in a prepared clipboard batch', () => {
  const mutations: unknown[] = [], edits = [{ path: 'First.md', property: 'note.number', value: str('12') }, { path: 'Second.md', property: 'note.checkbox', value: str('not a checkbox') }];
  assert.throws(() => { const prepared = prepareCollectionClipboardEdits(collection, edits); for (const edit of prepared) mutations.push(edit); }, /Ready:/);
  assert.deepEqual(mutations, []); assert.deepEqual(edits.map(edit => edit.value), [str('12'), str('not a checkbox')]);
});
