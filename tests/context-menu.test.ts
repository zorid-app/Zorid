import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { showContextMenu, dismissContextMenu } from '../src/platform/context-menu.ts';
import type { ContextMenuItem } from '../src/platform/context-menu.ts';

function setup() {
  const dom = new JSDOM('<!doctype html><body><textarea>Before and after</textarea><button id="other">Outside</button></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const input = doc.querySelector('textarea')!; input.focus(); input.setSelectionRange(2, 8);
  const event = { clientX: 20, clientY: 30 };
  const key = (value: string) => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const show = (items: ContextMenuItem[]) => showContextMenu(event, items, { document: doc });
  return { dom, doc, input, key, show };
}

test('desktop uses the typed native bridge and does not create a DOM menu or change focus', async () => {
  const { dom, doc, input, show } = setup();
  const calls: unknown[] = [];
  Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu: async (request: unknown) => { calls.push(request); return 'open'; } } });
  assert.equal(await show([{ id: 'open', label: 'Open' }]), 'open');
  assert.deepEqual(calls, [{ x: 20, y: 30, items: [{ id: 'open', label: 'Open' }] }]);
  assert.equal(doc.querySelector('[role=menu]'), null); assert.equal(doc.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 8); dom.window.close();
});

test('browser action menus skip disabled items, restore selection, and settle exactly once', async () => {
  const { dom, doc, input, key, show } = setup();
  const result = show([{ id: 'disabled', label: 'Disabled', enabled: false }, { id: 'open', label: 'Open', checked: true }, { id: 'close', label: 'Close' }]);
  assert.equal(doc.activeElement?.textContent, 'Open');
  assert.equal(doc.querySelector('[role=menuitemcheckbox]')?.getAttribute('aria-checked'), 'true');
  key('ArrowDown'); assert.equal(doc.activeElement?.textContent, 'Close');
  key('Enter'); assert.equal(await result, 'close');
  assert.equal(doc.querySelector('[role=menu]'), null); assert.equal(doc.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 8); dom.window.close();
});

test('browser submenu keyboard navigation and Escape restore the owning editor', async () => {
  const { dom, doc, input, key, show } = setup();
  const result = show([{ label: 'Insert', submenu: [{ id: 'row', label: 'Row' }, { id: 'column', label: 'Column' }] }]);
  key('ArrowRight'); assert.equal(doc.activeElement?.textContent, 'Row');
  key('ArrowLeft'); assert.equal(doc.activeElement?.textContent, 'Insert');
  key('ArrowRight'); key('End'); key('Enter');
  assert.equal(await result, 'column'); assert.equal(doc.activeElement, input);
  const dismissed = show([{ id: 'a', label: 'A' }]); key('Escape'); assert.equal(await dismissed, null);
  assert.equal(doc.activeElement, input); dom.window.close();
});

test('browser replacement and outside dismissal release menus and settle pending callers', async () => {
  const { dom, doc, show } = setup();
  const first = show([{ id: 'one', label: 'One' }]);
  const second = show([{ id: 'two', label: 'Two' }]);
  assert.equal(await first, null); assert.equal(doc.querySelectorAll('[role=menu]').length, 1);
  const other = doc.querySelector<HTMLButtonElement>('#other')!;
  other.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); other.focus();
  assert.equal(await second, null); assert.equal(doc.activeElement, other);
  assert.equal(doc.querySelector('[role=menu]'), null); dom.window.close();
});

test('browser menu takes keyboard context and unsupported clipboard roles are disabled', async () => {
  const { dom, doc, show, key } = setup();
  let calls = 0; doc.addEventListener('keydown', () => calls++);
  const result = show([{ role: 'pasteAndMatchStyle' }, { id: 'a', label: 'A' }]);
  assert.equal(doc.querySelector<HTMLButtonElement>('button.context-menu-item')?.disabled, true);
  key('p'); assert.equal(calls, 0);
  key('Escape'); await result; key('p'); assert.equal(calls, 1); dom.window.close();
});

test('browser Paste requires actual command availability even when execCommand exists', async () => {
  const { dom, doc, show, key } = setup();
  doc.execCommand = () => false;
  doc.queryCommandEnabled = () => false;
  const result = show([{ role: 'paste' }, { id: 'a', label: 'A' }]);
  assert.equal(doc.querySelector<HTMLButtonElement>('button.context-menu-item')?.disabled, true);
  key('Escape'); await result; dom.window.close();
});

test('browser Select all acts on the original text input, not the focused menu item', async () => {
  const { dom, doc, input, show, key } = setup();
  const result = show([{ role: 'selectAll' }]); key('Enter');
  assert.equal(await result, null); assert.equal(doc.activeElement, input);
  assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length); dom.window.close();
});

test('explicit workspace teardown dismisses browser menus and forwards native cancellation', async () => {
  const { dom, doc, show } = setup();
  const result = show([{ id: 'a', label: 'A' }]);
  await dismissContextMenu(doc);
  assert.equal(await result, null); assert.equal(doc.querySelector('[role=menu]'), null);
  let canceled = 0;
  Object.defineProperty(dom.window, 'zorid', { value: { dismissContextMenu: async () => { canceled++; } } });
  await dismissContextMenu(doc); assert.equal(canceled, 1); dom.window.close();
});
