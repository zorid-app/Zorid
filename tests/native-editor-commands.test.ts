import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createEditor } from '../src/ui/editor.ts';
import type { NativeEditorState } from '../src/ui/editor.ts';
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
  const states: NativeEditorState[] = [];
  const editor = createEditor(host, { value, mode, paths: () => ['Note.md'], onChange: text => changes.push(text), open: target => opened.push(target), onNativeEditorState: state => states.push(state), ...completion });
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
  return { editor, view, host, changes, opened, states, line, cursor, dom, destroy };
}


function cellEditor(host: HTMLElement, dom: JSDOM) {
  const cell = host.querySelector<HTMLElement>('.cm-live-table td')!;
  assert.ok(cell);
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.ok(child);
  return child;
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const toolbarState = ({focused,editable,canUndo,canRedo}:NativeEditorState) => ({focused,editable,canUndo,canRedo});

test('native allowlist preserves reversed selection, shared undo/redo and reports body state', async t => {
  const f=setup(t,'alpha beta','source');
  f.view.dispatch({selection:EditorSelection.single(5,0)});await flush();
  assert.deepEqual(toolbarState(f.editor.nativeState!()),{focused:true,editable:true,canUndo:false,canRedo:false});
  assert.equal(f.editor.nativeAction!('bold'),true);assert.equal(f.editor.getValue(),'**alpha** beta');
  assert.equal(f.editor.nativeState!().canUndo,true);
  assert.equal(f.editor.nativeAction!('undo'),true);assert.equal(f.editor.getValue(),'alpha beta');
  assert.equal(f.editor.nativeState!().canRedo,true);assert.equal(f.editor.nativeAction!('redo'),true);
  assert.equal(f.editor.nativeAction!('deleteEverything' as any),false);
  f.destroy();assert.deepEqual(toolbarState(f.states.at(-1)!),{focused:false,editable:false,canUndo:false,canRedo:false});
  assert.deepEqual({...f.states.at(-1),navigationRevision:0},{focused:false,editable:false,canUndo:false,canRedo:false,selectionCollapsed:false,composing:true,interactionActive:true,navigationRevision:0});
  assert.equal(f.editor.nativeAction!('bold'),false);
});

test('native button blur retains exact body selection; external replacement cannot restore it', async t => {
  const f=setup(t,'alpha beta','source');f.view.dispatch({selection:EditorSelection.single(0,5)});await flush();
  f.view.contentDOM.blur();await flush();assert.equal(f.editor.nativeState!().focused,false);
  assert.equal(f.editor.nativeAction!('italic'),true);assert.equal(f.editor.getValue(),'*alpha* beta');
  await flush();f.view.contentDOM.blur();f.editor.setValue('replacement');
  assert.equal(f.editor.nativeAction!('bold'),false);assert.equal(f.editor.getValue(),'replacement');
});

test('native guard rejects title, modal, search, composition, readonly and stale owner without edits', async t => {
  let current=true;const f=setup(t,'alpha','source',{isCurrent:()=>current});
  const input=document.createElement('input');document.body.append(input);input.focus();await flush();
  assert.equal(f.editor.nativeAction!('bold'),false);assert.equal(f.editor.nativeState!().editable,false);
  f.view.focus();const modal=document.createElement('div');modal.setAttribute('aria-modal','true');document.body.append(modal);
  assert.equal(f.editor.nativeAction!('bold'),false);modal.remove();
  const search=document.createElement('div');search.className='cm-search';f.view.dom.append(search);
  assert.equal(f.editor.nativeAction!('bold'),false);search.remove();
  f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
  assert.equal(f.editor.nativeAction!('bold'),false);
  f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
  current=false;assert.equal(f.editor.nativeAction!('bold'),false);current=true;
  f.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});
  assert.equal(f.editor.nativeAction!('bold'),false);assert.equal(f.editor.getValue(),'alpha');
});

test('nested table cell survives native blur, uses parent history, rejects block insertion and removed cells', async t => {
  const f=setup(t,'| Head |\n| --- |\n| alpha |');const child=cellEditor(f.host,f.dom);
  child.dispatch({selection:EditorSelection.single(0,5)});await flush();
  child.contentDOM.blur();await flush();assert.ok(child.dom.isConnected);
  assert.equal(f.editor.nativeAction!('bold'),true);assert.match(f.editor.getValue(),/\*\*alpha\*\*/);
  assert.equal(f.editor.nativeAction!('insertTable'),false);
  assert.equal(f.editor.nativeAction!('undo'),true);assert.doesNotMatch(f.editor.getValue(),/\*\*alpha\*\*/);
  await flush();f.editor.setValue('replacement');assert.equal(f.editor.nativeAction!('italic'),false);
});

test('native insertion reuses link/code/rule/table commands and dismiss disables restoration', async t => {
  const f=setup(t,'hello','source');f.cursor(5);
  assert.equal(f.editor.nativeAction!('insertLink'),true);assert.match(f.editor.getValue(),/\[.*\]\(/);
  f.editor.nativeAction!('undo');f.cursor(5);assert.equal(f.editor.nativeAction!('insertCodeBlock'),true);assert.match(f.editor.getValue(),/```/);
  f.editor.nativeAction!('undo');f.cursor(5);assert.equal(f.editor.nativeAction!('insertHorizontalRule'),true);assert.match(f.editor.getValue(),/\*\*\*/);
  f.editor.nativeAction!('undo');f.cursor(5);assert.equal(f.editor.nativeAction!('insertTable'),true);assert.match(f.editor.getValue(),/\|/);
  assert.equal(f.editor.nativeAction!('dismissKeyboard'),true);assert.equal(f.editor.nativeAction!('bold'),false);
});

test('native seam is absent without opt-in callback', t => {
  const f=setup(t,'alpha','source',{onNativeEditorState:undefined});assert.equal(f.editor.nativeAction,undefined);assert.equal(f.editor.nativeState,undefined);
});

test('focus reentrancy cannot refresh an in-flight action witness onto a replacement document', async t => {
  const f=setup(t,'original','source');f.view.dispatch({selection:EditorSelection.single(0,8)});await flush();
  f.view.contentDOM.blur();await flush();
  f.view.contentDOM.addEventListener('focus',()=>{f.editor.setValue('replacement');f.editor.nativeState!();},{once:true});
  assert.equal(f.editor.nativeAction!('bold'),false);assert.equal(f.editor.getValue(),'replacement');
});

test('completion, noneditable and removed editors cannot accept native mutations', async t => {
  const f=setup(t,'alpha','source');await flush();
  const completion=document.createElement('div');completion.className='cm-tooltip-autocomplete';f.view.dom.append(completion);
  assert.equal(f.editor.nativeAction!('inlineCode'),false);completion.remove();
  f.view.dispatch({effects:StateEffect.appendConfig.of(EditorView.editable.of(false))});
  assert.equal(f.editor.nativeAction!('bold'),false);
  f.host.remove();assert.equal(f.editor.nativeAction!('undo'),false);assert.equal(f.editor.nativeState!().editable,false);
});

for(const [action,marker] of [['strikethrough','~~'],['inlineCode','`']] as const)test(`native ${action} uses current multiple-selection formatting`, t => {
  const f=setup(t,'alpha beta','source');f.view.dispatch({selection:EditorSelection.create([EditorSelection.range(0,5),EditorSelection.range(10,6)],1)});
  assert.equal(f.editor.nativeAction!(action),true);assert.equal(f.editor.getValue(),`${marker}alpha${marker} ${marker}beta${marker}`);
});

test('a descendant control focus followed by blur cannot resurrect the previous body selection', async t => {
  const f=setup(t,'alpha','source');f.view.dispatch({selection:EditorSelection.single(0,5)});await flush();
  const input=document.createElement('input');f.view.dom.append(input);input.focus();await flush();
  input.blur();await flush();assert.equal(f.editor.nativeAction!('bold'),false);assert.equal(f.editor.getValue(),'alpha');
  f.view.focus();assert.equal(f.editor.nativeAction!('bold'),true);
});

test('disabled-state callback can reenter teardown without recursion or double destruction', async t => {
  let teardown:(()=>void)|undefined;let disabledCalls=0;
  const f=setup(t,'alpha','source',{onNativeEditorState:state=>{if(!state.focused&&!state.editable&&teardown){disabledCalls++;teardown();}}});
  await flush();teardown=()=>f.editor.destroy();f.destroy();
  assert.equal(disabledCalls,1);assert.equal(f.editor.nativeAction!('bold'),false);f.editor.destroy();assert.equal(disabledCalls,1);
});

// These exercise the real producer and CodeMirror state. They do not prove WK
// selection handles, native IME, media controls or UIKit edge arbitration.
test('navigation revision is stable on identical polls but observes synchronous CM selection and document round trips', async t => {
  const f=setup(t,'alpha','source');await flush();
  const initial=f.editor.nativeState!();
  assert.equal(f.editor.nativeState!().navigationRevision,initial.navigationRevision);
  assert.equal(initial.selectionCollapsed,true);
  f.cursor(2);f.cursor(0);
  const moved=f.editor.nativeState!();
  assert.ok(moved.navigationRevision>initial.navigationRevision);
  assert.equal(moved.selectionCollapsed,true);
  assert.equal(f.editor.nativeState!().navigationRevision,moved.navigationRevision);
  f.editor.setValue('temporary');f.editor.setValue('alpha');
  assert.ok(f.editor.nativeState!().navigationRevision>moved.navigationRevision);
});

test('DOM and multiple CM selections block collapsed eligibility and advance the semantic witness', async t => {
  const f=setup(t,'alpha beta','source');await flush();
  const before=f.editor.nativeState!().navigationRevision;
  const text=f.line(0).firstChild!;
  const selection=document.getSelection()!;
  selection.setBaseAndExtent(text,5,text,0);
  document.dispatchEvent(new f.dom.window.Event('selectionchange'));
  assert.equal(f.editor.nativeState!().selectionCollapsed,false);
  assert.ok(f.editor.nativeState!().navigationRevision>before);
  selection.collapse(text,0);
  f.view.dispatch({selection:EditorSelection.create([EditorSelection.range(0,5),EditorSelection.cursor(8)],1)});
  assert.equal(f.editor.nativeState!().selectionCollapsed,false);
});

test('composition and known overlays are reported, including an overlay removed before observer delivery', async t => {
  const f=setup(t,'alpha','source');await flush();
  const before=f.editor.nativeState!().navigationRevision;
  const menu=document.createElement('div');menu.setAttribute('role','menu');document.body.append(menu);
  assert.equal(f.editor.nativeState!().interactionActive,true);
  menu.remove();await flush();
  assert.equal(f.editor.nativeState!().interactionActive,false);
  const settled=f.editor.nativeState!().navigationRevision;
  assert.ok(settled>before);
  const transient=document.createElement('div');transient.setAttribute('role','menu');document.body.append(transient);transient.remove();
  await flush();assert.ok(f.editor.nativeState!().navigationRevision>settled,'coalesced menu A-B-A invalidates the original gesture');
  const classOverlay=document.createElement('div');document.body.append(classOverlay);await flush();
  const beforeClass=f.editor.nativeState!().navigationRevision;
  classOverlay.classList.add('modal-overlay');classOverlay.classList.remove('modal-overlay');
  await flush();assert.ok(f.editor.nativeState!().navigationRevision>beforeClass,'class-only modal A-B-A also invalidates');
  for(const className of ['cm-search','cm-tooltip-autocomplete','zorid-image-resizing']){
    const overlay=document.createElement('div');overlay.className=className;f.view.dom.append(overlay);
    assert.equal(f.editor.nativeState!().interactionActive,true,className);overlay.remove();
  }
  f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
  assert.equal(f.editor.nativeState!().composing,true);
  f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(f.editor.nativeState!().composing,false);
});

test('plain body pointer pans stay unclaimed while known embed/control and text interactions block', async t => {
  const f=setup(t,'alpha','source');await flush();
  const pointer=(target:EventTarget,type:string,id:number)=>{
    const event=new f.dom.window.Event(type,{bubbles:true});Object.defineProperty(event,'pointerId',{value:id});target.dispatchEvent(event);
  };
  pointer(f.line(0),'pointerdown',1);
  assert.equal(f.editor.nativeState!().interactionActive,false,'do not disable all body edge pans');
  pointer(document,'pointerup',1);
  const embed=document.createElement('div');embed.className='cm-live-embed';f.view.dom.append(embed);
  pointer(embed,'pointerdown',2);assert.equal(f.editor.nativeState!().interactionActive,true);
  pointer(document,'pointercancel',2);assert.equal(f.editor.nativeState!().interactionActive,false);
  for(const tag of ['video','audio','canvas']){
    const media=document.createElement(tag);f.view.dom.append(media);
    pointer(media,'pointerdown',2);assert.equal(f.editor.nativeState!().interactionActive,true,tag);
    pointer(document,'pointercancel',2);assert.equal(f.editor.nativeState!().interactionActive,false);media.remove();
  }
  f.line(0).dispatchEvent(new f.dom.window.Event('dragstart',{bubbles:true}));
  assert.equal(f.editor.nativeState!().interactionActive,true);
  document.dispatchEvent(new f.dom.window.Event('dragend'));assert.equal(f.editor.nativeState!().interactionActive,false);
  f.view.contentDOM.dispatchEvent(new f.dom.window.Event('selectstart',{bubbles:true}));
  assert.equal(f.editor.nativeState!().interactionActive,true);
  pointer(document,'pointerup',3);assert.equal(f.editor.nativeState!().interactionActive,false);
  const input=document.createElement('input');document.body.append(input);input.focus();
  assert.equal(f.editor.nativeState!().interactionActive,true);
});

test('stale owners and destruction emit unsafe state; producer recreation does not reuse a revision', async t => {
  let current=true;const f=setup(t,'alpha','source',{isCurrent:()=>current});await flush();
  const initial=f.editor.nativeState!().navigationRevision;
  current=false;const stale=f.editor.nativeState!();
  assert.equal(stale.selectionCollapsed,false);assert.equal(stale.composing,true);assert.equal(stale.interactionActive,true);
  assert.ok(stale.navigationRevision>initial);
  f.destroy();const final=f.states.at(-1)!;
  assert.ok(final.navigationRevision>stale.navigationRevision);
  const count=f.states.length;
  document.dispatchEvent(new f.dom.window.Event('selectionchange'));
  document.dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));await flush();
  assert.equal(f.states.length,count,'destroy removes gesture-state listeners');
  const host=document.createElement('div');document.body.append(host);
  const replacement=createEditor(host,{value:'next',mode:'source',paths:()=>[],onChange(){},open(){},onNativeEditorState(){}});
  try { assert.ok(replacement.nativeState!().navigationRevision>final.navigationRevision); }
  finally { replacement.destroy(); }
});
