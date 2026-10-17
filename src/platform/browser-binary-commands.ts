import { BrowserVaultError } from '../core/browser-vault.ts';
import { boundedUtf8 } from '../core/checkpoint-input.ts';
import type { Checkpoint, CheckpointScope, DurableCheckpoints } from '../core/durable-checkpoints.ts';
import { BINARY_CHUNK_BYTES, BINARY_FORMAT_FILE_BYTES } from '../core/binary-streams.ts';
import type { BinaryStreams, BinaryStageRequest, BinaryStageRef, BinarySealInput, BinarySealedStatus, BinaryOperationOutcome, BinaryStageStatus, BinaryReadRef } from '../core/binary-streams.ts';
import { vaultPath } from './path.ts';

export interface BrowserBinaryCommandsOptions {
  backend: BinaryStreams;
  scope: CheckpointScope;
  checkpoints: DurableCheckpoints;
  assertActive(): void;
}
type Phase = 'receiving' | 'seal_requested' | 'sealed' | 'commit_requested' | 'abort_requested' | 'committed' | 'rejected' | 'aborted';
interface State {
  version: 1;
  request: BinaryStageRequest;
  phase: Phase;
  ref?: BinaryStageRef;
  seal?: BinarySealInput;
  finalized?: BinarySealedStatus;
  outcome?: BinaryOperationOutcome;
}
interface Row { head: Checkpoint | null; state: State | null }
const prefix = 'binary-command/v1/', checkpointBytes = 65536;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value);
const fail = (code: string) => new BrowserVaultError(code, 'Binary operation did not complete; its original request is retained.');
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(value) || BigInt(value) > 18446744073709551615n) throw fail('invalid_binary_length');
  return BigInt(value);
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}(?![\s\S])/.test(value)) throw fail('invalid_binary_digest');
}
function json(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw fail('invalid_binary_checkpoint');
    return item;
  });
  if (typeof encoded !== 'string') throw fail('invalid_binary_checkpoint');
  boundedUtf8(encoded, checkpointBytes, 'invalid_binary_checkpoint');
  return encoded;
}
const same = (left: unknown, right: unknown) => json(left) === json(right);

/** Consumer-owned recovery phases only. The backend owns durable chunks, hashes,
 * target/event CAS and read pins. Calls are bounded individually; no producer or
 * whole-file body is retained, queued or automatically resumed after restart. */
export function createBrowserBinaryCommands(options: BrowserBinaryCommandsOptions): { streams: BinaryStreams; recover(): Promise<boolean> } {
  const { backend, checkpoints } = options;
  const scope = Object.freeze({ vaultId: options.scope.vaultId, clientId: options.scope.clientId });
  if (!id(scope.vaultId) || !id(scope.clientId) || checkpoints.scope.vaultId !== scope.vaultId || checkpoints.scope.clientId !== scope.clientId) throw fail('owner_mismatch');
  const limits = Object.freeze({ ...backend.limits });
  if (decimal(limits.maxFileBytes) > BigInt(BINARY_FORMAT_FILE_BYTES) || decimal(limits.smallReadBytes) > decimal(limits.maxFileBytes) || !Number.isInteger(limits.maxChunkBytes) || limits.maxChunkBytes < 1 || limits.maxChunkBytes > BINARY_CHUNK_BYTES) throw fail('invalid_stream_limits');
  let busy = false;
  function active(): void {
    options.assertActive();
    if (checkpoints.scope.vaultId !== scope.vaultId || checkpoints.scope.clientId !== scope.clientId) throw fail('owner_mismatch');
  }
  function run<T>(action: () => Promise<T>): Promise<T> {
    let accepted = false;
    try {
      active(); if (busy) throw fail('binary_busy'); busy = true; accepted = true;
      return action().finally(() => { busy = false; });
    } catch (error) { if (accepted) busy = false; return Promise.reject(error); }
  }
  function length(value: unknown): string {
    if (decimal(value) > decimal(limits.maxFileBytes)) throw fail('too_large');
    return value as string;
  }
  function request(input: BinaryStageRequest): BinaryStageRequest {
    if (!input || !id(input.operationId) || !id(input.target?.entryId)) throw fail('invalid_request');
    let target: BinaryStageRequest['target'];
    if (input.target.kind === 'create') {
      let path: string; try { path = vaultPath(input.target.path); } catch { throw fail('invalid_request'); }
      boundedUtf8(path, 8192, 'invalid_request');
      target = { kind: 'create', entryId: input.target.entryId, path };
    } else if (input.target.kind === 'write' && id(input.target.expectedRevision) && id(input.target.expectedContentEvent)) {
      target = { kind: 'write', entryId: input.target.entryId, expectedRevision: input.target.expectedRevision, expectedContentEvent: input.target.expectedContentEvent };
    } else throw fail('invalid_request');
    return { operationId: input.operationId, target, ...(input.expectedLength === undefined ? {} : { expectedLength: length(input.expectedLength) }) };
  }
  function bound(input: BinaryStageRef): BinaryStageRef {
    if (!input || input.localStoreId !== scope.vaultId || input.clientId !== scope.clientId || !id(input.operationId) || !id(input.stageId)) throw fail('owner_mismatch');
    return { localStoreId: input.localStoreId, clientId: input.clientId, operationId: input.operationId, stageId: input.stageId };
  }
  function sealInput(input: BinarySealInput): BinarySealInput {
    if (!input) throw fail('invalid_request');
    if (input.expectedDigest !== undefined) digest(input.expectedDigest);
    return { finalLength: length(input.finalLength), ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }) };
  }
  function finalized(input: BinarySealedStatus, expected?: BinarySealInput): BinarySealedStatus {
    if (!input) throw fail('invalid_binary_response');
    digest(input.sha256); const result = { length: length(input.length), sha256: input.sha256 };
    if (expected && (result.length !== expected.finalLength || expected.expectedDigest !== undefined && result.sha256 !== expected.expectedDigest)) throw fail('content_mismatch');
    return result;
  }
  function outcome(input: BinaryOperationOutcome, original: BinaryStageRequest): BinaryOperationOutcome {
    if (input?.status === 'committed') {
      boundedUtf8(input.receipt, checkpointBytes, 'invalid_binary_response');
      let receipt: any; try { receipt = JSON.parse(input.receipt); } catch { throw fail('invalid_binary_response'); }
      if (receipt?.operation_id !== original.operationId || decimal(receipt.sequence) === 0n || !Array.isArray(receipt.changes)) throw fail('invalid_binary_response');
      const targets = receipt.changes.filter((change: any) => change?.after?.id === original.target.entryId);
      if (targets.length !== 1 || targets[0].after.kind !== 'file' || targets[0].after.deleted !== false || !id(targets[0].after.revision) || original.target.kind === 'create' && targets[0].after.path !== original.target.path) throw fail('invalid_binary_response');
      return { status: 'committed', receipt: input.receipt };
    }
    if (input?.status !== 'rejected' || !id(input.error?.code) || typeof input.error.message !== 'string' || !['host', 'rust'].includes(input.error.source)) throw fail('invalid_binary_response');
    const rejected = structuredClone({ status: 'rejected' as const, error: input.error }); json(rejected); return rejected;
  }
  async function load(operationId: string): Promise<Row> {
    active(); if (!id(operationId)) throw fail('invalid_request');
    const head = await checkpoints.load(prefix + operationId);
    active();
    if (!head) return { head, state: null };
    try {
      if (head.version !== 1 || head.key !== prefix + operationId || head.vaultId !== scope.vaultId || head.clientId !== scope.clientId || head.deleted || !head.encodedState) throw 0;
      boundedUtf8(head.encodedState, checkpointBytes); const state = JSON.parse(head.encodedState) as State;
      const original = request(state.request);
      if (state.version !== 1 || original.operationId !== operationId || !same(state.request, original) || !['receiving', 'seal_requested', 'sealed', 'commit_requested', 'abort_requested', 'committed', 'rejected', 'aborted'].includes(state.phase)) throw 0;
      if (state.ref && (bound(state.ref).operationId !== operationId || !same(state.ref, bound(state.ref)))) throw 0;
      if (state.phase !== 'receiving' && !state.ref) throw 0;
      if (state.seal && !same(state.seal, sealInput(state.seal))) throw 0;
      if (state.finalized && !same(state.finalized, finalized(state.finalized, state.seal))) throw 0;
      if (['seal_requested', 'sealed', 'commit_requested', 'committed'].includes(state.phase) && !state.seal) throw 0;
      if (['sealed', 'commit_requested', 'committed'].includes(state.phase) && !state.finalized) throw 0;
      if (state.phase === 'receiving' && (state.seal || state.finalized || state.outcome)) throw 0;
      if (state.phase === 'seal_requested' && (state.finalized || state.outcome)) throw 0;
      if (state.outcome) { const checked = outcome(state.outcome, original); if (state.phase !== checked.status || !same(checked, state.outcome)) throw 0; }
      if (['committed', 'rejected'].includes(state.phase) && !state.outcome) throw 0;
      const clean: State = { version: 1, request: original, phase: state.phase, ...(state.ref ? {ref:state.ref} : {}), ...(state.seal ? {seal:state.seal} : {}), ...(state.finalized ? {finalized:state.finalized} : {}), ...(state.outcome ? {outcome:state.outcome} : {}) };
      if (Object.keys(state).some(key => !Object.hasOwn(clean, key))) throw 0;
      json(state); return { head, state };
    } catch { throw fail('invalid_binary_checkpoint'); }
  }
  async function persist(head: Checkpoint | null, state: State): Promise<Checkpoint> {
    active(); const encodedState = json(state);
    return checkpoints.compareAndSwap({ key: prefix + state.request.operationId, expectedRevision: head?.revision ?? null, nextRevision: crypto.randomUUID(), encodedState });
  }
  async function owned(input: BinaryStageRef) {
    const ref = bound(input), row = await load(ref.operationId);
    if (!row.state?.ref || !same(row.state.ref, ref)) throw fail('stage_checkpoint_missing');
    return { head: row.head, state: row.state, ref };
  }
  function status(input: BinaryStageStatus, ref: BinaryStageRef, original: BinaryStageRequest): BinaryStageStatus {
    if (!input || !same(bound(input.ref), ref) || !['receiving', 'sealed', 'commit_requested', 'committed', 'rejected', 'aborted'].includes(input.phase) || !Number.isInteger(input.nextSequence) || input.nextSequence < 0 || input.nextSequence > 0xffffffff) throw fail('invalid_binary_response');
    const result: BinaryStageStatus = { ref, phase: input.phase, acceptedLength: length(input.acceptedLength), nextSequence: input.nextSequence };
    if (input.finalized) result.finalized = finalized(input.finalized);
    if (input.outcome) { result.outcome = outcome(input.outcome, original); if (result.outcome.status !== result.phase) throw fail('invalid_binary_response'); }
    if (['committed', 'rejected'].includes(result.phase) && !result.outcome) throw fail('invalid_binary_response');
    return result;
  }
  async function inspect(row: Awaited<ReturnType<typeof owned>>): Promise<BinaryStageStatus> {
    active(); return status(await backend.query(row.ref), row.ref, row.state.request);
  }
  async function settle(row: Awaited<ReturnType<typeof owned>>, observed: BinaryStageStatus): Promise<void> {
    if (observed.outcome) {
      if (observed.outcome.status === 'committed' && !['commit_requested', 'committed'].includes(row.state.phase)) throw fail('binary_authorization_missing');
      if (row.state.outcome && !same(row.state.outcome, observed.outcome)) throw fail('binary_outcome_mismatch');
      if (!row.state.outcome) await persist(row.head, { ...row.state, phase: observed.outcome.status, outcome: observed.outcome });
    } else if (observed.phase === 'sealed' && row.state.phase === 'seal_requested') {
      const sealed = finalized(observed.finalized!, row.state.seal);
      await persist(row.head, { ...row.state, phase: 'sealed', finalized: sealed });
    }
  }
  const rejectOutcome = (value: BinaryOperationOutcome): never => { throw fail(value.status === 'rejected' ? value.error.code : 'invalid_stage_state'); };
  async function commit(input: BinaryStageRef): Promise<string> {
    let row = await owned(input);
    if (row.state.outcome) {
      if (row.state.outcome.status === 'committed') return row.state.outcome.receipt;
      return rejectOutcome(row.state.outcome);
    }
    if (!['sealed', 'commit_requested'].includes(row.state.phase)) throw fail('invalid_stage_state');
    if (row.state.phase === 'sealed') {
      row.state = { ...row.state, phase: 'commit_requested' }; row.head = await persist(row.head, row.state);
    } else {
      const observed = await inspect(row);
      if (observed.outcome) { await settle(row, observed); if (observed.outcome.status === 'committed') return observed.outcome.receipt; return rejectOutcome(observed.outcome); }
      if (!['sealed', 'commit_requested'].includes(observed.phase)) throw fail('invalid_stage_state');
    }
    let receipt: string;
    try { active(); receipt = await backend.commit(row.ref); }
    catch (error) {
      // Only the owning stage's retained outcome can make an error terminal.
      // If query is uncertain too, preserve authorization and the original error.
      let observed: BinaryStageStatus;
      try { observed = await inspect(row); } catch { throw error; }
      if (!observed.outcome) throw error;
      await settle(row, observed);
      if (observed.outcome.status === 'committed') return observed.outcome.receipt;
      return rejectOutcome(observed.outcome);
    }
    const committed = outcome({ status: 'committed', receipt }, row.state.request);
    await persist(row.head, { ...row.state, phase: 'committed', outcome: committed });
    return receipt;
  }
  function readRef(input: BinaryReadRef): BinaryReadRef {
    if (!input || input.localStoreId !== scope.vaultId || input.clientId !== scope.clientId || !id(input.readId) || !id(input.entryId) || !id(input.entryRevision) || !id(input.selectedContentEvent)) throw fail('owner_mismatch');
    return { localStoreId: input.localStoreId, clientId: input.clientId, readId: input.readId, entryId: input.entryId, entryRevision: input.entryRevision, selectedContentEvent: input.selectedContentEvent, length: length(input.length) };
  }
  const streams: BinaryStreams = {
    limits,
    begin: input => run(async () => {
      const captured = request(input); let { head, state } = await load(captured.operationId);
      if (state && !same(state.request, captured)) throw fail('idempotency_conflict');
      if (state?.ref) return bound(state.ref);
      if (!state) { state = { version: 1, request: captured, phase: 'receiving' }; head = await persist(head, state); }
      active(); const ref = bound(await backend.begin(captured));
      if (ref.operationId !== captured.operationId) throw fail('invalid_binary_response');
      await persist(head, { ...state, ref }); return { ...ref };
    }),
    append: (inputRef, input) => run(async () => {
      if (!input || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > limits.maxChunkBytes || !Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 0xffffffff) throw fail('request_limit');
      const captured = { sequence: input.sequence, offset: length(input.offset), bytes: input.bytes.slice() }, row = await owned(bound(inputRef));
      if (row.state.phase !== 'receiving') throw fail('invalid_stage_state');
      active(); const receipt = structuredClone(await backend.append(row.ref, captured));
      digest(receipt.digest);
      if (receipt.sequence !== captured.sequence || receipt.offset !== captured.offset || receipt.bytes !== captured.bytes.length || length(receipt.acceptedLength) !== String(decimal(captured.offset) + BigInt(captured.bytes.length))) throw fail('invalid_binary_response');
      return receipt;
    }),
    query: input => run(async () => { const row = await owned(bound(input)), observed = await inspect(row); await settle(row, observed); return structuredClone(observed); }),
    seal: (inputRef, input) => run(async () => {
      const captured = sealInput(input); let row = await owned(bound(inputRef));
      if (row.state.seal && !same(row.state.seal, captured)) throw fail('idempotency_conflict');
      if (row.state.finalized && ['sealed', 'commit_requested', 'committed'].includes(row.state.phase)) return { ...row.state.finalized };
      if (!['receiving', 'seal_requested'].includes(row.state.phase)) throw fail('invalid_stage_state');
      if (row.state.phase === 'receiving') { row.state = { ...row.state, phase: 'seal_requested', seal: captured }; row.head = await persist(row.head, row.state); }
      active(); const sealed = finalized(await backend.seal(row.ref, captured), captured);
      await persist(row.head, { ...row.state, phase: 'sealed', finalized: sealed }); return { ...sealed };
    }),
    commit: input => run(() => commit(bound(input))),
    abort: input => run(async () => {
      const row = await owned(bound(input));
      if (row.state.phase === 'aborted') return;
      if (['commit_requested', 'committed', 'rejected'].includes(row.state.phase)) throw fail('invalid_stage_state');
      const state: State = { ...row.state, phase: 'abort_requested' }, head = await persist(row.head, state);
      active(); await backend.abort(row.ref); await persist(head, { ...state, phase: 'aborted' });
    }),
    openRead: input => run(async () => {
      if (!input || !id(input.entryId) || input.expectedRevision !== undefined && !id(input.expectedRevision) || input.expectedContentEvent !== undefined && !id(input.expectedContentEvent)) throw fail('invalid_request');
      const captured = { entryId: input.entryId, ...(input.expectedRevision === undefined ? {} : {expectedRevision:input.expectedRevision}), ...(input.expectedContentEvent === undefined ? {} : {expectedContentEvent:input.expectedContentEvent}) };
      active(); const ref = readRef(await backend.openRead(captured)); active();
      if (ref.entryId !== captured.entryId || captured.expectedRevision !== undefined && ref.entryRevision !== captured.expectedRevision || captured.expectedContentEvent !== undefined && ref.selectedContentEvent !== captured.expectedContentEvent) throw fail('invalid_binary_response');
      return ref;
    }),
    read: (inputRef, input) => run(async () => {
      const ref = readRef(inputRef);
      if (!input || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > limits.maxChunkBytes) throw fail('request_limit');
      const captured = { offset: length(input.offset), maxBytes: input.maxBytes };
      active(); const part = await backend.read(ref, captured); active();
      if (!(part.bytes instanceof Uint8Array) || part.bytes.length > captured.maxBytes || typeof part.eof !== 'boolean') throw fail('invalid_binary_response');
      const next = decimal(captured.offset) + BigInt(part.bytes.length);
      if (next > decimal(ref.length) || part.nextOffset !== String(next) || part.eof !== (next === decimal(ref.length)) || !part.bytes.length && !part.eof) throw fail('invalid_binary_response');
      return { bytes: part.bytes.slice(), nextOffset: part.nextOffset, eof: part.eof };
    }),
    closeRead: input => run(async () => { const ref = readRef(input); active(); await backend.closeRead(ref); active(); }),
  };
  return Object.freeze({ streams: Object.freeze(streams), recover: () => run(async () => {
    let cursor: string | undefined, changed = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      active(); const page = await checkpoints.list({ limit: 100, cursor });
      for (const item of page.items) {
        if (item.deleted || !item.key.startsWith(prefix)) continue;
        const row = await load(item.key.slice(prefix.length));
        if (row.state?.phase !== 'commit_requested') continue;
        if (!row.state.ref) throw fail('invalid_binary_checkpoint');
        try { await commit(row.state.ref); changed = true; }
        catch (error) { const latest = await load(row.state.request.operationId); if (latest.state?.phase !== 'rejected') throw error; }
      }
      if (page.cursor === null) return changed;
      cursor = page.cursor;
    }
    throw fail('binary_recovery_limit');
  }) });
}
