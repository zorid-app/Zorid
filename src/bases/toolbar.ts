import { BaseDocument } from './document.ts';
import type { BaseValue, BaseViewConfig, BaseViewPatch } from './document.ts';
import type { BaseQueryResult } from './query.ts';
import { normalizeBaseProperty } from './query.ts';
import { icon } from '../ui/icons.ts';
import { filterConditionValues, validateToolbarPatch } from './toolbar-config.ts';
import type { BaseFilterCondition, BaseFilterOperator } from './toolbar-config.ts';
import { createBaseFilterDraft, newBaseFilterCondition, newBaseFilterGroup, readBaseFilterDraft, updateBaseFilterCondition, updateBaseFilterExpression, captureBaseFilterAcknowledgement, baseFilterCount } from './toolbar-filter.ts';
import type { BaseFilterNode, BaseFilterDraftNode, BaseFilterDraftCondition, BaseFilterConjunction } from './toolbar-filter.ts';
import type { BaseFilterOperandsSnapshot } from './toolbar-filter-operands.ts';
import {baseFilterOperators,baseFilterProperty,baseFilterMethod} from './toolbar-filter-types.ts';
import type {BaseFilterPropertyDescriptor,BaseFilterLiteral,BaseFilterOperatorDescriptor} from './toolbar-filter-types.ts';
export type {BaseFilterPropertyDescriptor} from './toolbar-filter-types.ts';
import {createBaseFilterValues} from './toolbar-filter-values.ts';
import type {BaseFilterValues} from './toolbar-filter-values.ts';
export type { BaseFilterOperandsSnapshot } from './toolbar-filter-operands.ts';
import { enhanceBaseFormulaEditor } from './toolbar-formula-editor.ts';
import { createBaseCombobox } from './toolbar-combobox.ts';
import { createBaseManualGroups } from './toolbar-groups.ts';
import { BASE_LAYOUTS, layoutIcon, uniqueViewName, validateViewName, createLayoutSettings, propertyDisplayPatch } from './toolbar-panels.ts';

export interface BaseToolbarState {
  result: BaseQueryResult;
  views: readonly BaseViewConfig[];
  selectedIndex: number;
  rootFilters?: BaseValue;
  root?: Readonly<Record<string, BaseValue>>;
  search?: string;
  propertyType?(property: string): string | undefined;
  filterProperty?(property: string): BaseFilterPropertyDescriptor | undefined;
  functionNames?: readonly string[];
  methodNames?: readonly string[];
  readOnly: boolean;
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
  preflight(): void;
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
  /** Read-only suggestions; their metadata status never changes filter meaning. */
  filterOperands?(): BaseFilterOperandsSnapshot;
  onDraftChange(): void;
  onError(error: unknown): void;
}
export interface BaseToolbar {
  update(state: BaseToolbarState): void;
  hasDraft(): boolean;
  /** Only this live toolbar's current connected portal, including its child controls. */
  owns(node: Node): boolean;
  captureSaveAcknowledgement(): () => void;
  destroy(): void;
}
type FilterNode = BaseFilterNode;
type PanelName = 'Views' | 'View options' | 'Add view' | 'Results' | 'Property' | 'Formula' | 'New item settings' | 'Filter' | 'Sort' | 'Properties' | 'Group';
interface Panel { rebase?(state: BaseToolbarState, expectedName?: string): boolean; refreshFilterAdvice?(state:BaseToolbarState):void; flush?(): void; name: PanelName; node: HTMLElement; trigger: HTMLElement; dirty: boolean; innerDraft?: boolean; saving: boolean; failure?: object; acceptsSaveAcknowledgement?: () => boolean; close(restore?: boolean): void }
/** Only a retained, exact accepted configuration may offer a persistence retry. */
export class BaseToolbarSaveError extends Error {
  readonly retry: () => Promise<void>;
  constructor(message: string, retry: () => Promise<void>) { super(message); this.retry = retry; }
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
  const next = structuredClone(snapshot);
  const merge = (target:Record<string,BaseValue|undefined>, values:Record<string,BaseValue|undefined>) => { for (const [key,value] of Object.entries(values)) { if (value === undefined) delete target[key]; else target[key] = structuredClone(value); } };
  if (patch.view) merge(next.views[index] as BaseViewPatch,patch.view);
  if (patch.root) merge(next.root,patch.root);
  return next;
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
  viewWrap.append(viewButton, selector);
  const count = button(doc, '', () => open('Results', count), 'Results'); count.className = 'bases-toolbar-action bases-toolbar-count'; count.setAttribute('aria-live', 'polite'); count.setAttribute('aria-haspopup', 'dialog');
  const actions = doc.createElement('div'); actions.className = 'bases-toolbar-actions';
  container.append(viewWrap, count, actions);
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
  const hasDraft = () => !!panel && (panel.dirty || panel.innerDraft || panel.saving || !!panel.failure);
  selector.addEventListener('change', () => {
    if (!state) return; const index = Number(selector.value), previous = state.selectedIndex;
    try {
      options.preflight(); if (hasDraft()) throw new Error('Apply or cancel the toolbar changes before switching views.');
      panel?.close(false);
      void options.selectView(index).catch(error => { if (!destroyed) { selector.value = String(previous); report(error); } });
    } catch (error) { selector.value = String(previous); report(error); }
  });
  function open(name: PanelName, trigger: HTMLElement, targetIndex?: number, formulaName?: string) {
    if (!state || destroyed || state.readOnly && !['Views', 'Results'].includes(name)) return;
    try { options.preflight(); if (hasDraft()) throw new Error('Apply or cancel the current toolbar changes first.'); } catch (error) { report(error); return; }
    if (panel?.name === name) { panel.close(); return; }
    panel?.close(false);
    let opening = state, result = opening.result;
    let version = result.version;
    let configuration = configurationSnapshot(opening);
    let expectedPatch: {view?:BaseViewPatch;root?:Record<string,BaseValue|undefined>} | undefined;
    let expectedSnapshot: ReturnType<typeof configurationSnapshot> | undefined;
    const selectedIndex = targetIndex ?? opening.selectedIndex;
    let configuredView = opening.views[selectedIndex] ?? result.view;
    const node = doc.createElement('section'); node.className = 'bases-toolbar-popover'; node.dataset.panel = name; node.classList.toggle('is-immediate',!!options.immediate); node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', name);
    const heading = doc.createElement('h3'); heading.textContent = name === 'View options' || name === 'Add view' ? 'Configure view' : name === 'Sort' ? 'Sort by' : name === 'Group' ? 'Group by' : name; if (['Views','Results','Properties','Filter'].includes(name)) heading.hidden = true;
    if (name === 'View options' || name === 'Add view' || name === 'Formula' || name === 'Property' || name === 'New item settings') {
      const back = button(doc, '', () => { if (hasDraft()) { if (options.immediate) panel?.flush?.(); else report(new Error('Apply or cancel the current changes first.')); return; } panel?.close(false); open(name === 'Formula' || name === 'Property' ? 'Properties' : 'Views',trigger); }, 'Back'); back.className = 'bases-toolbar-menu-next'; back.append(icon('chevron-left',16,doc)); heading.prepend(back);
    }
    const form = doc.createElement('form'), fields = doc.createElement('div'), footer = doc.createElement('div'), error = doc.createElement('div');
    fields.className = 'bases-toolbar-fields'; footer.className = 'bases-toolbar-footer'; error.className = 'bases-toolbar-error'; error.setAttribute('role', 'alert');
    const apply = doc.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply'; apply.className = 'mod-cta';
    const cancel = button(doc, 'Cancel', () => { if (!own.saving) own.close(); }); footer.append(cancel, apply); form.append(fields, error, footer); node.append(heading, form); doc.body.append(node);
    let autoTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let afterSave: (() => void) | undefined;
    let refreshPanel: ((result:BaseQueryResult,retainDraft:boolean)=>void) | undefined;
    let enhanceControls: (()=>void) | undefined;
    const focusVisible = (root:HTMLElement,label:string,fallback?:HTMLElement) => {
      // Rebuilt native selects are about to become hidden models. Enhance them
      // before restoring focus so the visible combobox owns subsequent keys.
      enhanceControls?.();
      const controls=Array.from(root.querySelectorAll<HTMLElement>('input,select,textarea,button,[contenteditable=true]')).filter(control=>!control.hidden&&!control.closest('[hidden],[aria-hidden=true]')&&!(control as HTMLButtonElement).disabled);
      (controls.find(control=>control.getAttribute('aria-label')===label)??controls[0]??fallback)?.focus();
    };
    const disposers: (()=>void)[] = [];
    const autoAdd = options.immediate === true && name === 'Add view';
    const auto = options.immediate === true && !['Views','Add view','New item settings'].includes(name) && (name !== 'Formula' || !!formulaName);
    if (auto || autoAdd) footer.hidden = true;
    const own: Panel = { name, node, trigger, dirty: false, saving: false, failure: undefined,
      close(restore = true) {
        if (own.saving) return;
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
    let retryPersistence: (() => Promise<void>) | undefined;
    type Control = HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
    type AcceptedAttempt = {generation:number;configuration?:ReturnType<typeof configurationSnapshot>;viewName:string;inputs:Map<Control,boolean>;acknowledge?:()=>void};
    let retainedAttempt: AcceptedAttempt | undefined;
    const inputStates = () => new Map(Array.from(node.querySelectorAll<Control>('input,button,select,textarea'),input=>[input,input.disabled] as const));
    const place = () => { if (!node.isConnected) return; const anchor = trigger.getBoundingClientRect(), bounds = node.getBoundingClientRect(); node.style.left = `${Math.max(8, Math.min(anchor.left, (win?.innerWidth ?? 800) - bounds.width - 8))}px`; node.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, (win?.innerHeight ?? 600) - bounds.height - 8))}px`; };
    const outside = (event: Event) => { if (!node.contains(event.target as Node) && !trigger.contains(event.target as Node)) {
      if ((auto || autoAdd) && own.dirty && !retryPersistence) { submit(true); return; }
      if (!hasDraft()) own.close(false);
    } };
    const keydown = (event: KeyboardEvent) => { const target = event.target as Element; if (event.defaultPrevented || target.closest?.('.bases-filter-operand')?.querySelector('[role=combobox][aria-expanded=true]') || target.closest?.('.bases-toolbar-combobox-popover,.bases-manual-group-new,.bases-formula-editor') || target.closest?.('[role=combobox]') && (event.key !== 'Escape' || target.closest('[role=combobox]')?.getAttribute('aria-expanded') === 'true')) return; if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !event.isComposing && (event.target instanceof doc.defaultView!.HTMLButtonElement || event.target === node)) { const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(item => !item.closest('[hidden]')); if (buttons.length) { const index = buttons.indexOf(doc.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length; buttons[next].focus(); event.preventDefault(); event.stopPropagation(); } } if (event.key === 'Escape' && !event.isComposing && !own.saving && node.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); if ((auto || autoAdd) && own.dirty && !retryPersistence) submit(true); else own.close(); } };
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', keydown, true); win?.addEventListener('resize', place); win?.addEventListener('scroll', place, true);
    const observer = win && 'ResizeObserver' in win ? new win.ResizeObserver(place) : undefined; observer?.observe(container); observer?.observe(node);
    const changed = () => {
      if (destroyed || panel !== own) return;
      generation++; own.dirty = true;
      // A failed accepted write must be retried before another semantic action.
      if (retryPersistence) return;
      own.failure = undefined; error.textContent = ''; apply.textContent = name === 'Add view' ? 'Create view' : 'Apply'; options.onDraftChange(); place();
      if (auto && !((name === 'View options' && doc.activeElement?.getAttribute('aria-label') === 'View name') || (name === 'Formula' && doc.activeElement?.getAttribute('aria-label') === 'Formula name'))) { if (autoTimer) clearTimeout(autoTimer); autoTimer = setTimeout(() => { autoTimer = undefined; submit(false); }, 250); }
    };
    const properties = [...new Set([...(Array.isArray(result.view.order) ? result.view.order.filter((value): value is string => typeof value === 'string').map(normalizeBaseProperty) : []), ...result.properties, ...result.availableProperties])];
    const propertyOptions = properties.map(property => [property, opening.label(property)] as const);
    const availableOptions = result.availableProperties.map(property => [property, opening.label(property)] as const);
    let readPatch: () => BaseViewPatch = () => ({});
    let readOperation: (() => () => Promise<void>) | undefined;
    const menuAction = (text: string, action: () => Promise<void>, enabled = true) => {
      const item = button(doc, text, () => {
        if (destroyed || panel !== own || !item.isConnected) return;
        if (own.saving || own.dirty) { error.textContent = 'Finish the current changes first.'; return; }
        try { options.preflight(); } catch (failure) { report(failure); return; }
        const commandGeneration = generation, commandInputs = inputStates();
        own.saving = true; options.onDraftChange(); for (const input of commandInputs.keys()) input.disabled = true; item.disabled = true;
        void invoke(action).then(() => {
          if (destroyed || panel !== own) return;
          own.saving = false;
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
            own.failure = {}; own.acceptsSaveAcknowledgement = () => generation === commandGeneration; own.dirty = true; retryPersistence = failure.retry;
            retainedAttempt = {generation:commandGeneration,viewName:configuredView.name,inputs:commandInputs};
            footer.hidden = false; apply.disabled = cancel.disabled = false; apply.textContent = 'Retry save';
          } else for(const [input,disabled] of commandInputs) input.disabled=disabled;
          report(failure); options.onDraftChange();
        });
      }); item.className = 'bases-toolbar-menu-item'; item.disabled = !enabled; fields.append(item); return item;
    };
    if (name === 'Views') {
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
      if (!opening.readOnly && options.commands?.addView) menuAction('Add view', async () => { own.saving = false; own.close(false); open('Add view', trigger); });
    } else if (name === 'Add view') {
      const input = doc.createElement('input'); input.value = uniqueViewName(opening.views); input.setAttribute('aria-label', 'View name'); input.placeholder = 'View name';
      const layout = select(doc, 'Layout', BASE_LAYOUTS.map(([key, label]) => [key, label] as const), 'table');
      const layoutLabel = doc.createElement('label'); layoutLabel.textContent = 'Layout'; layoutLabel.append(layout); fields.append(input, layoutLabel);
      const layoutFields = doc.createElement('div'); layoutFields.className = 'bases-layout-settings'; fields.append(layoutFields);
      let initial: BaseViewPatch = {};
      let layoutPatch = createLayoutSettings(doc,layoutFields,{type:'table',name:input.value},propertyOptions,changed);
      input.addEventListener('input', changed);
      layout.addEventListener('change', () => {
        initial = {...initial,...layoutPatch()};
        layoutFields.replaceChildren();
        layoutPatch = createLayoutSettings(doc,layoutFields,{...initial,type:layout.value,name:input.value},propertyOptions,changed);
        changed();
      });
      apply.textContent = 'Create view'; own.dirty = true;
      readOperation = () => {
        const name = validateViewName(opening.views,input.value), type = layout.value;
        const patch = validateToolbarPatch(result,{...initial,...layoutPatch()});
        if (!options.commands?.addView) throw new Error('View creation is unavailable.');
        return () => options.commands!.addView!(version,type,name,patch);
      };
      if (autoAdd) {
        input.addEventListener('blur',event=>{ if (event.relatedTarget && node.contains(event.relatedTarget as Node)) return; if (own.dirty) submit(false); });
        input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();input.blur();}});
      }
    } else if (name === 'Results') {
      const limit = doc.createElement('input'); limit.type = 'number'; limit.min = '0'; limit.step = '1'; limit.placeholder = 'e.g. 10'; limit.value = typeof result.view.limit === 'number' && result.view.limit > 0 ? String(result.view.limit) : ''; limit.setAttribute('aria-label', 'Limit'); const label = doc.createElement('label'); label.append(doc.createTextNode('Limit number of results'), limit); fields.append(label); limit.addEventListener('input', changed);
      if (!opening.readOnly) { const showAll = menuAction('Show all results', () => options.save(version, {limit: undefined}),typeof result.view.limit === 'number' && result.view.limit > 0); showAll.replaceChildren(icon('rotate-ccw',16,doc),doc.createTextNode('Show all')); }
      limit.disabled = opening.readOnly;
      if (options.onExport) { menuAction('Copy', () => options.onExport!('tsv', true)).replaceChildren(icon('copy',16,doc),doc.createTextNode('Copy to clipboard')); menuAction('Export CSV', () => options.onExport!('csv', false)).replaceChildren(icon('file-down',16,doc),doc.createTextNode('Export CSV…')); }
      readPatch = () => { if (limit.value && (!Number.isSafeInteger(Number(limit.value)) || Number(limit.value) < 0)) throw new Error('Limit must be a nonnegative whole number.'); return {limit: limit.value && Number(limit.value) > 0 ? Number(limit.value) : undefined}; };
    } else if (name === 'Property') {
      const property = formulaName!;
      const display = doc.createElement('input'); display.value = opening.label(property); display.setAttribute('aria-label','Display name'); display.placeholder = property.slice(property.indexOf('.') + 1);
      const label = doc.createElement('label'); label.append(doc.createTextNode('Display name'),display); fields.append(label); display.addEventListener('input',changed);
      readOperation = () => { const root = propertyDisplayPatch(opening.root,new Map([[property,display.value]])); if (!options.commands?.updateRoot) throw new Error('Property labels are unavailable.'); expectedPatch = {root}; return () => options.commands!.updateRoot!(version,root); };
      if (property.startsWith('formula.')) menuAction('Edit formula',async () => { own.saving = false; own.close(false); open('Formula',trigger,undefined,property.slice(8)); });
      else if (property.startsWith('note.') && options.onPropertySettings) menuAction('Property type',async () => { own.saving = false; own.close(false); options.onPropertySettings!(property); });
    } else if (name === 'Formula') {
      const names = mapping(opening.root?.formulas) ? opening.root!.formulas as Record<string, BaseValue> : {};
      const input = doc.createElement('input'); input.placeholder = 'Formula name'; input.setAttribute('aria-label', 'Formula name'); input.value = formulaName ?? '';
      const expression = doc.createElement('textarea'); expression.setAttribute('aria-label', 'Formula expression'); expression.placeholder = 'Enter a formula…'; const initialExpression = formulaName ? names[formulaName] : undefined; expression.value = typeof initialExpression === 'string' ? initialExpression : ''; expression.rows = 5;
      fields.append(input, expression); input.addEventListener('input', changed); expression.addEventListener('input', changed);
      input.addEventListener('blur',()=>{if(auto&&own.dirty)submit(false);});
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();input.blur();}});
      // Use the same document transformation to project the exact acknowledgement witness.
      readOperation = () => {
        const name = input.value.trim(), source = expression.value;
        const currentNames = mapping(opening.root?.formulas) ? opening.root!.formulas as Record<string,BaseValue> : {};
        if (!name) throw new Error('Formula name must not be empty.');
        if (name !== formulaName && Object.hasOwn(currentNames,name)) throw new Error('A formula with that name already exists.');
        if (!source.trim() && !auto) throw new Error('Formula expression must not be empty.');
        if (options.commands?.editFormula) {
          const projected = BaseDocument.parse(JSON.stringify({...opening.root,views:opening.views}));
          if (formulaName && formulaName !== name) projected.renameFormula(formulaName,name);
          projected.setFormula(name,source);
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
    } else if (name === 'New item settings') {
      const folder = doc.createElement('input'), template = doc.createElement('input'); folder.setAttribute('aria-label', 'New item folder'); template.setAttribute('aria-label', 'New item template'); folder.value = typeof opening.root?.newItemFolder === 'string' ? opening.root.newItemFolder : ''; template.value = typeof opening.root?.newItemTemplate === 'string' ? opening.root.newItemTemplate : '';
      for (const [text, input] of [['Folder',folder], ['Template',template]] as const) { const label = doc.createElement('label'); label.append(doc.createTextNode(text), input); fields.append(label); input.addEventListener('input', changed); }
      const hint = doc.createElement('p'); hint.textContent = 'Zorid copies the complete template, including its body. Placeholders stay literal.'; fields.append(hint);
      readOperation = () => { if (!options.commands?.updateRoot) throw new Error('Creation settings are unavailable.'); return () => options.commands!.updateRoot!(version, {newItemFolder:folder.value.trim() || undefined,newItemTemplate:template.value.trim() || undefined}); };
    } else if (name === 'View options') {
      const layout = select(doc, 'Layout', BASE_LAYOUTS.map(([key, label]) => [key, label] as const), configuredView.type);
      const layoutLabel = doc.createElement('label'); layoutLabel.textContent = 'Layout'; layoutLabel.append(layout); fields.append(layoutLabel); layout.addEventListener('change', changed);
      const nameInput = doc.createElement('input'); nameInput.setAttribute('aria-label', 'View name'); nameInput.value = configuredView.name;
      if (opening.allowRename) { const nameLabel = doc.createElement('label'); nameLabel.textContent = options.immediate ? '' : 'Name'; nameLabel.append(nameInput); fields.prepend(nameLabel); nameInput.addEventListener('input', changed); }
      nameInput.addEventListener('blur', () => { if (auto && own.dirty) submit(false); });
      nameInput.addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); nameInput.blur(); } });
      const layoutFields = doc.createElement('div'); layoutFields.className = 'bases-layout-settings'; fields.append(layoutFields);
      let layoutPatch = createLayoutSettings(doc, layoutFields, configuredView, propertyOptions, changed);
      layout.addEventListener('change', () => { layoutFields.replaceChildren(); layoutPatch = createLayoutSettings(doc, layoutFields, {...configuredView, type:layout.value}, propertyOptions, changed); });
      readPatch = () => {
        if (selectedIndex !== opening.selectedIndex && !options.commands?.updateView) throw new Error('Open this view before changing its settings.');
        const patch: BaseViewPatch = { type: layout.value, ...layoutPatch() };
        if (opening.allowRename && nameInput.value.trim() !== configuredView.name) {
          patch.name = validateViewName(opening.views, nameInput.value, selectedIndex);
        }
        return patch;
      };
      if (options.commands?.updateView) readOperation = () => { const patch = validateToolbarPatch({...result,view:configuredView},readPatch()); expectedPatch = {view:patch}; return () => options.commands!.updateView!(version,selectedIndex,patch); };
      if (selectedIndex !== opening.selectedIndex && !options.commands?.updateView) { nameInput.disabled = true; layout.disabled = true; for (const input of layoutFields.querySelectorAll<HTMLInputElement>('input,select')) input.disabled = true; menuAction('Open this view', () => options.selectView(selectedIndex)); }
      if (options.commands?.setDefaultView) menuAction('Set as default view', () => options.commands!.setDefaultView!(version, selectedIndex), selectedIndex !== 0);
      if (options.commands?.duplicateView) menuAction('Duplicate view', async () => {
        const duplicateName = uniqueViewName(opening.views, configuredView.name);
        await options.commands!.duplicateView!(version,selectedIndex,duplicateName);
        const refreshed = deferredState; deferredState = undefined;
        if (!options.immediate || !refreshed) return;
        own.saving = false; own.close(false); update(refreshed);
        const index = refreshed.views.findIndex(view=>view.name===duplicateName);
        if (index >= 0) { open('View options',trigger,index); const input = panel?.node.querySelector<HTMLInputElement>('[aria-label="View name"]'); input?.select(); }
      });
      if (options.commands?.moveView) { menuAction('Move view earlier', () => options.commands!.moveView!(version, selectedIndex, selectedIndex - 1), selectedIndex > 0); menuAction('Move view later', () => options.commands!.moveView!(version, selectedIndex, selectedIndex + 1), selectedIndex < opening.views.length - 1); }
      if (options.commands?.removeView) menuAction('Delete view', () => options.commands!.removeView!(version, selectedIndex), opening.views.length > 1).classList.add('mod-destructive');
      if (options.commands?.updateRoot) menuAction('New item settings', async () => { own.saving = false; own.close(false); open('New item settings', trigger); });
      if (options.immediate) {
        const actions = doc.createElement('div'); actions.className = 'bases-view-actions'; actions.hidden = true;
        for (const item of Array.from(fields.querySelectorAll(':scope > .bases-toolbar-menu-item'))) actions.append(item);
        fields.append(actions);
        const more = button(doc, '', () => { actions.hidden = !actions.hidden; more.setAttribute('aria-expanded', String(!actions.hidden)); place(); }, 'View actions');
        more.className = 'bases-toolbar-menu-next'; more.append(icon('ellipsis-vertical',16,doc)); heading.append(more); const close = button(doc,'',() => { if (own.dirty) submit(true); else own.close(); },'Close menu'); close.className = 'bases-toolbar-menu-next'; close.append(icon('close',16,doc)); heading.append(close);
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
        const formulas = mapping(opening.root?.formulas) ? opening.root!.formulas as Record<string,BaseValue> : {};
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
      readOperation = () => { const view = validateToolbarPatch(result, {order}); if (!displayNames.size) { expectedPatch = {view}; return () => options.save(version, view); } if (!options.saveConfiguration) throw new Error('Combined property configuration is unavailable.'); const root = propertyDisplayPatch(opening.root, displayNames); expectedPatch = {view,root}; return () => options.saveConfiguration!(version, {view,root}); };
    } else if (name === 'Sort') {
      let sortDrag: {item:BaseValue;source:HTMLElement;token:string;version:BaseQueryResult['version']} | undefined;
      const sort = Array.isArray(result.view.sort) ? structuredClone(result.view.sort) as BaseValue[] : [];
      const list = doc.createElement('div'); fields.append(list);
      const render = () => {
        const focusedLabel = list.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : undefined;
        sortDrag = undefined; list.replaceChildren(); sort.forEach((value, index) => {
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
            const property = select(doc, 'Sort property', choices, currentProperty), direction = select(doc, 'Sort direction', [['ASC', 'A → Z'], ['DESC', 'Z → A']], String(value.direction));
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
      type Section={section:HTMLElement;refreshBlankAdvice():void;get():FilterNode|undefined;acknowledge():()=>void};
      let rootEditor:Section|undefined,viewEditor:Section|undefined;
      own.refreshFilterAdvice=next=>{
        if(own.saving||own.failure||next.readOnly!==opening.readOnly||next.selectedIndex!==opening.selectedIndex
          ||next.views[selectedIndex]?.name!==configuredView.name||next.views[selectedIndex]?.type!==configuredView.type
          ||JSON.stringify(configurationSnapshot(next))!==JSON.stringify(configuration))return;
        filterAdvice=next;
        if(compositions.size||pressedPointers.size||releasedPointers.size||node.querySelector('[role="combobox"][aria-expanded="true"],[role="listbox"],.cm-tooltip-autocomplete'))return;
        rootEditor?.refreshBlankAdvice();viewEditor?.refreshBlankAdvice();
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
        const localEditors=new Set<BaseFilterValues>(),validators=new Set<()=>void>(),rendered=new WeakMap<BaseFilterDraftNode,HTMLElement>();
        const refreshBlankAdvice=new Set<()=>void>();
        let tree:HTMLElement,renderBudget=1000;
        const release=()=>{for(const editor of localEditors){editor.destroy();operandEditors.delete(editor);}localEditors.clear();validators.clear();refreshBlankAdvice.clear();syncDraft();};
        const focusNode=(value:BaseFilterDraftNode)=>{const row=rendered.get(value);if(row)focusVisible(row,'Filter property');};
        const renderNode=(value:BaseFilterDraftNode,remove:()=>void,depth=0):HTMLElement=>{
          const row=doc.createElement('div');row.className=value.kind==='condition'?'bases-filter-condition':'bases-filter-group';rendered.set(value,row);
          if(--renderBudget<0||depth>32){row.append(doc.createTextNode('This filter exceeds the visual editor’s size or nesting limit.'));return row;}
          const live=()=>alive()&&row.isConnected&&tree.contains(row);
          if(value.kind==='condition'){
            const removeButton=button(doc,'Remove',()=>{if(!live()||!canRestructure(row))return;remove();render();semanticChanged();focusVisible(tree,'Match');},'Remove filter');
            if(options.immediate){removeButton.replaceChildren(icon('trash',16,doc));removeButton.className='bases-toolbar-menu-next';}
            if(value.advanced||!value.fields){
              const expression=doc.createElement('textarea');expression.setAttribute('aria-label','Filter expression');expression.value=value.source??'';expression.rows=2;
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
                const expression=doc.createElement('textarea');expression.setAttribute('aria-label','Filter expression');expression.value=value.source??'';expression.rows=2;
                expression.addEventListener('input',()=>{if(live()){updateBaseFilterExpression(value,expression.value);semanticChanged();}});row.append(expression,removeButton);return row;
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
              const operator=select(doc,'Condition',catalog.map(item=>[item.id,item.label] as const),fields.operator);row.append(property,operator);
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
              editor=createBaseFilterValues(doc,host,{operator:selected,property:descriptor,values:initialValues,snapshot:operandSnapshot,alive:live,
                onChange(){const current=editor.read();publish(fromValues(value.fields!,current.values),{error:current.error,incomplete:missing(selected!,current.values)});},
                onDraftChange(){syncDraft();validate();semanticChanged();},
              });
              localEditors.add(editor);operandEditors.add(editor);validators.add(validate);
              const refreshBlank=()=>{
                const field=primary(),focused=doc.activeElement;
                if(!live()||descriptor.kind!=='unknown'||value.fields!==fields||value.source!==undefined||value.advanced
                  ||fields.text!==''||fields.arguments!==undefined||fields.values!==undefined||Object.hasOwn(fields,'operand')
                  ||editor.hasDraft()||!field||field.value!==''||field.validity.badInput
                  ||host.contains(focused)||row.querySelector('[aria-expanded="true"],[role="listbox"]'))return;
                const supplied=filterAdvice.filterProperty?.(fields.property);
                if(!supplied||supplied.kind==='unknown')return;
                const label=focused instanceof doc.defaultView!.HTMLElement&&row.contains(focused)?focused.getAttribute('aria-label'):undefined;
                editor.destroy();localEditors.delete(editor);operandEditors.delete(editor);validators.delete(validate);refreshBlankAdvice.delete(refreshBlank);
                const budget=renderBudget;renderBudget=1;const replacement=renderNode(value,remove,depth);renderBudget=budget;row.replaceWith(replacement);
                if(label)focusVisible(replacement,label);syncDraft();place();
              };
              refreshBlankAdvice.add(refreshBlank);
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
            const mode=select(doc,'Match',[['and','All the following are true'],['or','Any of the following are true'],['not','None of the following are true']],value.conjunction);
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
        return {section,refreshBlankAdvice(){for(const refresh of [...refreshBlankAdvice])refresh();},get:()=>readBaseFilterDraft(draft),acknowledge(){const source=readBaseFilterDraft(draft),acknowledge=captureBaseFilterAcknowledgement(draft);return ()=>{acknowledge();count(source);for(const validate of validators)validate();};}};
      }
      rootEditor=filterSection('All views',initialRoot,false,!!options.commands?.updateRoot);
      viewEditor=filterSection('This view',initialView,true);fields.append(rootEditor.section,viewEditor.section);
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
      closeWhenSettled ||= close;
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = undefined; }
      if (own.saving || destroyed || panel !== own) return;
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
        viewName:name==='View options'?form.querySelector<HTMLInputElement>('[aria-label="View name"]')?.value.trim()||configuredView.name:configuredView.name,
        inputs:inputStates(),acknowledge:afterSave,
      };
      const submittedGeneration = attempt.generation, expectedConfiguration = attempt.configuration, expectedViewName = attempt.viewName;
      own.saving = true; options.onDraftChange();
      const disabled = inputStates();
      if (!auto) for (const input of disabled.keys()) input.disabled = true;
      error.textContent = 'Saving…';
      void invoke(operation).then(() => {
        if (destroyed || panel !== own) return;
        own.saving = false; own.failure = undefined; retryPersistence = undefined; retainedAttempt = undefined;
        if(retrying)for(const [input,wasDisabled] of attempt.inputs) input.disabled=wasDisabled;
        own.dirty = generation !== submittedGeneration;
        if (!expectedConfiguration && own.dirty) {
          own.failure = {}; footer.hidden = false; error.textContent = 'The retained command is saved. Your newer configuration draft is still here. Cancel and reopen the updated view before continuing.'; options.onDraftChange(); return;
        }
        if (!auto) {
          if(own.dirty){footer.hidden=false;error.textContent='The retained draft is saved. Your newer changes are still here.';options.onDraftChange();return;}
          own.dirty = false; const refreshed = deferredState; deferredState = undefined; own.close(); if (refreshed) update(refreshed);
          if (autoAdd && !closeWhenSettled && refreshed) { const name = form.querySelector<HTMLInputElement>('[aria-label="View name"]')?.value.trim(); const index = refreshed.views.findIndex(view=>view.name===name); if (index>=0) open('View options',trigger,index); }
          return;
        }
        if (deferredState) {
          const refreshed = deferredState; deferredState = undefined;
          if(expectedConfiguration)configuration = expectedConfiguration;
          if (!own.rebase?.(refreshed,expectedViewName)) {
            if (!own.dirty) { own.close(); update(refreshed); return; }
            own.failure = {}; footer.hidden = false; error.textContent = 'This view changed or moved while saving. Your queued changes are still here. Cancel and reopen the view before continuing.'; options.onDraftChange(); return;
          }
          state = refreshed;
        }
        error.textContent = ''; footer.hidden = true; attempt.acknowledge?.(); options.onDraftChange();
        if (own.dirty) submit(closeWhenSettled);
        else if (closeWhenSettled) own.close();
      }, failure => {
        if (destroyed || panel !== own) return; own.saving = false; own.dirty = true;
        if(autoTimer){clearTimeout(autoTimer);autoTimer=undefined;}
        if (failure instanceof BaseToolbarSaveError) {retryPersistence = failure.retry;retainedAttempt??=attempt;}
        if (retryPersistence) {
          own.failure ??= {}; own.acceptsSaveAcknowledgement = () => generation === submittedGeneration;
          error.textContent = `Could not save: ${failure instanceof Error ? failure.message : String(failure)}. Retry the retained file draft, or cancel without discarding it.`;
          footer.hidden = false; apply.disabled = false; apply.textContent = 'Retry save'; cancel.disabled = false;
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
      const enhanced = new Map<HTMLSelectElement,ReturnType<typeof createBaseCombobox>>();
      const editors = new Map<HTMLTextAreaElement,ReturnType<typeof enhanceBaseFormulaEditor>>();
      const attemptedEditors = new WeakSet<HTMLTextAreaElement>();
      const enhance = () => {
        for (const [source,editor] of editors) if (!node.contains(source)) { editor.destroy(); editors.delete(source); }
        for (const source of node.querySelectorAll<HTMLTextAreaElement>('textarea')) {
          if (attemptedEditors.has(source) || !['Formula expression','Filter expression'].includes(source.getAttribute('aria-label')??'')) continue;
          attemptedEditors.add(source); const focused = doc.activeElement === source;
          try { const editor = enhanceBaseFormulaEditor(source,{propertyIds:properties,functionNames:opening.functionNames??['if','date','duration','list','max','min','number','now','today','escapeHTML'],methodNames:opening.methodNames??['isTruthy','isEmpty','toString','isType','contains','containsAll','containsAny','endsWith','lower','replace','repeat','reverse','slice','split','startsWith','title','trim','abs','ceil','floor','round','toFixed','date','format','time','filter','flat','join','map','reduce','sort','unique','sum','mean','keys','values','matches','hasLink','asLink','hasProperty','hasTag','inFolder','relative'],onEscape:()=>submit(true)}); editors.set(source,editor); if (focused) editor.focus(); } catch (failure) { report(failure); }
        }
        for (const [source,control] of enhanced) if (!node.contains(source)) { control.destroy(); enhanced.delete(source); }
        for (const source of node.querySelectorAll<HTMLSelectElement>('select')) {
          if (enhanced.has(source) || source.getAttribute('aria-label') === 'Value type') continue;
          const label = source.getAttribute('aria-label') ?? '';
          enhanced.set(source,createBaseCombobox(source,{owner:node,searchable:/property|Layout/.test(label)}));
        }
      };
      enhanceControls=enhance;
      const observer = new win.MutationObserver(enhance); observer.observe(node,{childList:true,subtree:true}); enhance();
      disposers.push(()=>{observer.disconnect();for(const control of enhanced.values())control.destroy();enhanced.clear();for(const editor of editors.values())editor.destroy();editors.clear();});
    }
    place(); const initialFocus = Array.from(fields.querySelectorAll<HTMLElement>('input,select,textarea,button')).find(control=>!control.hidden&&!control.closest('[hidden]')); initialFocus?.focus({ preventScroll: true }); if (name === 'Add view' && initialFocus?.tagName === 'INPUT') (initialFocus as HTMLInputElement).select();
  }
  function update(next: BaseToolbarState) {
    if (destroyed) return;
    if (hasDraft()) { panel?.refreshFilterAdvice?.(next); deferredState = next; return; }
    if (panel && options.immediate) {
      if (!panel.rebase?.(next)) { panel.close(false); update(next); return; }
      state = next;
      viewButton.replaceChildren(icon(layoutIcon(next.result.view.type),16,doc),doc.createTextNode(next.result.view.name),icon('chevrons-up-down',14,doc));
      count.replaceChildren(doc.createTextNode(`${next.result.counts.returned} results`));
      return;
    }
    const focusedLabel = actions.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : panel?.node.contains(doc.activeElement) ? panel.trigger.getAttribute('aria-label') : undefined;
    panel?.close(false);
    state = next;
    selector.replaceChildren(...next.views.map((view, index) => { const option = doc.createElement('option'); option.value = String(index); option.textContent = view.name; return option; })); selector.value = String(next.selectedIndex);
    viewButton.replaceChildren(icon(layoutIcon(next.result.view.type),16,doc),doc.createTextNode(next.result.view.name),icon('chevrons-up-down',14,doc));
    count.replaceChildren(icon('text-align-start',16,doc),doc.createTextNode(`${next.result.counts.returned} ${next.result.counts.returned === 1 ? 'result' : 'results'}`));
    searchCount.textContent = searchInput.value ? `${next.result.counts.returned} results` : '';
    actions.replaceChildren();
    if (!next.readOnly) for (const [name, glyph] of [['Sort','arrow-up-down'],['Group','stretch-horizontal'],['Filter','list-filter'],['Properties','list']] as const) {
      const node = button(doc, '', () => open(name, node), name); node.className = 'bases-toolbar-action'; node.title = name; node.setAttribute('aria-haspopup','dialog');
      const label = doc.createElement('span'); label.className = 'bases-toolbar-label'; label.textContent = name;
      node.append(icon(glyph,16,doc),label);
      if (name === 'Filter' && next.result.view.filters !== undefined || name === 'Sort' && Array.isArray(next.result.view.sort) && next.result.view.sort.length || name === 'Group' && next.result.view.groupBy !== undefined) node.classList.add('is-active');
      actions.append(node);
    }
    if (options.onSearch) { const node = button(doc, '', () => { if (!searchRow.hidden) { closeSearch(); return; } searchRow.hidden = false; searchInput.value = state?.search ?? ''; node.classList.add('is-active'); searchInput.focus(); searchInput.select(); }, 'Search'); node.className = 'bases-toolbar-action'; node.append(icon('search',16,doc),doc.createTextNode('Search')); node.classList.toggle('is-active',!searchRow.hidden); actions.append(node); }
    if (!next.readOnly && options.onNew) { const node = button(doc, '', () => { try { options.preflight(); if (hasDraft()) throw new Error('Finish the current changes first.'); node.disabled = true; void options.onNew!().catch(report).finally(() => { if (!destroyed) node.disabled = false; }); } catch (error) { report(error); } }, 'New'); node.className = 'bases-toolbar-action bases-toolbar-new'; node.append(icon('plus',16,doc),doc.createTextNode('New')); actions.append(node); }
    // Existing integrations can open the same configuration from its current view menu.
    if (!next.readOnly && !options.commands) { const node = button(doc, 'View', () => open('View options',node), 'View options'); node.className = 'bases-toolbar-action'; actions.append(node); }
    if (focusedLabel) Array.from(actions.querySelectorAll<HTMLButtonElement>('button')).find(node => node.getAttribute('aria-label') === focusedLabel)?.focus({ preventScroll: true });
  }
  return { update, hasDraft, owns: node => !!(!destroyed && container.isConnected && panel?.node.isConnected && panel.trigger.isConnected && container.contains(panel.trigger) && panel.node.contains(node)), captureSaveAcknowledgement() { const token = panel?.failure, captured = panel; return () => { if (!destroyed && captured && captured === panel && token && captured.failure === token && !captured.saving && captured.acceptsSaveAcknowledgement?.()) { captured.failure = undefined; captured.dirty = false; captured.close(false); } }; },
    destroy() { destroyed = true; if (panel) { panel.saving = false; panel.close(false); } container.replaceChildren(); },
  };
}
