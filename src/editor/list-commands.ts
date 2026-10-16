import { countColumn, EditorSelection, EditorState, Prec } from '@codemirror/state';
import type { ChangeSpec, Extension, StateCommand } from '@codemirror/state';
import { indentUnit, syntaxTree } from '@codemirror/language';
import { insertNewline, insertNewlineAndIndent } from '@codemirror/commands';
import { keymap } from '@codemirror/view';

export interface MarkdownListOptions { useTab?: boolean; tabSize?: number; smartIndentList?: boolean }
export interface MarkdownListCommands { tab: StateCommand; shiftTab: StateCommand; enter: StateCommand; shiftEnter: StateCommand }
interface Options { useTab: boolean; tabSize: number; smartIndentList: boolean }

function optionsWithDefaults(options: MarkdownListOptions): Options {
  const value = { useTab: options.useTab ?? true, tabSize: options.tabSize ?? 4, smartIndentList: options.smartIndentList ?? true };
  if (!Number.isInteger(value.tabSize) || value.tabSize < 1 || value.tabSize > 32) throw new RangeError('Invalid tab width');
  return value;
}
interface Prefix { indent: string; marker: string; task: boolean; length: number }
function prefix(text: string): Prefix {
  const match = /^([ \t>]*)(?:(- |\+ |\* |\d+[.)] )(\[.\] )?)?/.exec(text)!;
  return { indent: match[1], marker: (match[2] ?? '') + (match[3] ?? ''), task: Boolean(match[3]), length: match[0].length };
}
function afterQuote(text: string): number {
  const quote = /^[ \t>]*/.exec(text)![0].lastIndexOf('>');
  return quote < 0 ? 0 : quote + (text[quote + 1] === ' ' ? 2 : 1);
}

function indentLines(outdent: boolean, options: Options): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const numbers = new Set<number>(), changes: ChangeSpec[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from), last = state.doc.lineAt(range.to);
      for (let number = first.number; number <= last.number; number++) {
        if (!range.empty && number === last.number && range.to === last.from) break;
        numbers.add(number);
      }
    }
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const line = state.doc.line(number), at = afterQuote(line.text);
      if (!outdent) { changes.push({ from: line.from + at, insert: options.useTab ? '\t' : '    ' }); continue; }
      const beforeQuote = /^[ \t]+(?=>)/.exec(line.text)?.[0];
      if (beforeQuote) { changes.push({ from: line.from, to: line.from + beforeQuote.length }); continue; }
      const whitespace = /^[ \t]*/.exec(line.text.slice(at))![0];
      if (!whitespace) continue;
      const width = Math.max(0, countColumn(whitespace, options.tabSize) - (options.useTab ? options.tabSize : 4));
      const insert = options.useTab ? '\t'.repeat(Math.floor(width / options.tabSize)) + ' '.repeat(width % options.tabSize) : ' '.repeat(width);
      changes.push({ from: line.from + at, to: line.from + at + whitespace.length, insert });
    }
    const changeSet = state.changes(changes);
    const selection = EditorSelection.create(state.selection.ranges.map(range =>
      EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1))), state.selection.mainIndex);
    dispatch(state.update({ changes: changeSet, selection, userEvent: outdent ? 'delete.dedent' : 'input.indent', scrollIntoView: true }));
    return true;
  };
}

/** Lezer gating is an interim syntax provider; HyperMD token equivalence is not established. */
function continuationExcluded(state: EditorState, position: number): boolean {
  for (const bias of [-1, 1] as const) {
    for (let node = syntaxTree(state).resolveInner(position, bias); node; node = node.parent!) {
      if (['FencedCode', 'CodeBlock', 'InlineCode', 'Table', 'HTMLBlock', 'BlockMath', 'InlineMath'].includes(node.name)) return true;
    }
  }
  // The installed Markdown parser has no math node. This bounded fallback
  // recognizes standalone $$ block delimiters, not a complete TeX grammar.
  let math = false;
  const current = state.doc.lineAt(position);
  for (let number = 1; number <= current.number; number++) {
    if (/^[ \t]*\$\$[ \t]*$/.test(state.doc.line(number).text)) math = !math;
  }
  return math || /^[ \t]*\$\$/.test(current.text);
}

function newlineOnly(): StateCommand {
  return target => {
    const { state, dispatch } = target;
    if (state.readOnly) return false;
    if (state.selection.ranges.some(range => !range.empty || range.head < state.doc.lineAt(range.head).from + prefix(state.doc.lineAt(range.head).text).length)) return insertNewline(target);
    dispatch(state.update(state.changeByRange(range => {
      const line = state.doc.lineAt(range.head), parsed = prefix(line.text);
      const indent = parsed.indent + ' '.repeat(parsed.marker.length);
      return { changes: { from: range.from, to: range.to, insert: '\n' + indent }, range: EditorSelection.cursor(range.from + 1 + indent.length) };
    }), { userEvent: 'input.type', scrollIntoView: true }));
    return true;
  };
}

function nextMarker(parsed: Prefix): string {
  let marker = parsed.marker;
  if (/^\d/.test(marker)) marker = marker.replace(/^\d+/, number => String(Number(number) + 1));
  if (parsed.task) marker = marker.replace(/\[.\] $/, '[ ] ');
  return marker;
}

function newlineContinue(): StateCommand {
  const only = newlineOnly();
  return target => {
    const { state, dispatch } = target;
    if (state.readOnly) return false;
    if (state.selection.ranges.some(range => !range.empty)) return insertNewlineAndIndent(target);
    if (state.selection.ranges.some(range => continuationExcluded(state, range.head))) return only(target);
    const prefixes = state.selection.ranges.map(range => {
      const line = state.doc.lineAt(range.head), parsed = prefix(line.text);
      if (range.head < line.from + parsed.length) return null;
      if (!parsed.marker) {
        if (!parsed.indent) return null;
        for (let number = line.number - 1; number > 0; number--) {
          const previous = prefix(state.doc.line(number).text);
          if (previous.length < parsed.length) break;
          if (previous.marker && previous.length === parsed.length) return { ...previous, length: parsed.length };
        }
        return parsed.indent.includes('>') ? parsed : null;
      }
      return parsed;
    });
    if (prefixes.some(parsed => !parsed)) return insertNewlineAndIndent(target);
    let index = 0;
    dispatch(state.update(state.changeByRange(range => {
      const line = state.doc.lineAt(range.head), parsed = prefixes[index++]!;
      const actual = prefix(line.text);
      if (!line.text.slice(actual.length).trim()) {
        if (actual.indent.includes('>')) {
          const indent = actual.marker ? actual.indent : actual.indent.slice(0, actual.indent.lastIndexOf('>'));
          return { changes: { from: line.from, to: range.head, insert: indent }, range: EditorSelection.cursor(line.from + indent.length) };
        }
        const dedent = /(?:\t| {1,4})$/.exec(actual.indent);
        if (dedent) {
          const from = line.from + actual.indent.length - dedent[0].length, to = line.from + actual.indent.length;
          return { changes: { from, to }, range: EditorSelection.cursor(range.head - (to - from)) };
        }
        return { changes: { from: line.from, to: range.head }, range: EditorSelection.cursor(line.from) };
      }
      const following = line.text.slice(range.head - line.from), whitespace = /^[ \t]*/.exec(following)![0];
      const existing = prefix(following.slice(whitespace.length)).marker;
      const insert = '\n' + parsed.indent + (existing ? '' : nextMarker(parsed));
      return { changes: { from: range.head, to: range.head + whitespace.length, insert }, range: EditorSelection.cursor(range.head + insert.length) };
    }), { userEvent: 'input.type', scrollIntoView: true }));
    return true;
  };
}

/** Original commands implementing the bounded static contract in list-fold-reference.md. */
export function markdownListCommands(options: MarkdownListOptions = {}): MarkdownListCommands {
  const config = optionsWithDefaults(options);
  return { tab: indentLines(false, config), shiftTab: indentLines(true, config),
    enter: config.smartIndentList ? newlineContinue() : insertNewlineAndIndent,
    shiftEnter: config.smartIndentList ? newlineOnly() : insertNewlineAndIndent };
}

/** Place before markdown()'s own high-precedence keymap; table-cell highest bindings win. */
export function markdownListKeymap(options: MarkdownListOptions = {}): Extension {
  const config = optionsWithDefaults(options), commands = markdownListCommands(config);
  return [indentUnit.of(config.useTab ? '\t' : '    '), EditorState.tabSize.of(config.tabSize), Prec.high(keymap.of([
    { key: 'Tab', run: commands.tab, shift: commands.shiftTab },
    { key: 'Enter', run: commands.enter, shift: commands.shiftEnter },
  ]))];
}
