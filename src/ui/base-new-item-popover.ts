import { normalizePath, parentPath } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import { readProperties } from '../core/properties.ts';
import { icon } from './icons.ts';
import { renderProperties } from './properties.ts';
import type { PropertiesOptions } from './properties.ts';
import type { NoteBuffer } from './note-buffer.ts';
import type { EditorHandle, EditorOptions } from './editor.ts';

export interface BaseNewItemPopoverOptions {
  readonly anchor: HTMLElement;
  readonly vault: Vault;
  /** An ordinary note already saved durably, including an existing database row. */
  readonly path: string;
  readonly presentation?: 'popover' | 'side-peek';
  /** Existing rows can open without selecting their title or entering body editing. */
  readonly focusTitle?: boolean;
  readonly getBuffer: (path: string) => Promise<NoteBuffer>;
  readonly validate: () => void;
  /** Workspace rename must relocate the shared buffer before resolving. */
  readonly rename: (path: string, destination: string, validate: () => void, witness?: { entryId: string; revision: string }) => Promise<void>;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent, witness?: { readonly entryId: string; readonly revision: string }) => void | Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly onClose?: () => void;
  readonly editorOptions?: Partial<Omit<EditorOptions, 'value' | 'onChange' | 'validateChange' | 'canMutate' | 'isCurrent'>>;
  readonly properties?: Pick<PropertiesOptions, 'onPropertyDefinitionChange' | 'onAddProperty' | 'getRelationTargets' | 'getDisplayValue' | 'getDefinitions' | 'isManaged' | 'collectionName' | 'managedOnly'>;
  /** True means the host committed typed values and refreshed the same buffer. */
  readonly changeProperties?: (next:string,buffer:NoteBuffer)=>Promise<boolean>;
  /** The workspace owns subscriptions and the buffer's lifetime. */
  /** Defer only body publication while an owned inline configuration saves. */
  readonly deferSourceUpdate?: () => boolean;
  /** Portals belong only to this note's live embedded editor sessions. */
  readonly ownsEditorPortal?: (node: Node) => boolean;
  readonly subscribeBuffer?: (buffer: NoteBuffer, listener: () => void) => () => void;
  /** Embedded editors retain their own accepted writes and unaccepted drafts. */
  readonly flushEditor?: () => Promise<void>;
  readonly hasPendingEditorChanges?: () => boolean;
  /** Failure keeps this surface mounted, just like a failed note save. */
  readonly closeEditor?: () => Promise<void>;
  readonly propertiesExpanded?: boolean;
  readonly bodyExpanded?: boolean;
  /** Production defaults to the normal editor's lazy import. */
  readonly editorFactory?: (parent: HTMLElement, options: EditorOptions) => EditorHandle | Promise<EditorHandle>;
}
export interface BaseNewItemPopoverHandle {
  readonly element: HTMLElement;
  readonly path: string;
  refresh(): void;
  expandBody(): Promise<void>;
  hasPendingChanges(): boolean;
  /** Rejections retain the popover and exact failed drafts for correction/retry. */
  flush(): Promise<void>;
  close(options?: { restoreFocus?: boolean }): Promise<void>;
}
const noteName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
/** Presentation only: the complete original text always belongs to NoteBuffer. */
function bodyPreview(source: string): string {
  if (!/^\uFEFF?---[^\S\r\n]*(?:#[^\r\n]*)?\r?\n/.test(source)) return source;
  try { readProperties(source); } catch { return source; }
  const firstLineEnd = source.indexOf('\n') + 1;
  const closing = /^(?:---|\.\.\.)[^\S\r\n]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(source.slice(firstLineEnd));
  return closing ? source.slice(firstLineEnd + closing.index + closing[0].length) : source;
}

/** New edits an existing shared note buffer in a reference-sized hover surface.
 * Closing never disposes that buffer or substitutes a private copy of its text. */
export async function openBaseNewItemPopover(options: BaseNewItemPopoverOptions): Promise<BaseNewItemPopoverHandle> {
  options.validate();
  const document = options.anchor.ownerDocument, win = document.defaultView;
  const openingFocus = document.activeElement;
  let path = normalizePath(options.path);
  const initialEntry = options.vault.entries.get(path);
  if (initialEntry?.type !== 'file' || !/\.md$/i.test(path)) throw new Error('The new note is no longer available.');
  const entryId = initialEntry.entryId;
  const buffer = await options.getBuffer(path); options.validate();
  await buffer.load(entryId, options.validate); options.validate();
  if (buffer.path !== path || (entryId && options.vault.entries.get(path)?.entryId !== entryId)) throw new Error('The new note identity changed before opening.');
  const sidePeek = options.presentation === 'side-peek';
  const root = document.createElement('div'); root.className = 'popover hover-popover is-editing bases-new-item-popover'; root.classList.toggle('is-side-peek', sidePeek); root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', sidePeek ? 'Page preview' : 'New item'); root.tabIndex = -1;
  const title = document.createElement('div'); title.className = 'inline-title'; title.contentEditable = 'true'; title.spellcheck = true; title.tabIndex = -1; title.setAttribute('role', 'textbox'); title.setAttribute('aria-label', 'Note title'); title.setAttribute('aria-multiline', 'false'); title.setAttribute('enterkeyhint', 'done'); title.textContent = noteName(path);
  const propertiesHost = document.createElement('div'); propertiesHost.className = 'bases-new-item-properties';
  const body = document.createElement('div'); body.className = 'bases-new-item-body';
  const preview = document.createElement('div'); preview.className = 'bases-new-item-body-preview'; preview.tabIndex = 0; preview.setAttribute('role', 'button'); preview.setAttribute('aria-label', 'Edit note body');
  const editorHost = document.createElement('div'); editorHost.className = 'editor-host markdown-source-view is-live-preview'; editorHost.hidden = true;
  const open = document.createElement('button'); open.type = 'button'; open.className = 'markdown-embed-link clickable-icon'; open.setAttribute('aria-label', sidePeek ? 'Open as full page' : 'Open link'); open.append(icon('maximize', 16, document));
  const closeButton = sidePeek ? document.createElement('button') : undefined;
  if (closeButton) {
    const header = document.createElement('div'); header.className = 'bases-page-peek-header';
    closeButton.type = 'button'; closeButton.className = 'clickable-icon'; closeButton.setAttribute('aria-label', 'Close preview'); closeButton.append(icon('close', 16, document));
    header.append(closeButton, open); root.append(header);
  }
  const error = document.createElement('div'); error.className = 'bases-new-item-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'bases-new-item-retry'; retry.textContent = 'Retry'; retry.hidden = true;
  body.append(preview, editorHost); root.append(title, propertiesHost, body, ...(sidePeek ? [] : [open]), error, retry); document.body.append(root);
  let closed = false, expanded = false, composingTitle = false, titleBaseline = noteName(path), titleSerial = Promise.resolve();
  let titleDraft = titleBaseline, bodySnapshot = buffer.text, editor: EditorHandle | undefined, loading: Promise<void> | undefined, closing: Promise<void> | undefined;
  let titleAttempt: { requested: string; promise: Promise<void> } | undefined;
  let ownedContextMenu = false, closeFocusRetired = false, editorFocusEpoch = 0;
  let titleProblem = false, propertyDraft = false, propertyInputGeneration = 0;
  const writes = new Set<Promise<unknown>>(), unsubscribers: (() => void)[] = [];
  const live = () => !closed && root.isConnected;
  const validate = () => {
    options.validate();
    if (!live()) throw new Error('The new-item editor is closed.');
    if (buffer.path !== path || options.vault.entries.get(path)?.type !== 'file' || (entryId && options.vault.entries.get(path)?.entryId !== entryId)) throw new Error('The new note changed identity; its draft is preserved.');
  };
  const report = (failure: unknown) => { if (closed) return; error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false; retry.hidden = false; try { options.onError(failure); } catch { /* Reporting cannot destroy retained drafts. */ } position(); };
  const track = <T>(promise: Promise<T>): Promise<T> => { writes.add(promise); void promise.then(() => writes.delete(promise), () => writes.delete(promise)); return promise; };
  const titleText = () => title.textContent ?? '';
  function position() {
    if (closed) return;
    if (sidePeek) {
      const width = Math.min(600, Math.max(0, win?.innerWidth ?? 1024));
      root.style.width = `${width}px`; root.style.left = `${Math.max(0, (win?.innerWidth ?? 1024) - width)}px`; root.style.top = '0px';
      root.style.height = `${Math.max(0, win?.innerHeight ?? 768)}px`; return;
    }
    const rect = options.anchor.getBoundingClientRect(), width = Math.min(452, Math.max(0, (win?.innerWidth ?? 1024) - 16));
    root.style.width = `${width}px`;
    const left = Math.max(8, Math.min(rect.right - width, (win?.innerWidth ?? 1024) - width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 10, (win?.innerHeight ?? 768) - (root.offsetHeight || (expanded ? 217 : 134)) - 8));
    root.style.left = `${left}px`; root.style.top = `${top}px`;
  }
  const properties = renderProperties(propertiesHost, { ...options.properties, ...(options.properties?.onPropertyDefinitionChange ? { onPropertyDefinitionChange: (property: string, definition: Parameters<NonNullable<PropertiesOptions['onPropertyDefinitionChange']>>[1]) => track(Promise.resolve().then(() => options.properties!.onPropertyDefinitionChange!(property, definition))) } : {}), vault: options.vault, path,
    onVisibilityChange: visible => { if (options.properties?.managedOnly) { propertiesHost.hidden = !visible; root.classList.toggle('has-properties', visible); } },
    getSource: () => buffer.text, isCurrent: () => { try { validate(); return true; } catch { return false; } },
    onChange: next => track((async () => { validate(); if(await options.changeProperties?.(next,buffer)){validate();bodySnapshot=buffer.text;editor?.setValue(buffer.text);refresh();return;} buffer.update(next, { validateWrite: validate }); bodySnapshot = next; editor?.setValue(next); refresh(); await buffer.flush(); })()),
    openLink: (target, witness) => { const event = new (win?.MouseEvent ?? MouseEvent)('click'); void Promise.resolve(options.openFile(target, event, witness)).catch(report); },
    onError: report,
  });
  const propertiesRoot = propertiesHost.querySelector<HTMLElement>('.metadata-container')!;
  const heading = propertiesHost.querySelector<HTMLElement>('.metadata-properties-heading')!;
  let propertiesExpanded = options.propertiesExpanded ?? false;
  const drawHeading = () => { const label = document.createElement('span'); label.className = 'metadata-properties-title'; label.textContent = 'Properties'; heading.replaceChildren(icon(propertiesExpanded ? 'down' : 'right', 16, document), label); propertiesRoot.classList.toggle('is-collapsed', !propertiesExpanded); heading.setAttribute('role', 'button'); heading.setAttribute('aria-expanded', String(propertiesExpanded)); position(); };
  const toggleProperties = () => { propertiesExpanded = !propertiesExpanded; drawHeading(); };
  heading.addEventListener('click', toggleProperties);
  heading.addEventListener('keydown', event => { if (!event.isComposing && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleProperties(); } });
  drawHeading();

  function refresh() {
    if (!live()) return;
    // Workspace adoption is allowed only for this same stable entry.
    if (buffer.path !== path && entryId && options.vault.entries.get(buffer.path)?.entryId === entryId) { const previous = titleBaseline; path = buffer.path; titleBaseline = noteName(path); if (titleText().trim() === previous && !titleProblem) { title.textContent = titleBaseline; titleDraft = titleBaseline; } }
    properties.refresh();
    try { const count = readProperties(buffer.text).length; propertiesRoot.dataset.propertyCount = String(count); if (!options.properties?.managedOnly) { propertiesHost.hidden = count === 0; root.classList.toggle('has-properties', count > 0); } } catch { if (!options.properties?.managedOnly) propertiesHost.hidden = false; }
    if (!options.deferSourceUpdate?.()) {
    if (!editor) { preview.textContent = bodyPreview(buffer.text); preview.classList.toggle('is-empty', !preview.textContent); }
    else if (buffer.text !== bodySnapshot && !editorHost.contains(document.activeElement)) { bodySnapshot = buffer.text; editor.setValue(bodySnapshot); }
    }
    if (buffer.error) report(buffer.error);
    position();
  }
  async function expandBody(focus = true): Promise<void> {
    validate();
    if (editor) { if (focus) editor.focus(); return; }
    if (loading) return loading;
    const requestedFocusEpoch = editorFocusEpoch;
    expanded = true; root.classList.add('is-body-expanded'); preview.hidden = true; editorHost.hidden = false; position();
    loading = (async () => {
      const factory = options.editorFactory ?? (await import('./editor.ts')).createEditor;
      if (!live()) return;
      validate(); bodySnapshot = buffer.text;
      const handle = await factory(editorHost, { ...options.editorOptions, value: bodySnapshot, mode: 'live',
        paths: options.editorOptions?.paths ?? (() => [...options.vault.entries.keys()]),
        canMutate: () => { try { validate(); return true; } catch { return false; } }, isCurrent: () => { try { validate(); return true; } catch { return false; } },
        validateChange: next => { validate(); if (buffer.text !== bodySnapshot) throw new Error('The note changed in another editor; refresh before typing.'); buffer.validateTextChange(next); },
        onChangeRejected: failure => { report(failure); options.editorOptions?.onChangeRejected?.(failure); },
        onChange: next => { try { validate(); if (buffer.text !== bodySnapshot) throw new Error('The note changed in another editor; its content is preserved.'); buffer.update(next, { validateWrite: validate }); bodySnapshot = next; properties.refresh(); } catch (failure) { report(failure); } },
        open: options.editorOptions?.open ?? ((target, _kind, event) => { void Promise.resolve(options.openFile(target, event ?? new (win?.MouseEvent ?? MouseEvent)('click'))).catch(report); }),
      });
      if (!live()) { handle.destroy(); return; }
      editor = handle; if (buffer.text !== bodySnapshot) { bodySnapshot = buffer.text; editor.setValue(bodySnapshot); } if (focus && requestedFocusEpoch === editorFocusEpoch) editor.focus(); position();
    })().catch(failure => { if (live()) { expanded = false; root.classList.remove('is-body-expanded'); preview.hidden = false; editorHost.hidden = true; report(failure); } throw failure; }).finally(() => { loading = undefined; });
    return loading;
  }
  function saveTitle(): Promise<void> {
    if (composingTitle) return Promise.reject(new Error('Finish composing the note title before closing.'));
    const requested = titleText(); titleDraft = requested;
    if (titleAttempt?.requested === requested) return titleAttempt.promise;
    const operation = titleSerial.then(async () => {
      validate();
      const name = requested.trim();
      if (!name || /[\/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') throw new Error('Enter a nonempty note title without path separators.');
      if (name === titleBaseline) { titleProblem = false; return; }
      await buffer.flush(); validate();
      const destination = normalizePath((parentPath(path) ? `${parentPath(path)}/` : '') + name + '.md');
      const witnessed = buffer.savedDurableWitness ?? options.vault.entries.get(path);
      const witness = witnessed?.entryId && witnessed.revision ? { entryId: witnessed.entryId, revision: witnessed.revision } : undefined;
      const before = path;
      try { await options.rename(before, destination, validate, witness); }
      catch (failure) {
        // A failed acknowledgement may follow a committed workspace rename.
        // Only this exact shared buffer at the requested destination can adopt it.
        if (buffer.path === destination && options.vault.entries.get(destination)?.type === 'file' && (!entryId || options.vault.entries.get(destination)?.entryId === entryId)) { path = destination; titleBaseline = noteName(path); }
        throw failure;
      }
      if (buffer.path !== destination || options.vault.entries.get(destination)?.type !== 'file' || (entryId && options.vault.entries.get(destination)?.entryId !== entryId)) throw new Error('The rename could not be confirmed; the title draft is preserved.');
      path = destination; titleBaseline = noteName(path); titleProblem = false;
      if (titleText() === requested) { title.textContent = titleBaseline; titleDraft = titleBaseline; }
      refresh();
    });
    titleSerial = operation.catch(failure => { titleProblem = true; report(failure); });
    const attempt = { requested, promise: track(operation) }; titleAttempt = attempt;
    const clear = () => { if (titleAttempt === attempt) titleAttempt = undefined; }; void operation.then(clear, clear);
    return attempt.promise;
  }
  async function flush() {
    // A retired file with no local/nested draft has nothing to persist. Keep
    // pending buffers, in-flight actions and unaccepted inputs on the normal
    // validation path so retirement cannot become an implicit discard action.
    if(!hasPendingChanges()&&buffer.text===buffer.savedText){
      try{validate();}catch{return;}
    }
    validate();
    const focused = document.activeElement as HTMLElement | null;
    if (focused && focused !== retry && (root.contains(focused) || properties.owns(focused))) focused.blur();
    const currentTitleAttempt = titleAttempt;
    // Native change/blur and shared widget commits enter their queues first.
    await Promise.resolve(); await Promise.resolve();
    const propertyGeneration = propertyInputGeneration;
    await properties.flush();
    await (currentTitleAttempt?.requested === titleText() ? currentTitleAttempt.promise : saveTitle());
    while (writes.size) await Promise.all([...writes]);
    await options.flushEditor?.();
    const invalid = [...root.querySelectorAll<HTMLElement>('.metadata-property-error')].find(node => !node.hidden && !!node.textContent?.trim());
    if (invalid || root.querySelector('[data-base-editing]')) throw new Error(invalid?.textContent ?? 'Finish editing the current property before closing.');
    await buffer.flush(); validate();
    if (composingTitle || titleText().trim() !== titleBaseline) throw new Error('The title changed while saving; its draft is preserved.');
    if (propertyGeneration !== propertyInputGeneration) throw new Error('Property input changed while saving; finish the current edit before closing.');
    if (buffer.dirty || buffer.error) throw buffer.error ?? new Error('The new note still has pending changes.');
    propertyDraft = false;
    if (document.activeElement === retry) title.focus({ preventScroll: true });
    error.hidden = retry.hidden = true;
  }
  function hasPendingChanges() { return !closed && (composingTitle || titleProblem || propertyDraft || properties.hasPendingChanges() || titleText().trim() !== titleBaseline || !!writes.size || !!loading || buffer.dirty || !!buffer.error || !!options.hasPendingEditorChanges?.() || !!root.querySelector('[data-base-editing]') || [...root.querySelectorAll<HTMLElement>('.metadata-property-error')].some(node => !node.hidden && !!node.textContent?.trim())); }
  function ownedPortal(target: Node) { return properties.owns(target) || options.ownsEditorPortal?.(target) === true; }
  function remove(restoreFocus: boolean) {
    if (closed) return;
    const focused = document.activeElement, focusOwned = !focused || focused === document.body || focused === document.documentElement || root.contains(focused) || ownedPortal(focused);
    closed = true;
    const release = (operation: () => void) => { try { operation(); } catch (failure) { try { options.onError(failure); } catch {} } };
    release(() => properties.destroy()); release(() => editor?.destroy()); editor = undefined; unsubscribers.forEach(stop => release(stop));
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); document.removeEventListener('contextmenu', contextOwner, true); document.removeEventListener('focusin', observeFocus, true); win?.removeEventListener('resize', position); win?.removeEventListener('scroll', position, true); win?.removeEventListener('blur', retireCloseFocus); observer?.disconnect(); root.remove();
    if (restoreFocus && !closeFocusRetired && focusOwned && options.anchor.isConnected) options.anchor.focus({ preventScroll: true });
    try { options.onClose?.(); } catch (failure) { try { options.onError(failure); } catch {} }
  }
  async function close(closeOptions: { restoreFocus?: boolean } = {}): Promise<void> {
    if (closed) return;
    if (closing) return closing;
    closeFocusRetired = false;
    const wasInert=root.inert;
    closing = flush().then(async () => {
      const closingText=buffer.text,closingSavedText=buffer.savedText,closingPath=buffer.path;
      root.inert=true;
      await options.closeEditor?.();
      if(buffer.text!==closingText||buffer.savedText!==closingSavedText||buffer.path!==closingPath||buffer.dirty||buffer.error||composingTitle||propertyDraft||properties.hasPendingChanges()||writes.size||titleText().trim()!==titleBaseline||options.hasPendingEditorChanges?.()||root.querySelector('[data-base-editing]')||[...root.querySelectorAll<HTMLElement>('.metadata-property-error')].some(node=>!node.hidden&&!!node.textContent?.trim()))throw new Error('The new note changed while closing. Its draft is preserved.');
      remove(!!closeOptions.restoreFocus);
    }).catch(failure => { report(failure); throw failure; }).finally(() => { if(!closed)root.inert=wasInert;closing = undefined; });
    return closing;
  }
  function contextOwner(event: MouseEvent) { ownedContextMenu = root.contains(event.target as Node) || ownedPortal(event.target as Node); }
  function retireCloseFocus() { closeFocusRetired = true; editorFocusEpoch++; }
  function observeFocus(event: FocusEvent) { const target = event.target as Node; if (!root.contains(target) && !ownedPortal(target)) editorFocusEpoch++; }
  function outside(event: PointerEvent) { const target = event.target as Node; if (ownedContextMenu && (target as HTMLElement).closest?.('.context-menu')) return; if (!root.contains(target) && !ownedPortal(target)) { if (closing) retireCloseFocus(); void close().catch(() => {}); } }
  function escape(event: KeyboardEvent) {
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) ownedContextMenu = root.contains(event.target as Node) || ownedPortal(event.target as Node);
    if (event.defaultPrevented || event.isComposing || composingTitle || event.key !== 'Escape' || ownedPortal(event.target as Node)) return;
    if (!root.contains(event.target as Node)) return;
    event.preventDefault(); event.stopPropagation(); void close({ restoreFocus: true }).catch(() => {});
  }
  propertiesHost.addEventListener('input', () => { propertyDraft = true; propertyInputGeneration++; });
  title.addEventListener('input', () => { titleDraft = titleText(); });
  title.addEventListener('compositionstart', () => { composingTitle = true; }); title.addEventListener('compositionend', () => { composingTitle = false; titleDraft = titleText(); });
  title.addEventListener('beforeinput', event => { if ((event as InputEvent).inputType === 'insertParagraph' || (event as InputEvent).inputType === 'insertLineBreak') event.preventDefault(); });
  title.addEventListener('blur', () => { if (!closed && !composingTitle && (titleProblem || titleText().trim() !== titleBaseline)) void saveTitle().catch(() => {}); });
  title.addEventListener('keydown', event => { if (event.isComposing || composingTitle) return; if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const focusEpoch = editorFocusEpoch; void saveTitle().then(() => expandBody(focusEpoch === editorFocusEpoch)).catch(report); } });
  editorHost.addEventListener('focusout', () => { queueMicrotask(refresh); });
  preview.addEventListener('click', () => { void expandBody().catch(() => {}); }); preview.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void expandBody().catch(() => {}); } });
  open.addEventListener('mousedown', event => event.preventDefault()); open.addEventListener('click', event => { void close().then(() => options.openFile(path, event)).catch(report); });
  closeButton?.addEventListener('click', () => { void close({ restoreFocus: true }).catch(() => {}); });
  retry.addEventListener('click', () => { void flush().catch(report); });
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape); document.addEventListener('contextmenu', contextOwner, true); document.addEventListener('focusin', observeFocus, true); win?.addEventListener('resize', position); win?.addEventListener('scroll', position, true); win?.addEventListener('blur', retireCloseFocus);
  const observer = win?.ResizeObserver ? new win.ResizeObserver(position) : undefined; observer?.observe(root);
  for (const event of ['modify', 'rename', 'delete'] as const) unsubscribers.push(options.vault.on(event, change => { if (change.path === path || change.oldPath === path) refresh(); }));
  if (options.subscribeBuffer) unsubscribers.push(options.subscribeBuffer(buffer, refresh));
  refresh(); position();
  const focusStillOwned = document.activeElement === openingFocus || document.activeElement === document.body || root.contains(document.activeElement);
  if (focusStillOwned && options.focusTitle !== false) { title.focus(); const selection = document.getSelection(); if (selection) { const range = document.createRange(); range.selectNodeContents(title); selection.removeAllRanges(); selection.addRange(range); } }
  else if (focusStillOwned) root.focus({ preventScroll: true });
  const handle: BaseNewItemPopoverHandle = { element: root, get path() { return path; }, refresh, expandBody, hasPendingChanges, flush, close };
  if (options.bodyExpanded) await expandBody(focusStillOwned && options.focusTitle !== false).catch(() => {});
  return handle;
}
