import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFileTreeDrag, executeFileTreeMove, FILE_TREE_DRAG_MIME, FileTreeMoveError, fileTreeSelectionRoots, planFileTreeMove } from '../src/ui/file-tree-drag.ts';
import type { FileTreeDragRow, FileTreeEntry, FileTreeMoveContext, FileTreeMoveIntent } from '../src/ui/file-tree-drag.ts';
const file = (path: string): FileTreeEntry => ({ path, type: 'file' });
const folder = (path: string): FileTreeEntry => ({ path, type: 'folder' });

test('selection reduces descendants once, preserving similarly prefixed siblings and order', () => {
  const entries = [folder('A'), file('A/n.md'), folder('AB'), file('AB/n.md'), file('a.md')];
  assert.deepEqual(fileTreeSelectionRoots(['A/n.md', 'AB/n.md', 'A', 'A', 'a.md'], entries), ['AB/n.md', 'A', 'a.md']);
});
test('plans root and folder moves, skips existing parent and preserves all extensions', () => {
  const entries = [folder('A'), file('A/a.md'), file('b.custom'), file('A/archive.tar.gz')];
  assert.deepEqual(planFileTreeMove({ paths: ['A/a.md', 'b.custom'], folder: 'A' }, entries), [{ source: 'b.custom', destination: 'A/b.custom' }]);
  assert.deepEqual(planFileTreeMove({ paths: ['A/archive.tar.gz'], folder: '' }, entries), [{ source: 'A/archive.tar.gz', destination: 'archive.tar.gz' }]);
});
test('case-insensitive and NFC collisions allocate numeric suffix before last extension', () => {
  const entries = [folder('A'), folder('B'), file('A/n.md'), file('B/n.md'), file('N.md'), folder('n 1.md'), file('A/cafe\u0301.md'), file('café.md')];
  assert.deepEqual(planFileTreeMove({ paths: ['A/n.md', 'B/n.md', 'A/cafe\u0301.md'], folder: '' }, entries).map(move => move.destination), ['n 2.md', 'n 3.md', 'cafe\u0301 1.md']);
});
test('folders with dots retain their entire name when resolving collisions', () => {
  assert.deepEqual(planFileTreeMove({ paths: ['A/set.1'], folder: '' }, [folder('A'), folder('A/set.1'), file('set.1')]), [{ source: 'A/set.1', destination: 'set.1 1' }]);
});
test('invalid root, stale sources, nonfolder targets, cycles and case aliases reject whole selection', () => {
  const entries = [folder('A'), folder('A/child'), file('n.md')];
  for (const intent of [
    { paths: [''], folder: '' }, { paths: ['missing'], folder: '' }, { paths: ['n.md'], folder: 'missing' },
    { paths: ['A'], folder: 'n.md' }, { paths: ['A'], folder: 'A' }, { paths: ['n.md', 'A'], folder: 'A/child' },
    { paths: ['../A'], folder: '' }, { paths: ['/A'], folder: '' }, { paths: ['A'], folder: '../x' },
  ]) assert.throws(() => planFileTreeMove(intent, entries));
  assert.throws(() => planFileTreeMove({ paths: ['A'], folder: 'a/child' }, [...entries, folder('a/child')]));
});
test('selected folder moves only once and does not expand into file rewrites', () => {
  assert.deepEqual(planFileTreeMove({ paths: ['A/n.md', 'A'], folder: 'B' }, [folder('A'), file('A/n.md'), folder('B')]), [{ source: 'A', destination: 'B/A' }]);
});
test('sequential executor rechecks late collisions and retains committed prefix on failure', async () => {
  let entries = [file('a.md'), file('b.md'), file('c.md'), folder('D')];
  const calls: string[] = [];
  await assert.rejects(executeFileTreeMove({ paths: ['a.md', 'b.md', 'c.md'], folder: 'D' }, {
    getEntries: () => entries, isCurrent: () => true, isSourceCurrent: () => true,
    async rename(source, destination) {
      calls.push(destination);
      if (source === 'b.md') throw new Error('disk full');
      entries = entries.filter(entry => entry.path !== source).concat(file(destination), file('D/b.md'));
    },
  }), error => {
    assert.ok(error instanceof FileTreeMoveError);
    assert.deepEqual(error.completed, [{ source: 'a.md', destination: 'D/a.md' }]);
    assert.equal((error.cause as Error).message, 'disk full'); return true;
  });
  assert.deepEqual(calls, ['D/a.md', 'D/b 1.md']);
});
test('executor stops on stale vault before first or subsequent rename', async () => {
  let valid = false, calls = 0;
  const host = { getEntries: () => [file('a'), file('b'), folder('D')], isCurrent: () => valid, isSourceCurrent: () => true, async rename() { calls++; valid = false; } };
  await assert.rejects(executeFileTreeMove({ paths: ['a', 'b'], folder: 'D' }, host));
  assert.equal(calls, 0); valid = true;
  await assert.rejects(executeFileTreeMove({ paths: ['a', 'b'], folder: 'D' }, host), error => error instanceof FileTreeMoveError && error.completed.length === 1);
  assert.equal(calls, 1);
});

function setup(move?: (intent: FileTreeMoveIntent, context: FileTreeMoveContext) => void | Promise<void>) {
  const dom = new JSDOM('<!doctype html><body><main class="file-tree"></main><aside></aside></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, root = doc.querySelector('main')!;
  let entries = [file('a.md'), file('b.md'), folder('D'), file('D/c.md'), folder('E')];
  const rows: FileTreeDragRow[] = entries.map(entry => {
    const element = doc.createElement('div'); element.className = 'tree-row'; element.textContent = entry.path; element.draggable = true; root.append(element);
    return { path: entry.path, element, collapsed: entry.type === 'folder' };
  });
  let selected: string[] = [], vault = {}, versions = new Map(entries.map(entry => [entry.path, {}]));
  const calls: FileTreeMoveIntent[] = [], errors: unknown[] = [], expanded: string[] = [];
  const controller = createFileTreeDrag({ root, getEntries: () => entries, getRows: () => rows, getSelectedPaths: () => selected, getVaultToken: () => vault, getEntryToken: path => versions.get(path), expandFolder: path => { expanded.push(path); }, move: move ?? (intent => { calls.push(intent); }), onError: error => { errors.push(error); } });
  const values = new Map<string, string>();
  const transfer = { effectAllowed: '', dropEffect: '', setData(type: string, value: string) { values.set(type, value); }, getData(type: string) { return values.get(type) ?? ''; }, setDragImage() {} };
  const row = (path: string) => rows.find(row => row.path === path)!.element;
  const dispatch = (target: EventTarget, type: string, properties: Record<string, unknown> = {}) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ dataTransfer: transfer, clientX: 10, clientY: 10, ...properties }).map(([key, value]) => [key, { value }])));
    target.dispatchEvent(event); return event;
  };
  return { dom, doc, root, rows, row, controller, dispatch, transfer, values, calls, errors, expanded, select(paths: string[]) { selected = paths; }, switchVault() { vault = {}; }, replace(path: string) { versions.set(path, {}); }, remove(path: string) { entries = entries.filter(entry => entry.path !== path); } };
}

test('drag selected row carries whole selection; unselected row carries only itself', () => {
  const f = setup(); f.select(['a.md', 'b.md']);
  f.dispatch(f.row('a.md'), 'dragstart');
  assert.deepEqual(JSON.parse(f.values.get(FILE_TREE_DRAG_MIME)!).paths, ['a.md', 'b.md']);
  assert.equal(f.root.querySelectorAll('.is-file-drag-source').length, 2);
  f.controller.cancel(); f.dispatch(f.row('D/c.md'), 'dragstart');
  assert.deepEqual(JSON.parse(f.values.get(FILE_TREE_DRAG_MIME)!).paths, ['D/c.md']);
  f.controller.destroy(); f.dom.window.close();
});
test('file row targets its parent, background targets root, modifiers remain move-only', () => {
  const f = setup(); f.dispatch(f.row('a.md'), 'dragstart');
  assert.equal(f.dispatch(f.row('D/c.md'), 'dragover', { altKey: true, metaKey: true }).defaultPrevented, true);
  assert.equal(f.transfer.dropEffect, 'move');
  assert.ok(f.row('D').classList.contains('is-file-drop-target'));
  f.dispatch(f.row('D/c.md'), 'drop'); assert.deepEqual(f.calls, [{ paths: ['a.md'], folder: 'D' }]);
  f.controller.destroy(); f.dom.window.close();
  const g = setup(); g.dispatch(g.row('D/c.md'), 'dragstart'); g.dispatch(g.root, 'drop');
  assert.deepEqual(g.calls, [{ paths: ['D/c.md'], folder: '' }]); g.controller.destroy(); g.dom.window.close();
});
test('same-parent drop is a no-op and self/descendant drop is rejected', () => {
  const f = setup(); f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.root, 'drop'); assert.equal(f.calls.length, 0);
  f.dispatch(f.row('D'), 'dragstart');
  assert.equal(f.dispatch(f.row('D/c.md'), 'dragover').defaultPrevented, false);
  assert.equal(f.transfer.dropEffect, 'none'); f.dispatch(f.row('D/c.md'), 'drop'); assert.equal(f.calls.length, 0);
  f.controller.destroy(); f.dom.window.close();
});
test('hover expands only the current collapsed folder after 750ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(); f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.row('D'), 'dragover');
  t.mock.timers.tick(749); assert.deepEqual(f.expanded, []);
  f.dispatch(f.row('E'), 'dragover'); t.mock.timers.tick(1); assert.deepEqual(f.expanded, []);
  t.mock.timers.tick(749); assert.deepEqual(f.expanded, ['E']);
  f.controller.destroy(); f.dom.window.close();
});
test('leaving root cancels hover expansion and nested leave retains valid target', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(); f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.row('D'), 'dragover');
  f.dispatch(f.row('D'), 'dragleave', { relatedTarget: f.row('D/c.md') });
  t.mock.timers.tick(750); assert.deepEqual(f.expanded, ['D']);
  f.dispatch(f.row('E'), 'dragover'); f.dispatch(f.root, 'dragleave', { relatedTarget: f.doc.querySelector('aside') });
  t.mock.timers.tick(750); assert.deepEqual(f.expanded, ['D']);
  f.controller.destroy(); f.dom.window.close();
});
test('stale vault, replacement, missing source, Escape and destroy invalidate drag', () => {
  for (const invalidate of [(f: ReturnType<typeof setup>) => f.switchVault(), (f: ReturnType<typeof setup>) => f.replace('a.md'), (f: ReturnType<typeof setup>) => f.remove('a.md'), (f: ReturnType<typeof setup>) => f.dispatch(f.doc, 'keydown', { key: 'Escape' }), (f: ReturnType<typeof setup>) => f.controller.destroy()]) {
    const f = setup(); f.dispatch(f.row('a.md'), 'dragstart'); invalidate(f); f.dispatch(f.row('D'), 'drop');
    assert.equal(f.calls.length, 0); assert.equal(f.doc.querySelector('.file-tree-drag-ghost'), null);
    f.controller.destroy(); f.dom.window.close();
  }
});
test('async operation stays current through native dragend, is blocked against duplicates and invalidates on destroy', async () => {
  let context: FileTreeMoveContext | undefined, finish!: () => void, calls = 0;
  const f = setup((_intent, value) => { calls++; context = value; return new Promise<void>(resolve => { finish = resolve; }); });
  f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.row('D'), 'drop'); f.dispatch(f.doc, 'dragend'); assert.equal(context?.isCurrent(), true);
  f.dispatch(f.row('b.md'), 'dragstart'); f.dispatch(f.row('E'), 'drop'); assert.equal(calls, 1);
  f.controller.destroy(); assert.equal(context?.isCurrent(), false); finish(); await Promise.resolve(); f.dom.window.close();
});
test('rejected host callback surfaces failure and cleanup without mutating entries', async () => {
  const failure = new Error('read-only'); const f = setup(async () => { throw failure; });
  f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.row('D'), 'drop'); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.errors, [failure]); assert.equal(f.root.querySelectorAll('.is-file-drag-source').length, 0);
  assert.ok(f.row('a.md').isConnected); f.controller.destroy(); f.dom.window.close();
});
test('foreign drag payload never authorizes mutations; editing a name cannot begin a drag', () => {
  const f = setup(); f.transfer.setData(FILE_TREE_DRAG_MIME, JSON.stringify({ version: 1, paths: ['a.md'] }));
  assert.equal(f.dispatch(f.row('D'), 'drop').defaultPrevented, false); assert.equal(f.calls.length, 0);
  const input = f.doc.createElement('input'); f.row('a.md').append(input);
  assert.equal(f.dispatch(input, 'dragstart').defaultPrevented, true); f.dispatch(f.row('D'), 'drop'); assert.equal(f.calls.length, 0);
  f.controller.destroy(); f.dom.window.close();
});

 test('drop context rejects same-path replacement while host awaits dirty-buffer flush', async () => {
  let context!: FileTreeMoveContext, resume!: () => void, renamed = false;
  const f = setup(async (_intent, value) => { context = value; await new Promise<void>(resolve => { resume = resolve; }); renamed = context.isSourceCurrent('a.md'); });
  f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.row('D'), 'drop');
  assert.equal(context.isSourceCurrent('a.md'), true); f.replace('a.md');
  assert.equal(context.isCurrent(), true); assert.equal(context.isSourceCurrent('a.md'), false);
  resume(); await Promise.resolve(); assert.equal(renamed, false); f.controller.destroy(); f.dom.window.close();
 });
 test('executor checks identity of each remaining source after earlier asynchronous rename', async () => {
  let entries = [file('a'), file('b'), folder('D')], valid = true;
  await assert.rejects(executeFileTreeMove({ paths: ['a', 'b'], folder: 'D' }, {
    getEntries: () => entries, isCurrent: () => true, isSourceCurrent: path => path === 'a' || valid,
    async rename(source, destination) { entries = entries.filter(entry => entry.path !== source).concat(file(destination)); valid = false; },
  }), error => error instanceof FileTreeMoveError && error.completed.length === 1 && (error.cause as Error).message === 'Source changed: b');
 });

 test('destination deletion or replacement during pending host flush invalidates operation', async () => {
  for (const replace of [false, true]) {
    let context!: FileTreeMoveContext, finish!: () => void;
    const f = setup((_intent, value) => { context = value; return new Promise<void>(resolve => { finish = resolve; }); });
    f.dispatch(f.row('a.md'), 'dragstart'); f.dispatch(f.row('D'), 'drop'); assert.equal(context.isCurrent(), true);
    if (replace) f.replace('D'); else f.remove('D');
    assert.equal(context.isCurrent(), false); assert.equal(context.isSourceCurrent('a.md'), false);
    finish(); await Promise.resolve(); f.controller.destroy(); f.dom.window.close();
  }
 });
