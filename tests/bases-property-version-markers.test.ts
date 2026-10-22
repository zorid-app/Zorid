import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';

test('widget version marker follows only its captured presentation and own acknowledged baseline', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), element = dom.window.document.querySelector<HTMLElement>('main')!;
  const row = { path: 'One.md', values: { 'note.score': { type: 'number' as const, value: 1 } } };
  const dispose = mountBasePropertyWidget(element, { row, property: 'note.score', value: row.values['note.score'], version: 10 }, {
    getDefinition: () => ({ type: 'number' }),
    commit: edit => ({ version: 11, row: { ...row, values: { 'note.score': edit.value } }, value: edit.value }),
  });
  assert.equal(element.dataset.baseWidgetVersion, '10'); element.click();
  const input = element.querySelector('input')!; input.value = '5'; assert.equal(element.dataset.baseWidgetVersion, '10');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(element.dataset.baseWidgetVersion, '11'); dispose(); assert.equal(element.dataset.baseWidgetVersion, undefined); dom.window.close();
});

test('a late acknowledged write cannot restore a disposed widget marker', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), element = dom.window.document.querySelector<HTMLElement>('main')!;
  const row = { path: 'One.md', values: { 'note.score': { type: 'number' as const, value: 1 } } };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const dispose = mountBasePropertyWidget(element, { row, property: 'note.score', value: row.values['note.score'], version: 10 }, {
    getDefinition: () => ({ type: 'number' }), commit: async edit => { await gate; return { version: 11, row, value: edit.value }; },
  });
  element.click(); const input = element.querySelector('input')!; input.value = '5'; input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  dispose(); release(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(element.dataset.baseWidgetVersion, undefined); dom.window.close();
});
