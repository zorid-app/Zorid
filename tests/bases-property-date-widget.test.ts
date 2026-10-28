import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyWidgetOptions} from '../src/bases/property-widgets.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));
function fixture(raw: string, datetime = true) {
  const dom = new JSDOM('<div tabindex="0"></div><button>Outside</button>', {pretendToBeVisual: true});
  const doc = dom.window.document, element = doc.querySelector('div')!, outside = doc.querySelector('button')!;
  const edits: Parameters<BasePropertyWidgetOptions['commit']>[0][] = [];
  const dispose = mountBasePropertyWidget(element, {
    row: {path: 'Date.md', values: {}}, property: 'note.when', value: {type: 'string', value: raw}, version: 1,
  }, {getDefinition: () => ({type: datetime ? 'datetime' : 'date'}), commit: edit => {edits.push(edit);}});
  const open = () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, cancelable: true}));
    const input = element.querySelector<HTMLInputElement>('input.metadata-input')!;
    assert.ok(input);
    return input;
  };
  const key = (input: HTMLInputElement, key: string) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
  return {dom, doc, element, outside, edits, open, key, close() {dispose(); dom.window.close();}};
}

for (const raw of [
  '2026-01-01T12:30:00.123456789',
  '2026-01-01T12:30:00-05:00',
  '2026-01-01T12:30:00',
]) {
  test(`untouched Enter preserves exact date-time spelling: ${raw}`, async () => {
    const f = fixture(raw);
    try {
      const input = f.open();
      assert.equal(input.value, raw);
      f.key(input, 'Enter');
      await tick();
      assert.deepEqual(f.edits, []);
      assert.equal(f.element.dataset.baseEditing, undefined);
    } finally {f.close();}
  });
  test(`untouched blur preserves exact date-time spelling and outside focus: ${raw}`, async () => {
    const f = fixture(raw);
    try {
      const input = f.open();
      assert.equal(input.value, raw);
      f.outside.focus();
      await tick();
      assert.deepEqual(f.edits, []);
      assert.equal(f.element.dataset.baseEditing, undefined);
      assert.equal(f.doc.activeElement, f.outside);
    } finally {f.close();}
  });
}

test('explicit date-time change remains a parsed literal and saves once', async () => {
  const f = fixture('2026-01-01T12:30:00.123456789');
  try {
    const input = f.open(), changed = '2026-01-02T14:45:00.987654321+09:00';
    input.value = changed;
    input.dispatchEvent(new f.dom.window.Event('input', {bubbles: true}));
    f.key(input, 'Enter');
    await tick();
    assert.equal(f.edits.length, 1);
    assert.deepEqual(f.edits[0].value, {type: 'string', value: changed});
    assert.equal(f.element.dataset.baseEditing, undefined);
  } finally {f.close();}
});

test('explicit native date change remains parsed and saves once', async () => {
  const f = fixture('2026-01-01', false);
  try {
    const input = f.open();
    assert.equal(input.type, 'date');
    input.value = '2026-02-27';
    f.key(input, 'Enter');
    await tick();
    assert.equal(f.edits.length, 1);
    assert.deepEqual(f.edits[0].value, {type: 'string', value: '2026-02-27'});
  } finally {f.close();}
});

test('invalid explicit date-time input retains the exact draft without a mutation', async () => {
  const f = fixture('2026-01-01T12:30:00.123456789');
  try {
    const input = f.open();
    input.value = '2026-02-30T14:45';
    f.key(input, 'Enter');
    await tick();
    assert.deepEqual(f.edits, []);
    assert.equal(f.element.dataset.baseEditing, 'draft');
    assert.equal(input.value, '2026-02-30T14:45');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
  } finally {f.close();}
});
