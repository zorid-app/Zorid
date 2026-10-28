import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {configureBaseDateInput} from '../src/bases/property-date-input.ts';

test('native date controls are used only when exact persisted text round-trips', () => {
  const dom = new JSDOM('<input>');
  const input = dom.window.document.querySelector('input')!;
  for (const [raw, datetime, type] of [
    ['2026-10-27', false, 'date'],
    ['0001-01-01', false, 'date'],
    ['', false, 'date'],
    ['2026-10-27T12:30', true, 'datetime-local'],
    ['2026-10-27T12:30:15.123', true, 'datetime-local'],
    ['2026-10-27T12:30:15.120', true, 'datetime-local'],
    ['', true, 'datetime-local'],
  ] as const) {
    configureBaseDateInput(input, raw, datetime);
    assert.equal(input.type, type, raw);
    assert.equal(input.value, raw, raw);
    assert.equal(input.step, 'any');
  }
  dom.window.close();
});

test('seconds spelling and nanosecond precision are retained exactly instead of normalized or emptied', () => {
  const dom = new JSDOM('<input>');
  const input = dom.window.document.querySelector('input')!;
  for (const raw of [
    '2026-01-01T12:30:00',
    '2026-01-01T12:30:00.000',
    '2026-01-01T12:30:15',
    '2026-01-01T12:30:00.123456789',
    '2026-01-01T12:30:15.123456',
  ]) {
    configureBaseDateInput(input, raw, true);
    assert.equal(input.type, 'text', raw);
    assert.equal(input.value, raw, raw);
  }
  dom.window.close();
});

test('offsets and invalid date literals remain exact editable text', () => {
  const dom = new JSDOM('<input>');
  const input = dom.window.document.querySelector('input')!;
  for (const [raw, datetime] of [
    ['2026-01-01T12:30:00-05:00', true],
    ['2026-01-01T12:30Z', true],
    ['2026-01-01T12:30:00.123456789+09:00', true],
    ['2026-02-30', false],
    ['not a calendar day', false],
    ['2026-01-01T24:00', true],
  ] as const) {
    configureBaseDateInput(input, raw, datetime);
    assert.equal(input.type, 'text', raw);
    assert.equal(input.value, raw, raw);
  }
  dom.window.close();
});

test('a reused input can return from exact-text fallback to a native value without retaining old text', () => {
  const dom = new JSDOM('<input>');
  const input = dom.window.document.querySelector('input')!;
  configureBaseDateInput(input, '2026-01-01T12:30:00.123456789', true);
  configureBaseDateInput(input, '2026-10-27', false);
  assert.equal(input.type, 'date');
  assert.equal(input.value, '2026-10-27');
  configureBaseDateInput(input, '', true);
  assert.equal(input.type, 'datetime-local');
  assert.equal(input.value, '');
  dom.window.close();
});
