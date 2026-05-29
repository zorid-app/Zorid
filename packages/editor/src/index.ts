import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
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

export interface LivePreviewSelectionRange {
  readonly from: number;
  readonly to: number;
}

export interface LivePreviewVisibleRange {
  readonly from: number;
  readonly to: number;
}

export interface LivePreviewContext {
  readonly state: EditorState;
  readonly docText: string;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly focused: boolean;
  readonly selectionRanges: readonly LivePreviewSelectionRange[];
}

export interface LivePreviewRange {
  readonly rendererId: string;
  readonly from: number;
  readonly to: number;
  readonly className: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface LivePreviewRenderer {
  readonly id: string;
  match(context: LivePreviewContext): readonly LivePreviewRange[];
}

export function livePreviewSelectionRanges(state: EditorState): LivePreviewSelectionRange[] {
  return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

export function livePreviewRangeIntersectsSelection(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  selectionRanges: readonly LivePreviewSelectionRange[],
): boolean {
  return selectionRanges.some((selection) => {
    if (selection.from === selection.to) return selection.from >= range.from && selection.from <= range.to;
    return selection.from < range.to && selection.to > range.from;
  });
}

export function shouldRenderLivePreviewRange(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  context: Pick<LivePreviewContext, 'focused' | 'selectionRanges'>,
): boolean {
  return !context.focused || !livePreviewRangeIntersectsSelection(range, context.selectionRanges);
}

export function filterLivePreviewRanges(
  ranges: readonly LivePreviewRange[],
  context: Pick<LivePreviewContext, 'visibleFrom' | 'visibleTo' | 'focused' | 'selectionRanges'>,
): LivePreviewRange[] {
  return ranges
    .filter((range) => range.from < context.visibleTo && range.to > context.visibleFrom)
    .filter((range) => shouldRenderLivePreviewRange(range, context))
    .sort(
      (left, right) => left.from - right.from || left.to - right.to || left.rendererId.localeCompare(right.rendererId),
    );
}

export function createLivePreviewContext(
  state: EditorState,
  visibleRange: LivePreviewVisibleRange,
  focused = false,
): LivePreviewContext {
  return {
    state,
    docText: state.doc.toString(),
    visibleFrom: visibleRange.from,
    visibleTo: visibleRange.to,
    focused,
    selectionRanges: livePreviewSelectionRanges(state),
  };
}

export function collectLivePreviewRanges(
  renderers: readonly LivePreviewRenderer[],
  context: LivePreviewContext,
): LivePreviewRange[] {
  return filterLivePreviewRanges(
    renderers.flatMap((renderer) => renderer.match(context)),
    context,
  );
}

function livePreviewDecorationsForView(view: EditorView, renderers: readonly LivePreviewRenderer[]): DecorationSet {
  const ranges = view.visibleRanges.flatMap((visibleRange) =>
    collectLivePreviewRanges(renderers, createLivePreviewContext(view.state, visibleRange, view.hasFocus)),
  );
  return Decoration.set(
    ranges.map((range) =>
      Decoration.mark({
        class: range.className,
        attributes: {
          'data-live-preview-renderer': range.rendererId,
          ...range.attributes,
        },
      }).range(range.from, range.to),
    ),
    true,
  );
}

export function livePreviewExtension(renderers: readonly LivePreviewRenderer[]): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = livePreviewDecorationsForView(view, renderers);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
          this.decorations = livePreviewDecorationsForView(update.view, renderers);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

function regexLivePreviewRenderer(
  id: string,
  className: string,
  pattern: RegExp,
  rangeForMatch: (match: RegExpExecArray) => { fromOffset: number; toOffset: number },
): LivePreviewRenderer {
  return {
    id,
    match: ({ docText }) => {
      const ranges: LivePreviewRange[] = [];
      const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      for (const match of docText.matchAll(matcher)) {
        const index = match.index;
        if (index === undefined) continue;
        const { fromOffset, toOffset } = rangeForMatch(match);
        const from = index + fromOffset;
        const to = index + toOffset;
        if (to > from) ranges.push({ rendererId: id, from, to, className });
      }
      return ranges;
    },
  };
}

export const headingLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'heading',
  'z-live-preview-heading',
  /^#{1,6}\s+.+$/gm,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const inlineCodeLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'inline-code',
  'z-live-preview-inline-code',
  /`[^`\n]+`/g,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const markdownLinkLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'markdown-link',
  'z-live-preview-link',
  /\[[^\]\n]+\]\([^) \n][^)\n]*\)/g,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const wikiLinkLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'wiki-link',
  'z-live-preview-wiki-link',
  /\[\[[^\]\n]+\]\]/g,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const tagLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'tag',
  'z-live-preview-tag',
  /(^|[\s([{])#[A-Za-z0-9_/-]+/gm,
  (match) => {
    const leading = match[1]?.length ?? 0;
    return { fromOffset: leading, toOffset: match[0].length };
  },
);

export const taskMarkerLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'task-marker',
  'z-live-preview-task-marker',
  /^(\s*[-*+]\s+\[[ xX]\])/gm,
  (match) => ({ fromOffset: 0, toOffset: match[1]?.length ?? match[0].length }),
);

export const defaultLivePreviewRenderers: readonly LivePreviewRenderer[] = [
  headingLivePreviewRenderer,
  inlineCodeLivePreviewRenderer,
  markdownLinkLivePreviewRenderer,
  wikiLinkLivePreviewRenderer,
  tagLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
];

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
  const extensions: Extension[] = [markdown(), ...composed.extensions];
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
