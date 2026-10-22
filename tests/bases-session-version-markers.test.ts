import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function fixture() {
  const adapter = new MemoryAdapter({ 'Work.base': 'views:\n  - type: table\n    name: Table\n    order: [file.name, note.rating]\n    columnSize: {note.rating: 170}\n', 'One.md': '---\nrating: 1\n---\nbody\n', 'Properties.yaml': 'properties:\n  rating: {type: number}\n' });
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), host = dom.window.document.querySelector('main')!;
  let failQuery = false;
  const buffers = new Map<string, NoteBuffer>(), errors: string[] = [], states: {version: number; updating?: boolean; error?: string | null}[] = [];
  const session = createBaseSession(host, { vault, basePath: 'Work.base', validate() {}, openFile() {}, query: { now() { if (failQuery) throw new Error('Diagnostic fixture query unavailable'); return new Date(0); } }, onError(error) { errors.push(String(error)); }, onState(state) { states.push({ version: state.version, updating: state.updating, error: state.error?.message }); }, buffers: {
    async getBuffer(path) { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, { debounceMs: 60000 }); buffers.set(path, buffer); } await buffer.load(); return buffer; }, validate() {},
  } }); await session.ready;
  const key = (node: Element, key: string) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const cell = () => host.querySelector<HTMLElement>('[data-path="One.md"][data-property="note.rating"]')!;
  const begin = () => { cell().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); return cell().querySelector<HTMLInputElement>('input')!; };
  const save = (input: HTMLInputElement) => { input.value = '5'; key(input, 'Enter'); };
  const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100 && !await check(); i++) await tick(); assert.ok(await check()); };
  return { adapter, vault, session, host, cell, begin, save, key, errors, states, until,
    async failRefresh() { failQuery = true; await session.refresh(); },
    async cleanup() { const input = cell()?.querySelector('input'); if (input) key(input, 'Escape'); await tick(); await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close(); },
  };
}

test('settled resize/reset markers identify the current numeric widget begin frame', async () => {
  const f = await fixture(); try {
    for (const key of ['ArrowRight', 'Home']) { f.key(f.host.querySelector('[title="note.rating"] [role="separator"]')!, key); await f.until(() => !f.session.hasPendingChanges()); await tick(); }
    const input = f.begin(); assert.ok(input);
    const root = f.host.querySelector<HTMLElement>('.bases-session')!, table = f.host.querySelector<HTMLElement>('.zorid-bases-table')!;
    assert.equal(root.dataset.baseControllerVersion, String(f.session.state.version)); assert.equal(table.dataset.baseRenderedVersion, root.dataset.baseControllerVersion); assert.equal(f.cell().dataset.baseWidgetVersion, root.dataset.baseControllerVersion);
    assert.equal(root.dataset.baseControllerUpdating, 'false'); assert.equal(root.dataset.baseControllerError, 'false');
    f.save(input); await f.until(async () => /rating: 5/.test(await f.vault.read('One.md')) || f.errors.length > 0);
    assert.deepEqual(f.errors, []); assert.match(await f.vault.read('One.md'), /rating: 5/);
  } finally { await f.cleanup(); }
});

test('controller markers advance before deferred table and widget drafts while save guards remain intact', async () => {
  const f = await fixture(); try {
    const input = f.begin(); const before = f.session.state.version;
    await f.vault.create('Unrelated.md', 'unrelated'); await f.session.refresh(); assert.ok(f.session.state.version > before); assert.equal(input.isConnected, true);
    const root = f.host.querySelector<HTMLElement>('.bases-session')!, table = f.host.querySelector<HTMLElement>('.zorid-bases-table')!;
    assert.equal(root.dataset.baseControllerVersion, String(f.session.state.version)); assert.equal(table.dataset.baseRenderedVersion, String(before)); assert.equal(f.cell().dataset.baseWidgetVersion, String(before));
    assert.equal(root.dataset.baseControllerUpdating, 'false'); assert.equal(root.dataset.baseControllerError, 'false');
    f.save(input); await f.until(() => f.errors.length > 0);
    assert.match(f.errors[0], /This base result is stale/); assert.match(await f.vault.read('One.md'), /rating: 1/); assert.equal(input.value, '5');
  } finally { await f.cleanup(); }
});

test('query error marker is a flag and updates while an existing numeric draft remains pinned', async () => {
  const f = await fixture(); try {
    const input = f.begin(), version = f.cell().dataset.baseWidgetVersion; await f.failRefresh();
    const root = f.host.querySelector<HTMLElement>('.bases-session')!;
    assert.equal(root.dataset.baseControllerError, 'true'); assert.equal(root.dataset.baseControllerUpdating, 'false');
    assert.equal(input.isConnected, true); assert.equal(f.cell().dataset.baseWidgetVersion, version); assert.equal(root.getAttribute('data-base-controller-error'), 'true');
  } finally { await f.cleanup(); }
});

test('controller updating marker changes before awaiting a refresh without replacing a pinned draft', async () => {
  const f = await fixture(); try {
    const input = f.begin(), root = f.host.querySelector<HTMLElement>('.bases-session')!;
    const pending = f.session.refresh(); assert.equal(root.dataset.baseControllerUpdating, 'true'); assert.equal(input.isConnected, true);
    await pending; assert.equal(root.dataset.baseControllerUpdating, 'false'); assert.equal(input.isConnected, true);
  } finally { await f.cleanup(); }
});
