import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createBaseListView} from '../src/bases/list-view.ts';
import {baseExpressionValue as value} from '../src/bases/expression.ts';
import type {BaseQueryResult} from '../src/bases/query.ts';
function setup() {
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true}), container = dom.window.document.querySelector('main')!;
  const row = {path: 'Items/Alpha.md', entryId: 'alpha', revision: 'r1', values: {'file.name': value('Alpha'), 'file.file': value('Items/Alpha.md'), 'note.rank': value(1)}};
  const result: BaseQueryResult = {version: 1, view: {type: 'list', name: 'List'}, rows: [row], groups: [{key: null, rows: [row]}], groupOptions: [], properties: ['file.name', 'file.file', 'note.rank'], availableProperties: [], counts: {scanned: 1, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1}, diagnostics: []};
  const drag = (target: Element) => { const event = new dom.window.Event('dragstart', {bubbles: true, cancelable: true}); const data = new Map<string, string>(); Object.defineProperty(event, 'dataTransfer', {value: {setData(type: string, text: string) {data.set(type, text);}}}); target.dispatchEvent(event); return {event, data}; };
  return {dom, container, result, drag};
}
test('List direct file properties delegate exact captured row to the file drag host; ordinary values do not', () => {
  const {dom, container, result, drag} = setup(), rows: unknown[] = [];
  const view = createBaseListView(container, {result, openFile() {}, dragFile(row, event) {rows.push(row); event.dataTransfer!.setData('text/plain', `[[${row.path.replace(/\.md$/, '')}]]`);}});
  for (const property of ['file.name', 'file.file']) {
    const element = container.querySelector<HTMLElement>(`[data-property="${property}"]`)!; assert.equal(element.draggable, true);
    assert.deepEqual([...drag(element.querySelector('a')!).data], [['text/plain', '[[Items/Alpha]]']]);
  }
  assert.deepEqual(rows, [result.rows[0], result.rows[0]]); drag(container.querySelector('[data-property="note.rank"]')!); assert.equal(rows.length, 2);
  view.destroy(); dom.window.close();
});
test('List file dragging preserves selected text and widget input ownership', () => {
  const {dom, container, result, drag} = setup(); let calls = 0;
  const view = createBaseListView(container, {result, openFile() {}, dragFile() {calls++;}});
  const link = container.querySelector('a')!, range = dom.window.document.createRange(); range.selectNodeContents(link); dom.window.getSelection()!.addRange(range);
  assert.equal(drag(link).event.defaultPrevented, false); assert.equal(calls, 0); dom.window.getSelection()!.removeAllRanges();
  const input = dom.window.document.createElement('input'); container.querySelector('[data-property="file.name"]')!.append(input);
  assert.equal(drag(input).event.defaultPrevented, false); assert.equal(calls, 0);
  view.destroy(); dom.window.close();
});
test('retired file drag sources are inert after query replacement and disposal', () => {
  const {dom, container, result, drag} = setup(); let calls = 0;
  const view = createBaseListView(container, {result, openFile() {}, dragFile() {calls++;}});
  const old = container.querySelector('a')!; view.update({...result, version: 2}); assert.equal(drag(old).event.defaultPrevented, true); assert.equal(calls, 0);
  const current = container.querySelector('a')!; view.destroy(); assert.equal(drag(current).event.defaultPrevented, true); assert.equal(calls, 0); dom.window.close();
});
test('drag hook leaves modifier and middle-click file opening ownership unchanged', () => {
  const {dom, container, result} = setup(); const opened: unknown[] = [];
  const view = createBaseListView(container, {result, dragFile() {}, openFile(path, event, witness) {opened.push({path, event, witness});}});
  const link = container.querySelector('a')!, modified = new dom.window.MouseEvent('click', {bubbles: true, cancelable: true, metaKey: true}), middle = new dom.window.MouseEvent('auxclick', {bubbles: true, cancelable: true, button: 1});
  link.dispatchEvent(modified); link.dispatchEvent(middle);
  assert.deepEqual(opened, [modified, middle].map(event => ({path: 'Items/Alpha.md', event, witness: {entryId: 'alpha', revision: 'r1'}})));
  view.destroy(); dom.window.close();
});

test('an enclosing list-row text selection owns dragging its filename', () => {
  const {dom, container, result, drag} = setup(); let calls = 0;
  const view = createBaseListView(container, {result, openFile() {}, dragFile() {calls++;}});
  const range = dom.window.document.createRange(); range.selectNodeContents(container.querySelector('.bases-list-item-properties')!); dom.window.getSelection()!.addRange(range);
  assert.equal(drag(container.querySelector('a')!).event.defaultPrevented, false); assert.equal(calls, 0);
  view.destroy(); dom.window.close();
});
test('disconnecting a file property directly invalidates its retained native drag source', () => {
  const {dom, container, result, drag} = setup(); let calls = 0;
  const view = createBaseListView(container, {result, openFile() {}, dragFile() {calls++;}});
  const value = container.querySelector('[data-property="file.name"]')!, link = value.querySelector('a')!; value.remove();
  assert.equal(drag(link).event.defaultPrevented, true); assert.equal(calls, 0); view.destroy(); dom.window.close();
});
