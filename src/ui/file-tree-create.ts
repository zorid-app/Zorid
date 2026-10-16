/** File-tree creation and inline title editing. Reference notes: docs/file-tree-create-reference.md. */
export interface InlineFolderCreationHost {
  /** Stable vault identity: creation allocation is serialized for this owner. */
  owner: object;
  paths: () => Iterable<string>;
  createFolder: (path: string) => Promise<unknown>;
  /** Capture vault identity and creation/navigation intent before calling. */
  isCurrent: () => boolean;
  /** Expand ancestors, render in normal sort order, then start inline rename. */
  revealAndEdit: (path: string) => void | Promise<void>;
}

export function availableFolderPath(paths: Iterable<string>, parent = '', title = 'Untitled folder'): string {
  const occupied = new Set(Array.from(paths, path => path.normalize('NFC').toLowerCase()));
  const prefix = parent ? `${parent.replace(/\/+$/, '')}/` : '';
  let index = 0;
  while (true) {
    const candidate = `${prefix}${title}${index ? ` ${index}` : ''}`;
    if (!occupied.has(candidate.normalize('NFC').toLowerCase())) return candidate;
    index++;
  }
}

const creationQueues = new WeakMap<object, Promise<unknown>>();

/** Creation precedes editing: Escape keeps the new, default-named folder. */
export async function createFolderInline(host: InlineFolderCreationHost, parent = ''): Promise<string | undefined> {
  if (!host.isCurrent()) return;
  const previous = creationQueues.get(host.owner);
  const creation = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
    // Each accepted request creates one folder in its original vault. Presentation
    // ownership may change while queued, but must never redirect the filesystem call.
    const path = availableFolderPath(host.paths(), parent);
    await host.createFolder(path);
    return path;
  });
  creationQueues.set(host.owner, creation);
  try {
    const path = await creation;
    if (host.isCurrent()) await host.revealAndEdit(path);
    return path;
  } finally {
    if (creationQueues.get(host.owner) === creation) creationQueues.delete(host.owner);
  }
}

export type FileTreeRenameFinish = 'enter' | 'blur' | 'escape' | 'dispose';
export interface FileTreeRenameOptions {
  name: string;
  /** Return a normalized display name, if different from the supplied name. */
  save: (name: string) => Promise<string | void>;
  isCurrent: () => boolean;
  onFinish: (reason: FileTreeRenameFinish, name: string) => void;
  onError: (error: unknown) => void;
  /** Optional immediate, advisory validation; save remains authoritative. */
  validate?: (name: string) => string | undefined;
  spellcheck?: boolean;
}

/** A rename draft survives tree reconstruction without stealing later focus. */
export class FileTreeRenameSession {
  private options: FileTreeRenameOptions;
  private row?: HTMLElement;
  private label?: HTMLElement;
  private detach?: () => void;
  private draft: string;
  private name: string;
  private active = true;
  private pending?: Promise<boolean>;
  private exitOnBlur = false;
  private error?: HTMLElement;

  constructor(options: FileTreeRenameOptions) {
    this.options = options;
    this.name = this.draft = options.name;
  }

  get value(): string { return this.label?.textContent ?? this.draft; }
  get isActive(): boolean { return this.active; }

  attach(row: HTMLElement, label: HTMLElement, { focus = true }: { focus?: boolean } = {}): void {
    if (!this.active) return;
    this.draft = this.value;
    this.detach?.();
    this.row = row; this.label = label;
    const wasDraggable = row.draggable;
    row.draggable = false;
    row.classList.add('is-being-renamed');
    label.textContent = this.draft;
    label.setAttribute('contenteditable', this.pending ? 'false' : 'true');
    label.setAttribute('role', 'textbox');
    label.setAttribute('aria-label', 'Folder or file name');
    label.setAttribute('spellcheck', String(this.options.spellcheck ?? true));
    label.tabIndex = 0;
    const stop = (event: Event) => event.stopPropagation();
    const key = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); void this.commit('enter'); }
      if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
    };
    const input = () => {
      this.draft = label.textContent ?? '';
      flattenTitle(label, this.draft);
      const message = invalidTitle(this.draft.trim(), false) ?? this.options.validate?.(this.draft.trim());
      this.showError(message);
    };
    const blur = () => { void this.commit('blur'); };
    label.addEventListener('keydown', key);
    label.addEventListener('input', input);
    label.addEventListener('blur', blur);
    row.addEventListener('click', stop, true);
    row.addEventListener('dblclick', stop, true);
    this.detach = () => {
      label.removeEventListener('keydown', key);
      label.removeEventListener('input', input);
      label.removeEventListener('blur', blur);
      row.removeEventListener('click', stop, true);
      row.removeEventListener('dblclick', stop, true);
      row.classList.remove('is-being-renamed'); row.draggable = wasDraggable;
      for (const attribute of ['contenteditable', 'role', 'aria-label', 'spellcheck', 'tabindex', 'aria-invalid', 'aria-busy']) label.removeAttribute(attribute);
      this.error?.remove(); this.error = undefined;
    };
    if (focus) queueMicrotask(() => {
      if (!this.active || this.label !== label || !label.isConnected || !this.options.isCurrent()) return;
      label.focus();
      const selection = label.ownerDocument.getSelection(), range = label.ownerDocument.createRange();
      range.selectNodeContents(label); selection?.removeAllRanges(); selection?.addRange(range);
      row.scrollIntoView?.({ block: 'nearest' });
    });
  }

  commit(reason: 'enter' | 'blur'): Promise<boolean> {
    if (!this.active || !this.options.isCurrent()) return Promise.resolve(false);
    this.exitOnBlur ||= reason === 'blur';
    if (this.pending) return this.pending;
    const name = this.value.trim();
    this.draft = this.value;
    this.label?.setAttribute('contenteditable', 'false');
    this.label?.setAttribute('aria-busy', 'true');
    this.pending = Promise.resolve().then(async () => {
      if (!this.active || !this.options.isCurrent()) return false;
      const invalid = invalidTitle(name, true);
      if (invalid) throw new Error(invalid);
      const saved = name === this.name ? undefined : await this.options.save(name);
      this.name = typeof saved === 'string' ? saved : name;
      if (this.active && this.options.isCurrent()) this.finish(this.exitOnBlur ? 'blur' : reason);
      return true;
    }).catch(error => {
      if (this.active && this.options.isCurrent()) {
        this.showError(error instanceof Error ? error.message : String(error));
        this.options.onError(error);
        if (this.exitOnBlur) this.finish('blur');
      }
      return false;
    }).finally(() => {
      this.pending = undefined;
      this.exitOnBlur = false;
      if (this.active) {
        this.label?.setAttribute('contenteditable', 'true');
        this.label?.removeAttribute('aria-busy');
      }
    });
    return this.pending;
  }

  cancel(): void { this.finish('escape'); }
  dispose(): void { this.finish('dispose'); }

  private finish(reason: FileTreeRenameFinish): void {
    if (!this.active) return;
    this.active = false;
    this.detach?.(); this.detach = undefined;
    if (this.label) this.label.textContent = this.name;
    this.draft = this.name;
    this.options.onFinish(reason, this.name);
  }

  private showError(message?: string): void {
    this.error?.remove(); this.error = undefined;
    this.label?.removeAttribute('aria-invalid');
    if (!message || !this.row) return;
    this.label?.setAttribute('aria-invalid', 'true');
    this.error = this.row.ownerDocument.createElement('span');
    this.error.className = 'file-tree-rename-error'; this.error.role = 'alert';
    this.error.textContent = message; this.row.append(this.error);
  }
}

function invalidTitle(name: string, requireNonempty: boolean): string | undefined {
  if (/[\\/:]/.test(name)) return 'File name cannot contain slash, backslash, or colon.';
  if (requireNonempty && !name) return 'File name cannot be empty.';
  if (name.startsWith('.')) return 'File name cannot start with a dot.';
}

/** Keep pasted formatting out of the title while retaining the text selection. */
function flattenTitle(label: HTMLElement, text: string): void {
  if (label.childNodes.length === 1 && label.firstChild?.nodeType === 3) return;
  const selection = label.ownerDocument.getSelection();
  const position = (node: Node | null, offset: number): number | undefined => {
    if (!node || !label.contains(node)) return;
    const range = label.ownerDocument.createRange();
    range.selectNodeContents(label); range.setEnd(node, offset);
    return Math.min(text.length, range.toString().length);
  };
  const anchor = position(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  const focus = position(selection?.focusNode ?? null, selection?.focusOffset ?? 0);
  label.textContent = text;
  if (selection && label.firstChild && anchor !== undefined && focus !== undefined) {
    selection.setBaseAndExtent(label.firstChild, anchor, label.firstChild, focus);
  }
}
