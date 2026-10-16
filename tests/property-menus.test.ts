import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderProperties } from '../src/ui/properties.ts';
import { readProperties, setProperty } from '../src/core/properties.ts';
import type { ContextMenuItem } from '../src/platform/context-menu.ts';
import type { PropertiesOptions } from '../src/ui/properties.ts';

function setup(initial: string, extra: Partial<PropertiesOptions> = {}) {
  const dom = new JSDOM('<!doctype html><div id="host"></div><button id="other">Other</button>');
  const document = dom.window.document, host = document.getElementById('host')!;
  let source = initial, current = true;
  let menu: ContextMenuItem[] = [], resolve: (id: string | null) => void = () => {}, reject: (error: unknown) => void = () => {};
  const writes: string[] = [], copied: string[] = [], errors: unknown[] = [], documents: Document[] = [];
  let dismissed = 0;
  const view = renderProperties(host, {
    getSource: () => source,
    onChange: next => { writes.push(next); source = next; },
    isCurrent: () => current,
    onError: error => errors.push(error),
    showMenu: (event, items, options) => { event.preventDefault?.(); event.stopPropagation?.(); menu = items; documents.push(options!.document!); return new Promise((yes, no) => { resolve = yes; reject = no; }); },
    dismissMenu: async doc => { assert.equal(doc, document); dismissed++; resolve(null); },
    writeClipboard: async text => { copied.push(text); }, ...extra,
  });
  const row = (key: string) => [...host.querySelectorAll<HTMLElement>('.metadata-property')].find(row => row.dataset.propertyKey === key)!;
  const open = (target: Element) => { const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 17, clientY: 23 }); target.dispatchEvent(event); return event; };
  const settle = () => new Promise<void>(done => setImmediate(done));
  return { dom, document, host, view, row, open, settle, writes, copied, errors, documents,
    select: (id: string) => resolve(id), fail: (error: unknown) => reject(error),
    get menu() { return menu; }, get source() { return source; }, set source(value: string) { source = value; },
    get dismissed() { return dismissed; }, set current(value: boolean) { current = value; },
    close: () => { view.destroy(); dom.window.close(); },
  };
}
const labels = (items: ContextMenuItem[]): string[] => items.map(item => 'type' in item ? '---' : item.label ?? ('role' in item ? item.role : ''));
const submenu = (items: ContextMenuItem[], label: string) => {
  const item = items.find(item => 'submenu' in item && item.label === label);
  assert.ok(item && 'submenu' in item); return item.submenu;
};
const action = (items: ContextMenuItem[], id: string) => {
  const item = items.find(item => 'id' in item && item.id === id);
  assert.ok(item && 'id' in item); return item;
};

test('property header menu has ordered supported actions and opens a real add form', async () => {
  const ui = setup('---\nz: last\na: first\n---\nbody');
  assert.equal(ui.open(ui.host.querySelector('.metadata-properties-heading')!).defaultPrevented, true);
  assert.deepEqual(labels(ui.menu), ['Add file property', '---', 'Sort', '---', 'Clear file properties']);
  assert.deepEqual(labels(submenu(ui.menu, 'Sort')), ['Name (A to Z)', 'Name (Z to A)']);
  assert.equal(ui.documents[0], ui.document);
  ui.select('properties-add'); await ui.settle();
  assert.equal(ui.document.activeElement?.getAttribute('aria-label'), 'New property name');
  assert.equal(ui.writes.length, 0);
  ui.close();
});

test('header sorting/clearing preserves newer body bytes and unaffected YAML data', async () => {
  const ui = setup('---\nz: "last" # note\na: {nested: true}\n---\nold');
  ui.open(ui.host.querySelector('.metadata-properties-heading')!);
  ui.source = ui.source.replace('\nold', '\nnewer body');
  ui.select('properties-sort-asc'); await ui.settle();
  assert.deepEqual(readProperties(ui.source).map(property => property.key), ['a', 'z']);
  assert.match(ui.source, /z: "last" # note/); assert.ok(ui.source.endsWith('newer body'));
  ui.open(ui.host.querySelector('.metadata-properties-heading')!);
  ui.select('properties-clear'); await ui.settle();
  assert.equal(ui.source, 'newer body');
  ui.close();
});

test('property type menus follow registration order, reserved names and compatible noncoercing choices', async () => {
  const ui = setup('---\namount: "2"\naliases: [Alias]\ntags: [tag]\ncssclasses: [wide]\n---\nbody');
  ui.open(ui.row('amount').querySelector('select')!);
  assert.deepEqual(labels(ui.menu), ['Property type', '---', 'Remove']);
  const types = submenu(ui.menu, 'Property type');
  assert.deepEqual(labels(types), ['Automatic (Text)', 'Checkbox', 'Date', 'Date & time', 'List', 'Number', 'Text']);
  assert.equal(action(types, 'property-type-number').enabled, false);
  assert.equal(action(types, 'property-type-text').enabled, true);
  ui.select('property-type-text'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(readProperties(ui.source)[0].value, '2');
  ui.open(ui.row('amount').querySelector('select')!);
  assert.equal(action(submenu(ui.menu, 'Property type'), 'property-type-text').checked, true);
  ui.select('property-type-number'); await ui.settle();
  assert.equal(ui.writes.length, 0);
  for (const key of ['aliases', 'tags', 'cssclasses']) {
    ui.open(ui.row(key).querySelector('select')!);
    const reserved = submenu(ui.menu, 'Property type');
    assert.ok(reserved.every(item => !('id' in item) || item.enabled === false));
    assert.ok(!labels(reserved).some(label => label.startsWith('Automatic')));
    assert.equal(action(reserved, `property-type-${key === 'cssclasses' ? 'list' : key}`).checked, true);
  }
  ui.close();
});

test('property removal applies to the captured row and preserves newer unrelated changes', async () => {
  const ui = setup('---\nfirst: remove\nsecond: keep\n---\nbody');
  ui.open(ui.row('first'));
  ui.source = ui.source.replace('second: keep', 'second: newer');
  ui.select('property-remove'); await ui.settle();
  assert.deepEqual(readProperties(ui.source).map(property => [property.key, property.value]), [['second', 'newer']]);
  ui.close();
});

test('list and tag menus edit, copy and remove the selected item without splitting commas', async () => {
  const ui = setup('---\nitems: ["one, two", "line one\\nline two"]\ntags: [tag]\n---\nbody');
  const chip = () => ui.row('items').querySelectorAll('.metadata-list-item')[1];
  ui.open(chip());
  assert.deepEqual(labels(ui.menu), ['Edit', 'Copy', 'Remove from list']);
  ui.select('list-copy'); await ui.settle(); assert.deepEqual(ui.copied, ['line one\nline two']);
  ui.open(chip()); ui.select('list-edit'); await ui.settle();
  const input = chip().querySelector('textarea')!;
  assert.equal(ui.document.activeElement, input); assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length);
  ui.open(chip()); ui.select('list-remove'); await ui.settle();
  assert.deepEqual(readProperties(ui.source)[0].value, ['one, two']);
  ui.open(ui.row('tags').querySelector('.metadata-list-item')!);
  assert.deepEqual(labels(ui.menu), ['Edit', 'Copy', 'Remove from list']);
  ui.select('list-remove'); await ui.settle(); assert.deepEqual(readProperties(ui.source)[1].value, []);
  ui.close();
});

test('list copy without clipboard is disabled and ordinary name/scalar inputs retain native menus', () => {
  const ui = setup('---\nname: value\nitems: [one]\n---\nbody', { writeClipboard: undefined });
  assert.equal(ui.open(ui.row('name').querySelector('.metadata-property-key-input')!).defaultPrevented, false);
  assert.equal(ui.open(ui.row('name').querySelector('.metadata-property-value input')!).defaultPrevented, false);
  ui.open(ui.row('items').querySelector('.metadata-list-item')!);
  assert.equal(action(ui.menu, 'list-copy').enabled, false);
  ui.close();
});

test('changed property, shifted list and changed header snapshots reject delayed destructive actions', async () => {
  const ui = setup('---\nname: original\nitems: [one, two]\n---\nbody');
  ui.open(ui.row('name')); ui.source = ui.source.replace('original', 'external');
  ui.select('property-remove'); await ui.settle();
  assert.match(ui.host.textContent!, /changed while the menu/);
  ui.open(ui.row('items').querySelectorAll('.metadata-list-item')[1]);
  ui.source = ui.source.replace('[one, two]', '[inserted, one, two]');
  ui.select('list-remove'); await ui.settle();
  ui.view.refresh(); ui.open(ui.host.querySelector('.metadata-properties-heading')!);
  ui.source = ui.source.replace('name: external', 'name: newer');
  ui.select('properties-clear'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(ui.errors.length, 3);
  assert.deepEqual(readProperties(ui.source)[1].value, ['inserted', 'one', 'two']);
  ui.close();
});

test('draft edits disable or invalidate destructive actions instead of discarding input', async () => {
  const ui = setup('---\nname: original\n---\nbody');
  ui.open(ui.row('name'));
  const input = ui.row('name').querySelector<HTMLInputElement>('.metadata-property-value input')!;
  input.value = 'unsaved'; input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  ui.select('property-remove'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(input.value, 'unsaved');
  assert.match(ui.host.textContent!, /unsaved draft/);
  ui.open(ui.row('name')); assert.equal(action(ui.menu, 'property-remove').enabled, false);
  ui.open(ui.host.querySelector('.metadata-properties-heading')!);
  assert.equal(action(ui.menu, 'properties-clear').enabled, false);
  ui.close();
});

test('menu failures, clipboard failures and rejected persistence reach visible errors and callback', async () => {
  const ui = setup('---\nitems: [one]\n---\nbody', { writeClipboard: async () => { throw new Error('clipboard denied'); } });
  ui.open(ui.row('items')); ui.fail(new Error('menu unavailable')); await ui.settle();
  assert.match(ui.host.textContent!, /menu unavailable/);
  ui.open(ui.row('items').querySelector('.metadata-list-item')!); ui.select('list-copy'); await ui.settle();
  assert.match(ui.host.textContent!, /clipboard denied/); assert.equal(ui.errors.length, 2); ui.close();
  const failing = setup('---\nname: value\n---\nbody', { onChange: () => { throw new Error('disk full'); } });
  failing.open(failing.row('name')); failing.select('property-remove'); await failing.settle();
  assert.match(failing.host.textContent!, /disk full/); assert.equal(failing.errors.length, 1);
  assert.equal(readProperties(failing.source)[0].key, 'name'); failing.close();
});

test('destroyed, disconnected, superseded and different-owner menus cannot mutate', async () => {
  const ui = setup('---\nname: value\n---\nbody');
  ui.open(ui.row('name')); const oldSelect = ui.select;
  ui.view.destroy(); oldSelect('property-remove'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(ui.dismissed, 1); ui.close();
  const owner = setup('---\nname: value\n---\nbody');
  owner.open(owner.row('name')); owner.current = false; owner.select('property-remove'); await owner.settle();
  assert.equal(owner.writes.length, 0); assert.equal(owner.errors.length, 1); owner.close();
  const disconnected = setup('---\nname: value\n---\nbody');
  disconnected.open(disconnected.row('name')); disconnected.host.remove(); disconnected.select('property-remove'); await disconnected.settle();
  assert.equal(disconnected.writes.length, 0); disconnected.close();
  const other = setup('---\nname: value\n---\nbody');
  other.open(other.row('name')); other.open(other.document.getElementById('other')!);
  other.select('property-remove'); await other.settle(); other.view.destroy();
  assert.equal(other.writes.length, 0); assert.equal(other.dismissed, 0); other.close();
});

test('keyboard context invocation uses the owning document and header actions', async () => {
  const ui = setup('---\nname: value\n---\nbody');
  const header = ui.host.querySelector<HTMLElement>('.metadata-properties-heading')!; header.focus();
  const event = new ui.dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true });
  header.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(ui.documents[0], ui.document);
  ui.select('properties-add'); await ui.settle();
  assert.equal(ui.document.activeElement?.getAttribute('aria-label'), 'New property name'); ui.close();
});

test('synchronous popup failure is reported and does not retain dismissal ownership', async () => {
  const ui = setup('---\nname: value\n---\nbody', { showMenu: () => { throw new Error('bridge unavailable'); } });
  ui.open(ui.row('name')); await ui.settle();
  assert.match(ui.host.textContent!, /bridge unavailable/); assert.equal(ui.errors.length, 1);
  ui.view.destroy(); assert.equal(ui.dismissed, 0); ui.close();
});

test('queued removal revalidates the source after an earlier save completes', async () => {
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  const ui = setup('---\nname: value\nitems: [one, two]\n---\nbody', {
    onChange: async next => { ui.writes.push(next); ui.source = next; await saving; },
  });
  const name = ui.row('name').querySelector<HTMLInputElement>('.metadata-property-value input')!;
  name.value = 'saved'; name.dispatchEvent(new ui.dom.window.Event('change'));
  await ui.settle();
  ui.open(ui.row('items').querySelector('.metadata-list-item')!); ui.select('list-remove'); await ui.settle();
  ui.source = setProperty(ui.source, 'items', ['external', 'one', 'two'], 'list');
  release(); await ui.settle();
  assert.equal(ui.writes.length, 1); assert.deepEqual(readProperties(ui.source)[1].value, ['external', 'one', 'two']);
  assert.match(ui.host.textContent!, /changed while the menu/); ui.close();
});

test('default browser popup dispatches actions and teardown removes its own menu', async () => {
  const ui = setup('---\nname: value\n---\nbody', { showMenu: undefined, dismissMenu: undefined });
  ui.open(ui.row('name'));
  const remove = [...ui.document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(button => button.textContent === 'Remove')!;
  assert.ok(remove); remove.click(); await ui.settle();
  assert.equal(readProperties(ui.source).length, 0); assert.equal(ui.document.querySelector('.context-menu'), null);
  ui.open(ui.host.querySelector('.metadata-properties-heading')!); assert.ok(ui.document.querySelector('.context-menu'));
  ui.view.destroy(); await ui.settle(); assert.equal(ui.document.querySelector('.context-menu'), null); ui.close();
});


test('unsubmitted property-name drafts block row and header removal', async () => {
  const ui = setup('---\nname: value\n---\nbody');
  ui.open(ui.row('name'));
  const input = ui.row('name').querySelector<HTMLInputElement>('.metadata-property-key-input')!;
  input.focus(); input.value = 'draft name';
  ui.select('property-remove'); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(input.value, 'draft name');
  ui.open(ui.host.querySelector('.metadata-properties-heading')!);
  assert.equal(action(ui.menu, 'properties-clear').enabled, false);
  ui.close();
});

test('failed and unsubmitted property-name drafts survive blur and refresh', async () => {
  const ui = setup('---\nname: value\nother: x\n---\nbody');
  const input = ui.row('name').querySelector<HTMLInputElement>('.metadata-property-key-input')!;
  input.focus(); input.value = 'other'; input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  ui.document.getElementById('other')!.focus(); await ui.settle();
  assert.equal(ui.writes.length, 0); assert.equal(input.value, 'other');
  assert.match(ui.host.textContent!, /already exists/);
  ui.open(ui.host.querySelector('.metadata-properties-heading')!);
  assert.equal(action(ui.menu, 'properties-clear').enabled, false);
  input.focus(); input.value = 'unsubmitted'; ui.document.getElementById('other')!.focus();
  ui.view.refresh(); assert.equal(input.value, 'unsubmitted');
  ui.open(ui.row('name')); assert.equal(action(ui.menu, 'property-remove').enabled, false);
  ui.close();
});

test('an older pending rename does not erase a newer blurred name draft', async () => {
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  const ui = setup('---\nname: value\n---\nbody', {
    onChange: async next => { await saving; ui.writes.push(next); ui.source = next; },
  });
  const input = ui.row('name').querySelector<HTMLInputElement>('.metadata-property-key-input')!;
  input.focus(); input.value = 'saved'; input.dispatchEvent(new ui.dom.window.Event('change'));
  await ui.settle(); input.value = 'newer draft'; input.dispatchEvent(new ui.dom.window.Event('input'));
  ui.document.getElementById('other')!.focus(); release(); await ui.settle();
  assert.deepEqual(readProperties(ui.source).map(property => property.key), ['saved']);
  assert.equal(input.value, 'newer draft'); assert.equal(input.isConnected, true);
  ui.open(ui.row('saved')); assert.equal(action(ui.menu, 'property-remove').enabled, false);
  input.dispatchEvent(new ui.dom.window.Event('change')); await ui.settle();
  assert.deepEqual(readProperties(ui.source).map(property => property.key), ['newer draft']);
  assert.equal(ui.writes.length, 2); ui.close();
});
