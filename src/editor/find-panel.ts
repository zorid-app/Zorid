import { search, SearchQuery, getSearchQuery, setSearchQuery, findNext, findPrevious, closeSearchPanel, selectMatches, replaceNext, replaceAll } from '@codemirror/search';
import { icon } from '../ui/icons.ts';
import { runScopeHandlers } from '@codemirror/view';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import type { Extension, Text } from '@codemirror/state';

const countLimit = 10_000, countSourceLimit = 256 * 1024, selectAllLimit = 1_000;
const sameMatcher = (a: SearchQuery, b: SearchQuery) => a.search === b.search && a.caseSensitive === b.caseSensitive
  && a.literal === b.literal && a.regexp === b.regexp && a.wholeWord === b.wholeWord && a.test === b.test;
let panelSequence = 0;

/** Uses CodeMirror's current document/query for both navigation and counts.
 * Counts scan complete notes only, bounded by source size and stored occurrences.
 * This adds no regex timeout to CM's synchronous engine. Selection-only updates
 * reuse counted ranges; navigation remains available when counting is skipped. */
class NoteFindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private view: EditorView;
  private query: SearchQuery;
  private field: HTMLInputElement;
  private count: HTMLElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private options: HTMLElement;
  private optionsButton: HTMLButtonElement;
  private matchCase: HTMLInputElement;
  private regex: HTMLInputElement;
  private wholeWord: HTMLInputElement;
  private selectAll: HTMLButtonElement;
  private selectHelp: HTMLElement;
  private replaceToggle: HTMLButtonElement;
  private replaceRow: HTMLElement;
  private replaceField: HTMLInputElement;
  private replaceButtons: HTMLButtonElement[];
  private composing = false;
  private disposed = false;
  private countedDoc?: Text;
  private countedQuery?: SearchQuery;
  private ranges: { from: number; to: number }[] = [];
  private limited = false;
  private countUnavailable = false;

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'cm-search zorid-find-panel';
    this.dom.setAttribute('role', 'search');
    this.dom.setAttribute('aria-label', 'Find in note');
    const row = doc.createElement('div'); row.className = 'zorid-find-row';
    const fieldWrap = doc.createElement('div'); fieldWrap.className = 'zorid-find-field';
    this.field = doc.createElement('input');
    this.field.type = 'text'; this.field.name = 'search'; this.field.placeholder = 'Find in note…';
    this.field.setAttribute('aria-label', 'Find in note'); this.field.setAttribute('main-field', 'true');
    this.field.autocomplete = 'off'; this.field.spellcheck = false;
    this.count = doc.createElement('span'); this.count.className = 'zorid-find-count';
    this.count.id = `zorid-find-count-${++panelSequence}`;
    this.count.setAttribute('role', 'status'); this.count.setAttribute('aria-live', 'polite');
    this.field.setAttribute('aria-describedby', this.count.id);
    fieldWrap.append(icon('search', 16, doc), this.field, this.count);
    const button = (label: string, text: string, action: () => void) => {
      const node = doc.createElement('button'); node.type = 'button'; node.textContent = text;
      node.className = 'zorid-find-button'; node.title = label; node.setAttribute('aria-label', label);
      node.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
      node.addEventListener('click', () => { if (!this.disposed && !this.composing) action(); });
      return node;
    };
    this.previous = button('Previous match', '', () => findPrevious(view));
    this.previous.classList.add('zorid-find-previous'); this.previous.append(icon('down', 16, doc));
    this.next = button('Next match', '', () => findNext(view)); this.next.append(icon('down', 16, doc));
    this.optionsButton = button('Search options', '', () => {
      this.options.hidden = !this.options.hidden;
      this.optionsButton.setAttribute('aria-expanded', String(!this.options.hidden));
    });
    this.optionsButton.append(icon('settings', 16, doc));
    this.optionsButton.setAttribute('aria-expanded', 'false');
    const close = button('Close find', '', () => closeSearchPanel(view)); close.append(icon('close', 16, doc));
    row.append(fieldWrap, this.previous, this.next, this.optionsButton, close);
    this.options = doc.createElement('div'); this.options.className = 'zorid-find-options'; this.options.hidden = true;
    this.options.id = `zorid-find-options-${panelSequence}`;
    this.optionsButton.setAttribute('aria-controls', this.options.id);
    const checkbox = (label: string, name: string) => {
      const wrapper = doc.createElement('label'), input = doc.createElement('input');
      input.type = 'checkbox'; input.name = name; input.addEventListener('change', () => this.commit());
      wrapper.append(input, doc.createTextNode(label)); this.options.append(wrapper); return input;
    };
    this.matchCase = checkbox('Match case', 'case');
    this.regex = checkbox('Regular expression', 'regexp');
    this.wholeWord = checkbox('Whole word', 'word');
    this.selectAll = button('Select all matches', 'Select all', () => selectMatches(view));
    this.selectHelp = doc.createElement('span'); this.selectHelp.className = 'zorid-find-limit-help';
    this.selectHelp.id = `zorid-find-select-help-${panelSequence}`;
    this.selectAll.setAttribute('aria-describedby', this.selectHelp.id);
    this.replaceToggle = button('Show replace', 'Replace…', () => {
      if (view.state.readOnly) return;
      this.replaceRow.hidden = !this.replaceRow.hidden;
      this.replaceToggle.setAttribute('aria-expanded', String(!this.replaceRow.hidden));
      if (!this.replaceRow.hidden) this.replaceField.focus();
    });
    this.replaceToggle.setAttribute('aria-expanded', 'false');
    this.options.append(this.selectAll, this.replaceToggle, this.selectHelp);
    this.replaceRow = doc.createElement('div'); this.replaceRow.className = 'zorid-find-replace'; this.replaceRow.hidden = true;
    this.replaceField = doc.createElement('input'); this.replaceField.type = 'text'; this.replaceField.name = 'replace';
    this.replaceField.placeholder = 'Replace with…'; this.replaceField.setAttribute('aria-label', 'Replace with');
    const replace = button('Replace next match', 'Replace', () => { if (!view.state.readOnly) replaceNext(view); });
    const all = button('Replace all matches', 'Replace all', () => { if (!view.state.readOnly) replaceAll(view); });
    this.replaceButtons = [replace, all];
    this.replaceRow.append(this.replaceField, replace, all);
    this.dom.append(row, this.options, this.replaceRow);
    for (const input of [this.field, this.replaceField]) {
      input.addEventListener('input', event => { if (!this.composing && !(event as InputEvent).isComposing) this.commit(); });
      input.addEventListener('compositionstart', () => { this.composing = true; });
      input.addEventListener('compositionend', () => { this.composing = false; this.commit(); });
    }
    this.dom.addEventListener('keydown', event => {
      if (this.disposed || this.composing || event.isComposing || event.keyCode === 229 || view.composing) return;
      if (event.key === 'Enter' && (event.target === this.field || event.target === this.replaceField)) {
        event.preventDefault(); event.stopPropagation();
        this.commit();
        if (event.target === this.replaceField) { if (!view.state.readOnly) replaceNext(view); }
        else if (event.altKey) {
          if (!this.selectAll.disabled) selectMatches(view);
          else { this.options.hidden = false; this.optionsButton.setAttribute('aria-expanded', 'true'); }
        }
        else (event.shiftKey ? findPrevious : findNext)(view);
      } else if (runScopeHandlers(view, event, 'search-panel')) {
        event.preventDefault(); event.stopPropagation();
      }
    });
    this.sync();
  }

  private commit(): void {
    if (this.disposed || this.composing) return;
    const query = new SearchQuery({ search: this.field.value, caseSensitive: this.matchCase.checked,
      regexp: this.regex.checked, wholeWord: this.wholeWord.checked, replace: this.replaceField.value,
      literal: this.query.literal, test: this.query.test });
    if (!query.eq(this.query)) this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private sync(): void {
    this.query = getSearchQuery(this.view.state);
    // A CM transaction may arrive while an input owns an uncommitted IME draft.
    if (!this.composing) {
      if (this.field.value !== this.query.search) this.field.value = this.query.search;
      if (this.replaceField.value !== this.query.replace) this.replaceField.value = this.query.replace;
    }
    this.matchCase.checked = this.query.caseSensitive; this.regex.checked = this.query.regexp; this.wholeWord.checked = this.query.wholeWord;
    if (this.countedDoc !== this.view.state.doc || !this.countedQuery || !sameMatcher(this.countedQuery, this.query)) {
      this.countedDoc = this.view.state.doc; this.countedQuery = this.query;
      this.ranges = []; this.limited = false;
      this.countUnavailable = this.view.state.doc.length > countSourceLimit;
      if (this.query.valid && !this.countUnavailable) {
        const cursor = this.query.getCursor(this.view.state);
        for (let item = cursor.next(); !item.done; item = cursor.next()) {
          if (this.ranges.length === countLimit) { this.limited = true; break; }
          this.ranges.push({ from: item.value.from, to: item.value.to });
        }
      }
    }
    const empty = !this.query.search, invalid = !empty && !this.query.valid;
    const selection = this.view.state.selection.main;
    let low = 0, high = this.ranges.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.ranges[middle].from < selection.from) low = middle + 1; else high = middle; }
    const selected = this.ranges[low];
    const indexed = selected?.from === selection.from && selected.to === selection.to;
    // CM backward literal navigation permits overlaps, whereas its cursor and
    // select-all command enumerate non-overlapping matches. Never label an
    // unindexed selected range as zero, or manufacture its occurrence number.
    const outside = !indexed && (selection.from !== selection.to || this.limited && selection.from > this.ranges.at(-1)!.from);
    const current = indexed ? String(low + 1) : outside ? '—' : '0';
    const total = `${this.ranges.length.toLocaleString('en-US')}${this.limited ? '+' : ''}`;
    const countText = invalid ? 'Invalid regex' : this.countUnavailable ? '— / —' : `${current} / ${total}`;
    const description = this.countUnavailable ? 'Match count unavailable for this large note' : outside
      ? `Current selection is outside the counted non-overlapping matches; ${total} matches counted`
      : this.limited ? `${current} of more than ${countLimit.toLocaleString('en-US')} non-overlapping matches` : `${current} of ${this.ranges.length} non-overlapping matches`;
    this.count.hidden = empty;
    if (this.count.textContent !== countText) this.count.textContent = countText;
    this.count.setAttribute('aria-label', invalid ? 'Invalid regular expression' : description);
    this.count.title = description;
    this.field.setAttribute('aria-invalid', String(invalid));
    this.dom.dataset.state = empty ? 'empty' : invalid ? 'invalid' : this.countUnavailable ? 'uncounted' : this.limited ? 'limited' : this.ranges.length ? 'ready' : 'no-match';
    const unavailable = !this.query.valid || !this.countUnavailable && !this.ranges.length;
    this.previous.disabled = this.next.disabled = unavailable;
    this.selectAll.disabled = unavailable || this.countUnavailable || this.limited || this.ranges.length > selectAllLimit;
    this.selectHelp.hidden = !this.query.valid || !this.selectAll.disabled || unavailable;
    this.selectHelp.textContent = this.countUnavailable ? 'Select all is unavailable while the match count is unavailable.' : 'Select all is available for up to 1,000 matches.';
    this.replaceToggle.hidden = this.view.state.readOnly;
    if (this.view.state.readOnly) { this.replaceRow.hidden = true; this.replaceToggle.setAttribute('aria-expanded', 'false'); }
    for (const button of this.replaceButtons) button.disabled = unavailable || this.view.state.readOnly;
  }

  mount(): void { this.field.focus(); this.field.select(); }
  update(_update: ViewUpdate): void { this.sync(); }
  destroy(): void { this.disposed = true; }
}

export function noteFindPanel(): Extension {
  return search({ top: true, createPanel: view => new NoteFindPanel(view) });
}
