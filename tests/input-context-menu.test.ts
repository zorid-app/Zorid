import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { shouldOverrideInputContextMenu } from '../src/platform/input-context-menu.ts';

test('ordinary text controls retain platform menus without a native menu capability', () => {
  const dom = new JSDOM('<input><textarea></textarea><input readonly value="Copy me">');
  try {
    for (const input of dom.window.document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) {
      assert.equal(shouldOverrideInputContextMenu(input), false);
    }
    // A storage bridge alone does not provide a replacement clipboard menu.
    Object.defineProperty(dom.window, 'zorid', { value: { getVault: async () => null }, configurable: true });
    assert.equal(shouldOverrideInputContextMenu(dom.window.document.querySelector('input')!), false);
    Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu: true } });
    assert.equal(shouldOverrideInputContextMenu(dom.window.document.querySelector('input')!), false);
  } finally { dom.window.close(); }
});

test('menu capability is resolved from the input owner window and follows document adoption', () => {
  const desktop = new JSDOM('<input>'), mobile = new JSDOM('<textarea></textarea>');
  try {
    let calls = 0;
    Object.defineProperty(desktop.window, 'zorid', { value: { showContextMenu: async () => { calls++; return null; } } });
    const input = desktop.window.document.querySelector('input')!;
    const textarea = mobile.window.document.querySelector('textarea')!;
    assert.equal(shouldOverrideInputContextMenu(input), true);
    assert.equal(shouldOverrideInputContextMenu(textarea), false);
    mobile.window.document.body.append(mobile.window.document.adoptNode(input));
    assert.equal(shouldOverrideInputContextMenu(input), false);
    desktop.window.document.body.append(desktop.window.document.adoptNode(textarea));
    assert.equal(shouldOverrideInputContextMenu(textarea), true);
    assert.equal(calls, 0, 'checking policy must not open or probe a native menu');
  } finally { desktop.window.close(); mobile.window.close(); }
});

test('controls in a document without a window retain the default menu', () => {
  const dom = new JSDOM('');
  try {
    const detachedDocument = dom.window.document.implementation.createHTMLDocument('Detached');
    assert.equal(detachedDocument.defaultView, null);
    assert.equal(shouldOverrideInputContextMenu(detachedDocument.createElement('input')), false);
  } finally { dom.window.close(); }
});
