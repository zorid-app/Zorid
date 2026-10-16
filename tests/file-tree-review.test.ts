import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { fileTreeSelectionRoots, planFileTreeMove } from '../src/ui/file-tree-drag.ts';

// Adversarial original fixtures; these do not establish native drag or reference parity.
for (const [first, second] of [['A', 'a'], ['Café', 'Cafe\u0301']]) {
  test(`selection pruning retains distinct indexed hierarchy ${JSON.stringify([first, second])}`, () => {
    const entries = [
      { path: first, type: 'folder' as const }, { path: second, type: 'folder' as const },
      { path: `${second}/keep.bin`, type: 'file' as const }, { path: 'Destination', type: 'folder' as const },
    ];
    const paths = [first, `${second}/keep.bin`];
    assert.deepEqual(fileTreeSelectionRoots(paths, entries), paths);
    assert.deepEqual(planFileTreeMove({ paths, folder: 'Destination' }, entries).map(move => move.source), paths);
  });
}

test('folder relocation rebases bookmarks, navigation history and collapsed descendants by exact boundary', async t => {
  const dom = new JSDOM('<body><div id="app"></div></body>', { url: 'https://zorid.test/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof dom.window.matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const workspace = new Workspace(dom.window.document.querySelector('#app')!);
  t.after(async () => {
    try { await workspace.destroy(); }
    finally {
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  await workspace.start({ adapter: new MemoryAdapter({ 'Folder/Nested/One.md': 'keep', 'Folderish/Two.md': 'other' }), label: 'Review fixture', id: 'review:file-tree' });
  const state = workspace as unknown as {
    bookmarks: Set<string>; collapsed: Set<string>;
    panes: Array<{ history: string[]; historyIndex: number }>;
  };
  state.bookmarks = new Set(['Folder/Nested/One.md', 'Folderish/Two.md']);
  state.collapsed = new Set(['Folder', 'Folder/Nested', 'Folderish']);
  state.panes[0].history = ['Folder/Nested/One.md', 'Folderish/Two.md', 'Folder/Nested/One.md'];
  state.panes[0].historyIndex = 1;
  await workspace.vault.rename('Folder', 'Moved');
  assert.deepEqual([...state.bookmarks], ['Moved/Nested/One.md', 'Folderish/Two.md']);
  assert.deepEqual([...state.collapsed], ['Moved', 'Moved/Nested', 'Folderish']);
  assert.deepEqual(state.panes[0].history, ['Moved/Nested/One.md', 'Folderish/Two.md', 'Moved/Nested/One.md']);
  assert.equal(state.panes[0].historyIndex, 1);
});
