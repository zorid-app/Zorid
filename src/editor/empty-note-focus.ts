import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Route clicks on the note's empty body background to the owning editor.
 * Text, widgets and controls retain CodeMirror/browser selection behavior.
 */
export function installEmptyNoteFocus(view: EditorView, host: HTMLElement): () => void {
  const surface = host.closest<HTMLElement>('.note-scroll') ?? host;
  const document = host.ownerDocument;
  let destroyed = false;
  let pointer: { x: number; y: number; state: typeof view.state; moved: boolean; event: MouseEvent } | undefined;
  const usable = () => !destroyed && host.isConnected && view.dom.isConnected && !view.state.readOnly && view.state.facet(EditorView.editable);
  const blank = (event: MouseEvent) => {
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
    if (!start || start.event.defaultPrevented || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || event.defaultPrevented || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !usable() || !blank(event)) return;
    // Never collapse a drag selection, replace a newer selection, or act on a
    // changed document while the mouse was held down.
    if (view.state.doc !== start.state.doc || !view.state.selection.eq(start.state.selection)) return;
    event.preventDefault();
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), userEvent: 'select.pointer' });
    view.focus();
  };
  const down = (event: MouseEvent) => {
    cancel();
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !usable() || !blank(event)) return;
    pointer = { x: event.clientX, y: event.clientY, state: view.state, moved: false, event };
    // Do not prevent mousedown: native dragging/selection remains available.
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('dragstart', cancel, true);
    document.defaultView?.addEventListener('blur', cancel);
  };
  surface.addEventListener('mousedown', down);
  return () => { destroyed = true; cancel(); surface.removeEventListener('mousedown', down); };
}
