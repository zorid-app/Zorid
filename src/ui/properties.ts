import { readProperties, removeProperty, renameProperty, setProperty, validatePropertyValue } from '../core/properties.ts';
import type { Property, PropertyType, PropertyValue } from '../core/properties.ts';
import { dismissContextMenu, showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { clearProperties, sortProperties } from './property-menus.ts';
import type { Vault } from '../core/vault.ts';
import { baseExpressionValue } from '../bases/expression.ts';
import type { BaseExpressionValue } from '../bases/expression.ts';
import type { BasePropertyDefinition } from '../bases/property-definitions.ts';
import { basePropertyPopoverOwner,mountBasePropertyWidget,canCaptureBasePropertyRawDraft,captureBasePropertyRawDraft,restoreBasePropertyRawDraft } from '../bases/property-widgets.ts';
import type { BaseRelationTarget,BasePropertyRawDraft } from '../bases/property-widgets.ts';

export interface PropertiesOptions {
  getSource: () => string;
  /** Vault access supplies file/link controls only; it never discovers a schema. */
  vault?: Vault;
  path?: string;
  /** Explicit collection-scoped definitions supplied by the current owner. */
  getDefinitions?: () => Readonly<Record<string, BasePropertyDefinition>>;
  /** Join the fresh owner's authoritative collection/schema read before restoring raw controls. */
  prepareAdmissionRestore?: () => Promise<void>;
  /** Stable collection writer, null for an established nonmember, undefined while unknown. */
  getAdmissionWriterIdentity?: () => string | null | undefined;
  /** Managed membership/identities cannot be edited as ordinary YAML keys. */
  isManaged?: () => boolean;
  /** Workspace notes show this panel only for authoritative collection members. */
  managedOnly?: boolean;
  /** Keep an outer host's spacing in sync with the panel's presentation. */
  onVisibilityChange?: (visible: boolean) => void;
  collectionName?: () => string | undefined;
  /** Managed hosts own collection schema authoring and its pending picker. */
  onAddProperty?: (anchor: HTMLElement) => Promise<void> | void;
  /** Add one choice through the managed schema owner without enabling conversion. */
  onCreateOption?: (property: string, label: string) => Promise<void> | void;
  onPropertyDefinitionChange?: (property: string, definition: BasePropertyDefinition) => Promise<void> | void;
  /** Optional Rust-filtered targets. A filtered relation is never evaluated locally. */
  getRelationTargets?: (property: string, definition: BasePropertyDefinition) => readonly BaseRelationTarget[] | undefined;
  /** Core-derived display only after the owner verifies the saved actor and raw
   * property baseline. Undefined keeps the exact raw property display. */
  getDisplayValue?: (property: string, raw: BaseExpressionValue) => BaseExpressionValue | undefined;
  onChange: (next: string) => Promise<void> | void;
  openLink?: (target: string, witness?: { readonly entryId: string; readonly revision: string }) => void;
  showMenu?: typeof showContextMenu;
  dismissMenu?: typeof dismissContextMenu;
  writeClipboard?: (text: string) => Promise<void> | void;
  onError?: (error: unknown) => void;
  /** Optional owner identity guard for a host that reuses a panel across files. */
  isCurrent?: () => boolean;
}
/** Component-owned RAM state only; restoring it never accepts a property edit. */
export interface PropertiesRawControl {
  readonly kind: 'key' | 'value'; readonly index: number; readonly tag: string; readonly inputType?: string;
  readonly value: string; readonly checked?: boolean; readonly indeterminate?: boolean;
  readonly focused: boolean; readonly selectionStart: number | null; readonly selectionEnd: number | null;
  readonly selectionDirection: 'forward' | 'backward' | 'none' | null;
}
export interface PropertiesRawDrafts {
  readonly identity: {readonly path?: string; readonly entryId?: string; readonly revision?: string};
  readonly rows: readonly {readonly key:string;readonly valueFingerprint:string;readonly definitionFingerprint?:string;
    readonly type:PropertyType;readonly managed:boolean;readonly writerGuarded:boolean;readonly writerIdentity?:string|null;readonly controls:readonly PropertiesRawControl[];readonly widget?:BasePropertyRawDraft}[];
  readonly addForm?: {readonly propertiesFingerprint:string;readonly managed:boolean;readonly writerGuarded:boolean;readonly writerIdentity?:string|null;readonly name:PropertiesRawControl;readonly type:string};
}
export interface PropertiesRawConflict {readonly draft:PropertiesRawDrafts;readonly reason:string}
export interface PropertiesAdmissionRecovery {readonly rawDrafts:PropertiesRawDrafts;settle():Promise<void>}
export interface PropertiesView {
  refresh(): void;
  canRecoverAdmission?(): boolean;
  prepareAdmissionRestore?(): Promise<void>;
  prepareAdmissionRecovery?(): PropertiesAdmissionRecovery;
  restoreAdmissionDrafts?(drafts:PropertiesRawDrafts, options?:{focus?:boolean}): {restored:boolean;pending:boolean;conflicts:readonly PropertiesRawConflict[]};
  /** Includes accepted queued writes and unsubmitted scalar/list/name drafts. */
  hasPendingChanges(): boolean;
  /** Settle accepted writes; unresolved input stays mounted for correction. */
  flush(): Promise<void>;
  /** Only this panel and rich-property portals opened by its exact rows. */
  owns(node:Node):boolean;
  destroy(): void;
}

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
  renderedDefinition?: string;
  renderedDisplay?: string;
  renderedManaged?:boolean;renderedWriterIdentity?:string|null;
  disposeWidget?: () => void;
}

/** Property edits always apply to the latest buffer source. Shared definitions
 * enhance controls without replacing the note or its unsaved body. */
export function renderProperties(container: HTMLElement, options: PropertiesOptions): PropertiesView {
  const document = container.ownerDocument;
  const mountedEntry=options.path?options.vault?.entries.get(options.path):undefined;
  const mountedIdentity=Object.freeze({path:options.path,entryId:mountedEntry?.entryId,revision:mountedEntry?.revision});
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (label: string, className = '') => {
    const node = element('button', className, label); node.type = 'button'; return node;
  };
  const selectType = (label: string, current: string) => {
    const node = element('select', 'metadata-property-type'); node.setAttribute('aria-label', label);
    for (const type of types) { const option = element('option', '', labels[type]); option.value = type; node.append(option); }
    if (options.getDefinitions && options.onPropertyDefinitionChange) for (const [type, label] of [['link', 'Link'], ['select', 'Select'], ['multiselect', 'Multiselect'], ['status', 'Status'], ['relation', 'Relation'], ['reverseRelation', 'Reverse relation'], ['rollup', 'Rollup']]) { const option = element('option', '', label); option.value = type; node.append(option); }
    node.value = current; return node;
  };
  const root = element('div', 'metadata-container'); root.setAttribute('aria-label', 'Properties');
  const heading = element('div', 'metadata-properties-heading', 'Properties'); heading.tabIndex = 0;
  const rowsContainer = element('div', 'metadata-content');
  const globalError = element('div', 'metadata-error'); globalError.setAttribute('role', 'alert'); globalError.hidden = true;
  const addButton = button('Add property', 'metadata-add-button');
  root.append(heading, rowsContainer, globalError, addButton); container.append(root);
  const restoredPassiveRows=new Set<Row>();
  const rows = new Map<string, Row>(), selectedTypes = new Map<string, PropertyType>();
  let frozen = false;
  let recovery:PropertiesAdmissionRecovery|undefined;
  let destroyed = false, pending = Promise.resolve(), addForm: HTMLElement | undefined, addingManagedProperty = false;
  let addFormBaseline:{propertiesFingerprint:string;managed:boolean;writerGuarded:boolean;writerIdentity?:string|null}|undefined;
  let pendingGeneration=0,settledGeneration=0,mutationFailure:unknown,mutationFailureOwner:Row|undefined;
  // A canceled search cannot establish the outcome of an uncertain schema write.
  const retainedOptionFailures = new Map<Row, Map<string, unknown>>();
  const releasedWidgetRows = new Set<Row>();
  const clearOptionFailure = (row: Row, label: string) => {
    const failures=retainedOptionFailures.get(row);failures?.delete(label);
    if(!failures?.size)retainedOptionFailures.delete(row);
  };
  function setPending(operation:Promise<void>):void {
    pending=operation;const generation=++pendingGeneration;
    const settled=()=>{settledGeneration=Math.max(settledGeneration,generation);clearReleasedWidgetErrors();};void operation.then(settled,settled);
  }
  let menuSerial = 0, menuPending = false;
  let definitions: Readonly<Record<string, BasePropertyDefinition>> = {};
  let definitionLoad = 0;
  const unsubscribers: (() => void)[] = [];
  const definitionFor = (key: string) => Object.hasOwn(definitions, key) ? definitions[key] : undefined;
  const managedKey=(key:string)=>!!options.isManaged?.()&&(key==='_id'||key==='_type'||!!definitionFor(key));
  const showMenu = options.showMenu ?? showContextMenu;
  const clipboard = options.writeClipboard ?? (document.defaultView?.navigator.clipboard?.writeText
    ? (text: string) => document.defaultView!.navigator.clipboard.writeText(text) : undefined);

  function error(target: HTMLElement, problem?: unknown): void {
    target.textContent = problem ? problem instanceof Error ? problem.message : String(problem) : '';
    target.hidden = !problem;
  }
  function report(problem: unknown, target: HTMLElement = globalError): void {
    error(target, problem);
    try { options.onError?.(problem); } catch (error) { console.error('Properties error handler failed', error); }
  }
  function live(): boolean { return !frozen && !destroyed && root.isConnected && (options.isCurrent?.() ?? true); }
  function current(source: string, row: Row): Property {
    const property = readProperties(source).find(item => item.key === row.key);
    if (!property) throw new Error(`Property was removed or renamed: ${row.key}`);
    return property;
  }
  function commit(target: HTMLElement, operation: (source: string) => string, success?: () => void): void {
    if(frozen)return;
    setPending(pending.then(async () => {
      if (destroyed) return;
      mutationFailure=undefined;mutationFailureOwner=undefined;
      error(target);
      try {
        const source = options.getSource(), next = operation(source);
        if (next !== source) await options.onChange(next);
        if (destroyed) return;
        success?.(); refresh();
      } catch (problem) { mutationFailure=problem;if (!destroyed) { refresh(); report(problem, target); } }
    }));
  }
  function typeFor(property: Property): PropertyType { return selectedTypes.get(property.key) ?? property.type; }
  function edited(row: Row): void { if(!frozen){row.dirty = true; row.revision++;} }
  function acknowledge(row: Row, revision: number): boolean {
    if (row.revision !== revision) return false;
    row.dirty = false; return true;
  }
  function setValue(row: Row, value: unknown, type = typeFor(row.property)): void {
    if(frozen)return;
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

  function renderValue(row: Row, replaceFocused=false): void {
    if(frozen)return;
    const type = typeFor(row.property), value = row.property.value;
    const signature = JSON.stringify(value), definition = definitionFor(row.key), definitionSignature = JSON.stringify(definition);
    if (row.value.hasAttribute('data-base-editing')||row.keyInput.value!==row.key) return;
    const writerIdentity=options.getAdmissionWriterIdentity?.(),managed=!!options.isManaged?.();
    const rawValue = baseExpressionValue(value);
    const displaySignature = definition ? JSON.stringify(options.getDisplayValue?.(row.key, rawValue)) : undefined;
    if (row.renderedType === type && row.renderedValue === signature && row.renderedDefinition === definitionSignature && row.renderedDisplay === displaySignature&&row.renderedManaged===managed&&row.renderedWriterIdentity===writerIdentity) return;
    // Preserve selection and unsubmitted edits during background refreshes.
    const focused = row.value.contains(document.activeElement) ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
    if (row.dirty || (!replaceFocused && focused && /^(INPUT|TEXTAREA)$/.test(focused.tagName) && type !== 'list' && type !== 'tags')) return;
    const focusLabel = focused?.getAttribute('aria-label');
    const focusable = '.multi-select-pill, a, button, input, textarea, select';
    const focusedIndex = focused ? [...row.value.querySelectorAll(focusable)].indexOf(focused) : -1;
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    row.disposeWidget?.(); row.disposeWidget = undefined;
    row.renderedType = type; row.renderedValue = signature; row.renderedDefinition = definitionSignature; row.renderedDisplay = displaySignature;row.renderedManaged=managed;row.renderedWriterIdentity=writerIdentity; row.value.replaceChildren();
    if (definition) {
      let baseline = signature, definitionBaseline = definitionSignature;
      const toPlain = (value: BaseExpressionValue): unknown => {
        if (value.type === 'null') return null;
        if (value.type === 'string' || value.type === 'number' || value.type === 'boolean') return value.value;
        if (value.type === 'list') return value.value.map(toPlain);
        throw new Error('This property result cannot be stored in a note.');
      };
      row.disposeWidget = mountBasePropertyWidget(row.value, { property: `note.${row.key}`, value: rawValue, row: { path: options.path ?? 'Note.md', values: {},entryId:mountedIdentity.entryId,revision:mountedIdentity.revision }, version: 0 }, {
        getDefinition: () => definitionFor(row.key) ?? definition,
        isCurrent: () => live() && rows.get(row.key) === row,
        getDisplayValue: presentation => options.getDisplayValue?.(row.key, presentation.value),
        openFile: (path, _event, witness) => options.openLink?.(path, witness),
        getRelationTargets: () => options.getRelationTargets?.(row.key, definition) ?? (!definition.relation?.targetFilter ? [...(options.vault?.entries.values() ?? [])].filter(entry => entry.type === 'file' && /\.md$/i.test(entry.path)).map(entry => ({ path: entry.path, label: entry.path.replace(/\.md$/i, ''), entryId: entry.entryId, revision: entry.revision })) : undefined),
        commit: edit => {
          const operation = pending.then(async () => {
            mutationFailure=undefined;mutationFailureOwner=undefined;
            if (!live() || rows.get(row.key) !== row) throw new Error('This property editor is no longer active.');
            if (JSON.stringify(definitionFor(row.key)) !== definitionBaseline) throw new Error('This property definition changed; reopen the editor before saving. The draft is preserved.');
            const source = options.getSource(), latest = current(source, row);
            if (JSON.stringify(latest.value) !== baseline) throw new Error('This property changed outside the editor; the draft is preserved.');
            const next = setProperty(source, row.key, toPlain(edit.value));
            if (next !== source) await options.onChange(next);
            baseline = JSON.stringify(toPlain(edit.value)); error(row.error);
            if (live()) queueMicrotask(() => { if (live()) refresh(); });
            return { version: 0, row: edit.row, value: edit.value };
          });
          setPending(operation.then(() => {}, problem => {mutationFailure=problem;mutationFailureOwner=row;})); return operation;
        },
        ...(options.onCreateOption || options.onPropertyDefinitionChange ? { createOption: (_property: string, value: string, presentation: import('../bases/presentation-common.ts').BasePropertyPresentation) => {
          const operation = pending.then(async () => {
            mutationFailure=undefined;mutationFailureOwner=undefined;
            if (!live() || rows.get(row.key) !== row || JSON.stringify(current(options.getSource(), row).value) !== baseline) throw new Error('This property changed before the option could be created.');
            const supplied = definitionFor(row.key), latest = options.onCreateOption ? supplied : supplied ?? definition;
            if (!latest || JSON.stringify(latest) !== definitionBaseline) throw new Error('This property definition changed before the option could be created.');
            const nextDefinition = { ...latest, options: [...latest.options ?? [], { value }] };
            if (options.onCreateOption) await options.onCreateOption(row.key, value);
            else await options.onPropertyDefinitionChange!(row.key, nextDefinition);
            await loadDefinitions();
            if (!live() || rows.get(row.key) !== row || JSON.stringify(current(options.getSource(), row).value) !== baseline) throw new Error('This property changed while the option was created; the draft is preserved.');
            const accepted = definitionFor(row.key);
            if (options.onCreateOption) {
              const matches = accepted?.options?.filter(option => option.value === value || option.label === value) ?? [];
              if (accepted?.type !== latest.type || matches.length !== 1) throw new Error('The created option could not be confirmed; refresh the property settings before using it. The draft is preserved.');
            } else if (JSON.stringify(accepted) !== JSON.stringify(nextDefinition)) throw new Error('Property settings changed while the option was created; the draft is preserved.');
            definitionBaseline = JSON.stringify(accepted);
            return { version: 0, row: presentation.row, value: baseExpressionValue(current(options.getSource(), row).value) };
          });
          setPending(operation.then(() => {clearOptionFailure(row,value);}, problem => {
            mutationFailure=problem;mutationFailureOwner=row;
            const receipt=problem as {source?:unknown;commitUncertain?:unknown};
            if(receipt?.source==='host'&&receipt.commitUncertain===false)clearOptionFailure(row,value);
            else {
              const failures=retainedOptionFailures.get(row)??new Map<string,unknown>();
              failures.set(value,problem);retainedOptionFailures.set(row,failures);
            }
          })); return operation;
        } } : {}),
        onError: problem => report(problem, row.error),
      });
      if (focusedIndex >= 0) row.value.querySelectorAll<HTMLElement>(focusable)[focusedIndex]?.focus();
      return;
    }
    const aria = `${row.key} value`;
    if (type === 'list' || type === 'tags') {
      const items = listValues(row.property);
      const list = element('div', 'metadata-list');
      items.forEach((item, index) => {
        let baseline = item;
        const chip = element('div', 'metadata-list-item'); chip.dataset.itemIndex = String(index);
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
        if (key === 'Escape') { row.dirty = false;mutationFailure=undefined;mutationFailureOwner=undefined; input.blur(); row.renderedValue = undefined; renderValue(row); error(row.error); }
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
    row.element.dataset.propertyKey = property.key; row.element.tabIndex = 0; row.keyInput.value = property.key;
    row.keyInput.setAttribute('aria-label', `${property.key} name`); row.error.setAttribute('role', 'alert'); row.error.hidden = true;
    row.value.addEventListener('focusout', () => {
      // Wait for change handling to capture drafts before a background value refresh.
      queueMicrotask(() => { if (!destroyed && !row.dirty) renderValue(row); });
    });
    row.keyInput.addEventListener('change', () => {
      if(managedKey(row.key)){row.keyInput.value=row.key;return;}
      const newKey = row.keyInput.value;
      commit(row.error, source => renameProperty(source, row.key, newKey), () => {
        const oldKey = row.key; rows.delete(oldKey); rows.set(newKey, row); row.key = newKey;
        const type = selectedTypes.get(oldKey); selectedTypes.delete(oldKey); if (type) selectedTypes.set(newKey, type);
        row.renderedValue = undefined;
      });
    });
    row.selector.addEventListener('change', () => {
      if (options.onPropertyDefinitionChange && options.getDefinitions) {
        const type = row.selector.value as BasePropertyDefinition['type'];
        const definition = definitionFor(row.key);
        row.selector.disabled = true;
        const operation = pending.then(async () => {mutationFailure=undefined;mutationFailureOwner=undefined; if (!live() || hasDraft(row)) throw new Error('Finish editing this property before changing its definition.'); await options.onPropertyDefinitionChange!(row.key, { ...definition, type }); await loadDefinitions(); });
        setPending(operation.catch(problem => {mutationFailure=problem; if (live()) report(problem, row.error); }).finally(() => { if (live()) row.selector.disabled = false; }));
        return;
      }
      const type = row.selector.value as PropertyType;
      commit(row.error, source => {
        const property = current(source, row);
        return setProperty(source, row.key, convert(property.value, type), type);
      }, () => { selectedTypes.set(row.key, type); row.dirty = false; row.renderedValue = undefined; });
    });
    const remove = button('×', 'metadata-property-remove'); remove.setAttribute('aria-label', `Remove ${property.key}`);
    remove.addEventListener('click', () => {if(managedKey(row.key))return;commit(row.error, source => removeProperty(source, row.key), () => { selectedTypes.delete(row.key); });});
    row.element.append(row.selector, row.keyInput, row.value, remove, row.error); return row;
  }

  function refresh(): void {
    definitions = options.getDefinitions?.() ?? {};
    if (destroyed || frozen) return;
    // A membership refresh must never strand an existing edit or failed save.
    // Unknown/nonmember notes stay quiet; readable YAML is not membership proof.
    const retained = pendingGeneration !== settledGeneration || !!mutationFailure || !!addForm || [...rows.values()].some(hasDraft);
    root.hidden = !!options.managedOnly && !options.isManaged?.() && !retained;
    options.onVisibilityChange?.(!root.hidden);
    heading.textContent=options.collectionName?.()?`${options.collectionName!()} properties`:'Properties';
    let properties: Property[];
    try { properties = readProperties(options.getSource()); error(globalError); addButton.disabled = false; }
    catch (problem) { error(globalError, problem); addButton.disabled = true; return; }
    const keys = new Set(properties.map(property => property.key));
    for (const [key, row] of rows) if (!keys.has(key)) {
      if (hasDraft(row)) { error(row.error, new Error('This property was removed outside the editor; its draft is preserved.')); continue; }
      row.disposeWidget?.(); row.element.remove(); rows.delete(key); selectedTypes.delete(key);
    }
    properties.forEach((property, index) => {
      let row = rows.get(property.key);
      if (!row) { row = createRow(property); rows.set(property.key, row); }
      row.property = property; row.element.dataset.propertyKey = property.key;
      // A row's key input is initialized once. A rename updates this row's key
      // after saving; refresh must not replace a rejected or newer name draft,
      // even after focus moves elsewhere. External keys get distinct rows.
      row.keyInput.setAttribute('aria-label', `${property.key} name`); row.selector.setAttribute('aria-label', `${property.key} type`);
      row.element.querySelector('.metadata-property-remove')?.setAttribute('aria-label', `Remove ${property.key}`);
      row.keyInput.readOnly=managedKey(property.key);
      const reserved=!!options.isManaged?.()&&(property.key==='_id'||property.key==='_type');
      row.element.hidden=reserved;
      const remove=row.element.querySelector<HTMLButtonElement>('.metadata-property-remove');if(remove)remove.hidden=managedKey(property.key);
      const definition=definitionFor(property.key);
      if(definition&&![...row.selector.options].some(option=>option.value===definition.type)){const option=element('option','',definition.type==='multiselect'?'Multi-select':definition.type[0].toUpperCase()+definition.type.slice(1));option.value=definition.type;row.selector.append(option);}
      row.selector.value = definition?.type ?? typeFor(property);
      row.selector.disabled = !!definitionFor(property.key) && !options.onPropertyDefinitionChange; renderValue(row);
      // Reinsert only when order actually changed, preserving DOM focus and selection.
      if (rowsContainer.children[index] !== row.element) rowsContainer.insertBefore(row.element, rowsContainer.children[index] ?? null);
    });
  }

  type MenuEvent = Parameters<typeof showContextMenu>[0];
  function propertySignature(property: Property): string { return JSON.stringify([property.key, property.value]); }
  function hasDraft(row: Row): boolean { return row.dirty || row.keyInput.value !== row.key || row.value.hasAttribute('data-base-editing'); }
  function guardRow(row: Row, expected: string, revision: number, source: string): Property {
    if (!live() || rows.get(row.key) !== row || !row.element.isConnected) throw new Error('This property editor is no longer active');
    if (row.revision !== revision || hasDraft(row)) throw new Error('This property has an unsaved draft; finish editing before using this action');
    const property = current(source, row);
    if (propertySignature(property) !== expected) throw new Error('This property changed while the menu was open');
    return property;
  }
  function openMenu(event: MenuEvent, items: ContextMenuItem[], actions: Map<string, () => void | Promise<void>>): void {
    if (!live()) return;
    const serial = ++menuSerial; menuPending = true;
    const failed = (problem: unknown) => {
      if (serial !== menuSerial) return;
      menuPending = false;
      if (!destroyed) report(problem);
    };
    let result: Promise<string | null>;
    try { result = showMenu(event, items, { document }); }
    catch (problem) { failed(problem); return; }
    void result.then(async id => {
      if (serial !== menuSerial) return;
      menuPending = false;
      if (!id || destroyed) return;
      if (!live()) throw new Error('This property editor is no longer active');
      await actions.get(id)?.();
    }).catch(failed);
  }
  function openPropertyMenu(event: MenuEvent, row: Row): void {
    const expected = propertySignature(row.property), revision = row.revision;
    const actions = new Map<string, () => void | Promise<void>>();
    const reserved = ['aliases', 'cssclasses', 'tags'].includes(row.key);
    const inferred = row.property.value === null ? 'text' : row.property.type;
    const assigned = selectedTypes.get(row.key);
    if(managedKey(row.key)){event.preventDefault?.();event.stopPropagation?.();return;}
    const submenu: ContextMenuItem[] = [];
    if (!reserved) {
      submenu.push({ id: 'property-type-automatic', label: assigned ? 'Automatic' : `Automatic (${inferred === 'unknown' ? 'Unknown' : labels[inferred]})`, checked: !assigned, enabled: !hasDraft(row) });
      actions.set('property-type-automatic', () => {
        guardRow(row, expected, revision, options.getSource()); selectedTypes.delete(row.key);
        row.renderedType = undefined; refresh();
      });
    }
    const entries: { id: string; type: PropertyType; label: string }[] = [
      ...(row.key === 'aliases' ? [{ id: 'aliases', type: 'list' as const, label: 'Aliases' }] : []),
      ...(['checkbox', 'date', 'datetime', 'list', 'number'] as const).map(type => ({ id: type, type, label: labels[type] })),
      ...(row.key === 'tags' ? [{ id: 'tags', type: 'tags' as const, label: 'Tags' }] : []),
      { id: 'text', type: 'text', label: 'Text' },
    ];
    for (const entry of entries) {
      let compatible = true;
      try { validatePropertyValue(entry.type, row.property.value); } catch { compatible = false; }
      const id = `property-type-${entry.id}`;
      submenu.push({ id, label: entry.label, enabled: !reserved && !hasDraft(row) && compatible,
        checked: reserved ? entry.id === (row.key === 'cssclasses' ? 'list' : row.key) : assigned === entry.type });
      if (!reserved && compatible) actions.set(id, () => {
        const property = guardRow(row, expected, revision, options.getSource());
        validatePropertyValue(entry.type, property.value);
        // Local display choice only: no coercion or fabricated vault-wide registry.
        selectedTypes.set(row.key, entry.type); row.renderedType = undefined; refresh();
      });
    }
    actions.set('property-remove', () => commit(globalError, source => {
      guardRow(row, expected, revision, source); return removeProperty(source, row.key);
    }, () => { selectedTypes.delete(row.key); }));
    openMenu(event, [
      { label: 'Property type', submenu }, { type: 'separator' },
      { id: 'property-remove', label: 'Remove', enabled: !hasDraft(row) },
    ], actions);
  }
  function openListMenu(event: MenuEvent, row: Row, chip: HTMLElement): void {
    const index = Number(chip.dataset.itemIndex), expected = propertySignature(row.property), revision = row.revision;
    const values = listValues(row.property), item = values[index];
    if (item === undefined) return;
    const guard = (source = options.getSource()) => {
      const property = guardRow(row, expected, revision, source);
      if (!chip.isConnected || listValues(property)[index] !== item) throw new Error('This list item changed while the menu was open');
      return property;
    };
    const actions = new Map<string, () => void | Promise<void>>([
      ['list-edit', () => { guard(); const input = chip.querySelector('textarea')!; input.focus(); input.select(); }],
      ['list-remove', () => commit(globalError, source => {
        const property = guard(source), next = listValues(property); next.splice(index, 1);
        return setProperty(source, row.key, next, typeFor(property));
      })],
    ]);
    if (clipboard) actions.set('list-copy', async () => { guard(); await clipboard(item); });
    openMenu(event, [
      { id: 'list-edit', label: 'Edit', enabled: !hasDraft(row) },
      { id: 'list-copy', label: 'Copy', enabled: !!clipboard && !hasDraft(row) },
      { id: 'list-remove', label: 'Remove from list', enabled: !hasDraft(row) },
    ], actions);
  }
  function openHeaderMenu(event: MenuEvent): void {
    let expected: string;
    try { expected = JSON.stringify(readProperties(options.getSource())); }
    catch (problem) { event.preventDefault?.(); event.stopPropagation?.(); report(problem); return; }
    const dirty = [...rows.values()].some(hasDraft);
    const guard = (source: string) => {
      if (!live()) throw new Error('This property editor is no longer active');
      if ([...rows.values()].some(hasDraft)) throw new Error('Properties have unsaved drafts; finish editing before using this action');
      if (JSON.stringify(readProperties(source)) !== expected) throw new Error('Properties changed while the menu was open');
    };
    const actions = new Map<string, () => void | Promise<void>>([
      ['properties-add', () => { if (!live()) return; readProperties(options.getSource()); addButton.click(); }],
      ['properties-sort-asc', () => commit(globalError, source => { guard(source); return sortProperties(source); })],
      ['properties-sort-desc', () => commit(globalError, source => { guard(source); return sortProperties(source, true); })],
      ['properties-clear', () => commit(globalError, source => { guard(source); return clearProperties(source); }, () => selectedTypes.clear())],
    ]);
    openMenu(event, [
      { id: 'properties-add', label: 'Add file property' }, { type: 'separator' },
      { label: 'Sort', submenu: [
        { id: 'properties-sort-asc', label: 'Name (A to Z)', enabled: !dirty },
        { id: 'properties-sort-desc', label: 'Name (Z to A)', enabled: !dirty },
      ] }, { type: 'separator' }, { id: 'properties-clear', label: 'Clear file properties', enabled: !dirty&&!options.isManaged?.() },
    ], actions);
  }
  function routeMenu(event: MenuEvent): void {
    if (!live()) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.nodeType !== 1 || !root.contains(target)) return;
    if (heading.contains(target)) { openHeaderMenu(event); return; }
    const rowElement = target.closest<HTMLElement>('.metadata-property');
    const row = rowElement?.dataset.propertyKey ? rows.get(rowElement.dataset.propertyKey) : undefined;
    if (!row) return;
    const chip = target.closest<HTMLElement>('.metadata-list-item');
    if (chip) { openListMenu(event, row, chip); return; }
    if (target === row.element || target === row.selector) openPropertyMenu(event, row);
    // Name and scalar-value inputs retain native text-editing context menus.
  }
  function contextMenu(event: MouseEvent): void { if (!event.defaultPrevented) routeMenu(event); }
  function keyboardMenu(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
    const target = event.target as HTMLElement, rect = target.getBoundingClientRect();
    routeMenu({ clientX: rect.left + 4, clientY: rect.bottom, target, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() });
  }
  // Another surface's context event relinquishes ownership before it can open a
  // new popup, so destroying this panel cannot dismiss that surface's menu.
  function supersede(): void { menuSerial++; menuPending = false; }
  function keyboardSupersede(event: KeyboardEvent): void { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) supersede(); }
  document.addEventListener('contextmenu', supersede, true);
  document.addEventListener('keydown', keyboardSupersede, true);
  root.addEventListener('contextmenu', contextMenu);
  root.addEventListener('keydown', keyboardMenu);
  // Freeze at the component boundary before making its containing workspace
  // inert: browser-generated change/blur must not accept raw values on retire.
  const blockFrozen=(event:Event)=>{
    const target=event.target as HTMLElement|null,row=target?[...rows.values()].find(row=>row.element.contains(target)):undefined;
    if(frozen||event.type==='change'&&row&&restoredPassiveRows.has(row)){
      const activeComposition=event.type==='keydown'&&!!event.target&&composing.has(event.target)&&compositions.get(event.target)?.end===undefined;
      if(!activeComposition)event.preventDefault();event.stopImmediatePropagation();return;
    }
    if(row&&['keydown','click'].includes(event.type))restoredPassiveRows.delete(row);
  };
  const activateRestored=(event:Event)=>{
    if(frozen)return;const target=event.target as Node|null;
    for(const row of restoredPassiveRows)if(target&&row.element.contains(target)||event.type==='pointerdown'&&row.element.contains(document.activeElement))restoredPassiveRows.delete(row);
  };
  root.addEventListener('input',activateRestored,true);document.addEventListener('pointerdown',activateRestored,true);
  for(const type of ['change','click','keydown','contextmenu'])root.addEventListener(type,blockFrozen,true);
  const freezeNativeControl=(target:EventTarget)=>{const control=target as HTMLInputElement;if(['INPUT','TEXTAREA'].includes(control.tagName)&&!['checkbox','radio','button','submit'].includes(control.type))control.readOnly=true;else if(['INPUT','SELECT','BUTTON'].includes(control.tagName))control.disabled=true;};
  const composing=new Set<EventTarget>();let compositionDone:(()=>void)|undefined;
  type RawComposition={start:string;update?:string;lastValue?:string;lastData?:string|null;lastFinal?:boolean;end?:string};
  const compositions=new Map<EventTarget,RawComposition>();
  const finishComposition=(target:EventTarget)=>{
    const state=compositions.get(target);if(!state||state.end===undefined)return;
    const value=(target as HTMLInputElement).value,ended=state.end;
    const finalInput=state.lastFinal&&state.lastValue===value;
    const priorInput=!!ended&&state.lastValue===value&&(ended===state.update||ended===state.lastData);
    const cancelled=ended===''&&value===state.start;
    if(!finalInput&&!priorInput&&!cancelled)return;
    composing.delete(target);compositions.delete(target);if(frozen)freezeNativeControl(target);if(!composing.size){compositionDone?.();compositionDone=undefined;}
  };
  const compositionStart=(event:Event)=>{if(event.target){composing.add(event.target);compositions.set(event.target,{start:(event.target as HTMLInputElement).value});}};
  const compositionUpdate=(event:Event)=>{const state=event.target?compositions.get(event.target):undefined;if(state)state.update=(event as CompositionEvent).data;};
  const compositionEnd=(event:Event)=>{const state=event.target?compositions.get(event.target):undefined;if(state){state.end=(event as CompositionEvent).data;finishComposition(event.target!);}};
  const compositionInput=(event:Event)=>{const state=event.target?compositions.get(event.target):undefined;if(state){const input=event as InputEvent;state.lastValue=(event.target as HTMLInputElement).value;state.lastData=input.data;state.lastFinal=input.isComposing===false;finishComposition(event.target!);}};
  root.addEventListener('compositionstart',compositionStart,true);root.addEventListener('compositionend',compositionEnd,true);
  root.addEventListener('compositionupdate',compositionUpdate,true);root.addEventListener('input',compositionInput,true);

  addButton.addEventListener('click', () => {
    const addOwnerCurrent = () => { try { return live(); } catch { return false; } };
    if (!addOwnerCurrent() || addForm || addingManagedProperty) return;
    if (options.isManaged?.() && options.onAddProperty) {
      addingManagedProperty = true; addButton.disabled = true; error(globalError);
      let operation: Promise<void>;
      try { operation = Promise.resolve(options.onAddProperty(addButton)); }
      catch (problem) { operation = Promise.reject(problem); }
      void operation.catch(problem => { if (addOwnerCurrent() && options.isManaged?.()) report(problem); }).finally(() => {
        addingManagedProperty = false;
        if (!destroyed && addButton.isConnected) addButton.disabled = false;
      });
      return;
    }
    openRawAddForm();
  });
  function openRawAddForm(focus=true):void {
    if(addForm||!live())return;
    addFormBaseline={propertiesFingerprint:JSON.stringify(readProperties(options.getSource())),managed:!!options.isManaged?.(),writerGuarded:!!options.getAdmissionWriterIdentity,writerIdentity:options.getAdmissionWriterIdentity?.()};
    addForm = element('div', 'metadata-add-form');
    const name = element('input', 'metadata-property-key-input'); name.placeholder = 'Property name'; name.setAttribute('aria-label', 'New property name');
    const selector = selectType('New property type', 'text');
    const add = button('Add'), cancel = button('Cancel');
    const create = () => {
      const key = name.value, type = selector.value as PropertyType;
      commit(globalError, source => {
        if (readProperties(source).some(property => property.key === key)) throw new Error(`Property already exists: ${key}`);
        return setProperty(source, key, null, type);
      }, () => {
        if (options.vault && options.onPropertyDefinitionChange && type !== 'unknown') {
          const operation = pending.then(async () => {mutationFailure=undefined;mutationFailureOwner=undefined; if (!live()) throw new Error('This property editor is no longer active.'); await options.onPropertyDefinitionChange!(key, { type: type as BasePropertyDefinition['type'] }); await loadDefinitions(); });
          setPending(operation.catch(problem => {mutationFailure=problem; if (live()) report(problem); }));
        } else selectedTypes.set(key, type);
        addForm?.remove(); addForm = undefined;addFormBaseline=undefined;
      });
    };
    add.addEventListener('click', create);
    name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); create(); } });
    cancel.addEventListener('click', () => { addForm?.remove(); addForm = undefined;addFormBaseline=undefined;mutationFailure=undefined;mutationFailureOwner=undefined; addButton.focus(); });
    addForm.append(name, selector, add, cancel); root.append(addForm); if(focus)name.focus();
  }
  async function loadDefinitions(): Promise<void> {
    if (destroyed) return;
    definitions = options.getDefinitions?.() ?? {};
    refresh();
  }
  void loadDefinitions();
  function clearReleasedWidgetErrors(): void {
    if(destroyed||pendingGeneration!==settledGeneration)return;
    for(const row of releasedWidgetRows){
      if(rows.get(row.key)!==row||hasDraft(row)){releasedWidgetRows.delete(row);continue;}
      if(retainedOptionFailures.has(row))continue;
      error(row.error);releasedWidgetRows.delete(row);
      if(mutationFailureOwner===row){mutationFailure=undefined;mutationFailureOwner=undefined;}
    }
  }
  const editObserver = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(records => {
    if(destroyed)return;
    // Both parser failures and rejected writes report into the owning row. A
    // rich widget releasing its marker retires only that row's settled error.
    for(const record of records){
      if(record.oldValue===null||(record.target as Element).hasAttribute('data-base-editing'))continue;
      const row=[...rows.values()].find(row=>row.value===record.target);if(row)releasedWidgetRows.add(row);
    }
    clearReleasedWidgetErrors();
    refresh();
  }) : undefined;
  editObserver?.observe(rowsContainer, { subtree: true, attributes: true, attributeOldValue:true, attributeFilter: ['data-base-editing'] });
  refresh();
  const hasPendingChanges=()=>!destroyed&&(pendingGeneration!==settledGeneration||!!mutationFailure||!!retainedOptionFailures.size||!!addForm||[...rows.values()].some(hasDraft));
  const flush=async()=>{
    if(destroyed)return;
    for(;;){const captured=pending;await captured;await Promise.resolve();if(captured===pending)break;}
    for(const failures of retainedOptionFailures.values())if(failures.size)throw failures.values().next().value;
    if(mutationFailure)throw mutationFailure;
    const invalid=[...rows.values()].find(row=>hasDraft(row)&&!row.error.hidden&&!!row.error.textContent?.trim());
    if(invalid)throw new Error(invalid.error.textContent!);
    if(addForm&&!globalError.hidden&&globalError.textContent?.trim())throw new Error(globalError.textContent);
    if(addForm||[...rows.values()].some(hasDraft))throw new Error('Finish editing the current property before closing.');
  };
  const controlsFor=(row:Row):HTMLInputElement[]=>[row.keyInput,...row.value.querySelectorAll<HTMLInputElement>('input,textarea,select')];
  const rawControl=(control:HTMLInputElement,kind:'key'|'value',index:number):PropertiesRawControl=>({kind,index,tag:control.tagName,inputType:control.tagName==='INPUT'?control.type:undefined,
    value:control.value,checked:control.tagName==='INPUT'?control.checked:undefined,indeterminate:control.tagName==='INPUT'?control.indeterminate:undefined,
    focused:document.activeElement===control,selectionStart:control.selectionStart??null,selectionEnd:control.selectionEnd??null,selectionDirection:control.selectionDirection??null});
  const restoreControl=(control:HTMLInputElement|undefined,state:PropertiesRawControl,focus:boolean):boolean=>{
    if(!control||control.tagName!==state.tag||state.inputType!==undefined&&control.type!==state.inputType)return false;
    control.value=state.value;if(state.checked!==undefined)control.checked=state.checked;if(state.indeterminate!==undefined)control.indeterminate=state.indeterminate;
    if(focus&&state.focused)control.focus();
    if(state.selectionStart!==null&&state.selectionEnd!==null&&'setSelectionRange'in control)try{control.setSelectionRange(state.selectionStart,state.selectionEnd,state.selectionDirection??undefined);}catch{/* Checkbox/select controls have no text selection. */}
    return true;
  };
  const canRecoverAdmission=()=>!destroyed&&!frozen&&pendingGeneration===settledGeneration&&!mutationFailure&&!retainedOptionFailures.size&&!addingManagedProperty&&!menuPending
    &&[...rows.values()].every(row=>!row.value.hasAttribute('data-base-editing')||canCaptureBasePropertyRawDraft(row.value));
  const prepareAdmissionRecovery=():PropertiesAdmissionRecovery=>{
    if(recovery)return recovery;
    if(!canRecoverAdmission())throw new Error('Submitted property changes must settle before storage reconnects.');
    const identity=mountedIdentity;
    const drafts=[...rows.values()].filter(row=>hasDraft(row)||[...composing].some(target=>row.element.contains(target as Node))).map(row=>({row,key:row.key,valueFingerprint:row.renderedValue??JSON.stringify(row.property.value),definitionFingerprint:row.renderedDefinition,
      type:row.renderedType??typeFor(row.property),managed:row.renderedManaged??false,writerGuarded:!!options.getAdmissionWriterIdentity,writerIdentity:row.renderedWriterIdentity,widget:row.value.hasAttribute('data-base-editing')?captureBasePropertyRawDraft(row.value):undefined}));
    if(drafts.some(draft=>draft.row.value.hasAttribute('data-base-editing')&&!draft.widget))throw new Error('The property draft changed before it could be retained.');
    const snapshot=():PropertiesRawDrafts=>({identity,rows:drafts.map(({row,...draft})=>({...draft,controls:draft.widget?[]:controlsFor(row).map((control,index)=>rawControl(control,index===0?'key':'value',index===0?0:index-1))})),
      ...(addForm?{addForm:{...addFormBaseline!,name:rawControl(addForm.querySelector<HTMLInputElement>('input')!,'key',0),type:addForm.querySelector<HTMLSelectElement>('select')!.value}}:{})});
    let raw=snapshot();frozen=true;
    for(const control of root.querySelectorAll('input,textarea,select,button'))if(!composing.has(control))freezeNativeControl(control);
    const compositionReady=composing.size?new Promise<void>(resolve=>{compositionDone=resolve;}):Promise.resolve();
    const settled=Promise.all([compositionReady,...drafts.flatMap(draft=>draft.widget?[draft.widget.ready]:[])]).then(()=>new Promise<void>(resolve=>setTimeout(resolve,0))).then(()=>{
      const next=snapshot();raw={...next,rows:next.rows.map((row,index)=>({...row,controls:row.controls.map((control,controlIndex)=>({...control,focused:raw.rows[index]?.controls[controlIndex]?.focused??false}))})),
        ...(next.addForm?{addForm:{...next.addForm,name:{...next.addForm.name,focused:raw.addForm?.name.focused??false}}}:{})};
    });
    return recovery={get rawDrafts(){return raw;},settle:()=>settled};
  };
  const restoredDrafts=new WeakSet<PropertiesRawDrafts>();
  const restoreAdmissionDrafts=(draft:PropertiesRawDrafts,restoreOptions?:{focus?:boolean}):{restored:boolean;pending:boolean;conflicts:readonly PropertiesRawConflict[]}=>{
    const conflict=(reason:string)=>({restored:false,pending:false,conflicts:[{draft,reason}]});
    if(restoredDrafts.has(draft)&&live())return {restored:true,pending:false,conflicts:[]};
    if(!live()||pendingGeneration!==settledGeneration||hasPendingChanges())return conflict('The fresh properties owner already has unfinished changes.');
    const actor=options.path?options.vault?.entries.get(options.path):undefined;
    if(draft.identity.path!==options.path||draft.identity.entryId!==undefined&&draft.identity.entryId!==actor?.entryId)return conflict('The note identity changed while storage reconnected.');
    let currentProperties:Property[];try{currentProperties=readProperties(options.getSource());}catch{return conflict('The fresh note properties cannot be read. Their raw draft is retained.');}
    const managed=!!options.isManaged?.(),writerIdentity=options.getAdmissionWriterIdentity?.();
    const writers=draft.rows.map(row=>({managed:row.managed,guarded:row.writerGuarded,id:row.writerIdentity}));if(draft.addForm)writers.push({managed:draft.addForm.managed,guarded:draft.addForm.writerGuarded,id:draft.addForm.writerIdentity});
    if(writers.some(writer=>writer.guarded&&writerIdentity===undefined))return {restored:false,pending:true,conflicts:[]};
    if(writers.some(writer=>writer.managed!==managed||writer.guarded&&(!options.getAdmissionWriterIdentity||writer.id===undefined||writer.id!==writerIdentity)))return conflict('The collection writer changed while storage reconnected. Its raw draft is retained.');
    for(const item of draft.rows){const row=rows.get(item.key),property=currentProperties.find(property=>property.key===item.key);
      if(!row||!property||JSON.stringify(property.value)!==item.valueFingerprint||JSON.stringify(definitionFor(item.key))!==item.definitionFingerprint)return conflict(`Property ${item.key} changed while storage reconnected. Its raw draft is retained.`);
      if(!item.widget){if(!types.includes(item.type))return conflict(`Property ${item.key} has an unavailable presentation type.`);try{validatePropertyValue(item.type,property.value);}catch{return conflict(`Property ${item.key} no longer supports its retained presentation type.`);}selectedTypes.set(item.key,item.type);row.renderedType=undefined;renderValue(row,true);row.selector.value=item.type;const controls=controlsFor(row);if(item.controls.some(state=>{const control=state.kind==='key'?controls[0]:controls[state.index+1];return !control||control.tagName!==state.tag||state.inputType!==undefined&&control.type!==state.inputType;}))return conflict(`Property ${item.key} no longer has the same controls.`);}
    }
    if(draft.addForm&&JSON.stringify(currentProperties)!==draft.addForm.propertiesFingerprint)return conflict('Properties changed while the new-property form was retained.');
    // All checks precede any raw control publication. Never dispatch input,
    // change, blur, Enter, or a schema operation to reconstruct a draft.
    for(const item of draft.rows){const row=rows.get(item.key)!;
      if(item.widget){if(!restoreBasePropertyRawDraft(row.value,item.widget))return conflict(`Property ${item.key} could not restore its raw editor.`);}
      else {const controls=controlsFor(row);for(const state of item.controls)restoreControl(state.kind==='key'?controls[0]:controls[state.index+1],state,restoreOptions?.focus!==false);}
      if(!item.widget){row.dirty=true;row.revision++;restoredPassiveRows.add(row);}
    }
    if(draft.addForm){openRawAddForm(false);const name=addForm?.querySelector<HTMLInputElement>('input'),selector=addForm?.querySelector<HTMLSelectElement>('select');if(!name||!selector)return conflict('The new-property form is unavailable.');selector.value=draft.addForm.type;restoreControl(name,draft.addForm.name,restoreOptions?.focus!==false);}
    restoredDrafts.add(draft);return {restored:true,pending:false,conflicts:[]};
  };
  const owns=(node:Node)=>{if(destroyed||!root.isConnected||!node.isConnected)return false;if(root.contains(node))return true;const owner=basePropertyPopoverOwner(node);return !!owner&&[...rows.values()].some(row=>row.value===owner);};
  return { refresh,hasPendingChanges,flush,owns,canRecoverAdmission,prepareAdmissionRecovery,restoreAdmissionDrafts,
    async prepareAdmissionRestore(){
      if(!live())throw new Error('The fresh property owner is no longer current.');
      await options.prepareAdmissionRestore?.();
      if(!live())throw new Error('The property owner changed while its fresh schema was being read.');
      refresh();
    }, destroy() {
    if (destroyed) return;
    destroyed = true; menuSerial++;
    document.removeEventListener('contextmenu', supersede, true); document.removeEventListener('keydown', keyboardSupersede, true);
    root.removeEventListener('contextmenu', contextMenu); root.removeEventListener('keydown', keyboardMenu);
    for(const type of ['change','click','keydown','contextmenu'])root.removeEventListener(type,blockFrozen,true);
    root.removeEventListener('compositionstart',compositionStart,true);root.removeEventListener('compositionend',compositionEnd,true);
    root.removeEventListener('compositionupdate',compositionUpdate,true);root.removeEventListener('input',compositionInput,true);
    root.removeEventListener('input',activateRestored,true);document.removeEventListener('pointerdown',activateRestored,true);restoredPassiveRows.clear();
    if (menuPending) void (options.dismissMenu ?? dismissContextMenu)(document).catch(problem => { try { options.onError?.(problem); } catch { /* The owner is already disposed. */ } });
    menuPending = false; definitionLoad++; editObserver?.disconnect(); unsubscribers.forEach(unsubscribe => unsubscribe()); for (const row of rows.values()) row.disposeWidget?.(); rows.clear();retainedOptionFailures.clear();releasedWidgetRows.clear(); selectedTypes.clear(); root.remove();
  } };
}
