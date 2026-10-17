import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import type { EditorHandle } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { VaultEntry } from '../src/core/types.ts';
import type { DurableWrites } from '../src/core/durable-writes.ts';
import type {
  DocumentEntry, DocumentPage, DocumentPin, DocumentPinId,
  DocumentRelationshipPage, DocumentService, DocumentSnapshotId,
} from '../src/core/document-semantics.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const snapshot: DocumentSnapshotId = {
  localStoreId: 'store', generationEpoch: 'epoch', generation: '1',
  versions: { schema: 1, extraction: 'markdown-1', resolver: 'resolver-1', query: 'query-1' },
};
const source = { localStoreId: 'store', watermark: '10' };
const ids = { 'Current.md': 'current', 'Other.md': 'other', 'Source.md': 'source' };

class IdentityAdapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  durableWrites?: DurableWrites;
  identities = new Map<string, string>(Object.entries(ids));
  private held?: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> };
  holdCurrentWrite() {
    const held = { entered: deferred<void>(), release: deferred<void>() }; this.held = held;
    return { entered: held.entered.promise, release: () => held.release.resolve() };
  }
  releaseWrites() { this.held?.release.resolve(); }
  private identified(entry: VaultEntry): VaultEntry {
    const entryId = this.identities.get(entry.path);
    return entryId ? { ...entry, entryId, revision: `revision-${entryId}` } : entry;
  }
  override async list() { return (await super.list()).map(entry => this.identified(entry)); }
  override async stat(path: string) { const row = await super.stat(path); return row ? this.identified(row) : null; }
  override async write(path: string, text: string) {
    const held = path === 'Current.md' ? this.held : undefined;
    if (held) { held.entered.resolve(); await held.release.promise; if (this.held === held) this.held = undefined; }
    await super.write(path, text);
  }
}
function relationships(targetId: string): DocumentPage<DocumentRelationshipPage> {
  const entry = (id: string, path: string): DocumentEntry => ({ id, path, revision: `revision-${id}`, kind: 'file', deleted: false });
  return { result: { snapshot, source, coverageComplete: true, value: {
    snapshot, next: null, scanComplete: true, coverageComplete: true, complete: true,
    edges: targetId === 'current' ? [{
      source: entry('source', 'Source.md'), target: entry('current', 'Current.md'), linkIndex: 0,
      link: { kind: 'wiki', embed: false, target: 'Current', fragment: '', destination: 'Current',
        range: { bytes: [0, 11], utf16: [0, 11] }, targetRange: { bytes: [2, 9], utf16: [2, 9] }, definitionRange: null },
    }] : [],
  } }, cursor: null };
}
function serviceFixture(read: DocumentPin['backlinks'] = async input => relationships(input.targetId)) {
  const pins: { closed: number }[] = [];
  const unused = async (): Promise<never> => { throw new Error('Unexpected semantic operation'); };
  const service: DocumentService = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => {
      const state = { closed: 0 }; pins.push(state);
      return { pinId: String(pins.length) as DocumentPinId, snapshot, source, coverageComplete: true,
        close: async () => { state.closed++; }, backlinks: read, metadata: unused, search: unused, base: unused };
    },
  };
  return { service, pins };
}
async function setup(t: TestContext, twoPanes = false, preloadSource = false) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const adapter = new IdentityAdapter({ 'Current.md': 'Current body', 'Other.md': 'Other body', 'Source.md': '[[Current]]' });
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  const workspace = new Workspace(root, (parent, options): EditorHandle => {
    const input = document.createElement('textarea'); input.value = options.value; parent.append(input);
    return { getValue: () => input.value, setValue: value => { input.value = value; }, focus: () => input.focus(),
      destroy: () => input.remove(), insert: text => { input.value += text; options.onChange(input.value); } };
  });
  t.after(async () => {
    adapter.releaseWrites();
    // Only navigation reads use this capability; all constructed editor buffers
    // in this fixture deliberately exercise the real legacy adapter write gate.
    adapter.durableWrites = undefined;
    try { await workspace.destroy(); }
    finally { dom.window.close(); for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    } }
  });
  await workspace.start({ adapter, id: 'test:workspace-document-backlinks', label: 'Backlinks test' });
  await workspace.openNote('Current.md');
  const pane = workspace.activePane;
  if (preloadSource) { await workspace.openNote('Source.md', true); await workspace.openNote('Current.md'); }
  let other = pane;
  if (twoPanes) {
    await (workspace as any).split('right'); other = workspace.activePane;
    await workspace.openNote('Other.md'); (workspace as any).activate(pane);
  }
  root.classList.remove('right-hidden');
  const unused = async (): Promise<never> => { throw new Error('Unexpected durable operation'); };
  adapter.durableWrites = {
    checkpoints: { scope: { vaultId: 'store', clientId: 'client' }, load: unused, compareAndSwap: unused, list: unused, changes: unused },
    readText: unused,
    readTextById: async id => {
      const path = [...adapter.identities].find(([, entryId]) => entryId === id)?.[0];
      if (!path) return null;
      return { entryId: id, revision: `revision-${id}`, path, content: await adapter.read(path), stat: { ctime: 1, mtime: 1, size: 11 } };
    },
    planWrite: unused, prepare: unused, commit: unused, query: unused, listUnacknowledged: unused, acknowledge: unused,
  };
  let navigation: Promise<void> | undefined;
  const realOpen = workspace.openNote.bind(workspace);
  workspace.openNote = (...args: Parameters<typeof realOpen>) => { navigation = realOpen(...args); return navigation; };
  return { workspace, adapter, root, pane, other, get navigation() { return navigation; },
    async mount(fixture: ReturnType<typeof serviceFixture>) {
      adapter.documentSemantics = fixture.service; (workspace as any).renderRight();
      return (workspace as any).documentBacklinks as { ready: Promise<void> };
    } };
}

for (const change of ['pane', 'replaced-id'] as const) test(`backlink navigation rechecks ${change} after the real note save flush`, async t => {
  const ui = await setup(t, change === 'pane'), fixture = serviceFixture();
  const view = await ui.mount(fixture); await view.ready;
  const link = ui.root.querySelector<HTMLButtonElement>('.right-content button[data-entry-id="source"]');
  assert.ok(link, 'the actual workspace backlinks hook rendered the saved source ID');
  const gate = ui.adapter.holdCurrentWrite();
  ui.pane.editor!.insert(' saved before navigation'); link.click();
  await gate.entered;
  assert.ok(ui.navigation, 'row click reached the real Workspace.openNote flush gate');
  if (change === 'pane') (ui.workspace as any).activate(ui.other);
  else {
    // An independently observed replacement occupies the same path while this
    // pane's save is pending. Publish its real adapter identity to the inventory.
    await ui.adapter.trash('Source.md'); await ui.adapter.write('Source.md', 'Replacement content');
    ui.adapter.identities.set('Source.md', 'replacement');
    ui.workspace.vault.entries.set('Source.md', (await ui.adapter.stat('Source.md'))!);
  }
  gate.release(); await ui.navigation;
  assert.equal(ui.workspace.activePane, change === 'pane' ? ui.other : ui.pane);
  assert.equal(ui.pane.tabs.find(tab => tab.id === ui.pane.active)?.path, 'Current.md');
  assert.ok(ui.workspace.panes.every(pane => pane.tabs.every(tab => tab.path !== 'Source.md')));
  assert.equal(await ui.adapter.read('Current.md'), 'Current body saved before navigation');
  if (change === 'replaced-id') assert.equal(await ui.adapter.read('Source.md'), 'Replacement content');
});

test('a current stable backlink still navigates after saving rerenders the sidebar', async t => {
  const ui = await setup(t, false, true), fixture = serviceFixture();
  const view = await ui.mount(fixture); await view.ready;
  const link = ui.root.querySelector<HTMLButtonElement>('.right-content button[data-entry-id="source"]');
  assert.ok(link);
  const gate = ui.adapter.holdCurrentWrite();
  ui.pane.editor!.insert(' saved before navigation'); link.click(); await gate.entered;
  assert.ok(ui.navigation); gate.release(); await ui.navigation;
  assert.equal(ui.workspace.activePane, ui.pane);
  assert.equal(ui.pane.tabs.find(tab => tab.id === ui.pane.active)?.path, 'Source.md');
  assert.equal(await ui.adapter.read('Current.md'), 'Current body saved before navigation');
});

test('opening a blank tab retires the previous workspace backlinks pin before its late response', async t => {
  const started = deferred<void>(), response = deferred<DocumentPage<DocumentRelationshipPage>>();
  const ui = await setup(t), fixture = serviceFixture(async () => { started.resolve(); return response.promise; });
  const old = await ui.mount(fixture); await started.promise;
  assert.equal(fixture.pins.length, 1);
  await (ui.workspace as any).newTab(ui.pane);
  await until(() => fixture.pins[0].closed === 1, 'old query pin closes on blank-tab activation');
  response.resolve(relationships('current')); await old.ready;
  await (ui.workspace as any).documentBacklinks?.ready;
  assert.equal(ui.pane.tabs.find(tab => tab.id === ui.pane.active)?.path, null);
  assert.match(ui.root.querySelector('.right-content')?.textContent ?? '', /Open a saved note/);
  assert.equal(ui.root.querySelector('.right-content [data-entry-id="source"]'), null);
  assert.equal(fixture.pins[0].closed, 1);
  assert.equal(fixture.pins.length, 1, 'blank tab does not acquire a semantic pin');
});
