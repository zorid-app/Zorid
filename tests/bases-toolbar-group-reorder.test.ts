import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';
import { createBaseToolbar } from '../src/bases/toolbar.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { createBaseManualGroups } from '../src/bases/toolbar-groups.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';

const source = '# keep\nplugin: {retain: true}\nviews:\n - type: table\n   name: Table\n   groupBy: {property: status, direction: ASC}\n   groupOrder: [Todo, Done, Later]\n';
const result = executeBaseQuery(BaseDocument.parse(source), { version: 1, files: ['Todo', 'Done', 'Later'].map((status, index) => ({ path: `${index}.md`, properties: { status } })) });
function fixture() {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true }), doc = dom.window.document;
  let changes = 0, menuEscapes = 0; const drafts: boolean[] = [], errors: string[] = [];
  const parentEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') menuEscapes++; };
  doc.addEventListener('keydown', parentEscape, true);
  const groups = createBaseManualGroups(doc, doc.querySelector('main')!, { result, property: () => 'note.status', changed() { changes++; }, draft(value) { drafts.push(value); }, error(value) { errors.push(value); } });
  const lines = () => [...doc.querySelectorAll<HTMLElement>('.bases-manual-group-row')];
  for (const line of lines()) line.getBoundingClientRect = () => { const top = [...line.parentElement!.children].indexOf(line) * 30; return { top, bottom: top + 30, height: 30, left: 0, right: 160, width: 160, x: 0, y: top, toJSON() {} }; };
  const row = (name: string) => lines().find(line => line.querySelector('.bases-manual-group-name')!.textContent === name)!;
  const names = () => lines().map(line => line.querySelector('.bases-manual-group-name')!.textContent);
  const key = (element: Element, key: string, extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); element.dispatchEvent(event); return event; };
  const transfer = () => { const data = new Map<string, string>(); return { effectAllowed: '', dropEffect: '', setData(type: string, value: string) { data.set(type, value); }, getData(type: string) { return data.get(type) ?? ''; } }; };
  const dragEvent = (element: HTMLElement, type: string, data: ReturnType<typeof transfer>, after = true) => { const rect = element.getBoundingClientRect(), event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: rect.top + rect.height * (after ? .5 : .25) }); Object.defineProperty(event, 'dataTransfer', { value: data }); element.dispatchEvent(event); return event; };
  return { dom, doc, groups, row, lines, names, key, transfer, dragEvent, drafts, errors, get changes() { return changes; }, get menuEscapes() { return menuEscapes; }, close() { groups.destroy(); doc.removeEventListener('keydown', parentEscape, true); dom.window.close(); } };
}
test('pointer movement previews existing DOM rows without saving; Escape restores exact order and row focus', () => {
  const f = fixture(); try {
    const original = f.lines(), sourceRow = f.row('Todo'), grip = sourceRow.querySelector<HTMLElement>('.bases-manual-group-grip')!, data = f.transfer(); sourceRow.focus();
    f.dragEvent(grip, 'dragstart', data); f.dragEvent(f.row('Done'), 'dragover', data);
    assert.deepEqual(f.names(), ['Done', 'Todo', 'Later']); assert.equal(f.lines()[1], sourceRow); assert.equal(f.changes, 0); assert.throws(() => f.groups.read(), /Finish or cancel the group reorder/);
    const escape = f.key(sourceRow, 'Escape'); assert.equal(escape.defaultPrevented, true); assert.equal(f.menuEscapes, 0); assert.deepEqual(f.lines(), original); assert.equal(f.doc.activeElement, sourceRow); assert.equal(sourceRow.querySelector<HTMLInputElement>('input')!.disabled, false); assert.equal(sourceRow.querySelector<HTMLInputElement>('input')!.checked, true); assert.deepEqual(f.groups.read(), ['Todo', 'Done', 'Later']); assert.equal(f.changes, 0); assert.deepEqual(f.drafts, [true, false]);
    f.dragEvent(grip, 'dragend', data); assert.equal(f.changes, 0);
  } finally { f.close(); }
});
test('drop commits the preview once and keeps focus on the same group identity', () => {
  const f = fixture(); try {
    const sourceRow = f.row('Todo'), identity = sourceRow.dataset.groupId, grip = sourceRow.querySelector<HTMLElement>('.bases-manual-group-grip')!, data = f.transfer();
    f.dragEvent(grip, 'dragstart', data); f.dragEvent(f.row('Later'), 'dragover', data); assert.equal(f.changes, 0);
    f.dragEvent(f.row('Later'), 'drop', data); f.dragEvent(grip, 'dragend', data);
    assert.deepEqual(f.groups.read(), ['Done', 'Later', 'Todo']); assert.equal(f.changes, 1); assert.equal((f.doc.activeElement as HTMLElement).dataset.groupId, identity); assert.equal(f.drafts.at(-1), false);
  } finally { f.close(); }
});
test('grip keyboard pickup supports live moves, Escape rollback and explicit drop while Alt shortcuts remain immediate', () => {
  const f = fixture(); try {
    const row = f.row('Todo'), grip = row.querySelector<HTMLElement>('.bases-manual-group-grip')!; assert.equal(grip.getAttribute('role'), 'button'); assert.equal(grip.tabIndex, 0);
    f.key(grip, ' '); f.key(row, 'ArrowDown'); assert.deepEqual(f.names(), ['Done', 'Todo', 'Later']); assert.equal(f.changes, 0); f.key(row, 'End'); assert.deepEqual(f.names(), ['Done', 'Later', 'Todo']);
    f.key(row, 'Escape'); assert.deepEqual(f.groups.read(), ['Todo', 'Done', 'Later']); assert.equal(f.changes, 0); assert.equal(f.doc.activeElement, row);
    f.key(grip, 'Enter'); f.key(row, 'End'); f.key(row, 'Home'); f.key(row, 'ArrowDown'); f.key(row, 'Enter'); assert.deepEqual(f.groups.read(), ['Done', 'Todo', 'Later']); assert.equal(f.changes, 1);
    f.key(f.row('Todo'), 'ArrowUp', { altKey: true }); assert.deepEqual(f.groups.read(), ['Todo', 'Done', 'Later']); assert.equal(f.changes, 2);
  } finally { f.close(); }
});
test('native drag cancellation, outside drop and keyboard Tab roll back without stealing outside focus', () => {
  for (const cancel of ['dragend', 'outside', 'Tab'] as const) {
    const f = fixture(); try {
      const source = f.row('Todo'), grip = source.querySelector<HTMLElement>('.bases-manual-group-grip')!, data = f.transfer();
      if (cancel === 'Tab') { f.key(grip, ' '); f.key(source, 'End'); f.key(source, 'Tab'); }
      else { f.dragEvent(grip, 'dragstart', data); f.dragEvent(f.row('Done'), 'dragover', data); if (cancel === 'outside') { f.doc.querySelector<HTMLElement>('#outside')!.focus(); f.dragEvent(f.doc.querySelector<HTMLElement>('#outside')!, 'drop', data); } else f.dragEvent(grip, 'dragend', data); }
      assert.deepEqual(f.groups.read(), ['Todo', 'Done', 'Later']); assert.equal(f.changes, 0); if (cancel === 'outside') assert.equal(f.doc.activeElement?.id, 'outside');
    } finally { f.close(); }
  }
});
test('focus leaving a reorder rolls back and never consumes another owner keyboard command', () => {
  for (const mode of ['keyboard', 'pointer'] as const) for (const destination of ['input', 'body', 'blur'] as const) {
    if (mode === 'pointer' && destination === 'blur') continue; // Native drag DOM movement may leave BODY focused; Escape must still cancel it.
    const f = fixture(); try {
      const source = f.row('Todo'), grip = source.querySelector<HTMLElement>('.bases-manual-group-grip')!, data = f.transfer();
      if (mode === 'keyboard') { f.key(grip, ' '); f.key(source, 'ArrowDown'); }
      else { f.dragEvent(grip, 'dragstart', data); f.dragEvent(f.row('Done'), 'dragover', data); }
      assert.deepEqual(f.names(), ['Done', 'Todo', 'Later']); source.focus();
      let target: HTMLElement;
      if (destination === 'input') { target = f.doc.createElement('input'); f.doc.body.append(target); target.focus(); }
      else if (destination === 'body') { target = f.doc.body; target.tabIndex = -1; target.focus(); }
      else { source.focus(); source.blur(); target = f.doc.body; }
      for (const key of ['ArrowDown', 'Enter', 'Escape']) assert.equal(f.key(target, key).defaultPrevented, false, `${mode}/${destination}/${key}`);
      assert.deepEqual(f.names(), ['Todo', 'Done', 'Later']); assert.deepEqual(f.groups.read(), ['Todo', 'Done', 'Later']); assert.equal(f.changes, 0); assert.equal(f.doc.activeElement, target); assert.equal(f.drafts.at(-1), false);
      f.dragEvent(f.row('Done'), 'drop', data); assert.equal(f.changes, 0);
    } finally { f.close(); }
  }
});
test('result, property or lifecycle retirement prevents old drag callbacks from writing', () => {
  for (const retire of ['update', 'automatic', 'destroy'] as const) {
    const f = fixture(); try {
      const grip = f.row('Todo').querySelector<HTMLElement>('.bases-manual-group-grip')!, target = f.row('Done'), data = f.transfer(); f.dragEvent(grip, 'dragstart', data); f.dragEvent(target, 'dragover', data);
      if (retire === 'update') f.groups.update({ ...result, version: 2 }, false); else if (retire === 'automatic') f.groups.setManual(false); else f.groups.destroy();
      f.dragEvent(target, 'drop', data); f.dragEvent(grip, 'dragend', data); assert.equal(f.changes, 0); assert.equal(f.drafts.at(-1), false);
    } finally { f.close(); }
  }
});
test('foreign drag tokens cannot commit and other group actions cannot overwrite an active preview', () => {
  const f = fixture(); try {
    const grip = f.row('Todo').querySelector<HTMLElement>('.bases-manual-group-grip')!, data = f.transfer(); f.dragEvent(grip, 'dragstart', data); f.dragEvent(f.row('Done'), 'dragover', data);
    f.row('Later').querySelector<HTMLInputElement>('input')!.click(); f.doc.querySelector<HTMLButtonElement>('[aria-label="Add group"]')!.click(); f.dragEvent(f.row('Done'), 'drop', f.transfer()); assert.equal(f.changes, 0); assert.equal(f.doc.querySelector('[aria-label="Group name"]'), null);
    f.key(f.row('Todo'), 'Escape'); assert.deepEqual(f.groups.read(), ['Todo', 'Done', 'Later']); assert.equal(f.changes, 0);
  } finally { f.close(); }
});
test('committed drag order persists through the existing controller and shared NoteBuffer path', async () => {
  const adapter = new MemoryAdapter({ 'Work.base': source, ...Object.fromEntries(['Todo', 'Done', 'Later'].map((status, index) => [`${index}.md`, `---\nstatus: ${status}\n---\nKeep note ${index}\n`])) });
  const vault = new Vault(adapter); await vault.initialize(); const buffer = new NoteBuffer(vault, 'Work.base', { debounceMs: 60000 }); await buffer.load();
  const controller = new BaseController({ vault, basePath: 'Work.base', delayMs: 1000, mutations: createBaseMutationHost({ validate() {}, getBuffer: () => buffer }) }); await controller.refresh();
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document, saves: Promise<void>[] = [];
  const groups = createBaseManualGroups(doc, doc.querySelector('main')!, { result: controller.state.result!, property: () => 'note.status', changed() { saves.push(controller.updateView(controller.state.version, { groupOrder: groups.read() })); }, error(message) { assert.equal(message, ''); } });
  try {
    const rows = [...doc.querySelectorAll<HTMLElement>('[data-group-id]')], grip = rows[0].querySelector<HTMLElement>('.bases-manual-group-grip')!, data = new Map<string, string>(), transfer = { effectAllowed: '', dropEffect: '', setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '' };
    const event = (node: HTMLElement, type: string) => { const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: 1 }); Object.defineProperty(e, 'dataTransfer', { value: transfer }); node.dispatchEvent(e); };
    event(grip, 'dragstart'); event(rows[1], 'dragover'); assert.equal(await vault.read('Work.base'), source); assert.equal(saves.length, 0); event(rows[1], 'drop'); await Promise.all(saves);
    assert.equal(saves.length, 1); assert.deepEqual(BaseDocument.parse(await vault.read('Work.base')).views[0].groupOrder, ['Done', 'Todo', 'Later']); assert.ok((await vault.read('Work.base')).startsWith('# keep\n')); assert.deepEqual(BaseDocument.parse(await vault.read('Work.base')).getRoot('plugin'), { retain: true }); assert.equal(await vault.read('0.md'), '---\nstatus: Todo\n---\nKeep note 0\n');
  } finally { groups.destroy(); controller.dispose(); await buffer.dispose(); dom.window.close(); }
});

test('dropping without a move is inert and readonly group controls stay readonly after cancellation', () => {
  const f = fixture(); try {
    const source = f.row('Todo'), grip = source.querySelector<HTMLElement>('.bases-manual-group-grip')!, data = f.transfer();
    const other = f.row('Done').querySelector<HTMLInputElement>('input')!; other.disabled = true;
    f.dragEvent(grip, 'dragstart', data); assert.equal(source.querySelector<HTMLInputElement>('input')!.disabled, true); f.dragEvent(source, 'drop', data);
    assert.equal(f.changes, 0); assert.equal(other.disabled, true); assert.equal(source.querySelector<HTMLInputElement>('input')!.disabled, false);
    f.key(grip, ' '); f.key(source, 'Enter'); assert.equal(f.changes, 0);
  } finally { f.close(); }
});

test('normal Group menu reordering changes only groupOrder and preserves the original property alias', async () => {
  for (const spelling of ['status', 'note.status']) {
    const original = source.replace('property: status', `property: ${spelling}`), document = BaseDocument.parse(original), before = parse(original);
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document; let version = 1, saves = 0; const errors: unknown[] = [];
    const files = ['Todo', 'Done', 'Later'].map((status, index) => ({ path: `${index}.md`, properties: { status, score: index } }));
    const toolbar = createBaseToolbar(doc.querySelector('main')!, { immediate: true, preflight() {}, async selectView() {}, async save(expected, patch) { assert.equal(expected, version); document.updateView(0, patch); version++; saves++; refresh(); }, onDraftChange() {}, onError(error) { errors.push(error); } });
    function refresh() { const next = executeBaseQuery(document, { version, files }); toolbar.update({ result: next, views: document.views, selectedIndex: 0, readOnly: false, allowRename: true, label: property => property }); }
    const until = async (check: () => boolean) => { for (let i = 0; i < 600 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(check()); };
    try {
      refresh(); doc.querySelector<HTMLButtonElement>('[aria-label="Group"]')!.click();
      const row = doc.querySelector<HTMLElement>('.bases-manual-group-row')!; row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); await until(() => saves === 1);
      const expected = structuredClone(before); expected.views[0].groupOrder = ['Done', 'Todo', 'Later']; assert.deepEqual(parse(document.toString()), expected); assert.deepEqual(errors, []);
      const property = doc.querySelector<HTMLSelectElement>('[aria-label="Group property"]')!; property.value = 'note.score'; property.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await until(() => saves === 2);
      assert.equal((document.views[0].groupBy as { property: string }).property, 'note.score'); assert.deepEqual(document.views[0].groupOrder, []);
    } finally { toolbar.destroy(); dom.window.close(); }
  }
});
