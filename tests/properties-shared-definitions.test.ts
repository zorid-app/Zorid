import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderProperties } from '../src/ui/properties.ts';
import { readProperties } from '../src/core/properties.ts';
import type { Vault } from '../src/core/vault.ts';
import type { VaultEvent, VaultChange } from '../src/core/types.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup(initial = '---\ntopics: [Legacy]\nstatus: Todo\n---\nOriginal body') {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }); const container = dom.window.document.querySelector('main')!;
  let source = initial, definitions = 'properties:\n  topics:\n    type: multiselect\n    options:\n      - value: Rust\n        color: orange\n  status:\n    type: status\n    options:\n      - value: Todo\n        category: todo\n      - value: Done\n        category: done\n';
  const listeners = new Map<string, Set<(change: VaultChange) => void>>(); let writes = 0;
  const vault = { entries: new Map([['Properties.yaml', { path: 'Properties.yaml', type: 'file' }]]), read: async () => definitions,
    on: (event: VaultEvent, callback: (change: VaultChange) => void) => { const set = listeners.get(event) ?? new Set(); listeners.set(event, set); set.add(callback); return () => set.delete(callback); },
  } as unknown as Vault;
  const changes: unknown[] = [];
  const view = renderProperties(container, { vault, path: 'Books/A.md', getSource: () => source,
    onChange: next => { writes++; source = next; }, onPropertyDefinitionChange: (property, definition) => { changes.push({ property, definition }); },
  });
  return { dom, container, view, changes, listeners, get writes() { return writes; }, get source() { return source; }, set source(next: string) { source = next; },
    setDefinitions(next: string) { definitions = next; for (const listener of listeners.get('modify') ?? []) listener({ path: 'Properties.yaml' }); },
    property: (name: string) => container.querySelector<HTMLElement>(`[data-property-key="${name}"] .metadata-property-value`)!,
    values: () => Object.fromEntries(readProperties(source).map(p => [p.key, p.value])),
    close: () => { view.destroy(); dom.window.close(); },
  };
}

test('ordinary note panel uses same rich widgets and commits into latest unsaved body', async () => {
  const s = setup(); await tick(); const field = s.property('topics'); assert.equal(field.dataset.propertyType, 'multiselect'); assert.ok(field.querySelector('.is-unknown'));
  field.click(); const input = s.dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  input.value = 'Rust'; input.dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  s.source = s.source.replace('Original body', 'Newer unsaved body 🌱'); input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick();
  assert.deepEqual(s.values().topics, ['Legacy', 'Rust']); assert.ok(s.source.endsWith('Newer unsaved body 🌱')); s.close();
});

test('external changes and definition refresh preserve draft; stale property commit is rejected', async () => {
  const s = setup(); await tick(); const field = s.property('topics'); field.click(); const input = s.dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  input.value = 'Rust'; input.dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  s.source = s.source.replace('[Legacy]', '[External]'); s.setDefinitions('properties:\n  topics:\n    type: text\n'); await tick(); assert.equal(field.dataset.baseEditing, 'draft'); assert.ok(s.dom.window.document.querySelector('.bases-property-popover'));
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); assert.equal(s.writes, 0); assert.match(s.container.textContent!, /changed outside|definition changed/); assert.equal(field.dataset.baseEditing, 'draft'); s.close();
});

test('shared value-type choice changes only definition, never coerces existing note values', async () => {
  const s = setup(); await tick(); const selector = s.container.querySelector<HTMLSelectElement>('[aria-label="status type"]')!;
  selector.value = 'number'; selector.dispatchEvent(new s.dom.window.Event('change', { bubbles: true })); await tick();
  assert.equal(s.writes, 0); assert.deepEqual(s.changes, [{ property: 'status', definition: { type: 'number', options: [{ value: 'Todo', category: 'todo' }, { value: 'Done', category: 'done' }] } }]); assert.equal(s.values().status, 'Todo');
  s.close(); assert.equal([...s.listeners.values()].reduce((total, set) => total + set.size, 0), 0);
});

test('opening missing or incompatible list/date fields without edits never changes data', async () => {
  const s = setup('---\ntopics:\nstatus: Todo\n---\nBody'); await tick(); const field = s.property('topics'); field.click(); const input = s.dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); assert.equal(s.writes, 0); assert.equal(s.values().topics, null); s.close();
});


test('an active ordinary-note editor cannot save through a changed property definition', async () => {
  const s = setup('---\ntopics: [Legacy]\nstatus: Todo\n---\nBody'); await tick(); const field = s.property('status'); field.click();
  const input = s.dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!; input.value = 'Done'; input.dispatchEvent(new s.dom.window.Event('input', { bubbles: true }));
  s.setDefinitions('properties:\n  status:\n    type: rollup\n    rollup: {relation: project, aggregation: count}\n  project:\n    type: relation\n'); await tick();
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); assert.equal(s.writes, 0); assert.equal(s.values().status, 'Todo'); assert.equal(field.dataset.baseEditing, 'draft'); assert.match(s.container.textContent!, /definition changed/); s.close();
});
