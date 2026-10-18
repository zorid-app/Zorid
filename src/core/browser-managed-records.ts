import { BrowserVaultError } from './browser-vault.ts';
import { decimalU64, normalizedTransact, getExactSource } from './browser-normalized-idb.ts';
import type { Abort, SourceKey, SourceRead } from './browser-normalized-idb.ts';

/** Private storage seam. The parent opener owns the fresh database version and activation.
 * No JavaScript merge/admission decisions or JS-constructible authentication capability. */
export const browserManagedKeyPaths = {
  managed_collections: ['realmId', 'vaultId', 'owner', 'collection'],
  managed_records: ['realmId', 'vaultId', 'owner', 'collection', 'record', 'generation'],
  managed_receipts: ['realmId', 'vaultId', 'updateId'],
  managed_operation_sources: ['realmId', 'vaultId', 'owner', 'collection', 'record', 'generation', 'operationId', 'updateId'],
  managed_local_operations: ['realmId', 'vaultId', 'owner', 'collection', 'operationId'],
  managed_changes: ['realmId', 'vaultId', 'sequenceOrder'],
} as const;
export type ManagedStore = keyof typeof browserManagedKeyPaths;
export const browserManagedStores = Object.freeze(Object.keys(browserManagedKeyPaths) as ManagedStore[]);
export const browserManagedIndexes = {
  managed_receipts: [{ name: 'by_retry', keyPath: ['realmId', 'vaultId', 'owner', 'collection', 'updateId'], unique: false }],
  managed_operation_sources: [{ name: 'by_operation', keyPath: ['realmId', 'vaultId', 'owner', 'collection', 'record', 'generation', 'operationId'], unique: false }],
  managed_changes: [{ name: 'by_collection', keyPath: ['realmId', 'vaultId', 'owner', 'collection', 'sequenceOrder'], unique: false }],
} as const;
export const managedRetryLimits = Object.freeze({ count: 16, bytes: 1024 * 1024 });
const failure = (code: string) => new BrowserVaultError(code, 'Managed browser storage rejected an unavailable or inconsistent record');

/** Called only by the parent fresh-format upgrade; never adopts existing records stores. */
export function createBrowserManagedSchema(db: IDBDatabase): void {
  if (browserManagedStores.some(name => db.objectStoreNames.contains(name))) throw failure('storage_schema_mismatch');
  for (const name of browserManagedStores) {
    const store = db.createObjectStore(name, { keyPath: [...browserManagedKeyPaths[name]] });
    const indexes = browserManagedIndexes[name as keyof typeof browserManagedIndexes] ?? [];
    for (const index of indexes) store.createIndex(index.name, [...index.keyPath], { unique: index.unique });
  }
}

export interface ManagedCollectionKey { realmId: string; vaultId: string; owner: string; collection: string }
export interface ManagedReceiptHead extends ManagedCollectionKey, SourceKey {
  record: string; generation: string; restores: string | null; revision: string;
  /** Rust-derived opaque reason; the Rust bridge decides retry eligibility. */
  status: string; payloadBytes: string;
}
export interface ManagedRetrySelection {
  heads: ManagedReceiptHead[];
  inputBytes: string;
  /** Exclusive continuation; null means end of collection, so the next sweep wraps. */
  next: string | null;
  exhausted: boolean;
}
export interface ManagedStorageHost {
  db: IDBDatabase; authorityId: string;
  /** Includes lease and (for received work) sync session generation. */
  assertActive(): void;
}
function sync<T>(value: T): T {
  if (value && typeof (value as { then?: unknown }).then === 'function') throw failure('async_storage_callback');
  return value;
}
function on<T>(host: ManagedStorageHost, tx: IDBTransaction, request: IDBRequest<T>, callback: (value: T) => void, abort: Abort): void {
  request.onsuccess = () => { try { host.assertActive(); sync(callback(request.result)); } catch (error) { abort(error); } };
}
function components(key: ManagedCollectionKey): string[] {
  const parts = [key.realmId, key.vaultId, key.owner, key.collection];
  // Envelope realm/vault validation belongs to the shared ledger. Domain IDs allow punctuation.
  if (parts.some(part => typeof part !== 'string' || !part || part.length > 128)) throw failure('invalid_managed_identity');
  return parts;
}
function head(value: unknown, collection: ManagedCollectionKey): ManagedReceiptHead {
  const row = value as ManagedReceiptHead;
  if (!row || components(row).some((part, index) => part !== components(collection)[index]) ||
    !['updateId', 'record', 'generation', 'revision', 'status'].every(field => typeof row[field as keyof ManagedReceiptHead] === 'string' && row[field as keyof ManagedReceiptHead])) throw failure('storage_corrupt');
  if (row.restores !== null && (typeof row.restores !== 'string' || !row.restores)) throw failure('storage_corrupt');
  const length = BigInt(decimalU64(row.payloadBytes));
  if (length < 1n || length > BigInt(managedRetryLimits.bytes)) throw failure('storage_corrupt');
  return structuredClone(row);
}

/** Reads only metadata, never a byte-store cursor/getAll. Eligibility is supplied by Rust,
 * preserving native excluded statuses without introducing a second classifier in JS. */
export function selectManagedRetryPage(host: ManagedStorageHost, collection: ManagedCollectionKey,
  after: string | null, retryEligible: (status: string) => boolean, limit = managedRetryLimits.count): Promise<ManagedRetrySelection> {
  const prefix = components(collection);
  if (!Number.isInteger(limit) || limit < 1 || limit > managedRetryLimits.count ||
    (after !== null && (typeof after !== 'string' || !after || after.length > 128))) return Promise.reject(failure('invalid_managed_retry'));
  return normalizedTransact(host.db, { ...host, stores: ['managed_receipts'], mode: 'readonly' }, (tx, done, abort) => {
    const result: ManagedRetrySelection = { heads: [], inputBytes: '0', next: null, exhausted: true };
    const range = IDBKeyRange.bound([...prefix, after ?? ''], [...prefix, []], after !== null, true);
    const request = tx.objectStore('managed_receipts').index('by_retry').openCursor(range);
    on(host, tx, request, cursor => {
      if (!cursor) { done(result); return; }
      const row = head(cursor.value, collection);
      const eligible = sync(retryEligible(row.status));
      if (typeof eligible !== 'boolean') throw failure('invalid_managed_retry');
      if (!eligible) { cursor.continue(); return; }
      const bytes = BigInt(result.inputBytes) + BigInt(row.payloadBytes);
      if (result.heads.length === limit || bytes > BigInt(managedRetryLimits.bytes)) {
        result.exhausted = false; result.next = result.heads.at(-1)?.updateId ?? after; done(result); return;
      }
      result.heads.push(row); result.inputBytes = String(bytes); cursor.continue();
    }, abort);
  });
}

/** Exact body read under authority/lease guard. Replay must validate its authenticated
 * descriptor in Rust again before a separate strict CAS activation transaction. */
export function readManagedRetrySource(host: ManagedStorageHost, receipt: ManagedReceiptHead): Promise<SourceRead> {
  return normalizedTransact(host.db, { ...host, stores: ['sync_source_headers', 'sync_source_payloads'], mode: 'readonly' }, (tx, done, abort) => {
    getExactSource(tx, receipt, 'payload', source => {
      try {
        host.assertActive();
        if (!source || String(source.bytes.byteLength) !== decimalU64(receipt.payloadBytes)) throw failure('storage_corrupt');
        done(source);
      } catch (error) { abort(error); }
    }, abort);
  });
}

export interface ManagedScope { realm: string; vault: string; owner: string; collection: string; record: string; generation: string; restores: string | null }
export interface RecordsPlan {
  checkPreconditions(actualFactsJson: string): void;
  resultJson(): string;
  nextState(): Uint8Array | undefined;
  projection(): Uint8Array | undefined;
  payload(): Uint8Array | undefined;
  payloadMetadataJson(): string | undefined;
  localRequest(): Uint8Array | undefined;
  operationBindings(): Uint8Array;
  free(): void;
}
export interface ManagedRecordsWasm {
  validateRecordsRegistration(next: Uint8Array, old: Uint8Array | undefined): void;
  validateRecordsAccepted(registration: Uint8Array, state: Uint8Array): void;
  canonicalRecordsLocalRequest(registration: Uint8Array, scopeJson: string, operation: string, expected: Uint8Array, command: Uint8Array): Uint8Array;
  finalizeRecordsLocalResult(operation: string, revision: Uint8Array, sequence: string): Uint8Array;
  prepareRecordsLocal(factsJson: string, command: Uint8Array): RecordsPlan;
  recordsSnapshot(registration: Uint8Array, scopeJson: string, state: Uint8Array | undefined): RecordsPlan;
  recordsRetryEligible(status: string): boolean;
  validateRecordsStoredOperation(scopeJson: string, operation: string, update: string, content: Uint8Array): void;
  validateRecordsStoredReplay(collectionScopeJson: string, operation: string, request: Uint8Array, result: Uint8Array): void;
  validateRecordsStoredBinding(scopeJson: string, operation: string, update: string, content: Uint8Array, evidenceJson: string): void;
  recordsStoredReadSet(payload: Uint8Array): string;
}
export interface AuthenticatedRecordsUpdate {
  recordsReadSetJson(): string;
  metadataJson(): string;
  exactPlaintext(): Uint8Array;
  exactWire(): Uint8Array;
  prepareRecords(factsJson: string): RecordsPlan;
  free(): void;
}
interface Usage {
  records: string; state_bytes: string; replaced_bytes: string; receipts: string; receipt_bytes: string;
  operation_bytes: string; local_operations: string; local_bytes: string; changes: string;
}
interface Counters { key: string; usage: Usage; sequence: string; registrations: string }
interface CollectionRow extends ManagedCollectionKey { registration: Uint8Array; revision: string; retryAfter: string | null }
interface StateRow extends ManagedCollectionKey { record: string; generation: string; restores: string | null; state: Uint8Array; projection: Uint8Array }
interface LocalRow extends ManagedCollectionKey { record: string; generation: string; restores: string | null; operationId: string; request: Uint8Array; result: Uint8Array; updateId: string | null }
interface BindingRow extends ManagedCollectionKey { record: string; generation: string; restores: string | null; operationId: string; updateId: string; content: Uint8Array }
interface RecordsFacts {
  registration: string | null; registration_revision: string | null; scope: ManagedScope;
  accepted: string | null; restore_source: string | null;
  operation_sources: Array<{ operation: string; update: string; content: string }>;
  local: null | { operation: string; expected_revision: number[]; prior_request: string | null; prior_result: string | null };
  usage: Usage; receipt: null | { status: string; revision: string };
  cursor: null | { epoch: string; position: string };
}
interface FactsSnapshot { facts: RecordsFacts; counters: Counters; state?: StateRow; bindings: BindingRow[] }
export interface ManagedLocalInput { scope: ManagedScope; operation: string; expectedRevision: Uint8Array; command: Uint8Array }
/** A public-looking token carries no fields; only this adapter's closure can authorize it. */
export interface ManagedCollectionHandle { readonly dispose: () => void }
export interface ManagedCommitOutcome { result: Uint8Array; replay: boolean; localDurable: true }
export interface ManagedCommonLedger {
  /** Existing common ledger owner rechecks enrollment/session and returns the shared cursor.
   * Must include exact wire/dedupe/source/quota checks at commit, not trust prepared facts. */
  stores: readonly string[];
  storedSource(tx: IDBTransaction, key: SourceKey, done: (value: {source:SourceRead;authored:boolean}|null) => void, abort: Abort): void;
  readContext(tx: IDBTransaction, scope: ManagedScope, done: (cursor: RecordsFacts['cursor']) => void, abort: Abort): void;
  authored(tx: IDBTransaction, metadataJson: string, payload: Uint8Array, done: () => void, abort: Abort): void;
  received(tx: IDBTransaction, input: { metadataJson: string; payload: Uint8Array; wire: Uint8Array; delivery?: unknown; duplicateOnly?: boolean; assertActive?(): void },
    done: (result: { duplicate: boolean; authored: boolean }) => void, abort: Abort): void;
  /** AEAD-open exact retained wire using the enrolled key; never construct an update from plaintext. */
  retainedSession(): { assertActive(): void; open(receipt: ManagedReceiptHead): Promise<AuthenticatedRecordsUpdate> };

}
export interface ManagedRecordsHost extends ManagedStorageHost { wasm: ManagedRecordsWasm; common: ManagedCommonLedger }
const counterKey = 'managed-records-usage:v1';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const raw = (bytes: Uint8Array): string => decoder.decode(bytes);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
const scopeKey = (scope: ManagedScope): ManagedCollectionKey => ({ realmId: scope.realm, vaultId: scope.vault, owner: scope.owner, collection: scope.collection });
const sameScope = (a:ManagedScope,b:ManagedScope) => (['realm','vault','owner','collection','record','generation','restores'] as const).every(key=>a[key]===b[key]);
const recordKey = (scope: ManagedScope): string[] => [...components(scopeKey(scope)), scope.record, scope.generation];
const initialCounters = (): Counters => ({ key: counterKey, sequence: '0', registrations: '0', usage: {
  records: '0', state_bytes: '0', replaced_bytes: '0', receipts: '0', receipt_bytes: '0', operation_bytes: '0', local_operations: '0', local_bytes: '0', changes: '0',
} });
function counters(value: unknown): Counters {
  // Fresh-format parent may initialize this explicitly; an absent row denotes untouched records.
  if (value === undefined) return initialCounters();
  const row = structuredClone(value) as Counters;
  if (!row || row.key !== counterKey || !row.usage) throw failure('storage_corrupt');
  decimalU64(row.sequence); decimalU64(row.registrations);
  for (const key of Object.keys(initialCounters().usage) as (keyof Usage)[]) decimalU64(row.usage[key]);
  if (row.usage.replaced_bytes !== '0') throw failure('storage_corrupt');
  return row;
}
function changeCounter(usage: Usage, key: keyof Usage, delta: bigint): void {
  usage[key] = decimalU64(String(BigInt(usage[key]) + delta));
}
function boundedBytes(value: Uint8Array, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) throw failure('invalid_managed_bytes');
  return value.slice();
}

/** Storage adapter over the SAME authority database. Binding functions are trusted injected
 * Rust exports; no public worker registration endpoint or product activation is introduced. */
export function createBrowserManagedRecords(host: ManagedRecordsHost) {
  const handles = new WeakMap<ManagedCollectionHandle, { key: ManagedCollectionKey; revision: string }>();
  const stores = [...browserManagedStores, ...host.common.stores];
  const active = () => host.assertActive();
  const transactionGuards = new WeakMap<IDBTransaction, () => void>();
  const transact = <T>(mode: IDBTransactionMode, start: (tx: IDBTransaction, done: (value: T) => void, abort: Abort) => void, extra?: () => void) => {
    const admitted = () => { active(); extra?.(); };
    return normalizedTransact<T>(host.db, { authorityId: host.authorityId, stores, mode, assertActive: admitted }, (tx, done, abort) => {
      transactionGuards.set(tx, admitted); start(tx, done, abort);
    });
  };
  const read = <T>(tx: IDBTransaction, request: IDBRequest<T>, callback: (value: T) => void, abort: Abort) =>
    on({ ...host, assertActive() { active(); transactionGuards.get(tx)?.(); } }, tx, request, callback, abort);
  function authorize(tx: IDBTransaction, token: ManagedCollectionHandle, done: (row: CollectionRow) => void, abort: Abort): void {
    const retained = handles.get(token);
    if (!retained) throw failure('invalid_managed_handle');
    read(tx, tx.objectStore('managed_collections').get(components(retained.key)), (row: CollectionRow | undefined) => {
      if (!row || row.revision !== retained.revision) throw failure('stale_managed_registration');
      done(row);
    }, abort);
  }
  function readFacts(tx: IDBTransaction, scope: ManagedScope, registration: CollectionRow | undefined,
    local: RecordsFacts['local'], done: (snapshot: FactsSnapshot) => void, abort: Abort): void {
    const collection = scopeKey(scope), prefix = recordKey(scope);
    const facts: RecordsFacts = { registration: registration ? raw(registration.registration) : null,
      registration_revision: registration?.revision ?? null, scope, accepted: null, restore_source: null,
      operation_sources: [], local, usage: initialCounters().usage, receipt: null, cursor: null };
    const snapshot: FactsSnapshot = { facts, counters: initialCounters(), bindings: [] };
    read(tx, tx.objectStore('managed_records').get(prefix), (state: StateRow | undefined) => {
      snapshot.state = state; facts.accepted = state ? raw(state.state) : null;
      const restore = () => {
        const request = tx.objectStore('managed_operation_sources').index('by_operation').openCursor(IDBKeyRange.bound(prefix, [...prefix, []], false, true));
        let bytes = 0;
        read(tx, request, cursor => {
          if (cursor) {
            const row = cursor.value as BindingRow;
            bytes += boundedBytes(row.content, 1024 * 1024).byteLength;
            if (bytes > 16 * 1024 * 1024) throw failure('storage_corrupt');
            if (recordKey({ ...scope, record: row.record, generation: row.generation }).some((part, index) => part !== prefix[index]) ||
              components(row).some((part, index) => part !== components(collection)[index])) throw failure('storage_corrupt');
            snapshot.bindings.push(row); facts.operation_sources.push({ operation: row.operationId, update: row.updateId, content: raw(row.content) });
            cursor.continue(); return;
          }
          facts.operation_sources.sort((a, b) => a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : a.update < b.update ? -1 : a.update > b.update ? 1 : 0);
          read(tx, tx.objectStore('control').get(counterKey), row => {
            snapshot.counters = counters(row); facts.usage = structuredClone(snapshot.counters.usage);
            facts.usage.replaced_bytes = String((state?.state.byteLength ?? 0) + (state?.projection.byteLength ?? 0));
            host.common.readContext(tx, scope, cursor => { try { active(); facts.cursor = cursor; done(snapshot); } catch (error) { abort(error); } }, abort);
          }, abort);
        }, abort);
      };
      if (scope.restores === null) { restore(); return; }
      read(tx, tx.objectStore('managed_records').get([...prefix.slice(0, -1), scope.restores]), (prior: StateRow | undefined) => {
        facts.restore_source = prior ? raw(prior.state) : null; restore();
      }, abort);
    }, abort);
  }
  function appendChange(tx: IDBTransaction, scope: ManagedScope, operation: string, status: string, count: Counters): string {
    if (BigInt(count.usage.changes) >= 65536n || BigInt(count.sequence) >= 9223372036854775807n) throw failure('managed_change_capacity');
    count.sequence = String(BigInt(count.sequence) + 1n); changeCounter(count.usage, 'changes', 1n);
    tx.objectStore('managed_changes').add({ ...scopeKey(scope), record: scope.record, generation: scope.generation,
      operationId: operation, status, sequence: count.sequence, sequenceOrder: count.sequence.padStart(20, '0') });
    return count.sequence;
  }
  function installState(tx: IDBTransaction, scope: ManagedScope, snapshot: FactsSnapshot, plan: RecordsPlan): void {
    const state = plan.nextState(), projection = plan.projection();
    if (state === undefined && projection === undefined) return;
    if (state === undefined || projection === undefined) throw failure('invalid_managed_plan');
    boundedBytes(state, 1024 * 1024); boundedBytes(projection, 1024 * 1024);
    const before = snapshot.state ? snapshot.state.state.byteLength + snapshot.state.projection.byteLength : 0;
    changeCounter(snapshot.counters.usage, 'state_bytes', BigInt(state.byteLength + projection.byteLength - before));
    if (!snapshot.state) changeCounter(snapshot.counters.usage, 'records', 1n);
    tx.objectStore('managed_records').put({ ...scopeKey(scope), record: scope.record, generation: scope.generation, restores: scope.restores, state, projection });
  }
  function installBindings(tx: IDBTransaction, scope: ManagedScope, snapshot: FactsSnapshot, plan: RecordsPlan): void {
    const bindings = JSON.parse(raw(plan.operationBindings())) as Array<{ operation: string; update: string; content: string }>;
    if (!Array.isArray(bindings)) throw failure('invalid_managed_plan');
    for (const binding of bindings) {
      if (typeof binding.operation !== 'string' || typeof binding.update !== 'string' || typeof binding.content !== 'string') throw failure('invalid_managed_plan');
      const content = encoder.encode(binding.content);
      const old = snapshot.bindings.find(row => row.operationId === binding.operation && row.updateId === binding.update);
      if (old) { if (!sameBytes(old.content, content)) throw failure('immutable_source_conflict'); continue; }
      changeCounter(snapshot.counters.usage, 'operation_bytes', BigInt(content.byteLength));
      tx.objectStore('managed_operation_sources').add({ ...scopeKey(scope), record: scope.record, generation: scope.generation,
        restores: scope.restores, operationId: binding.operation, updateId: binding.update, content });
    }
  }

  async function register(key: ManagedCollectionKey, bytes: Uint8Array): Promise<ManagedCollectionHandle> {
    const registration = boundedBytes(bytes, 1024 * 1024); components(key);
    // Extract identifiers only; all schema semantics/field values remain Rust-owned bytes.
    const identity = JSON.parse(raw(registration));
    if (identity.realm !== key.realmId || identity.vault !== key.vaultId || identity.owner !== key.owner || identity.schema?.collection !== key.collection) throw failure('invalid_managed_identity');
    const revision = await transact<string>('readwrite', (tx, done, abort) => {
      read(tx, tx.objectStore('managed_collections').get(components(key)), (old: CollectionRow | undefined) => {
        sync(host.wasm.validateRecordsRegistration(registration, old?.registration));
        if (old && sameBytes(old.registration, registration)) { done(old.revision); return; }
        const cursor = tx.objectStore('managed_records').openCursor();
        read(tx, cursor, row => {
          if (row) {
            const state = row.value as StateRow;
            if (components(state).every((part, index) => part === components(key)[index])) sync(host.wasm.validateRecordsAccepted(registration, state.state));
            row.continue(); return;
          }
          read(tx, tx.objectStore('control').get(counterKey), retained => {
            const count = counters(retained);
            if (!old && BigInt(count.registrations) >= 128n) throw failure('managed_registration_capacity');
            if (!old) count.registrations = String(BigInt(count.registrations) + 1n);
            const revision = crypto.randomUUID();
            tx.objectStore('managed_collections').put({ ...key, registration, revision, retryAfter: old?.retryAfter ?? null });
            tx.objectStore('control').put(count); done(revision);
          }, abort);
        }, abort);
      }, abort);
    });
    active();
    const token: ManagedCollectionHandle = Object.freeze({ dispose() { handles.delete(token); } });
    handles.set(token, { key: structuredClone(key), revision }); return token;
  }

  async function apply(token: ManagedCollectionHandle, input: ManagedLocalInput): Promise<ManagedCommitOutcome> {
    const stable = structuredClone(input);
    stable.command = boundedBytes(stable.command, 4 * 1024 * 1024);
    stable.expectedRevision = boundedBytes(stable.expectedRevision, 32);
    // Exact authorized replay is checked before any accepted/restore/quota reads.
    // Preparation occurs inside the bounded synchronous tx callback; no await spans IDB.
    const result = await transact<ManagedCommitOutcome>('readwrite', (tx, done, abort) => {
      authorize(tx, token, registration => {
        if (components(registration).some((part, index) => part !== components(scopeKey(stable.scope))[index])) throw failure('invalid_managed_identity');
        const request = sync(host.wasm.canonicalRecordsLocalRequest(registration.registration, JSON.stringify(stable.scope), stable.operation, stable.expectedRevision, stable.command));
        read(tx, tx.objectStore('managed_local_operations').get([...components(registration), stable.operation]), (prior: LocalRow | undefined) => {
          if (prior) {
            if (!sameBytes(prior.request, request)) throw failure('managed_operation_collision');
            sync(host.wasm.validateRecordsStoredReplay(JSON.stringify(scopeKey(stable.scope)), stable.operation, prior.request, prior.result));
            done({ result: prior.result.slice(), replay: true, localDurable: true }); return;
          }
          readFacts(tx, stable.scope, registration, { operation: stable.operation, expected_revision: [...stable.expectedRevision], prior_request: null, prior_result: null }, snapshot => {
            const plan = sync(host.wasm.prepareRecordsLocal(JSON.stringify(snapshot.facts), stable.command));
            try {
              sync(plan.checkPreconditions(JSON.stringify(snapshot.facts)));
              const metadata = JSON.parse(plan.resultJson()) as { status: string; revision: number[] | null };
              if (metadata.status !== 'accepted' || !Array.isArray(metadata.revision) || metadata.revision.length !== 32) throw failure('invalid_managed_plan');
              if (!sameBytes(plan.localRequest()!, request)) throw failure('invalid_managed_plan');
              installState(tx, stable.scope, snapshot, plan); installBindings(tx, stable.scope, snapshot, plan);
              const sequence = appendChange(tx, stable.scope, stable.operation, 'accepted', snapshot.counters);
              const result = sync(host.wasm.finalizeRecordsLocalResult(stable.operation, new Uint8Array(metadata.revision), sequence));
              if (request.byteLength > 2 * 1024 * 1024 || result.byteLength > 2 * 1024 * 1024) throw failure('managed_replay_capacity');
              changeCounter(snapshot.counters.usage, 'local_operations', 1n);
              changeCounter(snapshot.counters.usage, 'local_bytes', BigInt(request.byteLength + result.byteLength));
              const payload = plan.payload(), payloadMetadata = plan.payloadMetadataJson();
              const finish = () => {
                tx.objectStore('managed_local_operations').add({ ...scopeKey(stable.scope), record:stable.scope.record,generation:stable.scope.generation,restores:stable.scope.restores,operationId: stable.operation, request, result,
                  updateId: payloadMetadata ? JSON.parse(payloadMetadata).key.update_id : null });
                tx.objectStore('control').put(snapshot.counters); done({ result, replay: false, localDurable: true });
              };
              if (payload !== undefined) {
                if (!payloadMetadata) throw failure('invalid_managed_plan');
                // Snapshot bytes before freeing the private Rust plan.
                sync(host.common.authored(tx, payloadMetadata, payload.slice(), finish, abort));
              } else { if (payloadMetadata !== undefined) throw failure('invalid_managed_plan'); finish(); }
            } finally { plan.free(); }
          }, abort);
        }, abort);
      }, abort);
    });
    // Revocation here is response loss AFTER possible durable commit, never rollback.
    active(); return result;
  }

  async function snapshot(token: ManagedCollectionHandle, scope: ManagedScope): Promise<{ state?: Uint8Array; projection?: Uint8Array; metadata: string; unresolved: Array<{updateId:string;status:string;revision:string}>; changesAfter:string }> {
    const result = await transact<{ state?: Uint8Array; projection?: Uint8Array; metadata: string; unresolved: Array<{updateId:string;status:string;revision:string}>; changesAfter:string }>('readonly', (tx, done, abort) => {
      authorize(tx, token, registration => {
        if (components(registration).some((part, index) => part !== components(scopeKey(scope))[index])) throw failure('invalid_managed_identity');
        read(tx, tx.objectStore('managed_records').get(recordKey(scope)), (row: StateRow | undefined) => {
          const plan = sync(host.wasm.recordsSnapshot(registration.registration, JSON.stringify(scope), row?.state));
          let state:Uint8Array|undefined,projection:Uint8Array|undefined,metadata:string;
          try { state=plan.nextState();projection=plan.projection();metadata=plan.resultJson(); } finally { plan.free(); }
          const unresolved:Array<{updateId:string;status:string;revision:string}>=[],prefix=components(registration);
          const request=tx.objectStore('managed_receipts').index('by_retry').openCursor(IDBKeyRange.bound(prefix,[...prefix,[]],false,true));
          read(tx,request,cursor=>{
            if(cursor){
              const receipt=head(cursor.value,registration);
              if(receipt.record===scope.record&&receipt.generation===scope.generation&&receipt.status!=='accepted')unresolved.push({updateId:receipt.updateId,status:receipt.status,revision:receipt.revision});
              cursor.continue();return;
            }
            read(tx,tx.objectStore('control').get(counterKey),retained=>done({state,projection,metadata,unresolved,changesAfter:counters(retained).sequence}),abort);
          },abort);
        }, abort);
      }, abort);
    });
    active(); return result;
  }

  interface Incoming {
    scope: ManagedScope; metadataJson: string; payload: Uint8Array; wire: Uint8Array; updateId: string;
    expected: FactsSnapshot; receipt?: ManagedReceiptHead; plan: RecordsPlan; delivery?: unknown; used: boolean; assertExtra?: () => void;
  }
  const prepared = new WeakMap<object, Incoming>();
  async function prepareReceive(update: AuthenticatedRecordsUpdate, delivery?: unknown, assertExtra?: () => void): Promise<{ dispose(): void }> {
    active(); assertExtra?.();
    const description = JSON.parse(sync(update.recordsReadSetJson())) as { scope: ManagedScope; operations: string[] };
    const scope = description.scope, key = scopeKey(scope), metadataJson = sync(update.metadataJson());
    const metadata = JSON.parse(metadataJson), updateId = metadata.key.update_id;
    const payload = boundedBytes(sync(update.exactPlaintext()), 1024 * 1024), wire = boundedBytes(sync(update.exactWire()), 1052720);
    const captured = await transact<{ expected: FactsSnapshot; receipt?: ManagedReceiptHead }>('readonly', (tx, done, abort) => {
      read(tx, tx.objectStore('managed_collections').get(components(key)), (registration: CollectionRow | undefined) => {
        readFacts(tx, scope, registration, null, expected => {
          read(tx, tx.objectStore('managed_receipts').get([key.realmId, key.vaultId, updateId]), (retained: ManagedReceiptHead | undefined) => {
            const receipt = retained ? head(retained, key) : undefined;
            expected.facts.receipt = receipt ? { status: receipt.status, revision: receipt.revision } : null;
            done({ expected, receipt });
          }, abort);
        }, abort);
      }, abort);
    }, assertExtra);
    active(); assertExtra?.();
    const plan = sync(update.prepareRecords(JSON.stringify(captured.expected.facts)));
    const incoming: Incoming = { scope: structuredClone(scope), metadataJson, payload, wire, updateId, ...captured,
      plan, delivery: structuredClone(delivery), used: false, assertExtra };
    const token = Object.freeze({ dispose() { const value = prepared.get(token); if (value) { prepared.delete(token); value.plan.free(); } } });
    prepared.set(token, incoming); return token;
  }
  function commitReceive(tx: IDBTransaction, token: { dispose(): void }, retry: boolean,
    done: (result: { duplicate: boolean; status: string; changed: boolean }) => void, abort: Abort): void {
    const value = prepared.get(token);
    if (!value || value.used) throw failure('invalid_managed_plan');
    value.assertExtra?.();
    if (value.assertExtra) transactionGuards.set(tx, () => { active(); value.assertExtra!(); });
    value.used = true;
    const { scope, plan } = value, key = scopeKey(scope);
    read(tx, tx.objectStore('managed_collections').get(components(key)), (registration: CollectionRow | undefined) => {
      readFacts(tx, scope, registration, null, actual => {
        read(tx, tx.objectStore('managed_receipts').get([key.realmId, key.vaultId, value.updateId]), (retained: ManagedReceiptHead | undefined) => {
          const receipt = retained ? head(retained, key) : undefined;
          actual.facts.receipt = receipt ? { status: receipt.status, revision: receipt.revision } : null;
          try { sync(plan.checkPreconditions(JSON.stringify(actual.facts))); } catch (error) { throw new BrowserVaultError('managed_snapshot_conflict', 'Managed facts changed before commit', { reason: String(error) }); }
          if (receipt && (receipt.record !== scope.record || receipt.generation !== scope.generation || receipt.restores !== scope.restores || receipt.payloadBytes !== String(value.payload.byteLength))) throw failure('storage_corrupt');
          host.common.received(tx, { metadataJson: value.metadataJson, payload: value.payload.slice(), wire: value.wire.slice(),
            delivery: retry ? undefined : value.delivery, assertActive: () => { active(); transactionGuards.get(tx)?.(); } }, common => {
            try {
              active();
              if (common.duplicate && !retry) {
                if (!receipt && !common.authored) throw failure('storage_corrupt');
                if (receipt) { done({ duplicate: true, status: receipt.status, changed: false }); return; }
                // Authored self echo additionally requires durable local ownership evidence.
                const request = tx.objectStore('managed_local_operations').openCursor();
                let owned = false;
                read(tx, request, cursor => {
                  if (cursor) {
                    const row = cursor.value as LocalRow;
                    if (row.realmId === key.realmId && row.vaultId === key.vaultId && row.updateId === value.updateId) owned = true;
                    cursor.continue(); return;
                  }
                  if (!owned) throw failure('storage_corrupt');
                  done({ duplicate: true, status: 'accepted', changed: false });
                }, abort); return;
              }
              if (retry && (!common.duplicate || common.authored || !receipt)) throw failure('storage_corrupt');
              if (!retry && receipt) throw failure('storage_corrupt');
              const result = JSON.parse(sync(plan.resultJson())) as { status: string; conflicting_updates: string[] };
              if (!Array.isArray(result.conflicting_updates)) throw failure('invalid_managed_plan');
              const conflicts = [...new Set(result.conflicting_updates)].filter(id => id !== value.updateId);
              let index = 0;
              const finishConflicts = () => {
                if (index < conflicts.length) {
                  const id = conflicts[index++];
                  read(tx, tx.objectStore('managed_receipts').get([key.realmId, key.vaultId, id]), (other: ManagedReceiptHead | undefined) => {
                    if (other && !['accepted', 'integrity_conflict'].includes(other.status)) {
                      const checked = head(other, key);
                      checked.status = 'integrity_conflict'; checked.revision = crypto.randomUUID();
                      tx.objectStore('managed_receipts').put(checked);
                      appendChange(tx, { ...scope, record: checked.record, generation: checked.generation }, id, checked.status, actual.counters);
                    }
                    finishConflicts();
                  }, abort); return;
                }
                installState(tx, scope, actual, plan); installBindings(tx, scope, actual, plan);
                if (!retry) {
                  changeCounter(actual.counters.usage, 'receipts', 1n);
                  changeCounter(actual.counters.usage, 'receipt_bytes', BigInt(value.payload.byteLength));
                }
                const changed = !receipt || receipt.status !== result.status;
                if (changed) {
                  tx.objectStore('managed_receipts').put({ ...key, record: scope.record, generation: scope.generation, restores: scope.restores,
                    updateId: value.updateId, payloadBytes: String(value.payload.byteLength), status: result.status, revision: crypto.randomUUID() });
                  appendChange(tx, scope, value.updateId, result.status, actual.counters);
                }
                tx.objectStore('control').put(actual.counters);
                done({ duplicate: !!receipt, status: result.status, changed: changed || conflicts.length > 0 });
              };
              finishConflicts();
            } catch (error) { abort(error); }
          }, abort);
        }, abort);
      }, abort);
    }, abort);
  }
  async function receive(update: AuthenticatedRecordsUpdate, delivery?: unknown) {
    // Exact immutable replay precedes any accepted-state decoding or fresh quotas.
    const metadataJson = sync(update.metadataJson()), metadata = JSON.parse(metadataJson);
    const description = JSON.parse(sync(update.recordsReadSetJson())) as { scope: ManagedScope };
    const payload = boundedBytes(sync(update.exactPlaintext()), 1024 * 1024), wire = boundedBytes(sync(update.exactWire()), 1052720);
    const duplicate = await transact<{ duplicate: true; status: string; changed: false } | null>('readwrite', (tx, done, abort) => {
      host.common.received(tx, { metadataJson, payload, wire, delivery: structuredClone(delivery), duplicateOnly: true }, common => {
        try {
          active();
          if (!common.duplicate) { done(null); return; }
          const key = scopeKey(description.scope);
          read(tx, tx.objectStore('managed_receipts').get([key.realmId, key.vaultId, metadata.key.update_id]), (retained: ManagedReceiptHead | undefined) => {
            if (retained) {
              const receipt = head(retained, key);
              if (receipt.record !== description.scope.record || receipt.generation !== description.scope.generation || receipt.restores !== description.scope.restores || receipt.payloadBytes !== String(payload.byteLength)) throw failure('storage_corrupt');
              done({ duplicate: true, status: receipt.status, changed: false }); return;
            }
            if (!common.authored) throw failure('storage_corrupt');
            let owned = false;
            const request = tx.objectStore('managed_local_operations').openCursor();
            read(tx, request, cursor => {
              if (cursor) {
                const row = cursor.value as LocalRow;
                if (row.realmId === key.realmId && row.vaultId === key.vaultId && row.updateId === metadata.key.update_id) owned = true;
                cursor.continue(); return;
              }
              if (!owned) throw failure('storage_corrupt');
              done({ duplicate: true, status: 'accepted', changed: false });
            }, abort);
          }, abort);
        } catch (error) { abort(error); }
      }, abort);
    });
    if (duplicate) { active(); return duplicate; }
    // The caller owns/frees its authenticated update. Every private plan is freed here.
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await prepareReceive(update, delivery);
      try {
        const result = await transact<{ duplicate: boolean; status: string; changed: boolean }>('readwrite',
          (tx, done, abort) => commitReceive(tx, token, false, done, abort));
        active(); return result;
      } catch (error) {
        if (!(error instanceof BrowserVaultError) || error.code !== 'managed_snapshot_conflict' || attempt === 2) throw error;
      } finally { token.dispose(); }
    }
    throw failure('managed_contention');
  }
  async function retryPage(token: ManagedCollectionHandle) {
    const session = host.common.retainedSession(), admitted = () => { active(); session.assertActive(); };
    admitted();
    const registration = await transact<CollectionRow>('readonly', (tx, done, abort) => authorize(tx, token, done, abort), admitted);
    const selected = await selectManagedRetryPage({ ...host, assertActive: admitted }, registration, registration.retryAfter, status => sync(host.wasm.recordsRetryEligible(status)));
    let examined = 0, changed = false, next: string | null = registration.retryAfter;
    for (const receipt of selected.heads) {
      active();
      // Open retained authenticated wire first; the one exact stored plaintext lookup
      // happens in the final CAS transaction via common.received.
      const update = await session.open(receipt);
      try {
        const plan = await prepareReceive(update, undefined, admitted);
        try {
          const result = await transact<{ duplicate: boolean; status: string; changed: boolean }>('readwrite', (tx, done, abort) => {
            authorize(tx, token, () => commitReceive(tx, plan, true, done, abort), abort);
          }, admitted);
          changed ||= result.changed; examined++; next = receipt.updateId;
        } finally { plan.dispose(); }
      } finally { update.free(); }
    }
    // Separate persisted progress may safely reexamine a receipt after a crash. It must
    // not overwrite a concurrent maintenance pass's continuation or registration repair.
    await transact<void>('readwrite', (tx, done, abort) => authorize(tx, token, current => {
      if (current.retryAfter !== registration.retryAfter) throw failure('managed_snapshot_conflict');
      tx.objectStore('managed_collections').put({ ...current, retryAfter: selected.exhausted ? null : next }); done(undefined);
    }, abort), admitted);
    admitted(); return { examined, inputBytes: selected.inputBytes, next: selected.exhausted ? null : next, exhausted: selected.exhausted, changed };
  }
  async function changes(token: ManagedCollectionHandle, after: string, limit = 64) {
    decimalU64(after);if(BigInt(after)>9223372036854775807n)throw failure('invalid_managed_page');
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw failure('invalid_managed_page');
    const result = await transact<Array<{ sequence: string; status: string; record: string; generation: string; operationId: string }>>('readonly', (tx, done, abort) => {
      authorize(tx, token, registration => {
        const prefix = components(registration), rows: Array<{ sequence: string; status: string; record: string; generation: string; operationId: string }> = [];
        const request = tx.objectStore('managed_changes').index('by_collection').openCursor(IDBKeyRange.bound([...prefix, after.padStart(20, '0')], [...prefix, []], true, true));
        read(tx, request, cursor => {
          if (!cursor || rows.length === limit) { done(rows); return; }
          const row = cursor.value;
          decimalU64(row.sequence);
          if (row.sequenceOrder !== row.sequence.padStart(20, '0')) throw failure('storage_corrupt');
          rows.push({ sequence: row.sequence, status: row.status, record: row.record, generation: row.generation, operationId: row.operationId }); cursor.continue();
        }, abort);
      }, abort);
    });
    active(); return result;
  }

  async function validate(): Promise<void> {
    await transact<void>('readonly', (tx, done, abort) => {
      const observed=initialCounters(),registrations=new Map<string,CollectionRow>(),states=new Map<string,StateRow>(),locals=new Map<string,LocalRow>(),receipts=new Map<string,ManagedReceiptHead>();
      const sources=new Map<string,{source:SourceRead;authored:boolean;scope:ManagedScope;operations:string[]}>(),bindings=new Set<string>();
      let lastSequence='0';
      const collectionId=(row:ManagedCollectionKey)=>JSON.stringify(components(row));
      const identityId=(row:SourceKey)=>JSON.stringify([row.realmId,row.vaultId,row.updateId]);
      const localId=(row:ManagedCollectionKey,operation:string)=>JSON.stringify([...components(row),operation]);
      const bindingId=(scope:ManagedScope,operation:string,update:string)=>JSON.stringify([...recordKey(scope),operation,update]);
      const rowScope=(row:ManagedCollectionKey&{record:string;generation:string;restores:string|null}):ManagedScope=>({realm:row.realmId,vault:row.vaultId,owner:row.owner,collection:row.collection,record:row.record,generation:row.generation,restores:row.restores});
      const scan=(store:ManagedStore,accept:(row:any,next:()=>void)=>void,next:()=>void)=>{
        const request=tx.objectStore(store).openCursor();
        read(tx,request,cursor=>{if(!cursor){next();return;}accept(cursor.value,()=>cursor.continue());},abort);
      };
      const source=(key:SourceKey,callback:(value:NonNullable<ReturnType<typeof sources.get>>)=>void)=>{
        const id=identityId(key),cached=sources.get(id);if(cached){callback(cached);return;}
        host.common.storedSource(tx,key,value=>{try{
          active();if(!value)throw failure('storage_corrupt');
          const description=JSON.parse(sync(host.wasm.recordsStoredReadSet(value.source.bytes))) as {scope:ManagedScope;operations:string[]};
          if(description.scope.realm!==key.realmId||description.scope.vault!==key.vaultId||!Array.isArray(description.operations))throw failure('storage_corrupt');
          const result={...value,...description};sources.set(id,result);callback(result);
        }catch(error){abort(error);}},abort);
      };
      const phases:Array<()=>void>=[
        ()=>scan('managed_collections',(row:CollectionRow,next)=>{
          components(row);boundedBytes(row.registration,1024*1024);
          if(typeof row.revision!=='string'||!row.revision||(row.retryAfter!==null&&(typeof row.retryAfter!=='string'||row.retryAfter.length>128)))throw failure('storage_corrupt');
          sync(host.wasm.validateRecordsRegistration(row.registration,undefined));
          const identity=JSON.parse(raw(row.registration));
          if(identity.realm!==row.realmId||identity.vault!==row.vaultId||identity.owner!==row.owner||identity.schema?.collection!==row.collection)throw failure('storage_corrupt');
          registrations.set(collectionId(row),row);observed.registrations=String(BigInt(observed.registrations)+1n);
          if(BigInt(observed.registrations)>128n)throw failure('storage_corrupt');next();
        },advance),
        ()=>scan('managed_records',(row:StateRow,next)=>{
          const registration=registrations.get(collectionId(row));if(!registration)throw failure('storage_corrupt');
          boundedBytes(row.state,1024*1024);boundedBytes(row.projection,1024*1024);
          const scope=rowScope(row),plan=sync(host.wasm.recordsSnapshot(registration.registration,JSON.stringify(scope),row.state));
          try{if(!sameBytes(plan.nextState()!,row.state)||!sameBytes(plan.projection()!,row.projection))throw failure('storage_corrupt');}finally{plan.free();}
          states.set(JSON.stringify(recordKey(scope)),row);changeCounter(observed.usage,'records',1n);changeCounter(observed.usage,'state_bytes',BigInt(row.state.byteLength+row.projection.byteLength));next();
        },advance),
        ()=>scan('managed_local_operations',(row:LocalRow,next)=>{
          if(!registrations.has(collectionId(row)))throw failure('storage_corrupt');
          boundedBytes(row.request,2*1024*1024);boundedBytes(row.result,2*1024*1024);
          sync(host.wasm.validateRecordsStoredReplay(JSON.stringify(scopeKey(rowScope(row))),row.operationId,row.request,row.result));
          locals.set(localId(row,row.operationId),row);changeCounter(observed.usage,'local_operations',1n);changeCounter(observed.usage,'local_bytes',BigInt(row.request.byteLength+row.result.byteLength));
          if(row.updateId===null){next();return;}
          source({realmId:row.realmId,vaultId:row.vaultId,updateId:row.updateId},retained=>{
            if(!retained.authored||!sameScope(retained.scope,rowScope(row))||!retained.operations.includes(row.operationId))throw failure('storage_corrupt');next();
          });
        },advance),
        ()=>scan('managed_receipts',(row:ManagedReceiptHead,next)=>{
          head(row,row);sync(host.wasm.recordsRetryEligible(row.status));receipts.set(identityId(row),row);
          changeCounter(observed.usage,'receipts',1n);changeCounter(observed.usage,'receipt_bytes',BigInt(row.payloadBytes));
          source(row,retained=>{
            if(retained.authored||String(retained.source.bytes.byteLength)!==row.payloadBytes||!sameScope(retained.scope,rowScope(row)))throw failure('storage_corrupt');next();
          });
        },advance),
        ()=>scan('managed_operation_sources',(row:BindingRow,next)=>{
          components(row);boundedBytes(row.content,1024*1024);const scope=rowScope(row);
          sync(host.wasm.validateRecordsStoredOperation(JSON.stringify(scope),row.operationId,row.updateId,row.content));
          changeCounter(observed.usage,'operation_bytes',BigInt(row.content.byteLength));bindings.add(bindingId(scope,row.operationId,row.updateId));
          const local=locals.get(localId(row,row.updateId));
          if(local&&local.updateId===null){
            const registration=registrations.get(collectionId(row)),accepted=states.get(JSON.stringify(recordKey(scope)));
            if(!registration||!accepted||!sameScope(rowScope(local),scope)||!sameScope(rowScope(accepted),scope)||local.operationId!==row.operationId)throw failure('storage_corrupt');
            sync(host.wasm.validateRecordsStoredBinding(JSON.stringify(scope),row.operationId,row.updateId,row.content,JSON.stringify({payload:null,registration:raw(registration.registration),accepted:raw(accepted.state)})));next();return;
          }
          source({realmId:row.realmId,vaultId:row.vaultId,updateId:row.updateId},retained=>{
            if(!sameScope(scope,retained.scope)||(retained.authored?!local||local.updateId!==row.updateId:!receipts.has(identityId(row))))throw failure('storage_corrupt');
            sync(host.wasm.validateRecordsStoredBinding(JSON.stringify(scope),row.operationId,row.updateId,row.content,JSON.stringify({payload:raw(retained.source.bytes),registration:null,accepted:null})));next();
          });
        },advance),
        ()=>scan('managed_changes',(row,next)=>{
          components(row);const sequence=decimalU64(row.sequence);
          if(sequence==='0'||row.sequenceOrder!==sequence.padStart(20,'0')||BigInt(sequence)>9223372036854775807n)throw failure('storage_corrupt');
          sync(host.wasm.recordsRetryEligible(row.status));if(BigInt(sequence)>BigInt(lastSequence))lastSequence=sequence;
          changeCounter(observed.usage,'changes',1n);next();
        },advance),
        ()=>{
          // Reverse source -> binding completeness, including sources with waiting status.
          for(const retained of sources.values())for(const operation of retained.operations){
            if(!bindings.has(bindingId(retained.scope,operation,retained.source.header.updateId)))throw failure('storage_corrupt');
          }
          for(const local of locals.values())if(!bindings.has(bindingId(rowScope(local),local.operationId,local.updateId??local.operationId)))throw failure('storage_corrupt');
          read(tx,tx.objectStore('control').get(counterKey),retained=>{
            const expected=counters(retained);observed.sequence=lastSequence;
            if(observed.sequence!==expected.sequence||observed.registrations!==expected.registrations||(Object.keys(observed.usage) as (keyof Usage)[]).some(key=>observed.usage[key]!==expected.usage[key]))throw failure('storage_corrupt');
            done(undefined);
          },abort);
        },
      ];
      let phase=0;function advance(){phases[phase++]();}advance();
    });
    active();
  }

  return { register, apply, snapshot, prepareReceive, commitReceive, receive, retryPage, changes, validate };


}
