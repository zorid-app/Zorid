import { BaseDocument, baseViewSource, baseViewSetting, baseViewIndexById, baseViewIndexByName, newBaseViewId, uniqueBaseViewName, validateBaseViewName } from './document.ts';
import type { BaseValue, BaseViewPatch, BaseRootPatch, BaseViewSource } from './document.ts';
import type { BaseExpressionValue } from './expression.ts';
import { executeBaseQuery, normalizeBaseProperty } from './query.ts';
import type { BaseQueryOptions, BaseQueryResult } from './query.ts';
import { SharedBaseQueryRunner, sharedBaseWitness, sharedBaseCapture, sharedBaseCoverage, sharedBasePreview } from './shared-query.ts';
import { createBaseClockHost } from './clock.ts';
import { baseEditAdmissionVersion, recordBaseEditAdmission, withBaseEditAdmissionPhase } from './edit-admission-diagnostics.ts';
import type { BaseEditAdmissionReason, BaseEditInvalidationKind } from './edit-admission-diagnostics.ts';
import type { BaseClockCapture, BaseClockHost } from './clock.ts';
import type { BaseSavedWitness } from './shared-query.ts';
import { readProperties, removeProperty, setProperty } from '../core/properties.ts';
import { isMarkdown, normalizePath } from '../core/types.ts';
import type { VaultEntry } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';
import type { ConditionalSavedSourceCapture, ConditionalSavedSourceWitness } from '../core/durable-writes.ts';
import { closeBaseViewReferenceQueries, prepareBaseViewReferences } from './view-references.ts';
import type { BaseViewReferenceOperation, BaseViewRenameReport } from './view-references.ts';

export interface BaseViewRenamed { readonly basePath: string; readonly index: number; readonly viewId?: string; readonly from: string; readonly to: string }

export interface BaseMutationHost {
  /** Run transform once against the latest shared draft, validating after all awaits. */
  transform(path: string, transform: (source: string) => string, validate: () => void, validateWrite?: () => void, expectedWitness?: BaseSavedWitness, conditionalSource?: BaseConditionalSavedSource): Promise<void>;
  /** Must validate inside the host's serialized rename transaction. */
  rename?(path: string, destination: string, validate: () => void, expectedWitness?: BaseSavedWitness): Promise<void>;
}
export interface BaseConditionalSavedSource {
  /** Stable only for retries of this original semantic command. */
  readonly attempt: object;
  /** Original logical bytes are captured before the physical-source await. */
  validate(source: string, originalSavedSource: string): void;
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
  const conditional = new WeakMap<NoteBuffer, { attempt: object; capture: ConditionalSavedSourceCapture; originalSavedSource: string; desiredSource?: string }>();
  const conditionalAttempts = new WeakMap<object, { buffer: NoteBuffer; capture: ConditionalSavedSourceCapture }>();
  return {
    transform(path, transform, validate, validateWrite = validate, expectedWitness, sourceCondition) {
      const expected = expectedWitness && Object.freeze({ ...expectedWitness });
      const conditionalSource = sourceCondition && Object.freeze({ attempt: sourceCondition.attempt, validate: sourceCondition.validate });
      const result = pending.then(async () => {
        withBaseEditAdmissionPhase('before-buffer', () => { options.validate(); validate(); });
        const buffer = await options.getBuffer(path);
        await buffer.load();
        withBaseEditAdmissionPhase('after-buffer-load', () => { options.validate(); validate(); });
        if (buffer.path !== path) throw new Error('The edited file moved');
        const durableWitness = () => (buffer as NoteBuffer & { readonly savedDurableWitness?: BaseSavedWitness & { readonly path: string } }).savedDurableWitness;
        let admitted = durableWitness();
        type ConditionalBuffer = NoteBuffer & {
          captureConditionalSavedSource?(witness: ConditionalSavedSourceWitness, validate?: () => void): Promise<ConditionalSavedSourceCapture | undefined>;
          releaseConditionalSavedSource?(capture: ConditionalSavedSourceCapture): Promise<void>;
          conditionalSavedSourceStatus?(capture: ConditionalSavedSourceCapture): 'unattached' | 'pending' | 'settled' | 'foreign';
        };
        const guarded = buffer as ConditionalBuffer;
        const original = conditionalSource && conditionalAttempts.get(conditionalSource.attempt);
        if (original && original.buffer !== buffer) throw new Error('The original conditional Base buffer was replaced; its save cannot be replayed');
        let retained = conditional.get(buffer);
        // A generic shared-buffer Save may settle the exact original operation
        // without reentering this host. Retire only its clean, acknowledged text;
        // a pending/rejected guard or newer draft still belongs to that attempt.
        if (retained && (!conditionalSource || retained.attempt !== conditionalSource.attempt)
          && guarded.conditionalSavedSourceStatus?.(retained.capture) === 'settled'
          && !buffer.dirty && !buffer.error && !buffer.hasRecoveryConflict
          && retained.desiredSource !== undefined && buffer.text === retained.desiredSource && buffer.savedText === retained.desiredSource
          && admitted?.entryId === retained.capture.logicalWitness.entryId && admitted.path === retained.capture.logicalWitness.path) {
          conditional.delete(buffer); conditionalAttempts.delete(retained.attempt); retained = undefined;
        }
        if (original && original.capture !== retained?.capture) throw new Error('The original conditional Base capture is no longer owned by this buffer');
        if (retained && (!conditionalSource || retained.attempt !== conditionalSource.attempt)) throw new Error('Retry the original conditional Base command before editing this note');
        const status = retained && guarded.conditionalSavedSourceStatus?.(retained.capture);
        if (retained && (!status || status === 'foreign')) throw new Error('The original conditional Base save is no longer owned by this buffer');
        // A fresh query can precede the workspace's clean-buffer notification.
        // Reload only a genuine logical revision, never physical capture bytes,
        // and never disturb an accepted draft or an original retained attempt.
        if (expected && admitted?.entryId === expected.entryId && admitted.path === path && admitted.revision !== expected.revision
          && !retained && !buffer.dirty && !buffer.error && !buffer.hasRecoveryConflict && typeof buffer.reload === 'function') {
          await buffer.reload();
          options.validate(); validate();
          if (buffer.path !== path) throw new Error('The edited file moved');
          admitted = durableWitness();
        }
        // A committing original intent may have advanced the core revision before
        // its buffer acknowledgement. Resume that intent, never capture it again.
        if (expected && (!admitted || admitted.entryId !== expected.entryId || admitted.path !== path || status !== 'pending' && admitted.revision !== expected.revision)) {
          throw new Error('This saved Base result is stale or has no durable edit identity; refresh before editing');
        }
        const validateIdentity = () => {
          const current = durableWitness();
          if (expected && (!current || current.entryId !== expected.entryId || current.path !== path)) throw new Error('The edited saved file was replaced or moved');
        };
        const forget = () => {
          conditional.delete(buffer);
          if (conditionalSource) conditionalAttempts.delete(conditionalSource.attempt);
        };
        try {
          if (conditionalSource && !retained && admitted) {
            if (!guarded.captureConditionalSavedSource || !guarded.releaseConditionalSavedSource || !guarded.conditionalSavedSourceStatus) throw new Error('Conditional saved-source capture is unavailable for this durable note');
            const originalSavedSource = buffer.savedText;
            const capture = await guarded.captureConditionalSavedSource({ ...admitted, path }, () => { options.validate(); validate(); });
            // Explicit absence of both provider methods preserves the browser's
            // logical CAS path. Native providers expose a pair that rejects an
            // unsupported host; advertised capture failures never reach here.
            if (capture) {
              retained = { attempt: conditionalSource.attempt, capture, originalSavedSource }; conditional.set(buffer, retained);
              conditionalAttempts.set(conditionalSource.attempt, { buffer, capture });
              if (capture.logicalWitness.entryId !== admitted.entryId || capture.logicalWitness.revision !== admitted.revision || capture.logicalWitness.path !== path) throw new Error('The captured saved source belongs to a different note revision');
            }
          }
          if (retained) {
            options.validate(); validate(); validateIdentity();
            conditionalSource!.validate(retained.capture.source, retained.originalSavedSource);
          }
          const source = buffer.text, next = withBaseEditAdmissionPhase('transform', () => transform(source));
          // Transform is synchronous: no intervening editor input may be discarded.
          withBaseEditAdmissionPhase('before-buffer-update', () => { options.validate(); validate(); });
          if (buffer.text !== source) throw new Error('The edited buffer changed');
          // A previous failed save may already contain this exact transformed draft.
          // Retrying must still persist it (or report the continuing failure).
          if (next === source && !buffer.dirty && !buffer.error && (!retained || guarded.conditionalSavedSourceStatus!(retained.capture) !== 'pending')) {
            if (retained && guarded.conditionalSavedSourceStatus!(retained.capture) === 'unattached') await guarded.releaseConditionalSavedSource!(retained.capture);
            forget(); return;
          }
          const attach = retained && guarded.conditionalSavedSourceStatus!(retained.capture) === 'unattached' ? retained.capture : undefined;
          buffer.update(next, { validateWrite: () => withBaseEditAdmissionPhase('durable-validation', () => { options.validate(); validateWrite(); validateIdentity(); }), ...(attach ? { conditionalSavedSource: attach } : {}) });
          if (retained && retained.desiredSource === undefined) retained.desiredSource = next;
          options.onBufferChange?.(path, buffer, source);
          // Do not replay or roll back a failed write: recovery draft owns that state.
          await buffer.flush();
          if (retained && guarded.conditionalSavedSourceStatus!(retained.capture) !== 'settled') throw new Error('The original conditional Base save is still pending');
          forget();
        } catch (error) {
          if (retained && guarded.conditionalSavedSourceStatus!(retained.capture) === 'unattached') {
            try { await guarded.releaseConditionalSavedSource!(retained.capture); forget(); }
            catch (releaseError) { throw new AggregateError([error, releaseError], `${error instanceof Error ? error.message : String(error)}. Releasing the unused saved-source capture also failed.`, { cause: error }); }
          }
          throw error;
        }
      });
      pending = result.catch(() => undefined);
      return result;
    },
    ...(options.rename ? { rename: options.rename } : {}),
  };
}

/** A coherent saved configuration read, independent of query success. The
 * exact controller-owned object is required for source-only error recovery. */
export interface BaseConfigurationRead {
  readonly source: string;
  readonly path: string;
  readonly entryId: string;
  readonly revision: string;
  readonly version: number;
  readonly viewIndex: number;
  readonly viewId?: string;
}
interface ConfigurationReadProof {
  readonly read: BaseConfigurationRead;
  readonly epoch: number;
  readonly selection: number;
  readonly configuration: number;
  readonly identity: number | undefined;
  readonly adapter: Vault['adapter'];
  readonly capability: Vault['adapter']['durableWrites'];
  readonly repairable: boolean;
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
  /** Stable binding for new embeds; display names may repeat. */
  viewId?: string;
  /** Rebind an active named embed after config acknowledgement, before its saved
   * source references are updated. Must preserve the original embed identity. */
  onViewRenamed?(event: BaseViewRenamed): void;
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
interface PropertyState { readonly requestedKey: string; readonly targetKey: string; readonly key?: string; readonly value?: BaseValue }
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
function propertyState(source: string, keys: readonly string[], targets?: readonly PropertyState[]): PropertyState[] {
  const properties = readProperties(source);
  return keys.map(requestedKey => {
    const retained = targets?.find(state => state.requestedKey === requestedKey);
    const found = retained ? properties.find(item => item.key === retained.targetKey)
      : properties.find(item => item.key === requestedKey) ?? properties.find(item => item.key.toLowerCase() === requestedKey.toLowerCase());
    const targetKey = retained?.targetKey ?? found?.key ?? requestedKey;
    return found ? { requestedKey, targetKey, key: found.key, value: structuredClone(found.value) } : { requestedKey, targetKey };
  });
}
function statesEqual(left: readonly PropertyState[], right: readonly PropertyState[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function currentFilePath(query: BaseQueryOptions, basePath: string): string | null { return query.currentFilePath === undefined ? basePath : query.currentFilePath; }
function validateCurrentIdentity(current: VaultEntry | null | undefined, expectedEntryId: string | undefined): void {
  if (expectedEntryId !== undefined && (!current || current.entryId !== expectedEntryId)) throw new Error('The pinned current note changed. Refresh before using this Base.');
}
function sameCurrentFile(left: VaultEntry | null | undefined, right: VaultEntry | null | undefined): boolean {
  return left === null ? right === null : !!left && !!right && left.entryId === right.entryId && left.revision === right.revision && left.path === right.path;
}

export class BaseController {
  private options: BaseControllerOptions;
  private path: string;
  private query: BaseQueryOptions;
  private viewName?: string;
  private selectedViewId?: string;
  private readonly explicitlyBoundView: boolean;
  private selectionSerial = 0;
  private configurationEpoch = 0;
  private undoCommands: BaseHistoryCommand[] = [];
  private redoCommands: BaseHistoryCommand[] = [];
  private historyBusy = false;
  private pendingPropertyHistory = new Map<string, PropertyHistoryEntry>();
  private propertySourceAttempts = new Map<string, { readonly attempt: object; readonly selection: number; readonly configuration: number; readonly entryId?: string }>();
  private pendingHistoryDirection = new WeakMap<BaseHistoryEntry, 'undo' | 'redo'>();
  private historySourceAttempts = new WeakMap<PropertyHistoryEntry, Record<'undo' | 'redo', object>>();
  private emptyConfigurationWitness?: BaseSavedWitness;
  private configurationReadProof?: ConfigurationReadProof;
  private configurationViewIds?: { readonly source: string; readonly ids: string[] };
  private pendingConfigurations = new Map<string, { readonly expected: string; readonly witness?: BaseSavedWitness; readonly attempt: object; readonly index: number; readonly name: string; readonly bound: boolean; readonly selectionSerial: number; readonly entryId?: string; readonly adapter: Vault['adapter']; validate(): void; committed?(): Promise<BaseViewRenameReport | void> }>();
  private pendingViewReferences?: BaseViewReferenceOperation;
  private referenceServices = new Set<NonNullable<Vault['adapter']['documentSemantics']>>();
  private epoch = 0;
  private currentFileRequest = 0;
  // Paths remain private: rejection diagnostics expose only their roles.
  private lastInvalidation: { readonly kind: BaseEditInvalidationKind; readonly paths?: readonly string[] } = { kind: 'initial' };
  private version = 0;
  private disposed = false;
  private derivedSuspended = false;
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
  private queryEntries = new WeakMap<BaseQueryResult, { readonly definition: VaultEntry; readonly current: VaultEntry | null }>();
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
    this.query = { ...options.query }; this.viewName = options.viewName; this.selectedViewId = options.viewId;
    this.explicitlyBoundView = options.viewId !== undefined || options.viewName !== undefined;
    for (const path of options.vault.entries.keys()) this.identities.set(path, ++this.nextIdentity);
    this.subscriptions = (['create', 'modify', 'rename', 'delete', 'ready'] as const).map(event => options.vault.on(event, change => {
      if (event === 'ready' || change.path === this.path || change.oldPath === this.path) this.configurationEpoch++;
      if (event === 'delete' || event === 'rename') {
        const previous = change.oldPath ?? change.path;
        for (const path of this.identities.keys()) if (path === previous || path.startsWith(previous + '/')) this.identities.delete(path);
      }
      for (const path of options.vault.entries.keys()) if (!this.identities.has(path)) this.identities.set(path, ++this.nextIdentity);
      this.stale = true; this.clearWake();
      this.epoch++; this.lastInvalidation = { kind: `vault-${event}`, paths: event === 'ready' ? undefined : change.oldPath === undefined ? [change.path] : [change.path, change.oldPath] }; this.sharedQueries.cancel();
      this.schedule();
    }));
    this.subscriptions.push(this.clock.subscribeWake(() => this.onClockWake()));
    this.schedule();
  }

  get state(): BaseControllerState { return this.current; }
  get configurationRead(): BaseConfigurationRead | undefined {
    const proof = this.configurationReadProof;
    if (!proof || this.disposed || this.current.updating || this.requested || proof.epoch !== this.epoch || proof.selection !== this.selectionSerial || proof.configuration !== this.configurationEpoch || proof.identity !== this.identities.get(this.path) || proof.adapter !== this.options.vault.adapter || proof.capability !== this.options.vault.adapter.durableWrites || proof.read.version !== this.current.version) return undefined;
    return proof.read;
  }

  private retainConfigurationRead(read: BaseConfigurationRead, repairable: boolean): void {
    this.configurationReadProof = { read: Object.freeze(read), epoch: this.epoch, selection: this.selectionSerial, configuration: this.configurationEpoch, identity: this.identities.get(this.path), adapter: this.options.vault.adapter, capability: this.options.vault.adapter.durableWrites, repairable };
  }

  /** Native reads carry source and revision together. Older/test adapters must
   * seal read bytes between matching identity/revision observations. */
  private async verifyConfigurationRead(read: BaseConfigurationRead, validate: () => void): Promise<void> {
    const vault = this.options.vault, adapter = vault.adapter;
    const witness = (entry: {entryId?: string;revision?: string;path?: string}|null|undefined) => !!entry && entry.entryId === read.entryId && entry.revision === read.revision && entry.path === read.path;
    validate();
    if (adapter.durableWrites) {
      const current = await vault.readDurableText(read.path); validate();
      if (!witness(current) || !this.options.inlineSource && current.content !== read.source) throw new Error('The saved Base configuration changed; refresh before changing its source.');
    } else {
      const observe = () => adapter.stat ? adapter.stat(read.path) : Promise.resolve(vault.entries.get(read.path));
      const before = await observe(); validate();
      const source = this.options.inlineSource ? undefined : await vault.read(read.path); validate();
      const after = await observe(); validate();
      if (!witness(before) || !witness(after) || before!.mtime !== after!.mtime || before!.size !== after!.size || source !== undefined && source !== read.source) throw new Error('The saved Base configuration changed; refresh before changing its source.');
    }
    if (this.options.inlineSource) {
      const inline = await this.options.inlineSource.read(); validate();
      if (inline.source !== read.source || inline.witness?.entryId !== read.entryId || inline.witness.revision !== read.revision) throw new Error('The containing note changed; refresh before changing its Base source.');
    }
  }

  get basePath(): string { return this.path; }
  /** Admission for a new property interaction only. Existing drafts/writes keep
   * their captured guards. A coherent publish precedes refresh's final flag reset. */
  get canBeginPropertyEdit(): boolean {
    return !this.disposed && !this.derivedSuspended && this.current === this.settled && !this.stale && !this.requested
      && !this.current.updating && !this.current.error && !!this.current.result && !sharedBasePreview(this.current.result);
  }
  /** Host-wide saved-name notification. Passive embeds retain their drafts and
   * exact original binding; the host chooses when to refresh/render them. */
  rebindViewName(from: string, to: string, viewId?: string): boolean {
    if (this.disposed || this.viewName !== from || viewId !== undefined && this.selectedViewId !== undefined && this.selectedViewId !== viewId) return false;
    this.viewName = to; return true;
  }
  get selectedViewIndex(): number { return this.query.viewIndex ?? 0; }
  get selectedViewIdentity(): string | undefined { return this.selectedViewId; }
  get canUndo(): boolean { return !this.disposed && !this.historyBusy && this.undoCommands.length > 0; }
  get canRedo(): boolean { return !this.disposed && !this.historyBusy && this.redoCommands.length > 0; }

  private schedule(): void {
    if (this.disposed || this.derivedSuspended || !this.clock.isVisible() || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, Math.max(0, Math.min(1000, this.options.delayMs ?? 30)));
  }

  private clearWake(): void { this.wakeSerial++; this.cancelWake?.(); this.cancelWake = undefined; }

  private armWake(result = this.current.result): void {
    this.clearWake();
    // An explicit fixed query clock cannot advance when a host wall timer fires.
    if (this.disposed || this.derivedSuspended || this.stale || !this.clock.isVisible() || this.query.now) return;
    const hint = result?.shared?.refreshHint;
    if (!hint || hint.dependency === 'none' || hint.nextWakeMs === null) return;
    const serial = this.wakeSerial;
    this.cancelWake = this.clock.scheduleAt(hint.nextWakeMs, () => {
      if (this.disposed || serial !== this.wakeSerial) return;
      this.cancelWake = undefined; this.onClockWake();
    });
  }

  private onClockWake(): void {
    if (this.disposed || this.derivedSuspended) return;
    this.clearWake();
    if (!this.clock.isVisible()) {
      if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.refreshing) { this.stale = true; this.epoch++; this.lastInvalidation = { kind: 'clock-hidden-refresh-abort' }; this.sharedQueries.cancel(); }
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
      const kind = this.stale ? 'clock-stale' : zoneChanged ? 'clock-timezone' : missed ? 'clock-deadline' : 'clock-backwards';
      this.stale = true; this.epoch++; this.lastInvalidation = { kind }; this.sharedQueries.cancel(); void this.refresh();
    } else this.armWake();
  }

  /** Refresh failures are represented in state; mutation failures reject to the caller. */
  refresh(): Promise<void> {
    if(this.derivedSuspended)return Promise.resolve();
    this.configurationReadProof = undefined;
    this.clearWake(); this.stale = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const refresh = async () => {
      if (this.disposed || !this.clock.isVisible()) return;
      const epoch = this.epoch;
      this.configurationReadProof = undefined;
      let configurationRead: BaseConfigurationRead | undefined, querying = false;
      if (!this.current.updating) this.publish({ ...this.current, updating: true, error: null });
      try {
        const service = this.options.vault.adapter.documentSemantics;
        const observe = async (path: string) => this.options.vault.adapter.stat ? await this.options.vault.adapter.stat(path) : this.options.vault.entries.get(path);
        let definition = await observe(this.path);
        const inline = this.options.inlineSource ? await this.options.inlineSource.read() : undefined;
        const coherent = !inline && this.options.vault.adapter.durableWrites ? await this.options.vault.readDurableText(this.path) : undefined;
        const source = inline ? inline.source : coherent ? coherent.content : await this.options.vault.read(this.path);
        if (coherent) definition = {path: coherent.path, entryId: coherent.entryId, revision: coherent.revision, type: 'file', ctime: coherent.stat.ctime, mtime: coherent.stat.mtime, size: coherent.stat.size};
        if (inline?.witness && definition && (inline.witness.entryId !== definition.entryId || inline.witness.revision !== definition.revision)) throw new Error('The containing note changed. Refresh before editing this Base.');
        if (this.disposed || this.derivedSuspended || epoch !== this.epoch) { this.schedule(); return; }
        let version = this.version + 1;
        const document = BaseDocument.parse(source);
        if (!document.views.length && !this.explicitlyBoundView) {
          this.selectedViewId = undefined;
          const latest = await observe(this.path);
          if (this.disposed || this.derivedSuspended || epoch !== this.epoch) { this.schedule(); return; }
          if (!latest || service && (!definition || latest.entryId !== definition.entryId || latest.revision !== definition.revision || latest.mtime !== definition.mtime || latest.size !== definition.size)) throw new Error('The Base configuration changed. Refresh before adding a view.');
          this.emptyConfigurationWitness = latest.entryId && latest.revision ? Object.freeze({ entryId: latest.entryId, revision: latest.revision }) : undefined;
          this.query = { ...this.query, viewIndex: 0 }; this.stale = false; this.clearWake();
          const signature = JSON.stringify([source, this.identities.get(this.path), 'no-views']);
          if (signature === this.signature && !this.settled.error) { this.publish(this.settled); return; }
          this.version = version; this.signature = signature;
          this.publish({ version, source, result: null, error: null, updating: false }); return;
        }
        this.emptyConfigurationWitness = undefined;
        let viewIndex = this.query.viewIndex ?? 0;
        if (this.selectedViewId !== undefined) {
          const retainedIndex = document.views.findIndex(view => view.id === this.selectedViewId);
          if (retainedIndex >= 0) viewIndex = retainedIndex;
          else if (this.explicitlyBoundView) viewIndex = baseViewIndexById(document.views, this.selectedViewId);
          else { this.selectedViewId = undefined; viewIndex = Math.min(Math.max(0, viewIndex), document.views.length - 1); }
        } else if (this.viewName !== undefined) viewIndex = baseViewIndexByName(document.views, this.viewName);
        const selectedId = document.views[viewIndex]?.id;
        if (typeof selectedId === 'string') this.selectedViewId = selectedId;
        if (definition?.entryId && definition.revision && document.views[viewIndex]) {
          const read: BaseConfigurationRead = {source, path: this.path, entryId: definition.entryId, revision: definition.revision, version: this.current.version, viewIndex, ...(typeof selectedId === 'string' ? {viewId: selectedId} : {})};
          await this.verifyConfigurationRead(read, () => { if (this.disposed || this.derivedSuspended || epoch !== this.epoch) throw new Error('The Base configuration read was retired.'); });
          configurationRead = read;
        }
        let result: BaseQueryResult;
        const currentPath = currentFilePath(this.query, this.path), expectedCurrentEntryId = this.query.currentFileEntryId;
        const current = service || expectedCurrentEntryId !== undefined
          ? currentPath === null ? null : (currentPath === this.path ? definition ?? await observe(currentPath) : await observe(currentPath)) ?? null
          : null;
        validateCurrentIdentity(current, expectedCurrentEntryId);
        if (service) {
          if (!definition || currentPath !== null && !current) throw new Error('The saved Base or current file is unavailable.');
          const owner = this, allowPreview = !this.current.result || !!sharedBasePreview(this.current.result);
          const effectiveQuery: BaseQueryOptions & { inlineSource?: { source: string; startByte: number; endByte: number } } = inline ? { ...this.query, inlineSource: { source, startByte: inline.startByte, endByte: inline.endByte } } : this.query;
          const request = { service, definition, current, entries: [...this.options.vault.entries.values()], query: effectiveQuery,
            viewIndex, viewName: this.selectedViewId === undefined ? this.viewName : undefined, get version() { return owner.version + 1; }, clock: this.clock, isCurrent: () => !this.disposed && !this.derivedSuspended && epoch === this.epoch,
            readFile: (path: string) => this.options.vault.read(path),
            ...(allowPreview ? {
              onPreview: (result: BaseQueryResult) => {
                if (this.disposed || this.derivedSuspended || epoch !== this.epoch || this.current.result && !sharedBasePreview(this.current.result)) return;
                this.version = Number(result.version);
                this.publish({ version: this.version, source, result, error: null, updating: true });
              },
              onPreviewStatus: (message: string) => {
                if (!this.disposed && !this.derivedSuspended && epoch === this.epoch) this.publish({ ...this.current, previewStatus: message, error: null, updating: true });
              },
            } : {}),
          };
          querying = true;
          result = await this.sharedQueries.query(request);
          querying = false;
          version = Number(result.version);
          if (this.disposed || this.derivedSuspended || epoch !== this.epoch) { this.schedule(); return; }
          const latest = await observe(this.path);
          if (!latest || latest.entryId !== definition.entryId || latest.revision !== definition.revision) throw new Error('The Base definition changed. Refresh before editing.');
          if (this.disposed || this.derivedSuspended || epoch !== this.epoch) { this.schedule(); return; }
          if (expectedCurrentEntryId !== undefined) {
            validateCurrentIdentity(currentPath === this.path ? latest : currentPath === null ? null : await observe(currentPath), expectedCurrentEntryId);
            if (this.disposed || this.derivedSuspended || epoch !== this.epoch) { this.schedule(); return; }
          }
          this.queryEntries.set(result, { definition: Object.freeze({ ...definition }), current: current === null ? null : Object.freeze({ ...current }) });
        } else {
          const files = [...this.options.vault.entries.values()].filter(entry => entry.type === 'file').map(entry => {
            const metadata = this.options.vault.metadata.get(entry.path);
            return { path: entry.path, ctime: entry.ctime, mtime: entry.mtime, size: entry.size,
              properties: metadata?.frontmatter, tags: metadata?.tags };
          });
          querying = true;
          result = executeBaseQuery(document, { version, files }, { currentFilePath: this.path, ...this.query, viewIndex });
          querying = false;
        }
        this.query = { ...this.query, viewIndex };
        this.lastCapture = sharedBaseCapture(result);
        this.stale = false; this.armWake(result);
        // Identical rows can still belong to a different `this` context. Keep
        // its saved witness with the result used by footer advice and edits.
        const signature = JSON.stringify([source, this.identities.get(this.path), [currentPath, current?.entryId, current?.revision], result.rows.map(row => this.identities.get(row.path)), { ...result, version: 0 }, sharedBaseCoverage(result)]);
        if (signature === this.signature && !this.settled.error) { if (configurationRead) this.retainConfigurationRead({...configurationRead,version:this.settled.version},false); this.publish(this.settled); return; }
        this.version = version; this.signature = signature;
        if (configurationRead) this.retainConfigurationRead({...configurationRead,version},false);
        this.publish({ version, source, result, error: null, updating: false });
      } catch (error) {
        if (querying && configurationRead && !(this.current.result && sharedBasePreview(this.current.result))) {
          try {
            await this.verifyConfigurationRead(configurationRead, () => { if (this.disposed || this.derivedSuspended || epoch !== this.epoch) throw new Error('The Base configuration read was retired.'); });
            this.retainConfigurationRead({...configurationRead,version:this.current.version},true);
          } catch { this.configurationReadProof = undefined; }
        } else this.configurationReadProof = undefined;
        if (!this.disposed && !this.derivedSuspended && epoch === this.epoch) this.publish({ ...this.current, updating: false, error: error instanceof Error ? error : new Error(String(error)) });
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
    if(this.derivedSuspended)return;
    this.current = Object.freeze(state);
    if (!state.updating) this.settled = this.current;
    try { this.options.onChange?.(this.current); } catch (error) { console.error('Bases observer failed', error); }
  }

  setView(viewIndex: number): Promise<void> {
    const selected = BaseDocument.parse(this.current.source).views[viewIndex];
    if (!Number.isInteger(viewIndex) || !selected) return Promise.reject(new Error('The selected base view does not exist'));
    if (this.viewName !== undefined) {
      if (this.current.error) return Promise.reject(this.current.error);
      if (!this.current.result) return Promise.reject(new Error('The Base configuration is not ready'));
      const view = BaseDocument.parse(this.current.source).views[viewIndex];
      if (!Number.isInteger(viewIndex) || !view) return Promise.reject(new Error('The selected base view does not exist'));
      // An explicit local selection binds its name too, so later reordering
      // cannot retarget an embedded view to an unrelated configuration.
      this.viewName = view.name;
    }
    this.selectedViewId = typeof selected.id === 'string' ? selected.id : undefined;
    this.selectionSerial++;
    this.query = { ...this.query, viewIndex }; this.stale = true; this.clearWake(); this.epoch++; this.lastInvalidation = { kind: 'view-selection' }; this.sharedQueries.cancel();
    return this.refresh();
  }

  setSearchTerms(terms: readonly string[]): Promise<void> {
    if (!Array.isArray(terms) || terms.some(term => typeof term !== 'string')) return Promise.reject(new Error('Search terms must be strings'));
    this.query = { ...this.query, searchTerms: [...terms] };
    this.stale = true; this.clearWake(); this.epoch++; this.lastInvalidation = { kind: 'search-change' }; this.sharedQueries.cancel();
    return this.refresh();
  }

  async setCurrentFilePath(path: string | null, expectedEntryId?: string): Promise<void> {
    if (path !== null) path = normalizePath(path);
    else expectedEntryId = undefined;
    if (expectedEntryId !== undefined && (typeof expectedEntryId !== 'string' || !expectedEntryId)) throw new Error('A saved current-note identity is required');
    const request = ++this.currentFileRequest, vault = this.options.vault, adapter = vault.adapter;
    const validate = async () => {
      const current = path === null ? null : adapter.stat ? await adapter.stat(path) : vault.entries.get(path);
      if (this.disposed || request !== this.currentFileRequest || vault.adapter !== adapter) throw new Error('The current file changed before its context was ready');
      validateCurrentIdentity(current, expectedEntryId);
    };
    // A failed expected identity must not retarget a retained pinned context.
    // Register first so a slower preflight cannot supersede a newer selection.
    if (expectedEntryId !== undefined) await validate();
    if (this.query.currentFilePath === path && this.query.currentFileEntryId === expectedEntryId) return;
    this.query = { ...this.query, currentFilePath: path, currentFileEntryId: expectedEntryId };
    this.stale = true; this.clearWake(); this.epoch++; this.lastInvalidation = { kind: 'current-file-change' }; this.sharedQueries.cancel();
    await this.refresh();
    // refresh publishes generic read errors in state. An identity-bound setter
    // additionally rejects a replaced note rather than positively ACKing a pin.
    if (expectedEntryId !== undefined) await validate();
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
      if (this.derivedSuspended || vault.adapter !== adapter || adapter.documentSemantics !== service || this.current.source !== source) throw new Error('This Base changed before summary previews were ready');
    };
    const observe = async (path: string) => adapter.stat ? await adapter.stat(path) : vault.entries.get(path);
    validate();
    const definition = await observe(this.path); validate();
    if (!definition?.entryId || !definition.revision || !saved || definition.entryId !== saved.entryId || definition.revision !== saved.revision
      || definition.entryId !== retained.definition.entryId || definition.revision !== retained.definition.revision) throw new Error('The saved Base changed; refresh before requesting summary previews');
    const inline = this.options.inlineSource ? await this.options.inlineSource.read() : undefined;
    validate();
    if (inline && (inline.source !== source || inline.witness && (inline.witness.entryId !== definition.entryId || inline.witness.revision !== definition.revision))) throw new Error('The containing note changed; refresh before requesting summary previews');
    const currentPath = currentFilePath(this.query, this.path);
    const current = currentPath === null ? null : (currentPath === this.path ? definition : await observe(currentPath)) ?? null; validate();
    validateCurrentIdentity(current, this.query.currentFileEntryId);
    if (current !== null && (!current.entryId || !current.revision) || !sameCurrentFile(current, retained.current)) throw new Error('The current saved note changed; refresh before requesting summary previews');
    const captured = sharedBaseCapture(this.current.result!);
    const query: BaseQueryOptions & { summaryPreviewProperty: string; summaryPreviewGroupKeyId?: string; inlineSource?: { source: string; startByte: number; endByte: number } } = {
      ...this.query, searchTerms: this.query.searchTerms && [...this.query.searchTerms], summaryPreviewProperty: property, summaryPreviewGroupKeyId: groupKeyId,
      ...(captured ? { now: () => new Date(captured.clockMs), timezone: captured.timezone } : {}),
      ...(inline ? { inlineSource: { source, startByte: inline.startByte, endByte: inline.endByte } } : {}),
    };
    const runner = new SharedBaseQueryRunner(); this.summaryQueries.add(runner);
    try {
      const request = { service, definition, current, entries: [...vault.entries.values()], query, version,
        viewIndex: this.selectedViewIndex, viewName: this.selectedViewId === undefined ? this.viewName : undefined, clock: this.clock,
        isCurrent: () => !this.disposed && !this.derivedSuspended && epoch === this.epoch && version === this.current.version && vault.adapter === adapter,
        readFile: async (path: string) => { validate(); const text = await vault.read(path); validate(); return text; },
      };
      const result = await runner.query(request); validate();
      const latestDefinition = await observe(this.path); validate();
      const latestCurrent = currentPath === null ? null : (currentPath === this.path ? latestDefinition : await observe(currentPath)) ?? null; validate();
      validateCurrentIdentity(latestCurrent, this.query.currentFileEntryId);
      if (!latestDefinition || latestDefinition.entryId !== definition.entryId || latestDefinition.revision !== definition.revision
        || !sameCurrentFile(latestCurrent, current)) throw new Error('The saved Base or current note changed; refresh before requesting summary previews');
      const previews = (result as BaseQueryResult & { readonly summaryPreviews?: Readonly<Record<string, BaseExpressionValue>> }).summaryPreviews;
      if (!previews) throw new Error('Summary previews are unavailable on this host');
      return previews;
    } finally { this.summaryQueries.delete(runner); runner.dispose(); }
  }

  private guard(version: number, path: string, allowEmptyConfiguration = false): { validate: () => void; validateWrite: () => void } {
    const epoch = this.epoch, identity = this.identities.get(path), base = this.identities.get(this.path);
    const selection = this.selectionSerial, configuration = this.configurationEpoch;
    const invalidation = this.lastInvalidation.kind, stale = this.stale;
    const targetWitness = { ...this.options.vault.entries.get(path) }, baseWitness = { ...this.options.vault.entries.get(this.path) };
    const witnessFacts = (captured: Partial<VaultEntry>, current: VaultEntry | undefined) => {
      const capturedEntryAvailable = typeof captured.entryId === 'string', currentEntryAvailable = typeof current?.entryId === 'string';
      const capturedRevisionAvailable = typeof captured.revision === 'string', currentRevisionAvailable = typeof current?.revision === 'string';
      const entryMatches = capturedEntryAvailable && currentEntryAvailable && captured.entryId === current?.entryId;
      return { capturedEntryAvailable, currentEntryAvailable, capturedRevisionAvailable, currentRevisionAvailable, entryMatches,
        revisionMatches: entryMatches && capturedRevisionAvailable && currentRevisionAvailable && captured.revision === current?.revision };
    };
    const affected = (candidate: string) => !!this.lastInvalidation.paths?.some(changed => candidate === changed || candidate.startsWith(changed + '/'));
    const rejection = (error: Error, reason: BaseEditAdmissionReason) => {
      const target = witnessFacts(targetWitness, this.options.vault.entries.get(path)), definition = witnessFacts(baseWitness, this.options.vault.entries.get(this.path));
      return recordBaseEditAdmission(error, {
        capturedInvalidationKind: invalidation, currentInvalidationKind: this.lastInvalidation.kind, capturedStale: stale, currentStale: this.stale,
        invalidationTargetAffected: affected(path), invalidationBaseAffected: affected(this.path),
        invalidationOtherPath: !!this.lastInvalidation.paths?.some(changed => ![path, this.path].some(candidate => candidate === changed || candidate.startsWith(changed + '/'))),
        capturedTargetEntryAvailable: target.capturedEntryAvailable, currentTargetEntryAvailable: target.currentEntryAvailable,
        capturedTargetRevisionAvailable: target.capturedRevisionAvailable, currentTargetRevisionAvailable: target.currentRevisionAvailable,
        targetEntryMatches: target.entryMatches, targetRevisionMatches: target.revisionMatches,
        capturedBaseEntryAvailable: definition.capturedEntryAvailable, currentBaseEntryAvailable: definition.currentEntryAvailable,
        capturedBaseRevisionAvailable: definition.capturedRevisionAvailable, currentBaseRevisionAvailable: definition.currentRevisionAvailable,
        baseEntryMatches: definition.entryMatches, baseRevisionMatches: definition.revisionMatches,
        guard: 'controller', phase: 'controller-guard', reason,
        submittedVersion: baseEditAdmissionVersion(version), currentVersion: this.current.version,
        hasResult: !!this.current.result, queryError: !!this.current.error, updating: this.current.updating, disposed: this.disposed,
        capturedEpoch: epoch, currentEpoch: this.epoch,
        capturedTargetIdentity: identity, currentTargetIdentity: this.identities.get(path),
        capturedBaseIdentity: base, currentBaseIdentity: this.identities.get(this.path),
        targetIdentityMatches: !!identity && identity === this.identities.get(path), baseIdentityMatches: !!base && base === this.identities.get(this.path),
        capturedSelection: selection, currentSelection: this.selectionSerial,
        capturedConfigurationEpoch: configuration, currentConfigurationEpoch: this.configurationEpoch,
      });
    };
    const validateWrite = () => {
      if (this.disposed || !identity || this.identities.get(path) !== identity || !base || this.identities.get(this.path) !== base) {
        throw rejection(new Error('This base result is stale; refresh before editing'), this.disposed ? 'closed' : 'identity');
      }
    };
    const validate = () => {
      validateWrite();
      if (this.current.result && sharedBasePreview(this.current.result)) throw rejection(new Error('Indexing previews are read-only. Wait for saved results before editing.'), 'preview');
      if (this.current.error || (!this.current.result && !(allowEmptyConfiguration && path === this.path && !this.current.updating && !BaseDocument.parse(this.current.source).views.length)) || version !== this.current.version || epoch !== this.epoch) throw rejection(new Error('This base result is stale; refresh before editing'), this.current.error ? 'query-error' : !this.current.result ? 'result-unavailable' : version !== this.current.version ? 'version' : 'epoch');
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
        let attempt = this.propertySourceAttempts.get(signature);
        const actor = result!.rows.find(row => row.path === path)!;
        let pinnedBefore: readonly PropertyState[] | undefined;
        const validate = () => {
          guard.validateWrite();
          if (this.selectionSerial !== selection || this.configurationEpoch !== config) throw new Error('The Base configuration or selected view changed before editing');
          if (!completed.length) guard.validate();
        };
        try {
          for (const [pendingSignature, pendingEntry] of this.pendingPropertyHistory) {
            if (pendingEntry.path === path && pendingSignature !== signature) throw new Error('Retry the original Base property command before editing another value in this file');
          }
          if (attempt && (attempt.selection !== selection || attempt.configuration !== config || attempt.entryId !== actor.entryId)) throw new Error('The original Base property command changed; retry its retained save before editing');
          if (!attempt) { attempt = { attempt: {}, selection, configuration: config, entryId: actor.entryId }; this.propertySourceAttempts.set(signature, attempt); }
          const witness = sharedBaseWitness(result!, path);
          await this.options.mutations.transform(path, source => {
            validate(); const before = propertyState(source, keys, entry?.after);
            const originalRetry = entry && statesEqual(before, entry.after);
            if (pinnedBefore && !statesEqual(before, pinnedBefore) && !originalRetry) throw new Error('A touched property changed in the shared draft; its current value was preserved');
            let next = source;
            for (const edit of values) {
              const key = edit.property.slice(5), current = propertyState(next, [key], before)[0];
              next = edit.remove ? current.key === undefined ? next : removeProperty(next, current.key) : setProperty(next, current.key ?? current.targetKey, edit.value);
            }
            const after = propertyState(next, keys, before);
            // An exact failed draft retry retains its original undo baseline.
            if (!entry || !statesEqual(before, entry.after)) {
              entry = { kind: 'properties', path, identity: this.identities.get(path)!, entryId: witness?.entryId ?? this.options.vault.entries.get(path)?.entryId, before, after };
              this.pendingPropertyHistory.set(signature, entry);
            }
            return next;
          }, validate, () => {
            guard.validateWrite();
            if (this.selectionSerial !== selection || this.configurationEpoch !== config) throw new Error('The Base configuration or selected view changed before saving');
          }, witness, {
            attempt: attempt.attempt,
            validate: (physical, originalSavedSource) => {
              validate();
              // Ordinary Base edits are absolute frontmatter mutations. A
              // pending physical branch, even formatting-only, must reconcile
              // into a new logical witness before this command can author it.
              if (physical !== originalSavedSource) throw new Error('The physical saved source changed; refresh after reconciliation before editing this property');
              pinnedBefore = propertyState(originalSavedSource, keys, entry?.before);
            },
          });
          completed.push(path); this.pendingPropertyHistory.delete(signature); this.propertySourceAttempts.delete(signature);
          if (entry && !statesEqual(entry.before, entry.after)) history.push(entry);
        } catch (error) {
          if (!entry && !(error instanceof AggregateError)) this.propertySourceAttempts.delete(signature);
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
    // Inferred multitext retains its value type, but moving groups replaces
    // membership in full. A composite destination remains one exact list.
    const value = current?.type === 'list' && !Array.isArray(edit.value) ? [edit.value] : edit.value;
    return this.editProperty({ ...edit, property: group.property, value });
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
            let attempts = this.historySourceAttempts.get(entry);
            if (!attempts) { attempts = { undo: {}, redo: {} }; this.historySourceAttempts.set(entry, attempts); }
            await this.options.mutations.transform(path, text => {
              validate(entry);
              const current = propertyState(text, expected.map(state => state.requestedKey), expected);
              const retry = this.pendingHistoryDirection.get(entry) === direction && statesEqual(current, desired);
              if (!statesEqual(current, expected) && !retry) throw new Error('A touched property changed after this command; its current value was preserved');
              let next = text;
              for (const state of desired) {
                const current = propertyState(next, [state.requestedKey], [state])[0];
                if (current.key !== undefined && current.key !== state.key) next = removeProperty(next, current.key);
                if (state.key !== undefined) next = setProperty(next, state.key, state.value!);
              }
              this.pendingHistoryDirection.set(entry, direction);
              return next;
            }, () => validate(entry), () => validate(entry), witness, {
              attempt: attempts[direction],
              validate: source => {
                validate(entry);
                const saved = propertyState(source, expected.map(state => state.requestedKey), expected);
                if (!statesEqual(saved, expected)) throw new Error('A touched property changed after this command; its current value was preserved');
              },
            });
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
    if (Object.hasOwn(detached, 'name') && detached.name !== BaseDocument.parse(this.current.source).views[index]?.name) {
      await this.renameViewConfiguration(version, index, detached.name as string, detached); return;
    }
    await this.changeConfiguration(version, document => {
      if (Object.hasOwn(detached, 'name')) detached.name = validateBaseViewName(detached.name as string, document.views, index);
      document.updateView(index, detached);
      return active;
    });
  }

  async updateConfiguration(version: number, patch: BaseConfigurationPatch): Promise<void> {
    const detached = structuredClone(patch), index = this.selectedViewIndex;
    if (detached.root && Object.hasOwn(detached.root, 'views')) throw new Error('Use the guarded view commands to manage base views');
    if (detached.view && Object.hasOwn(detached.view, 'name') && detached.view.name !== BaseDocument.parse(this.current.source).views[index]?.name) {
      await this.renameViewConfiguration(version, index, detached.view.name as string, detached.view, detached.root); return;
    }
    await this.changeConfiguration(version, document => {
      if (detached.view && Object.hasOwn(detached.view, 'name')) detached.view.name = validateBaseViewName(detached.view.name as string, document.views, index);
      document.updateViewConfiguration(index, detached);
      return index;
    });
  }

  private allocateConfigurationViewId(source: string, position: number, occupied: Iterable<string>): string {
    if (this.configurationViewIds?.source !== source) this.configurationViewIds = { source, ids: [] };
    const ids = this.configurationViewIds.ids, used = new Set(occupied), previous = ids[position];
    if (previous !== undefined) {
      if (used.has(previous)) throw new Error('The retained view identity allocation no longer matches this configuration');
      return previous;
    }
    const id = newBaseViewId(used); ids[position] = id; return id;
  }

  /** Shared absolute-source transaction. A retry persists the same draft once. */
  private async changeConfiguration(version: number, change: (document: BaseDocument) => number, committed?: () => Promise<BaseViewRenameReport | void>, repair?: {read: BaseConfigurationRead; validate(): void; validateWrite(): void}): Promise<BaseViewRenameReport | void> {
    const { validate, validateWrite } = repair ?? this.guard(version, this.path, true), expected = repair ? repair.read.source : this.current.source;
    let allocation = 0;
    const document = BaseDocument.parse(expected, used => this.allocateConfigurationViewId(expected, allocation++, used)), index = change(document), desired = document.toString();
    const selected = document.views[index];
    if (!selected && document.views.length) throw new Error('The selected base view does not exist');
    const selectionSerial = this.selectionSerial;
    const witness = repair ? {entryId:repair.read.entryId,revision:repair.read.revision} : this.current.result ? sharedBaseWitness(this.current.result, this.path) : this.emptyConfigurationWitness;
    const previous = !this.options.inlineSource ? this.pendingConfigurations.get(desired) : undefined;
    if (previous && (previous.expected !== expected || previous.selectionSerial !== selectionSerial || previous.index !== index || previous.name !== (selected?.name ?? '')
      || previous.bound !== (this.viewName !== undefined) || previous.adapter !== this.options.vault.adapter
      || previous.witness?.entryId !== witness?.entryId || previous.witness?.revision !== witness?.revision)) {
      throw new Error('Retry the original Base configuration save before changing its command');
    }
    const attempt = previous?.attempt ?? {};
    const retry = previous ?? { expected, witness: witness && Object.freeze({ ...witness }), attempt, index, name: selected?.name ?? '', bound: this.viewName !== undefined, selectionSerial, entryId: witness?.entryId, adapter: this.options.vault.adapter, validate: validateWrite, committed };
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
    } else await this.options.mutations.transform(this.path, transform, validateSelection, validateWrite, witness, {
      attempt,
      validate(source) {
        // Standalone configuration is an absolute whole-file CAS. Even an
        // unrelated external comment cannot be merged into this saved command.
        if (source !== expected) throw new Error('The Base physical saved source changed; its external edit was preserved');
      },
    });
    } catch (error) {
      if (prepared || this.options.inlineSource) this.pendingConfigurations.set(desired, retry);
      throw error;
    }
    this.pendingConfigurations.clear(); this.configurationViewIds = undefined;
    // A config's own modify event advances epoch. An explicit view selection
    // also advances it, but updates query/name: never undo that later choice.
    if (!this.disposed && this.selectionSerial === selectionSerial) {
      this.query = { ...this.query, viewIndex: index };
      this.selectedViewId = typeof selected?.id === 'string' ? selected.id : undefined;
      if (this.viewName !== undefined) this.viewName = selected?.name;
      this.stale = true; this.clearWake();
      this.epoch++; this.lastInvalidation = { kind: 'configuration-commit' }; this.sharedQueries.cancel();
    }
    if(this.derivedSuspended)this.current=Object.freeze({...this.current,source:desired,updating:false});
    try { return await retry.committed?.(); } finally { await this.refresh(); }
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
      const selected = BaseDocument.parse(source).views[retry.index];
      this.selectedViewId = typeof selected?.id === 'string' ? selected.id : undefined;
      if (retry.bound) this.viewName = retry.name || undefined;
      this.stale = true; this.clearWake(); this.epoch++; this.lastInvalidation = { kind: 'configuration-retry-ack' }; this.sharedQueries.cancel();
    }
    this.pendingConfigurations.clear(); this.configurationViewIds = undefined;
    if(this.derivedSuspended)this.current=Object.freeze({...this.current,source,updating:false});
    try { await retry.committed?.(); } finally { await this.refresh(); } return true;
  }

  async renameView(version: number, index: number, name: string): Promise<BaseViewRenameReport> {
    return this.renameViewConfiguration(version, index, name, { name });
  }

  get hasPendingViewReferences(): boolean { return this.pendingViewReferences !== undefined; }

  async retryViewRenameReferences(): Promise<BaseViewRenameReport | null> {
    const operation = this.pendingViewReferences;
    if (!operation) return null;
    try {
      const report = await operation.run();
      if (this.pendingViewReferences === operation) this.pendingViewReferences = undefined;
      return report;
    } finally { await this.refresh(); }
  }

  private async renameViewConfiguration(version: number, index: number, rawName: string, patch: BaseViewPatch, root?: BaseRootPatch): Promise<BaseViewRenameReport> {
    if (this.pendingViewReferences) throw new Error('Retry the previous view reference updates before renaming another view');
    const { validate, validateWrite } = this.guard(version, this.path);
    const document = BaseDocument.parse(this.current.source), from = document.views[index]?.name;
    if (from === undefined) throw new Error('The renamed Base view does not exist');
    const viewNames = document.views.map(view => view.name);
    const to = validateBaseViewName(rawName, document.views, index), active = this.selectedViewIndex;
    // Legacy name fragments can be rewritten only while both sides resolve to
    // one view. Repeated labels use stable IDs; ambiguous old links remain inert.
    const canRenameReferences = viewNames.filter(name => name === from).length === 1 && !viewNames.some((name, candidate) => candidate !== index && name === to);
    if (!canRenameReferences && document.views[index].id === undefined) patch = { ...patch, id: this.allocateConfigurationViewId(this.current.source, 0, document.views.flatMap(view => typeof view.id === 'string' ? [view.id] : [])) };
    if (to === from) {
      await this.changeConfiguration(version, next => { next.updateViewConfiguration(index, { root, view: { ...patch, name: to } }); return active; });
      return Object.freeze({ basePath: this.path, from, to, completedPaths: Object.freeze([]), failedPaths: Object.freeze([]), references: 0, mode: this.options.vault.adapter.documentSemantics ? 'core' : 'legacy' });
    }
    document.updateViewConfiguration(index, { root, view: { ...patch, name: to } });
    const desired = document.toString();
    if (!this.options.inlineSource && this.pendingConfigurations.has(desired)) {
      // Resume the exact saved command before consulting backlinks again. Its
      // reference witnesses and result belong to the original continuation.
      if (!this.pendingConfigurations.get(desired)!.committed) throw new Error('Retry the original Base configuration save before renaming its view');
      const report = await this.changeConfiguration(version, next => { next.updateViewConfiguration(index, { root, view: { ...patch, name: to } }); return active; });
      if (!report) throw new Error('The original view rename has no retained reference outcome');
      return report;
    }
    const adapter = this.options.vault.adapter, service = adapter.documentSemantics;
    const original = this.options.vault.entries.get(this.path);
    if (!original) throw new Error('The renamed Base file is unavailable');
    const identity = this.identities.get(this.path);
    const referenceWrite = () => {
      validateWrite();
      if (this.identities.get(this.path) !== identity || this.options.vault.adapter !== adapter || adapter.documentSemantics !== service) throw new Error('The original Base reference owner changed');
    };
    const validateRenamed = async () => {
      referenceWrite();
      const observe = async () => adapter.stat ? await adapter.stat(this.path) : (await adapter.list()).find(entry => entry.path === this.path);
      const before = await observe();
      referenceWrite();
      if (!before || before.type !== 'file' || original.entryId && before.entryId !== original.entryId) throw new Error('The saved renamed Base configuration changed before its references were updated');
      const source = await adapter.read(this.path);
      referenceWrite();
      const after = await observe();
      referenceWrite();
      if (!after || after.type !== 'file' || before.entryId !== after.entryId || before.revision !== after.revision || before.mtime !== after.mtime || before.size !== after.size || source !== desired) throw new Error('The saved renamed Base changed while its references were being validated');
    };
    if (adapter.documentSemantics) this.referenceServices.add(adapter.documentSemantics);
    const operation = this.options.inlineSource || !canRenameReferences ? undefined : await prepareBaseViewReferences({ vault: this.options.vault, base: original, from, to, viewNames,
      mutations: this.options.mutations, validate, validateWrite: referenceWrite, validateRenamed });
    validate();
    let report: BaseViewRenameReport = Object.freeze({ basePath: this.path, from, to, completedPaths: Object.freeze([]), failedPaths: Object.freeze([]), references: 0, mode: adapter.documentSemantics ? 'core' : 'legacy' });
    const committed = async () => {
      // Publish the binding transition once the name is saved, even if one of
      // the independently saved references subsequently fails.
      if (operation) this.pendingViewReferences = operation;
      if (canRenameReferences) this.options.onViewRenamed?.(Object.freeze({ basePath: this.path, index, ...(typeof document.views[index].id === 'string' ? { viewId: document.views[index].id as string } : {}), from, to }));
      if (!operation) return report;
      report = await operation.run();
      if (this.pendingViewReferences === operation) this.pendingViewReferences = undefined;
      return report;
    };
    await this.changeConfiguration(version, next => { next.updateViewConfiguration(index, { root, view: { ...patch, name: to } }); return active; }, committed);
    return report;
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

  async setViewSource(version: number, index: number, source: BaseViewSource): Promise<void> {
    const selected = structuredClone(source), active = this.selectedViewIndex;
    await this.changeConfiguration(version, document => { document.changeViewSource(index, selected); return active; });
  }

  /** Query-error recovery grants only a source change on the selected parsed
   * view. It does not authorize property writes or other configuration edits. */
  async repairViewSource(read: BaseConfigurationRead, source: BaseViewSource): Promise<void> {
    const proof = this.configurationReadProof, selected = structuredClone(source);
    const validate = () => {
      if (!proof || !proof.repairable || this.configurationRead !== read || !this.current.error || this.current.result && sharedBasePreview(this.current.result) || baseViewSource(BaseDocument.parse(read.source).views[read.viewIndex]).kind !== 'collection') throw new Error('The failed Base configuration changed; refresh before changing its source.');
    };
    const validateWrite = () => {
      if (!proof || this.disposed || proof.adapter !== this.options.vault.adapter || proof.capability !== this.options.vault.adapter.durableWrites || proof.identity !== this.identities.get(this.path)) throw new Error('The Base source repair owner was replaced or retired.');
    };
    validate();
    await this.verifyConfigurationRead(read, validate);
    await this.changeConfiguration(read.version, document => { document.changeViewSource(read.viewIndex, selected); return read.viewIndex; }, undefined, {read,validate,validateWrite});
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
    await this.changeConfiguration(version, document => { document.updateViewConfiguration(this.selectedViewIndex, { root: detached }); return this.selectedViewIndex; });
  }

  async setFormula(version: number, name: string, expression: string | undefined): Promise<void> {
    await this.changeConfiguration(version, document => { document.setViewFormula(this.selectedViewIndex, name, expression); return this.selectedViewIndex; });
  }

  async renameFormula(version: number, from: string, to: string): Promise<void> {
    await this.changeConfiguration(version, document => { document.renameViewFormula(this.selectedViewIndex, from, to); return this.selectedViewIndex; });
  }

  async editFormula(version: number, originalName: string | undefined, name: string, expression: string): Promise<void> {
    await this.changeConfiguration(version, document => {
      if (originalName !== undefined && originalName !== name) document.renameViewFormula(this.selectedViewIndex, originalName, name);
      if (originalName === undefined) {
        const formulas = baseViewSetting(document, this.selectedViewIndex, 'formulas');
        if (formulas && !Array.isArray(formulas) && typeof formulas === 'object' && Object.hasOwn(formulas, name)) throw new Error('A formula with this name already exists');
      }
      document.setViewFormula(this.selectedViewIndex, name, expression); return this.selectedViewIndex;
    });
  }

  async editSummary(version: number, originalName: string | undefined, name: string, expression: string): Promise<void> {
    await this.changeConfiguration(version, document => { document.editViewSummary(this.selectedViewIndex, originalName, name, expression); return this.selectedViewIndex; });
  }

  async removeSummary(version: number, name: string): Promise<void> {
    await this.changeConfiguration(version, document => { document.removeViewSummary(this.selectedViewIndex, name); return this.selectedViewIndex; });
  }

  /** Read-only presentation of the exact accepted sources; never write authority. */
  get retainedConfigurationSources():readonly {readonly saved:string;readonly desired:string}[] {
    return Object.freeze([...this.pendingConfigurations].map(([desired,retry])=>Object.freeze({saved:retry.expected,desired})));
  }

  /** Retire derived queries without retiring accepted source/reference writers.
   * The original mutation guards, immutable plans and completed-file set survive.
   * This owner is disposed only after its admission capsule confirms settlement. */
  suspendDerivedActivity():void {
    if(this.disposed||this.derivedSuspended)return;
    this.derivedSuspended=true;this.configurationReadProof=undefined;this.clearWake();
    if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}
    this.requested=false;this.sharedQueries.cancel();
    for(const runner of this.summaryQueries)runner.cancel();
  }

  dispose(): void {
    this.configurationReadProof = undefined;
    this.disposed = true; this.clearWake(); this.epoch++; this.lastInvalidation = { kind: 'controller-dispose' }; this.sharedQueries.dispose();
    for (const runner of this.summaryQueries) runner.dispose(); this.summaryQueries.clear();
    this.undoCommands = []; this.redoCommands = []; this.pendingPropertyHistory.clear(); this.propertySourceAttempts.clear(); this.pendingConfigurations.clear(); this.configurationViewIds = undefined;
    this.pendingViewReferences = undefined;
    for (const service of this.referenceServices) void closeBaseViewReferenceQueries(service).catch(() => {});
    this.referenceServices.clear();
    // Disposal retires activity without publishing an observer after closure.
    this.current = this.settled;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = [];
  }
}
