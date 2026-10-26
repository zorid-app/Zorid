import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { fixtureFiles, OLD_BASE, FIRST_BASE, NEWEST_BASE, rowNames, rowSource } from './bases-electron-sidebar-race-integration/fixtures.mjs';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 4000;
  while (!await check()) { assert.ok(Date.now() < end, label); await new Promise<void>(done => setTimeout(done, 2)); }
}
async function setup(t: TestContext, secondPane = false) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  const rect = () => ({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const adapter = new MemoryAdapter(Object.fromEntries(fixtureFiles())), root = document.querySelector<HTMLElement>('#app')!;
  const errors: unknown[] = [], mounted: string[] = [], closed: string[] = [];
  const validations = new Map<string, () => void>();
  const workspace = new Workspace(root, createEditor, { base: (host, options) => {
    const sidebar = host.classList.contains('sidebar-base-host');
    const session = createBaseSession(host, { ...options, onError(error) { if (sidebar) errors.push(error); options.onError?.(error); } });
    if (sidebar) {
      mounted.push(options.basePath); validations.set(options.basePath, options.validate);
      const close = session.close.bind(session); session.close = async () => { closed.push(options.basePath); await close(); };
    }
    return session;
  } });
  t.after(async () => { try { await workspace.destroy(); } finally { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } });
  await workspace.start({ adapter, id: 'test:sidebar-drain', label: 'Sidebar drain' });
  const internal = workspace as any;
  await workspace.openNote(FIRST_BASE); const firstPane = workspace.activePane;
  let newestPane = firstPane;
  if (secondPane) { await internal.split(); await workspace.openNote(NEWEST_BASE); newestPane = workspace.activePane; internal.activate(firstPane); }
  await internal.openBaseSidebar(OLD_BASE);
  const original = internal.sidebarBase;
  assert.equal(original.path, OLD_BASE); assert.deepEqual(mounted, [OLD_BASE]);
  return { dom, workspace, internal, adapter, errors, mounted, closed, validations, original, firstPane, newestPane };
}
function key(dom: JSDOM, target: Element, key: string, metaKey = false) {
  const event = new dom.window.KeyboardEvent('keydown', { key, metaKey, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event;
}
async function acceptedBulk(f: Awaited<ReturnType<typeof setup>>) {
  const gate = deferred(), write = f.adapter.write.bind(f.adapter); let reached = false;
  f.adapter.write = async (path, source) => {
    if (path === rowNames[0] && source.includes('race_score: null')) { reached = true; await gate.promise; }
    await write(path, source);
  };
  const cell = f.original.host.querySelector<HTMLElement>(`[role="gridcell"][data-path="${rowNames[0]}"][data-property="note.race_score"]`)!;
  assert.ok(cell); cell.focus(); assert.equal(key(f.dom, cell, 'a', true).defaultPrevented, true);
  assert.equal(key(f.dom, cell, 'Backspace').defaultPrevented, true);
  await until(() => reached, 'The original accepted bulk clear reaches its first normal write');
  assert.equal(f.original.session.hasPendingChanges(), true);
  assert.equal(f.original.host.querySelector('[role="grid"]')?.getAttribute('aria-busy'), 'true');
  return { release: gate.resolve, restore() { gate.resolve(); f.adapter.write = write; } };
}
async function cleared(f: Awaited<ReturnType<typeof setup>>) {
  for (const [index, path] of rowNames.entries()) assert.equal(await f.adapter.read(path), rowSource(index).replace(`race_score: ${index + 1}`, 'race_score: null'), 'Every file in the already accepted command remains owned until saved');
  for (const [path, source] of fixtureFiles()) if (!rowNames.includes(path)) assert.equal(await f.adapter.read(path), source);
}

test('two newer sidebar selections drain all accepted bulk writes before mounting only the newest target', async t => {
  const f = await setup(t), bulk = await acceptedBulk(f); let first: Promise<unknown> | undefined, newest: Promise<unknown> | undefined;
  try {
    first = f.internal.openBaseSidebar(FIRST_BASE).then(() => null, (error: unknown) => error);
    await until(() => !!f.original.closing, 'The replacement joins the original sidebar close');
    newest = f.internal.openBaseSidebar(NEWEST_BASE).then(() => null, (error: unknown) => error);
    assert.equal(f.internal.sidebarBase, f.original); assert.equal(f.original.host.isConnected, true); assert.deepEqual(f.mounted, [OLD_BASE]);
    bulk.release(); assert.deepEqual(await Promise.all([first, newest]), [null, null]);
    await cleared(f);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.closed, [OLD_BASE]); assert.deepEqual(f.mounted, [OLD_BASE, NEWEST_BASE]);
    assert.equal(f.internal.sidebarBase.path, NEWEST_BASE); assert.equal(f.original.host.isConnected, false);
    assert.throws(f.validations.get(OLD_BASE)!, /sidebar Base changed/, 'A replaced session never retains write authority');
  } finally { bulk.restore(); await Promise.allSettled([first, newest].filter(Boolean) as Promise<unknown>[]); }
});

test('activating a prewarmed pane while the sidebar closes defers this-context changes without dropping accepted writes', async t => {
  const f = await setup(t, true), bulk = await acceptedBulk(f); let first: Promise<unknown> | undefined, newest: Promise<unknown> | undefined;
  try {
    const previousContext = f.original.context;
    first = f.internal.openBaseSidebar(FIRST_BASE).then(() => null, (error: unknown) => error);
    await until(() => !!f.original.closing, 'The original session is draining');
    assert.doesNotThrow(() => f.internal.activate(f.newestPane), 'A newer pane cannot call a closing sidebar action');
    assert.equal(f.original.context, previousContext, 'The draining command keeps its original this-context');
    newest = f.internal.openBaseSidebar(NEWEST_BASE).then(() => null, (error: unknown) => error);
    bulk.release(); assert.deepEqual(await Promise.all([first, newest]), [null, null]);
    await cleared(f); assert.deepEqual(f.errors, []); assert.deepEqual(f.mounted, [OLD_BASE, NEWEST_BASE]);
    assert.equal(f.internal.sidebarBase.path, NEWEST_BASE); assert.equal(f.internal.sidebarBase.context, NEWEST_BASE);
  } finally { bulk.restore(); await Promise.allSettled([first, newest].filter(Boolean) as Promise<unknown>[]); }
});

test('a rejected replacement retains the old draft and its authority until the user finishes that original edit', async t => {
  const f = await setup(t), cell = f.original.host.querySelector<HTMLElement>(`[role="gridcell"][data-path="${rowNames[0]}"][data-property="note.race_score"]`)!;
  key(f.dom, cell, 'Enter');
  const input = cell.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!; assert.ok(input); input.value = '99';
  await assert.rejects(f.internal.openBaseSidebar(FIRST_BASE), /Finish or cancel the property edit/);
  assert.equal(f.internal.sidebarBase, f.original); assert.equal(f.original.closing, undefined); assert.equal(input.isConnected, true); assert.equal(input.value, '99');
  assert.deepEqual(f.mounted, [OLD_BASE]);
  for (const [index, path] of rowNames.entries()) assert.equal(await f.adapter.read(path), rowSource(index));
  assert.doesNotThrow(f.validations.get(OLD_BASE)!, 'The retained mounted session remains authoritative after close was refused');
  key(f.dom, input, 'Enter');
  await until(async () => !input.isConnected && !f.original.session.hasPendingChanges() && (await f.adapter.read(rowNames[0])).includes('race_score: 99'), 'The original retained draft can save normally');
  assert.equal(await f.adapter.read(rowNames[0]), rowSource(0).replace('race_score: 1', 'race_score: 99'));
  assert.ok(f.errors.length > 0); assert.ok(f.errors.every(error => /Finish or cancel the property edit/.test(String(error))));
  await f.internal.openBaseSidebar(NEWEST_BASE); assert.equal(f.internal.sidebarBase.path, NEWEST_BASE); assert.deepEqual(f.mounted, [OLD_BASE, NEWEST_BASE]);
});

test('the mounted-session drain allowance never authorizes a same-path recreated Base source', async t => {
  const f = await setup(t), validate = f.validations.get(OLD_BASE)!;
  await f.adapter.trash(OLD_BASE); await f.workspace.vault.reload();
  await f.adapter.write(OLD_BASE, fixtureFiles().get(OLD_BASE)! + 'recreated: true\n'); await f.workspace.vault.reload();
  assert.throws(validate, /sidebar Base changed/, 'The old file token still gates a session even if its path and mounted record remain');
  for (const [index, path] of rowNames.entries()) assert.equal(await f.adapter.read(path), rowSource(index));
  await f.internal.openBaseSidebar(NEWEST_BASE); assert.equal(f.internal.sidebarBase.path, NEWEST_BASE);
});
