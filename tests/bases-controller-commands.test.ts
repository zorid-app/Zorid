import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { readProperties } from '../src/core/properties.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { BaseController, BaseBulkEditError, createBaseMutationHost } from '../src/bases/controller.ts';

const base = '# keep\nplugin: {retain: true}\nfilters: file.ext == "md"\nviews:\n  - type: table\n    name: First\n    order: [file.name, status, score]\n    pluginView: {keep: true}\n  - type: cards\n    name: Second\n';
const note = '---\nstatus: Todo\nscore: 1\n---\nBody\n';
async function fixture(adapter = new MemoryAdapter({ 'Work.base': base, 'One.md': note, 'Two.md': note }), viewName?: string) {
  const vault = new Vault(adapter); await vault.initialize();
  const buffers = new Map<string, NoteBuffer>();
  const getBuffer = async (path: string) => {
    let buffer = buffers.get(path);
    if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); }
    await buffer.load(); return buffer;
  };
  const mutations = createBaseMutationHost({ getBuffer, validate() {}, rename: (from, to, validate, witness) => vault.rename(from, to, validate, witness) });
  const controller = new BaseController({ vault, basePath: 'Work.base', mutations, viewName, delayMs: 1000 });
  await controller.refresh();
  return { vault, buffers, getBuffer, controller, async stop() { controller.dispose(); for (const buffer of buffers.values()) { try { await buffer.dispose(); } catch {} } } };
}
const properties = (source: string) => Object.fromEntries(readProperties(source).map(item => [item.key, item.value]));

test('view creation, duplication, default ordering and deletion retain the selected view and custom data', async () => {
  const f = await fixture(undefined, 'First');
  try {
    await f.controller.addView(f.controller.state.version, 'kanban');
    assert.equal(f.controller.state.result?.view.name, 'Kanban');
    await f.controller.duplicateView(f.controller.state.version, 0);
    assert.equal(f.controller.state.result?.view.name, 'First 2');
    assert.deepEqual(f.controller.state.result?.view.pluginView, { keep: true });
    await f.controller.setDefaultView(f.controller.state.version);
    assert.equal(f.controller.selectedViewIndex, 0);
    assert.equal(BaseDocument.parse(await f.vault.read('Work.base')).views[0].name, 'First 2');
    await f.controller.updateView(f.controller.state.version, 1, { name: 'Renamed original' });
    assert.equal(f.controller.state.result?.view.name, 'First 2');
    await f.controller.removeView(f.controller.state.version);
    assert.equal(f.controller.state.result?.view.name, 'Renamed original');
    assert.match(await f.vault.read('Work.base'), /# keep/); assert.match(await f.vault.read('Work.base'), /plugin:/);
    await assert.rejects(f.controller.addView(f.controller.state.version, 'table', 'Second'), /already exists/);
    await assert.rejects(f.controller.addView(f.controller.state.version, 'table', 'bad#name'), /unsupported/);
  } finally { await f.stop(); }
});

test('one atomic configuration edit changes root and view and refuses unrelated dirty source', async () => {
  const f = await fixture();
  try {
    await f.controller.updateConfiguration(f.controller.state.version, { root: { filters: 'score > 0', formulas: { double: 'score * 2' } }, view: { order: ['file.name', 'formula.double'] } });
    const document = BaseDocument.parse(await f.vault.read('Work.base'));
    assert.equal(document.getRoot('filters'), 'score > 0'); assert.deepEqual(document.views[0].order, ['file.name', 'formula.double']);
    const buffer = await f.getBuffer('Work.base'); buffer.update(buffer.text + '# typed');
    await assert.rejects(f.controller.updateRoot(f.controller.state.version, { newItemFolder: 'Books' }), /unsaved/);
    assert.ok(buffer.text.endsWith('# typed'));
  } finally { await f.stop(); }
});

test('bulk edits transform each file once; undo and redo preserve subsequent unrelated typing and missing values', async () => {
  class Adapter extends MemoryAdapter { writes = new Map<string, number>(); override async write(path: string, text: string) { this.writes.set(path, (this.writes.get(path) ?? 0) + 1); await super.write(path, text); } }
  const adapter = new Adapter({ 'Work.base': base, 'One.md': note, 'Two.md': note }), f = await fixture(adapter);
  try {
    const version = f.controller.state.version;
    await f.controller.editProperties([
      { version, path: 'One.md', property: 'status', value: 'Done' }, { version, path: 'One.md', property: 'new', value: ['a', 'b'] },
      { version, path: 'Two.md', property: 'score', value: 5 },
    ]);
    assert.equal(adapter.writes.get('One.md'), 1); assert.equal(adapter.writes.get('Two.md'), 1);
    const buffer = await f.getBuffer('One.md'); buffer.update(buffer.text + 'Later unrelated typing\n');
    assert.equal(f.controller.canUndo, true); await f.controller.undo();
    assert.deepEqual(properties(await f.vault.read('One.md')), { status: 'Todo', score: 1 });
    assert.ok((await f.vault.read('One.md')).endsWith('Later unrelated typing\n'));
    assert.equal(properties(await f.vault.read('Two.md')).score, 1); assert.equal(f.controller.canRedo, true);
    await f.controller.redo(); assert.equal(properties(await f.vault.read('One.md')).status, 'Done');
    assert.deepEqual(properties(await f.vault.read('One.md')).new, ['a', 'b']); assert.equal(properties(await f.vault.read('Two.md')).score, 5);
  } finally { await f.stop(); }
});

test('undo refuses to overwrite a touched property or a replacement file', async () => {
  const f = await fixture();
  try {
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'status', value: 'Done' });
    const buffer = await f.getBuffer('One.md'); buffer.update(buffer.text.replace('Done', 'Later'));
    await assert.rejects(f.controller.undo(), /touched property/); assert.match(buffer.text, /Later/);
    await f.vault.trash('One.md'); await f.vault.create('One.md', note); await f.controller.refresh();
    await assert.rejects(f.controller.undo(), /cannot be reversed/); assert.equal(await f.vault.read('One.md'), note);
  } finally { await f.stop(); }
});

test('failed exact property retry retains the original undo baseline', async () => {
  class Adapter extends MemoryAdapter { fail = false; override async write(path: string, text: string) { if (this.fail && path === 'One.md') throw new Error('disk full'); return super.write(path, text); } }
  const adapter = new Adapter({ 'Work.base': base, 'One.md': note }), f = await fixture(adapter);
  try {
    adapter.fail = true;
    const edit = { version: f.controller.state.version, path: 'One.md', property: 'status', value: 'Done' };
    await assert.rejects(f.controller.editProperty(edit), /disk full/); assert.equal(f.controller.canUndo, false);
    adapter.fail = false; await f.controller.editProperty(edit); assert.equal(f.controller.canUndo, true);
    await f.controller.undo(); assert.equal(properties(await f.vault.read('One.md')).status, 'Todo');
  } finally { adapter.fail = false; await f.stop(); }
});

test('partial bulk failure reports the saved prefix and that prefix can be undone', async () => {
  class Adapter extends MemoryAdapter { fail = true; override async write(path: string, text: string) { if (this.fail && path === 'Two.md') throw new Error('disk full'); return super.write(path, text); } }
  const adapter = new Adapter({ 'Work.base': base, 'One.md': note, 'Two.md': note }), f = await fixture(adapter);
  try {
    const version = f.controller.state.version;
    await assert.rejects(f.controller.editProperties(['One.md', 'Two.md'].map(path => ({ version, path, property: 'status', value: 'Done' }))), error => {
      assert.ok(error instanceof BaseBulkEditError); assert.deepEqual(error.completedPaths, ['One.md']); assert.equal(error.failedPath, 'Two.md'); return true;
    });
    assert.equal(properties(await f.vault.read('One.md')).status, 'Done'); assert.equal(properties(await f.vault.read('Two.md')).status, 'Todo');
    await f.controller.undo(); assert.equal(properties(await f.vault.read('One.md')).status, 'Todo');
  } finally { adapter.fail = false; await f.stop(); }
});

test('failed undo flush retries its exact draft and retains redo', async () => {
  class Adapter extends MemoryAdapter { fail = false; override async write(path: string, text: string) { if (this.fail && path === 'One.md') throw new Error('disk full'); return super.write(path, text); } }
  const adapter = new Adapter({ 'Work.base': base, 'One.md': note }), f = await fixture(adapter);
  try {
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'status', value: 'Done' });
    adapter.fail = true; await assert.rejects(f.controller.undo(), /disk full/);
    assert.equal(properties(await f.vault.read('One.md')).status, 'Done');
    adapter.fail = false; await f.controller.undo(); assert.equal(properties(await f.vault.read('One.md')).status, 'Todo');
    await f.controller.redo(); assert.equal(properties(await f.vault.read('One.md')).status, 'Done');
  } finally { adapter.fail = false; await f.stop(); }
});

test('file move undo/redo uses guarded namespace operations and preserves older property history', async () => {
  const f = await fixture();
  try {
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'status', value: 'Done' });
    await f.controller.renameFile(f.controller.state.version, 'One.md', 'Renamed.md');
    assert.equal(f.vault.entries.has('One.md'), false);
    await f.controller.undo(); assert.equal(f.vault.entries.has('Renamed.md'), false);
    await f.controller.undo(); assert.equal(properties(await f.vault.read('One.md')).status, 'Todo');
    await f.controller.redo(); await f.controller.redo(); assert.equal(properties(await f.vault.read('Renamed.md')).status, 'Done');
    await f.vault.create('One.md', 'unrelated'); await f.controller.refresh();
    await assert.rejects(f.controller.undo(), /already exists/); assert.equal(await f.vault.read('One.md'), 'unrelated');
  } finally { await f.stop(); }
});

test('undo records a stable-ID-proven namespace commit even if backlink completion then fails', async () => {
  class Adapter extends MemoryAdapter {
    ids = new Map([['Work.base', 'base'], ['One.md', 'one']]);
    override async list() { return (await super.list()).map(entry => ({ ...entry, entryId: this.ids.get(entry.path), revision: 'revision' })); }
    override async stat(path: string) { const entry = await super.stat(path); return entry && { ...entry, entryId: this.ids.get(path), revision: 'revision' }; }
    override async rename(from: string, to: string) { const id = this.ids.get(from); await super.rename(from, to); this.ids.delete(from); if (id) this.ids.set(to, id); }
  }
  const f = await fixture(new Adapter({ 'Work.base': base, 'One.md': note }));
  let failAfterCommit = false;
  const controller = new BaseController({ vault: f.vault, basePath: 'Work.base', mutations: createBaseMutationHost({ getBuffer: f.getBuffer, validate() {}, async rename(from, to, validate, witness) { await f.vault.rename(from, to, validate, witness); if (failAfterCommit) throw new Error('Rename committed, but links failed'); } }) });
  try {
    await controller.refresh(); await controller.renameFile(controller.state.version, 'One.md', 'Renamed.md');
    failAfterCommit = true; await assert.rejects(controller.undo(), /links failed/);
    assert.equal(f.vault.entries.get('One.md')?.entryId, 'one'); assert.equal(controller.canUndo, false); assert.equal(controller.canRedo, true);
    failAfterCommit = false; await controller.redo(); assert.equal(f.vault.entries.get('Renamed.md')?.entryId, 'one');
    assert.equal(controller.canUndo, true); assert.equal(controller.canRedo, false);
  } finally { controller.dispose(); await f.stop(); }
});

test('inline configuration transforms only its fence while containing-note properties use whole-note buffers', async () => {
  const source = '---\nstatus: Todo\n---\nBefore\n```base\n' + base + '```\nAfter\n';
  const vault = new Vault(new MemoryAdapter({ 'Container.md': source, 'One.md': note })); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'Container.md', { debounceMs: 60000 }); await buffer.load();
  const mutations = createBaseMutationHost({ getBuffer() { return buffer; }, validate() {} });
  let inlineWrites = 0;
  const controller = new BaseController({ vault, basePath: 'Container.md', mutations, inlineSource: {
    async read() { const full = await vault.read('Container.md'), match = /```base\n([\s\S]*?)```/.exec(full)!; return { source: match[1], startByte: new TextEncoder().encode(full.slice(0, match.index + 8)).length, endByte: new TextEncoder().encode(full.slice(0, match.index + 8 + match[1].length)).length }; },
    async transform(expected, desired, validate) { inlineWrites++; await mutations.transform('Container.md', full => { validate(); assert.ok(full.includes('```base\n' + expected + '```')); return full.replace('```base\n' + expected + '```', '```base\n' + desired + '```'); }, validate); },
  } });
  try {
    await controller.refresh(); assert.equal(controller.state.error, null);
    await controller.editProperty({ version: controller.state.version, path: 'Container.md', property: 'status', value: 'Done' });
    assert.equal(inlineWrites, 0); assert.equal(properties(await vault.read('Container.md')).status, 'Done');
    await controller.updateView(controller.state.version, { name: 'Inline renamed' });
    assert.equal(inlineWrites, 1); const saved = await vault.read('Container.md');
    assert.ok(saved.includes('Before\n```base\n')); assert.ok(saved.endsWith('```\nAfter\n')); assert.equal(properties(saved).status, 'Done');
    assert.match(saved, /name: Inline renamed/);
  } finally { controller.dispose(); await buffer.dispose(); }
});
