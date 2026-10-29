import { createBaseFilterOperand } from './toolbar-filter-operands.ts';
import type { BaseFilterOperand, BaseFilterOperandsSnapshot,BaseFilterOperandAdmissionDraft } from './toolbar-filter-operands.ts';
import type { BaseFilterLiteral, BaseFilterOperatorDescriptor, BaseFilterPropertyDescriptor } from './toolbar-filter-types.ts';

export interface BaseFilterValuesOptions {
  operator: BaseFilterOperatorDescriptor;
  property: BaseFilterPropertyDescriptor;
  values?: readonly BaseFilterLiteral[];
  snapshot?: BaseFilterOperandsSnapshot;
  alive?(): boolean;
  onChange(): void;
  onDraftChange?(): void;
}
export interface BaseFilterValueControlDraft {
  readonly value:string;readonly type:string;readonly checked:boolean;readonly indeterminate:boolean;readonly focus:boolean;
  readonly selectionStart:number|null;readonly selectionEnd:number|null;readonly selectionDirection:'forward'|'backward'|'none'|null;
}
export type BaseFilterValueModelDraft=
 |{readonly kind:'empty'}
 |{readonly kind:'scalar';readonly edited:boolean;readonly raw:string;readonly checkboxValue?:boolean;readonly offset:string;readonly preserveRawDate:boolean}
 |{readonly kind:'members';readonly items:readonly BaseFilterLiteral[];readonly initialized:boolean;readonly pristine:boolean;readonly pendingIntent:boolean;readonly itemType:string;readonly memberError:string}
 |{readonly kind:'delegate';readonly committed:readonly string[];readonly captured?:readonly BaseFilterLiteral[];readonly touched:boolean;readonly delegate?:BaseFilterOperandAdmissionDraft};
export interface BaseFilterValuesAdmissionDraft {
  readonly witness:string;readonly initial?:readonly BaseFilterLiteral[];
  readonly state:{readonly explicitNull:boolean;readonly model:BaseFilterValueModelDraft;readonly control?:BaseFilterValueControlDraft;readonly focusKey?:string;readonly choices?:{readonly open:boolean;readonly activeValue?:string}};
  readonly ready:Promise<void>;
}
const completedValueDrafts=new WeakSet<BaseFilterValuesAdmissionDraft>();
export interface BaseFilterValues {
  canCaptureAdmissionDraft():boolean;
  captureFreeze():BaseFilterValuesAdmissionDraft|undefined;
  restoreAdmissionDraft(draft:BaseFilterValuesAdmissionDraft):boolean;
  read(): { values?: readonly BaseFilterLiteral[]; error?: string };
  hasDraft(): boolean;
  focus(): void;
  destroy(): void;
}

const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function parseNumber(raw: string): number | undefined { const value = numberPattern.test(raw) ? Number(raw) : NaN; return Number.isFinite(value) ? value : undefined; }
function copy(value: BaseFilterLiteral): BaseFilterLiteral { return Array.isArray(value) ? value.map(copy) : value; }
function copyValues(values: readonly BaseFilterLiteral[]): readonly BaseFilterLiteral[] { return values.map(copy); }
function display(value: BaseFilterLiteral): string { return typeof value === 'string' ? value : JSON.stringify(value); }
function dateShape(raw: string): { civil: string; suffix: string; timed: boolean } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(raw);
  if (!match) return;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return;
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59)) return;
  const suffix = match[8] ?? '';
  if (suffix && suffix !== 'Z' && (Number(suffix.slice(1, 3)) > 23 || Number(suffix.slice(4, 6)) > 59)) return;
  return { civil: suffix ? raw.slice(0, -suffix.length) : raw, suffix, timed: match[4] !== undefined };
}
function parseJSONLiteral(raw: string): { value?: BaseFilterLiteral; error?: string } {
  try {
    const parsed: unknown = JSON.parse(raw), queue: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
    let count = 0;
    while (queue.length) {
      const item = queue.pop()!;
      if (++count > 10000 || item.depth > 64) return { error: 'This item is too large or deeply nested.' };
      if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue;
      if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
      if (!Array.isArray(item.value)) return { error: 'Use text, numbers, checkboxes, null, or lists.' };
      for (const value of item.value) queue.push({ value, depth: item.depth + 1 });
    }
    return { value: parsed as BaseFilterLiteral };
  } catch { return { error: 'Enter a valid JSON value.' }; }
}

/** Values are expression literals; widgets never evaluate code or infer types from result rows. */
export function createBaseFilterValues(doc: Document, container: HTMLElement, options: BaseFilterValuesOptions): BaseFilterValues {
  const root = doc.createElement('div'); root.className = 'bases-filter-values bases-filter-operand'; container.append(root);
  let initial = options.values === undefined ? undefined : copyValues(options.values);
  const disposers: (() => void)[] = [];const focusControls=new Map<string,HTMLElement>();
  let frozen=false,restoring=false,restoredFocusPassive=false,interacted=false,capturedDraft:BaseFilterValuesAdmissionDraft|undefined;
  let freezeModel:()=>Promise<void>=()=>Promise.resolve();
  let captureModel:()=>BaseFilterValueModelDraft|undefined=()=>undefined,restoreModel:(model:BaseFilterValueModelDraft)=>boolean=()=>false;
  let destroyed = false, explicitNull = !!options.operator.comparison && options.operator.arity !== 'none' && initial?.length === 1 && initial[0] === null;
  let primary: HTMLInputElement | HTMLTextAreaElement | undefined, delegate: BaseFilterOperand | undefined;
  let nullIndicator: HTMLSpanElement | undefined;let captureChoices:()=>{open:boolean;activeValue?:string}|undefined=()=>undefined,restoreChoices:(state:{open:boolean;activeValue?:string})=>void=()=>{};
  let readValue: () => { values?: readonly BaseFilterLiteral[]; error?: string } = () => ({}), pending = () => false, reset = () => {};
  const usable = () => !destroyed && root.isConnected && container.contains(root) && (options.alive?.() ?? true);
  const interaction=(event:Event)=>{if(!frozen&&!restoring){interacted=true;restoredFocusPassive=false;}};for(const name of ['input','change','click','keydown']){root.addEventListener(name,interaction,true);disposers.push(()=>root.removeEventListener(name,interaction,true));}
  const enabled = (node: HTMLElement) => !frozen && usable() && node.isConnected && root.contains(node) && !node.matches(':disabled');
  function listen<T extends HTMLElement, K extends keyof HTMLElementEventMap>(node: T, name: K, handler: (event: HTMLElementEventMap[K]) => void) {
    const guarded = (event: Event) => { if (enabled(node)) {if(!restoring&&['input','change','click','keydown'].includes(name))interacted=true;handler(event as HTMLElementEventMap[K]);} };
    node.addEventListener(name, guarded); disposers.push(() => node.removeEventListener(name, guarded));
  }
  function notifyChange() { if (!frozen&&!restoring&&usable()) { if (nullIndicator) nullIndicator.hidden = !explicitNull; options.onChange(); } }
  function emit(node: HTMLElement) { if (enabled(node)) notifyChange(); }
  function draft(node: HTMLElement) { if (enabled(node)) options.onDraftChange?.(); }
  function button(label: string, action: (button: HTMLButtonElement) => void) {
    const node = doc.createElement('button'); node.type = 'button'; node.textContent = label; node.setAttribute('aria-label', label);focusControls.set(`action:${label}`,node); listen(node, 'click', () => action(node)); return node;
  }
  function input(type = 'text') {
    const node = doc.createElement('input'); node.type = type; node.setAttribute('aria-label', 'Filter value'); node.className = 'bases-filter-operand-input'; root.append(node); primary = node; return node;
  }
  function hint(text: string) { const node = doc.createElement('div'); node.className = 'bases-filter-value-hint'; node.setAttribute('role', 'status'); node.textContent = text; root.append(node); return node; }
  function choice(value: BaseFilterLiteral) { return typeof value === 'string' ? options.property.choices?.find(option => option.value === value) : undefined; }
  function label(value: BaseFilterLiteral) { return choice(value)?.label ?? display(value); }

  // A local picker keeps suggestion labels/colors separate from their stored literals.
  function choicesFor(control: HTMLInputElement, accept: (value: string) => void, allows = () => true) {
    if (!options.property.choices?.length) return;
    let popup: HTMLDivElement | undefined, list: HTMLDivElement | undefined, visible: NonNullable<BaseFilterPropertyDescriptor['choices']> = [], active = -1;
    const id = `base-filter-value-choices-${++nextChoicesId}`;
    const available = () => enabled(control) && allows();
    function close() { popup?.remove(); popup = undefined; list = undefined; active = -1; if (allows()) control.setAttribute('aria-expanded', 'false'); else control.removeAttribute('aria-expanded'); control.removeAttribute('aria-controls'); control.removeAttribute('aria-activedescendant'); doc.removeEventListener('pointerdown', outside, true); }
    function sync() {
      if (allows()) { control.setAttribute('role', 'combobox'); control.setAttribute('aria-autocomplete', 'list'); control.setAttribute('aria-expanded', String(!!popup)); }
      else { close(); control.removeAttribute('role'); control.removeAttribute('aria-autocomplete'); }
    }
    function outside(event: Event) {if(frozen)return;if (!usable() || !root.contains(event.target as Node)) close(); }
    function highlight(index: number) {
      active = index;
      for (const [i, row] of Array.from(list?.children ?? []).entries()) { row.classList.toggle('is-active', i === active); row.setAttribute('aria-selected', String(i === active)); }
      const row = active >= 0 ? list?.children[active] as HTMLElement | undefined : undefined;
      if (row) control.setAttribute('aria-activedescendant', row.id); else control.removeAttribute('aria-activedescendant');
      row?.scrollIntoView?.({ block: 'nearest' });
    }
    function render() {
      if (!popup || !list || !available()) return;
      const query = control.value.toLocaleLowerCase();
      visible = options.property.choices!.filter(option => (option.label ?? option.value).toLocaleLowerCase().includes(query) || option.value.toLocaleLowerCase().includes(query));
      list.replaceChildren(...visible.slice(0, 100).map((option, index) => {
        const row = doc.createElement('div'); row.className = 'bases-filter-operand-option'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false'); row.id = `${id}-${index}`; row.dataset.index = String(index); row.textContent = option.label ?? option.value; row.title = option.value;
        if (option.color) row.style.color = option.color;
        return row;
      }));
      popup.querySelector('[role="status"]')?.remove();
      const status = options.property.metadataStatus ?? 'current';
      const message = status === 'current' ? !visible.length ? 'No matching choices. You can enter a value.' : visible.length > 100 ? 'Showing the first 100 choices. Keep typing to narrow the list.' : ''
        : status === 'pending' ? 'Choices are still loading. You can enter a value.' : status === 'stale' ? 'Choices may be out of date. You can enter a value.' : 'Choices may be incomplete. You can enter a value.';
      if (message) { const statusNode = doc.createElement('div'); statusNode.setAttribute('role', 'status'); statusNode.textContent = message; popup.append(statusNode); }
      highlight(-1);
      const rect = control.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 220), Math.max(0, (doc.defaultView?.innerWidth ?? 1024) - 16));
      popup.style.position = 'fixed'; popup.style.width = `${width}px`; popup.style.maxHeight = '240px'; popup.style.left = `${Math.max(8, Math.min(rect.left, (doc.defaultView?.innerWidth ?? 1024) - width - 8))}px`; popup.style.top = `${rect.bottom + 4}px`;
    }
    function open() {
      if (!available() || popup) return;
      popup = doc.createElement('div'); popup.className = 'bases-filter-operand-popover'; list = doc.createElement('div'); list.id = id; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Filter value choices'); popup.append(list); root.append(popup);
      control.setAttribute('aria-expanded', 'true'); control.setAttribute('aria-controls', id); doc.addEventListener('pointerdown', outside, true); render();
    }
    sync();
    listen(control, 'focus', () => {if(!restoring&&!restoredFocusPassive)open();}); listen(control, 'click', open); listen(control, 'input', () => { open(); render(); });
    listen(control, 'keydown', event => {
      if (!available() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape' && popup) { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); open(); const count = Math.min(visible.length, 100); if (count) highlight(active < 0 ? event.key === 'ArrowDown' ? 0 : count - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count); }
      else if (event.key === 'Enter' && popup && active >= 0) { event.preventDefault(); event.stopImmediatePropagation(); const value = visible[active]?.value; close(); if (value !== undefined && available()) accept(value); }
      else if (event.key === 'Tab') close();
    });
    listen(root, 'focusout', event => { if (!root.contains(event.relatedTarget as Node | null)) close(); });
    const optionTarget = (event: Event) => { const target = event.target as Element | null, row = target?.nodeType === 1 ? target.closest<HTMLElement>('[role="option"]') : undefined; return row?.isConnected && list?.contains(row) ? row : undefined; };
    listen(root, 'pointerdown', event => { if (optionTarget(event) && available()) event.preventDefault(); });
    listen(root, 'pointermove', event => { const row = optionTarget(event); if (row && available()) highlight(Number(row.dataset.index)); });
    listen(root, 'click', event => { const row = optionTarget(event); if (!row || !available()) return; const value = visible[Number(row.dataset.index)]?.value; close(); if (value !== undefined) accept(value); });
    captureChoices=()=>({open:!!popup,activeValue:active>=0?visible[active]?.value:undefined});restoreChoices=state=>{if(!state.open)return;open();highlight(state.activeValue===undefined?-1:visible.findIndex(option=>option.value===state.activeValue));};
    disposers.push(close);
    return { sync, close };
  }

  const operand = options.operator.operand, comparison = !!options.operator.comparison && options.operator.arity !== 'none';
  const members = operand === 'list' || operand === 'tokens' || ((options.property.kind === 'list' || options.property.kind === 'tagList') && options.operator.method === 'contains');
  if (operand === 'none' || options.operator.arity === 'none') {readValue = () => ({ values: [] });captureModel=()=>({kind:'empty'});restoreModel=model=>model.kind==='empty';}
  else if (operand === 'readonly') {
    const node = doc.createElement('textarea'); node.readOnly = true; node.setAttribute('aria-label', 'Filter value'); node.value = initial === undefined ? '' : JSON.stringify(initial[0] ?? null); root.append(node); primary = node;
    hint(initial === undefined ? 'This value requires the expression editor.' : 'This value is preserved. Use the expression editor to change it.');
    captureModel=()=>({kind:'empty'});restoreModel=model=>model.kind==='empty';
    reset = () => { node.value = 'null'; };
    readValue = () => initial === undefined ? {} : { values: copyValues(initial) };
  } else if (members) {
    const exact = operand === 'list', single = options.operator.arity === 'one' && !exact;
    let items: BaseFilterLiteral[] = exact && Array.isArray(initial?.[0]) ? initial![0].map(copy) : !exact ? [...(initial ?? [])].map(copy) : [];
    let initialized = initial !== undefined, pristine = true, pendingIntent = false, itemType = 'string', memberError = '';
    const chips = doc.createElement('div'); chips.className = 'bases-filter-operand-chips'; root.append(chips);
    const type = doc.createElement('select'); type.setAttribute('aria-label', 'Item type');
    const textOnly = operand === 'tokens' && ['string', 'link', 'tag'].includes(options.property.kind);
    for (const [value, text] of (textOnly ? [['string', 'Text']] : [['string', 'Text'], ['number', 'Number'], ['boolean', 'Checkbox'], ['null', 'Null'], ['json', 'JSON']])) { const option = doc.createElement('option'); option.value = value; option.textContent = text; type.append(option); }
    root.append(type);focusControls.set('item-type',type); const field = input();
    const errorNode = doc.createElement('div'); errorNode.setAttribute('role', 'status'); root.append(errorNode);
    const pendingText = () => itemType === 'boolean' || itemType === 'null' ? pendingIntent : field.value.length > 0 || pendingIntent;
    function renderItems() {
      chips.replaceChildren(...items.map((value, index) => { const chip = doc.createElement('span'); chip.className = 'bases-filter-operand-chip'; chip.title = display(value); const text = doc.createElement('span'); text.textContent = label(value); const configured = choice(value); if (configured?.color) text.style.color = configured.color; const remove = doc.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove item ${display(value)}`); remove.textContent = '×'; remove.dataset.index = String(index);focusControls.set(`chip:${index}`,remove); chip.append(text, remove); return chip; }));
    }
    function clearDraft() { field.value = ''; field.checked = false; pendingIntent = false; memberError = ''; errorNode.textContent = ''; }
    function add(value?: BaseFilterLiteral) {
      if (!enabled(field) && itemType !== 'null') return;
      let result: { value?: BaseFilterLiteral; error?: string };
      if (value !== undefined) result = { value };
      else if (itemType === 'string') result = { value: field.value };
      else if (itemType === 'number') { const number = parseNumber(field.value); result = number === undefined ? { error: 'Enter a finite decimal number.' } : { value: number }; }
      else if (itemType === 'boolean') result = { value: field.checked };
      else if (itemType === 'null') result = { value: null };
      else result = parseJSONLiteral(field.value);
      if (result.error || result.value === undefined) { memberError = result.error ?? 'Enter an item.'; errorNode.textContent = memberError; draft(field); return; }
      items = single ? [copy(result.value)] : [...items, copy(result.value)]; initialized = true; pristine = false; explicitNull = false; clearDraft(); memberChoices?.close(); renderItems(); emit(type);
    }
    const memberChoices = choicesFor(field, value => add(value), () => itemType === 'string');
    listen(type, 'change', () => {
      if (pendingText()) { type.value = itemType; memberError = 'Add or clear the pending item before changing its type.'; errorNode.textContent = memberError; draft(type); return; }
      itemType = type.value; field.type = itemType === 'boolean' ? 'checkbox' : 'text'; field.hidden = itemType === 'null'; field.inputMode = itemType === 'number' ? 'decimal' : 'text'; clearDraft(); memberChoices?.sync(); pendingIntent = true; draft(type);
    });
    listen(field, 'input', () => { pendingIntent = true; memberError = ''; errorNode.textContent = ''; draft(field); });
    listen(field, 'change', () => { if (itemType === 'boolean') { pendingIntent = true; draft(field); } });
    listen(field, 'keydown', event => { if (!event.isComposing && !event.defaultPrevented && event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (pendingText()) add(); } });
    root.append(button('Add item', () => add()), button('Clear item', node => { clearDraft(); draft(node); }));
    listen(chips, 'click', event => {
      const target = event.target as HTMLElement, remove = target.closest<HTMLButtonElement>('button[data-index]');
      if (!remove || !chips.contains(remove) || !enabled(remove)) return;
      const focused = doc.activeElement === remove, index = Number(remove.dataset.index);
      items.splice(index, 1); initialized = true; pristine = false; explicitNull = false; renderItems();
      if (focused) {
        const adjacent = Array.from(chips.querySelectorAll<HTMLButtonElement>('button[data-index]'));
        (adjacent[Math.min(index, adjacent.length - 1)] ?? (!field.hidden ? field : root.querySelector<HTMLButtonElement>('[aria-label="Add item"]')))?.focus({ preventScroll: true });
      }
      emit(chips);
    });
    if (exact) root.append(button('Empty list', node => { items = []; initialized = true; pristine = false; explicitNull = false; clearDraft(); renderItems(); emit(node); }));
    pending = pendingText;
    reset = () => { clearDraft(); items = []; initialized = false; pristine = false; renderItems(); };
    captureModel=()=>({kind:'members',items:items.map(copy),initialized,pristine,pendingIntent,itemType,memberError});
    restoreModel=model=>{if(model.kind!=='members'||![...type.options].some(option=>option.value===model.itemType))return false;items=model.items.map(copy);initialized=model.initialized;pristine=model.pristine;pendingIntent=model.pendingIntent;itemType=model.itemType;memberError=model.memberError;type.value=itemType;field.type=itemType==='boolean'?'checkbox':'text';field.hidden=itemType==='null';field.inputMode=itemType==='number'?'decimal':'text';errorNode.textContent=memberError;renderItems();memberChoices?.sync();return true;};
    readValue = () => {
      if (pendingText()) return { error: memberError || 'Add or clear the pending item.' };
      if (!initialized) return {};
      if (pristine && initial !== undefined) return { values: copyValues(initial) };
      return { values: exact ? [items.map(copy)] : items.map(copy) };
    };
    renderItems();
  } else if (operand === 'file' || operand === 'folder' || operand === 'property' || operand === 'tags') {
    let captured = initial, touched = false;
    const exactTags = operand === 'tags' && comparison;
    const strings = explicitNull ? [] : exactTags && Array.isArray(initial?.[0]) ? initial![0] : initial;
    if (strings?.some(value => typeof value !== 'string')) {
      const node = doc.createElement('textarea'); node.readOnly = true; node.setAttribute('aria-label', 'Filter value'); node.value = JSON.stringify(initial); root.append(node); primary = node;
      hint('These typed values are preserved. Use the expression editor to change them.');captureModel=()=>({kind:'empty'});restoreModel=model=>model.kind==='empty'; reset = () => { node.value = 'null'; }; readValue = () => ({ values: copyValues(initial!) });
    } else {
      function createDelegate(values: readonly string[]) {
        delegate?.destroy();
        delegate = createBaseFilterOperand(doc, root, { kind: operand === 'tags' ? 'tag' : operand as 'file' | 'folder' | 'property', values, snapshot: options.snapshot,
          alive: () => !frozen&&usable() && !primary?.matches(':disabled'), onChange(next) { if (frozen||restoring||!usable()) return; touched = true; explicitNull = false; captured = exactTags ? [[...next]] : [...next]; notifyChange(); }, onDraftChange() { if (!frozen&&!restoring&&usable()) options.onDraftChange?.(); } });
        primary = root.querySelector<HTMLInputElement>('input')!;
      }
      createDelegate(strings as readonly string[] ?? []);
      let delegateDraft:BaseFilterOperandAdmissionDraft|undefined;freezeModel=()=>{delegateDraft=delegate!.captureFreeze();if(!delegateDraft)throw new Error('The original operand is not available for raw custody.');return delegateDraft.ready;};
      captureModel=()=>{if(!delegate!.canCaptureAdmissionDraft())return;const current=delegate!.read(),isTags=operand==='tags',committed=isTags&&delegate!.hasDraft()?current.slice(0,-1):current;
        const changed=!isTags&&JSON.stringify(current)!==JSON.stringify((captured??[]) as readonly BaseFilterLiteral[]);
        return{kind:'delegate',committed:[...committed],captured:changed?[...current]:captured&&copyValues(captured),touched:touched||changed,delegate:delegateDraft};};
      restoreModel=model=>{if(model.kind!=='delegate'||!model.delegate)return false;createDelegate(model.delegate.initialValues);if(!delegate!.restoreAdmissionDraft(model.delegate))return false;captured=model.captured&&copyValues(model.captured);touched=model.touched;return true;};
      pending = () => delegate!.hasDraft(); reset = () => { createDelegate([]); captured = undefined; touched = false; };
      readValue = () => delegate!.hasDraft() ? { error: 'Add or clear the pending tag.' } : !touched ? captured === undefined ? {} : { values: copyValues(captured) } : { values: copyValues(captured ?? []) };
      if (exactTags) root.append(button('Empty list', node => { createDelegate([]); captured = [[]]; touched = true; explicitNull = false; emit(node); }));
    }
  } else {
    let edited = false, raw = '', checkboxValue: boolean | undefined, offset = '', preserveRawDate = false;
    const initialValue = initial?.[0], isDate = operand === 'date' || operand === 'datetime';
    const field = input(operand === 'boolean' ? 'checkbox' : isDate ? operand === 'datetime' ? 'datetime-local' : 'date' : 'text');
    if (operand === 'datetime') field.step = 'any';
    if (operand === 'number') field.inputMode = 'decimal';
    if (typeof initialValue === 'string') raw = initialValue; else if (initialValue !== undefined && initialValue !== null) raw = display(initialValue);
    if (operand === 'boolean') { checkboxValue = typeof initialValue === 'boolean' ? initialValue : undefined; field.checked = checkboxValue ?? false; field.indeterminate = checkboxValue === undefined; }
    else if (isDate && raw) {
      const shape = dateShape(raw), fits = shape && (operand === 'datetime' ? shape.timed : !shape.timed) && (shape.civil.split('.')[1]?.length ?? 0) <= 3;
      if (fits) { field.value = shape.civil; offset = shape.suffix; }
      if (!fits || !field.value) { field.type = 'text'; field.value = raw; preserveRawDate = true; hint('Existing date text is preserved because it does not fit the native date control.'); }
    } else { const configured = choice(initialValue ?? null); field.value = configured?.label ?? raw; }
    let observedValue=field.value;
    const change = () => {
      observedValue=field.value;edited = true; explicitNull = false;
      if (operand === 'boolean') { checkboxValue = field.checked; field.indeterminate = false; }
      else raw = field.value + (isDate && field.type === 'datetime-local' && field.value ? offset : '');
      emit(field);
    };
    listen(field, operand === 'boolean' ? 'change' : 'input', change);
    if (operand === 'text') choicesFor(field, value => { edited = true; explicitNull = false; raw = value; field.value = choice(value)?.label ?? value; emit(field); });
    reset = () => { edited = true; raw = ''; field.value = ''; checkboxValue = undefined; field.checked = false; field.indeterminate = operand === 'boolean'; };
    captureModel=()=>({kind:'scalar',edited:edited||field.value!==observedValue,raw:field.value!==observedValue?field.value+(isDate&&field.type==='datetime-local'&&field.value?offset:''):raw,checkboxValue,offset,preserveRawDate});
    restoreModel=model=>{if(model.kind!=='scalar')return false;edited=model.edited;raw=model.raw;checkboxValue=model.checkboxValue;offset=model.offset;preserveRawDate=model.preserveRawDate;return true;};
    readValue = () => {
      if (!edited) return initial === undefined ? {} : { values: copyValues(initial) };
      if (operand === 'boolean') return checkboxValue === undefined ? {} : { values: [checkboxValue] };
      if (operand === 'number') { const number = parseNumber(raw); return number === undefined ? { error: 'Enter a finite decimal number.' } : { values: [number] }; }
      if (isDate) {
        const shape = dateShape(raw);
        if (!shape || (!preserveRawDate && (operand === 'datetime' ? !shape.timed : shape.timed))) return { error: operand === 'datetime' ? 'Enter a valid date and time.' : 'Enter a valid date.' };
      }
      return { values: [raw] };
    };
  }
  if (comparison) {
    nullIndicator = doc.createElement('span'); nullIndicator.className = 'bases-filter-value-null'; nullIndicator.textContent = 'Null'; nullIndicator.setAttribute('aria-label', 'Null value'); nullIndicator.hidden = !explicitNull;
    root.append(nullIndicator, button('Clear value', node => { reset(); explicitNull = true; emit(node); }));
  }
  const descriptor=()=>JSON.stringify([options.operator.id,options.operator.method,options.operator.comparison,options.operator.inverse,options.operator.arity,options.operator.operand,options.property.kind,options.property.withTime,options.property.comparisonWidget]);
  type Composition={composing:boolean;settling:boolean;start:string;update?:string;input?:{value:string;data:string|null;update?:string}};
  const compositions=new Map<EventTarget,Composition>();let finishCapture:(()=>void)|undefined;
  const valueOf=(target:EventTarget)=>target instanceof doc.defaultView!.HTMLInputElement||target instanceof doc.defaultView!.HTMLTextAreaElement?target.value:'';
  const compositionStart=(event:CompositionEvent)=>{if(event.target&&!frozen)compositions.set(event.target,{composing:true,settling:false,start:valueOf(event.target)});};
  const compositionUpdate=(event:CompositionEvent)=>{const state=event.target&&compositions.get(event.target);if(state?.composing)state.update=event.data;};
  const compositionInput=(event:Event)=>{const state=event.target&&compositions.get(event.target);if(!state)return;if(state.composing)state.input={value:valueOf(event.target!),data:(event as InputEvent).data??null,update:state.update};else{state.settling=false;finishCapture?.();}};
  const compositionEnd=(event:CompositionEvent)=>{const state=event.target&&compositions.get(event.target);if(!state)return;state.composing=false;const value=valueOf(event.target!);state.settling=!(event.data===''&&value===state.start||state.input?.value===value&&(state.input.data===event.data||state.input.update===event.data));finishCapture?.();};
  root.addEventListener('compositionstart',compositionStart,true);root.addEventListener('compositionupdate',compositionUpdate,true);root.addEventListener('input',compositionInput,true);root.addEventListener('compositionend',compositionEnd,true);
  disposers.push(()=>{root.removeEventListener('compositionstart',compositionStart,true);root.removeEventListener('compositionupdate',compositionUpdate,true);root.removeEventListener('input',compositionInput,true);root.removeEventListener('compositionend',compositionEnd,true);});
  const freezeControls=()=>{for(const control of root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button')){const composition=compositions.get(control);if(composition&&(composition.composing||composition.settling))continue;if(control instanceof doc.defaultView!.HTMLTextAreaElement||control instanceof doc.defaultView!.HTMLInputElement&&!['checkbox','radio','button','submit'].includes(control.type))control.readOnly=true;else control.disabled=true;}};
  const controlState=():BaseFilterValueControlDraft|undefined=>primary?{value:primary.value,type:primary.type,checked:'checked'in primary&&primary.checked,indeterminate:'indeterminate'in primary&&primary.indeterminate,focus:doc.activeElement===primary,selectionStart:primary.selectionStart,selectionEnd:primary.selectionEnd,selectionDirection:primary.selectionDirection}:undefined;
  const focusKey=()=>{if(doc.activeElement===primary)return'primary';for(const [key,node]of focusControls)if(node===doc.activeElement&&node.isConnected)return key;const chip=doc.activeElement instanceof doc.defaultView!.HTMLElement?doc.activeElement.closest<HTMLElement>('.bases-filter-operand-chip-remove[data-index]'):undefined;return chip&&root.contains(chip)?`delegate-chip:${chip.dataset.index}`:undefined;};
  const canCaptureAdmissionDraft=()=>!!capturedDraft||!destroyed&&root.isConnected&&!primary?.validity.badInput&&captureModel()!==undefined;
  function captureFreeze():BaseFilterValuesAdmissionDraft|undefined{
    if(capturedDraft)return capturedDraft;if(!canCaptureAdmissionDraft())return;frozen=true;
    const focus=controlState()?.focus??false,focused=focusKey();let modelReady=false;const modelCompletion=freezeModel();let state={explicitNull,model:captureModel()!,control:controlState(),focusKey:focused,choices:captureChoices()},resolve!:()=>void;const ready=new Promise<void>(yes=>{resolve=yes;});
    const captured:BaseFilterValuesAdmissionDraft={witness:descriptor(),initial:initial&&copyValues(initial),get state(){return state;},ready};capturedDraft=captured;freezeControls();
    finishCapture=()=>{if(!modelReady||completedValueDrafts.has(captured)||[...compositions].some(([target,state])=>target instanceof doc.defaultView!.Node&&root.contains(target)&&(state.composing||state.settling)))return;state={explicitNull,model:captureModel()!,control:controlState(),focusKey:focused,choices:captureChoices()};if(state.control)state={...state,control:{...state.control,focus}};freezeControls();completedValueDrafts.add(captured);resolve();finishCapture=undefined;};void modelCompletion.then(()=>{modelReady=true;finishCapture?.();},()=>{});finishCapture();return captured;
  }
  function restoreAdmissionDraft(captured:BaseFilterValuesAdmissionDraft):boolean{
    if(frozen||destroyed||interacted||[...compositions].some(([target,state])=>target instanceof doc.defaultView!.Node&&root.contains(target)&&(state.composing||state.settling))||!usable()||captured.witness!==descriptor()||JSON.stringify(initial)!==JSON.stringify(captured.initial)||!completedValueDrafts.has(captured))return false;
    const selected=captured.state.choices?.activeValue;if(selected!==undefined){const query=captured.state.control?.value.toLocaleLowerCase()??'';if(!captured.state.choices?.open||!options.property.choices?.some(option=>option.value===selected&&((option.label??option.value).toLocaleLowerCase().includes(query)||option.value.toLocaleLowerCase().includes(query))))return false;}
    restoring=true;try{
      if(!restoreModel(captured.state.model))return false;initial=captured.initial&&copyValues(captured.initial);explicitNull=captured.state.explicitNull;if(nullIndicator)nullIndicator.hidden=!explicitNull;
      const control=captured.state.control;if(control){if(!primary)return false;if(primary instanceof doc.defaultView!.HTMLInputElement){primary.type=control.type;primary.checked=control.checked;primary.indeterminate=control.indeterminate;}primary.value=control.value;
        try{if(control.selectionStart!==null&&control.selectionEnd!==null)primary.setSelectionRange(control.selectionStart,control.selectionEnd,control.selectionDirection??undefined);}catch{/* Native date/checkbox controls have no text selection. */}}
      if(captured.state.choices)restoreChoices(captured.state.choices);
      restoredFocusPassive=true;const key=captured.state.focusKey,target=key==='primary'?primary:key?.startsWith('delegate-chip:')?[...root.querySelectorAll<HTMLElement>('.bases-filter-operand-chip-remove[data-index]')].find(node=>node.dataset.index===key.slice(14)):key?focusControls.get(key):undefined;if(target?.isConnected)target.focus({preventScroll:true});else if(!key&&control?.focus)primary?.focus({preventScroll:true});
      return true;
    }finally{restoring=false;}
  }
  return {
    canCaptureAdmissionDraft,captureFreeze,restoreAdmissionDraft,
    read() { if (explicitNull && !pending()) return { values: [null] }; const result = readValue(); return result.values === undefined ? result : { ...result, values: copyValues(result.values) }; },
    hasDraft: () => pending(),
    focus() { if (usable()) { if (delegate) delegate.focus(); else primary?.focus({ preventScroll: true }); } },
    destroy() { if (destroyed) return; destroyed = true; delegate?.destroy(); for (const dispose of disposers.splice(0)) dispose(); root.remove(); },
  };
}

let nextChoicesId = 0;
