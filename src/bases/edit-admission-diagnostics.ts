/** Passive rejection-time facts only. Error identity, message and control flow
 * stay owned by the existing guards; no file data enters these records. */
export type BaseEditAdmissionPhase = 'action-current' | 'controller-guard' | 'before-buffer' | 'after-buffer-load' | 'transform' | 'before-buffer-update' | 'durable-validation';
export type BaseEditAdmissionReason = 'invalid-version' | 'version' | 'query-error' | 'result-unavailable' | 'epoch' | 'identity' | 'closed' | 'preview';
export const BASE_EDIT_INVALIDATION_KINDS = ['initial', 'vault-create', 'vault-modify', 'vault-rename', 'vault-delete', 'vault-ready', 'clock-hidden-refresh-abort', 'clock-stale', 'clock-timezone', 'clock-deadline', 'clock-backwards', 'view-selection', 'search-change', 'current-file-change', 'configuration-commit', 'configuration-retry-ack', 'controller-dispose'] as const;
export type BaseEditInvalidationKind = typeof BASE_EDIT_INVALIDATION_KINDS[number];
export interface BaseEditAdmissionSnapshot {
  readonly guard: 'view-actions' | 'controller';
  readonly phase: BaseEditAdmissionPhase;
  readonly reason: BaseEditAdmissionReason;
  readonly submittedVersion: number | null;
  readonly currentVersion: number;
  readonly hasResult: boolean;
  readonly queryError: boolean;
  readonly updating: boolean;
  readonly disposed?: boolean;
  readonly capturedInvalidationKind?: BaseEditInvalidationKind;
  readonly currentInvalidationKind?: BaseEditInvalidationKind;
  readonly capturedStale?: boolean;
  readonly currentStale?: boolean;
  readonly invalidationTargetAffected?: boolean;
  readonly invalidationBaseAffected?: boolean;
  readonly invalidationOtherPath?: boolean;
  readonly capturedTargetEntryAvailable?: boolean;
  readonly currentTargetEntryAvailable?: boolean;
  readonly capturedTargetRevisionAvailable?: boolean;
  readonly currentTargetRevisionAvailable?: boolean;
  readonly targetEntryMatches?: boolean;
  readonly targetRevisionMatches?: boolean;
  readonly capturedBaseEntryAvailable?: boolean;
  readonly currentBaseEntryAvailable?: boolean;
  readonly capturedBaseRevisionAvailable?: boolean;
  readonly currentBaseRevisionAvailable?: boolean;
  readonly baseEntryMatches?: boolean;
  readonly baseRevisionMatches?: boolean;

  readonly capturedEpoch?: number;
  readonly currentEpoch?: number;
  readonly capturedTargetIdentity?: number;
  readonly currentTargetIdentity?: number;
  readonly capturedBaseIdentity?: number;
  readonly currentBaseIdentity?: number;
  readonly targetIdentityMatches?: boolean;
  readonly baseIdentityMatches?: boolean;
  readonly capturedSelection?: number;
  readonly currentSelection?: number;
  readonly capturedConfigurationEpoch?: number;
  readonly currentConfigurationEpoch?: number;
}
export type BaseEditAdmissionReceipt = Readonly<BaseEditAdmissionSnapshot & { readonly serial: number }>;
const receipts = new WeakMap<object, BaseEditAdmissionReceipt>();
let serial = 0;
export function baseEditAdmissionVersion(version: unknown): number | null { return typeof version === 'number' && Number.isSafeInteger(version) ? version : null; }
export function recordBaseEditAdmission<T extends Error>(error: T, snapshot: BaseEditAdmissionSnapshot): T {
  const record: Record<string, unknown> = { serial: ++serial, guard: snapshot.guard, phase: snapshot.phase, reason: snapshot.reason };
  for (const key of ['submittedVersion', 'currentVersion', 'capturedEpoch', 'currentEpoch', 'capturedTargetIdentity', 'currentTargetIdentity', 'capturedBaseIdentity', 'currentBaseIdentity', 'capturedSelection', 'currentSelection', 'capturedConfigurationEpoch', 'currentConfigurationEpoch'] as const) {
    if (Object.hasOwn(snapshot, key)) record[key] = baseEditAdmissionVersion(snapshot[key]);
  }
  for (const key of ['hasResult', 'queryError', 'updating', 'disposed', 'targetIdentityMatches', 'baseIdentityMatches', 'capturedStale', 'currentStale', 'invalidationTargetAffected', 'invalidationBaseAffected', 'invalidationOtherPath', 'capturedTargetEntryAvailable', 'currentTargetEntryAvailable', 'capturedTargetRevisionAvailable', 'currentTargetRevisionAvailable', 'targetEntryMatches', 'targetRevisionMatches', 'capturedBaseEntryAvailable', 'currentBaseEntryAvailable', 'capturedBaseRevisionAvailable', 'currentBaseRevisionAvailable', 'baseEntryMatches', 'baseRevisionMatches'] as const) if (typeof snapshot[key] === 'boolean') record[key] = snapshot[key];
  for (const key of ['capturedInvalidationKind', 'currentInvalidationKind'] as const) if (BASE_EDIT_INVALIDATION_KINDS.some(kind => kind === snapshot[key])) record[key] = snapshot[key];
  receipts.set(error, Object.freeze(record) as BaseEditAdmissionReceipt); return error;
}
export function baseEditAdmissionReceipt(error: unknown): BaseEditAdmissionReceipt | undefined { return error !== null && (typeof error === 'object' || typeof error === 'function') ? receipts.get(error) : undefined; }
export function withBaseEditAdmissionPhase<T>(phase: BaseEditAdmissionPhase, operation: () => T): T {
  try { return operation(); }
  catch (error) { const record = baseEditAdmissionReceipt(error); if (record) receipts.set(error as object, Object.freeze({ ...record, phase })); throw error; }
}
