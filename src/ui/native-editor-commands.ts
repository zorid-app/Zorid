import type { EditorSelection, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { activeTableEditor, retainTableEditor } from '../editor/live-tables.ts';
import { runEditorCommand } from '../editor/editor-commands.ts';
import { canInsert } from '../editor/insertion-commands.ts';
import type { InsertionCommandId } from '../editor/insertion-commands.ts';

export interface NativeEditorState { focused: boolean; editable: boolean; canUndo: boolean; canRedo: boolean }
export type NativeEditorAction = 'insertLink' | 'insertTable' | 'insertCodeBlock' | 'insertHorizontalRule'
  | 'bold' | 'italic' | 'strikethrough' | 'inlineCode' | 'undo' | 'redo' | 'dismissKeyboard';
const commands = { insertLink: 'editor-insert-link', insertTable: 'editor-insert-table', insertCodeBlock: 'editor-insert-code-block',
  insertHorizontalRule: 'editor-insert-rule', bold: 'editor-bold', italic: 'editor-italic',
  strikethrough: 'editor-strikethrough', inlineCode: 'editor-code' } as const;
const disabled = (): NativeEditorState => ({focused:false,editable:false,canUndo:false,canRedo:false});

/** A native control has no DOM focus target. Retain exactly the body/cell which
 * owned focus, never resolve a replacement cell after UIKit takes keyboard focus. */
export function nativeEditorCommands(owner: EditorView, options: {
  isCurrent?: () => boolean; onNativeEditorState: (state: NativeEditorState) => void;
}) {
  const document = owner.dom.ownerDocument;
  let dead = false, queued = false, composing = false, dismissed = false;
  let captured: { target: EditorView; ownerDoc: Text; doc: Text; ownerSelection: EditorSelection; selection: EditorSelection; release: () => void } | undefined;
  let previous = '';
  const clear = () => { const old = captured; captured = undefined; old?.release(); };
  const current = () => {
    try { return !dead && (options.isCurrent?.() ?? true) && owner.dom.isConnected; }
    catch { return false; }
  };
  const body = () => {
    const target = activeTableEditor(owner) ?? owner;
    return document.activeElement === target.contentDOM ? target : undefined;
  };
  const blocked = (target: EditorView) => !current() || owner.state.readOnly || target.state.readOnly
    || !owner.state.facet(EditorView.editable) || !target.state.facet(EditorView.editable)
    || composing || owner.compositionStarted || target.compositionStarted || owner.composing || target.composing
    || !!document.querySelector('.modal-overlay,[aria-modal="true"],[role="menu"]')
    || !!owner.dom.querySelector('.cm-tooltip-autocomplete,.cm-search');
  const capture = () => {
    const target = body();
    if (!target || dismissed || !current()) return;
    if (captured?.target !== target) { clear(); captured = { target, ownerDoc: owner.state.doc, doc: target.state.doc,
      ownerSelection: owner.state.selection, selection: target.state.selection, release: retainTableEditor(owner,target.contentDOM) }; }
    else { captured.ownerDoc=owner.state.doc; captured.doc=target.state.doc; captured.ownerSelection=owner.state.selection; captured.selection=target.state.selection; }
  };
  const valid = (c = captured) => {
    const focused = document.activeElement;
    return !!c && !dismissed && !blocked(c.target) && c.target.dom.isConnected && owner.dom.contains(c.target.dom)
      && (focused === c.target.contentDOM || focused === document.body)
      && owner.state.doc === c.ownerDoc && c.target.state.doc === c.doc
      && owner.state.selection.eq(c.ownerSelection) && c.target.state.selection.eq(c.selection);
  };
  const state = (): NativeEditorState => {
    if (dead) return disabled();
    capture();
    const editable = valid();
    return {focused:!!body() && !dismissed && current(), editable,
      canUndo:editable && undoDepth(owner.state)>0, canRedo:editable && redoDepth(owner.state)>0};
  };
  const publish = () => { const next=state(), encoded=JSON.stringify(next); if(encoded!==previous){previous=encoded;try{options.onNativeEditorState(next);}catch{/* Native presentation cannot fail an editor transaction. */}} };
  const update = () => { if(dead||queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!dead)publish();}); };
  const focus = (event: FocusEvent) => {
    // Widgets/search/properties inside the owner are not the body. Once any
    // such control owns input, a later blur must not resurrect its old caret.
    if(body())dismissed=false;
    else if(event.target!==document.body)clear();
    update();
  };
  const blur = () => { capture(); update(); };
  const start = () => { composing=true;update(); };
  const end = () => { composing=false;update(); };
  document.addEventListener('focusin',focus,true);
  owner.dom.addEventListener('focusout',blur,true);
  owner.dom.addEventListener('compositionstart',start,true);
  owner.dom.addEventListener('compositionend',end,true);
  const observer = new (document.defaultView!.MutationObserver)(update);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-modal','role','class']});
  update();
  return {
    update, state,
    action(action: NativeEditorAction): boolean {
      if(!Object.hasOwn(commands,action)&&!['undo','redo','dismissKeyboard'].includes(action))return false;
      capture();if(!valid())return false;
      // Focus handlers may synchronously refresh public state. Freeze this
      // action's witness rather than validating a newly captured document/cell.
      const original=captured!, c={...original};
      if(action==='dismissKeyboard'){dismissed=true;c.target.contentDOM.blur();clear();publish();return true;}
      const command=Object.hasOwn(commands,action)?commands[action as keyof typeof commands]:undefined;
      if(command?.startsWith('editor-insert-')&&!canInsert(c.target.state,command as InsertionCommandId,{inTableCell:c.target!==owner}))return false;
      if(action==='undo'&&!undoDepth(owner.state)||action==='redo'&&!redoDepth(owner.state))return false;
      c.target.focus();
      if(captured!==original||!valid(c))return false;
      const before=owner.state.doc;
      if(action==='undo')undo(owner);else if(action==='redo')redo(owner);else runEditorCommand(command!,c.target,owner);
      capture();update();return owner.state.doc!==before;
    },
    destroy(){if(dead)return;dead=true;observer.disconnect();document.removeEventListener('focusin',focus,true);owner.dom.removeEventListener('focusout',blur,true);
      owner.dom.removeEventListener('compositionstart',start,true);owner.dom.removeEventListener('compositionend',end,true);clear();try{options.onNativeEditorState(disabled());}catch{/* Presentation only. */}},
  };
}
