import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBasePropertyDefinitions, updateBasePropertyDefinition, renameBasePropertyOption, parseBasePropertyInput, basePropertyValueDiagnostic, validDateText } from '../src/bases/property-definitions.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';

test('property settings are vault-wide definitions, with independent diagnostics and unfamiliar values retained', () => {
  const result = parseBasePropertyDefinitions(`version: 1\nproperties:\n  topics:\n    type: multiselect\n    options:\n      - value: Rust\n        color: orange\n  broken:\n    type: something-future\n  '__proto__':\n    type: text\n`);
  assert.equal(result.properties.topics.type, 'multiselect');
  assert.equal(result.properties.__proto__.type, 'text');
  assert.equal(Object.getPrototypeOf(result.properties), null);
  assert.equal(result.diagnostics[0].property, 'broken');
  assert.throws(() => parseBasePropertyDefinitions('properties: []'), /mapping/);
  assert.throws(() => parseBasePropertyDefinitions('properties: &p\n  topics: *p'), /alias|value type/i);
  assert.throws(() => parseBasePropertyDefinitions('shared: &a {type: text}\nproperties: {title: *a}'), /aliases/i);
  assert.equal(parseBasePropertyDefinitions('properties: {sum: {type: rollup, rollup: {relation: project, aggregation: sum}}}').diagnostics.length, 1);
});

test('targeted definition edits preserve other properties, unfamiliar config and comments', () => {
  const source = '# vault property settings\nversion: 1\nproperties:\n  topics:\n    # keep this comment\n    type: text\n    futureSetting: keep\n  rating:\n    type: number\n';
  const changed = updateBasePropertyDefinition(source, 'topics', { type: 'multiselect', options: [{ value: 'R&D, tools', color: 'blue' }] });
  assert.match(changed, /vault property settings/); assert.match(changed, /keep this comment/); assert.match(changed, /futureSetting: keep/);
  assert.equal(parseBasePropertyDefinitions(changed).properties.rating.type, 'number');
  assert.equal(parseBasePropertyDefinitions(changed).properties.topics.options?.[0].value, 'R&D, tools');
  const removed = updateBasePropertyDefinition(changed, 'topics', null);
  assert.equal(parseBasePropertyDefinitions(removed).properties.topics, undefined);
});

test('option rename returns an explicit separate note migration and preserves internal identity', () => {
  const source = 'properties:\n  status:\n    type: status\n    options:\n      - id: option-1\n        value: Doing\n        category: in-progress\n';
  const changed = renameBasePropertyOption(source, 'status', 'Doing', 'In progress');
  assert.deepEqual(changed.migration, { property: 'status', from: 'Doing', to: 'In progress' });
  assert.equal(parseBasePropertyDefinitions(changed.source).properties.status.options?.[0].id, 'option-1');
  assert.throws(() => renameBasePropertyOption(source, 'status', 'Missing', 'Done'), /no longer exists/);
  assert.throws(() => updateBasePropertyDefinition(source, 'status', { type: 'select', options: [{ value: 'A' }, { value: 'A' }] }), /unique/);
});

test('strict input conversion preserves commas, readable labels, unknown options and missing values', () => {
  assert.deepEqual(parseBasePropertyInput('R&D, tools\nRust', { type: 'multiselect' }), baseExpressionValue(['R&D, tools', 'Rust']));
  assert.deepEqual(parseBasePropertyInput('["Rust","Design"]', { type: 'list' }), baseExpressionValue(['Rust', 'Design']));
  assert.deepEqual(parseBasePropertyInput('[[Projects/A]]', { type: 'relation', relation: { multiple: true } }), baseExpressionValue(['[[Projects/A]]']));
  assert.deepEqual(parseBasePropertyInput('Unknown', { type: 'select', options: [{ value: 'A' }] }), baseExpressionValue('Unknown'));
  assert.deepEqual(parseBasePropertyInput('', { type: 'number' }), baseExpressionValue(null));
  for (const raw of ['NaN', 'Infinity', '0xFF', '  ', '12abc']) assert.throws(() => parseBasePropertyInput(raw, { type: 'number' }), /number/);
  assert.deepEqual(parseBasePropertyInput('-1.2e3', { type: 'number' }), baseExpressionValue(-1200));
  assert.throws(() => parseBasePropertyInput('yes', { type: 'checkbox' }), /true or false/);
  assert.match(basePropertyValueDiagnostic(baseExpressionValue('excellent'), { type: 'number' })!, /preserved/);
});

test('date parsing rejects normalized impossible days and never shifts a date-only value', () => {
  assert.equal(validDateText('2024-02-29', false), true); assert.equal(validDateText('2025-02-29', false), false);
  assert.equal(validDateText('2025-04-31', false), false); assert.equal(validDateText('2025-01-01T25:00', true), false);
  assert.deepEqual(parseBasePropertyInput('2025-01-01', { type: 'date' }), baseExpressionValue('2025-01-01'));
});


test('definition budgets, names and derived relation references match shared core validation', () => {
  assert.throws(() => updateBasePropertyDefinition('', 'bad\nname', { type: 'text' }), /bounded text/);
  assert.throws(() => updateBasePropertyDefinition('', 'x', { type: 'select', options: [{ value: 'x'.repeat(513) }] }), /nonempty value/);
  assert.throws(() => updateBasePropertyDefinition('', 'x', { type: 'select', options: Array.from({length:1025}, (_,i) => ({value:String(i)})) }), /Too many/);
  const parsed = parseBasePropertyDefinitions('properties: {invalid: {type: reverseRelation, reverseRelation: {property: missing}}, total: {type: rollup, rollup: {relation: invalid, aggregation: count}}}');
  assert.equal(Object.keys(parsed.properties).length, 0); assert.equal(parsed.diagnostics.length, 2);
  assert.equal(parseBasePropertyDefinitions('properties: {project: {type: relation}, related: {type: reverseRelation, reverseRelation: {property: project}}, total: {type: rollup, rollup: {relation: related, aggregation: count}}}').diagnostics.length, 0);
});
