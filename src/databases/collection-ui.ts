import type { DatabaseService, DatabaseCollection, DatabaseProperty, DatabasePropertyInput, DatabaseEntry, DatabaseRequest, DatabaseResponse } from '../core/databases.ts';
import type { BaseViewSource } from '../bases/document.ts';
import {validDateText} from '../bases/property-definitions.ts';
import {icon} from '../ui/icons.ts';
import type { BasePropertyDefinition } from '../bases/property-definitions.ts';

const datatypes = ['text', 'number', 'checkbox', 'date', 'datetime', 'select', 'multi-select', 'status'] as const;
const labels: Record<string, string> = { text: 'Text', number: 'Number', checkbox: 'Checkbox', date: 'Date', datetime: 'Date & time', select: 'Select', 'multi-select': 'Multi-select', status: 'Status' };
const categories = ['not_started', 'working', 'done'] as const;
const categoryLabels = ['Not started', 'In progress', 'Done'];
const operationId = () => crypto.randomUUID();

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text = ''): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag); node.textContent = text; return node;
}
function button(doc: Document, text: string, action: () => void): HTMLButtonElement {
  const node = element(doc, 'button', text); node.type = 'button'; node.addEventListener('click', action); return node;
}
function problemText(problem: unknown): string { return problem instanceof Error ? problem.message : String(problem); }

/** Schema identity stays in the core; these definitions only choose controls. */
export function collectionPropertyDefinitions(collection: DatabaseCollection): Readonly<Record<string, BasePropertyDefinition>> {
  return Object.fromEntries(collection.properties.map(property => [property.id, {
    type: property.datatype === 'multi-select' ? 'multiselect' : property.datatype,
    ...(property.options.length ? { options: property.options.map(option => ({ value: option.id, id: option.id, label: option.name,
      ...(option.color?{color:option.color}:{}),
      ...(option.category ? { category: option.category === 'not_started' ? 'todo' as const : option.category === 'working' ? 'in-progress' as const : 'done' as const } : {}) })) } : {}),
  } satisfies BasePropertyDefinition]));
}

export function collectionValue(value: unknown): string | number | boolean | null | string[] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  throw new Error('This value cannot be edited as a collection property.');
}

/** Best-effort creation hints never turn an impossible filter into a failed New. */
export function collectionInitialValues(collection:DatabaseCollection,hints:Readonly<Record<string,unknown>>,keys:'fieldIds'|'names'='fieldIds'):Record<string,string|number|boolean|null|string[]> {
  const values:Record<string,string|number|boolean|null|string[]>={};
  for(const[key,input]of Object.entries(hints)){
    const field=collection.properties.find(field=>keys==='fieldIds'?field.id===key:field.name===key);if(!field)continue;
    if(input===null){values[field.id]=null;continue;}
    let value:unknown=input;
    const valid=field.datatype==='text'?typeof value==='string':field.datatype==='number'?typeof value==='number'&&Number.isFinite(value):field.datatype==='checkbox'?typeof value==='boolean':field.datatype==='date'?typeof value==='string'&&validDateText(value,false):field.datatype==='datetime'?typeof value==='string'&&validDateText(value,true):['select','status'].includes(field.datatype)?typeof value==='string'&&!!field.options.find(option=>option.id===value||option.name===value):Array.isArray(value)&&value.every(item=>typeof item==='string'&&field.options.some(option=>option.id===item||option.name===item));
    if(!valid)continue;
    if(field.datatype==='select'||field.datatype==='status')value=field.options.find(option=>option.id===value||option.name===value)!.id;
    if(field.datatype==='multi-select')value=[...new Set((value as string[]).map(item=>field.options.find(option=>option.id===item||option.name===item)!.id))];
    values[field.id]=collectionValue(value);
  }
  return values;
}

/** The concrete control retains its original receipt and continuation through
 * a checked admission handoff. No hook means the ordinary one-shot service. */
export type CollectionSubmit=(command:DatabaseRequest,complete:(reply:DatabaseResponse,recovering:boolean,validateAttempt:()=>void)=>Promise<void>)=>Promise<void>;
function submitCollection(options:{service?:DatabaseService;submit?:CollectionSubmit},command:DatabaseRequest,complete:(reply:DatabaseResponse,recovering:boolean,validateAttempt:()=>void)=>Promise<void>):Promise<void>{
  return options.submit?options.submit(command,complete):options.service!.request(command).then(reply=>complete(reply,false,()=>{}));
}

export interface SourceChooserOptions {
  readonly service?: DatabaseService;
  readonly submit?:CollectionSubmit;
  readonly onDestroy?:()=>void;
  readonly isCurrent: () => boolean;
  readonly choose: (source: BaseViewSource,recovering?:boolean,validateAttempt?:()=>void) => Promise<void>;
  readonly onCancel?: () => void;
  readonly onError?: (problem: unknown) => void;
}
export interface SourceChooser { readonly element: HTMLElement; hasPendingChanges(): boolean; destroy(): void }

/** First-view and Add-view onboarding share the same source selector. */
export function mountSourceChooser(container: HTMLElement, options: SourceChooserOptions): SourceChooser {
  const doc = container.ownerDocument, root = element(doc, 'section'); root.className = 'collection-source-chooser'; root.setAttribute('aria-label', 'Choose view source');
  const heading = element(doc, 'h2', 'New database');
  const choices = element(doc, 'div'); choices.className = 'collection-source-choices';
  const form = element(doc, 'div'), error = element(doc, 'p'); error.setAttribute('role', 'alert'); error.hidden = true;
  let destroyed = false, busy = false, draft = false, composing = false, focusIntent = 0;
  let screen: 'choices' | 'existing' | 'create' = 'choices', canLeaveCreate: (() => boolean) | undefined;
  let returnFromCreate: (() => void) | undefined, createAvailability: (() => void) | undefined, retainedCreate = false;
  let emptyRequest: DatabaseRequest | undefined, emptySource: BaseViewSource | undefined, emptyAccepted = false, emptyUncertain = false;
  const live = () => !destroyed && options.isCurrent();
  const outsideFocus = (event: Event) => {
    if (busy && event.target instanceof doc.defaultView!.Node && !root.contains(event.target)
      && (event.type !== 'focusin' || event.target !== doc.body && event.target !== doc.documentElement)) focusIntent++;
  };
  const windowBlur = () => { if (busy) focusIntent++; };
  doc.addEventListener('focusin', outsideFocus, true); doc.addEventListener('pointerdown', outsideFocus, true);
  doc.defaultView?.addEventListener('blur', windowBlur);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; });
  async function run(action: () => Promise<void>) {
    if (busy || !live()) return;
    const focused = doc.activeElement instanceof doc.defaultView!.HTMLElement && root.contains(doc.activeElement) ? doc.activeElement : undefined;
    const intent = focusIntent;
    busy = true; root.setAttribute('aria-busy', 'true'); error.hidden = true;
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = true;
    try { await action(); }
    catch (problem) { if (live()) { error.textContent = problemText(problem); error.hidden = false; options.onError?.(problem); } }
    finally {
      busy = false; root.removeAttribute('aria-busy');
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = false;
      availability();
      if (focused && live() && intent === focusIntent && focused.isConnected && !focused.closest('[hidden]') && !focused.matches(':disabled')
        && (doc.activeElement === doc.body || doc.activeElement === doc.documentElement || root.contains(doc.activeElement))) focused.focus();
    }
  }
  const select = (source: BaseViewSource) => run(async () => { if (!live()) throw new Error('This view changed.'); await options.choose(source); });
  const decorateChoice = (control: HTMLButtonElement, glyph: string, suggested = false) => {
    const label = element(doc, 'span', control.textContent ?? ''); label.className = 'collection-source-label';
    const copy = element(doc, 'span'); copy.className = 'collection-source-copy'; copy.append(label);
    const slot = element(doc, 'span'); slot.className = `collection-source-icon${suggested ? ' is-suggested' : ''}`; slot.setAttribute('aria-hidden', 'true'); slot.append(icon(glyph, suggested ? 20 : 16, doc));
    control.replaceChildren(slot, copy); return {label, copy};
  };
  const empty = button(doc, 'New empty data source', () => { void createEmpty(); }); empty.className = 'collection-source-primary';
  const emptyLabel = decorateChoice(empty, 'plus').label;
  const notes = button(doc, 'Notes in your vault', () => { void select({ kind: 'untyped' }); });
  decorateChoice(notes, 'file').copy.append(element(doc, 'small', 'Browse note titles, previews and file information.'));
  const tasks = button(doc, 'Tasks', () => { showCreate('choices', tasks, 'tasks'); }); decorateChoice(tasks, 'square-check', true);
  const configured = button(doc, 'New data source with options', () => { showCreate('choices', configured); }); decorateChoice(configured, 'sliders-horizontal');
  const collection = button(doc, 'Link to existing data source', () => { draft = true; showCollections(); }); decorateChoice(collection, 'link');
  const suggested = element(doc, 'div', 'Suggested'); suggested.className = 'collection-source-section-label';
  choices.append(empty, suggested, tasks, configured, collection, notes);
  root.append(heading, choices, form, error);
  const cancel = options.onCancel ? button(doc, 'Cancel', () => { if (!busy && !emptyRequest && !emptySource && !retainedCreate && (screen !== 'create' || canLeaveCreate?.())) options.onCancel!(); }) : undefined;
  if (cancel) root.append(cancel);
  if (!options.service) root.append(element(doc, 'p', 'Collections are unavailable in this vault. You can browse existing notes.'));
  container.append(root);
  function availability() {
    createAvailability?.();
    const retained = !!emptyRequest || !!emptySource || retainedCreate;
    empty.disabled = !options.service || busy || retainedCreate;
    tasks.disabled = !options.service || busy || retained;
    configured.disabled = !options.service || busy || retained;
    collection.disabled = !options.service || busy || retained;
    notes.disabled = busy || retained;
    if (cancel) cancel.disabled = busy || retained || screen === 'create' && !canLeaveCreate?.();
    updateTabStops();
  }
  async function createEmpty() {
    if (!options.service || busy || !live()) return;
    draft = true;
    await run(async () => {
      try {
        if (!emptySource) {
          if (!emptyRequest) {
            const response = await options.service!.request({ op: 'list' }); if (!live()) return;
            const names = new Set(response.collections.map(collection => collection.name.toLowerCase()));
            let name = 'New database', suffix = 1;
            while (names.has(name.toLowerCase())) name = `New database ${++suffix}`;
            emptyRequest = { op: 'create', operationId: operationId(), name, preset: 'blank' };
          }
          await submitCollection(options,emptyRequest,async(response,recovering,validateAttempt)=>{
            validateAttempt();if(!live())throw new Error('This collection control was closed.');
            emptyAccepted = true;
            if (response.projection.pending || response.projection.issues.length) throw new Error(response.projection.issues.map(issue => issue.message).join('\n') || 'The data source is committed locally but its files still need publication. Retry this creation.');
            const created = response.collections.filter(collection => !collection.deleted && emptyRequest?.op === 'create' && collection.name === emptyRequest.name);
            if (created.length!==1) throw new Error('The data source was not returned unambiguously. Retry this creation.');
            emptySource = { kind: 'collection', id: created[0].id };await options.choose(emptySource,recovering,validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.');
          });
        }else{if(!live())return;await options.choose(emptySource);}
        if (live()) { emptyRequest = undefined; emptySource = undefined; emptyAccepted = false; emptyUncertain = false; draft = false; }
      } catch (problem) {
        const rejected = problem as { source?: unknown; commitUncertain?: unknown };
        if (!emptyAccepted && !emptyUncertain && !emptySource && rejected?.source === 'host' && rejected.commitUncertain === false) emptyRequest = undefined;
        else if (emptyRequest && !(rejected?.source === 'host' && rejected.commitUncertain === false)) emptyUncertain = true;
        draft = !!emptyRequest || !!emptySource;
        if (live()) emptyLabel.textContent = 'Retry data source';
        throw problem;
      }
    });
  }
  function navigationButtons(): HTMLButtonElement[] {
    const region = screen === 'choices' ? choices : screen === 'existing' ? form : undefined;
    return region ? [...region.querySelectorAll<HTMLButtonElement>('button')].filter(control => !control.disabled && !control.closest('[hidden]')) : [];
  }
  function updateTabStops(preferred?: HTMLButtonElement) {
    const available = navigationButtons(), active = preferred ?? available.find(control => control === doc.activeElement) ?? available.find(control => control.tabIndex === 0) ?? available[0];
    for (const control of available) control.tabIndex = control === active ? 0 : -1;
  }
  function showChoices(focus: HTMLButtonElement = collection) {
    screen = 'choices'; composing = false; draft = false; canLeaveCreate = undefined; returnFromCreate = undefined; createAvailability = undefined;
    choices.hidden = false; heading.textContent = 'New database'; form.replaceChildren(); error.hidden = true; availability();
    if (live()) focus.focus();
  }
  root.addEventListener('focusin', event => {
    if (event.target instanceof doc.defaultView!.HTMLButtonElement && navigationButtons().includes(event.target)) updateTabStops(event.target);
  });
  root.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || busy || !live()) return;
    if (event.key === 'Escape' && !(event.target instanceof doc.defaultView!.HTMLSelectElement)) {
      if (screen === 'choices' && !draft && !emptyRequest && !emptySource && cancel) { event.preventDefault(); event.stopPropagation(); cancel.click(); }
      else if (screen !== 'choices') {
        event.preventDefault(); event.stopPropagation();
        if (screen === 'existing' && error.hidden) showChoices();
        else if (screen === 'create' && canLeaveCreate?.()) returnFromCreate?.();
      }
      return;
    }
    const available = navigationButtons(), index = available.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !available.length) return;
    const next = event.key === 'ArrowDown' ? (index + 1) % available.length : event.key === 'ArrowUp' ? (index - 1 + available.length) % available.length : event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : undefined;
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); updateTabStops(available[next]); available[next].focus(); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); available[index].click(); }
  });
  availability(); if (live()) (options.service ? empty : notes).focus();
  function showCollections() {
    if (busy || !live() || retainedCreate) return;
    if (!options.service) { error.textContent = 'Collections are unavailable in this vault.'; error.hidden = false; return; }
    screen = 'existing'; composing = false; canLeaveCreate = undefined; returnFromCreate = undefined; createAvailability = undefined; choices.hidden = true; heading.textContent = 'Choose a collection'; form.replaceChildren();
    const list = element(doc, 'div'); list.className = 'collection-source-existing';
    const create = button(doc, 'Create a collection', () => showCreate('existing', create));
    form.append(create, list, button(doc, 'Back', () => showChoices()));
    if (live()) create.focus();
    void run(async () => {
      const response = await options.service!.request({ op: 'list' }); if (!live()) return;
      for (const item of response.collections.filter(item => !item.deleted)) list.append(button(doc, item.name, () => { void select({ kind: 'collection', id: item.id }); }));
      if (!list.childNodes.length) list.append(element(doc, 'p', 'No collections yet.'));
    });
  }
  function showCreate(origin: 'choices' | 'existing', originButton: HTMLButtonElement, initialPreset: 'blank' | 'tasks' = 'blank') {
    if (!options.service || busy || !live() || retainedCreate || screen === 'create' && !canLeaveCreate?.()) return;
    screen = 'create'; composing = false; draft = true; choices.hidden = true; form.replaceChildren(); heading.textContent = 'New data source';
    const initialName = initialPreset === 'tasks' ? 'Tasks' : '';
    const name = element(doc, 'input'); name.value = initialName; name.placeholder = 'Collection name'; name.setAttribute('aria-label', 'Collection name');
    const preset = element(doc, 'select'); preset.setAttribute('aria-label', 'Collection preset');
    for (const [value, label] of [['blank', 'Start blank'], ['tasks', 'Tasks']] as const) { const option = element(doc, 'option', label); option.value = value; preset.append(option); }
    preset.value = initialPreset;
    let request: Extract<DatabaseRequest, {op:'create'}> | undefined, source: BaseViewSource | undefined, accepted = false, uncertain = false;
    let capturedDraft: {name: string; preset: string} | undefined;
    const hint = element(doc, 'p'); hint.className = 'collection-source-create-hint'; hint.setAttribute('role', 'status'); hint.hidden = true;
    const submit = button(doc, 'Create collection', () => { void run(async () => {
      try {
        if (!source) {
          if (!request) {
            capturedDraft = {name: name.value, preset: preset.value};
            request = { op: 'create', operationId: operationId(), name: name.value.trim(), preset: preset.value as 'blank' | 'tasks' };
            retainedCreate = true;
          }
          await submitCollection(options,request,async(response,recovering,validateAttempt)=>{
            validateAttempt();if(!live())throw new Error('This collection control was closed.');accepted = true;
            if (response.projection.pending || response.projection.issues.length) throw new Error(response.projection.issues.map(issue => issue.message).join('\n') || 'The collection is committed locally but its files still need publication. Retry creation.');
            const created = response.collections.filter(item => !item.deleted && item.name === request!.name);
            if (created.length!==1) throw new Error('The collection was not returned unambiguously. Retry this creation.');
            source = { kind: 'collection', id: created[0].id };await options.choose(source,recovering,validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.');
          });
        }else await options.choose(source);
        if (live()) { request = undefined; source = undefined; capturedDraft = undefined; retainedCreate = false; accepted = false; uncertain = false; draft = false; }
      } catch (problem) {
        const rejected = problem as {source?: unknown; commitUncertain?: unknown};
        if (!accepted && !uncertain && !source && rejected?.source === 'host' && rejected.commitUncertain === false) { request = undefined; capturedDraft = undefined; retainedCreate = false; }
        else if (request && !(rejected?.source === 'host' && rejected.commitUncertain === false)) uncertain = true;
        throw problem;
      }
    }); });
    canLeaveCreate = () => !request && !source && name.value === initialName && preset.value === initialPreset;
    returnFromCreate = () => {
      if (busy || request || source) return;
      if (origin === 'choices') showChoices(originButton); else showCollections();
    };
    const back = button(doc, 'Back', () => returnFromCreate?.());
    createAvailability = () => {
      retainedCreate = !!request || !!source;
      if (capturedDraft) { name.value = capturedDraft.name; preset.value = capturedDraft.preset; }
      name.readOnly = retainedCreate; preset.disabled = busy || retainedCreate; back.disabled = busy || !!request || !!source;
      hint.hidden = !!canLeaveCreate?.();
      hint.textContent = retainedCreate ? 'Retry this creation to finish linking the original data source.' : 'Use Back to cancel this setup.';
    };
    name.addEventListener('input', availability); preset.addEventListener('change', availability);
    name.addEventListener('keydown', event => { if (event.key === 'Enter' && !composing && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); submit.click(); } });
    form.append(name, preset, submit, back, hint); availability(); name.focus();
  }
  return { element: root, hasPendingChanges: () => busy || draft, destroy() { if(destroyed)return;destroyed = true;options.onDestroy?.(); doc.removeEventListener('focusin', outsideFocus, true); doc.removeEventListener('pointerdown', outsideFocus, true); doc.defaultView?.removeEventListener('blur', windowBlur); root.remove(); } };
}

export interface CollectionEditorOptions {
  readonly service: DatabaseService;
  readonly submit?:CollectionSubmit;
  readonly onDestroy?:()=>void;
  readonly collection: DatabaseCollection;
  readonly entries: readonly DatabaseEntry[];
  readonly isCurrent: () => boolean;
  readonly onSaved: (collection: DatabaseCollection,recovering?:boolean,validateAttempt?:()=>void) => Promise<void>;
  readonly onClose: () => void;
  readonly propertyId?: string;
  /** Existing single-property editors may float at their invoking header. Full managers ignore this. */
  readonly anchor?: HTMLElement;
}
export interface CollectionEditor { readonly element: HTMLElement; hasPendingChanges(): boolean; destroy(): void }

export interface CollectionPropertyPickerOptions extends Omit<CollectionEditorOptions, 'entries' | 'propertyId'> {
  /** Optional header/button anchor. Unanchored hosts may position the picker themselves. */
  readonly anchor?: HTMLElement;
}

const datatypeIcons: Record<typeof datatypes[number], string> = {
  text: 'Aa', number: '#', select: '⌄', 'multi-select': '≡', status: '◉', date: '▦', datetime: '◷', checkbox: '☑',
};
const pickerDatatypes = ['text', 'number', 'select', 'multi-select', 'status', 'date', 'checkbox', 'datetime'] as const;

/** Add one property through the same revision-bound schema command as the full editor. */
export function mountCollectionPropertyPicker(container: HTMLElement, options: CollectionPropertyPickerOptions): CollectionEditor {
  const doc = container.ownerDocument, root = element(doc, 'section');
  root.className = 'collection-property-picker'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Add property');
  const header = element(doc, 'div'); header.className = 'collection-property-picker-header';
  const icon = element(doc, 'span', 'Aa'); icon.className = 'collection-property-type-icon'; icon.setAttribute('aria-hidden', 'true');
  const name = element(doc, 'input'); name.placeholder = 'Type property name…'; name.setAttribute('aria-label', 'Type property name…');
  const grid = element(doc, 'div'); grid.className = 'collection-property-type-grid'; grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', 'Property type');
  const error = element(doc, 'p'); error.setAttribute('role', 'alert'); error.hidden = true;
  const retry = button(doc, 'Retry creation', () => { void save(); }); retry.hidden = true;
  let destroyed = false, busy = false, dirty = false, selected = 0, request: DatabaseRequest | undefined;
  let accepted: DatabaseCollection | undefined;
  const live = () => !destroyed && options.isCurrent();
  const choices: HTMLButtonElement[] = [];
  const setSelected = (index: number, focus = false) => {
    selected = Math.max(0, Math.min(choices.length - 1, index));
    choices.forEach((choice, index) => { choice.tabIndex = index === selected ? 0 : -1; choice.classList.toggle('is-active', index === selected); });
    if (focus) choices[selected]?.focus();
  };
  function controls() {
    name.readOnly = busy || !!request;
    choices.forEach(choice => { choice.disabled = busy || !!request; });
    retry.disabled = busy;
    cancel.disabled = busy || !!request;
  }
  function close() {
    if (busy || request || !live()) return;
    dirty = false; options.onClose();
  }
  async function save(type = pickerDatatypes[selected]) {
    if (busy || !live()) return;
    if (!request) {
      setSelected(pickerDatatypes.indexOf(type));
      let propertyName = name.value.trim();
      if (!propertyName) {
        propertyName = labels[type]; let suffix = 1;
        while (options.collection.properties.some(property => property.name === propertyName)) propertyName = `${labels[type]} ${++suffix}`;
      }
      const property: DatabasePropertyInput = { name: propertyName, datatype: type,
        options: type === 'status' ? categories.map((category, index) => ({ name: categoryLabels[index], category })) : [] };
      request = { op: 'update', operationId: operationId(), collectionId: options.collection.id,
        expectedRevision: options.collection.revision, name: options.collection.name,
        properties: [...structuredClone(options.collection.properties), property] };
    }
    busy = true; root.setAttribute('aria-busy', 'true'); error.hidden = true; controls();
    try {
      if (!accepted) {
        await submitCollection(options,request,async(response,recovering,validateAttempt)=>{
          validateAttempt();if(!live())throw new Error('This collection control was closed.');
          if (response.projection.pending || response.projection.issues.length) throw new Error(response.projection.issues.map(issue => issue.message).join('\n') || 'The property is committed locally but its files still need publication. Retry creation.');
          accepted = response.collections.find(collection => collection.id === options.collection.id);
          if (!accepted) throw new Error('The updated collection was not returned. Retry creation.');
          await options.onSaved(accepted,recovering,validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.');
        });
      }else await options.onSaved(accepted);
      if (live()) { request = undefined; dirty = false; options.onClose(); }
    } catch (problem) {
      if (live()) {
        // Only a verified terminal host rejection permits a new command. Lost
        // replies/publication failures retain the original operation identity.
        const rejected = problem as { source?: unknown; commitUncertain?: unknown };
        if (!accepted && rejected?.source === 'host' && rejected.commitUncertain === false) request = undefined;
        error.textContent = problemText(problem); error.hidden = false; retry.hidden = false;
        if (request) retry.focus(); else name.focus();
      }
    } finally {
      busy = false; root.removeAttribute('aria-busy'); controls();
    }
  }
  const cancel = button(doc, 'Cancel', close); cancel.className = 'collection-property-picker-cancel';
  name.addEventListener('input', () => { dirty = true; });
  name.addEventListener('keydown', event => {
    if (event.isComposing || busy || request) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save('text'); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); setSelected(0, true); }
  });
  pickerDatatypes.forEach((type, index) => {
    if (index % 2 === 0) { const row = element(doc, 'div'); row.className = 'collection-property-type-row'; row.setAttribute('role', 'row'); grid.append(row); }
    const cell = element(doc, 'div'); cell.setAttribute('role', 'gridcell');
    const choice = button(doc, labels[type], () => { void save(type); }); choice.dataset.datatype = type;
    const symbol = element(doc, 'span', datatypeIcons[type]); symbol.className = 'collection-property-type-icon'; symbol.setAttribute('aria-hidden', 'true'); choice.prepend(symbol);
    choice.addEventListener('pointerenter', () => { if (!busy && !request) setSelected(index); });
    choice.addEventListener('focus', () => { if (!busy && !request) setSelected(index); });
    choice.addEventListener('keydown', event => {
      if (event.isComposing || busy || request) return;
      const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowDown' ? index + 2 : event.key === 'ArrowUp' ? index - 2 : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowUp' && index < 2) name.focus(); else setSelected(next, true);
    });
    choices.push(choice); cell.append(choice); grid.lastElementChild!.append(cell);
  });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } });
  const outside = (event: PointerEvent) => {
    if (!root.contains(event.target as Node) && !options.anchor?.contains(event.target as Node) && !dirty) close();
  };
  const position = () => {
    if (!options.anchor?.isConnected) return;
    const rect = options.anchor.getBoundingClientRect(), view = doc.defaultView;
    root.classList.add('is-anchored');
    root.style.left = `${Math.max(8, Math.min(rect.left, (view?.innerWidth ?? 1024) - 316))}px`;
    root.style.top = `${Math.max(8, Math.min(rect.bottom + 4, (view?.innerHeight ?? 768) - root.offsetHeight - 8))}px`;
  };
  header.append(icon, name); root.append(header, element(doc, 'p', 'Select type'), grid, error, retry, cancel); container.append(root);
  setSelected(0); position(); name.focus();
  doc.addEventListener('pointerdown', outside, true); doc.addEventListener('scroll', position, true); doc.defaultView?.addEventListener('resize', position);
  return { element: root, hasPendingChanges: () => busy || dirty || !!request, destroy() {
    if(destroyed)return;destroyed = true;options.onDestroy?.(); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('scroll', position, true); doc.defaultView?.removeEventListener('resize', position); root.remove();
  } };
}

/** Failed saves retain the exact names/options and their original revision. */
export function mountCollectionEditor(container: HTMLElement, options: CollectionEditorOptions): CollectionEditor {
  if (options.propertyId && !options.collection.properties.some(property => property.id === options.propertyId)) throw new Error('This property is no longer available.');
  const doc = container.ownerDocument, root = element(doc, 'section'); root.className = 'collection-property-editor'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Collection properties');
  const title = element(doc, 'h3', 'Collection properties'), name = element(doc, 'input'); name.value = options.collection.name; name.setAttribute('aria-label', 'Collection name');
  const focusedProperty = options.propertyId ? options.collection.properties.find(property => property.id === options.propertyId) : undefined;
  if (focusedProperty) { root.classList.add('is-single-property'); root.setAttribute('aria-label', 'Edit property'); title.textContent = 'Edit property'; name.hidden = true; }
  const list = element(doc, 'div'), error = element(doc, 'p'); error.setAttribute('role', 'alert'); error.hidden = true;
  let properties: DatabasePropertyInput[] = [...structuredClone(options.collection.properties)], busy = false, destroyed = false, dirty = false, destructiveConfirmed = false;
  let request: DatabaseRequest | undefined;
  const live = () => !destroyed && options.isCurrent();
  const anchor = focusedProperty ? options.anchor : undefined, view = doc.defaultView;
  const place = () => {
    if (!live() || !root.isConnected || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect(), width = root.offsetWidth || 390;
    root.classList.add('is-anchored');
    root.style.left = `${Math.max(8, Math.min(rect.left, (view?.innerWidth ?? 1024) - width - 8))}px`;
    root.style.top = `${Math.max(8, Math.min(rect.bottom + 4, (view?.innerHeight ?? 768) - root.offsetHeight - 8))}px`;
  };
  const changed = () => { dirty = true; request = undefined; };
  const compactAction = (control: HTMLButtonElement, action: 'up' | 'down' | 'remove') => {
    if (!focusedProperty) return control;
    const text = control.textContent ?? '', label = element(doc, 'span', text); label.className = 'collection-property-action-label'; label.setAttribute('aria-hidden', 'true');
    control.classList.add('collection-property-icon-button'); control.setAttribute('aria-label', text); control.title = text; control.dataset.action = action;
    control.replaceChildren(icon(action === 'remove' ? 'trash' : 'down', 16, doc), label); return control;
  };
  name.addEventListener('input', changed);
  function confirmRemoval(label: string, count: number, remove: () => void, host: HTMLElement) {
    const confirmation = element(doc, 'div'); confirmation.className = 'collection-delete-confirmation';
    confirmation.append(element(doc, 'p', `Remove ${label}? This changes ${count} ${count === 1 ? 'entry' : 'entries'}.`), button(doc, 'Cancel', () => confirmation.remove()), button(doc, 'Remove', () => { destructiveConfirmed = true; remove(); changed(); render(); })); host.append(confirmation);
  }
  type MoveFocus = { property: DatabasePropertyInput; option?: NonNullable<DatabasePropertyInput['options']>[number]; direction: 'up' | 'down' };
  function moveProperty(index: number, delta: -1 | 1, control: HTMLButtonElement) {
    const next = index + delta; if (next < 0 || next >= properties.length) return;
    const property = properties[index], restore = doc.activeElement === control;
    [properties[index], properties[next]] = [properties[next], properties[index]];
    changed(); render(restore ? { property, direction: delta === -1 ? 'up' : 'down' } : undefined);
  }
  function moveOption(index: number, optionIndex: number, delta: -1 | 1, control: HTMLButtonElement) {
    const next = [...properties[index].options ?? []], destination = optionIndex + delta;
    if (destination < 0 || destination >= next.length) return;
    const option = next[optionIndex], restore = doc.activeElement === control;
    [next[optionIndex], next[destination]] = [next[destination], next[optionIndex]];
    const property = properties[index] = { ...properties[index], options: next };
    changed(); render(restore ? { property, option, direction: delta === -1 ? 'up' : 'down' } : undefined);
  }
  function render(moveFocus?: MoveFocus) {
    let focusTarget: HTMLButtonElement | undefined;
    list.replaceChildren();
    properties.forEach((property, index) => {
      if (focusedProperty && property.id !== focusedProperty.id) return;
      const row = element(doc, 'div'); row.className = 'collection-property-row'; row.dataset.propertyId = property.id ?? '';
      const label = element(doc, 'input'); label.value = property.name; label.setAttribute('aria-label', `${property.name || 'New property'} name`);
      label.addEventListener('input', () => { properties[index] = { ...properties[index], name: label.value }; changed(); });
      const type = element(doc, 'select'); type.setAttribute('aria-label', `${property.name || 'New property'} type`);
      for (const value of datatypes) { const option = element(doc, 'option', labels[value]); option.value = value; type.append(option); } type.value = property.datatype;
      const changeType = () => {
        const datatype = type.value as DatabaseProperty['datatype'], hasOptions = ['select', 'multi-select', 'status'].includes(datatype);
        const options = hasOptions ? properties[index].options?.map(option => ({ ...option, ...(datatype === 'status' ? { category: option.category ?? 'not_started' as const } : { category: undefined }) })) ?? [] : [];
        if (datatype === 'status' && !options.length) for (let i = 0; i < categories.length; i++) options.push({ name: categoryLabels[i], category: categories[i] });
        properties[index] = { ...properties[index], datatype, options,default:undefined }; changed(); render();
        if (focusedProperty) list.querySelector<HTMLButtonElement>('.collection-property-current-type')?.focus();
      };
      type.addEventListener('change', changeType);
      const count = options.entries.filter(entry => property.id && entry.values[property.id] != null).length;
      row.append(label, type);
      const propertyControls = focusedProperty ? element(doc, 'div') : row;
      if (focusedProperty) { propertyControls.className = 'collection-property-controls'; row.append(propertyControls); }
      if (focusedProperty) {
        type.hidden = true;
        const types = element(doc, 'div'); types.className = 'collection-property-edit-types'; types.hidden = true; types.setAttribute('role', 'menu'); types.setAttribute('aria-label', 'Property type');
        const toggle = button(doc, labels[property.datatype], () => { types.hidden = !types.hidden; toggle.setAttribute('aria-expanded', String(!types.hidden)); if (!types.hidden) types.querySelector<HTMLButtonElement>(`[data-datatype="${property.datatype}"]`)?.focus(); });
        toggle.className = 'collection-property-current-type'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-label', `${property.name} type`);
        pickerDatatypes.forEach((datatype, typeIndex) => {
          const choice = button(doc, labels[datatype], () => { type.value = datatype; changeType(); }); choice.dataset.datatype = datatype; choice.setAttribute('role', 'menuitemradio'); choice.setAttribute('aria-checked', String(property.datatype === datatype));
          const symbol = element(doc, 'span', datatypeIcons[datatype]); symbol.className = 'collection-property-type-icon'; symbol.setAttribute('aria-hidden', 'true'); choice.prepend(symbol);
          choice.addEventListener('keydown', event => {
            const delta = event.key === 'ArrowDown' ? 2 : event.key === 'ArrowUp' ? -2 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : undefined;
            if (delta !== undefined) { event.preventDefault(); event.stopPropagation(); types.querySelectorAll<HTMLButtonElement>('button')[Math.max(0, Math.min(pickerDatatypes.length - 1, typeIndex + delta))]?.focus(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); types.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
          }); types.append(choice);
        }); propertyControls.append(toggle); row.append(types);
      }
      const moveUp = compactAction(button(doc, 'Move property up', () => moveProperty(index, -1, moveUp)), 'up');
      const moveDown = compactAction(button(doc, 'Move property down', () => moveProperty(index, 1, moveDown)), 'down');
      if (moveFocus?.property === property && !moveFocus.option) focusTarget = moveFocus.direction === 'up' ? moveUp : moveDown;
      propertyControls.append(moveUp, moveDown, compactAction(button(doc, 'Remove property', () => confirmRemoval(`“${label.value}”`, count, () => { properties.splice(index, 1); }, row)), 'remove'));
      if (['select', 'multi-select', 'status'].includes(property.datatype)) {
        const choices = element(doc, 'div'); choices.className = 'collection-option-list';
        (property.options ?? []).forEach((option, optionIndex) => {
          const optionRow = element(doc, 'div'), optionName = element(doc, 'input'); optionName.value = option.name; optionName.setAttribute('aria-label', `${property.name} option ${optionIndex + 1}`);
          const optionControls = focusedProperty ? element(doc, 'div') : optionRow;
          if (focusedProperty) { optionName.className = 'collection-option-name'; optionControls.className = 'collection-option-controls'; optionControls.classList.toggle('has-category', property.datatype === 'status'); }
          optionName.addEventListener('input', () => { const next = [...properties[index].options ?? []]; next[optionIndex] = { ...next[optionIndex], name: optionName.value }; properties[index] = { ...properties[index], options: next }; changed(); }); optionRow.append(optionName);
          if (property.datatype === 'status') {
            const category = element(doc, 'select'); if (focusedProperty) category.className = 'collection-option-category'; category.setAttribute('aria-label', `${option.name} status category`);
            categories.forEach((value, i) => { const item = element(doc, 'option', categoryLabels[i]); item.value = value; category.append(item); }); category.value = option.category ?? 'not_started';
            category.addEventListener('change', () => { const next = [...properties[index].options ?? []]; next[optionIndex] = { ...next[optionIndex], category: category.value as typeof categories[number] }; properties[index] = { ...properties[index], options: next }; changed(); }); optionControls.append(category);
          }
          const color=element(doc,'select');if(focusedProperty)color.className='collection-option-color';color.setAttribute('aria-label',`${option.name} color`);
          for(const value of ['', 'gray','red','orange','yellow','green','blue','purple','pink']){const item=element(doc,'option',value?value[0].toUpperCase()+value.slice(1):'Default color');item.value=value;color.append(item);}color.value=option.color??'';
          const paintColor = () => { if (focusedProperty) { if (color.value) optionRow.dataset.optionColor = color.value; else delete optionRow.dataset.optionColor; } }; paintColor();
          color.addEventListener('change',()=>{const next=[...properties[index].options??[]];next[optionIndex]={...next[optionIndex],color:color.value||undefined};properties[index]={...properties[index],options:next};changed();paintColor();});optionControls.append(color);
          const moveOptionUp = compactAction(button(doc, 'Move option up', () => moveOption(index, optionIndex, -1, moveOptionUp)), 'up');
          const moveOptionDown = compactAction(button(doc, 'Move option down', () => moveOption(index, optionIndex, 1, moveOptionDown)), 'down');
          if (moveFocus?.property === property && moveFocus.option === option) focusTarget = moveFocus.direction === 'up' ? moveOptionUp : moveOptionDown;
          optionControls.append(moveOptionUp, moveOptionDown);
          const used = options.entries.filter(entry => property.id && option.id && (entry.values[property.id] === option.id || Array.isArray(entry.values[property.id]) && (entry.values[property.id] as unknown[]).includes(option.id))).length;
          optionControls.append(compactAction(button(doc, 'Remove option', () => confirmRemoval(`“${optionName.value}”`, used, () => { const next = [...properties[index].options ?? []]; next.splice(optionIndex, 1); const previousDefault=properties[index].default; const selectedDefault=Array.isArray(previousDefault)?previousDefault.filter(id=>id!==option.id):previousDefault===option.id?undefined:previousDefault;properties[index] = { ...properties[index], options: next,default:selectedDefault }; }, optionRow)), 'remove')); if (focusedProperty) optionRow.append(optionControls); choices.append(optionRow);
        });
        const addOption = button(doc, 'Add option', () => { properties[index] = { ...properties[index], options: [...properties[index].options ?? [], { name: 'New option', ...(property.datatype === 'status' ? { category: 'not_started' as const } : {}) }] }; changed(); render(); });
        if (focusedProperty) { addOption.className = 'collection-option-add'; addOption.prepend(icon('plus', 14, doc)); } choices.append(addOption); row.append(choices);
      }
      const defaultLabel=element(doc,'label','Default value');
      if(['select','status','multi-select'].includes(property.datatype)){
        const input=element(doc,'select');input.setAttribute('aria-label',`${property.name} default`);input.multiple=property.datatype==='multi-select';
        if(!input.multiple){const empty=element(doc,'option','No default');empty.value='';input.append(empty);}
        for(const option of property.options??[]){if(!option.id)continue;const item=element(doc,'option',option.name);item.value=option.id;item.selected=Array.isArray(property.default)?property.default.includes(option.id):property.default===option.id;input.append(item);}
        if(!input.multiple)input.value=typeof property.default==='string'?property.default:'';
        input.addEventListener('change',()=>{properties[index]={...properties[index],default:input.multiple?[...input.selectedOptions].map(option=>option.value):input.value||undefined};changed();});defaultLabel.append(input);
      }else if(property.datatype==='checkbox'){
        const input=element(doc,'select');input.setAttribute('aria-label',`${property.name} default`);for(const [value,text]of [['','No default'],['true','Checked'],['false','Unchecked']]){const item=element(doc,'option',text);item.value=value;input.append(item);}input.value=typeof property.default==='boolean'?String(property.default):'';
        input.addEventListener('change',()=>{properties[index]={...properties[index],default:input.value?input.value==='true':undefined};changed();});defaultLabel.append(input);
      }else{
        const input=element(doc,'input');input.setAttribute('aria-label',`${property.name} default`);input.placeholder='No default';input.type=property.datatype==='number'?'number':property.datatype==='date'?'date':property.datatype==='datetime'?'datetime-local':'text';input.value=property.default==null?'':String(property.default);
        input.addEventListener('input',()=>{properties[index]={...properties[index],default:input.value===''?undefined:property.datatype==='number'?Number(input.value):input.value};changed();});defaultLabel.append(input);
      }
      row.append(defaultLabel);list.append(row);
    });
    // Object identity is local to this synchronous render, so duplicate names
    // and unsaved fields/options need no fake schema IDs or index-based rebinding.
    if (focusTarget && live() && root.isConnected && (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)) focusTarget.focus();
    place();
  }
  const add = button(doc, 'Add property', () => { properties.push({ name: 'New property', datatype: 'text', options: [] }); changed(); render(); list.lastElementChild?.querySelector('input')?.focus(); });
  add.hidden = !!focusedProperty;
  const cancel = button(doc, 'Cancel', () => { if (!busy) options.onClose(); });
  const save = button(doc, 'Apply', () => { if (busy || !live()) return; busy = true; root.setAttribute('aria-busy', 'true');
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = true;
    error.hidden = true;
    if (!request) request = { op: 'update', operationId: operationId(), collectionId: options.collection.id, expectedRevision: options.collection.revision, name: name.value.trim(), properties: structuredClone(properties), confirmDestructive: destructiveConfirmed };
    void submitCollection(options,request,async(response,recovering,validateAttempt)=>{ validateAttempt();if (!live()) throw new Error('This collection control was closed.'); if(response.projection.pending||response.projection.issues.length)throw new Error(response.projection.issues.map(issue=>issue.message).join('\n')||'The properties are committed locally but their files still need publication. Retry Apply.'); const collection = response.collections.find(item => item.id === options.collection.id); if (!collection) throw new Error('The updated collection was not returned.'); await options.onSaved(collection,recovering,validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.'); }).then(()=>{if(live()){dirty=false;options.onClose();}}).catch(problem => { if (live()) { error.textContent = problemText(problem); error.hidden = false; } }).finally(() => { busy = false; root.removeAttribute('aria-busy'); for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = false; });
  });
  if (focusedProperty) root.addEventListener('keydown', event => {
    if (event.isComposing || busy) return;
    if (event.key === 'Escape' && !request) { event.preventDefault(); event.stopPropagation(); dirty = false; options.onClose(); }
    else if (event.key === 'Enter' && event.target === list.querySelector('.collection-property-row > input')) { event.preventDefault(); event.stopPropagation(); save.click(); }
  });
  if (focusedProperty) { const footer = element(doc, 'div'); footer.className = 'collection-property-footer'; footer.append(cancel, save); root.append(title, name, list, add, error, footer); }
  else root.append(title, name, list, add, error, cancel, save); container.append(root); render();
  const resize = anchor && view?.ResizeObserver ? new view.ResizeObserver(place) : undefined;
  if (anchor) { doc.addEventListener('scroll', place, true); view?.addEventListener('resize', place); resize?.observe(root); }
  const first = options.propertyId ? list.querySelector<HTMLElement>(`[data-property-id="${options.propertyId}"] input`) : name;
  first?.focus();
  return { element: root, hasPendingChanges: () => dirty || busy, destroy() { if(destroyed)return;destroyed = true;options.onDestroy?.(); doc.removeEventListener('scroll', place, true); view?.removeEventListener('resize', place); resize?.disconnect(); root.remove(); } };
}

export interface CollectionBrowserOptions {
  readonly service: DatabaseService;
  readonly submit?:CollectionSubmit;
  readonly onDestroy?:()=>void;
  readonly isCurrent: () => boolean;
  readonly open: (collection: DatabaseCollection) => Promise<void>;
  readonly openEntry: (entry: DatabaseEntry) => Promise<void>;
  readonly duplicatePath: (entry: DatabaseEntry) => string;
  readonly onMutation: (validateAttempt?:()=>void) => Promise<void>;
}
/** Collections remain reachable after their last linked Base has been deleted. */
export function mountCollectionBrowser(container: HTMLElement, options: CollectionBrowserOptions): {destroy():void} {
  const doc=container.ownerDocument,root=element(doc,'section');root.className='collection-browser';root.setAttribute('aria-label','Collections');
  const heading=element(doc,'h2','Collections'),list=element(doc,'div'),detail=element(doc,'div'),error=element(doc,'p');error.setAttribute('role','alert');error.hidden=true;root.append(heading,list,detail,error);container.append(root);
  let destroyed=false,busy=false,current:DatabaseCollection|undefined,request:DatabaseRequest|undefined;
  const retry=button(doc,'Retry unfinished operation',()=>{if(request)void run(()=>mutate(request!));});retry.hidden=true;root.append(retry);
  const live=()=>!destroyed&&options.isCurrent();
  async function run(action:()=>Promise<void>){if(busy||!live())return;busy=true;error.hidden=true;root.setAttribute('aria-busy','true');for(const control of root.querySelectorAll<HTMLButtonElement>('button'))control.disabled=true;try{await action();}catch(problem){if(live()){error.textContent=problemText(problem);error.hidden=false;}}finally{busy=false;root.removeAttribute('aria-busy');for(const control of root.querySelectorAll<HTMLButtonElement>('button'))control.disabled=false;retry.hidden=!request;}}
  async function refresh(validateAttempt:()=>void=()=>{}){const response=await options.service.request({op:'list'});validateAttempt();if(!live())return;list.replaceChildren();for(const collection of response.collections){const row=element(doc,'div');row.className='collection-browser-item';row.append(button(doc,collection.name+(collection.deleted?' (deleted)':''),()=>{void run(()=>select(collection.id));}));list.append(row);}if(!list.childNodes.length)list.append(element(doc,'p','Create a collection from a Base’s Add view menu.'));}
  async function mutate(command:DatabaseRequest){if(request&&JSON.stringify({...request,operationId:undefined})!==JSON.stringify({...command,operationId:undefined}))throw new Error('Retry the unfinished collection operation before starting another one.');request??=command;await submitCollection(options,request,async(reply,recovering,validateAttempt)=>{validateAttempt();if(!live())throw new Error('This collection control was closed.');if(reply.projection.pending||reply.projection.issues.length)throw new Error(reply.projection.issues.map(issue=>issue.message).join('\n')||'Some collection files still need publication. Retry this operation.');request=undefined;if(!recovering){await options.onMutation(validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.');await refresh(validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.');if(current){await select(current.id,validateAttempt);validateAttempt();if(!live())throw new Error('This collection control was closed.');}}});}
  async function select(id:string,validateAttempt:()=>void=()=>{}){const reply=await options.service.request({op:'get',collectionId:id});validateAttempt();if(!live())return;const collection=reply.collections.find(item=>item.id===id);if(!collection)throw new Error('This collection is unavailable.');current=collection;detail.replaceChildren();detail.append(element(doc,'h3',collection.name));
    if(collection.deleted){detail.append(element(doc,'p','This collection and its entries are in Trash.'),button(doc,'Restore collection',()=>{void run(()=>mutate({op:'restore',operationId:operationId(),collectionId:collection.id,expectedRevision:collection.revision}));}));return;}
    detail.append(button(doc,'Open collection',()=>{void run(()=>options.open(collection));}));
    detail.append(button(doc,'Delete collection',()=>{
      const confirmation=element(doc,'div');confirmation.className='collection-delete-confirmation';confirmation.append(element(doc,'p',`Move “${collection.name}” and all ${reply.entries.filter(entry=>!entry.deleted).length} entries to Trash? Views and other notes are kept.`),button(doc,'Cancel',()=>confirmation.remove()),button(doc,'Move to Trash',()=>{void run(()=>mutate({op:'delete',operationId:operationId(),collectionId:collection.id,expectedRevision:collection.revision}));}));detail.append(confirmation);
    }));
    const entries=element(doc,'div');entries.className='collection-browser-entries';
    for(const entry of reply.entries.filter(entry=>!entry.deleted)){
      let duplicate:DatabaseRequest|undefined;
      const row=element(doc,'div');row.className='collection-browser-entry';row.append(button(doc,entry.path.replace(/\.md$/i,''),()=>{void run(()=>options.openEntry(entry));}),button(doc,'Duplicate',()=>{duplicate??={op:'duplicate_entry',operationId:operationId(),entryId:entry.entryId,expectedRevision:entry.revision,newEntryId:crypto.randomUUID(),path:options.duplicatePath(entry)};void run(()=>mutate(duplicate!));}));entries.append(row);
    }
    if(!entries.childNodes.length)entries.append(element(doc,'p','No entries yet. Use New in a collection view.'));detail.append(entries);
  }
  void run(refresh);
  return{destroy(){if(destroyed)return;destroyed=true;options.onDestroy?.();root.remove();}};
}
