import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Route clicks on the note's empty body background to the owning editor.
 * Text, widgets and controls retain CodeMirror/browser selection behavior.
 * nativeCurrent opts native shells into touch focus during the trusted gesture.
 */
export function installEmptyNoteFocus(view: EditorView, host: HTMLElement, nativeCurrent?: () => boolean): () => void {
  const surface = host.closest<HTMLElement>('.note-scroll') ?? host;
  const document = host.ownerDocument;
  let destroyed = false;
  let pointer: { x: number; y: number; state: typeof view.state; moved: boolean; event: MouseEvent } | undefined;
  const usable = () => !destroyed && host.isConnected && view.dom.isConnected && !view.state.readOnly && view.state.facet(EditorView.editable);
  const blank = (event: {target: EventTarget | null; clientX: number; clientY: number}) => {
    // Only bare wrapper backgrounds belong here. Descendant controls, nested
    // editors, rendered links/embeds and contentDOM already own their events.
    if (event.target !== host && event.target !== surface) return false;
    const body = host.getBoundingClientRect(), bounds = surface.getBoundingClientRect();
    if (event.clientY < Math.max(body.top, view.contentDOM.getBoundingClientRect().bottom) || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY > bounds.bottom) return false;
    // A real scrollbar is not note content (clientWidth excludes its gutter).
    if (surface.offsetWidth > surface.clientWidth && event.clientX >= bounds.left + surface.clientLeft + surface.clientWidth) return false;
    if (surface.offsetHeight > surface.clientHeight && event.clientY >= bounds.top + surface.clientTop + surface.clientHeight) return false;
    return true;
  };
  const cancel = () => {
    pointer = undefined;
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', up, true);
    document.removeEventListener('dragstart', cancel, true);
    document.defaultView?.removeEventListener('blur', cancel);
  };
  const move = (event: MouseEvent) => {
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) pointer.moved = true;
  };
  const up = (event: MouseEvent) => {
    const start = pointer; cancel();
    if (!start || start.event.defaultPrevented || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || event.defaultPrevented || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || nativeCurrent&&!nativeCurrent() || !usable() || !blank(event)) return;
    // Never collapse a drag selection, replace a newer selection, or act on a
    // changed document while the mouse was held down.
    if (view.state.doc !== start.state.doc || !view.state.selection.eq(start.state.selection)) return;
    event.preventDefault();
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), userEvent: 'select.pointer' });
    view.focus();
  };
  let lastTouch: {x:number;y:number;at:number} | undefined;
  const down = (event: MouseEvent) => {
    cancel();
    if(!event.defaultPrevented&&event.button===0&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&lastTouch&&Date.now()-lastTouch.at<800&&Math.hypot(event.clientX-lastTouch.x,event.clientY-lastTouch.y)<=4&&blank(event)){event.preventDefault();return;}
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || nativeCurrent&&!nativeCurrent() || !usable() || !blank(event)) return;
    pointer = { x: event.clientX, y: event.clientY, state: view.state, moved: false, event };
    // Do not prevent mousedown: native dragging/selection remains available.
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('dragstart', cancel, true);
    document.defaultView?.addEventListener('blur', cancel);
  };
  // Native touch must transfer focus inside the original gesture. Waiting for
  // compatibility mouseup lets its preceding default mousedown blur the title
  // onto a non-editable wrapper before the body acquires focus.
  let touch: { id: number; x: number; y: number; state: typeof view.state; focus: Element | null; moved: boolean; event: TouchEvent; eligible: boolean } | undefined;
  const touchCancel = () => { touch = undefined; };
  const touchStart = (event: TouchEvent) => {
    touchCancel(); cancel(); lastTouch=undefined;
    const point = event.touches[0];
    if (event.touches.length !== 1 || !point || !blank({target:event.target,...pointCoords(point)})) return;
    const eligible=!event.defaultPrevented&&!!nativeCurrent?.()&&usable()&&!view.composing;
    touch = { id:point.identifier, x:point.clientX, y:point.clientY, state:view.state, focus:document.activeElement, moved:false, event, eligible };
  };
  const pointCoords = (point: Touch) => ({clientX:point.clientX,clientY:point.clientY});
  const additionalTouch = (event: TouchEvent) => { if(touch&&event.touches.length!==1)touchCancel(); };
  const touchMove = (event: TouchEvent) => {
    const point = [...event.touches].find(point => point.identifier === touch?.id);
    if (touch && (event.touches.length !== 1 || !point || Math.hypot(point.clientX-touch.x,point.clientY-touch.y)>4)) touch.moved=true;
  };
  const touchEnd = (event: TouchEvent) => {
    const start=touch;touchCancel();
    const point=[...event.changedTouches].find(point=>point.identifier===start?.id);
    // Even a rejected tracked gesture can emit compatibility mouse events.
    // Remember it before state/owner checks so mouseup cannot acquire a fresh
    // snapshot and bypass the touch gesture's rejection.
    if(start&&point)lastTouch={x:point.clientX,y:point.clientY,at:Date.now()};
    if (!start || !start.eligible || start.event.defaultPrevented || !point || event.touches.length || start.moved || event.defaultPrevented || !event.cancelable || !nativeCurrent?.() || !usable() || view.composing
      || document.activeElement!==start.focus || Math.hypot(point.clientX-start.x,point.clientY-start.y)>4
      || view.state.doc!==start.state.doc || !view.state.selection.eq(start.state.selection) || !blank({target:event.target,...pointCoords(point)})) return;
    // Cancel only a completed blank tap, never scrolling or content selection.
    event.preventDefault();
    view.dispatch({selection:EditorSelection.cursor(view.state.doc.length),userEvent:'select.pointer'});
    view.focus();
  };
  surface.addEventListener('mousedown', down);
  if(nativeCurrent){
    document.addEventListener('touchstart',additionalTouch,{capture:true,passive:true});
    document.defaultView?.addEventListener('blur',touchCancel);
    surface.addEventListener('touchstart',touchStart,{passive:true});
    surface.addEventListener('touchmove',touchMove,{passive:true});
    surface.addEventListener('touchend',touchEnd,{passive:false});
    surface.addEventListener('touchcancel',touchCancel);
  }
  return () => {
    destroyed = true; cancel(); touchCancel();surface.removeEventListener('mousedown', down);
    document.removeEventListener('touchstart',additionalTouch,true);document.defaultView?.removeEventListener('blur',touchCancel);
    surface.removeEventListener('touchstart',touchStart);surface.removeEventListener('touchmove',touchMove);
    surface.removeEventListener('touchend',touchEnd);surface.removeEventListener('touchcancel',touchCancel);
  };
}
