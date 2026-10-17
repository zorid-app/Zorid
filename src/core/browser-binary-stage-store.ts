import { BrowserVaultError } from './browser-vault.ts';
import { normalizedTransact, decimalU64, decimalOrder, nextDecimalU64, addImmutableSource, getExactSource, addImmutableMetadata, putNormalizedMetadata, boundedMetadataPage } from './browser-normalized-idb.ts';
import type { Abort, MetadataValue, SourceHeader, SourceInput } from './browser-normalized-idb.ts';
import { BINARY_CHUNK_BYTES } from './binary-streams.ts';
import type { BinaryStageRef, BinaryStageRequest, BinaryStageStatus, BinaryChunkInput, BinaryChunkReceipt, BinarySealInput, BinarySealedStatus } from './binary-streams.ts';

export const BINARY_STAGE_USAGE_KEY = 'binary-stream-usage:v1';
/** Initialized by the parent ONLY when creating the fresh local format. All staged,
 * authored and received exact plaintext sources share these counters; no GC here. */
export interface BrowserBinaryUsage {
  version: 1; stages: number; activeStages: number; sourcePayloadBytes: string; chunkRecords: number; pageRecords: number;
}
export interface BrowserBinaryStageLimits {
  maxFileBytes: string; maxChunkBytes: number; maxPayloadBytes: number;
  maxStages: number; maxActiveStages: number; maxSourceBytes: string; maxChunkRecords: number; maxPageRecords: number;
}
export interface StageWasmRecord { descriptorJson(): string; payloadBytes(): Uint8Array; chunkBytes(): Uint8Array | undefined; free(): void }
export interface StageWasmBuiltManifest { manifestJson(): string; free(): void }
export interface StageWasmBatch { pushRecord(record: StageWasmRecord): string; pushPayload(payload: Uint8Array): string; free(): void }
export interface StageWasmBuilder {
  pushChunk(id: string, bytes: Uint8Array): StageWasmRecord;
  flushPage(id: string): StageWasmRecord;
  restoreChunkPayload(id: string, payload: Uint8Array): StageWasmRecord;
  restorePagePayload(id: string, payload: Uint8Array): StageWasmRecord;
  statusJson(): string; finish(): StageWasmBuiltManifest; free(): void;
}
export interface BrowserBinaryStageWasm {
  WasmBinaryBuilder: new(scopeJson: string) => StageWasmBuilder;
  WasmAuthoredMetadataBatch: new(scopeJson: string) => StageWasmBatch;
}
export interface BrowserBinaryStageStoreOptions {
  db: IDBDatabase; authorityId: string; scope: { realmId: string; vaultId: string }; clientId: string;
  assertActive(): void; limits: Readonly<BrowserBinaryStageLimits>; wasm: BrowserBinaryStageWasm; allocateId(): string;
}
export interface BrowserStageSourceRef {
  clientId: string; stageId: string; sequenceOrder: string; kind: 'chunk' | 'page'; header: SourceHeader; chunk: BinaryChunkReceipt | null;
}
interface StageRow {
  version: 1; authorityId: string; realmId: string; vaultId: string; clientId: string; stageId: string; operationId: string;
  request: BinaryStageRequest; phase: BinaryStageStatus['phase']; generation: string; acceptedLength: string;
  nextSequence: number; emissionCount: number; sealRequested: BinarySealInput | null;
  finalized: (BinarySealedStatus & { manifest: MetadataValue }) | null; outcome?: BinaryStageStatus['outcome'];
}
interface Cache { row: StageRow; builder?: StageWasmBuilder; batch: StageWasmBatch; built?: StageWasmBuiltManifest; sources: BrowserStageSourceRef[] }
/** Owning handles, NOT durable-content proofs or commit authorization. Parent must persist
 * commit_requested first and recheck exact stage/source pins and current metadata in its
 * final transaction. Parent owns/free()s moved handles on every outcome. */
export interface BrowserSealedStage {
  ref: BinaryStageRef; request: BinaryStageRequest; stageGeneration: string; sourceRefs: BrowserStageSourceRef[];
  built: StageWasmBuiltManifest; batch: StageWasmBatch;
}
export interface BrowserBinaryStageStore {
  begin(request: BinaryStageRequest): Promise<BinaryStageRef>;
  append(ref: BinaryStageRef, input: BinaryChunkInput): Promise<BinaryChunkReceipt>;
  query(ref: BinaryStageRef): Promise<BinaryStageStatus>;
  seal(ref: BinaryStageRef, input: BinarySealInput): Promise<BinarySealedStatus>;
  abort(ref: BinaryStageRef): Promise<void>;
  takeSealed(ref: BinaryStageRef): Promise<BrowserSealedStage>;
  /** Retire in-memory handles only. Durable stages and immutable sources remain. */
  dispose(): void;
}
const fail = (code: string) => new BrowserVaultError(code, 'Browser binary staging did not complete; retain its original owner and operation');
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};
const keys = (value: unknown, required: readonly string[], optional: readonly string[] = []): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const ident = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value: unknown): string => {
  if (!Array.isArray(value) || value.length !== 32 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw fail('storage_corrupt');
  return value.map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const json = (value: unknown) => JSON.stringify(value);
const clone = <T>(value: T): T => structuredClone(value);
const sourceStores = ['sync_source_headers', 'sync_source_payloads', 'sync_source_wires'] as const;
const stageStores = ['binary_stages', 'binary_stage_chunks', ...sourceStores] as const;
const safeFree = (handle: { free(): void } | undefined) => { try { handle?.free(); } catch { /* Do not replace the durable operation's failure. */ } };

export function createBrowserBinaryStageStore(options: BrowserBinaryStageStoreOptions): BrowserBinaryStageStore {
  const { db, authorityId, clientId, wasm } = options, scope = clone(options.scope), limits = clone(options.limits);
  if (!ident(authorityId) || !ident(clientId) || !scope || !ident(scope.realmId) || !ident(scope.vaultId) ||
    typeof options.assertActive !== 'function' || typeof options.allocateId !== 'function') throw fail('invalid_binary_owner');
  if (limits.maxChunkBytes !== BINARY_CHUNK_BYTES || !Number.isInteger(limits.maxPayloadBytes) || limits.maxPayloadBytes < 1 || limits.maxPayloadBytes > 1048576 ||
    BigInt(decimalU64(limits.maxFileBytes)) > 67108864n || BigInt(decimalU64(limits.maxSourceBytes)) > 536870912n ||
    !Number.isInteger(limits.maxStages) || limits.maxStages < 1 || limits.maxStages > 4096 ||
    !Number.isInteger(limits.maxActiveStages) || limits.maxActiveStages < 1 || limits.maxActiveStages > 8 ||
    !Number.isInteger(limits.maxChunkRecords) || limits.maxChunkRecords < 1 || limits.maxChunkRecords > 4096 ||
    !Number.isInteger(limits.maxPageRecords) || limits.maxPageRecords < 1 || limits.maxPageRecords > 256) throw fail('invalid_binary_limits');
  if (typeof wasm?.WasmBinaryBuilder !== 'function' || typeof wasm.WasmAuthoredMetadataBatch !== 'function') throw fail('stream_bindings_unavailable');
  const scopeJson = json({ realm_id: scope.realmId, vault_id: scope.vaultId });
  const cache = new Map<string, Cache>(), tails = new Map<string, Promise<unknown>>();
  let retired = false;
  const active = () => { if (retired) throw fail('client_ownership_lost'); options.assertActive(); };
  function request(input: BinaryStageRequest): BinaryStageRequest {
    const value = clone(input);
    if (!keys(value, ['operationId', 'target'], ['expectedLength']) || !ident(value.operationId) || !value.target || !ident(value.target.entryId)) throw fail('invalid_binary_request');
    if (value.target.kind === 'create') {
      if (!keys(value.target, ['kind', 'entryId', 'path']) || typeof value.target.path !== 'string' || !value.target.path || new TextEncoder().encode(value.target.path).length > 4096) throw fail('invalid_binary_request');
    } else if (!keys(value.target, ['kind', 'entryId', 'expectedRevision', 'expectedContentEvent']) || value.target.kind !== 'write' || !ident(value.target.expectedRevision) || !ident(value.target.expectedContentEvent)) throw fail('invalid_binary_request');
    if (value.expectedLength !== undefined && BigInt(decimalU64(value.expectedLength)) > BigInt(limits.maxFileBytes)) throw fail('too_large');
    return value;
  }
  const refOf = (row: StageRow): BinaryStageRef => ({ localStoreId: authorityId, clientId, operationId: row.operationId, stageId: row.stageId });
  function owner(value: BinaryStageRef): BinaryStageRef {
    const ref = clone(value);
    if (!ref || ref.localStoreId !== authorityId || ref.clientId !== clientId || !ident(ref.operationId) || !ident(ref.stageId)) throw fail('binary_owner_mismatch');
    return ref;
  }
  function row(value: unknown, ref?: BinaryStageRef): StageRow {
    const result = value as StageRow;
    if (!keys(result, ['version', 'authorityId', 'realmId', 'vaultId', 'clientId', 'stageId', 'operationId', 'request', 'phase', 'generation', 'acceptedLength', 'nextSequence', 'emissionCount', 'sealRequested', 'finalized'], ['outcome']) || result.version !== 1 || result.authorityId !== authorityId || result.realmId !== scope.realmId || result.vaultId !== scope.vaultId ||
      result.clientId !== clientId || !ident(result.stageId) || !ident(result.operationId) ||
      !['receiving', 'sealed', 'commit_requested', 'committed', 'rejected', 'aborted'].includes(result.phase) ||
      !Number.isInteger(result.nextSequence) || result.nextSequence < 0 || result.nextSequence > 512 ||
      !Number.isInteger(result.emissionCount) || result.emissionCount < result.nextSequence || result.emissionCount > 516 ||
      BigInt(decimalU64(result.acceptedLength)) > BigInt(limits.maxFileBytes)) throw fail('storage_corrupt');
    decimalU64(result.generation);
    if (!same(request(result.request), result.request) || result.request.operationId !== result.operationId) throw fail('storage_corrupt');
    if (result.request.expectedLength !== undefined && BigInt(result.acceptedLength) > BigInt(result.request.expectedLength)) throw fail('storage_corrupt');
    if (ref && (ref.stageId !== result.stageId || ref.operationId !== result.operationId)) throw fail('binary_owner_mismatch');
    if (result.sealRequested !== null) sealInput(result.sealRequested);
    if (result.finalized !== null) {
      if (!keys(result.finalized, ['length', 'sha256', 'manifest']) || result.finalized.length !== result.acceptedLength || !/^[0-9a-f]{64}$/.test(result.finalized.sha256) || !result.finalized.manifest || !result.sealRequested) throw fail('storage_corrupt');
    }
    if (['sealed', 'commit_requested', 'committed'].includes(result.phase) && !result.finalized) throw fail('storage_corrupt');
    return result;
  }
  function usage(value: unknown): BrowserBinaryUsage {
    const result = value as BrowserBinaryUsage;
    if (!result || result.version !== 1 || !Number.isInteger(result.stages) || result.stages < 0 || result.stages > 4096 ||
      !Number.isInteger(result.activeStages) || result.activeStages < 0 || result.activeStages > 8 || result.activeStages > result.stages ||
      !Number.isInteger(result.chunkRecords) || result.chunkRecords < 0 || result.chunkRecords > 4096 ||
      !Number.isInteger(result.pageRecords) || result.pageRecords < 0 || result.pageRecords > 256 ||
      BigInt(decimalU64(result.sourcePayloadBytes)) > 536870912n) throw fail('binary_usage_unavailable');
    return result;
  }
  function sealInput(input: BinarySealInput): BinarySealInput {
    const value = clone(input);
    if (!keys(value, ['finalLength'], ['expectedDigest']) || BigInt(decimalU64(value.finalLength)) > BigInt(limits.maxFileBytes) ||
      (value.expectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(value.expectedDigest))) throw fail('invalid_binary_seal');
    return value;
  }
  function on<T>(tx: IDBTransaction, read: IDBRequest<T>, fn: (value: T) => void, abort: Abort): void {
    read.onsuccess = () => { try { active(); fn(read.result); } catch (error) { abort(error); } };
  }
  const transact = <T>(mode: IDBTransactionMode, names: readonly string[], start: (tx: IDBTransaction, done: (value: T) => void, abort: Abort) => void) =>
    normalizedTransact<T>(db, { authorityId, stores: names, mode, assertActive: active }, start);
  function stageRead<T>(ref: BinaryStageRef, mode: IDBTransactionMode, names: readonly string[], fn: (tx: IDBTransaction, stage: StageRow, done: (value: T) => void, abort: Abort) => void): Promise<T> {
    return transact<T>(mode, names, (tx, done, abort) => on(tx, tx.objectStore('binary_stages').get([clientId, ref.stageId]), value => {
      if (value === undefined) throw fail('binary_stage_not_found'); fn(tx, row(value, ref), done, abort);
    }, abort));
  }
  function serial<T>(ref: BinaryStageRef, run: (owned: BinaryStageRef) => Promise<T>): Promise<T> {
    let captured: BinaryStageRef;
    try { active(); captured = owner(ref); } catch (error) { return Promise.reject(error); }
    const key = captured.stageId, previous = tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => { active(); return run(captured); });
    tails.set(key, result); void result.finally(() => { if (tails.get(key) === result) tails.delete(key); }).catch(() => {});
    return result;
  }
  function discard(id: string): void {
    const current = cache.get(id); cache.delete(id);
    if (current) { safeFree(current.builder); safeFree(current.built); safeFree(current.batch); }
  }
  function fresh(stage: StageRow): Cache {
    const builder = new wasm.WasmBinaryBuilder(scopeJson);
    if (typeof builder.restoreChunkPayload !== 'function' || typeof builder.restorePagePayload !== 'function') { safeFree(builder); throw fail('stream_bindings_unavailable'); }
    try { return { row: clone(stage), builder, batch: new wasm.WasmAuthoredMetadataBatch(scopeJson), sources: [] }; }
    catch (error) { safeFree(builder); throw error; }
  }
  function stateOf(builder: StageWasmBuilder): { accepted_length: string; pending_chunks: number } {
    const state = JSON.parse(builder.statusJson());
    decimalU64(state.accepted_length);
    if (!Number.isInteger(state.pending_chunks) || state.pending_chunks < 0 || state.pending_chunks > 128) throw fail('invalid_wasm_result');
    return state;
  }
  // Shared immutable source shape: staging, authored outbox and received ingress all
  // bind the same exact plaintext commitments without changing descriptor on promotion.
  function sourceDescriptor(raw: any): MetadataValue {
    return { version: 1, metadata: { key: { realm_id: scope.realmId, vault_id: scope.vaultId, update_id: raw.update_id },
      family: 'files', format_version: 2, payload_digest: raw.record.payload_digest, payload_bytes: raw.record.payload_bytes, text_binding: null },
      record: raw.record, activity: null, summary_digest: raw.summary_digest };
  }
  function emission(stage: StageRow, ordinal: number, kind: 'chunk' | 'page', record: StageWasmRecord, chunk: BinaryChunkReceipt | null): { ref: BrowserStageSourceRef; payload: Uint8Array } {
    const descriptor = JSON.parse(record.descriptorJson()), payload = record.payloadBytes();
    if (!ident(descriptor.update_id) || !same(descriptor.scope, { realm_id: scope.realmId, vault_id: scope.vaultId }) ||
      descriptor.record?.body?.kind !== kind || !(payload instanceof Uint8Array) || payload.length < 1 || payload.length > limits.maxPayloadBytes || descriptor.record.payload_bytes !== payload.length) throw fail('invalid_wasm_result');
    digest(descriptor.record.payload_digest); digest(descriptor.summary_digest);
    return { ref: { clientId, stageId: stage.stageId, sequenceOrder: decimalOrder(String(ordinal)), kind,
      header: { realmId: scope.realmId, vaultId: scope.vaultId, updateId: descriptor.update_id, descriptor: sourceDescriptor(descriptor) }, chunk }, payload };
  }
  function verifySource(source: SourceInput): void {
    if (!source.payload || source.wire !== undefined) throw fail('storage_corrupt');
    const batch = new wasm.WasmAuthoredMetadataBatch(scopeJson);
    try {
      const checked = JSON.parse(batch.pushPayload(source.payload)), descriptor = source.header.descriptor as any;
      if (!same(checked.scope, { realm_id: scope.realmId, vault_id: scope.vaultId }) || checked.update_id !== source.header.updateId ||
        !same(sourceDescriptor(checked), descriptor)) throw fail('storage_corrupt');
    } finally { safeFree(batch); }
  }
  function sourceRef(value: unknown, stage: StageRow, ordinal: number): BrowserStageSourceRef {
    const result = value as BrowserStageSourceRef;
    if (!result || result.clientId !== clientId || result.stageId !== stage.stageId || result.sequenceOrder !== decimalOrder(String(ordinal)) ||
      !['chunk', 'page'].includes(result.kind) || result.header?.realmId !== scope.realmId || result.header?.vaultId !== scope.vaultId || !ident(result.header?.updateId) ||
      (result.kind === 'chunk' ? !result.chunk : result.chunk !== null)) throw fail('storage_corrupt');
    return result;
  }
  async function allocations(stage: StageRow): Promise<BrowserStageSourceRef[]> {
    const result: BrowserStageSourceRef[] = []; let lower: IDBValidKey = [clientId, stage.stageId, '']; let open = false;
    for (;;) {
      const page = await transact('readonly', ['binary_stage_chunks'], (tx, done, abort) => boundedMetadataPage(tx, 'binary_stage_chunks', {
        range: IDBKeyRange.bound(lower, [clientId, stage.stageId, '\uffff'], open, false), limit: 32, maxBytes: 128 * 1024,
      }, done, abort));
      const typed = page as import('./browser-normalized-idb.ts').MetadataPage;
      for (const item of typed.items) result.push(sourceRef(item, stage, result.length));
      if (result.length > stage.emissionCount) throw fail('storage_corrupt');
      if (typed.complete) break;
      if (!typed.lastKey) throw fail('storage_corrupt'); lower = typed.lastKey; open = true;
    }
    if (result.length !== stage.emissionCount) throw fail('storage_corrupt'); return result;
  }
  const payloadOf = (header: SourceHeader) => transact('readonly', sourceStores, (tx, done, abort) => getExactSource(tx, header, 'payload', done, abort)) as Promise<import('./browser-normalized-idb.ts').SourceRead | null>;
  async function rebuild(stage: StageRow): Promise<Cache> {
    discard(stage.stageId); const current = fresh(stage);
    try {
      const refs = await allocations(stage); let sequence = 0, length = 0n;
      for (const saved of refs) {
        active(); const source = await payloadOf(saved.header); active();
        if (!source || !same(source.header, saved.header)) throw fail('storage_corrupt');
        const record = saved.kind === 'chunk' ? current.builder!.restoreChunkPayload(saved.header.updateId, source.bytes) : current.builder!.restorePagePayload(saved.header.updateId, source.bytes);
        try {
          const derived = emission(stage, current.sources.length, saved.kind, record, saved.chunk);
          if (!same(derived.ref, saved) || !equalBytes(derived.payload, source.bytes)) throw fail('storage_corrupt');
          if (saved.kind === 'chunk') {
            const body = (saved.header.descriptor as any).record.body, receipt = saved.chunk!;
            length += BigInt(body.bytes);
            if (receipt.sequence !== sequence++ || receipt.offset !== String(length - BigInt(body.bytes)) || receipt.bytes !== body.bytes || receipt.acceptedLength !== String(length) || receipt.digest !== digest(body.digest)) throw fail('storage_corrupt');
          }
          current.batch.pushRecord(record); current.sources.push(saved);
        } finally { safeFree(record); }
      }
      const status = stateOf(current.builder!);
      if (sequence !== stage.nextSequence || String(length) !== stage.acceptedLength || status.accepted_length !== stage.acceptedLength) throw fail('storage_corrupt');
      active(); cache.set(stage.stageId, current); return current;
    } catch (error) { safeFree(current.builder); safeFree(current.batch); throw error; }
  }
  async function currentCache(stage: StageRow): Promise<Cache> {
    const previous = cache.get(stage.stageId);
    if (previous && same(previous.row, stage) && previous.builder) return previous;
    return rebuild(stage);
  }
  function saveUsage(tx: IDBTransaction, value: BrowserBinaryUsage): void { tx.objectStore('control').put({ key: BINARY_STAGE_USAGE_KEY, value }); }
  function withUsage<T>(tx: IDBTransaction, fn: (value: BrowserBinaryUsage) => void, abort: Abort): void {
    on(tx, tx.objectStore('control').get(BINARY_STAGE_USAGE_KEY), value => fn(usage(value?.value)), abort);
  }
  function persist(stage: StageRow, next: StageRow, emissions: { ref: BrowserStageSourceRef; payload: Uint8Array }[], pins: readonly BrowserStageSourceRef[] = []): Promise<void> {
    return stageRead<void>(refOf(stage), 'readwrite', stageStores, (tx, actual, done, abort) => {
      if (!same(actual, stage)) throw fail('binary_stage_changed');
      withUsage(tx, counters => {
        const bytes = emissions.reduce((sum, item) => sum + BigInt(item.payload.length), 0n), chunks = emissions.filter(item => item.ref.kind === 'chunk').length, pages = emissions.length - chunks;
        if (BigInt(counters.sourcePayloadBytes) + bytes > BigInt(limits.maxSourceBytes) || counters.chunkRecords + chunks > limits.maxChunkRecords || counters.pageRecords + pages > limits.maxPageRecords) throw fail('binary_quota_exceeded');
        const write = (index: number): void => {
          if (index === emissions.length) {
            saveUsage(tx, { ...counters, sourcePayloadBytes: String(BigInt(counters.sourcePayloadBytes) + bytes), chunkRecords: counters.chunkRecords + chunks, pageRecords: counters.pageRecords + pages });
            putNormalizedMetadata(tx, 'binary_stages', next as unknown as MetadataValue, () => done(), abort); return;
          }
          const item = emissions[index], key = [scope.realmId, scope.vaultId, item.ref.header.updateId];
          on(tx, tx.objectStore('sync_source_headers').get(key), existing => {
            if (existing !== undefined) throw fail('binary_allocation_conflict');
            addImmutableSource(tx, { header: item.ref.header, payload: item.payload }, verifySource, inserted => {
              if (!inserted) { abort(fail('binary_allocation_conflict')); return; }
              addImmutableMetadata(tx, 'binary_stage_chunks', item.ref as unknown as MetadataValue, insertedRow => {
                if (!insertedRow) { abort(fail('storage_corrupt')); return; } write(index + 1);
              }, abort);
            }, abort);
          }, abort);
        };
        let pinIndex = 0;
        const checkPins = (): void => {
          if (pinIndex === pins.length) { write(0); return; }
          const header = pins[pinIndex++].header, key = [header.realmId, header.vaultId, header.updateId];
          on(tx, tx.objectStore('sync_source_headers').get(key), actualHeader => {
            if (!same(actualHeader, header)) throw fail('storage_corrupt');
            on(tx, tx.objectStore('sync_source_payloads').getKey(key), actualKey => { if (actualKey === undefined) throw fail('storage_corrupt'); checkPins(); }, abort);
          }, abort);
        }; checkPins();
      }, abort);
    });
  }
  function allocate(): string { const id = options.allocateId(); if (!ident(id)) throw fail('invalid_binary_allocation'); return id; }
  const status = (stage: StageRow): BinaryStageStatus => ({ ref: refOf(stage), phase: stage.phase, acceptedLength: stage.acceptedLength,
    nextSequence: stage.nextSequence, ...(stage.finalized ? { finalized: { length: stage.finalized.length, sha256: stage.finalized.sha256 } } : {}), ...(stage.outcome ? { outcome: clone(stage.outcome) } : {}) });
  return {
    async begin(input) {
      active(); const captured = request(input), stageId = allocate();
      return transact<BinaryStageRef>('readwrite', ['binary_stages'], (tx, done, abort) => {
        on(tx, tx.objectStore('binary_stages').index('by_operation').get([clientId, captured.operationId]), existing => {
          if (existing !== undefined) { const original = row(existing); if (!same(original.request, captured)) throw fail('binary_operation_conflict'); done(refOf(original)); return; }
          withUsage(tx, counters => {
            if (counters.stages >= limits.maxStages || counters.activeStages >= limits.maxActiveStages) throw fail('binary_quota_exceeded');
            const created: StageRow = { version: 1, authorityId, ...scope, clientId, stageId, operationId: captured.operationId, request: captured,
              phase: 'receiving', generation: '0', acceptedLength: '0', nextSequence: 0, emissionCount: 0, sealRequested: null, finalized: null };
            addImmutableMetadata(tx, 'binary_stages', created as unknown as MetadataValue, inserted => {
              if (!inserted) { abort(fail('binary_allocation_conflict')); return; }
              saveUsage(tx, { ...counters, stages: counters.stages + 1, activeStages: counters.activeStages + 1 }); done(refOf(created));
            }, abort);
          }, abort);
        }, abort);
      });
    },
    append(ref, input) {
      let captured: BinaryChunkInput;
      try {
        if (!input || !Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 511 || !(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > limits.maxChunkBytes) throw fail('invalid_binary_chunk');
        captured = { sequence: input.sequence, offset: decimalU64(input.offset), bytes: input.bytes.slice() };
      } catch (error) { return Promise.reject(error); }
      return serial(ref, async owned => {
        try {
          const stage = await stageRead<StageRow>(owned, 'readonly', ['binary_stages'], (_tx, stage, done) => done(stage));
          if (stage.phase !== 'receiving' || stage.sealRequested) throw fail('binary_stage_not_receiving');
          if (captured.sequence < stage.nextSequence) {
            const ordinal = captured.sequence + Math.floor(captured.sequence / 128);
            const saved = await transact('readonly', ['binary_stage_chunks'], (tx, done, abort) => on(tx, tx.objectStore('binary_stage_chunks').get([clientId, stage.stageId, decimalOrder(String(ordinal))]), value => done(sourceRef(value, stage, ordinal)), abort)) as BrowserStageSourceRef;
            if (saved.kind !== 'chunk' || saved.chunk!.offset !== captured.offset || saved.chunk!.bytes !== captured.bytes.length) throw fail('binary_chunk_conflict');
            const exact = await payloadOf(saved.header); if (!exact || !same(exact.header, saved.header)) throw fail('storage_corrupt');
            // Bounded one-chunk encoding comparison, not a whole-stage replay or JS hash proof.
            const scratch = new wasm.WasmBinaryBuilder(scopeJson); let record: StageWasmRecord | undefined;
            try {
              record = scratch.pushChunk(saved.header.updateId, captured.bytes);
              const descriptor = JSON.parse(record.descriptorJson());
              if (!equalBytes(record.payloadBytes(), exact.bytes) || !same(sourceDescriptor(descriptor), saved.header.descriptor)) throw fail('binary_chunk_conflict');
              const expected: BinaryChunkReceipt = { sequence: captured.sequence, offset: captured.offset, bytes: captured.bytes.length,
                digest: digest(descriptor.record.body.digest), acceptedLength: String(BigInt(captured.offset) + BigInt(captured.bytes.length)) };
              if (!same(saved.chunk, expected)) throw fail('storage_corrupt');
            }
            finally { safeFree(record); safeFree(scratch); }
            active(); return clone(saved.chunk!);
          }
          if (captured.sequence !== stage.nextSequence || captured.offset !== stage.acceptedLength) throw fail('binary_chunk_conflict');
          const nextLength = BigInt(stage.acceptedLength) + BigInt(captured.bytes.length);
          if (nextLength > BigInt(limits.maxFileBytes) || stage.request.expectedLength !== undefined && nextLength > BigInt(stage.request.expectedLength)) throw fail('too_large');
          if (stage.request.expectedLength !== undefined && captured.bytes.length < limits.maxChunkBytes && nextLength !== BigInt(stage.request.expectedLength)) throw fail('invalid_binary_chunk');
          const current = await currentCache(stage); active(); const output: { ref: BrowserStageSourceRef; payload: Uint8Array }[] = [];
          const record = current.builder!.pushChunk(allocate(), captured.bytes);
          let receipt: BinaryChunkReceipt;
          try {
            const descriptor = JSON.parse(record.descriptorJson()), body = descriptor.record.body;
            receipt = { sequence: captured.sequence, offset: captured.offset, bytes: captured.bytes.length, digest: digest(body.digest), acceptedLength: String(nextLength) };
            output.push(emission(stage, stage.emissionCount, 'chunk', record, receipt)); current.batch.pushRecord(record);
          } finally { safeFree(record); }
          if (stateOf(current.builder!).pending_chunks === 128) {
            const page = current.builder!.flushPage(allocate());
            try { output.push(emission(stage, stage.emissionCount + output.length, 'page', page, null)); current.batch.pushRecord(page); } finally { safeFree(page); }
          }
          const next: StageRow = { ...stage, generation: nextDecimalU64(stage.generation), acceptedLength: String(nextLength), nextSequence: stage.nextSequence + 1, emissionCount: stage.emissionCount + output.length };
          await persist(stage, next, output, current.sources); current.row = clone(next); current.sources.push(...output.map(item => clone(item.ref))); active(); return receipt;
        } catch (error) { discard(owned.stageId); throw error; }
      });
    },
    query(ref) { return serial(ref, owned => stageRead<BinaryStageStatus>(owned, 'readonly', ['binary_stages'], (_tx, stage, done) => done(status(stage)))); },
    seal(ref, input) {
      let captured: BinarySealInput; try { captured = sealInput(input); } catch (error) { return Promise.reject(error); }
      return serial(ref, async owned => {
        try {
          let stage = await stageRead<StageRow>(owned, 'readwrite', ['binary_stages'], (tx, original, done, abort) => {
            if (original.sealRequested && !same(original.sealRequested, captured)) throw fail('binary_seal_conflict');
            if (original.finalized && ['sealed', 'commit_requested', 'committed'].includes(original.phase)) { done(original); return; }
            if (original.phase !== 'receiving' || captured.finalLength !== original.acceptedLength || original.request.expectedLength !== undefined && original.request.expectedLength !== captured.finalLength) throw fail('invalid_binary_seal');
            if (original.sealRequested) { done(original); return; }
            const next = { ...original, generation: nextDecimalU64(original.generation), sealRequested: captured };
            putNormalizedMetadata(tx, 'binary_stages', next as unknown as MetadataValue, () => done(next), abort);
          });
          if (stage.finalized) return { length: stage.finalized.length, sha256: stage.finalized.sha256 };
          // Seal hashes actual immutable durable sources, never the append cache alone.
          const current = await rebuild(stage), output: { ref: BrowserStageSourceRef; payload: Uint8Array }[] = []; active();
          if (stateOf(current.builder!).pending_chunks) {
            const page = current.builder!.flushPage(allocate());
            try { output.push(emission(stage, stage.emissionCount, 'page', page, null)); current.batch.pushRecord(page); } finally { safeFree(page); }
          }
          const builder = current.builder!; current.builder = undefined; const built = builder.finish(); current.built = built;
          const manifest = JSON.parse(built.manifestJson()), sha256 = digest(manifest.digest);
          if (manifest.bytes !== captured.finalLength || captured.expectedDigest !== undefined && captured.expectedDigest !== sha256) throw fail('binary_content_mismatch');
          const next: StageRow = { ...stage, phase: 'sealed', generation: nextDecimalU64(stage.generation), emissionCount: stage.emissionCount + output.length,
            finalized: { length: captured.finalLength, sha256, manifest } };
          await persist(stage, next, output, current.sources); current.row = clone(next); current.sources.push(...output.map(item => clone(item.ref))); active(); return { length: captured.finalLength, sha256 };
        } catch (error) { discard(owned.stageId); throw error; }
      });
    },
    abort(ref) { return serial(ref, owned => stageRead<void>(owned, 'readwrite', ['binary_stages'], (tx, stage, done, abort) => {
      if (stage.phase === 'aborted') { done(); return; }
      if (!['receiving', 'sealed'].includes(stage.phase)) throw fail('binary_stage_not_abortable');
      withUsage(tx, counters => {
        if (!counters.activeStages) throw fail('binary_usage_unavailable');
        putNormalizedMetadata(tx, 'binary_stages', { ...stage, phase: 'aborted', generation: nextDecimalU64(stage.generation) } as unknown as MetadataValue, () => {
          saveUsage(tx, { ...counters, activeStages: counters.activeStages - 1 }); done();
        }, abort);
      }, abort);
    }).then(() => { discard(owned.stageId); })); },
    takeSealed(ref) { return serial(ref, async owned => {
      try {
        const stage = await stageRead<StageRow>(owned, 'readonly', ['binary_stages'], (_tx, value, done) => done(value));
        if (!['sealed', 'commit_requested'].includes(stage.phase) || !stage.finalized) throw fail('binary_stage_not_sealed');
        let current = cache.get(stage.stageId);
        if (!current || !same(current.row, stage) || !current.built) {
          current = await rebuild(stage); active();
          const builder = current.builder!; current.builder = undefined; current.built = builder.finish();
        }
        const manifest = JSON.parse(current.built!.manifestJson());
        if (!same(manifest, stage.finalized.manifest) || manifest.bytes !== stage.finalized.length || digest(manifest.digest) !== stage.finalized.sha256) throw fail('storage_corrupt');
        await stageRead<void>(owned, 'readonly', ['binary_stages', 'sync_source_headers', 'sync_source_payloads'], (tx, actual, done, abort) => {
          if (!same(stage, actual)) throw fail('binary_stage_changed'); let index = 0;
          const next = () => {
            if (index === current!.sources.length) { done(); return; }
            const header = current!.sources[index++].header;
            const key = [header.realmId, header.vaultId, header.updateId];
            on(tx, tx.objectStore('sync_source_headers').get(key), value => {
              if (!same(value, header)) throw fail('storage_corrupt');
              on(tx, tx.objectStore('sync_source_payloads').getKey(key), value => { if (value === undefined) throw fail('storage_corrupt'); next(); }, abort);
            }, abort);
          }; next();
        });
        active(); cache.delete(stage.stageId);
        return { ref: refOf(stage), request: clone(stage.request), stageGeneration: stage.generation, sourceRefs: clone(current.sources), built: current.built!, batch: current.batch };
      } catch (error) { discard(owned.stageId); throw error; }
    }); },
    dispose() { if (retired) return; retired = true; for (const id of cache.keys()) discard(id); },
  };
}
