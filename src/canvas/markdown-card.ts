import { EditorView } from '@codemirror/view';
import { createEditor } from '../ui/editor.ts';
import type { EditorHandle, EditorOptions } from '../ui/editor.ts';
import { renderMarkdown } from '../ui/markdown.ts';
import { destroyMarkdown } from '../ui/markdown-lifecycle.ts';
import { selectMarkdownSubpath } from '../core/subpath.ts';
import { icon } from '../ui/dom.ts';

/** Internal workspace lease. update is synchronous compare-and-set against the
 * shared note buffer; flush retains the buffer's optimistic disk-write checks.
 * destroy releases subscriptions/resources, never the shared buffer or draft. */
export interface CanvasMarkdownSession {
  getText(): string;
  update(next: string, expected: string): void;
  subscribe(listener: (text: string) => void): () => void;
  flush(): Promise<void>;
  hasPendingChanges(): boolean;
  readonly readOnly?: boolean;
  readonly editorOptions?: Omit<EditorOptions, 'value' | 'mode' | 'onChange'>;
  destroy(): void;
}
export interface CanvasMarkdownCard {
  readonly element: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly ready: Promise<void>;
  activate(point?: { x: number; y: number }): Promise<void>;
  deactivate(): Promise<void>;
  flush(): Promise<void>;
  isEditing(): boolean;
  isEditable(): boolean;
  hasPendingChanges(): boolean;
  hasUnacceptedChanges(): boolean;
  refreshPreview(): void;
  destroy(): void;
}
export interface CanvasMarkdownCardOptions {
  load(): CanvasMarkdownSession | Promise<CanvasMarkdownSession>;
  editLabel?: string;
  subpath?: string;
  isCurrent?(): boolean;
  isPreviewCurrent?(): boolean;
  onEditingChange?(editing: boolean): void;
  onError?(error: unknown): void;
  editorFactory?: typeof createEditor;
}

/** The shared Markdown renderer supplies the original source line. Preserve
 * every other character, including CRLF and custom task status characters. */
export function canvasTaskSource(source: string, line: number, checked: boolean): string {
  const lines = source.split('\n');
  // A renderer-owned task may follow alternating list and quote containers,
  // e.g. "- > - [ ] task". Consume only those prefixes, never prose brackets.
  const marker = lines[line]?.match(/^([ \t]*(?:(?:>[ \t]*)|(?:(?:[-*+]|\d+[.)])[ \t]+))+\[)([^\r\n])(\])(?=[ \t]|\r?$)/);
  if (!marker) throw new Error('The task changed. Reopen the card before toggling it.');
  const at = marker[1].length;
  lines[line] = lines[line].slice(0, at) + (checked ? 'x' : ' ') + lines[line].slice(at + 1);
  return lines.join('\n');
}

/** Original owned card controller: the shared Reading renderer and Live editor
 * consume the same full-note snapshot. Preview fragments never become write input. */
export function createCanvasMarkdownCard(document: Document, options: CanvasMarkdownCardOptions): CanvasMarkdownCard {
  const element = document.createElement('div'); element.className = 'zorid-canvas-markdown-card';
  const preview = document.createElement('div'); preview.className = 'zorid-canvas-note-preview markdown-preview';
  const editorHost = document.createElement('div'); editorHost.className = 'zorid-canvas-note-editor editor-host'; editorHost.hidden = true;
  const status = document.createElement('div'); status.className = 'zorid-canvas-note-status'; status.setAttribute('role', 'status');
  element.append(preview, editorHost, status); preview.textContent = 'Loading note…';
  const toolbar = document.createElement('div'); toolbar.className = 'zorid-canvas-note-toolbar'; toolbar.setAttribute('aria-label', 'Card editing');
  const edit = document.createElement('button'); edit.type = 'button'; edit.disabled = true; edit.setAttribute('aria-label', options.editLabel ?? 'Edit note'); edit.title = options.editLabel ?? 'Edit note'; edit.append(icon('edit', 16, document)); toolbar.append(edit);
  let closed = false, editing = false, source = '', editor: EditorHandle | undefined, session: CanvasMarkdownSession | undefined;
  let unsubscribe: (() => void) | undefined, activation = 0, previewVersion = 0, loadError: unknown, draftError: unknown;
  let previewOwners: { destroy(): void }[] = [];
  let listConfiguration = '', configurationQueued = false;
  // Native media controls may blur the editor while exposing only the document
  // body as activeElement. Keep card-local pointer interaction separate from
  // keyboard focus; release/cancel must not leave a permanent focus exemption.
  const insidePointers = new Set<number>();
  let watchingFocus = false, focusIntent = 0;
  const containsFocusTarget = (target: EventTarget | null) => !!target && (element.contains(target as Node) || toolbar.contains(target as Node));
  const exitForFocus = () => { if (!closed && editing) void leaveEditing(focusIntent).catch(() => {}); };
  const checkFocus = () => {
    const intent = focusIntent;
    queueMicrotask(() => {
      if (intent === focusIntent && !insidePointers.size && !containsFocusTarget(document.activeElement)) exitForFocus();
    });
  };
  const focusIn = (event: FocusEvent) => {
    if (containsFocusTarget(event.target)) { focusIntent++; return; }
    // A native media control can expose body as its focused owner. An actual
    // external control gaining focus is an exit even during a held pointer.
    if (event.target === document.body || event.target === document.documentElement) return;
    focusIntent++; insidePointers.clear(); exitForFocus();
  };
  const pointerDown = (event: PointerEvent) => {
    focusIntent++;
    if (containsFocusTarget(event.target)) insidePointers.add(event.pointerId);
    else { insidePointers.clear(); exitForFocus(); }
  };
  const pointerUp = (event: PointerEvent) => { insidePointers.delete(event.pointerId); };
  const pointerCancel = (event: PointerEvent) => { pointerUp(event); checkFocus(); };
  const keyFocus = (event: KeyboardEvent) => { if (event.key === 'Tab') { insidePointers.clear(); checkFocus(); } };
  const windowBlur = () => { insidePointers.clear(); checkFocus(); };
  function watchFocus(): void {
    if (watchingFocus) return; watchingFocus = true;
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointerup', pointerUp, true);
    document.addEventListener('pointercancel', pointerCancel, true);
    document.addEventListener('lostpointercapture', pointerUp, true);
    document.addEventListener('keydown', keyFocus, true);
    document.defaultView?.addEventListener('blur', windowBlur);
  }
  function unwatchFocus(): void {
    if (!watchingFocus) return; watchingFocus = false; insidePointers.clear();
    document.removeEventListener('focusin', focusIn, true);
    document.removeEventListener('pointerdown', pointerDown, true);
    document.removeEventListener('pointerup', pointerUp, true);
    document.removeEventListener('pointercancel', pointerCancel, true);
    document.removeEventListener('lostpointercapture', pointerUp, true);
    document.removeEventListener('keydown', keyFocus, true);
    document.defaultView?.removeEventListener('blur', windowBlur);
  }
  const current = () => !closed && (options.isCurrent?.() ?? true);
  const previewCurrent = () => current() && (options.isPreviewCurrent?.() ?? true);
  const report = (error: unknown) => { if (closed) return; status.textContent = error instanceof Error ? error.message : String(error); try { options.onError?.(error); } catch { /* Observers do not own the card lifetime. */ } };
  function clearPreview(): void {
    previewVersion++;
    destroyMarkdown(preview);
    for (const owner of previewOwners) try { owner.destroy(); } catch (error) { report(error); }
    previewOwners = []; preview.replaceChildren();
  }
  const canEdit = () => !!session && !session.readOnly && !options.subpath;
  function showPreview(): void {
    if (closed || !session) return;
    clearPreview();
    const selected = options.subpath ? selectMarkdownSubpath(source, options.subpath) : { content: source };
    if (!selected) { preview.textContent = 'The referenced heading or block was not found.'; return; }
    const configuration = session.editorOptions;
    const version = previewVersion, renderedText = source;
    try {
      renderMarkdown(preview, selected.content, (target, kind) => { if (previewCurrent() && version === previewVersion) configuration?.open(target, kind); }, canEdit() ? (line, checked) => {
        if (!previewCurrent() || version !== previewVersion) return;
        try {
          session!.update(canvasTaskSource(renderedText, line, checked), renderedText);
          source = session!.getText(); editor?.setValue(source.replace(/\r\n?/g, '\n')); showPreview();
          void flush().catch(() => {});
        } catch (error) {
          // A rejected control edit has no accepted draft. Restore its source
          // marker instead of leaving a checkbox that falsely implies a save.
          showPreview(); report(error);
        }
      } : undefined, {
        properties: false,
        embed: configuration?.renderEmbed ? request => { const owner = configuration.renderEmbed!(request); previewOwners.push(owner); return owner.dom; } : undefined,
      });
      // Guard each retained subtree, not only its current parent: external
      // embed controls can remain callable after removal from the preview.
      for (const root of preview.children) root.addEventListener('click', event => {
        if (!previewCurrent() || version !== previewVersion) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      if (!canEdit()) for (const input of preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) input.disabled = true;
    } catch (error) { clearPreview(); preview.textContent = selected.content; report(error); }
  }
  function accept(value: string): void {
    if (!current() || !session) return;
    try {
      session.update(value, source);
      source = session.getText(); draftError = undefined; status.textContent = '';
      // Native input can arrive after focus has already returned to Reading.
      // Keep its visible controls bound to the newly accepted source snapshot.
      if (!editing) showPreview();
    } catch (error) { draftError = error; report(error); }
  }
  function initialize(loaded: CanvasMarkdownSession): void {
    if (closed) { loaded.destroy(); return; }
    session = loaded; source = loaded.getText();
    unsubscribe = loaded.subscribe(next => {
      if (closed) return;
      if (editor && !configurationQueued) {
        configurationQueued = true;
        queueMicrotask(() => {
          configurationQueued = false; if (closed || !editor) return;
          const configuration = session?.editorOptions?.listOptions ?? {}, key = JSON.stringify(configuration);
          if (key !== listConfiguration) { editor.configureLists?.(configuration); listConfiguration = key; }
        });
      }
      if (next === source || draftError) return;
      source = next;
      editor?.setValue(next.replace(/\r\n?/g, '\n'));
      if (!editing) showPreview();
    });
    edit.disabled = !canEdit();
    if (options.subpath) edit.title = 'Open the full note to edit a heading or block card';
    else if (loaded.readOnly) edit.title = 'This note is read-only';
    showPreview();
  }
  const failedLoad = (error: unknown) => { if (!closed) { loadError = error; preview.textContent = 'Unable to load note.'; report(error); } };
  let ready: Promise<void>;
  try {
    const loaded = options.load();
    if ('then' in loaded) ready = Promise.resolve(loaded).then(initialize).catch(failedLoad);
    else { initialize(loaded); ready = Promise.resolve(); }
  } catch (error) { failedLoad(error); ready = Promise.resolve(); }
  async function flush(): Promise<void> {
    await ready;
    if (closed) return;
    if (loadError) return; // An unreadable file has no writable local draft.
    if (!session) return;
    if (draftError) {
      // A rejected compare-and-set retains the editor draft and old base. Never
      // silently accept a newer shared snapshot as that draft's expected value.
      session.update(editor!.getValue(), source);
      source = session.getText(); draftError = undefined;
    }
    // The shared buffer owns write serialization. Reusing a settled card-level
    // promise could miss an edit accepted between two close/flush attempts.
    try { await session.flush(); if (!closed) status.textContent = ''; }
    catch (error) { report(error); throw error; }
  }
  async function activate(point?: { x: number; y: number }): Promise<void> {
    const version = ++activation;
    await ready;
    if (!current() || version !== activation || !canEdit()) return;
    if (!editor) {
      const configuration = session!.editorOptions;
      listConfiguration = JSON.stringify(configuration?.listOptions ?? {});
      editor = (options.editorFactory ?? createEditor)(editorHost, {
        paths: () => [], ...configuration,
        value: source, mode: 'live', onChange: accept,
        renderEmbed: configuration?.renderEmbed ? request => {
          try { return configuration.renderEmbed!(request); }
          catch (error) { report(error); const dom = document.createElement('span'); dom.className = 'markdown-embed-error'; dom.textContent = `Unable to display ${request.target}`; return { dom, destroy() {} }; }
        } : undefined,
        open: (target, kind, event) => { if (current()) configuration?.open(target, kind, event); },
      });
    }
    clearPreview(); editing = true; preview.hidden = true; editorHost.hidden = false; element.classList.add('is-editing');
    watchFocus(); options.onEditingChange?.(true); editor.focus();
    const cm = EditorView.findFromDOM(editorHost.querySelector('.cm-editor') ?? editorHost);
    if (point && cm) { const position = cm.posAtCoords(point); if (position !== null) cm.dispatch({ selection: { anchor: position }, userEvent: 'select.pointer' }); }
  }
  async function leaveEditing(expectedFocusIntent?: number): Promise<void> {
    const version = ++activation;
    if (!editing || closed) return;
    await flush();
    if (closed || version !== activation || expectedFocusIntent !== undefined && expectedFocusIntent !== focusIntent) return;
    editing = false; unwatchFocus(); editorHost.hidden = true; preview.hidden = false; element.classList.remove('is-editing'); showPreview(); options.onEditingChange?.(false);
  }
  // Explicit API/Escape exits do not depend on the automatic focus intent.
  async function deactivate(): Promise<void> { await leaveEditing(); }
  edit.onclick = () => { if (current()) void activate().catch(report); };
  // Reading controls and retained links cannot outlive their session owner.
  element.addEventListener('click', event => {
    if (!current() || !canEdit() && (event.target as Element).closest('input[type="checkbox"]')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  element.addEventListener('focusout', checkFocus);
  toolbar.addEventListener('focusout', checkFocus);
  editorHost.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); void deactivate().catch(() => {}); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); void flush().catch(() => {}); }
  });
  return {
    element, toolbar, ready, activate, deactivate, flush,
    isEditing: () => editing,
    isEditable: canEdit,
    hasPendingChanges: () => !!draftError || !!session?.hasPendingChanges(),
    hasUnacceptedChanges: () => !!draftError,
    refreshPreview() { if (!closed && !editing) showPreview(); },
    destroy() {
      if (closed) return; closed = true; activation++;
      unwatchFocus(); element.removeEventListener('focusout', checkFocus); toolbar.removeEventListener('focusout', checkFocus);
      for (const release of [unsubscribe, () => clearPreview(), () => editor?.destroy(), () => session?.destroy()]) {
        try { release?.(); } catch (error) { try { options.onError?.(error); } catch { /* Release the remaining owners. */ } }
      }
      edit.onclick = null; element.remove(); toolbar.remove();
    },
  };
}
