import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
import type { BasePropertyWidgetEdit, BasePropertyWidgetOptions } from '../src/bases/property-widgets.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';
import type { BasePropertyDefinition } from '../src/bases/property-definitions.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup(value: unknown, definition: BasePropertyDefinition, rest: Partial<BasePropertyWidgetOptions> = {}) {
  const dom = new JSDOM('<main><div></div><button>Outside</button></main>', { pretendToBeVisual: true });
  const element = dom.window.document.querySelector('div')!; const edits: BasePropertyWidgetEdit[] = [];
  const row = { path: 'A.md', values: { 'note.test': baseExpressionValue(value) }, entryId: 'stable-A' };
  const dispose = mountBasePropertyWidget(element, { row, property: 'note.test', value: baseExpressionValue(value), version: 14 }, {
    getDefinition: () => definition, commit: edit => { edits.push(edit); return { version: typeof edit.version === 'number' ? edit.version + 1 : edit.version, row: edit.row, value: edit.value }; }, ...rest,
  });
  const click = () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const input = () => dom.window.document.querySelector<HTMLInputElement>('input')!;
  const key = (key: string, options: Record<string, unknown> = {}) => input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  const close = () => { dispose(); dom.window.close(); };
  return { dom, element, edits, click, input, key, close, dispose, row };
}

test('opening and cancelling an empty property never creates it; edits carry captured row identity and version', async () => {
  const s = setup(null, { type: 'text' }); s.click(); assert.equal(s.element.dataset.baseEditing, 'draft'); s.key('Escape'); assert.equal(s.edits.length, 0);
  s.click(); s.input().value = 'hello'; s.key('Enter'); await tick(); assert.equal(s.edits[0].version, 14); assert.equal(s.edits[0].row, s.row); assert.equal(s.edits[0].path, 'A.md'); assert.deepEqual(s.edits[0].value, baseExpressionValue('hello')); assert.equal(s.element.dataset.baseEditing, undefined); s.close();
});

test('multiselect preserves unknown values and commits readable labels without replacing missing config options', async () => {
  const s = setup(['Legacy'], { type: 'multiselect', options: [{ value: 'Rust', label: 'Rust language', color: 'orange' }] });
  assert.equal(s.element.querySelector('.is-unknown')?.textContent, 'Legacy'); s.click();
  s.input().value = 'Rust'; s.input().dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); s.key('Enter'); await tick();
  assert.match(s.dom.window.document.querySelector('.bases-property-popover')!.textContent!, /Legacy/); s.key('Enter'); await tick();
  assert.deepEqual(s.edits.at(-1)?.value, baseExpressionValue(['Legacy', 'Rust'])); assert.equal(s.element.querySelector('[data-color="orange"]')?.textContent, 'Rust language'); s.close();
});

test('failed writes retain exact editable draft and recover on retry; pending writes resist Escape', async () => {
  let reject = true; let resolve: (() => void) | undefined;
  const s = setup('old', { type: 'text' }, { commit: async () => { if (reject) throw new Error('Disk unavailable'); await new Promise<void>(r => { resolve = r; }); } });
  s.click(); s.input().value = 'my draft'; s.key('Enter'); await tick(); assert.equal(s.input().value, 'my draft'); assert.equal(s.input().getAttribute('aria-invalid'), 'true'); assert.equal(s.element.dataset.baseEditing, 'draft');
  reject = false; s.key('Enter'); await tick(); assert.equal(s.element.dataset.baseEditing, 'pending'); s.key('Escape'); assert.equal(s.input().value, 'my draft'); resolve!(); await tick(); assert.equal(s.element.textContent, 'my draft'); s.close();
});

test('IME Enter does not commit, and disposal releases portals/listeners while issued saves settle', async () => {
  const s = setup([], { type: 'list' }); s.click(); s.input().value = '日本語'; s.input().dispatchEvent(new s.dom.window.CompositionEvent('compositionstart', { bubbles: true })); s.key('Enter', { isComposing: true }); assert.equal(s.edits.length, 0);
  s.input().dispatchEvent(new s.dom.window.CompositionEvent('compositionend', { bubbles: true })); s.key('Enter'); s.key('Enter'); await tick(); assert.deepEqual(s.edits.at(-1)?.value, baseExpressionValue(['日本語']));
  s.click(); assert.ok(s.dom.window.document.querySelector('.bases-property-inline-editor')); s.dispose(); assert.equal(s.dom.window.document.querySelector('.bases-property-popover'), null); assert.equal(s.element.dataset.baseEditing, undefined); s.close();
});

test('relation picker uses supplied resolved targets and preserves a dangling existing link', async () => {
  const s = setup('[[Missing]]', { type: 'relation' }, { getRelationTargets: () => [{ path: 'Projects/Alpha.md', label: 'Alpha', entryId: 'alpha-1' }] });
  assert.ok(s.element.querySelector('.is-unresolved')); s.click(); s.input().value = 'Alpha'; s.input().dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); s.key('Enter'); await tick(); assert.deepEqual(s.edits.at(-1)?.value, baseExpressionValue('[[Projects/Alpha]]')); s.close();
});

test('invalid number input remains a visible draft instead of converting silently', async () => {
  const s = setup('excellent', { type: 'number' }); assert.ok(s.element.classList.contains('mod-error')); s.click(); s.key('Enter'); await tick(); assert.equal(s.edits.length, 0);
  s.click(); s.input().value = '0xF'; s.key('Enter'); await tick(); assert.equal(s.element.dataset.baseEditing, 'draft'); assert.equal(s.edits.length, 0); s.key('Escape'); assert.equal(s.element.textContent, 'excellent'); s.close();
});


test('missing/incompatible multiple values remain untouched when opened and left unchanged', async () => {
  for (const value of [null, 42, [42]]) {
    const s = setup(value, { type: 'multiselect', options: [{ value: 'Rust' }] }); s.click(); s.key('Enter'); await tick(); assert.equal(s.edits.length, 0); s.close();
  }
  const s = setup('not-a-date', { type: 'date' }); s.click(); assert.equal(s.input().type, 'text'); assert.equal(s.input().value, 'not-a-date'); s.key('Enter'); await tick(); assert.equal(s.edits.length, 0); s.close();
});

test('shared namespace links are inertly rendered without calling expression getters', () => {
  const dom = new JSDOM('<div></div>'); const element = dom.window.document.querySelector('div')!; let opened = '';
  const value = { type: 'namespace' as const, name: 'Alpha', sharedValue: { type: 'link', path: 'Alpha.md', display: 'Project Alpha' }, get() { throw new Error('must not evaluate'); } };
  const dispose = mountBasePropertyWidget(element, { row: { path: 'A.md', values: {} }, property: 'formula.project', value, version: 1 }, { getDefinition: () => undefined, commit() { throw new Error('readonly'); }, openFile: path => { opened = path; } });
  element.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); assert.equal(opened, 'Alpha.md'); assert.equal(element.textContent, 'Project Alpha'); dispose(); dom.window.close();
});

test('shared date-only editor honors the provided presentation timezone', () => {
  const dom = new JSDOM('<div></div>'); const element = dom.window.document.querySelector('div')!;
  const value = { type: 'date' as const, timestamp: Date.parse('2026-01-01T16:00:00Z'), hasTime: false, presentationTimezone: 'Asia/Tokyo' };
  const dispose = mountBasePropertyWidget(element, { row: { path: 'A.md', values: {} }, property: 'note.date', value, version: 1 }, { getDefinition: () => ({ type: 'date' }), commit() {} });
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); assert.equal(element.querySelector('input')!.value, '2026-01-02'); dispose(); dom.window.close();
});


test('live chip changes rebase only through own successful acknowledgements', async () => {
  const s = setup([], { type: 'list' }); s.click(); s.input().value = 'First'; s.key('Enter'); await tick();
  assert.deepEqual(s.edits[0].value, baseExpressionValue(['First'])); assert.equal(s.edits[0].version, 14); assert.ok(s.dom.window.document.querySelector('.bases-property-inline-editor'));
  s.input().value = 'Second'; s.key('Enter'); await tick(); assert.equal(s.edits[1].version, 15); assert.deepEqual(s.edits[1].value, baseExpressionValue(['First', 'Second']));
  s.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Remove First"]')!.click(); await tick(); assert.equal(s.edits[2].version, 16); assert.deepEqual(s.edits[2].value, baseExpressionValue(['Second'])); s.key('Escape'); assert.equal(s.element.textContent, 'Second'); s.close();
});

test('successful live chip edit without rebase acknowledgement closes instead of reusing stale version', async () => {
  let count = 0; const s = setup([], { type: 'list' }, { commit: () => { count++; } }); s.click(); s.input().value = 'First'; s.key('Enter'); await tick();
  assert.equal(count, 1); assert.equal(s.dom.window.document.querySelector('.bases-property-popover'), null); assert.equal(s.element.dataset.baseEditing, undefined); s.close();
});

test('disabled missing relation choices cannot be selected by Enter or exact-match blur', async () => {
  const s = setup(null, { type: 'relation' }, { getRelationTargets: () => [{ path: 'Missing.md', label: 'Missing', missing: true }] });
  s.click(); s.input().value = 'Missing'; s.input().dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); assert.equal(s.dom.window.document.querySelector<HTMLButtonElement>('[role="option"]')!.disabled, true);
  s.key('Enter'); await tick(); assert.equal(s.edits.length, 0); assert.equal(s.element.dataset.baseEditing, 'draft'); s.close();
});

test('create option can acknowledge its own config-only refresh before committing selection', async () => {
  let definition: BasePropertyDefinition = { type: 'multiselect', options: [] }; const observed: number[] = [];
  const s = setup([], definition, { getDefinition: () => definition, createOption: (_property, value, presentation) => { definition = { ...definition, options: [{ value }] }; return { version: Number(presentation.version) + 1, row: presentation.row }; }, commit: edit => { observed.push(Number(edit.version)); return { version: Number(edit.version) + 1, row: edit.row, value: edit.value }; } });
  s.click(); s.input().value = 'New option'; s.input().dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); s.dom.window.document.querySelector<HTMLButtonElement>('.bases-property-create-option')!.click(); await tick();
  assert.deepEqual(observed, [15]); assert.equal(s.dom.window.document.querySelector('.is-unknown'), null); s.close();
});


test('ordinary lists edit inline, and chip Enter/Escape preserve existing text without a write', async () => {
  const s = setup(['First', 'Second'], { type: 'list' }); s.click(); assert.ok(s.element.querySelector('.bases-property-inline-editor')); assert.equal(s.dom.window.document.querySelector('.bases-property-popover'), null);
  let pill = s.element.querySelector<HTMLElement>('.multi-select-pill')!; pill.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); assert.equal(s.input().value, 'First');
  s.input().value = 'Draft'; s.key('Escape'); assert.equal(s.edits.length, 0); assert.equal(s.input().value, '');
  pill = s.element.querySelector<HTMLElement>('.multi-select-pill')!; pill.dispatchEvent(new s.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); s.input().value = 'Updated'; s.key('Enter'); await tick();
  assert.deepEqual(s.edits[0].value, baseExpressionValue(['Updated', 'Second'])); s.close();
});


test('offset datetime editing preserves its original literal value on open and close', async () => {
  const s = setup('2026-01-01T12:30:00-05:00', {type:'datetime'}); s.click(); assert.equal(s.input().type, 'text'); assert.equal(s.input().value, '2026-01-01T12:30:00-05:00'); s.key('Enter'); await tick(); assert.equal(s.edits.length, 0); s.close();
});


test('blur retained during IME commits final input even when activeElement stays on input', async () => {
  let release!: () => void; const writes: BasePropertyWidgetEdit[] = [];
  const s = setup('before', {type:'text'}, {commit: async edit => { writes.push(edit); await new Promise<void>(resolve=>{release=resolve;}); }});
  s.click(); const input = s.input(); input.dispatchEvent(new s.dom.window.CompositionEvent('compositionstart',{bubbles:true})); input.value='composing'; input.dispatchEvent(new s.dom.window.FocusEvent('blur'));
  s.element.dispatchEvent(new s.dom.window.Event('scroll')); s.dom.window.dispatchEvent(new s.dom.window.Event('resize'));
  input.dispatchEvent(new s.dom.window.CompositionEvent('compositionend',{bubbles:true})); input.value='確定した入力'; input.dispatchEvent(new s.dom.window.InputEvent('input',{bubbles:true,data:'確定した入力'}));
  assert.equal(s.dom.window.document.activeElement,input); await tick(); assert.equal(writes.length,1); assert.deepEqual(writes[0].value,baseExpressionValue('確定した入力')); assert.equal(input.disabled,true); assert.equal(s.element.dataset.baseEditing,'pending');
  release(); await tick(); assert.equal(s.element.dataset.baseEditing,undefined); assert.equal(s.element.textContent,'確定した入力'); s.close();
});

test('renewed focus or Escape cancels a deferred composing-blur finish without losing the draft', async () => {
  const s=setup('before',{type:'text'}); s.click(); const input=s.input(); input.dispatchEvent(new s.dom.window.CompositionEvent('compositionstart')); input.value='draft'; input.dispatchEvent(new s.dom.window.FocusEvent('blur')); input.dispatchEvent(new s.dom.window.CompositionEvent('compositionend'));
  input.dispatchEvent(new s.dom.window.FocusEvent('focus')); await tick(); assert.equal(s.edits.length,0); assert.equal(input.value,'draft'); assert.equal(s.element.dataset.baseEditing,'draft');
  input.dispatchEvent(new s.dom.window.CompositionEvent('compositionstart')); input.dispatchEvent(new s.dom.window.FocusEvent('blur')); input.dispatchEvent(new s.dom.window.CompositionEvent('compositionend')); s.key('Escape'); await tick(); assert.equal(s.edits.length,0); assert.equal(s.element.textContent,'before'); s.close();
});
