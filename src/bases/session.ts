import { BaseController, createBaseMutationHost } from './controller.ts';
import type { BaseBufferHost, BaseControllerState } from './controller.ts';
import { BaseDocument } from './document.ts';
import { sharedBaseCoverage, sharedBasePreview, sharedBaseWitness } from './shared-query.ts';
import { createBaseClockHost } from './clock.ts';
import type { BaseClockHost } from './clock.ts';
import { BaseToolbarSaveError, createBaseToolbar } from './toolbar.ts';
import { createBaseViewActions } from './view-actions.ts';
import { createBaseTableView } from './table-view.ts';
import { createBaseCardsView } from './cards-view.ts';
import type { BaseCardsViewOptions } from './cards-view.ts';
import { createBaseListView } from './list-view.ts';
import { createBaseKanbanView } from './kanban-view.ts';
import type { BaseQueryOptions, BaseQueryResult } from './query.ts';
import type { Vault } from '../core/vault.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';
import { exportBaseResults } from './export.ts';
import type { BaseExportFormat } from './export.ts';
import { prepareBaseItemCreation } from './creation.ts';
import type { BaseCreationOperation } from './creation.ts';
import { baseEditValue } from './view-actions.ts';
import type { BaseValue, BaseViewPatch } from './document.ts';
import type { BasePresentationOptions, BasePropertyPresentation } from './presentation-common.ts';
import { createBasePropertyRenderer } from './property-widgets.ts';
import type { BasePropertyWidgetEdit, BasePropertyWidgetAcknowledgement } from './property-widgets.ts';
import { baseValuesEqual } from './expression.ts';
import type { BaseRelationTarget } from './property-widgets.ts';
import { BASE_PROPERTY_DEFINITIONS_PATH, BASE_PROPERTY_TYPES, basePropertyName, parseBasePropertyDefinitions, updateBasePropertyDefinition, parseBasePropertyInput, inferBasePropertyDefinition, basePropertyValueDiagnostic } from './property-definitions.ts';
import type { BasePropertyDefinition, BasePropertyDefinitions, BasePropertyType } from './property-definitions.ts';
import { createBasePropertySettingsPanel } from './property-settings-panel.ts';

/** Pane hosts notify only when their explicit visibility state changes. */
export interface BaseSessionVisibility {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}
export interface BaseSessionOptions {
  readonly vault: Vault;
  readonly basePath: string;
  /** Workspace and writable embeds must share their existing buffer registry. */
  readonly buffers?: BaseBufferHost;
  readonly readOnly?: boolean;
  readonly inlineSource?: {
    read(): Promise<{ source: string; startByte: number; endByte: number; witness?: { entryId: string; revision: string } }>;
    transform(expectedSource: string, nextSource: string, validate: () => void): Promise<void>;
  };
  readonly contextMenu?: BasePresentationOptions['contextMenu'];
  readonly hoverFile?: BasePresentationOptions['hoverFile'];
  readonly dragFile?: BasePresentationOptions['dragFile'];
  readonly getRelationTargets?: (property: string, presentation: BasePropertyPresentation) => readonly BaseRelationTarget[] | undefined;
  readonly deleteFiles?: (rows: readonly import('./query.ts').BaseQueryRow[], result: BaseQueryResult) => Promise<void>;
  readonly exportResults?: (text: string, format: BaseExportFormat, copy: boolean) => Promise<void>;
  readonly query?: BaseQueryOptions;
  readonly clock?: BaseClockHost;
  readonly visibility?: BaseSessionVisibility;
  readonly viewName?: string;
  readonly closeCreatedFile?: () => boolean | Promise<boolean>;
  readonly openCreatedFile?: (path: string, event: MouseEvent | KeyboardEvent, anchor?: HTMLElement) => void | Promise<void>;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent) => void;
  readonly validate: () => void;
  readonly loadThumbnail?: BaseCardsViewOptions['loadThumbnail'];
  readonly onState?: (state: BaseControllerState) => void;
  readonly onError?: (error: unknown) => void;
}
export interface BaseSession {
  readonly ready: Promise<void>;
  readonly state: BaseControllerState;
  refresh(): Promise<void>;
  selectView(index: number): Promise<void>;
  setCurrentFile(path: string): Promise<void>;
  /** Workspace preflight: retain the mounted view while settling accepted edits. */
  flush(): Promise<void>;
  hasPendingChanges(): boolean;
  /** Retains UI/controller on failure; callers must not silently discard this rejection. */
  close(): Promise<void>;
}
interface MountedView {
  update(result: BaseQueryResult): void;
  destroy(): void;
  hasActiveEdits?(): boolean;
}

/** Compose existing Bases modules for a workspace pane or an embedded base. */
export function createBaseSession(container: HTMLElement, options: BaseSessionOptions): BaseSession {
  options.validate();
  if (!options.readOnly && !options.buffers) throw new Error('Writable Bases require the shared workspace buffer host');
  const doc = container.ownerDocument, win = doc.defaultView;
  const requestedQuery = options.query as (BaseQueryOptions & { randomSeed?: number }) | undefined;
  const randomSeed = requestedQuery?.randomSeed ?? (win?.crypto ?? globalThis.crypto).getRandomValues(new Uint32Array(1))[0];
  const query = { ...options.query, randomSeed };
  const root = doc.createElement('div'), toolbar = doc.createElement('div');
  const content = doc.createElement('div'), status = doc.createElement('div');
  root.className = 'bases-session'; toolbar.className = 'bases-session-toolbar'; content.className = 'bases-session-content';
  status.className = 'bases-session-status'; status.setAttribute('role', 'status');
  root.append(toolbar, content, status); container.append(root);
  let disposed = false, closing = false, mounted: MountedView | undefined, mountedType: string | undefined;
  let mountedResult: BaseQueryResult | undefined, deferred: BaseControllerState | undefined;
  let mountedIndex = -1, mountedMove = false, mountedWritable = false;
  const widgetResults = new Map<string | number, BaseQueryResult>(), widgetSources = new Map<string | number, string>();
  const rememberWidgetResult = (result: BaseQueryResult, source: string) => {
    widgetResults.set(result.version, result); widgetSources.set(result.version, source);
    while (widgetResults.size > 4) { const key = [...widgetResults.keys()].find(key => key !== mountedResult?.version); if (key === undefined) break; widgetResults.delete(key); widgetSources.delete(key); }
  };
  let propertyLabels: unknown;
  let definitions: BasePropertyDefinitions = { properties: {}, diagnostics: [] };
  let creation: BaseCreationOperation | undefined;
  let summaryPanel: HTMLElement | undefined;
  let definitionEpoch = 0, definitionsRevision = 0, mountedDefinitionsRevision = -1;
  let definitionsError: string | undefined;
  const loadDefinitions = async () => {
    const epoch = ++definitionEpoch;
    let source = '';
    try { source = options.vault.entries.get(BASE_PROPERTY_DEFINITIONS_PATH)?.type === 'file' ? await options.vault.read(BASE_PROPERTY_DEFINITIONS_PATH) : ''; }
    catch (error) {
      if (disposed || epoch !== definitionEpoch) return;
      definitionsError = error instanceof Error ? error.message : String(error); definitions = { properties: {}, diagnostics: [] }; definitionsRevision++;
      report(error); if (controller.state.result) render(controller.state); return;
    }
    if (disposed || epoch !== definitionEpoch) return;
    try { definitions = parseBasePropertyDefinitions(source); definitionsError = undefined; }
    catch (error) { definitionsError = error instanceof Error ? error.message : String(error); definitions = { properties: {}, diagnostics: [] }; report(error); }
    if (definitions.diagnostics.length) report(new Error(definitions.diagnostics.map(item => item.message).join(' ')));
    // Definitions affect mounted controls, even if the query result is unchanged.
    definitionsRevision++;
    if (controller.state.result) render(controller.state);
  };
  let selectedIndex = options.query?.viewIndex ?? 0;
  let notice: string | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<Promise<unknown>>(), changedBuffers = new Set<NoteBuffer>();
  const alive = () => { options.validate(); if (disposed) throw new Error('This base view is closed'); };
  const action = () => { alive(); if (closing) throw new Error('This base view is closing'); notice = undefined; };
  const report = (error: unknown) => {
    if (!disposed) status.textContent = error instanceof Error ? error.message : String(error);
    try { options.onError?.(error); } catch { /* User error reporters do not change persistence. */ }
  };
  const propertyDraft = () => !!mounted?.hasActiveEdits?.() || !!content.querySelector('.zorid-bases-table-input, [data-base-editing]');
  const activeDraft = () => propertyDraft() || toolbarUI.hasDraft() || settings.hasDraft() || !!summaryPanel;
  const schedule = () => {
    if (disposed || scheduled !== undefined) return;
    scheduled = setTimeout(() => { scheduled = undefined; if (deferred && !pending.size && !activeDraft()) { deferred = undefined; render(controller.state); } }, 0);
  };
  const releaseCleanBuffers = () => { for (const buffer of changedBuffers) if (!buffer.dirty && !buffer.error) changedBuffers.delete(buffer); };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    action();
    const promise = operation(); pending.add(promise);
    const settled = () => {
      pending.delete(promise);
      releaseCleanBuffers();
      schedule();
    };
    void promise.then(settled, error => { settled(); report(error); });
    return promise;
  };
  let configurationAttempt: { buffer?: NoteBuffer; text?: string } | undefined;
  const bufferMutations = options.buffers ? createBaseMutationHost({ ...options.buffers,
    validate() { alive(); options.buffers!.validate(); },
    onBufferChange(path, buffer, previousText) {
      changedBuffers.add(buffer);
      if (configurationAttempt && path === options.basePath) { configurationAttempt.buffer = buffer; configurationAttempt.text = buffer.text; }
      options.buffers!.onBufferChange?.(path, buffer, previousText);
    },
  }) : { async transform() { throw new Error('This base is read-only'); } };
  const mutations = bufferMutations;
  const hostClock = options.clock ?? createBaseClockHost({ document: doc, window: win });
  const clock: BaseClockHost = {
    capture: zone => hostClock.capture(zone), scheduleAt: (deadline, callback) => hostClock.scheduleAt(deadline, callback),
    isVisible: () => hostClock.isVisible() && (options.visibility?.isVisible() ?? true),
    subscribeWake(callback) {
      const stopClock = hostClock.subscribeWake(callback), stopPane = options.visibility?.subscribe(callback);
      return () => { stopClock(); stopPane?.(); };
    },
  };
  const controller = new BaseController({ vault: options.vault, basePath: options.basePath, mutations, query, clock, viewName: options.viewName, ...(options.inlineSource ? { inlineSource: options.inlineSource } : {}),
    onChange(state) { render(state); options.onState?.(state); },
  });
  const actions = createBaseViewActions(controller, { validate: action, canRename: !!options.buffers?.rename,
    validateFolder(path) { if (path && options.vault.entries.get(path)?.type !== 'folder') throw new Error('The destination folder no longer exists'); },
  });
  const settings = createBasePropertySettingsPanel(root, {
    definitions: () => definitions,
    properties: () => controller.state.result?.availableProperties ?? [],
    preflight() { action(); if (options.readOnly) throw new Error('This base is read-only'); if (pending.size || propertyDraft() || toolbarUI.hasDraft() || summaryPanel) throw new Error('Finish or cancel the current edit first.'); },
    save: (property, definition, expected) => track(() => saveDefinition(property, definition, expected)),
    onDraftChange: schedule, onError: report,
  });
  const toolbarUI = createBaseToolbar(toolbar, {
    immediate: true,
    preflight() { action(); if (pending.size || propertyDraft() || settings.hasDraft() || summaryPanel) throw new Error('Finish or cancel the current edit before changing the view.'); },
    selectView,
    save(version, patch) { return saveConfigurationCommand(() => controller.updateView(numericVersion(version), patch)); },
    saveConfiguration(version, patch) { return saveConfigurationCommand(() => controller.updateConfiguration(numericVersion(version), patch)); },
    commands: {
      updateView: (version, index, patch) => saveConfigurationCommand(() => controller.updateViewAt(numericVersion(version), index, patch)),
      editFormula: (version, originalName, name, expression) => saveConfigurationCommand(() => {
        if (originalName !== undefined) return controller.editFormula(numericVersion(version), originalName, name, expression);
        const state = controller.state, document = BaseDocument.parse(state.source), view = document.views[controller.selectedViewIndex];
        const formulas = document.getRoot('formulas');
        if (formulas && typeof formulas === 'object' && !Array.isArray(formulas) && Object.hasOwn(formulas, name)) throw new Error('A formula with this name already exists');
        document.setFormula(name, expression);
        const order = Array.isArray(view.order) ? [...view.order] : [...state.result?.properties ?? []];
        if (!order.includes(`formula.${name}`)) order.push(`formula.${name}`);
        return controller.updateConfiguration(numericVersion(version), { root: { formulas: document.getRoot('formulas') }, view: { order } });
      }),
      renameFormula: (version, from, to) => saveConfigurationCommand(() => controller.renameFormula(numericVersion(version), from, to)),
      addView: (version, type, name) => saveConfigurationCommand(() => controller.addView(numericVersion(version), type, name)),
      duplicateView: (version, index, name) => saveConfigurationCommand(() => controller.duplicateView(numericVersion(version), index, name)),
      removeView: (version, index) => saveConfigurationCommand(() => controller.removeView(numericVersion(version), index)),
      moveView: (version, from, to) => saveConfigurationCommand(() => controller.moveView(numericVersion(version), from, to)),
      setDefaultView: (version, index) => saveConfigurationCommand(() => controller.setDefaultView(numericVersion(version), index)),
      updateRoot: (version, patch) => saveConfigurationCommand(() => controller.updateRoot(numericVersion(version), patch)),
      setFormula: (version, name, expression) => saveConfigurationCommand(() => controller.setFormula(numericVersion(version), name, expression)),
    },
    onSearch(text) { if (propertyDraft() || settings.hasDraft()) { report(new Error('Finish or cancel the property edit before searching.')); return; } void track(() => controller.setSearchTerms(text.split(/\s+/).filter(Boolean))).catch(report); },
    onNew: () => track(() => createItem()),
    onExport: (format, copy) => track(() => exportResults(format, copy)),
    onPropertySettings(property) { try { settings.open(property); } catch (error) { report(error); } },
    onDraftChange: schedule,
    onError: report,
  });
  function saveConfigurationCommand(operation: () => Promise<void>): Promise<void> {
    action(); if (options.readOnly) return Promise.reject(new Error('This base is read-only'));
    const attempt: { buffer?: NoteBuffer; text?: string } = {}; configurationAttempt = attempt;
    return track(operation).catch(error => {
      const buffer = attempt.buffer, text = attempt.text;
      if (buffer && (buffer.dirty || buffer.error)) throw new BaseToolbarSaveError(error instanceof Error ? error.message : String(error), () => track(async () => {
        if (buffer.path !== options.basePath || buffer.text !== text) throw new Error('The retained configuration changed. Save or resolve that draft before retrying.');
        await buffer.flush(); await controller.refresh();
      }));
      throw error;
    }).finally(() => { if (configurationAttempt === attempt) configurationAttempt = undefined; });
  }
  function assertPropertyWritable(property: string, value?: import('./expression.ts').BaseExpressionValue): void {
    const invalid = definitions.diagnostics.find(item => item.property === basePropertyName(property));
    if (definitionsError || invalid) throw new Error(definitionsError ?? invalid!.message);
    const definition = definitions.properties[basePropertyName(property)];
    if (definition?.type === 'rollup' || definition?.type === 'reverseRelation') throw new Error('Derived properties cannot be edited.');
    const diagnostic = definition && value && basePropertyValueDiagnostic(value, definition);
    if (diagnostic) throw new Error(diagnostic);
  }
  function numericVersion(version: string | number): number { if (typeof version !== 'number') throw new Error('The base result is stale'); return version; }
  async function saveDefinition(property: string, definition: BasePropertyDefinition | null, expected?: BasePropertyDefinition | null): Promise<void> {
    action(); if (options.readOnly || !options.buffers) throw new Error('This base is read-only');
    if (!options.vault.entries.has(BASE_PROPERTY_DEFINITIONS_PATH)) await options.vault.create(BASE_PROPERTY_DEFINITIONS_PATH, 'properties: {}\n', alive);
    await bufferMutations.transform(BASE_PROPERTY_DEFINITIONS_PATH, source => {
      if (expected !== undefined && JSON.stringify(parseBasePropertyDefinitions(source).properties[property] ?? null) !== JSON.stringify(expected)) throw new Error('This property definition changed while its settings were open. Reopen settings before applying.');
      return updateBasePropertyDefinition(source, property, definition);
    }, alive);
    await loadDefinitions();
  }
  function editSummary(property: string, id: string, anchor: HTMLElement): void {
    const document = BaseDocument.parse(controller.state.source), raw = document.getRoot('summaries');
    const summaries: Record<string, BaseValue> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, BaseValue>) } : {};
    if (Object.hasOwn(summaries, id)) { openSummaryEditor(property, anchor, id); return; }
    const active = controller.state.result;
    const first = active?.rows.map(row => row.values[property]).find(value => value && value.type !== 'null');
    const definition = definitions.properties[basePropertyName(property)] ?? (first ? inferBasePropertyDefinition(first) : undefined);
    const dateRange = definition?.type === 'date' || definition?.type === 'datetime' || first?.type === 'date';
    // Functional expression definitions observed in the shipped reference registry.
    const builtins: Record<string, string> = { Average: 'values.mean().round(2)', Min: 'values.min()', Max: 'values.max()', Sum: 'values.sum().round(2)', Range: dateRange ? '(values.latest() - values.earliest())' : 'values.max() - values.min()', Median: 'values.median()', Stddev: 'values.stddev().round(2)', Earliest: 'values.earliest()', Latest: 'values.latest()', Checked: 'values.filter(value == true).length', Unchecked: 'values.filter(value == false).length', Empty: 'values.filter(value.isType("null")).length', Filled: 'values.filter(!value.isType("null")).length', Unique: 'values.unique().length' };
    const expression = builtins[id]; if (!expression) throw new Error('This summary is no longer available.');
    summaries[id] = expression;
    void track(() => controller.updateRoot(controller.state.version, { summaries })).then(() => openSummaryEditor(property, anchor, id)).catch(report);
  }
  function openSummaryEditor(property: string, anchor: HTMLElement, originalName?: string, suggestedName?: string): void {
    action(); if (options.readOnly || pending.size || activeDraft()) throw new Error('Finish or cancel the current edit first.');
    const opening = controller.state, document = BaseDocument.parse(opening.source);
    const configured = document.getRoot('summaries');
    const summaries: Record<string, BaseValue> = configured && typeof configured === 'object' && !Array.isArray(configured) ? { ...(configured as Record<string, BaseValue>) } : {};
    const panel = doc.createElement('section'); panel.className = 'bases-toolbar-popover'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', originalName ? 'Edit summary' : 'Add summary');
    const heading = doc.createElement('h3'); heading.textContent = originalName ? 'Edit summary' : 'Add summary';
    const form = doc.createElement('form'), fields = doc.createElement('fieldset'); fields.className = 'bases-toolbar-fields'; fields.style.border = '0'; fields.style.margin = '0';
    const name = doc.createElement('input'); name.setAttribute('aria-label', 'Summary name'); name.value = originalName ?? suggestedName ?? 'Summary'; name.readOnly = !!originalName;
    const expression = doc.createElement('textarea'); expression.setAttribute('aria-label', 'Summary expression'); expression.value = originalName && typeof summaries[originalName] === 'string' ? summaries[originalName] as string : 'values.length'; expression.rows = 4;
    const error = doc.createElement('div'); error.className = 'bases-toolbar-error'; error.setAttribute('role', 'alert');
    const footer = doc.createElement('div'); footer.className = 'bases-toolbar-footer'; const cancel = doc.createElement('button'), apply = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; apply.type = 'submit'; apply.textContent = 'Apply'; apply.className = 'mod-cta';
    let saving = false; const close = () => { if (saving) return; panel.remove(); if (summaryPanel === panel) summaryPanel = undefined; anchor.focus({ preventScroll: true }); schedule(); };
    cancel.addEventListener('click', close); panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } });
    form.addEventListener('submit', event => { event.preventDefault(); if (saving) return;
      void track(async () => {
        try {
          if (!name.value.trim() || !expression.value.trim()) throw new Error('Enter a summary name and expression.');
          if (!originalName && Object.hasOwn(summaries, name.value.trim())) throw new Error('A summary with that name already exists.');
          saving = true; fields.disabled = apply.disabled = cancel.disabled = true;
          const selected = controller.state.result?.view.summaries; const selection: Record<string, BaseValue> = selected && typeof selected === 'object' && !Array.isArray(selected) ? { ...(selected as Record<string, BaseValue>) } : {};
          summaries[name.value.trim()] = expression.value; selection[property] = name.value.trim();
          await controller.updateConfiguration(opening.version, { root: { summaries }, view: { summaries: selection } }); saving = false; close();
        } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); throw failure; }
        finally { saving = false; fields.disabled = apply.disabled = cancel.disabled = false; }
      }).catch(report);
    });
    fields.append(name, expression); footer.append(cancel, apply); form.append(fields, error, footer); panel.append(heading, form); doc.body.append(panel); summaryPanel = panel;
    const bounds = anchor.getBoundingClientRect(); panel.style.left = `${Math.max(8, Math.min(bounds.left, (win?.innerWidth ?? 800) - 468))}px`; panel.style.top = `${Math.max(8, Math.min(bounds.bottom, (win?.innerHeight ?? 600) - panel.offsetHeight - 8))}px`; name.focus();
  }
  async function createItem(group?: { property: string; value: BaseValue }, anchor?: HTMLElement): Promise<void> {
    action(); if (options.readOnly || !controller.state.result || sharedBasePreview(controller.state.result)) throw new Error('This base is read-only');
    if (await options.closeCreatedFile?.()) return;
    alive();
    // Retain an uncertain operation across retries rather than choosing a new filename.
    if (!creation || creation.status === 'committed') creation = await prepareBaseItemCreation({ vault: options.vault, document: controller.state.source, basePath: options.basePath, viewIndex: selectedIndex, group, validate: alive });
    const operation = creation, entry = await operation.run(); alive();
    await controller.refresh();
    notice = [...operation.plan.warnings, ...(controller.state.result && !controller.state.result.rows.some(row => row.path === entry.path) ? ['Created note is not shown in the current results.'] : [])].join(' ') || undefined;
    renderStatus(controller.state);
    const event = new (win?.MouseEvent ?? MouseEvent)('click');
    if (options.openCreatedFile) await options.openCreatedFile(entry.path, event, anchor ?? toolbar.querySelector<HTMLElement>('[aria-label="New"]') ?? content);
    else options.openFile(entry.path, event);
  }
  async function exportResults(format: BaseExportFormat, copy: boolean): Promise<void> {
    const result = controller.state.result; if (!result) throw new Error('Wait for results before exporting.');
    const labels = BaseDocument.parse(controller.state.source).getRoot('properties');
    const text = exportBaseResults(result, format, property => {
      const settings = labels && typeof labels === 'object' && !Array.isArray(labels) ? labels as Record<string, BaseValue> : {};
      const setting = settings[property] ?? settings[basePropertyName(property)];
      if (setting && typeof setting === 'object' && !Array.isArray(setting) && typeof (setting as Record<string, BaseValue>).displayName === 'string') return (setting as Record<string, BaseValue>).displayName as string;
      return property.startsWith('file.') ? property.replace(/^file\./, 'file ') : property.replace(/^(?:note|formula)\./, '');
    });
    if (options.exportResults) return options.exportResults(text, format, copy);
    if (copy) { if (!win?.navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.'); await win.navigator.clipboard.writeText(text); return; }
    if (!win?.URL?.createObjectURL) throw new Error('File export is unavailable in this window.');
    const blob = new win.Blob([text], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = win.URL.createObjectURL(blob), link = doc.createElement('a');
    link.href = url; link.download = `${options.basePath.split('/').pop()?.replace(/\.base$/i, '') ?? 'Base'}.${format === 'markdown' ? 'md' : format === 'paths' ? 'txt' : format}`;
    link.click(); setTimeout(() => win.URL.revokeObjectURL(url), 0);
  }
  function renderStatus(state: BaseControllerState): void {
    content.setAttribute('aria-busy', String(state.updating));
    if (state.error) { status.textContent = state.error.message; return; }
    if (definitionsError) { status.textContent = `Property settings: ${definitionsError}`; return; }
    if (definitions.diagnostics.length) { status.textContent = definitions.diagnostics.map(item => `${item.property ?? 'Property'}: ${item.message}`).join(' '); return; }
    if ([...changedBuffers].some(buffer => buffer.dirty || buffer.error)) return;
    const preview = state.result && sharedBasePreview(state.result);
    if (preview) {
      const p = preview.progress, unavailable = preview.unavailablePreparedFiles, filtered = preview.unavailableFilterRows;
      status.textContent = `Indexing… ${p.preparedFiles} of ${p.totalFiles} files indexed; ${p.pendingFiles} remaining. Read-only preview. Counts and aggregates cover indexed notes only.`
        + (!preview.preparedScanComplete ? ' Some indexed files have not been checked yet.' : '')
        + (unavailable ? ` ${unavailable} ${unavailable === 1 ? 'file is' : 'files are'} unavailable.` : '')
        + (filtered ? ` ${filtered} ${filtered === 1 ? 'note' : 'notes'} could not be checked against the filters.` : '')
        + (state.previewStatus ? ` ${state.previewStatus}` : '');
      return;
    }
    if (state.previewStatus) { status.textContent = state.previewStatus; return; }
    if (state.updating) { status.textContent = state.result ? 'Updating…' : 'Loading saved results…'; return; }
    const coverage = state.result && sharedBaseCoverage(state.result);
    status.textContent = coverage && !coverage.generationComplete ? 'Some saved files are unavailable in these results.'
      : coverage && !coverage.metadataComplete ? 'Some saved properties are unavailable in these results.' : notice ?? '';
  }
  function render(state: BaseControllerState): void {
    if (disposed) return;
    // Status changes never replace rows or a focused local property/config draft.
    renderStatus(state);
    if (state.error) { deferred = undefined; return; }
    if (!state.result) return;
    const result = state.result;
    selectedIndex = controller.selectedViewIndex;
    const document = BaseDocument.parse(state.source);
    const choices = document.views;
    propertyLabels = document.getRoot('properties');
    const getPropertyLabel = (property: string) => {
      if (propertyLabels && typeof propertyLabels === 'object' && !Array.isArray(propertyLabels)) {
        const config = (propertyLabels as Record<string, unknown>)[property] ?? (propertyLabels as Record<string, unknown>)[property.replace(/^note\./, '')];
        if (config && typeof config === 'object' && 'displayName' in config && typeof config.displayName === 'string') return config.displayName;
      }
      return property.startsWith('file.') ? property.replace(/^file\./, 'file ') : property.replace(/^(?:note|formula)\./, '');
    };
    const writable = !options.readOnly && !sharedBasePreview(result);
    toolbarUI.update({ result, views: choices, selectedIndex, rootFilters: document.getRoot('filters'), root: Object.fromEntries(['filters','formulas','properties','summaries','newItemFolder','newItemTemplate'].map(key => [key, document.getRoot(key)]).filter((entry): entry is [string, BaseValue] => entry[1] !== undefined)), readOnly: !writable, allowRename: options.viewName === undefined, propertyType: property => definitions.properties[basePropertyName(property)]?.type, label: getPropertyLabel });
    // Toolbar rebases its own in-flight configuration without replacing row drafts.
    if (pending.size || activeDraft()) { deferred = state; return; }
    deferred = undefined;
    if (mountedResult === result && mountedDefinitionsRevision === definitionsRevision) return;
    rememberWidgetResult(result, state.source);
    const acknowledgeWidget = (original: BasePropertyPresentation, savedValue?: import('./expression.ts').BaseExpressionValue): BasePropertyWidgetAcknowledgement | undefined => {
      const before = widgetResults.get(original.version), latest = controller.state.result;
      if (!before?.shared || !latest?.shared || sharedBasePreview(latest) || widgetSources.get(original.version) !== controller.state.source) return;
      const row = latest.rows.find(row => row.path === original.row.path); if (!row) return;
      const initial = sharedBaseWitness(before, row.path), current = sharedBaseWitness(latest, row.path);
      if (!initial || !current || initial.entryId !== current.entryId || (savedValue === undefined && initial.revision !== current.revision)) return;
      const value = row.values[original.property] ?? { type: 'null' as const };
      if (!baseValuesEqual(value, savedValue ?? original.value, true)) return;
      const oldBase = sharedBaseWitness(before, options.basePath), newBase = sharedBaseWitness(latest, options.basePath);
      if (!oldBase || !newBase || oldBase.entryId !== newBase.entryId) return;
      rememberWidgetResult(latest, controller.state.source);
      return { version: latest.version, row, value };
    };
    const shared = { result, getPropertyLabel, getPropertyType: (property: string) => definitions.properties[basePropertyName(property)]?.type,
      openFile(path: string, event: MouseEvent | KeyboardEvent) { try { action(); options.openFile(path, event); } catch (error) { report(error); } },
      ...(writable ? { editProperty: (edit: Parameters<typeof actions.editProperty>[0]) => track(() => { assertPropertyWritable(edit.property, edit.value); return actions.editProperty(edit); }) } : {}),
      onError: report, onEditStateChange: schedule,
      contextMenu: options.contextMenu, hoverFile: options.hoverFile, dragFile: options.dragFile,
      renderProperty: createBasePropertyRenderer({ getDefinition: property => definitions.properties[basePropertyName(property)],
        commit: (edit: BasePropertyWidgetEdit) => track(async () => { assertPropertyWritable(edit.property, edit.value); await actions.editProperty(edit); return acknowledgeWidget(edit, edit.value); }), readOnly: presentation => !writable || !!definitionsError || definitions.diagnostics.some(item => item.property === basePropertyName(presentation.property)),
        isCurrent: presentation => !disposed && !!mountedResult && widgetResults.has(presentation.version),
        getRelationTargets: options.getRelationTargets, openFile: options.openFile, onError: report,
        createOption: (property, value, presentation) => track(async () => { const definition = definitions.properties[basePropertyName(property)]; if (!definition) throw new Error('Configure this property first.'); await saveDefinition(basePropertyName(property), { ...definition, options: [...definition.options ?? [], { value }] }, definition); return acknowledgeWidget(presentation); }),
      }),
      getSummary: (property: string, groupIndex: number | null) => {
        const active = mountedResult ?? result;
        const summaries = (groupIndex === null ? active : active.groups[groupIndex]) as { summaries?: Readonly<Record<string, import('./expression.ts').BaseExpressionValue>> } | undefined;
        const value = summaries?.summaries?.[property];
        const selection = active.view.summaries;
        const label = selection && typeof selection === 'object' && !Array.isArray(selection) ? (selection as Record<string, BaseValue>)[property] ?? (selection as Record<string, BaseValue>)[basePropertyName(property)] : undefined;
        return value ? { value, ...(typeof label === 'string' ? { label } : {}) } : undefined;
      },
      ...(writable ? {
      requestAddSummary: (property: string, anchor: HTMLElement, name?: string) => openSummaryEditor(property, anchor, undefined, name),
      requestEditSummary: (property: string, id: string, anchor: HTMLElement) => editSummary(property, id, anchor),
      requestHideSummary: (property: string) => track(() => {
        const active = mountedResult ?? result, current = active.view.summaries;
        const selection: Record<string, BaseValue> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, BaseValue>) } : {};
        delete selection[property]; delete selection[basePropertyName(property)];
        return controller.updateView(numericVersion(active.version), { summaries: selection });
      }),
      propertyTypes: BASE_PROPERTY_TYPES.map(id => ({ id, label: id === 'datetime' ? 'Date & time' : id === 'reverseRelation' ? 'Reverse relation' : id[0].toUpperCase() + id.slice(1) })),
      requestPropertyType: (property: string, id: string) => {
        if (id === 'rollup' || id === 'reverseRelation') { settings.open(property, undefined, id); return Promise.resolve(); }
        return track(() => {
        if (!property.startsWith('note.') || !BASE_PROPERTY_TYPES.includes(id as BasePropertyType)) throw new Error('Choose a supported note property type.');
        const bare = basePropertyName(property), previous = definitions.properties[bare];
        return saveDefinition(bare, { ...previous, type: id as BasePropertyType }, previous ?? null);
      }); },
      } : {}),
      getSummaryOptions: async (property: string, groupIndex: number | null) => {
        const previews = await controller.summaryPreviews(property);
        const custom = BaseDocument.parse(controller.state.source).getRoot('summaries');
        const order = [...new Set(['Empty', 'Filled', 'Unique', 'Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', ...Object.keys(custom && typeof custom === 'object' && !Array.isArray(custom) ? custom : {})])];
        return order.filter(id => Object.hasOwn(previews, id)).map(id => ({ id, label: id, ...(groupIndex === null ? { preview: previews[id] } : {}) }));
      },
      summaryOptions: [...new Set(['Average','Min','Max','Sum','Range','Median','Stddev','Earliest','Latest','Checked','Unchecked','Empty','Filled','Unique', ...Object.keys((document.getRoot('summaries') as Record<string, BaseValue>) ?? {})])].map(id => ({ id, label: id })),
      ...(writable ? { requestSummary: (property: string, id: string) => track(() => {
        const active = mountedResult ?? result;
        const current = active.view.summaries;
        const selections: Record<string, BaseValue> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, BaseValue>) } : {};
        if (id) selections[property] = id; else delete selections[property];
        return controller.updateView(numericVersion(active.version), { summaries: selections });
      }),
      } : {}),
      isPropertyEditable: (property: string) => { try { assertPropertyWritable(property); return writable; } catch { return false; } },
      validatePropertyValue: (value: import('./expression.ts').BaseExpressionValue, property: string) => { assertPropertyWritable(property); return value; },
      parsePropertyInput: (raw: string, property: string, row: import('./query.ts').BaseQueryRow) => parseBasePropertyInput(raw, definitions.properties[basePropertyName(property)] ?? inferBasePropertyDefinition(row.values[property] ?? { type: 'null' }), row.values[property]),
      ...(writable ? {
        ...(options.deleteFiles ? { deleteFiles: (rows: readonly import('./query.ts').BaseQueryRow[]) => track(async () => {
          const active = mountedResult ?? result;
          if (active.version !== controller.state.version) throw new Error('The Base result is stale; refresh before deleting files.');
          await options.deleteFiles!(rows, active);
        }) } : {}),
        editProperties: (edits: readonly import('./table-view.ts').BaseTableEdit[]) => track(() => { edits.forEach(edit => assertPropertyWritable(edit.property)); return actions.editProperties(edits); }),
        patchView: (patch: BaseViewPatch) => track(() => controller.updateView(numericVersion(mountedResult?.version ?? result.version), patch)),
        undo: () => track(() => controller.undo()), redo: () => track(() => controller.redo()),
        requestEditProperty: (property: string, anchor: HTMLElement) => settings.open(property, anchor),
      } : {}),
    };
    if (sharedBasePreview(result) && !result.rows.length) {
      // A prepared subset cannot establish global absence. Keep its exact
      // counts/status, without installing a published-view empty-state claim.
      mounted?.destroy(); mounted = undefined; mountedType = undefined;
      content.textContent = 'No matches in indexed notes yet.';
      mountedResult = result;
      return;
    }
    const grouping = result.view.groupBy;
    const groupingProperty = grouping && typeof grouping === 'object' && !Array.isArray(grouping) ? (grouping as Record<string, BaseValue>).property : undefined;
    let groupWritable = true; if (typeof groupingProperty === 'string') { try { assertPropertyWritable(groupingProperty); } catch { groupWritable = false; } }
    const moveEnabled = writable && groupWritable && actions.canMove(result);
    if (mounted && mountedType === result.view.type && mountedIndex === selectedIndex && mountedMove === moveEnabled && mountedWritable === writable && mountedDefinitionsRevision === definitionsRevision) mounted.update(result);
    else {
      mounted?.destroy(); mounted = undefined; content.replaceChildren();
      switch (result.view.type) {
        case 'table': mounted = createBaseTableView(content, shared); break;
        case 'cards': mounted = createBaseCardsView(content, { ...shared, loadThumbnail: options.loadThumbnail }); break;
        case 'list': mounted = createBaseListView(content, shared); break;
        case 'kanban': mounted = createBaseKanbanView(content, { ...shared, loadThumbnail: options.loadThumbnail, onError: report, onPresentationError: report,
          readOnly: !writable, showColumnControls: false,
          ...(moveEnabled ? { requestMove: request => track(() => { assertPropertyWritable(request.property); return actions.requestMove(request); }) } : {}),
          ...(writable ? { requestGroupOrder: request => track(() => actions.requestGroupOrder(request)), createItem: request => track(() => { if (request.version !== controller.state.version) throw new Error('The base result is stale'); return createItem({ property: request.property, value: baseEditValue(request.group) }, (request as typeof request & { anchor?: HTMLElement }).anchor ?? content); }) } : {}),
        }); break;
        default: content.textContent = `Unsupported base view: ${result.view.type}`;
      }
      mountedType = result.view.type; mountedIndex = selectedIndex; mountedMove = moveEnabled; mountedWritable = writable;
    }
    mountedResult = result; mountedDefinitionsRevision = definitionsRevision; renderStatus(state);
  }
  const observer = win?.MutationObserver ? new win.MutationObserver(schedule) : undefined;
  observer?.observe(content, { subtree: true, childList: true });
  async function selectView(index: number): Promise<void> {
    action();
    if (pending.size || activeDraft()) throw new Error('Finish or cancel the property edit before switching views');
    const views = BaseDocument.parse(controller.state.source).views;
    if (!Number.isInteger(index) || index < 0 || index >= views.length) throw new Error('The selected base view does not exist');
    await controller.setView(index);
    if (!controller.state.error) selectedIndex = controller.selectedViewIndex;
  }

  async function settle(): Promise<void> {
    await Promise.allSettled([...pending]);
    // Let property widgets finish handling their accepted/rejected operations.
    await Promise.resolve();
    const acknowledgement = [...changedBuffers].some(buffer => buffer.path === options.basePath && (buffer.dirty || buffer.error)) ? toolbarUI.captureSaveAcknowledgement() : undefined;
    for (const buffer of changedBuffers) await buffer.flush();
    acknowledgement?.();
    releaseCleanBuffers();
    if (creation?.status === 'uncertain') throw new Error('The new note creation is uncertain. Use New again to reconcile it before leaving this base.');
    if (activeDraft()) throw new Error('Finish or cancel the property edit before leaving this base');
  }
  async function finish(close: boolean): Promise<void> {
    if (disposed) return;
    if (closing) throw new Error('This base view is already finishing edits');
    closing = true;
    try {
      await settle();
      if (close) {
        toolbarUI.destroy(); settings.destroy(); stopDefinitions.forEach(stop => stop()); mounted?.destroy(); mounted = undefined; observer?.disconnect();
        if (scheduled !== undefined) clearTimeout(scheduled);
        controller.dispose(); disposed = true; root.remove();
      }
    } catch (error) { report(error); throw error; }
    finally { closing = false; }
  }
  const stopDefinitions = (['create', 'modify', 'rename', 'delete'] as const).map(event => options.vault.on(event, change => {
    if (change.path === BASE_PROPERTY_DEFINITIONS_PATH || change.oldPath === BASE_PROPERTY_DEFINITIONS_PATH) void loadDefinitions().catch(report);
  }));
  return {
    ready: loadDefinitions().then(() => controller.refresh()),
    get state() { return controller.state; },
    refresh: () => controller.refresh(),
    selectView,
    setCurrentFile: path => { action(); return controller.setCurrentFilePath(path); },
    hasPendingChanges: () => !disposed && (!!pending.size || creation?.status === 'uncertain' || activeDraft() || [...changedBuffers].some(buffer => buffer.dirty || !!buffer.error)),
    flush: () => finish(false),
    close: () => finish(true),
  };
}
