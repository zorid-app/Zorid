import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resolveNumberedTabShortcut } from '../src/ui/workspace-keymap.ts';
import type { NumberedTabKeyEvent, NumberedTabShortcutContext } from '../src/ui/workspace-keymap.ts';
const key = (digit: string, overrides: Partial<NumberedTabKeyEvent> = {}): NumberedTabKeyEvent => ({ key: digit, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...overrides });
const resolve = (event: NumberedTabKeyEvent, overrides: Partial<NumberedTabShortcutContext> = {}) => resolveNumberedTabShortcut(event, { platform: 'mac', tabCount: 12, ...overrides });

test('Mod1..8 use ordered active-group positions and Mod9 always selects last', () => {
  for (let digit = 1; digit <= 8; digit++) assert.deepEqual(resolve(key(String(digit))), { handled: true, index: digit - 1 });
  for (const count of [1, 2, 8, 9, 12, 100]) assert.deepEqual(resolve(key('9'), { tabCount: count }), { handled: true, index: count - 1 });
  assert.deepEqual(resolve(key('3'), { tabCount: 3 }), { handled: true, index: 2 });
});

test('out-of-range and unavailable group are consumed no-ops, with no clamping or wrap', () => {
  assert.deepEqual(resolve(key('8'), { tabCount: 2 }), { handled: true });
  for (const count of [0, -1, NaN, Infinity, 1.5]) assert.deepEqual(resolve(key('1'), { tabCount: count }), { handled: true });
  assert.deepEqual(resolve(key('9'), { tabCount: 0 }), { handled: true });
});

test('platform Mod is exact; extra modifiers and unmodified numbers are not handled', () => {
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: false }, { metaKey: false, ctrlKey: true }]) assert.deepEqual(resolve(key('2', extra)), { handled: false });
  assert.deepEqual(resolve(key('2', { metaKey: false, ctrlKey: true }), { platform: 'other' }), { handled: true, index: 1 });
  assert.deepEqual(resolve(key('2'), { platform: 'other' }), { handled: false });
  assert.deepEqual(resolve(key('2', { ctrlKey: true }), { platform: 'other' }), { handled: false });
});

test('repeats and owned/prevented/composition events preserve their keyboard context', () => {
  for (const state of [{ repeat: true }, { defaultPrevented: true }, { isComposing: true }]) assert.deepEqual(resolve(key('2', state)), { handled: false });
  assert.deepEqual(resolve(key('2'), { blocked: true }), { handled: false });
  for (const digit of ['0', '10', '', 'Tab', 'F1', '!']) assert.deepEqual(resolve(key(digit)), { handled: false });
});

test('logical digits and legacy virtual digit keys match without guessing physical code', () => {
  assert.deepEqual(resolve(key('é', { which: 50 })), { handled: true, index: 1 });
  assert.deepEqual(resolve(key('', { keyCode: 51 })), { handled: true, index: 2 });
  assert.deepEqual(resolve(key('1', { which: 97 })), { handled: true, index: 0 });
  assert.deepEqual(resolve(key('End', { which: 97 })), { handled: false });
  assert.deepEqual(resolve(key('9', { which: 50 })), { handled: true, index: 1 });
  assert.deepEqual(resolve(key('2', { which: 57 })), { handled: true, index: 1 });
  assert.deepEqual(resolve(key('é', { which: 50.1 })), { handled: false });
});

test('phone exclusion applies to positions1..8; last-tab declaration has no phone exclusion', () => {
  assert.deepEqual(resolve(key('1'), { isPhone: true }), { handled: true });
  assert.deepEqual(resolve(key('8'), { isPhone: true }), { handled: true });
  assert.deepEqual(resolve(key('9'), { isPhone: true }), { handled: true, index: 11 });
});

test('focused input and contenteditable do not suppress matcher; matching itself has no DOM side effects', () => {
  const dom = new JSDOM('<input value="abc"><div contenteditable="true" tabindex="0">Text</div>');
  for (const input of [...dom.window.document.querySelectorAll<HTMLElement>('input,div')]) {
    input.focus();
    const event = new dom.window.KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    assert.deepEqual(resolve(event), { handled: true, index: 1 });
    assert.equal(event.defaultPrevented, false);
    assert.equal(dom.window.document.activeElement, input);
  }
  dom.window.close();
});

test('host can resolve current pane at dispatch, including pinned tabs, without changing another group', () => {
  const panes = [{ tabs: [{ id: 'a', pinned: true }, { id: 'b', pinned: false }], active: 'b' }, { tabs: [{ id: 'c', pinned: false }, { id: 'd', pinned: true }, { id: 'e', pinned: false }], active: 'c' }];
  const active = panes[1];
  const result = resolve(key('2'), { tabCount: active.tabs.length });
  if (result.handled && result.index !== undefined) active.active = active.tabs[result.index].id;
  assert.equal(active.active, 'd'); assert.equal(panes[0].active, 'b');
});

test('requested new-tab/file/window shortcuts have distinct exact chords and retain numbered dispatch', async () => {
  const { resolveWorkspaceShortcut } = await import('../src/ui/workspace-keymap.ts');
  const context = { platform: 'mac' as const, tabCount: 4, canOpenWindow: true };
  assert.deepEqual(resolveWorkspaceShortcut(key('t'), context), { handled: true, action: { type: 'new-tab' } });
  assert.deepEqual(resolveWorkspaceShortcut(key('n'), context), { handled: true, action: { type: 'new-file' } });
  assert.deepEqual(resolveWorkspaceShortcut(key('N', { shiftKey: true }), context), { handled: true, action: { type: 'new-window' } });
  assert.deepEqual(resolveWorkspaceShortcut(key('9'), context), { handled: true, action: { type: 'select-tab', index: 3 } });
  assert.deepEqual(resolveWorkspaceShortcut(key('8'), context), { handled: true });
  assert.deepEqual(resolveWorkspaceShortcut(key('T', { shiftKey: true }), context), { handled: false });
});

test('unsupported new-window shortcut is consumed and cannot create a file or tab', async () => {
  const { resolveWorkspaceShortcut } = await import('../src/ui/workspace-keymap.ts');
  for (const canOpenWindow of [undefined, false]) {
    const result = resolveWorkspaceShortcut(key('N', { shiftKey: true }), { platform: 'mac', tabCount: 3, canOpenWindow });
    assert.deepEqual(result, { handled: true });
    assert.equal('action' in result, false);
  }
});

test('new actions use platform Mod and reject competing modifiers/scopes/repeats', async () => {
  const { resolveWorkspaceShortcut } = await import('../src/ui/workspace-keymap.ts');
  const context = { platform: 'mac' as const, tabCount: 2, canOpenWindow: true };
  for (const override of [{ ctrlKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { metaKey: false }]) {
    assert.deepEqual(resolveWorkspaceShortcut(key('n', override), context), { handled: false });
    assert.deepEqual(resolveWorkspaceShortcut(key('t', override), context), { handled: false });
  }
  assert.deepEqual(resolveWorkspaceShortcut(key('n'), { ...context, blocked: true }), { handled: false });
  assert.deepEqual(resolveWorkspaceShortcut(key('n', { metaKey: false, ctrlKey: true }), { ...context, platform: 'other' }), { handled: true, action: { type: 'new-file' } });
  assert.deepEqual(resolveWorkspaceShortcut(key('N', { metaKey: false, ctrlKey: true, shiftKey: true }), { ...context, platform: 'other' }), { handled: true, action: { type: 'new-window' } });
  assert.deepEqual(resolveWorkspaceShortcut(key('Unidentified', { which: 84 }), context), { handled: true, action: { type: 'new-tab' } });
});
