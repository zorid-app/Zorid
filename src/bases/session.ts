import { BaseController, createBaseMutationHost } from './controller.ts';
import type { BaseBufferHost, BaseControllerState, BaseViewRenamed, BaseConfigurationRead } from './controller.ts';
import { BaseDocument, baseViewSource, baseViewSetting } from './document.ts';
import type { BaseViewSource,BaseViewConfig } from './document.ts';
import { mountSourceChooser, mountCollectionEditor, mountCollectionPropertyPicker, collectionPropertyDefinitions, collectionValue } from '../databases/collection-ui.ts';
import type { SourceChooser, CollectionEditor } from '../databases/collection-ui.ts';
import {planCollectionEntryCreation} from '../databases/creation.ts';
import {collectionClipboardValue} from '../databases/collection-clipboard.ts';
import {prepareCollectionOptionCreation} from '../databases/collection-option-creation.ts';
import type {CollectionOptionCreation} from '../databases/collection-option-creation.ts';
import type { DatabaseCollection, DatabaseEntry, DatabaseRequest, DatabaseResponse } from '../core/databases.ts';
import { sharedBaseCoverage, sharedBasePreview, sharedBaseWitness } from './shared-query.ts';
import { createBaseClockHost } from './clock.ts';
import type { BaseClockHost } from './clock.ts';
import { BaseToolbarSaveError, createBaseToolbar } from './toolbar.ts';
import { mountBaseTooltips } from './tooltips.ts';
import type { BaseFilterOperandsSnapshot, BaseFilterPropertyDescriptor, BaseToolbarState } from './toolbar.ts';
import { createBaseViewActions } from './view-actions.ts';
import { createBaseTableView } from './table-view.ts';
import type { BaseTableRawDraft } from './table-view.ts';
import { baseEditAdmissionReceipt } from './edit-admission-diagnostics.ts';
import { createBaseCardsView } from './cards-view.ts';
import type { BaseCardsViewOptions } from './cards-view.ts';
import { createBaseListView } from './list-view.ts';
import { createBaseKanbanView } from './kanban-view.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryOptions, BaseQueryResult, BaseQueryGroup } from './query.ts';
import type { Vault } from '../core/vault.ts';
import type { CommittedMetadataState } from '../core/committed-metadata-frame.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';
import { exportBaseResults } from './export.ts';
import type { BaseExportFormat } from './export.ts';
import { prepareBaseItemCreation } from './creation.ts';
import type { BaseCreationOperation } from './creation.ts';
import { baseEditablePropertyValue, baseImageSourceValue, baseEditValue, baseGroupWriteValue } from './view-actions.ts';
import type { BaseValue, BaseViewPatch } from './document.ts';
import type { BasePresentationOptions, BasePropertyPresentation } from './presentation-common.ts';
import { createBasePropertyRenderer, basePropertyEditRecovery,canCaptureBasePropertyRawDraft,captureBasePropertyRawDraft,restoreBasePropertyRawDraft } from './property-widgets.ts';
import type { BasePropertyWidgetEdit, BasePropertyWidgetAcknowledgement, BasePropertyEditorCompletionIntent, BasePropertyEditRecovery, BasePropertyRawDraft } from './property-widgets.ts';
import { baseValuesEqual, baseExpressionValue } from './expression.ts';
import { icon } from '../ui/icons.ts';
import { enhanceBaseSummaryEditor } from './toolbar-formula-editor.ts';
import type { BaseFormulaEditor } from './toolbar-formula-editor.ts';
import type { BaseRelationTarget } from './property-widgets.ts';
import { basePropertyName, parseBasePropertyInput, inferBasePropertyDefinition, basePropertyValueDiagnostic } from './property-definitions.ts';
import type { BasePropertyDefinition, BasePropertyDefinitions } from './property-definitions.ts';

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
export interface BaseSourceUnavailable { readonly kind:'collection-in-trash'; readonly collectionId:string; readonly message:string }
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
  readonly viewId?: string;
  /** Rebind an existing named embed after its new name is durably saved. */
  readonly onViewRenamed?: (event: BaseViewRenamed) => void;
  readonly closeCreatedFile?: () => boolean | Promise<boolean>;
  /** False explicitly ends this committed intent without presenting it. A
   * rejected opener retains the exact committed item for another attempt. */
  readonly openCreatedFile?: (path: string, event: MouseEvent | KeyboardEvent, anchor?: HTMLElement, expectedEntryId?:string) => void | boolean | Promise<void|boolean>;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent, witness?: { readonly entryId: string; readonly revision: string }) => void;
  readonly validate: () => void;
  readonly loadThumbnail?: BaseCardsViewOptions['loadThumbnail'];
  readonly onState?: (state: BaseControllerState, unavailable?:BaseSourceUnavailable) => void;
  /** A local draft or accepted edit finished; query refreshes alone do not emit this. */
  readonly onEditsSettled?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly canRecoverDatabaseEntry?: (request: DatabaseRequest & {op:'set_entry'}) => boolean;
  readonly holdRecoverDatabaseEntry?: (request: DatabaseRequest & {op:'set_entry'}) => () => void;
  readonly claimRecoverDatabaseEntry?: (request: DatabaseRequest & {op:'set_entry'}) => () => void;
}
export interface BaseSessionDraftOrigin {
  readonly entryId:string;readonly path:string;readonly revision:string;readonly source:string;readonly viewId?:string;readonly viewIndex:number;
  readonly collectionId?:string;readonly schemaFingerprint?:string;
}
/** Raw controls are presentation custody, never authoring commands or old pin authority. */
export type BaseSessionRawDraft={readonly origin:BaseSessionDraftOrigin;readonly kind:'property';readonly raw:BasePropertyRawDraft}|{readonly origin:BaseSessionDraftOrigin;readonly kind:'table';readonly raw:BaseTableRawDraft};
export interface BaseAdmissionDraftRestore {readonly restored:readonly BaseSessionRawDraft[];readonly pending:readonly BaseSessionRawDraft[];readonly conflicts:readonly {readonly draft:BaseSessionRawDraft;readonly reason:string}[]}
export interface BaseAdmissionRecovery {readonly rawDrafts?:readonly BaseSessionRawDraft[];settle():Promise<void>}
export interface BaseSession {
  readonly ready: Promise<void>;
  readonly state: BaseControllerState;
  refresh(): Promise<void>;
  selectView(index: number): Promise<void>;
  setCurrentFile(path: string | null, expectedEntryId?: string): Promise<void>;
  /** Passive saved-name transition for sibling embeds; retains all drafts. */
  readonly selectedViewIdentity?:string;
  rebindViewName(from: string, to: string, viewId?:string): boolean;
  /** Workspace preflight: retain the mounted view while settling accepted edits. */
  flush(options?: { dismissCleanPanels?: boolean }): Promise<void>;
  hasPendingChanges(): boolean;
  canRecoverAdmission?(): boolean;
  prepareAdmissionRecovery?(): BaseAdmissionRecovery;
  restoreAdmissionDrafts?(drafts:readonly BaseSessionRawDraft[]):Promise<BaseAdmissionDraftRestore>;
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
  dismissCleanPanels?(): void;
  openSummaryPicker?(property: string, anchor: HTMLElement, groupIndex?: number | null): void;
  canCaptureRawDraft?():boolean;
  captureRawDraft?():BaseTableRawDraft|undefined;
  restoreRawDraft?(draft:BaseTableRawDraft):'restored'|'pending'|'conflict';
  rawPropertyElement?(entryId:string,path:string,property:string):HTMLElement|undefined;
  completePropertyEdit?(element: HTMLElement, presentation: BasePropertyPresentation, intent: BasePropertyEditorCompletionIntent): void;
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
  const sourceBar = doc.createElement('div'); sourceBar.className = 'collection-source-bar';
  const sourcePanel = doc.createElement('div'); sourcePanel.className = 'collection-source-panel';
  const unavailableCard=doc.createElement('section');unavailableCard.className='bases-source-unavailable';unavailableCard.setAttribute('aria-label','Collection in Trash');unavailableCard.hidden=true;
  const unavailableMessage=doc.createElement('p'),unavailableActions=doc.createElement('div');unavailableCard.append(unavailableMessage,unavailableActions);
  const restoreRecovery=doc.createElement('div');restoreRecovery.className='collection-restore-recovery';restoreRecovery.hidden=true;
  root.append(sourceBar, toolbar, sourcePanel, unavailableCard, restoreRecovery, content, status); container.append(root);
  const tooltips = mountBaseTooltips(root);
  let disposed = false, closing = false, mounted: MountedView | undefined, mountedType: string | undefined;
  let mountedResult: BaseQueryResult | undefined, renderingResult: BaseQueryResult | undefined, deferred: BaseControllerState | undefined;
  let mountedIndex = -1, mountedMove = false, mountedWritable = false;
  const widgetResults = new Map<string | number, BaseQueryResult>(), widgetSources = new Map<string | number, string>();
  const rememberWidgetResult = (result: BaseQueryResult, source: string) => {
    widgetResults.set(result.version, result); widgetSources.set(result.version, source);
    if(collection&&!collectionVersions.has(result.version))collectionVersions.set(result.version,{collection,entries:new Map(collectionEntries)});
    while (widgetResults.size > 4) { const key = [...widgetResults.keys()].find(key => key !== mountedResult?.version); if (key === undefined) break; widgetResults.delete(key); widgetSources.delete(key);collectionVersions.delete(key); }
  };
  let propertyLabels:unknown;
  let collection: DatabaseCollection | undefined, collectionEntries = new Map<string, DatabaseEntry>();
  let collectionLoad = 0, loadedCollectionId: string | undefined;
  let loadedSourceContext:string|undefined, deletedSourceContext:string|undefined;
  let loadedConfigurationRead:BaseConfigurationRead|undefined,deletedConfigurationRead:BaseConfigurationRead|undefined;
  let pendingCollectionRestore:DatabaseRequest & {op:'restore'}|undefined;
  const configurationSource=()=>controller.configurationRead?.source??controller.state.source;
  const configurationIndex=()=>controller.configurationRead?.viewIndex??controller.selectedViewIndex;
  const sourceContext=()=>JSON.stringify([configurationSource(),configurationIndex(),controller.selectedViewIdentity,controller.configurationRead?.entryId,controller.configurationRead?.revision]);
  let chooser: SourceChooser | undefined, collectionEditor: CollectionEditor | undefined;
  const collectionMutations = new Map<string, DatabaseRequest>();
  type SetEntry=DatabaseRequest & {op:'set_entry'};
  type CollectionAttempt={signature:string;request:SetEntry;collectionId:string;widget?:BasePropertyEditRecovery;release?:()=>void;response?:DatabaseResponse};
  const collectionAttempts=new Map<string,CollectionAttempt>();
  let admissionRecovery:{capsule:BaseAdmissionRecovery;edits:CollectionAttempt[];settled:boolean;settling?:Promise<void>}|undefined;
  let interruptFinish:(()=>void)|undefined;
  let retireDerived!:()=>void;
  const derivedRetirement=new Promise<void>(resolve=>{retireDerived=resolve;});
  const optionCreations = new Map<string,CollectionOptionCreation>();
  const collectionVersions = new Map<string|number,{collection:DatabaseCollection;entries:Map<string,DatabaseEntry>}>();
  let pendingCollectionCreate: DatabaseRequest | undefined;
  type CreationContext={readonly viewId?:string;readonly source:string;readonly viewIndex:number};
  type CreationPhase='submitted'|'committed'|'presented'|'presentation-canceled';
  let pendingCollectionCreateOwner:(CreationContext&{readonly collectionId:string;phase:CreationPhase;entry?:DatabaseEntry})|undefined;
  const databaseService = options.vault.adapter.databases;
  const currentViewSource = (): BaseViewSource => {
    const view = BaseDocument.parse(configurationSource()).views[configurationIndex()];
    return view ? baseViewSource(view) : {kind:'untyped'};
  };
  const collectionMode = () => currentViewSource().kind === 'collection';

  const propertyLabel=(labels:unknown,property:string)=>{
    if(labels&&typeof labels==='object'&&!Array.isArray(labels)){
      const config=(labels as Record<string,unknown>)[property]??(labels as Record<string,unknown>)[property.replace(/^note\./,'')];
      if(config&&typeof config==='object'&&'displayName' in config&&typeof config.displayName==='string')return config.displayName;
    }
    return property==='file.name'||property==='file.file'?'Name':property.startsWith('file.')?property.replace(/^file\./,'file '):property.replace(/^(?:note|formula)\./,'');
  };
  // Presentation survives same-source reloads; this cache never supplies schema,
  // membership or write authority while the actual collection is unavailable.
  let collectionLabelSource:string|undefined;
  let collectionPropertyLabels=new Map<string,string>();
  const getPropertyLabel=(property:string)=>collection?.properties.find(field=>field.id===basePropertyName(property))?.name
    ??(collectionLabelSource===loadedCollectionId?collectionPropertyLabels.get(basePropertyName(property)):undefined)??propertyLabel(propertyLabels,property);
  let definitions: BasePropertyDefinitions = { properties: {}, diagnostics: [] };
  let creation: {readonly operation:BaseCreationOperation;readonly owner:CreationContext;phase:CreationPhase;entry?:{readonly path:string;readonly entryId?:string}} | undefined;
  const unfinishedNoteCreation=()=>!!creation&&(creation.phase==='committed'||creation.operation.status==='uncertain');
  let summaryPanel: HTMLElement | undefined;
  let summaryDraft = false, destroySummaryEditor: (() => void) | undefined;
  let summaryHasRawDraft: (() => boolean) | undefined;
  let definitionEpoch = 0, definitionsRevision = 0, mountedDefinitionsRevision = -1;
  let definitionsLoading = false;
  let definitionsError: string | undefined;
  // A query error is retained internally; only a fresh tombstone paired with
  // the controller's coherent saved configuration changes its presentation.
  const sourceUnavailable=():BaseSourceUnavailable|undefined=>{
    if(definitionsLoading||definitionsError||!collection?.deleted||!deletedConfigurationRead||deletedConfigurationRead!==controller.configurationRead||deletedSourceContext!==sourceContext())return;
    try{const source=currentViewSource();if(source.kind==='collection'&&source.id===loadedCollectionId&&source.id===collection.id)return{kind:'collection-in-trash',collectionId:collection.id,message:'This collection is in Trash. Restore it or choose another source.'};}catch{/* Invalid configuration keeps its ordinary error presentation. */}
  };
  // Entry values/revisions are query data, not a new widget schema. Rebuilding
  // the mounted view for an acknowledged value edit discards its next-cell
  // focus. Membership/write authority still uses the fresh entry map below.
  const collectionPresentation = () => JSON.stringify([loadedCollectionId,collection?.deleted,collection?.properties,definitions,definitionsError]);
  let definitionsPresentation=collectionPresentation();
  let definitionsLoad:{context:string;read:BaseConfigurationRead|undefined;promise:Promise<void>}|undefined;
  const publishDefinitions = () => {const presentation=collectionPresentation();if(presentation!==definitionsPresentation){definitionsPresentation=presentation;definitionsRevision++;}};
  const readDefinitions = async () => {
    if(admissionRecovery)return;
    const source = currentViewSource(), epoch = ++collectionLoad, context=sourceContext();
    loadedSourceContext=context;loadedConfigurationRead=controller.configurationRead;deletedSourceContext=undefined;deletedConfigurationRead=undefined;
    if (source.kind === 'untyped') {
      collectionLabelSource=undefined;collectionPropertyLabels.clear();
      loadedCollectionId = undefined; collection = undefined; collectionEntries.clear();
      definitions = { properties: {}, diagnostics: [] }; definitionsLoading = false; definitionsError = undefined; publishDefinitions();unavailableCard.hidden=true;options.onState?.(controller.state);
      return;
    }
    if(collectionLabelSource!==source.id){collectionLabelSource=source.id;collectionPropertyLabels.clear();}
    loadedCollectionId = source.id; collection=undefined;definitions={properties:{},diagnostics:[]};definitionsLoading = true;unavailableCard.hidden=true;options.onState?.(controller.state);
    try {
      if (!databaseService) throw new Error('Collections are unavailable in this vault.');
      const response = await databaseService.request({op:'get',collectionId:source.id});
      if (disposed || admissionRecovery || epoch !== collectionLoad || context!==sourceContext()) return;
      collection = response.collections.find(item=>item.id===source.id);
      collectionEntries = new Map(response.entries.map(item=>[item.entryId,item]));
      if (!collection) throw new Error('The selected collection is unavailable.');
      collectionPropertyLabels=new Map(collection.properties.map(field=>[field.id,field.name]));
      if(collection.deleted){
        const read=loadedConfigurationRead;
        const saved=options.inlineSource?(await options.inlineSource.read()).source:await options.vault.read(options.basePath);
        BaseDocument.parse(saved);
        const entry=read&&(options.vault.adapter.stat?await options.vault.adapter.stat(read.path):options.vault.entries.get(read.path));
        if(disposed||epoch!==collectionLoad||context!==sourceContext())return;
        if(!read||read!==controller.configurationRead||saved!==read.source||entry?.entryId!==read.entryId||entry.revision!==read.revision)throw new Error('The Base configuration changed. Refresh before changing its source.');
        deletedSourceContext=context;deletedConfigurationRead=loadedConfigurationRead;
      }
      definitions = {properties:collection.deleted?{}:collectionPropertyDefinitions(collection),diagnostics:[]}; definitionsError = undefined;
    } catch (failure) {
      if (disposed || admissionRecovery || epoch !== collectionLoad) return;
      definitions = {properties:{},diagnostics:[]}; definitionsError = failure instanceof Error ? failure.message : String(failure);
    }
    definitionsLoading = false; publishDefinitions();
    render(controller.state);options.onState?.(controller.state,sourceUnavailable());
  };
  const loadDefinitions = () => {
    const context=sourceContext(),read=controller.configurationRead;
    if(definitionsLoad?.context===context&&definitionsLoad.read===read)return definitionsLoad.promise;
    const promise=readDefinitions(),load={context,read,promise};definitionsLoad=load;
    const settled=()=>{if(definitionsLoad===load)definitionsLoad=undefined;};void promise.then(settled,settled);
    return promise;
  };
  let selectedIndex = options.query?.viewIndex ?? 0;
  let notice: string | undefined;
  let actionMessage:string|undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let refreshIndicatorTimer:ReturnType<typeof setTimeout>|undefined,refreshIndicatorVisible=false;
  const pending = new Set<Promise<unknown>>(), changedBuffers = new Set<NoteBuffer>();
  let configurationLifecycle = 0;
  const propertyEditReady = () => !disposed && !closing && !definitionsLoading && !definitionsError && !configurationLifecycle && !pendingCollectionRestore && !pendingCollectionCreate && !unfinishedNoteCreation() && !pending.size && !mounted?.hasQueuedConfiguration?.() && controller.canBeginPropertyEdit;
  const canBeginPropertyEdit = () => propertyEditReady() && !mounted?.hasActiveEdits?.();
  const canRetryPropertyEdit = () => propertyEditReady()&&!toolbarUI.hasDraft()&&!settings.hasDraft()&&!summaryDraft&&!chooser?.hasPendingChanges()&&!collectionEditor?.hasPendingChanges();
  const alive = () => { options.validate(); if (disposed) throw new Error('This base view is closed'); };
  const action = () => { alive(); if (closing) throw new Error('This base view is closing');if(admissionRecovery)throw new Error('This Base is reconnecting; its submitted edits are retained.'); notice = undefined;actionMessage=undefined; };
  const report = (error: unknown) => {
    if (!disposed) {
      actionMessage=error instanceof Error ? error.message : String(error);status.textContent = actionMessage;
      const receipt = baseEditAdmissionReceipt(error); if (receipt) root.dataset.baseLastEditRejection = JSON.stringify(receipt);
    }
    try { options.onError?.(error); } catch { /* User error reporters do not change persistence. */ }
  };
  const propertyDraft = () => !!mounted?.hasActiveEdits?.() || !!content.querySelector('.zorid-bases-table-input, [data-base-editing]');
  const activeDraft = () => !!pendingCollectionRestore || !!pendingCollectionCreate || unfinishedNoteCreation() || propertyDraft() || toolbarUI.hasDraft() || settings.hasDraft() || summaryDraft || !!chooser?.hasPendingChanges() || !!collectionEditor?.hasPendingChanges();
  const editsPending = () => !!pending.size || !!mounted?.hasQueuedConfiguration?.() || controller.hasPendingViewReferences || activeDraft() || !!summaryHasRawDraft?.() || [...changedBuffers].some(buffer => buffer.dirty || !!buffer.error);
  let editsWerePending = false;
  const schedule = () => {
    if (disposed) return;
    if (editsPending()) editsWerePending = true;
    if (scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if(!admissionRecovery)releaseUnownedCollectionAttempts();
      if (deferred && !pending.size && !activeDraft()) { deferred = undefined; render(controller.state); }
      if (!closing && !admissionRecovery && editsWerePending && !editsPending()) { editsWerePending = false; try { options.onEditsSettled?.(); } catch (error) { report(error); } }
    }, 0);
  };
  const releaseCleanBuffers = () => { for (const buffer of changedBuffers) if (!buffer.dirty && !buffer.error) changedBuffers.delete(buffer); };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    action();
    const promise = operation(); pending.add(promise); editsWerePending = true; renderStatus(controller.state);
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
  const controller = new BaseController({ vault: options.vault, basePath: options.basePath, mutations, query, clock, viewName: options.viewName,viewId:options.viewId, ...(options.inlineSource ? { inlineSource: options.inlineSource } : {}),
    onViewRenamed: options.onViewRenamed,
    onChange(state) { render(state); options.onState?.(state,sourceUnavailable()); },
  });
  const actions = createBaseViewActions(controller, { validate: action, canRename: !!options.buffers?.rename,
    isGroupListProperty(property) { const definition = definitions.properties[basePropertyName(property)]; return !!definition && (['list', 'tags', 'multiselect'].includes(definition.type) || definition.type === 'relation' && !!definition.relation?.multiple); },
    validateFolder(path) { if (path && options.vault.entries.get(path)?.type !== 'folder') throw new Error('The destination folder no longer exists'); },
  });
  const settings = { hasDraft: () => false, destroy() {} };
  const filterOwnerCurrent = () => {
    if (disposed || closing || admissionRecovery) return false;
    try { options.validate(); return true; } catch { return false; }
  };
  const layoutDefaults=(patch:BaseViewPatch,existing?:BaseViewConfig):BaseViewPatch=>{
    if(patch.type!=='kanban'||Object.hasOwn(patch,'groupBy')||existing?.groupBy!=null)return patch;
    const status=Object.entries(definitions.properties).find(([,definition])=>definition.type==='status')?.[0];
    return status?{...patch,groupBy:{property:`note.${status}`,direction:'ASC'}}:patch;
  };
  const toolbarUI = createBaseToolbar(toolbar, {
    immediate: true,
    filterOperands: () => baseSessionFilterOperands(options.vault, definitions, controller.state.result?.availableProperties ?? [], filterOwnerCurrent),
    preflight(kind) { action(); if(pendingCollectionRestore)throw new Error('Retry the unfinished Restore before changing this view.'); if((pendingCollectionCreate||unfinishedNoteCreation())&&kind!=='new')throw new Error('Use New again to finish the original entry creation before changing this view.'); if (pending.size || propertyDraft() || settings.hasDraft() || summaryPanel || chooser?.hasPendingChanges() || collectionEditor?.hasPendingChanges()) throw new Error('Finish or cancel the current edit before changing the view.'); },
    selectView,
    save(version, patch) { return saveConfigurationCommand(() => controller.updateView(numericVersion(version), layoutDefaults(patch,BaseDocument.parse(controller.state.source).views[controller.selectedViewIndex]))); },
    saveConfiguration(version, patch) { return saveConfigurationCommand(() => controller.updateConfiguration(numericVersion(version), patch)); },
    commands: {
      updateView: (version, index, patch) => saveConfigurationCommand(() => controller.updateViewAt(numericVersion(version), index, layoutDefaults(patch,BaseDocument.parse(controller.state.source).views[index]))),
      editFormula: (version, originalName, name, expression) => saveConfigurationCommand(() => {
        if (originalName !== undefined) return controller.editFormula(numericVersion(version), originalName, name, expression);
        const state = controller.state, document = BaseDocument.parse(state.source), view = document.views[controller.selectedViewIndex];
        const formulas = baseViewSetting(document,controller.selectedViewIndex,'formulas');
        if (formulas && typeof formulas === 'object' && !Array.isArray(formulas) && Object.hasOwn(formulas, name)) throw new Error('A formula with this name already exists');
        document.setViewFormula(controller.selectedViewIndex,name, expression);
        const order = Array.isArray(view.order) ? [...view.order] : [...state.result?.properties ?? []];
        if (!order.includes(`formula.${name}`)) order.push(`formula.${name}`);
        return controller.updateConfiguration(numericVersion(version), { root: { formulas: baseViewSetting(document,controller.selectedViewIndex,'formulas') }, view: { order } });
      }),
      renameFormula: (version, from, to) => saveConfigurationCommand(() => controller.renameFormula(numericVersion(version), from, to)),
      addView: (version, type, name, patch?: BaseViewPatch) => {
        const source = currentViewSource();
        return saveConfigurationCommand(() => controller.addView(numericVersion(version), type, name, {...layoutDefaults({...patch,type}),source}));
      },
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
    onPropertySettings: property => openCollectionProperties(basePropertyName(property)),
    onEditProperties:()=>openCollectionProperties(),
    onDraftChange: schedule,
    onError: report,
  });
  function closeSourceChooser(): void { chooser?.destroy(); chooser=undefined; }
  function chooseSource(choose:(source:BaseViewSource)=>Promise<void>, cancel=true):Promise<void> {
    action(); if (options.readOnly) return Promise.reject(new Error('This Base is read-only.'));
    if(pendingCollectionRestore||pendingCollectionCreate||unfinishedNoteCreation()||chooser?.hasPendingChanges()||collectionEditor?.hasPendingChanges())return Promise.reject(new Error('Finish or cancel the current collection edit before changing the view source.'));
    closeSourceChooser(); collectionEditor?.destroy(); collectionEditor=undefined;
    return new Promise((resolve,reject)=>{
      chooser=mountSourceChooser(sourcePanel,{service:databaseService,isCurrent:()=>!disposed&&!closing,
        choose:async source=>{await choose(source);closeSourceChooser();await loadDefinitions();if(!disposed)render(controller.state);resolve();},
        ...(cancel?{onCancel:()=>{closeSourceChooser();resolve();}}:{}),onError:report});
    });
  }
  function openCollectionProperties(propertyId?:string,anchor?:HTMLElement):void {
    action();if(options.readOnly||!databaseService||!collection||collection.deleted)throw new Error('This collection is unavailable.');
    if(pendingCollectionRestore||pendingCollectionCreate||unfinishedNoteCreation()||pending.size||propertyDraft()||toolbarUI.hasDraft())throw new Error('Finish editing the current value or retry the unfinished New first.');
    if(collectionEditor){collectionEditor.element.querySelector<HTMLInputElement>('input')?.focus();return;}
    const editingCollection=collection;
    collectionEditor=mountCollectionEditor(sourcePanel,{service:databaseService,collection:editingCollection,entries:[...collectionEntries.values()],propertyId,anchor,
      isCurrent:()=>!disposed&&!closing&&currentViewSource().kind==='collection'&&(currentViewSource() as {id:string}).id===editingCollection.id,
      onSaved:async()=>{await options.vault.reload();await loadDefinitions();await controller.refresh();await loadDefinitions();},
      onClose:()=>{collectionEditor?.destroy();collectionEditor=undefined;schedule();}});
  }
  function addCollectionProperty(anchor:HTMLElement):void {
    action();if(options.readOnly||!databaseService||!collection||collection.deleted)throw new Error('This collection is unavailable.');
    if(pendingCollectionRestore||pendingCollectionCreate||unfinishedNoteCreation()||pending.size||propertyDraft()||toolbarUI.hasDraft()||collectionEditor)throw new Error('Finish editing the current value before adding a property.');
    const editingCollection=collection, previousIds=new Set(collection.properties.map(field=>field.id));
    const editingSource=controller.state.source,editingViewId=controller.selectedViewIdentity,editingIndex=controller.selectedViewIndex;
    const ownerCurrent=()=>!disposed&&!closing&&currentViewSource().kind==='collection'&&(currentViewSource() as {id:string}).id===editingCollection.id;
    const visibilityOwnerCurrent=()=>ownerCurrent()&&controller.state.source===editingSource&&controller.selectedViewIdentity===editingViewId&&controller.selectedViewIndex===editingIndex;
    collectionEditor=mountCollectionPropertyPicker(sourcePanel,{service:databaseService,collection:editingCollection,anchor,
      isCurrent:ownerCurrent,
      onSaved:async saved=>{
        await options.vault.reload();await loadDefinitions();await controller.refresh();await loadDefinitions();
        if(!visibilityOwnerCurrent()){
          notice='Property added. The original view changed; choose its visibility in Settings.';renderStatus(controller.state);return;
        }
        const added=saved.properties.filter(field=>!previousIds.has(field.id));
        const state=controller.state, view=BaseDocument.parse(state.source).views[controller.selectedViewIndex];
        if(added.length&&view&&state.result){
          const order=Array.isArray(view.order)?view.order.filter((id):id is string=>typeof id==='string'):[...state.result.properties];
          for(const field of added){const id=`note.${field.id}`;if(!order.includes(id))order.push(id);}
          await controller.updateView(numericVersion(state.version),{order});
        }
      },
      onClose:()=>{collectionEditor?.destroy();collectionEditor=undefined;schedule();}});
  }
  async function editCollectionProperties(edits:readonly Parameters<typeof actions.editProperty>[0][]):Promise<void> {
    if(pendingCollectionRestore)throw new Error('Retry the unfinished Restore before changing properties.');
    action();if(!databaseService||!collection||collection.deleted||!edits.length)throw new Error('This collection is unavailable.');
    const version=edits[0].version,captured=collectionVersions.get(version),result=widgetResults.get(version);
    if(!captured||!result||widgetSources.get(version)!==controller.state.source||captured.collection.id!==collection.id)throw new Error('This collection view changed. Refresh before editing.');
    const batches=new Map<string,{entry:DatabaseEntry;values:Record<string,string|number|boolean|null|string[]>}>();
    for(const edit of edits){
      if(edit.version!==version)throw new Error('The edited cells belong to different view snapshots.');
      const row=result.rows.find(row=>row.path===edit.path),entry=row?.entryId?captured.entries.get(row.entryId):undefined,fieldId=basePropertyName(edit.property);
      if(!entry||entry.deleted||entry.collectionId!==captured.collection.id||!captured.collection.properties.some(field=>field.id===fieldId))throw new Error('The collection entry changed. Refresh before editing.');
      const next=collectionValue(baseEditValue(edit.value));let batch=batches.get(entry.entryId);
      if(!batch){batch={entry,values:{}};batches.set(entry.entryId,batch);}batch.values[fieldId]=next;
    }
    for(const {entry,values}of batches.values()){
      const signature=JSON.stringify([entry.entryId,version,values]);
      const edit=edits.find(edit=>edit.path===entry.path&&Object.keys(values).length===1&&Object.hasOwn(values,basePropertyName(edit.property))),widget=edit&&currentCollectionWidget(edit);
      let attempt=collectionAttempts.get(signature);
      if(attempt&&attempt.widget?.owner!==widget?.owner){attempt.release?.();collectionAttempts.delete(signature);collectionMutations.delete(signature);attempt=undefined;}
      let request=collectionMutations.get(signature);
      if(!request){request={op:'set_entry',operationId:crypto.randomUUID(),entryId:entry.entryId,expectedRevision:entry.revision,expectedCollectionRevision:captured.collection.revision,values};collectionMutations.set(signature,request);}
      if(!attempt){
        const selected=request as SetEntry,release=options.holdRecoverDatabaseEntry?.(selected);
        attempt={signature,request:selected,collectionId:captured.collection.id,widget,release};collectionAttempts.set(signature,attempt);
      }else attempt.widget=widget;
      const response=await databaseService.request(request),saved=response.entries.find(item=>item.entryId===entry.entryId);attempt.response=response;
      if(!saved||saved.pendingProjection)throw new Error('The property is committed locally but its note still needs publication. Retry this edit.');
      if(admissionRecovery)verifyRecoveredCollectionAttempt(attempt,response);
    }
    if(admissionRecovery)return;
    const refresh=(async()=>{
      await options.vault.reload();if(admissionRecovery)return;
      await loadDefinitions();if(admissionRecovery)return;
      await controller.refresh();if(admissionRecovery)return;
      await loadDefinitions();
    })().catch(error=>{if(!admissionRecovery)throw error;});
    await Promise.race([refresh,derivedRetirement]);
  }
  function currentCollectionWidget(edit:Pick<BasePropertyWidgetEdit,'version'|'path'|'property'|'value'>):BasePropertyEditRecovery|undefined {
    return [...content.querySelectorAll<HTMLElement>('[data-base-editing]')].map(basePropertyEditRecovery).find(widget=>widget&&widget.edit.version===edit.version&&widget.edit.path===edit.path&&widget.edit.property===edit.property&&baseValuesEqual(widget.edit.value,edit.value));
  }
  function rebindRetainedCollectionWidget(edit:BasePropertyWidgetEdit):void {
    const widget=currentCollectionWidget(edit);if(!widget)return;
    for(const attempt of collectionAttempts.values())if(attempt.widget?.owner===widget.owner&&attempt.widget.edit.version===edit.version&&attempt.widget.edit.path===edit.path&&attempt.widget.edit.property===edit.property&&baseValuesEqual(attempt.widget.edit.value,edit.value))attempt.widget=widget;
  }
  function releaseUnownedCollectionAttempts():void {
    for(const [signature,attempt]of collectionAttempts){
      const element=attempt.widget?.element;
      if(element?.isConnected&&element.hasAttribute('data-base-editing')||!element&&pending.size)continue;
      attempt.release?.();collectionAttempts.delete(signature);collectionMutations.delete(signature);
    }
  }
  function verifyRecoveredCollectionAttempt(attempt:CollectionAttempt,response:DatabaseResponse):void {
    const saved=response.entries.find(entry=>entry.entryId===attempt.request.entryId),collection=response.collections.find(collection=>collection.id===attempt.collectionId);
    if(!saved||saved.deleted||saved.pendingProjection||!saved.fileRevision||saved.collectionId!==attempt.collectionId||!collection||collection.deleted
      ||Object.entries(attempt.request.values).some(([field,value])=>JSON.stringify(saved.values[field])!==JSON.stringify(value)))throw new Error('The submitted collection edit is not confirmed. Its original draft is retained.');
  }
  function rawDraftOrigin():BaseSessionDraftOrigin|undefined {
    const read=controller.configurationRead;if(!read)return;
    const actor=options.vault.entries.get(read.path);if(actor?.entryId!==read.entryId)return;
    return{entryId:read.entryId,path:read.path,revision:read.revision,source:read.source,viewId:read.viewId,viewIndex:read.viewIndex,
      ...(collection?{collectionId:collection.id,schemaFingerprint:JSON.stringify(collection.properties)}:{})};
  }
  function recoverableCollectionAttempts():{edits:CollectionAttempt[];rawElements:HTMLElement[];table:boolean}|undefined {
    try{alive();}catch{return;}
    if(disposed||closing&&!interruptFinish||pendingCollectionRestore||pendingCollectionCreate||optionCreations.size||configurationLifecycle||controller.hasPendingViewReferences
      ||mounted?.hasQueuedConfiguration?.()||toolbarUI.hasDraft()||settings.hasDraft()||summaryDraft||summaryHasRawDraft?.()
      ||chooser?.hasPendingChanges()||collectionEditor?.hasPendingChanges()||unfinishedNoteCreation()
      ||[...changedBuffers].some(buffer=>buffer.dirty||!!buffer.error))return;
    const elements=[...content.querySelectorAll<HTMLElement>('[data-base-editing]')],table=!!content.querySelector('.zorid-bases-table-input');
    if(table&&!mounted?.canCaptureRawDraft?.())return;
    if(!elements.length)return activeDraft()?undefined:{edits:[],rawElements:[],table:false};
    const selected:CollectionAttempt[]=[],rawElements:HTMLElement[]=[];
    for(const element of elements){
      if(table&&element.querySelector('.zorid-bases-table-input'))continue;
      const widget=basePropertyEditRecovery(element);
      if(!widget){if(!canCaptureBasePropertyRawDraft(element))return;rawElements.push(element);continue;}
      if(!options.canRecoverDatabaseEntry||!options.claimRecoverDatabaseEntry||!options.holdRecoverDatabaseEntry)return;
      const attempt=[...collectionAttempts.values()].find(attempt=>attempt.widget===widget&&collectionMutations.get(attempt.signature)===attempt.request);
      if(!attempt?.release||!options.canRecoverDatabaseEntry(attempt.request))return;
      selected.push(attempt);
    }
    if(pending.size>selected.length||((rawElements.length||table)&&!rawDraftOrigin()))return;
    return{edits:selected,rawElements,table};
  }
  function prepareAdmissionRecovery():BaseAdmissionRecovery {
    if(admissionRecovery)return admissionRecovery.capsule;
    const selected=recoverableCollectionAttempts();if(!selected)throw new Error('Unsubmitted Base changes must be retained before reconnecting.');
    const {edits,rawElements,table}=selected,origin=rawDraftOrigin(),rawDrafts:BaseSessionRawDraft[]=[];
    const releases:(()=>void)[]=[];
    try{
      for(const edit of edits)releases.push(options.claimRecoverDatabaseEntry!(edit.request));
      for(const element of rawElements){const raw=captureBasePropertyRawDraft(element);if(!raw||!origin)throw new Error('The raw property changed while reconnecting; it is retained.');rawDrafts.push({kind:'property',origin,raw});}
      if(table){const raw=mounted?.captureRawDraft?.();if(!raw||!origin)throw new Error('The raw title changed while reconnecting; it is retained.');rawDrafts.push({kind:'table',origin,raw});}
    }catch(error){for(const release of releases)release();throw error;}
    const recovery:{capsule:BaseAdmissionRecovery;edits:CollectionAttempt[];settled:boolean;settling?:Promise<void>}={edits,settled:false,capsule:{rawDrafts,settle(){
      if(recovery.settled)return Promise.resolve();if(recovery.settling)return recovery.settling;
      const settling=(async()=>{
        alive();await Promise.all(rawDrafts.map(draft=>draft.raw.ready));alive();await Promise.allSettled([...pending]);await Promise.resolve();alive();
        for(const attempt of edits){
          const widget=attempt.widget!;
          if(widget.isCurrent()){
            if(widget.pending)throw new Error('The original collection edit is still pending.');
            const response=await databaseService!.request(attempt.request);alive();verifyRecoveredCollectionAttempt(attempt,response);
            if(!widget.acknowledge())throw new Error('The property draft changed while reconnecting; it is retained.');attempt.response=response;
          }else{
            if(widget.element.hasAttribute('data-base-editing')||!attempt.response)throw new Error('The property draft changed while reconnecting; it is retained.');
            verifyRecoveredCollectionAttempt(attempt,attempt.response);
          }
        }
        for(const attempt of edits){attempt.release?.();attempt.release=undefined;collectionAttempts.delete(attempt.signature);collectionMutations.delete(attempt.signature);}
        for(const release of releases)release();recovery.settled=true;actionMessage=undefined;notice=undefined;renderStatus(controller.state);
      })();recovery.settling=settling;void settling.finally(()=>{if(recovery.settling===settling)recovery.settling=undefined;}).catch(()=>{});return settling;
    }}};
    admissionRecovery=recovery;collectionLoad++;if(collectionRefreshTimer!==undefined){clearTimeout(collectionRefreshTimer);collectionRefreshTimer=undefined;}
    controller.dispose();interruptFinish?.();retireDerived();return recovery.capsule;
  }
  const restoredRawDrafts=new WeakSet<BaseSessionRawDraft>();
  async function restoreAdmissionDrafts(drafts:readonly BaseSessionRawDraft[]):Promise<BaseAdmissionDraftRestore> {
    alive();const restored:BaseSessionRawDraft[]=[],waiting:BaseSessionRawDraft[]=[],conflicts:{draft:BaseSessionRawDraft;reason:string}[]=[];
    for(const draft of drafts){
      await draft.raw.ready;alive();
      if(restoredRawDrafts.has(draft)){restored.push(draft);continue;}
      const fresh=rawDraftOrigin(),state=controller.state,origin=draft.origin;
      if(!fresh||!state.result||state.error||state.updating||definitionsLoading||definitionsError||mountedResult!==state.result){waiting.push(draft);continue;}
      if(origin.entryId!==fresh.entryId||origin.path!==fresh.path||origin.source!==fresh.source||origin.viewId!==fresh.viewId||origin.viewIndex!==fresh.viewIndex||origin.collectionId!==fresh.collectionId||origin.schemaFingerprint!==fresh.schemaFingerprint){conflicts.push({draft,reason:'The Base source, selected view, or collection schema changed. Your raw input is retained.'});continue;}
      const target=draft.raw.target,actor=options.vault.entries.get(target.path),row=state.result.rows.find(row=>row.entryId===target.entryId&&row.path===target.path);
      if(!row){if(sharedBasePreview(state.result)){waiting.push(draft);continue;}conflicts.push({draft,reason:'The edited note is no longer in this saved view. Your raw input is retained.'});continue;}
      if(!target.entryId||actor?.entryId!==target.entryId||actor.revision!==row.revision){conflicts.push({draft,reason:'The edited note identity changed. Your raw input is retained.'});continue;}
      if(draft.kind==='table'){
        const result=mounted?.restoreRawDraft?.(draft.raw)??'pending';if(result==='restored'){restoredRawDrafts.add(draft);restored.push(draft);}else if(result==='pending')waiting.push(draft);else conflicts.push({draft,reason:'The edited title or property baseline changed. Your raw input is retained.'});
      }else{
        const targeted=mounted?.rawPropertyElement?.(target.entryId,target.path,target.property);
        const elements=targeted?[targeted]:[...content.querySelectorAll<HTMLElement>('[data-base-widget-version]')];
        if(!elements.length){waiting.push(draft);continue;}
        if(elements.some(element=>restoreBasePropertyRawDraft(element,draft.raw))){restoredRawDrafts.add(draft);restored.push(draft);}else conflicts.push({draft,reason:'The edited property value or schema changed. Your raw input is retained.'});
      }
    }
    return{restored,pending:waiting,conflicts};
  }
  const editCollectionProperty=(edit:Parameters<typeof actions.editProperty>[0])=>editCollectionProperties([edit]);
  async function createCollectionOption(property:string,label:string,presentation:BasePropertyPresentation):Promise<void>{
    action();if(options.readOnly||!databaseService||pendingCollectionRestore||pendingCollectionCreate)throw new Error('This database is unavailable for option creation.');
    const captured=collectionVersions.get(presentation.version),result=widgetResults.get(presentation.version);
    if(!captured||!result||widgetSources.get(presentation.version)!==controller.state.source)throw new Error('The property view changed before the option could be created.');
    const witness=sharedBaseWitness(result,presentation.row.path),field=basePropertyName(property),source=controller.state.source;
    if(!witness)throw new Error('The saved note identity is unavailable.');
    const validate=()=>{action();const current=currentViewSource();if(current.kind!=='collection'||current.id!==captured.collection.id||controller.state.source!==source||options.vault.adapter.databases!==databaseService||options.vault.entries.get(presentation.row.path)?.entryId!==witness.entryId)throw new Error('The database or note changed while its option was being created.');};
    validate();const key=JSON.stringify([captured.collection.id,presentation.version,field,label]);
    let operation=optionCreations.get(key);
    if(!operation){operation=prepareCollectionOptionCreation({service:databaseService,collection:captured.collection,propertyId:field,label,validate});optionCreations.set(key,operation);}
    await operation.run();await options.vault.reload();await loadDefinitions();await controller.refresh();await loadDefinitions();validate();
    optionCreations.delete(key);
  }
  const editProperty=(edit:Parameters<typeof actions.editProperty>[0])=>collectionMode()?editCollectionProperty(edit):Promise.reject(new Error('Vault note views are browsing only. Open the note to edit its properties.'));
  function saveConfigurationCommand(operation: () => Promise<void>): Promise<void> {
    action();if(pendingCollectionRestore)throw new Error('Retry the unfinished Restore before changing this view.');if(pendingCollectionCreate||unfinishedNoteCreation())throw new Error('Use New again to finish the original entry creation before changing this view.'); if (options.readOnly) return Promise.reject(new Error('This base is read-only'));
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
  const summaryNames = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];
  function summaryScope(anchor: HTMLElement, index?: number | null): number | null {
    if (index !== undefined) return index;
    const value = anchor.dataset.summaryGroup;
    return value !== undefined && value !== 'overall' && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  }
  function addSummary(property: string, anchor: HTMLElement, suggested?: string): void {
    action(); if (options.readOnly || pending.size || activeDraft()) throw new Error('Finish or cancel the current edit first.');
    const state = controller.state, document = BaseDocument.parse(state.source), configured = baseViewSetting(document,controller.selectedViewIndex,document.views[controller.selectedViewIndex]?.source===undefined?'summaries':'summaryDefinitions');
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
    const document = BaseDocument.parse(controller.state.source), raw = baseViewSetting(document,controller.selectedViewIndex,document.views[controller.selectedViewIndex]?.source===undefined?'summaries':'summaryDefinitions');
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
    const configured = baseViewSetting(BaseDocument.parse(expectedSource),controller.selectedViewIndex,BaseDocument.parse(expectedSource).views[controller.selectedViewIndex]?.source===undefined?'summaries':'summaryDefinitions');
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
    summaryHasRawDraft = () => name.value !== acceptedName || expression.value !== acceptedExpression;
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
    const cleanup = () => { if (destroyed) return; destroyed = true; if (timer) clearTimeout(timer); doc.removeEventListener('pointerdown', outside, true); win?.removeEventListener('resize', place); win?.removeEventListener('scroll', scroll, true); resize?.disconnect(); formulaEditor?.destroy(); panel.remove(); if (summaryPanel === panel) { summaryPanel = undefined; summaryDraft = false; summaryHasRawDraft = undefined; destroySummaryEditor = undefined; } };
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
      try { const projected = BaseDocument.parse(expectedSource); projected.editViewSummary(controller.selectedViewIndex,acceptedName, next.name, next.expression); next.source = projected.toString(); } catch (failure) { fail(failure, next); return; }
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
      const projected = BaseDocument.parse(expectedSource); projected.removeViewSummary(controller.selectedViewIndex,acceptedName);
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
  function createItem(group?: { property: string; value: BaseValue }, anchor?: HTMLElement): Promise<void>;
  function createItem(group: { property: string; value: BaseValue } | undefined, anchor: HTMLElement | undefined, inline: true): Promise<{path:string;entryId?:string}|void>;
  async function createItem(group?: { property: string; value: BaseValue }, anchor?: HTMLElement, inline=false): Promise<{path:string;entryId?:string}|void> {
    action(); if (options.readOnly || !controller.state.result || sharedBasePreview(controller.state.result)) throw new Error('This base is read-only');
    const creatingSource=controller.state.source,creatingViewId=controller.selectedViewIdentity,creatingIndex=controller.selectedViewIndex;
    const validatePreparation=()=>{alive();if(controller.state.source!==creatingSource||controller.selectedViewIdentity!==creatingViewId||controller.selectedViewIndex!==creatingIndex)throw new Error('The view source changed while preparing New. No entry was created.');};
    await options.closeCreatedFile?.();
    validatePreparation();
    if(pendingCollectionCreate){const source=currentViewSource(),owner=pendingCollectionCreateOwner;if(!owner||source.kind!=='collection'||source.id!==owner.collectionId||(owner.viewId?controller.selectedViewIdentity!==owner.viewId:controller.state.source!==owner.source))throw new Error('The unfinished New belongs to its original collection view. Reopen that view to retry it.');}
    if(creation){const owner=creation.owner;if(collectionMode()||(owner.viewId?controller.selectedViewIdentity!==owner.viewId:controller.state.source!==owner.source))throw new Error('The unfinished New belongs to its original note view. Reopen that view to retry it.');}
    if(collectionMode()){
      if(!pendingCollectionCreate){
        if(!databaseService||!collection||collection.deleted)throw new Error('This collection is unavailable.');
        const creatingCollection=collection;
        const plan=await planCollectionEntryCreation({vault:options.vault,collection:creatingCollection,document:BaseDocument.parse(creatingSource),basePath:options.basePath,viewIndex:creatingIndex,group,validate:validatePreparation});validatePreparation();
        const folder=plan.path.includes('/')?plan.path.slice(0,plan.path.lastIndexOf('/')):'';
        let parent='';for(const segment of folder.split('/').filter(Boolean)){parent=parent?`${parent}/${segment}`:segment;if(options.vault.entries.get(parent)?.type==='file')throw new Error('A file occupies the new entry’s folder.');if(!options.vault.entries.has(parent))await options.vault.createFolder(parent,validatePreparation);validatePreparation();}
        pendingCollectionCreateOwner={collectionId:creatingCollection.id,viewId:creatingViewId,source:creatingSource,viewIndex:creatingIndex,phase:'submitted'};
        pendingCollectionCreate={op:'create_entry',operationId:crypto.randomUUID(),collectionId:creatingCollection.id,expectedCollectionRevision:creatingCollection.revision,entryId:crypto.randomUUID(),path:plan.path,body:plan.body,values:plan.values};
      }
      const request=pendingCollectionCreate,owner=pendingCollectionCreateOwner!;
      if(!owner.entry){
        if(!databaseService)throw new Error('This collection is unavailable.');
        let response;
        try{response=await databaseService.request(request);}
        catch(failure){
          const rejection=failure as {source?:unknown;commitUncertain?:unknown};
          if(rejection?.source==='host'&&rejection.commitUncertain===false){pendingCollectionCreate=undefined;pendingCollectionCreateOwner=undefined;try{await options.vault.reload();await loadDefinitions();await controller.refresh();await loadDefinitions();}catch{/* Keep the original definitive rejection visible. */}}
          throw failure;
        }
        // Save the receipt before any derived read or owner validation can fail.
        const entry=response.entries.find(entry=>request.op==='create_entry'&&entry.entryId===request.entryId);
        if(!entry||entry.pendingProjection)throw new Error('The entry is committed locally but its note still needs publication. Use New again to retry.');
        owner.entry=Object.freeze({...entry});owner.phase='committed';
      }
      const entry=owner.entry;validatePreparation();
      await options.vault.reload();validatePreparation();
      await loadDefinitions();validatePreparation();
      await controller.refresh();validatePreparation();
      await loadDefinitions();
      validatePreparation();
      if(controller.state.error)throw controller.state.error;
      if(definitionsError)throw new Error(definitionsError);
      const witness=await validateCreatedEntry(entry.path,entry.entryId,validatePreparation);
      notice=controller.state.result&&!controller.state.result.rows.some(row=>row.entryId===entry.entryId)?'Created entry is not shown in the current results.':undefined;renderStatus(controller.state);
      if(inline&&options.buffers?.rename&&controller.selectedViewIdentity===creatingViewId&&controller.selectedViewIndex===creatingIndex&&controller.state.source===creatingSource){
        const result=controller.state.result;
        if(result?.rows.some(row=>row.entryId===entry.entryId)&&result.properties.some(property=>property==='file.name'||property==='file.file')){owner.phase='presented';pendingCollectionCreate=undefined;pendingCollectionCreateOwner=undefined;return{path:entry.path,entryId:entry.entryId};}
      }
      const event=new(win?.MouseEvent??MouseEvent)('click');
      const presented=options.openCreatedFile?await options.openCreatedFile(entry.path,event,anchor??content,entry.entryId):options.openFile(entry.path,event,witness);
      owner.phase=presented===false?'presentation-canceled':'presented';pendingCollectionCreate=undefined;pendingCollectionCreateOwner=undefined;
      return;
    }
    // Keep both uncertain writes and committed-but-unpresented results. New is
    // a fresh intent only after this owner has completed its presentation.
    if (!creation) creation = {operation:await prepareBaseItemCreation({ vault: options.vault, document: creatingSource, basePath: options.basePath, viewIndex: creatingIndex, group, validate: validatePreparation }),owner:{source:creatingSource,viewId:creatingViewId,viewIndex:creatingIndex},phase:'submitted'};
    const owner=creation,operation=owner.operation;
    if(!owner.entry){owner.entry=Object.freeze({...await operation.run()});owner.phase='committed';}
    const entry=owner.entry;validatePreparation();
    await controller.refresh();
    validatePreparation();if(controller.state.error)throw controller.state.error;
    const witness=await validateCreatedEntry(entry.path,entry.entryId,validatePreparation);
    notice = [...operation.plan.warnings, ...(controller.state.result && !controller.state.result.rows.some(row => row.path === entry.path) ? ['Created note is not shown in the current results.'] : [])].join(' ') || undefined;
    renderStatus(controller.state);
    const event = new (win?.MouseEvent ?? MouseEvent)('click');
    const presented=options.openCreatedFile?await options.openCreatedFile(entry.path,event,anchor??toolbar.querySelector<HTMLElement>('[aria-label="New"]')??content,entry.entryId):options.openFile(entry.path,event,witness);
    owner.phase=presented===false?'presentation-canceled':'presented';creation=undefined;
  }
  async function validateCreatedEntry(path:string,entryId:string|undefined,validate:()=>void):Promise<{entryId:string;revision:string}|undefined>{
    if(!entryId)return;
    const adapter=options.vault.adapter;
    const entry=adapter.stat?await adapter.stat(path):(await adapter.list()).find(entry=>entry.path===path);
    validate();
    if(options.vault.adapter!==adapter||entry?.type!=='file'||entry.entryId!==entryId)throw new Error('The created note moved or was replaced. Its original creation is retained.');
    return entry.revision?{entryId,revision:entry.revision}:undefined;
  }
  async function exportResults(format: BaseExportFormat, copy: boolean): Promise<void> {
    const result = controller.state.result; if (!result) throw new Error('Wait for results before exporting.');
    const labels = baseViewSetting(BaseDocument.parse(controller.state.source),controller.selectedViewIndex,'properties');
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
    if(state.updating&&state.result){
      if(!refreshIndicatorVisible&&refreshIndicatorTimer===undefined)refreshIndicatorTimer=setTimeout(()=>{refreshIndicatorTimer=undefined;if(!disposed&&controller.state.updating&&controller.state.result){refreshIndicatorVisible=true;renderStatus(controller.state);}},350);
    }else{if(refreshIndicatorTimer!==undefined)clearTimeout(refreshIndicatorTimer);refreshIndicatorTimer=undefined;refreshIndicatorVisible=false;}
    renderRestoreRecovery();
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
    if(sourceUnavailable()){status.textContent=actionMessage??'';return;}
    if(actionMessage){status.textContent=actionMessage;return;}
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
    // Keep fast background revalidation quiet; long requests still expose
    // activity, and write admission remains blocked until fresh authority returns.
    if(state.updating&&state.result&&refreshIndicatorVisible){status.textContent='Updating…';return;}
    if (!state.result && (state.updating || !controller.canBeginPropertyEdit)) { status.textContent = 'Loading saved results…'; return; }
    const coverage = state.result && sharedBaseCoverage(state.result);
    status.textContent = coverage && !coverage.generationComplete ? 'Some saved files are unavailable in these results.'
      : coverage && !coverage.metadataComplete ? 'Some saved properties are unavailable in these results.' : notice ?? '';
  }
  function filterToolbarState(result: BaseQueryResult, document: BaseDocument, index: number): BaseToolbarState {
    const capturedDefinitions=definitions;
    const writable = !options.readOnly && !sharedBasePreview(result);
    const browseOnly=baseViewSource(document.views[index]??result.view).kind==='untyped';
    const filterProperty = baseSessionFilterPropertyProvider(options.vault, capturedDefinitions, result.availableProperties, () => filterOwnerCurrent() && !definitionsLoading && !definitionsError && definitions===capturedDefinitions);
    return { result, views: document.views, selectedIndex:index, rootFilters: document.views[index]?.source===undefined?document.getRoot('filters'):undefined, settings:Object.fromEntries(['formulas','properties','newItemFolder','newItemTemplate'].map(key=>[key,baseViewSetting(document,index,key)]).filter((entry):entry is [string,BaseValue]=>entry[1]!==undefined)), root: Object.fromEntries(['filters','formulas','properties','summaries','newItemFolder','newItemTemplate'].map(key => [key, document.getRoot(key)]).filter((entry): entry is [string, BaseValue] => entry[1] !== undefined)), readOnly: !writable, browseOnly, allowRename: true, propertyType: property => capturedDefinitions.properties[basePropertyName(property)]?.type,
      filterProperty, label: getPropertyLabel };
  }
  function renderSourceBar(source:BaseViewSource):void{
    sourceBar.replaceChildren();
    const sourceButton=doc.createElement('button');sourceButton.type='button';sourceButton.className='collection-source-button';sourceButton.textContent=sourceUnavailable()?'Choose another source':source.kind==='untyped'?'Notes in your vault':collection?.name??'Collection';sourceButton.setAttribute('aria-label','Change view source');
    sourceButton.disabled=!!options.readOnly;sourceButton.setAttribute('aria-haspopup','dialog');sourceButton.dataset.baseTooltip='Change data source';sourceButton.onclick=()=>{const repair=sourceUnavailable()?deletedConfigurationRead:undefined;if(activeDraft()){report(new Error('Finish or cancel the current edit first.'));return;}void chooseSource(async next=>{await saveConfigurationCommand(()=>repair?controller.repairViewSource(repair,next):controller.setViewSource(controller.state.version,selectedIndex,next));}).catch(report);};sourceBar.append(sourceButton);
    if(source.kind==='collection'&&databaseService&&!options.readOnly&&sourceUnavailable()&&!pendingCollectionRestore&&collection){
      const restoringCollection=collection;
      const restore=doc.createElement('button');restore.type='button';restore.textContent='Restore collection';restore.dataset.collectionRestore='';restore.disabled=!!pending.size;
      restore.onclick=()=>{
        if(pending.size||pendingCollectionRestore||!sourceUnavailable())return;
        pendingCollectionRestore={op:'restore',operationId:crypto.randomUUID(),collectionId:restoringCollection.id,expectedRevision:restoringCollection.revision};
        retryCollectionRestore();
      };sourceBar.append(restore);
    }
  }
  function renderRestoreRecovery():void{
    restoreRecovery.replaceChildren();restoreRecovery.hidden=!pendingCollectionRestore;
    for(const button of root.querySelectorAll<HTMLElement>('[data-collection-restore]'))button.hidden=!!pendingCollectionRestore;
    if(!pendingCollectionRestore)return;
    const retry=doc.createElement('button');retry.type='button';retry.textContent='Retry Restore';retry.setAttribute('aria-label',`Retry Restore for collection ${pendingCollectionRestore.collectionId}`);retry.disabled=!!pending.size;
    retry.onclick=()=>retryCollectionRestore();restoreRecovery.append(retry);
  }
  function retryCollectionRestore():void{
    const request=pendingCollectionRestore;
    if(!request||!databaseService||pending.size)return;
    void track(async()=>{
      try{
        const reply=await databaseService.request(request);
        if(reply.projection.pending||reply.projection.issues.length)throw new Error('Some collection files still need publication. Retry Restore.');
        pendingCollectionRestore=undefined;
      }catch(failure){const rejection=failure as {source?:unknown;commitUncertain?:unknown};if(rejection?.source==='host'&&rejection.commitUncertain===false)pendingCollectionRestore=undefined;throw failure;}
      await options.vault.reload();await loadDefinitions();await controller.refresh();await loadDefinitions();
    }).catch(()=>{/* track retains the action failure. */});
  }

  function render(state: BaseControllerState): void {
    if (disposed || admissionRecovery) return;
    // Status changes never replace rows or a focused local property/config draft.
    const unavailable=sourceUnavailable();unavailableCard.hidden=!unavailable;
    renderStatus(state);
    if(unavailable){
      toolbar.hidden=true;sourceBar.hidden=true;unavailableMessage.textContent=unavailable.message;
      renderSourceBar({kind:'collection',id:unavailable.collectionId});unavailableActions.replaceChildren(...sourceBar.childNodes);
      if(pending.size||activeDraft()){deferred=state;return;}
      deferred=undefined;mounted?.destroy();mounted=undefined;mountedResult=undefined;content.replaceChildren();
      return;
    }
    if (state.error) {
      toolbar.hidden=false;sourceBar.hidden=false;
      deferred = undefined;
      try{const view=BaseDocument.parse(configurationSource()).views[configurationIndex()];if(view){const source=baseViewSource(view);renderSourceBar(source);if(source.kind==='collection'&&(loadedCollectionId!==source.id||loadedSourceContext!==sourceContext()||loadedConfigurationRead!==controller.configurationRead))void loadDefinitions();}}
      catch{/* The existing source error stays visible. */}
      if(!propertyDraft()&&!activeDraft()){mounted?.destroy();mounted=undefined;mountedResult=undefined;content.textContent=state.error.message;}
      return;
    }
    if (!state.result) {
      try {
        if(!state.updating&&!BaseDocument.parse(state.source).views.length){
          toolbar.hidden=true;sourceBar.hidden=true;
          if(pending.size||toolbarUI.hasDraft()){deferred=state;return;}
          mounted?.destroy();mounted=undefined;mountedResult=undefined;content.replaceChildren();
          if(!chooser)void chooseSource(async source=>{await saveConfigurationCommand(()=>controller.addView(controller.state.version,'table','Table',{source}));},false);
        }
      } catch(failure) { report(failure); }
      return;
    }
    // An updating publication still carries the last admitted result. Do not
    // reload schema or rebuild its controls against a temporary missing proof.
    if(state.updating&&mountedResult){deferred=state;return;}
    toolbar.hidden=false;sourceBar.hidden=false;
    const result = state.result;
    selectedIndex = controller.selectedViewIndex;
    const document = BaseDocument.parse(state.source);
    // Adding a view advances the query selection before the new saved source
    // is published. Keep the current UI until that matching source arrives.
    if(state.updating&&!document.views[selectedIndex])return;
    propertyLabels=baseViewSetting(document,selectedIndex,'properties');
    const source=baseViewSource(document.views[selectedIndex]??result.view);
    if(source.kind==='collection'&&(loadedCollectionId!==source.id||loadedSourceContext!==sourceContext()||loadedConfigurationRead!==controller.configurationRead)){void loadDefinitions();}
    else if(source.kind==='untyped'&&loadedCollectionId!==undefined){void loadDefinitions();}
    // Same-source schema reads revoke write authority while in flight, but the
    // existing controls are presentation we can retain until that read settles.
    if(definitionsLoading&&mountedResult&&mountedIndex===selectedIndex&&JSON.stringify(baseViewSource(mountedResult.view))===JSON.stringify(source)){deferred=state;return;}
    renderSourceBar(source);
    const toolbarState=filterToolbarState(result,document,selectedIndex),writable=!toolbarState.readOnly&&source.kind==='collection'&&!definitionsLoading&&!definitionsError;
    toolbarUI.update({...toolbarState,...(collection?{sourceLabel:collection.name}:{})});
    // Toolbar rebases its own in-flight configuration without replacing row drafts.
    if (pending.size || activeDraft()) { deferred = state; return; }
    deferred = undefined;
    if (mountedResult === result && mountedDefinitionsRevision === definitionsRevision && mountedWritable === writable) return;
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
    const shared = { result, ...(source.kind==='collection'?{pageTitleProperty:'file.name'}:{}), canBeginPropertyEdit, getEditableValue: baseEditablePropertyValue, getPropertyLabel, getPropertyType: (property: string) => definitions.properties[basePropertyName(property)]?.type,
      openFile: openResultFile,
      ...(writable ? { editProperty: (edit: Parameters<typeof actions.editProperty>[0]) => track(() => { assertPropertyWritable(edit.property, edit.value); return editProperty(edit); }) } : {}),
      onError: report, onEditStateChange: () => { renderStatus(controller.state); schedule(); },
      contextMenu: options.contextMenu, hoverFile: options.hoverFile, dragFile: options.dragFile,
      renderProperty: createBasePropertyRenderer({ canBegin: canBeginPropertyEdit, getEditableValue: presentation => baseEditablePropertyValue(presentation.row, presentation.property), getDefinition: property => definitions.properties[basePropertyName(property)],
        commit: (edit: BasePropertyWidgetEdit) => {rebindRetainedCollectionWidget(edit);return track(async () => { assertPropertyWritable(edit.property, edit.value); await editProperty(edit); return acknowledgeWidget(edit, edit.value); });}, readOnly: presentation => !writable || !!definitionsError || definitions.diagnostics.some(item => item.property === basePropertyName(presentation.property)),
        isCurrent: presentation => !disposed && !!mountedResult && widgetResults.has(presentation.version),
        getRelationTargets,
        ...(writable?{createOption:(property:string,label:string,presentation:BasePropertyPresentation)=>track(async()=>{
          const expected=baseEditablePropertyValue(presentation.row,property);
          if(!expected)throw new Error('The saved property value is unavailable.');
          await createCollectionOption(property,label,presentation);
          const acknowledgement=acknowledgeWidget(presentation,expected);
          if(!acknowledgement)throw new Error('Option created. Refresh the property before choosing its value.');
          return acknowledgement;
        })}:{}),
        loadImage: options.loadThumbnail ? (source, signal, presentation) => options.loadThumbnail!({ row: presentation.row, property: presentation.property, value: baseImageSourceValue(presentation.value, source), version: presentation.version, signal }) : undefined,
        openFile: openResultFile, onError: report,
        ...(result.view.type==='table'?{onEditorComplete:(element:HTMLElement,presentation:BasePropertyPresentation,intent:BasePropertyEditorCompletionIntent)=>{if(!admissionRecovery)mounted?.completePropertyEdit?.(element,presentation,intent);}}:{}),
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
      } : {}),
      getSummaryOptions: async (property: string, groupIndex: number | null) => {
        const active = renderingResult ?? mountedResult ?? result, group = groupIndex === null ? undefined : active.groups[groupIndex];
        if (groupIndex !== null && !group) throw new Error('This result group changed; reopen its summary picker.');
        const previews = await controller.summaryPreviews(property, group?.sharedKeyId ?? undefined);
        const custom = baseViewSetting(BaseDocument.parse(controller.state.source),controller.selectedViewIndex,BaseDocument.parse(controller.state.source).views[controller.selectedViewIndex]?.source===undefined?'summaries':'summaryDefinitions');
        const order = [...new Set(['Empty', 'Filled', 'Unique', 'Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', ...Object.keys(custom && typeof custom === 'object' && !Array.isArray(custom) ? custom : {})])];
        return order.filter(id => Object.hasOwn(previews, id)).map(id => ({ id, label: id, preview: previews[id] }));
      },
      summaryOptions: [...new Set(['Average','Min','Max','Sum','Range','Median','Stddev','Earliest','Latest','Checked','Unchecked','Empty','Filled','Unique', ...Object.keys((baseViewSetting(document,controller.selectedViewIndex,document.views[controller.selectedViewIndex]?.source===undefined?'summaries':'summaryDefinitions') as Record<string, BaseValue>) ?? {})])].map(id => ({ id, label: id })),
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
      validatePropertyValue: (value: import('./expression.ts').BaseExpressionValue, property: string) => { assertPropertyWritable(property); return source.kind==='collection'&&collection?collectionClipboardValue(collection,property,value):value; },
      parsePropertyInput: (raw: string, property: string, row: import('./query.ts').BaseQueryRow) => parseBasePropertyInput(raw, definitions.properties[basePropertyName(property)] ?? inferBasePropertyDefinition(row.values[property] ?? { type: 'null' }), row.values[property]),
      ...(writable ? {
        ...(options.deleteFiles ? { deleteFiles: (rows: readonly import('./query.ts').BaseQueryRow[]) => track(async () => {
          const active = renderingResult ?? mountedResult ?? result;
          if (active.version !== controller.state.version) throw new Error('The Base result is stale; refresh before deleting files.');
          await options.deleteFiles!(rows, active);
        }) } : {}),
        editProperties: (edits: readonly import('./table-view.ts').BaseTableEdit[]) => track(() => { edits.forEach(edit => assertPropertyWritable(edit.property)); return editCollectionProperties(edits); }),
        patchView: (patch: BaseViewPatch) => saveConfigurationCommand(() => controller.updateView(numericVersion(mountedResult?.version ?? result.version), patch)),
        onConfigurationSettled: () => {
          if (disposed) return;
          const state = controller.state; if (!closing) render(state);
          if (!state.error && !state.updating && mountedResult === state.result && state.result) return { result: state.result, entryId: options.vault.entries.get(options.basePath)?.entryId };
        },
        getConfigurationIdentity: () => disposed ? undefined : options.vault.entries.get(options.basePath)?.entryId,
        isConfigurationClosing: () => disposed || closing,
        ...(source.kind==='collection'?{requestEditProperty:(property:string,anchor:HTMLElement)=>openCollectionProperties(basePropertyName(property),anchor)}:{}),
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
          case 'table': mounted = createBaseTableView(content, {...shared,...(writable?{
            canRetryPropertyEdit,
            onNew:(anchor:HTMLElement)=>track(()=>createItem(undefined,anchor,true)).then(created=>{render(controller.state);return created;}),
            requestAddProperty:(anchor:HTMLElement)=>{try{addCollectionProperty(anchor);}catch(error){report(error);}},
            ...(options.buffers?.rename?{renameFile:(edit:import('./table-view.ts').BaseTableRename)=>track(async()=>{
              action();const active=controller.state.result,row=active?.rows.find(row=>row.path===edit.path),witness=active&&sharedBaseWitness(active,edit.path);
              if(!row||!edit.witness||!witness||witness.entryId!==edit.witness.entryId||witness.revision!==edit.witness.revision)throw new Error('The note changed before its title could be saved.');
              const slash=edit.path.lastIndexOf('/'),extension=/\.[^/.]+$/.exec(edit.path)?.[0]??'';
              if(!edit.name||/[\\/:\u0000-\u001f]/.test(edit.name)||edit.name==='.'||edit.name==='..')throw new Error('Enter a name without path separators.');
              const destination=`${slash<0?'':edit.path.slice(0,slash+1)}${edit.name}${extension}`;
              await controller.renameFile(numericVersion(edit.version),edit.path,destination);await loadDefinitions();return{path:destination};
            })}:{})
          }:{})}); break;
          case 'cards': mounted = createBaseCardsView(content, { ...shared, loadThumbnail: options.loadThumbnail }); break;
          case 'list': mounted = createBaseListView(content, {...shared,...(writable?{onNew:(anchor:HTMLElement)=>track(()=>createItem(undefined,anchor))}:{})}); break;
          case 'kanban': mounted = createBaseKanbanView(content, { ...shared, loadThumbnail: options.loadThumbnail, onError: report, onPresentationError: report,
            getGroupAppearance:group=>{
              const active=renderingResult??mountedResult??result, grouping=active.view.groupBy;
              if(!grouping||typeof grouping!=='object'||Array.isArray(grouping)||!('property'in grouping)||typeof grouping.property!=='string')return undefined;
              const definition=definitions.properties[basePropertyName(grouping.property)];
              const key=group.key?.type==='string'?group.key.value:undefined;
              const option=key===undefined?undefined:definition?.options?.find(option=>option.value===key||option.id===key);
              return option?{label:option.label??option.value,color:option.color,category:option.category}:undefined;
            },
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
            ...(moveEnabled ? { requestMove: request => track(() => { assertPropertyWritable(request.property); if(request.property==='file.folder')return actions.requestMove(request);
              const active=controller.state.result,sourceGroup=active?.groups.find(group=>group.rows.some(row=>row.path===request.path)),destination=active?.groups.find(group=>group.sharedKeyId===request.destinationKeyId)??active?.groupOptions.find(group=>group.listed&&group.sharedKeyId===request.destinationKeyId);
              if(!active||active.version!==request.version||sourceGroup?.sharedKeyId!==request.sourceKeyId||!destination)throw new Error('The card group changed.');
              let value=baseGroupWriteValue(destination,active.shared!==undefined);const definition=definitions.properties[basePropertyName(request.property)];if(definition?.type==='multiselect'&&value!==null&&!Array.isArray(value))value=[value];
              return editCollectionProperty({version:request.version,path:request.path,property:request.property,value:baseExpressionValue(value)}); }) } : {}),
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
    closeSourceChooser();collectionEditor?.destroy();collectionEditor=undefined;
    await controller.setView(index);
    if (!controller.state.error) selectedIndex = controller.selectedViewIndex;
  }

  async function settle(validateRecovery:()=>void=()=>{}): Promise<void> {
    await Promise.allSettled([...pending]);
    validateRecovery();
    // Let property widgets finish handling their accepted/rejected operations.
    await Promise.resolve();
    validateRecovery();
    const acknowledgesSavedDraft = controller.hasPendingViewReferences || [...changedBuffers].some(buffer => buffer.path === options.basePath && (buffer.dirty || buffer.error));
    const acknowledgement = toolbarUI.captureSaveAcknowledgement();
    // Reference operations own their exact failed note drafts and original
    // witnesses; flushing those buffers independently would invalidate retry.
    if (controller.hasPendingViewReferences) {await controller.retryViewRenameReferences();validateRecovery();}
    for (const buffer of changedBuffers) {await buffer.flush();validateRecovery();}
    const configurationAcknowledged = await controller.acknowledgeConfigurationRetry();
    validateRecovery();
    if (acknowledgesSavedDraft || configurationAcknowledged) acknowledgement();
    releaseCleanBuffers();
    if(pendingCollectionRestore)throw new Error('The collection Restore is unfinished. Retry Restore before leaving this Base.');
    if(pendingCollectionCreate)throw new Error('The new entry is unfinished. Use New again to finish it before leaving this Base.');
    if (unfinishedNoteCreation()) throw new Error('The new note creation is unfinished. Use New again to finish it before leaving this base.');
    if (activeDraft()) throw new Error('Finish or cancel the property edit before leaving this base');
  }
  async function finish(close: boolean, dismissCleanPanels = false): Promise<void> {
    if (disposed) return;
    let recoveryInterruption:Error|undefined;
    const interrupted=()=>recoveryInterruption??=Object.assign(new Error('This Base is reconnecting; its submitted edits are retained.'),{code:'base_admission_recovery_pending'});
    if(admissionRecovery&&!admissionRecovery.settled)throw interrupted();
    if (closing) throw new Error('This base view is already finishing edits');
    if (mounted?.hasQueuedConfiguration?.()) throw new Error('Wait for the queued column width changes before leaving this base');
    closing = true;
    const previousRecovery=admissionRecovery;let interrupt!:()=>void;
    const retirement=new Promise<void>(resolve=>{interrupt=resolve;});interruptFinish=interrupt;
    try {
      if(!admissionRecovery?.settled)await Promise.race([settle(()=>{if(admissionRecovery!==previousRecovery)throw interrupted();}),retirement.then(()=>{throw interrupted();})]);
      if(admissionRecovery!==previousRecovery)throw interrupted();
      if(interruptFinish===interrupt)interruptFinish=undefined;
      if (mounted?.hasQueuedConfiguration?.()) throw new Error('Wait for the queued column width changes before leaving this base');
      if (dismissCleanPanels && summaryHasRawDraft?.()) throw new Error('Finish or cancel the summary edit before changing context');
      if (dismissCleanPanels) { mounted?.dismissCleanPanels?.(); toolbarUI.dismissCleanPanel(); settings.destroy(); destroySummaryEditor?.(); }
      if (close) {
        for(const attempt of collectionAttempts.values())attempt.release?.();collectionAttempts.clear();collectionMutations.clear();
        closeSourceChooser();collectionEditor?.destroy();collectionEditor=undefined;if(collectionRefreshTimer!==undefined)clearTimeout(collectionRefreshTimer);
        tooltips.destroy(); toolbarUI.destroy(); settings.destroy(); destroySummaryEditor?.(); stopDefinitions.forEach(stop => stop()); stopFilterMetadata(); mounted?.destroy(); mounted = undefined; observer?.disconnect();
        if (scheduled !== undefined) clearTimeout(scheduled);
        if(refreshIndicatorTimer!==undefined)clearTimeout(refreshIndicatorTimer);
        root.removeEventListener('keydown', switchViewKey, true); controller.dispose(); disposed = true; root.remove();
      }
    } catch (error) { if(!recoveryInterruption||error!==recoveryInterruption||!admissionRecovery)report(error); throw error; }
    finally {
      if(interruptFinish===interrupt)interruptFinish=undefined;
      closing = false; renderStatus(controller.state);
      const metadata=options.vault.metadataFrame;if(metadata)refreshFilterMetadata(metadata);
      if (editsWerePending) schedule();
    }
  }
  let collectionRefreshTimer:ReturnType<typeof setTimeout>|undefined;
  const stopDefinitions = (['create', 'modify', 'rename', 'delete', 'ready'] as const).map(event => options.vault.on(event, change => {
    renderStatus(controller.state);
    if(currentViewSource().kind==='collection'&&collectionRefreshTimer===undefined)collectionRefreshTimer=setTimeout(()=>{collectionRefreshTimer=undefined;if(!disposed)void loadDefinitions();},30);
  }));
  function refreshFilterMetadata(metadata:CommittedMetadataState):void {
    const state=controller.state;
    if(disposed||closing||definitionsLoading||definitionsError||!state.result||state.error||state.updating
      ||options.vault.isMetadataRetired||metadata!==options.vault.metadataFrame||metadata.status!=='current'||!filterOwnerCurrent())return;
    toolbarUI.refreshFilterAdvice(filterToolbarState(state.result,BaseDocument.parse(state.source),controller.selectedViewIndex));
  }
  const stopFilterMetadata = options.vault.onMetadata(refreshFilterMetadata);
  return {
    ready: controller.refresh().then(()=>loadDefinitions()),
    get state() { return controller.state; },
    refresh: async () => { await controller.refresh(); await loadDefinitions(); },
    selectView,
    setCurrentFile: (path, expectedEntryId) => { action(); return controller.setCurrentFilePath(path, expectedEntryId); },
    get selectedViewIdentity(){return controller.selectedViewIdentity;},
    rebindViewName: (from, to, viewId) => { alive(); return controller.rebindViewName(from, to,viewId); },
    hasPendingChanges: () => !disposed && !admissionRecovery?.settled && (!!pending.size || !!mounted?.hasQueuedConfiguration?.() || controller.hasPendingViewReferences || unfinishedNoteCreation() || !!pendingCollectionCreate || activeDraft() || [...changedBuffers].some(buffer => buffer.dirty || !!buffer.error)),
    canRecoverAdmission:()=>admissionRecovery?!disposed:!!recoverableCollectionAttempts(),
    prepareAdmissionRecovery,
    restoreAdmissionDrafts,
    owns: node => { try { alive(); return !closing && root.isConnected && toolbarUI.owns(node); } catch { return false; } },
    flush: options => finish(false, options?.dismissCleanPanels),
    close: () => finish(true),
  };
}
