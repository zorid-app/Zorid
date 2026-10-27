import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { readProperties } from '../src/core/properties.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { inferBaseCreationDefaults, planBaseItemCreation, prepareBaseItemCreation, prepareBaseFileCreation } from '../src/bases/creation.ts';

test('New literally copies full BOM/CRLF template and ignores conflicting property hints', async () => {
  const template = '\uFEFF---\r\nstatus: "Template" # retain\r\n---\r\n# {{title}}\r\n\r\nLiteral body {{date}}\r\n';
  const vault = new Vault(new MemoryAdapter({ 'Templates/Book.md': template })); await vault.initialize();
  const document = BaseDocument.parse('newItemTemplate: Templates/Book.md\nnewItemFolder: Books\nfilters: status == "Reading"\nviews: [{type: table, name: Table}]\n');
  const operation = await prepareBaseItemCreation({ vault, document, basePath: 'Library.base', name: 'Dune', defaults: { status: 'Default' }, group: { property: 'status', value: 'Group' } });
  assert.equal(operation.plan.path, 'Books/Dune.md'); assert.equal(operation.plan.text, template);
  assert.ok(operation.plan.warnings.some(warning => warning.includes('unchanged')));
  await operation.run(); assert.equal(await vault.read('Books/Dune.md'), template);
  assert.equal(await vault.read('Templates/Book.md'), template);
  assert.equal(operation.status, 'committed');
});

test('template parent precedes fallback and template read failure never creates a blank note', async () => {
  const vault = new Vault(new MemoryAdapter({ 'Templates/Book.md': '# body' })); await vault.initialize();
  const document = BaseDocument.parse('newItemTemplate: Templates/Book.md\nviews: [{type: table, name: Table}]');
  assert.equal((await planBaseItemCreation({ vault, document, basePath: 'Other/Library.base', fallbackFolder: 'Elsewhere' })).path, 'Templates/Untitled.md');
  document.setRoot('newItemTemplate', 'Missing.md');
  await assert.rejects(prepareBaseItemCreation({ vault, document, basePath: 'Library.base' }), /template.*unavailable/);
  assert.deepEqual([...vault.entries.keys()].filter(path => path.endsWith('.md')), ['Templates/Book.md']);
});

test('safe conjunctive defaults, explicit defaults, group precedence and visible empty fields', async () => {
  const vault = new Vault(new MemoryAdapter()); await vault.initialize();
  const document = BaseDocument.parse(`filters:\n  and:\n    - 'type == "book"'\n    - 'file.hasTag("reading")'\n    - 'file.inFolder("Books")'\nviews:\n  - type: kanban\n    name: Board\n    filters: 'status == "Reading" && rating >= 2'\n    order: [file.name, author, formula.label]\n`);
  const operation = await prepareBaseItemCreation({ vault, document, basePath: 'Library.base', defaults: { rating: 4 }, group: { property: 'status', value: 'Done' } });
  assert.equal(operation.path, 'Books/Untitled.md');
  assert.deepEqual(Object.fromEntries(readProperties(operation.text).map(item => [item.key, item.value])), { type: 'book', tags: ['reading'], status: 'Done', rating: 4, author: null });
  await operation.run(); assert.equal(await vault.read(operation.path), operation.text);
});

test('alternative/conflicting filters use deterministic first defaults while dynamic filters remain hints only', () => {
  const document = BaseDocument.parse(`filters:\n  and:\n    - or: ['status == "A"', 'status == "B"']\n    - 'owner == this.owner'\n    - 'priority == 1'\n    - 'priority == 2'\nviews: [{type: table, name: Table}]`);
  const defaults = inferBaseCreationDefaults(document);
  assert.deepEqual(defaults.properties, { status: 'A', priority: 1 }); assert.ok(defaults.warnings.length >= 2);
});

test('creation plans pick collision-safe names once and never replan after a racing create', async () => {
  const vault = new Vault(new MemoryAdapter({ 'Untitled.md': 'one', 'Untitled 1.md': 'two' })); await vault.initialize();
  const operation = await prepareBaseItemCreation({ vault, document: '', basePath: 'Library.base' });
  assert.equal(operation.path, 'Untitled 2.md');
  await vault.create(operation.path, 'external');
  await assert.rejects(operation.run(), /already exists/);
  await assert.rejects(operation.run(), /already exists/);
  assert.equal(await vault.read(operation.path), 'external'); assert.equal(vault.entries.has('Untitled 3.md'), false);
});

test('Create Base creates only normal .base config and can create its destination folder', async () => {
  const vault = new Vault(new MemoryAdapter()); await vault.initialize();
  const operation = await prepareBaseFileCreation({ vault, folder: 'Views', name: 'Books' });
  await operation.run();
  assert.deepEqual(BaseDocument.parse(await vault.read('Views/Books.base')).views, []);
  assert.deepEqual([...vault.entries.keys()].sort(), ['Views', 'Views/Books.base']);
});

test('a file used as destination parent and unsafe names fail without changing files', async () => {
  const vault = new Vault(new MemoryAdapter({ Books: 'ordinary file' })); await vault.initialize();
  await assert.rejects(planBaseItemCreation({ vault, document: 'newItemFolder: Books\nviews: [{type: table, name: Table}]', basePath: 'Library.base' }), /instead of a folder/);
  await assert.rejects(prepareBaseItemCreation({ vault, document: '', basePath: 'Library.base', name: '../escape' }), /filename/);
  assert.equal(await vault.read('Books'), 'ordinary file');
});
