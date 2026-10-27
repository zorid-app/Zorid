import type { DurableCheckpoints } from './durable-checkpoints.ts';

/** Verified provider rejection of inert write planning, before any intent exists.
 * This type must never be used to classify commit/acknowledgment uncertainty. */
export class DurableWritePlanningError extends Error {
  readonly source='host';
  readonly code:string;
  readonly commitUncertain:boolean;
  constructor(code:string,commitUncertain:boolean){
    super('The note write could not be planned.');this.name='DurableWritePlanningError';this.code=code;this.commitUncertain=commitUncertain;
  }
}


/** Durable consumer checkpoint data. All identities must survive retries/reload. */
export interface DurableWritePlan {
  readonly version: 1;
  /** Persistent LOCAL storage authority, never a path/name or logical sync vault ID. */
  readonly vaultId: string;
  readonly clientId: string;
  readonly operationId: string;
  readonly entryId: string;
  /** Exact provider request, at most 8 MiB of UTF-8. Never replan on retry.
   * Provider serialization determines how much text fits inside this bound. */
  readonly encodedPlan: string;
  /** Provider-composed text authored by this exact plan. Present only when a
   * managed collection projection replaced unchanged generated frontmatter.
   * Consumers reconcile this submitted generation after the exact commit; they
   * must retain edits typed while the request was pending. */
  readonly canonicalContent?: string;
}
export interface DurableWriteRef {
  /** Must match the store's persisted authority. Recreation creates a new ID;
   * any future sanctioned restore must rotate it before accepting old refs. */
  readonly vaultId: string;
  readonly clientId: string;
  readonly token: string;
  readonly operationId: string;
  readonly entryId: string;
}
export type DurableWriteOutcome =
  | { readonly status: 'committed'; readonly operationId: string; readonly sequence: string }
  | { readonly status: 'rejected'; readonly operationId: string; readonly code: string };
export type DurableWriteIntent = { readonly ref: DurableWriteRef } & (
  | { readonly state: 'prepared' | 'commit_requested'; readonly acknowledged: false }
  | { readonly state: 'committed'; readonly acknowledged: boolean;
      readonly receipt: { readonly operationId: string; readonly sequence: string; readonly entryId:string; readonly revision:string } }
  | { readonly state: 'rejected'; readonly acknowledged: boolean;
      readonly error: { readonly operationId: string; readonly code: string; readonly message: string; readonly details?: unknown } }
);
/** A logical editor baseline. Physical saved-source observations never replace it. */
export interface ConditionalSavedSourceWitness {
  readonly entryId: string;
  readonly revision: string;
  readonly path: string;
}
/** Provider-owned physical-source proof. Only this opaque guard enters a plan. */
export interface ConditionalSavedSourceGuard {
  readonly captureId: string;
  readonly logicalWitness: ConditionalSavedSourceWitness;
}
export interface ConditionalSavedSourceCapture extends ConditionalSavedSourceGuard {
  /** Physical UTF-8 source, for conditional touched-field checks only. */
  readonly source: string;
}
export type ConditionalSavedSourceStatus = 'unattached' | 'pending' | 'settled' | 'foreign';
export interface DurableWriteInput {
  readonly operationId: string;
  readonly path: string;
  readonly expectedEntryId: string;
  readonly expectedRevision: string;
  readonly expectedContent: string;
  readonly content: string;
  readonly conditionalSavedSource?: ConditionalSavedSourceGuard;
}
/** One coherent persisted observation, never assembled from read + stat. */
export interface DurableWriteRead {
  readonly content: string;
  readonly path: string;
  readonly entryId: string;
  readonly revision: string;
  readonly stat: {readonly ctime:number;readonly mtime:number;readonly size:number};
}
export interface DurableNoteCompositionInput {
  readonly entryId: string;
  readonly path: string;
  readonly expectedRevision: string;
  readonly baseline: string;
  readonly proposed: string;
}
export interface DurableNoteComposition {
  readonly current: DurableWriteRead;
  readonly content: string;
}
/** Optional editor capability; it does not replace legacy adapter methods.
 * Persist plan BEFORE prepare; persist returned ref BEFORE commit; reconcile and
 * persist settled outcome BEFORE acknowledge. A failed checkpoint forbids the
 * next step. Prepared records are inert. Unknown outcomes reuse the same plan/ref.
 */
export interface DurableWrites {
  readonly checkpoints: DurableCheckpoints;
  readText(path: string): Promise<DurableWriteRead>;
  readTextById(entryId: string): Promise<DurableWriteRead|null>;
  /** Optional pure managed-property refresh. The provider admits unchanged
   * baseline body/unmanaged source and returns one coherent current baseline.
   * Null means this ordinary note has no managed collection projection. */
  composeNote?(input: DurableNoteCompositionInput): Promise<DurableNoteComposition|null>;
  /** Optional paired capability. Captures do not advance the logical baseline. */
  captureSavedSource?(witness: ConditionalSavedSourceWitness): Promise<ConditionalSavedSourceCapture>;
  releaseSavedSource?(captureId: string): Promise<void>;
  planWrite(input: DurableWriteInput): Promise<DurableWritePlan>;
  prepare(plan: DurableWritePlan): Promise<DurableWriteIntent>;
  commit(ref: DurableWriteRef): Promise<DurableWriteIntent>;
  /** Null for a missing record. A checkpointed ref that disappears is recovery
   * failure, never permission to prepare again or manufacture a replacement. */
  query(ref: DurableWriteRef): Promise<DurableWriteIntent | null>;
  /** Includes inert prepared writes, excludes other command kinds. Listing never
   * authorizes execution; other commands need their own recovery consumer. */
  listUnacknowledged(): Promise<DurableWriteIntent[]>;
  acknowledge(ref: DurableWriteRef, expected: DurableWriteOutcome): Promise<void>;
}
