import type { BaseValue, BaseViewConfig, BaseViewPatch } from './document.ts';
import type { BaseQueryResult } from './query.ts';
import { normalizeBaseProperty } from './query.ts';
import { icon } from '../ui/icons.ts';
import { buildFilterCondition, validateToolbarPatch } from './toolbar-config.ts';
import { BASE_LAYOUTS, layoutIcon, uniqueViewName, validateViewName, createLayoutSettings, propertyDisplayPatch } from './toolbar-panels.ts';

export interface BaseToolbarState {
  result: BaseQueryResult;
  views: readonly BaseViewConfig[];
  selectedIndex: number;
  rootFilters?: BaseValue;
  root?: Readonly<Record<string, BaseValue>>;
  search?: string;
  readOnly: boolean;
  allowRename: boolean;
  label(property: string): string;
}
export type BaseToolbarExportFormat = 'csv' | 'tsv' | 'markdown' | 'paths';
export interface BaseToolbarCommands {
  updateView?(version: BaseQueryResult['version'], index: number, patch: BaseViewPatch): Promise<void>;
  editFormula?(version: BaseQueryResult['version'], originalName: string | undefined, name: string, expression: string): Promise<void>;
  addView?(version: BaseQueryResult['version'], type: string, name?: string): Promise<void>;
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
  commands?: BaseToolbarCommands;
  saveConfiguration?(version: BaseQueryResult['version'], patch: { view?: BaseViewPatch; root?: Record<string, BaseValue | undefined> }): Promise<void>;
  onSearch?(text: string): void;
  onNew?(): Promise<void>;
  onExport?(format: BaseToolbarExportFormat, copy: boolean): Promise<void>;
  onPropertySettings?(property: string): void;
  onDraftChange(): void;
  onError(error: unknown): void;
}
export interface BaseToolbar {
  update(state: BaseToolbarState): void;
  hasDraft(): boolean;
  captureSaveAcknowledgement(): () => void;
  destroy(): void;
}
type FilterNode = string | { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode[] };
type PanelName = 'Views' | 'View options' | 'Add view' | 'Results' | 'Formula' | 'New item settings' | 'Filter' | 'Sort' | 'Properties' | 'Group';
interface Panel { name: PanelName; node: HTMLElement; trigger: HTMLElement; dirty: boolean; saving: boolean; failure?: object; close(restore?: boolean): void }
/** Only a retained, exact accepted configuration may offer a persistence retry. */
export class BaseToolbarSaveError extends Error {
  readonly retry: () => Promise<void>;
  constructor(message: string, retry: () => Promise<void>) { super(message); this.retry = retry; }
}
const mapping = (value: unknown): value is Record<string, BaseValue> => !!value && typeof value === 'object' && !Array.isArray(value);
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
  const report = (error: unknown) => { try { options.onError(error); } catch { /* Error rendering cannot mutate configuration. */ } };
  const hasDraft = () => !!panel && (panel.dirty || panel.saving || !!panel.failure);
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
    const opening = state, result = opening.result;
    const version = result.version;
    const selectedIndex = targetIndex ?? opening.selectedIndex;
    const configuredView = opening.views[selectedIndex] ?? result.view;
    const node = doc.createElement('section'); node.className = 'bases-toolbar-popover'; node.dataset.panel = name; node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', name);
    const heading = doc.createElement('h3'); heading.textContent = name === 'View options' ? 'Configure view' : name;
    const form = doc.createElement('form'), fields = doc.createElement('div'), footer = doc.createElement('div'), error = doc.createElement('div');
    fields.className = 'bases-toolbar-fields'; footer.className = 'bases-toolbar-footer'; error.className = 'bases-toolbar-error'; error.setAttribute('role', 'alert');
    const apply = doc.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply'; apply.className = 'mod-cta';
    const cancel = button(doc, 'Cancel', () => { if (!own.saving) own.close(); }); footer.append(cancel, apply); form.append(fields, error, footer); node.append(heading, form); doc.body.append(node);
    const own: Panel = { name, node, trigger, dirty: false, saving: false, failure: undefined,
      close(restore = true) {
        if (own.saving) return;
        const focusOwned = node.contains(doc.activeElement); node.remove();
        doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', keydown, true); win?.removeEventListener('resize', place); win?.removeEventListener('scroll', place, true); observer?.disconnect();
        if (panel === own) panel = undefined; trigger.setAttribute('aria-expanded', 'false');
        if (restore && focusOwned && trigger.isConnected) trigger.focus({ preventScroll: true }); options.onDraftChange();
      },
    };
    panel = own; trigger.setAttribute('aria-expanded', 'true');
    let retryPersistence: (() => Promise<void>) | undefined;
    const place = () => { if (!node.isConnected) return; const anchor = trigger.getBoundingClientRect(), bounds = node.getBoundingClientRect(); node.style.left = `${Math.max(8, Math.min(anchor.left, (win?.innerWidth ?? 800) - bounds.width - 8))}px`; node.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, (win?.innerHeight ?? 600) - bounds.height - 8))}px`; };
    const outside = (event: Event) => { if (!node.contains(event.target as Node) && !trigger.contains(event.target as Node) && !hasDraft()) own.close(false); };
    const keydown = (event: KeyboardEvent) => { if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !event.isComposing && (event.target instanceof doc.defaultView!.HTMLButtonElement || event.target === node)) { const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(item => !item.closest('[hidden]')); if (buttons.length) { const index = buttons.indexOf(doc.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length; buttons[next].focus(); event.preventDefault(); event.stopPropagation(); } } if (event.key === 'Escape' && !event.isComposing && !own.saving && node.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); own.close(); } };
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', keydown, true); win?.addEventListener('resize', place); win?.addEventListener('scroll', place, true);
    const observer = win && 'ResizeObserver' in win ? new win.ResizeObserver(place) : undefined; observer?.observe(container); observer?.observe(node);
    const changed = () => { own.dirty = true; own.failure = undefined; error.textContent = ''; apply.textContent = 'Apply'; options.onDraftChange(); place(); };
    const properties = [...new Set([...(Array.isArray(result.view.order) ? result.view.order.filter((value): value is string => typeof value === 'string').map(normalizeBaseProperty) : []), ...result.properties, ...result.availableProperties])];
    const propertyOptions = properties.map(property => [property, opening.label(property)] as const);
    const availableOptions = result.availableProperties.map(property => [property, opening.label(property)] as const);
    let readPatch: () => BaseViewPatch = () => ({});
    let readOperation: (() => () => Promise<void>) | undefined;
    const menuAction = (text: string, action: () => Promise<void>, enabled = true) => {
      const item = button(doc, text, () => {
        if (own.saving || own.dirty) { error.textContent = 'Finish the current changes first.'; return; }
        try { options.preflight(); } catch (failure) { report(failure); return; }
        own.saving = true; options.onDraftChange(); item.disabled = true;
        void action().then(() => { if (destroyed || panel !== own) return; own.saving = false; own.close(); }, failure => { if (destroyed || panel !== own) return; own.saving = false; item.disabled = false; error.textContent = failure instanceof Error ? failure.message : String(failure); if (failure instanceof BaseToolbarSaveError) { own.failure = {}; own.dirty = true; retryPersistence = failure.retry; footer.hidden = false; apply.textContent = 'Retry save'; } report(failure); options.onDraftChange(); });
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
          const choose = button(doc, '', () => { own.close(false); try { options.preflight(); void options.selectView(index).catch(report); } catch (failure) { report(failure); } }, `Open view ${view.name}`);
          choose.className = 'bases-toolbar-menu-item'; choose.append(icon(layoutIcon(view.type), 16, doc), doc.createTextNode(view.name)); choose.classList.toggle('mod-active', index === opening.selectedIndex); row.append(choose);
          if (!opening.readOnly) {
            const configure = button(doc, '', () => { own.close(false); open('View options', trigger, index); }, `Configure view ${view.name}`); configure.className = 'bases-toolbar-menu-next'; configure.append(icon('chevron-right', 14, doc)); row.append(configure);
            row.draggable = !!options.commands?.moveView;
            row.addEventListener('dragstart', event => { event.dataTransfer?.setData('application/x-zorid-base-view', String(index)); });
            row.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('application/x-zorid-base-view')) event.preventDefault(); });
            row.addEventListener('drop', event => { event.preventDefault(); const raw = event.dataTransfer?.getData('application/x-zorid-base-view'); if (!raw || !/^\d+$/.test(raw)) return; const from = Number(raw); if (from >= opening.views.length || from === index) return; own.close(false); try { options.preflight(); void options.commands?.moveView?.(version, from, index).catch(report); } catch (failure) { report(failure); } });
            choose.addEventListener('keydown', event => { if (event.key === 'ArrowRight') { event.preventDefault(); configure.click(); } });
          }
          list.append(row);
        });
      };
      search.addEventListener('input', renderViews); renderViews();
      if (!opening.readOnly && options.commands?.addView) menuAction('Add view', async () => { own.saving = false; own.close(false); open('Add view', trigger); });
    } else if (name === 'Add view') {
      const input = doc.createElement('input'); input.value = uniqueViewName(opening.views); input.setAttribute('aria-label', 'View name'); input.placeholder = 'View name';
      const layout = select(doc, 'Layout', BASE_LAYOUTS.map(([key, label]) => [key, label] as const), 'table'); fields.append(input, layout); input.addEventListener('input', changed); layout.addEventListener('change', changed); apply.textContent = 'Create view'; own.dirty = true;
      readOperation = () => { const name = validateViewName(opening.views, input.value); if (!options.commands?.addView) throw new Error('View creation is unavailable.'); return () => options.commands!.addView!(version, layout.value, name); };
    } else if (name === 'Results') {
      const limit = doc.createElement('input'); limit.type = 'number'; limit.min = '0'; limit.step = '1'; limit.placeholder = 'Show all'; limit.value = typeof result.view.limit === 'number' && result.view.limit > 0 ? String(result.view.limit) : ''; limit.setAttribute('aria-label', 'Limit'); const label = doc.createElement('label'); label.append(doc.createTextNode('Limit'), limit); fields.append(label); limit.addEventListener('input', changed);
      if (!opening.readOnly) menuAction('Show all results', () => options.save(version, {limit: undefined}));
      limit.disabled = opening.readOnly;
      if (options.onExport) { menuAction('Copy', () => options.onExport!('tsv', true)); menuAction('Export CSV', () => options.onExport!('csv', false)); }
      readPatch = () => { if (limit.value && (!Number.isSafeInteger(Number(limit.value)) || Number(limit.value) < 0)) throw new Error('Limit must be a nonnegative whole number.'); return {limit: limit.value && Number(limit.value) > 0 ? Number(limit.value) : undefined}; };
    } else if (name === 'Formula') {
      const names = mapping(opening.root?.formulas) ? opening.root!.formulas as Record<string, BaseValue> : {};
      const input = doc.createElement('input'); input.placeholder = 'Formula name'; input.setAttribute('aria-label', 'Formula name'); input.value = formulaName ?? '';
      const expression = doc.createElement('textarea'); expression.setAttribute('aria-label', 'Formula expression'); expression.placeholder = 'Enter a formula…'; expression.value = formulaName && typeof names[formulaName] === 'string' ? names[formulaName] : ''; expression.rows = 5;
      fields.append(input, expression); input.addEventListener('input', changed); expression.addEventListener('input', changed);
      // Rename and expression edit are submitted as one root patch: no partial rename.
      readOperation = () => { const name = input.value.trim(); if (!name) throw new Error('Formula name must not be empty.'); if (name !== formulaName && Object.hasOwn(names, name)) throw new Error('A formula with that name already exists.'); if (!expression.value.trim()) throw new Error('Formula expression must not be empty.'); if (options.commands?.editFormula) return () => options.commands!.editFormula!(version,formulaName,name,expression.value); if (formulaName && formulaName !== name) throw new Error('Formula rename is unavailable.'); const formulas = {...names}; if (formulaName && formulaName !== name) delete formulas[formulaName]; formulas[name] = expression.value; if (!options.commands?.updateRoot) throw new Error('Formula editing is unavailable.'); return () => options.commands!.updateRoot!(version, {formulas}); };
      if (formulaName && options.commands?.setFormula) menuAction('Remove formula', () => options.commands!.setFormula!(version, formulaName, undefined));
    } else if (name === 'New item settings') {
      const folder = doc.createElement('input'), template = doc.createElement('input'); folder.setAttribute('aria-label', 'New item folder'); template.setAttribute('aria-label', 'New item template'); folder.value = typeof opening.root?.newItemFolder === 'string' ? opening.root.newItemFolder : ''; template.value = typeof opening.root?.newItemTemplate === 'string' ? opening.root.newItemTemplate : '';
      for (const [text, input] of [['Folder',folder], ['Template',template]] as const) { const label = doc.createElement('label'); label.append(doc.createTextNode(text), input); fields.append(label); input.addEventListener('input', changed); }
      const hint = doc.createElement('p'); hint.textContent = 'Zorid copies the complete template, including its body. Placeholders stay literal.'; fields.append(hint);
      readOperation = () => { if (!options.commands?.updateRoot) throw new Error('Creation settings are unavailable.'); return () => options.commands!.updateRoot!(version, {newItemFolder:folder.value.trim() || undefined,newItemTemplate:template.value.trim() || undefined}); };
    } else if (name === 'View options') {
      const layout = select(doc, 'Layout', BASE_LAYOUTS.map(([key, label]) => [key, label] as const), configuredView.type);
      const layoutLabel = doc.createElement('label'); layoutLabel.textContent = 'Layout'; layoutLabel.append(layout); fields.append(layoutLabel); layout.addEventListener('change', changed);
      const nameInput = doc.createElement('input'); nameInput.setAttribute('aria-label', 'View name'); nameInput.value = configuredView.name;
      if (opening.allowRename) { const nameLabel = doc.createElement('label'); nameLabel.textContent = 'Name'; nameLabel.append(nameInput); fields.prepend(nameLabel); nameInput.addEventListener('input', changed); }
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
      if (options.commands?.updateView) readOperation = () => { const patch = validateToolbarPatch({...result,view:configuredView},readPatch()); return () => options.commands!.updateView!(version,selectedIndex,patch); };
      if (selectedIndex !== opening.selectedIndex && !options.commands?.updateView) { nameInput.disabled = true; layout.disabled = true; for (const input of layoutFields.querySelectorAll<HTMLInputElement>('input,select')) input.disabled = true; menuAction('Open this view', () => options.selectView(selectedIndex)); }
      if (options.commands?.setDefaultView) menuAction('Set as default view', () => options.commands!.setDefaultView!(version, selectedIndex), selectedIndex !== 0);
      if (options.commands?.duplicateView) menuAction('Duplicate view', () => options.commands!.duplicateView!(version, selectedIndex, uniqueViewName(opening.views, configuredView.name)));
      if (options.commands?.moveView) { menuAction('Move view earlier', () => options.commands!.moveView!(version, selectedIndex, selectedIndex - 1), selectedIndex > 0); menuAction('Move view later', () => options.commands!.moveView!(version, selectedIndex, selectedIndex + 1), selectedIndex < opening.views.length - 1); }
      if (options.commands?.removeView) menuAction('Delete view', () => options.commands!.removeView!(version, selectedIndex), opening.views.length > 1).classList.add('mod-destructive');
      if (options.commands?.updateRoot) menuAction('New item settings', async () => { own.saving = false; own.close(false); open('New item settings', trigger); });
    } else if (name === 'Properties') {
      const displayNames = new Map<string, string>();
      let order = (Array.isArray(result.view.order) ? result.view.order as string[] : ['file.name']).map(normalizeBaseProperty);
      const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Find a property'; search.setAttribute('aria-label', 'Find a property');
      const list = doc.createElement('div'); list.className = 'bases-toolbar-property-list'; fields.append(search, list);
      const render = () => {
        list.replaceChildren(); const query = search.value.toLowerCase(); const candidates = [...new Set([...order, ...properties])].filter(property => opening.label(property).toLowerCase().includes(query) || property.toLowerCase().includes(query));
        for (const property of candidates.slice(0, 100)) {
          const row = doc.createElement('div'); row.className = 'bases-toolbar-property-row';
          const label = doc.createElement('label'), check = doc.createElement('input'); check.type = 'checkbox'; check.dataset.property = property; check.checked = order.includes(property); label.append(check, doc.createTextNode(opening.label(property))); row.append(label);
          check.addEventListener('change', () => { order = check.checked ? [...order, property] : order.filter(value => value !== property); changed(); render(); Array.from(list.querySelectorAll<HTMLInputElement>('input')).find(input => input.dataset.property === property)?.focus(); });
          const index = order.indexOf(property);
          const move = (delta: number) => { const next = [...order]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; order = next; changed(); render(); Array.from(list.querySelectorAll<HTMLInputElement>('input')).find(input => input.dataset.property === property)?.focus(); };
          if (index >= 0) {
            const up = button(doc, '↑', () => move(-1), `Move ${opening.label(property)} earlier`); up.disabled = index === 0; up.dataset.moveIndex = String(index);
            const down = button(doc, '↓', () => move(1), `Move ${opening.label(property)} later`); down.disabled = index === order.length - 1; row.append(up, down);
          }
          if (options.onPropertySettings && property.startsWith('note.')) { const settings = button(doc, '⋯', () => options.onPropertySettings!(property), `Property settings ${opening.label(property)}`); row.append(settings); }
          if (options.commands?.updateRoot) { const display = doc.createElement('input'); display.placeholder = opening.label(property); display.value = displayNames.get(property) ?? ''; display.setAttribute('aria-label', `Display name ${opening.label(property)}`); display.addEventListener('input', () => { displayNames.set(property, display.value); changed(); }); row.append(display); }
          if (property.startsWith('formula.') && options.commands?.updateRoot) row.append(button(doc, 'ƒ', () => { if (own.dirty) { error.textContent = 'Apply property changes before editing a formula.'; return; } own.close(false); open('Formula', trigger, undefined, property.slice(8)); }, `Edit formula ${property.slice(8)}`));
          list.append(row);
        }
        if (candidates.length > 100) { const hint = doc.createElement('p'); hint.textContent = 'Showing the first 100 properties. Refine your search to find more.'; list.append(hint); }
      };
      if (options.commands?.updateRoot) fields.append(button(doc, 'Add formula', () => { if (own.dirty) { error.textContent = 'Apply property changes before adding a formula.'; return; } own.close(false); open('Formula', trigger); }));
      search.addEventListener('input', render); render(); readPatch = () => ({ order });
      readOperation = () => { const view = validateToolbarPatch(result, {order}); if (!displayNames.size) return () => options.save(version, view); if (!options.saveConfiguration) throw new Error('Combined property configuration is unavailable.'); const root = propertyDisplayPatch(opening.root, displayNames); return () => options.saveConfiguration!(version, {view,root}); };
    } else if (name === 'Sort') {
      const sort = Array.isArray(result.view.sort) ? structuredClone(result.view.sort) as BaseValue[] : [];
      const list = doc.createElement('div'); fields.append(list);
      const render = () => {
        const focusedLabel = list.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : undefined;
        list.replaceChildren(); sort.forEach((value, index) => {
          const row = doc.createElement('div'); row.className = 'bases-toolbar-rule';
          if (!mapping(value)) { row.append(doc.createTextNode('Unsupported existing sort rule')); }
          else {
            const currentProperty = propertyId(value.column || value.property), choices = availableOptions.some(([key]) => key === currentProperty) ? availableOptions : [[currentProperty, opening.label(currentProperty)] as const, ...availableOptions];
            const property = select(doc, 'Sort property', choices, currentProperty), direction = select(doc, 'Sort direction', [['ASC', 'Ascending'], ['DESC', 'Descending']], String(value.direction));
            const edit = () => { const next: Record<string, BaseValue> = { ...value, property: property.value, direction: direction.value }; delete next.column; sort[index] = next; changed(); };
            property.addEventListener('change', edit); direction.addEventListener('change', edit); row.append(property, direction);
          }
          const earlier = button(doc, '↑', () => { [sort[index - 1], sort[index]] = [sort[index], sort[index - 1]]; changed(); render(); }, 'Move sort earlier'); earlier.disabled = index === 0;
          row.append(earlier, button(doc, 'Remove', () => { sort.splice(index, 1); changed(); render(); }, 'Remove sort')); list.append(row);
        });
        if (focusedLabel) (Array.from(list.querySelectorAll<HTMLElement>('[aria-label]')).find(node => node.getAttribute('aria-label') === focusedLabel && !(node as HTMLButtonElement).disabled) ?? list.querySelector<HTMLElement>('select') ?? Array.from(fields.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === 'Add sort'))?.focus();
        if (!sort.length) { const hint = doc.createElement('p'); hint.textContent = 'No explicit sort. Files use their default name order.'; list.append(hint); }
      };
      fields.append(button(doc, 'Add sort', () => { const used = new Set(sort.filter(mapping).map(value => propertyId(value.column || value.property))); const property = result.availableProperties.find(property => !used.has(property)); if (!property) { error.textContent = 'All available properties are already sorted.'; return; } sort.push({ property, direction: 'ASC' }); changed(); render(); }));
      render(); readPatch = () => ({ sort });
    } else if (name === 'Group') {
      const existing = mapping(result.view.groupBy) ? result.view.groupBy : undefined;
      const currentProperty = propertyId(existing?.property);
      const choices = currentProperty && !availableOptions.some(([key]) => key === currentProperty) ? [[currentProperty, opening.label(currentProperty)] as const, ...availableOptions] : availableOptions;
      const property = select(doc, 'Group property', [['', 'No grouping'], ...choices], currentProperty);
      const direction = select(doc, 'Group direction', [['ASC', 'Ascending'], ['DESC', 'Descending']], String(existing?.direction ?? 'ASC'));
      property.addEventListener('change', changed); direction.addEventListener('change', changed); fields.append(property, direction);
      const hint = doc.createElement('p'); hint.textContent = 'Changing the grouping property resets manually chosen group visibility and order.'; fields.append(hint);
      readPatch = () => {
        const groupBy: Record<string, BaseValue> | undefined = property.value ? { ...existing, property: property.value, direction: direction.value } : undefined;
        if (groupBy && property.value !== propertyId(existing?.property)) delete groupBy.column;
        return property.value === propertyId(existing?.property) ? { groupBy } : { groupBy, groupOrder: undefined };
      };
    } else {
      let filter = result.view.filters === undefined ? undefined : structuredClone(result.view.filters) as FilterNode;
      let rootFilter = opening.rootFilters === undefined ? undefined : structuredClone(opening.rootFilters) as FilterNode;
      let scope: 'view' | 'root' = 'view'; let viewFilter = filter;
      const scopes = doc.createElement('div'); scopes.className = 'bases-filter-scopes'; scopes.setAttribute('role','tablist'); fields.append(scopes);
      const allViews = button(doc, 'All views', () => switchScope('root')), thisView = button(doc, 'This view', () => switchScope('view'));
      allViews.setAttribute('role','tab'); thisView.setAttribute('role','tab'); allViews.setAttribute('aria-selected','false'); thisView.setAttribute('aria-selected','true'); allViews.disabled = !options.commands?.updateRoot;
      scopes.append(allViews, thisView);
      const switchScope = (next: 'view' | 'root') => { if (next === scope || !canRestructure()) return; if (scope === 'view') viewFilter = filter; else rootFilter = filter; scope = next; filter = scope === 'root' ? rootFilter : viewFilter; allViews.setAttribute('aria-selected',String(scope === 'root')); thisView.setAttribute('aria-selected',String(scope === 'view')); render(); };
      if (opening.rootFilters !== undefined) { const hint = doc.createElement('p'); hint.className = 'bases-toolbar-hint'; hint.textContent = 'This view also uses the base-wide filter. Changes here affect this view only.'; fields.append(hint); }
      const tree = doc.createElement('div'); tree.className = 'bases-filter-tree'; fields.append(tree);
      const canRestructure = (except?: HTMLElement) => {
        const invalid = Array.from(form.querySelectorAll<HTMLInputElement>('input')).find(input => !input.validity.valid && !except?.contains(input));
        if (!invalid) return true; error.textContent = 'Correct the invalid condition value before changing other conditions.'; invalid.focus(); return false;
      };
      const defaultExpression = () => buildFilterCondition(properties[0] ?? 'file.name', 'eq', '', 'text');
      let renderBudget = 1000;
      const renderNode = (value: FilterNode, replace: (next: FilterNode) => void, remove: () => void, depth = 0): HTMLElement => {
        const row = doc.createElement('div'); row.className = typeof value === 'string' ? 'bases-filter-condition' : 'bases-filter-group';
        if (--renderBudget < 0 || depth > 32) { row.append(doc.createTextNode('This filter exceeds the visual editor’s size or nesting limit.')); return row; }
        if (typeof value === 'string') {
          const basic = /^((?:note|file|formula)\[("(?:[^"\\]|\\.)*")\])\s*(==|!=|>|<)\s*(.+)$/.exec(value);
          const contains = /^((?:note|file|formula)\[("(?:[^"\\]|\\.)*")\])\.contains\((.+)\)$/.exec(value);
          let decoded: { property: string; operator: string; text: string; type: 'text' | 'number' | 'boolean' } | undefined;
          try {
            const match = basic || contains;
            if (match) {
              const namespace = match[1].slice(0, match[1].indexOf('[')), literal = JSON.parse(basic ? match[4] : match[3]);
              if (literal === null && basic && ['==','!='].includes(match[3]) || literal !== null && ['string', 'number', 'boolean'].includes(typeof literal)) decoded = { property: `${namespace}.${JSON.parse(match[2])}`, operator: contains ? 'contains' : literal === null ? match[3] === '==' ? 'unset' : 'set' : ({'==':'eq','!=':'neq','>':'gt','<':'lt'} as Record<string,string>)[match[3]], text: literal === null ? '' : String(literal), type: typeof literal === 'number' ? 'number' : typeof literal === 'boolean' ? 'boolean' : 'text' };
            }
          } catch { /* Preserve unsupported existing expressions as advanced conditions. */ }
          if (decoded) {
            const choices = propertyOptions.some(([key]) => key === decoded!.property) ? propertyOptions : [[decoded.property, decoded.property] as const, ...propertyOptions];
            const property = select(doc, 'Filter property', choices, decoded.property), operator = select(doc, 'Condition', [['eq','Is'],['neq','Is not'],['contains','Contains'],['gt','Greater than'],['lt','Less than'],['unset','Is not set'],['set','Is set']], decoded.operator);
            const type = select(doc, 'Value type', [['text','Text'],['number','Number'],['boolean','Checkbox']], decoded.type), input = doc.createElement('input'); input.setAttribute('aria-label', 'Filter value'); input.value = decoded.text;
            const edit = () => { changed(); input.disabled = type.disabled = operator.value === 'unset' || operator.value === 'set'; try { replace(buildFilterCondition(property.value, operator.value as 'eq', input.value, type.value as 'text')); input.setCustomValidity(''); error.textContent = ''; } catch (failure) { const message = failure instanceof Error ? failure.message : String(failure); input.setCustomValidity(message); error.textContent = message; } };
            property.addEventListener('change', edit); operator.addEventListener('change', edit); type.addEventListener('change', edit); input.addEventListener('input', edit); input.disabled = type.disabled = decoded.operator === 'unset' || decoded.operator === 'set'; row.append(property, operator, type, input);
          } else {
            const expression = doc.createElement('textarea'); expression.setAttribute('aria-label', 'Filter expression'); expression.value = value; expression.rows = 2;
            expression.addEventListener('input', () => { replace(expression.value); changed(); }); row.append(expression);
          }
          row.append(button(doc, 'Remove', () => { if (!canRestructure(row)) return; remove(); changed(); render(); }, 'Remove filter'));
        } else if (mapping(value) && Object.keys(value).length === 1 && ['and','or','not'].includes(Object.keys(value)[0]) && Array.isArray(Object.values(value)[0])) {
          const key = Object.keys(value)[0] as 'and' | 'or' | 'not', children = Object.values(value)[0] as FilterNode[];
          const mode = select(doc, 'Match', [['and','All conditions'],['or','Any condition'],['not','None of these conditions']], key);
          mode.addEventListener('change', () => { if (!canRestructure()) { mode.value = key; return; } replace({ [mode.value]: children } as FilterNode); changed(); render(); }); row.append(mode);
          for (let index = 0; index < children.length; index++) {
            row.append(renderNode(children[index], next => { children[index] = next; }, () => { children.splice(index, 1); }, depth + 1));
            if (renderBudget < 0) break;
          }
          row.append(button(doc, 'Add condition', () => { if (!canRestructure()) return; children.push(defaultExpression()); changed(); render(); }), button(doc, 'Add group', () => { if (!canRestructure()) return; children.push({ and: [defaultExpression()] }); changed(); render(); }), button(doc, 'Remove group', () => { if (!canRestructure(row)) return; remove(); changed(); render(); }));
        } else { row.append(doc.createTextNode('This filter is not supported by the visual editor.'), button(doc, 'Remove filter', () => { if (!canRestructure(row)) return; remove(); changed(); render(); })); }
        return row;
      };
      const render = () => {
        const focusedLabel = tree.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : undefined;
        tree.replaceChildren(); renderBudget = 1000;
        if (filter === undefined) { const hint = doc.createElement('p'); hint.textContent = 'No view-specific conditions.'; tree.append(hint); }
        else tree.append(renderNode(filter, next => { filter = next; }, () => { filter = undefined; }));
        if (focusedLabel) (Array.from(tree.querySelectorAll<HTMLElement>('[aria-label]')).find(node => node.getAttribute('aria-label') === focusedLabel) ?? tree.querySelector<HTMLElement>('input,select,textarea,button') ?? Array.from(fields.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === 'Add filter'))?.focus();
        place();
      };
      fields.append(button(doc, 'Add filter', () => { if (!canRestructure()) return; filter = filter === undefined ? { and: [defaultExpression()] } : { and: [filter, defaultExpression()] }; changed(); render(); }), button(doc, 'Add expression', () => { if (!canRestructure()) return; filter = filter === undefined ? 'true' : { and: [filter, 'true'] }; changed(); render(); }));
      render(); readPatch = () => ({ filters: filter as BaseValue | undefined });
      readOperation = () => {
        if (scope === 'view') viewFilter = filter; else rootFilter = filter;
        const view = validateToolbarPatch(result, {filters:viewFilter as BaseValue | undefined});
        const root = {filters:rootFilter as BaseValue | undefined};
        validateToolbarPatch(result, {filters:root.filters});
        if (options.saveConfiguration) return () => options.saveConfiguration!(version,{view,root});
        if (scope === 'root') { if (!options.commands?.updateRoot) throw new Error('All-view filters are unavailable.'); return () => options.commands!.updateRoot!(version,root); }
        return () => options.save(version,view);
      };
    }
    form.addEventListener('submit', event => {
      event.preventDefault(); if (own.saving || destroyed || panel !== own) return;
      if (!own.dirty && !own.failure) { own.close(); return; }
      if (!form.checkValidity()) { error.textContent = 'Check the invalid condition value before applying.'; return; }
      let operation: () => Promise<void>;
      try {
        options.preflight();
        if (retryPersistence) operation = retryPersistence;
        else if (readOperation) operation = readOperation();
        else { const patch = validateToolbarPatch(result, readPatch()); operation = () => options.save(result.version, patch); }
      } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); return; }
      own.saving = true; options.onDraftChange();
      const disabled = new Map(Array.from(node.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea'), input => [input, input.disabled] as const));
      for (const input of disabled.keys()) input.disabled = true;
      error.textContent = 'Saving…';
      void operation().then(() => {
        if (destroyed || panel !== own) return; own.saving = false; own.dirty = false; own.failure = undefined; own.close();
      }, failure => {
        if (destroyed || panel !== own) return; own.saving = false; own.dirty = true;
        if (failure instanceof BaseToolbarSaveError) retryPersistence = failure.retry;
        if (retryPersistence) {
          own.failure ??= {};
          error.textContent = `Could not save: ${failure instanceof Error ? failure.message : String(failure)}. Retry the retained file draft, or cancel without discarding it.`;
          apply.disabled = false; apply.textContent = 'Retry save'; cancel.disabled = false;
        } else {
          own.failure = undefined;
          for (const [input, wasDisabled] of disabled) input.disabled = wasDisabled;
          error.textContent = `Could not apply: ${failure instanceof Error ? failure.message : String(failure)}. Your changes are still here.`;
        }
        report(failure); options.onDraftChange();
      });
    });
    place(); node.querySelector<HTMLElement>('input,select,textarea,button')?.focus({ preventScroll: true });
  }
  function update(next: BaseToolbarState) {
    if (destroyed) return;
    if (hasDraft()) return;
    const focusedLabel = actions.contains(doc.activeElement) ? doc.activeElement?.getAttribute('aria-label') : panel?.node.contains(doc.activeElement) ? panel.trigger.getAttribute('aria-label') : undefined;
    panel?.close(false);
    state = next;
    selector.replaceChildren(...next.views.map((view, index) => { const option = doc.createElement('option'); option.value = String(index); option.textContent = view.name; return option; })); selector.value = String(next.selectedIndex);
    viewButton.replaceChildren(icon(layoutIcon(next.result.view.type),16,doc),doc.createTextNode(next.result.view.name),icon('chevrons-up-down',14,doc));
    count.replaceChildren(icon('text-align-start',16,doc),doc.createTextNode(`${next.result.counts.returned} ${next.result.counts.returned === 1 ? 'result' : 'results'}`));
    searchCount.textContent = searchInput.value ? `${next.result.counts.returned} results` : '';
    actions.replaceChildren();
    if (!next.readOnly) for (const [name, glyph] of [['Sort','arrow-up-down'],['Group','group'],['Filter','filter'],['Properties','list-filter']] as const) {
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
  return { update, hasDraft, captureSaveAcknowledgement() { const token = panel?.failure, captured = panel; return () => { if (!destroyed && captured && captured === panel && token && captured.failure === token && !captured.saving) { captured.failure = undefined; captured.dirty = false; captured.close(false); } }; },
    destroy() { destroyed = true; if (panel) { panel.saving = false; panel.close(false); } container.replaceChildren(); },
  };
}
