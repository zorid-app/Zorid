import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { liveProperties, bodyStart } from '../src/editor/live-properties.ts';
import { installEmptyNoteFocus } from '../src/editor/empty-note-focus.ts';

// Real CM DOM listeners/state with synthetic rectangles; native geometry is a
// separate verification step. No browser caret-layout emulation is asserted.
function setup(t: TestContext, source = '', readonly = false, editable = true) {
  const dom = new JSDOM('<!doctype html><body><button id="other">Other</button><div class="note-scroll"><input class="note-title"><div class="properties-host"><input></div><div class="editor-host"></div></div>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const rect = (top: number, bottom: number) => ({ x: 0, y: top, top, bottom, left: 0, right: 800, width: 800, height: bottom - top, toJSON() { return {}; } });
  dom.window.Range.prototype.getBoundingClientRect = () => rect(100, 124);
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const document = dom.window.document, host = document.querySelector<HTMLElement>('.editor-host')!, surface = host.parentElement!;
  host.getBoundingClientRect = () => rect(100, 300); surface.getBoundingClientRect = () => rect(0, 800);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: source, extensions: [liveProperties(), EditorState.readOnly.of(readonly), EditorView.editable.of(editable)] }) });
  view.contentDOM.getBoundingClientRect = () => rect(100, 124);
  view.dispatch({ selection: { anchor: bodyStart(view.state) } });
  const dispose = installEmptyNoteFocus(view, host);
  const other = document.getElementById('other')!; other.focus();
  t.after(() => { dispose(); view.destroy(); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const mouse = (target: EventTarget, type: string, extra: MouseEventInit = {}) => { const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 250, ...extra }); target.dispatchEvent(event); return event; };
  const click = (target: EventTarget, extra: MouseEventInit = {}) => { mouse(target, 'mousedown', extra); return mouse(target, 'mouseup', extra); };
  return { dom, document, view, host, surface, other, mouse, click, dispose };
}

test('blank host and lower note background focus empty CM for immediate body input', t => {
  const ui = setup(t);
  for (const target of [ui.host, ui.surface]) {
    ui.other.focus(); const up = ui.click(target, { clientY: 600 });
    assert.equal(up.defaultPrevented, true); assert.equal(ui.document.activeElement, ui.view.contentDOM);
    assert.equal(ui.view.state.selection.main.head, 0);
  }
  ui.view.dispatch({ ...ui.view.state.replaceSelection('Typed'), userEvent: 'input.type' });
  assert.equal(ui.view.state.doc.toString(), 'Typed');
});

test('properties-only EOF and trailing blank clicks target body end without changing YAML', t => {
  const ui = setup(t, '---\ntitle: Keep # comment\n---');
  ui.click(ui.surface, { clientY: 650 });
  assert.equal(ui.view.state.selection.main.head, ui.view.state.doc.length);
  ui.view.dispatch({ ...ui.view.state.replaceSelection('Body'), userEvent: 'input.type' });
  assert.equal(ui.view.state.doc.toString(), '---\ntitle: Keep # comment\n---\nBody');
  ui.view.dispatch({ selection: { anchor: bodyStart(ui.view.state) } }); ui.other.focus();
  ui.click(ui.host); assert.equal(ui.view.state.selection.main.head, ui.view.state.doc.length);
  ui.view.dispatch({ ...ui.view.state.replaceSelection('!'), userEvent: 'input.type' });
  assert.equal(ui.view.state.doc.toString(), '---\ntitle: Keep # comment\n---\nBody!');
});

test('title, property, link and embed targets keep their own event routes', t => {
  const ui = setup(t, 'Existing');
  for (const tag of ['a', 'button', 'div']) { const child = ui.document.createElement(tag); child.className = 'interactive-child'; ui.host.append(child); }
  for (const target of [ui.document.querySelector('.note-title')!, ui.document.querySelector('.properties-host input')!, ...ui.host.querySelectorAll('.interactive-child')]) {
    assert.equal(ui.click(target).defaultPrevented, false); assert.equal(ui.document.activeElement, ui.other);
  }
  // A prevented event from a specialized widget is never reclaimed.
  ui.host.addEventListener('mousedown', event => event.preventDefault(), { once: true });
  assert.equal(ui.click(ui.host).defaultPrevented, false);
  assert.equal(ui.document.activeElement, ui.other);
  assert.equal(ui.view.state.selection.main.head, 0);
});

test('modifiers, secondary buttons, drag movement and newer selections prevent blank focus', t => {
  const ui = setup(t, 'Existing');
  for (const extra of [{ button: 2 }, { button: 1 }, { shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    assert.equal(ui.click(ui.surface, extra).defaultPrevented, false);
  }
  ui.mouse(ui.host, 'mousedown'); ui.mouse(ui.document, 'mousemove', { clientX: 230 }); ui.mouse(ui.host, 'mouseup');
  assert.equal(ui.document.activeElement, ui.other);
  ui.mouse(ui.host, 'mousedown'); ui.view.dispatch({ selection: EditorSelection.range(0, 4) }); ui.mouse(ui.host, 'mouseup');
  assert.equal(ui.view.state.selection.main.to, 4); assert.equal(ui.document.activeElement, ui.other);
  ui.mouse(ui.host, 'mousedown'); ui.mouse(ui.document, 'dragstart'); ui.mouse(ui.host, 'mouseup');
  assert.equal(ui.document.activeElement, ui.other);
});

test('changed source, scrollbar, above-body, detached and disposed owners cannot claim clicks', t => {
  const ui = setup(t, 'Existing');
  ui.mouse(ui.host, 'mousedown'); ui.view.dispatch({ changes: { from: 0, insert: 'New' } }); ui.mouse(ui.host, 'mouseup');
  assert.equal(ui.document.activeElement, ui.other);
  assert.equal(ui.click(ui.surface, { clientY: 50 }).defaultPrevented, false);
  assert.equal(ui.click(ui.surface, { clientY: 110 }).defaultPrevented, false, 'side margin beside a text line is not below-document space');
  Object.defineProperty(ui.surface, 'offsetWidth', { value: 800 }); Object.defineProperty(ui.surface, 'clientWidth', { value: 780 });
  assert.equal(ui.click(ui.surface, { clientX: 790 }).defaultPrevented, false);
  Object.defineProperty(ui.surface, 'offsetHeight', { value: 800 }); Object.defineProperty(ui.surface, 'clientHeight', { value: 780 });
  assert.equal(ui.click(ui.surface, { clientY: 790 }).defaultPrevented, false, 'horizontal scrollbar retains its interaction');
  ui.mouse(ui.host, 'mousedown'); ui.dispose(); ui.mouse(ui.host, 'mouseup');
  assert.equal(ui.document.activeElement, ui.other); ui.host.remove(); assert.equal(ui.click(ui.host).defaultPrevented, false);
});

for (const [readonly, editable] of [[true, true], [false, false]]) test(`readonly=${readonly}, editable=${editable} does not acquire typing focus`, t => {
  const ui = setup(t, '', readonly, editable); assert.equal(ui.click(ui.surface).defaultPrevented, false); assert.equal(ui.document.activeElement, ui.other);
});
