import { readProperties, removeProperty, renameProperty, setProperty, validatePropertyValue } from '../core/properties.ts';
import type { Property, PropertyType, PropertyValue } from '../core/properties.ts';

export interface PropertiesOptions {
  getSource: () => string;
  onChange: (next: string) => Promise<void> | void;
  openLink?: (target: string) => void;
}
export interface PropertiesView { refresh(): void; destroy(): void }

const types: PropertyType[] = ['text', 'list', 'number', 'checkbox', 'date', 'datetime', 'tags', 'unknown'];
const labels: Record<PropertyType, string> = {
  text: 'Text', list: 'List', number: 'Number', checkbox: 'Checkbox', date: 'Date',
  datetime: 'Date & time', tags: 'Tags', unknown: 'Other (JSON)',
};
interface Row {
  key: string;
  property: Property;
  element: HTMLElement;
  keyInput: HTMLInputElement;
  selector: HTMLSelectElement;
  value: HTMLElement;
  error: HTMLElement;
  dirty: boolean;
  revision: number;
  renderedType?: PropertyType;
  renderedValue?: string;
}

/** Original functional properties editor. Type choices are local until a vault registry is available. */
export function renderProperties(container: HTMLElement, options: PropertiesOptions): PropertiesView {
  const document = container.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (label: string, className = '') => {
    const node = element('button', className, label); node.type = 'button'; return node;
  };
  const selectType = (label: string, current: PropertyType) => {
    const node = element('select', 'metadata-property-type'); node.setAttribute('aria-label', label);
    for (const type of types) { const option = element('option', '', labels[type]); option.value = type; node.append(option); }
    node.value = current; return node;
  };
  const root = element('div', 'metadata-container'); root.setAttribute('aria-label', 'Properties');
  const heading = element('div', 'metadata-properties-heading', 'Properties');
  const rowsContainer = element('div', 'metadata-content');
  const globalError = element('div', 'metadata-error'); globalError.setAttribute('role', 'alert'); globalError.hidden = true;
  const addButton = button('Add property', 'metadata-add-button');
  root.append(heading, rowsContainer, globalError, addButton); container.append(root);
  const rows = new Map<string, Row>(), selectedTypes = new Map<string, PropertyType>();
  let destroyed = false, pending = Promise.resolve(), addForm: HTMLElement | undefined;

  function error(target: HTMLElement, problem?: unknown): void {
    target.textContent = problem ? problem instanceof Error ? problem.message : String(problem) : '';
    target.hidden = !problem;
  }
  function current(source: string, row: Row): Property {
    const property = readProperties(source).find(item => item.key === row.key);
    if (!property) throw new Error(`Property was removed or renamed: ${row.key}`);
    return property;
  }
  function commit(target: HTMLElement, operation: (source: string) => string, success?: () => void): void {
    pending = pending.then(async () => {
      if (destroyed) return;
      error(target);
      try {
        const source = options.getSource(), next = operation(source);
        if (next !== source) await options.onChange(next);
        if (destroyed) return;
        success?.(); refresh();
      } catch (problem) { if (!destroyed) { refresh(); error(target, problem); } }
    });
  }
  function typeFor(property: Property): PropertyType { return selectedTypes.get(property.key) ?? property.type; }
  function edited(row: Row): void { row.dirty = true; row.revision++; }
  function acknowledge(row: Row, revision: number): boolean {
    if (row.revision !== revision) return false;
    row.dirty = false; return true;
  }
  function setValue(row: Row, value: unknown, type = typeFor(row.property)): void {
    const revision = row.revision;
    commit(row.error, source => { current(source, row); return setProperty(source, row.key, value, type); }, () => { acknowledge(row, revision); });
  }
  function listValues(property: Property): string[] {
    return property.value === null ? [] : Array.isArray(property.value) ? property.value as string[] : [String(property.value)];
  }
  function convert(value: PropertyValue, type: PropertyType): PropertyValue {
    let next = value;
    if (value !== null) {
      if (type === 'text' && ['string', 'number', 'boolean'].includes(typeof value)) next = String(value);
      else if (type === 'number' && typeof value === 'string' && value.trim()) next = Number(value);
      else if (type === 'checkbox' && (value === 'true' || value === 'false')) next = value === 'true';
      else if ((type === 'list' || type === 'tags') && typeof value === 'string') next = [value];
    }
    validatePropertyValue(type, next); return next;
  }

  function renderValue(row: Row): void {
    const type = typeFor(row.property), value = row.property.value;
    const signature = JSON.stringify(value);
    if (row.renderedType === type && row.renderedValue === signature) return;
    // Preserve selection and unsubmitted edits during background refreshes.
    const focused = row.value.contains(document.activeElement) ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
    if (row.dirty || (focused && type !== 'list' && type !== 'tags')) return;
    const focusLabel = focused?.getAttribute('aria-label');
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    row.renderedType = type; row.renderedValue = signature; row.value.replaceChildren();
    const aria = `${row.key} value`;
    if (type === 'list' || type === 'tags') {
      const items = listValues(row.property);
      const list = element('div', 'metadata-list');
      items.forEach((item, index) => {
        let baseline = item;
        const chip = element('div', 'metadata-list-item');
        const input = element('textarea', 'metadata-input metadata-list-input'); input.rows = 1; input.value = item;
        input.setAttribute('aria-label', `${row.key} item ${index + 1}`);
        input.addEventListener('input', () => edited(row));
        input.addEventListener('change', () => {
          const next = input.value, revision = row.revision;
          commit(row.error, source => {
            const values = listValues(current(source, row));
            if (values[index] !== baseline && values[index] !== next) throw new Error('This list item changed outside the properties editor');
            values[index] = next; return setProperty(source, row.key, values, type);
          }, () => { baseline = next; acknowledge(row, revision); });
        });
        const remove = button('×', 'metadata-list-remove'); remove.setAttribute('aria-label', `Remove ${row.key} item ${index + 1}`);
        remove.addEventListener('click', () => commit(row.error, source => {
          const values = listValues(current(source, row));
          if (values[index] !== baseline) throw new Error('This list item changed outside the properties editor');
          values.splice(index, 1); return setProperty(source, row.key, values, type);
        }, () => { row.dirty = false; }));
        chip.append(input, remove); list.append(chip);
      });
      const input = element('input', 'metadata-input metadata-list-new'); input.placeholder = 'Add value'; input.setAttribute('aria-label', `Add ${row.key} value`);
      const add = button('+', 'metadata-list-add'); add.setAttribute('aria-label', `Add value to ${row.key}`);
      const append = () => {
        if (!input.value) return;
        const value = input.value, revision = row.revision;
        commit(row.error, source => setProperty(source, row.key, [...listValues(current(source, row)), value], type), () => { if (acknowledge(row, revision)) input.value = ''; });
      };
      input.addEventListener('input', () => edited(row));
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); append(); } });
      add.addEventListener('click', append);
      list.append(input, add); row.value.append(list);
    } else if (type === 'checkbox') {
      const input = element('input', 'metadata-input metadata-checkbox'); input.type = 'checkbox'; input.checked = value === true; input.indeterminate = value === null;
      input.setAttribute('aria-label', aria); input.addEventListener('change', () => { edited(row); input.indeterminate = false; setValue(row, input.checked, type); });
      row.value.append(input);
    } else {
      // Text input for dates avoids native controls silently dropping offsets/invalid drafts.
      const input = type === 'unknown' ? element('textarea', 'metadata-input metadata-json') : element('input', 'metadata-input');
      input.setAttribute('aria-label', aria);
      input.value = value === null ? '' : type === 'unknown' ? JSON.stringify(value, null, 2) : String(value);
      if (type === 'number') input.setAttribute('inputmode', 'decimal');
      if (type === 'date') input.setAttribute('placeholder', 'YYYY-MM-DD');
      if (type === 'datetime') input.setAttribute('placeholder', 'YYYY-MM-DDTHH:mm');
      input.addEventListener('input', () => edited(row));
      const save = () => {
        try {
          let value: unknown = input.value;
          if (type === 'unknown') value = input.value.trim() ? JSON.parse(input.value) : null;
          else if (type === 'number') value = input.value.trim() ? Number(input.value) : null;
          else if (type === 'date' || type === 'datetime') value = input.value || null;
          validatePropertyValue(type, value); setValue(row, value, type);
        } catch (problem) { error(row.error, problem); }
      };
      input.addEventListener('change', save);
      input.addEventListener('keydown', event => {
        const key = (event as KeyboardEvent).key;
        if (key === 'Enter' && input.tagName === 'INPUT') { event.preventDefault(); save(); }
        if (key === 'Escape') { row.dirty = false; input.blur(); row.renderedValue = undefined; renderValue(row); error(row.error); }
      });
      row.value.append(input);
      if (options.openLink && typeof value === 'string') {
        const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(value);
        if (match) {
          const link = button('Open link', 'metadata-link'); link.addEventListener('click', () => options.openLink!(match[1])); row.value.append(link);
        }
      }
    }
    if (focusLabel) {
      const replacement = [...row.value.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
        .find(input => input.getAttribute('aria-label') === focusLabel);
      replacement?.focus();
      if (replacement && selection && selection[0] !== null && selection[1] !== null) replacement.setSelectionRange(selection[0], selection[1]);
    }
  }

  function createRow(property: Property): Row {
    const row: Row = {
      key: property.key, property, element: element('div', 'metadata-property'),
      keyInput: element('input', 'metadata-property-key-input'), selector: selectType(`${property.key} type`, typeFor(property)),
      value: element('div', 'metadata-property-value'), error: element('div', 'metadata-property-error'), dirty: false, revision: 0,
    };
    row.element.dataset.propertyKey = property.key; row.keyInput.value = property.key;
    row.keyInput.setAttribute('aria-label', `${property.key} name`); row.error.setAttribute('role', 'alert'); row.error.hidden = true;
    row.value.addEventListener('focusout', () => {
      // Wait for change handling to capture drafts before a background value refresh.
      queueMicrotask(() => { if (!destroyed && !row.dirty) renderValue(row); });
    });
    row.keyInput.addEventListener('change', () => {
      const newKey = row.keyInput.value;
      commit(row.error, source => renameProperty(source, row.key, newKey), () => {
        const oldKey = row.key; rows.delete(oldKey); rows.set(newKey, row); row.key = newKey;
        const type = selectedTypes.get(oldKey); selectedTypes.delete(oldKey); if (type) selectedTypes.set(newKey, type);
        row.renderedValue = undefined;
      });
    });
    row.selector.addEventListener('change', () => {
      const type = row.selector.value as PropertyType;
      commit(row.error, source => {
        const property = current(source, row);
        return setProperty(source, row.key, convert(property.value, type), type);
      }, () => { selectedTypes.set(row.key, type); row.dirty = false; row.renderedValue = undefined; });
    });
    const remove = button('×', 'metadata-property-remove'); remove.setAttribute('aria-label', `Remove ${property.key}`);
    remove.addEventListener('click', () => commit(row.error, source => removeProperty(source, row.key), () => { selectedTypes.delete(row.key); }));
    row.element.append(row.selector, row.keyInput, row.value, remove, row.error); return row;
  }

  function refresh(): void {
    if (destroyed) return;
    let properties: Property[];
    try { properties = readProperties(options.getSource()); error(globalError); addButton.disabled = false; }
    catch (problem) { error(globalError, problem); addButton.disabled = true; return; }
    const keys = new Set(properties.map(property => property.key));
    for (const [key, row] of rows) if (!keys.has(key)) { row.element.remove(); rows.delete(key); selectedTypes.delete(key); }
    properties.forEach((property, index) => {
      let row = rows.get(property.key);
      if (!row) { row = createRow(property); rows.set(property.key, row); }
      row.property = property; row.element.dataset.propertyKey = property.key;
      if (document.activeElement !== row.keyInput) row.keyInput.value = property.key;
      row.keyInput.setAttribute('aria-label', `${property.key} name`); row.selector.setAttribute('aria-label', `${property.key} type`);
      row.element.querySelector('.metadata-property-remove')?.setAttribute('aria-label', `Remove ${property.key}`);
      row.selector.value = typeFor(property); renderValue(row);
      // Reinsert only when order actually changed, preserving DOM focus and selection.
      if (rowsContainer.children[index] !== row.element) rowsContainer.insertBefore(row.element, rowsContainer.children[index] ?? null);
    });
  }

  addButton.addEventListener('click', () => {
    if (destroyed || addForm) return;
    addForm = element('div', 'metadata-add-form');
    const name = element('input', 'metadata-property-key-input'); name.placeholder = 'Property name'; name.setAttribute('aria-label', 'New property name');
    const selector = selectType('New property type', 'text');
    const add = button('Add'), cancel = button('Cancel');
    const create = () => {
      const key = name.value, type = selector.value as PropertyType;
      commit(globalError, source => {
        if (readProperties(source).some(property => property.key === key)) throw new Error(`Property already exists: ${key}`);
        return setProperty(source, key, null, type);
      }, () => { selectedTypes.set(key, type); addForm?.remove(); addForm = undefined; });
    };
    add.addEventListener('click', create);
    name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); create(); } });
    cancel.addEventListener('click', () => { addForm?.remove(); addForm = undefined; addButton.focus(); });
    addForm.append(name, selector, add, cancel); root.append(addForm); name.focus();
  });
  refresh();
  return { refresh, destroy() { if (destroyed) return; destroyed = true; rows.clear(); selectedTypes.clear(); root.remove(); } };
}
