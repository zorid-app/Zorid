import { BaseDocument, uniqueBaseViewName, validateBaseViewName } from './document.ts';
import type { BaseValue, BaseViewPatch, BaseRootPatch } from './document.ts';
import type { BaseExpressionValue } from './expression.ts';
import { executeBaseQuery, normalizeBaseProperty } from './query.ts';
import type { BaseQueryOptions, BaseQueryResult } from './query.ts';
import { SharedBaseQueryRunner, sharedBaseWitness, sharedBaseCapture, sharedBaseCoverage, sharedBasePreview } from './shared-query.ts';
import { createBaseClockHost } from './clock.ts';
import type { BaseClockCapture, BaseClockHost } from './clock.ts';
import type { BaseSavedWitness } from './shared-query.ts';
import { readProperties, removeProperty, setProperty } from '../core/properties.ts';
import { isMarkdown, normalizePath } from '../core/types.ts';
import type { VaultEntry } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';

export interface BaseMutationHost {
  /** Run transform once against the latest shared draft, validating after all awaits. */
  transform(path: string, transform: (source: string) => string, validate: () => void, validateWrite?: () => void, expectedWitness?: BaseSavedWitness): Promise<void>;
  /** Must validate inside the host's serialized rename transaction. */
  rename?(path: string, destination: string, validate: () => void, expectedWitness?: BaseSavedWitness): Promise<void>;
}
export interface BaseBufferHost {
  /** Must return the workspace's shared buffer, including existing dirty drafts. */
  getBuffer(path: string): NoteBuffer | Promise<NoteBuffer>;
  validate(): void;
  onBufferChange?(path: string, buffer: NoteBuffer, previousText: string): void;
  rename?: BaseMutationHost['rename'];
}
/** No private buffers or direct disk writes: use the same recovery/CAS path as typing. */
export function createBaseMutationHost(options: BaseBufferHost): BaseMutationHost {
  let pending: Promise<unknown> = Promise.resolve();
  return {
    transform(path, transform, validate, validateWrite = validate, expectedWitness) {
      const expected = expectedWitness && Object.freeze({ ...expectedWitness });
      const result = pending.then(async () => {
        options.validate(); validate();
        const buffer = await options.getBuffer(path);
        await buffer.load();
        options.validate(); validate();
        if (buffer.path !== path) throw new Error('The edited file moved');
        const durableWitness = () => (buffer as NoteBuffer & { readonly savedDurableWitness?: BaseSavedWitness & { readonly path: string } }).savedDurableWitness;
        const admitted = durableWitness();
        if (expected && (!admitted || admitted.entryId !== expected.entryId || admitted.revision !== expected.revision || admitted.path !== path)) {
          throw new Error('This saved Base result is stale or has no durable edit identity; refresh before editing');
        }
        const validateIdentity = () => {
          const current = durableWitness();
          if (expected && (!current || current.entryId !== expected.entryId || current.path !== path)) throw new Error('The edited saved file was replaced or moved');
        };
        const source = buffer.text, next = transform(source);
        // Transform is synchronous: no intervening editor input may be discarded.
        options.validate(); validate();
        if (buffer.text !== source) throw new Error('The edited buffer changed');
        // A previous failed save may already contain this exact transformed draft.
        // Retrying must still persist it (or report the continuing failure).
        if (next === source && !buffer.dirty && !buffer.error) return;
        buffer.update(next, { validateWrite: () => { options.validate(); validateWrite(); validateIdentity(); } });
        options.onBufferChange?.(path, buffer, source);
        // Do not replay or roll back a failed write: recovery draft owns that state.
        await buffer.flush();
      });
      pending = result.catch(() => undefined);
      return result;
    },
    ...(options.rename ? { rename: options.rename } : {}),
  };
}

export interface BaseControllerState {
  readonly version: number;
  readonly source: string;
  readonly result: BaseQueryResult | null;
  readonly error: Error | null;
  /** Refresh activity is separate from the coherent retained result. */
  readonly updating: boolean;
  /** Pending first-build explanation; never a successful empty result. */
  readonly previewStatus?: string;
}
export interface BaseControllerOptions {
  vault: Vault;
  basePath: string;
  mutations: BaseMutationHost;
  query?: BaseQueryOptions;
  /** View/host visibility and clock effects; never query semantics. */
  clock?: BaseClockHost;
  /** Internal embedded-view binding, resolved against each fresh configuration. */
  viewName?: string;
  /** Saved fenced configuration; byte spans are verified by the Rust service. */
  inlineSource?: {
    read(): Promise<{ source: string; startByte: number; endByte: number; witness?: BaseSavedWitness }>;
    transform(expectedSource: string, nextSource: string, validate: () => void): Promise<void>;
  };
  /** A fixed coalescing window; sustained events cannot postpone refresh forever. */
  delayMs?: number;
  onChange?(state: BaseControllerState): void;
}
export interface BasePropertyEdit {
  readonly version: number;
  readonly path: string;
  readonly property: string;
  readonly value: BaseValue;
}
export interface BaseConfigurationPatch {
  readonly view?: BaseViewPatch;
  readonly root?: BaseRootPatch;
}
interface PropertyState { readonly requestedKey: string; readonly key?: string; readonly value?: BaseValue }
interface PropertyHistoryEntry {
  readonly kind: 'properties'; path: string; identity: number;
  readonly entryId?: string; readonly before: readonly PropertyState[]; readonly after: readonly PropertyState[];
}
interface RenameHistoryEntry {
  readonly kind: 'rename'; readonly from: string; readonly to: string;
  readonly entryId?: string; identity: number; currentPath: string;
}
type BaseHistoryEntry = PropertyHistoryEntry | RenameHistoryEntry;
interface BaseHistoryCommand { entries: BaseHistoryEntry[] }
interface PropertyWrite extends BasePropertyEdit { readonly remove?: boolean }
export class BaseBulkEditError extends Error {
  readonly completedPaths: readonly string[];
  readonly failedPath: string;
  constructor(completedPaths: readonly string[], failedPath: string, cause: unknown) {
    super(completedPaths.length ? `Some files were saved before editing ${failedPath} failed. ${cause instanceof Error ? cause.message : String(cause)}` : `Editing ${failedPath} failed. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'BaseBulkEditError'; this.completedPaths = Object.freeze([...completedPaths]); this.failedPath = failedPath;
  }
}
function propertyState(source: string, keys: readonly string[]): PropertyState[] {
  const properties = readProperties(source);
  return keys.map(requestedKey => {
    const found = properties.find(item => item.key === requestedKey) ?? properties.find(item => item.key.toLowerCase() === requestedKey.toLowerCase());
    return found ? { requestedKey, key: found.key, value: structuredClone(found.value) } : { requestedKey };
  });
}
function statesEqual(left: readonly PropertyState[], right: readonly PropertyState[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export class BaseController {
  private options: BaseControllerOptions;
  private path: string;
  private query: BaseQueryOptions;
  private viewName?: string;
  private selectionSerial = 0;
  private configurationEpoch = 0;
  private undoCommands: BaseHistoryCommand[] = [];
  private redoCommands: BaseHistoryCommand[] = [];
  private historyBusy = false;
  private pendingPropertyHistory = new Map<string, PropertyHistoryEntry>();
  private pendingHistoryDirection = new WeakMap<BaseHistoryEntry, 'undo' | 'redo'>();
  private pendingConfigurations = new Map<string, { readonly index: number; readonly name: string; readonly bound: boolean; readonly selectionSerial: number; readonly entryId?: string; readonly adapter: Vault['adapter']; validate(): void }>();
  private epoch = 0;
  private version = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private subscriptions: (() => void)[];
  private signature = '';
  private identities = new Map<string, number>();
  private nextIdentity = 0;
  private refreshing = false;
  private requested = false;
  private sharedQueries = new SharedBaseQueryRunner();
  private summaryQueries = new Set<SharedBaseQueryRunner>();
  private queryEntries = new WeakMap<BaseQueryResult, { readonly definition: VaultEntry; readonly current: VaultEntry }>();
  private clock: BaseClockHost;
  private lastCapture?: BaseClockCapture;
  private cancelWake?: () => void;
  private wakeSerial = 0;
  private stale = true;
  private current: BaseControllerState = Object.freeze({ version: 0, source: '', result: null, error: null, updating: false });
  private settled = this.current;

  constructor(options: BaseControllerOptions) {
    this.options = options; this.path = normalizePath(options.basePath);
    this.clock = options.clock ?? createBaseClockHost();
    this.query = { ...options.query }; this.viewName = options.viewName;
    for (const path of options.vault.entries.keys()) this.identities.set(path, ++this.nextIdentity);
    this.subscriptions = (['create', 'modify', 'rename', 'delete', 'ready'] as const).map(event => options.vault.on(event, change => {
      if (event === 'ready' || change.path === this.path || change.oldPath === this.path) this.configurationEpoch++;
      if (event === 'delete' || event === 'rename') {
        const previous = change.oldPath ?? change.path;
        for (const path of this.identities.keys()) if (path === previous || path.startsWith(previous + '/')) this.identities.delete(path);
      }
      for (const path of options.vault.entries.keys()) if (!this.identities.has(path)) this.identities.set(path, ++this.nextIdentity);
      this.stale = true; this.clearWake();
      this.epoch++; this.sharedQueries.cancel();
      this.schedule();
    }));
    this.subscriptions.push(this.clock.subscribeWake(() => this.onClockWake()));
    this.schedule();
  }

  get state(): BaseControllerState { return this.current; }
  get basePath(): string { return this.path; }
  get selectedViewIndex(): number { return this.query.viewIndex ?? 0; }
  get canUndo(): boolean { return !this.disposed && !this.historyBusy && this.undoCommands.length > 0; }
  get canRedo(): boolean { return !this.disposed && !this.historyBusy && this.redoCommands.length > 0; }

  private schedule(): void {
    if (this.disposed || !this.clock.isVisible() || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, Math.max(0, Math.min(1000, this.options.delayMs ?? 30)));
  }

  private clearWake(): void { this.wakeSerial++; this.cancelWake?.(); this.cancelWake = undefined; }

  private armWake(result = this.current.result): void {
    this.clearWake();
    // An explicit fixed query clock cannot advance when a host wall timer fires.
    if (this.disposed || this.stale || !this.clock.isVisible() || this.query.now) return;
    const hint = result?.shared?.refreshHint;
    if (!hint || hint.dependency === 'none' || hint.nextWakeMs === null) return;
    const serial = this.wakeSerial;
    this.cancelWake = this.clock.scheduleAt(hint.nextWakeMs, () => {
      if (this.disposed || serial !== this.wakeSerial) return;
      this.cancelWake = undefined; this.onClockWake();
    });
  }

  private onClockWake(): void {
    if (this.disposed) return;
    this.clearWake();
    if (!this.clock.isVisible()) {
      if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.refreshing) { this.stale = true; this.epoch++; this.sharedQueries.cancel(); }
      if (this.current.updating) this.publish(this.settled);
      return;
    }
    const capture = this.clock.capture(this.query.timezone);
    const zoneChanged = this.lastCapture !== undefined && capture.timezone !== this.lastCapture.timezone;
    const hint = this.current.result?.shared?.refreshHint;
    const affected = !this.query.now && hint && hint.dependency !== 'none';
    const missed = affected && hint.nextWakeMs !== null && hint.nextWakeMs <= capture.clockMs;
    const backwards = affected && this.lastCapture !== undefined && capture.clockMs < this.lastCapture.clockMs;
    if (this.stale || zoneChanged || missed || backwards) {
      this.stale = true; this.epoch++; this.sharedQueries.cancel(); void this.refresh();
    } else this.armWake();
  }

  /** Refresh failures are represented in state; mutation failures reject to the caller. */
  refresh(): Promise<void> {
    this.clearWake(); this.stale = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const refresh = async () => {
      if (this.disposed || !this.clock.isVisible()) return;
      const epoch = this.epoch;
      if (!this.current.updating) this.publish({ ...this.current, updating: true, error: null });
      try {
        const service = this.options.vault.adapter.documentSemantics;
        const observe = async (path: string) => this.options.vault.adapter.stat ? await this.options.vault.adapter.stat(path) : this.options.vault.entries.get(path);
        const definition = service ? await observe(this.path) : undefined;
        const inline = this.options.inlineSource ? await this.options.inlineSource.read() : undefined;
        const source = inline ? inline.source : await this.options.vault.read(this.path);
        if (inline?.witness && definition && (inline.witness.entryId !== definition.entryId || inline.witness.revision !== definition.revision)) throw new Error('The containing note changed. Refresh before editing this Base.');
        if (this.disposed || epoch !== this.epoch) { this.schedule(); return; }
        let version = this.version + 1;
        const document = BaseDocument.parse(source);
        let viewIndex = this.query.viewIndex ?? 0;
        if (this.viewName !== undefined) {
          viewIndex = document.views.findIndex(view => view.name === this.viewName);
          if (viewIndex < 0) throw new Error(`Base view not found: ${this.viewName}`);
        }
        let result: BaseQueryResult;
        if (service) {
          const currentPath = this.query.currentFilePath ?? this.path;
          const current = currentPath === this.path ? definition : await observe(currentPath);
          if (!definition || !current) throw new Error('The saved Base or current file is unavailable.');
          const owner = this, allowPreview = !this.current.result || !!sharedBasePreview(this.current.result);
          const effectiveQuery: BaseQueryOptions & { inlineSource?: { source: string; startByte: number; endByte: number } } = inline ? { ...this.query, inlineSource: { source, startByte: inline.startByte, endByte: inline.endByte } } : this.query;
          const request = { service, definition, current, entries: [...this.options.vault.entries.values()], query: effectiveQuery,
            viewIndex, viewName: this.viewName, get version() { return owner.version + 1; }, clock: this.clock, isCurrent: () => !this.disposed && epoch === this.epoch,
            readFile: (path: string) => this.options.vault.read(path),
            ...(allowPreview ? {
              onPreview: (result: BaseQueryResult) => {
                if (this.disposed || epoch !== this.epoch || this.current.result && !sharedBasePreview(this.current.result)) return;
                this.version = Number(result.version);
                this.publish({ version: this.version, source, result, error: null, updating: true });
              },
              onPreviewStatus: (message: string) => {
                if (!this.disposed && epoch === this.epoch) this.publish({ ...this.current, previewStatus: message, error: null, updating: true });
              },
            } : {}),
          };
          result = await this.sharedQueries.query(request);
          version = Number(result.version);
          if (this.disposed || epoch !== this.epoch) { this.schedule(); return; }
          const latest = await observe(this.path);
          if (!latest || latest.entryId !== definition.entryId || latest.revision !== definition.revision) throw new Error('The Base definition changed. Refresh before editing.');
          if (this.disposed || epoch !== this.epoch) { this.schedule(); return; }
          this.queryEntries.set(result, { definition: Object.freeze({ ...definition }), current: Object.freeze({ ...current }) });
        } else {
          const files = [...this.options.vault.entries.values()].filter(entry => entry.type === 'file').map(entry => {
            const metadata = this.options.vault.metadata.get(entry.path);
            return { path: entry.path, ctime: entry.ctime, mtime: entry.mtime, size: entry.size,
              properties: metadata?.frontmatter, tags: metadata?.tags };
          });
          result = executeBaseQuery(document, { version, files }, { currentFilePath: this.path, ...this.query, viewIndex });
        }
        this.query = { ...this.query, viewIndex };
        this.lastCapture = sharedBaseCapture(result);
        this.stale = false; this.armWake(result);
        const signature = JSON.stringify([source, this.identities.get(this.path), result.rows.map(row => this.identities.get(row.path)), { ...result, version: 0 }, sharedBaseCoverage(result)]);
        if (signature === this.signature && !this.settled.error) { this.publish(this.settled); return; }
        this.version = version; this.signature = signature;
        this.publish({ version, source, result, error: null, updating: false });
      } catch (error) {
        if (!this.disposed && epoch === this.epoch) this.publish({ ...this.current, updating: false, error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    this.requested = true;
    if (this.refreshing) return this.pending;
    this.refreshing = true;
    this.pending = (async () => {
      try {
        do { this.requested = false; await refresh(); } while (this.requested && !this.disposed);
      } finally {
        // Release in the same continuation as the final requested check. A
        // later promise.finally leaves a gap that can lose a new refresh.
        this.refreshing = false;
      }
    })();
    return this.pending;
  }

  private publish(state: BaseControllerState): void {
    this.current = Object.freeze(state);
    if (!state.updating) this.settled = this.current;
    try { this.options.onChange?.(this.current); } catch (error) { console.error('Bases observer failed', error); }
  }

  setView(viewIndex: number): Promise<void> {
    if (this.viewName !== undefined) {
      if (this.current.error) return Promise.reject(this.current.error);
      if (!this.current.result) return Promise.reject(new Error('The Base configuration is not ready'));
      const view = BaseDocument.parse(this.current.source).views[viewIndex];
      if (!Number.isInteger(viewIndex) || !view) return Promise.reject(new Error('The selected base view does not exist'));
      // An explicit local selection binds its name too, so later reordering
      // cannot retarget an embedded view to an unrelated configuration.
      this.viewName = view.name;
    }
    this.selectionSerial++;
    this.query = { ...this.query, viewIndex }; this.stale = true; this.clearWake(); this.epoch++; this.sharedQueries.cancel();
    return this.refresh();
  }

  setSearchTerms(terms: readonly string[]): Promise<void> {
    if (!Array.isArray(terms) || terms.some(term => typeof term !== 'string')) return Promise.reject(new Error('Search terms must be strings'));
    this.query = { ...this.query, searchTerms: [...terms] };
    this.stale = true; this.clearWake(); this.epoch++; this.sharedQueries.cancel();
    return this.refresh();
  }

  setCurrentFilePath(path: string): Promise<void> {
    path = normalizePath(path);
    if (this.query.currentFilePath === path) return Promise.resolve();
    this.query = { ...this.query, currentFilePath: path };
    this.stale = true; this.clearWake(); this.epoch++; this.sharedQueries.cancel();
    return this.refresh();
  }

  /** Read-only footer advice from an independent saved-core invocation. Opening
   * a menu never writes configuration, publishes results or cancels its query. */
  async summaryPreviews(property: string, groupKeyId?: string): Promise<Readonly<Record<string, BaseExpressionValue>>> {
    if (typeof property !== 'string' || !property.trim()) throw new Error('A summary property is required');
    property = normalizeBaseProperty(property);
    const version = this.current.version, source = this.current.source, epoch = this.epoch;
    const { validate: validateResult } = this.guard(version, this.path);
    if (groupKeyId !== undefined && (typeof groupKeyId !== 'string' || !groupKeyId || !this.current.result!.groups.some(group => group.sharedKeyId === groupKeyId))) throw new Error('This Base group is stale or unavailable for summary previews');
    const vault = this.options.vault, adapter = vault.adapter, service = adapter.documentSemantics;
    if (!service) throw new Error('Summary previews are unavailable on this host');
    const retained = this.queryEntries.get(this.current.result!);
    if (!retained) throw new Error('Summary previews require current saved core results');
    const saved = sharedBaseWitness(this.current.result!, this.path);
    const validate = () => {
      validateResult();
      if (vault.adapter !== adapter || adapter.documentSemantics !== service || this.current.source !== source) throw new Error('This Base changed before summary previews were ready');
    };
    const observe = async (path: string) => adapter.stat ? await adapter.stat(path) : vault.entries.get(path);
    validate();
    const definition = await observe(this.path); validate();
    if (!definition?.entryId || !definition.revision || !saved || definition.entryId !== saved.entryId || definition.revision !== saved.revision
      || definition.entryId !== retained.definition.entryId || definition.revision !== retained.definition.revision) throw new Error('The saved Base changed; refresh before requesting summary previews');
    const inline = this.options.inlineSource ? await this.options.inlineSource.read() : undefined;
    validate();
    if (inline && (inline.source !== source || inline.witness && (inline.witness.entryId !== definition.entryId || inline.witness.revision !== definition.revision))) throw new Error('The containing note changed; refresh before requesting summary previews');
    const currentPath = this.query.currentFilePath ?? this.path;
    const current = currentPath === this.path ? definition : await observe(currentPath); validate();
    if (!current?.entryId || !current.revision || current.entryId !== retained.current.entryId || current.revision !== retained.current.revision || current.path !== retained.current.path) throw new Error('The current saved note changed; refresh before requesting summary previews');
    const captured = sharedBaseCapture(this.current.result!);
    const query: BaseQueryOptions & { summaryPreviewProperty: string; summaryPreviewGroupKeyId?: string; inlineSource?: { source: string; startByte: number; endByte: number } } = {
      ...this.query, searchTerms: this.query.searchTerms && [...this.query.searchTerms], summaryPreviewProperty: property, summaryPreviewGroupKeyId: groupKeyId,
      ...(captured ? { now: () => new Date(captured.clockMs), timezone: captured.timezone } : {}),
      ...(inline ? { inlineSource: { source, startByte: inline.startByte, endByte: inline.endByte } } : {}),
    };
    const runner = new SharedBaseQueryRunner(); this.summaryQueries.add(runner);
    try {
      const request = { service, definition, current, entries: [...vault.entries.values()], query, version,
        viewIndex: this.selectedViewIndex, viewName: this.viewName, clock: this.clock,
        isCurrent: () => !this.disposed && epoch === this.epoch && version === this.current.version && vault.adapter === adapter,
        readFile: async (path: string) => { validate(); const text = await vault.read(path); validate(); return text; },
      };
      const result = await runner.query(request); validate();
      const latestDefinition = await observe(this.path); validate();
      const latestCurrent = currentPath === this.path ? latestDefinition : await observe(currentPath); validate();
      if (!latestDefinition || latestDefinition.entryId !== definition.entryId || latestDefinition.revision !== definition.revision
        || !latestCurrent || latestCurrent.entryId !== current.entryId || latestCurrent.revision !== current.revision) throw new Error('The saved Base or current note changed; refresh before requesting summary previews');
      const previews = (result as BaseQueryResult & { readonly summaryPreviews?: Readonly<Record<string, BaseExpressionValue>> }).summaryPreviews;
      if (!previews) throw new Error('Summary previews are unavailable on this host');
      return previews;
    } finally { this.summaryQueries.delete(runner); runner.dispose(); }
  }

  private guard(version: number, path: string): { validate: () => void; validateWrite: () => void } {
    const epoch = this.epoch, identity = this.identities.get(path), base = this.identities.get(this.path);
    const validateWrite = () => {
      if (this.disposed || !identity || this.identities.get(path) !== identity || !base || this.identities.get(this.path) !== base) {
        throw new Error('This base result is stale; refresh before editing');
      }
    };
    const validate = () => {
      validateWrite();
      if (this.current.result && sharedBasePreview(this.current.result)) throw new Error('Indexing previews are read-only. Wait for saved results before editing.');
      if (this.current.error || !this.current.result || version !== this.current.version || epoch !== this.epoch) throw new Error('This base result is stale; refresh before editing');
    };
    validate(); return { validate, validateWrite };
  }

  editProperty(edit: BasePropertyEdit): Promise<void> { return this.writeProperties([edit]); }

  editProperties(edits: readonly BasePropertyEdit[]): Promise<void> { return this.writeProperties(edits); }

  private recordHistory(entries: BaseHistoryEntry[]): void {
    if (!entries.length) return;
    this.undoCommands.push({ entries }); this.redoCommands = [];
    if (this.undoCommands.length > 100) this.undoCommands.shift();
  }

  private async writeProperty(edit: BasePropertyEdit, remove = false): Promise<void> {
    return this.writeProperties([{ ...edit, remove }]);
  }

  private async writeProperties(input: readonly PropertyWrite[]): Promise<void> {
    if (this.historyBusy) throw new Error('Another Base command is still running');
    if (!Array.isArray(input)) throw new Error('Property edits must be a list');
    if (!input.length) return;
    const edits = structuredClone(input), result = this.current.result;
    const groups = new Map<string, PropertyWrite[]>(), guards = new Map<string, ReturnType<BaseController['guard']>>();
    for (const edit of edits) {
      const path = normalizePath(edit.path), guard = this.guard(edit.version, path);
      if (!result!.rows.some(row => row.path === path)) throw new Error('The file is not in this base result');
      const property = normalizeBaseProperty(edit.property);
      if (!property.startsWith('note.')) throw new Error('Only note properties can be edited as frontmatter');
      if (!isMarkdown(path)) throw new Error('This file cannot contain Markdown properties');
      const list = groups.get(path) ?? [];
      list.push({ ...edit, path, property }); groups.set(path, list); guards.set(path, guard);
    }
    const selection = this.selectionSerial, config = this.configurationEpoch;
    const completed: string[] = [], history: BaseHistoryEntry[] = [];
    this.historyBusy = true;
    try {
      for (const [path, values] of groups) {
        const guard = guards.get(path)!, keys = [...new Set(values.map(edit => edit.property.slice(5)))];
        const signature = JSON.stringify([path, this.identities.get(path), values.map(({ property, value, remove }) => ({ property, value, remove }))]);
        let entry = this.pendingPropertyHistory.get(signature);
        const validate = () => {
          guard.validateWrite();
          if (this.selectionSerial !== selection || this.configurationEpoch !== config) throw new Error('The Base configuration or selected view changed before editing');
          if (!completed.length) guard.validate();
        };
        try {
          const witness = sharedBaseWitness(result!, path);
          await this.options.mutations.transform(path, source => {
            validate(); const before = propertyState(source, keys);
            let next = source;
            for (const edit of values) {
              const key = edit.property.slice(5), current = propertyState(next, [key])[0];
              next = edit.remove ? current.key === undefined ? next : removeProperty(next, current.key) : setProperty(next, current.key ?? key, edit.value);
            }
            const after = propertyState(next, keys);
            // An exact failed draft retry retains its original undo baseline.
            if (!entry || !statesEqual(before, entry.after)) {
              entry = { kind: 'properties', path, identity: this.identities.get(path)!, entryId: witness?.entryId ?? this.options.vault.entries.get(path)?.entryId, before, after };
              this.pendingPropertyHistory.set(signature, entry);
            }
            return next;
          }, validate, () => {
            guard.validateWrite();
            if (this.selectionSerial !== selection || this.configurationEpoch !== config) throw new Error('The Base configuration or selected view changed before saving');
          }, witness);
          completed.push(path); this.pendingPropertyHistory.delete(signature);
          if (entry && !statesEqual(entry.before, entry.after)) history.push(entry);
        } catch (error) {
          this.recordHistory(history);
          if (groups.size === 1) throw error;
          throw new BaseBulkEditError(completed, path, error);
        }
      }
      this.recordHistory(history);
    } finally { this.historyBusy = false; }
    await this.refresh();
  }

  /** Kanban membership is the persisted group property, never a transient visual order. */
  moveToGroup(edit: Omit<BasePropertyEdit, 'property'>): Promise<void> {
    const group = this.current.result?.view.groupBy;
    if (!group || typeof group !== 'object' || Array.isArray(group) || !('property' in group) || typeof group.property !== 'string') {
      return Promise.reject(new Error('This view has no editable grouping property'));
    }
    // Reference Kanban clears the key for the empty group; table null edits remain values.
    if (edit.value === null) return this.writeProperty({ ...edit, property: group.property }, true);
    const current = this.current.result?.rows.find(row => row.path === edit.path)?.values[normalizeBaseProperty(group.property)];
    if (current?.type === 'list' && !Array.isArray(edit.value)) return Promise.reject(new Error('List-valued group membership requires an explicit list destination'));
    return this.editProperty({ ...edit, property: group.property });
  }

  async renameFile(version: number, path: string, destination: string): Promise<void> {
    if (this.historyBusy) throw new Error('Another Base command is still running');
    path = normalizePath(path); destination = normalizePath(destination);
    const { validate } = this.guard(version, path);
    if (!this.options.mutations.rename) throw new Error('The host does not provide guarded file renaming');
    if (!this.current.result!.rows.some(row => row.path === path)) throw new Error('The file is not in this base result');
    if (path === destination) return;
    const originalIdentity = this.identities.get(path)!, witness = sharedBaseWitness(this.current.result!, path);
    const entryId = witness?.entryId ?? this.options.vault.entries.get(path)?.entryId;
    this.historyBusy = true;
    try {
      try { await this.options.mutations.rename(path, destination, validate, witness); }
      catch (error) {
        // A durable namespace commit may succeed before a backlink/publication
        // failure. Only stable identity, never matching text/name, proves it.
        const moved = this.options.vault.entries.get(destination);
        if (entryId && moved?.entryId === entryId) {
          this.retargetHistory(path, destination, originalIdentity, entryId);
          this.recordHistory([{ kind: 'rename', from: path, to: destination, entryId, currentPath: destination, identity: this.identities.get(destination)! }]);
          throw new BaseBulkEditError([destination], path, error);
        }
        throw error;
      }
      this.retargetHistory(path, destination, originalIdentity, entryId);
      this.recordHistory([{ kind: 'rename', from: path, to: destination, entryId, currentPath: destination, identity: this.identities.get(destination)! }]);
    } finally { this.historyBusy = false; }
    await this.refresh();
  }

  private retargetHistory(from: string, to: string, identity: number, entryId?: string): void {
    const nextIdentity = this.identities.get(to);
    if (!nextIdentity) return;
    const entries = [...this.undoCommands, ...this.redoCommands].flatMap(command => command.entries).concat([...this.pendingPropertyHistory.values()]);
    for (const entry of entries) {
      const path = entry.kind === 'properties' ? entry.path : entry.currentPath;
      if (path !== from || entry.identity !== identity || entryId && entry.entryId && entry.entryId !== entryId) continue;
      if (entry.kind === 'properties') entry.path = to; else entry.currentPath = to;
      entry.identity = nextIdentity;
    }
  }

  undo(): Promise<void> { return this.applyHistory('undo'); }
  redo(): Promise<void> { return this.applyHistory('redo'); }

  private async applyHistory(direction: 'undo' | 'redo'): Promise<void> {
    if (this.historyBusy) throw new Error('Another Base command is still running');
    const source = direction === 'undo' ? this.undoCommands : this.redoCommands;
    const destination = direction === 'undo' ? this.redoCommands : this.undoCommands;
    const command = source.at(-1);
    if (!command) return;
    const admitted = this.guard(this.current.version, this.path);
    const config = this.configurationEpoch, selection = this.selectionSerial;
    const ordered = direction === 'undo' ? [...command.entries].reverse() : [...command.entries];
    const applied: BaseHistoryEntry[] = [], completed: string[] = [];
    const validate = (entry: BaseHistoryEntry) => {
      admitted.validateWrite();
      const path = entry.kind === 'properties' ? entry.path : entry.currentPath;
      if (this.identities.get(path) !== entry.identity || config !== this.configurationEpoch || selection !== this.selectionSerial) throw new Error('The file, Base configuration or selected view changed; this command cannot be reversed');
      const current = this.options.vault.entries.get(path);
      if (!current || entry.entryId && current.entryId !== entry.entryId) throw new Error('The original file was replaced; this command cannot be reversed');
    };
    // All retained targets must still exist before a multi-file reversal starts.
    for (const entry of ordered) validate(entry);
    this.historyBusy = true;
    const publishApplied = () => {
      if (!applied.length) return;
      const selected = new Set(applied);
      command.entries = command.entries.filter(entry => !selected.has(entry));
      if (!command.entries.length) source.pop();
      // Keep original execution order in both stacks, even when undo ran back.
      destination.push({ entries: direction === 'undo' ? [...applied].reverse() : [...applied] });
    };
    try {
      for (const entry of ordered) {
        const path = entry.kind === 'properties' ? entry.path : entry.currentPath;
        try {
          validate(entry);
          const observed = this.options.vault.adapter.stat ? await this.options.vault.adapter.stat(path) : this.options.vault.entries.get(path);
          validate(entry);
          if (!observed || entry.entryId && observed.entryId !== entry.entryId) throw new Error('The original file was replaced; this command cannot be reversed');
          const witness = observed.entryId && observed.revision ? { entryId: observed.entryId, revision: observed.revision } : undefined;
          if (entry.kind === 'properties') {
            const expected = direction === 'undo' ? entry.after : entry.before;
            const desired = direction === 'undo' ? entry.before : entry.after;
            await this.options.mutations.transform(path, text => {
              validate(entry);
              const current = propertyState(text, expected.map(state => state.requestedKey));
              const retry = this.pendingHistoryDirection.get(entry) === direction && statesEqual(current, desired);
              if (!statesEqual(current, expected) && !retry) throw new Error('A touched property changed after this command; its current value was preserved');
              let next = text;
              for (const state of desired) {
                const current = propertyState(next, [state.requestedKey])[0];
                if (current.key !== undefined && current.key !== state.key) next = removeProperty(next, current.key);
                if (state.key !== undefined) next = setProperty(next, state.key, state.value!);
              }
              this.pendingHistoryDirection.set(entry, direction);
              return next;
            }, () => validate(entry), () => validate(entry), witness);
          } else {
            if (!this.options.mutations.rename) throw new Error('The host does not provide guarded file renaming');
            const target = direction === 'undo' ? entry.from : entry.to, previousIdentity = entry.identity;
            try { await this.options.mutations.rename(path, target, () => validate(entry), witness); }
            catch (error) {
              const moved = this.options.vault.entries.get(target);
              if (entry.entryId && moved?.entryId === entry.entryId) {
                this.retargetHistory(path, target, previousIdentity, entry.entryId);
                entry.currentPath = target; entry.identity = this.identities.get(target)!;
                this.pendingHistoryDirection.delete(entry);
                applied.push(entry); completed.push(path);
              }
              throw error;
            }
            this.retargetHistory(path, target, previousIdentity, entry.entryId);
            entry.currentPath = target; entry.identity = this.identities.get(target)!;
          }
          this.pendingHistoryDirection.delete(entry);
          applied.push(entry); completed.push(path);
        } catch (error) {
          publishApplied();
          if (ordered.length === 1) throw error;
          throw new BaseBulkEditError(completed, path, error);
        }
      }
      publishApplied();
    } finally { this.historyBusy = false; }
    await this.refresh();
  }

  updateView(version: number, patch: BaseViewPatch): Promise<void>;
  updateView(version: number, index: number, patch: BaseViewPatch): Promise<void>;
  async updateView(version: number, indexOrPatch: number | BaseViewPatch, patch?: BaseViewPatch): Promise<void> {
    return this.updateViewAt(version, typeof indexOrPatch === 'number' ? indexOrPatch : this.selectedViewIndex, typeof indexOrPatch === 'number' ? patch! : indexOrPatch);
  }

  async updateViewAt(version: number, index: number, patch: BaseViewPatch): Promise<void> {
    const detached = structuredClone(patch), active = this.selectedViewIndex;
    await this.changeConfiguration(version, document => {
      if (Object.hasOwn(detached, 'name')) detached.name = validateBaseViewName(detached.name as string, document.views, index);
      document.updateView(index, detached);
      return active;
    });
  }

  async updateConfiguration(version: number, patch: BaseConfigurationPatch): Promise<void> {
    const detached = structuredClone(patch), index = this.selectedViewIndex;
    if (detached.root && Object.hasOwn(detached.root, 'views')) throw new Error('Use the guarded view commands to manage base views');
    await this.changeConfiguration(version, document => {
      if (detached.root) document.updateRoot(detached.root);
      if (detached.view) {
        if (Object.hasOwn(detached.view, 'name')) detached.view.name = validateBaseViewName(detached.view.name as string, document.views, index);
        document.updateView(index, detached.view);
      }
      return index;
    });
  }

  /** Shared absolute-source transaction. A retry persists the same draft once. */
  private async changeConfiguration(version: number, change: (document: BaseDocument) => number): Promise<void> {
    const { validate, validateWrite } = this.guard(version, this.path), expected = this.current.source;
    const document = BaseDocument.parse(expected), index = change(document), desired = document.toString();
    const selected = document.views[index];
    if (!selected) throw new Error('The selected base view does not exist');
    const selectionSerial = this.selectionSerial;
    const witness = sharedBaseWitness(this.current.result!, this.path);
    const retry = { index, name: selected.name, bound: this.viewName !== undefined, selectionSerial, entryId: witness?.entryId, adapter: this.options.vault.adapter, validate: validateWrite };
    let prepared = false;
    const validateSelection = () => {
      // Even an explicit switch back to the same view retires the command.
      if (this.selectionSerial !== selectionSerial) throw new Error('This base result is stale; the selected view changed before the configuration was saved');
      validate();
    };
    const transform = (source: string) => {
      validateSelection();
      // A failed flush may already retain exactly this absolute patch. Retry its
      // guarded persistence, but never merge unrelated unsaved configuration.
      if (source !== expected && source !== desired) throw new Error('The base configuration has an unsaved or external edit');
      prepared = true;
      return desired;
    };
    try { if (this.options.inlineSource) {
      // Inline configuration is not the containing note's property transform.
      // The host replaces only its captured fence and retains the whole draft.
      validateSelection();
      await this.options.inlineSource.transform(expected, desired, validateSelection);
    } else await this.options.mutations.transform(this.path, transform, validateSelection, validateWrite, witness);
    } catch (error) {
      if (prepared || this.options.inlineSource) this.pendingConfigurations.set(desired, retry);
      throw error;
    }
    this.pendingConfigurations.clear();
    // A config's own modify event advances epoch. An explicit view selection
    // also advances it, but updates query/name: never undo that later choice.
    if (!this.disposed && this.selectionSerial === selectionSerial) {
      this.query = { ...this.query, viewIndex: index };
      if (this.viewName !== undefined) this.viewName = selected.name;
      this.stale = true; this.clearWake();
      this.epoch++; this.sharedQueries.cancel();
    }
    await this.refresh();
  }

  /** The session may flush an already transformed recovery draft itself. Only
   * acknowledge an exact originally attempted configuration and file identity;
   * never reconstruct or replay the original semantic command. */
  async acknowledgeConfigurationRetry(): Promise<boolean> {
    if (!this.pendingConfigurations.size) return false;
    if (this.disposed) throw new Error('This base result is stale; the controller was closed');
    const adapter = this.options.vault.adapter, epoch = this.configurationEpoch;
    const observe = () => adapter.stat ? adapter.stat(this.path) : Promise.resolve(this.options.vault.entries.get(this.path));
    const before = await observe();
    const inline = this.options.inlineSource ? await this.options.inlineSource.read() : undefined;
    const source = inline ? inline.source : await this.options.vault.read(this.path);
    const retry = this.pendingConfigurations.get(source);
    if (!retry) throw new Error('The saved Base does not match an attempted configuration retry');
    retry.validate();
    const entry = await observe();
    retry.validate();
    if (this.options.vault.adapter !== adapter || adapter !== retry.adapter || !entry || retry.entryId && entry.entryId !== retry.entryId) throw new Error('The original Base was replaced before its configuration retry was acknowledged');
    if (!before || before.entryId !== entry.entryId || before.revision !== entry.revision || before.mtime !== entry.mtime || before.size !== entry.size || epoch !== this.configurationEpoch
      || inline?.witness && (inline.witness.entryId !== entry.entryId || inline.witness.revision !== entry.revision)) throw new Error('The Base changed while its configuration retry was being acknowledged');
    if (this.selectionSerial === retry.selectionSerial) {
      this.query = { ...this.query, viewIndex: retry.index };
      if (retry.bound) this.viewName = retry.name;
      this.stale = true; this.clearWake(); this.epoch++; this.sharedQueries.cancel();
    }
    this.pendingConfigurations.clear();
    await this.refresh(); return true;
  }

  async addView(version: number, type: string, name?: string, patch?: BaseViewPatch): Promise<void> {
    const detached = structuredClone(patch ?? {});
    await this.changeConfiguration(version, document => {
      const defaultName = type ? type[0].toUpperCase() + type.slice(1) : '';
      const chosen = validateBaseViewName(name ?? uniqueBaseViewName(defaultName, document.views), document.views);
      if (Object.hasOwn(detached, 'type') && detached.type !== type || Object.hasOwn(detached, 'name') && detached.name !== chosen) throw new Error('Initial view settings must use the requested view type and name');
      const index = document.addView(type, chosen); document.updateView(index, detached); return index;
    });
  }

  async duplicateView(version: number, index = this.selectedViewIndex, name?: string): Promise<void> {
    await this.changeConfiguration(version, document => {
      const view = document.views[index];
      if (!view) throw new Error('The selected base view does not exist');
      const chosen = validateBaseViewName(name ?? uniqueBaseViewName(view.name, document.views), document.views);
      return document.duplicateView(index, chosen);
    });
  }

  async removeView(version: number, index = this.selectedViewIndex): Promise<void> {
    const active = this.selectedViewIndex;
    await this.changeConfiguration(version, document => {
      // Keep the editor usable until last-view reference behavior is verified.
      if (document.views.length <= 1) throw new Error('The last base view cannot be deleted');
      document.removeView(index);
      return active === index ? Math.max(0, index - 1) : active > index ? active - 1 : active;
    });
  }

  async moveView(version: number, from: number, to: number): Promise<void> {
    const active = this.selectedViewIndex;
    await this.changeConfiguration(version, document => {
      document.moveView(from, to);
      return active === from ? to : from < active && active <= to ? active - 1 : to <= active && active < from ? active + 1 : active;
    });
  }

  setDefaultView(version: number, index = this.selectedViewIndex): Promise<void> { return this.moveView(version, index, 0); }

  async updateRoot(version: number, patch: BaseRootPatch): Promise<void> {
    const detached = structuredClone(patch);
    if (Object.hasOwn(detached, 'views')) throw new Error('Use the guarded view commands to manage base views');
    await this.changeConfiguration(version, document => { document.updateRoot(detached); return this.selectedViewIndex; });
  }

  async setFormula(version: number, name: string, expression: string | undefined): Promise<void> {
    await this.changeConfiguration(version, document => { document.setFormula(name, expression); return this.selectedViewIndex; });
  }

  async renameFormula(version: number, from: string, to: string): Promise<void> {
    await this.changeConfiguration(version, document => { document.renameFormula(from, to); return this.selectedViewIndex; });
  }

  async editFormula(version: number, originalName: string | undefined, name: string, expression: string): Promise<void> {
    await this.changeConfiguration(version, document => {
      if (originalName !== undefined && originalName !== name) document.renameFormula(originalName, name);
      if (originalName === undefined) {
        const formulas = document.getRoot('formulas');
        if (formulas && !Array.isArray(formulas) && typeof formulas === 'object' && Object.hasOwn(formulas, name)) throw new Error('A formula with this name already exists');
      }
      document.setFormula(name, expression); return this.selectedViewIndex;
    });
  }

  dispose(): void {
    this.disposed = true; this.clearWake(); this.epoch++; this.sharedQueries.dispose();
    for (const runner of this.summaryQueries) runner.dispose(); this.summaryQueries.clear();
    this.undoCommands = []; this.redoCommands = []; this.pendingPropertyHistory.clear(); this.pendingConfigurations.clear();
    // Disposal retires activity without publishing an observer after closure.
    this.current = this.settled;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = [];
  }
}
