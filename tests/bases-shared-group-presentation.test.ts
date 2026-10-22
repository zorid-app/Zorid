import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { projectSharedBaseResult } from '../src/bases/shared-query.ts';
import { createBaseKanbanView } from '../src/bases/kanban-view.ts';
import { createBaseKanbanColumns } from '../src/bases/kanban-columns.ts';
import { createBaseTableView } from '../src/bases/table-view.ts';
import { createBaseCardsView } from '../src/bases/cards-view.ts';
import { createBaseListView } from '../src/bases/list-view.ts';
import { createBaseViewActions } from '../src/bases/view-actions.ts';
import { displaySharedBaseValue, groupIdentity } from '../src/bases/presentation-common.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';
import type { BaseController } from '../src/bases/controller.ts';
import type { BaseKanbanMoveRequest } from '../src/bases/kanban-view.ts';
import type { DocumentBaseResult, DocumentBaseValue } from '../src/core/document-semantics.ts';

// Opaque fixture tokens deliberately reveal no JS canonicalization algorithm.
const ids = ['opaque-numeric-two', 'opaque-string-two'];
function raw(): DocumentBaseResult {
  const keys: DocumentBaseValue[] = [{ type: 'number', value: 2 }, { type: 'string', value: '2' }];
  return {
    snapshotId: { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'x', resolver: 'r', query: 'q' } },
    view: { type: 'kanban', name: 'Board', groupBy: { property: 'note.status', direction: 'ASC' }, groupOrder: [2, '2'] },
    rows: keys.map((key, i) => ({ entryId: `entry-${i}`, revision: 'r1', path: i ? 'B.md' : 'A.md', values: {
      'note.status': key, 'file.name': { type: 'string', value: i ? 'B' : 'A' },
      'formula.links': { type: 'list', value: [{ type: 'link', path: 'Target.md', target: { entryId: 'target', revision: 'r1' }, display: 'Target label', external: false }, { type: 'file', path: 'File.md' }] },
    } })),
    groups: keys.map((key, i) => ({ key, keyId: ids[i], entryIds: [`entry-${i}`] })),
    groupOptions: keys.map((key, i) => ({ key, keyId: ids[i], count: 1, listed: true })),
    properties: ['file.name', 'note.status', 'formula.links'], availableProperties: [],
    counts: { scanned: 2, matched: 2, afterGroupOrder: 2, afterSearch: 2, returned: 2 }, diagnostics: [],
    relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 20,
  };
}
const project = (input = raw(), version = 1) => projectSharedBaseResult(input, version, []);
function dom() { const window = new JSDOM('<main></main><button>Columns</button>', { pretendToBeVisual: true }).window; return { window, root: window.document.querySelector<HTMLElement>('main')!, anchor: window.document.querySelector<HTMLButtonElement>('button')! }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('real Kanban keeps numeric/string columns and exact move IDs while preserving nested labels', async () => {
  const { window, root } = dom(), result = project(), requests: BaseKanbanMoveRequest[] = [];
  const view = createBaseKanbanView(root, { result, openFile() {}, requestMove: async request => { requests.push(request); } });
  try {
    const columns = [...root.querySelectorAll('.bases-kanban-column')];
    assert.equal(columns.length, 2);
    assert.deepEqual(columns.map(column => [...column.querySelectorAll<HTMLElement>('.bases-kanban-card')].map(card => card.dataset.path)), [['A.md'], ['B.md']]);
    assert.match(columns[0].textContent!, /Target label, File\.md/);
    assert.equal(await view.move('A.md', result.groups[1].key!), true);
    assert.deepEqual(requests.map(request => [request.sourceKeyId, request.destinationKeyId]), [[ids[0], ids[1]]]);
    assert.deepEqual([...root.querySelectorAll('.bases-kanban-column')].map(column => [...column.querySelectorAll<HTMLElement>('.bases-kanban-card')].map(card => card.dataset.path)), [[], ['A.md', 'B.md']]);
  } finally { view.destroy(); window.close(); }
});

test('shared column hide uses opaque identity and raw configured ordinal, never loose matching', async () => {
  const { window, root, anchor } = dom(), result = project(), orders: unknown[] = [];
  const columns = createBaseKanbanColumns(root, { result, async requestGroupOrder(request) { orders.push(request.order); } });
  try {
    columns.open(anchor);
    assert.deepEqual([...window.document.querySelectorAll('.bases-columns-count')].map(node => node.textContent), ['1', '1']);
    window.document.querySelectorAll<HTMLElement>('.bases-columns-row')[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    await tick(); assert.deepEqual(orders, [['2', 2]], 'manual reordering retains each original typed source value');
    assert.equal(await columns.hide(result.groups[1].key!), true);
    assert.deepEqual(orders, [['2', 2], [2]], 'hiding string two preserves numeric two with its source type');
  } finally { columns.destroy(); window.close(); }
});

test('shared move actions require known IDs and choose the authoritative destination, not supplied display value', async () => {
  const result = project(), writes: unknown[] = [];
  const controller = { state: { version: result.version, result }, async moveToGroup(value: unknown) { writes.push(value); } } as unknown as BaseController;
  const actions = createBaseViewActions(controller, { validate() {} });
  const request: BaseKanbanMoveRequest = { path: 'A.md', version: result.version, property: 'note.status', source: result.groups[0].key!, destination: result.groups[0].key!, sourceKeyId: ids[0], destinationKeyId: ids[1] };
  await actions.requestMove(request);
  assert.equal((writes[0] as {value: unknown}).value, '2');
  await assert.rejects(actions.requestMove({ ...request, sourceKeyId: undefined }), /group changed/);
  await assert.rejects(actions.requestMove({ ...request, path: 'Missing.md' }), /group changed/);
  await assert.rejects(actions.requestMove({ ...request, destinationKeyId: 'unknown' }), /destination group/);
  assert.equal(writes.length, 1);
});

test('shared scroll state survives new projected values by group ID and stays separate for numeric/string keys', () => {
  const { window, root } = dom(), original = raw();
  const rows = Array.from({ length: 40 }, (_, index) => ({ ...original.rows[index % 2], entryId: `scroll-${index}`, path: `Scroll-${index}.md` }));
  const data = { ...original, rows, groups: original.groups.map((group, index) => ({ ...group, entryIds: rows.filter((_, i) => i % 2 === index).map(row => row.entryId) })), groupOptions: original.groupOptions.map(option => ({ ...option, count: 20 })) };
  const result = project(data);
  const view = createBaseKanbanView(root, { result, openFile() {} });
  try {
    const bodies = [...root.querySelectorAll<HTMLElement>('.bases-kanban-column-body')];
    bodies[0].scrollTop = 50; bodies[0].dispatchEvent(new window.Event('scroll'));
    bodies[1].scrollTop = 90; bodies[1].dispatchEvent(new window.Event('scroll'));
    view.update(project(data, 2));
    assert.deepEqual([...root.querySelectorAll<HTMLElement>('.bases-kanban-column-body')].map(body => body.scrollTop), [50, 90]);
  } finally { view.destroy(); window.close(); }
});

test('shared table, Cards and List format nested links inertly and preserve distinct group collapse IDs', async () => {
  const shared = project();
  for (const type of ['table', 'cards', 'list'] as const) {
    const { window, root } = dom(), result = { ...shared, view: { ...shared.view, type } };
    const handle = type === 'table' ? createBaseTableView(root, { result, openFile() {} }) : type === 'cards' ? createBaseCardsView(root, { result, openFile() {} }) : createBaseListView(root, { result, openFile() {} });
    try {
      assert.match(root.textContent!, /Target label, File\.md/);
      assert.doesNotMatch(root.textContent!, /requires a host implementation|namespace/);
      if (type !== 'table') {
        const heading = root.querySelector<HTMLButtonElement>('.bases-group-heading')!;
        heading.click(); await tick();
        handle.update({ ...project(raw(), 2), view: { ...result.view, type } }); await tick();
        assert.equal(root.querySelector('.bases-group-heading')!.getAttribute('aria-expanded'), 'false');
        assert.equal(root.querySelectorAll('.bases-group-heading')[1].getAttribute('aria-expanded'), 'true');
      }
    } finally { handle.destroy(); window.close(); }
  }
  const malicious = { type: 'namespace' as const, name: 'inert', get() { throw Error('must never execute'); } };
  assert.equal(displaySharedBaseValue({ type: 'object', value: { link: malicious } }), '{"link":"inert"}');
  assert.notEqual(groupIdentity(shared.groups[0]), groupIdentity(shared.groups[1]));
});

test('legacy Kanban still uses its existing loose destination behavior', async () => {
  const { window, root } = dom(), shared = project();
  const legacy = { ...shared, shared: undefined, view: { ...shared.view, groupOrder: undefined }, groups: shared.groups.map(group => ({ ...group, sharedKeyId: undefined })), groupOptions: [] };
  const writes: BaseKanbanMoveRequest[] = [];
  const view = createBaseKanbanView(root, { result: legacy, openFile() {}, requestMove: async request => { writes.push(request); } });
  try { assert.equal(await view.move('A.md', baseExpressionValue('2')), false); assert.equal(writes.length, 0); }
  finally { view.destroy(); window.close(); }
});


test('Cards/List collapse follows the opaque ID when equivalent object key presentation order changes', async () => {
  const data = (reverse = false): DocumentBaseResult => {
    const original = raw();
    const entries: [string, DocumentBaseValue][] = [['z', { type: 'number', value: 1 }], ['a', { type: 'number', value: 2 }]];
    const key: DocumentBaseValue = { type: 'object', value: reverse ? [...entries].reverse() : entries };
    return { ...original, view: { ...original.view, groupOrder: [{ z: 1, a: 2 }, '2'] },
      rows: [{ ...original.rows[0], values: { ...original.rows[0].values, 'note.status': key } }, original.rows[1]],
      groups: [{ ...original.groups[0], key }, original.groups[1]],
      groupOptions: [{ ...original.groupOptions[0], key }, original.groupOptions[1]],
    };
  };
  for (const type of ['cards', 'list'] as const) {
    const { window, root } = dom();
    const result = { ...project(data()), view: { ...project(data()).view, type } };
    const handle = type === 'cards' ? createBaseCardsView(root, { result, openFile() {} }) : createBaseListView(root, { result, openFile() {} });
    try {
      root.querySelector<HTMLButtonElement>('.bases-group-heading')!.click(); await tick();
      handle.update({ ...project(data(true), 2), view: { ...result.view, type } }); await tick();
      assert.equal(root.querySelector('.bases-group-heading')!.getAttribute('aria-expanded'), 'false');
      assert.equal(root.querySelectorAll('.bases-group-heading')[1].getAttribute('aria-expanded'), 'true');
    } finally { handle.destroy(); window.close(); }
  }
});


test('duplicate opaque IDs keep Rust unique-group order while popover retains every configured alias', async () => {
  const { window, root, anchor } = dom(), original = raw();
  const data = { ...original, view: { ...original.view, groupOrder: [2, '2', 2] },
    groups: [original.groups[1], original.groups[0]],
    groupOptions: [...original.groupOptions, original.groupOptions[0]],
  };
  const result = project(data), orders: unknown[] = [];
  const board = createBaseKanbanView(root, { result, openFile() {} });
  const columns = createBaseKanbanColumns(root, { result, async requestGroupOrder(request) { orders.push(request.order); } });
  try {
    assert.deepEqual([...root.querySelectorAll('.bases-kanban-column')].map(column => [...column.querySelectorAll<HTMLElement>('.bases-kanban-card')].map(card => card.dataset.path)), [['B.md'], ['A.md']]);
    columns.open(anchor);
    assert.equal(window.document.querySelectorAll('.bases-columns-row').length, 3, 'source aliases remain independently stored in their original ordinal positions');
    assert.equal(await columns.hide(result.groups[1].key!), true);
    assert.deepEqual(orders, [['2']], 'hiding one canonical group removes all of its listed aliases');
  } finally { columns.destroy(); board.destroy(); window.close(); }
});

test('rich Rust presentation crosses projection with nested labels and frozen target identity', () => {
  const source = raw();
  const values = source.rows[0].values as Record<string, DocumentBaseValue>;
  values.rich = { type:'list',value:[{type:'html',value:'<b>Hello</b>'},{type:'image',value:'cover.png'},{type:'icon',value:'star'},{type:'link',path:'Target.md',display:'fallback',displayValue:{type:'icon',value:'heart'},target:{entryId:'target',revision:'r2'},external:false}] };
  const output = project(source).rows[0].values.rich;
  assert.equal(output.type,'list'); if(output.type!=='list')return;
  assert.deepEqual(output.value.slice(0,3).map(item=>item.type==='namespace'?item.presentation:undefined),[{kind:'html',value:'<b>Hello</b>'},{kind:'image',value:'cover.png'},{kind:'icon',value:'star'}]);
  const link=output.value[3]; assert.equal(link.type,'namespace'); if(link.type!=='namespace')return;
  assert.deepEqual(link.presentation?.target,{entryId:'target',revision:'r2'});
  assert.equal(link.presentation?.label?.type,'namespace');
  assert.ok(Object.isFrozen(link.presentation)); assert.ok(Object.isFrozen(link.presentation?.target));
  assert.equal((values.rich.value[3] as {display:string}).display,'fallback','projection leaves raw data unchanged');
});


test('editable raw values preserve exact persisted aliases independently from typed rendering', () => {
  const source=raw();
  const row=source.rows[0] as typeof source.rows[number] & {editValues: Record<string,DocumentBaseValue>};
  row.editValues={'note.author':{type:'list',value:[{type:'string',value:'[[../People/Ada|Dr. Ada]]'}]}};
  (row.values as Record<string,DocumentBaseValue>)['note.author']={type:'list',value:[{type:'link',path:'People/Ada.md',target:{entryId:'ada',revision:'r1'},display:'Dr. Ada',external:false}]};
  const projected=project(source).rows[0];
  assert.deepEqual(projected.editValues?.['note.author'],{type:'list',value:[{type:'string',value:'[[../People/Ada|Dr. Ada]]'}]});
  assert.ok(Object.isFrozen(projected.editValues));
  assert.notDeepEqual(projected.editValues?.['note.author'],projected.values['note.author']);
});

test('core group assignment stays typed while order keys decode into plain persisted configuration', () => {
  const source=raw();
  const assignment:DocumentBaseValue={type:'list',value:[{type:'string',value:'[[/People/Ada.md|Ada]]'}]};
  const first=source.groups[0] as {editKey?:DocumentBaseValue;orderKey?:DocumentBaseValue};first.editKey=assignment;first.orderKey=assignment;
  const option=source.groupOptions[0] as {editKey?:DocumentBaseValue;orderKey?:DocumentBaseValue};option.editKey=assignment;option.orderKey=assignment;
  (source.groups[1] as {orderKey?:DocumentBaseValue}).orderKey={type:'string',value:'2026-10-22T01:30:00.123-04:00'};
  const output=project(source);
  assert.deepEqual(output.groups[0].editKey,assignment);
  assert.deepEqual(output.groups[0].orderKey,['[[/People/Ada.md|Ada]]']);
  assert.deepEqual(output.groupOptions[0].orderKey,output.groups[0].orderKey);
  assert.ok(Object.isFrozen(output.groups[0].orderKey));
  assert.equal(output.groups[1].editKey,undefined,'readonly group gets no invented assignment');
  assert.equal(output.groups[1].orderKey,'2026-10-22T01:30:00.123-04:00');
  (source.groups[1] as {orderKey?:DocumentBaseValue}).orderKey={type:'date',timestamp:0,hasTime:true};
  assert.throws(()=>project(source),/not a persisted value/);
});
