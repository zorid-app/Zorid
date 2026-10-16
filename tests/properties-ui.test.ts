import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderProperties } from '../src/ui/properties.ts';
import { readProperties } from '../src/core/properties.ts';

function setup(initial: string, onChange?: (next: string) => Promise<void> | void) {
  const dom = new JSDOM('<!doctype html><div id="properties"></div>');
  const container = dom.window.document.getElementById('properties')!;
  let source = initial;
  const writes: string[] = [], links: string[] = [];
  const view = renderProperties(container, {
    getSource: () => source,
    onChange: async next => { writes.push(next); source = next; await onChange?.(next); },
    openLink: target => links.push(target),
  });
  const control = <T extends HTMLElement = HTMLInputElement>(label: string): T => {
    const result = [...container.querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === label);
    assert.ok(result, `Missing control: ${label}`); return result as T;
  };
  const click = (label: string) => {
    const result = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
    assert.ok(result, `Missing button: ${label}`); result.click();
  };
  const change = (label: string, value: string) => {
    const input = control<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(label);
    input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return { dom, container, view, writes, links, control, click, change, settle,
    get source() { return source; }, set source(value: string) { source = value; },
    values: () => Object.fromEntries(readProperties(source).map(property => [property.key, property.value])),
    close: () => { view.destroy(); dom.window.close(); },
  };
}

test('property values commit against latest body text while retaining input focus and selection', async () => {
  const ui = setup('---\ntitle: Original\ncount: 2\n---\n# Original body');
  assert.deepEqual([...ui.container.querySelectorAll('.metadata-property')].map(row => (row as HTMLElement).dataset.propertyKey), ['title', 'count']);
  const input = ui.control('title value'); input.focus(); input.value = 'Changed'; input.setSelectionRange(2, 4);
  input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  ui.source = ui.source.replace('# Original body', '# Newer unsaved body 🌱');
  input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  await ui.settle();
  assert.equal(ui.values().title, 'Changed');
  assert.ok(ui.source.endsWith('# Newer unsaved body 🌱'));
  assert.equal(ui.dom.window.document.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
  ui.close();
});

test('add, rename, remove and explicit scalar type conversion edit ordered properties', async () => {
  const ui = setup('---\nfirst: "2"\nsecond: keep\n---\nBody');
  ui.change('first type', 'number'); await ui.settle();
  assert.equal(ui.values().first, 2);
  ui.change('second name', 'renamed'); await ui.settle();
  assert.deepEqual(readProperties(ui.source).map(property => property.key), ['first', 'renamed']);
  ui.change('renamed value', 'edited'); await ui.settle();
  assert.equal(ui.values().renamed, 'edited');
  ui.click('Add property'); ui.change('New property name', 'done'); ui.change('New property type', 'checkbox'); ui.click('Add'); await ui.settle();
  assert.equal(ui.values().done, null);
  const checkbox = ui.control('done value'); checkbox.checked = true; checkbox.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true })); await ui.settle();
  assert.equal(ui.values().done, true);
  // Removal labels must follow a renamed property too.
  ui.click('Remove renamed'); await ui.settle();
  assert.deepEqual(readProperties(ui.source).map(property => property.key), ['first', 'done']);
  ui.close();
});

test('invalid number and date values show errors and keep drafts without writing', async () => {
  const ui = setup('---\ncount: 2\ndate: 2024-02-29\n---\nBody');
  ui.change('count value', 'not a number'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(ui.values().count, 2);
  assert.equal(ui.control('count value').value, 'not a number');
  assert.match(ui.container.textContent!, /finite numbers|Invalid value/);
  ui.change('date value', '2026-02-29'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.match(ui.container.textContent!, /Invalid value for property type date/);
  ui.change('count value', '2.5'); await ui.settle();
  assert.equal(ui.values().count, 2.5);
  ui.close();
});

test('queued commits preserve intervening body edits and previous property changes', async () => {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  let count = 0;
  const ui = setup('---\none: old\ntwo: old\n---\nBody', async () => { if (++count === 1) { began(); await gate; } });
  ui.change('one value', 'first'); await started;
  ui.change('two value', 'second');
  ui.source = ui.source.replace('\nBody', '\nNewer body');
  release(); await ui.settle();
  assert.equal(ui.writes.length, 2);
  assert.deepEqual(ui.values(), { one: 'first', two: 'second' });
  assert.ok(ui.source.endsWith('Newer body'));
  ui.close();
});

test('background refresh preserves active drafts and updates unfocused fields', async () => {
  const ui = setup('---\ntitle: old\nother: old\n---\nBody');
  const input = ui.control('title value'); input.focus(); input.value = 'local draft';
  input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  ui.source = '---\ntitle: external\nother: updated\n---\nNewer body'; ui.view.refresh();
  assert.equal(ui.control('title value'), input); assert.equal(input.value, 'local draft');
  assert.equal(ui.control('other value').value, 'updated');
  input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true })); await ui.settle();
  assert.deepEqual(ui.values(), { title: 'local draft', other: 'updated' });
  assert.ok(ui.source.endsWith('Newer body'));
  ui.close();
});

test('finishing a slow save does not erase a newer invalid draft when the field loses focus', async () => {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const ui = setup('---\ncount: 1\n---\nBody', async () => { began(); await gate; });
  const input = ui.control('count value'); input.focus(); ui.change('count value', '2'); await started;
  input.value = 'unfinished'; input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  release(); await ui.settle();
  input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true })); input.blur(); await ui.settle(); ui.view.refresh();
  assert.equal(ui.control('count value').value, 'unfinished');
  assert.equal(ui.values().count, 2); assert.equal(ui.writes.length, 1);
  ui.close();
});

test('consecutive edits to one list item during a save are serialized without false external conflicts', async () => {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  let count = 0;
  const ui = setup('---\nitems: [one]\n---\nBody', async () => { if (++count === 1) { began(); await gate; } });
  const input = ui.control('items item 1'); input.focus(); ui.change('items item 1', 'first'); await started;
  ui.change('items item 1', 'second'); release(); await ui.settle();
  assert.deepEqual(ui.values().items, ['second']); assert.equal(ui.writes.length, 2);
  assert.doesNotMatch(ui.container.textContent!, /outside/);
  ui.close();
});

test('list and tag controls preserve commas and multiline items and support add/edit/remove', async () => {
  const ui = setup('---\nlist: ["one, two", "line one\\nline two"]\ntags: old\n---\nBody');
  assert.equal(ui.control('list item 1').value, 'one, two');
  assert.equal(ui.control('list item 2').value, 'line one\nline two');
  ui.change('list item 1', 'comma, stays'); await ui.settle();
  assert.deepEqual(ui.values().list, ['comma, stays', 'line one\nline two']);
  const add = ui.control('Add list value'); add.focus(); add.value = 'new'; add.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  add.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await ui.settle();
  assert.deepEqual(ui.values().list, ['comma, stays', 'line one\nline two', 'new']);
  assert.equal(ui.dom.window.document.activeElement?.getAttribute('aria-label'), 'Add list value');
  ui.click('Remove list item 2'); await ui.settle();
  assert.deepEqual(ui.values().list, ['comma, stays', 'new']);
  ui.change('tags item 1', 'nested/tag'); await ui.settle();
  assert.deepEqual(ui.values().tags, ['nested/tag']);
  ui.close();
});

test('nested properties edit as JSON and incompatible conversions do not discard data', async () => {
  const ui = setup('---\nconfig:\n  enabled: true\n  nested: [one, two]\n---\nBody');
  ui.change('config type', 'text'); await ui.settle();
  assert.equal(ui.writes.length, 0);
  assert.deepEqual(ui.values().config, { enabled: true, nested: ['one', 'two'] });
  assert.equal(ui.control<HTMLSelectElement>('config type').value, 'unknown');
  ui.change('config value', '{broken'); await ui.settle();
  assert.equal(ui.writes.length, 0);
  ui.change('config value', '{"enabled":false,"nested":[1,null]}'); await ui.settle();
  assert.deepEqual(ui.values().config, { enabled: false, nested: [1, null] });
  ui.close();
});

test('malformed YAML and failed persistence expose errors without losing edited input', async () => {
  const invalid = setup('---\ntitle: [broken\n---\nBody');
  assert.equal(invalid.container.querySelector<HTMLButtonElement>('.metadata-add-button')!.disabled, true);
  assert.match(invalid.container.querySelector('.metadata-error')!.textContent!, /Invalid/);
  assert.equal(invalid.writes.length, 0); invalid.close();
  const ui = setup('---\ntitle: old\n---\nBody', () => { throw new Error('disk full'); });
  ui.change('title value', 'recovery draft'); await ui.settle();
  assert.match(ui.container.textContent!, /disk full/);
  assert.equal(ui.control('title value').value, 'recovery draft');
  ui.close();
});

test('wiki link control opens the target and destruction prevents queued mutations', async () => {
  const ui = setup('---\nrelated: "[[Folder/Note#Heading|Label]]"\n---\nBody');
  ui.click('Open link'); assert.deepEqual(ui.links, ['Folder/Note#Heading']);
  ui.change('related value', 'new'); ui.view.destroy(); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(ui.container.children.length, 0);
  ui.view.refresh(); assert.equal(ui.container.children.length, 0);
  ui.close();
});
