export interface BaseFilterOperandsSnapshot {
  readonly files: readonly string[];
  readonly folders: readonly string[];
  readonly tags: readonly string[];
  readonly properties: readonly string[];
  readonly metadataStatus?: 'pending' | 'current' | 'stale' | 'unavailable';
}

export type BaseFilterOperandKind = 'file' | 'folder' | 'tag' | 'property';

export interface BaseFilterOperandOptions {
  kind: BaseFilterOperandKind;
  values: readonly string[];
  snapshot?: BaseFilterOperandsSnapshot;
  onChange(values: readonly string[]): void;
  onDraftChange?(): void;
  alive?(): boolean;
}

export interface BaseFilterOperand {
  read(): readonly string[];
  hasDraft(): boolean;
  focus(): void;
  destroy(): void;
}

let nextOperandId = 0;

/** Typed literals remain valid even when the current suggestion snapshot is incomplete. */
export function createBaseFilterOperand(doc: Document, container: HTMLElement, options: BaseFilterOperandOptions): BaseFilterOperand {
  const win = doc.defaultView, multiple = options.kind === 'tag';
  const root = doc.createElement('div'); root.className = 'bases-filter-operand'; root.dataset.kind = options.kind;
  const chips = doc.createElement('div'); chips.className = 'bases-filter-operand-chips';
  const input = doc.createElement('input'); input.type = 'text'; input.className = 'bases-filter-operand-input'; input.setAttribute('aria-label', 'Filter value');
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false'); input.autocomplete = 'off';
  input.placeholder = { file: 'File', folder: 'Folder', tag: 'Tag', property: 'Property' }[options.kind];
  const id = `bases-filter-operands-${++nextOperandId}`;
  let values = [...options.values], destroyed = false, popup: HTMLDivElement | undefined, list: HTMLDivElement | undefined;
  let visible: string[] = [], active = -1;
  if (!multiple) input.value = values[0] ?? '';
  if (multiple) root.append(chips);
  root.append(input); container.append(root);
  const usable = () => !destroyed && root.isConnected && container.contains(root) && (options.alive?.() ?? true);
  const hasDraft = () => multiple && input.value.trim().length > 0;
  const read = (): readonly string[] => multiple ? [...values, ...(hasDraft() ? [input.value] : [])] : input.value === '' ? [] : [input.value];
  const source = options.snapshot?.[({ file: 'files', folder: 'folders', tag: 'tags', property: 'properties' } as const)[options.kind]] ?? [];
  const status = options.snapshot?.metadataStatus ?? (options.snapshot ? 'current' : 'unavailable');

  function close() {
    popup?.remove(); popup = undefined; list = undefined; visible = []; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant');
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('scroll', place, true); win?.removeEventListener('resize', place);
  }

  function place() {
    if (!popup) return;
    if (!usable()) { close(); return; }
    const anchor = input.getBoundingClientRect(), viewportWidth = win?.innerWidth ?? doc.documentElement.clientWidth, viewportHeight = win?.innerHeight ?? doc.documentElement.clientHeight;
    const width = Math.min(Math.max(anchor.width, 220), Math.max(0, viewportWidth - 16));
    popup.style.position = 'fixed'; popup.style.width = `${width}px`;
    const below = viewportHeight - anchor.bottom - 12, above = anchor.top - 12, desired = Math.min(popup.scrollHeight || 240, 240), up = below < desired && above > below;
    const available = Math.max(0, up ? above : below);
    popup.style.maxHeight = `${Math.min(240, available)}px`;
    popup.style.left = `${Math.max(8, Math.min(anchor.left, viewportWidth - width - 8))}px`;
    popup.style.top = `${up ? Math.max(8, anchor.top - 4 - Math.min(popup.getBoundingClientRect().height || desired, available)) : anchor.bottom + 4}px`;
  }

  function highlight(index: number) {
    active = index;
    if (!list) return;
    for (const [i, row] of Array.from(list.children).entries()) { row.classList.toggle('is-active', i === active); row.setAttribute('aria-selected', String(i === active)); }
    const selected = active >= 0 ? list.children[active] as HTMLElement : undefined;
    if (selected) input.setAttribute('aria-activedescendant', selected.id); else input.removeAttribute('aria-activedescendant');
    selected?.scrollIntoView?.({ block: 'nearest' });
  }

  function publish() { if (usable()) options.onChange([...values]); }

  function renderChips() {
    chips.replaceChildren(...values.map((value, index) => {
      const chip = doc.createElement('span'); chip.className = 'bases-filter-operand-chip';
      const label = doc.createElement('span'); label.textContent = value; chip.append(label);
      const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'bases-filter-operand-chip-remove'; remove.setAttribute('aria-label', `Remove tag ${value}`); remove.textContent = '×';
      remove.dataset.index = String(index);
      chip.append(remove); return chip;
    }));
  }

  function accept(value: string) {
    if (!usable()) return;
    if (multiple) {
      if (!value.trim()) return;
      if (!values.includes(value)) values.push(value);
      input.value = ''; renderChips();
    } else { input.value = value; values = [value]; }
    close(); if (usable()) input.focus({ preventScroll: true }); publish();
  }

  function renderSuggestions() {
    if (!popup || !list || !usable()) return;
    const query = input.value.toLocaleLowerCase();
    const matches = [...new Set(source)].filter(value => (!multiple || !values.includes(value)) && value.toLocaleLowerCase().includes(query));
    visible = matches.slice(0, 100); active = -1;
    list.replaceChildren(...visible.map((value, index) => {
      const row = doc.createElement('div'); row.className = 'bases-filter-operand-option'; row.id = `${id}-${index}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false'); row.textContent = value; row.title = value;
      row.dataset.index = String(index);
      return row;
    }));
    popup.querySelector('.bases-filter-operand-status')?.remove();
    const message = status === 'pending' ? 'Suggestions are still loading. You can enter a value.'
      : status === 'stale' ? 'Suggestions may be out of date. You can enter a value.'
      : status === 'unavailable' ? 'Suggestions are unavailable. You can enter a value.'
      : !matches.length ? 'No matching suggestions. You can enter a value.'
      : matches.length > visible.length ? 'Showing the first 100 suggestions. Keep typing to narrow the list.' : '';
    if (message) { const hint = doc.createElement('div'); hint.className = 'bases-filter-operand-status'; hint.setAttribute('role', 'status'); hint.textContent = message; popup.append(hint); }
    highlight(-1); place();
  }

  function open() {
    if (!usable() || popup) return;
    popup = doc.createElement('div'); popup.className = 'bases-filter-operand-popover';
    list = doc.createElement('div'); list.className = 'bases-filter-operand-options'; list.id = id; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', `${input.placeholder} suggestions`);
    popup.append(list); root.append(popup); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', id);
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('scroll', place, true); win?.addEventListener('resize', place);
    renderSuggestions();
  }

  function outside(event: Event) { if (!usable() || !root.contains(event.target as Node)) close(); }
  function focusout(event: FocusEvent) { if (!root.contains(event.relatedTarget as Node | null)) close(); }
  function optionTarget(event: Event) {
    const target = event.target as Element | null;
    const row = target?.nodeType === 1 ? target.closest<HTMLElement>('.bases-filter-operand-option') : null;
    return usable() && row?.isConnected && list?.contains(row) ? row : undefined;
  }
  function pointerdown(event: Event) { if (optionTarget(event)) event.preventDefault(); }
  function pointermove(event: Event) { const row = optionTarget(event); if (row) highlight(Number(row.dataset.index)); }
  function clicked(event: Event) {
    if (!usable()) return;
    const row = optionTarget(event);
    if (row) { const value = visible[Number(row.dataset.index)]; if (value !== undefined) accept(value); return; }
    const target = event.target as Element | null;
    const remove = target?.nodeType === 1 ? target.closest<HTMLElement>('.bases-filter-operand-chip-remove') : null;
    if (!remove?.isConnected || !chips.contains(remove)) return;
    values.splice(Number(remove.dataset.index), 1); renderChips(); renderSuggestions();
    if (usable()) input.focus({ preventScroll: true }); publish();
  }
  function changed() {
    if (!usable()) return;
    open(); renderSuggestions();
    if (multiple) options.onDraftChange?.();
    else { values = input.value === '' ? [] : [input.value]; publish(); }
  }
  function keydown(event: KeyboardEvent) {
    if (!usable() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && popup) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation(); open();
      if (visible.length) highlight(active < 0 ? event.key === 'ArrowDown' ? 0 : visible.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (event.key === 'Enter' && (popup || hasDraft())) {
      event.preventDefault(); event.stopPropagation();
      if (active >= 0 && visible[active] !== undefined) accept(visible[active]);
      else if (multiple && hasDraft()) accept(input.value);
      else close();
    } else if (event.key === 'Backspace' && multiple && input.value === '' && values.length) {
      event.preventDefault(); values.pop(); renderChips(); renderSuggestions(); publish();
    } else if (event.key === 'Tab') close();
  }

  input.addEventListener('input', changed); input.addEventListener('focus', open); input.addEventListener('click', open); input.addEventListener('keydown', keydown); root.addEventListener('focusout', focusout);
  root.addEventListener('pointerdown', pointerdown); root.addEventListener('pointermove', pointermove); root.addEventListener('click', clicked);
  if (multiple) renderChips();
  return { read, hasDraft, focus() { if (usable()) input.focus({ preventScroll: true }); }, destroy() {
    if (destroyed) return;
    destroyed = true; close();
    input.removeEventListener('input', changed); input.removeEventListener('focus', open); input.removeEventListener('click', open); input.removeEventListener('keydown', keydown); root.removeEventListener('focusout', focusout);
    root.removeEventListener('pointerdown', pointerdown); root.removeEventListener('pointermove', pointermove); root.removeEventListener('click', clicked);
    root.remove();
  } };
}
