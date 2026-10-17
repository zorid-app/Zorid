import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap } from '@codemirror/search';
import { editorCommandHotkeys } from '../editor/editor-commands.ts';
import type { EditorHotkeySource } from './hotkeys.ts';
import { activeTableEditor, liveTables } from '../editor/live-tables.ts';
import { bodyStart, liveProperties, propertyUpdate } from '../editor/live-properties.ts';
import { frontmatterMarkdown } from '../editor/frontmatter-syntax.ts';
import { liveCallouts, renderedCalloutRanges } from '../editor/live-callouts.ts';
import { liveMath, liveMathMarkdown } from '../editor/live-math.ts';
import { liveFences } from '../editor/live-fences.ts';
import { liveEmbeds } from '../editor/live-embeds.ts';
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

export interface EditorHandle {
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
  value: string; mode: 'live' | 'source'; paths: () => string[];
  onChange: (value: string) => void; open: (target: string, kind?: 'wiki' | 'markdown', event?: MouseEvent) => void;
  isUnresolved?: LiveInlineOptions['isUnresolved'];
  onLinkHover?: LiveInlineOptions['onHover'];
  wiki?: Omit<WikiCompletionOptions, 'paths'>;
  transfers?: TransferOptions;
  listOptions?: MarkdownListOptions;
  hotkeys?: EditorHotkeySource;
  renderEmbed?: (request: EmbedRequest) => { dom: HTMLElement; destroy(): void };
}

const externalChange = Annotation.define<boolean>();
// CodeMirror's generic default underlines headings; Markdown headings use weight/size.
const markdownHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(spec =>
  spec.tag === tags.heading ? { ...spec, textDecoration: 'none' } : spec));

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const listConfiguration = new Compartment();
  const wiki = wikiCompletion({ ...options.wiki, paths: options.paths });
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.value, extensions: [
      EditorState.allowMultipleSelections.of(true),
      history(), listConfiguration.of(markdownListKeymap(options.listOptions)), markdown({base: markdownLanguage,addKeymap:false,extensions:[frontmatterMarkdown, liveInlineMarkdown, liveMathMarkdown]}), syntaxHighlighting(markdownHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
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
      ...(options.transfers ? [editorTransfers(options.transfers)] : []),
      editorContextMenu(),
      ...(options.mode === 'live' ? [liveProperties(), liveCallouts({open: options.open, renderEmbed: options.renderEmbed}),
        liveTables(options.open, owner => [wiki, editorCommandHotkeys(options.hotkeys, owner)], renderedCalloutRanges), liveTasks({excludes: renderedCalloutRanges}), liveLists({excludes: renderedCalloutRanges}),
        liveMath({excludes: renderedCalloutRanges}), liveFences({excludes: renderedCalloutRanges}),
        ...(options.renderEmbed ? [liveEmbeds(options.renderEmbed, {excludes: renderedCalloutRanges})] : []),
        liveInline({open: options.open,isUnresolved: options.isUnresolved,onHover: options.onLinkHover,excludes: renderedCalloutRanges})] : []),
    ]}),
  });
  if (options.mode === 'live' && bodyStart(view.state)) view.dispatch({ selection: { anchor: bodyStart(view.state) } });
  const disposeEmptyFocus = installEmptyNoteFocus(view, parent);
  return {
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
    focus: () => (activeTableEditor(view) ?? view).focus(), destroy() { disposeEmptyFocus(); view.destroy(); },
    insert(text) { const target = activeTableEditor(view) ?? view; target.dispatch({ ...target.state.replaceSelection(text), annotations: Transaction.userEvent.of('input') }); target.focus(); },
  };
}
