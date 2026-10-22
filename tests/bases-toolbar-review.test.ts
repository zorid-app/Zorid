import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BaseDocument } from '../src/bases/document.ts';
import type { BaseViewPatch } from '../src/bases/document.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { createBaseToolbar } from '../src/bases/toolbar.ts';

function fixture(view: Record<string, unknown> = {}, immediate = false) {
  const dom = new JSDOM('<main></main><button id="external">Outside</button>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const result = executeBaseQuery(BaseDocument.parse(JSON.stringify({ views: [{ type: 'table', name: 'Table', ...view }] })), { version: 1, files: [{ path: 'A.md', properties: { score: 2 } }] });
  const patches: BaseViewPatch[] = [], errors: unknown[] = [];
  const toolbar = createBaseToolbar(doc.querySelector('main')!, { immediate, preflight() {}, async selectView() {}, async save(_version, patch) { patches.push(patch); }, onDraftChange() {}, onError(error) { errors.push(error); } });
  const state = { result, views: [result.view], selectedIndex: 0, readOnly: false, allowRename: true, label: (property: string) => property };
  toolbar.update(state);
  const get = <T extends HTMLElement>(label: string) => doc.querySelector<T>(`[aria-label="${label}"]`)!;
  return { dom, doc, result, state, toolbar, patches, errors, get, click(label: string) { get<HTMLButtonElement>(label).click(); }, change(label: string, value: string) { const input = get<HTMLInputElement>(label); input.value = value; input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }, submit() { doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }, cleanup() { toolbar.destroy(); dom.window.close(); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('editing only group direction preserves a configured missing property and group order', async () => {
  const f = fixture({ groupBy: { property: 'formula.future', direction: 'ASC', extension: 'keep' }, groupOrder: ['x'] });
  try {
    f.click('Group');
    assert.equal(f.get<HTMLSelectElement>('Group property').value, 'formula.future');
    f.change('Group direction', 'DESC'); f.submit(); await tick();
    assert.deepEqual(f.patches, [{ groupBy: { property: 'formula.future', direction: 'DESC', extension: 'keep' } }]);
  } finally { f.cleanup(); }
});

test('sort reorder retains keyboard focus within the open dialog', () => {
  const f = fixture({ sort: [{ property: 'file.name', direction: 'ASC' }, { property: 'score', direction: 'DESC' }] });
  try {
    f.click('Sort');
    const move = f.doc.querySelectorAll<HTMLButtonElement>('[aria-label="Move sort earlier"]')[1];
    move.focus(); move.click();
    assert.ok(f.doc.querySelector('[role="dialog"]')!.contains(f.doc.activeElement), 'reordering must not drop keyboard focus to document body');
  } finally { f.cleanup(); }
});

test('filter add group retains keyboard focus within the open dialog', () => {
  const f = fixture({ filters: { and: ['true'] } });
  try {
    f.click('Filter');
    const add = f.get<HTMLButtonElement>('Add group'); add.focus(); add.click();
    assert.ok(f.doc.querySelector('[role="dialog"]')!.contains(f.doc.activeElement), 'adding a group must not drop keyboard focus to document body');
  } finally { f.cleanup(); }
});

test('removing a focused immediate filter restores a visible control and Escape closes from actual focus',async()=>{
 const f=fixture({filters:{and:['note.score >= 4']}},true);
 try{
  f.click('Filter');const remove=f.get<HTMLButtonElement>('Remove filter');remove.focus();remove.click();await tick();
  const active=f.doc.activeElement as HTMLElement;
  assert.notEqual(active,f.doc.body);assert.equal(active.getAttribute('role'),'combobox');assert.equal(active.getAttribute('aria-label'),'Match');assert.equal(active.closest('[hidden],[aria-hidden=true]'),null);
  active.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();
  assert.equal(f.doc.querySelector('[role="dialog"]'),null);assert.deepEqual(f.patches,[{filters:undefined}]);assert.deepEqual(f.errors,[]);
 }finally{f.cleanup();}
});

test('background refresh does not steal focus from an external control', () => {
  const f = fixture();
  try {
    f.click('Filter'); f.doc.querySelector<HTMLButtonElement>('#external')!.focus();
    f.toolbar.update(f.state);
    assert.equal(f.doc.activeElement?.id, 'external');
  } finally { f.cleanup(); }
});

test('changing group property updates an existing equivalent column alias', async () => {
  const f = fixture({ groupBy: { property: 'file.name', column: 'file.name', direction: 'ASC', extension: 'keep' } });
  try {
    f.click('Group'); f.change('Group property', 'note.score'); f.submit(); await tick();
    assert.equal(f.patches.length, 1, f.doc.querySelector('[role="alert"]')?.textContent ?? 'expected a saved group change');
    assert.equal((f.patches[0].groupBy as Record<string, unknown>).property, 'note.score');
    assert.equal((f.patches[0].groupBy as Record<string, unknown>).extension, 'keep');
  } finally { f.cleanup(); }
});

test('Add sort chooses an applicable property when an ordered formula is unavailable', async () => {
  const f = fixture({ order: ['formula.future', 'file.name'] });
  try {
    f.click('Sort'); f.click('Add sort'); f.submit(); await tick();
    assert.equal(f.patches.length, 1, f.doc.querySelector('[role="alert"]')?.textContent ?? 'expected a saved sort');
  } finally { f.cleanup(); }
});

test('invalid typed filter survives an attempted structural addition and blocks Apply', async () => {
  const f = fixture({ filters: { and: ['note["score"] == 2'] } });
  try {
    f.click('Filter'); const input = f.get<HTMLInputElement>('Filter value');
    input.value = 'not a number'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    f.click('Add group');
    assert.equal(input.isConnected, true); assert.equal(input.value, 'not a number');
    f.submit(); await tick(); assert.equal(f.patches.length, 0);
    f.click('Remove filter'); f.submit(); await tick();
    assert.deepEqual(f.patches, [{ filters: undefined }]);
  } finally { f.cleanup(); }
});
