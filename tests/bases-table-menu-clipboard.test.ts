import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableEdit } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';
import type { DatabaseCollection, DatabaseProperty, DatabaseValue } from '../src/core/databases.ts';
import { collectionClipboardValue } from '../src/databases/collection-clipboard.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const choices = [{ id: 'choice-red', name: 'Red, warm' }, { id: 'choice-blue', name: 'Blue' }];
const fields: DatabaseProperty[] = [
  { id: 'text', name: 'Text', datatype: 'text', options: [] },
  { id: 'number', name: 'Number', datatype: 'number', options: [] },
  { id: 'checkbox', name: 'Checkbox', datatype: 'checkbox', options: [] },
  { id: 'date', name: 'Date', datatype: 'date', options: [] },
  { id: 'datetime', name: 'Datetime', datatype: 'datetime', options: [] },
  { id: 'select', name: 'Select', datatype: 'select', options: choices },
  { id: 'multi-select', name: 'Multi-select', datatype: 'multi-select', options: choices },
  { id: 'status', name: 'Status', datatype: 'status', options: [{ id: 'working', name: 'In progress', category: 'working' }] },
  { id: 'empty', name: 'Nullable', datatype: 'number', options: [] },
  { id: 'empty-list', name: 'Empty list', datatype: 'multi-select', options: choices },
];
const collection: DatabaseCollection = { id: 'collection', name: 'Menu test', revision: 'schema-r1', deleted: false, properties: fields };
const saved: DatabaseValue[] = ['Exact\ntext\t"quoted"', -12.5, false, '2028-02-29', '2026-10-28T12:34:56.123456789+05:30', 'choice-red', ['choice-red', 'choice-blue'], 'working', null, []];

function fixture() {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true });
  const doc = dom.window.document, main = doc.querySelector('main')!;
  const properties = fields.map(field => `note.${field.id}`);
  const sourceRaw = Object.fromEntries(properties.map((property, index) => [property, baseExpressionValue(saved[index])]));
  const targetRaw = { ...sourceRaw, 'note.multi-select': baseExpressionValue(['choice-blue']), 'note.empty': baseExpressionValue(42), 'note.empty-list': baseExpressionValue(['choice-blue']) };
  const rows = [sourceRaw, targetRaw].map((values, index) => ({ path: `${index}.md`, entryId: `entry-${index}`, revision: 'r1', values: {
    ...values, 'note.select': baseExpressionValue('Red, warm'), 'note.multi-select': baseExpressionValue(['Red, warm', 'Blue']), 'note.status': baseExpressionValue('In progress'),
  } }));
  const result: BaseQueryResult = { version: 7, view: { type: 'table', name: 'Clipboard' }, rows, groups: [{ key: null, rows }],
    properties, availableProperties: properties, groupOptions: [], diagnostics: [], counts: { scanned: 2, matched: 2, afterGroupOrder: 2, afterSearch: 2, returned: 2 } };
  const batches: BaseTableEdit[][] = [], errors: unknown[] = [], executions: string[] = [];
  let clipboard = new Map<string, string>(), canRead = true, canWrite = true, admitted = true, textReads = 0, textWrites = 0;
  const phases: string[] = [];
  let readError: Error | undefined;
  let readGate: Promise<void> | undefined, typeGate: Promise<void> | undefined, textGate: Promise<void> | undefined;
  // Controlled async clipboard capability, without execCommand or permission
  // overrides. Actual native clipboard transfer remains a separate gate.
  const dispatch = (target: Element, type: 'copy' | 'paste') => {
    if (type === 'copy') clipboard = new Map();
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => clipboard.get(format) ?? '', setData: (format: string, value: string) => clipboard.set(format, value) } });
    target.dispatchEvent(event); return event;
  };
  Object.defineProperty(dom.window, 'Blob', { value: Blob });
  class Item {
    readonly types: string[];
    readonly values: Record<string, Blob>;
    static supports(type: string) { return type === 'text/plain' || type === 'text/html'; }
    constructor(values: Record<string, Blob>) { this.values = values; this.types = Object.keys(values); }
    async getType(type: string) { phases.push('type'); if (typeGate) await typeGate; const value = this.values[type];
      return { size: value.size, async text() { phases.push('text'); if (textGate) await textGate; return value.text(); } };
    }
  }
  Object.defineProperty(dom.window, 'ClipboardItem', { value: Item });
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: {
    get read() { return canRead ? async () => { executions.push('read'); phases.push('read'); if (readGate) await readGate;
      if (readError) throw readError;
      return [new Item(Object.fromEntries([...clipboard].filter(([type]) => ['text/plain', 'text/html'].includes(type)).map(([type, value]) => [type, new Blob([value], { type })])))]; } : undefined; },
    get write() { return canWrite ? async (items: Item[]) => { executions.push('write'); const next = new Map<string, string>();
      for (const type of items[0].types) next.set(type, await items[0].values[type].text()); clipboard = next; } : undefined; },
    async writeText(text: string) { textWrites++; clipboard = new Map([['text/plain', text]]); },
    async readText() { textReads++; return clipboard.get('text/plain') ?? ''; },
  } });
  const view = createBaseTableView(main, { result, openFile() {}, editProperty: async () => {},
    canBeginPropertyEdit: () => admitted,
    editProperties: async edits => { batches.push([...edits]); },
    getEditableValue: (row, property) => (row.path === '0.md' ? sourceRaw : targetRaw)[property],
    getPropertyType: property => fields.find(field => `note.${field.id}` === property)?.datatype,
    validatePropertyValue: (value, property) => collectionClipboardValue(collection, property, value),
    onError: error => errors.push(error),
  });
  const cell = (row: number, column = 0) => main.querySelector<HTMLElement>(`[role="gridcell"][data-path="${row}.md"][data-property="${properties[column]}"]`)!;
  const key = (target: Element, key: string, shiftKey = false) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  const selectSource = () => { cell(0).focus(); key(cell(0), 'End', true); };
  const menu = (target: Element, label: string) => {
    target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const action = [...doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === label);
    assert.ok(action, label); return action;
  };
  return { dom, doc, main, view, result, properties, sourceRaw, batches, errors, executions, phases, dispatch, cell, key, selectSource, menu,
    get clipboard() { return clipboard; }, set clipboard(value: Map<string, string>) { clipboard = value; },
    get textCalls() { return [textReads, textWrites]; }, denyPaste() { canRead = false; }, denyCopy() { canWrite = false; },
    revokeAdmission() { admitted = false; }, rejectRead(error: Error) { readError = error; },
    gate(phase: 'read' | 'type' | 'text') { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; });
      if (phase === 'read') readGate = promise; else if (phase === 'type') typeGate = promise; else textGate = promise; return resolve; },
    close() { view.destroy(); dom.window.close(); } };
}

test('menu Copy and Paste use the keyboard rich formats for all eight types, null and empty-list replacement', async () => {
  const f = fixture(); try {
    f.selectSource(); f.dispatch(f.doc.activeElement!, 'copy'); const keyboard = new Map(f.clipboard);
    f.menu(f.cell(0), 'Copy').click(); await tick();
    assert.ok(keyboard.get('text/html')?.includes('data-zorid-bases-clipboard'));
    assert.deepEqual(f.clipboard, new Map([['text/plain', keyboard.get('text/plain')!], ['text/html', keyboard.get('text/html')!]]));
    assert.deepEqual(f.executions, ['write']);
    f.cell(1).focus(); const paste = f.menu(f.cell(1), 'Paste'); assert.equal(paste.disabled, false); paste.click(); await tick();
    assert.deepEqual(f.executions, ['write', 'read']); assert.equal(f.batches.length, 1);
    const expected = f.properties.map(property => ({ version: 7, path: '1.md', property, value: f.sourceRaw[property] }));
    assert.deepEqual(f.batches[0], expected);
    // Keyboard Paste of the same payload must admit the identical commands.
    f.clipboard = new Map([...keyboard].filter(([type]) => ['text/html', 'text/plain'].includes(type)));
    f.dispatch(f.cell(1), 'paste'); await tick(); assert.deepEqual(f.batches[1], expected);
    assert.deepEqual(f.textCalls, [0, 0]); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('menu Paste validates the entire typed rectangle before any batch mutation', async () => {
  const f = fixture(); try {
    f.selectSource(); f.dispatch(f.doc.activeElement!, 'copy');
    const html = f.clipboard.get('text/html')!;
    const inert = f.doc.createElement('template'); inert.innerHTML = html;
    const table = inert.content.querySelector('table')!;
    const data = saved.map(data => ({ type: 'note', data })); data[9].data = ['unknown-option'];
    table.setAttribute('data-zorid-bases-cells', JSON.stringify([data]));
    f.clipboard = new Map([['text/html', table.outerHTML], ['text/plain', 'safe fallback must not bypass validation']]);
    f.cell(1).focus(); f.menu(f.cell(1), 'Paste').click(); await tick();
    assert.deepEqual(f.executions, ['read']); assert.equal(f.batches.length, 0);
    assert.match(String(f.errors[0]), /not configured/);
  } finally { f.close(); }
});

test('menu Paste is disabled without rich read support despite readText support', () => {
  const f = fixture(); try {
    f.denyPaste(); f.cell(1).focus(); const paste = f.menu(f.cell(1), 'Paste');
    assert.equal(paste.disabled, true); paste.click();
    assert.deepEqual(f.executions, []); assert.deepEqual(f.textCalls, [0, 0]); assert.equal(f.batches.length, 0);
  } finally { f.close(); }
});

test('menu Copy is disabled without rich write support despite writeText support', () => {
  const f = fixture(); try {
    f.denyCopy(); f.cell(0).focus(); const copy = f.menu(f.cell(0), 'Copy');
    assert.equal(copy.disabled, true); copy.click();
    assert.deepEqual(f.executions, []); assert.deepEqual(f.textCalls, [0, 0]);
  } finally { f.close(); }
});

for (const phase of ['read', 'type', 'text'] as const) {
  for (const change of ['result', 'focus', 'selection', 'admission', 'destroy'] as const) {
    test(`menu Paste abandons ${change} ownership changed while awaiting ${phase}`, async () => {
      const f = fixture(); try {
        f.selectSource(); f.dispatch(f.doc.activeElement!, 'copy');
        f.cell(1).focus(); const release = f.gate(phase);
        f.menu(f.cell(1), 'Paste').click(); await tick();
        assert.ok(f.phases.includes(phase), `the actual ${phase} await was reached`);
        if (change === 'result') f.view.update({ ...f.result, version: 8 });
        else if (change === 'focus') {
          const outside = f.doc.querySelector<HTMLButtonElement>('#outside')!;
          outside.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true }));
          outside.focus(); f.cell(1).focus();
        } else if (change === 'selection') f.key(f.cell(1), 'ArrowRight', true);
        else if (change === 'admission') f.revokeAdmission();
        else f.view.destroy();
        release(); await tick();
        assert.equal(f.batches.length, 0); assert.deepEqual(f.errors, []); assert.deepEqual(f.textCalls, [0, 0]);
      } finally { f.close(); }
    });
  }
}

test('external HTML without an own marker uses validated plain text semantics', async () => {
  const f = fixture(); try {
    f.clipboard = new Map([['text/html', '<table><tr><td>6</td></tr></table>'], ['text/plain', '6']]);
    f.cell(1, 1).focus(); f.menu(f.cell(1, 1), 'Paste').click(); await tick();
    assert.deepEqual(f.batches, [[{ version: 7, path: '1.md', property: 'note.number', value: baseExpressionValue(6) }]]);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.textCalls, [0, 0]);
  } finally { f.close(); }
});

test('malformed own HTML cannot fall back to plain text and a denied read reports without a write', async () => {
  for (const denied of [false, true]) {
    const f = fixture(); try {
      f.clipboard = new Map([['text/html', '<table data-zorid-bases-clipboard="1"></table>'], ['text/plain', '6']]);
      if (denied) f.rejectRead(new Error('Clipboard permission denied'));
      f.cell(1, 1).focus(); f.menu(f.cell(1, 1), 'Paste').click(); await tick();
      assert.deepEqual(f.executions, ['read']); assert.equal(f.batches.length, 0); assert.equal(f.errors.length, 1);
      assert.match(String(f.errors[0]), denied ? /permission denied/ : /Invalid Bases clipboard/);
    } finally { f.close(); }
  }
});

test('a replaced result or changed focus owner prevents a retained clipboard menu action', async () => {
  for (const change of ['result', 'focus'] as const) {
    const f = fixture(); try {
      f.selectSource(); const copy = f.menu(f.cell(0), 'Copy');
      if (change === 'result') f.view.update({ ...f.result, version: 8 });
      else f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
      copy.click(); await tick(); assert.deepEqual(f.executions, [], change); assert.deepEqual(f.textCalls, [0, 0], change);
    } finally { f.close(); }
  }
});
