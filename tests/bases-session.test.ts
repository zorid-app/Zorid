import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { baseEditValue, createBaseViewActions } from '../src/bases/view-actions.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { readProperties } from '../src/core/properties.ts';

const base = `pluginRoot: { keep: yes }\nfilters: 'file.ext == "md"'\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n  - {type: cards, name: Cards, order: [file.name, status]}\n  - {type: list, name: List, order: [file.name, status]}\n  - type: kanban\n    name: Board\n    order: [file.name, status]\n    groupBy: {property: status, direction: ASC}\n    groupOrder: [Todo, Done]\n`;
const note = '---\nstatus: Todo\n---\nbody\n';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function fixture() {
  const adapter = new MemoryAdapter({ 'Work.base': base, 'One.md': note });
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main')!;
  const buffers = new Map<string, NoteBuffer>(), changes: string[] = [];
  const getBuffer = async (path: string) => {
    let buffer = buffers.get(path);
    if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); }
    await buffer.load(); return buffer;
  };
  const bufferHost = { getBuffer, validate() {}, onBufferChange(_path: string, _buffer: NoteBuffer, previous: string) { changes.push(previous); } };
  const session = createBaseSession(host, { vault, basePath: 'Work.base', buffers: bufferHost, validate() {}, openFile() {} });
  await session.ready;
  return { adapter, vault, dom, host, buffers, changes, getBuffer, session, bufferHost,
    key(node: Element, key: string) { node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); },
    async cleanup() { for (const input of host.querySelectorAll('input,textarea')) input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); },
  };
}

test('one session mounts all four implemented views without changing base configuration', async () => {
  const f = await fixture();
  try {
    for (const [index, selector] of ['.zorid-bases-table', '.bases-cards-container', '.bases-list-container', '.bases-kanban-view'].entries()) {
      await f.session.selectView(index); await tick();
      assert.ok(f.host.querySelector(selector), selector);
      assert.equal(f.host.querySelectorAll('.bases-session-content > :first-child').length, 1);
    }
    assert.equal(await f.vault.read('Work.base'), base);
  } finally { await f.cleanup(); }
});

test('table edit reaches shared dirty buffer and publishes actual persisted metadata', async () => {
  const f = await fixture();
  try {
    const buffer = await f.getBuffer('One.md'); buffer.update(note + 'draft body\n');
    const cell = f.host.querySelector('[data-property="note.status"][role="gridcell"]')!;
    f.key(cell, 'Enter'); const input = cell.querySelector('input')!; input.value = 'Done'; f.key(input, 'Enter');
    for (let i = 0; i < 10 && buffer.dirty; i++) await tick();
    await tick();
    assert.equal(readProperties(await f.vault.read('One.md'))[0].value, 'Done');
    assert.ok((await f.vault.read('One.md')).endsWith('draft body\n'));
    assert.equal(f.changes[0], note + 'draft body\n');
    assert.equal(f.session.state.result?.rows[0].values['note.status'].value, 'Done');
    assert.equal(f.host.querySelector('input'), null);
  } finally { await f.cleanup(); }
});

test('unsubmitted table draft blocks view change/close and survives unrelated metadata refresh', async () => {
  const f = await fixture();
  try {
    const cell = f.host.querySelector('[data-property="note.status"][role="gridcell"]')!;
    f.key(cell, 'Enter'); const input = cell.querySelector('input')!; input.value = 'keep this';
    await f.vault.create('Two.md', note); await f.session.refresh();
    assert.equal(input.isConnected, true); assert.equal(input.value, 'keep this');
    await assert.rejects(f.session.selectView(1), /Finish or cancel/);
    await assert.rejects(f.session.close(), /Finish or cancel/);
    assert.equal(input.isConnected, true);
    f.key(input, 'Escape'); await tick();
    assert.equal(f.host.querySelector('input'), null);
    await f.session.selectView(1); assert.ok(f.host.querySelector('.bases-cards-container'));
  } finally { await f.cleanup(); }
});

test('typed conversion preserves nested values and refuses computed/nonfinite/cyclic payloads', () => {
  assert.deepEqual(baseEditValue({ type: 'list', value: [{ type: 'null' }, { type: 'object', value: { yes: { type: 'boolean', value: true } } }] }), [null, { yes: true }]);
  for (const value of [{ type: 'number', value: Infinity }, { type: 'date', timestamp: Date.now(), hasTime: false }, { type: 'regexp', value: /x/ }]) {
    assert.throws(() => baseEditValue(value as never), /Cannot persist/);
  }
  const loop: any = { type: 'list', value: [] }; loop.value.push(loop);
  assert.throws(() => baseEditValue(loop), /cyclic/);
});

test('Kanban actions validate source/property/destination and persist via the real controller', async () => {
  const f = await fixture();
  const controller = new BaseController({ vault: f.vault, basePath: 'Work.base', mutations: createBaseMutationHost(f.bufferHost), query: { viewIndex: 3 } });
  try {
    await controller.refresh();
    const actions = createBaseViewActions(controller, { validate() {} });
    const request = { version: controller.state.version, path: 'One.md', property: 'status', source: { type: 'string' as const, value: 'Todo' }, destination: { type: 'string' as const, value: 'Done' } };
    await assert.rejects(actions.requestMove({ ...request, property: 'other' }), /grouping property/);
    await assert.rejects(actions.requestMove({ ...request, source: request.destination }), /group changed/);
    await assert.rejects(actions.requestMove({ ...request, destination: { type: 'string', value: 'Not a column' } }), /destination group/);
    await actions.requestMove(request);
    assert.equal(readProperties(await f.vault.read('One.md'))[0].value, 'Done');
    await assert.rejects(actions.requestMove(request), /stale/);
  } finally { controller.dispose(); await f.cleanup(); }
});

test('readonly embedded session needs no buffer host and never exposes writable property cells', async () => {
  const vault = new Vault(new MemoryAdapter({ 'Work.base': base, 'One.md': note })); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const session = createBaseSession(host, { vault, basePath: 'Work.base', readOnly: true, validate() {}, openFile() {} });
  try {
    await session.ready;
    assert.equal(host.querySelector('[data-property="note.status"][role="gridcell"]')?.getAttribute('aria-readonly'), 'true');
    await session.selectView(3);
    assert.equal(host.querySelector('.bases-kanban-card')?.getAttribute('draggable'), 'false');
  } finally { await session.close(); dom.window.close(); }
});

test('Cards and List edit through the same mutation host and retain precommit drafts across query refresh', async () => {
  for (const index of [1, 2]) {
    const f = await fixture();
    try {
      await f.session.selectView(index);
      const property = f.host.querySelector('.bases-rendered-value[data-property="note.status"]')!;
      property.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      const input = property.querySelector('input')!; input.value = 'Done';
      await f.vault.create('Two.md', note); await f.session.refresh();
      assert.equal(input.isConnected, true); assert.equal(input.value, 'Done');
      await assert.rejects(f.session.close(), /Finish or cancel/);
      f.key(input, 'Enter'); await tick();
      assert.equal(input.isConnected, true); assert.equal(input.getAttribute('aria-invalid'), 'true');
      assert.equal(await f.vault.read('One.md'), note);
      f.key(input, 'Escape'); await tick();
      const fresh = f.host.querySelector('.bases-rendered-value[data-property="note.status"]')!;
      fresh.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      const retry = fresh.querySelector('input')!; retry.value = 'Done'; f.key(retry, 'Enter');
      await tick(); await tick();
      assert.equal(readProperties(await f.vault.read('One.md'))[0].value, 'Done');
    } finally { await f.cleanup(); }
  }
});
