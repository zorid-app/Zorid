import { BASE_NULL, baseValueToString } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BasePropertyPresentation, BasePresentationOptions } from './presentation-common.ts';
import { basePropertyValueDiagnostic, inferBasePropertyDefinition, parseBasePropertyInput } from './property-definitions.ts';
import type { BasePropertyDefinition, BasePropertyOption } from './property-definitions.ts';

export interface BaseRelationTarget {
  readonly path: string;
  readonly label?: string;
  readonly entryId?: string;
  readonly missing?: boolean;
  /** Rust-resolved persisted relation text, when different from a wiki link. */
  readonly value?: string;
}
export interface BasePropertyWidgetEdit extends BasePropertyPresentation { readonly path: string; }
/** Returned by the owner only after this editor's own successful mutation. The
 * owner verifies saved identity/value and supplies its fresh query witness. */
export interface BasePropertyWidgetAcknowledgement {
  readonly version: BasePropertyPresentation['version'];
  readonly row: BasePropertyPresentation['row'];
  readonly value?: BaseExpressionValue;
}
export interface BasePropertyWidgetOptions {
  readonly getDefinition: (property: string) => BasePropertyDefinition | undefined;
  readonly commit: (edit: BasePropertyWidgetEdit) => void | BasePropertyWidgetAcknowledgement | Promise<void | BasePropertyWidgetAcknowledgement>;
  /** Targets are selected/resolved by Rust/the owning workspace, never by a TS query evaluator. */
  readonly getRelationTargets?: (property: string, presentation: BasePropertyPresentation) => readonly BaseRelationTarget[] | undefined;
  readonly openFile?: (path: string, event: MouseEvent | KeyboardEvent) => void;
  readonly readOnly?: (presentation: BasePropertyPresentation) => boolean;
  readonly isCurrent?: (presentation: BasePropertyPresentation) => boolean;
  readonly createOption?: (property: string, value: string, presentation: BasePropertyPresentation) => void | BasePropertyWidgetAcknowledgement | Promise<void | BasePropertyWidgetAcknowledgement>;
  readonly onError?: (error: unknown) => void;
}
const str = (value: string): BaseExpressionValue => ({ type: 'string', value });
function renderText(value: BaseExpressionValue): string {
  if (value.type === 'namespace') return value.name;
  if (value.type === 'error') return value.error.message;
  if (value.type === 'list') return value.value.map(renderText).join(', ');
  try { return baseValueToString(value); } catch { return ''; }
}
function inputText(value: BaseExpressionValue, definition: BasePropertyDefinition): string {
  if (value.type === 'null') return '';
  if (value.type === 'list') return value.value.map(renderText).join('\n');
  if (value.type === 'date') {
    const d = new Date(value.timestamp);
    if (definition.type === 'date') {
      if (value.presentationTimezone) {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: value.presentationTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
        const part = (type: string) => parts.find(part => part.type === type)?.value ?? '';
        return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
      }
      return d.toISOString().slice(0, 10);
    }
    // datetime-local deliberately has no timezone conversion during editing.
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  return renderText(value);
}
export function createBasePropertyRenderer(options: BasePropertyWidgetOptions): NonNullable<BasePresentationOptions['renderProperty']> {
  return (element, presentation) => mountBasePropertyWidget(element, presentation, options);
}

/** A retained draft pins its host via data-base-editing. A failed commit keeps the
 * exact draft; disposal releases listeners/UI but never cancels an issued write. */
export function mountBasePropertyWidget(element: HTMLElement, presentation: BasePropertyPresentation, options: BasePropertyWidgetOptions): () => void {
  const document = element.ownerDocument, win = document.defaultView;
  let definition = options.getDefinition(presentation.property) ?? inferBasePropertyDefinition(presentation.value);
  const type = definition.type;
  const editable = presentation.property.startsWith('note.') && /\.md$/i.test(presentation.row.path) && !options.readOnly?.(presentation) && type !== 'rollup' && type !== 'reverseRelation';
  const multiple = ['list', 'tags', 'multiselect'].includes(type) || (type === 'relation' && !!definition.relation?.multiple);
  const picker = multiple || ['select', 'status', 'relation', 'link'].includes(type);
  let acceptedPresentation = presentation;
  let value = presentation.value, disposed = false, pending = false, editing = false, composing = false;
  let finishAfterPending = false;
  let input: HTMLInputElement | undefined, popup: HTMLDivElement | undefined;
  let draftChanged = false;
  let draft: string[] = [], selected = 0, choices: { value: string; label: string; option?: BasePropertyOption; missing?: boolean }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, 0); timers.add(timer); };
  const current = () => !disposed && (options.isCurrent?.(acceptedPresentation) ?? true);
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* report failures cannot discard the draft */ } };
  const mark = (state?: string) => { if (state) element.dataset.baseEditing = state; else element.removeAttribute('data-base-editing'); };
  const optionFor = (text: string) => definition.options?.find(option => option.value === text);
  const targets = () => options.getRelationTargets?.(presentation.property, acceptedPresentation) ?? [];
  const targetValue = (target: BaseRelationTarget) => target.value ?? `[[${target.path.replace(/\.md$/i, '')}]]`;
  const targetFor = (text: string) => targets().find(target => targetValue(target) === text || target.path === text);
  const closePopup = () => { popup?.remove(); popup = undefined; document.removeEventListener('pointerdown', outside, true); win?.removeEventListener('resize', position); win?.removeEventListener('scroll', position, true); };
  const error = (failure: unknown) => {
    if (disposed) return;
    mark('draft'); element.classList.add('mod-error'); input?.setAttribute('aria-invalid', 'true');
    const message = failure instanceof Error ? failure.message : String(failure);
    element.title = message; if (popup) { let el = popup.querySelector<HTMLElement>('.bases-property-error'); if (!el) { el = document.createElement('div'); el.className = 'bases-property-error'; el.setAttribute('role', 'alert'); popup.append(el); } el.textContent = message; }
    report(failure);
  };
  const acknowledge = (acknowledgement: BasePropertyWidgetAcknowledgement | void, next: BaseExpressionValue): boolean => {
    if (!acknowledgement) return false;
    if (acknowledgement.row.path !== acceptedPresentation.row.path) throw new Error('A property acknowledgement cannot retarget its file.');
    acceptedPresentation = { ...acceptedPresentation, version: acknowledgement.version, row: acknowledgement.row, value: acknowledgement.value ?? next };
    return true;
  };
  const commit = async (next: BaseExpressionValue, keepOpen = false): Promise<boolean> => {
    if (!editable || !current() || pending) return false;
    pending = true; let accepted = false; mark('pending'); if (input) input.disabled = true;
    try {
      const acknowledgement = await options.commit({ ...acceptedPresentation, path: acceptedPresentation.row.path, value: next });
      const rebased = acknowledge(acknowledgement, next);
      value = next; accepted = true;
      if (!disposed) {
        element.classList.remove('mod-error');
        if (keepOpen && rebased && current()) { draftChanged = false; mark('draft'); input?.removeAttribute('aria-invalid'); }
        else { editing = false; closePopup(); draw(); }
      }
      return true;
    } catch (failure) { error(failure); return false; }
    finally {
      pending = false;
      if (!disposed && accepted && finishAfterPending && editing) { editing = false; closePopup(); draw(); }
      if (!disposed && input) { input.disabled = false; if (keepOpen && editing && !finishAfterPending) input.focus(); }
      finishAfterPending = false;
    }
  };
  function chip(text: string, removable = false, index = -1): HTMLElement {
    const pill = document.createElement('span'); pill.className = 'multi-select-pill'; pill.tabIndex = 0;
    const option = optionFor(text), target = ['relation', 'link'].includes(type) ? targetFor(text) : undefined;
    const unknown = ['select', 'multiselect', 'status'].includes(type) && !option;
    if (unknown) { pill.classList.add('is-unknown'); pill.title = 'Unknown option. Its stored value is preserved.'; }
    if (target?.missing || (type === 'relation' && !target)) { pill.classList.add('is-unresolved'); pill.title = 'Unresolved relation or target outside available choices. Its stored value is preserved.'; }
    if (option?.color && /^(?:red|orange|yellow|green|cyan|blue|purple|pink|gray|grey|brown)$/.test(option.color)) pill.dataset.color = option.color;
    const label = document.createElement('span'); label.className = 'multi-select-pill-content'; label.textContent = option?.label ?? target?.label ?? text; pill.append(label);
    if (option?.category) pill.dataset.category = option.category;
    if (target && !target.missing && options.openFile && !removable) {
      pill.classList.add('internal-link'); pill.setAttribute('role', 'link');
      const open = (event: MouseEvent | KeyboardEvent) => { event.preventDefault(); event.stopPropagation(); options.openFile?.(target.path, event); };
      pill.addEventListener('click', open); pill.addEventListener('auxclick', event => { if (event.button === 1) open(event); });
      pill.addEventListener('keydown', event => { if (event.key === 'Enter') open(event); });
    }
    if (removable) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'multi-select-pill-remove-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${text}`);
      remove.addEventListener('mousedown', event => event.preventDefault());
      remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!pending) { draft.splice(index, 1); draftChanged = true; renderEditor(); input?.focus(); void saveDraft(); } }); pill.append(remove);
      pill.addEventListener('keydown', event => {
        if (event.isComposing || pending) return;
        if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); draft.splice(index, 1); draftChanged = true; renderEditor(); input?.focus(); void saveDraft(); }
        else if (event.key === 'Escape' || event.key === 'ArrowDown') { event.preventDefault(); input?.focus(); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const sibling = event.key === 'ArrowLeft' ? pill.previousElementSibling : pill.nextElementSibling; (sibling as HTMLElement | null)?.focus(); }
      });
    }
    return pill;
  }
  function appendReadOnly(parent: HTMLElement, item: BaseExpressionValue): void {
    if (item.type === 'list') { item.value.forEach((child, index) => { if (index) parent.append(document.createTextNode(', ')); appendReadOnly(parent, child); }); return; }
    const raw = item.type === 'namespace' ? Object.getOwnPropertyDescriptor(item, 'sharedValue')?.value : undefined;
    if (raw && (raw.type === 'file' || raw.type === 'link') && typeof raw.path === 'string' && options.openFile) {
      const link = document.createElement('a'); link.href = '#'; link.className = 'internal-link'; link.textContent = typeof raw.display === 'string' ? raw.display : item.type === 'namespace' ? item.name : raw.path;
      const open = (event: MouseEvent) => { if (!current() || (event.button !== 0 && event.button !== 1)) return; event.preventDefault(); event.stopPropagation(); options.openFile?.(raw.path, event); };
      link.addEventListener('click', open); link.addEventListener('auxclick', open); parent.append(link);
    } else parent.append(document.createTextNode(renderText(item)));
  }
  function draw() {
    if (disposed) return;
    input = undefined; mark(); element.replaceChildren();
    element.classList.add('bases-metadata-value', 'metadata-property-value'); element.dataset.propertyType = type;
    if (editable) element.tabIndex = 0;
    const diagnostic = basePropertyValueDiagnostic(value, definition);
    element.classList.toggle('mod-error', !!diagnostic || value.type === 'error'); element.title = diagnostic ?? (value.type === 'error' ? value.error.message : '');
    if (type === 'checkbox' && (!diagnostic || value.type === 'null')) {
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = value.type === 'boolean' && value.value; checkbox.indeterminate = value.type === 'null'; checkbox.disabled = !editable; checkbox.setAttribute('aria-label', presentation.property.replace(/^note\./, ''));
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', async () => { if (pending || !current()) return; checkbox.disabled = true; const next = checkbox.checked; if (!await commit({ type: 'boolean', value: next })) { checkbox.disabled = !editable; checkbox.checked = value.type === 'boolean' && value.value; } });
      element.append(checkbox);
    } else if (presentation.property === 'file.name' || presentation.property === 'file.file') {
      const link = document.createElement('a'); link.href = '#'; link.className = 'internal-link'; link.textContent = renderText(value);
      const open = (event: MouseEvent) => { if ((event.button === 0 || event.button === 1) && options.openFile && current()) { event.preventDefault(); event.stopPropagation(); options.openFile(presentation.row.path, event); } };
      link.addEventListener('click', open); link.addEventListener('auxclick', open); element.append(link);
    } else if (!editable && (value.type === 'namespace' || value.type === 'list')) {
      appendReadOnly(element, value);
    } else if (!diagnostic && picker && value.type !== 'null') {
      const values = value.type === 'list' ? value.value.map(renderText) : [renderText(value)];
      for (const text of values) element.append(chip(text));
    } else element.textContent = renderText(value);
  }
  function position() {
    if (!popup) return;
    const rect = element.getBoundingClientRect(), width = Math.max(260, Math.min(360, win?.innerWidth ?? 360));
    popup.style.left = `${Math.max(4, Math.min(rect.left, (win?.innerWidth ?? 1024) - width - 4))}px`;
    popup.style.width = `${width}px`; popup.style.top = `${Math.max(4, Math.min(rect.bottom + 4, (win?.innerHeight ?? 768) - Math.min(popup.scrollHeight || 200, 320) - 4))}px`;
  }
  function outside(event: PointerEvent) {
    if (!editing || element.contains(event.target as Node) || popup?.contains(event.target as Node)) return;
    if (pending) { finishAfterPending = true; return; }
    if (!composing) void finish();
  }
  function cancel() {
    if (pending) return;
    editing = false; closePopup(); draw(); element.focus();
  }
  function renderChoices() {
    if (!popup || !input) return;
    popup.querySelector('.suggestion-container')?.remove();
    const list = document.createElement('div'); list.className = 'suggestion-container'; list.setAttribute('role', 'listbox'); list.id = `base-options-${Math.random().toString(36).slice(2)}`;
    input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'true');
    const needle = input.value.toLocaleLowerCase();
    const all = type === 'relation' || type === 'link'
      ? targets().map(target => ({ value: targetValue(target), label: target.label ?? target.path, missing: target.missing }))
      : (definition.options ?? []).map(option => ({ value: option.value, label: option.label ?? option.value, option }));
    choices = all.filter(choice => (!multiple || !draft.includes(choice.value)) && (choice.label.toLocaleLowerCase().includes(needle) || choice.value.toLocaleLowerCase().includes(needle)));
    selected = Math.max(0, Math.min(selected, choices.length - 1));
    if (choices[selected]?.missing) selected = choices.findIndex(choice => !choice.missing);
    choices.forEach((choice, index) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = `suggestion-item${index === selected ? ' is-selected' : ''}`; row.id = `${list.id}-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected)); row.textContent = choice.label; row.disabled = !!choice.missing;
      row.addEventListener('mousedown', event => event.preventDefault()); row.addEventListener('click', () => { void choose(choice.value); }); list.append(row);
    });
    if (choices[selected] && !choices[selected].missing) input.setAttribute('aria-activedescendant', `${list.id}-${selected}`); else input.removeAttribute('aria-activedescendant');
    if (input.value && options.createOption && ['select', 'multiselect', 'status'].includes(type) && !definition.options?.some(option => option.value === input!.value)) {
      const add = document.createElement('button'); add.type = 'button'; add.className = 'suggestion-item bases-property-create-option'; add.textContent = `Create “${input.value}”`; add.addEventListener('mousedown', event => event.preventDefault()); add.addEventListener('click', async () => { if (pending) return; const next = input!.value; pending = true; mark('pending'); if (input) input.disabled = true; try { const acknowledgement = await options.createOption!(presentation.property, next, acceptedPresentation); acknowledge(acknowledgement, value); const updated = options.getDefinition(presentation.property); if (updated?.type === type) definition = updated; pending = false; if (!current()) { editing = false; closePopup(); draw(); report(new Error('Option created. Reopen the property to use the refreshed definition.')); return; } mark('draft'); if (input) input.disabled = false; await choose(next); } catch (failure) { pending = false; if (input) input.disabled = false; error(failure); } }); list.append(add);
    }
    if (!list.children.length) { const empty = document.createElement('div'); empty.className = 'suggestion-empty'; empty.textContent = type === 'relation' && definition.relation?.targetFilter && options.getRelationTargets?.(presentation.property, acceptedPresentation) === undefined ? 'Relation choices are unavailable until the shared index is ready.' : ['list', 'tags'].includes(type) ? 'Type a value and press Enter' : 'No matching options'; list.append(empty); }
    popup.append(list); position();
  }
  async function choose(next: string) {
    if (!current() || pending) return;
    if (choices.find(choice => choice.value === next)?.missing || ((type === 'relation' || type === 'link') && targetFor(next)?.missing)) { error(new Error('This related note is unavailable. Choose another note.')); return; }
    if (multiple) { if (!draft.includes(next)) { draft.push(next); draftChanged = true; } if (input) input.value = ''; renderEditor(); input?.focus(); await saveDraft(); }
    else await commit(str(next));
  }
  async function saveDraft() {
    if (multiple && draftChanged) await commit({ type: 'list', value: draft.map(str) }, true);
  }
  function renderEditor() {
    if (!popup || !input) return;
    let chips = popup.querySelector<HTMLElement>('.multi-select-container');
    if (!chips) { chips = document.createElement('div'); chips.className = 'multi-select-container'; popup.prepend(chips); }
    chips.replaceChildren(); if (multiple) draft.forEach((text, index) => chips!.append(chip(text, true, index))); chips.append(input); renderChoices();
  }
  async function finish() {
    if (!current() || !editing || pending || composing || !input) return;
    try {
      let next: BaseExpressionValue;
      if (picker) {
        if (multiple) {
          if (!draftChanged && !input.value) { cancel(); return; }
          if (input.value) {
            if (['list', 'tags'].includes(type)) { if (!draft.includes(input.value)) draft.push(input.value); }
            else { error(new Error('Choose a matching option or clear the search before saving.')); return; }
          }
          next = { type: 'list', value: draft.map(str) };
        } else {
          if (input.value === inputText(value, definition)) { cancel(); return; }
          const choice = choices.find(choice => !choice.missing && (choice.value === input!.value || choice.label === input!.value));
          if (input.value && !choice && ['select', 'status', 'relation'].includes(type)) { error(new Error('Choose a matching option.')); return; }
          next = input.value ? str(choice?.value ?? input.value) : BASE_NULL;
        }
      } else {
        if (input.value === inputText(value, definition)) { cancel(); return; }
        next = parseBasePropertyInput(input.value, definition, value);
      }
      if (JSON.stringify(next) === JSON.stringify(value)) { cancel(); return; }
      await commit(next);
    } catch (failure) { error(failure); }
  }
  function begin(event: MouseEvent | KeyboardEvent) {
    if (!editable || !current() || pending || editing) return;
    if ((event.target as HTMLElement).closest('a,button,input,[role="link"]')) return;
    event.preventDefault(); event.stopPropagation(); editing = true; draftChanged = false; mark('draft');
    draft = value.type === 'list' ? value.value.map(renderText) : value.type === 'null' ? [] : [renderText(value)];
    input = document.createElement('input'); input.className = 'metadata-input metadata-input-text'; input.setAttribute('aria-label', presentation.property.replace(/^note\./, '')); input.placeholder = 'Empty';
    input.type = basePropertyValueDiagnostic(value, definition) ? 'text' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : 'text';
    if (type === 'date' || type === 'datetime') input.max = type === 'date' ? '9999-12-31' : '9999-12-31T23:59:59';
    if (type === 'number') input.inputMode = 'decimal';
    input.value = multiple ? '' : inputText(value, definition);
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; later(() => { if (picker) renderChoices(); if (!element.contains(document.activeElement) && !popup?.contains(document.activeElement)) void finish(); }); });
    input.addEventListener('input', () => { input?.removeAttribute('aria-invalid'); if (picker && !composing) { selected = 0; renderChoices(); } });
    input.addEventListener('blur', () => later(() => { if (!element.contains(document.activeElement) && !popup?.contains(document.activeElement)) void finish(); }));
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (composing || event.isComposing || pending) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      else if (picker && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; let next = selected + direction; while (next >= 0 && next < choices.length && choices[next].missing) next += direction; if (next >= 0 && next < choices.length) selected = next; renderChoices(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (picker && choices[selected] && !choices[selected].missing && input?.value) void choose(choices[selected].value);
        else if (multiple && input?.value && ['list', 'tags'].includes(type)) void choose(input.value);
        else void finish();
      } else if (multiple && (event.key === 'Backspace' || event.key === 'ArrowLeft') && !input?.value && draft.length) { event.preventDefault(); popup?.querySelectorAll<HTMLElement>('.multi-select-pill')[draft.length - 1]?.focus(); }
      else if (event.key === 'Tab') { void finish(); }
    });
    if (picker) {
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
      popup = document.createElement('div'); popup.className = 'bases-property-popover popover';
      document.body.append(popup); renderEditor(); document.addEventListener('pointerdown', outside, true); win?.addEventListener('resize', position); win?.addEventListener('scroll', position, true);
    } else element.replaceChildren(input);
    input.focus(); if (!multiple) input.select();
  }
  const activate = (event: MouseEvent) => { if (!event.defaultPrevented && event.button === 0) begin(event); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending && type === 'checkbox' && element.hasAttribute('data-base-editing')) { event.preventDefault(); draw(); return; } if (!event.defaultPrevented && !event.isComposing && event.target === element && ['Enter', 'F2'].includes(event.key)) begin(event); };
  element.addEventListener('click', activate); element.addEventListener('dblclick', activate); element.addEventListener('keydown', key); draw();
  return () => { disposed = true; closePopup(); timers.forEach(clearTimeout); timers.clear(); mark(); element.removeEventListener('click', activate); element.removeEventListener('dblclick', activate); element.removeEventListener('keydown', key); };
}
