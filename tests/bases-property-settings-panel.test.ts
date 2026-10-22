import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBasePropertySettingsPanel } from '../src/bases/property-settings-panel.ts';
import type { BasePropertyDefinition } from '../src/bases/property-definitions.ts';

test('property settings retain drafts, edit option labels/colors and save a reusable definition', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document;
  let saved: { property: string; definition: BasePropertyDefinition | null } | undefined;
  const panel = createBasePropertySettingsPanel(doc.querySelector('main')!, {
    definitions: () => ({ properties: { status: { type: 'status', options: [{ value: 'Todo', category: 'todo' }] } }, diagnostics: [] }),
    properties: () => ['note.status'], preflight() {}, onDraftChange() {}, onError(error) { throw error; },
    async save(property, definition) { saved = { property, definition }; },
  });
  try {
    panel.open('note.status');
    assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="Stored option value"]')!.value, 'Todo');
    const label = doc.querySelector<HTMLInputElement>('[aria-label="Option label"]')!;
    label.value = 'To do'; label.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(panel.hasDraft(), true);
    const color = doc.querySelector<HTMLSelectElement>('[aria-label="Option color"]')!;
    color.value = 'blue'; color.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(saved?.property, 'status');
    assert.deepEqual(saved?.definition?.options, [{ value: 'Todo', label: 'To do', color: 'blue', category: 'todo' }]);
    assert.equal(panel.hasDraft(), false);
    assert.equal(doc.querySelector('[role="dialog"]'), null);
  } finally { panel.destroy(); dom.window.close(); }
});

test('failed property settings save preserves the exact form for recovery', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), doc = dom.window.document;
  const panel = createBasePropertySettingsPanel(doc.querySelector('main')!, {
    definitions: () => ({ properties: {}, diagnostics: [] }), properties: () => [],
    preflight() {}, onDraftChange() {}, onError() {}, async save() { throw new Error('Disk unavailable'); },
  });
  try {
    panel.open('authors');
    const type = doc.querySelector<HTMLSelectElement>('[aria-label="Property type"]')!; type.value = 'relation'; type.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const filter = doc.querySelector<HTMLInputElement>('[aria-label="Target filter"]')!; filter.value = 'type == "author"'; filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(panel.hasDraft(), true);
    assert.equal(filter.isConnected, true);
    assert.equal(filter.value, 'type == "author"');
    assert.equal(doc.querySelector('[role="alert"]')!.textContent, 'Disk unavailable');
  } finally { panel.destroy(); dom.window.close(); }
});
