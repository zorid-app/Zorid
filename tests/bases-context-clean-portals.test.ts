import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BaseDocument } from '../src/bases/document.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { createBaseTableView } from '../src/bases/table-view.ts';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import { createBaseKanbanColumns } from '../src/bases/kanban-columns.ts';

const files = [{ path: 'One.md', properties: { score: 11, status: 'Todo' } }];
const board = () => executeBaseQuery(BaseDocument.parse('views: [{type: kanban, name: Board, groupBy: {property: status, direction: ASC}, groupOrder: [Todo]}]\n'), { version: 1, files });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('the actual table retires its clean summary picker without replacing its published grid', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document, host = doc.querySelector<HTMLElement>('main')!;
  const result = executeBaseQuery(BaseDocument.parse('views: [{type: table, name: Table, order: [score]}]\n'), { version: 1, files });
  const requests: string[] = [];
  // Literal renderer inputs exercise portal ownership; Rust summary evaluation
  // and native query acceptance are outside this renderer-level regression.
  const table = createBaseTableView(host, { result, openFile() {}, getSummary: () => ({ value: { type: 'number', value: 11 } }),
    summaryOptions: [{ id: 'Sum', label: 'Sum' }], async requestSummary(_property, id) { requests.push(id); } });
  try {
    const cell = host.querySelector<HTMLElement>('[data-summary-property="note.score"]')!; cell.click(); await tick();
    const panel = doc.querySelector<HTMLElement>('.zorid-bases-summary-picker')!, choice = panel.querySelector<HTMLElement>('[data-summary-id="Sum"]')!;
    assert.ok(choice); const grid = host.querySelector('[role="grid"]'); table.dismissCleanPanels(); assert.equal(panel.isConnected, false);
    assert.equal(host.querySelector('[role="grid"]'), grid); assert.equal(grid?.getAttribute('data-base-rendered-version'), '1');
    choice.click(); assert.deepEqual(requests, [], 'A detached old picker cannot submit a summary'); cell.click(); await tick(); assert.ok(doc.querySelector('.zorid-bases-summary-picker'));
  } finally { table.destroy(); dom.window.close(); }
});

test('the actual Kanban view retires only its owned clean Group portal and remains usable', () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document, host = doc.querySelector<HTMLElement>('main')!;
  const requests: unknown[] = [], view = createBaseKanbanView(host, { result: board(), openFile() {}, async requestGroupOrder(request) { requests.push(request); } });
  try {
    const trigger = host.querySelector<HTMLButtonElement>('.bases-kanban-edit-columns')!; trigger.click(); const panel = doc.querySelector<HTMLElement>('.bases-columns-popover')!;
    assert.ok(panel); view.dismissCleanPanels(); assert.equal(panel.isConnected, false); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.deepEqual(requests, []);
    trigger.click(); assert.ok(doc.querySelector('.bases-columns-popover')); assert.equal(host.querySelectorAll('.bases-kanban-card').length, 1);
  } finally { view.destroy(); dom.window.close(); }
});

test('Group portal dismissal refuses pending or failed saves without losing their feedback', async () => {
  const dom = new JSDOM('<main></main><button>Group</button>', { pretendToBeVisual: true }), doc = dom.window.document;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let reject = true;
  const columns = createBaseKanbanColumns(doc.querySelector<HTMLElement>('main')!, { result: board(), async requestGroupOrder() { await gate; if (reject) throw new Error('Held group save failed'); } });
  try {
    columns.open(doc.querySelector<HTMLButtonElement>('button')!); doc.querySelector<HTMLElement>('.bases-columns-row')!.click();
    const panel = doc.querySelector<HTMLElement>('.bases-columns-popover')!; assert.equal(panel.getAttribute('aria-busy'), 'true');
    assert.throws(() => columns.dismissCleanPanel(), /Finish or cancel/); assert.equal(panel.isConnected, true);
    release(); await tick(); assert.match(panel.querySelector('[role="alert"]')!.textContent!, /Held group save failed/);
    assert.throws(() => columns.dismissCleanPanel(), /Finish or cancel/); assert.equal(panel.isConnected, true, 'Failed save feedback is retained');
    reject = false; panel.querySelector<HTMLElement>('.bases-columns-row')!.click(); await tick(); columns.dismissCleanPanel(); assert.equal(panel.isConnected, false);
  } finally { release(); columns.destroy(); dom.window.close(); }
});
