import { BaseController, createBaseMutationHost } from './controller.ts';
import { createBasePropertyDefinitionSaver } from './property-definition-save.ts';
import type { BaseBufferHost, BaseControllerState, BaseViewRenamed } from './controller.ts';
import { BaseDocument } from './document.ts';
import { sharedBaseCoverage, sharedBasePreview, sharedBaseWitness } from './shared-query.ts';
import { createBaseClockHost } from './clock.ts';
import type { BaseClockHost } from './clock.ts';
import { BaseToolbarSaveError, createBaseToolbar } from './toolbar.ts';
import type { BaseFilterOperandsSnapshot, BaseFilterPropertyDescriptor } from './toolbar.ts';
import { createBaseViewActions } from './view-actions.ts';
import { createBaseTableView } from './table-view.ts';
import { baseEditAdmissionReceipt } from './edit-admission-diagnostics.ts';
import { createBaseCardsView } from './cards-view.ts';
import type { BaseCardsViewOptions } from './cards-view.ts';
import { createBaseListView } from './list-view.ts';
import { createBaseKanbanView } from './kanban-view.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryOptions, BaseQueryResult, BaseQueryGroup } from './query.ts';
import type { Vault } from '../core/vault.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';
import { exportBaseResults } from './export.ts';
import type { BaseExportFormat } from './export.ts';
import { prepareBaseItemCreation } from './creation.ts';
import type { BaseCreationOperation } from './creation.ts';
import { baseEditablePropertyValue, baseImageSourceValue } from './view-actions.ts';
import type { BaseValue, BaseViewPatch } from './document.ts';
import type { BasePresentationOptions, BasePropertyPresentation } from './presentation-common.ts';
import { createBasePropertyRenderer } from './property-widgets.ts';
import type { BasePropertyWidgetEdit, BasePropertyWidgetAcknowledgement } from './property-widgets.ts';
import { baseValuesEqual } from './expression.ts';
import { icon } from '../ui/icons.ts';
import { enhanceBaseSummaryEditor } from './toolbar-formula-editor.ts';
import type { BaseFormulaEditor } from './toolbar-formula-editor.ts';
import type { BaseRelationTarget } from './property-widgets.ts';
import { BASE_PROPERTY_DEFINITIONS_PATH, BASE_PROPERTY_TYPES, basePropertyName, parseBasePropertyDefinitions, parseBasePropertyInput, inferBasePropertyDefinition, basePropertyValueDiagnostic } from './property-definitions.ts';
import type { BasePropertyDefinition, BasePropertyDefinitions, BasePropertyType } from './property-definitions.ts';
import { createBasePropertySettingsPanel } from './property-settings-panel.ts';

const unavailableFilterOperands = Object.freeze({ files: Object.freeze([]), folders: Object.freeze([]), tags: Object.freeze([]), properties: Object.freeze([]), metadataStatus: 'unavailable' as const });

/** Suggestions are copied display facts, never a second query or metadata index. */
export function baseSessionFilterOperands(vault: Vault, definitions: BasePropertyDefinitions, knownProperties: readonly string[], isCurrent: () => boolean): BaseFilterOperandsSnapshot {
  if (!isCurrent()) return unavailableFilterOperands;
  const files: string[] = [], folders = new Set(['/']), properties = new Set(Object.keys(definitions.properties)), tags = new Set<string>();
  for (const entry of vault.entries.values()) {
    if (entry.type === 'file') files.push(entry.path);
    else if (entry.type === 'folder') folders.add(entry.path || '/');
  }
  for (const property of knownProperties) if (property.startsWith('note.') && property.length > 5) properties.add(property.slice(5));
  const state = vault.metadataFrame, frame = state?.frame;
  let metadataStatus: NonNullable<BaseFilterOperandsSnapshot['metadataStatus']> = state?.status ?? 'unavailable';
  if (frame) {
    if (!frame.coverageComplete && metadataStatus === 'current') metadataStatus = 'stale';
    if (metadataStatus === 'current' && files.some(path => {
      const item = frame.row(path), live = vault.entries.get(path);
      return item?.kind !== 'file' || item.value.entry.id !== live?.entryId || item.value.entry.revision !== live?.revision;
    })) metadataStatus = 'stale';
    for (const [path, witnessed] of frame.entries()) {
      if (witnessed.kind !== 'file') continue;
      const live = vault.entries.get(path);
      if (!live || live.type !== 'file' || live.entryId !== witnessed.id || live.revision !== witnessed.revision) {
        if (metadataStatus === 'current') metadataStatus = 'stale';
        continue;
      }
      // This cache independently rejects retired or replaced saved witnesses.
      const note = vault.metadata.get(path);
      if (!note) { const item = frame.row(path); if (item?.kind === 'file' && item.value.metadata) metadataStatus = 'unavailable'; continue; }
      for (const tag of note.tags) if (tag) tags.add(tag);
      for (const property of Object.keys(note.frontmatter)) properties.add(property);
    }
  } else if (metadataStatus === 'current') metadataStatus = 'unavailable';
  if (!isCurrent() || vault.metadataFrame !== state) return unavailableFilterOperands;
  return Object.freeze({ files: Object.freeze(files.sort()), folders: Object.freeze([...folders].sort()), tags: Object.freeze([...tags].sort()), properties: Object.freeze([...properties].sort()), metadataStatus });
}

const unavailableFilterProperty: BaseFilterPropertyDescriptor = Object.freeze({ kind: 'unknown', metadataStatus: 'unavailable' });

/** Captured editor categories, not a promise that every row has that runtime type.
 * Only saved declarations or consistently witnessed Rust metadata supply them. */
export function baseSessionFilterProperties(vault: Vault, definitions: BasePropertyDefinitions, knownProperties: readonly string[], isCurrent: () => boolean): Readonly<Record<string, BaseFilterPropertyDescriptor>> {
  const result: Record<string, BaseFilterPropertyDescriptor> = Object.create(null);
  if (!isCurrent()) return Object.freeze(result);
  const state = vault.metadataFrame, frame = state?.frame;
  let metadataStatus: NonNullable<BaseFilterPropertyDescriptor['metadataStatus']> = state?.status ?? 'unavailable';
  const categories = new Map<string, string>();
  if (frame) {
    if (!frame.coverageComplete && metadataStatus === 'current') metadataStatus = 'stale';
    for (const entry of vault.entries.values()) {
      if (entry.type !== 'file') continue;
      const row = frame.row(entry.path);
      if (row?.kind !== 'file' || row.value.entry.id !== entry.entryId || row.value.entry.revision !== entry.revision) {
        if (metadataStatus === 'current') metadataStatus = 'stale';
      }
    }
    for (const [path, witnessed] of frame.entries()) {
      if (witnessed.kind !== 'file') continue;
      const live = vault.entries.get(path), row = frame.row(path);
      if (!live || live.type !== 'file' || live.entryId !== witnessed.id || live.revision !== witnessed.revision) {
        if (metadataStatus === 'current') metadataStatus = 'stale';
        continue;
      }
      // Historical frame rows alone cannot bypass retirement/cache admission.
      if (!vault.metadata.get(path)) {
        if (row?.kind === 'file' && row.value.metadata) metadataStatus = 'unavailable';
        continue;
      }
      if (row?.kind !== 'file') continue;
      for (const property of row.value.metadata?.properties ?? []) {
        const previous = categories.get(property.key);
        categories.set(property.key, previous === undefined || previous === property.type ? property.type : 'unknown');
      }
    }
  } else if (metadataStatus === 'current') metadataStatus = 'unavailable';
  const metadataKinds: Readonly<Record<string, BaseFilterPropertyDescriptor['kind']>> = {
    text: 'string', number: 'number', checkbox: 'boolean', date: 'date', datetime: 'date', list: 'list', tags: 'tagList', unknown: 'unknown',
  };
  const unknown: BaseFilterPropertyDescriptor = Object.freeze({ kind: 'unknown', metadataStatus });
  for (const property of knownProperties) if (property.startsWith('note.') || property.startsWith('formula.')) result[property] = unknown;
  for (const [property, category] of categories) result[`note.${property}`] = Object.freeze({
    kind: metadataStatus === 'current' ? metadataKinds[category] ?? 'unknown' : 'unknown', metadataStatus,
    ...(metadataStatus === 'current' && (category === 'date' || category === 'datetime') ? { withTime: category === 'datetime' } : {}),
  });
  for (const [property, definition] of Object.entries(definitions.properties)) {
    let kind: BaseFilterPropertyDescriptor['kind'];
    switch (definition.type) {
      case 'text': case 'select': case 'status': kind = 'string'; break;
      case 'number': kind = 'number'; break;
      case 'checkbox': kind = 'boolean'; break;
      case 'date': case 'datetime': kind = 'date'; break;
      case 'list': case 'multiselect': case 'reverseRelation': kind = 'list'; break;
      case 'tags': kind = 'tagList'; break;
      case 'link': kind = 'link'; break;
      case 'relation': kind = definition.relation?.multiple ? 'list' : 'link'; break;
      default: kind = 'unknown';
    }
    result[`note.${property}`] = Object.freeze({ kind, metadataStatus,
      ...(definition.type === 'date' || definition.type === 'datetime' ? { withTime: definition.type === 'datetime' } : {}),
      ...(['select', 'multiselect', 'status'].includes(definition.type) && definition.options ? { choices: Object.freeze(definition.options.map(option => Object.freeze({ value: option.value, ...(option.label !== undefined ? { label: option.label } : {}), ...(option.color !== undefined ? { color: option.color } : {}) }))) } : {}),
    });
  }
  // Invalid declarations do not acquire a replacement category from note values.
  for (const diagnostic of definitions.diagnostics) if (diagnostic.property !== undefined) result[`note.${diagnostic.property}`] = unknown;
  if (!isCurrent() || vault.metadataFrame !== state) return Object.freeze(Object.create(null));
  return Object.freeze(result);
}

/** Status wrappers may change during a hint without replacing saved facts.
 * Retain the advisory snapshot across those phases, never across new witnesses. */
export function baseSessionFilterPropertyProvider(vault: Vault, definitions: BasePropertyDefinitions, knownProperties: readonly string[], isCurrent: () => boolean): (property: string) => BaseFilterPropertyDescriptor | undefined {
  const captured = vault.metadataFrame, frame = captured?.frame;
  let validated = captured, properties: Readonly<Record<string, BaseFilterPropertyDescriptor>> | undefined, propertiesStatus = captured?.status;
  return property => {
    const current = vault.metadataFrame;
    if (!isCurrent() || vault.isMetadataRetired || current?.frame !== frame || current?.status === 'unavailable' && captured?.status !== 'unavailable') return unavailableFilterProperty;
    if (frame && current !== validated) {
      for (const entry of vault.entries.values()) {
        if (entry.type !== 'file') continue;
        const row = frame.row(entry.path);
        if (row?.kind !== 'file' || row.value.entry.id !== entry.entryId || row.value.entry.revision !== entry.revision) return unavailableFilterProperty;
      }
      for (const [path, witnessed] of frame.entries()) {
        if (witnessed.kind !== 'file') continue;
        const live = vault.entries.get(path), row = frame.row(path);
        if (!live || live.entryId !== witnessed.id || live.revision !== witnessed.revision || row?.kind === 'file' && row.value.metadata && !vault.metadata.get(path)) return unavailableFilterProperty;
      }
      if (!isCurrent() || vault.metadataFrame !== current) return unavailableFilterProperty;
      validated = current;
    }
    // A first lookup during the transient stale phase must not permanently
    // cache an incomplete category before the same-frame current delivery.
    if (!properties && captured?.status === 'current' && current?.status !== 'current') return unavailableFilterProperty;
    if (!properties || propertiesStatus !== 'current' && current?.status === 'current') {
      properties = baseSessionFilterProperties(vault, definitions, knownProperties, isCurrent);
      propertiesStatus = current?.status;
    }
    return properties[property];
  };
}

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
    /** Capture only the host's exact failed persistence attempt, never replay a configuration command. */
    captureSaveRetry?(): (() => Promise<void>) | undefined;
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
  /** Rebind an existing named embed after its new name is durably saved. */
  readonly onViewRenamed?: (event: BaseViewRenamed) => void;
  readonly closeCreatedFile?: () => boolean | Promise<boolean>;
  readonly openCreatedFile?: (path: string, event: MouseEvent | KeyboardEvent, anchor?: HTMLElement) => void | Promise<void>;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent, witness?: { readonly entryId: string; readonly revision: string }) => void;
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
  /** Passive saved-name transition for sibling embeds; retains all drafts. */
  rebindViewName(from: string, to: string): boolean;
  /** Workspace preflight: retain the mounted view while settling accepted edits. */
  flush(): Promise<void>;
  hasPendingChanges(): boolean;
  /** Lifecycle-owned portals may be outside the session's DOM root. */
  owns?(node: Node): boolean;
  /** Retains UI/controller on failure; callers must not silently discard this rejection. */
  close(): Promise<void>;
}
interface MountedView {
  update(result: BaseQueryResult): void;
  destroy(): void;
  hasActiveEdits?(): boolean;
  hasQueuedConfiguration?(): boolean;
  openSummaryPicker?(property: string, anchor: HTMLElement, groupIndex?: number | null): void;
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
  let mountedResult: BaseQueryResult | undefined, renderingResult: BaseQueryResult | undefined, deferred: BaseControllerState | undefined;
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
  let summaryDraft = false, destroySummaryEditor: (() => void) | undefined;
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
  let configurationLifecycle = 0;
  const canBeginPropertyEdit = () => !disposed && !closing && !configurationLifecycle && !pending.size && !mounted?.hasQueuedConfiguration?.() && !mounted?.hasActiveEdits?.() && controller.canBeginPropertyEdit;
  const alive = () => { options.validate(); if (disposed) throw new Error('This base view is closed'); };
  const action = () => { alive(); if (closing) throw new Error('This base view is closing'); notice = undefined; };
  const report = (error: unknown) => {
    if (!disposed) {
      status.textContent = error instanceof Error ? error.message : String(error);
      const receipt = baseEditAdmissionReceipt(error); if (receipt) root.dataset.baseLastEditRejection = JSON.stringify(receipt);
    }
    try { options.onError?.(error); } catch { /* User error reporters do not change persistence. */ }
  };
  const propertyDraft = () => !!mounted?.hasActiveEdits?.() || !!content.querySelector('.zorid-bases-table-input, [data-base-editing]');
  const activeDraft = () => propertyDraft() || toolbarUI.hasDraft() || settings.hasDraft() || summaryDraft;
  const schedule = () => {
    if (disposed || scheduled !== undefined) return;
    scheduled = setTimeout(() => { scheduled = undefined; if (deferred && !pending.size && !activeDraft()) { deferred = undefined; render(controller.state); } }, 0);
  };
  const releaseCleanBuffers = () => { for (const buffer of changedBuffers) if (!buffer.dirty && !buffer.error) changedBuffers.delete(buffer); };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    action();
    const promise = operation(); pending.add(promise); renderStatus(controller.state);
    const settled = () => {
      pending.delete(promise);
      releaseCleanBuffers();
      renderStatus(controller.state); schedule();
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
  const propertyDefinitionSaver = createBasePropertyDefinitionSaver();
  const hostClock = options.clock ?? createBaseClockHost({ document: doc, window: win });
  const clock: BaseClockHost = {
    capture: zone => hostClock.capture(zone), scheduleAt: (deadline, callback) => hostClock.scheduleAt(deadline, callback),
    isVisible: () => hostClock.isVisible() && (options.visibility?.isVisible() ?? true),
    subscribeWake(callback) {
      const wake = () => { callback(); renderStatus(controller.state); };
      const stopClock = hostClock.subscribeWake(wake), stopPane = options.visibility?.subscribe(wake);
      return () => { stopClock(); stopPane?.(); };
    },
  };
  const controller = new BaseController({ vault: options.vault, basePath: options.basePath, mutations, query, clock, viewName: options.viewName, ...(options.inlineSource ? { inlineSource: options.inlineSource } : {}),
    onViewRenamed: options.onViewRenamed,
    onChange(state) { render(state); options.onState?.(state); },
  });
  const actions = createBaseViewActions(controller, { validate: action, canRename: !!options.buffers?.rename,
    isGroupListProperty(property) { const definition = definitions.properties[basePropertyName(property)]; return !!definition && (['list', 'tags', 'multiselect'].includes(definition.type) || definition.type === 'relation' && !!definition.relation?.multiple); },
    validateFolder(path) { if (path && options.vault.entries.get(path)?.type !== 'folder') throw new Error('The destination folder no longer exists'); },
  });
  const settings = createBasePropertySettingsPanel(root, {
    definitions: () => definitions,
    properties: () => controller.state.result?.availableProperties ?? [],
    preflight() { action(); if (options.readOnly) throw new Error('This base is read-only'); if (pending.size || propertyDraft() || toolbarUI.hasDraft() || summaryPanel) throw new Error('Finish or cancel the current edit first.'); },
    save: (property, definition, expected) => track(() => saveDefinition(property, definition, expected)),
    onDraftChange: schedule, onError: report,
  });
  const filterOwnerCurrent = () => {
    if (disposed || closing) return false;
    try { options.validate(); return true; } catch { return false; }
  };
  const toolbarUI = createBaseToolbar(toolbar, {
    immediate: true,
    filterOperands: () => baseSessionFilterOperands(options.vault, definitions, controller.state.result?.availableProperties ?? [], filterOwnerCurrent),
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
      addView: (version, type, name, patch?: BaseViewPatch) => saveConfigurationCommand(() => controller.addView(numericVersion(version), type, name, patch)),
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
    configurationLifecycle++; renderStatus(controller.state);
    let saving: Promise<void>;
    try { saving = track(operation); }
    catch (error) { if (configurationAttempt === attempt) configurationAttempt = undefined; configurationLifecycle--; renderStatus(controller.state); throw error; }
    const command = saving.catch(error => {
      const buffer = attempt.buffer, text = attempt.text;
      const retryInline = options.inlineSource?.captureSaveRetry?.();
      if (retryInline) throw new BaseToolbarSaveError(error instanceof Error ? error.message : String(error), () => track(async () => {
        await retryInline();
        if (!await controller.acknowledgeConfigurationRetry()) throw new Error('The retained inline configuration is no longer pending.');
      }));
      if (controller.hasPendingViewReferences) throw new BaseToolbarSaveError(error instanceof Error ? error.message : String(error), () => track(async () => { await controller.retryViewRenameReferences(); }));
      if (buffer && (buffer.dirty || buffer.error)) throw new BaseToolbarSaveError(error instanceof Error ? error.message : String(error), () => track(async () => {
        if (controller.hasPendingViewReferences) { await controller.retryViewRenameReferences(); return; }
        if (buffer.path !== options.basePath || buffer.text !== text) throw new Error('The retained configuration changed. Save or resolve that draft before retrying.');
        await buffer.flush(); if (!await controller.acknowledgeConfigurationRetry()) await controller.refresh();
      }));
      throw error;
    }).finally(() => { if (configurationAttempt === attempt) configurationAttempt = undefined; configurationLifecycle--; renderStatus(controller.state); schedule(); });
    // Retain the complete configuration continuation without reporting its UI
    // recovery wrapper twice. The original operation/error stays owned by track.
    pending.add(command);
    const settled = () => { pending.delete(command); releaseCleanBuffers(); renderStatus(controller.state); schedule(); };
    void command.then(settled, settled);
    return command;
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
    const registryValidate = () => {alive(); options.buffers!.validate();}; registryValidate();
    if (!options.vault.entries.has(BASE_PROPERTY_DEFINITIONS_PATH)) await options.vault.create(BASE_PROPERTY_DEFINITIONS_PATH, 'properties: {}\n', registryValidate);
    const buffer = await options.buffers.getBuffer(BASE_PROPERTY_DEFINITIONS_PATH); registryValidate();
    await propertyDefinitionSaver.save(buffer, property, definition, expected, registryValidate, previousText => {
      changedBuffers.add(buffer); options.buffers!.onBufferChange?.(BASE_PROPERTY_DEFINITIONS_PATH, buffer, previousText);
    });
    await loadDefinitions();
  }
  const summaryNames = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];
  function summaryScope(anchor: HTMLElement, index?: number | null): number | null {
    if (index !== undefined) return index;
    const value = anchor.dataset.summaryGroup;
    return value !== undefined && value !== 'overall' && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  }
  function addSummary(property: string, anchor: HTMLElement, suggested?: string): void {
    action(); if (options.readOnly || pending.size || activeDraft()) throw new Error('Finish or cancel the current edit first.');
    const state = controller.state, document = BaseDocument.parse(state.source), configured = document.getRoot('summaries');
    const summaries: Record<string, BaseValue> = configured && typeof configured === 'object' && !Array.isArray(configured) ? { ...(configured as Record<string, BaseValue>) } : {};
    const used = new Set([...summaryNames, ...Object.keys(summaries)]), base = suggested?.trim() || 'new summary';
    let name = base; for (let suffix = 2; used.has(name); suffix++) name = `${base} ${suffix}`;
    const raw = state.result?.view.summaries, selection: Record<string, BaseValue> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, BaseValue>) } : {};
    delete selection[basePropertyName(property)]; selection[property] = name;
    // The reference creates a root definition immediately only for a typed name.
    const root = suggested?.trim() ? { summaries: { ...summaries, [name]: '' } } : undefined;
    void saveConfigurationCommand(() => controller.updateConfiguration(state.version, { ...(root ? { root } : {}), view: { summaries: selection } }))
      .then(() => openSummaryEditor(property, anchor, name, summaryScope(anchor))).catch(report);
  }
  function editSummary(property: string, id: string, anchor: HTMLElement, groupIndex?: number | null): void {
    const document = BaseDocument.parse(controller.state.source), raw = document.getRoot('summaries');
    const summaries: Record<string, BaseValue> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, BaseValue>) } : {};
    const scope = summaryScope(anchor, groupIndex);
    if (Object.hasOwn(summaries, id)) { openSummaryEditor(property, anchor, id, scope); return; }
    const active = controller.state.result, rows = scope === null ? active?.rows : active?.groups[scope]?.rows;
    const first = rows?.map(row => row.values[property]).find(value => value && value.type !== 'null');
    const definition = definitions.properties[basePropertyName(property)] ?? (first ? inferBasePropertyDefinition(first) : undefined);
    const dateRange = definition?.type === 'date' || definition?.type === 'datetime' || first?.type === 'date';
    // Functional expression definitions observed in the shipped reference registry.
    const builtins: Record<string, string> = { Average: 'values.mean().round(2)', Min: 'values.min()', Max: 'values.max()', Sum: 'values.sum().round(2)', Range: dateRange ? '(values.latest() - values.earliest())' : 'values.max() - values.min()', Median: 'values.median()', Stddev: 'values.stddev().round(2)', Earliest: 'values.earliest()', Latest: 'values.latest()', Checked: 'values.filter(value == true).length', Unchecked: 'values.filter(value == false).length', Empty: 'values.filter(value.isType("null")).length', Filled: 'values.filter(!value.isType("null")).length', Unique: 'values.unique().length' };
    const expression = builtins[id]; if (!expression) throw new Error('This summary is no longer available.');
    summaries[id] = expression;
    void saveConfigurationCommand(() => controller.updateRoot(controller.state.version, { summaries })).then(() => openSummaryEditor(property, anchor, id, scope)).catch(report);
  }
  function openSummaryEditor(property: string, anchor: HTMLElement, initialName: string, groupIndex: number | null = null): void {
    action(); if (options.readOnly || pending.size || activeDraft()) throw new Error('Finish or cancel the current edit first.');
    destroySummaryEditor?.();
    let expectedSource = controller.state.source, acceptedName = initialName;
    const configured = BaseDocument.parse(expectedSource).getRoot('summaries');
    let acceptedExpression = configured && typeof configured === 'object' && !Array.isArray(configured) && typeof (configured as Record<string, BaseValue>)[initialName] === 'string' ? (configured as Record<string, BaseValue>)[initialName] as string : '';
    const groupKey = groupIndex === null ? undefined : controller.state.result?.groups[groupIndex]?.sharedKeyId;
    const panel = doc.createElement('section'); panel.className = 'bases-toolbar-popover bases-summary-editor'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Edit summary');
    const heading = doc.createElement('h3'), title = doc.createElement('span'); title.textContent = `Edit property ${acceptedName}`;
    const more = doc.createElement('button'); more.type = 'button'; more.className = 'bases-toolbar-menu-next'; more.setAttribute('aria-label', 'Summary actions'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.append(icon('ellipsis-vertical', 16, doc));
    const back = doc.createElement('button'); back.type = 'button'; back.className = 'bases-toolbar-menu-next'; back.setAttribute('aria-label', 'Back to summaries'); back.append(icon('chevron-left', 16, doc)); heading.append(back, title, more);
    const fields = doc.createElement('fieldset'); fields.className = 'bases-toolbar-fields'; fields.style.border = '0'; fields.style.margin = '0';
    const nameLabel = doc.createElement('label'); nameLabel.textContent = 'Summary name';
    const name = doc.createElement('input'); name.setAttribute('aria-label', 'Summary name'); name.value = acceptedName; nameLabel.append(name);
    const expressionLabel = doc.createElement('label'); expressionLabel.textContent = 'Formula';
    const expression = doc.createElement('textarea'); expression.setAttribute('aria-label', 'Summary expression'); expression.placeholder = 'values.reduce( ... )'; expression.value = acceptedExpression; expression.rows = 4;
    const help = doc.createElement('span'); help.textContent = '?'; help.title = 'Use values to calculate over the values in this result group.'; expressionLabel.append(help); fields.append(nameLabel, expressionLabel, expression);
    const menu = doc.createElement('div'); menu.className = 'bases-summary-actions'; menu.hidden = true; menu.setAttribute('role', 'menu');
    const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'bases-toolbar-menu-item mod-warning'; remove.textContent = 'Delete summary'; remove.setAttribute('role', 'menuitem'); menu.append(remove);
    const error = doc.createElement('div'); error.className = 'bases-toolbar-error'; error.setAttribute('role', 'alert');
    const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry save'; retry.hidden = true;
    const cancelChanges = doc.createElement('button'); cancelChanges.type = 'button'; cancelChanges.textContent = 'Cancel changes'; cancelChanges.hidden = true;
    panel.append(heading, fields, menu, error, retry, cancelChanges); doc.body.append(panel); summaryPanel = panel;
    let dirty = false, saving = false, destroyed = false, generation = 0, closeRequest: boolean | undefined, retryPersistence: (() => Promise<void>) | undefined;
    type SummaryAttempt = { name: string; expression: string; source: string; deleted?: boolean };
    let retryAccepted: SummaryAttempt | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let formulaEditor: BaseFormulaEditor | undefined;
    const mark = () => { summaryDraft = dirty || saving || !!retryPersistence; panel.setAttribute('aria-busy', String(saving)); schedule(); };
    const updateDirty = () => { dirty = name.value.trim() !== acceptedName || expression.value !== acceptedExpression; mark(); };
    let anchorBounds = anchor.getBoundingClientRect();
    const place = () => {
      if (destroyed || !panel.isConnected) return;
      if (anchor.isConnected) anchorBounds = anchor.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(anchorBounds.left, (win?.innerWidth ?? 800) - bounds.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(anchorBounds.bottom, (win?.innerHeight ?? 600) - bounds.height - 8))}px`;
    };
    const scroll = (event: Event) => { const target = event.target; if (target && 'nodeType' in target && panel.contains(target as Node)) return; place(); };
    const resize = win?.ResizeObserver ? new win.ResizeObserver(place) : undefined;
    const cleanup = () => { if (destroyed) return; destroyed = true; if (timer) clearTimeout(timer); doc.removeEventListener('pointerdown', outside, true); win?.removeEventListener('resize', place); win?.removeEventListener('scroll', scroll, true); resize?.disconnect(); formulaEditor?.destroy(); panel.remove(); if (summaryPanel === panel) { summaryPanel = undefined; summaryDraft = false; destroySummaryEditor = undefined; } };
    const close = (chooser: boolean) => {
      if (destroyed) return;
      if (saving) { closeRequest = closeRequest === true || chooser; return; }
      if (dirty || retryPersistence) { closeRequest = closeRequest === true || chooser; void save(); return; }
      cleanup(); render(controller.state);
      if (chooser) {
        const currentGroups = controller.state.result?.groups ?? [];
        const index = groupKey === undefined ? groupIndex : currentGroups.findIndex(group => group.sharedKeyId === groupKey);
        if (index !== null && index < 0) report(new Error('This result group changed. Reopen its summary picker from the current group.'));
        else mounted?.openSummaryPicker?.(property, anchor, index);
      } else if (anchor.isConnected) anchor.focus({ preventScroll: true });
      schedule();
    };
    const accept = (next: SummaryAttempt): boolean => {
      if (controller.state.source !== next.source) { fail(new Error('This Base changed before the summary save was acknowledged. Reopen its editor before saving.'), next); return false; }
      acceptedName = next.name; acceptedExpression = next.expression; expectedSource = next.source;
      title.textContent = `Edit property ${acceptedName}`; retryPersistence = undefined; retryAccepted = undefined; retry.hidden = true; cancelChanges.hidden = true; fields.disabled = false; expression.disabled = false; formulaEditor?.sync(); error.textContent = '';
      updateDirty(); if (next.deleted) { dirty = false; mark(); close(true); } else if (closeRequest !== undefined && !dirty) close(closeRequest);
      return true;
    };
    const fail = (failure: unknown, next: SummaryAttempt) => {
      error.textContent = failure instanceof Error ? failure.message : String(failure); dirty = true;
      if (failure instanceof BaseToolbarSaveError) { retryPersistence = failure.retry; retryAccepted = next; retry.hidden = false; fields.disabled = true; expression.disabled = true; formulaEditor?.sync(); } else { retryPersistence = undefined; retryAccepted = undefined; retry.hidden = true; fields.disabled = false; expression.disabled = false; formulaEditor?.sync(); cancelChanges.hidden = false; }
      mark();
    };
    async function save(): Promise<void> {
      if (destroyed || retryPersistence) return; if (saving) return; if (!dirty) { if (closeRequest !== undefined) close(closeRequest); return; }
      if (timer) { clearTimeout(timer); timer = undefined; }
      const next: SummaryAttempt = { name: name.value.trim(), expression: expression.value, source: expectedSource }, submitted = generation;
      if (!next.name) { error.textContent = 'Summary name must not be empty.'; return; }
      if (controller.state.source !== expectedSource) { error.textContent = 'This Base changed while the summary was open. Reopen its editor before saving.'; cancelChanges.hidden = false; return; }
      try { const projected = BaseDocument.parse(expectedSource); projected.editSummary(acceptedName, next.name, next.expression); next.source = projected.toString(); } catch (failure) { fail(failure, next); return; }
      saving = true; mark();
      try { await saveConfigurationCommand(() => controller.editSummary(controller.state.version, acceptedName, next.name, next.expression)); if (!destroyed) { saving = false; if (accept(next) && generation !== submitted && dirty && doc.activeElement !== name) void save(); } }
      catch (failure) { if (!destroyed) { saving = false; fail(failure, next); } }
      finally { saving = false; if (!destroyed) mark(); }
    }
    name.addEventListener('input', () => { generation++; updateDirty(); });
    name.addEventListener('blur', () => { void save(); });
    name.addEventListener('keydown', event => { if (event.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); name.value = acceptedName; updateDirty(); name.blur(); } else if (event.key === 'Enter') { event.preventDefault(); name.blur(); } });
    expression.addEventListener('input', () => { generation++; updateDirty(); if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void save(); }, 250); });
    cancelChanges.addEventListener('click', () => { if (saving || retryPersistence) return; name.value = acceptedName; expression.value = acceptedExpression; dirty = false; mark(); close(true); });
    back.addEventListener('click', () => close(true));
    panel.addEventListener('keydown', event => { if (!event.defaultPrevented && event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(true); } });
    const toggleActions = (open: boolean) => {
      menu.hidden = !open; more.setAttribute('aria-expanded', String(open));
      place(); // Revealing actions changes the measured height near the viewport bottom.
      (open ? remove : more).focus({ preventScroll: true });
      if (open) remove.scrollIntoView?.({ block: 'nearest' });
    };
    more.addEventListener('click', () => toggleActions(menu.hidden));
    menu.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); toggleActions(false); } });
    remove.addEventListener('click', () => { if (saving || retryPersistence) return; if (timer) clearTimeout(timer); toggleActions(false);
      const projected = BaseDocument.parse(expectedSource); projected.removeSummary(acceptedName);
      const next: SummaryAttempt = { name: acceptedName, expression: acceptedExpression, deleted: true, source: projected.toString() }; saving = true; fields.disabled = true; expression.disabled = true; formulaEditor?.sync(); mark();
      void saveConfigurationCommand(() => { if (controller.state.source !== expectedSource) throw new Error('This Base changed while the summary was open.'); return controller.removeSummary(controller.state.version, acceptedName); }).then(() => { saving = false; accept(next); }, failure => { saving = false; fields.disabled = false; expression.disabled = false; formulaEditor?.sync(); fail(failure, next); });
    });
    retry.addEventListener('click', () => { if (!retryPersistence || !retryAccepted || saving) return; saving = true; mark(); const operation = retryPersistence, next = retryAccepted;
      void track(operation).then(() => { saving = false; if (accept(next) && dirty && doc.activeElement !== name) void save(); }, failure => { saving = false; fail(failure, next); });
    });
    const outside = (event: Event) => { if (!panel.contains(event.target as Node)) close(false); };
    doc.addEventListener('pointerdown', outside, true); win?.addEventListener('resize', place); win?.addEventListener('scroll', scroll, true); resize?.observe(panel); destroySummaryEditor = cleanup;
    try { formulaEditor = enhanceBaseSummaryEditor(expression, { onEscape: () => close(true), onCommit: () => { void save(); } }); } catch (failure) { cleanup(); throw failure; }
    place(); name.focus(); name.select(); mark();
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
    if (disposed) return;
    root.dataset.baseControllerVersion = String(state.version);
    root.dataset.baseControllerUpdating = String(!!state.updating);
    root.dataset.baseControllerError = String(!!state.error);
    const configurationBusy = !!configurationLifecycle || !!mounted?.hasQueuedConfiguration?.();
    const admissionBusy = configurationBusy || !!pending.size || (!state.error && !controller.canBeginPropertyEdit);
    content.setAttribute('aria-busy', String(admissionBusy));
    for (const element of content.querySelectorAll<HTMLElement>('[data-base-property-editable], [role="gridcell"][aria-readonly="false"]')) {
      if (element.hasAttribute('data-base-editing') || element.querySelector('[data-base-editing]')) continue;
      element.setAttribute('aria-disabled', String(!canBeginPropertyEdit()));
      for (const checkbox of element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.disabled = !canBeginPropertyEdit();
    }
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
    if (configurationBusy) { status.textContent = 'Saving view…'; return; }
    if (state.updating || !controller.canBeginPropertyEdit) { status.textContent = state.result ? 'Updating…' : 'Loading saved results…'; return; }
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
    const filterProperty = baseSessionFilterPropertyProvider(options.vault, definitions, result.availableProperties, () => filterOwnerCurrent() && !definitionsError);
    toolbarUI.update({ result, views: choices, selectedIndex, rootFilters: document.getRoot('filters'), root: Object.fromEntries(['filters','formulas','properties','summaries','newItemFolder','newItemTemplate'].map(key => [key, document.getRoot(key)]).filter((entry): entry is [string, BaseValue] => entry[1] !== undefined)), readOnly: !writable, allowRename: true, propertyType: property => definitions.properties[basePropertyName(property)]?.type,
      filterProperty, label: getPropertyLabel });
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
      const rawValue = baseEditablePropertyValue(row, original.property), expectedValue = savedValue ?? baseEditablePropertyValue(original.row, original.property);
      // Only our exact saved shape can acknowledge an editor's next baseline.
      if (!rawValue || !expectedValue || !baseValuesEqual(rawValue, expectedValue)) return;
      const oldBase = sharedBaseWitness(before, options.basePath), newBase = sharedBaseWitness(latest, options.basePath);
      if (!oldBase || !newBase || oldBase.entryId !== newBase.entryId) return;
      rememberWidgetResult(latest, controller.state.source);
      return { version: latest.version, row, value };
    };
    const openResultFile = (path: string, event: MouseEvent | KeyboardEvent, witness?: { readonly entryId: string; readonly revision: string }) => {
      try {
        action();
        const active = renderingResult ?? mountedResult ?? result, row = active.rows.find(row => row.path === path);
        const captured = row ? sharedBaseWitness(active, row.path) : undefined;
        options.openFile(path, event, witness ?? captured);
      } catch (error) { report(error); }
    };
    const getRelationTargets = (property: string, presentation: BasePropertyPresentation): readonly BaseRelationTarget[] | undefined => {
      const captured = widgetResults.get(presentation.version), current = controller.state;
      if (disposed || !captured || sharedBasePreview(captured)) return;
      if (options.getRelationTargets) return options.getRelationTargets(property, presentation);
      if (!captured.shared || !captured.shared.relationshipsAvailable || current.error || current.updating || current.result !== captured || current.version !== presentation.version || !captured.rows.includes(presentation.row)) return;
      const actor = options.vault.entries.get(presentation.row.path), witness = sharedBaseWitness(captured, presentation.row.path);
      if (!actor || !witness || actor.entryId !== witness.entryId || actor.revision !== witness.revision) return;
      const targets = captured.relationTargets?.[basePropertyName(property)];
      if (!targets) return;
      // Identity checks invalidate advice; they never resolve or filter targets.
      for (const target of targets) {
        const entry = options.vault.entries.get(target.path);
        if (!entry || entry.entryId !== target.entryId || entry.revision !== target.revision) return;
      }
      return targets;
    };
    const shared = { result, canBeginPropertyEdit, getEditableValue: baseEditablePropertyValue, getPropertyLabel, getPropertyType: (property: string) => definitions.properties[basePropertyName(property)]?.type,
      openFile: openResultFile,
      ...(writable ? { editProperty: (edit: Parameters<typeof actions.editProperty>[0]) => track(() => { assertPropertyWritable(edit.property, edit.value); return actions.editProperty(edit); }) } : {}),
      onError: report, onEditStateChange: () => { renderStatus(controller.state); schedule(); },
      contextMenu: options.contextMenu, hoverFile: options.hoverFile, dragFile: options.dragFile,
      renderProperty: createBasePropertyRenderer({ canBegin: canBeginPropertyEdit, getEditableValue: presentation => baseEditablePropertyValue(presentation.row, presentation.property), getDefinition: property => definitions.properties[basePropertyName(property)],
        commit: (edit: BasePropertyWidgetEdit) => track(async () => { assertPropertyWritable(edit.property, edit.value); await actions.editProperty(edit); return acknowledgeWidget(edit, edit.value); }), readOnly: presentation => !writable || !!definitionsError || definitions.diagnostics.some(item => item.property === basePropertyName(presentation.property)),
        isCurrent: presentation => !disposed && !!mountedResult && widgetResults.has(presentation.version),
        getRelationTargets,
        loadImage: options.loadThumbnail ? (source, signal, presentation) => options.loadThumbnail!({ row: presentation.row, property: presentation.property, value: baseImageSourceValue(presentation.value, source), version: presentation.version, signal }) : undefined,
        openFile: openResultFile, onError: report,
        createOption: (property, value, presentation) => track(async () => { const definition = definitions.properties[basePropertyName(property)]; if (!definition) throw new Error('Configure this property first.'); await saveDefinition(basePropertyName(property), { ...definition, options: [...definition.options ?? [], { value }] }, definition); return acknowledgeWidget(presentation); }),
      }),
      getSummary: (property: string, groupIndex: number | null) => {
        const active = renderingResult ?? mountedResult ?? result;
        const summaries = (groupIndex === null ? active : active.groups[groupIndex]) as { summaries?: Readonly<Record<string, import('./expression.ts').BaseExpressionValue>> } | undefined;
        const value = summaries?.summaries?.[property];
        const selection = active.view.summaries;
        const label = selection && typeof selection === 'object' && !Array.isArray(selection) ? (selection as Record<string, BaseValue>)[property] ?? (selection as Record<string, BaseValue>)[basePropertyName(property)] : undefined;
        return value ? { value, ...(typeof label === 'string' ? { label } : {}) } : undefined;
      },
      ...(writable ? {
      requestAddSummary: (property: string, anchor: HTMLElement, name?: string) => addSummary(property, anchor, name),
      requestEditSummary: (property: string, id: string, anchor: HTMLElement, groupIndex?: number | null) => editSummary(property, id, anchor, groupIndex),
      requestHideSummary: (property: string) => track(() => {
        const active = renderingResult ?? mountedResult ?? result, current = active.view.summaries;
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
        const active = renderingResult ?? mountedResult ?? result, group = groupIndex === null ? undefined : active.groups[groupIndex];
        if (groupIndex !== null && !group) throw new Error('This result group changed; reopen its summary picker.');
        const previews = await controller.summaryPreviews(property, group?.sharedKeyId ?? undefined);
        const custom = BaseDocument.parse(controller.state.source).getRoot('summaries');
        const order = [...new Set(['Empty', 'Filled', 'Unique', 'Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', ...Object.keys(custom && typeof custom === 'object' && !Array.isArray(custom) ? custom : {})])];
        return order.filter(id => Object.hasOwn(previews, id)).map(id => ({ id, label: id, preview: previews[id] }));
      },
      summaryOptions: [...new Set(['Average','Min','Max','Sum','Range','Median','Stddev','Earliest','Latest','Checked','Unchecked','Empty','Filled','Unique', ...Object.keys((document.getRoot('summaries') as Record<string, BaseValue>) ?? {})])].map(id => ({ id, label: id })),
      ...(writable ? { requestSummary: (property: string, id: string) => saveConfigurationCommand(() => {
        const active = renderingResult ?? mountedResult ?? result;
        const current = active.view.summaries;
        const selections: Record<string, BaseValue> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, BaseValue>) } : {};
        delete selections[basePropertyName(property)];
        if (id) selections[property] = id; else delete selections[property];
        return controller.updateView(numericVersion(active.version), { summaries: selections });
      }),
      } : {}),
      isPropertyEditable: (property: string) => { try { assertPropertyWritable(property); return writable; } catch { return false; } },
      validatePropertyValue: (value: import('./expression.ts').BaseExpressionValue, property: string) => { assertPropertyWritable(property); return value; },
      parsePropertyInput: (raw: string, property: string, row: import('./query.ts').BaseQueryRow) => parseBasePropertyInput(raw, definitions.properties[basePropertyName(property)] ?? inferBasePropertyDefinition(row.values[property] ?? { type: 'null' }), row.values[property]),
      ...(writable ? {
        ...(options.deleteFiles ? { deleteFiles: (rows: readonly import('./query.ts').BaseQueryRow[]) => track(async () => {
          const active = renderingResult ?? mountedResult ?? result;
          if (active.version !== controller.state.version) throw new Error('The Base result is stale; refresh before deleting files.');
          await options.deleteFiles!(rows, active);
        }) } : {}),
        editProperties: (edits: readonly import('./table-view.ts').BaseTableEdit[]) => track(() => { edits.forEach(edit => assertPropertyWritable(edit.property)); return actions.editProperties(edits); }),
        patchView: (patch: BaseViewPatch) => saveConfigurationCommand(() => controller.updateView(numericVersion(mountedResult?.version ?? result.version), patch)),
        onConfigurationSettled: () => {
          if (disposed) return;
          const state = controller.state; if (!closing) render(state);
          if (!state.error && !state.updating && mountedResult === state.result && state.result) return { result: state.result, entryId: options.vault.entries.get(options.basePath)?.entryId };
        },
        getConfigurationIdentity: () => disposed ? undefined : options.vault.entries.get(options.basePath)?.entryId,
        isConfigurationClosing: () => disposed || closing,
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
    // Retained renderer callbacks must use the incoming snapshot while their
    // synchronous update builds DOM, without adopting it if that update fails.
    renderingResult = result;
    try {
      if (mounted && mountedType === result.view.type && mountedIndex === selectedIndex && mountedMove === moveEnabled && mountedWritable === writable && mountedDefinitionsRevision === definitionsRevision) mounted.update(result);
      else {
        mounted?.destroy(); mounted = undefined; content.replaceChildren();
        switch (result.view.type) {
          case 'table': mounted = createBaseTableView(content, shared); break;
          case 'cards': mounted = createBaseCardsView(content, { ...shared, loadThumbnail: options.loadThumbnail }); break;
          case 'list': mounted = createBaseListView(content, shared); break;
          case 'kanban': mounted = createBaseKanbanView(content, { ...shared, loadThumbnail: options.loadThumbnail, onError: report, onPresentationError: report,
            readOnly: !writable, showColumnControls: false,
            isGroupWritable: (group: BaseQueryGroup) => {
              const active = renderingResult ?? mountedResult ?? result, grouping = active.view.groupBy;
              if (!grouping || typeof grouping !== 'object' || Array.isArray(grouping) || !('property' in grouping) || typeof grouping.property !== 'string') return false;
              const property = normalizeBaseProperty(grouping.property);
              if (property === 'file.folder') return group.key?.type === 'string';
              if (!property.startsWith('note.')) return false;
              try { assertPropertyWritable(property); } catch { return false; }
              if (active.shared === undefined) return true;
              const saved = typeof group.sharedKeyId === 'string' && (active.groups.find(candidate => candidate.sharedKeyId === group.sharedKeyId) ?? active.groupOptions.find(candidate => candidate.listed && candidate.sharedKeyId === group.sharedKeyId));
              return !!saved && 'editKey' in saved && saved.editKey !== undefined;
            },
            ...(moveEnabled ? { requestMove: request => track(() => { assertPropertyWritable(request.property); return actions.requestMove(request); }) } : {}),
            ...(writable ? { requestGroupOrder: request => track(() => actions.requestGroupOrder(request)), createItem: request => track(() => { if (request.version !== controller.state.version) throw new Error('The base result is stale'); return createItem(actions.creationGroup(request), (request as typeof request & { anchor?: HTMLElement }).anchor ?? content); }) } : {}),
          }); break;
          default: content.textContent = `Unsupported base view: ${result.view.type}`;
        }
        mountedType = result.view.type; mountedIndex = selectedIndex; mountedMove = moveEnabled; mountedWritable = writable;
      }
    } finally { renderingResult = undefined; }
    mountedResult = result; mountedDefinitionsRevision = definitionsRevision; renderStatus(state);
  }
  const switchViewKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey || !['PageUp', 'PageDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    try {
      const views = BaseDocument.parse(controller.state.source).views;
      if (!views.length) throw new Error('This Base has no views.');
      const index = (selectedIndex + (event.key === 'PageUp' ? views.length - 1 : 1)) % views.length;
      void selectView(index).then(() => { if (!disposed) { root.tabIndex = -1; root.focus({ preventScroll: true }); } }).catch(report);
    } catch (error) { report(error); }
  };
  root.addEventListener('keydown', switchViewKey, true);
  const observer = win?.MutationObserver ? new win.MutationObserver(schedule) : undefined;
  observer?.observe(content, { subtree: true, childList: true });
  async function selectView(index: number): Promise<void> {
    action();
    if (mounted?.hasQueuedConfiguration?.()) throw new Error('Wait for the queued column width changes before switching views');
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
    const acknowledgesSavedDraft = controller.hasPendingViewReferences || [...changedBuffers].some(buffer => buffer.path === options.basePath && (buffer.dirty || buffer.error));
    const acknowledgement = toolbarUI.captureSaveAcknowledgement();
    // Reference operations own their exact failed note drafts and original
    // witnesses; flushing those buffers independently would invalidate retry.
    if (controller.hasPendingViewReferences) await controller.retryViewRenameReferences();
    for (const buffer of changedBuffers) await buffer.flush();
    const configurationAcknowledged = await controller.acknowledgeConfigurationRetry();
    if (acknowledgesSavedDraft || configurationAcknowledged) acknowledgement();
    releaseCleanBuffers();
    if (creation?.status === 'uncertain') throw new Error('The new note creation is uncertain. Use New again to reconcile it before leaving this base.');
    if (activeDraft()) throw new Error('Finish or cancel the property edit before leaving this base');
  }
  async function finish(close: boolean): Promise<void> {
    if (disposed) return;
    if (closing) throw new Error('This base view is already finishing edits');
    if (mounted?.hasQueuedConfiguration?.()) throw new Error('Wait for the queued column width changes before leaving this base');
    closing = true;
    try {
      await settle();
      if (mounted?.hasQueuedConfiguration?.()) throw new Error('Wait for the queued column width changes before leaving this base');
      if (close) {
        toolbarUI.destroy(); settings.destroy(); destroySummaryEditor?.(); stopDefinitions.forEach(stop => stop()); mounted?.destroy(); mounted = undefined; observer?.disconnect();
        if (scheduled !== undefined) clearTimeout(scheduled);
        root.removeEventListener('keydown', switchViewKey, true); controller.dispose(); disposed = true; root.remove();
      }
    } catch (error) { report(error); throw error; }
    finally { closing = false; renderStatus(controller.state); }
  }
  const stopDefinitions = (['create', 'modify', 'rename', 'delete', 'ready'] as const).map(event => options.vault.on(event, change => {
    renderStatus(controller.state);
    if (change.path === BASE_PROPERTY_DEFINITIONS_PATH || change.oldPath === BASE_PROPERTY_DEFINITIONS_PATH) void loadDefinitions().catch(report);
  }));
  return {
    ready: loadDefinitions().then(() => controller.refresh()),
    get state() { return controller.state; },
    refresh: () => controller.refresh(),
    selectView,
    setCurrentFile: path => { action(); return controller.setCurrentFilePath(path); },
    rebindViewName: (from, to) => { alive(); return controller.rebindViewName(from, to); },
    hasPendingChanges: () => !disposed && (!!pending.size || !!mounted?.hasQueuedConfiguration?.() || controller.hasPendingViewReferences || creation?.status === 'uncertain' || activeDraft() || [...changedBuffers].some(buffer => buffer.dirty || !!buffer.error)),
    owns: node => { try { alive(); return !closing && root.isConnected && toolbarUI.owns(node); } catch { return false; } },
    flush: () => finish(false),
    close: () => finish(true),
  };
}
