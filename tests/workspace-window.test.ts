import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { WorkspaceStorageScope, validateWorkspaceWindowInfo } from '../src/ui/workspace-window.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { EditorOptions } from '../src/ui/editor.ts';

function domSetup() {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div>', { url: 'https://zorid.test/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return { dom, restore() { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}
function editor(parent: HTMLElement, options: EditorOptions) {
  const input = document.createElement('textarea'); input.value = options.value; input.oninput = () => options.onChange(input.value); parent.append(input);
  return { getValue: () => input.value, setValue(value: string) { input.value = value; }, focus() { input.focus(); }, destroy() { input.remove(); }, insert(text: string) { input.value += text; options.onChange(input.value); } };
}
const session = (path: string) => ({ panes: [{ id: 'saved-pane', tabs: [{ id: 'saved-tab', path, mode: 'live', kind: 'note' }], active: 0 }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('native identity scopes both sessions and drafts; legacy browser keys remain compatible', () => {
  const a = new WorkspaceStorageScope({ id: 'main', initialState: 'restore' });
  const b = new WorkspaceStorageScope({ id: 'secondary', initialState: 'empty' });
  assert.notEqual(a.sessionKey('desktop:/Notes'), b.sessionKey('desktop:/Notes'));
  assert.notEqual(a.draftPrefix('desktop:/Notes'), b.draftPrefix('desktop:/Notes'));
  assert.notEqual(a.sessionKey('a:b'), a.sessionKey('a/b'));
  assert.equal(new WorkspaceStorageScope().sessionKey('test:vault'), 'zorid:workspace:test:vault');
  assert.throws(() => validateWorkspaceWindowInfo({ id: '', initialState: 'restore' }));
});

test('only primary restores legacy recovery and migration never resurrects divergent old drafts', () => {
  const env = domSetup();
  try {
    const main = new WorkspaceStorageScope({ id: 'main', initialState: 'restore' }), extra = new WorkspaceStorageScope({ id: 'other', initialState: 'empty' });
    localStorage.setItem('zorid:workspace:desktop:/Notes', JSON.stringify(session('A.md')));
    localStorage.setItem('zorid:draft:desktop:/Notes:A.md', '{"base":"a","content":"old draft"}');
    extra.migrateLegacy(localStorage, 'desktop:/Notes'); assert.equal(localStorage.getItem(extra.sessionKey('desktop:/Notes')), null);
    const scopedDraft = `${main.draftPrefix('desktop:/Notes')}:A.md`;
    localStorage.setItem(scopedDraft, '{"base":"a","content":"new draft"}');
    main.migrateLegacy(localStorage, 'desktop:/Notes');
    assert.ok(localStorage.getItem(main.sessionKey('desktop:/Notes'))); assert.equal(localStorage.getItem('zorid:workspace:desktop:/Notes'), null);
    assert.match(localStorage.getItem(scopedDraft)!, /new draft/); assert.match(localStorage.getItem('zorid:draft:desktop:/Notes:A.md')!, /old draft/);
    localStorage.removeItem(scopedDraft); main.migrateLegacy(localStorage, 'desktop:/Notes'); assert.equal(localStorage.getItem(scopedDraft), null);
  } finally { env.restore(); }
});

test('CmdShiftN opens a native empty window, never creates a file; empty scope does not restore primary tabs', async () => {
  const env = domSetup(); let workspace: Workspace | undefined;
  try {
    let opened = 0;
    (window as any).zorid = { getWindowInfo: async () => ({ id: 'extra-1', initialState: 'empty' }), newWindow: async () => { opened++; return { id: 'extra-2' }; } };
    const scope = new WorkspaceStorageScope({ id: 'extra-1', initialState: 'empty' });
    localStorage.setItem('zorid:workspace:test:window', JSON.stringify(session('A.md')));
    const adapter = new MemoryAdapter({ 'A.md': 'text' }); workspace = new Workspace(document.querySelector('#app')!, editor);
    await workspace.start({ adapter, label: 'Test', id: 'test:window' });
    assert.equal(workspace.panes.length, 1); assert.equal(workspace.panes[0].tabs[0].path, null);
    const event = new env.dom.window.KeyboardEvent('keydown', { key: 'N', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(event); await tick();
    assert.equal(event.defaultPrevented, true); assert.equal(opened, 1); assert.deepEqual([...workspace.vault.entries.keys()], ['A.md']);
    await workspace.openNote('A.md'); const input = document.querySelector('textarea')!; input.value = 'dirty independent draft'; input.dispatchEvent(new env.dom.window.Event('input'));
    assert.match(localStorage.getItem(`${scope.draftPrefix('test:window')}:A.md`)!, /dirty independent draft/);
    assert.equal(localStorage.getItem('zorid:draft:test:window:A.md'), null);
    assert.ok(localStorage.getItem(scope.sessionKey('test:window')));
    await workspace.flush(); await workspace.openVault(workspace.platform); assert.equal(workspace.panes[0].tabs[0].path, 'A.md', 'same window can restore its subsequent own session');
    await workspace.destroy(); workspace = new Workspace(document.querySelector('#app')!, editor);
    await workspace.start({ adapter, label: 'Test', id: 'test:window' });
    assert.equal(workspace.panes[0].tabs[0].path, 'A.md', 'renderer reload restores its existing authenticated window identity despite creation initialState empty');
  } finally { if (workspace) await workspace.destroy(); env.restore(); }
});

test('native identity failure aborts initialization instead of sharing an unauthenticated persistence scope', async () => {
  const env = domSetup();
  try {
    (window as any).zorid = { getWindowInfo: async () => { throw new Error('identity unavailable'); }, newWindow: async () => ({ id: 'unused' }) };
    const workspace = new Workspace(document.querySelector('#app')!, editor);
    await assert.rejects(workspace.start({ adapter: new MemoryAdapter(), label: 'Test', id: 'test:failure' }), /identity unavailable/);
    assert.equal(localStorage.length, 0); assert.equal(workspace.panes.length, 0);
  } finally { env.restore(); }
});

test('failed primary migration preserves legacy session and draft bytes for retry', () => {
  const env = domSetup();
  try {
    const scope = new WorkspaceStorageScope({ id: 'main', initialState: 'restore' });
    const oldKey = 'zorid:workspace:test:quota'; localStorage.setItem(oldKey, 'legacy session');
    localStorage.setItem('zorid:draft:test:quota:A.md', '{"base":"a","content":"recovery"}');
    const failing = { get length() { return localStorage.length; }, key: (n: number) => localStorage.key(n), getItem: (key: string) => localStorage.getItem(key), setItem() { throw new Error('quota'); }, removeItem: (key: string) => localStorage.removeItem(key), clear() {} };
    assert.throws(() => scope.migrateLegacy(failing, 'test:quota'), /quota/);
    assert.equal(localStorage.getItem(oldKey), 'legacy session'); assert.match(localStorage.getItem('zorid:draft:test:quota:A.md')!, /recovery/);
    scope.migrateLegacy(localStorage, 'test:quota'); assert.equal(localStorage.getItem(oldKey), null); assert.equal(localStorage.getItem(scope.sessionKey('test:quota')), 'legacy session');
    const scopedDraft = `${scope.draftPrefix('test:quota')}:A.md`; assert.match(localStorage.getItem(scopedDraft)!, /recovery/);
    localStorage.removeItem(scopedDraft); scope.migrateLegacy(localStorage, 'test:quota'); assert.equal(localStorage.getItem(scopedDraft), null);
  } finally { env.restore(); }
});


test('legacy draft migration rejects longer vault prefixes and malformed encoded note suffixes', () => {
  const env = domSetup();
  try {
    const scope = new WorkspaceStorageScope({ id: 'main', initialState: 'restore' });
    localStorage.setItem('zorid:draft:desktop:/Notes:Archive:A.md', 'other vault');
    localStorage.setItem('zorid:draft:desktop:/Notes:bad%ZZ.md', 'malformed');
    localStorage.setItem('zorid:draft:desktop:/Notes:Folder%2FA%3AB.md', 'correct vault');
    scope.migrateLegacy(localStorage, 'desktop:/Notes');
    assert.equal(localStorage.getItem('zorid:draft:desktop:/Notes:Archive:A.md'), 'other vault');
    assert.equal(localStorage.getItem('zorid:draft:desktop:/Notes:bad%ZZ.md'), 'malformed');
    assert.equal(localStorage.getItem(`${scope.draftPrefix('desktop:/Notes')}:Folder%2FA%3AB.md`), 'correct vault');
    assert.equal(localStorage.getItem(`${scope.draftPrefix('desktop:/Notes')}:Archive:A.md`), null);
  } finally { env.restore(); }
});

test('startup migration quota failure cannot save an empty session over recoverable legacy tabs', async () => {
  const env = domSetup(); let workspace: Workspace | undefined;
  const original = env.dom.window.Storage.prototype.setItem;
  try {
    (window as any).zorid = { getWindowInfo: async () => ({ id: 'main', initialState: 'restore' }), newWindow: async () => ({ id: 'extra' }) };
    const legacyKey = 'zorid:workspace:test:quota-start', scope = new WorkspaceStorageScope({ id: 'main', initialState: 'restore' });
    localStorage.setItem(legacyKey, JSON.stringify(session('A.md')));
    env.dom.window.Storage.prototype.setItem = function(key, value) { if (key === scope.sessionKey('test:quota-start')) throw new Error('transient quota'); return original.call(this, key, value); };
    workspace = new Workspace(document.querySelector('#app')!, editor);
    const platform = { adapter: new MemoryAdapter({ 'A.md': 'retained' }), id: 'test:quota-start', label: 'Test' };
    await assert.rejects(workspace.start(platform), /transient quota/);
    assert.equal(localStorage.getItem(scope.sessionKey(platform.id)), null); assert.match(localStorage.getItem(legacyKey)!, /A.md/);
    env.dom.window.Storage.prototype.setItem = original;
    await workspace.start(platform); assert.equal(workspace.panes[0].tabs[0].path, 'A.md');
  } finally { env.dom.window.Storage.prototype.setItem = original; if (workspace) await workspace.destroy(); env.restore(); }
});

test('a numbered-tab shortcut waiting on disk cannot overtake a later pane activation', async () => {
  const env = domSetup(); let workspace: Workspace | undefined, release: (() => void) | undefined;
  try {
    const adapter = new MemoryAdapter({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c' });
    const write = adapter.write.bind(adapter); let armed = false, waiting = false;
    adapter.write = async (path, value) => { if (armed) { armed = false; waiting = true; await new Promise<void>(resolve => { release = resolve; }); } await write(path, value); };
    workspace = new Workspace(document.querySelector('#app')!, editor); await workspace.start({ adapter, label: 'Test', id: 'test:queued' });
    await workspace.openNote('A.md'); await workspace.openNote('B.md', true); const first = workspace.activePane;
    await (workspace as any).split('right'); await workspace.openNote('C.md'); const second = workspace.activePane;
    first.element.dispatchEvent(new env.dom.window.FocusEvent('focusin', { bubbles: true }));
    armed = true; first.editor!.insert(' unsaved');
    document.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick(); assert.equal(waiting, true);
    second.element.dispatchEvent(new env.dom.window.FocusEvent('focusin', { bubbles: true }));
    release!(); await tick(); await tick();
    assert.equal(workspace.activePane, second); assert.equal(first.tabs.find(tab => tab.id === first.active)?.path, 'B.md');
  } finally { release?.(); if (workspace) await workspace.destroy(); env.restore(); }
});
