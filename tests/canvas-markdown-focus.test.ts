import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCanvasMarkdownCard } from '../src/canvas/markdown-card.ts';
import type { EditorHandle } from '../src/ui/editor.ts';

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function fixture(flushHook?: () => Promise<void>) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main')!;
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  let input!: HTMLElement, audio!: HTMLAudioElement, nested!: HTMLButtonElement, flushes = 0, releases = 0, editors = 0;
  const card = createCanvasMarkdownCard(doc, {
    load: () => ({ getText: () => 'Content', update() {}, subscribe: () => () => {},
      flush: async () => { flushes++; await flushHook?.(); }, hasPendingChanges: () => false, destroy() { releases++; } }),
    editorFactory(parent) {
      editors++; input = doc.createElement('div'); input.tabIndex = 0; input.contentEditable = 'true';
      const widget = doc.createElement('div'); widget.contentEditable = 'false';
      audio = doc.createElement('audio'); audio.controls = true;
      nested = doc.createElement('button'); nested.textContent = 'Nested control'; widget.append(audio, nested); input.append(widget); parent.append(input);
      return { focus: () => input.focus(), getValue: () => 'Content', setValue() {}, destroy: () => input.remove() } as EditorHandle;
    },
  });
  host.append(card.element, card.toolbar); await card.activate();
  const pointer = (type: string, target: EventTarget, id = 1) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: id }); target.dispatchEvent(event); return event;
  };
  return { dom, doc, card, input, audio, nested, pointer, outside: doc.querySelector<HTMLButtonElement>('#outside')!,
    counts: () => ({ flushes, releases, editors }),
    close() { card.destroy(); dom.window.close(); if (saved) Object.defineProperty(globalThis, 'document', saved); else Reflect.deleteProperty(globalThis, 'document'); } };
}

test('native media pointer blur retains the same visible Live player and does not swallow playback click', async () => {
  const f = await fixture();
  try {
    f.pointer('pointerdown', f.audio); f.input.blur(); await tick();
    assert.equal(f.doc.activeElement, f.doc.body); assert.equal(f.card.isEditing(), true);
    assert.equal(f.card.element.querySelector('.zorid-canvas-note-editor')?.hasAttribute('hidden'), false);
    const click = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }); f.audio.dispatchEvent(click);
    f.pointer('pointerup', f.audio); await tick();
    assert.equal(click.defaultPrevented, false); assert.equal(f.card.isEditing(), true);
    assert.equal(f.card.element.querySelector('audio'), f.audio); assert.equal(f.counts().flushes, 0);
    // Native controls may already leave focus on body, so the next outside
    // pointer must exit even though it produces no new editor focusout event.
    f.pointer('pointerdown', f.outside); await tick();
    assert.equal(f.card.isEditing(), false); assert.equal(f.counts().flushes, 1);
  } finally { f.close(); }
});

test('release clears the pointer exemption; ordinary keyboard focusout and Tab still deactivate', async () => {
  const f = await fixture();
  try {
    f.pointer('pointerdown', f.audio); f.pointer('pointerup', f.audio);
    f.outside.focus(); await tick(); assert.equal(f.card.isEditing(), false);
    await f.card.activate(); f.pointer('pointerdown', f.audio); f.input.blur(); await tick(); f.pointer('pointerup', f.audio);
    assert.equal(f.card.isEditing(), true);
    f.doc.body.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    f.outside.focus(); await tick(); assert.equal(f.card.isEditing(), false);
    assert.equal(f.counts().editors, 1, 'focus transitions retain the existing editor');
  } finally { f.close(); }
});

test('pointer cancellation and window blur cannot leave a sticky card-local exemption', async () => {
  const f = await fixture();
  try {
    f.pointer('pointerdown', f.audio); f.input.blur(); await tick(); assert.equal(f.card.isEditing(), true);
    f.pointer('pointercancel', f.audio); await tick(); assert.equal(f.card.isEditing(), false);
    await f.card.activate(); f.pointer('pointerdown', f.audio); f.input.blur(); await tick();
    f.dom.window.dispatchEvent(new f.dom.window.Event('blur')); await tick(); assert.equal(f.card.isEditing(), false);
  } finally { f.close(); }
});

test('nested controls and card toolbar remain inside the focus boundary', async () => {
  const f = await fixture();
  try {
    f.pointer('pointerdown', f.nested); f.input.blur(); await tick(); assert.equal(f.card.isEditing(), true);
    f.nested.focus(); f.pointer('pointerup', f.nested); await tick(); assert.equal(f.card.isEditing(), true);
    f.pointer('pointerdown', f.card.toolbar.querySelector('button')!); f.card.toolbar.querySelector('button')!.focus(); await tick();
    assert.equal(f.card.isEditing(), true);
    f.pointer('pointerup', f.doc); f.outside.focus(); await tick(); assert.equal(f.card.isEditing(), false);
  } finally { f.close(); }
});

test('teardown removes document listeners and queued focus checks cannot flush a closed card', async () => {
  const f = await fixture();
  try {
    f.pointer('pointerdown', f.audio); f.input.blur(); f.card.destroy(); f.card.destroy();
    f.pointer('pointercancel', f.doc); f.pointer('pointerdown', f.outside);
    f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); await tick();
    assert.deepEqual(f.counts(), { flushes: 0, releases: 1, editors: 1 });
  } finally { f.close(); }
});

for (const held of [false, true]) test(`external focus after native body blur exits with pointer ${held ? 'held' : 'released'}`, async () => {
  const f = await fixture();
  try {
    f.pointer('pointerdown', f.audio); f.input.blur(); await tick();
    if (!held) f.pointer('pointerup', f.audio);
    f.outside.focus(); await tick();
    if (held) f.pointer('pointerup', f.audio);
    assert.equal(f.card.isEditing(), false);
  } finally { f.close(); }
});

test('returning to the card during a pending automatic save keeps the Live editor, but explicit exit still works', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(() => pending);
  try {
    f.pointer('pointerdown', f.outside); f.outside.focus(); await tick();
    f.pointer('pointerdown', f.audio); f.input.focus(); f.pointer('pointerup', f.audio);
    release(); await tick(); assert.equal(f.card.isEditing(), true);
    assert.equal(f.doc.activeElement, f.input);
    await f.card.deactivate(); assert.equal(f.card.isEditing(), false);
  } finally { release(); f.close(); }
});
