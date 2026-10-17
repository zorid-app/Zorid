import { vaultPath } from './path.ts';
import { bytesToBase64, base64ToBytes } from './binary.ts';
import { normalizePath, type VaultAdapter, type VaultEntry } from '../core/types.ts';
import type { PlatformVault } from './index.ts';
import type { DesktopReconciliation } from './bridge.d.ts';
import type { DurableWrites, DurableWriteRef, DurableWriteIntent, DurableWriteRead } from '../core/durable-writes.ts';
import type { Checkpoint, CheckpointMetadata, CheckpointPage, DurableCheckpoints } from '../core/durable-checkpoints.ts';

/** Native chooses/opens the vault before loading the editor. No vault root crosses this API. */
export interface NativeVaultPlugin {
  context(): Promise<{ name: string; clientId: string; reconciliation?: DesktopReconciliation; initialPath?: string }>;
  noteOpened(input: { path: string }): Promise<void>;
  refresh(): Promise<{ reconciliation: DesktopReconciliation }>;
  request(input: { header: string; body: string }): Promise<{ header: string; body: string }>;
  addListener(event: 'lifecycleRequest', handler: (event: { id: string; reason: MobileLifecycleReason }) => void): Promise<{ remove(): Promise<void> }>;
  lifecycleAck(input: { id: string; ok: boolean }): Promise<void>;
}
export type MobileLifecycleReason = 'background' | 'switchVault';
export interface MobileLifecycle {
  subscribe(handler: (reason: MobileLifecycleReason, ack: () => Promise<void>) => Promise<void>): () => void;
}
// Keep this owned surface until the coordinator lands the PlatformVault declaration.
type NativeMobilePlatformVault = PlatformVault & { mobileLifecycle: MobileLifecycle; initialPath?: string; noteOpened(path: string): Promise<void> };
const FILE_LIMIT = 16 * 1024 * 1024, PLAN_LIMIT = 8 * 1024 * 1024, CHECKPOINT_LIMIT = 32 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Wire objects are validated at their consumer boundary; never cast them to editor state directly.
type Wire = Record<string, any>;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const fail = (code: string, uncertain = false) => Object.assign(new Error(`Native vault: ${code}`), { code, commitUncertain: uncertain, source: 'host' });
function textBytes(value: string, limit: number): Uint8Array {
  if (typeof value !== 'string') throw fail('invalid_text');
  if (value.length > limit) throw fail('request_limit');
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) throw fail('invalid_text'); }
    else if (c >= 0xdc00 && c <= 0xdfff) throw fail('invalid_text');
  }
  const bytes = encoder.encode(value); if (bytes.length > limit) throw fail('request_limit'); return bytes;
}
function unbase64(value: string, limit: number): Uint8Array {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(limit / 3)) throw fail('response_limit', true);
  let bytes: Uint8Array; try { bytes = base64ToBytes(value); } catch { throw fail('invalid_response', true); }
  if (bytes.length > limit || bytesToBase64(bytes) !== value) throw fail('invalid_response', true);
  return bytes;
}
function sameKeys(value: Wire, keys: string[]): boolean { return !!value && typeof value === 'object' && Object.keys(value).sort().join(',') === keys.sort().join(','); }
const visible = (path: string) => path.split('/').every(part => !part.startsWith('.'));
const terminal = new Set(['invalid_request','not_found','invalid_path','invalid_identifier','invalid_mutation','invalid_text','invalid_family_command','entry_not_found','entry_deleted','revision_conflict','idempotency_conflict']);

function nativeNotePath(value: unknown): string {
  if (typeof value !== 'string') throw fail('invalid_path');
  // Native Rust paths are canonical relative entry paths; never silently rewrite
  // the selected spelling or allow the private store directory as a note.
  try {
    if (vaultPath(value) !== value || /[\u007f-\u009f]/.test(value) || /^\.zorid(?:\/|$)/i.test(value)) throw 0;
    textBytes(value,1024 * 1024);
  } catch { throw fail('invalid_path'); }
  return value;
}

/** Same bounded native status schema as the desktop host, copied into immutable UI state. */
function reconciliationStatus(input: unknown): DesktopReconciliation {
  const object = (v: unknown): v is Wire => !!v && typeof v === 'object' && !Array.isArray(v);
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const relative = (v: unknown) => v === null || typeof v === 'string' && encoder.encode(v).length <= 2048 && !!v
    && !v.startsWith('/') && !v.includes('\\') && !/[\u0000-\u001f\u007f]/.test(v) && !/^[A-Za-z]:/.test(v)
    && !/^\.zorid(?:\/|$)/i.test(v) && !v.split('/').some(part => !part || part === '.' || part === '..');
  const fields = ['scanId','complete','scanComplete','finished','observed','imported','namespaceApplied','issueCount','issuesTruncated','issues','failure'];
  if (!object(input) || !Object.keys(input).every(key => fields.includes(key)) || !id(input.scanId)
    || ![input.complete,input.scanComplete,input.finished,input.issuesTruncated].every(v => typeof v === 'boolean')
    || ![input.observed,input.imported,input.namespaceApplied,input.issueCount].every(count)
    || !Array.isArray(input.issues) || input.issues.length > 32 || input.issueCount < input.issues.length
    || input.issuesTruncated !== (input.issueCount > input.issues.length)
    || !input.issues.every((issue: unknown) => object(issue) && sameKeys(issue,['path','code']) && relative(issue.path)
      && ['scan_limit','recovery_retained','changed_during_scan','reconciliation_blocked'].includes(issue.code))
    || input.complete && (!input.scanComplete || !input.finished || input.issueCount !== 0)
    || input.failure !== undefined && (input.failure !== 'scan_failed' || input.complete)) throw fail('invalid_reconciliation');
  return Object.freeze({ scanId: input.scanId, complete: input.complete, scanComplete: input.scanComplete, finished: input.finished,
    observed: input.observed, imported: input.imported, namespaceApplied: input.namespaceApplied, issueCount: input.issueCount,
    issuesTruncated: input.issuesTruncated, issues: Object.freeze(input.issues.map((issue: Wire) => Object.freeze({path: issue.path, code: issue.code}))),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  });
}

/** Native Rust authority only. Whole-file binary I/O is bounded to 16 MiB;
 * binaryStreams/media resource URLs are deliberately unavailable until admitted.
 * Optional bridge injection supports focused tests without a native shell. */
export async function openNativeMobileVault(plugin?: NativeVaultPlugin): Promise<NativeMobilePlatformVault> {
  if (!plugin) {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('NativeVault')) throw fail('native_plugin_unavailable');
    plugin = registerPlugin<NativeVaultPlugin>('NativeVault');
  }
  const bridge = plugin;
  let clientId = '';
  let releasePromise: Promise<void> | undefined, leaseReleased = false;
  let lifecycleHandler: ((reason: MobileLifecycleReason, ack: () => Promise<void>) => Promise<void>) | undefined;
  let lifecycleTask: Promise<void> | undefined, lifecycleBusyId: string | undefined;
  let lifecycleStopped = false;
  let tail: Promise<unknown> = Promise.resolve(), serialTail: Promise<unknown> = Promise.resolve();
  let requestId = 0n, closed = false, closing = false, lease: Wire | undefined;
  const listeners = new Set<(paths?: readonly string[]) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  function stopPolling() { if (timer) { clearInterval(timer); timer = undefined; } listeners.clear(); reconciliationListeners.clear(); }
  const rejectLifecycle = async (id: string) => { try { await bridge.lifecycleAck({ id, ok: false }); } catch { /* Native may already have expired this request. */ } };
  function onLifecycle(event: { id: string; reason: MobileLifecycleReason }) {
    if (typeof event?.id !== 'string' || !uuid(event.id)) return;
    if (lifecycleBusyId === event.id) return; // Duplicate delivery shares the original outcome.
    if (lifecycleTask || lifecycleStopped || closed || closing || releasePromise || !['background','switchVault'].includes(event.reason)) { void rejectLifecycle(event.id); return; }
    lifecycleBusyId = event.id;
    const handler = lifecycleHandler;
    const task = Promise.resolve().then(async () => {
      let approved = false, finished = false, ackPromise: Promise<void> | undefined;
      const ack = (): Promise<void> => {
        if (finished) return Promise.reject(fail('stale_lifecycle'));
        if (ackPromise) return ackPromise;
        ackPromise = (async () => {
          // Native owns the deadline and rejects stale_lifecycle without switching.
          await bridge.lifecycleAck({ id: event.id, ok: true });
          approved = true;
          if (event.reason === 'switchVault') { stopPolling(); closed = true; leaseReleased = true; }
        })();
        void ackPromise.catch(() => {}); // An unawaited ACK must not create an unhandled rejection.
        return ackPromise;
      };
      try {
        if (handler) await handler(event.reason,ack);
      } catch { /* The workspace receives ACK rejection and restores editing. */ }
      finally {
        finished = true;
        // Even a throwing handler may already have sent an ACK. Settle it before
        // releasing the listener or sending a contradictory negative response.
        if (ackPromise) { try { await ackPromise; } catch { /* Native rejected authorization. */ } }
        if (!approved) await rejectLifecycle(event.id);
      }
    });
    lifecycleTask = task;
    void task.finally(() => {
      if (lifecycleTask === task) { lifecycleTask = undefined; lifecycleBusyId = undefined; }
      if (closed) void stopLifecycle().catch(() => {});
    });
  }
  // Subscribe before context: startup-time requests must receive a negative ACK.
  const lifecycleListener = await bridge.addListener('lifecycleRequest',onLifecycle);
  let removePromise: Promise<void> | undefined;
  function stopLifecycle(): Promise<void> {
    lifecycleStopped = true; lifecycleHandler = undefined;
    if (!removePromise) removePromise = lifecycleListener.remove().catch(error => { removePromise = undefined; throw error; });
    return removePromise;
  }
  const mobileLifecycle: MobileLifecycle = {
    subscribe(handler) {
      active();
      if (releasePromise || lifecycleStopped) throw fail('storage_closed');
      if (lifecycleHandler) throw fail('lifecycle_handler_registered');
      lifecycleHandler = handler;
      return () => { if (lifecycleHandler === handler) lifecycleHandler = undefined; };
    },
  };
  let initialPath: string | undefined;
  let context: Awaited<ReturnType<NativeVaultPlugin['context']>>;
  let reconciliationState: DesktopReconciliation | null = null;
  const reconciliationListeners = new Set<(status: DesktopReconciliation) => void>();
  function notify() { for (const listener of listeners) { try { listener(); } catch { /* Consumer errors do not change durable storage outcomes. */ } } }
  function active() { if (closed || closing) throw fail('storage_closed'); }
  function serial<T>(action: () => Promise<T>): Promise<T> { active(); if (releasePromise) throw fail('storage_closed'); const task = serialTail.then(action); serialTail = task.catch(() => {}); return task; }
  function request(command: Wire, bytes: Uint8Array = new Uint8Array(), allowClosing = false): Promise<{ result: Wire; bytes: Uint8Array }> {
    if (!allowClosing) active();
    const limit = command.method.startsWith('checkpoint_') ? CHECKPOINT_LIMIT : FILE_LIMIT;
    if (bytes.length > limit) throw fail('request_limit');
    const request_id = String(++requestId);
    // Release authorizes its command reference, never an outer lease. Rust
    // rejects leased release_client; omission also permits lost-ACK replay.
    const header = JSON.stringify({ version: 1, request_id, command, ...(lease && command.method !== 'release_client' ? { lease } : {}) });
    if (encoder.encode(header).length > 1024 * 1024) throw fail('request_limit');
    const body = bytesToBase64(bytes);
    const task = tail.then(async () => {
      let reply;
      try { reply = await bridge.request({ header, body }); } catch { throw fail('outcome_unknown', true); }
      let envelope: Wire;
      try { if (typeof reply.header !== 'string' || reply.header.length > 1024 * 1024) throw 0; envelope = JSON.parse(reply.header); } catch { throw fail('invalid_response', true); }
      if (envelope.version !== 1 || envelope.request_id !== request_id || typeof envelope.ok !== 'boolean') throw fail('invalid_response', true);
      const response = unbase64(reply.body, limit);
      if (!envelope.ok) {
        const error = envelope.error;
        if (!error || typeof error !== 'object' || Array.isArray(error) || typeof error.code !== 'string' || !/^[a-z_]{1,64}$/.test(error.code)
          || typeof error.message !== 'string' || typeof error.commit_uncertain !== 'boolean' || response.length) throw fail('invalid_response', true);
        // Storage/checkpoint failures may have committed even when their code is
        // not outcome_unknown. The validated host flag owns that distinction.
        throw fail(error.code, error.commit_uncertain);
      }
      if (!envelope.result || typeof envelope.result !== 'object') throw fail('invalid_response', true);
      if (!['read_path','read_presented','checkpoint_load','checkpoint_cas'].includes(command.method) && response.length) throw fail('invalid_response', true);
      return { result: envelope.result, bytes: response };
    });
    tail = task.catch(() => {}); return task;
  }
  const call = async (method: string, fields: Wire = {}, bytes?: Uint8Array) => (await request({ method, ...fields }, bytes)).result;
  try {
    context = await bridge.context();
    if (typeof context.clientId !== 'string' || !uuid(context.clientId) || typeof context.name !== 'string' || !context.name) throw fail('invalid_native_context');
    if (context.initialPath !== undefined) {
      try { initialPath = nativeNotePath(context.initialPath); } catch { throw fail('invalid_native_context'); }
    }
    if (context.reconciliation !== undefined) reconciliationState = reconciliationStatus(context.reconciliation);
    clientId = context.clientId;
    const claimed = (await call('claim_client', { client_id: clientId })).lease;
    if (!claimed || !id(claimed.local_store_id) || claimed.client_id !== clientId || !uuid(claimed.token)) throw fail('invalid_client_lease');
    lease = Object.freeze({ local_store_id: claimed.local_store_id, client_id: clientId, token: claimed.token });
    const authority = (await call('identity')).identity;
    if (authority?.local_store_id !== lease.local_store_id) throw fail('invalid_authority');
  } catch (error) {
    closing = true;
    if (lease) await request({ method: 'release_client', reference: lease },undefined,true).catch(() => {});
    await lifecycleTask; await stopLifecycle().catch(() => {}); closed = true;
    throw error;
  }
  const reconciliation: NonNullable<PlatformVault['reconciliation']> = {
    getStatus: () => reconciliationState,
    subscribe(listener) {
      active(); if (releasePromise) throw fail('storage_closed');
      reconciliationListeners.add(listener);
      return () => { reconciliationListeners.delete(listener); };
    },
    async retry() {
      active(); if (releasePromise) throw fail('storage_closed');
      // Only native may initiate a trusted scan. Share the exact request queue,
      // so refresh never overlaps a leased request or another refresh.
      const task = tail.then(async () => {
        active();
        const response = await bridge.refresh();
        active();
        if (!response || !sameKeys(response,['reconciliation'])) throw fail('invalid_reconciliation');
        const status = reconciliationStatus(response.reconciliation);
        reconciliationState = status;
        for (const listener of reconciliationListeners) { try { listener(status); } catch { /* UI listener errors do not undo native reconciliation. */ } }
        notify();
      });
      tail = task.catch(() => {});
      await task;
    },
  };
  const scope = Object.freeze({ vaultId: lease!.local_store_id as string, clientId });
  function checkScope(value: Wire) { if (value?.vaultId !== scope.vaultId || value.clientId !== clientId) throw fail('checkpoint_scope_mismatch'); }
  function key(value: string) { textBytes(value, 1024); if (!value || value.includes('\0')) throw fail('checkpoint_invalid'); return value; }
  function checkpointMetadata(value: Wire): CheckpointMetadata {
    checkScope(value);
    if (value.version !== 1 || typeof value.key !== 'string' || !value.key || value.key.includes('\0') || encoder.encode(value.key).length > 1024 || !uuid(value.revision)
      || !decimal(value.sequence) || value.sequence === '0' || BigInt(value.sequence) > 9223372036854775807n || typeof value.deleted !== 'boolean'
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > CHECKPOINT_LIMIT || value.deleted && value.byteLength !== 0 || value.encodedState !== undefined) throw fail('invalid_checkpoint');
    return Object.freeze({ version: 1, ...scope, key: value.key, revision: value.revision, sequence: value.sequence, deleted: value.deleted, byteLength: value.byteLength });
  }
  function checkpoint(value: Wire | null, bytes: Uint8Array, requestedKey: string): Checkpoint | null {
    if (value === null) { if (bytes.length) throw fail('invalid_response', true); return null; }
    const meta = checkpointMetadata(value!);
    if (meta.key !== requestedKey || meta.byteLength !== bytes.length) throw fail('invalid_checkpoint', true);
    return Object.freeze({ ...meta, encodedState: meta.deleted ? null : decoder.decode(bytes) });
  }
  async function page(method: string, options: { limit: number; cursor?: string; after?: string }): Promise<CheckpointPage> {
    let limit = options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || options.after !== undefined && !decimal(options.after)) throw fail('checkpoint_invalid');
    if (options.cursor !== undefined) textBytes(options.cursor, 2048);
    for (;;) {
      try {
        const value = await call(method, { scope, limit, cursor: options.cursor ?? null, ...(method === 'checkpoint_changes' ? { after: options.after } : {}) });
        if (!Array.isArray(value.items) || value.items.length > limit || !decimal(value.highWater) || !(value.cursor === null || typeof value.cursor === 'string' && !!value.cursor)) throw fail('invalid_checkpoint');
        if (BigInt(value.highWater) > 9223372036854775807n || options.after !== undefined && BigInt(value.highWater) < BigInt(options.after)) throw fail('invalid_checkpoint');
        if (value.cursor !== null) textBytes(value.cursor,2048);
        const items = value.items.map((item: Wire) => checkpointMetadata(item)) as CheckpointMetadata[];
        let previous = BigInt(options.after ?? '0'); const keys = new Set<string>();
        for (const item of items) {
          if (BigInt(item.sequence) <= previous || BigInt(item.sequence) > BigInt(value.highWater) || method === 'checkpoint_list' && (item.deleted || keys.has(item.key))) throw fail('invalid_checkpoint');
          previous = BigInt(item.sequence); keys.add(item.key);
        }
        return Object.freeze({ items: Object.freeze(items), cursor: value.cursor, highWater: value.highWater });
      } catch (error) { if ((error as Wire)?.code !== 'response_limit' || limit <= 1) throw error; limit = Math.max(1, Math.floor(limit / 2)); }
    }
  }
  const checkpoints: DurableCheckpoints = Object.freeze<DurableCheckpoints>({ scope,
    async load(input: string) { const captured = key(input); const reply = await request({ method: 'checkpoint_load', scope, key: captured }); return checkpoint(reply.result.checkpoint, reply.bytes, captured); },
    async compareAndSwap(input) {
      const change = { ...input, key: key(input.key) };
      if (!(change.expectedRevision === null || uuid(change.expectedRevision)) || !uuid(change.nextRevision)) throw fail('checkpoint_invalid');
      const bytes = change.encodedState === null ? new Uint8Array() : textBytes(change.encodedState, CHECKPOINT_LIMIT);
      const reply = await request({ method: 'checkpoint_cas', scope, key: change.key, expected_revision: change.expectedRevision, next_revision: change.nextRevision, has_state: change.encodedState !== null }, bytes);
      try { const result = checkpoint(reply.result.checkpoint, reply.bytes, change.key); if (!result || result.revision !== change.nextRevision || result.encodedState !== change.encodedState) throw 0; return result; } catch { throw fail('outcome_unknown', true); }
    },
    list: options => page('checkpoint_list', options), changes: options => page('checkpoint_changes', options),
  });
  async function readRow(method: string, fields: Wire): Promise<Wire | null> { const reply = await request({ method, ...fields }); return reply.result.entry === null ? null : { ...reply.result, bytes: reply.bytes }; }
  function observation(row: Wire | null): DurableWriteRead {
    if (!row) throw fail('not_found');
    const p = row.presentation, e = row.entry;
    if (!row.has_content || !e || !id(e.id) || !id(e.revision) || e.kind !== 'file' || e.deleted || !p || p.id !== e.id || ![p.ctime_ms,p.mtime_ms,p.size_bytes].every(v => Number.isSafeInteger(v) && v >= 0) || p.size_bytes !== row.bytes.length) throw fail('invalid_presentation');
    return Object.freeze({ path: normalizePath(e.path), content: decoder.decode(row.bytes), entryId: e.id, revision: e.revision, stat: Object.freeze({ ctime: p.ctime_ms, mtime: p.mtime_ms, size: p.size_bytes }) });
  }
  function bound(ref: DurableWriteRef): DurableWriteRef { active(); if (ref?.vaultId !== scope.vaultId || ref.clientId !== clientId || !id(ref.operationId) || !id(ref.entryId) || !id(ref.token)) throw fail('intent_identity_mismatch'); return Object.freeze({ ...ref }); }
  const nativeRef = (ref: DurableWriteRef) => ({ client_id: clientId, token: ref.token });
  function view(row: Wire, expected?: DurableWriteRef): DurableWriteIntent {
    if (!row || row.client_id !== clientId || ![row.token,row.operation_id,row.entry_id].every(id) || row.mutation_kind !== 'write') throw fail('intent_identity_mismatch');
    const ref = Object.freeze({ ...scope, token: row.token, operationId: row.operation_id, entryId: row.entry_id });
    if (expected && (ref.token !== expected.token || ref.operationId !== expected.operationId || ref.entryId !== expected.entryId)) throw fail('intent_identity_mismatch');
    if (row.state === 'prepared' || row.state === 'commit_requested') { if (row.acknowledged !== false) throw fail('invalid_intent_state'); return Object.freeze({ ref, state: row.state, acknowledged: false }); }
    if (typeof row.acknowledged !== 'boolean') throw fail('invalid_intent_state');
    if (row.state === 'committed') {
      const target = row.receipt?.changes?.find((c: Wire) => c.after?.id === ref.entryId)?.after;
      if (row.receipt.operation_id !== ref.operationId || !decimal(row.receipt.sequence) || row.receipt.sequence === '0' || !target || target.deleted || target.kind !== 'file' || !id(target.revision)) throw fail('intent_identity_mismatch');
      return Object.freeze({ ref, state: 'committed', acknowledged: row.acknowledged, receipt: Object.freeze({ operationId: ref.operationId, sequence: row.receipt.sequence, entryId: ref.entryId, revision: target.revision }) });
    }
    if (row.state !== 'rejected' || typeof row.error?.code !== 'string') throw fail('invalid_intent_state');
    return Object.freeze({ ref, state: 'rejected', acknowledged: row.acknowledged, error: Object.freeze({ operationId: ref.operationId, code: row.error.code, message: 'The stored write was rejected; its original request is retained.' }) });
  }
  async function required(ref: DurableWriteRef) { const row = (await call('query_intent', { reference: nativeRef(ref) })).intent; if (!row) throw fail('intent_not_found'); return view(row, ref); }
  const durableWrites: DurableWrites = Object.freeze<DurableWrites>({ checkpoints,
    readText: async path => observation(await readRow('read_path', { path: normalizePath(path) })),
    async readTextById(entryId) { if (!id(entryId)) throw fail('invalid_entry_id'); const row = await readRow('read_presented', { id: entryId }); if (!row) return null; const result = observation(row); if (result.entryId !== entryId) throw fail('intent_identity_mismatch'); return result; },
    async planWrite(input) {
      const captured = { ...input, path: normalizePath(input.path) };
      if (![captured.operationId,captured.expectedEntryId,captured.expectedRevision].every(id)) throw fail('invalid_write_plan');
      textBytes(captured.expectedContent, PLAN_LIMIT); const bytes = textBytes(captured.content, PLAN_LIMIT);
      const encodedPlan = JSON.stringify({ operation_id: captured.operationId, mutation: { type: 'write', id: captured.expectedEntryId, expected: captured.expectedRevision }, content_base64: bytesToBase64(bytes) });
      textBytes(encodedPlan, PLAN_LIMIT);
      const current = await durableWrites.readText(captured.path);
      if (current.entryId !== captured.expectedEntryId || current.revision !== captured.expectedRevision || current.content !== captured.expectedContent) throw fail('revision_conflict');
      return Object.freeze({ version: 1, ...scope, operationId: captured.operationId, entryId: captured.expectedEntryId, encodedPlan });
    },
    async prepare(input) {
      const plan = { ...input }; active();
      if (plan.version !== 1 || plan.vaultId !== scope.vaultId || plan.clientId !== clientId || !id(plan.operationId) || !id(plan.entryId)) throw fail('invalid_write_plan');
      textBytes(plan.encodedPlan, PLAN_LIMIT);
      let parsed: Wire; try { parsed = JSON.parse(plan.encodedPlan); } catch { throw fail('invalid_write_plan'); }
      if (JSON.stringify(parsed) !== plan.encodedPlan || !sameKeys(parsed,['operation_id','mutation','content_base64']) || !sameKeys(parsed.mutation,['type','id','expected']) || parsed.operation_id !== plan.operationId || parsed.mutation.type !== 'write' || parsed.mutation.id !== plan.entryId || !id(parsed.mutation.expected)) throw fail('invalid_write_plan');
      const bytes = unbase64(parsed.content_base64, PLAN_LIMIT); decoder.decode(bytes);
      const row = (await call('prepare_intent', { client_id: clientId, operation_id: parsed.operation_id, mutation: parsed.mutation }, bytes)).intent;
      try { const result = view(row); if (result.ref.operationId !== plan.operationId || result.ref.entryId !== plan.entryId) throw 0; return result; } catch { throw fail('outcome_unknown', true); }
    },
    async commit(input) { const ref = bound(input); await required(ref); try { const result = view((await call('commit_intent', { reference: nativeRef(ref) })).intent, ref); if (result.state !== 'committed' && result.state !== 'rejected') throw 0; notify(); return result; } catch { throw fail('outcome_unknown', true); } },
    async query(input) { const ref = bound(input); const row = (await call('query_intent', { reference: nativeRef(ref) })).intent; return row === null ? null : view(row,ref); },
    async listUnacknowledged() {
      const results: DurableWriteIntent[] = []; let cursor = '0';
      for (let count = 0; count < 100; count++) {
        const page = await call('list_intents', { client_id: clientId, cursor, limit: 100 });
        if (!Array.isArray(page.intents) || page.intents.length > 100 || !decimal(page.next_cursor) || typeof page.has_more !== 'boolean' || page.has_more && BigInt(page.next_cursor) <= BigInt(cursor)) throw fail('invalid_response');
        let order = BigInt(cursor);
        for (const row of page.intents) {
          if (row.client_id !== clientId || !decimal(row.order) || BigInt(row.order) <= order) throw fail('invalid_response');
          order = BigInt(row.order);
          if (!row.acknowledged && row.mutation_kind === 'write') results.push(view(row));
        }
        if (order !== BigInt(page.next_cursor)) throw fail('invalid_response');
        if (!page.has_more) return results; cursor = page.next_cursor;
      }
      throw fail('intent_enumeration_limit');
    },
    async acknowledge(input, expectedInput) {
      const ref = bound(input), expected = { ...expectedInput }, actual = await required(ref);
      if (expected.operationId !== ref.operationId || !(expected.status === 'committed' && actual.state === 'committed' && expected.sequence === actual.receipt.sequence || expected.status === 'rejected' && actual.state === 'rejected' && expected.code === actual.error.code)) throw fail('intent_outcome_mismatch');
      const wire = expected.status === 'committed' ? { state: 'committed', operation_id: expected.operationId, sequence: expected.sequence } : { state: 'rejected', operation_id: expected.operationId, code: expected.code };
      const settled = view((await call('acknowledge_intent', { reference: nativeRef(ref), expected: wire })).intent,ref);
      if (!settled.acknowledged || !(settled.state === 'committed' && expected.status === 'committed' && settled.receipt.sequence === expected.sequence || settled.state === 'rejected' && expected.status === 'rejected' && settled.error.code === expected.code)) throw fail('outcome_unknown', true);
    },
  });
  async function snapshot(): Promise<Wire[]> {
    const result = await call('list_snapshot');
    if (!Array.isArray(result.entries)) throw fail('invalid_response');
    for (const row of result.entries) {
      const e = row.state, p = row.presentation;
      if (!e || !id(e.id) || !id(e.revision) || !['file','folder'].includes(e.kind) || e.deleted || normalizePath(e.path) !== e.path || !p || p.id !== e.id || ![p.ctime_ms,p.mtime_ms,p.size_bytes].every(v => Number.isSafeInteger(v) && v >= 0)) throw fail('invalid_presentation');
    }
    return result.entries;
  }
  const metadata = async (path: string): Promise<Wire | undefined> => (await snapshot()).find(row => row.state.path === path)?.state;
  type Step = { family: { version: 1; request: { operation_id: string; mutation: Wire }; create_mode: 'text' | 'binary' | null }; body: string };
  type FileState = { version: 1; operationId: string; signature: string; state: 'requested' | 'committed' | 'rejected'; next: number; commands: Step[]; code?: string };
  type Input = { kind: string; path: string; body?: string; expectedBody?: string; expectedEntryId?: string; expectedRevision?: string; destination?: string; force?: boolean };
  const prefix = 'mobile-file-command/v1/';
  const pending = new Map<string, { input: Input; operationId: string; entryId: string }>();
  const step = (operationId: string, mutation: Wire, mode: Step['family']['create_mode'] = null, body = ''): Step => ({ family: { version: 1, request: { operation_id: operationId, mutation }, create_mode: mode }, body });
  async function planFile(input: Input, operationId: string, entryId: string): Promise<Step[]> {
    const current = await metadata(input.path), commands: Step[] = [];
    const create = (path: string, kind: string, eid = entryId, op = operationId) => step(op, { type: 'create', id: eid, path, kind }, kind === 'file' ? input.kind.endsWith('Binary') ? 'binary' : 'text' : null, kind === 'file' ? input.body! : '');
    if (['mkdir','createText','createBinary'].includes(input.kind)) { if (current) throw fail('revision_conflict'); return [create(input.path,input.kind === 'mkdir' ? 'folder' : 'file')]; }
    if (['writeText','writeBinary'].includes(input.kind)) {
      if (!current) { if (input.expectedBody !== undefined || input.expectedEntryId !== undefined) throw fail('revision_conflict'); return [create(input.path,'file')]; }
      if (current.kind !== 'file') throw fail('invalid_request');
      if (input.expectedEntryId !== undefined && (current.id !== input.expectedEntryId || current.revision !== input.expectedRevision)) throw fail('revision_conflict');
      if (input.expectedBody !== undefined) {
        const observed = await readRow('read_path', { path: input.path });
        if (!observed || observed.entry.id !== current.id || observed.entry.revision !== current.revision || bytesToBase64(observed.bytes) !== input.expectedBody) throw fail('revision_conflict');
      }
      return [step(operationId,{ type: 'write', id: current.id, expected: current.revision },null,input.body!)];
    }
    if (!current) throw fail('not_found');
    let destination = input.destination;
    if (input.kind === 'trash') {
      if (input.path === '.trash' || input.path.startsWith('.trash/')) throw fail('invalid_request');
      destination = `.trash/${operationId}/${input.path}`;
      const parents = destination.split('/'); parents.pop();
      for (let i = 1; i <= parents.length; i++) {
        const path = parents.slice(0,i).join('/'), parent = await metadata(path);
        if (parent) { if (parent.kind !== 'folder') throw fail('invalid_request'); }
        else commands.push(create(path,'folder',crypto.randomUUID(),crypto.randomUUID()));
      }
    }
    if (input.kind === 'move' || input.kind === 'trash') {
      if (!destination || destination === input.path || destination.startsWith(input.path + '/') || await metadata(destination)) throw fail('revision_conflict');
      commands.push(step(operationId,{ type: 'move', id: current.id, expected: current.revision, path: destination }));
    } else if (input.kind === 'delete') commands.push(step(operationId,{ type: 'delete', id: current.id, expected: current.revision, recursive: input.force }));
    else throw fail('invalid_file_request');
    if (commands.length > 256) throw fail('request_limit');
    return commands;
  }
  async function persistFile(head: Checkpoint | null, state: FileState) { return checkpoints.compareAndSwap({ key: prefix + state.operationId, expectedRevision: head?.revision ?? null, nextRevision: crypto.randomUUID(), encodedState: JSON.stringify(state) }); }
  function decodeFile(head: Checkpoint): FileState {
    let state: FileState; try { state = JSON.parse(head.encodedState!); } catch { throw fail('invalid_file_checkpoint'); }
    if (state.version !== 1 || !id(state.operationId) || head.key !== prefix + state.operationId || !/^([a-f0-9]{64})$/.test(state.signature) || !['requested','committed','rejected'].includes(state.state) || !Array.isArray(state.commands) || !state.commands.length || state.commands.length > 256 || !Number.isInteger(state.next) || state.next < 0 || state.next > state.commands.length || state.state === 'committed' && state.next !== state.commands.length || state.state === 'requested' && state.next === state.commands.length) throw fail('invalid_file_checkpoint');
    const operations = new Set<string>();
    for (const command of state.commands) {
      const family = command.family, mutation = family?.request?.mutation;
      if (family?.version !== 1 || !id(family.request?.operation_id) || operations.has(family.request.operation_id) || !mutation || !id(mutation.id) || !['create','write','move','delete'].includes(mutation.type) || (mutation.type === 'create' && mutation.kind === 'file' ? !['text','binary'].includes(family.create_mode!) : family.create_mode !== null)) throw fail('invalid_file_checkpoint');
      unbase64(command.body, FILE_LIMIT); operations.add(family.request.operation_id);
    }
    if (!operations.has(state.operationId)) throw fail('invalid_file_checkpoint');
    return state;
  }
  async function finishFile(head: Checkpoint, initial: FileState) {
    let state = initial;
    if (state.state === 'rejected') throw fail(state.code ?? 'file_operation_rejected');
    if (state.state === 'committed') return;
    while (state.next < state.commands.length) {
      const command = state.commands[state.next]; let result: Wire;
      try { result = await call('file_command', { client_id: clientId, family: command.family }, unbase64(command.body,FILE_LIMIT)); }
      catch (error) {
        if (!(error as Wire)?.commitUncertain && terminal.has((error as Wire)?.code)) await persistFile(head,{ ...state, state: 'rejected', code: (error as Wire).code });
        throw error;
      }
      const mutation = command.family.request.mutation;
      const change = result.commit?.changes?.find((c: Wire) => c.after?.id === mutation.id);
      if (result.commit?.operation_id !== command.family.request.operation_id || !decimal(result.commit.sequence) || result.commit.sequence === '0' || !change || !id(change.after.revision)
        || mutation.type === 'create' && (change.before !== null || change.after.path !== mutation.path || change.after.kind !== mutation.kind)
        || mutation.type !== 'create' && (change.before?.revision !== mutation.expected || change.before?.id !== mutation.id)
        || mutation.type !== 'delete' && change.after.deleted !== false
        || mutation.type === 'write' && change.after.kind !== 'file'
        || !['pending','projected'].includes(result.projection?.state)
        || mutation.type === 'move' && change.after.path !== mutation.path
        || mutation.type === 'delete' && change.after.deleted !== true) throw fail('outcome_unknown',true);
      state = { ...state, next: state.next + 1, state: state.next + 1 === state.commands.length ? 'committed' : 'requested' };
      head = await persistFile(head,state);
    }
    notify();
  }
  function execute(input: Input): Promise<void> {
    const captured = { ...input, path: normalizePath(input.path), ...(input.destination ? { destination: normalizePath(input.destination) } : {}) };
    const signature = JSON.stringify(captured), mapKey = `${captured.kind}:${captured.path}`, prior = pending.get(mapKey);
    if (prior && JSON.stringify(prior.input) !== signature) return Promise.reject(fail('file_operation_pending'));
    const request = prior ?? { input: captured, operationId: crypto.randomUUID(), entryId: crypto.randomUUID() };
    pending.set(mapKey,request);
    return serial(async () => {
      const digest = await crypto.subtle.digest('SHA-256',new Uint8Array(textBytes(signature,CHECKPOINT_LIMIT)));
      const fingerprint = Array.from(new Uint8Array(digest),b => b.toString(16).padStart(2,'0')).join('');
      let head = await checkpoints.load(prefix + request.operationId), state: FileState;
      if (head?.encodedState) { state = decodeFile(head); if (state.signature !== fingerprint) throw fail('idempotency_conflict'); }
      else {
        state = { version: 1, operationId: request.operationId, signature: fingerprint, state: 'requested', next: 0, commands: await planFile(captured,request.operationId,request.entryId) };
        head = await persistFile(head,state);
      }
      await finishFile(head!,state);
    }).then(() => { if (pending.get(mapKey) === request) pending.delete(mapKey); }, error => {
      if (!error?.commitUncertain && terminal.has(error?.code) && pending.get(mapKey) === request) pending.delete(mapKey);
      throw error;
    });
  }
  const bodyText = (content: string) => bytesToBase64(textBytes(content,FILE_LIMIT));
  function bodyBinary(data: Uint8Array) { if (!(data instanceof Uint8Array) || data.length > FILE_LIMIT) throw fail('request_limit'); return bytesToBase64(data); }
  const adapter: VaultAdapter = {
    durableWrites, durableNamespace: true,
    async list() { return (await snapshot()).filter(row => visible(row.state.path)).map(row => ({ path: row.state.path, entryId: row.state.id, revision: row.state.revision, type: row.state.kind, ctime: row.presentation.ctime_ms, mtime: row.presentation.mtime_ms, size: row.presentation.size_bytes } as VaultEntry)); },
    async stat(path) { const target = normalizePath(path), row = (await snapshot()).find(row => row.state.path === target); return row ? { path: target, entryId: row.state.id, revision: row.state.revision, type: row.state.kind, ctime: row.presentation.ctime_ms, mtime: row.presentation.mtime_ms, size: row.presentation.size_bytes } : null; },
    read: async path => (await durableWrites.readText(path)).content,
    async readBinary(path) { const row = await readRow('read_path',{ path: normalizePath(path) }); if (!row) throw fail('not_found'); if (!row.has_content || row.entry.kind !== 'file') throw fail('not_file'); return row.bytes; },
    write: (path,content) => execute({kind:'writeText',path,body:bodyText(content)}),
    createText: (path,content) => execute({kind:'createText',path,body:bodyText(content)}),
    compareAndWrite: (path,expectedContent,content,identity) => execute({kind:'writeText',path,body:bodyText(content),expectedBody:bodyText(expectedContent),...(identity?{expectedEntryId:identity.entryId,expectedRevision:identity.revision}:{})}),
    writeBinary: (path,data) => execute({kind:'writeBinary',path,body:bodyBinary(data)}),
    createBinary: (path,data) => execute({kind:'createBinary',path,body:bodyBinary(data)}),
    mkdir: path => execute({kind:'mkdir',path}), rename: (path,destination) => execute({kind:'move',path,destination}),
    trash: path => execute({kind:'trash',path}), remove: (path,force) => execute({kind:'delete',path,force}),
    subscribe(listener) {
      active(); listeners.add(listener);
      if (!timer) {
        let busy = false, previous: string | undefined;
        timer = setInterval(() => {
          if (busy || closing || closed) return; busy = true;
          void snapshot().then(rows => { const signature = JSON.stringify(rows); if (signature !== previous) { previous = signature; notify(); } }).catch(() => {}).finally(() => { busy = false; });
        },2000);
      }
      return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined; } };
    },
  };
  return { adapter, mobileLifecycle, reconciliation, ...(initialPath === undefined ? {} : { initialPath }),
    async noteOpened(path) {
      active(); if (releasePromise) throw fail('storage_closed');
      const captured = nativeNotePath(path);
      // This optional notification follows actual workspace activation. It only
      // updates native device-local Recents; errors never change durable saves.
      const task = tail.then(async () => {
        active();
        await bridge.noteOpened({ path: captured });
        active();
      });
      tail = task.catch(() => {});
      await task;
    },
    label: context.name, id: `mobile-core:${scope.vaultId}:${clientId}`,
    recoverCommands: () => serial(async () => {
      let cursor: string | undefined;
      for (let count = 0; count < 100; count++) {
        const page = await checkpoints.list({ limit: 100, cursor });
        for (const item of page.items) {
          if (!item.key.startsWith(prefix)) continue;
          const head = await checkpoints.load(item.key); if (!head?.encodedState) continue;
          const state = decodeFile(head); if (state.state !== 'requested') continue;
          try { await finishFile(head,state); } catch (error) { if ((error as Wire)?.commitUncertain || !terminal.has((error as Wire)?.code)) throw error; }
        }
        if (page.cursor === null) return true; cursor = page.cursor;
      }
      throw fail('file_recovery_limit');
    }),
    release() {
      if (releasePromise) return releasePromise;
      stopPolling();
      releasePromise = (async () => {
        // Flush admitted consumers before retiring the native client lease.
        await lifecycleTask;
        await serialTail; await tail; closing = true;
        if (!leaseReleased) {
          const result = (await request({ method:'release_client', reference:lease },undefined,true)).result;
          if (result.released !== true || !result.reference || ['local_store_id','client_id','token'].some(k => result.reference[k] !== lease![k])) throw fail('invalid_release',true);
          leaseReleased = true;
        }
        await stopLifecycle(); closed = true;
      })().catch(error => { releasePromise = undefined; throw error; });
      return releasePromise;
    },
  };
}
