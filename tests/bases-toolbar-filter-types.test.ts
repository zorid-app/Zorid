import test from 'node:test';
import assert from 'node:assert/strict';
import { baseFilterMethod, baseFilterOperators, baseFilterProperty } from '../src/bases/toolbar-filter-types.ts';
import type { BaseFilterOperator, BaseFilterPropertyDescriptor } from '../src/bases/toolbar-filter-types.ts';

const ids = (descriptor: BaseFilterPropertyDescriptor, selected?: BaseFilterOperator) => baseFilterOperators(descriptor, selected).map(operator => operator.id);
const equality = ['eq', 'neq'];
const ordered = [...equality, 'lt', 'lte', 'gt', 'gte'];
const stringMethods = ['startsWith', 'endsWith', 'isEmpty', 'contains', 'containsAny', 'containsAll'];
const stringInverses = ['notStartsWith', 'notEndsWith', 'isNotEmpty', 'notContains', 'notContainsAny', 'notContainsAll'];

test('String catalog follows comparisons, all positive methods, then all inverses', () => {
  const catalog = baseFilterOperators({ kind: 'string' });
  assert.deepEqual(catalog.map(operator => operator.id), [...equality, ...stringMethods, ...stringInverses]);
  assert.deepEqual(catalog.map(operator => operator.label), [
    'is', 'is not', 'starts with', 'ends with', 'is empty', 'contains', 'contains any of', 'contains all of',
    'does not start with', 'does not end with', 'is not empty', 'does not contain', 'does not contain any of', 'does not contain all of',
  ]);
  assert.equal(catalog.some(operator => operator.id === 'matches'), false, 'there is no invented ordinary String regex operator');
});

test('Number and Date preserve audited ordered comparisons, labels and operand kinds', () => {
  const number = baseFilterOperators({ kind: 'number' });
  assert.deepEqual(number.map(operator => operator.id), [...ordered, 'isEmpty', 'isNotEmpty']);
  assert.deepEqual(number.slice(0, 6).map(operator => operator.label), ['=', '≠', '<', '≤', '>', '≥']);
  assert.deepEqual(number.slice(0, 6).map(operator => operator.comparison), ['==', '!=', '<', '<=', '>', '>=']);
  assert.ok(number.slice(0, 6).every(operator => operator.operand === 'number' && operator.arity === 'one'));
  for (const withTime of [false, true]) {
    const date = baseFilterOperators({ kind: 'date', withTime });
    assert.deepEqual(date.map(operator => operator.id), [...ordered, 'isEmpty', 'isNotEmpty']);
    assert.deepEqual(date.slice(0, 6).map(operator => operator.label), ['on', 'not on', 'before', 'on or before', 'after', 'on or after']);
    assert.ok(date.slice(0, 6).every(operator => operator.operand === (withTime ? 'datetime' : 'date')));
  }
});

test('fresh Boolean has exactly equality and inequality with Boolean operands', () => {
  const operators = baseFilterOperators({ kind: 'boolean' });
  assert.deepEqual(operators.map(operator => operator.id), equality);
  assert.ok(operators.every(operator => operator.operand === 'boolean'));
});

test('List and TagList distinguish one exact list from member and variadic token predicates', () => {
  for (const kind of ['list', 'tagList'] as const) {
    const operators = baseFilterOperators({ kind });
    assert.deepEqual(operators.map(operator => operator.id), [...equality, 'isEmpty', 'contains', 'containsAny', 'containsAll', 'isNotEmpty', 'notContains', 'notContainsAny', 'notContainsAll']);
    assert.deepEqual(operators.slice(0, 2).map(operator => operator.label), ['is exactly', 'is not exactly']);
    assert.ok(operators.slice(0, 2).every(operator => operator.arity === 'one' && operator.operand === (kind === 'list' ? 'list' : 'tags')));
    assert.equal(operators.find(operator => operator.id === 'contains')?.operand, 'text');
    assert.equal(operators.find(operator => operator.id === 'containsAny')?.arity, 'variadic');
    assert.equal(operators.find(operator => operator.id === 'containsAll')?.operand, 'tokens');
  }
});

test('File catalog skips generic comparisons and keeps audited chooser types and multi-tag arity', () => {
  const catalog = baseFilterOperators({ kind: 'file' });
  assert.deepEqual(catalog.map(operator => operator.id), ['hasLink', 'inFolder', 'hasTag', 'hasProperty', 'notHasLink', 'notInFolder', 'notHasTag', 'notHasProperty']);
  assert.deepEqual(catalog.map(operator => operator.operand), ['file', 'folder', 'tags', 'property', 'file', 'folder', 'tags', 'property']);
  assert.equal(catalog.find(operator => operator.id === 'hasTag')?.arity, 'variadic');
  assert.deepEqual(ids({ kind: 'file' }, 'gt'), catalog.map(operator => operator.id));
  assert.deepEqual(ids({ kind: 'file' }, 'unset'), catalog.map(operator => operator.id));
});

test('Link and Tag inherit String operators before their own method and its inverse', () => {
  assert.deepEqual(ids({ kind: 'link' }), [...equality, ...stringMethods, 'linksTo', ...stringInverses, 'notLinksTo']);
  assert.deepEqual(ids({ kind: 'tag' }), [...equality, ...stringMethods, 'matches', ...stringInverses, 'notMatches']);
  assert.equal(baseFilterMethod('linksTo')?.label, 'linksTo');
  assert.equal(baseFilterMethod('notLinksTo')?.label, 'linksTo', 'the shipped label registry uses the same literal fallback');
  assert.equal(baseFilterMethod('linksTo')?.operand, 'text', 'Link method RHS does not claim File chooser metadata');
  assert.equal(baseFilterMethod('notMatches')?.inverse, true);
});

test('Null and unknown stay conservative while Object equality is readonly', () => {
  for (const kind of ['null', 'unknown', 'object'] as const) {
    const operators = baseFilterOperators({ kind });
    assert.deepEqual(operators.map(operator => operator.id), [...equality, 'isEmpty', 'isNotEmpty']);
    assert.equal(operators[0].operand, kind === 'object' ? 'readonly' : 'text');
  }
  assert.deepEqual(baseFilterProperty('formula.arbitrary'), { kind: 'unknown', metadataStatus: 'unavailable' });
});

test('selected legacy ordering is retained as a complete ordered comparison block', () => {
  for (const kind of ['string', 'boolean', 'list', 'tagList', 'link', 'tag', 'object', 'null', 'unknown'] as const) {
    for (const selected of ['lt', 'lte', 'gt', 'gte'] as const) {
      assert.deepEqual(ids({ kind }, selected).slice(0, 6), ordered, `${kind}/${selected}`);
    }
  }
});

test('set/unset are loaded-only null-check conveniences and remain distinct from emptiness', () => {
  assert.equal(ids({ kind: 'string' }).includes('set'), false);
  assert.equal(ids({ kind: 'string' }).includes('unset'), false);
  for (const selected of ['set', 'unset'] as const) {
    const operators = baseFilterOperators({ kind: 'string' }, selected);
    assert.equal(operators.at(-1)?.id, selected);
    assert.equal(operators.some(operator => operator.id === (selected === 'set' ? 'unset' : 'set')), false);
    assert.deepEqual(operators.at(-1), { id: selected, label: selected === 'set' ? 'is set' : 'is not set', comparison: selected === 'set' ? '!=' : '==', arity: 'none', operand: 'none' });
    assert.equal(baseFilterMethod(selected), undefined);
    assert.equal(baseFilterMethod('isEmpty')?.method, 'isEmpty');
  }
});

test('built-in property kinds and comparison widgets override supplied/declared metadata', () => {
  const misleading: BaseFilterPropertyDescriptor = { kind: 'boolean', metadataStatus: 'stale' };
  const expected: Record<string, BaseFilterPropertyDescriptor> = {
    file: { kind: 'file' }, 'file.file': { kind: 'file' },
    'file.name': { kind: 'string' }, 'file.basename': { kind: 'string' }, 'file.fullname': { kind: 'string' }, 'file.ext': { kind: 'string' },
    'file.path': { kind: 'string', comparisonWidget: 'file' }, 'file.folder': { kind: 'string', comparisonWidget: 'folder' },
    'file.size': { kind: 'number' }, 'file.ctime': { kind: 'date', withTime: false }, 'file.mtime': { kind: 'date', withTime: false },
    'file.links': { kind: 'list' }, 'file.embeds': { kind: 'list' },
    'file.tags': { kind: 'tagList', comparisonWidget: 'tags' }, 'file.properties': { kind: 'object' },
  };
  for (const [property, descriptor] of Object.entries(expected)) assert.deepEqual(baseFilterProperty(property, misleading, 'number'), descriptor, property);
  assert.equal(baseFilterOperators(baseFilterProperty('file.path'))[0].operand, 'file');
  assert.equal(baseFilterOperators(baseFilterProperty('file.folder'))[0].operand, 'folder');
  assert.equal(baseFilterOperators(baseFilterProperty('file.ctime'))[0].operand, 'date');
  assert.equal(baseFilterOperators(baseFilterProperty('file.path')).find(operator => operator.id === 'contains')?.operand, 'text', 'custom chooser is comparison-only');
});

test('captured metadata precedes declared schema and retains choices and status without mutation', () => {
  const supplied: BaseFilterPropertyDescriptor = Object.freeze({ kind: 'string', choices: Object.freeze([Object.freeze({ value: 'todo', label: 'To do', color: 'blue' })]), metadataStatus: 'current' });
  assert.equal(baseFilterProperty('note.progress', supplied, 'number'), supplied);
  assert.equal(baseFilterProperty('formula.progress', supplied), supplied);
  const pending: BaseFilterPropertyDescriptor = Object.freeze({ kind: 'unknown', metadataStatus: 'pending' });
  assert.equal(baseFilterProperty('formula.waiting', pending, 'number'), pending, 'a captured unresolved descriptor is not guessed from schema');
  baseFilterOperators(supplied);
  assert.deepEqual(supplied.choices, [{ value: 'todo', label: 'To do', color: 'blue' }]);
});

test('known declared types map statically while relation/rollup outputs and prototype names remain unknown', () => {
  const schema: Record<string, BaseFilterPropertyDescriptor> = {
    text: { kind: 'string' }, select: { kind: 'string' }, status: { kind: 'string' }, number: { kind: 'number' },
    checkbox: { kind: 'boolean' }, date: { kind: 'date', withTime: false }, datetime: { kind: 'date', withTime: true },
    aliases: { kind: 'list' }, multitext: { kind: 'list' }, list: { kind: 'list' }, multiselect: { kind: 'list' },
    tags: { kind: 'tagList', comparisonWidget: 'tags' }, link: { kind: 'link' },
  };
  for (const [type, descriptor] of Object.entries(schema)) assert.deepEqual(baseFilterProperty('note.value', undefined, type), descriptor, type);
  for (const type of ['relation', 'reverseRelation', 'rollup', 'unknown', 'constructor', '__proto__']) assert.equal(baseFilterProperty('note.value', undefined, type).kind, 'unknown', type);
  for (const property of ['constructor', '__proto__', 'note.date', 'formula.number', 'file.unknown']) assert.equal(baseFilterProperty(property).kind, 'unknown', property);
});

test('catalog arrays and descriptors cannot be mutated across callers', () => {
  const operators = baseFilterOperators({ kind: 'string' });
  assert.equal(Object.isFrozen(operators), true);
  assert.ok(operators.every(Object.isFrozen));
  assert.equal(baseFilterMethod('eq'), undefined);
  assert.equal(baseFilterMethod('contains')?.arity, 'one');
  assert.equal(baseFilterMethod('notContainsAny')?.method, 'containsAny');
  assert.equal(baseFilterMethod('notContainsAny')?.inverse, true);
});
