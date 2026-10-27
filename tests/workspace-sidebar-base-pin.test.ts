import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';

const base = 'filters: \'(this == null && kind == "missing") || (this != null && kind == "row" && category == this.category)\'\nviews: [{type: table, name: Context, order: [file.name, score]}]\n';
const fixtures = {
  'Context.base': base, 'Other.base': base,
  'A.md': '---\ncategory: One\n---\nA main note\n', 'B.md': '---\ncategory: Two\n---\nB main note\n', 'C.md': '---\ncategory: Three\n---\nC main note\n',
  'Row One.md': '---\nkind: row\ncategory: One\nscore: 11\n---\nOne row body\n',
  'Row Two.md': '---\nkind: row\ncategory: Two\nscore: 22\n---\nTwo row body\n',
  'Row Three.md': '---\nkind: row\ncategory: Three\nscore: 33\n---\nThree row body\n',
  'No current.md': '---\nkind: missing\nscore: 0\n---\nNull context only\n',
  'Properties.yaml': 'properties:\n  score: {type: number}\n',
};
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 4000;
  while (!await check()) { assert.ok(Date.now() < end, label); await new Promise<void>(done => setTimeout(done, 2)); }
}
async function setup(t: TestContext, adapter = new MemoryAdapter(fixtures)) {
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
  dom.window.Range.prototype.getBoundingClientRect = rect; dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null }); dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = document.querySelector<HTMLElement>('#app')!, errors: unknown[] = [], platform = { adapter, id: 'test:sidebar-pin', label: 'Sidebar pin' };
  const create = () => new Workspace(root, createEditor, { base: (host, options) => createBaseSession(host, { ...options, onError(error) { errors.push(error); options.onError?.(error); } }) });
  let workspace = create();
  t.after(async () => { try { await workspace.destroy(); } finally { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } });
  await workspace.start(platform); await workspace.openNote('A.md'); await (workspace as any).openBaseSidebar('Context.base');
  return { dom, root, adapter, errors, get workspace() { return workspace; }, internal: () => workspace as any,
    button: () => root.querySelector<HTMLButtonElement>('.right-tabs button.sidebar-base-pin'),
    async restart(afterClose?: () => void) { await workspace.destroy(); afterClose?.(); workspace = create(); await workspace.start(platform); },
  };
}
async function rows(f: Awaited<ReturnType<typeof setup>>, expected: string[]) {
  await until(() => {
    const session = f.internal().sidebarBase?.session, state = session?.state;
    return !!state?.result && !state.error && !state.updating && JSON.stringify(state.result.rows.map((row: { path: string }) => row.path)) === JSON.stringify(expected);
  }, 'The actual sidebar query publishes the expected this-context rows');
}
async function toggle(f: Awaited<ReturnType<typeof setup>>, pinned: boolean) {
  const button = f.button(); assert.ok(button, 'Sidebar Base exposes its public Pin control'); assert.equal(button.hidden, false); assert.equal(button.disabled, false); button.click();
  await until(() => f.internal().sidebarBase?.pinned === pinned && !f.internal().sidebarBase?.pinning, 'Pin operation acknowledges its local context');
  assert.equal(button.getAttribute('aria-pressed'), String(pinned)); assert.equal(button.getAttribute('aria-label'), pinned ? 'Unpin sidebar Base' : 'Pin sidebar Base');
}

test('public sidebar Pin freezes its active-note context and Unpin immediately catches up to the latest main note', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']);
  await toggle(f, true); await f.workspace.openNote('B.md'); await rows(f, ['Row One.md']);
  assert.equal(f.internal().sidebarBase.context, 'A.md');
  await toggle(f, false); await rows(f, ['Row Two.md']); assert.equal(f.internal().sidebarBase.context, 'B.md');
  for (const [path, source] of Object.entries(fixtures)) assert.equal(await f.adapter.read(path), source);
  assert.deepEqual(f.errors, []);
});

class IdentityAdapter extends MemoryAdapter {
  private next = 0;
  private identities = new Map<string, string>();
  private revisions = new Map<string, number>();
  private identify(entry: Awaited<ReturnType<MemoryAdapter['stat']>>) {
    if (!entry || entry.type !== 'file') return entry;
    if (!this.identities.has(entry.path)) this.identities.set(entry.path, `pin-entry-${++this.next}`);
    return { ...entry, entryId: this.identities.get(entry.path), revision: `r${this.revisions.get(entry.path) ?? 1}` };
  }
  async list() { return (await super.list()).map(entry => this.identify(entry)!); }
  async stat(path: string) { return this.identify(await super.stat(path)); }
  async write(path: string, source: string) { await super.write(path, source); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1); }
  async trash(path: string) { await super.trash(path); for (const key of [...this.identities.keys()]) if (key === path || key.startsWith(path + '/')) { this.identities.delete(key); this.revisions.delete(key); } }
  async rename(from: string, to: string) {
    await super.rename(from, to);
    for (const path of [...this.identities.keys()]) if (path === from || path.startsWith(from + '/')) {
      const next = to + path.slice(from.length); this.identities.set(next, this.identities.get(path)!); this.identities.delete(path); this.revisions.set(next, this.revisions.get(path) ?? 1); this.revisions.delete(path);
    }
  }
}
function key(f: Awaited<ReturnType<typeof setup>>, target: Element, key: string) { target.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }
function scoreInput(f: Awaited<ReturnType<typeof setup>>, path: string, value: string) {
  const cell = f.root.querySelector(`[role="gridcell"][data-path="${path}"][data-property="note.score"]`)!; assert.ok(cell); key(f, cell, 'Enter');
  const input = cell.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!; assert.ok(input); input.value = value; return input;
}

test('a pinned current note and its stable identity survive restart while the main note has advanced', async t => {
  const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']);
  await toggle(f, true); const identity = (await f.adapter.stat('A.md'))!.entryId; await f.workspace.openNote('B.md');
  await f.restart(); await rows(f, ['Row One.md']);
  assert.equal(f.internal().current().path, 'B.md'); assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.pinnedContext.entryId, identity);
  assert.equal(f.button()!.getAttribute('aria-pressed'), 'true'); await toggle(f, false); await rows(f, ['Row Two.md']); assert.deepEqual(f.errors, []);
});

test('hidden sidebar pin intent is restored lazily and a newly chosen Base starts following the main note', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  f.root.querySelector<HTMLButtonElement>('.right-tabs button[aria-label="Outline"]')!.click(); await until(() => f.internal().rightTab === 'outline', 'Outline is selected');
  await f.restart(); assert.equal(f.internal().sidebarBase, undefined); assert.equal(f.button()!.hidden, true);
  f.root.querySelector<HTMLButtonElement>('.right-tabs button[aria-label="Bases"]')!.click(); await rows(f, ['Row One.md']); assert.equal(f.internal().sidebarBase.pinned, true);
  await f.internal().openBaseSidebar('Other.base'); await rows(f, ['Row Two.md']); assert.equal(f.internal().sidebarBase.pinned, false); assert.equal(f.button()!.getAttribute('aria-pressed'), 'false');
});

test('blank and nonfile main tabs have explicit null context, and a main Base remains a real current file', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']);
  f.root.querySelector<HTMLButtonElement>('.pane.is-active .tab-add')!.click(); await rows(f, ['No current.md']); assert.equal(f.internal().sidebarBase.context, null);
  await toggle(f, true); await f.workspace.openNote('B.md'); await rows(f, ['No current.md']);
  await toggle(f, false); await rows(f, ['Row Two.md']);
  await f.workspace.openNote('Other.base'); await rows(f, []); assert.equal(f.internal().sidebarBase.context, 'Other.base');
  await toggle(f, true); await f.workspace.openNote('A.md'); await rows(f, []); assert.equal(f.internal().sidebarBase.context, 'Other.base');
  await toggle(f, false); await rows(f, ['Row One.md']);
  await f.internal().openGraph(); await rows(f, ['No current.md']); assert.equal(f.internal().sidebarBase.context, null);
  assert.deepEqual(f.errors, []);
});

test('a retained property draft refuses Pin without changing the pin or losing the draft', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); const input = scoreInput(f, 'Row One.md', '88');
  f.button()!.click(); await until(() => !f.internal().sidebarBase.pinning && f.errors.length > 0, 'The unfinished edit refuses the local pin change');
  assert.equal(f.internal().sidebarBase.pinned, false); assert.equal(f.button()!.getAttribute('aria-pressed'), 'false'); assert.equal(input.isConnected, true); assert.equal(input.value, '88');
  assert.equal(f.internal().sidebarBase.host.hasAttribute('inert'), false); assert.equal(await f.adapter.read('Row One.md'), fixtures['Row One.md']);
  assert.ok(f.errors.every(error => /Finish or cancel/.test(String(error)))); key(f, input, 'Escape'); await until(() => !input.isConnected, 'The retained input is cancelled normally');
  await toggle(f, true); await rows(f, ['Row One.md']);
});

test('known current-note and Base renames preserve the pin, while updates to that same current file remain live', async t => {
  const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  const identity = (await f.adapter.stat('A.md'))!.entryId;
  await f.workspace.vault.rename('A.md', 'Renamed A.md'); await until(() => f.internal().sidebarBase.context === 'Renamed A.md' && !f.internal().sidebarBase.pinning, 'The pin follows a known rename'); await rows(f, ['Row One.md']);
  assert.equal(f.internal().sidebarBase.pinnedContext.entryId, identity);
  await f.workspace.vault.rename('Context.base', 'Renamed Context.base'); await until(() => f.internal().sidebarBase.path === 'Renamed Context.base', 'The sidebar source remounts after its own known rename'); await rows(f, ['Row One.md']);
  assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.context, 'Renamed A.md');
  await f.workspace.vault.modify('Renamed A.md', fixtures['A.md'].replace('One', 'Two')); await rows(f, ['Row Two.md']);
  assert.equal(f.internal().sidebarBase.context, 'Renamed A.md'); assert.equal(f.internal().sidebarBase.pinned, true); assert.deepEqual(f.errors, []);
});

test('a pinned note never silently adopts a same-path replacement, including before reload and after restart', async t => {
  const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  const originalId = f.internal().sidebarBase.pinnedContext.entryId;
  await f.adapter.trash('A.md'); await f.adapter.write('A.md', fixtures['A.md'].replace('One', 'Two'));
  await f.internal().sidebarBase.session.refresh();
  const state = f.internal().sidebarBase.session.state; assert.ok(state.error); assert.match(state.error.message, /current note changed/); assert.deepEqual(state.result.rows.map((row: { path: string }) => row.path), ['Row One.md']);
  await f.workspace.vault.reload(); await rows(f, ['No current.md']); assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.pinnedContext.entryId, originalId);
  await f.restart(); await rows(f, ['No current.md']); assert.equal(f.internal().sidebarBase.pinnedContext.entryId, originalId);
  await toggle(f, false); await rows(f, ['Row Two.md']);
});

test('legacy identity-less contexts retain their live token instead of adopting a recreated path', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  await f.workspace.vault.trash('A.md'); await rows(f, ['No current.md']);
  await f.workspace.vault.create('A.md', fixtures['A.md'].replace('One', 'Two')); await rows(f, ['No current.md']);
  assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.context, null);
  await toggle(f, false); await rows(f, ['Row Two.md']);
});

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('keyboard Pin retires a clean body-mounted toolbar panel before awaiting the current-file read', async t => {
  const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']);
  const trigger = f.root.querySelector<HTMLButtonElement>('.sidebar-base-host button[aria-label="Views"]')!;
  trigger.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const panel = document.querySelector<HTMLElement>('.bases-toolbar-popover[data-panel="View options"]')!;
  assert.ok(panel); assert.equal(panel.parentElement, document.body); assert.equal(f.internal().sidebarBase.session.hasPendingChanges(), false);
  await f.internal().sidebarBase.session.flush(); assert.equal(panel.isConnected, true, 'Ordinary flush retains its existing clean-panel behavior');
  const gate = deferred(), entered = deferred(), stat = f.adapter.stat.bind(f.adapter); let held = false;
  f.adapter.stat = async path => { if (path === 'A.md' && !held) { held = true; entered.resolve(); await gate.promise; } return stat(path); };
  try {
    // Native keyboard activation dispatches click without an outside pointerdown.
    f.button()!.focus(); f.button()!.click(); await entered.promise;
    assert.equal(f.internal().sidebarBase.host.hasAttribute('inert'), true);
    assert.equal(panel.isConnected, false, 'The clean portal cannot admit a new configuration draft during the context read');
    gate.resolve(); await until(() => !f.internal().sidebarBase.pinning, 'The same public Pin request settles');
    assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(await f.adapter.read('Context.base'), fixtures['Context.base']); assert.deepEqual(f.errors, []);
  } finally { gate.resolve(); f.adapter.stat = stat; await until(() => !f.internal().sidebarBase.pinning, 'The held Pin operation releases'); }
});

test('Pin retains an unfinished toolbar name instead of dismissing its body-mounted draft', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']);
  f.root.querySelector<HTMLButtonElement>('.sidebar-base-host button[aria-label="Views"]')!.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const panel = document.querySelector<HTMLElement>('.bases-toolbar-popover[data-panel="View options"]')!, input = panel.querySelector<HTMLInputElement>('[aria-label="View name"]')!;
  try {
    input.value = ''; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.button()!.focus(); f.button()!.click();
    await until(() => !f.internal().sidebarBase.pinning && f.errors.length > 0, 'The draft refuses Pin');
    assert.equal(panel.isConnected, true); assert.equal(input.value, ''); assert.equal(f.internal().sidebarBase.pinned, false); assert.equal(f.button()!.disabled, false);
    assert.equal(await f.adapter.read('Context.base'), fixtures['Context.base']); assert.ok(f.errors.every(error => /Finish or cancel/.test(String(error))));
  } finally { panel.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')?.click(); }
});

test('Pin retires only clean property settings and retains an exact unfinished property name', async t => {
  for (const dirty of [false, true]) await t.test(dirty ? 'retained draft' : 'clean portal', async t => {
    const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']);
    f.root.querySelector<HTMLElement>('.sidebar-base-host [role="columnheader"][title="note.score"]')!.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')].find(button => button.textContent?.trim() === 'Edit property...')!.click();
    await until(() => !!document.querySelector('.bases-property-settings'), 'The actual property settings portal opens');
    const panel = document.querySelector<HTMLElement>('.bases-property-settings')!, input = panel.querySelector<HTMLInputElement>('[aria-label="Property name"]')!;
    const gate = deferred(), entered = deferred(), stat = f.adapter.stat.bind(f.adapter); let held = false;
    if (!dirty) f.adapter.stat = async path => { if (path === 'A.md' && !held) { held = true; entered.resolve(); await gate.promise; } return stat(path); };
    try {
      if (dirty) { input.value = 'score '; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); }
      f.button()!.focus(); f.button()!.click();
      if (dirty) {
        await until(() => !f.internal().sidebarBase.pinning && f.errors.length > 0, 'The exact property draft refuses Pin');
        assert.equal(panel.isConnected, true); assert.equal(input.value, 'score '); assert.equal(f.internal().sidebarBase.pinned, false); assert.ok(f.errors.every(error => /Finish or cancel/.test(String(error))));
      } else {
        await entered.promise; assert.equal(panel.isConnected, false); gate.resolve(); await until(() => !f.internal().sidebarBase.pinning, 'Pin finishes'); assert.equal(f.internal().sidebarBase.pinned, true); assert.deepEqual(f.errors, []);
      }
      assert.equal(await f.adapter.read('Properties.yaml'), fixtures['Properties.yaml']); assert.equal(await f.adapter.read('Context.base'), fixtures['Context.base']);
    } finally { gate.resolve(); f.adapter.stat = stat; await until(() => !f.internal().sidebarBase.pinning, 'Pin releases'); [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')?.click(); }
  });
});

test('the public Pin control is disabled throughout an accepted save draining for sidebar replacement', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); const original = f.internal().sidebarBase;
  const gate = deferred(), entered = deferred(), write = f.adapter.write.bind(f.adapter);
  f.adapter.write = async (path, source) => { if (path === 'Row One.md' && source.includes('score: 99')) { entered.resolve(); await gate.promise; } await write(path, source); };
  let opening: Promise<void> | undefined;
  try {
    const input = scoreInput(f, 'Row One.md', '99'); key(f, input, 'Enter'); await entered.promise;
    opening = f.internal().openBaseSidebar('Other.base');
    assert.equal(f.button()!.disabled, true, 'Closing is reflected before awaiting the accepted write');
    f.button()!.click(); assert.equal(original.pinning, undefined, 'Disabled Pin cannot start another context transaction');
    gate.resolve(); await opening; await rows(f, ['Row One.md']);
    assert.equal(f.internal().sidebarBase.path, 'Other.base'); assert.equal(f.button()!.disabled, false);
    assert.equal(await f.adapter.read('Row One.md'), fixtures['Row One.md'].replace('score: 11', 'score: 99')); assert.deepEqual(f.errors, []);
  } finally { gate.resolve(); f.adapter.write = write; await Promise.allSettled([opening].filter(Boolean) as Promise<unknown>[]); }
});

test('a refused sidebar close reenables Pin and preserves the retained property draft', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); const original = f.internal().sidebarBase;
  const input = scoreInput(f, 'Row One.md', '88'), opening = f.internal().openBaseSidebar('Other.base').then(() => null, (error: unknown) => error);
  try {
    assert.equal(f.button()!.disabled, true, 'Pin is unavailable while the close request is pending');
    assert.match(String(await opening), /Finish or cancel/);
    assert.equal(f.internal().sidebarBase, original); assert.equal(original.closing, undefined); assert.equal(f.button()!.disabled, false);
    assert.equal(original.pinning, undefined); assert.equal(input.isConnected, true); assert.equal(input.value, '88');
    assert.equal(await f.adapter.read('Row One.md'), fixtures['Row One.md']);
    key(f, input, 'Escape'); await until(() => !input.isConnected, 'The unchanged draft is cancelled normally'); await toggle(f, true);
  } finally { await opening; if (input.isConnected) key(f, input, 'Escape'); }
});

test('Unpin drains an accepted property save and catches the latest pane activated during that drain', async t => {
  const f = await setup(t); const a = f.workspace.activePane;
  await f.internal().split(); await f.workspace.openNote('B.md'); const b = f.workspace.activePane;
  await f.internal().split(); await f.workspace.openNote('C.md'); const c = f.workspace.activePane;
  a.element.focus(); await rows(f, ['Row One.md']); await toggle(f, true);
  const gate = deferred(), entered = deferred(), write = f.adapter.write.bind(f.adapter);
  f.adapter.write = async (path, source) => { if (path === 'Row One.md' && source.includes('score: 99')) { entered.resolve(); await gate.promise; } await write(path, source); };
  try {
    const input = scoreInput(f, 'Row One.md', '99'); key(f, input, 'Enter'); await entered.promise;
    b.element.focus(); f.button()!.click(); await until(() => !!f.internal().sidebarBase.pinning, 'Unpin joins the already accepted write');
    assert.equal(f.button()!.disabled, true); assert.equal(f.internal().sidebarBase.host.hasAttribute('inert'), true); assert.equal(f.internal().sidebarBase.pinned, true);
    c.element.focus(); gate.resolve(); await until(() => !f.internal().sidebarBase.pinning && !f.internal().sidebarBase.pinned, 'One unpin acknowledges the latest main context');
    await rows(f, ['Row Three.md']); assert.equal(f.internal().sidebarBase.context, 'C.md'); assert.equal(f.internal().sidebarBase.host.hasAttribute('inert'), false);
    assert.equal(await f.adapter.read('Row One.md'), fixtures['Row One.md'].replace('score: 11', 'score: 99')); assert.deepEqual(f.errors, []);
  } finally { gate.resolve(); f.adapter.write = write; }
});

test('a newer sidebar selection supersedes a pending Pin without transferring pin state or losing its accepted write', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); const original = f.internal().sidebarBase;
  const gate = deferred(), entered = deferred(), write = f.adapter.write.bind(f.adapter);
  f.adapter.write = async (path, source) => { if (path === 'Row One.md' && source.includes('score: 99')) { entered.resolve(); await gate.promise; } await write(path, source); };
  let pin: Promise<unknown> | undefined, opening: Promise<void> | undefined;
  try {
    const input = scoreInput(f, 'Row One.md', '99'); key(f, input, 'Enter'); await entered.promise;
    pin = f.internal().toggleSidebarBasePin().then(() => null, (error: unknown) => error);
    await until(() => !!original.pinning, 'The local pin has joined the accepted write'); opening = f.internal().openBaseSidebar('Other.base');
    gate.resolve(); const refusal = await pin; assert.match(String(refusal), /sidebar Base changed/); await opening;
    await rows(f, ['Row One.md']); assert.equal(f.internal().sidebarBase.path, 'Other.base'); assert.equal(f.internal().sidebarBase.pinned, false); assert.equal(f.button()!.getAttribute('aria-pressed'), 'false');
    assert.equal(await f.adapter.read('Row One.md'), fixtures['Row One.md'].replace('score: 11', 'score: 99')); assert.equal(original.host.isConnected, false); assert.equal(original.host.hasAttribute('inert'), false); assert.deepEqual(f.errors, []);
  } finally { gate.resolve(); f.adapter.write = write; await Promise.allSettled([pin, opening].filter(Boolean) as Promise<unknown>[]); }
});

test('an identity failure during Unpin restores the original pinned selector and never acknowledges a replacement', async t => {
  const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  const gate = deferred(), entered = deferred(), stat = f.adapter.stat.bind(f.adapter); let reads = 0;
  f.adapter.stat = async path => { if (path === 'B.md' && ++reads === 2) { entered.resolve(); await gate.promise; } return stat(path); };
  let unpin: Promise<unknown> | undefined;
  try {
    unpin = f.internal().toggleSidebarBasePin().then(() => null, (error: unknown) => error); await entered.promise;
    assert.equal(f.internal().sidebarBase.host.hasAttribute('inert'), true);
    await f.adapter.trash('B.md'); await f.adapter.write('B.md', fixtures['B.md'].replace('Two', 'Three')); gate.resolve();
    const error = await unpin; assert.match(String(error), /current.*changed/i); await rows(f, ['Row One.md']);
    assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.context, 'A.md'); assert.equal(f.internal().sidebarBase.host.hasAttribute('inert'), false); assert.equal(f.button()!.getAttribute('aria-pressed'), 'true');
    assert.equal(await f.adapter.read('B.md'), fixtures['B.md'].replace('Two', 'Three'));
  } finally { gate.resolve(); f.adapter.stat = stat; await Promise.allSettled([unpin].filter(Boolean) as Promise<unknown>[]); }
});

test('an explicitly pinned blank context survives restart instead of defaulting to the Base or main file', async t => {
  const f = await setup(t); f.root.querySelector<HTMLButtonElement>('.pane.is-active .tab-add')!.click(); await rows(f, ['No current.md']);
  await toggle(f, true); await f.workspace.openNote('A.md'); await f.restart(); await rows(f, ['No current.md']);
  assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.context, null); assert.equal(f.internal().sidebarBase.pinnedContext.path, null);
  await toggle(f, false); await rows(f, ['Row One.md']);
});

test('a known rename preserves a lazily restored legacy pin without recapturing another path', async t => {
  const f = await setup(t); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  f.root.querySelector<HTMLButtonElement>('.right-tabs button[aria-label="Outline"]')!.click(); await until(() => f.internal().rightTab === 'outline', 'Outline is selected');
  await f.restart(); assert.equal(f.internal().sidebarBase, undefined);
  await f.workspace.vault.rename('A.md', 'Renamed A.md');
  f.root.querySelector<HTMLButtonElement>('.right-tabs button[aria-label="Bases"]')!.click(); await rows(f, ['Row One.md']);
  assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.context, 'Renamed A.md'); await toggle(f, false); await rows(f, ['Row Two.md']);
});

test('malformed persisted pin identity restores an absent context rather than silently choosing the current note', async t => {
  const f = await setup(t, new IdentityAdapter(fixtures)); await rows(f, ['Row One.md']); await toggle(f, true); await f.workspace.openNote('B.md');
  const key = f.internal().sessionKey();
  await f.restart(() => { const stored = JSON.parse(localStorage.getItem(key)!); stored.sidebarBaseContextEntryId = { invalid: true }; localStorage.setItem(key, JSON.stringify(stored)); });
  await rows(f, ['No current.md']); assert.equal(f.internal().sidebarBase.pinned, true); assert.equal(f.internal().sidebarBase.context, null);
  await toggle(f, false); await rows(f, ['Row Two.md']);
});
