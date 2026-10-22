import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableFileWitness } from '../src/bases/table-view.ts';
import type { BaseQueryRow, BaseQueryResult } from '../src/bases/query.ts';

function fixture(property: 'file.name' | 'file.file', row: BaseQueryRow, callbacks: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true });
  const main = dom.window.document.querySelector('main')!;
  const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Files' }, rows: [row], groups: [{ key: null, rows: [row] }], properties: [property], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  const opened: unknown[][] = [], menus: unknown[][] = [];
  const view = createBaseTableView(main, { result, openFile(...args) { opened.push(args); }, contextMenu(...args) { menus.push(args); }, ...callbacks });
  const cell = () => main.querySelector<HTMLElement>('[role=gridcell][data-path]')!;
  const link = () => cell().querySelector('a')!;
  const key = (name: string, init: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }); cell().dispatchEvent(event); return event; };
  return { dom, main, result, view, opened, menus, cell, link, key, close() { view.destroy(); dom.window.close(); } };
}
const savedRow = (): BaseQueryRow => ({ path: 'Notes/literal#draft.md', entryId: 'saved-entry', revision: 'saved-revision', values: { 'file.name': { type: 'string', value: 'literal#draft' }, 'file.file': { type: 'namespace', name: 'Notes/literal#draft.md', get() { throw new Error('No path resolution belongs in the table'); } } } });

for (const property of ['file.name', 'file.file'] as const) test(`${property} click, middle click, modified keyboard and context retain the saved row witness`, () => {
  const row = savedRow(), f = fixture(property, row);
  const click = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, shiftKey: true }); f.link().dispatchEvent(click);
  const middle = new f.dom.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, ctrlKey: true, altKey: true }); f.link().dispatchEvent(middle);
  const enter = f.key('Enter', { metaKey: true, shiftKey: true }), f2 = f.key('F2', { ctrlKey: true });
  for (const [index, event] of [click, middle, enter, f2].entries()) {
    assert.equal(event.defaultPrevented, true); assert.equal(f.opened[index][0], row.path); assert.equal(f.opened[index][1], event);
    assert.deepEqual(f.opened[index][2], { entryId: 'saved-entry', revision: 'saved-revision' }); assert.equal(Object.hasOwn(f.opened[index][2] as object, 'subpath'), false); assert.equal(Object.isFrozen(f.opened[index][2]), true);
  }
  const context = new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); f.cell().dispatchEvent(context);
  assert.equal(context.defaultPrevented, true); assert.equal(f.menus[0][0], row); assert.equal(f.menus[0][1], context); assert.deepEqual(f.menus[0][2], f.opened[0][2]); f.close();
});

test('legacy rows keep the existing two-argument open and context API', () => {
  const { entryId: _entryId, revision: _revision, ...row } = savedRow(), f = fixture('file.name', row);
  f.link().click(); f.key('Enter'); f.cell().dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(f.opened.length, 2); assert.ok(f.opened.every(args => args.length === 2)); assert.equal(f.menus[0].length, 2); f.close();
});

test('a path reused during an awaited open never substitutes the new entry witness', async () => {
  let release!: () => void, captured: BaseTableFileWitness | undefined, checked: Promise<void> | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const row = savedRow();
  const f = fixture('file.name', row, { openFile(_path, _event, witness) { captured = witness; checked = waiting.then(() => { assert.deepEqual(witness, { entryId: 'saved-entry', revision: 'saved-revision' }); }); } });
  const retainedLink = f.link(); retainedLink.click();
  // An upstream caller cannot retarget the mount by mutating its original row object.
  (row as { entryId: string }).entryId = 'replacement-entry'; (row as { revision: string }).revision = 'replacement-revision';
  const replacement = { ...savedRow(), entryId: 'replacement-entry', revision: 'replacement-revision' };
  f.view.update({ ...f.result, version: 2, rows: [replacement], groups: [{ key: null, rows: [replacement] }] });
  release(); await checked; assert.deepEqual(captured, { entryId: 'saved-entry', revision: 'saved-revision' });
  // Retained links from the replaced result remain inert rather than reopening by path.
  captured = undefined; retainedLink.click(); assert.equal(captured, undefined); f.close();
});
