import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument } from '../src/bases/document.ts';
import { mountedRename } from './bases-electron-safety-integration/mounted-rename-contract.mjs';

test('mounted rename changes only the view name in the actual C2 source fixture', () => {
  const base = BaseDocument.parse(mountedRename.beforeBase);
  base.updateView(0, { name: 'Mounted renamed' });
  assert.equal(base.toString(), mountedRename.afterBase);
});

test('name-only patches retain all unrelated bytes, including no-op configuration fields', () => {
  const source = '# unknown comment\nplugin: {quoted: "001", flow: [a,b]}\nviews:\n  - type: table\n    name: Old # name comment\n    order: [file.name, score]\n    plugin: {z: 1,a: 2}\n  - type: list\n    name: Other\n    order: [file.name]\n';
  const base = BaseDocument.parse(source), oldViews = base.views;
  base.updateView(0, { name: 'Mounted renamed', type: 'table', order: ['file.name', 'score'], missing: undefined });
  assert.equal(base.toString(), source.replace('name: Old', 'name: Mounted renamed'));
  assert.equal(oldViews[0].name, 'Old');
  assert.deepEqual(base.views, BaseDocument.parse(base.toString()).views);
  assert.deepEqual(Object.keys(base.views[0]), ['type', 'name', 'order', 'plugin']);
});

test('quoted and multiline names preserve surrounding comments, flow spacing and document boundaries', () => {
  const cases = [
    ['views: [{type: table, name: "Old", order: [file.name]}] # end', '"Old"', 'New "quoted"', '"New \\"quoted\\""'],
    ["views: [ {name: 'Old', type: table, plugin: {a: 1,b: 2}} ]\n", "'Old'", "It's new", "'It''s new'"],
    ['views:\n - type: table\n   name: "Old\n     folded" # retain\n   order: [file.name]\n', '"Old\n     folded"', 'New', '"New"'],
    ['views: [{type: table, name: Old, order: [file.name]}]\n', 'name: Old', 'New, comma', 'name: "New, comma"'],
    ['\uFEFF# keep\r\nviews:\r\n - type: table\r\n   name: Old # retain\r\nplugin: [a,b]', 'name: Old', 'New', 'name: New'],
  ];
  for (const [source, before, name, after] of cases) {
    const base = BaseDocument.parse(source);
    base.updateView(0, { name });
    assert.equal(base.toString(), source.replace(before, after));
    assert.equal(BaseDocument.parse(base.toString()).views[0].name, name);
  }
});

test('block scalar renames retain the header comment and every byte outside the old name', () => {
  for (const header of ['|-', '>+', '|2-']) {
    const source = `# header\nviews:\n  - type: table\n    name: ${header}  # title\n      Old\n      name\n    order: [file.name]\nunknown: {z: 1,a: 2}\n`;
    const base = BaseDocument.parse(source);
    base.updateView(0, { name: 'New\nname' });
    assert.equal(base.toString(), source.replace(`${header}  # title\n      Old\n      name\n`, '"New\\nname"  # title\n'));
    assert.equal(BaseDocument.parse(base.toString()).views[0].name, 'New\nname');
  }
});

test('anchored names retain their source properties and aliases keep normal mutation semantics', () => {
  const source = 'views:\n - type: table\n   name: &title Old # keep\n   order: [file.name]\npluginName: *title\n';
  const base = BaseDocument.parse(source);
  base.updateView(0, { name: 'New' });
  assert.equal(base.toString(), source.replace('&title Old', '&title New'));
  assert.equal(base.getRoot('pluginName'), 'New');
  const aliased = 'title: &title Old\nviews: [{type: table, name: *title, order: [file.name]}]\n';
  const other = BaseDocument.parse(aliased);
  other.updateView(0, { name: 'New' });
  assert.equal(other.toString(), aliased.replace('name: *title', 'name: New'));
  assert.equal(other.getRoot('title'), 'Old');
});

test('ambiguous plain names cannot change YAML types, inject fields or redirect aliases', () => {
  const source = 'unknown: {flow: [a,b], nonfinite: .nan}\nviews: [{type: table, name: Old, order: [file.name]}]\n';
  for (const name of ['true', 'null', '42', '*missing', '!!str injected', 'New # hidden', 'New\nplugin: changed', 'New\rname', '\u0000name', '[a,b]', 'name: value']) {
    const base = BaseDocument.parse(source);
    base.updateView(0, { name });
    assert.equal(base.toString(), source.replace('name: Old', `name: ${JSON.stringify(name)}`));
    assert.equal(base.views[0].name, name);
    assert.deepEqual(base.getRoot('unknown'), { flow: ['a', 'b'], nonfinite: NaN });
    assert.equal(base.getRoot('plugin'), undefined);
  }
});

test('explicit string tags and whole-view aliases retain original source and mutation semantics', () => {
  const source = 'views:\n - &view\n   type: table\n   name: !!str Old\n   order: [file.name]\npluginView: *view\n';
  const base = BaseDocument.parse(source);
  base.updateView(0, { name: 'true' });
  assert.equal(base.toString(), source.replace('!!str Old', '!!str true'));
  assert.deepEqual(base.getRoot('pluginView'), base.views[0]);
});

test('repeated renames and a rename after another mutation use current source ranges', () => {
  const source = 'views: [{type: table, name: Old, order: [file.name]}, {type: list, name: Other}]\n';
  const base = BaseDocument.parse(source);
  base.updateView(0, { name: 'A much longer name' });
  base.updateView(1, { name: 'Second' });
  assert.equal(base.toString(), source.replace('name: Old', 'name: A much longer name').replace('name: Other', 'name: Second'));
  base.updateRoot({ plugin: { nested: ['a', 'b'] } });
  const before = base.toString();
  base.updateView(0, { name: 'Last' });
  assert.equal(base.toString(), before.replace('name: A much longer name', 'name: Last'));
  assert.deepEqual(base.views, BaseDocument.parse(base.toString()).views);
});

test('invalid and no-op name patches remain atomic; multi-field changes still apply normally', () => {
  const source = 'views: [{type: table, name: Old, order: [file.name]}]\n';
  const base = BaseDocument.parse(source), views = base.views;
  for (const operation of [() => base.updateView(0, { name: '' }), () => base.updateView(0, { name: undefined }), () => base.updateView(0, { name: 1 }), () => base.updateView(9, { name: 'New' })]) {
    assert.throws(operation); assert.equal(base.toString(), source); assert.equal(base.views, views);
  }
  base.updateView(0, { name: 'Old', missing: undefined });
  assert.equal(base.toString(), source); assert.equal(base.views, views);
  base.updateView(0, { name: 'New', order: ['score'] });
  assert.equal(base.views[0].name, 'New'); assert.deepEqual(base.views[0].order, ['score']);
  assert.deepEqual(base.views, BaseDocument.parse(base.toString()).views);
});
