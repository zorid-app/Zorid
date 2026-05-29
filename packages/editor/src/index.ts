import { history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import type {
  EditorAPI,
  EditorChange,
  EditorCommandContribution,
  EditorExtensionContribution,
  EditorHandle,
  EditorUpdateEvent,
  OpenDocumentOptions,
} from '@zorid/platform-api';
import { type Disposable, normalizeVaultPath, type VaultPath } from '@zorid/shared';
import { defaultLivePreviewRenderers, type LivePreviewRenderer, livePreviewExtension } from './live-preview/index.js';

// Live Preview exports remain available from the package root for current
// first-party integrations and tests. Treat them as experimental while the
// package is private; do not publish them as a stable third-party plugin API
// without a dedicated API review.
export type {
  LivePreviewContext,
  LivePreviewDecorationKind,
  LivePreviewRange,
  LivePreviewRenderer,
  LivePreviewSelectionRange,
  LivePreviewVisibleRange,
  TaskMarkerRange,
} from './live-preview/index.js';
export {
  collectLivePreviewRanges,
  createLivePreviewContext,
  defaultLivePreviewRenderers,
  filterLivePreviewRanges,
  findTaskMarkerAtPosition,
  headingLivePreviewRenderer,
  inlineCodeDelimiterLivePreviewRenderer,
  inlineCodeLivePreviewRenderer,
  livePreviewExtension,
  livePreviewRangeIntersectsSelection,
  livePreviewSelectionRanges,
  markdownLinkLivePreviewRenderer,
  nextTaskMarkerCheckbox,
  shouldRenderLivePreviewRange,
  tagLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
  toggleTaskMarkerAtPosition,
  toggleTaskMarkerAtSelection,
  wikiLinkLivePreviewRenderer,
} from './live-preview/index.js';

export interface EditorDocumentStore {
  read(path: VaultPath): Promise<string>;
  write(path: VaultPath, contents: string): Promise<void>;
}

export interface EditorExtensionDiagnostic {
  id: string;
  reason: string;
}

export interface EditorExtensionComposition {
  extensions: Extension[];
  diagnostics: EditorExtensionDiagnostic[];
}

export interface MarkdownEditorExtensionOptions {
  extensionContributions?: readonly EditorExtensionContribution[];
  onChange?: (text: string, update: ViewUpdate) => void;
  onSave?: () => void;
  shouldEmitChange?: () => boolean;
  livePreviewRenderers?: readonly LivePreviewRenderer[] | false;
}

export interface MountedMarkdownEditorOptions extends MarkdownEditorExtensionOptions {
  parent: HTMLElement;
  text: string;
}

export interface SetMountedMarkdownEditorTextOptions {
  emitChange?: boolean;
}

export function coerceEditorExtensionContribution(
  contribution: EditorExtensionContribution,
): { extension: Extension; diagnostic?: undefined } | { extension?: undefined; diagnostic: EditorExtensionDiagnostic } {
  const value = contribution.extension;
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    return { extension: value as Extension };
  }
  return {
    diagnostic: {
      id: contribution.id,
      reason: 'Editor extension contributions must be CodeMirror extension objects, functions, or arrays.',
    },
  };
}

export function composeEditorExtensions(
  contributions: readonly EditorExtensionContribution[] = [],
): EditorExtensionComposition {
  const extensions: Extension[] = [];
  const diagnostics: EditorExtensionDiagnostic[] = [];
  for (const contribution of contributions) {
    const result = coerceEditorExtensionContribution(contribution);
    if (result.extension) {
      extensions.push(result.extension);
    } else {
      diagnostics.push(result.diagnostic);
    }
  }
  return { extensions, diagnostics };
}

export function createMarkdownEditorExtensions({
  extensionContributions = [],
  livePreviewRenderers = defaultLivePreviewRenderers,
  onChange,
  onSave,
  shouldEmitChange = () => true,
}: MarkdownEditorExtensionOptions = {}): Extension[] {
  const composed = composeEditorExtensions(extensionContributions);
  // `markdown()` keeps @codemirror/lang-markdown's default keymap enabled,
  // including Enter/Backspace Markdown continuation behavior. Do not add a
  // duplicate custom keymap unless tests prove a concrete gap.
  const extensions: Extension[] = [markdown(), history(), keymap.of(historyKeymap), ...composed.extensions];
  if (livePreviewRenderers !== false) {
    extensions.push(livePreviewExtension(livePreviewRenderers));
  }

  if (onSave) {
    extensions.push(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSave();
            return true;
          },
        },
      ]),
    );
  }

  if (onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged && shouldEmitChange()) {
          onChange(update.state.doc.toString(), update);
        }
      }),
    );
  }

  return extensions;
}

export function createMarkdownEditorState(text: string, options: MarkdownEditorExtensionOptions = {}): EditorState {
  return EditorState.create({
    doc: text,
    extensions: createMarkdownEditorExtensions(options),
  });
}

export class MountedMarkdownEditor {
  readonly view: EditorView;
  #emitChanges = true;

  constructor({ parent, text, ...extensionOptions }: MountedMarkdownEditorOptions) {
    this.view = new EditorView({
      parent,
      state: createMarkdownEditorState(text, {
        ...extensionOptions,
        shouldEmitChange: () => this.#emitChanges && (extensionOptions.shouldEmitChange?.() ?? true),
      }),
    });
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(value: string, options: SetMountedMarkdownEditorTextOptions = {}): void {
    if (value === this.getText()) return;
    this.#emitChanges = options.emitChange ?? false;
    try {
      this.view.dispatch({
        changes: {
          from: 0,
          to: this.view.state.doc.length,
          insert: value,
        },
      });
    } finally {
      this.#emitChanges = true;
    }
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}

export function createMountedMarkdownEditor(options: MountedMarkdownEditorOptions): MountedMarkdownEditor {
  return new MountedMarkdownEditor(options);
}

export class MarkdownEditorHandle implements EditorHandle {
  readonly id: string;
  readonly path: VaultPath;
  #initialText: string;
  #text: string;
  #store: EditorDocumentStore;
  #listeners = new Set<(event: EditorUpdateEvent) => void>();
  state: EditorState;

  constructor(path: VaultPath, text: string, store: EditorDocumentStore) {
    this.id = `editor:${path}`;
    this.path = path;
    this.#initialText = text;
    this.#text = text;
    this.#store = store;
    this.state = createMarkdownEditorState(text);
  }

  getText(): string {
    return this.#text;
  }
  setText(value: string): void {
    this.#text = value;
    this.state = createMarkdownEditorState(value);
    this.#emit();
  }
  dispatch(change: EditorChange): void {
    const from = change.from ?? 0;
    const to = change.to ?? this.#text.length;
    this.setText(`${this.#text.slice(0, from)}${change.insert}${this.#text.slice(to)}`);
  }
  async save(): Promise<void> {
    await this.#store.write(this.path, this.#text);
    this.markSaved();
  }
  focus(): void {
    /* focus is host-owned in the desktop shell; no-op for headless service. */
  }
  onUpdate(listener: (event: EditorUpdateEvent) => void): Disposable {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
  dispose(): void {
    this.#listeners.clear();
  }
  isDirty(): boolean {
    return this.#text !== this.#initialText;
  }
  markSaved(): void {
    this.#initialText = this.#text;
    this.#emit();
  }
  #emit(): void {
    const event = { text: this.#text, dirty: this.isDirty() };
    for (const listener of this.#listeners) listener(event);
  }
}

export class EditorService implements EditorAPI {
  #store: EditorDocumentStore;
  #active?: MarkdownEditorHandle;
  #extensions: EditorExtensionContribution[] = [];
  #commands: EditorCommandContribution[] = [];

  constructor(store: EditorDocumentStore) {
    this.#store = store;
  }
  getActiveEditor(): EditorHandle | null {
    return this.#active ?? null;
  }
  activeEditor(): EditorHandle | undefined {
    return this.#active;
  }
  async openDocument(path: VaultPath, _options: OpenDocumentOptions = {}): Promise<EditorHandle> {
    const text = await this.#store.read(path);
    this.#active = new MarkdownEditorHandle(path, text, this.#store);
    return this.#active;
  }
  async open(path: VaultPath): Promise<EditorHandle> {
    return this.openDocument(path);
  }
  async save(handle: EditorHandle): Promise<void> {
    await handle.save();
  }
  registerExtension(extension: EditorExtensionContribution) {
    this.#extensions.push(extension);
    return {
      dispose: () => {
        this.#extensions = this.#extensions.filter((item) => item.id !== extension.id);
      },
    };
  }
  registerCommand(command: EditorCommandContribution) {
    this.#commands.push(command);
    return {
      dispose: () => {
        this.#commands = this.#commands.filter((item) => item.id !== command.id);
      },
    };
  }
  registeredExtensions(): readonly EditorExtensionContribution[] {
    return [...this.#extensions];
  }
  registeredCommands(): readonly EditorCommandContribution[] {
    return [...this.#commands];
  }
}

export function createInMemoryEditorStore(initial: Record<string, string> = {}): EditorDocumentStore {
  const files = new Map(Object.entries(initial));
  return {
    read: async (path) => files.get(path) ?? '',
    write: async (path, contents) => {
      files.set(path, contents);
    },
  };
}

export function createEditorService(
  store = createInMemoryEditorStore({ [normalizeVaultPath('Untitled.md')]: '' }),
): EditorService {
  return new EditorService(store);
}
