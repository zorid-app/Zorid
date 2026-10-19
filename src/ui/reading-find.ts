import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { icon } from './icons.ts';

export interface ReadingFind {
  open(): void;
  refresh(): void;
  close(): void;
  destroy(): void;
}
interface Segment { node: Text; from: number; to: number }
interface Match { from: number; to: number }
interface Projection { state: EditorState; segments: Segment[] }
const nodeLimit = 250_000, projectionLimit = 16 * 1024 * 1024 + nodeLimit, countSourceLimit = 256 * 1024, countLimit = 10_000;
const excluded = 'script,style,noscript,template,button,input,textarea,select,option,svg,canvas,iframe,object,embed,[hidden],[aria-hidden="true"],[contenteditable="true"],.internal-embed,.cm-editor';
const blocks = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TBODY|TD|TH|THEAD|TR|UL)$/;
let sequence = 0;

/** Coordinates belong only to the current rendered text, never Markdown source.
 * Work is bounded before any query: complete projections only, no regex search
 * over a truncated document. The text ceiling includes a structural-separator
 * allowance above the supported 16MiB source size. Inline nodes retain continuity; block boundaries
 * and excluded subtrees separate text. No rendered node is wrapped or replaced. */
async function project(root: HTMLElement, current: () => boolean): Promise<Projection | undefined> {
  const segments: Segment[] = [], chunks: string[] = [];
  let length = 0, visited = 0, lastBreak = true;
  const addBreak = () => { if (!lastBreak) { chunks.push('\n'); length++; lastBreak = true; } };
  // Queue siblings one at a time: a very wide parent must not allocate an
  // unbounded child array before the node/work budget can be checked.
  const stack: { node: Node; exit?: boolean; siblings?: boolean }[] = [{ node: root }];
  while (stack.length) {
    if (!current()) return;
    const { node, exit, siblings } = stack.pop()!;
    if (exit) { addBreak(); continue; }
    if (++visited > nodeLimit || length > projectionLimit) return;
    if (visited % 2048 === 0) {
      await new Promise<void>(resolve => root.ownerDocument.defaultView!.setTimeout(resolve, 0));
      if (!current()) return;
    }
    if (siblings && node.nextSibling) stack.push({ node: node.nextSibling, siblings: true });
    const parent = node.parentElement;
    if (parent?.tagName === 'DETAILS' && !parent.hasAttribute('open') && (node.nodeType !== 1 || (node as Element).tagName !== 'SUMMARY')) continue;
    if (node.nodeType === 3) {
      const text = node as Text;
      if (text.length > projectionLimit - length) return;
      if (text.length) { segments.push({ node: text, from: length, to: length + text.length }); chunks.push(text.data); length += text.length; lastBreak = text.data.endsWith('\n'); }
    } else if (node.nodeType === 1) {
      const element = node as HTMLElement;
      if (element !== root && (element.matches(excluded) || element.style.display === 'none' || element.style.visibility === 'hidden')) { addBreak(); continue; }
      const block = blocks.test(element.tagName);
      if (block || element.tagName === 'BR') addBreak();
      if (block) stack.push({ node, exit: true });
      if (element.firstChild) stack.push({ node: element.firstChild, siblings: true });
    }
  }
  if (length > projectionLimit || !current()) return;
  return { state: EditorState.create({ doc: chunks.join('') }), segments };
}

export function createReadingFind(host: HTMLElement, preview: HTMLElement, options: {
  isCurrent(): boolean;
  returnFocus(): void;
}): ReadingFind {
  const doc = preview.ownerDocument, win = doc.defaultView!;
  const id = ++sequence, baseName = `zorid-reading-find-${id}`, activeName = `${baseName}-active`;
  const registry = win.CSS?.highlights;
  const HighlightClass = (win as Window & typeof globalThis).Highlight;
  const supported = !!registry && typeof HighlightClass === 'function';
  const dom = doc.createElement('div'); dom.className = 'cm-search zorid-find-panel zorid-reading-find'; dom.hidden = true;
  dom.setAttribute('role', 'search'); dom.setAttribute('aria-label', 'Find in note');
  const row = doc.createElement('div'); row.className = 'zorid-find-row';
  const wrap = doc.createElement('div'); wrap.className = 'zorid-find-field';
  const field = doc.createElement('input'); field.type = 'text'; field.name = 'search'; field.placeholder = 'Find in note…';
  field.autocomplete = 'off'; field.spellcheck = false; field.setAttribute('aria-label', 'Find in note');
  const count = doc.createElement('span'); count.className = 'zorid-find-count'; count.id = `zorid-reading-count-${id}`;
  count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite'); field.setAttribute('aria-describedby', count.id);
  wrap.append(icon('search', 16, doc), field, count);
  let disposed = false, opened = false, composing = false, projection: Projection | undefined;
  let returnSelection: { start: Node; from: number; end: Node; to: number } | undefined;
  let query = new SearchQuery({ search: '', literal: true }), matches: Match[] = [], current: Match | undefined;
  let counted = true, limited = false, noMatch = false, projecting = false, failed = false, generation = 0, style: HTMLStyleElement | undefined;
  const button = (label: string, glyph: string, action: () => void) => {
    const node = doc.createElement('button'); node.type = 'button'; node.className = 'zorid-find-button';
    node.title = label; node.setAttribute('aria-label', label); node.append(icon(glyph, 16, doc));
    node.addEventListener('mousedown', event => { if (!event.button) event.preventDefault(); });
    node.addEventListener('click', () => { if (live() && !composing) action(); }); return node;
  };
  const previous = button('Previous match', 'down', () => navigate(-1)); previous.classList.add('zorid-find-previous');
  const next = button('Next match', 'down', () => navigate(1));
  const controls = doc.createElement('div'); controls.className = 'zorid-find-options'; controls.hidden = true; controls.id = `zorid-reading-options-${id}`;
  const settings = button('Search options', 'settings', () => { controls.hidden = !controls.hidden; settings.setAttribute('aria-expanded', String(!controls.hidden)); });
  settings.setAttribute('aria-controls', controls.id); settings.setAttribute('aria-expanded', 'false');
  const closeButton = button('Close find', 'close', () => close());
  row.append(wrap, previous, next, settings, closeButton);
  const checkbox = (label: string, name: string) => {
    const wrapper = doc.createElement('label'), input = doc.createElement('input'); input.type = 'checkbox'; input.name = name;
    input.addEventListener('change', commit); wrapper.append(input, doc.createTextNode(label)); controls.append(wrapper); return input;
  };
  const matchCase = checkbox('Match case', 'case'), regexp = checkbox('Regular expression', 'regexp'), word = checkbox('Whole word', 'word');
  dom.append(row, controls); host.append(dom);
  const observer = new win.MutationObserver(() => { if (live()) refresh(); else clearHighlights(); });
  function live(): boolean { return !disposed && opened && options.isCurrent() && preview.isConnected; }
  function clearHighlights(): void { registry?.delete(baseName); registry?.delete(activeName); style?.remove(); style = undefined; }
  function ranges(match: Match): Range[] {
    if (!projection) return [];
    const result: Range[] = [], segments = projection.segments;
    let low = 0, high = segments.length;
    while (low < high) { const mid = (low + high) >>> 1; if (segments[mid].to <= match.from) low = mid + 1; else high = mid; }
    for (let i = low; i < segments.length && segments[i].from < match.to; i++) {
      const segment = segments[i];
      const range = doc.createRange(); range.setStart(segment.node, Math.max(0, match.from - segment.from)); range.setEnd(segment.node, Math.min(segment.node.length, match.to - segment.from)); result.push(range);
    }
    return result;
  }
  function paint(rebuild = true): void {
    if (rebuild) clearHighlights(); else registry?.delete(activeName);
    if (!live() || !supported || !query.valid || !projection) return;
    if (!style) {
      style = doc.createElement('style'); style.dataset.readingFind = String(id);
      style.textContent = `::highlight(${baseName}) { background-color: var(--text-highlight-bg, #ffe08a); color: var(--text-normal); } ::highlight(${activeName}) { background-color: var(--interactive-accent, #7358df); color: var(--text-on-accent, white); }`;
      doc.head.append(style);
    }
    if (rebuild) {
      const all = new HighlightClass();
      for (const match of matches) for (const range of ranges(match)) all.add(range);
      registry.set(baseName, all);
    }
    const active = new HighlightClass();
    if (current) for (const range of ranges(current)) active.add(range);
    active.priority = 1; registry.set(activeName, active);
  }
  function sync(): void {
    const empty = !query.search, invalid = !empty && !query.valid;
    const index = current ? matches.findIndex(match => match.from === current!.from && match.to === current!.to) : -1;
    const position = current ? index < 0 ? '—' : String(index + 1) : '0';
    const total = `${matches.length.toLocaleString('en-US')}${limited ? '+' : ''}`;
    const unavailable = !supported || !projection;
    const text = projecting ? 'Searching…' : unavailable ? 'Find unavailable' : invalid ? 'Invalid regex' : counted ? `${position} / ${total}` : noMatch ? '0 / 0' : `${position} / —`;
    const description = projecting ? 'Preparing this note for find.' : !supported ? 'Find is unavailable in this browser.' : failed ? 'Find couldn’t be prepared. Close and reopen find to try again.' : !projection ? 'Find is unavailable for this very large note.' : invalid ? 'Invalid regular expression' : !counted && !noMatch ? 'Match count unavailable for this large note. Use previous or next to search.' : limited ? `${position} of more than 10,000 matches` : `${position} of ${matches.length} matches`;
    count.hidden = empty && !unavailable; if (count.textContent !== text) count.textContent = text;
    count.title = description; count.setAttribute('aria-label', description); field.setAttribute('aria-invalid', String(invalid));
    dom.dataset.state = projecting ? 'preparing' : unavailable ? 'unavailable' : empty ? 'empty' : invalid ? 'invalid' : noMatch || counted && !matches.length ? 'no-match' : !counted ? 'uncounted' : limited ? 'limited' : 'ready';
    previous.disabled = next.disabled = unavailable || !query.valid || counted && !matches.length || noMatch;
  }
  function recount(): void {
    matches = []; current = undefined; limited = false; noMatch = false;
    counted = !!projection && projection.state.doc.length <= countSourceLimit;
    if (supported && query.valid && counted) {
      const cursor = query.getCursor(projection!.state);
      for (let item = cursor.next(); !item.done; item = cursor.next()) {
        if (matches.length === countLimit) { limited = true; break; } matches.push({ from: item.value.from, to: item.value.to });
      }
    }
    paint(); sync();
  }
  function commit(): void {
    if (!live() || composing) return;
    query = new SearchQuery({ search: field.value, literal: true, caseSensitive: matchCase.checked, regexp: regexp.checked, wholeWord: word.checked }); recount();
  }
  function navigate(direction: number): void {
    if (!live() || composing || !projection || !supported || !query.valid) return;
    // Counting is skipped for large notes. Only explicit navigation scans them;
    // the complete projection still bounds input size, not JS regex wall time.
    if (counted && !limited) {
      const index = current ? matches.findIndex(match => match.from === current!.from && match.to === current!.to) : direction > 0 ? -1 : 0;
      current = matches[(index + direction + matches.length) % matches.length];
    } else {
      const cursor = query.getCursor(projection.state);
      let first: Match | undefined, last: Match | undefined, chosen: Match | undefined;
      for (let item = cursor.next(); !item.done; item = cursor.next()) {
        const match = { from: item.value.from, to: item.value.to }; first ??= match;
        if (direction > 0 && (!current || match.from > current.from || match.from === current.from && match.to > current.to)) { chosen = match; break; }
        if (direction < 0 && (!current || match.from < current.from || match.from === current.from && match.to < current.to)) chosen = match;
        last = match;
      }
      current = chosen ?? (direction > 0 ? first : last);
    }
    noMatch = !current; paint(false); sync();
    if (current) {
      const range = ranges(current)[0], scroller = preview.closest<HTMLElement>('.note-scroll');
      const rect = range?.getBoundingClientRect?.(), viewport = scroller?.getBoundingClientRect();
      if (scroller && rect && viewport && viewport.height > 0) {
        scroller.scrollTop += rect.top + rect.height / 2 - viewport.top - viewport.height / 2;
        const code = range.startContainer.parentElement?.closest('pre');
        if (code) { const clip = code.getBoundingClientRect(); if (rect.left < clip.left) code.scrollLeft += rect.left - clip.left; else if (rect.right > clip.right) code.scrollLeft += rect.right - clip.right; }
      } else {
        const segment = projection.segments.find(segment => segment.to > current!.from);
        segment?.node.parentElement?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      }
    }
  }
  function refresh(): void {
    const request = ++generation;
    observer.disconnect(); observer.takeRecords(); clearHighlights(); projection = undefined; matches = []; current = undefined;
    projecting = false; failed = false; returnSelection = undefined;
    if (!live()) return;
    observer.observe(preview, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'open', 'style', 'class'] });
    if (!supported) { sync(); return; }
    projecting = true; sync();
    void project(preview, () => request === generation && live()).then(result => {
      if (request !== generation || !live()) return;
      projecting = false; projection = result; recount();
    }).catch(error => {
      if (request !== generation || !live()) return;
      console.error('Note find could not be prepared', error);
      projecting = false; failed = true; projection = undefined; matches = []; current = undefined; clearHighlights(); sync();
    });
  }
  function open(): void {
    if (disposed || !options.isCurrent() || !preview.isConnected) return;
    const selection = doc.getSelection();
    const saved = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    const endpoints = saved && preview.contains(saved.startContainer) && preview.contains(saved.endContainer) ? { start: saved.startContainer, from: saved.startOffset, end: saved.endContainer, to: saved.endOffset } : undefined;
    const seed = selection && selection.rangeCount && preview.contains(selection.anchorNode) && preview.contains(selection.focusNode) ? selection.toString() : '';
    opened = true; dom.hidden = false;
    if (seed && seed.length <= 100) { field.value = seed; query = new SearchQuery({ search: seed, literal: true, caseSensitive: matchCase.checked, regexp: regexp.checked, wholeWord: word.checked }); }
    refresh(); returnSelection = endpoints; field.focus(); field.select();
  }
  function close(): void {
    if (disposed || !opened) return;
    const restore = live() && dom.contains(doc.activeElement);
    opened = false; generation++; projecting = false; dom.hidden = true; observer.disconnect(); observer.takeRecords(); clearHighlights(); projection = undefined; matches = []; current = undefined; composing = false;
    if (restore) {
      options.returnFocus();
      if (returnSelection && options.isCurrent() && preview.contains(returnSelection.start) && preview.contains(returnSelection.end)) {
        const range = doc.createRange();
        try { range.setStart(returnSelection.start, returnSelection.from); range.setEnd(returnSelection.end, returnSelection.to); const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); } catch { /* The preview may have changed while focus was restored. */ }
      }
    }
    returnSelection = undefined;
  }
  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || !live() || composing || event.isComposing || event.keyCode === 229 || event.altKey || event.getModifierState('AltGraph')) return;
    const primary = /Mac|iPhone|iPad/.test(win.navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (key === 'escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (key === 'f3' || primary && key === 'g' || key === 'enter' && event.target === field) {
      event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1);
    }
  }
  field.addEventListener('input', event => { if (!(event as InputEvent).isComposing) commit(); });
  field.addEventListener('compositionstart', () => { composing = true; });
  field.addEventListener('compositionend', () => { composing = false; commit(); });
  dom.addEventListener('keydown', keydown); preview.addEventListener('keydown', keydown);
  return { open, refresh, close, destroy() {
    if (disposed) return; disposed = true; opened = false; generation++; projecting = false; observer.disconnect(); observer.takeRecords(); clearHighlights(); projection = undefined; matches = []; current = undefined; returnSelection = undefined;
    dom.removeEventListener('keydown', keydown); preview.removeEventListener('keydown', keydown); dom.remove();
  } };
}
