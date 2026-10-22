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
    getDefinition: () => definition, commit: edit => { edits.push(edit); }, ...rest,
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
  s.click(); assert.ok(s.dom.window.document.querySelector('.bases-property-popover')); s.dispose(); assert.equal(s.dom.window.document.querySelector('.bases-property-popover'), null); assert.equal(s.element.dataset.baseEditing, undefined); s.close();
});

test('relation picker uses supplied resolved targets and preserves a dangling existing link', async () => {
  const s = setup('[[Missing]]', { type: 'relation' }, { getRelationTargets: () => [{ path: 'Projects/Alpha.md', label: 'Alpha', entryId: 'alpha-1' }] });
  assert.ok(s.element.querySelector('.is-unresolved')); s.click(); s.input().value = 'Alpha'; s.input().dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); s.key('Enter'); await tick(); assert.deepEqual(s.edits.at(-1)?.value, baseExpressionValue('[[Projects/Alpha]]')); s.close();
});

test('invalid number input remains a visible draft instead of converting silently', async () => {
  const s = setup('excellent', { type: 'number' }); assert.ok(s.element.classList.contains('mod-error')); s.click(); s.key('Enter'); await tick(); assert.equal(s.edits.length, 0);
  s.click(); s.input().value = '0xF'; s.key('Enter'); await tick(); assert.equal(s.element.dataset.baseEditing, 'draft'); assert.equal(s.edits.length, 0); s.key('Escape'); assert.equal(s.element.textContent, 'excellent'); s.close();
});
