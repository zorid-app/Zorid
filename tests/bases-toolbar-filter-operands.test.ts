import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseFilterOperand } from '../src/bases/toolbar-filter-operands.ts';
import type { BaseFilterOperandKind, BaseFilterOperandsSnapshot } from '../src/bases/toolbar-filter-operands.ts';

const snapshot: BaseFilterOperandsSnapshot = {
  files: ['Books/Dune.md', 'Books/"Quoted".md', '<b>literal</b>.md'], folders: ['Books', 'Research/Work'],
  tags: ['#reading', '#work/project', 'with spaces'], properties: ['status', 'note.foo', 'say"hello'], metadataStatus: 'current',
};

function fixture(kind: BaseFilterOperandKind, values: readonly string[] = [], suggestions: BaseFilterOperandsSnapshot | null = snapshot) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true });
  const doc = dom.window.document, container = doc.querySelector('main')!;
  const changes: string[][] = [], drafts: string[][] = [];
  let alive = true;
  const control = createBaseFilterOperand(doc, container, { kind, values, snapshot: suggestions ?? undefined, onChange(value) { changes.push([...value]); }, onDraftChange() { drafts.push([...control.read()]); }, alive: () => alive });
  const input = doc.querySelector<HTMLInputElement>('[aria-label="Filter value"]')!;
  const type = (value: string) => { input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const key = (value: string, extra: KeyboardEventInit = {}) => { const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }); input.dispatchEvent(event); return event; };
  return { dom, doc, container, control, input, changes, drafts, type, key, retire() { alive = false; }, cleanup() { control.destroy(); dom.window.close(); } };
}

test('single file operand accepts searchable suggestions with pointer and preserves quoted literal values', () => {
  const f = fixture('file');
  try {
    f.control.focus(); assert.equal(f.doc.activeElement, f.input); assert.equal(f.input.getAttribute('aria-expanded'), 'true');
    f.type('"Quoted"');
    const option = f.doc.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(option.textContent, 'Books/"Quoted".md'); assert.equal(option.title, 'Books/"Quoted".md'); option.click();
    assert.deepEqual(f.control.read(), ['Books/"Quoted".md']); assert.deepEqual(f.changes.at(-1), ['Books/"Quoted".md']);
    assert.equal(f.input.getAttribute('aria-expanded'), 'false'); assert.equal(f.doc.activeElement, f.input);
    f.type('  unlisted "value" \\ with spaces  ');
    assert.deepEqual(f.control.read(), ['  unlisted "value" \\ with spaces  ']); assert.equal(f.control.hasDraft(), false);
    assert.match(f.doc.querySelector('[role="status"]')!.textContent!, /No matching suggestions/);
    f.type(''); assert.deepEqual(f.control.read(), []); assert.deepEqual(f.changes.at(-1), []);
  } finally { f.cleanup(); }
});

test('folder keyboard selection uses only folder suggestions and Escape closes one level', () => {
  const f = fixture('folder');
  try {
    let parentEscapes = 0; f.container.addEventListener('keydown', event => { if (event.key === 'Escape') parentEscapes++; });
    f.control.focus(); f.key('ArrowUp');
    assert.equal(f.doc.querySelector('.is-active')?.textContent, 'Research/Work');
    f.key('Enter'); assert.deepEqual(f.control.read(), ['Research/Work']);
    f.input.click(); const first = f.key('Escape');
    assert.equal(first.defaultPrevented, true); assert.equal(parentEscapes, 0); assert.equal(f.doc.activeElement, f.input);
    f.key('Escape'); assert.equal(parentEscapes, 1);
    f.input.click(); const tab = f.key('Tab'); assert.equal(tab.defaultPrevented, false); assert.equal(f.input.getAttribute('aria-expanded'), 'false');
  } finally { f.cleanup(); }
});

test('property keys remain literal, including note. prefixes and HTML-looking text', () => {
  const f = fixture('property');
  try {
    f.control.focus(); f.type('note.'); f.key('ArrowDown'); f.key('Enter');
    assert.deepEqual(f.control.read(), ['note.foo']);
    f.type('say"hello'); assert.deepEqual(f.changes.at(-1), ['say"hello']);
    f.type('<b>literal</b>'); assert.equal(f.doc.querySelector('b'), null); assert.deepEqual(f.control.read(), ['<b>literal</b>']);
  } finally { f.cleanup(); }
  const file = fixture('file');
  try { file.control.focus(); assert.equal(file.doc.querySelector('b'), null); assert.ok(Array.from(file.doc.querySelectorAll('[role="option"]')).some(row => row.textContent === '<b>literal</b>.md')); }
  finally { file.cleanup(); }
});

test('tag literals become chips only on Enter and retain pending text for validation', () => {
  const f = fixture('tag', ['#reading']);
  try {
    f.control.focus(); f.type('  #custom "quoted"  ');
    assert.equal(f.control.hasDraft(), true); assert.deepEqual(f.control.read(), ['#reading', '  #custom "quoted"  ']);
    assert.deepEqual(f.changes, []); assert.deepEqual(f.drafts.at(-1), ['#reading', '  #custom "quoted"  ']);
    f.key('Enter'); assert.equal(f.control.hasDraft(), false); assert.equal(f.input.value, '');
    assert.deepEqual(f.changes, [['#reading', '  #custom "quoted"  ']]);
    assert.equal(f.doc.querySelectorAll('.bases-filter-operand-chip').length, 2);
    f.type('   '); assert.equal(f.control.hasDraft(), false); assert.deepEqual(f.control.read(), ['#reading', '  #custom "quoted"  ']);
    f.type(''); f.key('Backspace'); assert.deepEqual(f.control.read(), ['#reading']); assert.deepEqual(f.changes.at(-1), ['#reading']);
  } finally { f.cleanup(); }
});

test('variadic tags select several suggestions and remove chips without changing other values', () => {
  const f = fixture('tag', ['#reading']);
  try {
    f.control.focus(); assert.ok(!Array.from(f.doc.querySelectorAll('[role="option"]')).some(row => row.textContent === '#reading'));
    f.type('work'); f.key('ArrowDown'); f.key('Enter'); assert.deepEqual(f.control.read(), ['#reading', '#work/project']);
    f.input.click(); f.type('spaces'); f.doc.querySelector<HTMLElement>('[role="option"]')!.click();
    assert.deepEqual(f.control.read(), ['#reading', '#work/project', 'with spaces']);
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Remove tag #work/project"]')!.click();
    assert.deepEqual(f.control.read(), ['#reading', 'with spaces']); assert.equal(f.doc.activeElement, f.input);
    f.type('#reading'); f.key('Enter'); assert.deepEqual(f.control.read(), ['#reading', 'with spaces']);
  } finally { f.cleanup(); }
});

test('incomplete snapshots show honest status even when cached suggestions match', () => {
  for (const status of ['pending', 'stale', 'unavailable'] as const) {
    const f = fixture('tag', [], { ...snapshot, metadataStatus: status });
    try {
      f.control.focus(); assert.ok(f.doc.querySelector('[role="option"]'));
      const message = f.doc.querySelector('[role="status"]')!.textContent!;
      assert.match(message, status === 'pending' ? /still loading/ : status === 'stale' ? /out of date/ : /unavailable/);
      f.type('unlisted'); assert.doesNotMatch(f.doc.querySelector('[role="status"]')!.textContent!, /No matching/);
      f.key('Enter'); assert.deepEqual(f.control.read(), ['unlisted']);
    } finally { f.cleanup(); }
  }
  const f = fixture('property', [], null);
  try { f.control.focus(); f.type('custom'); assert.match(f.doc.querySelector('[role="status"]')!.textContent!, /unavailable/); assert.deepEqual(f.control.read(), ['custom']); }
  finally { f.cleanup(); }
});

test('IME Enter cannot commit a pending tag and outside interaction dismisses suggestions', () => {
  const f = fixture('tag');
  try {
    f.control.focus(); f.type('composing'); f.key('Enter', { isComposing: true }); assert.equal(f.control.hasDraft(), true); assert.deepEqual(f.changes, []);
    f.doc.querySelector('#outside')!.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(f.input.getAttribute('aria-expanded'), 'false'); assert.equal(f.control.hasDraft(), true);
    f.key('Enter'); assert.deepEqual(f.changes, [['composing']]);
  } finally { f.cleanup(); }
});

test('retired or detached suggestion and chip callbacks cannot publish changes', () => {
  const f = fixture('tag', ['#reading']);
  try {
    f.control.focus(); const retiredOption = f.doc.querySelector<HTMLElement>('[role="option"]')!, retiredChip = f.doc.querySelector<HTMLButtonElement>('[aria-label="Remove tag #reading"]')!;
    f.type('work'); retiredOption.click(); assert.deepEqual(f.changes, []);
    f.key('Enter'); const count = f.changes.length; retiredChip.click(); assert.equal(f.changes.length, count);
    f.retire(); f.type('ignored'); f.key('Enter'); assert.equal(f.changes.length, count);
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Remove tag #reading"]')!.click(); assert.equal(f.changes.length, count);
  } finally { f.cleanup(); }
  const detached = fixture('file');
  try {
    detached.control.focus(); const row = detached.doc.querySelector<HTMLElement>('[role="option"]')!;
    detached.container.remove(); row.click(); detached.type('ignored'); detached.key('ArrowDown'); assert.deepEqual(detached.changes, []);
  } finally { detached.cleanup(); }
});

test('destroy removes open suggestions and leaves retained input and row callbacks inert', () => {
  const f = fixture('file');
  try {
    f.control.focus(); const row = f.doc.querySelector<HTMLElement>('[role="option"]')!;
    f.control.destroy(); f.control.destroy(); row.click(); f.type('ignored'); f.key('ArrowDown'); f.control.focus();
    assert.deepEqual(f.changes, []); assert.equal(f.doc.querySelector('[role="listbox"]'), null); assert.equal(f.doc.querySelector('[role="combobox"]'), null);
  } finally { f.cleanup(); }
});
