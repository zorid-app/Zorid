import { createEditor } from './editor.ts';
import type { EditorHandle, EditorInteractionState, EditorOptions } from './editor.ts';

/** Supplied by the Workspace binding; this component never reads or admits a file. */
export interface MobileDocumentEditorSnapshot {
  readonly route: {
    readonly kind: 'document';
    readonly entryId: string;
    readonly path: string;
    readonly revision: string;
    readonly recovery: 'none' | 'retainedDraft';
  };
  readonly content: string;
}

export interface MobileDocumentEditorHostOptions {
  parent: HTMLElement;
  visitId: string;
  snapshot: MobileDocumentEditorSnapshot;
  canMutate(): boolean;
  isCurrent(): boolean;
  editorOptions: Omit<EditorOptions, 'value' | 'onChange' | 'canMutate' | 'interactionState'>;
  onChange(text: string): void;
  editorFactory?: typeof createEditor;
  /** Workspace mounts/guards its own title and properties, with scoped cleanup. */
  beforeEditor?(scroll: HTMLElement): void | (() => void);
}

export interface MobileDocumentEditorHost {
  readonly visitId: string;
  readonly element: HTMLElement;
  readonly editor: EditorHandle;
  setInteractionState(state: EditorInteractionState): void;
  synchronize(snapshot: MobileDocumentEditorSnapshot): void;
  destroy(): void;
}

/** One passive, retained Markdown view. The caller owns writer tokens, canonical
 * buffers, admission, saving, attachment/presentation and the window's view cap.
 * This module owns only its wrapper, existing editor instance and hook cleanup.
 */
export function createMobileDocumentEditorHost(options: MobileDocumentEditorHostOptions): MobileDocumentEditorHost {
  const { parent, visitId, canMutate, isCurrent, onChange } = options;
  const suppliedCurrent = options.editorOptions.isCurrent;
  const entryId = options.snapshot.route.entryId, initialContent = options.snapshot.content;
  if (!visitId || !entryId || options.snapshot.route.kind !== 'document' || typeof initialContent !== 'string') {
    throw new Error('A mobile editor host requires a document snapshot and visit identity');
  }
  if (!parent.isConnected) throw new Error('The mobile editor slot is detached');
  let retired = false, active = false, initialized = false;
  let editor: EditorHandle | undefined, cleanup: void | (() => void);
  let editorDestroyed = false, hookDestroyed = false;
  const current = () => {
    try { return !retired && isCurrent() && (suppliedCurrent?.() ?? true); }
    catch { return false; }
  };
  const authoring = () => {
    try { return initialized && active && current() && canMutate(); }
    catch { return false; }
  };
  if (!current()) throw new Error('The mobile editor owner is stale');
  const element = parent.ownerDocument.createElement('div');
  element.className = 'tab-view-content';
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflow: 'hidden' });
  const scroll = parent.ownerDocument.createElement('div');
  scroll.className = 'note-scroll'; element.append(scroll); parent.append(element);
  const destroy = () => {
    retired = true; active = false;
    const errors: unknown[] = [];
    // Retire callbacks immediately; retry only resources whose cleanup failed.
    if (editor && !editorDestroyed) {
      try { editor.destroy(); editorDestroyed = true; } catch (error) { errors.push(error); }
    }
    if (!hookDestroyed) {
      try { cleanup?.(); hookDestroyed = true; } catch (error) { errors.push(error); }
    }
    element.remove();
    if (errors.length) throw new AggregateError(errors, 'Mobile editor host cleanup failed');
  };
  try {
    cleanup = options.beforeEditor?.(scroll);
    if (!current()) throw new Error('The mobile editor owner changed during preparation');
    const body = parent.ownerDocument.createElement('div'); body.className = 'editor-host'; scroll.append(body);
    editor = (options.editorFactory ?? createEditor)(body, {
      ...options.editorOptions,
      value: initialContent,
      interactionState: { active: false },
      isCurrent: () => active && current(),
      canMutate: authoring,
      onChange(text) {
        // Reject delayed/retired callbacks and values which no longer describe
        // this live editor. Canonical admission/save remains the caller's job.
        if (authoring() && editor?.getValue() === text && authoring()) onChange(text);
      },
    });
    if (!editor.setInteractionState) throw new Error('The editor factory does not support passive interaction');
    if (!current()) throw new Error('The mobile editor owner changed during construction');
    initialized = true;
  } catch (error) {
    try { destroy(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Mobile editor preparation and cleanup failed'); }
    throw error;
  }
  const retainedEditor = editor;
  return {
    visitId, element, editor: retainedEditor,
    setInteractionState(state) {
      if (retired) return;
      if (state.active && !current()) {
        active = false; retainedEditor.setInteractionState!({ active: false });
        throw new Error('The mobile editor owner is stale');
      }
      active = state.active;
      try { retainedEditor.setInteractionState!(state); }
      catch (error) { active = false; throw error; }
    },
    synchronize(snapshot) {
      if (!current()) throw new Error('The mobile editor owner is stale');
      if (snapshot.route.kind !== 'document' || snapshot.route.entryId !== entryId || typeof snapshot.content !== 'string') {
        throw new Error('The mobile document identity changed');
      }
      retainedEditor.setValue(snapshot.content);
    },
    destroy,
  };
}
