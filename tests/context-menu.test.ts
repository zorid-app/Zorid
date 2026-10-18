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

function editableSelection() {
  const fixture = setup();
  const editor = fixture.doc.createElement('div');
  editor.tabIndex = 0; editor.contentEditable = 'true'; editor.textContent = 'abcdef';
  fixture.doc.body.append(editor); editor.focus();
  const text = editor.firstChild!;
  fixture.doc.getSelection()!.setBaseAndExtent(text, 5, text, 1);
  return { ...fixture, editor, text };
}

test('browser restoration preserves backward DOM selection endpoints', async () => {
  const { dom, doc, text, show, key } = editableSelection();
  const result = show([{ id: 'action', label: 'Action' }]);
  key('Escape'); await result;
  const selection = doc.getSelection()!;
  assert.equal(selection.anchorNode, text); assert.equal(selection.focusNode, text);
  assert.equal(selection.anchorOffset, 5); assert.equal(selection.focusOffset, 1);
  assert.equal(selection.toString(), 'bcde'); dom.window.close();
});

test('browser stale DOM endpoints neither overwrite newer selection nor execute edit roles', async () => {
  for (const command of ['Escape', 'Enter']) {
    const { dom, doc, editor, show, key } = editableSelection();
    let executions = 0; doc.execCommand = () => { executions++; return true; };
    const result = show([{ role: 'cut' }]);
    // Replacing a render with identical text still invalidates its node ownership.
    editor.replaceChildren(doc.createTextNode('abcdef'));
    const replacement = editor.firstChild!;
    doc.getSelection()!.setBaseAndExtent(replacement, 2, replacement, 4);
    key(command); assert.equal(await result, null);
    assert.equal(executions, 0); assert.equal(doc.getSelection()!.toString(), 'cd');
    assert.equal(doc.getSelection()!.anchorNode, replacement); dom.window.close();
  }
});

test('browser roles reject replacement input values, changed editability and changed DOM content', async () => {
  for (const mutate of [
    (input: HTMLTextAreaElement) => { input.value = 'NEW DOCUMENT'; },
    (input: HTMLTextAreaElement) => { input.readOnly = true; },
    (input: HTMLTextAreaElement) => { input.disabled = true; },
  ]) {
    const { dom, doc, input, show, key } = setup();
    let executions = 0; doc.execCommand = () => { executions++; return true; };
    const result = show([{ role: 'cut' }]); mutate(input); key('Enter'); await result;
    assert.equal(executions, 0); dom.window.close();
  }
  const { dom, doc, text, show, key } = editableSelection();
  let executions = 0; doc.execCommand = () => { executions++; return true; };
  const result = show([{ role: 'cut' }]); text.nodeValue = 'NEW DOCUMENT'; key('Enter'); await result;
  assert.equal(executions, 0); dom.window.close();
});

test('disabled-only browser menus own focus and prevent printable key defaults until dismissed', async () => {
  const { dom, doc, input, show, key } = setup();
  const result = show([{ id: 'disabled', label: 'Disabled', enabled: false }]);
  assert.equal(doc.activeElement?.getAttribute('role'), 'menu');
  const event = new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  doc.activeElement!.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  key('Escape'); await result; assert.equal(doc.activeElement, input);
  const after = new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  input.dispatchEvent(after); assert.equal(after.defaultPrevented, false); dom.window.close();
});

test('hovering a sibling closes the submenu while retaining actionable focus', async () => {
  const { dom, doc, show, key } = setup();
  const result = show([{ label: 'Submenu', submenu: [{ id: 'child', label: 'Child' }] }, { id: 'other', label: 'Other' }]);
  key('ArrowRight'); assert.equal(doc.activeElement?.textContent, 'Child');
  const other = [...doc.querySelectorAll('button.context-menu-item')].find(row => row.textContent === 'Other')!;
  other.dispatchEvent(new dom.window.Event('pointerenter'));
  assert.equal(doc.activeElement, other); assert.equal(doc.querySelectorAll('[role=menu]').length, 1);
  key('Enter'); assert.equal(await result, 'other'); dom.window.close();
});

test('dismissed browser role handlers cannot execute late and roles reject external focus changes', async () => {
  const { dom, doc, show, key } = setup();
  let executions = 0; doc.execCommand = () => { executions++; return true; };
  const first = show([{ role: 'cut' }]);
  const oldButton = doc.querySelector<HTMLButtonElement>('button.context-menu-item')!;
  key('Escape'); await first; oldButton.click(); assert.equal(executions, 0);
  const second = show([{ role: 'cut' }]);
  const button = doc.querySelector<HTMLButtonElement>('button.context-menu-item')!;
  doc.querySelector<HTMLButtonElement>('#other')!.focus(); button.click(); await second;
  assert.equal(executions, 0); dom.window.close();
});

test('browser roles revalidate when restoring focus synchronously changes the source', async () => {
  const { dom, doc, input, show, key } = setup();
  let executions = 0; doc.execCommand = () => { executions++; return true; };
  const result = show([{ role: 'cut' }]);
  input.addEventListener('focus', () => { input.value = 'replacement on focus'; }, { once: true });
  key('Enter'); assert.equal(await result, null);
  assert.equal(executions, 0); assert.equal(input.value, 'replacement on focus'); dom.window.close();
});

test('browser Copy can restore a Reading selection whose original focus owner is BODY', async () => {
  const { dom, doc, show, key } = setup();
  const paragraph = doc.createElement('p'); paragraph.textContent = 'reading text'; doc.body.append(paragraph);
  (doc.activeElement as HTMLElement).blur();
  doc.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 7, paragraph.firstChild!, 0);
  const copied: string[] = []; doc.execCommand = command => { copied.push(command, doc.getSelection()!.toString()); return true; };
  const result = show([{ role: 'copy' }]); key('Enter'); await result;
  assert.deepEqual(copied, ['copy', 'reading']); assert.equal(doc.activeElement, doc.body);
  assert.equal(doc.getSelection()!.anchorOffset, 7); dom.window.close();
});

test('browser menu releases keyboard ownership when another control receives focus', async () => {
  const { dom, doc, show } = setup();
  const result = show([{ id: 'action', label: 'Action' }]);
  const other = doc.querySelector<HTMLButtonElement>('#other')!; other.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  other.dispatchEvent(event); assert.equal(await result, null);
  assert.equal(event.defaultPrevented, false); assert.equal(doc.activeElement, other);
  const second = show([{ id: 'action', label: 'Action' }]);
  const input = doc.querySelector('textarea')!; input.focus();
  await dismissContextMenu(doc); await second; assert.equal(doc.activeElement, input); dom.window.close();
});

test('browser command and selection-restoration failures still settle and release keyboard capture', async () => {
  for (const failRestore of [false, true]) {
    const { dom, doc, show, key } = failRestore ? editableSelection() : setup();
    let executions = 0;
    doc.execCommand = () => { executions++; throw new Error('Command denied'); };
    const result = show([{ role: 'cut' }]);
    if (failRestore) doc.getSelection()!.setBaseAndExtent = () => { throw new Error('Selection unavailable'); };
    key('Enter'); assert.equal(await result, null);
    assert.equal(executions, failRestore ? 0 : 1); assert.equal(doc.querySelector('[role=menu]'), null);
    const event = new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
    doc.dispatchEvent(event); assert.equal(event.defaultPrevented, false); dom.window.close();
  }
});

test('guarded editor roles use renderer witness and abort without restoring stale focus', async () => {
  const { dom, doc, input } = setup();
  let commands = 0, native = 0;
  doc.execCommand = () => { commands++; return true; };
  Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu: async () => { native++; return null; } } });
  const lease = {}, abort = new AbortController();
  let epoch = lease;
  const result = showContextMenu({ clientX: 0, clientY: 0 }, [{ role: 'cut' }], {
    document: doc, signal: abort.signal, isCurrent: () => epoch === lease,
  });
  assert.equal(native, 0, 'raw native roles cannot run ahead of renderer witness');
  const cut = doc.querySelector<HTMLButtonElement>('[role=menuitem]')!;
  assert.ok(cut); assert.notEqual(doc.activeElement, input);
  epoch = {}; abort.abort(); epoch = {};
  assert.equal(await result, null);
  cut.click();
  assert.equal(commands, 0);
  assert.notEqual(doc.activeElement, input, 'aborted owner cannot recover its old focus');
  assert.equal(doc.querySelector('[role=menu]'), null);
  dom.window.close();
});

test('guarded role rechecks authority after focus handlers before running effect', async () => {
  const { dom, doc, input } = setup();
  let current = true, commands = 0;
  doc.execCommand = () => { commands++; return true; };
  const result = showContextMenu({ clientX: 0, clientY: 0 }, [{ role: 'cut' }], { document: doc, isCurrent: () => current });
  input.addEventListener('focus', () => { current = false; }, { once: true });
  doc.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
  assert.equal(await result, null);
  assert.equal(commands, 0);
  dom.window.close();
});

test('aborting an older owned session cannot dismiss or refocus another menu', async () => {
  const { dom, doc } = setup();
  const firstAbort = new AbortController();
  const first = showContextMenu({ clientX: 0, clientY: 0 }, [{ id: 'first', label: 'First' }], { document: doc, signal: firstAbort.signal, isCurrent: () => true });
  const second = showContextMenu({ clientX: 0, clientY: 0 }, [{ id: 'second', label: 'Second' }], { document: doc, isCurrent: () => true });
  assert.equal(await first, null);
  firstAbort.abort();
  assert.equal(doc.activeElement?.textContent, 'Second');
  doc.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
  assert.equal(await second, 'second');
  dom.window.close();
});
