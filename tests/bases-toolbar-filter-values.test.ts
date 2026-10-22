import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseFilterValues } from '../src/bases/toolbar-filter-values.ts';
import type { BaseFilterLiteral, BaseFilterOperatorDescriptor, BaseFilterPropertyDescriptor } from '../src/bases/toolbar-filter-types.ts';

const eq = (operand: BaseFilterOperatorDescriptor['operand']): BaseFilterOperatorDescriptor => ({ id: 'eq', label: 'is', comparison: '==', arity: 'one', operand });
const method = (operand: BaseFilterOperatorDescriptor['operand'], arity: BaseFilterOperatorDescriptor['arity'] = 'variadic', name = 'containsAny'): BaseFilterOperatorDescriptor => ({ id: name === 'contains' ? 'contains' : 'containsAny', label: name, method: name, arity, operand });
function fixture(operator: BaseFilterOperatorDescriptor, property: BaseFilterPropertyDescriptor, values?: readonly BaseFilterLiteral[]) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true }), doc = dom.window.document, container = doc.querySelector('main')!;
  let changes = 0, drafts = 0, alive = true;
  const control = createBaseFilterValues(doc, container, { operator, property, values, snapshot: { files: ['Books/Dune.md'], folders: ['Books'], tags: ['#reading', '#work'], properties: ['note.foo'], metadataStatus: 'current' }, alive: () => alive, onChange() { changes++; }, onDraftChange() { drafts++; } });
  const get = <T extends HTMLElement>(label: string) => doc.querySelector<T>(`[aria-label="${label}"]`)!;
  const type = (value: string) => { const input = get<HTMLInputElement>('Filter value'); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const click = (label: string) => get<HTMLButtonElement>(label).click();
  const itemType = (value: string) => { const select = get<HTMLSelectElement>('Item type'); select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const key = (value: string, extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }); get('Filter value').dispatchEvent(event); return event; };
  return { dom, doc, container, control, get, type, click, itemType, key, get changes() { return changes; }, get drafts() { return drafts; }, retire() { alive = false; }, cleanup() { control.destroy(); dom.window.close(); } };
}

test('mounting values never authors an empty scalar, list, null, or method argument', () => {
  for (const [operand, kind] of [['text', 'string'], ['number', 'number'], ['boolean', 'boolean'], ['date', 'date'], ['datetime', 'date'], ['list', 'list'], ['tags', 'tagList'], ['file', 'string'], ['readonly', 'object']] as const) {
    const f = fixture(eq(operand), { kind });
    try { assert.deepEqual(f.control.read(), {}); assert.equal(f.changes, 0); assert.equal(f.drafts, 0); assert.equal(f.control.hasDraft(), false); }
    finally { f.cleanup(); }
  }
  const f = fixture({ id: 'isEmpty', label: 'is empty', method: 'isEmpty', operand: 'none', arity: 'none' }, { kind: 'string' });
  try { assert.deepEqual(f.control.read(), { values: [] }); assert.equal(f.doc.querySelector('main input,main select,main button'), null); assert.equal(f.changes, 0); }
  finally { f.cleanup(); }
  const unset = fixture({ id: 'unset', label: 'is not set', comparison: '==', operand: 'none', arity: 'none' }, { kind: 'string' }, [null]);
  try { assert.deepEqual(unset.control.read(), { values: [] }); assert.equal(unset.doc.querySelector('main input,main select,main textarea,main button'), null); assert.equal(unset.changes, 0); }
  finally { unset.cleanup(); }
});

test('empty text, incomplete text and explicit null remain different states', () => {
  const f = fixture(eq('text'), { kind: 'string' });
  try {
    f.type(''); assert.deepEqual(f.control.read(), { values: [''] });
    f.type('  "quoted" \\ literal  '); assert.deepEqual(f.control.read(), { values: ['  "quoted" \\ literal  '] });
    f.click('Clear value'); assert.deepEqual(f.control.read(), { values: [null] }); assert.equal(f.get('Null value').hidden, false);
    f.type(''); assert.deepEqual(f.control.read(), { values: [''] }); assert.equal(f.get('Null value').hidden, true);
  } finally { f.cleanup(); }
});

test('numbers use decimal text controls, retain invalid drafts, and never coerce blank/hex/nonfinite text', () => {
  const f = fixture(eq('number'), { kind: 'number' }, [12]);
  try {
    assert.equal(f.get<HTMLInputElement>('Filter value').type, 'text'); assert.equal(f.get<HTMLInputElement>('Filter value').inputMode, 'decimal');
    for (const value of ['', ' ', '0x10', 'Infinity', 'NaN', '1e999', '4oops']) { f.type(value); assert.match(f.control.read().error!, /finite decimal/); assert.equal(f.get<HTMLInputElement>('Filter value').value, value); }
    for (const [raw, number] of [['-1.25e2', -125], ['.5', 0.5], ['+2', 2]] as const) { f.type(raw); assert.deepEqual(f.control.read(), { values: [number] }); }
    f.click('Clear value'); assert.deepEqual(f.control.read(), { values: [null] });
  } finally { f.cleanup(); }
  const loadedString = fixture(eq('number'), { kind: 'number' }, ['5']);
  try { assert.deepEqual(loadedString.control.read(), { values: ['5'] }); loadedString.type('5'); assert.deepEqual(loadedString.control.read(), { values: [5] }); }
  finally { loadedString.cleanup(); }
});

test('checkbox shows unknown/null as indeterminate and false remains a real value', () => {
  const f = fixture(eq('boolean'), { kind: 'boolean' });
  try {
    const checkbox = f.get<HTMLInputElement>('Filter value'); assert.equal(checkbox.type, 'checkbox'); assert.equal(checkbox.indeterminate, true);
    checkbox.checked = false; checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    assert.deepEqual(f.control.read(), { values: [false] }); assert.equal(checkbox.indeterminate, false);
    f.click('Clear value'); assert.deepEqual(f.control.read(), { values: [null] }); assert.equal(checkbox.indeterminate, true);
    checkbox.checked = true; checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); assert.deepEqual(f.control.read(), { values: [true] });
  } finally { f.cleanup(); }
});

test('date/time controls preserve original offsets and civil input without UTC conversion', () => {
  const original = '2026-11-01T01:30:00-04:00', f = fixture(eq('datetime'), { kind: 'date', withTime: true }, [original]);
  try {
    assert.equal(f.get<HTMLInputElement>('Filter value').type, 'datetime-local'); assert.deepEqual(f.control.read(), { values: [original] });
    f.type('2026-11-02T09:45'); assert.deepEqual(f.control.read(), { values: ['2026-11-02T09:45-04:00'] });
    f.type(''); assert.match(f.control.read().error!, /valid date and time/);
    f.click('Clear value'); assert.deepEqual(f.control.read(), { values: [null] });
  } finally { f.cleanup(); }
  const date = fixture(eq('date'), { kind: 'date' }, ['2024-02-29']);
  try { assert.equal(date.get<HTMLInputElement>('Filter value').type, 'date'); date.type('2026-10-22'); assert.deepEqual(date.control.read(), { values: ['2026-10-22'] }); }
  finally { date.cleanup(); }
});

test('unrepresentable dates fall back to text and preserve raw input until explicit edits', () => {
  for (const original of ['2026-11-01T01:30:00.123456789+05:30', '2026-02-30', 'not a date']) {
    const f = fixture(eq('datetime'), { kind: 'date', withTime: true }, [original]);
    try {
      assert.equal(f.get<HTMLInputElement>('Filter value').type, 'text'); assert.deepEqual(f.control.read(), { values: [original] });
      assert.match(f.doc.querySelector('[role="status"]')!.textContent!, /preserved/);
      f.type('2026-11-01T02:30:00+05:30'); assert.deepEqual(f.control.read(), { values: ['2026-11-01T02:30:00+05:30'] });
      f.type('2026-02-30T02:30'); assert.ok(f.control.read().error);
    } finally { f.cleanup(); }
  }
});

test('exact list preserves mixed and nested literal kinds and never mutates supplied arrays', () => {
  const values: BaseFilterLiteral[] = [[1, true, '1', null, [false, ['nested']]]], f = fixture(eq('list'), { kind: 'list' }, values);
  try {
    assert.deepEqual(f.control.read(), { values });
    const read = f.control.read().values! as BaseFilterLiteral[]; (read[0] as BaseFilterLiteral[]).push('external'); assert.deepEqual(f.control.read(), { values });
    const remove = f.doc.querySelectorAll<HTMLButtonElement>('.bases-filter-operand-chip button')[1]; remove.click();
    assert.deepEqual(f.control.read(), { values: [[1, '1', null, [false, ['nested']]]] }); assert.deepEqual(values, [[1, true, '1', null, [false, ['nested']]]]);
  } finally { f.cleanup(); }
});

test('typed list members author one array RHS while variadic members remain separate arguments', () => {
  const f = fixture(eq('list'), { kind: 'list' });
  try {
    f.itemType('number'); f.type('1'); f.click('Add item');
    f.itemType('boolean'); assert.equal(f.get<HTMLInputElement>('Filter value').type, 'checkbox'); const checkbox = f.get<HTMLInputElement>('Filter value'); checkbox.checked = true; checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); f.click('Add item');
    f.itemType('string'); f.type('1'); f.key('Enter');
    f.itemType('null'); assert.equal(f.get<HTMLInputElement>('Filter value').hidden, true); f.click('Add item');
    assert.deepEqual(f.control.read(), { values: [[1, true, '1', null]] }); assert.equal(f.control.hasDraft(), false);
    f.click('Clear value'); assert.deepEqual(f.control.read(), { values: [null] }); f.type('pending after null'); assert.ok(f.control.read().error); f.click('Clear item'); assert.deepEqual(f.control.read(), { values: [null] }); f.click('Empty list'); assert.deepEqual(f.control.read(), { values: [[]] });
  } finally { f.cleanup(); }
  const variadic = fixture(method('tokens'), { kind: 'list' }, [1, true, '1', null, [2]]);
  try { assert.deepEqual(variadic.control.read(), { values: [1, true, '1', null, [2]] }); variadic.type('next'); variadic.key('Enter'); assert.deepEqual(variadic.control.read(), { values: [1, true, '1', null, [2], 'next'] }); }
  finally { variadic.cleanup(); }
});

test('pending/invalid chip blocks reads and type changes until Enter or Clear item', () => {
  const f = fixture(eq('list'), { kind: 'list' }, [[]]);
  try {
    f.itemType('number'); f.type('not a number'); assert.equal(f.control.hasDraft(), true); f.key('Enter'); assert.match(f.control.read().error!, /finite decimal/); assert.equal(f.changes, 0);
    f.itemType('boolean'); assert.equal(f.get<HTMLSelectElement>('Item type').value, 'number'); assert.equal(f.get<HTMLInputElement>('Filter value').value, 'not a number');
    f.click('Clear item'); assert.equal(f.control.hasDraft(), false); assert.deepEqual(f.control.read(), { values: [[]] });
    f.itemType('string'); f.type(' '); assert.equal(f.control.hasDraft(), true); f.key('Enter'); assert.deepEqual(f.control.read(), { values: [[' ']] });
    f.type('composing'); f.key('Enter', { isComposing: true }); assert.equal(f.control.hasDraft(), true); assert.equal(f.changes, 1);
  } finally { f.cleanup(); }
});

test('String variadic new members stay strings while loaded types remain unchanged', () => {
  const f = fixture(method('tokens'), { kind: 'string' }, ['first']);
  try {
    assert.deepEqual(Array.from(f.get<HTMLSelectElement>('Item type').options, option => option.textContent), ['Text']);
    f.type('1'); f.key('Enter'); assert.deepEqual(f.control.read(), { values: ['first', '1'] });
  } finally { f.cleanup(); }
});

test('List contains replaces a single Any argument and accepts nested list JSON without flattening', () => {
  const f = fixture(method('text', 'one', 'contains'), { kind: 'list' }, [false]);
  try {
    assert.deepEqual(f.control.read(), { values: [false] }); f.itemType('json'); f.type('[1,[true,null],"x"]'); f.click('Add item');
    assert.deepEqual(f.control.read(), { values: [[1, [true, null], 'x']] });
    f.type('{"not":"literal"}'); f.click('Add item'); assert.match(f.control.read().error!, /text, numbers/);
    assert.equal(f.get<HTMLInputElement>('Filter value').value, '{"not":"literal"}');
  } finally { f.cleanup(); }
});

test('configured choices display labels/colors, serialize raw values, and retain unknown choices', () => {
  const property: BaseFilterPropertyDescriptor = { kind: 'string', choices: [{ value: 'in_progress', label: 'In progress', color: 'purple' }, { value: 'done', label: 'Finished' }] };
  const f = fixture(eq('text'), property, ['in_progress']);
  try {
    assert.equal(f.get<HTMLInputElement>('Filter value').value, 'In progress'); assert.deepEqual(f.control.read(), { values: ['in_progress'] });
    f.type('finish'); const option = f.doc.querySelector<HTMLElement>('[role="option"]')!; assert.equal(option.textContent, 'Finished'); assert.equal(option.title, 'done'); option.click();
    assert.equal(f.get<HTMLInputElement>('Filter value').value, 'Finished'); assert.deepEqual(f.control.read(), { values: ['done'] });
    f.type('progress'); const colored = f.doc.querySelector<HTMLElement>('[role="option"]')!; assert.equal(colored.style.color, 'purple'); f.key('ArrowDown'); f.key('Enter'); assert.deepEqual(f.control.read(), { values: ['in_progress'] });
  } finally { f.cleanup(); }
  const unknown = fixture(eq('list'), { ...property, kind: 'list' }, [['unknown', 'in_progress']]);
  try { assert.deepEqual(unknown.control.read(), { values: [['unknown', 'in_progress']] }); assert.match(unknown.doc.querySelector('.bases-filter-operand-chips')!.textContent!, /unknown.*In progress/); }
  finally { unknown.cleanup(); }
});

test('choice Escape closes only its own picker; detached choices cannot invoke callbacks', () => {
  const f = fixture(eq('text'), { kind: 'string', choices: [{ value: '<b>raw</b>', label: 'Literal' }, { value: 'next', label: 'Next' }], metadataStatus: 'stale' });
  try {
    let escapes = 0; f.container.addEventListener('keydown', event => { if (event.key === 'Escape') escapes++; });
    f.control.focus(); const old = f.doc.querySelector<HTMLElement>('[role="option"]')!;
    assert.match(f.doc.querySelector('[role="status"]')!.textContent!, /out of date/); assert.equal(f.doc.querySelector('b'), null);
    f.type('next'); const count = f.changes; old.click(); assert.equal(f.changes, count);
    f.key('Escape'); assert.equal(escapes, 0); assert.equal(f.get('Filter value').getAttribute('aria-expanded'), 'false'); f.key('Escape'); assert.equal(escapes, 1);
    f.get('Filter value').click(); f.retire(); f.doc.querySelector<HTMLElement>('[role="option"]')!.click(); assert.equal(f.changes, count);
  } finally { f.cleanup(); }
});

test('configured choices close and leave native semantics when member kind changes away from Text', () => {
  const f = fixture(eq('list'), { kind: 'list', choices: [{ value: 'stored', label: 'Choice' }] }, [[]]);
  try {
    f.control.focus(); const oldOption = f.doc.querySelector<HTMLElement>('[role="option"]')!;
    f.itemType('boolean'); const checkbox = f.get<HTMLInputElement>('Filter value');
    assert.equal(checkbox.type, 'checkbox'); assert.equal(checkbox.hasAttribute('role'), false); assert.equal(checkbox.hasAttribute('aria-expanded'), false); assert.equal(f.doc.querySelector('[role="listbox"]'), null);
    oldOption.click(); assert.equal(f.changes, 0); assert.equal(f.control.hasDraft(), true);
    f.click('Add item'); assert.deepEqual(f.control.read(), { values: [[false]] });
    f.itemType('number'); f.type('2'); f.get('Filter value').click(); f.key('ArrowDown'); assert.equal(f.doc.querySelector('[role="listbox"]'), null); f.click('Add item');
    f.itemType('string'); assert.equal(f.get('Filter value').getAttribute('role'), 'combobox'); f.click('Clear item'); f.get('Filter value').click();
    assert.ok(f.doc.querySelector('[role="listbox"]')); f.key('ArrowDown'); f.key('Enter'); assert.deepEqual(f.control.read(), { values: [[false, 2, 'stored']] });
  } finally { f.cleanup(); }
});

test('tag exact lists and File variadic tags keep distinct argument structures and clear safely', () => {
  const exact = fixture(eq('tags'), { kind: 'tagList' }, [['#reading', ' #literal ']]);
  try {
    assert.deepEqual(exact.control.read(), { values: [['#reading', ' #literal ']] }); exact.type('#work'); assert.equal(exact.control.hasDraft(), true); assert.ok(exact.control.read().error); exact.key('Enter'); assert.deepEqual(exact.control.read(), { values: [['#reading', ' #literal ', '#work']] });
    exact.click('Empty list'); assert.deepEqual(exact.control.read(), { values: [[]] }); assert.equal(exact.doc.querySelectorAll('.bases-filter-operand-chip').length, 0);
    exact.click('Clear value'); assert.deepEqual(exact.control.read(), { values: [null] }); exact.type('new'); exact.key('Enter'); assert.deepEqual(exact.control.read(), { values: [['new']] });
  } finally { exact.cleanup(); }
  const variadic = fixture({ id: 'hasTag', label: 'has tag', method: 'hasTag', arity: 'variadic', operand: 'tags' }, { kind: 'file' }, ['#reading']);
  try { variadic.type('#work'); variadic.key('Enter'); assert.deepEqual(variadic.control.read(), { values: ['#reading', '#work'] }); }
  finally { variadic.cleanup(); }
});

test('file/folder/property operands reuse literal suggestions and preserve namespaced property keys', () => {
  for (const operand of ['file', 'folder', 'property'] as const) {
    const f = fixture({ id: 'hasLink', label: 'links to', method: 'hasLink', arity: 'one', operand }, { kind: 'file' });
    try { f.control.focus(); f.key('ArrowDown'); f.key('Enter'); assert.deepEqual(f.control.read(), { values: [operand === 'file' ? 'Books/Dune.md' : operand === 'folder' ? 'Books' : 'note.foo'] }); }
    finally { f.cleanup(); }
  }
});

test('disabled and retired controls cannot publish changes and destroy removes owned pickers', () => {
  const f = fixture(eq('number'), { kind: 'number' }, [3]);
  try {
    const input = f.get<HTMLInputElement>('Filter value'); input.disabled = true; f.type('4'); assert.equal(f.changes, 0); assert.deepEqual(f.control.read(), { values: [3] });
    input.disabled = false; f.retire(); f.type('5'); f.click('Clear value'); assert.equal(f.changes, 0); assert.deepEqual(f.control.read(), { values: [3] });
  } finally { f.cleanup(); }
  const chips = fixture(eq('list'), { kind: 'list' }, [['x']]);
  try { const remove = chips.doc.querySelector<HTMLButtonElement>('.bases-filter-operand-chip button')!, input = chips.get<HTMLInputElement>('Filter value'); chips.click('Empty list'); const count = chips.changes; remove.click(); assert.equal(chips.changes, count); chips.control.destroy(); chips.control.destroy(); input.value = 'retired'; input.dispatchEvent(new chips.dom.window.Event('input', { bubbles: true })); assert.equal(chips.changes, count); assert.equal(chips.doc.querySelector('.bases-filter-values'), null); }
  finally { chips.cleanup(); }
});
