import { EditorSelection, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { activeTableEditor } from './live-tables.ts';

export interface TransferFile {
  name: string;
  type: string;
  nativePath?: string;
  read(): Promise<Uint8Array>;
}
export interface TransferOptions {
  importFile(file: TransferFile): Promise<string>;
  nativePath?: (file: File) => string;
  onError?: (error: unknown) => void;
}

function readFile(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(buffer => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Unable to read ${file.name}`));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

/** Copy the File handles while the native event's transfer store is readable. */
export function transferFiles(transfer: DataTransfer, nativePath?: (file: File) => string): TransferFile[] {
  const files = transfer.items?.length
    ? Array.from(transfer.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file)
    : Array.from(transfer.files ?? []);
  return files.map(file => ({ name: file.name, type: file.type,
    nativePath: nativePath?.(file) || undefined, read: () => readFile(file) }));
}

function replace(view: EditorView, text: string, event: string) {
  view.dispatch({ ...view.state.replaceSelection(text), annotations: Transaction.userEvent.of(event), scrollIntoView: true });
}

/** A URL can replace selected label text, including corresponding multi-cursor labels. */
export function pasteURLs(view: EditorView, text: string): boolean {
  const urls = text.trim().split(/\r?\n/);
  if (!urls.every(url => /^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(url))) return false;
  const ranges = view.state.selection.ranges;
  if ((urls.length !== 1 && urls.length !== ranges.length)
    || ranges.some(range => range.empty || /[\r\n]/.test(view.state.sliceDoc(range.from, range.to)))) return false;
  let index = 0;
  const change = view.state.changeByRange(range => {
    const label = view.state.sliceDoc(range.from, range.to), url = urls.length === 1 ? urls[0] : urls[index]; index++;
    const inserted = `[${label}](${url})`;
    return { changes: { from: range.from, to: range.to, insert: inserted }, range: EditorSelection.cursor(range.from + inserted.length) };
  });
  view.dispatch({ ...change, annotations: Transaction.userEvent.of('input.paste'), scrollIntoView: true });
  return true;
}

/** Shared web transfer path for Electron and Capacitor. Native-only formats are separate adapters. */
export function editorTransfers(options: TransferOptions): Extension {
  return ViewPlugin.fromClass(class {
    private view: EditorView;
    private disposed = false;
    private pending: Promise<void> = Promise.resolve();
    constructor(view: EditorView) {
      this.view = view;
      // Capture also reaches nested table editors, whose widgets ignore outer CM events.
      view.dom.addEventListener('paste', this.paste, true);
      view.dom.addEventListener('drop', this.drop, true);
      view.dom.addEventListener('dragover', this.dragOver, true);
    }
    private target(event: Event): EditorView | null {
      const target = event.target as Node | null;
      const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
      const root = element?.closest('.cm-editor');
      const view = root ? EditorView.findFromDOM(root as HTMLElement) : null;
      if (!view || !element || !view.contentDOM.contains(element)) return null;
      // Search panels and controls inside embeds own their input. Stop at the
      // resolved contentDOM so a nested table editor remains a valid target.
      for (let node: Element | null = element; node && node !== view.contentDOM; node = node.parentElement) {
        if (node.matches('input, textarea, select, button, [contenteditable="false"]')) return null;
      }
      return view;
    }
    private insertFiles(files: TransferFile[]) {
      this.pending = this.pending.then(async () => {
        for (let index = 0; index < files.length; index++) {
          if (this.disposed) return;
          const embed = await options.importFile(files[index]);
          // A completed binary write is retained, but never write into a closed/reused editor.
          if (this.disposed) return;
          const editor = activeTableEditor(this.view) ?? this.view;
          if (editor.state.readOnly) return;
          replace(editor, embed + (index < files.length - 1 ? '\n\n' : ''), 'input.paste');
        }
      }).catch(error => { if (!this.disposed) options.onError?.(error); });
    }
    private paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const view = this.target(event); if (!view || view.state.readOnly) return;
      const transfer = event.clipboardData, markdown = transfer.getData('text/markdown');
      const text = markdown || transfer.getData('text/plain');
      if (text && pasteURLs(view, text)) { event.preventDefault(); event.stopPropagation(); return; }
      // The Markdown extension has its own URL-over-selection paste handler.
      // Consume rejected label shapes here so it cannot wrap multiline labels.
      if (text && view.state.selection.ranges.some(range => !range.empty)
        && text.trim().split(/\r?\n/).every(url => /^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(url))) {
        event.preventDefault(); event.stopPropagation(); replace(view, text, 'input.paste'); return;
      }
      if (markdown) { event.preventDefault(); event.stopPropagation(); replace(view, markdown, 'input.paste'); return; }
      let files: TransferFile[];
      try { files = transferFiles(transfer, options.nativePath); }
      catch (error) { event.preventDefault(); options.onError?.(error); return; }
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); this.insertFiles(files);
    };
    private dragOver = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
      const view = this.target(event); if (!view || view.state.readOnly) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    };
    private drop = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer) return;
      const view = this.target(event); if (!view || view.state.readOnly) return;
      let files: TransferFile[];
      try { files = transferFiles(event.dataTransfer, options.nativePath); }
      catch (error) { event.preventDefault(); options.onError?.(error); return; }
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position !== null) view.dispatch({ selection: { anchor: position }, annotations: Transaction.userEvent.of('select.pointer') });
      view.focus(); this.insertFiles(files);
    };
    destroy() {
      this.disposed = true;
      this.view.dom.removeEventListener('paste', this.paste, true);
      this.view.dom.removeEventListener('drop', this.drop, true);
      this.view.dom.removeEventListener('dragover', this.dragOver, true);
    }
  });
}
