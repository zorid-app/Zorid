import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferPropertyType, readProperties, removeProperty, renameProperty, setProperty, validatePropertyValue,
} from '../src/core/properties.ts';
import type { PropertyType } from '../src/core/properties.ts';

test('properties parse real YAML in order, preserving nested values and date strings', () => {
  const properties = readProperties(`---
title: "A: title # literal"
description: |
  first line
  second line
created: 2026-10-16
updated: 2026-10-16T14:30:00-04:00
enabled: true
quoted: "false"
count: 3.25
tags: [one, "two/three"]
aliases:
  - 'An alias'
empty:
config:
  paths: [one, two]
  settings:
    width: 50
    visible: false
mixed: [a, 1, null]
---
# Body`);
  assert.deepEqual(properties.map(property => property.key), ['title', 'description', 'created', 'updated', 'enabled', 'quoted', 'count', 'tags', 'aliases', 'empty', 'config', 'mixed']);
  assert.deepEqual(properties.find(property => property.key === 'created'), { key: 'created', value: '2026-10-16', type: 'date' });
  assert.deepEqual(properties.find(property => property.key === 'updated'), { key: 'updated', value: '2026-10-16T14:30:00-04:00', type: 'datetime' });
  assert.deepEqual(properties.find(property => property.key === 'config')!.value, { paths: ['one', 'two'], settings: { width: 50, visible: false } });
  assert.equal(properties.find(property => property.key === 'description')!.value, 'first line\nsecond line\n');
  assert.equal(properties.find(property => property.key === 'quoted')!.value, 'false');
  assert.equal(properties.find(property => property.key === 'mixed')!.type, 'unknown');
  assert.equal(properties.find(property => property.key === 'tags')!.type, 'tags');
  assert.equal(properties.find(property => property.key === 'aliases')!.type, 'list');
  assert.equal(properties.find(property => property.key === 'empty')!.value, null);
});

test('set, remove and rename preserve body bytes, property order and untouched YAML styles/comments', () => {
  const body = '\n# Body 🌱\n\n![[file.pdf#page=2]]\n```yaml\n---\n```\nlast line';
  const source = '---\n# leading comment\ntitle: "Old" # title comment\nlist: [one, two] # flow\ndescription: |\n  untouched text\n  next line\n\'quoted-key\': true\n---\n' + body;
  let output = setProperty(source, 'title', 'New', 'text');
  assert.ok(output.endsWith('---\n' + body));
  assert.match(output, /# leading comment/);
  assert.match(output, /title: "New" # title comment/);
  assert.match(output, /list: \[.*one, two.*\] # flow/);
  assert.match(output, /description: \|\n  untouched text\n  next line/);
  assert.match(output, /'quoted-key': true/);
  output = renameProperty(output, 'list', 'items');
  assert.deepEqual(readProperties(output).map(property => property.key), ['title', 'items', 'description', 'quoted-key']);
  assert.match(output, /items: \[.*one, two.*\] # flow/);
  output = setProperty(output, 'last', 9, 'number');
  assert.equal(readProperties(output).at(-1)!.key, 'last');
  output = removeProperty(output, 'description');
  assert.deepEqual(readProperties(output).map(property => property.key), ['title', 'items', 'quoted-key', 'last']);
  assert.ok(output.endsWith('---\n' + body));
  assert.equal(removeProperty(output, 'absent'), output);
  assert.equal(renameProperty(output, 'items', 'items'), output);
  assert.throws(() => renameProperty(output, 'title', 'items'), /already exists/);
  assert.throws(() => renameProperty(output, 'absent', 'new'), /does not exist/);
});

test('CRLF, BOM, dot delimiters and delimiter comments survive without altering Markdown', () => {
  const body = '\r\n# Heading\r\n\r\nline with LF\nno trailing newline 🌱';
  const source = '\uFEFF---  # properties\r\ntitle: One\r\n... # end\r\n' + body;
  const result = setProperty(source, 'title', 'Two', 'text');
  assert.ok(result.startsWith('\uFEFF---  # properties\r\n'));
  assert.ok(result.endsWith('... # end\r\n' + body));
  assert.match(result, /title: Two\r\n/);
  assert.deepEqual(readProperties(result), [{ key: 'title', value: 'Two', type: 'text' }]);
  const eof = setProperty('---\ntitle: Old\n...', 'title', 'New');
  assert.ok(eof.endsWith('\n...'));
  assert.ok(!eof.endsWith('\n'));
});

test('adding frontmatter to plain Markdown preserves all existing body characters', () => {
  for (const body of ['', '# Hello\n\nText', '# Windows\r\ntext\r\n', '\n---\nThematic rule', '# Head\n---\nBody']) {
    assert.deepEqual(readProperties(body), []);
    const output = setProperty(body, 'title', '01', 'text');
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    assert.ok(output.endsWith(`---${newline}${body}`));
    assert.deepEqual(readProperties(output), [{ key: 'title', value: '01', type: 'text' }]);
  }
  const output = setProperty('\uFEFF# Body\r\nlast', 'tags', ['one', 'nested/tag'], 'tags');
  assert.ok(output.startsWith('\uFEFF---\r\n'));
  assert.ok(output.endsWith('---\r\n# Body\r\nlast'));
});

test('empty and comment-only frontmatter accepts properties and keeps comments', () => {
  for (const yaml of ['', '# existing comment\n']) {
    const source = `---\n${yaml}---\nbody`;
    assert.deepEqual(readProperties(source), []);
    const result = setProperty(source, 'done', true, 'checkbox');
    assert.equal(readProperties(result)[0].value, true);
    if (yaml) assert.ok(result.includes('# existing comment'));
    assert.ok(result.endsWith('---\nbody'));
    assert.deepEqual(readProperties(removeProperty(result, 'done')), []);
  }
});

test('invalid YAML, duplicate keys and unsupported frontmatter never get overwritten by edits', () => {
  const sources = [
    '---\ntitle: [broken\n---\nbody',
    '---\ntitle: one\ntitle: two\n---\nbody',
    '---\nnested:\n  duplicate: 1\n  duplicate: 2\n---\nbody',
    '---\n- not\n- a mapping\n---\nbody',
    '---\nnull\n---\nbody',
    '---\ntitle: missing closing marker',
    '---',
    '---\n? [complex, key]\n: value\n---\nbody',
    '---\nvalue: !unsupported value\n---\nbody',
    '---\nvalue: *missing\n---\nbody',
  ];
  for (const source of sources) {
    assert.throws(() => readProperties(source), undefined, source);
    assert.throws(() => setProperty(source, 'title', 'replacement'), undefined, source);
    assert.throws(() => removeProperty(source, 'title'), undefined, source);
    assert.throws(() => renameProperty(source, 'title', 'name'), undefined, source);
  }
});

test('typed values validate without coercing text, lists, booleans or dates', () => {
  const accepted: [PropertyType, unknown][] = [
    ['text', 'false'], ['list', ['one', 'two']], ['number', 0], ['number', -2.5],
    ['checkbox', false], ['date', '2024-02-29'], ['date', '0099-01-02'],
    ['datetime', '2026-10-16T12:30'], ['datetime', '2026-10-16T12:30:59.123Z'],
    ['datetime', '2026-10-16T12:30:00-04:00'], ['tags', 'one'], ['tags', ['one', 'a/b']],
    ['unknown', { nested: [{ value: 2 }, null] }], ['unknown', null],
  ];
  for (const [type, value] of accepted) {
    assert.doesNotThrow(() => validatePropertyValue(type, value));
    assert.deepEqual(readProperties(setProperty('body', 'value', value, type))[0].value, value);
  }
  for (const type of ['text', 'list', 'number', 'checkbox', 'date', 'datetime', 'tags', 'unknown'] as const) {
    assert.doesNotThrow(() => validatePropertyValue(type, null));
  }
  const rejected: [PropertyType, unknown][] = [
    ['text', true], ['number', '1'], ['number', NaN], ['number', Infinity], ['checkbox', 'false'],
    ['list', 'one'], ['list', [1]], ['tags', ['one', false]],
    ['date', '2026-02-29'], ['date', '2024-02-30'], ['date', '2026-13-01'], ['date', '10/16/2026'],
    ['datetime', '2026-02-30T12:30'], ['datetime', '2026-10-16T24:00'],
    ['datetime', '2026-10-16T12:60'], ['datetime', '2026-10-16T12:30:60Z'],
    ['datetime', '2026-10-16T12:30+25:00'], ['unknown', new Date()], ['unknown', undefined],
  ];
  for (const [type, value] of rejected) {
    assert.throws(() => validatePropertyValue(type, value));
    assert.throws(() => setProperty('body', 'value', value, type));
  }
  assert.equal(inferPropertyType('created', '2026-02-29'), 'text');
});

test('prototype-like names roundtrip as own properties without changing JavaScript prototypes', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.deepEqual(readProperties(`---\n${key}: literal\n---\n`), [{ key, value: 'literal', type: 'text' }]);
    const created = setProperty('body', key, { polluted: true });
    assert.deepEqual(readProperties(created), [{ key, value: { polluted: true }, type: 'unknown' }]);
    const updated = setProperty(created, key, 'updated', 'text');
    assert.equal(readProperties(updated)[0].value, 'updated');
    const renamed = renameProperty('---\nsafe: true\n---\nbody', 'safe', key);
    assert.deepEqual(readProperties(renamed), [{ key, value: true, type: 'checkbox' }]);
    assert.deepEqual(readProperties(renameProperty(renamed, key, 'ordinary')), [{ key: 'ordinary', value: true, type: 'checkbox' }]);
    assert.deepEqual(readProperties(removeProperty(renamed, key)), []);
    const nested = JSON.parse(`{"${key}": {"polluted": true}}`);
    const parsed = readProperties(setProperty('body', 'nested', nested))[0].value as Record<string, unknown>;
    assert.deepEqual(parsed, nested);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.ok(Object.hasOwn(parsed, key));
    assert.equal(Object.getOwnPropertyDescriptor(parsed, key)?.enumerable, true);
  }
  const allKeys = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":true}');
  assert.deepEqual(readProperties(setProperty('body', 'nested', allKeys))[0].value, allKeys);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('cyclic data, accessors and excessive alias expansion fail without running user code', () => {
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => setProperty('body', 'cycle', cycle), /Cyclic/);
  let calls = 0;
  assert.throws(() => setProperty('body', 'getter', { get value() { calls++; return 1; } }), /accessors/);
  const arrayAccessor: unknown[] = [];
  Object.defineProperty(arrayAccessor, '0', { get() { calls++; return 1; }, enumerable: true });
  assert.throws(() => setProperty('body', 'getter', arrayAccessor), /accessors/);
  const customJSON: unknown[] = [];
  Object.defineProperty(customJSON, 'toJSON', { value: () => { calls++; return []; } });
  assert.throws(() => setProperty('body', 'custom', customJSON));
  assert.throws(() => setProperty('body', 'sparse', new Array(2)), /Sparse/);
  assert.equal(calls, 0);
  assert.throws(() => readProperties('---\ncycle: &self [*self]\n---\n'), /Cyclic/);
  assert.throws(() => readProperties('---\na: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n---\n'), /alias/i);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('ordinary aliases remain valid and deleting an anchor still in use fails explicitly', () => {
  const source = '---\noriginal: &shared [one, two]\ncopy: *shared\ntitle: Original\n---\nbody';
  const updated = setProperty(source, 'title', 'Updated', 'text');
  assert.deepEqual(readProperties(updated).slice(0, 2).map(property => property.value), [['one', 'two'], ['one', 'two']]);
  assert.match(updated, /&shared/);
  assert.match(updated, /\*shared/);
  assert.throws(() => removeProperty(source, 'original'), /anchor|alias/i);
});

test('header property sorting preserves YAML node styles, comments, delimiters and body bytes', async () => {
  const { sortProperties, clearProperties } = await import('../src/ui/property-menus.ts');
  const body = '\r\n# Body 🌱\r\n\nexact tail';
  const source = '\uFEFF--- # opening\r\nz: "last" # keep inline\r\nitem10: [a, b]\r\n# attached to item2\r\nitem2: |\r\n  multiline\r\na: {nested: true}\r\n... # closing\r\n' + body;
  const sorted = sortProperties(source);
  assert.deepEqual(readProperties(sorted).map(property => property.key), ['a', 'item2', 'item10', 'z']);
  assert.ok(sorted.startsWith('\uFEFF--- # opening\r\n'));
  assert.ok(sorted.endsWith('... # closing\r\n' + body));
  assert.match(sorted, /z: "last" # keep inline/);
  assert.match(sorted, /# attached to item2\r\nitem2: \|\r\n  multiline/);
  assert.deepEqual(readProperties(sortProperties(sorted, true)).map(property => property.key), ['z', 'item10', 'item2', 'a']);
  assert.equal(sortProperties(sorted), sorted);
  assert.equal(clearProperties(source), '\uFEFF' + body);
  assert.equal(clearProperties('# No metadata\n'), '# No metadata\n');
});

test('header property operations refuse malformed YAML and invalid alias reordering', async () => {
  const { sortProperties, clearProperties } = await import('../src/ui/property-menus.ts');
  const invalid = '---\nbroken: [\n---\nbody';
  assert.throws(() => sortProperties(invalid));
  assert.throws(() => clearProperties(invalid));
  const alias = '---\nz: &shared [one, two]\na: *shared\n---\nbody';
  assert.throws(() => sortProperties(alias), /alias|anchor/i);
  assert.deepEqual(readProperties(alias).map(property => property.value), [['one', 'two'], ['one', 'two']]);
  assert.equal(clearProperties(alias), 'body');
});
