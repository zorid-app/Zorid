import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseQueryGroup, BaseQueryResult } from '../src/bases/query.ts';
import type { BaseViewConfig } from '../src/bases/document.ts';

const group = (id: string, label = 'Same label', path = `${id}.md`): BaseQueryGroup => ({
  sharedKeyId: id, key: { type: 'string', value: label },
  rows: [{ path, entryId: `entry-${id}`, revision: 'row-1', values: { 'file.name': { type: 'string', value: path }, 'note.text': { type: 'string', value: id } } }],
});
const initialView: BaseViewConfig = { id: 'view00000001', type: 'table', name: 'Grouped', source: { kind: 'collection', id: 'source000001' },
  groupBy: { property: 'note.status', direction: 'ASC' } };
function result(groups: readonly BaseQueryGroup[], view = initialView, version = 1): BaseQueryResult {
  const rows = groups.flatMap(group => group.rows);
  return { version, view, rows, groups, properties: ['file.name', 'note.text'], availableProperties: ['file.name', 'note.text'], groupOptions: [], diagnostics: [],
    counts: { scanned: rows.length, matched: rows.length, afterGroupOrder: rows.length, afterSearch: rows.length, returned: rows.length } };
}
function fixture(snapshot = result([group('opaque-a'), group('opaque-b')])) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), main = dom.window.document.querySelector('main')!;
  let entryId = 'base-entry';
  const view = createBaseTableView(main, { result: snapshot, openFile() {}, getConfigurationIdentity: () => entryId });
  const heading = (index: number) => main.querySelector<HTMLButtonElement>(`[data-group-button="${index}"]`)!;
  const visible = (path: string) => !!main.querySelector(`[data-path="${path}"]`);
  return { dom, main, view, heading, visible, replaceBase() { entryId = 'replacement-base'; }, close() { view.destroy(); dom.window.close(); } };
}

test('same-view refresh retains collapsed shared group identity across label, row and group-order changes', () => {
  const f = fixture(); try {
    f.heading(1).click(); assert.equal(f.visible('opaque-b.md'), false);
    const updatedB = group('opaque-b', 'Renamed option', 'renamed-row.md');
    const updatedView = { ...initialView, name: 'Renamed view', sort: [{ property: 'file.name', direction: 'DESC' }],
      groupOrder: ['opaque-b', 'opaque-a'], groupBy: { direction: 'DESC', property: 'note.status' } };
    f.view.update(result([updatedB, group('opaque-a')], updatedView, 2));
    assert.equal(f.heading(0).getAttribute('aria-expanded'), 'false');
    assert.equal(f.visible('renamed-row.md'), false);
    assert.equal(f.heading(1).getAttribute('aria-expanded'), 'true'); assert.equal(f.visible('opaque-a.md'), true);
    f.heading(0).click(); assert.equal(f.visible('renamed-row.md'), true);
  } finally { f.close(); }
});

test('an accepted ordinary row edit refresh keeps the existing group collapsed', () => {
  const f = fixture(); try {
    f.heading(1).click();
    const changed = group('opaque-b');
    const edited = { ...changed, rows: changed.rows.map(row => ({ ...row, revision: 'row-2', values: { 'file.name': { type: 'string' as const, value: 'Edited title' } } })) };
    f.view.update(result([group('opaque-a'), edited], structuredClone(initialView), 2));
    assert.equal(f.heading(1).getAttribute('aria-expanded'), 'false'); assert.equal(f.visible('opaque-b.md'), false);
    assert.equal(f.visible('opaque-a.md'), true);
  } finally { f.close(); }
});

test('gone or replaced shared group identities never lend their collapsed state to an equal label or index', () => {
  const f = fixture(); try {
    f.heading(1).click();
    f.view.update(result([group('opaque-a'), group('replacement-b')], initialView, 2));
    assert.equal(f.heading(1).getAttribute('aria-expanded'), 'true'); assert.equal(f.visible('replacement-b.md'), true);
    // Returning after an accepted result omitted the old identity starts open.
    f.view.update(result([group('opaque-b'), group('opaque-a')], initialView, 3));
    assert.equal(f.heading(0).getAttribute('aria-expanded'), 'true'); assert.equal(f.visible('opaque-b.md'), true);
  } finally { f.close(); }
});

test('actual view, source, grouping or Base replacement clears otherwise equal collapsed identities', () => {
  const changes: [string, BaseViewConfig][] = [
    ['view', { ...initialView, id: 'view00000002' }],
    ['view type', { ...initialView, type: 'list' }],
    ['collection', { ...initialView, source: { kind: 'collection', id: 'source000002' } }],
    ['source kind', { ...initialView, source: { kind: 'untyped' } }],
    ['grouping', { ...initialView, groupBy: { property: 'note.other', direction: 'ASC' } }],
    ['ungrouped', { ...initialView, groupBy: undefined }],
    ['Base entry', initialView],
  ];
  for (const [kind, nextView] of changes) {
    const f = fixture(); try {
      f.heading(1).click(); if (kind === 'Base entry') f.replaceBase();
      f.view.update(result([group('opaque-a'), group('opaque-b')], nextView, 2));
      assert.equal(f.heading(1).getAttribute('aria-expanded'), 'true', kind);
      assert.equal(f.visible('opaque-b.md'), true, kind);
    } finally { f.close(); }
  }
});

test('legacy group keys retain typed identity rather than display text or position', () => {
  const boolean = { ...group('boolean'), sharedKeyId: undefined, key: { type: 'boolean' as const, value: false } };
  const string = { ...group('string'), sharedKeyId: undefined, key: { type: 'string' as const, value: 'false' } };
  const view = { type: 'table', name: 'Legacy', groupBy: { property: 'note.value', direction: 'ASC' } };
  const f = fixture(result([string, boolean], view)); try {
    f.heading(1).click();
    f.view.update(result([structuredClone(boolean), structuredClone(string)], view, 2));
    assert.equal(f.heading(0).getAttribute('aria-expanded'), 'false'); assert.equal(f.visible('boolean.md'), false);
    assert.equal(f.heading(1).getAttribute('aria-expanded'), 'true'); assert.equal(f.visible('string.md'), true);
    f.view.update(result([boolean, string], { ...view, name: 'Other legacy view' }, 3));
    assert.equal(f.heading(0).getAttribute('aria-expanded'), 'true');
  } finally { f.close(); }
});

test('a row moving into a retained collapsed group leaves a visible roving tab stop without stealing outside focus', () => {
  const selected = group('opaque-a'), collapsed = group('opaque-b');
  const f = fixture(result([selected, collapsed])); try {
    const selectedCell = f.main.querySelector<HTMLElement>('[data-path="opaque-a.md"][data-property="note.text"]')!;
    selectedCell.focus(); f.heading(1).click();
    const outside = f.dom.window.document.createElement('button'); f.dom.window.document.body.append(outside); outside.focus();
    const visible = group('opaque-a', 'Same label', 'visible.md');
    const replacement = { ...visible, rows: visible.rows.map(row => ({ ...row, entryId: 'entry-visible' })) };
    f.view.update(result([replacement, { ...collapsed, rows: [...selected.rows, ...collapsed.rows] }], initialView, 2));
    assert.equal(f.heading(1).getAttribute('aria-expanded'), 'false'); assert.equal(f.visible('opaque-a.md'), false);
    assert.equal(f.dom.window.document.activeElement, outside);
    const targets = f.main.querySelectorAll<HTMLElement>('[role="gridcell"][data-path][tabindex="0"]');
    assert.equal(targets.length, 1); assert.equal(targets[0].dataset.path, 'visible.md');
    assert.equal(targets[0].dataset.property, 'note.text'); assert.equal(f.main.querySelector('[data-base-editing]'), null);
  } finally { f.close(); }
});

test('changed exposed formula definitions clear collapse for formula-based grouping', () => {
  const formulaView = { ...initialView, groupBy: { property: 'formula.Score', direction: 'ASC' }, formulas: { Score: 'note.rating' } };
  const f = fixture(result([group('opaque-a'), group('opaque-b')], formulaView)); try {
    f.heading(1).click();
    f.view.update(result([group('opaque-a'), group('opaque-b')], { ...formulaView, formulas: { Score: 'note.rating + 1' } }, 2));
    assert.equal(f.heading(1).getAttribute('aria-expanded'), 'true'); assert.equal(f.visible('opaque-b.md'), true);
  } finally { f.close(); }
});
