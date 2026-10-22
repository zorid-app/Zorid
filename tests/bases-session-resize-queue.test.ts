import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { VaultEntry } from '../src/core/types.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function fixture({ automatic = false, failAfterSave = false, hideAfterSave = false, authoritativeIdentity = true } = {}) {
  // Fixture-owned authoritative IDs remain stable across writes. This exercises
  // session/controller composition, not Rust, native storage, or Electron.
  let release!: () => void, writeStarted = false, writes = 0, failQuery = false, visible = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Adapter extends MemoryAdapter {
    identity(entry: VaultEntry): VaultEntry { return authoritativeIdentity ? { ...entry, entryId: `fixture:${entry.path}` } : entry; }
    override async list() { return (await super.list()).map(entry => this.identity(entry)); }
    override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identity(entry) : null; }
    override async write(path: string, content: string) { await super.write(path, content); if (path === 'Work.base' && ++writes === 1) { writeStarted = true; failQuery = failAfterSave; if (hideAfterSave) visible = false; await gate; } }
  }
  const adapter = new Adapter({ 'Work.base': `views:\n  - type: table\n    name: Table\n    order: [file.name, note.rating]\n    columnSize: ${automatic ? '{}' : '{note.rating: 170}'}\n  - {type: list, name: Other}\n`, 'One.md': '---\nrating: 10\n---\nbody\n' });
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  const buffers = new Map<string, NoteBuffer>(), errors: string[] = [];
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile() {}, onError(error) { errors.push(error instanceof Error ? error.message : String(error)); },
    clock: { capture: () => ({ clockMs: 0, timezone: 'UTC' }), isVisible: () => visible, scheduleAt: () => () => {}, subscribeWake: () => () => {} },
    query: { now() { if (failQuery) throw new Error('Post-save query fixture unavailable'); return new Date(0); } },
    buffers: {
      async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); } await buffer.load(); return buffer; },
      validate() {},
    },
  }); await session.ready;
  const key = (key: string) => host.querySelector('[role="columnheader"][title="note.rating"] [role="separator"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const savedWidths = async () => BaseDocument.parse(await adapter.read('Work.base')).views[0].columnSize;
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await tick(); assert.ok(check()); };
  return { session, host, key, release, savedWidths, until, errors,
    pointerReset() { host.querySelector('[role="columnheader"][title="note.rating"] [role="separator"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); },
    get writes() { return writes; }, get writeStarted() { return writeStarted; },
    async recover() { failQuery = false; visible = true; await session.refresh(); },
    async close() { release(); failQuery = false; visible = true; await session.refresh(); await until(() => !session.hasPendingChanges()); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); },
  };
}

test('session publishes the acknowledged configuration before dispatching an accepted rapid reset', async () => {
  const f = await fixture(); try {
    f.key('ArrowRight'); f.key('Home'); await f.until(() => f.writeStarted);
    assert.deepEqual(await f.savedWidths(), { 'note.rating': 180 }); f.release();
    await f.until(() => f.writes === 2 && !f.session.hasPendingChanges());
    assert.deepEqual(await f.savedWidths(), {}); assert.deepEqual(f.session.state.result?.view.columnSize, {});
  } finally { await f.close(); }
});

test('close, flush and view switches preserve accepted queued widths until both writes complete', async () => {
  const f = await fixture(); try {
    f.key('ArrowRight'); f.key('Home'); assert.equal(f.session.hasPendingChanges(), true);
    await assert.rejects(f.session.close(), /queued column width changes/);
    await assert.rejects(f.session.flush(), /queued column width changes/);
    await assert.rejects(f.session.selectView(1), /queued column width changes/);
    assert.ok(f.host.querySelector('.bases-session')); f.release();
    await f.until(() => f.writes === 2 && !f.session.hasPendingChanges()); assert.deepEqual(await f.savedWidths(), {});
    await f.session.close(); assert.equal(f.host.querySelector('.bases-session'), null);
  } finally { await f.close(); }
});

test('a successful no-op reset acknowledges the unchanged result before the next resize', async () => {
  const f = await fixture({ automatic: true }); try {
    f.key('Home'); f.key('ArrowRight'); f.release(); await f.until(() => !f.session.hasPendingChanges());
    const widths = await f.savedWidths(); assert.equal(typeof (widths as Record<string, unknown>)['note.rating'], 'number'); assert.equal(f.session.state.error, null);
  } finally { await f.close(); }
});

test('post-save query failure keeps queued widths pending and blocks close until refresh recovers', async () => {
  const f = await fixture({ failAfterSave: true }); try {
    f.key('ArrowRight'); f.key('Home'); f.release(); await f.until(() => !!f.session.state.error);
    assert.equal(f.writes, 1); assert.equal(f.session.hasPendingChanges(), true);
    await assert.rejects(f.session.close(), /queued column width changes/); assert.match(f.host.textContent!, /Post-save query fixture unavailable/);
    await f.recover(); await f.until(() => f.writes === 2 && !f.session.hasPendingChanges());
    assert.deepEqual(await f.savedWidths(), {}); assert.equal(f.session.state.error, null);
  } finally { await f.close(); }
});

test('flushing an accepted no-op save leaves later resizing available', async () => {
  const f = await fixture({ automatic: true }); try {
    f.key('Home'); f.release(); await f.session.flush(); f.key('ArrowRight'); await f.until(() => !f.session.hasPendingChanges());
    assert.equal(typeof ((await f.savedWidths()) as Record<string, unknown>)['note.rating'], 'number');
  } finally { await f.close(); }
});


test('hidden post-save refresh cannot acknowledge stale widths and collapse repeated deltas', async () => {
  const f = await fixture({ hideAfterSave: true }); try {
    f.key('ArrowRight'); f.key('ArrowRight'); await f.until(() => f.writeStarted); f.release();
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(f.session.state.result?.view.columnSize && (f.session.state.result.view.columnSize as Record<string, unknown>)['note.rating'], 170);
    assert.equal(f.session.hasPendingChanges(), true); assert.equal(f.writes, 1);
    await assert.rejects(f.session.close(), /queued column width changes/);
    await f.recover(); await f.until(() => f.writes === 2 && !f.session.hasPendingChanges());
    assert.deepEqual(await f.savedWidths(), { 'note.rating': 190 });
  } finally { await f.close(); }
});

test('late keyboard and pointer reset input during close is explicitly rejected before acceptance', async () => {
  for (const input of ['keyboard', 'pointer'] as const) {
    const f = await fixture(); try {
      f.key('ArrowRight'); await f.until(() => f.writeStarted); const closing = f.session.close();
      if (input === 'keyboard') f.key('Home'); else f.pointerReset();
      assert.ok(f.errors.some(error => /finishing edits.*not accepted/.test(error))); f.release(); await closing;
      assert.equal(f.writes, 1); assert.deepEqual(await f.savedWidths(), { 'note.rating': 180 }); assert.equal(f.host.querySelector('.bases-session'), null);
    } finally { await f.close(); }
  }
});

test('legacy MemoryAdapter sessions resize directly and visibly reject unsafe pending or closing input', async () => {
  const f = await fixture({ authoritativeIdentity: false }); try {
    f.key('ArrowRight'); await f.until(() => f.writeStarted); f.key('Home');
    assert.ok(f.errors.some(error => /Wait for the current column width save, then retry/.test(error)));
    const closing = f.session.close(); f.pointerReset(); assert.ok(f.errors.some(error => /finishing edits.*not accepted/.test(error)));
    f.release(); await closing; assert.equal(f.writes, 1); assert.deepEqual(await f.savedWidths(), { 'note.rating': 180 });
  } finally { await f.close(); }
});
