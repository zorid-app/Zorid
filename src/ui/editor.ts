import { nativeCaretVisibility } from '../editor/native-caret-visibility.ts';
import { nativeEditorCommands } from './native-editor-commands.ts';
import type { NativeEditorAction, NativeEditorState } from './native-editor-commands.ts';
export type { NativeEditorAction, NativeEditorState } from './native-editor-commands.ts';
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, selectParentSyntax, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap } from '@codemirror/search';
import { noteFindPanel } from '../editor/find-panel.ts';
import { editorCommandHotkeys, runEditorCommand } from '../editor/editor-commands.ts';
import type { EditorHotkeySource } from './hotkeys.ts';
import { activeTableEditor, liveTables, refreshTableInteraction, retainTableEditor } from '../editor/live-tables.ts';
import { bodyStart, liveProperties, propertyUpdate } from '../editor/live-properties.ts';
import { frontmatterMarkdown } from '../editor/frontmatter-syntax.ts';
import { liveCallouts, renderedCalloutRanges } from '../editor/live-callouts.ts';
import { liveMath, liveMathMarkdown } from '../editor/live-math.ts';
import { liveFences } from '../editor/live-fences.ts';
import { liveEmbeds } from '../editor/live-embeds.ts';
import type { EmbedRenderContext } from '../editor/live-embeds.ts';
import { editorTransfers } from '../editor/transfers.ts';
import type { TransferOptions } from '../editor/transfers.ts';
import type { EmbedRequest } from './markdown.ts';
import { liveTasks } from '../editor/live-tasks.ts';
import { liveLists } from '../editor/live-lists.ts';
import { markdownListKeymap } from '../editor/list-commands.ts';
import type { MarkdownListOptions } from '../editor/list-commands.ts';
import { editorContextMenu } from '../editor/context-menu.ts';
import { liveInline, liveInlineMarkdown, refreshLiveInline } from '../editor/live-inline.ts';
import type { LiveInlineOptions } from '../editor/live-inline.ts';
import { textChanges } from '../editor/text-changes.ts';
import { wikiCompletion } from '../editor/wiki-completion.ts';
import type { WikiCompletionOptions } from '../editor/wiki-completion.ts';
import { installEmptyNoteFocus } from '../editor/empty-note-focus.ts';
import { markdownFolding, getMarkdownFoldState, restoreMarkdownFoldState, toggleMarkdownFold, foldMarkdown, unfoldMarkdown, foldAllMarkdown, unfoldAllMarkdown, foldMoreMarkdown, foldLessMarkdown } from '../editor/folding.ts';
import type { MarkdownFoldSnapshot } from '../editor/folding.ts';

export type EditorFoldAction = 'toggle' | 'fold' | 'unfold' | 'foldAll' | 'unfoldAll' | 'foldMore' | 'foldLess';
const foldCommands = { toggle: toggleMarkdownFold, fold: foldMarkdown, unfold: unfoldMarkdown,
  foldAll: foldAllMarkdown, unfoldAll: unfoldAllMarkdown, foldMore: foldMoreMarkdown, foldLess: foldLessMarkdown };

export interface EditorViewState {
  selection: { ranges: { anchor: number; head: number }[]; mainIndex: number };
  scrollTop: number; scrollLeft: number;
  folds?: MarkdownFoldSnapshot;
}

export interface EditorCommandTarget {
  run(id: string): boolean;
  dispose(): void;
}

export interface EditorInteractionState { active: boolean }

export interface EditorHandle {
  /** Refresh writer authority in place; every call retires captured authoring actions. Never focuses. */
  setInteractionState?(state: EditorInteractionState): void;
  nativeAction?(action: NativeEditorAction): boolean;
  nativeState?(): NativeEditorState;
  /** Capture one note/child selection before a modal takes focus. */
  captureCommandTarget?(isCurrent: () => boolean): EditorCommandTarget | null;
  getValue(): string;
  getViewState?(): EditorViewState;
  restoreViewState?(state: EditorViewState): void;
  /** Apply an external snapshot without recording it as a user edit. Existing undo entries are mapped through the change, not conflict-merged. */
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
  insert(text: string): void;
  configureLists?(options: MarkdownListOptions): void;
  refreshLinks?(): void;
  fold?(action: EditorFoldAction): boolean;
}
export interface EditorOptions {
  /** Pure live writer-token check. Exceptions deny authoring. Desktop defaults to true. */
  canMutate?: () => boolean;
  /** Passive views must start inactive, before any extension mounts. */
  interactionState?: EditorInteractionState;
  onNativeEditorState?: (state: NativeEditorState) => void;
  /** Native actions require the owning active pane/runtime/generation to remain current. */
  isCurrent?: () => boolean;
  value: string; mode: 'live' | 'source'; paths: () => string[];
  onChange: (value: string) => void; open: (target: string, kind?: 'wiki' | 'markdown', event?: MouseEvent) => void;
  isUnresolved?: LiveInlineOptions['isUnresolved'];
  onLinkHover?: LiveInlineOptions['onHover'];
  wiki?: Omit<WikiCompletionOptions, 'paths'>;
  transfers?: TransferOptions;
  listOptions?: MarkdownListOptions;
  hotkeys?: EditorHotkeySource;
  renderEmbed?: (request: EmbedRequest, context?: EmbedRenderContext) => { dom: HTMLElement; destroy(): void };
}

const externalChange = Annotation.define<boolean>();
// CodeMirror's generic default underlines headings; Markdown headings use weight/size.
const markdownHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(spec =>
  spec.tag === tags.heading ? { ...spec, textDecoration: 'none' } : spec));

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  let native: ReturnType<typeof nativeEditorCommands> | undefined;
  let destroyed = false, active = options.interactionState?.active ?? true;
  // An opaque identity avoids counter wrap and invalidates even same-state lease refreshes.
  let authoringEpoch = {};
  let interactionManaged = options.canMutate !== undefined || options.interactionState !== undefined;
  const canAuthor = () => {
    try { return !destroyed && active && (options.canMutate?.() ?? true); }
    catch { return false; }
  };
  const isCurrent = () => active && !destroyed && (options.isCurrent?.() ?? true);
  const interaction = new Compartment(), menus = new Compartment();
  const interactionExtensions = () => [canAuthor() ? [] : EditorState.readOnly.of(true), active ? [] : EditorView.editable.of(false)];
  const captureAuthoring = () => {
    if (!canAuthor()) return null;
    const epoch = authoringEpoch;
    return () => epoch === authoringEpoch && canAuthor();
  };
  const menuExtensions = () => editorContextMenu(undefined, undefined, interactionManaged ? captureAuthoring : undefined);
  const nativeCaret=options.onNativeEditorState?nativeCaretVisibility(isCurrent):[];
  const nativeUpdates = options.onNativeEditorState ? EditorView.updateListener.of(() => native?.update()) : [];
  const listConfiguration = new Compartment();
  const wiki = wikiCompletion({ ...options.wiki, paths: options.paths });
  const view = new EditorView({
    parent,
    // readOnly alone does not reject programmatic changes, and CM filters can
    // be bypassed with filter:false. Authorize the actual applied batch here.
    dispatchTransactions(transactions, target) {
      if (destroyed || transactions.some(transaction => transaction.docChanged
        && !transaction.annotation(externalChange) && (!canAuthor() || target.state.readOnly))) return;
      target.update(transactions);
    },
    state: EditorState.create({ doc: options.value, extensions: [
      interaction.of(interactionExtensions()), EditorState.allowMultipleSelections.of(true),
      nativeUpdates, nativeCaret, history(), listConfiguration.of(markdownListKeymap(options.listOptions)), markdown({base: markdownLanguage,addKeymap:false,extensions:[frontmatterMarkdown, liveInlineMarkdown, liveMathMarkdown]}), syntaxHighlighting(markdownHighlightStyle),
      noteFindPanel(),
      keymap.of([...defaultKeymap.filter(binding => binding.run !== selectParentSyntax), ...historyKeymap, ...searchKeymap]),
      EditorView.lineWrapping, wiki, editorCommandHotkeys(options.hotkeys),
      markdownFolding(),
      EditorView.contentAttributes.of({'aria-label': 'Note editor', spellcheck: 'true'}),
      EditorView.updateListener.of(update => { if (update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(externalChange))) options.onChange(update.state.doc.toString()); }),
      ...(options.mode === 'source' ? [EditorView.domEventHandlers({ click(event, sourceView) {
        if (!event.metaKey && !event.ctrlKey) return false;
        const position = sourceView.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const node = syntaxTree(sourceView.state).resolveInner(position, 1);
        if (node.name !== 'LiveInlineWiki') return false;
        const target = sourceView.state.sliceDoc(node.from + 2, node.to - 2).split('|')[0].trim();
        if (!target) return false;
        options.open(target, 'wiki', event); return true;
      } })] : []),
      ...(options.transfers ? [editorTransfers(options.transfers, captureAuthoring)] : []),
      menus.of(menuExtensions()),
      ...(options.mode === 'live' ? [liveProperties(), liveCallouts({open: options.open, renderEmbed: options.renderEmbed}),
        liveTables(options.open, owner => [wiki, editorCommandHotkeys(options.hotkeys, owner), nativeUpdates, nativeCaret], renderedCalloutRanges, canAuthor), liveTasks({excludes: renderedCalloutRanges}), liveLists({excludes: renderedCalloutRanges}),
        liveMath({excludes: renderedCalloutRanges}), liveFences({excludes: renderedCalloutRanges}),
        ...(options.renderEmbed ? [liveEmbeds(options.renderEmbed, {excludes: renderedCalloutRanges})] : []),
        liveInline({nativeTouch: options.onNativeEditorState ? {isCurrent} : undefined,open: options.open,isUnresolved: options.isUnresolved,onHover: options.onLinkHover,excludes: renderedCalloutRanges})] : []),
    ]}),
  });
  if (options.mode === 'live' && bodyStart(view.state)) view.dispatch({ selection: { anchor: bodyStart(view.state) } });
  const disposeEmptyFocus = installEmptyNoteFocus(view, parent, options.onNativeEditorState ? isCurrent : undefined);
  if (options.onNativeEditorState) native = nativeEditorCommands(view, {onNativeEditorState:options.onNativeEditorState,isCurrent:() => isCurrent() && canAuthor()});
  return {
    setInteractionState(state) {
      if (destroyed) return;
      authoringEpoch = {};
      active = state.active;
      interactionManaged = true;
      // A fresh menu plugin retires its outstanding async action witnesses.
      view.dispatch({ effects: [interaction.reconfigure(interactionExtensions()), menus.reconfigure(menuExtensions()), refreshTableInteraction.of()] });
      const focused = view.dom.ownerDocument.activeElement;
      if (!active && focused instanceof HTMLElement && view.dom.contains(focused)) focused.blur();
    },
    ...(native ? {nativeAction: native.action, nativeState: native.state} : {}),
    captureCommandTarget(isCurrent) {
      const document = view.dom.ownerDocument, focused = document.activeElement;
      const target = activeTableEditor(view) ?? view;
      // The palette button may use the last body selection. Other controls,
      // including a title, property field or CM search input, own their input.
      const inBody = focused === target.contentDOM;
      const paletteButton = focused instanceof HTMLElement && focused.closest('[data-hotkey-command="command-palette"]');
      if (!inBody && focused !== document.body && !paletteButton) return null;
      if (!canAuthor() || destroyed || !isCurrent() || !view.dom.isConnected || !target.dom.isConnected
        || view.state.readOnly || target.state.readOnly || view.compositionStarted || target.compositionStarted
        || document.querySelector('.modal-overlay,[aria-modal="true"],[role="menu"]')
        || view.dom.querySelector('.cm-tooltip-autocomplete,.cm-search')) return null;
      const ownerDoc = view.state.doc, ownerSelection = view.state.selection;
      const doc = target.state.doc, selection = target.state.selection;
      const release = retainTableEditor(view, target.contentDOM);
      let disposed = false;
      const epoch = authoringEpoch;
      const valid = () => epoch === authoringEpoch && canAuthor() && !disposed && !destroyed && isCurrent() && view.dom.isConnected && target.dom.isConnected
        && view.dom.contains(target.dom) && view.state.doc === ownerDoc && target.state.doc === doc
        && view.state.selection.eq(ownerSelection) && target.state.selection.eq(selection)
        && !view.state.readOnly && !target.state.readOnly && !view.compositionStarted && !target.compositionStarted;
      return {
        run(id) {
          if (!valid()) return false;
          target.focus();
          // Focusing can run application handlers, change selection or retire
          // this pane. Never resolve a replacement target after that happens.
          if (!valid()) return false;
          return runEditorCommand(id, target, view);
        },
        dispose() { if (!disposed) { disposed = true; release(); } },
      };
    },
    getValue: () => view.state.doc.toString(),
    getViewState: () => ({selection: {ranges:view.state.selection.ranges.map(range=>({anchor:range.anchor,head:range.head})),mainIndex:view.state.selection.mainIndex}, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft, folds: getMarkdownFoldState(view.state)}),
    restoreViewState(saved) {
      // Session data is untrusted and can refer to a longer, older file snapshot.
      const ranges = saved?.selection?.ranges;
      if (Array.isArray(ranges) && ranges.length && ranges.length <= 1000 && ranges.every(range => Number.isFinite(range?.anchor) && Number.isFinite(range?.head))) {
        const clamp = (position: number) => Math.max(0, Math.min(view.state.doc.length, Math.trunc(position)));
        const main = Number.isInteger(saved.selection.mainIndex) ? Math.max(0, Math.min(ranges.length - 1, saved.selection.mainIndex)) : 0;
        view.dispatch({ selection: EditorSelection.create(ranges.map(range => EditorSelection.range(clamp(range.anchor), clamp(range.head))), main), annotations: Transaction.addToHistory.of(false) });
      }
      // Selection changes normally unfold entered ranges. Restore selection
      // first so a saved spanning selection cannot erase the saved folds.
      if (saved?.folds) restoreMarkdownFoldState(view, saved.folds);
      if (Number.isFinite(saved?.scrollTop)) view.scrollDOM.scrollTop = Math.max(0, saved.scrollTop);
      if (Number.isFinite(saved?.scrollLeft)) view.scrollDOM.scrollLeft = Math.max(0, saved.scrollLeft);
    },
    refreshLinks() { view.dispatch({ effects: refreshLiveInline.of() }); },
    fold(action) {
      if (!Object.hasOwn(foldCommands, action)) return false;
      const child = activeTableEditor(view), childFocused = child?.hasFocus;
      const changed = foldCommands[action](view);
      // Folding can unmount the focused cell editor. Keep typing focus in its
      // owning note, without taking focus from a title or toolbar control.
      if (changed && childFocused && !child!.dom.isConnected) view.focus();
      return changed;
    },
    configureLists(listOptions) { view.dispatch({ effects: listConfiguration.reconfigure(markdownListKeymap(listOptions)) }); },
    setValue(value) {
      const previous = view.state.doc.toString();
      if (value === previous) return;
      // Multiple changed spans preserve carets/history in unchanged gaps.
      // The helper bounds expensive diffs; this remains a snapshot, not a merge.
      view.dispatch({ changes: textChanges(previous, value),
        annotations: [externalChange.of(true), propertyUpdate.of(true), Transaction.addToHistory.of(false), isolateHistory.of('full')] });
    },
    focus: () => { if (active && !destroyed) (activeTableEditor(view) ?? view).focus(); }, destroy() { if(destroyed)return; destroyed = true; native?.destroy(); disposeEmptyFocus(); view.destroy(); },
    insert(text) { if (!canAuthor() || view.state.readOnly) return; const target = activeTableEditor(view) ?? view; target.dispatch({ ...target.state.replaceSelection(text), annotations: Transaction.userEvent.of('input') }); target.focus(); },
  };
}
