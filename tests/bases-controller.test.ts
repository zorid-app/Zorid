import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { readProperties } from '../src/core/properties.ts';

const base = `# Keep comment\npluginRoot: {custom: [1, 2]}\nfilters: 'file.ext == "md"'\nviews:\n  - type: kanban\n    name: Board\n    groupBy: { property: Status, direction: ASC }\n    order: [file.name, Status]\n    pluginView: { retain: yes }\n`;
const note = '---\nStatus: Todo\nother: [one, two]\n---\nBody\n';
async function fixture(adapter = new MemoryAdapter({ 'Work.base': base, 'One.md': note })) {
  const vault = new Vault(adapter); await vault.initialize();
  const buffers = new Map<string, NoteBuffer>();
  const getBuffer = async (path: string) => {
    let buffer = buffers.get(path);
    if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); }
    await buffer.load(); return buffer;
  };
  let valid = true;
  const mutations = createBaseMutationHost({ getBuffer, validate() { if (!valid) throw new Error('Host disposed'); } });
  const controller = new BaseController({ vault, basePath: 'Work.base', mutations, delayMs: 1000 });
  await controller.refresh();
  assert.equal(controller.state.error, null);
  return { vault, buffers, getBuffer, controller, mutations, stop: async () => {
    controller.dispose(); valid = false;
    for (const buffer of buffers.values()) { try { await buffer.dispose(); } catch { /* failed drafts intentional */ } }
  } };
}

test('actual Vault snapshot includes metadata, immutable results, stable no-op refresh and CRUD', async () => {
  const f = await fixture();
  try {
    const first = f.controller.state;
    assert.equal(first.result?.rows[0].path, 'One.md');
    assert.deepEqual(first.result?.rows[0].values['note.Status'], { type: 'string', value: 'Todo' });
    assert.equal(Object.isFrozen(first.result?.rows), true);
    await f.controller.refresh(); assert.equal(f.controller.state, first);
    await f.vault.create('Two.md', '---\nStatus: Done\n---\n'); await f.controller.refresh();
    assert.equal(f.controller.state.result?.rows.length, 2);
    await f.vault.rename('Two.md', 'Three.md'); await f.controller.refresh();
    assert.ok(f.controller.state.result?.rows.some(row => row.path === 'Three.md'));
    await f.vault.trash('Three.md'); await f.controller.refresh();
    assert.equal(f.controller.state.result?.rows.length, 1);
  } finally { await f.stop(); }
});

test('property and Kanban edits preserve latest dirty body through real NoteBuffer/Vault CAS', async () => {
  const f = await fixture();
  try {
    const buffer = await f.getBuffer('One.md'); buffer.update(note + 'Unsaved typing\n');
    await f.controller.moveToGroup({ version: f.controller.state.version, path: 'One.md', value: 'Done' });
    assert.equal(buffer.dirty, false);
    const disk = await f.vault.read('One.md');
    assert.ok(disk.endsWith('Body\nUnsaved typing\n'));
    assert.deepEqual(readProperties(disk).map(item => [item.key, item.value]), [['Status', 'Done'], ['other', ['one', 'two']]]);
    assert.equal(f.controller.state.result?.groups[0].key?.value, 'Done');
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'status', value: 'Later' });
    assert.equal(readProperties(await f.vault.read('One.md')).filter(item => /status/i.test(item.key)).length, 1);
  } finally { await f.stop(); }
});

test('base view mutations preserve unknown fields and comments and reject dirty config', async () => {
  const f = await fixture();
  try {
    await f.controller.updateView(f.controller.state.version, { name: 'My Board', columnWidth: 300 });
    const source = await f.vault.read('Work.base');
    assert.match(source, /# Keep comment/); assert.match(source, /pluginRoot/); assert.match(source, /pluginView/);
    assert.equal(f.controller.state.result?.view.name, 'My Board');
    const buffer = await f.getBuffer('Work.base'); buffer.update(source + '# unsaved\n');
    await assert.rejects(f.controller.updateView(f.controller.state.version, { name: 'Discard draft' }), /unsaved/);
    assert.ok(buffer.text.endsWith('# unsaved\n'));
  } finally { await f.stop(); }
});

test('failed flush retains transformed dirty draft, rejects, and does not replay the transform', async () => {
  class Fails extends MemoryAdapter {
    fail = false;
    override async write(path: string, text: string) { if (this.fail && path === 'One.md') throw new Error('disk full'); return super.write(path, text); }
  }
  const adapter = new Fails({ 'Work.base': base, 'One.md': note }), f = await fixture(adapter);
  try {
    adapter.fail = true;
    await assert.rejects(f.controller.moveToGroup({ version: f.controller.state.version, path: 'One.md', value: 'Done' }), /disk full/);
    const buffer = await f.getBuffer('One.md');
    assert.equal(buffer.dirty, true); assert.match(buffer.text, /Status: Done/);
    assert.equal(await f.vault.read('One.md'), note);
    assert.equal(f.controller.state.result?.groups[0].key?.value, 'Todo');
    adapter.fail = false; await buffer.flush(); await f.controller.refresh();
    assert.equal(f.controller.state.result?.groups[0].key?.value, 'Done');
  } finally { adapter.fail = false; await f.stop(); }
});

test('disk conflict preserves user draft instead of overwriting external text', async () => {
  const adapter = new MemoryAdapter({ 'Work.base': base, 'One.md': note }), f = await fixture(adapter);
  try {
    const buffer = await f.getBuffer('One.md'); buffer.update(note + 'mine\n');
    await adapter.write('One.md', note + 'external\n');
    await assert.rejects(f.controller.moveToGroup({ version: f.controller.state.version, path: 'One.md', value: 'Done' }), /changed outside/);
    assert.ok(buffer.text.endsWith('mine\n')); assert.equal(buffer.dirty, true);
    assert.ok((await adapter.read('One.md')).endsWith('external\n'));
  } finally { await f.stop(); }
});

test('queued target delete/recreate and source base replacement reject stale edits', async () => {
  for (const replaced of ['One.md', 'Work.base']) {
    const f = await fixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const mutations = createBaseMutationHost({ getBuffer: async path => { await gate; return f.getBuffer(path); }, validate() {} });
      const controller = new BaseController({ vault: f.vault, basePath: 'Work.base', mutations });
      await controller.refresh();
      const write = controller.moveToGroup({ version: controller.state.version, path: 'One.md', value: 'Wrong' });
      const rejected = assert.rejects(write, /stale/);
      await f.vault.trash(replaced); await f.vault.create(replaced, replaced.endsWith('.base') ? base : note);
      release(); await rejected; controller.dispose();
      assert.equal(await f.vault.read('One.md'), note);
    } finally { await f.stop(); }
  }
});

test('disposed controller rejects queued writes and ignores later vault events', async () => {
  const f = await fixture();
  try {
    const state = f.controller.state; f.controller.dispose();
    await assert.rejects(f.controller.editProperty({ version: state.version, path: 'One.md', property: 'Status', value: 'Lost' }), /stale/);
    await f.vault.modify('One.md', note + 'Changed'); await f.controller.refresh();
    assert.equal(f.controller.state, state);
  } finally { await f.stop(); }
});

test('read-only file/formula grouping fails without mutating Markdown', async () => {
  const f = await fixture();
  try {
    for (const property of ['file.name', 'formula.computed']) {
      await assert.rejects(f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property, value: 'Wrong' }), /Only note/);
    }
    await assert.rejects(f.controller.renameFile(f.controller.state.version, 'One.md', 'Two.md'), /guarded/);
    assert.equal(await f.vault.read('One.md'), note);
  } finally { await f.stop(); }
});

test('single-flight refresh bounds queued reads while preserving the latest Vault snapshot', async () => {
  class Delayed extends MemoryAdapter {
    gate?: Promise<void>; reads = 0;
    override async read(path: string) { if (path === 'Work.base') { this.reads++; const gate = this.gate; this.gate = undefined; await gate; } return super.read(path); }
  }
  const adapter = new Delayed({ 'Work.base': base, 'One.md': note }), f = await fixture(adapter);
  try {
    let release!: () => void; adapter.gate = new Promise<void>(resolve => { release = resolve; });
    const before = adapter.reads;
    const refreshes = Array.from({ length: 100 }, () => f.controller.refresh());
    await f.vault.modify('One.md', note.replace('Todo', 'Latest'));
    release(); await Promise.all(refreshes); await f.controller.refresh();
    assert.ok(adapter.reads - before <= 3);
    assert.equal(f.controller.state.result?.groups[0].key?.value, 'Latest');
  } finally { await f.stop(); }
});

test('replacement queued after draft update cannot receive the old file edit', async () => {
  const f = await fixture(); let replacement: Promise<unknown> = Promise.resolve();
  let once = true;
  const mutations = createBaseMutationHost({ getBuffer: f.getBuffer, validate() {}, onBufferChange() {
    if (!once) return; once = false;
    replacement = Promise.all([f.vault.trash('One.md'), f.vault.create('One.md', note)]);
  } });
  const controller = new BaseController({ vault: f.vault, basePath: 'Work.base', mutations });
  try {
    await controller.refresh();
    await assert.rejects(controller.moveToGroup({ version: controller.state.version, path: 'One.md', value: 'Wrong' }), /stale/);
    await replacement;
    assert.equal(await f.vault.read('One.md'), note);
  } finally { controller.dispose(); await f.stop(); }
});

test('editing prefers the exact property key when YAML contains case-distinct keys', async () => {
  const f = await fixture(new MemoryAdapter({ 'Work.base': base, 'One.md': '---\nStatus: Upper\nstatus: lower\n---\nBody' }));
  try {
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'note.status', value: 'new' });
    assert.deepEqual(readProperties(await f.vault.read('One.md')).map(item => [item.key, item.value]), [['Status', 'Upper'], ['status', 'new']]);
  } finally { await f.stop(); }
});

test('Kanban refuses to discard list membership through a scalar destination', async () => {
  const f = await fixture(new MemoryAdapter({ 'Work.base': base, 'One.md': note.replace('Status: Todo', 'Status: [Todo, Later]') }));
  try {
    await assert.rejects(f.controller.moveToGroup({ version: f.controller.state.version, path: 'One.md', value: 'Done' }), /explicit list/);
    assert.deepEqual(readProperties(await f.vault.read('One.md'))[0].value, ['Todo', 'Later']);
    await f.controller.moveToGroup({ version: f.controller.state.version, path: 'One.md', value: ['Done', 'Later'] });
    assert.deepEqual(readProperties(await f.vault.read('One.md'))[0].value, ['Done', 'Later']);
  } finally { await f.stop(); }
});
