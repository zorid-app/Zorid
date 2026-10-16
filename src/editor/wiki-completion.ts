import { Forward } from 'lucide';
import { EditorSelection, Prec, Transaction } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { autocompletion, closeCompletion, completionStatus, currentCompletions, moveCompletionSelection, pickedCompletion, selectedCompletion, setSelectedCompletion, startCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

export interface WikiFileMetadata {
  aliases?: readonly string[];
  headings?: readonly { heading: string; level: number }[];
  /** Existing IDs only. Creating block IDs requires a separate host transaction. */
  blocks?: readonly { id: string; text: string }[];
  mtime?: number;
  ignored?: boolean;
}
export interface WikiCompletionOptions {
  /** Supported file paths in stable vault order, including attachments if desired. */
  paths: () => readonly string[];
  sourcePath?: () => string | null;
  metadata?: (path: string) => WikiFileMetadata | undefined;
  resolvePath?: (target: string, source: string) => string | null;
  linkText?: (path: string, source: string) => string;
  unresolvedPaths?: () => readonly string[];
}
type Mode = 'file' | 'heading' | 'block' | 'display';
type Kind = Mode | 'alias' | 'unresolved' | 'none';
type AcceptKey = 'Enter' | 'Tab' | '#' | '^' | 'raw';
interface WikiOption extends Completion {
  wiki: { kind: Kind; mode: Mode; target: string; alias?: string; note: string; flair?: string; score: number; matches: number[]; noteMatches?: number[]; placeholder?: boolean; ignored?: boolean };
}
interface WikiContext { from: number; to: number; query: string }
const withoutMd = (path: string) => path.replace(/\.md$/i, '');
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const imagePath = (path: string) => /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|heic)$/i.test(path);
const normalizeHeading = (heading: string) => heading.replace(/[:#|^\\\r\n]|%%|\[\[|\]\]/g, ' ').replace(/\s+/g, ' ').trim();

function contextAt(state: EditorState, pos = state.selection.main.head): WikiContext | null {
  if (!state.selection.main.empty || state.selection.ranges.length !== 1) return null;
  const line = state.doc.lineAt(pos), before = line.text.slice(0, pos - line.from);
  const open = before.lastIndexOf('[[');
  if (open < 0 || before.lastIndexOf(']') > open) return null;
  // A background parse may not yet cover a late-document caret. Spend bounded
  // work reaching this line and decline until syntax can be established.
  const tree = ensureSyntaxTree(state, line.to, 20);
  if (!tree) return null;
  for (let node = tree.resolveInner(pos, -1); node; node = node.parent!) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Comment', 'LiveInlineComment'].includes(node.name)) return null;
  }
  const query = before.slice(open + 2);
  if (query.includes('|') && imagePath(query.split('|')[0].split('#')[0])) return null;
  return { from: line.from + open + 2, to: pos, query };
}

/** Original bounded fuzzy matcher. Exact proprietary scores are not reproduced. */
function match(query: string, label: string): { score: number; matches: number[] } | null {
  const needle = query.toLowerCase(), haystack = label.toLowerCase();
  // Lowercasing can expand a source character (İ -> i + combining dot).
  // Scores use the folded string, but render spans must index original UTF-16.
  const sourceMatches = (spans: number[]): number[] => {
    if (haystack.length === label.length) return spans;
    const starts: number[] = [], ends: number[] = [];
    let offset = 0;
    for (const character of label) {
      for (let unit = 0; unit < character.toLowerCase().length; unit++) { starts.push(offset); ends.push(offset + character.length); }
      offset += character.length;
    }
    const mapped: number[] = [];
    for (let index = 0; index < spans.length; index += 2) {
      const from = starts[spans[index]], to = ends[spans[index + 1] - 1];
      if (mapped.length && from <= mapped[mapped.length - 1]) mapped[mapped.length - 1] = Math.max(to, mapped[mapped.length - 1]);
      else mapped.push(from, to);
    }
    return mapped;
  };
  if (!needle) return { score: 0, matches: [] };
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return { score: (haystack === needle ? 100 : 80) - contiguous / 100 - label.length / 1000, matches: sourceMatches([contiguous, contiguous + needle.length]) };
  const matches: number[] = [];
  let cursor = 0, gap = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return null;
    gap += found - cursor;
    if (matches.length && matches[matches.length - 1] === found) matches[matches.length - 1] = found + character.length;
    else matches.push(found, found + character.length);
    cursor = found + character.length;
  }
  return { score: 40 - gap / 100 - label.length / 1000, matches: sourceMatches(matches) };
}
function resolve(options: WikiCompletionOptions, target: string, paths: readonly string[]): string | null {
  const source = options.sourcePath?.() ?? '';
  if (options.resolvePath) return options.resolvePath(target, source);
  if (!target) return paths.includes(source) ? source : null;
  const normalized = withoutMd(target).toLowerCase();
  return paths.find(path => withoutMd(path).toLowerCase() === normalized)
    ?? paths.find(path => withoutMd(basename(path)).toLowerCase() === normalized) ?? null;
}
function link(options: WikiCompletionOptions, path: string, nameCounts: ReadonlyMap<string, number>): string {
  if (options.linkText) return options.linkText(path, options.sourcePath?.() ?? '');
  const name = basename(path);
  return withoutMd(nameCounts.get(name.toLowerCase()) === 1 ? name : path);
}
function isWiki(completion: Completion | null): completion is WikiOption { return !!completion && 'wiki' in completion; }

function apply(view: EditorView, option: WikiOption, key: AcceptKey): boolean {
  if (view.state.readOnly || view.composing) return false;
  const context = contextAt(view.state);
  if (!context) return false;
  const { wiki } = option;
  let target = key === 'raw' || wiki.kind === 'none' ? context.query : wiki.target;
  let alias = key === 'raw' || wiki.kind === 'none' ? undefined : wiki.alias;
  const suffix = view.state.doc.sliceString(context.to, view.state.doc.lineAt(context.to).to);
  // Only the current same-line closing pair belongs to this replacement. An
  // explicit suffix alias wins over generated basename/metadata aliases, even
  // when untyped destination characters remain between the caret and the pipe.
  const closing = suffix.indexOf(']]');
  let end = context.to;
  if (closing >= 0) {
    const remainder = suffix.slice(0, closing);
    if (!remainder.includes('[[')) {
      end += closing + 2;
      if (!context.query.includes('|')) {
        const pipe = remainder.indexOf('|');
        if (pipe >= 0) alias = remainder.slice(pipe + 1);
      }
    }
  }
  if (key === '#') target += /\.pdf$/i.test(target) ? '#page=' : '#';
  if (key === '^') target += '^';
  const hasAlias = alias !== undefined;
  const text = `[[${target}${hasAlias ? `|${alias}` : ''}]]`;
  const start = context.from - 2, innerEnd = start + text.length - 2;
  let anchor = start + text.length, head = anchor;
  if (key === 'Tab') { anchor = alias !== undefined ? innerEnd - alias.length : innerEnd; head = innerEnd; }
  else if (key === '#' || key === '^') anchor = head = alias !== undefined ? innerEnd - alias.length - 1 : innerEnd;
  closeCompletion(view);
  view.dispatch({ changes: { from: start, to: end, insert: text }, selection: EditorSelection.single(anchor, head),
    annotations: [pickedCompletion.of(option), Transaction.userEvent.of('input.complete')], scrollIntoView: true });
  view.focus();
  if (key === '#' || key === '^') startCompletion(view);
  return true;
}

export function wikiCompletionSource(options: WikiCompletionOptions): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const found = contextAt(context.state, context.pos);
    if (!found) return null;
    const paths = options.paths(), raw = found.query.trim(), results: WikiOption[] = [];
    const nameCounts = new Map<string, number>();
    for (const path of paths) { const name = basename(path).toLowerCase(); nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1); }
    let mode: Mode = 'file';
    const add = (label: string, kind: Kind, target: string, note: string, score: number, matches: number[], alias?: string, flair?: string, ignored?: boolean, presentation: { noteMatches?: number[]; placeholder?: boolean } = {}) => {
      const option: WikiOption = { label, wiki: { kind, mode, target, note, score, matches, alias, flair, ignored, ...presentation } };
      option.apply = view => { apply(view, option, 'Enter'); };
      results.push(option);
    };
    const pipe = raw.indexOf('|');
    if (pipe >= 0) {
      mode = 'display';
      const target = raw.slice(0, pipe), query = raw.slice(pipe + 1), hash = target.indexOf('#');
      const path = resolve(options, hash < 0 ? target : target.slice(0, hash), paths);
      for (const alias of path ? options.metadata?.(path)?.aliases ?? [] : []) {
        const matched = match(query, alias);
        if (matched) add(alias, 'alias', link(options, path!, nameCounts) + (hash < 0 ? '' : target.slice(hash)), target, matched.score, matched.matches, alias, '↪');
      }
      if (!results.length) add(query || 'Display text', 'alias', target, target, 0, [], query, '↪', undefined, { placeholder: !query });
    } else if (raw.includes('#') || raw.includes('^')) {
      const globalHeading = raw.startsWith('##'), globalBlock = raw.startsWith('^^');
      const hash = raw.indexOf('#'), caret = raw.indexOf('^'), block = globalBlock || caret >= 0 && (hash < 0 || raw[hash + 1] === '^');
      mode = block ? 'block' : 'heading';
      const global = globalHeading || globalBlock;
      const split = hash >= 0 ? hash : caret;
      const target = global ? '' : raw.slice(0, split), query = global ? raw.slice(2) : raw.slice(split + (block && hash >= 0 ? 2 : 1));
      const resolved = global ? null : resolve(options, target, paths);
      const candidates = global ? paths : resolved ? [resolved] : [];
      for (const path of candidates) {
        const metadata = options.metadata?.(path);
        if (global && metadata?.ignored || !/\.md$/i.test(path)) continue;
        const destination = global ? path === options.sourcePath?.() ? '' : link(options, path, nameCounts) : target;
        if (block) {
          for (const item of metadata?.blocks ?? []) {
            const matched = match(query, item.text), idMatch = match(query, item.id);
            if (matched || idMatch) add(item.text, 'block', `${destination}#^${item.id}`, global ? `${withoutMd(path)} > ${item.id}` : item.id, idMatch ? 100 : matched!.score, matched?.matches ?? [], undefined);
          }
        } else {
          const segments = query.split('#'), needle = segments.pop() ?? '';
          let parent = 0, level = 0;
          for (const item of metadata?.headings ?? []) {
            if (level && item.level <= level) break;
            if (parent < segments.length) {
              if (item.heading.toLowerCase() === segments[parent].toLowerCase()) { parent++; level = item.level; }
              continue;
            }
            const matched = match(needle, item.heading);
            if (matched) add(item.heading, 'heading', `${destination}#${[...segments, normalizeHeading(item.heading)].join('#')}`, global ? withoutMd(path) : '', matched.score, matched.matches, undefined, `H${item.level}`);
          }
        }
      }
      if (!results.length && !global && !block && resolved) add(query || 'Heading', 'heading', raw, '', 0, [], undefined, undefined, undefined, { placeholder: !query });
    } else {
      for (const path of paths) {
        const metadata = options.metadata?.(path), ignored = metadata?.ignored;
        if (!raw && ignored) continue;
        const displayPath = withoutMd(path), name = basename(displayPath), folder = displayPath.slice(0, displayPath.length - name.length);
        const matchedName = match(raw, name), matchedPath = matchedName ? null : match(raw, displayPath);
        const target = link(options, path, nameCounts), alias = target.includes('/') && !imagePath(path) ? withoutMd(basename(path)) : undefined;
        const matched = matchedName ?? matchedPath;
        if (matched) add(name, 'file', target, folder, raw ? matched.score - (matchedPath ? 1 : 0) - (ignored ? 10 : 0) : metadata?.mtime ?? 0,
          matchedName?.matches ?? clipMatches(matchedPath?.matches ?? [], folder.length, displayPath.length), alias, undefined, ignored,
          { noteMatches: clipMatches(matchedPath?.matches ?? [], 0, folder.length) });
        for (const alias of metadata?.aliases ?? []) {
          const matched = match(raw, alias);
          if (matched) add(alias, 'alias', target, displayPath, raw ? matched.score - (ignored ? 10 : 0) : metadata?.mtime ?? 0, matched.matches, alias, '↪', ignored);
        }
      }
      const known = new Set(paths.map(withoutMd));
      for (const path of options.unresolvedPaths?.() ?? []) {
        if (known.has(path)) continue;
        known.add(path);
        const matched = match(raw, path);
        if (matched) add(path, 'unresolved', path, '', matched.score, matched.matches);
      }
    }
    if (!results.length) add('No match found', 'none', raw, '', 0, []);
    results.sort((a, b) => b.wiki.score - a.wiki.score);
    return { from: found.from, to: context.pos, options: results.slice(0, 100), filter: false, getMatch: completion => isWiki(completion) ? completion.wiki.matches : [] };
  };
}

/** Project UTF-16 match spans into a displayed title or folder without splitting
 * the source/insertion identity of a completion. */
function clipMatches(matches: readonly number[], from: number, to: number): number[] {
  const clipped: number[] = [];
  for (let index = 0; index < matches.length; index += 2) {
    const start = Math.max(from, matches[index]), end = Math.min(to, matches[index + 1]);
    if (start < end) clipped.push(start - from, end - from);
  }
  return clipped;
}
function appendHighlighted(element: HTMLElement, text: string, matches: readonly number[]) {
  let offset = 0;
  for (let index = 0; index < matches.length; index += 2) {
    const from = Math.max(offset, matches[index]), to = Math.min(text.length, matches[index + 1]);
    if (from >= to) continue;
    element.append(element.ownerDocument.createTextNode(text.slice(offset, from)));
    const highlight = element.ownerDocument.createElement('strong');
    highlight.textContent = text.slice(from, to); element.append(highlight); offset = to;
  }
  element.append(element.ownerDocument.createTextNode(text.slice(offset)));
}
function renderRow(completion: Completion, _state: EditorState, view: EditorView): Node | null {
  if (!isWiki(completion)) return null;
  const doc = view.dom.ownerDocument, row = doc.createElement('span'), content = doc.createElement('span'), title = doc.createElement('span');
  row.className = 'wiki-suggestion-row'; content.className = 'wiki-suggestion-content'; title.className = 'wiki-suggestion-title';
  if (completion.wiki.placeholder) title.classList.add('wiki-suggestion-placeholder');
  appendHighlighted(title, completion.label, completion.wiki.matches); content.append(title);
  if (completion.wiki.note) {
    const note = doc.createElement('span'); note.className = 'wiki-suggestion-note';
    appendHighlighted(note, completion.wiki.note, completion.wiki.noteMatches ?? []); content.append(note);
  }
  row.append(content);
  if (completion.wiki.flair) {
    const aux = doc.createElement('span'), flair = doc.createElement('span');
    aux.className = 'wiki-suggestion-aux'; flair.className = 'wiki-suggestion-flair';
    if (completion.wiki.kind === 'alias') {
      flair.setAttribute('aria-label', 'Alias'); flair.title = 'Alias';
      // Licensed project icon data, created in the editor's own document.
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor',
        'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
      for (const [tag, attributes] of Forward) {
        const child = doc.createElementNS(svg.namespaceURI, tag);
        for (const [key, value] of Object.entries(attributes)) if (value !== undefined) child.setAttribute(key, String(value));
        svg.append(child);
      }
      flair.append(svg);
    } else flair.textContent = completion.wiki.flair;
    aux.append(flair); row.append(aux);
  }
  return row;
}

/** Install instead of the generic autocompletion extension. Import its CSS separately. */
export function wikiCompletion(options: WikiCompletionOptions): Extension {
  const choose = (key: AcceptKey, allowUnselected = false) => (view: EditorView) => {
    if (completionStatus(view.state) !== 'active' || view.composing) return false;
    let option = selectedCompletion(view.state);
    if (key === 'raw') option = currentCompletions(view.state)[0] ?? null;
    if (!isWiki(option)) return allowUnselected;
    if (key === '#' && option.wiki.mode !== 'file' && option.wiki.mode !== 'heading' || key === '^' && option.wiki.mode !== 'file') return false;
    return apply(view, option, key);
  };
  const end = (last: boolean) => (view: EditorView) => {
    if (completionStatus(view.state) !== 'active' || view.composing) return false;
    view.dispatch({ effects: setSelectedCompletion(last ? currentCompletions(view.state).length - 1 : 0) }); return true;
  };
  return [autocompletion({ override: [wikiCompletionSource(options)], defaultKeymap: false, selectOnOpen: false,
    icons: false, maxRenderedOptions: 100, activateOnTypingDelay: 0, interactionDelay: 0,
    tooltipClass: () => 'cm-wiki-completion', optionClass: completion => isWiki(completion) && completion.wiki.ignored ? 'wiki-suggestion-downranked' : '',
    addToOptions: [{ position: 40, render: renderRow }] }),
    Prec.highest(keymap.of([
      { key: 'ArrowDown', run: moveCompletionSelection(true) }, { key: 'ArrowUp', run: moveCompletionSelection(false) },
      { key: 'Ctrl-n', run: moveCompletionSelection(true) }, { key: 'Ctrl-p', run: moveCompletionSelection(false) },
      { key: 'PageDown', run: moveCompletionSelection(true, 'page') }, { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
      { key: 'Home', run: end(false) }, { key: 'End', run: end(true) },
      { key: 'Enter', run: choose('Enter', true) }, { key: 'Shift-Enter', run: choose('raw') }, { key: 'Tab', run: choose('Tab') },
      { key: '#', run: choose('#') }, { key: '^', run: choose('^') }, { key: 'Escape', run: closeCompletion },
    ])),
    ViewPlugin.fromClass(class {
      private destroyed = false;
      private first: Completion | undefined;
      private queued = false;
      private view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        view.dom.addEventListener('mousedown', this.mouseDown, true);
        view.dom.addEventListener('mousemove', this.mouseMove, true);
        view.dom.addEventListener('click', this.click, true);
        view.dom.addEventListener('auxclick', this.click, true);
        this.schedule();
      }
      private row(event: MouseEvent): number | null {
        const target = event.target as Element | null;
        const row = target?.closest?.('.cm-wiki-completion [role="option"]');
        return row ? Number(row.id.match(/-(\d+)$/)?.[1] ?? -1) : null;
      }
      private mouseDown = (event: MouseEvent) => { if (this.row(event) !== null) { event.preventDefault(); event.stopPropagation(); } };
      private mouseMove = (event: MouseEvent) => { const index = this.row(event); if (index !== null && index >= 0) this.view.dispatch({ effects: setSelectedCompletion(index) }); };
      private click = (event: MouseEvent) => {
        const index = this.row(event); if (index === null) return;
        const option = currentCompletions(this.view.state)[index];
        if (isWiki(option)) { event.preventDefault(); event.stopPropagation(); apply(this.view, option, 'Enter'); }
      };
      update() { this.schedule(); }
      private schedule() {
        if (this.queued) return; this.queued = true;
        queueMicrotask(() => {
          this.queued = false; if (this.destroyed) return;
          const all = currentCompletions(this.view.state), first = all[0];
          if (first !== this.first) {
            this.first = first;
            const query = contextAt(this.view.state)?.query;
            if (first && query !== undefined) this.view.dispatch({ effects: setSelectedCompletion(['', '#', '^'].includes(query) ? -1 : 0) });
          }
          const popup = this.view.dom.querySelector<HTMLElement>('.cm-wiki-completion');
          if (!popup || !isWiki(first ?? null)) return;
          let footer = popup.querySelector<HTMLElement>('.wiki-suggestion-instructions');
          if (!footer) { footer = this.view.dom.ownerDocument.createElement('div'); footer.className = 'wiki-suggestion-instructions'; popup.append(footer); }
          const mode = (first as WikiOption).wiki.mode;
          if (footer.dataset.mode !== mode) {
            footer.dataset.mode = mode; footer.replaceChildren();
            const instructions = mode === 'file' ? [['Type #', 'to link heading'], ['Type ^', 'to link blocks'], ['Type |', 'to change display text']] : [['↵', 'to accept']];
            for (const [key, purpose] of instructions) {
              const item = footer.ownerDocument.createElement('span'), command = footer.ownerDocument.createElement('b');
              command.textContent = key; item.append(command, footer.ownerDocument.createTextNode(purpose)); footer.append(item);
            }
          }
        });
      }
      destroy() {
        this.destroyed = true;
        this.view.dom.removeEventListener('mousedown', this.mouseDown, true); this.view.dom.removeEventListener('mousemove', this.mouseMove, true);
        this.view.dom.removeEventListener('click', this.click, true); this.view.dom.removeEventListener('auxclick', this.click, true);
      }
    }),
  ];
}
