export interface CheckpointScope { readonly vaultId: string; readonly clientId: string }
export interface CheckpointMetadata extends CheckpointScope {
  readonly version: 1;
  readonly key: string;
  readonly revision: string;
  readonly sequence: string;
  readonly deleted: boolean;
  readonly byteLength: number;
}
export interface Checkpoint extends CheckpointMetadata { readonly encodedState: string | null }
export interface CheckpointChange {
  readonly key: string;
  readonly expectedRevision: string | null;
  readonly nextRevision: string;
  /** Opaque editor-owned state, at most 32 MiB UTF-8. Null retains a tombstone. */
  readonly encodedState: string | null;
}
export interface CheckpointListOptions { readonly limit: number; readonly cursor?: string }
export interface CheckpointChangesOptions extends CheckpointListOptions { readonly after: string }
export interface CheckpointPage {
  readonly items: readonly CheckpointMetadata[];
  /** Continue even when items is empty. Null is the only end-of-pass signal. */
  readonly cursor: string | null;
  readonly highWater: string;
}
/** Internal local recovery data. Never emitted to the sync outbox.
 * Current heads hold bodies; immutable revision metadata fences all used IDs.
 * Pagination is fixed at highWater; after listing, run changes(after=highWater).
 * Historical metadata must be reconciled against load's current head before use.
 */
export interface DurableCheckpoints {
  readonly scope: CheckpointScope;
  load(key: string): Promise<Checkpoint | null>;
  compareAndSwap(change: CheckpointChange): Promise<Checkpoint>;
  list(options: CheckpointListOptions): Promise<CheckpointPage>;
  changes(options: CheckpointChangesOptions): Promise<CheckpointPage>;
}
