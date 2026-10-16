import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildFileListBackgroundMenu, installFileListBackgroundMenu } from '../src/ui/file-list-background-menu.ts';
import type { FileListBackgroundContext, FileListBackgroundOptions } from '../src/ui/file-list-background-menu.ts';
import type { ContextMenuItem } from '../src/platform/context-menu.ts';

const labels = (items: ContextMenuItem[]) => items.map(item => 'type' in item ? '---' : item.label);
const noop = () => {};
function build(extra: Partial<FileListBackgroundContext> = {}) {
  return buildFileListBackgroundMenu({ hasVault: true, isValid: () => true, actions: { newNote: noop, newFolder: noop, newCanvas: noop }, ...extra });
}
test('vault background orders actual root creation capabilities without file actions or separators', () => {
  assert.deepEqual(labels(build().items), ['New note', 'New folder', 'New canvas']);
  assert.deepEqual(labels(build({ actions: { newNote: noop, newFolder: noop } }).items), ['New note', 'New folder']);
  assert.deepEqual(labels(build({ actions: { newCanvas: noop } }).items), ['New canvas']);
  assert.deepEqual(build({ hasVault: false }).items, []);
  assert.deepEqual(build({ actions: {} }).items, []);
});
test('actions capture callbacks, settle once, reject stale/dismissed IDs and propagate errors', async () => {
  let alive = true, created = 0;
  const actions = { newNote: () => { created++; } };
  const first = build({ isValid: () => alive, actions }); actions.newNote = () => { created += 100; };
  assert.equal(await first.run('file-list.new-note'), true); assert.equal(created, 1);
  assert.equal(await first.run('file-list.new-note'), false);
  const stale = build({ isValid: () => alive, actions }); alive = false;
  assert.equal(await stale.run('file-list.new-note'), false); assert.equal(created, 1);
  const cancelled = build(); await cancelled.run(null); assert.equal(await cancelled.run('file-list.new-note'), false);
  const unknown = build(); assert.equal(await unknown.run('workspace.delete'), false);
  const disposed = build(); disposed.dispose(); assert.equal(await disposed.run('file-list.new-note'), false);
  const failing = build({ actions: { newNote: async () => { throw new Error('disk full'); } } });
  await assert.rejects(failing.run('file-list.new-note'), /disk full/); assert.equal(await failing.run('file-list.new-note'), false);
});

function setup(extra: Partial<FileListBackgroundOptions> = {}) {
  const dom = new JSDOM('<!doctype html><body><aside><button id="toolbar">Toolbar</button><div id="list"><div class="file-tree"><div class="tree-row" role="treeitem"><span>File</span></div><div class="tree-row folder-row" role="treeitem"><span>Folder</span></div></div></div></aside>');
  const document = dom.window.document, container = document.getElementById('list')!;
  let available = true, alive = true, selected = true, focused = true, activeNote = 'Current.md', dismissed = 0, created = 0;
  const errors: unknown[] = [], menus: ContextMenuItem[][] = [], documents: Document[] = [], resolvers: ((id: string | null) => void)[] = [];
  const dispose = installFileListBackgroundMenu(container, {
    isAvailable: () => available,
    getTree: () => container.querySelector('.file-tree'),
    buildMenu: () => build({ isValid: () => alive, actions: { newNote: () => { created++; }, newFolder: noop, newCanvas: noop } }),
    clearSelection: () => { selected = false; focused = false; },
    onError: error => errors.push(error),
    showMenu: (event, items, options) => { menus.push(items); documents.push(options!.document!); assert.equal(event.clientX, 15); assert.equal(event.clientY, 31); return new Promise(resolve => resolvers.push(resolve)); },
    dismissMenu: async owner => { assert.equal(owner, document); dismissed++; }, ...extra,
  });
  const open = (target: EventTarget) => { const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 15, clientY: 31 }); target.dispatchEvent(event); return event; };
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return { dom, document, container, dispose, open, settle, errors, menus, documents, resolvers,
    get tree() { return container.querySelector('.file-tree')!; },
    get selected() { return selected; }, get focused() { return focused; }, get activeNote() { return activeNote; },
    get created() { return created; }, get dismissed() { return dismissed; },
    set available(value: boolean) { available = value; }, set alive(value: boolean) { alive = value; },
    close() { dispose(); dom.window.close(); },
  };
}
test('only bare list/tree backgrounds open root menu and clear selection without changing active note', async () => {
  const ui = setup();
  for (const target of [ui.document.getElementById('toolbar')!, ...ui.container.querySelectorAll('.tree-row, .tree-row span')]) {
    assert.equal(ui.open(target).defaultPrevented, false);
  }
  assert.equal(ui.menus.length, 0); assert.equal(ui.selected, true);
  assert.equal(ui.open(ui.container).defaultPrevented, true);
  assert.equal(ui.selected, false); assert.equal(ui.focused, false); assert.equal(ui.activeNote, 'Current.md');
  assert.equal(ui.documents[0], ui.document); assert.deepEqual(labels(ui.menus[0]), ['New note', 'New folder', 'New canvas']);
  ui.resolvers[0]('file-list.new-note'); await ui.settle(); assert.equal(ui.created, 1);
  assert.equal(ui.open(ui.tree).defaultPrevented, true); ui.close();
});
test('no vault/non-Files surface, missing tree, handled event and detached surface do not open menus', () => {
  const ui = setup(); ui.available = false; assert.equal(ui.open(ui.container).defaultPrevented, false); ui.available = true;
  ui.container.addEventListener('contextmenu', event => event.preventDefault(), { capture: true, once: true });
  ui.open(ui.container); assert.equal(ui.menus.length, 0);
  ui.tree.remove(); assert.equal(ui.open(ui.container).defaultPrevented, false);
  ui.container.remove(); assert.equal(ui.open(ui.container).defaultPrevented, false); ui.close();
});
test('replaced tree, stale vault, switched tab and superseding menus cannot run delayed actions', async () => {
  for (const replace of ['tree', 'vault', 'tab', 'menu'] as const) {
    const ui = setup(); ui.open(ui.container);
    if (replace === 'tree') ui.tree.replaceWith(ui.tree.cloneNode(true));
    if (replace === 'vault') ui.alive = false;
    if (replace === 'tab') ui.available = false;
    if (replace === 'menu') ui.open(ui.document.getElementById('toolbar')!);
    ui.resolvers[0]('file-list.new-note'); await ui.settle();
    assert.equal(ui.created, 0, replace); ui.close();
  }
});
test('destroy invalidates actions and dismisses only a still-owned popup', async () => {
  const ui = setup(); ui.open(ui.container); ui.dispose(); ui.resolvers[0]('file-list.new-note'); await ui.settle();
  assert.equal(ui.created, 0); assert.equal(ui.dismissed, 1); ui.close();
  const other = setup(); other.open(other.container); other.open(other.document.getElementById('toolbar')!); other.dispose();
  assert.equal(other.dismissed, 0); other.close();
});
test('popup, selection-clear and asynchronous action errors reach the host reporter', async () => {
  const sync = setup({ showMenu: () => { throw new Error('popup unavailable'); } }); sync.open(sync.container);
  assert.match(String(sync.errors[0]), /popup unavailable/); sync.dispose(); assert.equal(sync.dismissed, 0); sync.close();
  const clear = setup({ clearSelection: () => { throw new Error('selection unavailable'); } }); clear.open(clear.container);
  assert.match(String(clear.errors[0]), /selection unavailable/); assert.equal(clear.menus.length, 0); clear.close();
  const async = setup({ buildMenu: () => build({ actions: { newNote: async () => { throw new Error('save failed'); } } }) });
  async.open(async.container); async.resolvers[0]('file-list.new-note'); await async.settle(); assert.match(String(async.errors[0]), /save failed/); async.close();
});
test('browser fallback presents and executes the background action through the owning document', async () => {
  const ui = setup({ showMenu: undefined, dismissMenu: undefined }); ui.open(ui.container);
  const button = [...ui.document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(item => item.textContent === 'New note')!;
  assert.ok(button); button.click(); await ui.settle(); assert.equal(ui.created, 1);
  assert.equal(ui.document.querySelector('.context-menu'), null); ui.close();
});
