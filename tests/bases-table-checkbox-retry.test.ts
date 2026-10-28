import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableView } from '../src/bases/table-view.ts';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
import type { BasePropertyWidgetAcknowledgement, BasePropertyWidgetEdit } from '../src/bases/property-widgets.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(retryCallback = true) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document, main = doc.querySelector('main')!;
  const row = { path: 'One.md', entryId: 'one', revision: 'r1', values: { 'note.first': { type: 'boolean' as const, value: false }, 'note.second': { type: 'boolean' as const, value: false } } };
  const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Main' }, rows: [row], groups: [{ key: null, rows: [row] }], properties: ['note.first', 'note.second'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  const writes: BasePropertyWidgetEdit[] = [];
  let pending = false, retryReady = true, readOnly = false, current = true, closing = false, view: BaseTableView | undefined;
  let accept!: (value: BasePropertyWidgetAcknowledgement) => void, reject!: (error: Error) => void;
  const canBegin = () => !pending && !view?.hasActiveEdits();
  view = createBaseTableView(main, { result, openFile() {}, editProperty: async () => {}, canBeginPropertyEdit: canBegin, ...(retryCallback ? { canRetryPropertyEdit: () => retryReady && !pending } : {}), isConfigurationClosing: () => closing,
    renderProperty(element, presentation) { return mountBasePropertyWidget(element, presentation, { getDefinition: () => ({ type: 'checkbox' }), canBegin, isCurrent: () => current, readOnly: () => readOnly,
      commit(edit) { writes.push(edit); pending = true; return new Promise<BasePropertyWidgetAcknowledgement>((yes, no) => { accept = yes; reject = no; }).finally(() => { pending = false; }); },
    }); },
  });
  const cell = (property = 'note.first') => main.querySelector<HTMLElement>(`[role="gridcell"][data-property="${property}"]`)!;
  const space = (property = 'note.first', init: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...init }); cell(property).dispatchEvent(event); return event; };
  const failFirst = async () => { cell().focus(); space(); assert.equal(writes.length, 1); reject(new Error('Not saved')); await tick(); assert.equal(cell().dataset.baseEditing, 'draft'); assert.equal(canBegin(), false); };
  return { dom, doc, main, view, row, writes, cell, space, failFirst, accept: async () => { const edit = writes.at(-1)!; accept({ version: 2, row: { ...row, revision: 'r2' }, value: edit.value }); await tick(); }, setRetryReady(value: boolean) { retryReady = value; }, setReadOnly(value: boolean) { readOnly = value; }, setCurrent(value: boolean) { current = value; }, setClosing(value: boolean) { closing = value; }, close() { view!.destroy(); dom.window.close(); } };
}

test('Space retries only its owning failed checkbox and pending repetitions remain blocked', async () => {
  const f = fixture(); try {
    await f.failFirst(); assert.equal(f.space().defaultPrevented, true); assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1].value, { type: 'boolean', value: true }); assert.equal(f.cell().dataset.baseEditing, 'pending');
    f.space(); f.space('note.first', { repeat: true }); assert.equal(f.writes.length, 2); await f.accept(); assert.equal(f.cell().hasAttribute('data-base-editing'), false); assert.equal(f.cell().querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true);
  } finally { f.close(); }
});

test('the retained retry exception never admits a checkbox in another cell', async () => {
  const f = fixture(); try { await f.failFirst(); assert.equal(f.space('note.second').defaultPrevented, true); assert.equal(f.writes.length, 1); assert.equal(f.cell('note.second').dataset.baseEditing, undefined); } finally { f.close(); }
});

test('Shift Space keeps table row selection instead of toggling a checkbox',()=>{
  const f=fixture();try{f.cell().focus();f.space('note.first',{shiftKey:true});assert.equal(f.writes.length,0);assert.equal(f.main.querySelectorAll('[role="gridcell"][aria-selected="true"]').length,2);}finally{f.close();}
});

test('host retry readiness and configuration closing still block the owning failed checkbox', async () => {
  const f = fixture(); try {
    await f.failFirst(); f.setRetryReady(false); assert.equal(f.space().defaultPrevented, true); assert.equal(f.writes.length, 1);
    f.setRetryReady(true); f.setClosing(true); assert.equal(f.space().defaultPrevented, true); assert.equal(f.writes.length, 1);
  } finally { f.close(); }
});

test('legacy hosts without independent retry readiness retain strict admission', async () => {
  const f = fixture(false); try { await f.failFirst(); assert.equal(f.space().defaultPrevented, true); assert.equal(f.writes.length, 1); } finally { f.close(); }
});

test('another active draft or range selection prevents the owning checkbox retry', async () => {
  const f = fixture(); try {
    await f.failFirst(); f.cell('note.second').dataset.baseEditing = 'draft'; f.space(); assert.equal(f.writes.length, 1); f.cell('note.second').removeAttribute('data-base-editing');
    f.cell('note.second').focus(); f.cell('note.second').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.main.querySelectorAll('[aria-selected="true"]').length, 2); f.space(); assert.equal(f.writes.length, 1);
  } finally { f.close(); }
});

test('the widget still rejects retained retries after current-owner or read-only revocation', async () => {
  for (const revoke of ['current', 'readOnly']) {
    const f = fixture(); try { await f.failFirst(); if (revoke === 'current') f.setCurrent(false); else f.setReadOnly(true); f.space(); assert.equal(f.writes.length, 1, revoke); assert.equal(f.cell().dataset.baseEditing, 'draft'); } finally { f.close(); }
  }
});
