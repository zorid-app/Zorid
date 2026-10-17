import { ChangeSet, EditorSelection } from '@codemirror/state';
import type { EditorState, SelectionRange, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { mathSpan } from './math-syntax.ts';
import { isolateHistory } from '@codemirror/commands';

import { INSERTION_COMMANDS } from './insertion-catalogue.ts';
import type { InsertionCommandId } from './insertion-catalogue.ts';
export { INSERTION_COMMANDS } from './insertion-catalogue.ts';
export type { InsertionCommandId } from './insertion-catalogue.ts';
export interface InsertionOptions { inTableCell?: boolean; rectangle?: boolean }
export function isInsertionCommand(id: string): id is InsertionCommandId {
  return INSERTION_COMMANDS.some(command => command.id === id);
}
const inline = new Set<InsertionCommandId>(['editor-insert-link', 'editor-insert-image']);
const excluded = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'Comment', 'CommentBlock', 'ZoridFrontmatter', 'Table', 'InlineCode',
  'ZoridMathBlock', 'ZoridMathInline', 'ZoridMathDisplay', 'LiveInlineWiki', 'LiveInlineWikiEmbed', 'LiveInlineComment']);
const inlineExcluded = new Set(['InlineCode', 'Link', 'Image', 'Autolink']);

/** Bounded parsing fails closed. A cold late-document selection must never be
 * treated as ordinary prose just because the incremental tree ends early. */
export function canInsert(state: EditorState, id: InsertionCommandId, options: InsertionOptions = {}): boolean {
  if (state.readOnly || options.rectangle || options.inTableCell && !inline.has(id)) return false;
  const until = id === 'editor-insert-footnote' ? state.doc.length : state.selection.ranges.reduce((end, range) => Math.max(end, range.to), 0);
  const tree = ensureSyntaxTree(state, until, 20);
  if (!tree) return false;
  for (const range of state.selection.ranges) {
    let blocked = false;
    tree.iterate({ from: range.from, to: range.to, enter(node) {
      if (inline.has(id) && ['Link', 'Image', 'Autolink'].includes(node.name) && !range.empty && range.from <= node.from && range.to >= node.to) return false;
      if (node.name === 'InlineCode' && !range.empty && !inline.has(id) && range.from <= node.from && range.to >= node.to) return;
      if (excluded.has(node.name) || inline.has(id) && inlineExcluded.has(node.name)) {
        // A cursor at the start/end of a code/table line is still inside it.
        if (range.empty ? node.from <= range.from && node.to >= range.to : node.from < range.to && node.to > range.from) blocked = true;
      }
    } });
    if (blocked) return false;
    const selected = state.sliceDoc(range.from, range.to);
    if (inline.has(id) && /[\r\n]/.test(selected)) return false;
    if (id === 'editor-insert-math-block' && selected.includes('$$')) return false;
  }
  if (id === 'editor-insert-footnote') {
    // Definitions must not be appended inside a terminal unclosed code fence.
    let unclosed = false;
    tree.iterate({ enter(node) {
      if (node.to !== state.doc.length) return;
      if (node.name === 'HTMLBlock' || node.name === 'CommentBlock' || node.name === 'Comment' || node.name === 'LiveInlineComment' || node.name === 'ZoridFrontmatter') { unclosed = true; return; }
      if (node.name === 'ZoridMathBlock' && !mathSpan(node.node, (from, to) => state.sliceDoc(from, to))?.closed) { unclosed = true; return; }
      if (node.name !== 'FencedCode') return;
      const first = node.node.firstChild, last = node.node.lastChild;
      if (!last || !first || last.from === first.from || last.name !== 'CodeMark') unclosed = true;
    } });
    if (unclosed) return false;
  }
  return true;
}
function boundaryBefore(state: EditorState, at: number): string {
  if (!at) return '';
  const before = state.sliceDoc(Math.max(0, at - 2), at);
  return before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
}
function boundaryAfter(state: EditorState, at: number): string {
  if (at === state.doc.length) return '';
  const after = state.sliceDoc(at, Math.min(state.doc.length, at + 2));
  return after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
}
function oriented(range: SelectionRange, from: number, to: number) {
  return range.anchor > range.head ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
}
function footnotes(state: EditorState): TransactionSpec {
  const occupied = new Set([...state.doc.toString().matchAll(/\[\^([^\]\s]+)\]/g)].map(match => match[1].toLocaleLowerCase()));
  let next = 1;
  let definitions = '';
  const selections: { from: number; to: number; original: SelectionRange }[] = [];
  const replacements = state.selection.ranges.map(range => {
    while (occupied.has(String(next))) next++;
    const label = String(next++); occupied.add(label);
    const text = state.sliceDoc(range.from, range.to);
    const prefix = `[^${label}]: `;
    const start = definitions.length + prefix.length;
    definitions += prefix + text.replaceAll('\n', '\n    ') + '\n';
    selections.push({ from: start, to: definitions.length - 1, original: range });
    return { from: range.from, to: range.to, insert: `[^${label}]` };
  });
  // Calculate padding against the document after replacing selections, including
  // a selection/cursor at EOF. End insertion is part of the same transaction.
  const replaced = ChangeSet.of(replacements, state.doc.length);
  const interim = replaced.apply(state.doc);
  const tail = interim.sliceString(Math.max(0, interim.length - 2));
  const padding = !interim.length || tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
  const append = padding + definitions;
  const changes = replaced.compose(ChangeSet.of({ from: interim.length, insert: append }, interim.length));
  const base = interim.length + padding.length;
  return { changes, selection: EditorSelection.create(selections.map(item => oriented(item.original, base + item.from, base + item.to)), state.selection.mainIndex) };
}

/** One transaction and one undo unit. Selected text is retained: wrappers keep
 * its bytes; table/rule insert after it rather than silently replacing it. */
export function insertionTransaction(state: EditorState, id: InsertionCommandId, options: InsertionOptions = {}): TransactionSpec | null {
  if (!canInsert(state, id, options)) return null;
  const transaction = id === 'editor-insert-footnote' ? footnotes(state) : state.changeByRange(range => {
    const selected = state.sliceDoc(range.from, range.to);
    let insert: string, from: number, to: number;
    if (inline.has(id)) {
      const prefix = id === 'editor-insert-image' ? '![' : '[';
      // Escape label punctuation so the selection cannot close the new label.
      const label = selected.replace(/[\\\[\]]/g, '\\$&');
      insert = `${prefix}${label}]()`;
      from = to = range.empty ? prefix.length : insert.length - 1;
    } else {
      let body: string, bodyFrom: number, bodyTo: number;
      if (id === 'editor-insert-callout') {
        body = '> [!note]\n> ' + selected.replaceAll('\n', '\n> ');
        bodyFrom = 12; bodyTo = body.length;
      } else if (id === 'editor-insert-code-block') {
        let longest = 0;
        for (const match of selected.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
        const fence = '`'.repeat(Math.max(3, longest + 1));
        body = fence + '\n' + selected + '\n' + fence;
        bodyFrom = fence.length + 1; bodyTo = bodyFrom + selected.length;
      } else if (id === 'editor-insert-math-block') {
        body = '$$\n' + selected + '\n$$'; bodyFrom = 3; bodyTo = 3 + selected.length;
      } else {
        const kept = selected ? selected + (selected.endsWith('\n\n') ? '' : selected.endsWith('\n') ? '\n' : '\n\n') : '';
        if (id === 'editor-insert-table') {
          body = kept + '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';
          bodyFrom = kept.length + 2; bodyTo = bodyFrom + 8;
        } else {
          body = kept + '***\n\n'; bodyFrom = bodyTo = body.length;
        }
      }
      const before = boundaryBefore(state, range.from), after = boundaryAfter(state, range.to);
      insert = before + body + after;
      from = before.length + bodyFrom; to = before.length + bodyTo;
    }
    return { changes: { from: range.from, to: range.to, insert }, range: oriented(range, range.from + from, range.from + to) };
  });
  return { ...transaction, userEvent: 'input.insert', annotations: isolateHistory.of('full'), scrollIntoView: true };
}
export function runInsertion(view: EditorView, id: InsertionCommandId, options: InsertionOptions = {}): boolean {
  if (view.composing || view.compositionStarted || !view.dom.isConnected) return false;
  const transaction = insertionTransaction(view.state, id, options);
  if (!transaction) return false;
  view.dispatch(transaction); view.focus(); return true;
}
