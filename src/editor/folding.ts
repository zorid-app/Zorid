import { EditorSelection, EditorState, Facet, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { codeFolding, ensureSyntaxTree, foldedRanges, foldEffect, foldService, syntaxTree, syntaxTreeAvailable, unfoldEffect } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import type { Command, DecorationSet, KeyBinding, ViewUpdate } from '@codemirror/view';
import { bodyStart } from './live-properties.ts';

export interface MarkdownFoldingOptions { headings?: boolean; lists?: boolean }
export interface MarkdownFoldRange { kind: 'heading' | 'list'; line: number; from: number; to: number }
export interface MarkdownFoldSnapshot { version: 1; lines: number; folds: { fromLine: number; toLine: number }[] }
const configuration = Facet.define<MarkdownFoldingOptions, Required<MarkdownFoldingOptions>>({
  combine(values) { return Object.assign({ headings: true, lists: true }, ...values); },
});
type Tree = ReturnType<typeof syntaxTree>;
const cache = new WeakMap<EditorState['doc'], { tree: Tree; tabSize: number; ranges: readonly MarkdownFoldRange[] }>();
const indentWidth = (text: string, tabSize: number) => {
  let width = 0;
  for (const character of text) width = character === '\t' ? width + tabSize - width % tabSize : width + 1;
  return width;
};

/** One linear structural/line scan per document/tree version, shared by all
 * visible indicators and commands. Selection-only updates reuse this index. */
function index(state: EditorState, tree = syntaxTree(state)): readonly MarkdownFoldRange[] {
  const previous = cache.get(state.doc);
  if (previous?.tree === tree && previous.tabSize === state.tabSize) return previous.ranges;
  const headings = new Map<number, number>(), lists = new Set<number>();
  const prefix = bodyStart(state);
  tree.iterate({ enter(node) {
    if (node.to < prefix) return false;
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
    if (heading) {
      if (node.name.startsWith('Setext') && !/^[=\-]+\s*$/.test(state.doc.lineAt(node.to).text)) return false;
      const line = node.name.startsWith('Setext') ? state.doc.line(Math.max(1, state.doc.lineAt(node.to).number - 1)) : state.doc.lineAt(node.from);
      if (line.from >= prefix && (/^\s{0,3}#{1,6}(?:\s|$)/.test(line.text) || node.name.startsWith('Setext'))) headings.set(line.number, Number(heading[1]));
      return false;
    }
    if (node.name === 'ListItem') {
      const line = state.doc.lineAt(node.from);
      if (line.from >= prefix && /^\s*(?:[-+*]|\d+[.)])\s/.test(line.text)) lists.add(line.number);
    }
    if (['Paragraph', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Table'].includes(node.name)) return false;
  } });
  const ranges: MarkdownFoldRange[] = [];
  const headingStack: { level: number; line: number; from: number }[] = [];
  const listStack: { indent: number; line: number; from: number }[] = [];
  // ensureSyntaxTree can advance the parser context before a transaction
  // publishes that tree on state. An older tree must not assume EOF coverage.
  const complete = tree.length >= state.doc.length && syntaxTreeAvailable(state, state.doc.length);
  const lastLine = state.doc.lineAt(Math.min(tree.length, state.doc.length)).number;
  let lastNonblank = 0;
  const closeHeading = (to: number) => { const item = headingStack.pop()!; if (to > item.from) ranges.push({ kind: 'heading', line: item.line, from: item.from, to }); };
  const closeList = () => { const item = listStack.pop()!; if (lastNonblank > item.from) ranges.push({ kind: 'list', line: item.line, from: item.from, to: lastNonblank }); };
  for (let number = 1; number <= lastLine; number++) {
    const line = state.doc.line(number), level = headings.get(number);
    if (level) {
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) closeHeading(line.from - 1);
      headingStack.push({ level, line: number, from: line.to });
    }
    if (!line.text.trim()) continue;
    const indent = indentWidth(line.text.match(/^\s*/)?.[0] ?? '', state.tabSize);
    while (listStack.length && listStack[listStack.length - 1].indent >= indent) closeList();
    if (lists.has(number)) listStack.push({ indent, line: number, from: line.to });
    lastNonblank = line.to;
  }
  if (complete) {
    while (headingStack.length) closeHeading(state.doc.length);
    while (listStack.length) closeList();
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  cache.set(state.doc, { tree, tabSize: state.tabSize, ranges });
  return ranges;
}
export function foldableMarkdownRanges(state: EditorState): readonly MarkdownFoldRange[] {
  const options = state.facet(configuration);
  return index(state).filter(range => options[range.kind === 'heading' ? 'headings' : 'lists']);
}
function allRanges(view: EditorView): readonly MarkdownFoldRange[] {
  // Unlike the reference's synchronous five-second fold-all parse request,
  // commands decline unresolved ranges after a short bounded parse attempt.
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 25);
  const options = view.state.facet(configuration);
  return index(view.state, tree ?? syntaxTree(view.state)).filter(range => options[range.kind === 'heading' ? 'headings' : 'lists']);
}
function existing(state: EditorState): { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { result.push({ from, to }); });
  return result;
}
function dispatchFolds(view: EditorView, ranges: readonly { from: number; to: number }[], fold: boolean): boolean {
  if (!ranges.length || view.composing) return false;
  const prior = new Set(existing(view.state).map(range => `${range.from}:${range.to}`));
  const changes = ranges.filter(range => prior.has(`${range.from}:${range.to}`) !== fold);
  if (!changes.length) return false;
  const effects = changes.map(range => (fold ? foldEffect : unfoldEffect).of(range));
  // Move only endpoints that would become invisible, preserving direction and
  // unaffected selections. Folding is view state, never a document edit.
  const clamp = (position: number) => changes.reduce((value, range) => range.from < value && value < range.to ? range.from : value, position);
  const selection = fold ? EditorSelection.create(view.state.selection.ranges.map(range => EditorSelection.range(clamp(range.anchor), clamp(range.head))), view.state.selection.mainIndex) : view.state.selection;
  view.dispatch({ effects, ...(selection.eq(view.state.selection) ? {} : { selection }), annotations: Transaction.addToHistory.of(false) });
  return true;
}
function selectedRanges(view: EditorView, ranges: readonly MarkdownFoldRange[]) {
  const lines = new Set(view.state.selection.ranges.map(range => view.state.doc.lineAt(range.head).number));
  return ranges.filter(range => lines.has(range.line));
}
export const foldMarkdown: Command = view => dispatchFolds(view, selectedRanges(view, allRanges(view)), true);
export const unfoldMarkdown: Command = view => {
  const lines = new Set(view.state.selection.ranges.map(range => view.state.doc.lineAt(range.head).number));
  return dispatchFolds(view, existing(view.state).filter(range => lines.has(view.state.doc.lineAt(range.from).number)), false);
};
export const toggleMarkdownFold: Command = view => unfoldMarkdown(view) || foldMarkdown(view);
export const foldAllMarkdown: Command = view => dispatchFolds(view, allRanges(view), true);
export const unfoldAllMarkdown: Command = view => dispatchFolds(view, existing(view.state), false);
function progressive(view: EditorView, fold: boolean): boolean {
  const folded = new Set(existing(view.state).map(range => `${range.from}:${range.to}`)), ranges = allRanges(view), chosen: MarkdownFoldRange[] = [];
  for (const selection of view.state.selection.ranges) {
    const end = view.state.doc.lineAt(selection.to).to;
    const matches = ranges.filter(range => range.to >= selection.from && range.from <= end
      && folded.has(`${range.from}:${range.to}`) !== fold);
    const range = fold ? matches[matches.length - 1] : matches[0];
    if (range && !chosen.includes(range)) chosen.push(range);
  }
  return dispatchFolds(view, chosen, fold);
}
export const foldMoreMarkdown: Command = view => progressive(view, true);
export const foldLessMarkdown: Command = view => progressive(view, false);

/** Conventional CM bindings, opt-in only: the reference commands inspected
 * have no declared default shortcuts. Host command/palette wiring is separate. */
export const markdownFoldingKeymap: readonly KeyBinding[] = [
  { key: 'Ctrl-Shift-[', mac: 'Cmd-Alt-[', run: foldMarkdown },
  { key: 'Ctrl-Shift-]', mac: 'Cmd-Alt-]', run: unfoldMarkdown },
  { key: 'Ctrl-Alt-[', run: foldAllMarkdown },
  { key: 'Ctrl-Alt-]', run: unfoldAllMarkdown },
];
export function markdownFoldingKeyboard(): Extension { return keymap.of(markdownFoldingKeymap); }

export function getMarkdownFoldState(state: EditorState): MarkdownFoldSnapshot {
  return { version: 1, lines: state.doc.lines, folds: existing(state).map(range => ({ fromLine: state.doc.lineAt(range.from).number, toLine: state.doc.lineAt(range.to).number })) };
}
export function restoreMarkdownFoldState(view: EditorView, value: unknown): boolean {
  const saved = value as Partial<MarkdownFoldSnapshot> | null;
  if (!saved || saved.version !== 1 || saved.lines !== view.state.doc.lines || !Array.isArray(saved.folds) || saved.folds.length > 10000) return false;
  const ranges = new Map(allRanges(view).map(range => [`${range.line}:${view.state.doc.lineAt(range.to).number}`, range])), selected: MarkdownFoldRange[] = [];
  for (const entry of saved.folds) {
    if (!entry || !Number.isInteger(entry.fromLine) || !Number.isInteger(entry.toLine) || entry.fromLine < 1 || entry.toLine > saved.lines || entry.fromLine >= entry.toLine) return false;
    const range = ranges.get(`${entry.fromLine}:${entry.toLine}`);
    if (range && !selected.includes(range)) selected.push(range);
  }
  unfoldAllMarkdown(view);
  if (selected.length) dispatchFolds(view, selected, true);
  return true;
}

class FoldIndicator extends WidgetType {
  readonly collapsed: boolean;
  readonly kind: MarkdownFoldRange['kind'];
  constructor(collapsed: boolean, kind: MarkdownFoldRange['kind']) { super(); this.collapsed = collapsed; this.kind = kind; }
  eq(other: FoldIndicator) { return other.collapsed === this.collapsed && other.kind === this.kind; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = view.dom.ownerDocument.createElement('span'); wrapper.className = 'cm-markdown-fold-control'; wrapper.contentEditable = 'false';
    const button = view.dom.ownerDocument.createElement('button');
    button.type = 'button'; button.className = `cm-markdown-fold-toggle${this.collapsed ? ' is-collapsed' : ''}`;
    button.setAttribute('aria-label', `${this.collapsed ? 'Expand' : 'Collapse'} ${this.kind}`);
    button.setAttribute('aria-expanded', String(!this.collapsed)); button.title = button.getAttribute('aria-label')!;
    button.textContent = '›'; button.contentEditable = 'false';
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (!button.isConnected || view.composing) return;
      const line = view.state.doc.lineAt(view.posAtDOM(button));
      const folded = existing(view.state).find(range => view.state.doc.lineAt(range.from).number === line.number);
      const range = allRanges(view).find(range => range.line === line.number);
      if (folded) dispatchFolds(view, [folded], false);
      else if (range) dispatchFolds(view, [range], true);
      view.focus();
    });
    wrapper.append(button); return wrapper;
  }
  ignoreEvent() { return true; }
}

export function markdownFolding(options: MarkdownFoldingOptions = {}): Extension {
  const indicators = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private composing = false;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(update: ViewUpdate) {
      if (update.view.composing) { this.decorations = this.decorations.map(update.changes); this.composing = true; return; }
      if (this.composing || update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
        || foldedRanges(update.startState) !== foldedRanges(update.state) || update.startState.facet(configuration) !== update.state.facet(configuration)) {
        this.composing = false; this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView) {
      const ranges = foldableMarkdownRanges(view.state), folded = new Set(existing(view.state).map(range => range.from));
      const starts = new Map(ranges.map(range => [range.line, range]));
      const result: ReturnType<Decoration['range']>[] = [];
      for (const block of view.viewportLineBlocks) {
        const line = view.state.doc.lineAt(block.from), range = starts.get(line.number);
        if (!range) continue;
        const collapsed = folded.has(range.from);
        const offset = line.text.search(/\S/);
        if (offset >= 0) result.push(Decoration.widget({ widget: new FoldIndicator(collapsed, range.kind), side: -1 }).range(line.from + offset));
      }
      return Decoration.set(result, true);
    }
  }, { decorations: plugin => plugin.decorations });
  return [configuration.of(options), codeFolding({ placeholderDOM(view, onclick) {
    const button = view.dom.ownerDocument.createElement('button'); button.type = 'button';
    button.className = 'cm-foldPlaceholder cm-markdown-fold-placeholder'; button.textContent = '…'; button.setAttribute('aria-label', 'Expand folded content');
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
      if (!button.isConnected || view.composing) return;
      onclick(event); view.focus();
    });
    return button;
  } }), foldService.of((state, start) => foldableMarkdownRanges(state).find(range => range.line === state.doc.lineAt(start).number) ?? null),
  EditorView.atomicRanges.of(view => foldedRanges(view.state)), indicators,
  EditorState.transactionExtender.of(transaction => {
    const effects: ReturnType<typeof unfoldEffect.of>[] = [];
    for (const range of existing(transaction.startState)) {
      let touched = false;
      if (transaction.docChanged) transaction.changes.iterChangedRanges((from, to) => {
        const header = transaction.startState.doc.lineAt(range.from);
        if (from <= range.to && to >= header.from) touched = true;
      });
      const from = transaction.changes.mapPos(range.from, 1), to = transaction.changes.mapPos(range.to, -1);
      if (transaction.selection && transaction.newSelection.ranges.some(selection => selection.from < to && selection.to > from)) touched = true;
      if (touched && from < to) effects.push(unfoldEffect.of({ from, to }));
    }
    return effects.length ? { effects } : null;
  })];
}
