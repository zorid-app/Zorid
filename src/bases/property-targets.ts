import { catchUpDocumentIndex, DocumentSemanticsError } from '../core/document-semantics.ts';
import type { DocumentBaseRefreshHint, DocumentCurrentRelationValues, DocumentEntry, DocumentPin, DocumentQueryResult, DocumentService, DocumentSnapshotId, DocumentSourceId } from '../core/document-semantics.ts';
import type { VaultEntry } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import { createBaseClockHost } from './clock.ts';
import type { BaseClockHost } from './clock.ts';
import type { BaseExpressionValue } from './expression.ts';
import { createSharedBaseValueProjector } from './shared-values.ts';

export interface PropertyTarget { readonly entryId: string; readonly revision: string; readonly path: string; readonly label: string }
export interface PropertyTargetDiagnostic { readonly property?: string; readonly code?: string; readonly message: string }
// Structural capability keeps older admitted hosts supported without pretending
// that a missing endpoint can be replaced by a TypeScript predicate evaluator.
interface TargetsRead {
  readonly currentRelationValues?: DocumentCurrentRelationValues;
  readonly definition: DocumentEntry | null;
  readonly relationTargets: Readonly<Record<string, readonly PropertyTarget[]>>;
  readonly propertyDefinitionDiagnostics: readonly PropertyTargetDiagnostic[];
  readonly refreshHint?: DocumentBaseRefreshHint | null;
}
interface TargetsPin extends DocumentPin {
  propertyTargets?(input?: { readonly options?: {
    readonly propertyDefinitionsSource?: { readonly id: string; readonly source: string };
    readonly currentEntryId?: string; readonly clockMs?: number; readonly timezone?: string; readonly maxRows?: number; readonly maxSteps?: number;
  } }): Promise<DocumentQueryResult<TargetsRead>>;
}
export interface PropertyTargetsInput {
  readonly service?: DocumentService | null;
  readonly vault: Vault;
  /** Read committed file text, never a dirty editor buffer. Core seals it to the pin. */
  readonly readFile: (path: string) => Promise<string>;
  readonly current: Readonly<VaultEntry>;
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
  readonly clock?: BaseClockHost;
  readonly timezone?: string;
  readonly maxRows?: number;
  readonly maxSteps?: number;
}
export interface PropertyTargetsResult {
  readonly currentRelationValues?: {
    readonly witness: { readonly entryId: string; readonly revision: string };
    readonly values: Readonly<Record<string, BaseExpressionValue>>;
    readonly editValues: Readonly<Record<string, BaseExpressionValue>>;
  };
  readonly relationTargets: Readonly<Record<string, readonly PropertyTarget[]>>;
  readonly diagnostics: readonly PropertyTargetDiagnostic[];
  readonly refreshHint: DocumentBaseRefreshHint | null;
  readonly snapshot: DocumentSnapshotId;
  readonly source: DocumentSourceId;
  readonly coverageComplete: boolean;
  readonly current: DocumentEntry;
  readonly settings: DocumentEntry | null;
  readonly clockMs: number;
  readonly timezone: string;
}

/** Raw note properties contain inert data, never display namespaces or getters. */
export function isPlainPropertyValue(value: unknown): value is BaseExpressionValue {
  let remaining = 10000;
  const active = new Set<object>();
  const plain = (value: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 64 || !value || typeof value !== 'object' || active.has(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return false;
    const kind = Object.getOwnPropertyDescriptor(value, 'type')?.value;
    const allowed = kind === 'null' ? ['type'] : ['type', 'value'];
    if (Object.getOwnPropertyNames(value).some(key => !allowed.includes(key))) return false;
    if (kind === 'null') return true;
    const data = Object.getOwnPropertyDescriptor(value, 'value')?.value;
    if (kind === 'string') return typeof data === 'string';
    if (kind === 'boolean') return typeof data === 'boolean';
    if (kind === 'number') return typeof data === 'number' && Number.isFinite(data);
    if (kind !== 'list' && kind !== 'object') return false;
    if (kind === 'list' ? !Array.isArray(data) : !data || typeof data !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) return false;
    if (active.has(data) || Object.getOwnPropertySymbols(data).length) return false;
    const ownKeys = Object.keys(data);
    if (ownKeys.length > remaining || kind === 'list' && (!Number.isSafeInteger(data.length) || data.length > remaining || ownKeys.length !== data.length || Object.getOwnPropertyNames(data).length !== data.length + 1) || kind === 'object' && Object.getOwnPropertyNames(data).length !== ownKeys.length) return false;
    const keys = kind === 'list' ? Array.from({ length: data.length }, (_, index) => String(index)) : ownKeys;
    active.add(value); active.add(data);
    const valid = keys.every(key => {
      const item = Object.getOwnPropertyDescriptor(data, key);
      return !!item && 'value' in item && plain(item.value, depth + 1);
    });
    active.delete(value); active.delete(data); return valid;
  };
  return plain(value, 0);
}

function projectCurrentValues(input: DocumentCurrentRelationValues | undefined, current: DocumentEntry, timezone: string): PropertyTargetsResult['currentRelationValues'] {
  if (input === undefined) return;
  if (input.witness.entryId !== current.id || input.witness.revision !== current.revision) throw new DocumentSemanticsError('property_targets_stale');
  const captured = structuredClone(input);
  let remaining = 400000;
  const seal = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 384) throw new DocumentSemanticsError('property_targets_invalid_values');
    if (value && typeof value === 'object') { for (const item of Object.values(value)) seal(item, depth + 1); Object.freeze(value); }
  };
  seal(captured);
  const valueKeys = Object.keys(captured.values).sort(), editKeys = Object.keys(captured.editValues).sort();
  if (valueKeys.length !== editKeys.length || valueKeys.some((key, index) => key !== editKeys[index])) throw new DocumentSemanticsError('property_targets_invalid_values');
  const value = createSharedBaseValueProjector(timezone);
  const values = Object.freeze(Object.fromEntries(Object.entries(captured.values).map(([key, item]) => [key, value(item)])));
  const editValues = Object.freeze(Object.fromEntries(Object.entries(captured.editValues).map(([key, item]) => {
    const raw = value(item);
    if (!isPlainPropertyValue(raw)) throw new DocumentSemanticsError('property_targets_invalid_values');
    return [key, raw];
  })));
  return Object.freeze({ witness: captured.witness, values, editValues });
}

const failedCloses = new WeakMap<DocumentService, Map<DocumentPin, Promise<void> | undefined>>();
function pending(service: DocumentService) {
  let pins = failedCloses.get(service);
  if (!pins) { pins = new Map(); failedCloses.set(service, pins); }
  return pins;
}
async function close(service: DocumentService, pin: DocumentPin): Promise<void> {
  const pins = pending(service), closing = pins.get(pin);
  if (closing) return closing;
  const task = Promise.resolve().then(() => pin.close()).then(() => { pins.delete(pin); }, error => { pins.set(pin, undefined); throw error; });
  pins.set(pin, task);
  await task;
}
/** Retry owned failed close acknowledgements, including during workspace teardown. */
export async function closePropertyTargetQueries(service: DocumentService): Promise<void> {
  for (const pin of [...pending(service).keys()]) await close(service, pin);
}
function sameSnapshot(a: DocumentSnapshotId, b: DocumentSnapshotId): boolean {
  return a.localStoreId === b.localStoreId && a.generationEpoch === b.generationEpoch && a.generation === b.generation
    && a.versions.schema === b.versions.schema && a.versions.extraction === b.versions.extraction
    && a.versions.resolver === b.versions.resolver && a.versions.query === b.versions.query;
}
function sameSource(a: DocumentSourceId, b: DocumentSourceId): boolean { return a.localStoreId === b.localStoreId && a.watermark === b.watermark; }
function saved(entry: Readonly<VaultEntry>): DocumentEntry {
  if (entry.type !== 'file' || !entry.entryId || !entry.revision) throw new DocumentSemanticsError('property_targets_identity_unavailable');
  return Object.freeze({ id: entry.entryId, revision: entry.revision, path: entry.path, kind: 'file', deleted: false });
}
function sameEntry(a: DocumentEntry | null | undefined, b: DocumentEntry): boolean {
  return !!a && a.id === b.id && a.revision === b.revision && a.path === b.path && a.kind === 'file' && !a.deleted;
}
function sameSaved(a: VaultEntry | undefined, b: DocumentEntry): boolean {
  return !!a && a.type === 'file' && a.entryId === b.id && a.revision === b.revision && a.path === b.path;
}

/** Query Rust-owned relation candidates for an ordinary saved note. No publication
 * occurs until every read, source observation, and pin-close acknowledgement passes. */
export async function queryPropertyTargets(input: PropertyTargetsInput): Promise<PropertyTargetsResult> {
  const adapter = input.vault.adapter, admitted = adapter.documentSemantics;
  const service = input.service === undefined ? admitted : input.service;
  const check = () => {
    if (!input.isCurrent() || input.signal?.aborted || input.vault.adapter !== adapter || adapter.documentSemantics !== admitted) throw new DocumentSemanticsError('document_request_cancelled');
  };
  check();
  if (!service || (service as DocumentService & { readonly propertyTargetsAvailable?: boolean }).propertyTargetsAvailable !== true) throw new DocumentSemanticsError('property_targets_unavailable');
  const current = saved(input.current);
  await closePropertyTargetQueries(service); check();
  const maintained = await catchUpDocumentIndex(service, { isCurrent: () => { try { check(); return true; } catch { return false; } }, signal: input.signal }); check();
  if (!maintained.current || !maintained.snapshot || maintained.rebuildRequired) throw new DocumentSemanticsError('property_targets_index_not_current');
  const inventory = await adapter.list(); check();
  if (!sameSaved(inventory.find(entry => entry.path === current.path), current)) throw new DocumentSemanticsError('property_targets_stale');
  // Definitions belong to databases. Ordinary note queries never read a global registry.
  const settings = null;
  let pin: TargetsPin | undefined, result: PropertyTargetsResult;
  try {
    pin = await service.open(); check();
    if (typeof pin.propertyTargets !== 'function') throw new DocumentSemanticsError('property_targets_unavailable');
    const capturedPin = pin;
    const reportCheck = <T>(report: DocumentQueryResult<T>) => {
      check();
      if (!sameSnapshot(report.snapshot, capturedPin.snapshot) || !sameSource(report.source, capturedPin.source)) throw new DocumentSemanticsError('property_targets_stale');
    };
    const noteMetadata = await pin.metadata(current.id); reportCheck(noteMetadata);
    if (!sameEntry(noteMetadata.value.entry, current)) throw new DocumentSemanticsError('property_targets_stale');
    const captured = (input.clock ?? createBaseClockHost()).capture(input.timezone);
    if (!Number.isSafeInteger(captured.clockMs)) throw new DocumentSemanticsError('invalid_request');
    const report = await pin.propertyTargets({ options: { currentEntryId: current.id,
      clockMs: captured.clockMs, timezone: captured.timezone, maxRows: input.maxRows ?? 10000, ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }) } });
    reportCheck(report);
    if (report.value.definition !== null) throw new DocumentSemanticsError('property_targets_stale');
    const latestInventory = await adapter.list(); check();
    if (!sameSaved(latestInventory.find(entry => entry.path === current.path), current)) throw new DocumentSemanticsError('property_targets_stale');
    // Core status observes all saved candidates, not merely the note/settings
    // visible in the workspace's possibly older namespace inventory.
    const latest = await service.status(); check();
    if (!latest.current || latest.rebuildRequired || !latest.snapshot || !sameSnapshot(latest.snapshot, pin.snapshot) || !sameSource(latest.source, pin.source)) throw new DocumentSemanticsError('property_targets_stale');
    const currentRelationValues = projectCurrentValues(report.value.currentRelationValues, current, captured.timezone);
    result = Object.freeze({ ...(currentRelationValues ? { currentRelationValues } : {}), relationTargets: Object.freeze(Object.fromEntries(Object.entries(report.value.relationTargets).map(([key, targets]) => [key, Object.freeze(targets.map(target => Object.freeze({ ...target })))]))),
      diagnostics: Object.freeze(report.value.propertyDefinitionDiagnostics.map(diagnostic => Object.freeze({ ...diagnostic }))),
      refreshHint: report.value.refreshHint ? Object.freeze({ ...report.value.refreshHint }) : null,
      snapshot: Object.freeze({ ...report.snapshot, versions: Object.freeze({ ...report.snapshot.versions }) }), source: Object.freeze({ ...report.source }),
      coverageComplete: report.coverageComplete, current, settings, clockMs: captured.clockMs, timezone: captured.timezone });
  } finally { if (pin) await close(service, pin); }
  check();
  return result;
}
