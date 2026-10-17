import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseSession } from '../src/bases/session.ts';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseViewActions } from '../src/bases/view-actions.ts';

const config = `# Keep this\npluginRoot: { retained: [1, 2] }\nfilters: 'file.ext == "md"'\nviews:\n  - type: kanban\n    name: Board\n    pluginView: keep\n    groupBy: { property: status, direction: ASC, pluginGroup: keep }\n    groupOrder: [Todo, Done, unseen]\n`;
async function setup(source = config, adapter = new MemoryAdapter({ 'Board.base': source, 'One.md': '---\nstatus: Todo\n---\nBody' })) {
  const vault = new Vault(adapter); await vault.initialize();
  const buffers = new Map<string, NoteBuffer>();
  const host = { validate() {}, async getBuffer(path: string) {
    let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); }
    await buffer.load(); return buffer;
  } };
  const controller = new BaseController({ vault, basePath: 'Board.base', mutations: createBaseMutationHost(host) });
  await controller.refresh();
  const actions = createBaseViewActions(controller, { validate() {} });
  return { vault, controller, actions, host, async stop() { for (const buffer of buffers.values()) await buffer.dispose(); controller.dispose(); } };
}

test('column configuration changes only BaseDocument options, retaining unknown fields and note bytes', async () => {
  const f = await setup();
  try {
    const note = await f.vault.read('One.md');
    await f.actions.requestGroupOrder({ version: f.controller.state.version, property: 'note.status', order: ['Done', 'Todo', { future: 1 }] });
    const document = BaseDocument.parse(await f.vault.read('Board.base'));
    assert.deepEqual(document.views[0].groupOrder, ['Done', 'Todo', { future: 1 }]);
    assert.deepEqual(document.views[0].groupBy, { property: 'status', direction: 'ASC', pluginGroup: 'keep' });
    assert.equal(document.views[0].pluginView, 'keep'); assert.deepEqual(document.getRoot('pluginRoot'), { retained: [1, 2] });
    assert.match(document.toString(), /# Keep this/); assert.equal(await f.vault.read('One.md'), note);
    await f.actions.requestGroupOrder({ version: f.controller.state.version, property: 'status', order: undefined, direction: 'DESC' });
    const automatic = BaseDocument.parse(await f.vault.read('Board.base'));
    assert.equal(automatic.views[0].groupOrder, undefined);
    assert.deepEqual(automatic.views[0].groupBy, { property: 'status', direction: 'DESC', pluginGroup: 'keep' });
    await f.actions.requestGroupOrder({ version: f.controller.state.version, property: 'status', order: [] });
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Board.base')).views[0].groupOrder, []);
  } finally { await f.stop(); }
});

test('stale revisions, changed grouping and malformed directions cannot write configuration', async () => {
  const f = await setup();
  try {
    const version = f.controller.state.version;
    await assert.rejects(f.actions.requestGroupOrder({ version, property: 'other', order: [] }), /grouping property/);
    await assert.rejects(f.actions.requestGroupOrder({ version, property: 'status', order: undefined, direction: 'wrong' as never }), /direction/);
    await assert.rejects(f.actions.requestGroupOrder({ version, property: 'status', order: 'wrong' as never }), /list/);
    assert.equal(await f.vault.read('Board.base'), config);
    await f.vault.create('Two.md', 'other'); await f.controller.refresh();
    await assert.rejects(f.actions.requestGroupOrder({ version, property: 'status', order: [] }), /stale/);
    assert.equal(await f.vault.read('Board.base'), config);
  } finally { await f.stop(); }
});

test('formula and file group configuration remains writable while card properties remain read-only', async () => {
  for (const property of ['file.ext', 'formula.phase']) {
    const source = config.replace('property: status', `property: ${property}`).replace('views:', 'formulas:\n  phase: \'"Todo"\'\nviews:');
    const f = await setup(source);
    try {
      assert.equal(f.actions.canMove(f.controller.state.result!), false);
      await f.actions.requestGroupOrder({ version: f.controller.state.version, property, order: ['Todo'], direction: 'DESC' });
      assert.equal((BaseDocument.parse(await f.vault.read('Board.base')).views[0].groupBy as any).direction, 'DESC');
    } finally { await f.stop(); }
  }
});

test('dirty and externally changed base configuration is preserved instead of overwritten', async () => {
  const f = await setup();
  try {
    const buffer = await f.host.getBuffer('Board.base'); buffer.update(config + '# unsaved\n');
    await assert.rejects(f.actions.requestGroupOrder({ version: f.controller.state.version, property: 'status', order: [] }), /unsaved/);
    assert.equal(buffer.text, config + '# unsaved\n'); assert.equal(await f.vault.read('Board.base'), config);
  } finally { await f.stop(); }
});


test('session Edit columns persists visibility and keeps formula config editable without enabling card moves', async () => {
  const source = config.replace('property: status', 'property: formula.phase').replace('views:', 'formulas:\n  phase: \'"Todo"\'\nviews:');
  const f = await setup(source), dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const element = dom.window.document.querySelector('main')!;
  const session = createBaseSession(element, { vault: f.vault, basePath: 'Board.base', buffers: f.host, validate() {}, openFile() {} });
  try {
    await session.ready;
    const note = await f.vault.read('One.md');
    const card = element.querySelector('.bases-kanban-card');
    assert.equal(card?.getAttribute('draggable'), 'false');
    element.querySelector<HTMLButtonElement>('.bases-kanban-edit-columns')!.click();
    dom.window.document.querySelector<HTMLButtonElement>('.bases-columns-toggle')!.click();
    await session.flush();
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Board.base')).views[0].groupOrder, []);
    assert.equal(await f.vault.read('One.md'), note);
    assert.equal(session.hasPendingChanges(), false);
  } finally { await session.close(); await f.stop(); dom.window.close(); }
});

test('readonly session never exposes column configuration mutations', async () => {
  const f = await setup(), dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const element = dom.window.document.querySelector('main')!;
  const session = createBaseSession(element, { vault: f.vault, basePath: 'Board.base', readOnly: true, validate() {}, openFile() {} });
  try { await session.ready; assert.equal(element.querySelector('.bases-kanban-edit-columns'), null); }
  finally { await session.close(); await f.stop(); dom.window.close(); }
});
