import { Transaction } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type KeyBinding,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { isMarkdownCalloutTitleLine } from './live-preview/markdown-code-context.js';

const indentationUnitColumns = 4;
const indentationUnit = ' '.repeat(indentationUnitColumns);

interface TouchedLine {
  readonly number: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface LineReplacement {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

export function leadingIndentColumns(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === ' ') {
      columns += 1;
      continue;
    }
    if (character === '\t') {
      columns += indentationUnitColumns;
      continue;
    }
    break;
  }
  return columns;
}

export function indentationDepth(text: string): number {
  return Math.floor(leadingIndentColumns(text) / indentationUnitColumns);
}

export function indentLineText(text: string): string {
  return `${indentationUnit}${text}`;
}

export function outdentLineText(text: string): string {
  if (text.startsWith('\t')) return text.slice(1);

  let remove = 0;
  while (remove < indentationUnitColumns && text.charCodeAt(remove) === 32) remove += 1;
  return text.slice(remove);
}

function touchedLines(view: EditorView): TouchedLine[] {
  const doc = view.state.doc;
  const lineNumbers = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const fromLine = doc.lineAt(range.from);
    const toPosition = range.empty ? range.to : Math.max(range.from, range.to - 1);
    const toLine = doc.lineAt(toPosition);
    for (let number = fromLine.number; number <= toLine.number; number += 1) lineNumbers.add(number);
  }
  return [...lineNumbers]
    .sort((left, right) => left - right)
    .map((number) => {
      const line = doc.line(number);
      return { number, from: line.from, to: line.to, text: line.text };
    });
}

function dispatchLineReplacements(
  view: EditorView,
  replacements: readonly LineReplacement[],
  userEvent: string,
): boolean {
  const changes = replacements.filter(
    (replacement) => view.state.doc.sliceString(replacement.from, replacement.to) !== replacement.insert,
  );
  if (changes.length === 0) return false;
  view.dispatch({ changes, annotations: Transaction.userEvent.of(userEvent) });
  return true;
}

export function indentLinesAtSelection(view: EditorView): boolean {
  const replacements = touchedLines(view)
    .filter((line) => !isBlank(line.text))
    .filter((line) => !isMarkdownCalloutTitleLine(line.text))
    .map((line) => ({ from: line.from, to: line.to, insert: indentLineText(line.text) }));
  return dispatchLineReplacements(view, replacements, 'input.indent');
}

export function outdentLinesAtSelection(view: EditorView): boolean {
  const replacements = touchedLines(view)
    .filter((line) => leadingIndentColumns(line.text) > 0)
    .filter((line) => !isMarkdownCalloutTitleLine(line.text))
    .map((line) => ({ from: line.from, to: line.to, insert: outdentLineText(line.text) }));
  return dispatchLineReplacements(view, replacements, 'input.outdent');
}

export const markdownIndentKeymap: readonly KeyBinding[] = [
  {
    key: 'Tab',
    preventDefault: true,
    run: indentLinesAtSelection,
  },
  {
    key: 'Shift-Tab',
    preventDefault: true,
    run: outdentLinesAtSelection,
  },
];

function indentationGuideDecorations(view: EditorView): DecorationSet {
  const decorations = [];
  for (const visibleRange of view.visibleRanges) {
    let position = visibleRange.from;
    while (position <= visibleRange.to) {
      const line = view.state.doc.lineAt(position);
      const depth = indentationDepth(line.text);
      if (depth > 0) {
        decorations.push(
          Decoration.line({
            class: 'z-editor-indent-guide',
            attributes: {
              'data-indent-depth': String(depth),
            },
          }).range(line.from),
        );
      }
      if (line.to >= visibleRange.to || line.to === view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

export const editorIndentationGuideExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = indentationGuideDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = indentationGuideDecorations(update.view);
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export const editorIndentationExtension = [editorIndentationGuideExtension, keymap.of(markdownIndentKeymap)];
