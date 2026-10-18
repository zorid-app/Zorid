import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { selectAll } from '@codemirror/commands';
import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { activeTableEditor, retainTableEditor, tableContextMenuTarget, tableMenuAt, tableSelectionAt, tableSelectionRanges, tableSelectionAnnotation } from './live-tables.ts';
import type { TableMenuItem } from './live-tables.ts';
import { formatMenuForEditor } from './format-menu.ts';
import type { FormatMenuItem } from './format-menu.ts';

/** Renderer commands remain local; only bounded menu descriptors cross IPC. */
export function editorContextMenu(show = showContextMenu, onError: (error: unknown) => void = console.error,
  captureAuthoring?: () => (() => boolean) | null): Extension {
  return ViewPlugin.fromClass(class {
    private alive = true;
    private serial = 0;
    private view: EditorView;
    private session?: AbortController;
    constructor(view: EditorView) { this.view = view; view.dom.addEventListener('contextmenu', this.open); }
    private open = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const authoring = captureAuthoring?.();
      const target = tableContextMenuTarget(this.view, event);
      if (!target || target.nodeType !== 1) return;
      const table = tableMenuAt(this.view, target);
      const content = target.closest('.cm-content');
      // Search panels and embedded property/media controls own their own menus.
      if (!content && !table.length || target.closest('input, textarea, select, button')) return;
      const editorElement = target.closest<HTMLElement>('.cm-editor');
      const editor = editorElement ? EditorView.findFromDOM(editorElement) : this.view;
      if (!editor || !this.view.dom.contains(editor.dom)) return;
      if (captureAuthoring && !authoring) { event.preventDefault(); event.stopPropagation(); return; }
      const rectangle = tableSelectionAt(this.view, target);
      const version = ++this.serial, readOnly = this.view.state.readOnly || !rectangle && editor.state.readOnly;
      const actions = new Map<string, () => unknown>([['select-all', () => selectAll(editor)]]);
      // A rendered cell supplies only its table menu. The active nested editor
      // contributes editor commands before the table sections.
      const editingText = !rectangle && (!table.length || editor !== this.view);
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
        if ('role' in item) return { role: item.role, label: item.label, enabled: item.enabled && (item.role === 'copy' || !readOnly) };
        if ('submenu' in item) return { label: item.label, submenu: describeTable(item.submenu) };
        const id = 'table-' + item.id; actions.set(id, item.run);
        return { id, label: item.label, enabled: !readOnly && item.enabled };
      });
      if (table.length) {
        if (items.length) items.push({ type: 'separator' });
        items.push(...describeTable(table));
      }
      if (rectangle) {
        const format = formatMenuForEditor(this.view, {
          ranges: () => tableSelectionRanges(this.view, target), annotations: [tableSelectionAnnotation],
        }).filter(item => 'id' in item && item.id === 'format');
        items.splice(3, 0, ...describeFormat(format));
      }
      const doc = editor.state.doc, selection = editor.state.selection;
      const rectangleSnapshot = JSON.stringify(tableSelectionRanges(this.view, target));
      const cellEditor = activeTableEditor(this.view);
      const release = retainTableEditor(this.view, target);
      const current = () => this.alive && version === this.serial && editor.dom.isConnected
        && (!authoring || authoring()) && editor.state.doc === doc && editor.state.selection.eq(selection)
        && (!rectangle || JSON.stringify(tableSelectionRanges(this.view, target)) === rectangleSnapshot);
      const session = new AbortController();
      this.session?.abort(); this.session = session;
      void (async () => {
        try {
          const id = await show(event, items, { signal: session.signal, ...(authoring ? { isCurrent: current } : {}) });
          if (!id || authoring && !authoring() || !this.alive || version !== this.serial || !editor.dom.isConnected) return;
          if (editor.state.doc !== doc || !editor.state.selection.eq(selection)) return;
          if (rectangle && JSON.stringify(tableSelectionRanges(this.view, target)) !== rectangleSnapshot) return;
          if (id !== 'select-all' && (this.view.state.readOnly || !rectangle && editor.state.readOnly)) return;
          await actions.get(id)?.();
          if ((!authoring || authoring()) && rectangle && id.startsWith('format-') && cellEditor?.dom.isConnected) cellEditor.focus();
        } finally { if (this.session === session) this.session = undefined; release(); }
      })().catch(onError);
    };
    destroy() { this.alive = false; this.session?.abort(); this.serial++; this.view.dom.removeEventListener('contextmenu', this.open); }
  });
}
