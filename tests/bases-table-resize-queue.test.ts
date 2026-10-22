import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import type { BaseViewPatch } from '../src/bases/document.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true });
  const main = dom.window.document.querySelector('main')!;
  const rows = [{ path: 'One.md', values: { 'note.rating': { type: 'number' as const, value: 10 }, 'note.other': { type: 'number' as const, value: 20 } } }];
  let result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Library', columnSize: { 'note.rating': 170, 'note.other': 100 } }, rows, groups: [{ key: null, rows }], properties: ['note.rating', 'note.other'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 } };
  const calls: { patch: BaseViewPatch; resolve(): void; reject(error: Error): void }[] = [];
  const table = createBaseTableView(main, { result, openFile() {}, patchView: patch => new Promise<void>((resolve, reject) => { calls.push({ patch, resolve, reject }); }), ...extra });
  const key = (key: string, property = 'note.rating') => [...main.querySelectorAll<HTMLElement>('[role="columnheader"]')].find(cell => cell.title === property)!.querySelector('[role="separator"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const update = (next: BaseQueryResult) => { result = next; table.update(next); };
  const acknowledge = (index: number) => update({ ...result, version: Number(result.version) + 1, view: { ...result.view, ...calls[index].patch } });
  return { dom, main, table, calls, key, update, acknowledge, get result() { return result; }, close() { table.destroy(); dom.window.close(); } };
}

test('a reset accepted during a pending resize saves after its acknowledged result', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].patch, { columnSize: { 'note.rating': 180, 'note.other': 100 } });
  f.calls[0].resolve(); await tick(); assert.equal(f.calls.length, 1, 'Do not dispatch against the old result while its acknowledgement is pending'); assert.equal(f.table.hasQueuedConfiguration(), true);
  f.acknowledge(0); await tick(); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.other': 100 } }); f.calls[1].resolve(); await tick(); f.close();
});

test('repeated arrow intents accumulate against each acknowledged width', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('ArrowRight'); f.key('ArrowLeft');
  for (const [index, width] of [180, 190, 180].entries()) {
    assert.equal(f.calls.length, index + 1); assert.deepEqual(f.calls[index].patch, { columnSize: { 'note.rating': width, 'note.other': 100 } });
    f.calls[index].resolve(); await tick(); f.acknowledge(index); await tick();
  }
  f.close();
});

test('a queued second-column resize retains the first column acknowledgement and new unrelated widths', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('ArrowRight', 'note.other'); f.calls[0].resolve(); await tick();
  f.update({ ...f.result, version: 2, view: { ...f.result.view, columnSize: { 'note.rating': 180, 'note.other': 120 } } }); await tick();
  assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.rating': 180, 'note.other': 130 } }); f.calls[1].resolve(); await tick(); f.close();
});

test('double-click automatic sizing accepted during a pending save is not dropped', async () => {
  const f = fixture(); f.key('ArrowRight');
  f.main.querySelector('[role="separator"]')!.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  f.calls[0].resolve(); await tick(); f.acknowledge(0); await tick();
  assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.other': 100 } }); f.calls[1].resolve(); await tick(); f.close();
});

test('the synchronous host acknowledgement handshake drains only after the new result is published', async () => {
  let acknowledge = () => {};
  const f = fixture({ onConfigurationSettled: () => acknowledge() }); let settled = 0;
  acknowledge = () => { f.acknowledge(settled++); };
  f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.other': 100 } });
  f.calls[1].resolve(); await tick(); assert.equal(settled, 2); f.close();
});

test('removed properties and changed view identities cancel queued intents without retargeting', async () => {
  for (const change of ['property', 'view'] as const) {
    const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
    f.update({ ...f.result, version: 2, ...(change === 'property' ? { properties: ['note.other'] } : { view: { ...f.result.view, name: 'Different view' } }) }); await tick();
    assert.equal(f.calls.length, 1); assert.match(f.main.textContent!, /queued column width change was cancelled/); f.close();
  }
});

test('a rejected save reports its failure and retires later resize intents', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.calls[0].reject(new Error('Read-only fixture save failed.')); await tick();
  assert.match(f.main.textContent!, /Read-only fixture save failed.*Queued column width changes were cancelled/);
  f.update({ ...f.result, version: 2 }); await tick(); assert.equal(f.calls.length, 1); f.close();
});

test('same-path replacement or deletion never rebases an accepted old-entry resize', async () => {
  for (const replacement of ['replacement-entry', undefined]) {
    let identity: string | undefined = 'original-entry';
    const f = fixture({ getConfigurationIdentity: () => identity }); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
    identity = replacement; f.acknowledge(0); await tick(); assert.equal(f.calls.length, 1); assert.match(f.main.textContent!, /queued column width change was cancelled/); f.close();
  }
});

test('missing host identity preserves direct legacy resizing but rejects unsafe queued input', async () => {
  const f = fixture({ getConfigurationIdentity: () => undefined }); f.key('ArrowRight'); f.key('Home'); assert.equal(f.calls.length, 1); assert.match(f.main.textContent!, /Wait for the current column width save, then retry/); f.calls[0].resolve(); await tick(); f.acknowledge(0); await tick(); assert.equal(f.calls.length, 1); f.close();
});

test('changing away and back to a view retires its old queued intent', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  f.update({ ...f.result, version: 2, view: { ...f.result.view, name: 'Other' } });
  f.update({ ...f.result, version: 3, view: { ...f.result.view, name: 'Library' } }); await tick();
  assert.equal(f.calls.length, 1); assert.match(f.main.textContent!, /queued column width change was cancelled/); f.close();
});

test('a removed and restored column cannot revive its queued old intent', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  const original = f.result;
  f.update({ ...original, version: 2, properties: ['note.other'] });
  f.update({ ...original, version: 3 }); await tick();
  assert.equal(f.calls.length, 1); assert.match(f.main.textContent!, /queued column width change was cancelled/); f.close();
});

test('a replaced and restored Base identity cannot revive its old queued intent', async () => {
  let identity = 'original-entry'; const f = fixture({ getConfigurationIdentity: () => identity }); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  identity = 'replacement-entry'; f.update({ ...f.result, version: 2 });
  identity = 'original-entry'; f.update({ ...f.result, version: 3 }); await tick();
  assert.equal(f.calls.length, 1); assert.match(f.main.textContent!, /queued column width change was cancelled/); f.close();
});

test('same-entry revisions may advance without retiring the queued resize', async () => {
  const f = fixture({ getConfigurationIdentity: () => 'same-entry' }); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  f.acknowledge(0); await tick(); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.other': 100 } }); f.calls[1].resolve(); await tick(); f.close();
});

test('destroy retires queued commands even after the outstanding host promise settles', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.table.destroy(); f.calls[0].resolve(); await tick();
  f.acknowledge(0); await tick(); assert.equal(f.calls.length, 1); f.dom.window.close();
});

test('active property drafts retain ownership while pending resize commands wait', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  f.acknowledge(0); const cell = f.main.querySelector<HTMLElement>('[role="gridcell"]')!; cell.dataset.baseEditing = 'draft'; await tick();
  assert.equal(f.calls.length, 1); assert.equal(cell.dataset.baseEditing, 'draft'); delete cell.dataset.baseEditing; await tick();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.other': 100 } }); f.calls[1].resolve(); await tick(); f.close();
});

test('fresh conflicting widths explicitly cancel queued intentions and permit retry from current settings', async () => {
  const f = fixture(); f.key('ArrowRight'); f.key('Home'); f.calls[0].resolve(); await tick();
  f.update({ ...f.result, version: 2, view: { ...f.result.view, columnSize: { 'note.rating': 250, 'note.other': 100 } } }); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.table.hasQueuedConfiguration(), false); assert.match(f.main.textContent!, /width changed while saving.*cancelled.*Resize again/);
  f.key('ArrowRight'); assert.deepEqual(f.calls[1].patch, { columnSize: { 'note.rating': 260, 'note.other': 100 } }); f.calls[1].resolve(); await tick(); f.close();
});
