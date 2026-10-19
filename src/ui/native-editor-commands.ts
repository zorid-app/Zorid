import { searchPanelOpen } from '@codemirror/search';
import type { EditorSelection, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { activeTableEditor, retainTableEditor } from '../editor/live-tables.ts';
import { runEditorCommand } from '../editor/editor-commands.ts';
import { canInsert } from '../editor/insertion-commands.ts';
import type { InsertionCommandId } from '../editor/insertion-commands.ts';

export interface NativeEditorState {
  focused: boolean; editable: boolean; canUndo: boolean; canRedo: boolean;
  selectionCollapsed: boolean; composing: boolean; interactionActive: boolean; navigationRevision: number;
}
export type NativeEditorAction = 'insertLink' | 'insertTable' | 'insertCodeBlock' | 'insertHorizontalRule'
  | 'bold' | 'italic' | 'strikethrough' | 'inlineCode' | 'undo' | 'redo' | 'dismissKeyboard';
const commands = { insertLink: 'editor-insert-link', insertTable: 'editor-insert-table', insertCodeBlock: 'editor-insert-code-block',
  insertHorizontalRule: 'editor-insert-rule', bold: 'editor-bold', italic: 'editor-italic',
  strikethrough: 'editor-strikethrough', inlineCode: 'editor-code' } as const;
// Shared across producer recreation in this JS realm. This is a UI witness,
// never a vault revision/lease. Exhaustion fails closed without wrapping.
let navigationClock = 0, navigationExhausted = false;
const nextRevision = () => {
  if (navigationClock === Number.MAX_SAFE_INTEGER) navigationExhausted = true;
  else navigationClock++;
  return navigationClock;
};
const disabled = (navigationRevision: number): NativeEditorState => ({focused:false,editable:false,canUndo:false,canRedo:false,
  selectionCollapsed:false,composing:true,interactionActive:true,navigationRevision});
const overlays = '.modal-overlay,[aria-modal="true"],[role="menu"],[role="dialog"],.cm-tooltip-autocomplete,.cm-search,.zorid-image-resizing,.zorid-image-selected';
const interactive = 'a,button,input,textarea,select,audio,video,iframe,object,embed,canvas,summary,[role="button"],[contenteditable="false"],.interactive-child,.cm-live-embed,.cm-embed-block,.cm-live-table';

/** A native control has no DOM focus target. Retain exactly the body/cell which
 * owned focus, never resolve a replacement cell after UIKit takes keyboard focus. */
export function nativeEditorCommands(owner: EditorView, options: {
  isCurrent?: () => boolean; onNativeEditorState: (state: NativeEditorState) => void;
}) {
  const document = owner.dom.ownerDocument;
  let dead = false, queued = false, composing = false, dismissed = false;
  let selecting = false, dragging = false, contextInteraction = false;
  const interactionPointers = new Set<number>();
  let navigationRevision = 0;
  type Witness = {
    current: boolean; target: EditorView; doc: Text; selection: EditorSelection; targetDoc: Text; targetSelection: EditorSelection;
    focus: Element | null; anchor: Node | null; anchorOffset: number; head: Node | null; headOffset: number; ranges: number;
    flags: string;
  };
  let witness: Witness | undefined;
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
    || searchPanelOpen(owner.state) || !!owner.dom.querySelector('.cm-tooltip-autocomplete,.cm-search');
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
  const state = (captureFocus = true): NativeEditorState => {
    if (dead || navigationExhausted) return disabled(navigationRevision);
    if(captureFocus)capture();
    const target = activeTableEditor(owner) ?? owner;
    const selection = document.getSelection();
    const isCurrent = current();
    const inComposition = composing || owner.composing || owner.compositionStarted || target.composing || target.compositionStarted;
    const active = document.activeElement;
    const interactionActive = !isCurrent || selecting || dragging || contextInteraction || interactionPointers.size > 0
      || !!document.querySelector(overlays) || (!body() && active !== document.body);
    const editable = valid();
    const next = {focused:!!body() && !dismissed && isCurrent, editable,
      canUndo:editable && undoDepth(owner.state)>0, canRedo:editable && redoDepth(owner.state)>0,
      selectionCollapsed:!!selection && selection.isCollapsed && owner.state.selection.ranges.every(range => range.empty)
        && target.state.selection.ranges.every(range => range.empty),
      composing:inComposition, interactionActive};
    const now: Witness = {current:isCurrent,target,doc:owner.state.doc,selection:owner.state.selection,
      targetDoc:target.state.doc,targetSelection:target.state.selection,focus:active,
      anchor:selection?.anchorNode ?? null,anchorOffset:selection?.anchorOffset ?? 0,
      head:selection?.focusNode ?? null,headOffset:selection?.focusOffset ?? 0,ranges:selection?.rangeCount ?? -1,
      flags:JSON.stringify(next)};
    if (!witness || witness.current !== now.current || witness.target !== now.target || witness.doc !== now.doc
      || !witness.selection.eq(now.selection) || witness.targetDoc !== now.targetDoc || !witness.targetSelection.eq(now.targetSelection)
      || witness.focus !== now.focus || witness.anchor !== now.anchor || witness.anchorOffset !== now.anchorOffset
      || witness.head !== now.head || witness.headOffset !== now.headOffset || witness.ranges !== now.ranges || witness.flags !== now.flags) {
      navigationRevision = nextRevision(); witness = now;
    }
    return navigationExhausted || !isCurrent ? disabled(navigationRevision) : {...next,navigationRevision};
  };
  const publish = () => { const next=state(), encoded=JSON.stringify(next); if(encoded!==previous){previous=encoded;try{options.onNativeEditorState(next);}catch{/* Native presentation cannot fail an editor transaction. */}} };
  // Sample before coalescing: selection/document A->B->A still invalidates the
  // native gesture's original witness, even if only the final state is sent.
  const update = () => { if(dead)return;state(false);if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!dead)publish();}); };
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
  const selectionChanged = () => { update(); };
  const selectStart = () => { selecting=true;update(); };
  const pointerDown = (event: PointerEvent) => {
    contextInteraction=false;
    const element = event.target instanceof document.defaultView!.Element ? event.target : null;
    // Plain body pans stay eligible. Only known interactive surfaces claim a
    // pointer; do not rewrite editor gestures or prevent any DOM event.
    if(element?.closest(interactive))interactionPointers.add(event.pointerId);
    update();
  };
  const pointerEnd = (event: PointerEvent) => { interactionPointers.delete(event.pointerId);selecting=false;update(); };
  const dragStart = () => { dragging=true;update(); };
  const dragEnd = () => { dragging=false;update(); };
  const contextMenu = () => { contextInteraction=true;update(); };
  const key = () => { contextInteraction=false;selecting=false;update(); };
  const deactivate = () => { interactionPointers.clear();selecting=false;dragging=false;contextInteraction=true;update(); };
  document.addEventListener('focusin',focus,true);
  owner.dom.addEventListener('focusout',blur,true);
  owner.dom.addEventListener('compositionstart',start,true);
  owner.dom.addEventListener('compositionend',end,true);
  document.addEventListener('selectionchange',selectionChanged);
  owner.dom.addEventListener('selectstart',selectStart,true);
  document.addEventListener('pointerdown',pointerDown,true);
  document.addEventListener('pointerup',pointerEnd,true);
  document.addEventListener('pointercancel',pointerEnd,true);
  document.addEventListener('dragstart',dragStart,true);
  document.addEventListener('dragend',dragEnd,true);
  document.addEventListener('drop',dragEnd,true);
  document.addEventListener('contextmenu',contextMenu,true);
  document.addEventListener('keydown',key,true);
  document.defaultView!.addEventListener('blur',deactivate);
  const observer = new (document.defaultView!.MutationObserver)(records => {
    // A menu can open and close within one observer delivery. Invalidate even
    // when its final DOM state matches the previous sample.
    const relevantNode = (node: Node) => node instanceof document.defaultView!.Element
      && (node.matches(overlays) || !!node.querySelector(overlays));
    if (records.some(record => record.type === 'childList'
      ? [...record.addedNodes,...record.removedNodes].some(relevantNode)
      : record.attributeName !== 'class' || relevantNode(record.target)
        || /(?:^|\s)(?:modal-overlay|cm-tooltip-autocomplete|cm-search|zorid-image-(?:resizing|selected))(?:\s|$)/.test(record.oldValue ?? ''))) navigationRevision=nextRevision();
    update();
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['aria-modal','role','class']});
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
      owner.dom.removeEventListener('compositionstart',start,true);owner.dom.removeEventListener('compositionend',end,true);
      document.removeEventListener('selectionchange',selectionChanged);owner.dom.removeEventListener('selectstart',selectStart,true);
      document.removeEventListener('pointerdown',pointerDown,true);document.removeEventListener('pointerup',pointerEnd,true);document.removeEventListener('pointercancel',pointerEnd,true);
      document.removeEventListener('dragstart',dragStart,true);document.removeEventListener('dragend',dragEnd,true);document.removeEventListener('drop',dragEnd,true);
      document.removeEventListener('contextmenu',contextMenu,true);document.removeEventListener('keydown',key,true);document.defaultView!.removeEventListener('blur',deactivate);
      clear();navigationRevision=nextRevision();try{options.onNativeEditorState(disabled(navigationRevision));}catch{/* Presentation only. */}},
  };
}
