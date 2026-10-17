import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';

const source = (names = ['First', 'Target'], kanban = false) => `filters: 'file.ext == "md"'\nviews:\n${names.map(name => `  - type: ${kanban && name === 'Target' ? 'kanban' : 'table'}\n    name: ${name}\n    order: [file.name, status]\n    groupBy: {property: status, direction: ASC}\n    groupOrder: [Todo, Done]\n    unknownView: ${name}\n`).join('')}`;
async function fixture(adapter = new MemoryAdapter({ 'Work.base': source(), 'One.md': '---\nstatus: Todo\n---\nBody', 'Two.md': '---\nstatus: Done\n---\nBody' })) {
  const vault = new Vault(adapter); await vault.initialize(); const buffers = new Map<string, NoteBuffer>();
  const host = { validate() {}, async getBuffer(path: string) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); } await buffer.load(); return buffer; } };
  return { vault, host, async dispose() { for (const buffer of buffers.values()) await buffer.dispose(); } };
}
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

test('named selection before first configuration read rejects without binding synthetic default name', async () => {
  const f = await fixture(); const originalRead = f.vault.read.bind(f.vault);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  f.vault.read = async path => { if (path === 'Work.base') { started(); await gate; } return originalRead(path); };
  const controller = new BaseController({ vault: f.vault, basePath: 'Work.base', viewName: 'Target', mutations: createBaseMutationHost(f.host), delayMs: 1000 });
  try {
    const refreshing = controller.refresh(); await ready;
    const selecting = controller.setView(0).then(() => null, error => error as Error);
    release(); await refreshing; const error = await selecting;
    assert.match(error?.message ?? '', /not ready/i);
    assert.equal(controller.state.error, null); assert.equal(controller.state.result!.view.name, 'Target');
    await controller.setView(0); assert.equal(controller.state.result!.view.name, 'First');
  } finally { release(); controller.dispose(); f.vault.read = originalRead; await f.dispose(); }
});

test('rejected named selection restores the previous visible selector index', async () => {
  const f = await fixture(), dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main')!;
  const session = createBaseSession(host, { vault: f.vault, basePath: 'Work.base', viewName: 'Target', buffers: f.host, validate() {}, openFile() {} });
  try {
    await session.ready; const selector = host.querySelector('select')!; assert.equal(selector.value, '1');
    await f.vault.modify('Work.base', source(['First'])); await session.refresh(); assert.ok(session.state.error);
    selector.value = '0'; selector.dispatchEvent(new dom.window.Event('change')); await tick();
    assert.equal(selector.value, '1'); assert.equal(session.state.result!.view.name, 'Target');
    assert.match(host.querySelector('.bases-session-status')!.textContent!, /not found: Target/);
  } finally { await session.close(); await f.dispose(); dom.window.close(); }
});

test('named config edit waiting on a host cannot patch another view after reordering', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const mutations = createBaseMutationHost({ ...f.host, async getBuffer(path) { started(); await gate; return f.host.getBuffer(path); } });
  const controller = new BaseController({ vault: f.vault, basePath: 'Work.base', viewName: 'Target', mutations, delayMs: 1000 });
  try {
    await controller.refresh(); const editing = controller.updateView(controller.state.version, { limit: 7 }).then(() => null, error => error as Error); await ready;
    await f.vault.modify('Work.base', source(['Target', 'First'])); await controller.refresh(); release();
    const error = await editing; assert.match(error?.message ?? '', /stale/);
    const document = BaseDocument.parse(await f.vault.read('Work.base')); assert.ok(document.views.every(view => view.limit === undefined));
    assert.equal(controller.selectedViewIndex, 0);
    await controller.updateView(controller.state.version, { limit: 9 });
    const updated = BaseDocument.parse(await f.vault.read('Work.base')); assert.equal(updated.views[0].limit, 9); assert.equal(updated.views[1].limit, undefined);
  } finally { release(); controller.dispose(); await f.dispose(); }
});

test('named Kanban preserves exact failed configuration retry and leaves sibling view intact', async () => {
  class Failing extends MemoryAdapter { fail = false; override async write(path: string, text: string) { if (this.fail && path === 'Work.base') throw new Error('disk full'); await super.write(path, text); } }
  const adapter = new Failing({ 'Work.base': source(undefined, true), 'One.md': '---\nstatus: Todo\n---\nBody', 'Two.md': '---\nstatus: Done\n---\nBody' });
  const f = await fixture(adapter), dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const session = createBaseSession(host, { vault: f.vault, basePath: 'Work.base', viewName: 'Target', buffers: f.host, validate() {}, openFile() {} });
  try {
    await session.ready; adapter.fail = true;
    host.querySelector('.bases-kanban-edit-columns')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Show Todo"]')!;
    assert.ok(checkbox); checkbox.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await tick();
    const buffer = await f.host.getBuffer('Work.base'); assert.equal(buffer.dirty, true); assert.ok(buffer.error);
    assert.deepEqual(BaseDocument.parse(buffer.text).views[1].groupOrder, ['Done']);
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Work.base')).views[1].groupOrder, ['Todo', 'Done']);
    adapter.fail = false;
    const retry = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Show Todo"]'); assert.ok(retry); assert.equal(retry.checked, true);
    retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await tick(); await session.flush();
    const saved = BaseDocument.parse(await f.vault.read('Work.base')); assert.deepEqual(saved.views[1].groupOrder, ['Done']); assert.deepEqual(saved.views[0].groupOrder, ['Todo', 'Done']);
    assert.equal(session.state.result!.view.name, 'Target'); assert.equal(host.querySelector('select')!.value, '1');
  } finally { adapter.fail = false; await session.close(); await f.dispose(); dom.window.close(); }
});
