export interface BaseComboboxOptions {
  searchable?: boolean;
  /** Keep the popup inside its owning panel for outside-click and focus handling. */
  owner?: HTMLElement;
  onOpen?(): void;
}

export interface BaseCombobox {
  sync(): void;
  destroy(): void;
}

let nextComboboxId = 0;

/** A searchable presentation of a native select; the select remains the value/event model. */
export function createBaseCombobox(select: HTMLSelectElement, options: BaseComboboxOptions = {}): BaseCombobox {
  const doc = select.ownerDocument, win = doc.defaultView;
  const original = { hidden: select.hidden, tabIndex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden') };
  const button = doc.createElement('button');
  button.type = 'button'; button.className = 'bases-toolbar-combobox-button';
  button.setAttribute('role', 'combobox'); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  const label = doc.createElement('span'); label.className = 'bases-toolbar-combobox-label';
  const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('width', '16'); chevron.setAttribute('height', '16');
  chevron.setAttribute('fill', 'none'); chevron.setAttribute('stroke', 'currentColor'); chevron.setAttribute('stroke-width', '2'); chevron.setAttribute('aria-hidden', 'true');
  chevron.classList.add('bases-toolbar-combobox-chevron');
  const chevronPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); chevronPath.setAttribute('d', 'm7 9 5-5 5 5m-10 6 5 5 5-5'); chevron.append(chevronPath);
  button.append(label, chevron); select.after(button);
  select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  const listId = `bases-toolbar-combobox-${++nextComboboxId}`;
  let destroyed = false, popup: HTMLDivElement | undefined, list: HTMLDivElement | undefined, search: HTMLInputElement | undefined;
  let visible: HTMLOptionElement[] = [], active = -1;
  const disabled = () => select.disabled || select.matches(':disabled');
  const selectable = (option: HTMLOptionElement) => !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && (option.parentElement as HTMLOptGroupElement).disabled);

  function close(returnFocus: boolean) {
    popup?.remove(); popup = undefined; list = undefined; search = undefined; visible = []; active = -1;
    button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-controls'); button.removeAttribute('aria-activedescendant');
    if (returnFocus && !destroyed && button.isConnected && !button.disabled) button.focus({ preventScroll: true });
  }

  function place() {
    if (!popup) return;
    if (!button.isConnected) { close(false); return; }
    const rect = button.getBoundingClientRect(), viewportWidth = win?.innerWidth ?? doc.documentElement.clientWidth, viewportHeight = win?.innerHeight ?? doc.documentElement.clientHeight;
    const margin = 8, gap = 4, width = Math.min(Math.max(rect.width, options.searchable ? 220 : 160), Math.max(0, viewportWidth - margin * 2));
    popup.style.position = 'fixed'; popup.style.width = `${width}px`;
    const below = viewportHeight - rect.bottom - gap - margin, above = rect.top - gap - margin;
    const preferredHeight = Math.min(popup.scrollHeight || 320, 320);
    const opensAbove = below < preferredHeight && above > below;
    const available = Math.max(0, opensAbove ? above : below);
    popup.style.maxHeight = `${Math.min(320, available)}px`;
    const height = Math.min(popup.getBoundingClientRect().height || preferredHeight, available);
    popup.style.left = `${Math.max(margin, Math.min(rect.left, viewportWidth - width - margin))}px`;
    popup.style.top = `${opensAbove ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap}px`;
    popup.classList.toggle('opens-above', opensAbove);
  }

  function highlight(index: number) {
    active = index;
    if (!list) return;
    for (const [i, row] of Array.from(list.children).entries()) row.classList.toggle('is-active', i === active);
    const row = active >= 0 ? list.children[active] as HTMLElement : undefined;
    for (const input of [button, search]) {
      if (!input) continue;
      if (row) input.setAttribute('aria-activedescendant', row.id); else input.removeAttribute('aria-activedescendant');
    }
    row?.scrollIntoView?.({ block: 'nearest' });
  }

  function choose(index: number) {
    const option = visible[index];
    if (!option || !selectable(option) || disabled()) return;
    const changed = select.selectedIndex !== option.index;
    select.selectedIndex = option.index;
    close(true); sync();
    if (changed && win) select.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  function render() {
    if (!list) return;
    const previous = visible[active], query = search?.value.trim().toLocaleLowerCase() ?? '';
    visible = Array.from(select.options).filter(option => !option.hidden && !option.closest('optgroup[hidden]') && (!query || option.label.toLocaleLowerCase().includes(query)));
    list.replaceChildren(...visible.map((option, index) => {
      const row = doc.createElement('div'); row.className = 'bases-toolbar-combobox-option'; row.id = `${listId}-${index}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected)); row.title = option.label; row.textContent = option.label;
      row.classList.toggle('is-selected', option.selected); row.classList.toggle('is-disabled', !selectable(option));
      if (!selectable(option)) row.setAttribute('aria-disabled', 'true');
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('pointermove', () => { if (selectable(option)) highlight(index); });
      row.addEventListener('click', () => choose(index));
      return row;
    }));
    if (!visible.length) {
      const empty = doc.createElement('div'); empty.className = 'bases-toolbar-combobox-empty'; empty.setAttribute('role', 'status'); empty.textContent = 'No results'; list.append(empty);
    }
    const preferred = previous && visible.includes(previous) && selectable(previous) ? visible.indexOf(previous) : visible.findIndex(option => option.selected && selectable(option));
    highlight(preferred >= 0 ? preferred : visible.findIndex(selectable)); place();
  }

  function open() {
    if (destroyed || disabled() || popup) return;
    options.onOpen?.();
    if (destroyed || disabled() || !button.isConnected) return;
    popup = doc.createElement('div'); popup.className = 'bases-toolbar-combobox-popover';
    if (options.searchable) {
      search = doc.createElement('input'); search.type = 'search'; search.className = 'bases-toolbar-combobox-search'; search.placeholder = 'Search...';
      search.setAttribute('aria-label', `Search ${button.getAttribute('aria-label') ?? 'options'}`); search.setAttribute('role', 'searchbox'); search.setAttribute('aria-controls', listId); search.autocomplete = 'off';
      search.addEventListener('input', render); search.addEventListener('keydown', keydown); popup.append(search);
    }
    list = doc.createElement('div'); list.id = listId; list.className = 'bases-toolbar-combobox-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', button.getAttribute('aria-label') ?? 'Options'); popup.append(list);
    (options.owner ?? select.parentElement ?? doc.body).append(popup);
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', listId);
    render(); search?.focus({ preventScroll: true });
  }

  function move(step: number) {
    if (!visible.some(selectable)) return;
    let index = active;
    for (let count = 0; count < visible.length; count++) {
      index = (index + step + visible.length) % visible.length;
      if (selectable(visible[index])) { highlight(index); return; }
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && popup) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab' && popup) { close(true); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      if (!popup) open(); else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' || (event.key === ' ' && event.target === button)) {
      event.preventDefault(); event.stopPropagation();
      if (!popup) open(); else choose(active);
    } else if ((event.key === 'Home' || event.key === 'End') && popup && event.target === button) {
      event.preventDefault();
      const edge = event.key === 'Home' ? visible.findIndex(selectable) : visible.length - 1 - [...visible].reverse().findIndex(selectable);
      highlight(edge >= visible.length ? -1 : edge);
    } else if (options.searchable && event.target === button && event.key.length === 1 && !event.altKey) {
      event.preventDefault(); open(); if (search) { search.value += event.key; render(); }
    }
  }

  function sync() {
    if (destroyed) return;
    label.textContent = select.options[select.selectedIndex]?.label ?? select.getAttribute('placeholder') ?? '';
    button.disabled = disabled();
    for (const name of ['aria-label', 'aria-labelledby', 'aria-describedby', 'title']) {
      const value = select.getAttribute(name);
      if (value === null) button.removeAttribute(name); else button.setAttribute(name, value);
    }
    if (button.disabled) close(false); else render();
  }
  const click = () => { if (popup) close(true); else open(); };
  const pointerdown = (event: Event) => { if (popup && event.target !== button && !button.contains(event.target as Node) && !popup.contains(event.target as Node)) close(false); };
  const focusin = (event: Event) => { if (popup && event.target !== button && !popup.contains(event.target as Node)) close(false); };
  const observer = win ? new win.MutationObserver(sync) : undefined;
  observer?.observe(select, { subtree: true, childList: true, characterData: true, attributes: true });
  button.addEventListener('click', click); button.addEventListener('keydown', keydown); select.addEventListener('change', sync);
  doc.addEventListener('pointerdown', pointerdown, true); doc.addEventListener('focusin', focusin);
  win?.addEventListener('resize', place); doc.addEventListener('scroll', place, true);
  sync();
  return { sync, destroy() {
    if (destroyed) return;
    destroyed = true; close(false); observer?.disconnect();
    button.removeEventListener('click', click); button.removeEventListener('keydown', keydown); select.removeEventListener('change', sync);
    doc.removeEventListener('pointerdown', pointerdown, true); doc.removeEventListener('focusin', focusin); win?.removeEventListener('resize', place); doc.removeEventListener('scroll', place, true);
    button.remove(); select.hidden = original.hidden;
    if (original.tabIndex === null) select.removeAttribute('tabindex'); else select.setAttribute('tabindex', original.tabIndex);
    if (original.ariaHidden === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', original.ariaHidden);
  } };
}
