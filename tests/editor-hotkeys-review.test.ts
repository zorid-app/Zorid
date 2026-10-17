import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { HotkeyPreferences } from '../src/ui/hotkeys.ts';
import { runEditorCommand } from '../src/editor/editor-commands.ts';
import { tableSelectionAt } from '../src/editor/live-tables.ts';
import { foldedRanges } from '@codemirror/language';
import type { EditorOptions } from '../src/ui/editor.ts';

// Real editor integration checks. Synthetic composition events exercise our
// listener lifecycle, not native IME candidate windows or browser DOM input.
// Geometry shims do not prove clicks, painted selection or native caret parity.
function setup(t: TestContext, value: string, mode: 'live' | 'source' = 'live', completion: Partial<EditorOptions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, entry] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: entry });
  }
  const emptyRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!;
  const changes: string[] = [];
  const opened: string[] = [];
  const editor = createEditor(host, { value, mode, paths: () => ['Note.md'], onChange: text => changes.push(text), open: target => opened.push(target), ...completion });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  assert.ok(view, 'find real CodeMirror instance from its DOM');
  view.focus();
  view.dispatch({ selection: view.state.selection });
  let destroyed = false;
  const destroy = () => { if (!destroyed) { editor.destroy(); destroyed = true; } };
  t.after(() => {
    destroy();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const line = (index: number) => [...host.querySelectorAll<HTMLElement>('.cm-line')][index];
  const cursor = (position: number) => view.dispatch({ selection: { anchor: position } });
  return { editor, view, host, changes, opened, line, cursor, dom, destroy };
}


function cellEditor(host: HTMLElement, dom: JSDOM) {
  const cell = host.querySelector<HTMLElement>('.cm-live-table td')!;
  assert.ok(cell);
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.ok(child);
  return child;
}

function preferences() {
  const data = new Map<string, string>();
  return new HotkeyPreferences({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } }, 'other');
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function press(view: EditorView, dom: JSDOM, key = 'F7', extra: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  view.contentDOM.dispatchEvent(event); return event;
}


test('AltGraph text input overlapping a custom chord is not cancelled or formatted',t=>{
  const source=preferences();source.set('editor-bold',[{key:'e',modifiers:['Mod','Alt']}]);
  const {view,dom}=setup(t,'word','source',{hotkeys:source});view.dispatch({selection:{anchor:0,head:4}});
  const event=new dom.window.KeyboardEvent('keydown',{key:'e',ctrlKey:true,altKey:true,bubbles:true,cancelable:true});
  Object.defineProperty(event,'getModifierState',{value:(key:string)=>key==='AltGraph'});
  view.contentDOM.dispatchEvent(event);
  assert.equal(view.state.doc.toString(),'word');
  assert.equal(event.defaultPrevented,false,'browser AltGraph text input must retain its default action');
});

test('IME keydowns overlapping a custom chord retain their native default action',t=>{
  const source=preferences();source.set('editor-bold',[{key:'F7',modifiers:[]}]);
  const {view,dom}=setup(t,'word','source',{hotkeys:source});view.dispatch({selection:{anchor:0,head:4}});
  const event=press(view,dom,'F7',{isComposing:true});
  assert.equal(view.state.doc.toString(),'word');assert.equal(event.defaultPrevented,false);
});

test('temporary source rebinds during composition coalesce across two independent editor instances',async t=>{
  const source=preferences();source.set('editor-bold',[{key:'F7',modifiers:[]}]);
  const {view,dom,host}=setup(t,'word','source',{hotkeys:source});
  const second=document.createElement('section');host.after(second);
  const handle=createEditor(second,{value:'second',mode:'source',paths:()=>[],open(){},onChange(){},hotkeys:source});try {
  const other=EditorView.findFromDOM(second.querySelector('.cm-editor')!)!;
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart',{bubbles:true}));
  source.set('editor-bold',[{key:'F8',modifiers:[]}]);await flush();
  other.focus();other.dispatch({selection:{anchor:0,head:6}});press(other,dom,'F8');assert.equal(other.state.doc.toString(),'**second**');
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,45));
  view.focus();view.dispatch({selection:{anchor:0,head:4}});press(view,dom,'F8');assert.equal(view.state.doc.toString(),'**word**');
  } finally { handle.destroy(); }
});

test('one rectangle-format undo preserves earlier cell typing and rectangle ownership',async t=>{
  const source=preferences();source.set('editor-bold',[{key:'F7',modifiers:[]}]);
  const text='| A | B |\n| --- | --- |\n| word | other |';
  const {view,dom,host,editor}=setup(t,text,'live',{hotkeys:source});
  const child=cellEditor(host,dom);
  child.dispatch({changes:{from:4,insert:'!'},selection:{anchor:5},userEvent:'input.type'});
  press(child,dom,'ArrowRight',{shiftKey:true});
  assert.ok(tableSelectionAt(view,child.contentDOM));
  press(child,dom);
  assert.equal(editor.getValue(),text.replace('word','**word!**').replace('other','**other**'));
  assert.ok(undo(view));await flush();
  assert.equal(editor.getValue(),text.replace('word','word!'));
  assert.ok(child.dom.isConnected);assert.ok(tableSelectionAt(view,child.contentDOM));assert.ok(child.hasFocus);
});
