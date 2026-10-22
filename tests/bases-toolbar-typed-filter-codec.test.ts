import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterCondition, decodeFilterCondition, encodeFilterLiteral, filterConditionValues, serializeFilterCondition } from '../src/bases/toolbar-config.ts';
import type { BaseFilterCondition, BaseFilterLiteral, BaseFilterOperator } from '../src/bases/toolbar-config.ts';

function roundTrip(source: string): BaseFilterCondition {
  const decoded = decodeFilterCondition(source);
  assert.ok(decoded, `expected a structured literal condition: ${source}`);
  assert.equal(serializeFilterCondition(decoded), source, 'the exact canonical expression must survive reopening');
  return decoded;
}
const condition = (operator: BaseFilterOperator, extra: Partial<BaseFilterCondition> = {}): BaseFilterCondition => ({ property: 'note.value', operator, text: '', type: 'text', ...extra });

test('all String predicates and inverses retain exact method names, arguments and unary inverse scope', () => {
  const pairs: readonly [BaseFilterOperator, BaseFilterOperator, string][] = [
    ['startsWith', 'notStartsWith', 'startsWith'], ['endsWith', 'notEndsWith', 'endsWith'],
    ['isEmpty', 'isNotEmpty', 'isEmpty'], ['contains', 'notContains', 'contains'],
    ['containsAny', 'notContainsAny', 'containsAny'], ['containsAll', 'notContainsAll', 'containsAll'],
  ];
  for (const [positive, negative, method] of pairs) {
    const values = method === 'isEmpty' ? [] : method === 'containsAny' || method === 'containsAll' ? ['one', 'two'] : ['needle'];
    for (const [operator, inverse] of [[positive, false], [negative, true]] as const) {
      const expected = `${inverse ? '!' : ''}note["value"].${method}(${values.map(value => JSON.stringify(value)).join(', ')})`;
      const source = serializeFilterCondition(condition(operator, { arguments: values }));
      assert.equal(source, expected, operator);
      const decoded = roundTrip(source);
      assert.equal(decoded.operator, operator); assert.deepEqual(filterConditionValues(decoded), values);
    }
  }
});

test('Link and Tag predicates retain the same literal-only inverse encoding', () => {
  for (const [operator, expected] of [
    ['linksTo', 'note["value"].linksTo("Target.md")'], ['notLinksTo', '!note["value"].linksTo("Target.md")'],
    ['matches', 'note["value"].matches("Target.md")'], ['notMatches', '!note["value"].matches("Target.md")'],
  ] as const) {
    assert.equal(serializeFilterCondition(condition(operator, { arguments: ['Target.md'] })), expected);
    assert.equal(roundTrip(expected).operator, operator);
  }
});

test('list equality has one complete array RHS while variadic methods retain separate primitive members', () => {
  const members: BaseFilterLiteral[] = ['one', 2, false, null, ['nested', -0]];
  const exact = serializeFilterCondition(condition('eq', { type: 'list', operand: members }));
  assert.equal(exact, 'note["value"] == ["one", 2, false, null, ["nested", -0]]');
  const decodedExact = roundTrip(exact);
  assert.deepEqual(decodedExact.operand, members); assert.equal(decodedExact.arguments, undefined);
  assert.deepEqual(filterConditionValues(decodedExact), [members], 'one array remains one comparison operand');
  const any = serializeFilterCondition(condition('containsAny', { type: 'list', arguments: members }));
  assert.equal(any, 'note["value"].containsAny("one", 2, false, null, ["nested", -0])');
  const decodedAny = roundTrip(any);
  assert.deepEqual(decodedAny.arguments, members); assert.equal(decodedAny.operand, undefined);
  assert.deepEqual(filterConditionValues(decodedAny), members, 'variadic arguments are not silently wrapped');
  assert.notEqual(any, serializeFilterCondition(condition('containsAny', { arguments: [members] })));
});

test('a single list method argument and nested Any values retain their AST shape and scalar types', () => {
  for (const source of [
    'note["value"].containsAny(["one", 2, false, null])',
    '!note["value"].containsAll(["one", [true, -0]], null, [3, ["four"]])',
    'note["value"].contains(["one", true])',
    'note["value"] != []',
  ]) roundTrip(source);
  const single = roundTrip('note["value"].containsAny(["one", 2])');
  assert.deepEqual(single.arguments, [['one', 2]]);
  const variadic = roundTrip('note["value"].containsAny("one", 2)');
  assert.deepEqual(variadic.arguments, ['one', 2]);
  assert.notDeepEqual(filterConditionValues(single), filterConditionValues(variadic));
});

test('number, Boolean and null literals preserve their kinds without string coercion', () => {
  for (const [operator, text, type, expected] of [
    ['gte', '-12.5', 'number', 'note["value"] >= -12.5'],
    ['lt', '1e2', 'number', 'note["value"] < 100'],
    ['eq', 'false', 'boolean', 'note["value"] == false'],
    ['neq', 'true', 'boolean', 'note["value"] != true'],
    ['eq', 'null', 'null', 'note["value"] == null'],
    ['neq', '', 'null', 'note["value"] != null'],
  ] as const) {
    assert.equal(buildFilterCondition('value', operator, text, type), expected); roundTrip(expected);
  }
  assert.equal(roundTrip('note["value"] == null').operator, 'unset');
  assert.equal(roundTrip('note["value"] != null').operator, 'set');
  assert.equal(roundTrip('note["value"].contains(null)').type, 'null');
  assert.equal(roundTrip('note["value"] < null').type, 'null');
});

test('date and datetime operands remain exact quoted strings with civil time and offsets intact', () => {
  for (const [text, type] of [
    ['2026-10-22', 'date'], ['2026-11-01T01:30', 'datetime'], ['2026-11-01T01:30:45.123-04:00', 'datetime'],
  ] as const) {
    const expected = `note["value"] < ${JSON.stringify(text)}`;
    assert.equal(buildFilterCondition('value', 'lt', text, type), expected);
    const decoded = roundTrip(expected);
    assert.equal(decoded.text, text); assert.equal(decoded.type, 'text', 'literal source alone does not infer a Date descriptor');
    assert.equal(expected.includes('date('), false);
  }
});

test('negative zero, quoted keys and injection-shaped literals remain inert and readable', () => {
  assert.equal(encodeFilterLiteral(-0), '-0');
  assert.equal(buildFilterCondition('value', 'eq', '-0', 'number'), 'note["value"] == -0');
  const zero = roundTrip('note["value"] == -0'); assert.equal(zero.text, '-0');
  assert.equal(Object.is(filterConditionValues(zero)[0], -0), true);
  const property = 'note.odd.key" ] || true || note["x';
  const payload = '"] || true || dangerous("x") //\n\\quoted\t';
  const source = buildFilterCondition(property, 'eq', payload, 'text');
  assert.equal(source, `note[${JSON.stringify(property.slice(5))}] == ${JSON.stringify(payload)}`);
  const decoded = roundTrip(source); assert.equal(decoded.property, property); assert.equal(decoded.text, payload);
  for (const value of ['[[Target|Alias]]', 'date("2026-10-22")', '__proto__', '</script><script>run()</script>']) {
    const result = roundTrip(buildFilterCondition('value', 'contains', value, 'text'));
    assert.equal(result.text, value); assert.deepEqual(filterConditionValues(result), [value]);
  }
});

test('legacy builder distinguishes list exact equality, one list argument, and variadic arguments', () => {
  assert.equal(buildFilterCondition('value', 'eq', ['one', 2], 'list'), 'note["value"] == ["one", 2]');
  assert.equal(buildFilterCondition('value', 'containsAny', ['one', 2], 'list'), 'note["value"].containsAny("one", 2)');
  assert.equal(buildFilterCondition('value', 'contains', ['one', 2], 'list'), 'note["value"].contains(["one", 2])');
  assert.equal(buildFilterCondition('value', 'eq', '["one",2,false]', 'list'), 'note["value"] == ["one", 2, false]');
});

test('unsupported arbitrary ASTs remain in advanced mode without evaluation or lossy rehydration', () => {
  for (const source of [
    'note.value + 1 > 2', '!(note.value == "x")', '!!note.value.contains("x")',
    'note.value.contains(note.other)', 'note.value.containsAny("one", date("2026-10-22"))',
    'note.value.containsAny()', 'note.value.contains("one", "two")', 'note.value.isEmpty("one")',
    'note.value == date("2026-10-22")', 'note.value == /pattern/i', 'note.value == {"a": 1}',
    'note.value == note.other', 'note.value == (1 + 2)', 'note.value == +1',
    'note.value.unknown("x")', 'note.value == Infinity', 'note.value == NaN',
    'note.value.nested.contains("x")', 'file == null', 'file.contains("x")',
    'note.value.hasTag("work")', 'file.hasLink(link("Target"))', 'note.value >',
  ]) assert.equal(decodeFilterCondition(source), undefined, source);
});

test('empty predicates and null checks remain distinct expressions when built and reopened', () => {
  for (const [operator, expected] of [
    ['isEmpty', 'note["value"].isEmpty()'], ['isNotEmpty', '!note["value"].isEmpty()'],
    ['unset', 'note["value"] == null'], ['set', 'note["value"] != null'],
  ] as const) {
    const source = serializeFilterCondition(condition(operator)); assert.equal(source, expected);
    assert.equal(roundTrip(source).operator, operator);
  }
});

test('invalid scalar and list values reject cycles, accessors, sparse arrays and excessive nesting', () => {
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  let reads = 0;
  const accessor = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return 'unsafe'; } });
  const sparse = Array(2);
  const named = ['one']; Object.defineProperty(named, 'extra', { value: 'extra', enumerable: true });
  const symbol = ['one']; Object.defineProperty(symbol, Symbol('extra'), { value: 'extra' });
  let deep: unknown = 'leaf'; for (let depth = 0; depth < 66; depth++) deep = [deep];
  for (const invalid of [cyclic, accessor, sparse, named, symbol, deep, Infinity, NaN, undefined, {}, new Date(), () => 'code']) {
    assert.throws(() => encodeFilterLiteral(invalid as BaseFilterLiteral));
    assert.throws(() => serializeFilterCondition(condition('eq', { operand: invalid as BaseFilterLiteral })));
  }
  assert.equal(reads, 0, 'validation must reject accessor-backed literals without invoking user code');
});

test('method argument vectors are validated as inert indexed lists before serialization', () => {
  let reads = 0;
  const accessor = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return 'unsafe'; } });
  const named = ['one']; Object.defineProperty(named, 'extra', { value: 'extra', enumerable: true });
  for (const invalid of [accessor, Array(2), named]) {
    assert.throws(() => serializeFilterCondition(condition('containsAny', { arguments: invalid })));
  }
  assert.equal(reads, 0, 'outer argument vectors need the same no-accessor guarantee as nested list literals');
});
