import { icon } from '../ui/icons.ts';
import { baseRichPresentation, mountBaseRichValue } from './rich-values.ts';
import { BASE_NULL, baseValueToString } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BasePropertyPresentation, BasePresentationOptions } from './presentation-common.ts';
import { basePropertyValueDiagnostic, inferBasePropertyDefinition, parseBasePropertyInput } from './property-definitions.ts';
import type { BasePropertyDefinition, BasePropertyOption } from './property-definitions.ts';

export interface BaseRelationTarget {
  readonly path: string;
  readonly label?: string;
  readonly entryId?: string;
  readonly revision?: string;
  /** Explicit core-resolved heading/block fragment; never inferred from path. */
  readonly subpath?: string;
  readonly missing?: boolean;
  /** Rust-resolved persisted relation text, when different from a wiki link. */
  readonly value?: string;
}
/** New selections use a vault-rooted, percent-escaped path so the source note's
 * folder and wiki-link delimiters cannot change the verified target identity.
 * Keep exact file extensions and slashes readable; existing raw values are never
 * normalized, and explicit core-provided persisted text takes precedence. */
export function baseRelationTargetValue(target: BaseRelationTarget): string {
  return target.value ?? `[[/${target.path.replace(/^\/+/, '').split('/').map(segment => encodeURIComponent(segment)).join('/')}]]`;
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
  /** Same-snapshot persisted source value, before link/date/rich inference. */
  readonly getEditableValue?: (presentation: BasePropertyPresentation) => BaseExpressionValue | undefined;
  /** Optional typed display from the same saved property baseline. The owner must
   * verify entry identity/revision and exact raw value before returning it. Called
   * at mount and after acknowledged edits only; undefined uses presentation.value.
   * Display values never initialize or replace the persisted editable draft. */
  readonly getDisplayValue?: (presentation: BasePropertyPresentation) => BaseExpressionValue | undefined;
  readonly getDefinition: (property: string) => BasePropertyDefinition | undefined;
  readonly commit: (edit: BasePropertyWidgetEdit) => void | BasePropertyWidgetAcknowledgement | Promise<void | BasePropertyWidgetAcknowledgement>;
  /** Targets are selected/resolved by Rust/the owning workspace, never by a TS query evaluator. */
  readonly getRelationTargets?: (property: string, presentation: BasePropertyPresentation) => readonly BaseRelationTarget[] | undefined;
  readonly loadImage?: (source: string, signal: AbortSignal, presentation: BasePropertyPresentation) => Promise<{ readonly url: string; dispose(): void } | null>;
  readonly openFile?: (path: string, event: MouseEvent | KeyboardEvent, witness?: { readonly entryId: string; readonly revision: string; readonly subpath?: string }) => void;
  readonly readOnly?: (presentation: BasePropertyPresentation) => boolean;
  /** Live gate for new interactions; never revokes an existing draft or write. */
  readonly canBegin?: () => boolean;
  readonly isCurrent?: (presentation: BasePropertyPresentation) => boolean;
  readonly createOption?: (property: string, value: string, presentation: BasePropertyPresentation) => void | BasePropertyWidgetAcknowledgement | Promise<void | BasePropertyWidgetAcknowledgement>;
  readonly onError?: (error: unknown) => void;
}
const str = (value: string): BaseExpressionValue => ({ type: 'string', value });
const propertyPopoverOwners=new WeakMap<Node,HTMLElement>();
/** Process-local ownership of a currently mounted rich-property portal. */
export function basePropertyPopoverOwner(node:Node):HTMLElement|undefined {
  for(let current:Node|null=node;current;current=current.parentNode){const owner=propertyPopoverOwners.get(current);if(owner&&current.isConnected&&owner.isConnected)return owner;}
  return undefined;
}
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
      if (value.presentationTimezone) return baseValueToString({ ...value, hasTime: false });
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
  const suppliedRaw = options.getEditableValue?.(presentation);
  const rawSafe = (value: BaseExpressionValue, active = new Set<object>(), budget = {left:10000}, depth = 0): boolean => {
    if (--budget.left < 0 || depth > 64 || !value || typeof value !== 'object' || active.has(value)) return false;
    const kind = Object.getOwnPropertyDescriptor(value, 'type')?.value;
    if (kind === 'null') return true;
    const data = Object.getOwnPropertyDescriptor(value, 'value')?.value;
    if (kind === 'string') return typeof data === 'string';
    if (kind === 'number') return typeof data === 'number' && Number.isFinite(data);
    if (kind === 'boolean') return typeof data === 'boolean';
    if ((kind !== 'list' || !Array.isArray(data)) && (kind !== 'object' || !data || typeof data !== 'object')) return false;
    active.add(value);
    const keys = kind === 'list' ? Array.from({length:Math.min(data.length,10001)},(_,index)=>String(index)) : Object.keys(data);
    const valid = keys.length <= budget.left && keys.every(key => { const item = Object.getOwnPropertyDescriptor(data,key); return !!item && 'value' in item && rawSafe(item.value,active,budget,depth+1); });
    active.delete(value); return valid;
  };
  let value = suppliedRaw ?? presentation.value, displayValue = options.getDisplayValue?.(presentation) ?? presentation.value;
  let definition = options.getDefinition(presentation.property) ?? inferBasePropertyDefinition(value, presentation.property);
  const type = definition.type;
  const rawUnavailable = type !== 'rollup' && type !== 'reverseRelation' && presentation.property.startsWith('note.') && suppliedRaw === undefined && !rawSafe(presentation.value) && (!!options.getEditableValue || presentation.value.type === 'namespace' || type === 'relation' || type === 'link');
  const editable = presentation.property.startsWith('note.') && /\.md$/i.test(presentation.row.path) && !rawUnavailable && !options.readOnly?.(presentation) && type !== 'rollup' && type !== 'reverseRelation';
  const multiple = ['list', 'tags', 'multiselect'].includes(type) || (type === 'relation' && !!definition.relation?.multiple);
  const inlineList = type === 'list' || type === 'tags';
  const picker = multiple || ['select', 'status', 'relation', 'link'].includes(type);
  let acceptedPresentation = presentation;
  element.dataset.baseWidgetVersion = String(acceptedPresentation.version);
  let disposed = false, pending = false, editing = false, composing = false;
  let blurDuringComposition = false, compositionEpoch = 0;
  let finishAfterPending = false, editingIndex: number | undefined;
  let disposeRich: (() => void) | undefined;
  let removeFocusObserver: (() => void) | undefined;
  let input: HTMLInputElement | undefined, popup: HTMLDivElement | undefined;
  let draftChanged = false;
  let draft: { text: string; value: BaseExpressionValue }[] = [], selected = 0, choices: { value: string; label: string; option?: BasePropertyOption; missing?: boolean; target?: BaseRelationTarget }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, 0); timers.add(timer); };
  const current = () => !disposed && (options.isCurrent?.(acceptedPresentation) ?? true);
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* report failures cannot discard the draft */ } };
  const mark = (state?: string) => { if (state) element.dataset.baseEditing = state; else element.removeAttribute('data-base-editing'); };
  const optionFor = (text: string) => definition.options?.find(option => option.value === text);
  const targets = () => options.getRelationTargets?.(presentation.property, acceptedPresentation) ?? [];
  const targetValue = baseRelationTargetValue;
  const pairedTargets = new Map<string, BaseRelationTarget>();
  const pairTargets = () => {
    pairedTargets.clear(); let remaining = 10000;
    const own = (object: unknown, key: string): unknown => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    const labelText = (label: unknown, depth = 0): string | undefined => {
      if (--remaining < 0 || depth > 64) return;
      const kind = own(label, 'type'), data = own(label, 'value');
      if (kind === 'namespace') { const name = own(label, 'name'); return typeof name === 'string' ? name : undefined; }
      if (kind === 'string' && typeof data === 'string') return data;
      if (kind === 'number' && typeof data === 'number' && Number.isFinite(data) || kind === 'boolean' && typeof data === 'boolean') return String(data);
      if (kind === 'null') return '';
      if (kind === 'list' && Array.isArray(data)) {
        const length = own(data, 'length');
        if (typeof length !== 'number' || length > remaining) return;
        const parts: string[] = [];
        for (let index = 0; index < length; index++) { const part = labelText(own(data, String(index)), depth + 1); if (part === undefined) return; parts.push(part); }
        return parts.join(', ');
      }
    };
    const pair = (raw: unknown, shown: unknown, depth = 0) => {
      if (--remaining < 0 || depth > 64) return;
      const rawKind = own(raw, 'type'), rawData = own(raw, 'value'), shownData = own(shown, 'value');
      if (rawKind === 'list' && own(shown, 'type') === 'list' && Array.isArray(rawData) && Array.isArray(shownData)) {
        const length = own(rawData, 'length');
        if (typeof length !== 'number' || length !== own(shownData, 'length') || length > remaining) return;
        for (let index = 0; index < length; index++) pair(own(rawData, String(index)), own(shownData, String(index)), depth + 1);
        return;
      }
      const rendered = baseRichPresentation(shown as BaseExpressionValue), path = own(rendered, 'value');
      if (rawKind === 'string' && typeof rawData === 'string' && own(rendered, 'kind') === 'link' && typeof path === 'string') {
        const target = own(rendered, 'target'), entryId = own(target, 'entryId'), revision = own(target, 'revision'), subpath = own(rendered, 'subpath');
        const shared = own(shown, 'sharedValue');
        // Explicit core null means unresolved in this saved generation. Absent
        // legacy resolution metadata and external links do not establish that.
        const missing = own(shared, 'type') === 'link' && own(shared, 'target') === null && own(shared, 'external') === false;
        pairedTargets.set(rawData, { path, label: labelText(own(rendered, 'label')) ?? labelText(shown), entryId: typeof entryId === 'string' ? entryId : undefined, revision: typeof revision === 'string' ? revision : undefined, ...(missing ? {missing:true} : {}), ...(typeof subpath === 'string' && subpath.startsWith('#') ? {subpath} : {}) });
      }
    }; pair(value, displayValue);
  };
  pairTargets();
  const targetFor = (text: string) => pairedTargets.get(text) ?? targets().find(target => targetValue(target) === text || target.path === text);
  const closePopup = () => { if(popup){propertyPopoverOwners.delete(popup);popup.remove();} popup = undefined; document.removeEventListener('pointerdown', outside, true); win?.removeEventListener('resize', position); win?.removeEventListener('scroll', position, true); };
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
    if (!disposed) element.dataset.baseWidgetVersion = String(acceptedPresentation.version);
    displayValue = options.getDisplayValue?.(acceptedPresentation) ?? acceptedPresentation.value; value = options.getEditableValue?.(acceptedPresentation) ?? next; pairTargets();
    return true;
  };
  const commit = async (next: BaseExpressionValue, keepOpen = false, restoreFailureFocus = true): Promise<boolean> => {
    if (!editable || !current() || pending) return false;
    const focusInput = !picker && restoreFailureFocus ? input : undefined;
    const ownedFocus = !!focusInput && document.activeElement === focusInput && document.hasFocus();
    let focusMoved = false;
    const moved = (event: FocusEvent) => { if (event.target !== focusInput) focusMoved = true; };
    const pointedOutside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) focusMoved = true; };
    const leftWindow = () => { focusMoved = true; };
    const navigated = (event: KeyboardEvent) => { if (event.key === 'Tab' && !event.isComposing) focusMoved = true; };
    const removeObservers = () => {
      document.removeEventListener('focusin', moved, true); document.removeEventListener('pointerdown', pointedOutside, true);
      document.removeEventListener('keydown', navigated, true); win?.removeEventListener('blur', leftWindow);
    };
    if (ownedFocus) {
      // Disabling can blur a focused Chromium input. Restore only the failed
      // scalar editor's original ownership, never a subsequent navigation intent.
      document.addEventListener('focusin', moved, true); document.addEventListener('pointerdown', pointedOutside, true);
      document.addEventListener('keydown', navigated, true); win?.addEventListener('blur', leftWindow);
      removeFocusObserver = removeObservers;
    }
    pending = true; let accepted = false; mark('pending'); if (input) input.disabled = true;
    try {
      const acknowledgement = await options.commit({ ...acceptedPresentation, path: acceptedPresentation.row.path, value: next });
      const rebased = acknowledge(acknowledgement, next);
      value = next; if (!acknowledgement) displayValue = next; pairTargets(); accepted = true;
      if (!disposed) {
        element.classList.remove('mod-error');
        if (keepOpen && rebased && current()) { draftChanged = false; mark('draft'); input?.removeAttribute('aria-invalid'); }
        else { editing = false; closePopup(); draw(); }
      }
      return true;
    } catch (failure) { error(failure); return false; }
    finally {
      pending = false;
      if (ownedFocus) { removeObservers(); if (removeFocusObserver === removeObservers) removeFocusObserver = undefined; }
      if (!disposed && accepted && finishAfterPending && editing) { editing = false; closePopup(); draw(); }
      if (!disposed && input) {
        input.disabled = false;
        if (keepOpen && editing && !finishAfterPending) input.focus();
        else if (!accepted && ownedFocus && !focusMoved && editing && !composing && current()
          && input === focusInput && input.isConnected && element.isConnected && element.contains(input)
          && (document.activeElement === input || document.activeElement === document.body || document.activeElement === document.documentElement)) input.focus();
      }
      finishAfterPending = false;
    }
  };
  function chip(text: string, removable = false, index = -1): HTMLElement {
    const pill = document.createElement('span'); pill.className = 'multi-select-pill'; pill.tabIndex = 0;
    const option = optionFor(text), target = pairedTargets.get(text) ?? (['relation', 'link'].includes(type) ? targetFor(text) : undefined);
    const unknown = ['select', 'multiselect', 'status'].includes(type) && !option;
    if (unknown) { pill.classList.add('is-unknown'); pill.title = 'Unknown option. Its stored value is preserved.'; }
    if (target?.missing || (type === 'relation' && !target)) { pill.classList.add('is-unresolved'); pill.title = 'Unresolved relation or target outside available choices. Its stored value is preserved.'; }
    if (option?.color && /^(?:red|orange|yellow|green|cyan|blue|purple|pink|gray|grey|brown)$/.test(option.color)) pill.dataset.color = option.color;
    const label = document.createElement('span'); label.className = 'multi-select-pill-content'; label.textContent = option?.label ?? target?.label ?? text; pill.append(label);
    if (option?.category) pill.dataset.category = option.category;
    if (target && !target.missing && options.openFile && !removable) {
      pill.classList.add('internal-link'); pill.setAttribute('role', 'link');
      const open = (event: MouseEvent | KeyboardEvent) => {
        if ('button' in event ? event.button !== 0 && event.button !== 1 : event.isComposing) return;
        event.preventDefault(); event.stopPropagation();
        if (!current()) return;
        options.openFile?.(target.path, event, target.entryId && target.revision ? {entryId:target.entryId,revision:target.revision,...(typeof target.subpath === 'string' && target.subpath.startsWith('#') ? {subpath:target.subpath} : {})} : undefined);
      };
      pill.addEventListener('click', open); pill.addEventListener('auxclick', event => { if (event.button === 1) open(event); });
      pill.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); editChip(index); });
      pill.addEventListener('keydown', event => { if (event.key === 'Enter') open(event); });
    }
    if (removable) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'multi-select-pill-remove-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${text}`);
      remove.addEventListener('mousedown', event => event.preventDefault());
      remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!pending) { removeChip(index); } }); pill.append(remove);
      pill.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); editChip(index); });
      pill.addEventListener('keydown', event => {
        if (event.isComposing || pending) return;
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); editChip(index); }
        else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); removeChip(index); }
        else if (event.key === 'Escape' || event.key === 'ArrowDown') { event.preventDefault(); input?.focus(); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const sibling = event.key === 'ArrowLeft' ? pill.previousElementSibling : pill.nextElementSibling; (sibling as HTMLElement | null)?.focus(); }
      });
    }
    return pill;
  }
  function draw() {
    if (disposed) return;
    disposeRich?.(); disposeRich = undefined;
    input = undefined; mark(); element.replaceChildren();
    element.classList.add('bases-metadata-value', 'metadata-property-value'); element.dataset.propertyType = type;
    if (editable) { element.tabIndex = 0; element.dataset.basePropertyEditable = 'true'; element.setAttribute('aria-disabled', String(options.canBegin?.() === false)); }
    const diagnostic = rawUnavailable ? 'Saved property text is unavailable; refresh before editing.' : presentation.property.startsWith('note.') ? basePropertyValueDiagnostic(value, definition) : undefined;
    if (rawUnavailable) element.dataset.baseEditUnavailable = 'true'; else element.removeAttribute('data-base-edit-unavailable');
    element.classList.toggle('mod-error', !!diagnostic || value.type === 'error'); element.title = diagnostic ?? (value.type === 'error' ? value.error.message : '');
    if (type === 'checkbox' && (!diagnostic || value.type === 'null')) {
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'metadata-input-checkbox'; checkbox.checked = value.type === 'boolean' && value.value; checkbox.indeterminate = value.type === 'null'; checkbox.disabled = !editable || options.canBegin?.() === false; checkbox.setAttribute('aria-label', presentation.property.replace(/^note\./, ''));
      const canBeginCheckbox = () => editable && (element.dataset.baseEditing === 'draft' || options.canBegin?.() !== false);
      checkbox.addEventListener('click', event => { event.stopPropagation(); if (!canBeginCheckbox()) event.preventDefault(); });
      checkbox.addEventListener('change', async () => {
        if (pending || !current()) return;
        if (!canBeginCheckbox()) { checkbox.checked = value.type === 'boolean' && value.value; checkbox.indeterminate = value.type === 'null'; return; }
        // Chromium can blur a control as soon as it becomes disabled. Capture
        // keyboard ownership first, and relinquish it if any other node focuses.
        const ownedFocus = document.activeElement === checkbox;
        let focusMoved = false;
        const moved = (event: FocusEvent) => { if (event.target !== checkbox) focusMoved = true; };
        const pointedOutside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) focusMoved = true; };
        const leftWindow = () => { focusMoved = true; };
        const removeObservers = () => {
          document.removeEventListener('focusin', moved, true); document.removeEventListener('pointerdown', pointedOutside, true); win?.removeEventListener('blur', leftWindow);
        };
        if (ownedFocus) {
          document.addEventListener('focusin', moved, true); document.addEventListener('pointerdown', pointedOutside, true); win?.addEventListener('blur', leftWindow);
          removeFocusObserver = removeObservers;
        }
        checkbox.disabled = true; const next = checkbox.checked;
        try {
          if (!await commit({ type: 'boolean', value: next })) {
            checkbox.disabled = !editable; checkbox.checked = value.type === 'boolean' && value.value; checkbox.indeterminate = value.type === 'null';
          }
        } finally {
          if (ownedFocus) { removeObservers(); removeFocusObserver = undefined; }
          const active = document.activeElement;
          if (ownedFocus && !focusMoved && current() && (active === checkbox || active === document.body || active === document.documentElement)) {
            const replacement = element.querySelector<HTMLInputElement>('.metadata-input-checkbox');
            if (replacement && !replacement.disabled) replacement.focus();
          }
        }
      });
      element.append(checkbox);
    } else if (displayValue.type === 'null') {
      // Empty property presentation is distinct from expression string coercion.
      element.textContent = '';
    } else if (!diagnostic && (type === 'date' || type === 'datetime') && value.type !== 'null') {
      // Obsidian's shipped date widgets use native date controls with ISO values;
      // their visible order/separators come from Chromium's locale, not a slash
      // format string. Keep this inert display separate from the guarded draft.
      const date = document.createElement('input'); date.className = 'bases-property-date-display';
      date.type = type === 'date' ? 'date' : 'datetime-local'; date.readOnly = true; date.tabIndex = -1;
      date.setAttribute('aria-label', presentation.property.replace(/^note\./, ''));
      const source = displayValue.type === 'date' ? displayValue : value;
      const nativeValue = inputText(source, definition);
      date.value = type === 'datetime' ? nativeValue.replace(/(?:Z|[+-]\d{2}:\d{2})$/, '') : nativeValue;
      if (date.value) {
        const wrapper = document.createElement('span'); wrapper.className = 'bases-property-date';
        const calendar = icon('calendar', 16, document); calendar.classList.add('bases-property-date-icon');
        wrapper.append(calendar, date); element.append(wrapper);
      } else element.textContent = renderText(value);
    } else if (presentation.property === 'file.name' || presentation.property === 'file.file') {
      const link = document.createElement('a'); link.href = '#'; link.className = 'internal-link'; link.textContent = renderText(value);
      const open = (event: MouseEvent) => { if ((event.button === 0 || event.button === 1) && options.openFile && current()) { event.preventDefault(); event.stopPropagation(); options.openFile(presentation.row.path, event, presentation.row.entryId && presentation.row.revision ? { entryId: presentation.row.entryId, revision: presentation.row.revision } : undefined); } };
      link.addEventListener('click', open); link.addEventListener('auxclick', open); element.append(link);
    } else if (!editable && (displayValue.type === 'namespace' || displayValue.type === 'list' || displayValue.type === 'object')) {
      disposeRich = mountBaseRichValue(element, displayValue, { openFile: options.openFile, loadImage: options.loadImage ? (source, signal) => options.loadImage!(source, signal, presentation) : undefined, isCurrent: current, onError: report });
    } else if (!diagnostic && picker && value.type !== 'null') {
      const values = value.type === 'list' ? value.value.map(renderText) : [renderText(value)];
      for (const text of values) element.append(chip(text));
    } else if (!diagnostic && displayValue.type === 'namespace') {
      disposeRich = mountBaseRichValue(element, displayValue, { openFile: options.openFile, loadImage: options.loadImage ? (source, signal) => options.loadImage!(source, signal, presentation) : undefined, isCurrent: current, onError: report });
    } else element.textContent = renderText(displayValue);
  }
  function position() {
    if (!popup || inlineList) return;
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
    blurDuringComposition = false; compositionEpoch++;
    editing = false; closePopup(); draw(); element.focus();
  }
  function renderChoices() {
    if (!popup || !input) return;
    popup.querySelector('.suggestion-container')?.remove();
    if (inlineList) return;
    const list = document.createElement('div'); list.className = 'suggestion-container'; list.setAttribute('role', 'listbox'); list.id = `base-options-${Math.random().toString(36).slice(2)}`;
    input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'true');
    const needle = input.value.toLocaleLowerCase();
    const all = type === 'relation' || type === 'link'
      ? targets().map(target => ({ value: targetValue(target), label: target.label ?? target.path, missing: target.missing, target }))
      : (definition.options ?? []).map(option => ({ value: option.value, label: option.label ?? option.value, option }));
    choices = all.filter(choice => (!multiple || !draft.some((item, index) => item.text === choice.value && index !== editingIndex)) && (choice.label.toLocaleLowerCase().includes(needle) || choice.value.toLocaleLowerCase().includes(needle)));
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
    if (!list.children.length) { const empty = document.createElement('div'); empty.className = 'suggestion-empty'; empty.textContent = type === 'relation' && definition.relation?.targetFilter && options.getRelationTargets?.(presentation.property, acceptedPresentation) === undefined ? 'Relation choices are unavailable until the shared index is ready.' : type === 'link' ? 'Type a link or URL' : ['list', 'tags'].includes(type) ? 'Type a value and press Enter' : 'No matching options'; list.append(empty); }
    popup.append(list); position();
  }
  function validateRelationChoice(next: string, selected = type === 'relation'): boolean {
    // A plain link is still free text/URL input. Only selecting an offered note
    // acquires a captured target whose identity must remain current.
    if (type !== 'relation' && (type !== 'link' || !selected)) return true;
    try {
      const currentTargets = options.getRelationTargets?.(presentation.property, acceptedPresentation);
      if (!currentTargets) { error(new Error(`${type === 'link' ? 'Link' : 'Relation'} choices are unavailable; wait for the shared index before choosing a note.`)); return false; }
      const candidate = currentTargets.find(target => targetValue(target) === next), original = choices.find(choice => choice.value === next)?.target;
      if (!candidate || candidate.missing || (original && (original.entryId !== candidate.entryId || original.revision !== candidate.revision))) { error(new Error(`This ${type === 'link' ? 'link' : 'relation'} choice changed or is no longer available; choose from the refreshed results.`)); return false; }
      return true;
    } catch (failure) { error(failure); return false; }
  }
  async function choose(next: string) {
    if (!current() || pending || !validateRelationChoice(next, true)) return;
    if (choices.find(choice => choice.value === next)?.missing || ((type === 'relation' || type === 'link') && targetFor(next)?.missing)) { error(new Error('This related note is unavailable. Choose another note.')); return; }
    if (multiple) {
      const duplicate = draft.findIndex((item, index) => item.text === next && index !== editingIndex);
      if (duplicate >= 0) { popup?.querySelectorAll<HTMLElement>('.multi-select-pill')[duplicate]?.focus(); return; }
      if (editingIndex !== undefined) { if (draft[editingIndex].text !== next) { draft[editingIndex] = {text:next,value:str(next)}; draftChanged = true; } editingIndex = undefined; }
      else { draft.push({text:next,value:str(next)}); draftChanged = true; }
      if (input) input.value = ''; renderEditor(); input?.focus(); await saveDraft();
    }
    else await commit(str(next));
  }
  function removeChip(index: number) {
    if (editingIndex === index) { editingIndex = undefined; if (input) input.value = ''; }
    else if (editingIndex !== undefined && editingIndex > index) editingIndex--;
    draft.splice(index, 1); draftChanged = true; renderEditor(); input?.focus(); void saveDraft();
  }
  function editChip(index: number) {
    if (pending || !current() || !input || !multiple) return;
    editingIndex = index; input.value = draft[index].text; renderChoices(); input.focus(); input.select();
  }
  async function saveDraft() {
    if (multiple && draftChanged) await commit({ type: 'list', value: draft.map(item => item.value) }, true);
  }
  function renderEditor() {
    if (!popup || !input) return;
    let chips = popup.querySelector<HTMLElement>('.multi-select-container');
    if (!chips) { chips = document.createElement('div'); chips.className = 'multi-select-container'; popup.prepend(chips); }
    chips.replaceChildren(); if (multiple) draft.forEach((item, index) => chips!.append(chip(item.text, true, index))); chips.append(input); renderChoices();
  }
  async function finish(restoreFailureFocus = true) {
    if (!current() || !editing || pending || composing || !input) return;
    try {
      let next: BaseExpressionValue;
      if (picker) {
        if (multiple) {
          if (!draftChanged && !input.value) { cancel(); return; }
          if (input.value) {
            if (inlineList) {
              const duplicate = draft.findIndex((item, index) => item.text === input!.value && index !== editingIndex);
              if (duplicate >= 0) { error(new Error('This value is already in the list.')); return; }
              if (editingIndex !== undefined) { if (draft[editingIndex].text !== input.value) { draft[editingIndex] = {text:input.value,value:str(input.value)}; draftChanged = true; } editingIndex = undefined; }
              else { draft.push({text:input.value,value:str(input.value)}); draftChanged = true; }
            }
            else { error(new Error('Choose a matching option or clear the search before saving.')); return; }
          }
          next = { type: 'list', value: draft.map(item => item.value) };
        } else {
          if (input.value === inputText(value, definition)) { cancel(); return; }
          const choice = choices.find(choice => !choice.missing && (choice.value === input!.value || choice.label === input!.value));
          if (input.value && !choice && ['select', 'status', 'relation'].includes(type)) { error(new Error('Choose a matching option.')); return; }
          if (input.value && !validateRelationChoice(choice?.value ?? input.value, !!choice)) return;
          next = input.value ? str(choice?.value ?? input.value) : BASE_NULL;
        }
      } else {
        if (input.value === inputText(value, definition)) { cancel(); return; }
        next = parseBasePropertyInput(input.value, definition, value);
      }
      if (JSON.stringify(next) === JSON.stringify(value)) { cancel(); return; }
      await commit(next, false, restoreFailureFocus);
    } catch (failure) { error(failure); }
  }
  function begin(event: MouseEvent | KeyboardEvent) {
    if (!editable || !current() || pending || editing || options.canBegin?.() === false) return;
    if ((event.target as HTMLElement).closest('a,button,input,[role="link"]')) return;
    event.preventDefault(); event.stopPropagation(); editing = true; draftChanged = false; mark('draft');
    // Chip labels are editable text; untouched persisted values retain their
    // types and nested data until that specific chip is explicitly changed.
    draft = (value.type === 'list' ? value.value : value.type === 'null' ? [] : [value]).map(item => ({text:renderText(item),value:item}));
    input = document.createElement('input'); input.className = 'metadata-input metadata-input-text'; input.setAttribute('aria-label', presentation.property.replace(/^note\./, '')); input.placeholder = 'Empty';
    input.type = basePropertyValueDiagnostic(value, definition) || (type === 'datetime' && value.type === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value.value)) ? 'text' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : 'text';
    if (type === 'date' || type === 'datetime') input.max = type === 'date' ? '9999-12-31' : '9999-12-31T23:59:59';
    if (type === 'number') input.inputMode = 'decimal';
    input.value = multiple ? '' : inputText(value, definition);
    input.addEventListener('focus', () => { blurDuringComposition = false; compositionEpoch++; });
    input.addEventListener('compositionstart', () => { composing = true; blurDuringComposition = false; compositionEpoch++; });
    input.addEventListener('compositionend', () => {
      composing = false;
      const blurred = blurDuringComposition, epoch = compositionEpoch; blurDuringComposition = false;
      // The final input event follows compositionend. A retained blur must still
      // finish when a synthetic/native blur leaves activeElement on this input.
      later(() => { if (epoch !== compositionEpoch) return; if (picker) renderChoices(); if (blurred || (!element.contains(document.activeElement) && !popup?.contains(document.activeElement))) void finish(); });
    });
    input.addEventListener('input', () => { input?.removeAttribute('aria-invalid'); if (picker && !composing) { selected = 0; renderChoices(); } });
    input.addEventListener('blur', () => { if (composing) { blurDuringComposition = true; return; } later(() => { if (!element.contains(document.activeElement) && !popup?.contains(document.activeElement)) void finish(); }); });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (composing || event.isComposing || pending) return;
      if (event.key === 'Escape') { event.preventDefault(); if (editingIndex !== undefined) { const index = editingIndex; editingIndex = undefined; if (input) input.value = ''; renderChoices(); popup?.querySelectorAll<HTMLElement>('.multi-select-pill')[index]?.focus(); } else cancel(); }
      else if (picker && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; let next = selected + direction; while (next >= 0 && next < choices.length && choices[next].missing) next += direction; if (next >= 0 && next < choices.length) selected = next; renderChoices(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (picker && choices[selected] && !choices[selected].missing && input?.value) void choose(choices[selected].value);
        else if (multiple && input?.value && ['list', 'tags'].includes(type)) void choose(input.value);
        else void finish();
      } else if (multiple && (event.key === 'Backspace' || event.key === 'ArrowLeft') && !input?.value && draft.length) { event.preventDefault(); popup?.querySelectorAll<HTMLElement>('.multi-select-pill')[draft.length - 1]?.focus(); }
      else if (event.key === 'Tab') { void finish(false); }
    });
    if (picker) {
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
      popup = document.createElement('div'); popup.className = inlineList ? 'bases-property-inline-editor' : 'bases-property-popover popover';
      propertyPopoverOwners.set(popup,element);
      if (inlineList) element.replaceChildren(popup); else document.body.append(popup); renderEditor(); document.addEventListener('pointerdown', outside, true); win?.addEventListener('resize', position); win?.addEventListener('scroll', position, true);
    } else element.replaceChildren(input);
    input.focus(); if (!multiple) input.select();
  }
  const activate = (event: MouseEvent) => { if (!event.defaultPrevented && event.button === 0) begin(event); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending && type === 'checkbox' && element.hasAttribute('data-base-editing')) { event.preventDefault(); draw(); return; } if (!event.defaultPrevented && !event.isComposing && event.target === element && ['Enter', 'F2'].includes(event.key)) begin(event); };
  element.addEventListener('click', activate); element.addEventListener('dblclick', activate); element.addEventListener('keydown', key); draw();
  return () => { disposed = true; delete element.dataset.baseWidgetVersion; delete element.dataset.basePropertyEditable; element.removeAttribute('aria-disabled'); removeFocusObserver?.(); removeFocusObserver = undefined; disposeRich?.(); disposeRich = undefined; closePopup(); timers.forEach(clearTimeout); timers.clear(); mark(); element.removeEventListener('click', activate); element.removeEventListener('dblclick', activate); element.removeEventListener('keydown', key); };
}
