import type { DatabaseService, DatabaseCollection, DatabaseProperty, DatabasePropertyInput, DatabaseEntry, DatabaseRequest } from '../core/databases.ts';
import type { BaseViewSource } from '../bases/document.ts';
import {validDateText} from '../bases/property-definitions.ts';
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

export interface SourceChooserOptions {
  readonly service?: DatabaseService;
  readonly isCurrent: () => boolean;
  readonly choose: (source: BaseViewSource) => Promise<void>;
  readonly onCancel?: () => void;
  readonly onError?: (problem: unknown) => void;
}
export interface SourceChooser { readonly element: HTMLElement; hasPendingChanges(): boolean; destroy(): void }

/** First-view and Add-view onboarding share the same source selector. */
export function mountSourceChooser(container: HTMLElement, options: SourceChooserOptions): SourceChooser {
  const doc = container.ownerDocument, root = element(doc, 'section'); root.className = 'collection-source-chooser'; root.setAttribute('aria-label', 'Choose view source');
  const heading = element(doc, 'h2', 'What would you like to see?');
  const choices = element(doc, 'div'); choices.className = 'collection-source-choices';
  const form = element(doc, 'div'), error = element(doc, 'p'); error.setAttribute('role', 'alert'); error.hidden = true;
  let destroyed = false, busy = false, draft = false;
  const live = () => !destroyed && options.isCurrent();
  async function run(action: () => Promise<void>) {
    if (busy || !live()) return;
    busy = true; root.setAttribute('aria-busy', 'true'); error.hidden = true;
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = true;
    try { await action(); }
    catch (problem) { if (live()) { error.textContent = problemText(problem); error.hidden = false; options.onError?.(problem); } }
    finally { busy = false; root.removeAttribute('aria-busy'); for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = false; }
  }
  const select = (source: BaseViewSource) => run(async () => { if (!live()) throw new Error('This view changed.'); await options.choose(source); });
  const notes = button(doc, 'Notes in your vault', () => { void select({ kind: 'untyped' }); });
  notes.append(element(doc, 'small', 'Browse note titles, previews and file information.'));
  const collection = button(doc, 'A collection of things', () => { draft = true; showCollections(); });
  collection.append(element(doc, 'small', 'Organize entries with your own properties.'));
  choices.append(notes, collection);
  root.append(heading, choices, form, error);
  if (options.onCancel) root.append(button(doc, 'Cancel', () => { if (!busy) options.onCancel!(); }));
  container.append(root);
  function showCollections() {
    if (!options.service) { error.textContent = 'Collections are unavailable in this vault.'; error.hidden = false; return; }
    choices.hidden = true; heading.textContent = 'Choose a collection'; form.replaceChildren();
    const list = element(doc, 'div'); list.className = 'collection-source-existing';
    const create = button(doc, 'Create a collection', showCreate);
    form.append(create, list, button(doc, 'Back', () => { draft = false; choices.hidden = false; heading.textContent = 'What would you like to see?'; form.replaceChildren(); error.hidden = true; }));
    void run(async () => {
      const response = await options.service!.request({ op: 'list' }); if (!live()) return;
      for (const item of response.collections.filter(item => !item.deleted)) list.append(button(doc, item.name, () => { void select({ kind: 'collection', id: item.id }); }));
      if (!list.childNodes.length) list.append(element(doc, 'p', 'No collections yet.'));
    });
  }
  function showCreate() {
    form.replaceChildren(); heading.textContent = 'Create a collection';
    const name = element(doc, 'input'); name.placeholder = 'Collection name'; name.setAttribute('aria-label', 'Collection name');
    const preset = element(doc, 'select'); preset.setAttribute('aria-label', 'Collection preset');
    for (const [value, label] of [['blank', 'Start blank'], ['tasks', 'Tasks']] as const) { const option = element(doc, 'option', label); option.value = value; preset.append(option); }
    let request: DatabaseRequest | undefined, signature = '';
    const submit = button(doc, 'Create collection', () => { void run(async () => {
      const next = JSON.stringify([name.value.trim(), preset.value]);
      if (!request || signature !== next) { signature = next; request = { op: 'create', operationId: operationId(), name: name.value.trim(), preset: preset.value as 'blank' | 'tasks' }; }
      const response = await options.service!.request(request); if (!live()) return;
      if(response.projection.pending||response.projection.issues.length)throw new Error(response.projection.issues.map(issue=>issue.message).join('\n')||'The collection is committed locally but its files still need publication. Retry creation.');
      const created = response.collections.find(item => !item.deleted);
      if (!created) throw new Error('The collection was not returned. Retry this creation.');
      await options.choose({ kind: 'collection', id: created.id });
    }); });
    name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit.click(); } });
    form.append(name, preset, submit, button(doc, 'Back', () => { if (!busy) showCollections(); })); name.focus();
  }
  return { element: root, hasPendingChanges: () => busy || draft, destroy() { destroyed = true; root.remove(); } };
}

export interface CollectionEditorOptions {
  readonly service: DatabaseService;
  readonly collection: DatabaseCollection;
  readonly entries: readonly DatabaseEntry[];
  readonly isCurrent: () => boolean;
  readonly onSaved: (collection: DatabaseCollection) => Promise<void>;
  readonly onClose: () => void;
  readonly propertyId?: string;
}
export interface CollectionEditor { readonly element: HTMLElement; hasPendingChanges(): boolean; destroy(): void }

/** Failed saves retain the exact names/options and their original revision. */
export function mountCollectionEditor(container: HTMLElement, options: CollectionEditorOptions): CollectionEditor {
  const doc = container.ownerDocument, root = element(doc, 'section'); root.className = 'collection-property-editor'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Collection properties');
  const title = element(doc, 'h3', 'Collection properties'), name = element(doc, 'input'); name.value = options.collection.name; name.setAttribute('aria-label', 'Collection name');
  const list = element(doc, 'div'), error = element(doc, 'p'); error.setAttribute('role', 'alert'); error.hidden = true;
  let properties: DatabasePropertyInput[] = [...structuredClone(options.collection.properties)], busy = false, destroyed = false, dirty = false, destructiveConfirmed = false;
  let request: DatabaseRequest | undefined;
  const live = () => !destroyed && options.isCurrent();
  const changed = () => { dirty = true; request = undefined; };
  name.addEventListener('input', changed);
  function confirmRemoval(label: string, count: number, remove: () => void, host: HTMLElement) {
    const confirmation = element(doc, 'div'); confirmation.className = 'collection-delete-confirmation';
    confirmation.append(element(doc, 'p', `Remove ${label}? This changes ${count} ${count === 1 ? 'entry' : 'entries'}.`), button(doc, 'Cancel', () => confirmation.remove()), button(doc, 'Remove', () => { destructiveConfirmed = true; remove(); changed(); render(); })); host.append(confirmation);
  }
  function render() {
    list.replaceChildren();
    properties.forEach((property, index) => {
      const row = element(doc, 'div'); row.className = 'collection-property-row'; row.dataset.propertyId = property.id ?? '';
      const label = element(doc, 'input'); label.value = property.name; label.setAttribute('aria-label', `${property.name || 'New property'} name`);
      label.addEventListener('input', () => { properties[index] = { ...properties[index], name: label.value }; changed(); });
      const type = element(doc, 'select'); type.setAttribute('aria-label', `${property.name || 'New property'} type`);
      for (const value of datatypes) { const option = element(doc, 'option', labels[value]); option.value = value; type.append(option); } type.value = property.datatype;
      type.addEventListener('change', () => {
        const datatype = type.value as DatabaseProperty['datatype'], hasOptions = ['select', 'multi-select', 'status'].includes(datatype);
        const options = hasOptions ? properties[index].options?.map(option => ({ ...option, ...(datatype === 'status' ? { category: option.category ?? 'not_started' as const } : { category: undefined }) })) ?? [] : [];
        if (datatype === 'status' && !options.length) for (let i = 0; i < categories.length; i++) options.push({ name: categoryLabels[i], category: categories[i] });
        properties[index] = { ...properties[index], datatype, options,default:undefined }; changed(); render();
      });
      const count = options.entries.filter(entry => property.id && entry.values[property.id] != null).length;
      row.append(label, type, button(doc,'Move property up',()=>{if(index===0)return;[properties[index-1],properties[index]]=[properties[index],properties[index-1]];changed();render();}),button(doc,'Move property down',()=>{if(index===properties.length-1)return;[properties[index+1],properties[index]]=[properties[index],properties[index+1]];changed();render();}), button(doc, 'Remove property', () => confirmRemoval(`“${label.value}”`, count, () => { properties.splice(index, 1); }, row)));
      if (['select', 'multi-select', 'status'].includes(property.datatype)) {
        const choices = element(doc, 'div'); choices.className = 'collection-option-list';
        (property.options ?? []).forEach((option, optionIndex) => {
          const optionRow = element(doc, 'div'), optionName = element(doc, 'input'); optionName.value = option.name; optionName.setAttribute('aria-label', `${property.name} option ${optionIndex + 1}`);
          optionName.addEventListener('input', () => { const next = [...properties[index].options ?? []]; next[optionIndex] = { ...next[optionIndex], name: optionName.value }; properties[index] = { ...properties[index], options: next }; changed(); }); optionRow.append(optionName);
          if (property.datatype === 'status') {
            const category = element(doc, 'select'); category.setAttribute('aria-label', `${option.name} status category`);
            categories.forEach((value, i) => { const item = element(doc, 'option', categoryLabels[i]); item.value = value; category.append(item); }); category.value = option.category ?? 'not_started';
            category.addEventListener('change', () => { const next = [...properties[index].options ?? []]; next[optionIndex] = { ...next[optionIndex], category: category.value as typeof categories[number] }; properties[index] = { ...properties[index], options: next }; changed(); }); optionRow.append(category);
          }
          const color=element(doc,'select');color.setAttribute('aria-label',`${option.name} color`);
          for(const value of ['', 'gray','red','orange','yellow','green','blue','purple','pink']){const item=element(doc,'option',value?value[0].toUpperCase()+value.slice(1):'Default color');item.value=value;color.append(item);}color.value=option.color??'';
          color.addEventListener('change',()=>{const next=[...properties[index].options??[]];next[optionIndex]={...next[optionIndex],color:color.value||undefined};properties[index]={...properties[index],options:next};changed();});optionRow.append(color);
          optionRow.append(button(doc,'Move option up',()=>{if(optionIndex===0)return;const next=[...properties[index].options??[]];[next[optionIndex-1],next[optionIndex]]=[next[optionIndex],next[optionIndex-1]];properties[index]={...properties[index],options:next};changed();render();}),button(doc,'Move option down',()=>{const next=[...properties[index].options??[]];if(optionIndex===next.length-1)return;[next[optionIndex+1],next[optionIndex]]=[next[optionIndex],next[optionIndex+1]];properties[index]={...properties[index],options:next};changed();render();}));
          const used = options.entries.filter(entry => property.id && option.id && (entry.values[property.id] === option.id || Array.isArray(entry.values[property.id]) && (entry.values[property.id] as unknown[]).includes(option.id))).length;
          optionRow.append(button(doc, 'Remove option', () => confirmRemoval(`“${optionName.value}”`, used, () => { const next = [...properties[index].options ?? []]; next.splice(optionIndex, 1); const previousDefault=properties[index].default; const selectedDefault=Array.isArray(previousDefault)?previousDefault.filter(id=>id!==option.id):previousDefault===option.id?undefined:previousDefault;properties[index] = { ...properties[index], options: next,default:selectedDefault }; }, optionRow))); choices.append(optionRow);
        });
        choices.append(button(doc, 'Add option', () => { properties[index] = { ...properties[index], options: [...properties[index].options ?? [], { name: 'New option', ...(property.datatype === 'status' ? { category: 'not_started' as const } : {}) }] }; changed(); render(); })); row.append(choices);
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
  }
  const add = button(doc, 'Add property', () => { properties.push({ name: 'New property', datatype: 'text', options: [] }); changed(); render(); list.lastElementChild?.querySelector('input')?.focus(); });
  const cancel = button(doc, 'Cancel', () => { if (!busy) options.onClose(); });
  const save = button(doc, 'Apply', () => { if (busy || !live()) return; busy = true; root.setAttribute('aria-busy', 'true');
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = true;
    error.hidden = true;
    if (!request) request = { op: 'update', operationId: operationId(), collectionId: options.collection.id, expectedRevision: options.collection.revision, name: name.value.trim(), properties: structuredClone(properties), confirmDestructive: destructiveConfirmed };
    void options.service.request(request).then(async response => { if (!live()) return; if(response.projection.pending||response.projection.issues.length)throw new Error(response.projection.issues.map(issue=>issue.message).join('\n')||'The properties are committed locally but their files still need publication. Retry Apply.'); const collection = response.collections.find(item => item.id === options.collection.id); if (!collection) throw new Error('The updated collection was not returned.'); await options.onSaved(collection); if (live()) { dirty = false; options.onClose(); } }).catch(problem => { if (live()) { error.textContent = problemText(problem); error.hidden = false; } }).finally(() => { busy = false; root.removeAttribute('aria-busy'); for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = false; });
  });
  root.append(title, name, list, add, error, cancel, save); container.append(root); render();
  const first = options.propertyId ? list.querySelector<HTMLElement>(`[data-property-id="${options.propertyId}"] input`) : name;
  first?.focus();
  return { element: root, hasPendingChanges: () => dirty || busy, destroy() { destroyed = true; root.remove(); } };
}

export interface CollectionBrowserOptions {
  readonly service: DatabaseService;
  readonly isCurrent: () => boolean;
  readonly open: (collection: DatabaseCollection) => Promise<void>;
  readonly openEntry: (entry: DatabaseEntry) => Promise<void>;
  readonly duplicatePath: (entry: DatabaseEntry) => string;
  readonly onMutation: () => Promise<void>;
}
/** Collections remain reachable after their last linked Base has been deleted. */
export function mountCollectionBrowser(container: HTMLElement, options: CollectionBrowserOptions): {destroy():void} {
  const doc=container.ownerDocument,root=element(doc,'section');root.className='collection-browser';root.setAttribute('aria-label','Collections');
  const heading=element(doc,'h2','Collections'),list=element(doc,'div'),detail=element(doc,'div'),error=element(doc,'p');error.setAttribute('role','alert');error.hidden=true;root.append(heading,list,detail,error);container.append(root);
  let destroyed=false,busy=false,current:DatabaseCollection|undefined,request:DatabaseRequest|undefined;
  const retry=button(doc,'Retry unfinished operation',()=>{if(request)void run(()=>mutate(request!));});retry.hidden=true;root.append(retry);
  const live=()=>!destroyed&&options.isCurrent();
  async function run(action:()=>Promise<void>){if(busy||!live())return;busy=true;error.hidden=true;root.setAttribute('aria-busy','true');for(const control of root.querySelectorAll<HTMLButtonElement>('button'))control.disabled=true;try{await action();}catch(problem){if(live()){error.textContent=problemText(problem);error.hidden=false;}}finally{busy=false;root.removeAttribute('aria-busy');for(const control of root.querySelectorAll<HTMLButtonElement>('button'))control.disabled=false;retry.hidden=!request;}}
  async function refresh(){const response=await options.service.request({op:'list'});if(!live())return;list.replaceChildren();for(const collection of response.collections){const row=element(doc,'div');row.className='collection-browser-item';row.append(button(doc,collection.name+(collection.deleted?' (deleted)':''),()=>{void run(()=>select(collection.id));}));list.append(row);}if(!list.childNodes.length)list.append(element(doc,'p','Create a collection from a Base’s Add view menu.'));}
  async function mutate(command:DatabaseRequest){if(request&&JSON.stringify({...request,operationId:undefined})!==JSON.stringify({...command,operationId:undefined}))throw new Error('Retry the unfinished collection operation before starting another one.');request??=command;const reply=await options.service.request(request);if(reply.projection.pending||reply.projection.issues.length)throw new Error(reply.projection.issues.map(issue=>issue.message).join('\n')||'Some collection files still need publication. Retry this operation.');request=undefined;await options.onMutation();await refresh();if(current)await select(current.id);}
  async function select(id:string){const reply=await options.service.request({op:'get',collectionId:id});if(!live())return;const collection=reply.collections.find(item=>item.id===id);if(!collection)throw new Error('This collection is unavailable.');current=collection;detail.replaceChildren();detail.append(element(doc,'h3',collection.name));
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
  return{destroy(){destroyed=true;root.remove();}};
}
