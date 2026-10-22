import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseCombobox } from '../src/bases/toolbar-combobox.ts';

function fixture(searchable = true) {
  const dom = new JSDOM('<main><select aria-label="Sort property"><option value="name">File name</option><option value="cost" disabled>Cost</option><option value="status">Status</option><option value="due">Due date</option></select></main><button id="outside">Outside</button>', { pretendToBeVisual: true });
  const doc = dom.window.document, select = doc.querySelector('select')!, owner = doc.querySelector('main')!;
  const events: string[] = [];
  select.addEventListener('change', () => events.push(select.value));
  const combobox = createBaseCombobox(select, { searchable, owner });
  const button = doc.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  const key = (target: Element, value: string) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  return { dom, doc, select, owner, combobox, button, events, key, search: () => doc.querySelector<HTMLInputElement>('[role="searchbox"]')!, cleanup() { combobox.destroy(); dom.window.close(); } };
}

test('search chooses the original option, emits native change, and restores focus', () => {
  const f = fixture();
  try {
    assert.equal(f.select.hidden, true); assert.equal(f.select.getAttribute('aria-hidden'), 'true');
    assert.equal(f.button.getAttribute('aria-label'), 'Sort property'); assert.equal(f.button.textContent, 'File name');
    f.button.click();
    assert.equal(f.button.getAttribute('aria-expanded'), 'true'); assert.equal(f.doc.activeElement, f.search());
    assert.ok(f.owner.contains(f.doc.querySelector('[role="listbox"]')));
    const search = f.search(); search.value = 'due'; search.dispatchEvent(new f.dom.window.Event('input'));
    assert.deepEqual(Array.from(f.doc.querySelectorAll('[role="option"]'), row => row.textContent), ['Due date']);
    const option = f.doc.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(option.title, 'Due date'); option.click();
    assert.equal(f.select.value, 'due'); assert.deepEqual(f.events, ['due']); assert.equal(f.button.textContent, 'Due date');
    assert.equal(f.doc.querySelector('[role="listbox"]'), null); assert.equal(f.doc.activeElement, f.button);
  } finally { f.cleanup(); }
});

test('keyboard navigation skips disabled options and Escape cancels without changing the model', () => {
  const f = fixture(false);
  try {
    f.button.focus(); f.key(f.button, 'ArrowDown');
    assert.equal(f.button.getAttribute('aria-expanded'), 'true');
    f.key(f.button, 'ArrowDown');
    assert.equal(f.doc.querySelector('.is-active')?.textContent, 'Status');
    f.key(f.button, 'Enter'); assert.equal(f.select.value, 'status'); assert.deepEqual(f.events, ['status']);
    f.key(f.button, 'ArrowUp'); f.key(f.button, 'ArrowDown'); f.key(f.button, 'Escape');
    assert.equal(f.select.value, 'status'); assert.equal(f.doc.activeElement, f.button); assert.equal(f.button.getAttribute('aria-expanded'), 'false');
    f.key(f.button, 'Enter'); f.key(f.button, 'End'); assert.equal(f.doc.querySelector('.is-active')?.textContent, 'Due date');
    f.key(f.button, 'Home'); assert.equal(f.doc.querySelector('.is-active')?.textContent, 'File name');
  } finally { f.cleanup(); }
});

test('Tab returns focus to trigger for normal tab order; outside focus closes without stealing focus', () => {
  const f = fixture();
  try {
    f.button.click(); const tab = new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    f.search().dispatchEvent(tab); assert.equal(tab.defaultPrevented, false); assert.equal(f.doc.activeElement, f.button);
    f.button.click(); const outside = f.doc.querySelector<HTMLButtonElement>('#outside')!; outside.focus();
    assert.equal(f.doc.querySelector('[role="listbox"]'), null); assert.equal(f.doc.activeElement, outside);
    f.button.click(); outside.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  } finally { f.cleanup(); }
});

test('native changes, option mutations and disabled state synchronize the custom control', async () => {
  const f = fixture();
  try {
    f.select.value = 'status'; f.select.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(f.button.textContent, 'Status');
    f.button.click(); f.select.options[2].textContent = 'Workflow';
    await Promise.resolve();
    assert.equal(f.button.textContent, 'Workflow'); assert.equal(f.doc.querySelector('[aria-selected="true"]')?.textContent, 'Workflow');
    f.select.disabled = true; await Promise.resolve();
    assert.equal(f.button.disabled, true); assert.equal(f.doc.querySelector('[role="listbox"]'), null);
    f.select.disabled = false; f.select.setAttribute('aria-label', 'Group property'); await Promise.resolve();
    assert.equal(f.button.disabled, false); assert.equal(f.button.getAttribute('aria-label'), 'Group property');
    f.select.replaceChildren(); f.combobox.sync(); f.button.click();
    assert.equal(f.doc.querySelector('[role="status"]')?.textContent, 'No results');
  } finally { f.cleanup(); }
});

test('search never chooses disabled options or interprets markup in labels', () => {
  const f = fixture();
  try {
    f.select.options[1].label = '<b>Cost</b>'; f.combobox.sync(); f.button.click();
    const search = f.search(); search.value = 'cost'; search.dispatchEvent(new f.dom.window.Event('input'));
    const option = f.doc.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(option.textContent, '<b>Cost</b>'); assert.equal(option.querySelector('b'), null); assert.equal(option.getAttribute('aria-disabled'), 'true');
    option.click(); f.key(search, 'Enter'); assert.equal(f.select.value, 'name'); assert.deepEqual(f.events, []);
  } finally { f.cleanup(); }
});

test('destroy removes popup and listeners and restores original native attributes', async () => {
  const f = fixture();
  try {
    f.button.click(); f.combobox.destroy(); f.combobox.destroy();
    assert.equal(f.select.hidden, false); assert.equal(f.select.hasAttribute('tabindex'), false); assert.equal(f.select.hasAttribute('aria-hidden'), false);
    assert.equal(f.doc.querySelector('[role="combobox"]'), null); assert.equal(f.doc.querySelector('[role="listbox"]'), null);
    f.button.click(); f.select.value = 'status'; f.select.dispatchEvent(new f.dom.window.Event('change')); f.select.options[0].textContent = 'Changed';
    await Promise.resolve(); assert.equal(f.doc.querySelector('[role="listbox"]'), null); assert.equal(f.button.textContent, 'File name');
  } finally { f.cleanup(); }
});

test('popup stays in the viewport and follows its anchor when the owning panel scrolls', () => {
  const f = fixture();
  try {
    Object.defineProperty(f.dom.window, 'innerWidth', { value: 300 }); Object.defineProperty(f.dom.window, 'innerHeight', { value: 200 });
    let top = 170;
    f.button.getBoundingClientRect = () => ({ x: 270, y: top, top, bottom: top + 20, left: 270, right: 290, width: 20, height: 20, toJSON() {} });
    f.button.click();
    const popup = f.doc.querySelector<HTMLElement>('.bases-toolbar-combobox-popover')!;
    assert.equal(popup.classList.contains('opens-above'), true);
    assert.ok(Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width) <= 292);
    assert.ok(Number.parseFloat(popup.style.top) >= 8);
    top = 20; f.owner.dispatchEvent(new f.dom.window.Event('scroll'));
    assert.equal(popup.classList.contains('opens-above'), false); assert.equal(popup.style.top, '44px');
  } finally { f.cleanup(); }
});
