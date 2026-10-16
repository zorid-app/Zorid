import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, EditorSelection, Text } from '@codemirror/state';
import { textChanges } from '../src/editor/text-changes.ts';
import type { TextChangeDiagnostics } from '../src/editor/text-changes.ts';

function verify(previous: string, next: string, diagnostics?: TextChangeDiagnostics) {
  const changes = textChanges(previous, next, diagnostics);
  let end = 0, applied = '';
  for (const change of changes) {
    assert.ok(change.from >= end && change.from <= change.to && change.to <= previous.length);
    applied += previous.slice(end, change.from) + change.insert;
    end = change.to;
  }
  assert.equal(applied + previous.slice(end), next);
  const set = ChangeSet.of(changes, previous.length, '\n');
  assert.equal(set.apply(Text.of(previous.split('\n'))).toString(), next);
  return { changes, set };
}

test('separated edits retain unchanged middle carets and directional selections', () => {
  const { changes, set } = verify('aaa\nKEEP\nzzz', '!aaa\nKEEP\nzzz!');
  assert.deepEqual(changes, [{ from: 0, to: 0, insert: '!' }, { from: 12, to: 12, insert: '!' }]);
  const selection = EditorSelection.create([EditorSelection.cursor(5), EditorSelection.range(8, 6)], 1).map(set);
  assert.deepEqual(selection.ranges.map(({ anchor, head }) => ({ anchor, head })), [{ anchor: 6, head: 6 }, { anchor: 9, head: 7 }]);
  assert.equal(selection.mainIndex, 1);
});

test('separated deletions and replacements preserve multiline islands', () => {
  const { set, changes } = verify('remove\nKEEP ONE\nreplace\nKEEP TWO\nremove', 'KEEP ONE\nnew\nKEEP TWO\n');
  assert.ok(changes.length >= 3);
  assert.equal(set.mapPos(9), 2);
  assert.equal(set.mapPos(27), 16);
});

test('repeated-text ties are deterministic while preserving the matching run', () => {
  const { changes, set } = verify('ababa', 'babab');
  assert.deepEqual(changes, [{ from: 0, to: 1, insert: '' }, { from: 5, to: 5, insert: 'b' }]);
  assert.equal(set.mapPos(3), 2);
  assert.deepEqual(textChanges('ababa', 'babab'), changes);
});

test('Unicode changes use UTF-16 offsets and keep valid surrogate pairs together', () => {
  const { changes, set } = verify('a😀x😄z', 'a😁x😅z');
  assert.deepEqual(changes, [{ from: 1, to: 3, insert: '😁' }, { from: 4, to: 6, insert: '😅' }]);
  assert.equal(set.mapPos(3), 3);
  verify('👩‍💻 e\u0301\r\n保持\r\n終', '!👩‍💻 e\u0301\r\n保持\r\n終!');
  verify('😀', 'a');
  verify('a', '😀');
  // JavaScript permits unpaired surrogates too: reconstruction must remain exact.
  verify('\ud83d\ude00', '\ude00');
  verify('\ud83d', '\ud83d\ude00');
});

test('empty, equal, and single-edit inputs do not allocate a search trace', () => {
  for (const [previous, next] of [['', ''], ['', 'insert'], ['delete', ''], ['equal', 'equal'], ['abc', 'ab!c']]) {
    const stats = { work: 0, traceCells: 0, fallback: false };
    verify(previous, next, stats);
    assert.equal(stats.traceCells, 0);
    assert.equal(stats.fallback, false);
  }
  assert.deepEqual(textChanges('same', 'same'), []);
});

test('all short repeated-text inputs reconstruct exactly', () => {
  const strings = [''];
  for (let length = 1; length <= 5; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) strings.push(bits.toString(2).padStart(length, '0'));
  }
  for (const previous of strings) for (const next of strings) verify(previous, next);
});

test('seeded mixed Unicode edits reconstruct exactly', () => {
  let state = 0x12345678;
  const random = (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  const alphabet = ['a', 'b', '\n', '\r', '😀', '😁', '\u0301', '中', '\ud83d', '\ude00'];
  for (let sample = 0; sample < 1000; sample++) {
    const make = () => Array.from({ length: random(40) }, () => alphabet[random(alphabet.length)]).join('');
    verify(make(), make());
  }
});

test('distant edits in a million-unit document retain the middle with bounded trace storage', () => {
  const previous = '0123456789'.repeat(100_000), next = `!${previous}!`;
  const stats = { work: 0, traceCells: 0, fallback: false };
  const { changes, set } = verify(previous, next, stats);
  assert.equal(changes.length, 2);
  assert.equal(set.mapPos(500_000), 500_001);
  assert.equal(stats.fallback, false);
  assert.ok(stats.traceCells <= 3 * 259, 'trace depends on edit distance, not matching document length');
  assert.ok(stats.work <= 5 * (previous.length + next.length) + 65_536);
});

test('adversarial repeated edits stop at the deterministic work cap', () => {
  const previous = 'a'.repeat(100_000), next = ('b' + 'a'.repeat(999)).repeat(100);
  const stats = { work: 0, traceCells: 0, fallback: false };
  const { changes } = verify(previous, next, stats);
  assert.equal(stats.fallback, true);
  assert.equal(changes.length, 1);
  assert.ok(stats.work <= 5 * (previous.length + next.length) + 65_536);
  assert.ok(stats.traceCells <= 129 * 259);
});

test('unrelated documents stop at the edit-distance cap and preserve equal edges', () => {
  const previous = `prefix${'a'.repeat(100_000)}suffix`, next = `prefix${'b'.repeat(100_000)}suffix`;
  const stats = { work: 0, traceCells: 0, fallback: false };
  const { changes, set } = verify(previous, next, stats);
  assert.equal(stats.fallback, true);
  assert.equal(stats.traceCells, 129 * 259);
  assert.deepEqual(changes, [{ from: 6, to: 100_006, insert: 'b'.repeat(100_000) }]);
  assert.equal(set.mapPos(3), 3);
  assert.equal(set.mapPos(previous.length - 3), next.length - 3);
  assert.ok(stats.work <= 5 * (previous.length + next.length) + 65_536);
});
