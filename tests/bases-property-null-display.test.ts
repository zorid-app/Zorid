import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import {BASE_NULL, BaseExpressionError, baseExpressionValue, baseValueToString} from '../src/bases/expression.ts';
import type {BaseExpressionValue} from '../src/bases/expression.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import {createSharedBaseValueProjector} from '../src/bases/shared-values.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {BaseBulkEditError} from '../src/bases/controller.ts';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {readProperties} from '../src/core/properties.ts';

function widget(value: BaseExpressionValue, definition?: BasePropertyDefinition) {
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true}), element = dom.window.document.querySelector('main')!;
  let writes = 0;
  const dispose = mountBasePropertyWidget(element, {row: {path: 'A.md', values: {'note.value': value}}, property: 'note.value', value, version: 1}, {
    getDefinition: () => definition, commit() { writes++; },
  });
  return {element, get writes() { return writes; }, close() { dispose(); dom.window.close(); }};
}

test('top-level shared Null is blank for scalar and picker properties without coercing or writing it', () => {
  const value = createSharedBaseValueProjector()({type: 'null'});
  assert.equal(value, BASE_NULL); assert.equal(baseValueToString(value), 'null', 'expression coercion is a separate contract');
  const types: BasePropertyDefinition['type'][] = ['text', 'number', 'date', 'datetime', 'list', 'tags', 'select', 'multiselect', 'status', 'link', 'relation'];
  for (const type of types) {
    const f = widget(value, {type}); try {
      assert.equal(f.element.textContent, '', type + ' Null has no literal text');
      assert.equal(f.element.querySelector('.multi-select-pill,.internal-link,.bases-property-date-display'), null, type + ' Null creates no invented value');
      assert.equal(f.writes, 0);
    } finally { f.close(); }
  }
  const inferred = widget(baseExpressionValue(undefined)); try { assert.equal(inferred.element.textContent, '', 'missing property follows the same empty presentation'); assert.equal(inferred.writes, 0); } finally { inferred.close(); }
});

test('Null checkbox keeps its existing indeterminate control rather than becoming text', () => {
  const f = widget(BASE_NULL, {type: 'checkbox'}); try {
    const checkbox = f.element.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    assert.ok(checkbox); assert.equal(checkbox.indeterminate, true); assert.equal(checkbox.checked, false); assert.equal(f.element.textContent, ''); assert.equal(f.writes, 0);
  } finally { f.close(); }
});

test('literal null strings, nested values, zero, false, errors and dates keep their existing presentation', () => {
  const cases: [BaseExpressionValue, BasePropertyDefinition, string][] = [
    [baseExpressionValue('null'), {type: 'text'}, 'null'],
    [baseExpressionValue([null, 'null', 0, false]), {type: 'list'}, 'null, null, 0, false'],
    [baseExpressionValue({empty: null}), {type: 'text'}, '{"empty":"null"}'],
    [baseExpressionValue(0), {type: 'number'}, '0'],
    [baseExpressionValue(false), {type: 'text'}, 'false'],
    [{type: 'error', error: new BaseExpressionError('type', 'Keep this error')}, {type: 'number'}, 'Keep this error'],
  ];
  for (const [value, definition, expected] of cases) {
    const f = widget(value, definition); try { assert.equal(f.element.textContent, expected); assert.equal(f.writes, 0); } finally { f.close(); }
  }
  const checked = widget(baseExpressionValue(false), {type: 'checkbox'}); try { const input = checked.element.querySelector<HTMLInputElement>('input')!; assert.equal(input.checked, false); assert.equal(input.indeterminate, false); } finally { checked.close(); }
  const date = widget({type: 'date', timestamp: Date.parse('2026-10-22T00:00:00Z'), hasTime: false, presentationTimezone: 'UTC'}, {type: 'date'});
  try { const input = date.element.querySelector<HTMLInputElement>('input[type=date]')!; assert.ok(input); assert.equal(input.value, '2026-10-22'); assert.equal(date.writes, 0); } finally { date.close(); }
});

const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(check()); };

/** Normal session/controller/shared-buffer composition on the explicit legacy
 * MemoryAdapter. The actual native failure remains separate runtime evidence. */
test('real BaseSession partial clear publishes a blank Null cell for the saved prefix and retains the failed shared draft', async () => {
  const originalA = '---\nscore: 7\nuntouched: keep-A\n---\nA body 😀\n';
  const originalB = '---\nscore: 2\nuntouched: keep-B\n---\nB body\n';
  class Adapter extends MemoryAdapter { failB = false; override async write(path: string, text: string) { if (path === 'B.md' && this.failB) throw Error('B fixture write failed'); await super.write(path, text); } }
  const adapter = new Adapter({'Work.base': 'filters: file.ext == "md"\nviews:\n  - type: table\n    name: Main\n    order: [file.name, score]\n    sort: [{property: file.name, direction: ASC}]\n', 'Properties.yaml': 'properties:\n  score: {type: number}\n', 'A.md': originalA, 'B.md': originalB});
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true}), host = dom.window.document.querySelector('main')!;
  const buffers = new Map<string, NoteBuffer>(), errors: unknown[] = [];
  const getBuffer = async (path: string) => { let buffer = buffers.get(path); if (!buffer) { buffer = new NoteBuffer(vault, path, {debounceMs: 60000}); buffers.set(path, buffer); } await buffer.load(); return buffer; };
  const session = createBaseSession(host, {vault, basePath: 'Work.base', buffers: {getBuffer, validate() {}}, validate() {}, openFile() {}, onError(error) { errors.push(error); }});
  const cell = (path: string) => host.querySelector<HTMLElement>(`[role=gridcell][data-path="${path}"][data-property="note.score"]`)!;
  const key = (node: Element, value: string, extra: KeyboardEventInit = {}) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: value, bubbles: true, cancelable: true, ...extra}));
  try {
    await session.ready; assert.equal(cell('A.md').textContent, '7'); assert.equal(cell('B.md').textContent, '2');
    const retained = await getBuffer('B.md'); retained.update(originalB + 'Retained B draft\n'); adapter.failB = true;
    cell('A.md').click(); key(cell('A.md').querySelector('input')!, 'Escape'); key(cell('A.md'), 'ArrowDown', {shiftKey: true}); key(cell('A.md'), 'Delete');
    await wait(() => errors.some(error => error instanceof BaseBulkEditError));
    const failure = errors.find(error => error instanceof BaseBulkEditError) as BaseBulkEditError;
    assert.deepEqual(failure.completedPaths, ['A.md']); assert.equal(failure.failedPath, 'B.md');
    await session.refresh(); await wait(() => host.querySelector('.bases-session-content')?.getAttribute('aria-busy') === 'false');
    const published = session.state.result!.rows.find(row => row.path === 'A.md')!; assert.equal(published.values['note.score'].type, 'null');
    assert.equal(readProperties(await vault.read('A.md')).find(item => item.key === 'score')!.value, null);
    assert.equal(await vault.read('A.md'), originalA.replace('score: 7', 'score: null'));
    assert.equal(await vault.read('B.md'), originalB); assert.match(retained.text, /Retained B draft/); assert.equal(retained.dirty, true);
    assert.equal(cell('A.md').textContent, '', 'the rich number widget must show the actually saved Null as empty before history');
    assert.equal(cell('B.md').textContent, '2', 'failed row remains the saved value');
  } finally {
    adapter.failB = false; await session.close(); for (const buffer of buffers.values()) await buffer.dispose(); dom.window.close();
  }
});
