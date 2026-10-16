import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_NULL, BaseExpressionError, BaseFunctionRegistry, baseDate, baseDuration, baseExpressionValue,
  baseValueIsTruthy, baseValuesEqual, baseValueToString, createBaseExpressionContext,
  evaluateBaseExpression, evaluateBaseExpressionOrThrow, parseBaseExpression, testBaseExpression,
} from '../src/bases/expression.ts';
import type { BaseExpressionContext, BaseExpressionValue } from '../src/bases/expression.ts';

const value = (source: string, context?: BaseExpressionContext) => evaluateBaseExpressionOrThrow(source, context);
function plain(input: BaseExpressionValue): unknown {
  switch (input.type) {
    case 'null': return null;
    case 'boolean': case 'number': case 'string': return input.value;
    case 'list': return input.value.map(plain);
    case 'object': return Object.fromEntries(Object.entries(input.value).map(([key, item]) => [key, plain(item)]));
    default: return input;
  }
}
function error(source: string, code: string, context?: BaseExpressionContext): void {
  const result = evaluateBaseExpression(source, context);
  assert.equal(result.type, 'error', source);
  if (result.type === 'error') assert.equal(result.error.code, code, source);
}

test('operators compose with conventional precedence and left associativity', () => {
  assert.equal(plain(value('2 + 3 * 4')), 14);
  assert.equal(plain(value('(2 + 3) * 4')), 20);
  assert.equal(plain(value('20 / 2 / 5')), 2);
  assert.equal(plain(value('10 - 3 - 2')), 5);
  assert.equal(plain(value('-2 * -3 + 8 % 3')), 8);
  assert.equal(plain(value('1 + 2 * 3 == 7 && !false')), true);
  assert.equal(plain(value('true || false && false')), true);
  assert.equal(plain(value('2 < 3 == true')), true);
  assert.equal(plain(value('1e2 + .5')), 100.5);
});

test('strings, arrays, parentheses, regexp literals and chained member calls parse without evaluation', () => {
  assert.equal(plain(value(`'can\\'t' + "\\n\\u0041"`)), "can't\nA");
  assert.equal(plain(value('[10, 20, 30][-1]')), 30);
  assert.equal(plain(value('[10, 20][9]')), null);
  assert.equal(plain(value('[10, 20][0.5]')), null);
  assert.equal(plain(value('"abc"[-1]')), '');
  assert.equal(plain(value('"abc"[1.8]')), 'b');
  assert.equal(plain(value('"abcdef".slice(1, 4).length')), 3);
  assert.equal(plain(value('/[a/]+/i.matches("A/A")')), true);
  assert.equal(plain(value('8 / 2 + 1')), 5);
  const parsed = parseBaseExpression('file.ext == "md"');
  assert.equal(parsed.kind, 'binary');
});

test('malformed or unsupported syntax is explicit and never runs JavaScript', () => {
  for (const source of ['1 +', '[1,]', '(1', 'a ? b : c', '{a: 1}', 'a = 1', 'a === 1', '1; 2', '`code`', '"bad\\q"', '/[/', '/a/zz', '"unterminated']) {
    assert.throws(() => parseBaseExpression(source), BaseExpressionError, source);
    error(source, 'parse');
  }
  assert.equal(plain(value('globalThis.process.exit()')), null); // Missing identifiers never expose ambient globals.
  error('"x".constructor()', 'unknown-function');
  error('note["callback"]()', 'unsupported');
  error('new Date()', 'parse');
  error('"raw\tcontrol"', 'parse');
  error(String.raw`"bad\'escape"`, 'parse');
  assert.equal(plain(value('')), null);
  assert.throws(() => testBaseExpression('unknown()'), /Unknown function/);
});

test('null, false, zero, missing and empty values remain distinct', () => {
  const context = createBaseExpressionContext({ note: { checked: false, count: 0, blank: '', empty: [], explicit: null } });
  assert.equal(plain(value('checked', context)), false);
  assert.equal(plain(value('missing', context)), null);
  assert.equal(plain(value('missing == explicit', context)), true);
  assert.equal(plain(value('missing == false', context)), false);
  assert.equal(plain(value('!missing', context)), null);
  assert.equal(plain(value('missing < 1', context)), null);
  assert.equal(plain(value('missing + 1', context)), null);
  assert.equal(plain(value('"a" + missing', context)), 'a');
  assert.equal(plain(value('missing.isEmpty()', context)), true);
  assert.equal(plain(value('missing.toString()', context)), 'null');
  assert.equal(plain(value('count.isEmpty()', context)), false);
  assert.equal(plain(value('empty.isEmpty()', context)), true);
  assert.equal(plain(value('missing.isType("Null")', context)), true);
  for (const expression of ['checked', 'count', 'blank', 'empty', 'missing']) assert.equal(testBaseExpression(expression, context), false);
});

test('logical and conditional operators short-circuit and always type Boolean results', () => {
  assert.deepEqual(value('0 && unknown()'), { type: 'boolean', value: false });
  assert.deepEqual(value('"yes" || unknown()'), { type: 'boolean', value: true });
  assert.equal(plain(value('if(true, 42, unknown())')), 42);
  assert.equal(plain(value('if(null, unknown(), 7)')), 7);
  assert.equal(plain(value('if(false, unknown())')), null);
  assert.equal(plain(value('false.if(unknown(), 8)')), 8);
  error('if(true)', 'type');
  error('if(true, 1, 2, 3)', 'type');
  error('IF(true, 42, unknown())', 'unknown-function'); // Ordinary registry dispatch is eager.
  error('IF(1, 42)', 'type');
  assert.equal(plain(value('if(1, 42)')), 42);
});

test('typed arithmetic supports lists/text, rejects unobserved numeric coercion, and retains non-finite results', () => {
  assert.deepEqual(plain(value('[1, 2] + [3]')), [1, 2, 3]);
  assert.equal(plain(value('"x" + 2')), 'x2');
  assert.equal(plain(value('"2" + 3')), '23');
  error('"2" * 3', 'type');
  error('true + 1', 'type');
  error('-"2"', 'type');
  assert.equal(plain(value('1 / 0')), Infinity);
  assert.ok(Number.isNaN(plain(value('0 / 0'))));
  assert.equal(baseValueIsTruthy(value('0 / 0')), false);
});

test('typed equality includes primitive coercion and singleton list rules without null coercion', () => {
  for (const source of ['"2" == 2', 'true == 1', 'false == ""', '[2] == 2', '["2"] == [2]']) assert.equal(plain(value(source)), true, source);
  for (const source of ['null == 0', '"02" == "2"', '[1, 2] == 1', '[] == false']) assert.equal(plain(value(source)), false, source);
  assert.equal(baseValuesEqual(baseExpressionValue([2]), baseExpressionValue(['2'])), false);
  assert.equal(baseValuesEqual(baseExpressionValue([2]), baseExpressionValue(['2']), true), true);
});

test('entry context resolves namespaces and case-insensitive own properties with exact spelling preferred', () => {
  const context = createBaseExpressionContext({ note: { Status: 'Todo', status: 'Done', nested: { Score: 2 }, 'odd.name': 3 },
    file: { ext: 'md', name: 'Entry' }, thisValue: { Project: 'Home', file: { name: 'Dashboard' } } });
  assert.equal(plain(value('Status', context)), 'Todo');
  assert.equal(plain(value('status', context)), 'Done');
  assert.equal(plain(value('STATUS', context)), 'Todo');
  assert.equal(plain(value('NOTE["odd.name"] + nested.score', context)), 5);
  assert.equal(plain(value('FILE.Ext', context)), 'md');
  assert.equal(plain(value('this.project + this.file.name', context)), 'HomeDashboard');
  assert.equal(plain(value('note.constructor', context)), null);
  error('[1]["0"]', 'access');
  error('note[0]', 'access', context);
  error('1.absent', 'parse');
  error('(1).absent', 'access');
  assert.equal(plain(value('missing.foo[0]', context)), null);
});

test('untrusted plain data cannot expose prototypes, accessors or cyclic object graphs', () => {
  let getterCalls = 0;
  assert.throws(() => baseExpressionValue({ get a() { getterCalls++; return 1; } }), /accessors/);
  assert.equal(getterCalls, 0);
  const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
  assert.throws(() => baseExpressionValue(cyclic), /Cyclic/);
  assert.throws(() => baseExpressionValue(() => 1), /Unsupported/);
  const object = JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}');
  const context = createBaseExpressionContext({ note: object });
  assert.equal(plain(value('note.__proto__.polluted', context)), true);
  assert.equal(plain(value('note.constructor', context)), 'ordinary');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  object.constructor = 'changed';
  assert.equal(plain(value('note.constructor', context)), 'ordinary');
});

test('function registry supports explicit capabilities, overrides, argument validation and safe disposal', () => {
  const functions = new BaseFunctionRegistry(); let calls = 0;
  functions.register('double', { parameters: [{ types: ['number'] }], invoke: ([value]) => { calls++; return baseExpressionValue(Number(plain(value)) * 2); } });
  const context = createBaseExpressionContext({ functions });
  assert.equal(plain(value('DOUBLE(4)', context)), 8);
  assert.equal(plain(value('double(null)', context)), null);
  assert.equal(calls, 1);
  error('double("4")', 'type', context); error('double()', 'type', context); error('double(1, 2)', 'type', context);
  functions.register('pair', { parameters: [{ types: ['number'] }, { types: ['number'] }], invoke: args => baseExpressionValue(args.length) });
  assert.equal(plain(value('pair(null, unknown())', context)), null); // Validate required null before evaluating later arguments.
  const disposeOld = functions.register('double', { parameters: [], invoke: () => baseExpressionValue(3) });
  const disposeNew = functions.register('double', { parameters: [], invoke: () => baseExpressionValue(9) });
  disposeOld(); assert.equal(plain(value('double()', context)), 9);
  disposeNew(); error('double()', 'unknown-function', context);
  assert.equal(plain(value('unknownProperty.unsupported(unknown())', context)), null);
});

test('formula references evaluate lazily once per context, isolate bindings, and cache failures', () => {
  const functions = new BaseFunctionRegistry(); let calls = 0;
  functions.register('tick', { parameters: [], invoke: () => baseExpressionValue(++calls) });
  const context = createBaseExpressionContext({ note: { amount: 3, value: 10 }, functions,
    formulas: { doubled: 'amount * 2', chained: 'formula.doubled + 1', counted: 'tick()', outer: 'value', broken: 'noSuchFunction()' } });
  assert.equal(plain(value('formula.CHAINED', context)), 7);
  assert.equal(plain(value('formula.counted + formula.counted', context)), 2); assert.equal(calls, 1);
  assert.deepEqual(plain(value('[1, 2].map(formula.outer)', context)), [10, 10]);
  assert.equal(plain(value('formula.missing', context)), null);
  error('formula.broken', 'unknown-function', context);
  error('formula.broken', 'unknown-function', context);
  const changed = createBaseExpressionContext({ note: { amount: 7 }, formulas: { doubled: 'amount * 2' } });
  assert.equal(plain(value('formula.doubled', changed)), 14);
  assert.equal(plain(value('formula.doubled', context)), 6);
});

test('direct and indirect cycles return typed errors and predicate path throws', () => {
  for (const formulas of [{ loop: 'formula.loop' }, { loop: 'formula.other', other: 'formula.loop' }]) {
    const context = createBaseExpressionContext({ formulas });
    error('formula.loop', 'cycle', context);
    assert.throws(() => testBaseExpression('formula.loop', context), /Circular/);
    error('formula.loop', 'cycle', context);
  }
  const result = evaluateBaseExpression('unknown()');
  assert.equal(baseValueIsTruthy(result), false);
  assert.match(baseValueToString(result), /^Error: Unknown function/);
});

test('map/filter/reduce bindings support nested scopes and object result shapes', () => {
  assert.deepEqual(plain(value('[2, 4, 6].map(value + index)')), [2, 5, 8]);
  assert.deepEqual(plain(value('[1, 2, 3, 4].filter(value % 2 == 0)')), [2, 4]);
  assert.equal(plain(value('[2, 3, 4].reduce(acc + value, 1)')), 10);
  assert.equal(plain(value('[].reduce(acc + value, 8)')), 8);
  assert.deepEqual(plain(value('[[1, 2], [3]].map(value.map(value * 2))')), [[2, 4], [6]]);
  const context = createBaseExpressionContext({ note: { data: { first: 2, second: 5 }, acc: 7 } });
  assert.deepEqual(plain(value('data.map(key + value)', context)), ['first2', 'second5']);
  assert.deepEqual(plain(value('data.filter(value > 2)', context)), { second: 5 });
  assert.deepEqual(plain(value('[1, 2].map(acc)', context)), [7, 7]);
  assert.deepEqual(plain(value('[1, 2].MAP(9)')), [1, 2]);
  error('[1].map()', 'type'); error('[1].reduce(value)', 'type'); error('data.reduce(value, 0)', 'unknown-function', context);
});

test('string and numeric builtins preserve observed case, empty-query and conversion differences', () => {
  assert.equal(plain(value('"AbC".contains("bc")')), true);
  assert.equal(plain(value('"AbC".startsWith("a")')), false);
  assert.equal(plain(value('"AbC".endsWith("C")')), true);
  assert.equal(plain(value('"x".contains("")')), false);
  assert.equal(plain(value('"x".containsAll("")')), true);
  assert.equal(plain(value('"aba".replace("a", "x")')), 'xbx');
  assert.equal(plain(value('"aba".replace(/a/, "x")')), 'xba');
  assert.equal(plain(value('"aba".replace("", "x")')), 'aba');
  assert.deepEqual(plain(value('"a,b,c".split(",", 2)')), ['a', 'b']);
  assert.equal(plain(value('number("12tail")')), 12);
  assert.equal(plain(value('number(true)')), 1);
  assert.equal(plain(value('(12.345).round(2)')), 12.35);
  assert.equal(plain(value('(12.345).round(-1)')), 12);
  assert.equal(plain(value('(12).toFixed(2)')), '12.00');
  error('number("no")', 'type'); error('"x".startsWith(1)', 'type');
});

test('list helpers preserve aggregation and membership distinctions on mixed values', () => {
  assert.equal(plain(value('[2, "9", null, 6].sum()')), 8);
  assert.equal(plain(value('[2, "9", null, 6].mean()')), 2);
  assert.equal(plain(value('["9", null].sum()')), null);
  assert.equal(plain(value('[1, 2, 3, 4].median()')), 2.5);
  assert.equal(plain(value('[1, 3].stddev()')), 1);
  assert.equal(plain(value('[1, 2].contains("2")')), true);
  assert.equal(plain(value('[1, 2].containsAll(["1", 2])')), true);
  assert.equal(plain(value('[1, 2].containsAny([3, 4])')), false);
  assert.deepEqual(plain(value('[1, [2, [3]]].flat()')), [1, 2, 3]);
  assert.equal(plain(value('[1, null].join("|")')), '1|null');
  assert.deepEqual(plain(value('list(2)')), [2]);
  assert.equal(plain(value('max(3, 7, 2)')), 7);
  assert.equal(plain(value('min()')), null);
});

test('dates and simple calendar durations retain type, date-only flag and asymmetric arithmetic', () => {
  const current = new Date(2024, 0, 15, 10, 20, 30);
  const context = createBaseExpressionContext({ now: () => current });
  assert.equal(baseValueToString(value('today()', context)), '2024-01-15');
  assert.equal(baseValueToString(value('now()', context)), '2024-01-15T10:20:30');
  assert.equal(plain(value('date("2024-01-15").month')), 1);
  assert.equal(plain(value('date("202401151020").hour')), 10);
  assert.equal(baseValueToString(value('date("2024-01-15") + "2 days"')), '2024-01-17');
  assert.equal(baseValueToString(value('date("2024-01-15") + duration("2h")')), '2024-01-15T02:00:00');
  assert.deepEqual(value('date("2024-01-16") - date("2024-01-15")'), baseDuration({ milliseconds: 86_400_000 }));
  assert.equal(plain(value('date("2024-01-15") == date("2024-01-15T10:20:30")')), true);
  assert.equal(plain(value('date("2024-01-15") < "2024-01-16"')), true);
  assert.deepEqual(value('duration("2d") * 3'), baseDuration({ days: 6 }));
  assert.deepEqual(value('duration("1w") - duration("2d")'), baseDuration({ days: 5 }));
  error('3 * duration("2d")', 'type');
  error('duration("P1DT2H")', 'unsupported');
  error('duration("2d").toString()', 'unsupported');
  assert.equal(plain(value('date("not a date")')), null);
  assert.deepEqual(baseExpressionValue(current), baseDate(current));
});

test('regex object state is retained on a compiled expression', () => {
  const expression = parseBaseExpression('/a/g.matches("a")');
  assert.equal(plain(evaluateBaseExpressionOrThrow(expression)), true);
  assert.equal(plain(evaluateBaseExpressionOrThrow(expression)), false);
});

test('unsupported host functions are explicit and evaluation budgets terminate deep work', () => {
  for (const source of ['file("Note")', 'link("Note")', 'random()', '"x".unknown()', '[1].sort()', 'html("x")']) error(source, 'unknown-function');
  error('[1, 2, 3].map(value + 1)', 'budget', createBaseExpressionContext({ maxSteps: 5 }));
  assert.throws(() => parseBaseExpression('('.repeat(300) + '1' + ')'.repeat(300)), /nesting limit/);
  const formulas: Record<string, string> = {};
  for (let index = 0; index < 20; index++) formulas[`f${index}`] = index === 19 ? '1' : `formula.f${index + 1}`;
  error('formula.f0', 'budget', createBaseExpressionContext({ formulas, maxSteps: 10 }));
  assert.deepEqual(BASE_NULL, { type: 'null' });
});

test('a depleted outer evaluation budget does not poison a formula cache', () => {
  const context = createBaseExpressionContext({ formulas: { total: '1 + 2' }, maxSteps: 6 });
  error('0 + formula.total', 'budget', context);
  assert.equal(plain(value('formula.total', context)), 3);
});

test('host-returned error values remain values while host-thrown errors propagate', () => {
  const functions = new BaseFunctionRegistry(), failure = new BaseExpressionError('type', 'Host value error');
  functions.register('errorValue', { parameters: [], invoke: () => ({ type: 'error', error: failure }) });
  functions.register('throwError', { parameters: [], invoke: () => { throw failure; } });
  const context = createBaseExpressionContext({ functions });
  assert.deepEqual(value('errorValue()', context), { type: 'error', error: failure });
  assert.equal(testBaseExpression('errorValue()', context), false);
  assert.throws(() => testBaseExpression('throwError()', context), error => error === failure);
  error('throwError()', 'type', context);
});

test('invalid evaluation budgets reject rather than silently disabling the step guard', () => {
  for (const maxSteps of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    error('1', 'type', createBaseExpressionContext({ maxSteps }));
  }
  error('1', 'budget', createBaseExpressionContext({ maxSteps: 0 }));
  assert.equal(plain(value('1', createBaseExpressionContext({ maxSteps: 1 }))), 1);
});

test('optional variadic arguments retain their parameter position after null', () => {
  const functions = new BaseFunctionRegistry();
  functions.register('collect', { parameters: [{ types: ['number'], optional: true, variadic: true }], invoke: args => ({ type: 'list', value: args }) });
  const context = createBaseExpressionContext({ functions });
  assert.deepEqual(plain(value('collect(null, 1)', context)), [null, 1]);
  assert.deepEqual(plain(value('collect(1, null, 2)', context)), [1, null, 2]);
  assert.deepEqual(plain(value('collect()', context)), []);
  error('collect(1, "x")', 'type', context);
});

test('large min/max aggregations avoid function argument limits and preserve numeric edge cases', () => {
  const context = createBaseExpressionContext({ note: { values: Array.from({ length: 150_000 }, (_, index) => index) } });
  assert.equal(plain(value('values.max()', context)), 149_999);
  assert.equal(plain(value('values.min()', context)), 0);
  const args = Array.from({ length: 150_000 }, (_, index) => ({ kind: 'literal' as const, value: baseExpressionValue(index) }));
  assert.equal(plain(evaluateBaseExpressionOrThrow({ kind: 'call', callee: { kind: 'identifier', name: 'max' }, args }, createBaseExpressionContext({ maxSteps: 200_000 }))), 149_999);
  assert.ok(Number.isNaN(plain(value('[1, 0 / 0].min()'))));
  assert.equal(plain(value('max(1, 1 / 0)')), Infinity);
  assert.ok(Object.is(plain(value('min(-0, 0)')), -0));
  assert.ok(Object.is(plain(value('max(-0, 0)')), 0));
});
