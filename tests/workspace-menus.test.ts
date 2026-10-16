import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExplorerMenu, buildPaneMenu, buildTabMenu, buildTabGroupMenu } from '../src/ui/workspace-menus.ts';
import type { WorkspaceMenu, PaneMenuContext, TabMenuContext } from '../src/ui/workspace-menus.ts';
import type { ContextMenuItem } from '../src/platform/context-menu.ts';
const noop = () => {};
const valid = () => true;
const labels = (items: ContextMenuItem[]): unknown[] => items.map(item => 'type' in item ? '---' : 'submenu' in item ? [item.label, labels(item.submenu)] : item.label);
const find = (menu: WorkspaceMenu, id: string) => menu.items.find(item => 'id' in item && item.id === `workspace.${id}`);
const pane = (extra: Partial<PaneMenuContext> = {}): PaneMenuContext => ({ location: 'main', isValid: valid, actions: {}, ...extra });
const tab = (extra: Partial<TabMenuContext> = {}): TabMenuContext => ({ ...pane(), targetId: 'b', visible: true, tabs: [{ id: 'a', pinned: true }, { id: 'b', pinned: false }, { id: 'c', pinned: false }], tabActions: {}, ...extra });

test('Explorer file inventory orders sections and Copy path children, with platform labels', () => {
  const actions = Object.fromEntries(['openNewTab', 'openRight', 'openNewWindow', 'duplicate', 'move', 'bookmark', 'copyVaultPath', 'copyFullPath', 'openDefaultApp', 'revealInSystem', 'rename', 'delete'].map(key => [key, noop]));
  const menu = buildExplorerMenu({ kind: 'file', platform: 'mac', isValid: valid, actions });
  assert.deepEqual(labels(menu.items), ['Open in new tab', 'Open to the right', 'Open in new window', '---', 'Duplicate', 'Move file to...', 'Bookmark...', '---', ['Copy path', ['from vault folder', 'from system root']], '---', 'Open in default app', 'Reveal in Finder', '---', 'Rename...', 'Delete']);
  const other = buildExplorerMenu({ kind: 'file', isValid: valid, actions });
  assert.ok(labels(other.items).includes('Make a copy'));
  assert.ok(labels(other.items).includes('Show in system explorer'));
});

test('root folder suppresses file-only and destructive capabilities without empty groups', () => {
  const actions = Object.fromEntries(['openNewTab', 'openRight', 'openNewWindow', 'duplicate', 'move', 'bookmark', 'copyVaultPath', 'copyFullPath', 'openDefaultApp', 'revealInSystem', 'rename', 'delete', 'newNote', 'newFolder', 'searchInFolder'].map(key => [key, noop]));
  assert.deepEqual(labels(buildExplorerMenu({ kind: 'folder', isRoot: true, isValid: valid, actions }).items), ['New note', 'New folder']);
  const menu = buildExplorerMenu({ kind: 'folder', isValid: valid, actions });
  assert.deepEqual(labels(menu.items), ['New note', 'New folder', '---', 'Make a copy', 'Move folder to...', 'Search in folder', 'Bookmark...', '---', ['Copy path', ['from vault folder', 'from system root']], '---', 'Show in system explorer', '---', 'Rename...', 'Delete']);
});

test('unsupported bookmark editing is omitted rather than mapped to removal', async () => {
  let adds = 0, edits = 0;
  const base = { kind: 'file' as const, bookmarked: true, isValid: valid };
  assert.deepEqual(buildExplorerMenu({ ...base, actions: { bookmark: () => { adds++; } } }).items, []);
  const menu = buildExplorerMenu({ ...base, actions: { bookmark: () => { adds++; }, editBookmark: () => { edits++; } } });
  assert.deepEqual(labels(menu.items), ['Edit bookmark']);
  assert.equal(await menu.run('workspace.bookmark'), true);
  assert.equal(adds, 0); assert.equal(edits, 1);
});

test('tab close targets preserve clicked ownership and exclude pinned siblings from bulk actions', async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const tabs = [{ id: 'a', pinned: true }, { id: 'b', pinned: false }, { id: 'c', pinned: false }, { id: 'd', pinned: true }];
  const context = tab({ tabs, tabActions: { closeTabs: ids => { mutableCalls.push([...ids]); }, togglePin: noop } });
  const closeAfter = buildTabMenu(context);
  assert.deepEqual(labels(closeAfter.items), ['Close', 'Close others', 'Close tabs after', 'Close all', '---', 'Pin']);
  tabs.push({ id: 'later', pinned: false });
  await closeAfter.run('workspace.close-after');
  assert.deepEqual(calls, [['c']]);
  const pinned = buildTabMenu({ ...context, targetId: 'a' });
  await pinned.run('workspace.close');
  assert.deepEqual(calls[1], ['a']);
  await buildTabMenu(context).run('workspace.close-others');
  assert.deepEqual(calls[2], ['c', 'later']);
});

test('single unpinned target omits redundant bulk close; pinned target can close all other unpinned tabs', () => {
  const one = buildTabMenu(tab({ tabs: [{ id: 'b', pinned: false }], tabActions: { closeTabs: noop } }));
  assert.deepEqual(labels(one.items), ['Close']);
  const pinned = buildTabMenu(tab({ targetId: 'a', tabs: [{ id: 'a', pinned: true }, { id: 'b', pinned: false }], tabActions: { closeTabs: noop } }));
  assert.deepEqual(labels(pinned.items), ['Close', 'Close others', 'Close tabs after', 'Close all']);
  assert.deepEqual(buildTabMenu(tab({ targetId: 'missing', tabActions: { closeTabs: noop } })).items, []);
});

test('hidden tab exposes tab actions only; pane menu does not inherit tab actions', () => {
  const context = tab({ visible: false, markdown: { mode: 'live' }, actions: { splitRight: noop, splitDown: noop, toggleReading: noop }, tabActions: { closeTabs: noop, togglePin: noop, moveToNewWindow: noop } });
  assert.deepEqual(labels(buildTabMenu(context).items), ['Close', 'Close others', 'Close tabs after', 'Close all', '---', 'Pin', '---', 'Move to new window']);
  assert.deepEqual(labels(buildPaneMenu(context).items), ['Reading view', '---', 'Split right', 'Split down']);
});

test('sidebar tab omits bulk closes and disables supported Split right, with callable Split down', async () => {
  let right = 0, down = 0;
  const context = tab({ location: 'sidebar', actions: { splitRight: () => { right++; }, splitDown: () => { down++; } }, tabActions: { closeTabs: noop } });
  const menu = buildTabMenu(context);
  assert.deepEqual(labels(menu.items), ['Close', '---', 'Split right', 'Split down']);
  assert.equal((find(menu, 'split-right') as { enabled: boolean }).enabled, false);
  assert.equal(await menu.run('workspace.split-right'), false);
  assert.equal(await buildTabMenu(context).run('workspace.split-down'), true);
  assert.equal(right, 0); assert.equal(down, 1);
});

test('Markdown pane section order, checked Reading, disabled Replace and properties', async () => {
  let replacements = 0;
  const menu = buildPaneMenu(pane({
    markdown: { mode: 'reading', canAddProperty: false },
    file: { actions: { rename: noop, delete: noop, move: noop, copyVaultPath: noop } },
    actions: { splitRight: noop, splitDown: noop, toggleReading: noop, addProperty: noop, find: noop, replace: () => { replacements++; }, exportPdf: noop },
  }));
  assert.deepEqual(labels(menu.items), ['Reading view', '---', 'Split right', 'Split down', '---', 'Rename...', 'Move file to...', 'Add file property', 'Export to PDF...', '---', 'Find...', 'Replace...', '---', ['Copy path', ['from vault folder']], '---', 'Delete file']);
  assert.equal((find(menu, 'reading') as { checked: boolean }).checked, true);
  assert.equal((find(menu, 'add-property') as { enabled: boolean }).enabled, false);
  assert.equal(await menu.run('workspace.replace'), false); assert.equal(replacements, 0);
  assert.ok(!JSON.stringify(menu.items).includes('Source mode'));
});

test('lifetime guard, dismissal, disposal, unknown action and duplicate settlement prevent stale execution', async () => {
  let alive = true, count = 0;
  const make = () => buildExplorerMenu({ kind: 'file', isValid: () => alive, actions: { delete: () => { count++; } } });
  const stale = make(); alive = false;
  assert.equal(await stale.run('workspace.delete'), false); alive = true;
  assert.equal(await stale.run('workspace.delete'), false);
  const cancelled = make(); assert.equal(await cancelled.run(null), false); assert.equal(await cancelled.run('workspace.delete'), false);
  const disposed = make(); disposed.dispose(); assert.equal(await disposed.run('workspace.delete'), false);
  const unknown = make(); assert.equal(await unknown.run('workspace.unknown'), false); assert.equal(await unknown.run('workspace.delete'), false);
  const good = make(); assert.equal(await good.run('workspace.delete'), true); assert.equal(await good.run('workspace.delete'), false);
  assert.equal(count, 1);
});

test('action is consumed before asynchronous work and failures propagate', async () => {
  let release!: () => void, calls = 0;
  const menu = buildExplorerMenu({ kind: 'file', isValid: valid, actions: { delete: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); } } });
  const first = menu.run('workspace.delete');
  assert.equal(await menu.run('workspace.delete'), false);
  release(); assert.equal(await first, true); assert.equal(calls, 1);
  const failure = buildExplorerMenu({ kind: 'file', isValid: valid, actions: { delete: () => { throw new Error('write failed'); } } });
  await assert.rejects(failure.run('workspace.delete'), /write failed/);
  assert.equal(await failure.run('workspace.delete'), false);
});

test('main group menu snapshots targets, marks active tab and keeps pinned tabs on close all', async () => {
  const calls: unknown[] = [];
  const context = { location: 'main' as const, stacked: true, activeId: 'a', isValid: valid, tabs: [{ id: 'a', pinned: true, title: 'A' }, { id: 'b', pinned: false, title: 'B' }], actions: { toggleStacked: noop, closeTabs: (ids: readonly string[]) => { calls.push([...ids]); }, activateTab: (id: string) => { calls.push(id); } } };
  const menu = buildTabGroupMenu(context);
  assert.deepEqual(labels(menu.items), ['Unstack tabs', '---', 'Close all', '---', 'A', 'B']);
  assert.equal((find(menu, 'tab-0') as { checked: boolean }).checked, true);
  context.tabs.reverse();
  await menu.run('workspace.tab-1'); assert.equal(calls[0], 'b');
  await buildTabGroupMenu(context).run('workspace.close-all'); assert.deepEqual(calls[1], ['b']);
});

test('sidebar group only lists tabs and dynamic titles fit bounded native descriptors', () => {
  const menu = buildTabGroupMenu({ location: 'sidebar', activeId: 'a', isValid: valid, tabs: [{ id: 'a', pinned: false, title: '\n' }, { id: 'b', pinned: false, title: 'X'.repeat(300) }], actions: { toggleStacked: noop, closeTabs: noop, activateTab: noop } });
  assert.deepEqual(labels(menu.items), ['Untitled', 'X'.repeat(200)]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(menu.items)));
});
