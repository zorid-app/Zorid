import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth, selectAll } from '@codemirror/commands';
import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { tableActionsAt } from './live-tables.ts';

/** Renderer commands remain local; only bounded menu descriptors cross IPC. */
export function editorContextMenu(show = showContextMenu, onError: (error: unknown) => void = console.error): Extension {
  return ViewPlugin.fromClass(class {
    private alive = true;
    private serial = 0;
    private view: EditorView;
    constructor(view: EditorView) { this.view = view; view.dom.addEventListener('contextmenu', this.open); }
    private open = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (!target || target.nodeType !== 1) return;
      const table = tableActionsAt(this.view, target);
      const content = target.closest('.cm-content');
      // Search panels and embedded property/media controls own their own menus.
      if (!content && !table.length || target.closest('input, textarea, select, button')) return;
      const editorElement = target.closest<HTMLElement>('.cm-editor');
      const editor = editorElement ? EditorView.findFromDOM(editorElement) : this.view;
      if (!editor || !this.view.dom.contains(editor.dom)) return;
      const version = ++this.serial, readOnly = this.view.state.readOnly || editor.state.readOnly;
      const actions = new Map<string, () => unknown>([
        ['undo', () => undo(this.view)], ['redo', () => redo(this.view)],
        ['select-all', () => selectAll(editor)],
      ]);
      const items: ContextMenuItem[] = [
        { id: 'undo', label: 'Undo', enabled: !readOnly && undoDepth(this.view.state) > 0 },
        { id: 'redo', label: 'Redo', enabled: !readOnly && redoDepth(this.view.state) > 0 },
        { type: 'separator' },
        { role: 'cut', enabled: !readOnly && !editor.state.selection.main.empty },
        { role: 'copy', enabled: !editor.state.selection.main.empty },
        { role: 'paste', enabled: !readOnly },
        { role: 'pasteAndMatchStyle', enabled: !readOnly },
        { type: 'separator' }, { id: 'select-all', label: 'Select all' },
      ];
      if (table.length) {
        items.push({ type: 'separator' });
        for (const action of table) {
          const id = 'table-' + action.id; actions.set(id, action.run);
          items.push({ id, label: action.label, enabled: !readOnly && action.enabled });
        }
      }
      void show(event, items).then(id => {
        if (!id || !this.alive || version !== this.serial || !editor.dom.isConnected) return;
        if (id !== 'select-all' && (this.view.state.readOnly || editor.state.readOnly)) return;
        actions.get(id)?.();
      }).catch(onError);
    };
    destroy() { this.alive = false; this.serial++; this.view.dom.removeEventListener('contextmenu', this.open); }
  });
}
