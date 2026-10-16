import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { selectAll } from '@codemirror/commands';
import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { tableMenuAt } from './live-tables.ts';
import type { TableMenuItem } from './live-tables.ts';

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
      const table = tableMenuAt(this.view, target);
      const content = target.closest('.cm-content');
      // Search panels and embedded property/media controls own their own menus.
      if (!content && !table.length || target.closest('input, textarea, select, button')) return;
      const editorElement = target.closest<HTMLElement>('.cm-editor');
      const editor = editorElement ? EditorView.findFromDOM(editorElement) : this.view;
      if (!editor || !this.view.dom.contains(editor.dom)) return;
      const version = ++this.serial, readOnly = this.view.state.readOnly || editor.state.readOnly;
      const actions = new Map<string, () => unknown>([['select-all', () => selectAll(editor)]]);
      // A rendered cell supplies only its table menu. The active nested editor
      // contributes editor commands before the table sections.
      const editingText = !table.length || editor !== this.view;
      const items: ContextMenuItem[] = editingText ? [
        { role: 'cut', enabled: !readOnly && !editor.state.selection.main.empty },
        { role: 'copy', enabled: !editor.state.selection.main.empty },
        { role: 'paste', enabled: !readOnly },
        { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: !readOnly },
        { id: 'select-all', label: 'Select all' },
      ] : [];
      const describeTable = (entries: TableMenuItem[]): ContextMenuItem[] => entries.map(item => {
        if ('type' in item) return { type: 'separator' };
        if ('submenu' in item) return { label: item.label, submenu: describeTable(item.submenu) };
        const id = 'table-' + item.id; actions.set(id, item.run);
        return { id, label: item.label, enabled: !readOnly && item.enabled };
      });
      if (table.length) {
        if (items.length) items.push({ type: 'separator' });
        items.push(...describeTable(table));
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
