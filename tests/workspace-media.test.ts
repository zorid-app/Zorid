import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import type { WorkspaceViewFactories } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { createMediaView, mediaKind } from '../src/ui/media-view.ts';
import type { AttachmentLease } from '../src/ui/attachments.ts';

const paths = ['mp3','wav','m4a','3gp','flac','ogg','oga','opus','mp4','webm','ogv','mov','mkv'].map(ext => `Media/clip.${ext.toUpperCase()}`);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Workspace media update did not settle');
}
async function setup(t: TestContext, factories: WorkspaceViewFactories = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  const root = dom.window.document.querySelector('main')!;
  const adapter = new MemoryAdapter(Object.fromEntries([...paths, 'unknown.avi'].map(path => [path, new Uint8Array([1, 2, 3])])));
  const workspace = new Workspace(root, () => { throw new Error('Unexpected Markdown editor'); }, factories);
  t.after(async () => {
    try { await workspace.destroy(); } finally {
      dom.window.close();
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
  await workspace.start({ adapter, label: 'Media', id: 'test:media' });
  return { workspace, adapter, dom, root };
}
function controlled() {
  const views: { path: string; host: HTMLElement; element: HTMLMediaElement; destroys: number; ready: Promise<void>; reject: (error: Error) => void; destroy(): void }[] = [];
  const media: NonNullable<WorkspaceViewFactories['media']> = (host, path) => {
    const element = host.ownerDocument.createElement(mediaKind(path)!); element.controls = true; host.append(element);
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((_resolve, fail) => { reject = fail; });
    const view = { path, host, element, destroys: 0, ready, reject, destroy() { this.destroys++; element.remove(); } };
    views.push(view); return view;
  };
  return { views, media };
}

test('standalone workspace routes all thirteen local formats and preserves native media menus', async t => {
  const factory = controlled(), { workspace, root, dom } = await setup(t, factory);
  for (const path of paths) {
    await workspace.openNote(path);
    const view = factory.views.at(-1)!;
    assert.equal(view.path, path); assert.equal(workspace.activePane.mediaView, view);
    assert.ok(root.querySelector('.media-attachment-view'));
    assert.doesNotMatch(root.textContent!, /No viewer is available/);
    const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    view.element.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
    assert.equal(root.querySelector('.context-menu'), null);
  }
  await workspace.openNote('unknown.avi');
  assert.equal(workspace.activePane.mediaView, undefined);
  assert.match(root.textContent!, /No viewer is available yet for AVI/);
  assert.ok(factory.views.every(view => view.destroys === 1));
});

test('parking, restoring and docking retain the same player; cached close and vault replacement dispose once', async t => {
  const factory = controlled(), { workspace } = await setup(t, factory);
  await workspace.openNote(paths[0]);
  const source = workspace.activePane, firstTab = source.tabs[0], first = factory.views[0];
  await workspace.openNote(paths[8], true);
  assert.equal(first.destroys, 0); assert.equal(first.element.isConnected, false);
  await (workspace as any).selectTab(source, firstTab);
  assert.equal(source.mediaView, first); assert.equal(first.element.isConnected, true); assert.equal(factory.views.length, 2);
  await (workspace as any).dockTab({ sourcePaneId: source.id, tabId: firstTab.id, targetPaneId: source.id, edge: 'right', index: 0 });
  const moved = workspace.activePane;
  assert.notEqual(moved, source); assert.equal(moved.mediaView, first); assert.equal(first.destroys, 0);
  assert.equal(source.mediaView, factory.views[1]);
  await workspace.openNote(paths[1], true, moved);
  await (workspace as any).closeTab(moved, firstTab);
  assert.equal(first.destroys, 1);
  await workspace.openNote(paths[2], true, moved);
  await workspace.openVault({ adapter: new MemoryAdapter(), label: 'Next', id: 'test:next' });
  assert.ok(factory.views.every(view => view.destroys === 1));
});

test('active refresh and cached modification/deletion release obsolete media handles', async t => {
  const factory = controlled(), { workspace, adapter } = await setup(t, factory);
  await workspace.openNote(paths[0]); const pane = workspace.activePane, firstTab = pane.tabs[0], first = factory.views[0];
  await workspace.renderPane(pane, { refresh: true });
  assert.equal(first.destroys, 1); const replacement = factory.views[1];
  await workspace.openNote(paths[1], true);
  await adapter.writeBinary(paths[0], new Uint8Array([1, 2, 3, 4])); await workspace.vault.reload([paths[0]]);
  await until(() => replacement.destroys === 1);
  await (workspace as any).selectTab(pane, firstTab);
  assert.equal(factory.views.length, 4); const refreshed = factory.views[3];
  await workspace.openNote(paths[2], true);
  await workspace.vault.trash(paths[0]); await until(() => refreshed.destroys === 1 && firstTab.path === null);
  assert.equal(workspace.activePane.mediaView, factory.views[4]);
});

test('readiness callbacks follow a moved owner but cannot publish after close or vault replacement', async t => {
  const factory = controlled(), { workspace, dom } = await setup(t, factory);
  await workspace.openNote(paths[0]); const pane = workspace.activePane, tab = pane.tabs[0], first = factory.views[0];
  await workspace.openNote(paths[1], true);
  await (workspace as any).selectTab(pane, tab);
  await (workspace as any).dockTab({ sourcePaneId: pane.id, tabId: tab.id, targetPaneId: pane.id, edge: 'right', index: 0 });
  const moved = workspace.activePane;
  first.reject(new Error('current media failure')); await tick();
  assert.match(dom.window.document.body.textContent!, /current media failure/);
  await workspace.openNote(paths[2]); const active = factory.views.at(-1)!;
  await (workspace as any).closeTab(moved, moved.tabs.find(tab => tab.id === moved.active));
  active.reject(new Error('closed media failure')); await tick();
  assert.doesNotMatch(dom.window.document.body.textContent!, /closed media failure/);
  const remaining = factory.views[1];
  await workspace.openVault({ adapter: new MemoryAdapter(), label: 'Next', id: 'test:next' });
  remaining.reject(new Error('previous vault failure')); await tick();
  assert.doesNotMatch(dom.window.document.body.textContent!, /previous vault failure/);
});

test('closing a real media view with pending acquisition settles readiness and releases the late lease', async t => {
  let resolve!: (lease: AttachmentLease) => void, releases = 0;
  const acquired = new Promise<AttachmentLease>(done => { resolve = done; });
  const { workspace, root } = await setup(t, { media: (host, path) => createMediaView(host, path, { acquire: () => acquired }) });
  await workspace.openNote(paths[1]); await tick();
  const pane = workspace.activePane, view = pane.mediaView!;
  await (workspace as any).closeTab(pane, pane.tabs[0]); await view.ready;
  resolve({ url: 'blob:late', type: 'audio/wav', release() { releases++; } }); await tick();
  assert.equal(releases, 1); assert.equal(root.querySelector('audio'), null);
});

test('default standalone media factory reads the workspace resource and owns native decoder error UI', async t => {
  const { workspace, root, dom } = await setup(t);
  await workspace.openNote(paths[1]); await until(() => !!root.querySelector('audio'));
  const audio = root.querySelector('audio')!;
  assert.match(audio.src, /^blob:/); assert.equal(audio.controls, true);
  audio.dispatchEvent(new dom.window.Event('error')); await workspace.activePane.mediaView!.ready;
  assert.match(root.textContent!, /Unable to play this media/);
  await workspace.openNote('unknown.avi'); assert.equal(audio.hasAttribute('src'), false);
});
