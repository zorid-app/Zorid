import test from 'node:test';
import assert from 'node:assert/strict';
import {optionalSummaryMap} from './optional-summary-map.mjs';
const n = value => ({type: 'number', value});
const matches = (actual, expected) => assert.deepEqual(optionalSummaryMap(actual, expected), expected);
test('omitted and explicit empty summary maps satisfy the authored empty expectation', () => {
  matches(undefined, {}); matches({}, {});
});
test('populated maps and zero-valued typed summaries remain exact', () => {
  const populated = {rating: n(15), count: n(0)};
  assert.equal(optionalSummaryMap(populated, {}), populated);
  matches(populated, structuredClone(populated));
});
for (const [name, actual, expected] of [
  ['missing nonempty map', undefined, {rating: n(15)}],
  ['explicit null', null, {}],
  ['array', [], {}],
  ['string', '', {}],
  ['number', 0, {}],
  ['extra summary', {rating: n(0)}, {}],
  ['wrong numeric result', {rating: n(14)}, {rating: n(15)}],
  ['wrong typed result', {rating: {type: 'string', value: '15'}}, {rating: n(15)}],
  ['missing populated key', {other: n(15)}, {rating: n(15)}],
  ['extra populated key', {rating: n(15), extra: n(0)}, {rating: n(15)}],
  ['null cell instead of numeric', {rating: {type: 'null'}}, {rating: n(15)}],
]) test('rejects ' + name, () => assert.throws(() => matches(actual, expected), assert.AssertionError));
