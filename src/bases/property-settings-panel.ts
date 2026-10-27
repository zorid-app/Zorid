import { BASE_PROPERTY_TYPES, basePropertyName, validateBasePropertyDefinition } from './property-definitions.ts';
import type { BasePropertyDefinition, BasePropertyDefinitions, BasePropertyOption, BasePropertyType } from './property-definitions.ts';

export interface BasePropertySettingsPanel {
  open(property?: string, anchor?: HTMLElement, type?: BasePropertyType): void;
  hasDraft(): boolean;
  destroy(): void;
}
/** Rich definitions are an explicit Zorid extension; surrounding controls share
 * the Bases popover conventions. No metadata is written until Apply succeeds. */
export function createBasePropertySettingsPanel(container: HTMLElement, options: {
  definitions(): BasePropertyDefinitions;
  properties(): readonly string[];
  save(property: string, definition: BasePropertyDefinition | null, expected: BasePropertyDefinition | null): Promise<void>;
  preflight(): void;
  onDraftChange(): void;
  onError(error: unknown): void;
}): BasePropertySettingsPanel {
  const doc = container.ownerDocument, win = doc.defaultView;
  let panel: HTMLElement | undefined, dirty = false, pending = false;
  let cleanup: (() => void) | undefined;
  const close = (restore = true) => { if (pending) return; cleanup?.(); cleanup = undefined; panel?.remove(); panel = undefined; dirty = false; options.onDraftChange(); void restore; };
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const open = (initial?: string, anchor?: HTMLElement, initialType?: BasePropertyType) => {
    options.preflight(); if (panel && dirty) throw new Error('Apply or cancel the property settings first.'); close(false);
    panel = element('section'); panel.className = 'bases-toolbar-popover bases-property-settings'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Property settings');
    panel.append(element('h3', 'Property settings'));
    const form = element('form'), fields = element('fieldset'); fields.className = 'bases-toolbar-fields'; fields.style.border = '0'; fields.style.margin = '0';
    const property = element('input'); property.setAttribute('aria-label', 'Property name'); property.placeholder = 'Property name'; property.value = initial ? basePropertyName(initial) : '';
    const list = element('datalist'); list.id = `bases-property-names-${Math.random().toString(36).slice(2)}`;
    for (const name of new Set([...options.properties().filter(name => name.startsWith('note.')).map(basePropertyName), ...Object.keys(options.definitions().properties)])) { const option = element('option'); option.value = name; list.append(option); }
    property.setAttribute('list', list.id); fields.append(property, list);
    const type = element('select'); type.setAttribute('aria-label', 'Property type');
    const labels: Partial<Record<BasePropertyType, string>> = { multiselect: 'Multiselect', datetime: 'Date and time', reverseRelation: 'Reverse relation' };
    for (const value of BASE_PROPERTY_TYPES) { const option = element('option', labels[value] ?? value[0].toUpperCase() + value.slice(1)); option.value = value; type.append(option); }
    fields.append(type);
    const detail = element('div'); detail.className = 'bases-property-definition-fields'; fields.append(detail);
    const error = element('div'); error.className = 'bases-toolbar-error'; error.setAttribute('role', 'alert');
    const footer = element('div'); footer.className = 'bases-toolbar-footer';
    const cancel = element('button', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => close());
    const remove = element('button', 'Remove settings'); remove.type = 'button';
    const apply = element('button', 'Apply'); apply.type = 'submit'; apply.className = 'mod-cta'; footer.append(remove, cancel, apply); form.append(fields, error, footer); panel.append(form); doc.body.append(panel);
    let expected: BasePropertyDefinition | null = null;
    const detailDrafts = new Map<string, { definition: BasePropertyDefinition; expected: BasePropertyDefinition | null }>();
    let activeProperty = property.value, activeType: BasePropertyType = 'text';
    const remember = () => detailDrafts.set(`${activeProperty}\0${activeType}`, { definition: readDetail(), expected });
    let definition: BasePropertyDefinition = { type: 'text' }, readDetail = () => definition;
    const input = (label: string, value = '') => { const wrapper = element('label', label), node = element('input'); node.value = value; node.setAttribute('aria-label', label); wrapper.append(node); detail.append(wrapper); return node; };
    const draw = () => {
      detail.replaceChildren(); const kind = type.value as BasePropertyType;
      if (['select', 'multiselect', 'status'].includes(kind)) {
        const rows = element('div'); rows.className = 'bases-property-option-settings'; detail.append(rows);
        const selected: BasePropertyOption[] = [...definition.options ?? []];
        const renderOptions = () => { rows.replaceChildren(); selected.forEach((option, index) => {
          const row = element('div'); row.className = 'bases-property-option-row';
          const value = element('input'); value.value = option.value; value.setAttribute('aria-label', 'Stored option value');
          // Renaming the label preserves readable stored values and their identity.
          const label = element('input'); label.value = option.label ?? option.value; label.setAttribute('aria-label', 'Option label');
          const color = element('select'); color.setAttribute('aria-label', 'Option color');
          for (const name of ['', 'gray', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'brown']) { const item = element('option', name || 'Default'); item.value = name; color.append(item); } color.value = option.color ?? '';
          const category = element('select'); category.setAttribute('aria-label', 'Status category'); for (const name of ['todo', 'in-progress', 'done']) { const item = element('option', name); item.value = name; category.append(item); } category.value = option.category ?? 'todo';
          const sync = () => { selected[index] = { ...selected[index], value: value.value, label: label.value || undefined, color: color.value || undefined, ...(kind === 'status' ? { category: category.value as 'todo' | 'in-progress' | 'done' } : {}) }; };
          for (const node of [value, label, color, category]) node.addEventListener('input', sync);
          const up = element('button', '↑'); up.type = 'button'; up.setAttribute('aria-label', 'Move option up'); up.disabled = index === 0; up.addEventListener('click', () => { [selected[index - 1], selected[index]] = [selected[index], selected[index - 1]]; dirty = true; renderOptions(); });
          const down = element('button', '↓'); down.type = 'button'; down.setAttribute('aria-label', 'Move option down'); down.disabled = index === selected.length - 1; down.addEventListener('click', () => { [selected[index + 1], selected[index]] = [selected[index], selected[index + 1]]; dirty = true; renderOptions(); });
          const del = element('button', '×'); del.type = 'button'; del.setAttribute('aria-label', 'Remove option'); del.addEventListener('click', () => { selected.splice(index, 1); dirty = true; renderOptions(); });
          row.append(value, label, color); if (kind === 'status') row.append(category); row.append(up, down, del); rows.append(row);
        }); };
        renderOptions(); const add = element('button', 'Add option'); add.type = 'button'; add.addEventListener('click', () => { selected.push({ value: '' }); dirty = true; renderOptions(); }); detail.append(add);
        detail.append(element('p', 'Changing a stored value leaves existing note values unchanged. Rename display labels to preserve membership. Removing an option preserves existing note values.'));
        readDetail = () => ({ type: kind, options: selected });
      } else if (kind === 'relation') {
        detail.append(element('p', 'Relations store readable note links. Renaming in Zorid updates links; external moves may require repair. Deleting a target preserves its links.'));
        const filter = input('Target filter', definition.relation?.targetFilter), multiple = input('Allow multiple'); multiple.type = 'checkbox'; multiple.checked = !!definition.relation?.multiple;
        readDetail = () => {
          const relation = { ...definition.relation, multiple: multiple.checked };
          if (filter.value) relation.targetFilter = filter.value; else delete relation.targetFilter;
          return { type: kind, relation };
        };
      } else if (kind === 'reverseRelation') {
        const source = input('Source relation property', definition.reverseRelation?.property); readDetail = () => ({ type: kind, reverseRelation: { ...definition.reverseRelation, property: source.value } });
      } else if (kind === 'rollup') {
        const relation = input('Relation property', definition.rollup?.relation), target = input('Related property', definition.rollup?.property), aggregation = element('select'); aggregation.setAttribute('aria-label', 'Aggregation');
        for (const value of ['count', 'sum', 'average', 'min', 'max', 'values', 'unique']) { const option = element('option', value); option.value = value; aggregation.append(option); } aggregation.value = definition.rollup?.aggregation ?? 'count'; detail.append(aggregation);
        readDetail = () => {
          const rollup = { ...definition.rollup, relation: relation.value, aggregation: aggregation.value as NonNullable<BasePropertyDefinition['rollup']>['aggregation'] };
          if (target.value) rollup.property = target.value; else delete rollup.property;
          return { type: kind, rollup };
        };
      } else readDetail = () => ({ type: kind });
    };
    const load = () => { expected = options.definitions().properties[property.value] ?? null; definition = expected ?? { type: 'text' }; if (initialType) { definition = { ...definition, type: initialType }; initialType = undefined; dirty = true; } activeProperty = property.value; activeType = definition.type; const cached = detailDrafts.get(`${activeProperty}\0${activeType}`); if (cached) { definition = cached.definition; expected = cached.expected; } type.value = definition.type; draw(); };
    property.addEventListener('change', () => { remember(); load(); }); type.addEventListener('change', () => { remember(); activeType = type.value as BasePropertyType; const cached = detailDrafts.get(`${activeProperty}\0${activeType}`); definition = cached?.definition ?? { ...definition, type: activeType }; if (cached) expected = cached.expected; draw(); dirty = true; options.onDraftChange(); }); load();
    form.addEventListener('input', () => { dirty = true; options.onDraftChange(); });
    const save = async (definition: BasePropertyDefinition | null) => { if (pending) return; pending = true; fields.disabled = true; apply.disabled = remove.disabled = cancel.disabled = true;
      try { if (!property.value.trim()) throw new Error('Enter a property name.'); if (definition) validateBasePropertyDefinition(definition); await options.save(property.value.trim(), definition, expected); pending = false; close(); }
      catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); dirty = true; options.onError(failure); }
      finally { pending = false; fields.disabled = false; apply.disabled = remove.disabled = cancel.disabled = false; options.onDraftChange(); }
    };
    form.addEventListener('submit', event => { event.preventDefault(); void save(readDetail()); }); remove.addEventListener('click', () => { void save(null); });
    const place = () => { if (!panel) return; const rect = anchor?.getBoundingClientRect(); panel.style.left = `${Math.max(8, Math.min(rect?.left ?? (win?.innerWidth ?? 800) / 2 - 240, (win?.innerWidth ?? 800) - 488))}px`; panel.style.top = `${Math.max(8, Math.min(rect?.bottom ?? 80, (win?.innerHeight ?? 600) - panel.offsetHeight - 8))}px`; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing && panel?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); close(); } };
    const outside = (event: Event) => { if (!dirty && !pending && !panel?.contains(event.target as Node)) close(false); };
    doc.addEventListener('keydown', key, true); doc.addEventListener('pointerdown', outside, true); win?.addEventListener('resize', place);
    cleanup = () => { doc.removeEventListener('keydown', key, true); doc.removeEventListener('pointerdown', outside, true); win?.removeEventListener('resize', place); if (anchor?.isConnected) anchor.focus({ preventScroll: true }); };
    place(); property.focus();
  };
  return { open, hasDraft: () => !!panel && (dirty || pending), destroy() { if (!pending) close(false); } };
}
