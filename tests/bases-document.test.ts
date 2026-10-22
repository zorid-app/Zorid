import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument, BUILTIN_BASE_VIEW_TYPES } from '../src/bases/document.ts';

const fixture = `# Original base
filters:
  and:
    - 'file.ext == "md"'
properties:
  status:
    displayName: "Current status"
    pluginConfig: { retain: true }
formulas:
  label: 'file.name + "!"'
summaries:
  custom: 'values.length'
newItemFolder: Notes
newItemTemplate: Templates/Note.md
pluginRoot:
  quoted: "001"
  nested: [true, 2, null]
views:
  - type: table
    name: "Table"
    filters: 'status != "Done"'
    groupBy: { property: status, direction: ASC }
    groupOrder: [Todo, Done]
    order: [file.name, status, formula.label]
    sort: [{ property: file.name, direction: DESC }]
    limit: 12
    summaries: { status: custom }
    rowHeight: tall
    pluginView: { keep: "002" }
  - type: cards
    name: Cards
    cardSize: 220
    image: cover
    imageFit: contain
    imageAspectRatio: 1.5
  - type: list
    name: List
    markers: number
    indentProperties: true
    separator: " | "
  - type: kanban
    name: Board
    columnWidth: 300
    image: cover
    imageAspectRatio: 0.5
    groupBy: { property: status, direction: ASC }
  - type: community-timeline
    name: Timeline
    options: { zoom: 2, arbitrary: [a, b] }
`;

test('all four built-in views and arbitrary plugin views roundtrip with unknown fields intact', () => {
  const base = BaseDocument.parse(fixture);
  assert.deepEqual(BUILTIN_BASE_VIEW_TYPES, ['table', 'cards', 'list', 'kanban']);
  assert.deepEqual(base.views.map(view => view.type), [...BUILTIN_BASE_VIEW_TYPES, 'community-timeline']);
  assert.equal(base.toString(), fixture);
  assert.deepEqual(base.getRoot('pluginRoot'), { quoted: '001', nested: [true, 2, null] });
  assert.deepEqual(base.views[0].pluginView, { keep: '002' });
  assert.deepEqual(base.views[4].options, { zoom: 2, arbitrary: ['a', 'b'] });
  assert.equal(base.getRoot('newItemFolder'), 'Notes');
  assert.equal(base.getRoot('newItemTemplate'), 'Templates/Note.md');
  assert.deepEqual(base.getRoot('formulas'), { label: 'file.name + "!"' });
});

test('empty source, missing views and empty views produce an initial table', () => {
  for (const source of ['', ' \r\n', '{}\n', 'views: []\n', '# heading\nfilters: "true"\n']) {
    const base = BaseDocument.parse(source);
    assert.equal(base.views.length, 1); assert.equal(base.views[0].type, 'table');
    assert.equal(typeof base.views[0].name, 'string'); assert.ok(base.views[0].name);
    assert.equal(BaseDocument.parse(base.toString()).views[0].type, 'table');
    if (source.includes('filters:')) assert.equal(base.getRoot('filters'), 'true');
  }
});

test('view patches preserve unknown root/view configuration, quotes, comments and field order', () => {
  const base = BaseDocument.parse(fixture);
  base.updateView(0, { name: 'Renamed', rowHeight: undefined, limit: 3.5, sort: [{ property: 'status', direction: 'ASC' }] });
  const result = base.toString();
  assert.match(result, /^# Original base/);
  assert.match(result, /name: "Renamed"/);
  assert.match(result, /quoted: "001"/);
  assert.match(result, /keep: "002"/);
  assert.equal(base.views[0].rowHeight, undefined);
  assert.equal(base.views[0].limit, 3.5);
  assert.deepEqual(base.views[0].sort, [{ property: 'status', direction: 'ASC' }]);
  assert.deepEqual(base.getRoot('properties'), { status: { displayName: 'Current status', pluginConfig: { retain: true } } });
  const reparsed = BaseDocument.parse(result);
  assert.deepEqual(reparsed.views, base.views);
  assert.deepEqual(reparsed.getRoot('pluginRoot'), base.getRoot('pluginRoot'));
  assert.ok(result.indexOf('filters:') < result.indexOf('properties:'));
});

test('add, duplicate and remove views retain their options and allow parser-valid names', () => {
  const base = BaseDocument.parse(fixture);
  assert.equal(base.addView('custom.plugin', 'Table'), 5); // Duplicate names are valid in the document parser.
  assert.equal(base.views[5].type, 'custom.plugin');
  assert.equal(base.duplicateView(3, '#Board: copy'), 6); // UI naming restrictions are a separate layer.
  assert.deepEqual(base.views[6], { ...base.views[3], name: '#Board: copy' });
  base.updateView(6, { columnWidth: 400 });
  assert.equal(base.views[3].columnWidth, 300);
  base.removeView(2); assert.deepEqual(base.views.map(view => view.type), ['table', 'cards', 'kanban', 'community-timeline', 'custom.plugin', 'kanban']);
  while (base.views.length) base.removeView(0);
  assert.deepEqual(base.views, []); // No invented last-view prohibition.
  assert.equal(BaseDocument.parse(base.toString()).views[0].type, 'table');
  assert.equal(base.addView('list', 'Restored'), 0);
});

test('root edits preserve safe own prototype-like keys and never share mutable inputs', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const base = BaseDocument.parse('views:\n  - type: table\n    name: Table\n');
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":true},"nested":[1,2]}');
  base.setRoot('__proto__', input); input.nested.push(3);
  assert.deepEqual(base.getRoot('__proto__'), { ...JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":true}}'), nested: [1, 2] });
  const patch = JSON.parse('{"__proto__":{"plugin":true},"constructor":"ordinary"}');
  base.updateView(0, patch); patch.__proto__.plugin = false;
  assert.ok(Object.hasOwn(base.views[0], '__proto__'));
  assert.deepEqual(base.views[0].__proto__, { plugin: true });
  assert.equal(base.views[0].constructor, 'ordinary');
  assert.equal(base.getRoot('toString'), undefined);
  const reparsed = BaseDocument.parse(base.toString());
  assert.deepEqual(reparsed.getRoot('__proto__'), base.getRoot('__proto__'));
  assert.deepEqual(reparsed.views, base.views);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  base.setRoot('__proto__', undefined); assert.equal(base.getRoot('__proto__'), undefined);
  base.setRoot('plugin', { '': true, 'multiline\nkey': 'preserved' });
  assert.deepEqual(BaseDocument.parse(base.toString()).getRoot('plugin'), { '': true, 'multiline\nkey': 'preserved' });
});

test('published configuration snapshots are cached, deeply readonly and detached from edits', () => {
  const base = BaseDocument.parse(fixture), views = base.views;
  assert.equal(base.views, views);
  assert.ok(Object.isFrozen(views)); assert.ok(Object.isFrozen(views[0]));
  assert.ok(Object.isFrozen(views[0].order));
  assert.throws(() => { (views[0] as { name: string }).name = 'tampered'; }, TypeError);
  base.updateView(0, { name: 'New' });
  assert.equal(views[0].name, 'Table'); assert.equal(base.views[0].name, 'New');
});

test('invalid YAML and malformed views reject without producing a replacement document', () => {
  for (const source of [
    'views: [', 'views: []\nviews: []', 'value:\n  duplicate: 1\n  duplicate: 2',
    '- list root', 'null', 'plain string', 'views: {}', 'views: null', 'views: [true]',
    'views: [{type: table}]', 'views: [{name: Table}]', 'views: [{type: "", name: Table}]',
    'views: [{type: table, name: ""}]', 'views: [{type: table, name: 1}]',
    'unknown: !unsupported tagged\nviews: []', 'cycle: &self [*self]\nviews: []',
  ]) assert.throws(() => BaseDocument.parse(source), undefined, source);
});

test('failed edits leave both original source and snapshot unchanged', () => {
  const base = BaseDocument.parse(fixture), views = base.views;
  const operations = [
    () => base.updateView(-1, { name: 'bad' }), () => base.updateView(99, { name: 'bad' }),
    () => base.updateView(0.5, { name: 'bad' }), () => base.updateView(0, { name: '' }),
    () => base.updateView(0, { name: undefined }), () => base.updateView(0, { type: 2 }),
    () => base.updateView(0, { options: Number.NaN }), () => base.addView('', 'bad'),
    () => base.duplicateView(0, ''), () => base.removeView(99),
    () => base.setRoot('views', true), () => base.setRoot('views', [{ type: 'table' }]),
  ];
  for (const operation of operations) {
    assert.throws(operation); assert.equal(base.toString(), fixture); assert.equal(base.views, views);
  }
  let getterCalls = 0;
  assert.throws(() => base.updateView(0, { get name() { getterCalls++; return 'Changed'; } }));
  assert.equal(getterCalls, 0); assert.equal(base.toString(), fixture);
});

test('BOM and CRLF convention survive edits and untouched source is byte-exact', () => {
  const source = '\uFEFF# Comment\r\nviews:\r\n  - type: table\r\n    name: \'My table\'\r\nplugin: "001"';
  const base = BaseDocument.parse(source); assert.equal(base.toString(), source);
  base.updateView(0, { limit: 5 });
  const output = base.toString(); assert.ok(output.startsWith('\uFEFF# Comment\r\n'));
  assert.match(output, /name: 'My table'/); assert.match(output, /plugin: "001"/);
  assert.equal(output.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(BaseDocument.parse(output).views[0].limit, 5);
});

test('duplicating a view renames internal anchors and preserves external aliases and original targets', () => {
  const source = 'shared: &outside [shared]\nviews:\n  - type: table\n    name: Original\n    own: &inside [one, two]\n    reference: *inside\n    external: *outside\nlast: *inside\n';
  const base = BaseDocument.parse(source); base.duplicateView(0, 'Copy');
  assert.deepEqual(base.views[1].own, ['one', 'two']);
  assert.deepEqual(base.views[1].reference, ['one', 'two']);
  assert.deepEqual(base.views[1].external, ['shared']);
  assert.match(base.toString(), /&inside_copy/);
  assert.match(base.toString(), /reference: \*inside_copy/);
  assert.match(base.toString(), /last: \*inside/);
  const before = base.toString();
  assert.throws(() => base.removeView(0), /alias|anchor/i);
  assert.equal(base.toString(), before);
});

test('view reorder/default moves original YAML nodes and preserves custom settings and comments', () => {
  const base = BaseDocument.parse('# header\nviews:\n  - type: table\n    name: First # name comment\n    custom: "001"\n  - type: cards\n    name: Second\n');
  base.moveView(0, 1);
  assert.deepEqual(base.views.map(view => view.name), ['Second', 'First']);
  assert.match(base.toString(), /name: First # name comment/); assert.match(base.toString(), /custom: "001"/);
  base.setDefaultView(1); assert.equal(base.views[0].name, 'First');
  const before = base.toString(); assert.throws(() => base.moveView(0, 8)); assert.equal(base.toString(), before);
});

test('atomic root patches preserve source when one key fails validation', () => {
  const base = BaseDocument.parse(fixture);
  assert.throws(() => base.updateRoot({ newItemFolder: 'Books', views: true })); assert.equal(base.toString(), fixture);
  let reads = 0;
  assert.throws(() => base.updateRoot({ get folders() { reads++; return 'bad'; } })); assert.equal(reads, 0);
  base.updateRoot({ newItemFolder: 'Books', newItemTemplate: undefined });
  assert.equal(base.getRoot('newItemFolder'), 'Books'); assert.equal(base.getRoot('newItemTemplate'), undefined);
  assert.match(base.toString(), /pluginRoot:/);
});

test('formula rename rewrites typed references while preserving literal text and unknown configuration', () => {
  const base = BaseDocument.parse(`formulas:\n  old: 'score * 2' # formula comment\n  other: 'formula.old + formula["old"] + "formula.old"'\nfilters: 'formula.old > 0'\nproperties:\n  formula.old: {displayName: Doubled}\ncustom: formula.old\nviews:\n  - type: table\n    name: Table\n    order: [file.name, formula.old]\n    sort: [{property: formula.old, direction: ASC}]\n    groupBy: {property: formula.old, direction: ASC}\n    summaries: {formula.old: Sum}\n`);
  base.renameFormula('old', 'new name');
  assert.equal((base.getRoot('formulas') as Record<string, unknown>)['new name'], 'score * 2');
  assert.equal((base.getRoot('formulas') as Record<string, unknown>).other, '((formula["new name"] + formula["new name"]) + "formula.old")');
  assert.deepEqual(base.views[0].order, ['file.name', 'formula.new name']); assert.equal(base.getRoot('custom'), 'formula.old');
  assert.match(base.toString(), /# formula comment/);
  const before = base.toString(); assert.throws(() => base.renameFormula('new name', 'other'), /already exists/); assert.equal(base.toString(), before);
});
