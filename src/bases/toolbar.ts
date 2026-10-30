import { reviewRetainedBaseConfiguration } from './configuration-review.ts';
import type { BaseConfigurationReview } from './configuration-review.ts';
import { BaseDocument } from './document.ts';
import type { BaseValue, BaseViewConfig, BaseViewPatch } from './document.ts';
import type { BaseQueryResult } from './query.ts';
import { normalizeBaseProperty } from './query.ts';
import { icon } from '../ui/icons.ts';
import {baseValueToString} from './expression.ts';
import { filterConditionValues, validateToolbarPatch } from './toolbar-config.ts';
import type { BaseFilterCondition, BaseFilterOperator } from './toolbar-config.ts';
import { createBaseFilterDraft, newBaseFilterCondition, newBaseFilterGroup, readBaseFilterDraft, updateBaseFilterCondition, updateBaseFilterExpression, captureBaseFilterAcknowledgement, baseFilterCount } from './toolbar-filter.ts';
import type { BaseFilterNode, BaseFilterDraftNode, BaseFilterDraftCondition, BaseFilterDraftGroup, BaseFilterConjunction } from './toolbar-filter.ts';
import type { BaseFilterOperandsSnapshot } from './toolbar-filter-operands.ts';
import {baseFilterOperators,baseFilterProperty,baseFilterMethod} from './toolbar-filter-types.ts';
import type {BaseFilterPropertyDescriptor,BaseFilterLiteral,BaseFilterOperatorDescriptor} from './toolbar-filter-types.ts';
export type {BaseFilterPropertyDescriptor} from './toolbar-filter-types.ts';
import {createBaseFilterValues} from './toolbar-filter-values.ts';
import type {BaseFilterValues,BaseFilterValuesAdmissionDraft} from './toolbar-filter-values.ts';
export type { BaseFilterOperandsSnapshot } from './toolbar-filter-operands.ts';
import { enhanceBaseFormulaEditor } from './toolbar-formula-editor.ts';
import type {BaseFormulaEditor,BaseFormulaAdmissionDraft} from './toolbar-formula-editor.ts';
import { createBaseCombobox } from './toolbar-combobox.ts';
import type {BaseCombobox,BaseComboboxAdmissionDraft} from './toolbar-combobox.ts';
import { createBaseManualGroups } from './toolbar-groups.ts';
import type {BaseManualGroupsAdmissionDraft} from './toolbar-groups.ts';
import { BASE_LAYOUTS, layoutIcon, uniqueViewName, validateViewName, createLayoutSettings, propertyDisplayPatch } from './toolbar-panels.ts';

export interface BaseToolbarState {
  result: BaseQueryResult;
  views: readonly BaseViewConfig[];
  selectedIndex: number;
  rootFilters?: BaseValue;
  root?: Readonly<Record<string, BaseValue>>;
  /** Effective configuration for this view; root remains the persisted witness. */
  settings?: Readonly<Record<string,BaseValue>>;
  search?: string;
  /** Presentation only; source identity remains in the saved view. */
  sourceLabel?: string;
  propertyType?(property: string): string | undefined;
  filterProperty?(property: string): BaseFilterPropertyDescriptor | undefined;
  functionNames?: readonly string[];
  methodNames?: readonly string[];
  readOnly: boolean;
  /** Untyped note sources expose browsing, filtering and sorting only. */
  browseOnly?: boolean;
  allowRename: boolean;
  label(property: string): string;
}
export type BaseToolbarExportFormat = 'csv' | 'tsv' | 'markdown' | 'paths';
export interface BaseToolbarCommands {
  updateView?(version: BaseQueryResult['version'], index: number, patch: BaseViewPatch): Promise<void>;
  editFormula?(version: BaseQueryResult['version'], originalName: string | undefined, name: string, expression: string): Promise<void>;
  addView?(version: BaseQueryResult['version'], type: string, name?: string, initial?: BaseViewPatch): Promise<void>;
  duplicateView?(version: BaseQueryResult['version'], index: number, name?: string): Promise<void>;
  removeView?(version: BaseQueryResult['version'], index: number): Promise<void>;
  moveView?(version: BaseQueryResult['version'], from: number, to: number): Promise<void>;
  setDefaultView?(version: BaseQueryResult['version'], index: number): Promise<void>;
  updateRoot?(version: BaseQueryResult['version'], patch: Record<string, BaseValue | undefined>): Promise<void>;
  setFormula?(version: BaseQueryResult['version'], name: string, expression?: string): Promise<void>;
  renameFormula?(version: BaseQueryResult['version'], from: string, to: string): Promise<void>;
}
export interface BaseToolbarOptions {
  preflight(action?:'new'): void;
  selectView(index: number): Promise<void>;
  save(version: BaseQueryResult['version'], patch: BaseViewPatch): Promise<void>;
  /** Reference mode persists changes in place; failures retain their exact draft. */
  immediate?: boolean;
  commands?: BaseToolbarCommands;
  saveConfiguration?(version: BaseQueryResult['version'], patch: { view?: BaseViewPatch; root?: Record<string, BaseValue | undefined> }): Promise<void>;
  onSearch?(text: string): void;
  onNew?(): Promise<void>;
  onExport?(format: BaseToolbarExportFormat, copy: boolean): Promise<void>;
  onPropertySettings?(property: string): void;
  onEditProperties?(): void;
  /** Read-only suggestions; their metadata status never changes filter meaning. */
  filterOperands?(): BaseFilterOperandsSnapshot;
  onDraftChange(): void;
  onError(error: unknown): void;
}
export type BaseToolbarPanelName = 'View settings' | 'Views' | 'View options' | 'Add view' | 'Results' | 'Property' | 'Formula' | 'New item settings' | 'Filter' | 'Sort' | 'Properties' | 'Group';
export type BaseToolbarRawPanelState={readonly kind:'new-item-settings';readonly folder:string;readonly template:string}|{readonly kind:'view-settings';readonly name:string}|{readonly kind:'results';readonly limit:string}|{readonly kind:'filter';readonly all:BaseToolbarFilterSectionDraft;readonly view:BaseToolbarFilterSectionDraft}
 |{readonly kind:'views';readonly search:string}
 |{readonly kind:'property';readonly display:string}
 |{readonly kind:'formula';readonly name:string;readonly expression:BaseToolbarExpressionDraft}
 |{readonly kind:'sort';readonly rules:readonly BaseValue[]}
 |{readonly kind:'properties';readonly search:string;readonly order:readonly string[];readonly names:readonly (readonly [string,string])[]}
 |{readonly kind:'group';readonly property:string;readonly direction:string;readonly manual?:BaseManualGroupsAdmissionDraft}
 |{readonly kind:'view-options'|'add-view';readonly name:string;readonly layout:string;readonly patch:BaseViewPatch};
export type BaseToolbarExpressionDraft={readonly kind:'native';readonly text:string}|{readonly kind:'formula';readonly draft:BaseFormulaAdmissionDraft};
export interface BaseToolbarFilterSectionDraft {readonly tree:BaseFilterDraftGroup;readonly expanded:boolean;readonly initialized:boolean;readonly values:readonly {readonly path:string;readonly draft:BaseFilterValuesAdmissionDraft}[];readonly expressions:readonly {readonly path:string;readonly raw:BaseToolbarExpressionDraft}[]}
export interface BaseToolbarAdmissionDraft {
  readonly panel:BaseToolbarPanelName;
  readonly target:{readonly selectedIndex:number;readonly viewId?:string;readonly formulaName?:string;readonly returnTo?:BaseToolbarPanelName};
  readonly configuration:{readonly views:readonly BaseViewConfig[];readonly root:Readonly<Record<string,BaseValue|undefined>>};
  readonly dirty:boolean;readonly innerDraft:boolean;
  readonly access:{readonly readOnly:boolean;readonly browseOnly:boolean;readonly allowRename:boolean};
  readonly comboboxes:readonly {readonly key:string;readonly draft:BaseComboboxAdmissionDraft}[];
  readonly raw:BaseToolbarRawPanelState;
  readonly controls:readonly {readonly key:string;readonly start:number|null;readonly end:number|null;readonly direction:'forward'|'backward'|'none'|null}[];
  readonly focus?:{readonly key:string;readonly start:number|null;readonly end:number|null;readonly direction:'forward'|'backward'|'none'|null};
  readonly validation:string;
  readonly ready:Promise<void>;
}
/** Human input only; saved configuration and native witnesses are never copied as drafts. */
export function baseToolbarAdmissionDraftText(draft:BaseToolbarAdmissionDraft):string {
  const expression=(raw:BaseToolbarExpressionDraft)=>raw.kind==='native'?raw.text:raw.draft.state.text;
  const literal=(value:BaseFilterLiteral)=>typeof value==='string'?value:JSON.stringify(value);
  const filterValue=(draft:BaseFilterValuesAdmissionDraft):string=>{
    const {model,control}=draft.state,parts:string[]=[];
    if(draft.state.explicitNull)parts.push('null');
    if(control)parts.push(control.type==='checkbox'?String(control.indeterminate?'unset':control.checked):control.value);
    if(model.kind==='scalar'&&model.checkboxValue!==undefined)parts.push(String(model.checkboxValue));
    if(model.kind==='members')parts.push(...model.items.map(literal));
    if(model.kind==='delegate'){parts.push(...model.committed);if(model.delegate)parts.push(...model.delegate.state.values,model.delegate.state.input);}
    if(draft.state.choices?.activeValue)parts.push(draft.state.choices.activeValue);
    return parts.filter(Boolean).join('\n');
  };
  const filterNames=(root:BaseFilterDraftNode):string[]=>root.kind==='condition'?(root.fields?[root.fields.property,root.fields.operator]:[]):root.children.flatMap(filterNames);
  let text:string;
  switch(draft.raw.kind){
    case'new-item-settings':text=`Folder: ${draft.raw.folder}\nTemplate: ${draft.raw.template}`;break;
    case'view-settings':text=draft.raw.name;break;
    case'results':text=draft.raw.limit;break;
    case'filter':text=[draft.raw.all,draft.raw.view].flatMap(section=>[...filterNames(section.tree),...section.values.map(value=>filterValue(value.draft)),...section.expressions.map(value=>expression(value.raw))]).filter(Boolean).join('\n');break;
    case'views':text=draft.raw.search;break;
    case'property':text=draft.raw.display;break;
    case'formula':text=`${draft.raw.name}\n${expression(draft.raw.expression)}`;break;
    case'sort':text=draft.raw.rules.map(rule=>mapping(rule)?[rule.property??rule.column??'',rule.direction??''].join(' '):typeof rule==='string'?rule:JSON.stringify(rule)).join('\n');break;
    case'properties':text=[draft.raw.search,...draft.raw.order,...draft.raw.names.map(([key,value])=>`${key}: ${value}`)].join('\n');break;
    case'group':text=[draft.raw.property,draft.raw.direction,...(draft.raw.manual?.state.rows.map(row=>baseValueToString(row.key))??[]),draft.raw.manual?.state.newGroup?.value??''].filter(Boolean).join('\n');break;
    case'view-options':case'add-view':text=[draft.raw.name,draft.raw.layout,...Object.entries(draft.raw.patch).map(([key,value])=>`${key}: ${typeof value==='string'?value:JSON.stringify(value)}`)].join('\n');break;
  }
  return[text,...draft.comboboxes.map(value=>value.draft.state.query).filter(Boolean)].filter(Boolean).join('\n');
}
const completedToolbarDrafts=new WeakSet<BaseToolbarAdmissionDraft>();
export interface BaseToolbar {
  update(state: BaseToolbarState): void;
  /** Metadata-only advice; never replaces query/context witnesses or actions. */
  refreshFilterAdvice(state: BaseToolbarState): void;
  hasDraft(): boolean;
  canCaptureAdmissionDraft():boolean;
  captureFreeze():BaseToolbarAdmissionDraft|undefined;
  /** Fence UI submissions while its original accepted save settles. */
  suspendAdmission():BaseToolbarAdmissionDraft|undefined;
  restoreAdmissionDraft(draft:BaseToolbarAdmissionDraft):'restored'|'pending'|'conflict';
  /** Only this live toolbar's current connected portal, including its child controls. */
  owns(node: Node): boolean;
  /** After accepted saves settle, retire this toolbar's clean portal only. */
  dismissCleanPanel(): void;
  captureSaveAcknowledgement(): () => void;
  destroy(): void;
}
type FilterNode = BaseFilterNode;
type PanelName = BaseToolbarPanelName;
interface Panel { acknowledgeAcceptedSave?():void;suspendAdmission?():BaseToolbarAdmissionDraft|undefined; hasUnfinishedInput?():boolean;canCaptureAdmissionDraft?():boolean;captureFreeze?():BaseToolbarAdmissionDraft|undefined;restoreRaw?(draft:BaseToolbarAdmissionDraft):boolean;rebase?(state: BaseToolbarState, expectedName?: string): boolean; refreshFilterAdvice?(state:BaseToolbarState):void; flush?(): void; name: PanelName; node: HTMLElement; trigger: HTMLElement; dirty: boolean; innerDraft?: boolean; saving: boolean; failure?: object; acceptsSaveAcknowledgement?: () => boolean; close(restore?: boolean): void }
/** Only a retained, exact accepted configuration may offer a persistence retry. */
export class BaseToolbarSaveError extends Error {
  readonly retry: () => Promise<void>;
  readonly review?:BaseConfigurationReview;
  constructor(message: string, retry: () => Promise<void>,review?:BaseConfigurationReview) { super(message); this.retry = retry;this.review=review; }
}
const invoke = (operation:()=>Promise<void>):Promise<void> => { try { return Promise.resolve(operation()); } catch (failure) { return Promise.reject(failure); } };
const mapping = (value: unknown): value is Record<string, BaseValue> => !!value && typeof value === 'object' && !Array.isArray(value);
function configurationSnapshot(state: BaseToolbarState): {views: BaseViewConfig[]; root: Record<string, BaseValue | undefined>} {
  const root = state.root ? Object.fromEntries(Object.entries(state.root).filter(([key]) => key !== 'views')) : {filters:state.rootFilters};
  return {views:structuredClone(state.views) as BaseViewConfig[],root};
}
function resultsConfigurationWitness(snapshot:ReturnType<typeof configurationSnapshot>):ReturnType<typeof configurationSnapshot>{
  const witness=structuredClone(snapshot);delete witness.root.summaries;for(const view of witness.views)delete (view as BaseViewPatch).summaries;return witness;
}
function applyConfigurationPatch(snapshot: ReturnType<typeof configurationSnapshot>, patch: {view?:BaseViewPatch;root?:Record<string,BaseValue|undefined>}, index: number): ReturnType<typeof configurationSnapshot> {
  const document=BaseDocument.parse(JSON.stringify({...snapshot.root,views:snapshot.views}));
  document.updateViewConfiguration(index,patch);
  const keys=new Set([...Object.keys(snapshot.root),...Object.keys(patch.root??{})]);keys.delete('views');
  return{views:structuredClone(document.views) as BaseViewConfig[],root:Object.fromEntries([...keys].map(key=>[key,document.getRoot(key)]))};
}

const propertyId = (value: BaseValue | undefined) => typeof value === 'string' ? normalizeBaseProperty(value) : '';
const button = (doc: Document, text: string, action: () => void, label = text) => {
  const node = doc.createElement('button'); node.type = 'button'; node.textContent = text; node.setAttribute('aria-label', label); node.addEventListener('click', action); return node;
};
const select = (doc: Document, label: string, values: readonly (readonly [string, string])[], value: string) => {
  const node = doc.createElement('select'); node.setAttribute('aria-label', label);
  for (const [key, text] of values) { const option = doc.createElement('option'); option.value = key; option.textContent = text; node.append(option); }
  node.value = value; return node;
};

/** Staged configuration UI: the session owns persistence, draft lifetime and query refresh. */
export function createBaseToolbar(container: HTMLElement, options: BaseToolbarOptions): BaseToolbar {
  const doc = container.ownerDocument, win = doc.defaultView;
  const selector = doc.createElement('select'); selector.setAttribute('aria-label', 'Base view');
  // Keep the native selection model behind the custom keyboard/menu presentation.
  selector.hidden = true; selector.tabIndex = -1; selector.setAttribute('aria-hidden', 'true');
  const viewWrap = doc.createElement('div'); viewWrap.className = 'bases-toolbar-view';
  const viewButton = button(doc, '', () => open('Views', viewButton), 'Views'); viewButton.className = 'bases-toolbar-action'; viewButton.setAttribute('aria-haspopup', 'dialog');
  viewButton.addEventListener('contextmenu', event => { event.preventDefault(); open('View options', viewButton); });
  const tabs = doc.createElement('div'); tabs.className = 'bases-toolbar-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Database views');
  const addView = button(doc, '', () => open('Add view', addView), 'Add a view'); addView.className = 'bases-toolbar-action bases-toolbar-add-view'; addView.dataset.baseTooltip = 'Add a view'; addView.setAttribute('aria-haspopup', 'dialog'); addView.append(icon('plus',16,doc));
  viewButton.dataset.baseTooltip = 'All views';
  viewWrap.append(tabs, addView, viewButton, selector);
  const actions = doc.createElement('div'); actions.className = 'bases-toolbar-actions';
  container.append(viewWrap, actions);
  const searchRow = doc.createElement('div'); searchRow.className = 'bases-search-row'; searchRow.hidden = true;
  const searchInput = doc.createElement('input'); searchInput.type = 'search'; searchInput.placeholder = 'Find…'; searchInput.setAttribute('aria-label', 'Search base');
  const searchCount = doc.createElement('span'); searchCount.className = 'document-search-count'; searchCount.setAttribute('aria-live', 'polite');
  const closeSearch = () => { searchRow.hidden = true; searchInput.value = ''; options.onSearch?.(''); actions.querySelector<HTMLButtonElement>('[aria-label="Search"]')?.classList.remove('is-active'); };
  const closeSearchButton = button(doc, '×', closeSearch, 'Close search'); searchRow.append(searchInput, searchCount, closeSearchButton); container.append(searchRow);
  searchInput.addEventListener('input', () => { try { options.onSearch?.(searchInput.value); } catch (error) { report(error); } });
  searchInput.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closeSearch(); actions.querySelector<HTMLButtonElement>('[aria-label="Search"]')?.focus(); } });
  let state: BaseToolbarState | undefined, destroyed = false;
  let panel: Panel | undefined;
  let deferredState: BaseToolbarState | undefined;
  let activeViewDrag: { source: HTMLElement; from: number; version: BaseQueryResult['version']; token: string } | undefined;
  const report = (error: unknown) => { try { options.onError(error); } catch { /* Error rendering cannot mutate configuration. */ } };
  const hasDraft = () => !!panel && (panel.dirty || panel.innerDraft || panel.saving || !!panel.failure || !!panel.hasUnfinishedInput?.());
  function refreshFilterSummary(next:BaseToolbarState):void {
    const trigger=actions.querySelector<HTMLButtonElement>('[aria-label="Filter"]');if(!trigger)return;
    // Match the filter sections' top-level rule/group count. A persisted empty
    // group is still configured (an empty OR can hide every row).
    const count=(source:BaseValue|undefined)=>!source?0:typeof source==='string'?1
      :mapping(source)&&Array.isArray(Object.values(source)[0])?Math.max(1,baseFilterCount(source as FilterNode)):1;
    const view=next.views[next.selectedIndex]??next.result.view;
    const all=view.source===undefined?count(next.rootFilters):0,local=count(next.result.view.filters),total=all+local;
    const description=all&&local?`${total} filters: ${all} for all views, ${local} for this view.`
      :total?`${total} ${total===1?'filter':'filters'} for ${all?'all views':'this view'}.`:'No filters.';
    trigger.classList.toggle('is-active',total>0);
    trigger.setAttribute('aria-description',description);trigger.dataset.baseTooltip=`Filter: ${description}`;
    let badge=trigger.querySelector<HTMLElement>('.bases-toolbar-filter-count');
    if(total){
      if(!badge){badge=doc.createElement('span');badge.className='bases-toolbar-filter-count';badge.setAttribute('aria-hidden','true');trigger.append(badge);}
      badge.textContent=String(total);
    }else badge?.remove();
  }
  function selectView(index: number) {
    if (!state || destroyed || index < 0 || index >= state.views.length) return;
    const previous = state.selectedIndex;
    try {
      options.preflight(); if (hasDraft()) throw new Error('Apply or cancel the toolbar changes before switching views.');
      panel?.close(false);
      void options.selectView(index).catch(error => { if (!destroyed) { selector.value = String(previous); report(error); } });
    } catch (error) { selector.value = String(previous); report(error); }
  }
  selector.addEventListener('change', () => selectView(Number(selector.value)));
  // Reuse the actual tab nodes while a clean popover survives a query refresh.
  // Its trigger remains connected and can still receive focus when dismissed.
  function updateTabs(next: BaseToolbarState) {
    const children = Array.from(tabs.children) as HTMLButtonElement[];
    next.views.forEach((view,index) => {
      let tab = children[index];
      if (!tab) {
        tab = button(doc, '', () => { if (!tab.isConnected||!state) return; if(state.selectedIndex===index)open(state.readOnly?'Views':'View settings',tab,index);else selectView(index); });
        tab.className = 'bases-toolbar-tab'; tab.setAttribute('role','tab');
        tab.addEventListener('contextmenu',event => { event.preventDefault(); if (tab.isConnected) open('View options',tab,index); });
        tabs.append(tab);
      }
      tab.setAttribute('aria-label',`${view.name} view`); tab.dataset.baseTooltip = view.name;
      if(index===next.selectedIndex)tab.setAttribute('aria-haspopup','dialog');else tab.removeAttribute('aria-haspopup');
      tab.setAttribute('aria-selected',String(index === next.selectedIndex)); tab.tabIndex = index === next.selectedIndex ? 0 : -1;
      tab.replaceChildren(icon(layoutIcon(view.type),16,doc),doc.createTextNode(view.name));
    });
    for (const extra of children.slice(next.views.length)) extra.remove();
    addView.hidden = next.readOnly || !options.commands?.addView;
    viewButton.replaceChildren(icon('down',14,doc));
  }
  tabs.addEventListener('keydown',event => {
    if (event.isComposing || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const children = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role=tab]'));
    const index = children.indexOf(doc.activeElement as HTMLButtonElement); if (index < 0) return;
    event.preventDefault();
    const rtl = win?.getComputedStyle(tabs).direction === 'rtl';
    const step = (event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? children.length - 1 : (index + step + children.length) % children.length;
    children[next]?.focus();
  });
  function open(name: PanelName, trigger: HTMLElement, targetIndex?: number, formulaName?: string, returnTo?: PanelName, restoring?:BaseToolbarAdmissionDraft) {
    if (!state || destroyed || state.readOnly && !['Views', 'Results'].includes(name)) return;
    if (state.browseOnly && ['Properties','Property','Formula','Group'].includes(name)) return;
    if(!restoring)try { options.preflight(); if (hasDraft()) throw new Error('Apply or cancel the current toolbar changes first.'); } catch (error) { report(error); return; }
    if (panel?.name === name) { panel.close(); return; }
    panel?.close(false);
    let opening = state, result = opening.result;
    let version = result.version;
    let configuration = configurationSnapshot(opening);
    let expectedPatch: {view?:BaseViewPatch;root?:Record<string,BaseValue|undefined>} | undefined;
    let expectedSnapshot: ReturnType<typeof configurationSnapshot> | undefined;
    const selectedIndex = targetIndex ?? opening.selectedIndex;
    let configuredView = opening.views[selectedIndex] ?? result.view;
    const node = doc.createElement('section'); node.className = 'bases-toolbar-popover'; node.dataset.panel = name; node.classList.toggle('is-immediate',!!options.immediate); node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', name); if(name==='View settings'||returnTo)node.dataset.settingsFlow='true';
    const heading = doc.createElement('h3'); heading.textContent = name === 'View options' ? 'View settings' : name === 'Add view' ? 'Add a view' : name === 'Sort' ? 'Sort by' : name === 'Group' ? 'Group by' : name; if (['Views','Results','Properties','Filter'].includes(name)) heading.hidden = true;
    if(returnTo){heading.hidden=false;heading.textContent=name==='View options'?'Layout':name==='Properties'?'Property visibility':name;}
    if (returnTo || name === 'View options' || name === 'Add view' || name === 'Formula' || name === 'Property' || name === 'New item settings') {
      const back = button(doc, '', () => { if(returnTo){navigatePanel(returnTo,returnTo==='View options'?'View settings':undefined);return;} if (name === 'Add view' && !own.saving) { own.close(false); open('Views',trigger); return; } if (hasDraft()) { if (options.immediate) panel?.flush?.(); else report(new Error('Apply or cancel the current changes first.')); return; } panel?.close(false); open(name === 'Formula' || name === 'Property' ? 'Properties' : 'Views',trigger); }, 'Back'); back.className = 'bases-toolbar-menu-next'; back.append(icon('chevron-left',16,doc)); back.dataset.panelAction='back'; heading.prepend(back);
    }
    const form = doc.createElement('form'), fields = doc.createElement('div'), footer = doc.createElement('div'), error = doc.createElement('div');
    fields.className = 'bases-toolbar-fields'; footer.className = 'bases-toolbar-footer'; error.className = 'bases-toolbar-error'; error.setAttribute('role', 'alert');
    const apply = doc.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply'; apply.className = 'mod-cta';
    const cancel = button(doc, 'Cancel', () => { if (!own.saving) own.close(); }); footer.append(cancel, apply); form.append(fields, error, footer); node.append(heading, form); doc.body.append(node);
    let autoTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0,rawFrozen=false,rawPassive=!!restoring,submitted=false;
    const comboOwners=new Map<HTMLSelectElement,BaseCombobox>(),formulaOwners=new Map<HTMLTextAreaElement,BaseFormulaEditor>(),deferredNativeExpressions=new WeakSet<HTMLTextAreaElement>();
    let rawModel:{hasRawInput?():boolean;dirtyOnRestore?:boolean;finishRestore?():boolean;canCapture?():boolean;ready?(raw:BaseToolbarRawPanelState):readonly Promise<void>[];capture():BaseToolbarRawPanelState;restore(raw:BaseToolbarRawPanelState):boolean;controls():readonly (readonly [string,HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement])[]}|undefined;
    type NativeText=HTMLInputElement|HTMLTextAreaElement;
    type Composition={active:boolean;settling:boolean;start:string;update?:string;input?:{value:string;data:string|null;update?:string}};
    const compositions=new Map<NativeText,Composition>(),activeCompositionTargets=new Set<EventTarget>();let completeRawCapture:(()=>void)|undefined;
    const textTarget=(event:Event):NativeText|undefined=>event.target instanceof doc.defaultView!.HTMLInputElement||event.target instanceof doc.defaultView!.HTMLTextAreaElement?event.target:undefined;
    const unfinishedInput=()=>[...activeCompositionTargets].some(target=>target instanceof doc.defaultView!.Node&&node.contains(target))||[...compositions.entries()].some(([input,cycle])=>node.contains(input)&&(cycle.active||cycle.settling));
    const unsubmittedInput=()=>unfinishedInput()||!!rawModel?.hasRawInput?.()||[...comboOwners.values()].some(control=>control.hasRawInput());
    const activateRaw=(event:Event)=>{if(rawFrozen){
      if(event.target instanceof doc.defaultView!.Element&&event.target.closest('[data-base-review]'))return;
      if(event.type==='keydown'&&event.target&&activeCompositionTargets.has(event.target)){event.stopImmediatePropagation();return;}
      if(event.type==='input'||event.type==='change')return;
      if(event.cancelable)event.preventDefault();event.stopImmediatePropagation();return;
    }rawPassive=false;};
    for(const event of ['input','change','keydown','click','pointerdown','dragstart','dragover','drop','dragend'])node.addEventListener(event,activateRaw,true);
    node.addEventListener('compositionstart',event=>{if(rawFrozen)return;activeCompositionTargets.add(event.target!);const input=textTarget(event);if(input)compositions.set(input,{active:true,settling:false,start:input.value});options.onDraftChange();},true);
    node.addEventListener('compositionupdate',event=>{const input=textTarget(event),cycle=input&&compositions.get(input);if(cycle?.active)cycle.update=event.data;},true);
    node.addEventListener('input',event=>{const input=textTarget(event),cycle=input&&compositions.get(input);if(cycle&&input){if(cycle.active)cycle.input={value:input.value,data:(event as InputEvent).data??null,update:cycle.update};else cycle.settling=false;}queueMicrotask(()=>completeRawCapture?.());},true);
    node.addEventListener('compositionend',event=>{activeCompositionTargets.delete(event.target!);const input=textTarget(event),cycle=input&&compositions.get(input);if(cycle&&input){cycle.active=false;cycle.settling=!(event.data===''&&input.value===cycle.start||cycle.input?.value===input.value&&(cycle.input.data===event.data||cycle.input.update===event.data));}queueMicrotask(()=>completeRawCapture?.());options.onDraftChange();},true);
    let afterSave: (() => void) | undefined;
    let afterClean: (() => void) | undefined;
    let refreshPanel: ((result:BaseQueryResult,retainDraft:boolean)=>void) | undefined;
    let enhanceControls: (()=>void) | undefined;let restoringRawModel=!!restoring;
    const focusVisible = (root:HTMLElement,label:string,fallback?:HTMLElement) => {
      // Rebuilt native selects are about to become hidden models. Enhance them
      // before restoring focus so the visible combobox owns subsequent keys.
      enhanceControls?.();
      const controls=Array.from(root.querySelectorAll<HTMLElement>('input,select,textarea,button,[contenteditable=true]')).filter(control=>!control.hidden&&!control.closest('[hidden],[aria-hidden=true]')&&!(control as HTMLButtonElement).disabled);
      (controls.find(control=>control.getAttribute('aria-label')===label)??controls[0]??fallback)?.focus();
    };
    const disposers: (()=>void)[] = [];
    const auto = options.immediate === true && !['Views','Add view','New item settings'].includes(name) && (name !== 'Formula' || !!formulaName);
    if (auto) footer.hidden = true;
    const own: Panel = { name, node, trigger, dirty: false, saving: false, failure: undefined,hasUnfinishedInput:unfinishedInput,
      close(restore = true) {
        if (own.saving||rawFrozen&&!destroyed) return;
        if (autoTimer) clearTimeout(autoTimer);
        activeViewDrag = undefined;
        for (const dispose of disposers.splice(0)) dispose();
        const focusOwned = node.contains(doc.activeElement); node.remove();
        doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', keydown, true); win?.removeEventListener('resize', place); win?.removeEventListener('scroll', place, true); observer?.disconnect();
        if (panel === own) panel = undefined; trigger.setAttribute('aria-expanded', 'false');
        if (restore && focusOwned && trigger.isConnected) trigger.focus({ preventScroll: true }); options.onDraftChange();
      },
    };
    own.rebase = (next, expectedName = configuredView.name) => {
      const snapshot=configurationSnapshot(next);
      // Results edits only the limit. A just-accepted summary selection or
      // definition must not dismiss a newly opened menu or stale its limit draft.
      // Other configuration/view changes still invalidate its exact baseline.
      if(name!=='Views'&&next.selectedIndex!==opening.selectedIndex)return false;
      if(name==='Results'&&next.readOnly!==opening.readOnly)return false;
      const exact=JSON.stringify(snapshot)===JSON.stringify(configuration);
      const summaryOnly=name==='Results'&&!own.failure&&JSON.stringify(resultsConfigurationWitness(snapshot))===JSON.stringify(resultsConfigurationWitness(configuration));
      if((!exact&&!summaryOnly)||next.views[selectedIndex]?.name!==expectedName)return false;
      own.refreshFilterAdvice?.(next);
      configuration=snapshot;opening=next;result=next.result;version=result.version;configuredView=next.views[selectedIndex]??result.view;refreshPanel?.(result,own.dirty);return true;
    };
    panel = own; trigger.setAttribute('aria-expanded', 'true');
    let retryPersistence: (() => Promise<void>) | undefined,reviewFailure:BaseToolbarSaveError|undefined;
    const reviewRetained=()=>reviewRetainedBaseConfiguration(form,reviewFailure?.review,[...fields.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select')].map(input=>`${input.getAttribute('aria-label')??input.name}: ${input.value}`).join('\n'));
    type Control = HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
    type AcceptedAttempt = {generation:number;configuration?:ReturnType<typeof configurationSnapshot>;viewName:string;inputs:Map<Control,boolean>;acknowledge?:()=>void};
    let retainedAttempt: AcceptedAttempt | undefined,activeAttempt:AcceptedAttempt|undefined;
    const inputStates = () => new Map(Array.from(node.querySelectorAll<Control>('input,button,select,textarea'),input=>[input,input.disabled] as const));
    const place = () => { if (!node.isConnected) return; const anchor = trigger.getBoundingClientRect(), bounds = node.getBoundingClientRect(); node.style.left = `${Math.max(8, Math.min(anchor.left, (win?.innerWidth ?? 800) - bounds.width - 8))}px`; node.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, (win?.innerHeight ?? 600) - bounds.height - 8))}px`; };
    const outside = (event: Event) => { if(rawFrozen)return;if (!node.contains(event.target as Node) && !trigger.contains(event.target as Node)) {
      if (name === 'Add view' && !own.saving && !retryPersistence) { own.close(false); return; }
      if (auto && own.dirty && !retryPersistence) { submit(true); return; }
      if (!hasDraft()) own.close(false);
    } };
    const keydown = (event: KeyboardEvent) => { const target = event.target as Element;
      if(event.isComposing||!node.contains(target))return;
      if(target.closest?.('[data-settings-menu]')&&['Enter',' '].includes(event.key)&&target.getAttribute('role')==='menuitem'){event.preventDefault();(target as HTMLButtonElement).click();return;} if (event.defaultPrevented || target.closest?.('.bases-filter-operand')?.querySelector('[role=combobox][aria-expanded=true]') || target.closest?.('.bases-toolbar-combobox-popover,.bases-manual-group-new,.bases-formula-editor') || target.closest?.('[role=combobox]') && (event.key !== 'Escape' || target.closest('[role=combobox]')?.getAttribute('aria-expanded') === 'true')) return; if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !event.isComposing && (event.target instanceof doc.defaultView!.HTMLButtonElement || event.target === node)) { const menu=target.closest?.('[data-settings-menu]'); const buttons = Array.from((menu??node).querySelectorAll<HTMLButtonElement>(menu?'[role=menuitem]:not(:disabled)':'button:not(:disabled)')).filter(item => !item.closest('[hidden]')); if (buttons.length) { const index = menu ? Math.max(0,buttons.findIndex(item=>item.classList.contains('is-active'))) : buttons.indexOf(doc.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length; buttons[next].focus(); event.preventDefault(); event.stopPropagation(); } } if (event.key === 'Escape' && !event.isComposing && !own.saving && node.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); if (auto && own.dirty && !retryPersistence) submit(true); else own.close(); } };
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', keydown, true); win?.addEventListener('resize', place); win?.addEventListener('scroll', place, true);
    const observer = win && 'ResizeObserver' in win ? new win.ResizeObserver(place) : undefined; observer?.observe(container); observer?.observe(node);
    const changed = () => {
      if (destroyed || panel !== own || rawFrozen) return;
      generation++; own.dirty = true;
      // A failed accepted write must be retried before another semantic action.
      if (retryPersistence) return;
      own.failure = undefined; error.textContent = ''; apply.textContent = name === 'Add view' ? 'Create view' : 'Apply'; options.onDraftChange(); place();
      if (auto && !(((name === 'View options'||name==='View settings') && doc.activeElement?.getAttribute('aria-label') === 'View name') || (name === 'Formula' && doc.activeElement?.getAttribute('aria-label') === 'Formula name'))) { if (autoTimer) clearTimeout(autoTimer); autoTimer = setTimeout(() => { autoTimer = undefined; submit(false); }, 250); }
    };
    const properties = [...new Set([...(Array.isArray(result.view.order) ? result.view.order.filter((value): value is string => typeof value === 'string').map(normalizeBaseProperty) : []), ...result.properties, ...result.availableProperties])];
    const propertyOptions = properties.map(property => [property, opening.label(property)] as const);
    const availableOptions = result.availableProperties.map(property => [property, opening.label(property)] as const);
    let readPatch: () => BaseViewPatch = () => ({});
    let readOperation: (() => () => Promise<void>) | undefined;
    const menuAction = (text: string, action: () => Promise<void>, enabled = true) => {
      const item = button(doc, text, () => {
        if (destroyed || panel !== own || !item.isConnected || rawFrozen || rawPassive) return;
        if (own.saving || own.dirty) { error.textContent = 'Finish the current changes first.'; return; }
        try { options.preflight(); } catch (failure) { report(failure); return; }
        const commandGeneration = generation, commandInputs = inputStates();
        own.saving = true; options.onDraftChange(); for (const input of commandInputs.keys()) input.disabled = true; item.disabled = true;
        submitted=true;void invoke(action).then(() => {
          if (destroyed || panel !== own) return;
          own.saving = false;submitted=false;
          const refreshed = deferredState; deferredState = undefined;
          if (generation !== commandGeneration) {
            for (const [input,disabled] of commandInputs) input.disabled = disabled;
            own.dirty = true; own.failure = {}; footer.hidden = false; error.textContent = 'The command was saved. Your newer configuration draft is still here. Cancel and reopen the updated view before continuing.'; options.onDraftChange(); return;
          }
          own.close(); if (refreshed) update(refreshed);
        }, failure => {
          if (destroyed || panel !== own) return;
          own.saving = false; item.disabled = false; if(autoTimer){clearTimeout(autoTimer);autoTimer=undefined;}
          error.textContent = failure instanceof Error ? failure.message : String(failure);
          if (failure instanceof BaseToolbarSaveError) {
            own.failure = {}; own.acceptsSaveAcknowledgement = () => generation === commandGeneration; own.dirty = true; retryPersistence = failure.retry;reviewFailure=failure;
            retainedAttempt = {generation:commandGeneration,viewName:configuredView.name,inputs:commandInputs};
            footer.hidden = false; apply.disabled = cancel.disabled = false; apply.textContent = 'Review retained changes';apply.dataset.baseReview='true';node.inert=false;
          } else for(const [input,disabled] of commandInputs) input.disabled=disabled;
          report(failure); options.onDraftChange();
        });
      }); item.className = 'bases-toolbar-menu-item'; item.disabled = !enabled; fields.append(item); return item;
    };
    function transition(action:()=>void) {
      if(destroyed||panel!==own||rawFrozen||rawPassive)return;
      if(hasDraft()){
        if(auto&&!own.innerDraft&&!retryPersistence){afterClean=action;submit(false);}
        else error.textContent='Apply or cancel the current changes first.';
        return;
      }
      action();
    }
    function navigatePanel(next:PanelName,parent:PanelName|undefined='View settings',afterOpen?:()=>void) {
      transition(()=>{own.close(false);open(next,trigger,selectedIndex,undefined,parent);afterOpen?.();});
    }
    if(name==='View settings'||returnTo){
      const close=button(doc,'',()=>{if(auto&&own.dirty&&!retryPersistence)submit(true);else own.close();},'Close settings');
      close.className='bases-toolbar-menu-next';close.dataset.panelAction='close';close.append(icon('close',16,doc));heading.append(close);
    }
    if(name==='View settings'){
      const nameRow=doc.createElement('div');nameRow.className='bases-settings-name';nameRow.append(icon(layoutIcon(configuredView.type),18,doc));
      const input=doc.createElement('input');input.setAttribute('aria-label','View name');input.placeholder='View name';input.value=configuredView.name;input.disabled=!opening.allowRename;
      nameRow.append(input);fields.append(nameRow);input.addEventListener('input',changed);
      input.addEventListener('blur',()=>{if(auto&&own.dirty)submit(false);});input.addEventListener('keydown',event=>{if(!event.isComposing&&event.key==='Enter'){event.preventDefault();input.blur();}});
      readPatch=()=>{const name=validateViewName(opening.views,input.value,selectedIndex);return name===configuredView.name?{}:{name};};
      rawModel={capture:()=>({kind:'view-settings',name:input.value}),restore:raw=>{if(raw.kind!=='view-settings')return false;input.value=raw.name;return true;},controls:()=>[['name',input]]};
      if(options.commands?.updateView)readOperation=()=>{const patch=readPatch();expectedPatch={view:patch};return()=>options.commands!.updateView!(version,selectedIndex,patch);};
      const menu=doc.createElement('div');menu.dataset.settingsMenu='true';menu.setAttribute('role','menu');menu.setAttribute('aria-label','View settings commands');fields.append(menu);
      const row=(label:string,glyph:string,value:string,action:()=>void)=>{
        const item=button(doc,'',action,label);item.className='bases-settings-row';item.dataset.setting=label.toLowerCase().replace(/ /g,'-');item.setAttribute('role','menuitem');item.tabIndex=menu.querySelector('[role=menuitem]')?-1:0;
        const text=doc.createElement('span');text.className='bases-settings-row-label';text.textContent=label;
        const detail=doc.createElement('span');detail.className='bases-settings-row-value';detail.textContent=value;item.append(icon(glyph,16,doc),text,detail,icon('chevron-right',14,doc));
        const active=()=>{for(const sibling of menu.querySelectorAll<HTMLElement>('[role=menuitem]')){sibling.classList.toggle('is-active',sibling===item);sibling.tabIndex=sibling===item?0:-1;}};
        item.addEventListener('mouseenter',active);item.addEventListener('focus',active);menu.append(item);return item;
      };
      row('Layout',layoutIcon(configuredView.type),BASE_LAYOUTS.find(([key])=>key===configuredView.type)?.[1]??configuredView.type,()=>navigatePanel('View options'));
      if(!opening.browseOnly)row('Property visibility','eye',String(result.properties.length),()=>navigatePanel('Properties'));
      row('Filter','list-filter','',()=>navigatePanel('Filter'));row('Sort','arrow-up-down','',()=>navigatePanel('Sort'));
      if(!opening.browseOnly)row('Group','group','',()=>navigatePanel('Group'));
      const divider=doc.createElement('div');divider.className='bases-settings-section-label';divider.textContent='Data source settings';menu.append(divider);
      const source=doc.createElement('div');source.className='bases-settings-row is-readonly';source.dataset.setting='source';
      const sourceTitle=doc.createElement('span');sourceTitle.className='bases-settings-row-label';sourceTitle.textContent='Source';const sourceValue=doc.createElement('span');sourceValue.className='bases-settings-row-value';sourceValue.textContent=opening.sourceLabel??(opening.browseOnly?'Notes in your vault':'Collection');source.append(icon('link',16,doc),sourceTitle,sourceValue);menu.append(source);
      if(!opening.browseOnly&&options.onEditProperties)row('Edit properties','list','',()=>transition(()=>{own.close(false);options.onEditProperties!();}));
      row('More view actions','more','',()=>navigatePanel('View options','View settings',()=>panel?.node.querySelector<HTMLButtonElement>('[aria-label="View actions"]')?.click()));
      refreshPanel=()=>{sourceValue.textContent=opening.sourceLabel??(opening.browseOnly?'Notes in your vault':'Collection');};
    } else if (name === 'Views') {
      footer.hidden = true;
      const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Search…'; search.setAttribute('aria-label', 'Find a view'); fields.append(search);
      const list = doc.createElement('div'); list.className = 'bases-views-list'; fields.append(list);
      const renderViews = () => {
        list.replaceChildren();
        opening.views.forEach((view, index) => {
          if (!view.name.toLowerCase().includes(search.value.toLowerCase())) return;
          const row = doc.createElement('div'); row.className = 'bases-toolbar-menu-view-row'; row.dataset.viewIndex = String(index);
          const choose = button(doc, '', () => { if (destroyed || panel !== own || !row.isConnected) return; own.close(false); try { options.preflight(); void options.selectView(index).catch(report); } catch (failure) { report(failure); } }, `Open view ${view.name}`);
          choose.className = 'bases-toolbar-menu-item'; choose.append(icon(layoutIcon(view.type), 16, doc), doc.createTextNode(view.name)); choose.classList.toggle('mod-active', index === opening.selectedIndex); row.append(choose);
          if (!opening.readOnly) {
            const configure = button(doc, '', () => { own.close(false); open('View options', trigger, index); }, `Configure view ${view.name}`); configure.className = 'bases-toolbar-menu-next'; configure.append(icon('chevron-right', 14, doc)); row.append(configure);
            row.draggable = !!options.commands?.moveView;
            row.addEventListener('dragstart', event => {
              if (destroyed || !row.isConnected || panel !== own || !event.dataTransfer) { event.preventDefault(); return; }
              const token = `${Date.now()}-${Math.random()}`;
              activeViewDrag = {source:row,from:index,version,token};
              event.dataTransfer.setData('application/x-zorid-base-view',token); event.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', () => { activeViewDrag = undefined; });
            row.addEventListener('dragover', event => { if (activeViewDrag?.source.isConnected && activeViewDrag.version === version && panel === own && event.dataTransfer?.types.includes('application/x-zorid-base-view')) event.preventDefault(); });
            row.addEventListener('drop', event => {
              const drag = activeViewDrag, token = event.dataTransfer?.getData('application/x-zorid-base-view'); activeViewDrag = undefined;
              if (destroyed || !row.isConnected || panel !== own || !drag || !drag.source.isConnected || drag.token !== token || drag.version !== version || drag.from === index) return;
              event.preventDefault(); own.close(false);
              try { options.preflight(); void options.commands?.moveView?.(version,drag.from,index).catch(report); } catch (failure) { report(failure); }
            });
            choose.addEventListener('keydown', event => { if (event.key === 'ArrowRight') { event.preventDefault(); configure.click(); } });
          }
          list.append(row);
        });
      };
      search.addEventListener('input', renderViews); renderViews();
      rawModel={hasRawInput:()=>!!search.value,dirtyOnRestore:false,capture:()=>({kind:'views',search:search.value}),restore:raw=>{if(raw.kind!=='views')return false;search.value=raw.search;renderViews();return true;},controls:()=>[['search',search]]};
      menuAction('Results',async()=>{own.saving=false;own.close(false);open('Results',trigger);});
      if (!opening.readOnly && options.commands?.addView) menuAction('Add view', async () => { own.saving = false; own.close(false); open('Add view', trigger); });
    } else if (name === 'Add view') {
      const input = doc.createElement('input'); input.value = uniqueViewName(opening.views); input.setAttribute('aria-label', 'View name'); input.placeholder = 'View name';
      const layout = select(doc, 'Layout', BASE_LAYOUTS.map(([key, label]) => [key, label] as const), 'table');
      const layoutLabel = doc.createElement('label'); layoutLabel.textContent = 'Layout'; layoutLabel.append(layout); fields.append(input, layoutLabel);
      const layoutFields = doc.createElement('div'); layoutFields.className = 'bases-layout-settings'; fields.append(layoutFields);
      let initial: BaseViewPatch = {};const layoutControls=new Map<string,HTMLInputElement|HTMLSelectElement>();const control=(key:string,input:HTMLInputElement|HTMLSelectElement)=>layoutControls.set(`layout/${key}`,input);
      let layoutPatch = createLayoutSettings(doc,layoutFields,{type:'table',name:input.value},propertyOptions,changed,control);
      input.addEventListener('input', changed);
      layout.addEventListener('change', () => {
        initial = {...initial,...layoutPatch()};
        layoutControls.clear();layoutFields.replaceChildren();
        layoutPatch = createLayoutSettings(doc,layoutFields,{...initial,type:layout.value,name:input.value},propertyOptions,changed,control);
        changed();
      });
      apply.textContent = 'Create view'; own.dirty = true;
      readOperation = () => {
        const name = validateViewName(opening.views,input.value), type = layout.value;
        const patch = validateToolbarPatch(result,{...initial,...layoutPatch()});
        if (!options.commands?.addView) throw new Error('View creation is unavailable.');
        return () => options.commands!.addView!(version,type,name,patch);
      };
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();submit(true);}});
      rawModel={capture:()=>({kind:'add-view',name:input.value,layout:layout.value,patch:structuredClone({...initial,...layoutPatch()})}),restore:raw=>{if(raw.kind!=='add-view')return false;input.value=raw.name;layout.value=raw.layout;initial=structuredClone(raw.patch);layoutControls.clear();layoutFields.replaceChildren();layoutPatch=createLayoutSettings(doc,layoutFields,{...initial,type:raw.layout,name:raw.name},propertyOptions,changed,control);return true;},controls:()=>[['name',input],['layout',layout],...[...layoutControls]]};
    } else if (name === 'Results') {
      const limit = doc.createElement('input'); limit.type = 'text'; limit.inputMode = 'numeric'; limit.setAttribute('aria-description','Nonnegative whole number of results; leave blank for all results.'); limit.placeholder = 'e.g. 10'; limit.value = typeof result.view.limit === 'number' && result.view.limit > 0 ? String(result.view.limit) : ''; limit.setAttribute('aria-label', 'Limit'); const label = doc.createElement('label'); label.append(doc.createTextNode('Limit number of results'), limit); fields.append(label); limit.addEventListener('input', changed);
      if (!opening.readOnly) { const showAll = menuAction('Show all results', () => options.save(version, {limit: undefined}),typeof result.view.limit === 'number' && result.view.limit > 0); showAll.replaceChildren(icon('rotate-ccw',16,doc),doc.createTextNode('Show all')); }
      limit.disabled = opening.readOnly;
      if (options.onExport) { menuAction('Copy', () => options.onExport!('tsv', true)).replaceChildren(icon('copy',16,doc),doc.createTextNode('Copy to clipboard')); menuAction('Export CSV', () => options.onExport!('csv', false)).replaceChildren(icon('file-down',16,doc),doc.createTextNode('Export CSV…')); }
      readPatch = () => { if (limit.value && (!limit.value.trim() || !Number.isSafeInteger(Number(limit.value)) || Number(limit.value) < 0)) throw new Error('Limit must be a nonnegative whole number.'); return {limit: limit.value && Number(limit.value) > 0 ? Number(limit.value) : undefined}; };
      rawModel={capture:()=>({kind:'results',limit:limit.value}),restore:raw=>{if(raw.kind!=='results')return false;limit.value=raw.limit;return true;},controls:()=>[['limit',limit]]};
    } else if (name === 'Property') {
      const property = formulaName!;
      const display = doc.createElement('input'); display.value = opening.label(property); display.setAttribute('aria-label','Display name'); display.placeholder = property.slice(property.indexOf('.') + 1);
      const label = doc.createElement('label'); label.append(doc.createTextNode('Display name'),display); fields.append(label); display.addEventListener('input',changed);
      rawModel={capture:()=>({kind:'property',display:display.value}),restore:raw=>{if(raw.kind!=='property')return false;display.value=raw.display;return true;},controls:()=>[['display',display]]};
      readOperation = () => { const root = propertyDisplayPatch(opening.settings??opening.root,new Map([[property,display.value]])); if (!options.commands?.updateRoot) throw new Error('Property labels are unavailable.'); expectedPatch = {root}; return () => options.commands!.updateRoot!(version,root); };
      if (property.startsWith('formula.')) menuAction('Edit formula',async () => { own.saving = false; own.close(false); open('Formula',trigger,undefined,property.slice(8)); });
      else if (property.startsWith('note.') && options.onPropertySettings) menuAction('Property type',async () => { own.saving = false; own.close(false); options.onPropertySettings!(property); });
    } else if (name === 'Formula') {
      const names = mapping((opening.settings??opening.root)?.formulas) ? (opening.settings??opening.root)!.formulas as Record<string, BaseValue> : {};
      const input = doc.createElement('input'); input.placeholder = 'Formula name'; input.setAttribute('aria-label', 'Formula name'); input.value = formulaName ?? '';
      const expression = doc.createElement('textarea'); expression.setAttribute('aria-label', 'Formula expression'); expression.placeholder = 'Enter a formula…'; const initialExpression = formulaName ? names[formulaName] : undefined; expression.value = typeof initialExpression === 'string' ? initialExpression : ''; expression.rows = 5;
      fields.append(input, expression); input.addEventListener('input', changed); expression.addEventListener('input', changed);
      input.addEventListener('blur',()=>{if(auto&&own.dirty)submit(false);});
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();input.blur();}});
      // Use the same document transformation to project the exact acknowledgement witness.
      readOperation = () => {
        const name = input.value.trim(), source = expression.value;
        const currentNames = mapping((opening.settings??opening.root)?.formulas) ? (opening.settings??opening.root)!.formulas as Record<string,BaseValue> : {};
        if (!name) throw new Error('Formula name must not be empty.');
        if (name !== formulaName && Object.hasOwn(currentNames,name)) throw new Error('A formula with that name already exists.');
        if (!source.trim() && !auto) throw new Error('Formula expression must not be empty.');
        if (options.commands?.editFormula) {
          const projected = BaseDocument.parse(JSON.stringify({...opening.root,views:opening.views}));
          if (formulaName && formulaName !== name) projected.renameViewFormula(selectedIndex,formulaName,name);
          projected.setViewFormula(selectedIndex,name,source);
          const keys = new Set([...Object.keys(opening.root??{}),'formulas']); keys.delete('views');
          const root = Object.fromEntries([...keys].map(key=>[key,projected.getRoot(key)]));
          expectedSnapshot = {views:structuredClone(projected.views) as BaseViewConfig[],root};
          afterSave = () => { formulaName = name; };
          return () => options.commands!.editFormula!(version,formulaName,name,source);
        }
        if (formulaName && formulaName !== name) throw new Error('Formula rename is unavailable.');
        const formulas = {...currentNames,[name]:source};
        if (!options.commands?.updateRoot) throw new Error('Formula editing is unavailable.');
        expectedPatch = {root:{formulas}}; return () => options.commands!.updateRoot!(version,{formulas});
      };
      if (formulaName && options.commands?.setFormula) menuAction('Remove formula', () => options.commands!.setFormula!(version, formulaName!, undefined));
      let restoreExpression:BaseToolbarExpressionDraft|undefined;
      rawModel={canCapture:()=>!formulaOwners.has(expression)||formulaOwners.get(expression)?.canCaptureAdmissionDraft()===true,
        capture:()=>{const editor=formulaOwners.get(expression),draft=editor?.captureFreeze();if(editor&&!draft)throw new Error('The raw formula changed before it could be retained.');return{kind:'formula',name:input.value,expression:draft?{kind:'formula',draft}:{kind:'native',text:expression.value}};},
        ready:raw=>raw.kind==='formula'&&raw.expression.kind==='formula'?[raw.expression.draft.ready]:[],
        restore:raw=>{if(raw.kind!=='formula')return false;input.value=raw.name;restoreExpression=raw.expression;if(raw.expression.kind==='native'){expression.value=raw.expression.text;deferredNativeExpressions.add(expression);}else expression.value=raw.expression.draft.initial;return true;},
        finishRestore:()=>{const captured=restoreExpression;restoreExpression=undefined;return!captured||captured.kind==='native'||formulaOwners.get(expression)?.restoreAdmissionDraft(captured.draft)===true;},
        controls:()=>[['name',input],...(!formulaOwners.has(expression)?[['expression',expression] as const]:[])]};
    } else if (name === 'New item settings') {
      const folder = doc.createElement('input'), template = doc.createElement('input'); folder.setAttribute('aria-label', 'New item folder'); template.setAttribute('aria-label', 'New item template'); folder.value = typeof (opening.settings??opening.root)?.newItemFolder === 'string' ? (opening.settings??opening.root)!.newItemFolder as string : ''; template.value = typeof (opening.settings??opening.root)?.newItemTemplate === 'string' ? (opening.settings??opening.root)!.newItemTemplate as string : '';
      for (const [text, input] of [['Folder',folder], ['Template',template]] as const) { const label = doc.createElement('label'); label.append(doc.createTextNode(text), input); fields.append(label); input.addEventListener('input', changed); }
      const hint = doc.createElement('p'); hint.textContent = 'Zorid copies the complete template, including its body. Placeholders stay literal.'; fields.append(hint);
      readOperation = () => { if (!options.commands?.updateRoot) throw new Error('Creation settings are unavailable.'); return () => options.commands!.updateRoot!(version, {newItemFolder:folder.value.trim() || undefined,newItemTemplate:template.value.trim() || undefined}); };
      rawModel={capture:()=>({kind:'new-item-settings',folder:folder.value,template:template.value}),restore:raw=>{if(raw.kind!=='new-item-settings')return false;folder.value=raw.folder;template.value=raw.template;return true;},controls:()=>[['folder',folder],['template',template]]};
    } else if (name === 'View options') {
      const layout = select(doc, 'Layout', BASE_LAYOUTS.map(([key, label]) => [key, label] as const), configuredView.type);
      const layoutLabel = doc.createElement('label'); layoutLabel.textContent = 'Layout'; layoutLabel.append(layout); fields.append(layoutLabel); layout.addEventListener('change', changed);
      const nameInput = doc.createElement('input'); nameInput.setAttribute('aria-label', 'View name'); nameInput.value = configuredView.name;
      if (opening.allowRename&&returnTo!=='View settings') { const nameLabel = doc.createElement('label'); nameLabel.textContent = options.immediate ? '' : 'Name'; nameLabel.append(nameInput); fields.prepend(nameLabel); nameInput.addEventListener('input', changed); }
      nameInput.addEventListener('blur', () => { if (auto && own.dirty) submit(false); });
      nameInput.addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); nameInput.blur(); } });
      if(returnTo==='View settings'){
        layoutLabel.hidden=true;
        const grid=doc.createElement('div');grid.className='bases-layout-picker';grid.setAttribute('role','group');grid.setAttribute('aria-label','Layout');
        for(const [type,label,glyph] of BASE_LAYOUTS){const tile=button(doc,'',()=>{layout.value=type;layout.dispatchEvent(new win!.Event('change',{bubbles:true}));for(const item of grid.querySelectorAll('[data-layout]'))item.setAttribute('aria-pressed',String((item as HTMLElement).dataset.layout===type));},label);tile.dataset.layout=type;tile.setAttribute('aria-pressed',String(configuredView.type===type));tile.append(icon(glyph,22,doc),doc.createTextNode(label));grid.append(tile);}fields.append(grid);
      }
      const layoutFields = doc.createElement('div'); layoutFields.className = 'bases-layout-settings'; fields.append(layoutFields);
      const layoutControls=new Map<string,HTMLInputElement|HTMLSelectElement>(),control=(key:string,input:HTMLInputElement|HTMLSelectElement)=>layoutControls.set(`layout/${key}`,input);let retainedLayoutPatch:BaseViewPatch={};
      let layoutPatch = createLayoutSettings(doc, layoutFields, configuredView, propertyOptions, changed,control);
      if(returnTo==='View settings'){const limit=button(doc,`Load limit · ${typeof configuredView.limit==='number'?configuredView.limit:'All results'}`,()=>navigatePanel('Results','View options'),'Load limit');limit.className='bases-settings-row';fields.append(limit);}
      layout.addEventListener('change', () => { retainedLayoutPatch={};layoutControls.clear();layoutFields.replaceChildren(); layoutPatch = createLayoutSettings(doc, layoutFields, {...configuredView, type:layout.value}, propertyOptions, changed,control); });
      readPatch = () => {
        if (selectedIndex !== opening.selectedIndex && !options.commands?.updateView) throw new Error('Open this view before changing its settings.');
        const patch: BaseViewPatch = { type: layout.value,...retainedLayoutPatch, ...layoutPatch() };
        if (opening.allowRename && nameInput.value.trim() !== configuredView.name) {
          patch.name = validateViewName(opening.views, nameInput.value, selectedIndex);
        }
        return patch;
      };
      if (options.commands?.updateView) readOperation = () => { const patch = validateToolbarPatch({...result,view:configuredView},readPatch()); expectedPatch = {view:patch}; return () => options.commands!.updateView!(version,selectedIndex,patch); };
      rawModel={capture:()=>({kind:'view-options',name:nameInput.value,layout:layout.value,patch:structuredClone({...retainedLayoutPatch,...layoutPatch()})}),restore:raw=>{if(raw.kind!=='view-options')return false;nameInput.value=raw.name;layout.value=raw.layout;retainedLayoutPatch=structuredClone(raw.patch);layoutControls.clear();layoutFields.replaceChildren();layoutPatch=createLayoutSettings(doc,layoutFields,{...configuredView,...retainedLayoutPatch,type:raw.layout},propertyOptions,changed,control);for(const tile of fields.querySelectorAll<HTMLElement>('[data-layout]'))tile.setAttribute('aria-pressed',String(tile.dataset.layout===raw.layout));return true;},controls:()=>[['name',nameInput],['layout',layout],...[...layoutControls]]};
      if (selectedIndex !== opening.selectedIndex && !options.commands?.updateView) { nameInput.disabled = true; layout.disabled = true; for (const input of layoutFields.querySelectorAll<HTMLInputElement>('input,select')) input.disabled = true; menuAction('Open this view', () => options.selectView(selectedIndex)); }
      if (options.commands?.setDefaultView) menuAction('Set as default view', () => options.commands!.setDefaultView!(version, selectedIndex), selectedIndex !== 0);
      if (options.commands?.duplicateView) menuAction('Duplicate view', async () => {
        const duplicateName = uniqueViewName(opening.views, configuredView.name);
        await options.commands!.duplicateView!(version,selectedIndex,duplicateName);
        const refreshed = deferredState; deferredState = undefined;
        if (!options.immediate || !refreshed) return;
        own.saving = false; own.close(false); update(refreshed);
        const index=refreshed.selectedIndex,created=refreshed.views[index];
        if (created&&typeof created.id==='string'&&!opening.views.some(view=>view.id===created.id)) { open('View options',trigger,index); const input = panel?.node.querySelector<HTMLInputElement>('[aria-label="View name"]'); input?.select(); }
      });
      if (options.commands?.moveView) { menuAction('Move view earlier', () => options.commands!.moveView!(version, selectedIndex, selectedIndex - 1), selectedIndex > 0); menuAction('Move view later', () => options.commands!.moveView!(version, selectedIndex, selectedIndex + 1), selectedIndex < opening.views.length - 1); }
      if (options.commands?.removeView) menuAction('Delete view', () => options.commands!.removeView!(version, selectedIndex), opening.views.length > 0).classList.add('mod-destructive');
      if (options.commands?.updateRoot) menuAction('New item settings', async () => { own.saving = false; own.close(false); open('New item settings', trigger); });
      if (options.immediate) {
        const actions = doc.createElement('div'); actions.className = 'bases-view-actions'; actions.hidden = true;
        for (const item of Array.from(fields.querySelectorAll(':scope > .bases-toolbar-menu-item'))) actions.append(item);
        fields.append(actions);
        const more = button(doc, '', () => { actions.hidden = !actions.hidden; more.setAttribute('aria-expanded', String(!actions.hidden)); place(); }, 'View actions');
        more.className = 'bases-toolbar-menu-next'; more.append(icon('ellipsis-vertical',16,doc)); if(returnTo)heading.insertBefore(more,heading.querySelector('[data-panel-action=close]'));else heading.append(more); if(!returnTo){const close = button(doc,'',() => { if (own.dirty) submit(true); else own.close(); },'Close menu'); close.className = 'bases-toolbar-menu-next'; close.append(icon('close',16,doc)); heading.append(close);}
      }
    } else if (name === 'Properties') {
      const displayNames = new Map<string, string>();
      let propertyDrag: {property:string;source:HTMLElement;token:string;version:BaseQueryResult['version']} | undefined;
      let order = (Array.isArray(result.view.order) ? result.view.order as string[] : ['file.name']).map(normalizeBaseProperty);
      const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Find or create…'; search.setAttribute('aria-label', 'Find a property');
      const list = doc.createElement('div'); list.className = 'bases-toolbar-property-list'; fields.append(search, list);
      const render = () => {
        propertyDrag = undefined; list.replaceChildren(); const query = search.value.toLowerCase(); const candidates = [...new Set([...order, ...properties])].filter(property => opening.label(property).toLowerCase().includes(query) || property.toLowerCase().includes(query));
        for (const property of candidates.slice(0, 100)) {
          const row = doc.createElement('div'); row.className = 'bases-toolbar-property-row';
          const label = doc.createElement('label'), check = doc.createElement('input'); check.type = 'checkbox'; check.dataset.property = property; check.checked = order.includes(property); const grip = doc.createElement('span'); grip.className = 'bases-property-grip';
          const kind = opening.propertyType?.(property); const glyph = property.startsWith('file.') ? 'info' : property.startsWith('formula.') ? 'square-function' : kind === 'number' || kind === 'rating' ? 'binary' : kind === 'checkbox' || kind === 'boolean' ? 'square-check' : kind === 'date' || kind === 'datetime' ? 'calendar' : kind === 'list' || kind === 'multiselect' ? 'list' : 'text';
          grip.append(icon(glyph,16,doc)); grip.draggable = order.includes(property); label.append(check,grip,doc.createTextNode(opening.label(property))); row.append(label);
          grip.addEventListener('dragstart',event=>{if(destroyed||panel!==own||!grip.isConnected||!order.includes(property)||!event.dataTransfer){event.preventDefault();return;}const token=`${Date.now()}-${Math.random()}`;propertyDrag={property,source:grip,token,version};event.dataTransfer.setData('application/x-zorid-base-property',token);event.dataTransfer.effectAllowed='move';});
          grip.addEventListener('dragend',()=>{propertyDrag=undefined;});
          row.addEventListener('dragover',event=>{if(propertyDrag?.source.isConnected&&propertyDrag.version===version&&order.includes(property))event.preventDefault();});
          row.addEventListener('drop',event=>{const drag=propertyDrag;propertyDrag=undefined;if(!drag?.source.isConnected||!row.isConnected||panel!==own||drag.version!==version||event.dataTransfer?.getData('application/x-zorid-base-property')!==drag.token)return;const from=order.indexOf(drag.property),to=order.indexOf(property);if(from<0||to<0||from===to)return;event.preventDefault();order.splice(from,1);order.splice(to,0,drag.property);changed();render();});
          check.addEventListener('change', () => { order = check.checked ? [...order, property] : order.filter(value => value !== property); changed(); render(); Array.from(list.querySelectorAll<HTMLInputElement>('input')).find(input => input.dataset.property === property)?.focus(); });
          const index = order.indexOf(property);
          const move = (delta: number) => { const next = [...order]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; order = next; changed(); render(); Array.from(list.querySelectorAll<HTMLInputElement>('input')).find(input => input.dataset.property === property)?.focus(); };
          if (index >= 0) {
            const up = button(doc, '↑', () => move(-1), `Move ${opening.label(property)} earlier`); up.disabled = index === 0; up.dataset.moveIndex = String(index);
            const down = button(doc, '↓', () => move(1), `Move ${opening.label(property)} later`); down.disabled = index === order.length - 1; row.append(up, down);
          }
          if (options.commands?.updateRoot || options.onPropertySettings) {
            const configure = button(doc,'',() => {
              if (own.dirty) { if (auto) { submit(true); return; } error.textContent = 'Apply property changes before configuring a property.'; return; }
              own.close(false);
              if (options.commands?.updateRoot) open('Property',trigger,undefined,property); else options.onPropertySettings?.(property);
            },`Configure property ${opening.label(property)}`); configure.className = 'bases-toolbar-menu-next'; configure.append(icon('chevron-right',14,doc)); row.append(configure);
          }
          check.addEventListener('keydown',event => { if (!event.altKey || !['ArrowUp','ArrowDown'].includes(event.key) || index < 0) return; const delta = event.key === 'ArrowUp' ? -1 : 1; if (index + delta < 0 || index + delta >= order.length) return; event.preventDefault(); move(delta); });
          list.append(row);
        }
        if (candidates.length > 100) { const hint = doc.createElement('p'); hint.textContent = 'Showing the first 100 properties. Refine your search to find more.'; list.append(hint); }
      };
      if (options.immediate && options.commands?.editFormula) menuAction('Add formula',async()=>{
        const formulas = mapping((opening.settings??opening.root)?.formulas) ? (opening.settings??opening.root)!.formulas as Record<string,BaseValue> : {};
        const name = uniqueViewName(Object.keys(formulas).map(name=>({type:'formula',name})),search.value.trim()||'Untitled');
        await options.commands!.editFormula!(version,undefined,name,'');
        const refreshed = deferredState; deferredState = undefined; if (!refreshed) return;
        own.saving = false; own.close(false); update(refreshed); open('Formula',trigger,undefined,name);
        const input = panel?.node.querySelector<HTMLInputElement>('[aria-label="Formula name"]'); input?.select();
      });
      else if (options.commands?.updateRoot) fields.append(button(doc, 'Add formula', () => { if (own.dirty) { error.textContent = 'Apply property changes before adding a formula.'; return; } own.close(false); open('Formula', trigger); }));
      const addProperty = button(doc,'Add property',() => {
        const name = search.value.trim(); if (!name) { search.focus(); return; }
        const property = normalizeBaseProperty(name.startsWith('note.') ? name : `note.${name}`);
        if (!order.includes(property)) { order.push(property); changed(); }
        search.value = ''; render(); updateAddProperty();
      },'Add property'); addProperty.className = 'bases-toolbar-menu-item';
      const updateAddProperty = () => { addProperty.hidden = !search.value.trim() || properties.some(property => property === normalizeBaseProperty(`note.${search.value.trim()}`)); addProperty.textContent = `Add property “${search.value.trim()}”`; };
      fields.append(addProperty,button(doc,'Hide all',() => { order = []; changed(); render(); }));
      search.addEventListener('input',() => { render(); updateAddProperty(); }); updateAddProperty(); render(); readPatch = () => ({ order });
      rawModel={hasRawInput:()=>!!search.value,capture:()=>({kind:'properties',search:search.value,order:[...order],names:[...displayNames]}),restore:raw=>{if(raw.kind!=='properties')return false;search.value=raw.search;order=[...raw.order];displayNames.clear();for(const [key,value]of raw.names)displayNames.set(key,value);render();updateAddProperty();return true;},controls:()=>[['search',search]]};
      let presentedLabels=JSON.stringify(properties.map(property=>[property,opening.label(property),opening.propertyType?.(property)]));
      refreshPanel=(_next,retainDraft)=>{
        const nextLabels=JSON.stringify(properties.map(property=>[property,opening.label(property),opening.propertyType?.(property)]));
        if(retainDraft||nextLabels===presentedLabels)return;
        const focused=doc.activeElement as HTMLElement|null,row=focused?.closest('.bases-toolbar-property-row');
        const property=row?.querySelector<HTMLInputElement>('input[data-property]')?.dataset.property;
        const slot=row&&focused?Array.from(row.querySelectorAll('input,button')).indexOf(focused):-1;
        presentedLabels=nextLabels;render();updateAddProperty();
        if(property){const replacement=Array.from(list.querySelectorAll<HTMLInputElement>('input[data-property]')).find(input=>input.dataset.property===property)?.closest('.bases-toolbar-property-row');replacement?.querySelectorAll<HTMLElement>('input,button')[slot]?.focus({preventScroll:true});}
      };
      readOperation = () => { const view = validateToolbarPatch(result, {order}); if (!displayNames.size) { expectedPatch = {view}; return () => options.save(version, view); } if (!options.saveConfiguration) throw new Error('Combined property configuration is unavailable.'); const root = propertyDisplayPatch(opening.settings??opening.root, displayNames); expectedPatch = {view,root}; return () => options.saveConfiguration!(version, {view,root}); };
    } else if (name === 'Sort') {
      let sortDrag: {item:BaseValue;source:HTMLElement;token:string;version:BaseQueryResult['version']} | undefined;
      const sort = Array.isArray(result.view.sort) ? structuredClone(result.view.sort) as BaseValue[] : [];const sortControls=new Map<string,HTMLSelectElement>();
      const list = doc.createElement('div'); fields.append(list);
      const render = () => {
        const focusedLabel = list.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : undefined;
        sortDrag = undefined;sortControls.clear(); list.replaceChildren(); sort.forEach((value, index) => {
          const row = doc.createElement('div'); row.className = 'bases-toolbar-rule';
          const grip=doc.createElement('span');grip.className='bases-sort-grip';grip.draggable=true;grip.append(icon('grip-vertical',14,doc));row.append(grip);
          grip.addEventListener('dragstart',event=>{if(destroyed||panel!==own||!grip.isConnected||!event.dataTransfer){event.preventDefault();return;}const token=`${Date.now()}-${Math.random()}`;sortDrag={item:sort[index],source:grip,token,version};event.dataTransfer.setData('application/x-zorid-base-sort',token);event.dataTransfer.effectAllowed='move';});
          grip.addEventListener('dragend',()=>{sortDrag=undefined;});
          row.addEventListener('dragover',event=>{if(sortDrag?.source.isConnected&&sortDrag.version===version)event.preventDefault();});
          row.addEventListener('drop',event=>{const drag=sortDrag;sortDrag=undefined;if(!drag?.source.isConnected||!row.isConnected||panel!==own||drag.version!==version||event.dataTransfer?.getData('application/x-zorid-base-sort')!==drag.token)return;const from=sort.indexOf(drag.item);if(from<0||from===index)return;event.preventDefault();sort.splice(from,1);sort.splice(index,0,drag.item);changed();render();});
          row.addEventListener('keydown',event=>{if(event.isComposing||!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;const to=Math.max(0,Math.min(sort.length-1,index+(event.key==='ArrowUp'?-1:1)));if(to===index)return;event.preventDefault();event.stopPropagation();const label=(event.target as Element).getAttribute('aria-label');[sort[index],sort[to]]=[sort[to],sort[index]];changed();render();queueMicrotask(()=>{const controls=Array.from(list.children[to]?.querySelectorAll<HTMLElement>('[aria-label]')??[]);(controls.find(control=>control.getAttribute('aria-label')===label&&!control.hidden)??controls.find(control=>!control.hidden))?.focus();});},true);
          if (!mapping(value)) { row.append(doc.createTextNode('Unsupported existing sort rule')); }
          else {
            const currentProperty = propertyId(value.column || value.property), choices = availableOptions.some(([key]) => key === currentProperty) ? availableOptions : [[currentProperty, opening.label(currentProperty)] as const, ...availableOptions];
            const property = select(doc, 'Sort property', choices, currentProperty), direction = select(doc, 'Sort direction', [['ASC', 'A → Z'], ['DESC', 'Z → A']], String(value.direction));sortControls.set(`sort/${index}/property`,property);sortControls.set(`sort/${index}/direction`,direction);
            const edit = () => { const next: Record<string, BaseValue> = { ...value, property: property.value, direction: direction.value }; delete next.column; sort[index] = next; changed(); };
            property.addEventListener('change', edit); direction.addEventListener('change', edit); row.append(property, direction);
          }
          const earlier = button(doc, '↑', () => { [sort[index - 1], sort[index]] = [sort[index], sort[index - 1]]; changed(); render(); }, 'Move sort earlier'); earlier.disabled = index === 0;
          const remove = button(doc, 'Remove', () => { sort.splice(index, 1); changed(); render(); }, 'Remove sort'); if (options.immediate) { remove.replaceChildren(icon('trash',16,doc)); remove.className = 'bases-toolbar-menu-next'; earlier.className = 'bases-sort-earlier'; } row.append(earlier, remove); list.append(row);
        });
        if (focusedLabel) focusVisible(list,focusedLabel,Array.from(fields.querySelectorAll<HTMLButtonElement>('button')).find(node=>node.textContent==='Add sort'));
        if (!sort.length) { const hint = doc.createElement('p'); hint.textContent = 'No explicit sort. Files use their default name order.'; list.append(hint); }
      };
      fields.append(button(doc, 'Add sort', () => { const used = new Set(sort.filter(mapping).map(value => propertyId(value.column || value.property))); const property = result.availableProperties.find(property => !used.has(property)); if (!property) { error.textContent = 'All available properties are already sorted.'; return; } sort.push({ property, direction: 'ASC' }); changed(); render(); }));
      render(); readPatch = () => ({ sort });
      rawModel={capture:()=>({kind:'sort',rules:structuredClone(sort)}),restore:raw=>{if(raw.kind!=='sort'||raw.rules.filter(mapping).some(rule=>!properties.includes(propertyId(rule.column||rule.property))))return false;sort.splice(0,sort.length,...structuredClone(raw.rules));render();return true;},controls:()=>[...sortControls]};
    } else if (name === 'Group') {
      const existing = mapping(result.view.groupBy) ? result.view.groupBy : undefined;
      const currentProperty = propertyId(existing?.property);
      const choices = currentProperty && !availableOptions.some(([key]) => key === currentProperty) ? [[currentProperty, opening.label(currentProperty)] as const, ...availableOptions] : availableOptions;
      const property = select(doc, 'Group property', [['', 'No grouping'], ...choices], currentProperty);
      const direction = select(doc, 'Group direction', options.immediate ? [['ASC', 'A → Z'], ['DESC', 'Z → A'],['MANUAL','Manual']] : [['ASC', 'A → Z'], ['DESC', 'Z → A']], options.immediate && Array.isArray(result.view.groupOrder) ? 'MANUAL' : String(existing?.direction ?? 'ASC'));
      property.addEventListener('change', changed); direction.addEventListener('change', changed); const groupRow = doc.createElement('div'); groupRow.className = 'bases-toolbar-rule'; groupRow.append(property,direction); const clear = button(doc,'',() => { property.value = ''; changed(); },'Remove grouping'); clear.className = 'bases-toolbar-menu-next'; clear.append(icon('trash',16,doc)); groupRow.append(clear); fields.append(groupRow);
      const hint = doc.createElement('p'); hint.hidden = !!options.immediate; hint.textContent = 'Changing the grouping property resets manually chosen group visibility and order.'; fields.append(hint);
      const manual = options.immediate ? createBaseManualGroups(doc,fields,{result,property:()=>property.value,valueType:()=>opening.propertyType?.(property.value),changed,draft:active=>{own.innerDraft=active;property.disabled=direction.disabled=clear.disabled=active;options.onDraftChange();},error:message=>{error.textContent=message;}}) : undefined;
      if (manual) {
        disposers.push(()=>manual.destroy()); refreshPanel=(next,retainDraft)=>manual.update(next,retainDraft);
        direction.addEventListener('change',()=>manual.setManual(direction.value==='MANUAL'));
        property.addEventListener('change',()=>manual.update(result,false));
      }
      let restoreManual:BaseManualGroupsAdmissionDraft|undefined;
      rawModel={canCapture:()=>!manual||manual.canCaptureAdmissionDraft(),capture:()=>{const captured=manual?.captureFreeze();if(manual&&!captured)throw new Error('The raw grouping changed before it could be retained.');return{kind:'group',property:property.value,direction:direction.value,manual:captured};},ready:raw=>raw.kind==='group'&&raw.manual?[raw.manual.ready]:[],
        restore:raw=>{if(raw.kind!=='group'||raw.property&&!properties.includes(raw.property))return false;property.value=raw.property;direction.value=raw.direction;restoreManual=raw.manual;return true;},finishRestore:()=>{const captured=restoreManual;restoreManual=undefined;return!captured||manual?.restoreAdmissionDraft(captured)===true;},controls:()=>[['property',property],['direction',direction]]};
      readPatch = () => {
        const groupBy: Record<string, BaseValue> | undefined = property.value ? { ...existing, property: property.value, direction: direction.value === 'MANUAL' ? existing?.direction ?? 'ASC' : direction.value } : undefined;
        if (groupBy && property.value !== propertyId(existing?.property)) delete groupBy.column;
        if (manual) return {groupBy,groupOrder:property.value ? manual.read() : undefined};
        return property.value === propertyId(existing?.property) ? { groupBy } : { groupBy, groupOrder: undefined };
      };
      readOperation = () => {
        const patch = validateToolbarPatch(result, readPatch()), saved = configuredView.groupBy;
        // Validation canonicalizes IDs; an unchanged selection must retain its
        // original persisted spelling when only visibility/order/direction moves.
        if (mapping(patch.groupBy) && mapping(saved) && typeof saved.property === 'string' && propertyId(patch.groupBy.property) === propertyId(saved.property)) patch.groupBy = { ...patch.groupBy, property: saved.property };
        expectedPatch = {view:patch}; return () => options.save(version,patch);
      };
    } else {
      const initialView = result.view.filters === undefined ? undefined : structuredClone(result.view.filters) as FilterNode;
      const initialRoot = opening.rootFilters === undefined ? undefined : structuredClone(opening.rootFilters) as FilterNode;
      // Metadata advice may become current while an incomplete row is local.
      // Keep its providers separate from the original mutation/context witness.
      let filterAdvice=opening;
      const compositions=new Set<EventTarget>(),pressedPointers=new Set<number>(),releasedPointers=new Set<number>();
      let pointerFrame:number|undefined;
      const cancelPointerFrame=()=>{if(pointerFrame!==undefined){win?.cancelAnimationFrame(pointerFrame);pointerFrame=undefined;}};
      const resetPointers=()=>{pressedPointers.clear();releasedPointers.clear();cancelPointerFrame();};
      const inside=(target:EventTarget|null)=>target instanceof doc.defaultView!.Node&&node.contains(target);
      const compositionStart=(event:CompositionEvent)=>{if(event.target)compositions.add(event.target);};
      const compositionEnd=(event:CompositionEvent)=>{if(event.target)compositions.delete(event.target);};
      const pointerDown=(event:PointerEvent)=>{if(event.button===0&&inside(event.target)){pressedPointers.add(event.pointerId);releasedPointers.delete(event.pointerId);}};
      const pointerUp=(event:PointerEvent)=>{
        if(!pressedPointers.delete(event.pointerId))return;
        if(!inside(event.target)){releasedPointers.delete(event.pointerId);return;}
        // Native click follows release. Keep that target stable through click,
        // with one frame as a bounded fallback when a release produces no click.
        releasedPointers.add(event.pointerId);
        if(pointerFrame===undefined){if(win?.requestAnimationFrame)pointerFrame=win.requestAnimationFrame(()=>{pointerFrame=undefined;releasedPointers.clear();});else queueMicrotask(()=>releasedPointers.clear());}
      };
      const pointerCancel=(event:PointerEvent)=>{pressedPointers.delete(event.pointerId);releasedPointers.delete(event.pointerId);if(!releasedPointers.size)cancelPointerFrame();};
      const clicked=()=>{queueMicrotask(()=>{releasedPointers.clear();cancelPointerFrame();});};
      const lostInteraction=()=>{compositions.clear();resetPointers();};
      node.addEventListener('compositionstart',compositionStart,true);node.addEventListener('compositionend',compositionEnd,true);node.addEventListener('pointerdown',pointerDown,true);
      doc.addEventListener('pointerup',pointerUp,true);doc.addEventListener('pointercancel',pointerCancel,true);doc.addEventListener('click',clicked,true);doc.addEventListener('dragend',resetPointers,true);win?.addEventListener('blur',lostInteraction);
      disposers.push(()=>{node.removeEventListener('compositionstart',compositionStart,true);node.removeEventListener('compositionend',compositionEnd,true);node.removeEventListener('pointerdown',pointerDown,true);doc.removeEventListener('pointerup',pointerUp,true);doc.removeEventListener('pointercancel',pointerCancel,true);doc.removeEventListener('click',clicked,true);doc.removeEventListener('dragend',resetPointers,true);win?.removeEventListener('blur',lostInteraction);lostInteraction();});
      let savedViewFilter = JSON.stringify(initialView), savedRootFilter = JSON.stringify(initialRoot);
      let operandSnapshot:BaseFilterOperandsSnapshot|undefined;
      try{operandSnapshot=options.filterOperands?.();}catch(failure){report(failure);}
      const operandEditors=new Set<BaseFilterValues>();
      disposers.push(()=>{for(const editor of operandEditors)editor.destroy();operandEditors.clear();});
      type Section={section:HTMLElement;canCapture():boolean;capture():BaseToolbarFilterSectionDraft;restore(raw:BaseToolbarFilterSectionDraft):boolean;finishRestore():boolean;nativeControls():readonly (readonly [string,HTMLTextAreaElement|HTMLSelectElement])[];refreshUntouchedAdvice():void;get():FilterNode|undefined;acknowledge():()=>void};
      let rootEditor:Section|undefined,viewEditor:Section|undefined;
      own.refreshFilterAdvice=next=>{
        if(rawFrozen||own.saving||own.failure||next.readOnly!==opening.readOnly||next.selectedIndex!==opening.selectedIndex
          ||next.views[selectedIndex]?.name!==configuredView.name||next.views[selectedIndex]?.type!==configuredView.type
          ||JSON.stringify(configurationSnapshot(next))!==JSON.stringify(configuration))return;
        filterAdvice=next;
        if(compositions.size||pressedPointers.size||releasedPointers.size||node.querySelector('[role="combobox"][aria-expanded="true"],[role="listbox"],.cm-tooltip-autocomplete'))return;
        rootEditor?.refreshUntouchedAdvice();viewEditor?.refreshUntouchedAdvice();
      };
      const syncDraft=()=>{own.innerDraft=[...operandEditors].some(editor=>editor.hasDraft());};
      const semanticChanged=()=>{
        syncDraft();
        if(own.innerDraft){changed();return;}
        try{
          const rootFilter=rootEditor?.get(),viewFilter=viewEditor?.get();
          const different=JSON.stringify(rootFilter)!==savedRootFilter||JSON.stringify(viewFilter)!==savedViewFilter;
          if(different||own.saving||retryPersistence){changed();return;}
          // Local blank rows/groups and reverted edits do not enter the save
          // coordinator at all: no version, status or query invalidation.
          if(autoTimer){clearTimeout(autoTimer);autoTimer=undefined;}
          own.dirty=false;own.failure=undefined;error.textContent='';footer.hidden=!!auto;options.onDraftChange();place();
        }catch(failure){changed();error.textContent=failure instanceof Error?failure.message:String(failure);footer.hidden=false;}
      };
      const canRestructure=(except?:HTMLElement)=>{
        const invalid=Array.from(form.querySelectorAll<HTMLInputElement>('input')).find(input=>!input.validity.valid&&!except?.contains(input));
        if(!invalid)return true;error.textContent='Correct the invalid condition value before changing other conditions.';invalid.focus();return false;
      };
      function filterSection(title:string,initial:FilterNode|undefined,expanded:boolean,enabled=true):Section{
        let draft=createBaseFilterDraft(initial),initialized=false;
        const section=doc.createElement('section');section.className='bases-filter-section';
        const content=doc.createElement('div');content.className='bases-filter-section-content';content.hidden=!expanded;
        const disclosure=button(doc,title,()=>{if(!alive())return;content.hidden=!content.hidden;disclosure.setAttribute('aria-expanded',String(!content.hidden));if(!initialized&&!content.hidden)initialize();place();});
        disclosure.className='bases-filter-section-header';disclosure.disabled=!enabled;disclosure.setAttribute('aria-expanded',String(expanded));
        const flair=doc.createElement('span');flair.className='bases-filter-count';
        const count=(source:FilterNode|undefined)=>{const n=baseFilterCount(source);flair.textContent=String(n);flair.hidden=n===0;};count(initial);disclosure.append(flair);section.append(disclosure,content);
        const alive=()=>!destroyed&&panel===own&&section.isConnected;
        const localEditors=new Set<BaseFilterValues>(),valueEditors=new Map<BaseFilterDraftCondition,BaseFilterValues>(),expressionSources=new Map<BaseFilterDraftCondition,HTMLTextAreaElement>(),filterSelects=new Map<string,HTMLSelectElement>(),validators=new Set<()=>void>(),rendered=new WeakMap<BaseFilterDraftNode,HTMLElement>();
        let restoringValues=new Map<string,BaseFilterValuesAdmissionDraft>(),restoringExpressions=new Map<string,BaseToolbarExpressionDraft>(),restoreProblem=false;const finishChildRestores:(()=>void)[]=[],finishFormulaRestores:(()=>void)[]=[];
        const pathOf=(wanted:BaseFilterDraftNode):string=>{let found:string|undefined;const visit=(value:BaseFilterDraftNode,path:string)=>{if(value===wanted)found=path;if(value.kind==='group')value.children.forEach((child,index)=>visit(child,`${path}/${index}`));};visit(draft,'root');return found??'';};
        const refreshUntouchedAdvice=new Set<()=>void>();
        let tree:HTMLElement,renderBudget=1000;
        const release=()=>{for(const editor of localEditors){editor.destroy();operandEditors.delete(editor);}localEditors.clear();valueEditors.clear();expressionSources.clear();filterSelects.clear();validators.clear();refreshUntouchedAdvice.clear();syncDraft();};
        const focusNode=(value:BaseFilterDraftNode)=>{const row=rendered.get(value);if(row)focusVisible(row,'Filter property');};
        const renderNode=(value:BaseFilterDraftNode,remove:()=>void,depth=0):HTMLElement=>{
          const row=doc.createElement('div');row.className=value.kind==='condition'?'bases-filter-condition':'bases-filter-group';rendered.set(value,row);
          if(--renderBudget<0||depth>32){row.append(doc.createTextNode('This filter exceeds the visual editor’s size or nesting limit.'));return row;}
          const live=()=>alive()&&row.isConnected&&tree.contains(row);
          if(value.kind==='condition'){
            const removeButton=button(doc,'Remove',()=>{if(!live()||!canRestructure(row))return;remove();render();semanticChanged();focusVisible(tree,'Match');},'Remove filter');
            if(options.immediate){removeButton.replaceChildren(icon('trash',16,doc));removeButton.className='bases-toolbar-menu-next';}
            if(value.advanced||!value.fields){
              const expression=doc.createElement('textarea');expression.setAttribute('aria-label','Filter expression');const retainedExpression=restoringExpressions.get(pathOf(value));expression.value=retainedExpression?(retainedExpression.kind==='native'?retainedExpression.text:retainedExpression.draft.initial):value.source??'';expression.rows=2;expressionSources.set(value,expression);
              if(retainedExpression){if(retainedExpression.kind==='native'){deferredNativeExpressions.add(expression);updateBaseFilterExpression(value,retainedExpression.text);}else finishFormulaRestores.push(()=>{const editor=formulaOwners.get(expression);if(!editor?.restoreAdmissionDraft(retainedExpression.draft)){restoreProblem=true;return;}updateBaseFilterExpression(value,retainedExpression.draft.state.text);});}
              expression.addEventListener('input',()=>{if(!live())return;updateBaseFilterExpression(value,expression.value);semanticChanged();});row.append(expression,removeButton);
            }else{
              const fields=value.fields;
              const choices=[['file.file',opening.label('file.file')==='file file'?'file':opening.label('file.file')] as const,...propertyOptions.filter(([key])=>key!=='file.file')];
              if(!choices.some(([key])=>key===fields.property))choices.unshift([fields.property,fields.property]);
              const property=select(doc,'Filter property',choices,fields.property);
              const descriptor=baseFilterProperty(fields.property,filterAdvice.filterProperty?.(fields.property),filterAdvice.propertyType?.(fields.property));
              let catalog=baseFilterOperators(descriptor,fields.operator);
              let selected=catalog.find(item=>item.id===fields.operator);
              // A recognized AST can still require a different property family.
              // Keep such saved source editable verbatim, never coerce its data.
              if(!selected){
                const expression=doc.createElement('textarea');expression.setAttribute('aria-label','Filter expression');const retainedExpression=restoringExpressions.get(pathOf(value));expression.value=retainedExpression?(retainedExpression.kind==='native'?retainedExpression.text:retainedExpression.draft.initial):value.source??'';expression.rows=2;expressionSources.set(value,expression);
              if(retainedExpression){if(retainedExpression.kind==='native'){deferredNativeExpressions.add(expression);updateBaseFilterExpression(value,retainedExpression.text);}else finishFormulaRestores.push(()=>{const editor=formulaOwners.get(expression);if(!editor?.restoreAdmissionDraft(retainedExpression.draft)){restoreProblem=true;return;}updateBaseFilterExpression(value,retainedExpression.draft.state.text);});}
                expression.addEventListener('input',()=>{if(live()){updateBaseFilterExpression(value,expression.value);semanticChanged();}});row.append(expression,removeButton);
                const saved=value.source;
                // A retired metadata frame can temporarily hide a saved operator.
                // Recover only untouched source once current advice supports it.
                if(descriptor.kind==='unknown'&&saved!==undefined&&value.acceptedSource===saved){
                  const refreshSaved=()=>{
                    const focused=doc.activeElement;
                    if(!live()||value.advanced||value.fields!==fields||value.source!==saved||value.acceptedSource!==saved||expression.value!==saved
                      ||focused&&row.contains(focused))return;
                    const supplied=filterAdvice.filterProperty?.(fields.property);
                    if(!supplied||supplied.kind==='unknown'||!baseFilterOperators(baseFilterProperty(fields.property,supplied),fields.operator).some(item=>item.id===fields.operator))return;
                    refreshUntouchedAdvice.delete(refreshSaved);
                    const budget=renderBudget;renderBudget=1;const replacement=renderNode(value,remove,depth);renderBudget=budget;row.replaceWith(replacement);
                    enhanceControls?.();place();
                  };
                  refreshUntouchedAdvice.add(refreshSaved);
                }
                return row;
              }
              let initialValues:readonly BaseFilterLiteral[]|undefined;
              try{initialValues=filterConditionValues(fields);}catch{/* incomplete local draft */}
              if(value.source===undefined&&fields.text===''&&fields.arguments===undefined&&!Object.hasOwn(fields,'operand'))initialValues=undefined;
              // Unknown property category stays unknown. An already-authored
              // literal can still retain its own numeric/Boolean/list editor.
              if(descriptor.kind==='unknown'&&selected.comparison&&initialValues?.length===1){
                const literal=initialValues[0],operand=typeof literal==='number'?'number':typeof literal==='boolean'?'boolean':Array.isArray(literal)?'list':selected.operand;
                catalog=catalog.map(item=>item.comparison&&item.arity==='one'?{...item,operand}:item);
                selected=catalog.find(item=>item.id===fields.operator)!;
              }
              const operator=select(doc,'Condition',catalog.map(item=>[item.id,item.label] as const),fields.operator);row.append(property,operator);filterSelects.set(`${title}/${pathOf(value)}/property`,property);filterSelects.set(`${title}/${pathOf(value)}/operator`,operator);
              const host=doc.createElement('div');host.className='bases-filter-operand-host';row.append(host);
              let editor:BaseFilterValues;
              const primary=()=>host.querySelector<HTMLInputElement|HTMLTextAreaElement>('input,textarea');
              const validate=()=>{
                const input=primary();if(!input)return;
                try{readBaseFilterDraft(value);input.setCustomValidity(editor?.hasDraft()?'Add or clear the pending item.':'');}catch(failure){input.setCustomValidity(failure instanceof Error?failure.message:String(failure));}
              };
              const publish=(next:BaseFilterCondition,issue?:{incomplete?:boolean;error?:string})=>{updateBaseFilterCondition(value,next,issue);validate();semanticChanged();};
              const fromValues=(next:BaseFilterCondition,values:readonly BaseFilterLiteral[]|undefined):BaseFilterCondition=>{
                const clean={...next};delete clean.values;delete clean.arguments;delete clean.operand;
                const method=baseFilterMethod(clean.operator);
                if(method)clean.arguments=values;
                else if(values?.length===1)clean.operand=values[0];
                return clean;
              };
              const missing=(item:BaseFilterOperatorDescriptor,values:readonly BaseFilterLiteral[]|undefined)=>item.arity!=='none'&&(values===undefined||values.length===0||(!(item.operand==='tokens'||((descriptor.kind==='list'||descriptor.kind==='tagList')&&item.method==='contains'))&&values.some(part=>typeof part==='string'&&part==='')));
              const retainedValue=restoringValues.get(pathOf(value));if(retainedValue)initialValues=retainedValue.initial;
              editor=createBaseFilterValues(doc,host,{operator:selected,property:descriptor,values:initialValues,snapshot:operandSnapshot,alive:live,
                onChange(){const current=editor.read();publish(fromValues(value.fields!,current.values),{error:current.error,incomplete:missing(selected!,current.values)});},
                onDraftChange(){syncDraft();validate();semanticChanged();},
              });
              localEditors.add(editor);valueEditors.set(value,editor);operandEditors.add(editor);validators.add(validate);
              if(retainedValue)finishChildRestores.push(()=>{if(!editor.restoreAdmissionDraft(retainedValue)){restoreProblem=true;return;}const current=editor.read();updateBaseFilterCondition(value,fromValues(value.fields!,current.values),{error:current.error,incomplete:missing(selected!,current.values)});validate();});
              const refreshBlank=()=>{
                const field=primary(),focused=doc.activeElement;
                if(!live()||descriptor.kind!=='unknown'||value.fields!==fields||value.source!==undefined||value.advanced
                  ||fields.text!==''||fields.arguments!==undefined||fields.values!==undefined||Object.hasOwn(fields,'operand')
                  ||editor.hasDraft()||!field||field.value!==''||field.validity.badInput
                  // Native action buttons activate on Space release; keep their
                  // original target until focus leaves. Combobox keys are owned.
                  ||row.contains(focused)&&focused instanceof doc.defaultView!.HTMLButtonElement&&focused.getAttribute('role')!=='combobox'
                  ||host.contains(focused)||row.querySelector('[aria-expanded="true"],[role="listbox"]'))return;
                const supplied=filterAdvice.filterProperty?.(fields.property);
                if(!supplied||supplied.kind==='unknown')return;
                const label=focused instanceof doc.defaultView!.HTMLElement&&row.contains(focused)?focused.getAttribute('aria-label'):undefined;
                editor.destroy();localEditors.delete(editor);operandEditors.delete(editor);validators.delete(validate);refreshUntouchedAdvice.delete(refreshBlank);
                const budget=renderBudget;renderBudget=1;const replacement=renderNode(value,remove,depth);renderBudget=budget;row.replaceWith(replacement);
                if(label)focusVisible(replacement,label);syncDraft();place();
              };
              refreshUntouchedAdvice.add(refreshBlank);
              const blocked=()=>{syncDraft();if(own.innerDraft){error.textContent='Add or clear the pending item before changing its condition.';return true;}return !canRestructure();};
              property.addEventListener('change',()=>{
                if(!live())return;
                if(blocked()){property.value=value.fields!.property;return;}
                const category=baseFilterProperty(property.value,filterAdvice.filterProperty?.(property.value),filterAdvice.propertyType?.(property.value));
                const next=baseFilterOperators(category)[0];
                publish({property:property.value,operator:next.id,text:'',type:'text'},{incomplete:next.arity!=='none'});render();focusNode(value);
              });
              operator.addEventListener('change',()=>{
                if(!live())return;
                if(blocked()){operator.value=value.fields!.operator;return;}
                const next=catalog.find(item=>item.id===operator.value);
                if(!next){operator.value=value.fields!.operator;return;}
                const current=editor.read();
                // Reuse data only for the same operand family/arity; changing
                // exact-list versus variadic membership never flattens arrays.
                const compatible=next.operand===selected!.operand&&next.arity===selected!.arity;
                const values=next.arity==='none'?[]:compatible?current.values:undefined;
                publish(fromValues({...value.fields!,operator:next.id,text:''},values),{incomplete:!(compatible&&value.source!==undefined)&&missing(next,values)});render();focusNode(value);
              });
              const advanced=button(doc,'',()=>{if(!live()||!canRestructure())return;value.advanced=true;render();const target=rendered.get(value);focusVisible(target??tree,'Filter expression');},'Edit expression');
              advanced.className='bases-toolbar-menu-next';advanced.append(icon('code',16,doc));row.append(advanced,removeButton);
            }
          }else{
            const mode=select(doc,'Match',[['and','All the following are true'],['or','Any of the following are true'],['not','None of the following are true']],value.conjunction);filterSelects.set(`${title}/${pathOf(value)}/match`,mode);
            mode.addEventListener('change',()=>{if(!live()||!canRestructure()){mode.value=value.conjunction;return;}value.conjunction=mode.value as BaseFilterConjunction;value.implicit=false;semanticChanged();render();});row.append(mode);
            for(let index=0;index<value.children.length;index++){
              const child=value.children[index];row.append(renderNode(child,()=>{value.children.splice(value.children.indexOf(child),1);if(!value.children.length)value.children.push(newBaseFilterCondition());},depth+1));if(renderBudget<0)break;
            }
            const append=(next:BaseFilterDraftNode)=>{if(!live()||!canRestructure())return;value.children.push(next);semanticChanged();render();focusNode(next);};
            row.append(button(doc,'Add condition',()=>append(newBaseFilterCondition())),button(doc,'Add group',()=>append(newBaseFilterGroup())),button(doc,'Remove group',()=>{if(!live()||!canRestructure(row))return;remove();render();semanticChanged();}));
          }
          return row;
        };
        const render=()=>{
          const focusedLabel=tree.contains(doc.activeElement)?doc.activeElement?.getAttribute('aria-label'):undefined;
          release();tree.replaceChildren();renderBudget=1000;tree.append(renderNode(draft,()=>{draft=newBaseFilterGroup();}));
          for(const restore of finishChildRestores.splice(0))restore();
          if(focusedLabel)focusVisible(tree,focusedLabel);place();
        };
        const initialize=()=>{
          if(initialized)return;initialized=true;tree=doc.createElement('div');tree.className='bases-filter-tree';content.append(tree);
          const actions=doc.createElement('div');actions.className='bases-filter-actions';
          const append=(next:BaseFilterDraftNode)=>{if(!alive()||!canRestructure())return;draft.children.push(next);semanticChanged();render();focusNode(next);};
          actions.append(button(doc,'Add filter',()=>append(newBaseFilterCondition())));
          if(options.immediate)actions.append(button(doc,'Add filter group',()=>append(newBaseFilterGroup())));
          else actions.append(button(doc,'Add expression',()=>{if(!alive()||!canRestructure())return;const next:BaseFilterDraftCondition={kind:'condition',source:'true',advanced:true};if(readBaseFilterDraft(draft)===undefined)draft={kind:'group',conjunction:'and',children:[next],persistedEmpty:false,implicit:true};else draft.children.push(next);semanticChanged();render();focusNode(next);}));
          content.append(actions);render();
        };
        if(expanded)initialize();
        return {section,canCapture:()=>[...expressionSources.values()].every(source=>!formulaOwners.has(source)||formulaOwners.get(source)?.canCaptureAdmissionDraft?.()===true)&&[...valueEditors.values()].every(editor=>editor.canCaptureAdmissionDraft()),
          capture(){return{tree:structuredClone(draft),expanded:!content.hidden,initialized,values:[...valueEditors].map(([condition,editor])=>{const captured=editor.captureFreeze();if(!captured)throw new Error('The raw filter value changed before it could be retained.');return{path:pathOf(condition),draft:captured};}),expressions:[...expressionSources].map(([condition,source])=>{const editor=formulaOwners.get(source);if(!editor)return{path:pathOf(condition),raw:{kind:'native' as const,text:source.value}};const captured=editor.captureFreeze();if(!captured)throw new Error('The raw formula changed before it could be retained.');return{path:pathOf(condition),raw:{kind:'formula' as const,draft:captured}};})};},
          restore(raw){draft=structuredClone(raw.tree);content.hidden=!raw.expanded;disclosure.setAttribute('aria-expanded',String(raw.expanded));restoringValues=new Map(raw.values.map(value=>[value.path,value.draft]));restoringExpressions=new Map(raw.expressions.map(value=>[value.path,value.raw]));restoreProblem=false;if(raw.initialized){if(!initialized)initialize();else render();}restoringValues.clear();restoringExpressions.clear();return!restoreProblem;},finishRestore(){for(const restore of finishFormulaRestores.splice(0))restore();return!restoreProblem;},nativeControls:()=>[...[...expressionSources].filter(([,source])=>!formulaOwners.has(source)).map(([condition,source])=>[`${title}/${pathOf(condition)}`,source] as const),...[...filterSelects]],
          refreshUntouchedAdvice(){for(const refresh of [...refreshUntouchedAdvice])refresh();},get:()=>readBaseFilterDraft(draft),acknowledge(){const source=readBaseFilterDraft(draft),acknowledge=captureBaseFilterAcknowledgement(draft);return ()=>{acknowledge();count(source);for(const validate of validators)validate();};}};
      }
      rootEditor=filterSection('All views',initialRoot,false,!!options.commands?.updateRoot);
      if(configuredView.source!==undefined)rootEditor.section.hidden=true;
      viewEditor=filterSection('This view',initialView,true);fields.append(rootEditor.section,viewEditor.section);
      rawModel={canCapture:()=>!!rootEditor?.canCapture()&&!!viewEditor?.canCapture(),capture:()=>({kind:'filter',all:rootEditor!.capture(),view:viewEditor!.capture()}),
        ready:raw=>raw.kind==='filter'?[...[...raw.all.values,...raw.view.values].map(value=>value.draft.ready),...[...raw.all.expressions,...raw.view.expressions].flatMap(value=>value.raw.kind==='formula'?[value.raw.draft.ready]:[])]:[],
        restore:raw=>raw.kind==='filter'&&rootEditor!.restore(raw.all)&&viewEditor!.restore(raw.view),finishRestore:()=>rootEditor!.finishRestore()&&viewEditor!.finishRestore(),controls:()=>[...rootEditor!.nativeControls(),...viewEditor!.nativeControls()]};
      readPatch=()=>({filters:viewEditor!.get() as BaseValue|undefined});
      readOperation=()=>{
        const viewFilter=viewEditor!.get(),rootFilter=rootEditor!.get();
        const view=validateToolbarPatch(result,{filters:viewFilter as BaseValue|undefined});
        const root={filters:rootFilter as BaseValue|undefined};validateToolbarPatch(result,{filters:root.filters});
        const viewChanged=JSON.stringify(viewFilter)!==savedViewFilter,rootChanged=JSON.stringify(rootFilter)!==savedRootFilter;
        const patch={...(viewChanged?{view}:{}),...(rootChanged?{root}:{})};
        const submittedView=JSON.stringify(viewFilter),submittedRoot=JSON.stringify(rootFilter),ackView=viewEditor!.acknowledge(),ackRoot=rootEditor!.acknowledge();
        afterSave=()=>{savedViewFilter=submittedView;savedRootFilter=submittedRoot;ackView();ackRoot();};
        if(!viewChanged&&!rootChanged){expectedPatch={};return async()=>{};}
        if(options.saveConfiguration){expectedPatch=patch;return ()=>options.saveConfiguration!(version,patch);}
        if(rootChanged){if(viewChanged)throw Error('Combined filter changes are unavailable.');if(!options.commands?.updateRoot)throw Error('All-view filters are unavailable.');expectedPatch={root};return ()=>options.commands!.updateRoot!(version,root);}
        expectedPatch={view};return ()=>options.save(version,view);
      };
    }
    let closeWhenSettled = false;
    const submit = (close: boolean) => {
      if(close)afterClean=undefined;
      closeWhenSettled ||= close;
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = undefined; }
      if (own.saving || destroyed || panel !== own) return;
      if(reviewFailure){reviewRetained();return;}
      if(rawFrozen || rawPassive)return;
      if (own.innerDraft) { error.textContent = 'Finish or cancel the unfinished value first.'; return; }
      if (!own.dirty && !own.failure) { if (close) own.close(); return; }
      if (!form.checkValidity()) { error.textContent = 'Check the invalid condition value before applying.'; return; }
      if(!retryPersistence&&name!=='Views'&&deferredState&&deferredState.selectedIndex!==opening.selectedIndex){error.textContent='The selected view changed. Your draft is still here. Cancel and reopen the view before saving.';footer.hidden=false;options.onDraftChange();return;}
      if (deferredState && own.rebase?.(deferredState)) { state = deferredState; deferredState = undefined; }
      let operation: () => Promise<void>;
      expectedPatch = undefined; expectedSnapshot = undefined;
      try {
        options.preflight();
        if (retryPersistence) operation = retryPersistence;
        else if (readOperation) operation = readOperation();
        else { const patch = validateToolbarPatch(result, readPatch()); expectedPatch = {view:patch}; operation = () => options.save(version, patch); }
      } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); return; }
      const retrying = !!retryPersistence && !!retainedAttempt;
      const attempt: AcceptedAttempt = retrying ? retainedAttempt! : {
        generation,configuration:expectedSnapshot??(expectedPatch?applyConfigurationPatch(configuration,expectedPatch,selectedIndex):configuration),
        viewName:name==='View options'||name==='View settings'?form.querySelector<HTMLInputElement>('[aria-label="View name"]')?.value.trim()||configuredView.name:configuredView.name,
        inputs:inputStates(),acknowledge:afterSave,
      };
      activeAttempt=attempt;
      const submittedGeneration = attempt.generation, expectedConfiguration = attempt.configuration, expectedViewName = attempt.viewName;
      own.saving = true; options.onDraftChange();
      const disabled = inputStates();
      if (!auto) for (const input of disabled.keys()) input.disabled = true;
      error.textContent = 'Saving…';
      submitted=true;void invoke(operation).then(() => {
        if (destroyed || panel !== own) return;
        own.saving = false; submitted=false; own.failure = undefined; retryPersistence = undefined; retainedAttempt = undefined;
        if(retrying)for(const [input,wasDisabled] of attempt.inputs) input.disabled=wasDisabled;
        own.dirty = generation !== submittedGeneration;
        if (!expectedConfiguration && own.dirty) {
          own.failure = {}; footer.hidden = false; error.textContent = 'The retained command is saved. Your newer configuration draft is still here. Cancel and reopen the updated view before continuing.'; options.onDraftChange(); return;
        }
        if (!auto) {
          if(own.dirty){footer.hidden=false;error.textContent='The retained draft is saved. Your newer changes are still here.';options.onDraftChange();return;}
          own.dirty = false; const refreshed = deferredState; deferredState = undefined; own.close(); if (refreshed) update(refreshed);
          return;
        }
        if(expectedConfiguration)configuration = expectedConfiguration;
        if (deferredState) {
          const refreshed = deferredState; deferredState = undefined;
          if(expectedConfiguration)configuration = expectedConfiguration;
          if (!own.rebase?.(refreshed,expectedViewName)) {
            if (!own.dirty) { own.close(); update(refreshed); return; }
            own.failure = {}; footer.hidden = false; error.textContent = 'This view changed or moved while saving. Your queued changes are still here. Cancel and reopen the view before continuing.'; options.onDraftChange(); return;
          }
          state = refreshed;
          refreshFilterSummary(refreshed);
        }
        error.textContent = ''; footer.hidden = true; attempt.acknowledge?.(); options.onDraftChange();
        if (own.dirty) submit(closeWhenSettled);
        else if(afterClean){const next=afterClean;afterClean=undefined;next();}
        else if (closeWhenSettled) own.close();
      }, failure => {
        if (destroyed || panel !== own) return; own.saving = false; own.dirty = true;
        if(autoTimer){clearTimeout(autoTimer);autoTimer=undefined;}
        if (failure instanceof BaseToolbarSaveError) {retryPersistence = failure.retry;reviewFailure=failure;retainedAttempt??=attempt;}
        if (retryPersistence) {
          own.failure ??= {}; own.acceptsSaveAcknowledgement = () => generation === submittedGeneration;
          error.textContent = `Could not save: ${failure instanceof Error ? failure.message : String(failure)}. The accepted configuration and your newer input are retained for review or copying.`;
          footer.hidden = false; apply.disabled = false; apply.textContent = 'Review retained changes';apply.dataset.baseReview='true';node.inert=false; cancel.disabled = false;
          for (const input of node.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) input.disabled = true;
        } else {
          own.failure = undefined; footer.hidden = false;
          for (const [input, wasDisabled] of disabled) input.disabled = wasDisabled;
          error.textContent = `Could not apply: ${failure instanceof Error ? failure.message : String(failure)}. Your changes are still here.`;
        }
        report(failure); options.onDraftChange();
      });
    };
    form.addEventListener('submit', event => { event.preventDefault(); submit(!auto || !!retryPersistence); });
    own.flush = () => submit(true);
    if (options.immediate && win?.MutationObserver) {
      const enhanced=comboOwners;
      const editors=formulaOwners;
      const attemptedEditors = new WeakSet<HTMLTextAreaElement>();
      const enhance = () => {
        if(rawFrozen||restoringRawModel)return;
        for (const [source,editor] of editors) if (!node.contains(source)) { editor.destroy(); editors.delete(source); }
        for (const source of node.querySelectorAll<HTMLTextAreaElement>('textarea')) {
          if (deferredNativeExpressions.has(source) || attemptedEditors.has(source) || !['Formula expression','Filter expression'].includes(source.getAttribute('aria-label')??'')) continue;
          attemptedEditors.add(source); const focused = doc.activeElement === source;
          try { const editor = enhanceBaseFormulaEditor(source,{propertyIds:properties,functionNames:opening.functionNames??['if','date','duration','list','max','min','number','now','today','escapeHTML'],methodNames:opening.methodNames??['isTruthy','isEmpty','toString','isType','contains','containsAll','containsAny','endsWith','lower','replace','repeat','reverse','slice','split','startsWith','title','trim','abs','ceil','floor','round','toFixed','date','format','time','filter','flat','join','map','reduce','sort','unique','sum','mean','keys','values','matches','hasLink','asLink','hasProperty','hasTag','inFolder','relative'],onEscape:()=>submit(true)}); editors.set(source,editor); if (focused) editor.focus(); } catch (failure) { report(failure); }
        }
        for (const [source,control] of enhanced) if (!node.contains(source)) { control.destroy(); enhanced.delete(source); }
        for (const source of node.querySelectorAll<HTMLSelectElement>('select')) {
          if (enhanced.has(source) || source.getAttribute('aria-label') === 'Value type') continue;
          const label = source.getAttribute('aria-label') ?? '';
          enhanced.set(source,createBaseCombobox(source,{owner:node,searchable:/property|Layout/.test(label),isCurrent:()=>!destroyed&&!rawFrozen&&panel===own}));
        }
      };
      enhanceControls=enhance;
      const observer = new win.MutationObserver(enhance); observer.observe(node,{childList:true,subtree:true}); enhance();
      disposers.push(()=>{observer.disconnect();for(const control of enhanced.values())control.destroy();enhanced.clear();for(const editor of editors.values())editor.destroy();editors.clear();});
    }
    own.acknowledgeAcceptedSave=()=>{
      const attempt=retainedAttempt;if(!attempt||!own.failure||own.saving)return;
      const newer=generation!==attempt.generation;
      if(newer&&!attempt.configuration)return;
      if(attempt.configuration)configuration=attempt.configuration;
      if(deferredState&&!own.rebase?.(deferredState,attempt.viewName))return;
      if(deferredState){state=deferredState;deferredState=undefined;}
      own.failure=undefined;retryPersistence=undefined;reviewFailure=undefined;retainedAttempt=undefined;submitted=false;
      for(const [input,disabled]of attempt.inputs)input.disabled=disabled;
      attempt.acknowledge?.();own.dirty=newer;
      node.querySelector('.bases-configuration-review')?.remove();
      if(newer){rawPassive=true;footer.hidden=false;apply.textContent='Apply';delete apply.dataset.baseReview;error.textContent='The accepted configuration is saved. Your newer input is retained. Edit or cancel it to continue.';options.onDraftChange();}
      else own.close(false);
    };
    let capturingAccepted=false;
    own.suspendAdmission=()=>{
      const newer=!!activeAttempt&&(generation!==activeAttempt.generation||unfinishedInput());
      capturingAccepted=newer;
      const raw=newer?own.captureFreeze?.():undefined;
      rawFrozen=true;if(autoTimer){clearTimeout(autoTimer);autoTimer=undefined;}afterClean=undefined;
      if(newer&&!raw)throw new Error('The newer Base settings are retained while their input finishes.');
      if(raw)void raw.ready.then(()=>{if(!reviewFailure)node.inert=true;});else node.inert=true;return raw;
    };
    let captured:BaseToolbarAdmissionDraft|undefined;
    own.canCaptureAdmissionDraft=()=>!!captured||!!rawModel&&(rawModel.canCapture?.()??true)&&rawModel.controls().every(([,control])=>!(control instanceof doc.defaultView!.HTMLSelectElement)||!comboOwners.has(control)||comboOwners.get(control)?.canCaptureAdmissionDraft()===true)&&(own.dirty||!!own.innerDraft||unsubmittedInput())&&(capturingAccepted||!own.saving&&!own.failure&&!submitted&&!retryPersistence&&!retainedAttempt);
    own.captureFreeze=()=>{
      if(captured)return captured;if(!own.canCaptureAdmissionDraft?.()||!rawModel)return;
      const controls=()=>rawModel!.controls().map(([key,control])=>({key,start:'selectionStart'in control?control.selectionStart:null,end:'selectionEnd'in control?control.selectionEnd:null,direction:'selectionDirection'in control?control.selectionDirection:null}));
      const focused=rawModel.controls().find(([,control])=>control===doc.activeElement),control=focused?.[1];
      const focus=focused&&control?{key:focused[0],start:'selectionStart'in control?control.selectionStart:null,end:'selectionEnd'in control?control.selectionEnd:null,direction:'selectionDirection'in control?control.selectionDirection:null}:undefined;
      rawFrozen=true;if(autoTimer){clearTimeout(autoTimer);autoTimer=undefined;}afterClean=undefined;
      const freezeNative=()=>{
        for(const [,control]of rawModel!.controls())if('readOnly'in control){const cycle=compositions.get(control);if(!cycle?.active&&!cycle?.settling)control.readOnly=true;}
        for(const control of node.querySelectorAll<HTMLButtonElement|HTMLSelectElement|HTMLInputElement>('button,select,input[type=checkbox],input[type=radio]'))control.disabled=true;
      };
      const comboboxes=rawModel.controls().flatMap(([key,control])=>{if(!(control instanceof doc.defaultView!.HTMLSelectElement))return[];const owner=comboOwners.get(control);if(!owner)return[];const draft=owner.captureFreeze();if(!draft)throw new Error('The raw choice changed before it could be retained.');return[{key,draft}];});
      let raw=rawModel.capture(),positions=controls(),resolve!:()=>void,finished=false,childrenReady=false;const ready=new Promise<void>(yes=>{resolve=yes;});
      captured={panel:name,get target(){return{selectedIndex,viewId:typeof configuredView.id==='string'?configuredView.id:undefined,formulaName,returnTo};},get configuration(){return structuredClone(capturingAccepted?activeAttempt?.configuration??configuration:configuration);},dirty:own.dirty||unfinishedInput(),innerDraft:!!own.innerDraft,access:{readOnly:opening.readOnly,browseOnly:opening.browseOnly===true,allowRename:opening.allowRename},comboboxes,get raw(){return raw;},get controls(){return positions;},focus,validation:error.textContent??'',ready};
      completeRawCapture=()=>{if(finished||!childrenReady||unfinishedInput())return;raw=rawModel!.capture();positions=controls();freezeNative();finished=true;completedToolbarDrafts.add(captured!);completeRawCapture=undefined;resolve();};
      freezeNative();void Promise.all([...(rawModel.ready?.(raw)??[]),...comboboxes.map(value=>value.draft.ready)]).then(()=>{childrenReady=true;completeRawCapture?.();});completeRawCapture();
      return captured;
    };
    own.restoreRaw=draft=>{
      if(!rawModel?.restore(draft.raw))return false;
      restoringRawModel=false;enhanceControls?.();if(rawModel.finishRestore?.()===false)return false;for(const captured of draft.comboboxes){const control=rawModel.controls().find(([key])=>key===captured.key)?.[1];if(!(control instanceof doc.defaultView!.HTMLSelectElement)||comboOwners.get(control)?.restoreAdmissionDraft(captured.draft)!==true)return false;}rawPassive=true;own.dirty=draft.dirty&&rawModel.dirtyOnRestore!==false;own.innerDraft||=draft.innerDraft;generation++;error.textContent=draft.validation;options.onDraftChange();
      for(const captured of draft.controls){const control=rawModel.controls().find(([key])=>key===captured.key)?.[1];if(control&&'setSelectionRange'in control&&captured.start!==null&&captured.end!==null)try{control.setSelectionRange(captured.start,captured.end,captured.direction??undefined);}catch{/* Native date controls have no text selection. */}}
      if(draft.focus)rawModel.controls().find(([key])=>key===draft.focus!.key)?.[1].focus({preventScroll:true});
      return true;
    };
    place();if(!restoring){const initialFocus = Array.from(fields.querySelectorAll<HTMLElement>('input,select,textarea,button')).find(control=>!control.hidden&&!control.closest('[hidden]')); initialFocus?.focus({ preventScroll: true }); if (name === 'Add view' && initialFocus?.tagName === 'INPUT') (initialFocus as HTMLInputElement).select();}
  }
  function update(next: BaseToolbarState) {
    if (destroyed) return;
    if (hasDraft()) { panel?.refreshFilterAdvice?.(next); deferredState = next; return; }
    if (panel && options.immediate) {
      if (!panel.rebase?.(next)) { panel.close(false); update(next); return; }
      state = next;
      updateTabs(next);
      refreshFilterSummary(next);
      return;
    }
    const focusedLabel = actions.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : panel?.node.contains(doc.activeElement) ? panel.trigger.getAttribute('aria-label') : undefined;
    panel?.close(false);
    state = next;
    selector.replaceChildren(...next.views.map((view, index) => { const option = doc.createElement('option'); option.value = String(index); option.textContent = view.name; return option; })); selector.value = String(next.selectedIndex);
    updateTabs(next);
    searchCount.textContent = searchInput.value ? `${next.result.counts.returned} results` : '';
    actions.replaceChildren();
    if (!next.readOnly) for (const [name, glyph] of [['Filter','list-filter'],['Sort','arrow-up-down']] as const) {
      const node = button(doc, '', () => open(name, node), name); node.className = 'bases-toolbar-action'; node.dataset.baseTooltip = name; node.setAttribute('aria-haspopup','dialog');
      const label = doc.createElement('span'); label.className = 'bases-toolbar-label'; label.textContent = name;
      node.append(icon(glyph,16,doc),label);
      if (name === 'Sort' && Array.isArray(next.result.view.sort) && next.result.view.sort.length) node.classList.add('is-active');
      actions.append(node);
    }
    refreshFilterSummary(next);
    if (options.onSearch) { const node = button(doc, '', () => { if (!searchRow.hidden) { closeSearch(); return; } searchRow.hidden = false; searchInput.value = state?.search ?? ''; node.classList.add('is-active'); searchInput.focus(); searchInput.select(); }, 'Search'); node.className = 'bases-toolbar-action'; node.dataset.baseTooltip = 'Search'; node.append(icon('search',16,doc)); node.classList.toggle('is-active',!searchRow.hidden); actions.append(node); }
    if (!next.readOnly) { const node = button(doc, '', () => open('View settings',node), 'Settings'); node.className = 'bases-toolbar-action bases-toolbar-settings'; node.dataset.baseTooltip = 'Settings'; node.dataset.toolbarAction='settings'; node.setAttribute('aria-haspopup','dialog'); node.append(icon('sliders-horizontal',16,doc)); actions.append(node); }
    if (!next.readOnly && options.onNew) { const node = button(doc, '', () => { try { options.preflight('new'); if (hasDraft()) throw new Error('Finish the current changes first.'); node.disabled = true; void options.onNew!().catch(report).finally(() => { if (!destroyed) node.disabled = false; }); } catch (error) { report(error); } }, 'New'); node.className = 'bases-toolbar-action bases-toolbar-new'; node.textContent='New'; actions.append(node);
      if(options.commands?.updateRoot){node.classList.add('has-options');const more=button(doc,'',()=>open('New item settings',more),'New item options');more.className='bases-toolbar-action bases-toolbar-new-options';more.dataset.baseTooltip='New item options';more.setAttribute('aria-haspopup','dialog');more.append(icon('down',14,doc));actions.append(more);}
    }
    if (focusedLabel) Array.from(actions.querySelectorAll<HTMLButtonElement>('button')).find(node => node.getAttribute('aria-label') === focusedLabel)?.focus({ preventScroll: true });
  }
  return { update,suspendAdmission(){const raw=panel?.suspendAdmission?.();container.inert=true;return raw;},canCaptureAdmissionDraft:()=>panel?.canCaptureAdmissionDraft?.()===true,captureFreeze:()=>panel?.captureFreeze?.(),restoreAdmissionDraft(draft){
      if(destroyed||!state||panel||!completedToolbarDrafts.has(draft))return'pending';
      const current=configurationSnapshot(state),target=state.views[draft.target.selectedIndex];
      if(state.readOnly!==draft.access.readOnly||(state.browseOnly===true)!==draft.access.browseOnly||state.allowRename!==draft.access.allowRename||JSON.stringify(current)!==JSON.stringify(draft.configuration)||!target||draft.target.viewId!==undefined&&target.id!==draft.target.viewId)return'conflict';
      const trigger=actions.querySelector<HTMLElement>('[data-toolbar-action="settings"]')??viewButton;
      open(draft.panel,trigger,draft.target.selectedIndex,draft.target.formulaName,draft.target.returnTo,draft);
      const restoredPanel=panel as Panel|undefined;if(!restoredPanel?.restoreRaw?.(draft)){restoredPanel?.close(false);return'conflict';}return'restored';
    },refreshFilterAdvice(next) {
      if(destroyed)return;
      if(state&&next.result===state.result&&next.selectedIndex===state.selectedIndex&&next.readOnly===state.readOnly
        &&JSON.stringify(configurationSnapshot(next))===JSON.stringify(configurationSnapshot(state))) {
        state={...state,filterProperty:next.filterProperty,propertyType:next.propertyType};
      }
      panel?.refreshFilterAdvice?.(next);
    }, hasDraft, owns: node => !!(!destroyed && container.isConnected && panel?.node.isConnected && panel.trigger.isConnected && container.contains(panel.trigger) && panel.node.contains(node)), captureSaveAcknowledgement() { const token=panel?.failure,captured=panel;return()=>{if(!destroyed&&captured&&captured===panel&&token&&captured.failure===token&&!captured.saving)captured.acknowledgeAcceptedSave?.();}; },
    dismissCleanPanel() { if (hasDraft()) throw new Error('Apply or cancel the toolbar changes before changing context.'); panel?.close(false); },
    destroy() { destroyed = true; if (panel) { panel.saving = false; panel.close(false); } container.replaceChildren(); },
  };
}
