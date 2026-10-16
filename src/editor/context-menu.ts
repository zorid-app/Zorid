import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { selectAll } from '@codemirror/commands';
import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { retainTableEditor, tableMenuAt } from './live-tables.ts';
import type { TableMenuItem } from './live-tables.ts';
import { formatMenuForEditor } from './format-menu.ts';
import type { FormatMenuItem } from './format-menu.ts';

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
      const selected = editor.state.selection.ranges.some(range => !range.empty);
      const items: ContextMenuItem[] = editingText ? [
        { role: 'cut', enabled: !readOnly && selected },
        { role: 'copy', enabled: selected },
        { role: 'paste', enabled: !readOnly },
        { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: !readOnly },
        { id: 'select-all', label: 'Select all' },
      ] : [];
      const describeFormat = (entries: FormatMenuItem[]): ContextMenuItem[] => entries.map(item => {
        if ('type' in item) return { type: 'separator' };
        if ('submenu' in item) return { label: item.label, enabled: !readOnly && item.enabled, submenu: describeFormat(item.submenu) };
        const id = 'format-' + item.id; actions.set(id, item.run);
        return { id, label: item.label, enabled: !readOnly && item.enabled,
          ...(item.checked === undefined ? {} : { checked: item.checked }) };
      });
      if (editingText) items.unshift(...describeFormat(formatMenuForEditor(editor, { inTableCell: editor !== this.view })), { type: 'separator' });
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
      const doc = editor.state.doc, selection = editor.state.selection;
      const release = retainTableEditor(this.view, target);
      void (async () => {
        try {
          const id = await show(event, items);
          if (!id || !this.alive || version !== this.serial || !editor.dom.isConnected) return;
          if (editor.state.doc !== doc || !editor.state.selection.eq(selection)) return;
          if (id !== 'select-all' && (this.view.state.readOnly || editor.state.readOnly)) return;
          await actions.get(id)?.();
        } finally { release(); }
      })().catch(onError);
    };
    destroy() { this.alive = false; this.serial++; this.view.dom.removeEventListener('contextmenu', this.open); }
  });
}
