import { INSERTION_COMMANDS, canInsert, runInsertion } from './insertion-commands.ts';
import { ChangeSet, EditorSelection } from '@codemirror/state';
import type { Annotation, ChangeSpec, EditorState, SelectionRange } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

export type FormatMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled: boolean; checked?: boolean; run: () => boolean }
  | { id: string; label: string; enabled: boolean; submenu: FormatMenuItem[] };
export interface FormatMenuOptions {
  inTableCell?: boolean;
  /** Resolve selected cell source spans afresh when opening or running an action. */
  ranges?: () => readonly { from: number; to: number }[];
  /** Ownership annotations for the caller's rectangular-selection lifecycle. */
  annotations?: readonly Annotation<unknown>[];
}
type Kind = 'bold' | 'italic' | 'strikethrough' | 'code' | 'math' | 'comment' | 'highlight';
interface Range { from: number; to: number }
interface SelectionContext { state: EditorState; tree: ReturnType<typeof syntaxTree> }
interface Span extends Range { kind: Kind; contentFrom: number; contentTo: number; color?: string; colorMarker?: string }
const delimiters: Record<Kind, string> = { bold: '**', italic: '*', strikethrough: '~~', code: '`', math: '$', comment: '%%', highlight: '==' };
const colors: Record<string, string> = { red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢', blue: '🔵', purple: '🟣' };
const colorAliases: Record<string, string> = { '🔴': 'red', '🟥': 'red', '🟠': 'orange', '🟧': 'orange', '🟡': 'yellow', '🟨': 'yellow', '🟢': 'green', '🟩': 'green', '🔵': 'blue', '🟦': 'blue', '🟣': 'purple', '🟪': 'purple' };
const blocked = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'Table']);
const markerTypes = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker']);

function trimmed(state: EditorState, range: Range): Range {
  let { from, to } = range;
  while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
  while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
  return { from, to };
}
function overlaps(a: Range, b: Range): boolean { return a.from < b.to && b.from < a.to; }
function escaped(source: string, at: number): boolean {
  let count = 0; while (at > 0 && source[--at] === '\\') count++;
  return count % 2 === 1;
}

/** Prefix maxima answer containment/overlap queries without walking every
 * prior span. Nested and crossing intervals are both supported. */
class IntervalIndex {
  private starts: number[];
  private ends: number[];
  constructor(ranges: readonly Range[]) {
    const sorted = [...ranges].sort((a, b) => a.from - b.from);
    this.starts = sorted.map(range => range.from);
    let maximum = -1;
    this.ends = sorted.map(range => maximum = Math.max(maximum, range.to));
  }
  private maximumEnd(before: number, inclusive: boolean): number {
    let low = 0, high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.starts[middle] < before || inclusive && this.starts[middle] === before) low = middle + 1;
      else high = middle;
    }
    return low ? this.ends[low - 1] : -1;
  }
  containsPoint(position: number): boolean { return this.maximumEnd(position, true) > position; }
  inside(position: number): boolean { return this.maximumEnd(position, false) > position; }
  covers(range: Range): boolean { return this.maximumEnd(range.from, true) >= range.to; }
  overlaps(range: Range): boolean { return this.maximumEnd(range.to, false) > range.from; }
}

/** Lezer supplies supported Markdown structure; the bounded extra scanner adds
 * the reference's highlight/color, inline math and percent-comment syntax. */
function inspect(state: EditorState, cellRanges: readonly Range[] | undefined, tree: ReturnType<typeof syntaxTree>) {
  const spans: Span[] = [], excluded: Range[] = [], codeRanges: Range[] = [], markers: Range[] = [];
  const source = state.doc.toString();
  const kinds: Record<string, Kind> = { StrongEmphasis: 'bold', Emphasis: 'italic', Strikethrough: 'strikethrough', InlineCode: 'code' };
  tree.iterate({ enter(node) {
    if (blocked.has(node.name) && !(cellRanges && node.name === 'Table')) { excluded.push({ from: node.from, to: node.to }); return false; }
    const kind = kinds[node.name];
    if (kind) {
      const first = node.node.firstChild, last = node.node.lastChild;
      if (first && last && first !== last) spans.push({ kind, from: node.from, to: node.to, contentFrom: first.to, contentTo: last.from });
      if (kind === 'code') { codeRanges.push({ from: node.from, to: node.to }); }
    }
    if (markerTypes.has(node.name)) markers.push({ from: node.from, to: node.to });
  } });
  // The caller supplies independent inline documents. Bound lexical matching
  // directly to those spans, including when the parser has not reached a late
  // table yet; outside-table text must never pair with a selected cell.
  const regions: readonly Range[] = cellRanges ?? [{ from: 0, to: source.length }];
  const lexicalExcluded = [...excluded, ...codeRanges];
  for (const kind of ['comment', 'highlight', 'math'] as const) {
    const delimiter = delimiters[kind], lexicalIndex = new IntervalIndex(lexicalExcluded);
    for (const region of regions) {
      const fragment = source.slice(region.from, region.to);
      const nextDelimiter = (position: number): number => {
        const local = fragment.indexOf(delimiter, position - region.from);
        return local < 0 ? -1 : region.from + local;
      };
      for (let from = region.from; from < region.to;) {
        from = nextDelimiter(from);
        if (from < 0) break;
        const start = from; from += delimiter.length;
        if (escaped(source, start) || lexicalIndex.containsPoint(start)
          || (kind === 'math' && (source[start - 1] === '$' || source[from] === '$'))
          || (kind !== 'comment' && /\s/.test(source[from] ?? ''))) continue;
        let end = nextDelimiter(from);
        while (end >= 0 && (escaped(source, end) || kind !== 'comment' && lexicalIndex.containsPoint(end) || (kind === 'math' && source[end + 1] === '$'))) end = nextDelimiter(end + delimiter.length);
        if (end < 0) continue;
        if (kind !== 'comment' && (/\n/.test(source.slice(from, end)) || /\s/.test(source[end - 1] ?? ''))) continue;
        if (kind === 'math' && /\d/.test(source[end + 1] ?? '')) continue;
        const codePoint = source.codePointAt(from);
        const marker = kind === 'highlight' && from < end && codePoint !== undefined ? String.fromCodePoint(codePoint) : '';
        const color = colorAliases[marker] ?? '';
        const contentFrom = from + (color ? marker.length : 0), to = end + delimiter.length;
        spans.push({ kind, from: start, to, contentFrom, contentTo: end, color, colorMarker: color ? marker : '' });
        markers.push({ from: start, to: contentFrom }, { from: end, to });
        if (kind === 'comment') lexicalExcluded.push({ from: start, to });
        from = to;
      }
    }
  }
  const opaque = new IntervalIndex(spans.filter(span => span.kind === 'comment' || span.kind === 'math')
    .map(span => ({ from: span.contentFrom, to: span.contentTo })));
  const visibleSpans = spans.filter(span => !opaque.covers(span));
  const byKind = new Map<Kind, IntervalIndex>();
  for (const kind of Object.keys(delimiters) as Kind[]) byKind.set(kind, new IntervalIndex(visibleSpans.filter(span => span.kind === kind)));
  return {
    tree,
    spans: visibleSpans,
    excluded: new IntervalIndex(excluded),
    byKind,
    markers: markers.filter(marker => !opaque.covers(marker)),
  };
}
function contentLine(state: EditorState, number: number, tree: ReturnType<typeof syntaxTree>): Range {
  const line = state.doc.line(number);
  let from = line.from;
  tree.iterate({ from: line.from, to: line.to, enter(node) {
    if (['HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker'].includes(node.name)) from = Math.max(from, node.to);
  } });
  const task = /^[ \t]*\[([^\r\n])\](?=[ \t]|$)/.exec(state.sliceDoc(from, line.to));
  if (from > line.from && task) from += task[0].length;
  return trimmed(state, { from, to: line.to });
}
function selectionParts(state: EditorState, range: Range, data: ReturnType<typeof inspect>): Range[] {
  const first = state.doc.lineAt(range.from), last = state.doc.lineAt(range.to), parts: Range[] = [];
  for (let number = first.number; number <= last.number; number++) {
    const line = state.doc.line(number);
    if (first.number !== last.number && data.excluded.overlaps(line)) continue;
    const content = contentLine(state, number, data.tree);
    const part = trimmed(state, { from: Math.max(range.from, content.from), to: Math.min(range.to, content.to) });
    if (part.from < part.to) parts.push(part);
  }
  return parts;
}
function formatted(state: EditorState, range: SelectionRange, kind: Kind, data: ReturnType<typeof inspect>): boolean {
  const index = data.byKind.get(kind)!;
  if (range.empty) return index.inside(range.from);
  const parts = selectionParts(state, range, data);
  return parts.length > 0 && parts.every(part => index.covers(part));
}
function uniqueRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter(range => range.from < range.to).sort((a, b) => a.from - b.from || a.to - b.to), result: Range[] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else result.push({ ...range });
  }
  return result;
}
function removeMarkers(state: EditorState, spans: Span[]): ChangeSet {
  return state.changes(uniqueRanges(spans.flatMap(span => [{ from: span.from, to: span.contentFrom }, { from: span.contentTo, to: span.to }])));
}
function applyWrappers(state: EditorState, removed: ChangeSet, targets: (Range & { prefix: string; suffix: string })[]): ChangeSet {
  const seen = new Set<string>(), additions: ChangeSpec[] = [];
  for (const target of targets) {
    const from = removed.mapPos(target.from), to = removed.mapPos(target.to), key = `${from}:${to}:${target.prefix}`;
    if (seen.has(key)) continue; seen.add(key);
    if (from === to) additions.push({ from, insert: target.prefix + target.suffix });
    else additions.push({ from, insert: target.prefix }, { from: to, insert: target.suffix });
  }
  return removed.compose(ChangeSet.of(additions, removed.newLength));
}
function selectionAfter(range: SelectionRange, changes: ChangeSet, from = range.from, to = range.to): SelectionRange {
  const a = changes.mapPos(from, 1), b = from === to ? a : changes.mapPos(to, -1);
  return EditorSelection.range(range.anchor <= range.head ? a : b, range.anchor <= range.head ? b : a);
}
function available(view: EditorView): boolean { return view.dom.isConnected && !view.state.readOnly; }

function selectionState(view: EditorView, options: FormatMenuOptions): SelectionContext | null {
  const state = view.state;
  if (!options.ranges) return { state, tree: syntaxTree(state) };
  const ranges = options.ranges();
  if (!ranges.length || ranges.some(range => !Number.isInteger(range.from) || !Number.isInteger(range.to)
    || range.from < 0 || range.to < range.from || range.to > state.doc.length)) return null;
  // Compute source operations from cell ranges without a preliminary dispatch
  // that could clear the caller's rectangle or activate a nested cell editor.
  const selected = state.update({ selection: EditorSelection.create(ranges.map(range => EditorSelection.range(range.from, range.to))), filter: false }).state;
  // Standard Markdown wrappers also need a complete tree at the target. If a
  // bounded synchronous parse cannot reach it, decline instead of guessing.
  const tree = ensureSyntaxTree(selected, ranges.reduce((end, range) => Math.max(end, range.to), 0), 50);
  // ensureSyntaxTree advances the parser context, not this immutable state's
  // published tree. Keep its result with the selection for every inspection;
  // dispatching merely to publish it would disturb the caller's rectangle.
  return tree ? { state: selected, tree } : null;
}

function toggleFormat(view: EditorView, kind: Exclude<Kind, 'highlight'>, options: FormatMenuOptions): boolean {
  if (!available(view)) return false;
  const context = selectionState(view, options); if (!context) return false;
  const { state, tree } = context;
  const data = inspect(state, options.ranges ? state.selection.ranges : undefined, tree), marker = delimiters[kind];
  const commonRemove = formatted(state, state.selection.ranges[0], kind, data);
  const removals: Span[] = [], targets: (Range & { prefix: string; suffix: string })[] = [];
  const selected: { from: number; to: number; skip?: number; emptyInsert?: number }[] = [];
  for (const range of state.selection.ranges) {
    if (options.ranges && range.empty) { selected.push({ from: range.from, to: range.to }); continue; }
    const removing = kind === 'comment' ? formatted(state, range, kind, data) : commonRemove;
    let bounds = kind === 'comment' ? { from: range.from, to: range.to } : trimmed(state, range);
    const enclosing = data.spans.find(span => span.kind === kind && span.from <= bounds.from && bounds.from <= span.to);
    if (removing) {
      if (range.empty && kind !== 'comment' && enclosing?.contentTo === range.from) {
        selected.push({ from: range.from, to: range.to, skip: enclosing.to }); continue;
      }
      removals.push(...data.spans.filter(span => span.kind === kind && (range.empty
        ? span.from <= range.from && range.from <= span.to : overlaps(span, bounds))));
    } else {
      if (range.empty) bounds = state.wordAt(range.from) ?? bounds;
      for (const span of data.spans.filter(span => span.kind === kind)) {
        if (span.from < bounds.from && bounds.from < span.to) bounds.from = span.from;
        if (span.from < bounds.to && bounds.to < span.to) bounds.to = span.to;
      }
      const parts = kind === 'comment' || range.empty ? [bounds] : selectionParts(state, bounds, data);
      for (const part of parts) {
        removals.push(...data.spans.filter(span => span.kind === kind && overlaps(span, part)));
        targets.push({ ...part, prefix: marker, suffix: marker });
      }
    }
    const select = kind === 'comment' && range.empty && !removing ? bounds : kind === 'comment' ? range : trimmed(state, range);
    selected.push({ from: select.from, to: select.to,
      ...(!removing && range.empty && bounds.from === bounds.to ? { emptyInsert: marker.length } : {}) });
  }
  const changes = applyWrappers(state, removeMarkers(state, removals), targets);
  const ranges = state.selection.ranges.map((range, index) => {
    const plan = selected[index];
    if (plan.skip !== undefined) return EditorSelection.cursor(changes.mapPos(plan.skip));
    if (plan.emptyInsert !== undefined) return EditorSelection.cursor(changes.mapPos(plan.from, -1) + plan.emptyInsert);
    return selectionAfter(range, changes, plan.from, plan.to);
  });
  view.dispatch({ changes, selection: EditorSelection.create(ranges, state.selection.mainIndex), ...(kind === 'comment' ? {} : { userEvent: 'input.type' }), annotations: options.annotations });
  return true;
}

function toggleHighlight(view: EditorView, color: string, options: FormatMenuOptions): boolean {
  if (!available(view)) return false;
  const context = selectionState(view, options); if (!context) return false;
  const { state, tree } = context;
  const data = inspect(state, options.ranges ? state.selection.ranges : undefined, tree), highlights = data.spans.filter(span => span.kind === 'highlight');
  const targets: Range[] = [];
  for (const range of state.selection.ranges) {
    if (options.ranges && range.empty) continue;
    if (range.empty) {
      const current = highlights.find(span => span.from <= range.from && range.from <= span.to);
      targets.push(current ?? state.wordAt(range.from) ?? range);
    } else targets.push(...selectionParts(state, trimmed(state, range), data));
  }
  if (!targets.length) return false;
  const affected = highlights.filter(span => targets.some(target => overlaps(span, target)));
  const remove = affected.length > 0 && affected.every(span => span.color === color)
    && targets.every(target => {
      let end = target.from;
      for (const span of affected.sort((a, b) => a.from - b.from)) if (span.from <= end) end = Math.max(end, span.to);
      return end > target.from && end >= target.to;
    });
  const removed = removeMarkers(state, affected);
  let changes = removed;
  if (!remove) {
    const clean = removed.apply(state.doc);
    let segments = affected.map(span => ({ from: removed.mapPos(span.contentFrom), to: removed.mapPos(span.contentTo), color: span.color ?? '' }));
    for (const target of targets) {
      const overlay = { from: removed.mapPos(target.from), to: removed.mapPos(target.to), color };
      const next: typeof segments = [];
      for (const segment of segments) {
        if (!overlaps(segment, overlay)) { next.push(segment); continue; }
        if (segment.from < overlay.from) {
          let to = overlay.from;
          if (segment.color !== color) while (to > segment.from && /\s/.test(clean.sliceString(to - 1, to))) to--;
          if (to > segment.from) next.push({ ...segment, to });
        }
        if (segment.to > overlay.to) {
          let from = overlay.to;
          if (segment.color !== color) while (from < segment.to && /\s/.test(clean.sliceString(from, from + 1))) from++;
          if (from < segment.to) next.push({ ...segment, from });
        }
      }
      next.push(overlay); segments = next;
    }
    segments.sort((a, b) => a.from - b.from);
    const merged: typeof segments = [];
    for (const segment of segments) {
      const last = merged.at(-1);
      if (last && segment.color === last.color && segment.from <= last.to) last.to = Math.max(last.to, segment.to);
      else merged.push({ ...segment });
    }
    const additions: ChangeSpec[] = [];
    for (const segment of merged) {
      const alias = affected.find(span => span.color === segment.color)?.colorMarker;
      const prefix = '==' + (segment.color ? alias || colors[segment.color] : '');
      additions.push({ from: segment.from, insert: prefix }, { from: segment.to, insert: '==' });
    }
    changes = removed.compose(ChangeSet.of(additions, removed.newLength));
  }
  const singleEmpty = !affected.length && targets.length === 1 && targets[0].from === targets[0].to;
  view.dispatch({ changes, ...(singleEmpty ? { selection: { anchor: targets[0].from + 2 + (colors[color]?.length ?? 0) } } : {}), userEvent: 'input.type', annotations: options.annotations });
  view.focus(); return true;
}
function insertLink(view: EditorView, external: boolean, options: FormatMenuOptions): boolean {
  if (!available(view)) return false;
  const state = selectionState(view, options)?.state;
  if (!state || /\n/.test(state.sliceDoc(state.selection.main.from, state.selection.main.to).trim())) return false;
  view.dispatch({ ...state.changeByRange(range => {
    const selected = state.sliceDoc(range.from, range.to);
    const insert = external ? `[${selected}]()` : `[[${selected}]]`;
    const offset = external ? range.empty ? 1 : selected.length + 3 : selected.length + 2;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + offset) };
  }), userEvent: 'input.autocomplete', annotations: options.annotations });
  return true;
}
function clearFormatting(view: EditorView, options: FormatMenuOptions): boolean {
  if (!available(view)) return false;
  const context = selectionState(view, options); if (!context) return false;
  const { state, tree } = context;
  const data = inspect(state, options.ranges ? state.selection.ranges : undefined, tree);
  const markers = data.markers.filter(marker => state.selection.ranges.some(range => !range.empty && marker.from <= range.to && marker.to >= range.from));
  view.dispatch({ changes: uniqueRanges(markers), annotations: options.annotations });
  return true;
}

/** Local action closures dispatch against the current owning editor. The caller
 * serializes only descriptors, and revalidates menu ownership after dismissal. */
export function formatMenuForEditor(view: EditorView, options: FormatMenuOptions = {}): FormatMenuItem[] {
  const selectedState = selectionState(view, options), state = selectedState?.state ?? view.state;
  const tree = selectedState?.tree ?? syntaxTree(state);
  const data = inspect(state, options.ranges ? state.selection.ranges : undefined, tree), selection = state.selection.main, enabled = Boolean(selectedState) && !state.readOnly;
  const action = (id: string, label: string, run: () => boolean, checked?: boolean): FormatMenuItem => ({ id, label, enabled, ...(checked === undefined ? {} : { checked }), run });
  const format = (kind: Exclude<Kind, 'highlight'>, label: string) => action(`format-${kind}`, label, () => toggleFormat(view, kind, options), formatted(state, selection, kind, data));
  const current = data.spans.find(span => span.kind === 'highlight' && span.from <= selection.head && span.to >= selection.head);
  const highlighted = formatted(state, selection, 'highlight', data);
  const linksEnabled = enabled && !/\n/.test(state.sliceDoc(selection.from, selection.to).trim());
  const items: FormatMenuItem[] = [
    { id: 'insert-link', label: 'Add link', enabled: linksEnabled, run: () => insertLink(view, false, options) },
    { id: 'insert-external-link', label: 'Add external link', enabled: linksEnabled, run: () => insertLink(view, true, options) },
    { type: 'separator' },
    { id: 'format', label: 'Format', enabled, submenu: [
      format('bold', 'Bold'), format('italic', 'Italic'), format('strikethrough', 'Strikethrough'),
      { id: 'format-highlight', label: 'Highlight', enabled, submenu: ['', ...Object.keys(colors)].map(color =>
        action(`format-highlight-${color || 'default'}`, color ? color[0].toUpperCase() + color.slice(1) : 'Default', () => toggleHighlight(view, color, options), highlighted && (current?.color ?? '') === color)) },
      { type: 'separator' }, format('code', 'Code'), format('math', 'Math'), format('comment', 'Comment'),
      { type: 'separator' }, action('format-clear', 'Clear formatting', () => clearFormatting(view, options)),
    ] },
  ];
  if (options.inTableCell) {
    const disabled = (id: string, label: string, checked?: boolean): FormatMenuItem => ({ id, label, enabled: false, ...(checked === undefined ? {} : { checked }), run: () => false });
    items.push({ id: 'paragraph', label: 'Paragraph', enabled: false, submenu: [
      disabled('paragraph-bullet', 'Bullet list'), disabled('paragraph-number', 'Numbered list'), disabled('paragraph-task', 'Task list'),
      { type: 'separator' }, ...[1, 2, 3, 4, 5, 6].map(level => disabled(`paragraph-heading-${level}`, `Heading ${level}`, false)),
      disabled('paragraph-body', 'Body', true), { type: 'separator' }, disabled('paragraph-quote', 'Quote'),
    ] });
  }
  const insertionOptions = { inTableCell: options.inTableCell, rectangle: !!options.ranges };
  const insertions: FormatMenuItem[] = INSERTION_COMMANDS.map(command => ({
    id: command.id === 'editor-insert-link' ? 'insert-markdown-link' : command.id.replace('editor-', ''), label: command.label,
    enabled: !view.composing && !view.compositionStarted && canInsert(view.state, command.id, insertionOptions),
    run: () => runInsertion(view, command.id, insertionOptions),
  }));
  items.push({ id: 'insert', label: 'Insert', enabled: insertions.some(item => 'enabled' in item && item.enabled), submenu: insertions });
  return items;
}
