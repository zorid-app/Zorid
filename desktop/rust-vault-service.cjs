'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkpointBytes } = require('./durable-checkpoints.cjs');
const { familyStatus, syncStatus, syncReport, familyCommand } = require('./family-sync-protocol.cjs');

const MAX_HEADER = 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BODY = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTS = 32;

function failure(code, uncertain = false) {
  const error = new Error(uncertain
    ? 'Native host acknowledgement is uncertain; retain the identical operation ID and request.'
    : 'Native host request rejected.');
  error.code = code;
  error.commitUncertain = uncertain;
  return error;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
function entry(value) {
  return object(value) && identity(value.id) && identity(value.revision) && typeof value.path === 'string' && value.path.length > 0
    && ['file', 'folder'].includes(value.kind) && typeof value.deleted === 'boolean';
}
function presentation(value, state) {
  return object(value) && value.id === state.id && [value.ctime_ms, value.mtime_ms, value.size_bytes].every(value => Number.isSafeInteger(value) && value >= 0)
    && (state.kind === 'file' || value.size_bytes === 0);
}
const presented = value => object(value) && entry(value.state) && presentation(value.presentation, value.state);
function changePage(command, result) {
  if (!decimal(result.next_cursor) || !decimal(result.head_cursor) || !Array.isArray(result.changes)
    || !decimal(command.cursor) || result.changes.length > command.limit
    || BigInt(result.next_cursor) > BigInt(result.head_cursor) || BigInt(result.next_cursor) < BigInt(command.cursor)
    || result.has_more !== (BigInt(result.next_cursor) < BigInt(result.head_cursor))) return false;
  let cursor = BigInt(command.cursor);
  for (const change of result.changes) {
    if (!object(change) || !decimal(change.cursor) || BigInt(change.cursor) !== cursor + 1n
      || !Array.isArray(change.entries) || !change.entries.every(presented) || !object(change.origin)) return false;
    cursor++;
    const origin = change.origin;
    if (origin.kind === 'bootstrap') {
      if (change.requires_full_reload !== true || change.entries.length) return false;
    } else {
      if (change.requires_full_reload !== false || !change.entries.length) return false;
      if (origin.kind === 'local_command') { if (!identity(origin.operation_id)) return false; }
      else if (origin.kind !== 'received_update' || ![origin.realm_id, origin.vault_id, origin.update_id].every(value => typeof value === 'string' && value.length > 0)) return false;
    }
  }
  return cursor === BigInt(result.next_cursor);
}
function receipt(value) {
  if (!object(value) || !identity(value.operation_id) || !decimal(value.sequence) || value.sequence === '0'
    || !Array.isArray(value.changes) || !value.changes.length) return false;
  const ids = new Set();
  return value.changes.every(change => {
    if (!object(change) || !entry(change.after) || ids.has(change.after.id)) return false;
    ids.add(change.after.id);
    return change.before === null ? !change.after.deleted : entry(change.before)
      && change.before.id === change.after.id && change.before.kind === change.after.kind && change.before.revision !== change.after.revision;
  });
}
const rejectionCodes = new Set(['invalid_path', 'invalid_identifier', 'invalid_mutation', 'entry_not_found', 'entry_deleted', 'revision_conflict', 'idempotency_conflict']);
function intent(value) {
  if (!object(value) || ![value.token, value.client_id, value.operation_id, value.entry_id].every(identity)
    || !['create', 'write', 'move', 'delete'].includes(value.mutation_kind)
    || !decimal(value.order) || value.order === '0' || typeof value.acknowledged !== 'boolean'
    || !['prepared', 'commit_requested', 'committed', 'rejected'].includes(value.state)) return false;
  if (value.projection !== null && (!object(value.projection) || !['projected', 'pending'].includes(value.projection.state))) return false;
  if (value.state === 'committed') return receipt(value.receipt) && value.receipt.operation_id === value.operation_id
    && value.receipt.changes.some(change => change.after.id === value.entry_id) && value.error === null;
  if (value.projection !== null || value.receipt !== null) return false;
  if (value.state === 'rejected') return object(value.error) && rejectionCodes.has(value.error.code);
  return !value.acknowledged && value.error === null;
}
function matchesRef(value, ref) { return value.client_id === ref.client_id && value.token === ref.token; }
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function checkpointMetadata(value, scope) {
  return object(value) && value.version === 1 && value.vaultId === scope.vaultId && value.clientId === scope.clientId
    && typeof value.key === 'string' && value.key.length > 0 && !value.key.includes('\0') && Buffer.byteLength(value.key, 'utf8') <= 1024
    && uuid(value.revision) && decimal(value.sequence) && value.sequence !== '0' && BigInt(value.sequence) <= 9223372036854775807n
    && typeof value.deleted === 'boolean' && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 && value.byteLength <= MAX_CHECKPOINT_BODY
    && (!value.deleted || value.byteLength === 0) && value.encodedState === undefined;
}
function checkpointBody(value, bytes) {
  if (value.byteLength !== bytes.length || (value.deleted && bytes.length)) return false;
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); return true; } catch { return false; }
}
function checkpointPage(command, result) {
  if (!Array.isArray(result.items) || result.items.length > command.limit || !decimal(result.highWater)
    || BigInt(result.highWater) > 9223372036854775807n || !(result.cursor === null || (typeof result.cursor === 'string' && result.cursor.length > 0 && Buffer.byteLength(result.cursor) <= 2048))) return false;
  if (command.method === 'checkpoint_changes' && (!decimal(command.after) || BigInt(result.highWater) < BigInt(command.after))) return false;
  if (result.cursor !== null && !result.items.length) return false;
  let previous = command.method === 'checkpoint_changes' ? BigInt(command.after) : 0n;
  const keys = new Set();
  for (const value of result.items) {
    if (!checkpointMetadata(value, command.scope) || BigInt(value.sequence) <= previous || BigInt(value.sequence) > BigInt(result.highWater)) return false;
    if (command.method === 'checkpoint_list' && (value.deleted || keys.has(value.key))) return false;
    previous = BigInt(value.sequence); keys.add(value.key);
  }
  return true;
}
function checkpointResult({ result, bytes }) {
  return result.checkpoint === null ? null : { ...result.checkpoint,
    encodedState: result.checkpoint.deleted ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
}
function successful(command, result, bytes, expectedBytes) {
  if (!object(result)) return false;
  if (!command) return bytes.length === 0; // Full startup validation follows.
  if (!['read', 'read_path', 'read_presented', 'checkpoint_load', 'checkpoint_cas'].includes(command.method) && bytes.length) return false;
  switch (command.method) {
    case 'fixture_family_enroll': return familyStatus(result.family);
    case 'fixture_family_status': return syncStatus(result.sync);
    case 'fixture_family_once': return syncReport(result.sync, command);
    case 'fixture_family_apply': return familyCommand(command.family)
      && successful({ method: 'apply', ...command.family.request }, result, bytes, expectedBytes);
    case 'claim_client': return object(result.lease) && identity(result.lease.local_store_id) && result.lease.client_id === command.client_id && uuid(result.lease.token);
    case 'release_client': return result.released === true && object(result.reference) && ['local_store_id', 'client_id', 'token'].every(key => result.reference[key] === command.reference[key]);
    case 'checkpoint_load': return result.checkpoint === null ? bytes.length === 0 : checkpointMetadata(result.checkpoint, command.scope) && result.checkpoint.key === command.key && checkpointBody(result.checkpoint, bytes);
    case 'checkpoint_cas': return checkpointMetadata(result.checkpoint, command.scope) && result.checkpoint.key === command.key
      && result.checkpoint.revision === command.next_revision && result.checkpoint.deleted === !command.has_state
      && checkpointBody(result.checkpoint, bytes) && expectedBytes instanceof Uint8Array && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(expectedBytes);
    case 'checkpoint_list': case 'checkpoint_changes': return checkpointPage(command, result);
    case 'identity': return object(result.identity) && identity(result.identity.local_store_id)
      && [result.identity.realm_id, result.identity.vault_id].every(value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 1024));
    case 'prepare_intent': return intent(result.intent) && result.intent.client_id === command.client_id
      && result.intent.operation_id === command.operation_id && result.intent.entry_id === command.mutation.id
      && result.intent.mutation_kind === command.mutation.type
      && (result.intent.state !== 'committed' || successful({ ...command, method: 'apply' }, { commit: result.intent.receipt, projection: { state: 'projected' } }, bytes));
    case 'commit_intent': return intent(result.intent) && matchesRef(result.intent, command.reference)
      && ['committed', 'rejected'].includes(result.intent.state);
    case 'query_intent': return result.intent === null || (intent(result.intent) && matchesRef(result.intent, command.reference));
    case 'acknowledge_intent': return intent(result.intent) && matchesRef(result.intent, command.reference) && result.intent.acknowledged
      && result.intent.state === command.expected.state && result.intent.operation_id === command.expected.operation_id
      && (result.intent.state === 'committed' ? result.intent.receipt.sequence === command.expected.sequence : result.intent.error.code === command.expected.code);
    case 'list_intents': {
      if (!Array.isArray(result.intents) || !decimal(result.next_cursor) || typeof result.has_more !== 'boolean' || !decimal(command.cursor)
        || result.intents.length > command.limit) return false;
      let cursor = BigInt(command.cursor);
      for (const value of result.intents) {
        if (!intent(value) || value.client_id !== command.client_id || BigInt(value.order) <= cursor) return false;
        cursor = BigInt(value.order);
      }
      return cursor === BigInt(result.next_cursor) && (result.intents.length > 0 || !result.has_more);
    }
    case 'apply': {
      if (!receipt(result.commit) || result.commit.operation_id !== command.operation_id
        || !object(result.projection) || !['pending', 'projected'].includes(result.projection.state)) return false;
      const change = result.commit.changes.find(value => value.after.id === command.mutation.id);
      if (!change) return false;
      if (command.mutation.type === 'create') return change.before === null && change.after.path === command.mutation.path && change.after.kind === command.mutation.kind;
      if (!change.before || change.before.revision !== command.mutation.expected) return false;
      if (command.mutation.type === 'write') return change.after.kind === 'file' && !change.after.deleted;
      if (command.mutation.type === 'move') return change.after.path === command.mutation.path && !change.after.deleted;
      return command.mutation.type === 'delete' && change.after.deleted;
    }
    case 'read': return entry(result.entry) && result.entry.id === command.id && !result.entry.deleted
      && result.has_content === (result.entry.kind === 'file') && (result.has_content || bytes.length === 0);
    case 'read_path': return result.entry === null ? bytes.length === 0 : entry(result.entry) && result.entry.path === command.path && !result.entry.deleted
      && presentation(result.presentation, result.entry) && result.presentation.size_bytes === bytes.length
      && result.has_content === (result.entry.kind === 'file');
    case 'read_presented': return result.entry === null ? bytes.length === 0 : entry(result.entry) && result.entry.id === command.id && !result.entry.deleted
      && presentation(result.presentation, result.entry) && result.presentation.size_bytes === bytes.length
      && result.has_content === (result.entry.kind === 'file');
    case 'list_snapshot': return decimal(result.cursor) && Array.isArray(result.entries)
      && result.entries.every(value => presented(value) && !value.state.deleted)
      && new Set(result.entries.map(value => value.state.id)).size === result.entries.length
      && new Set(result.entries.map(value => value.state.path)).size === result.entries.length;
    case 'changes_after': return changePage(command, result);
    case 'list': return Array.isArray(result.entries) && result.entries.every(value => entry(value) && !value.deleted)
      && new Set(result.entries.map(value => value.id)).size === result.entries.length;
    case 'rescan': return identity(result.scan_id) && typeof result.complete === 'boolean' && typeof result.finished === 'boolean'
      && Number.isSafeInteger(result.observed) && result.observed >= 0 && Number.isSafeInteger(result.imported) && result.imported >= 0
      && Array.isArray(result.missing) && result.missing.every(value => typeof value === 'string')
      && Array.isArray(result.issues) && result.issues.every(value => object(value) && (value.path === null || typeof value.path === 'string') && value.code === 'scan_incomplete');
    case 'status': return decimal(result.pending_outbox) && decimal(result.pending_projection)
      && Array.isArray(result.attempts) && Array.isArray(result.observations);
    case 'recover': case 'reconcile': return Array.isArray(result.imported) && result.imported.every(receipt)
      && Array.isArray(result.projected) && result.projected.every(identity)
      && Array.isArray(result.blocked) && result.blocked.every(value => object(value) && typeof value.path === 'string' && value.code === 'reconciliation_blocked');
    default: return false;
  }
}

/** Private main-process transport, NOT yet the path-based VaultService adapter.
 * Every mutation comes from an explicit caller-owned durable operation intent.
 * No automatic new operation IDs, storage policy or raw filesystem writes.
 * Explicit family fixture sync delegates entirely to the shared native runner.
 */
class RustVaultService {
  static async open(root, { executable, timeoutMs = 30000, fixtureSyncConfig } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)
      || typeof executable !== 'string' || !path.isAbsolute(executable)
      || (fixtureSyncConfig !== undefined && (typeof fixtureSyncConfig !== 'string' || !path.isAbsolute(fixtureSyncConfig)))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      throw failure('invalid_host_options');
    }
    const canonical = await fs.realpath(root);
    if (!(await fs.stat(canonical)).isDirectory()) throw failure('invalid_vault');
    // executable is an explicitly selected trusted app resource, never an env var
    // or renderer-supplied command. shell:false preserves arguments literally.
    const service = new RustVaultService(canonical, executable, timeoutMs, fixtureSyncConfig);
    try { await service.ready; }
    catch (error) { service.abort(error); await service.exit; throw error; }
    return service;
  }

  constructor(root, executable, timeoutMs, fixtureSyncConfig) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.sequence = 0n;
    this.tail = Promise.resolve();
    this.queuedBytes = 0;
    this.queuedCount = 0;
    this.closing = false;
    this.fatal = null;
    this.prefix = Buffer.alloc(8);
    this.prefixUsed = 0;
    this.frame = null;
    this.frameUsed = 0;
    this.exited = false;
    // Only trusted main selects this protected fixture config. No framed RPC can change it.
    const args = ['--vault', root, ...(fixtureSyncConfig === undefined ? [] : ['--fixture-sync-config', fixtureSyncConfig])];
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.ready = this.expect('0').then(({ result, bytes }) => {
      if (bytes.length || result?.transport !== 'zorid-native-stdio' || result.max_header !== MAX_HEADER || result.max_body !== MAX_BODY
        || (result.max_checkpoint_body !== undefined && result.max_checkpoint_body !== MAX_CHECKPOINT_BODY)
        || !Array.isArray(result.capabilities) || result.capabilities.length > 64
        || !result.capabilities.every(value => typeof value === 'string' && /^[a-z_]{1,64}$/.test(value))
        || (result.capabilities.includes('checkpoint_cas') && result.max_checkpoint_body !== MAX_CHECKPOINT_BODY)) {
        this.abort(failure('invalid_handshake'));
        throw this.fatal;
      }
      this.capabilities = Object.freeze([...(result.capabilities ?? [])]);
    });
    // The host deliberately redacts diagnostics. Do not forward even unexpected
    // stderr to renderer/logs, and keep draining so diagnostics cannot deadlock it.
    this.child.stderr?.resume();
    this.child.stdout?.on('data', chunk => this.receive(chunk));
    this.child.stdout?.on('error', () => this.abort(failure('transport_io', true)));
    this.child.stdin?.on('error', () => this.abort(failure('transport_io', true)));
    this.child.on('error', () => this.abort(failure('host_unavailable', true)));
    this.child.on('close', () => {
      this.exited = true;
      this.resolveExit();
      if (!this.closing || this.pending || this.frame || this.prefixUsed) this.abort(failure('host_exited', true));
    });
  }

  expect(requestId, command = null, body = null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(failure('host_timeout', true)), this.timeoutMs);
      this.pending = { requestId, command, body, resolve, reject, timer };
    });
  }
  abort(error) {
    if (!this.fatal) this.fatal = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.fatal);
      this.pending = null;
    }
    this.frame = null;
    this.prefixUsed = this.frameUsed = 0;
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    if (!this.exited) this.child.kill('SIGKILL');
  }
  receive(chunk) {
    if (this.fatal) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.frame) {
          const amount = Math.min(8 - this.prefixUsed, chunk.length - offset);
          chunk.copy(this.prefix, this.prefixUsed, offset, offset + amount);
          this.prefixUsed += amount; offset += amount;
          if (this.prefixUsed < 8) continue;
          this.headerLength = this.prefix.readUInt32BE(0);
          const bodyLength = this.prefix.readUInt32BE(4);
          const bodyLimit = ['checkpoint_load', 'checkpoint_cas'].includes(this.pending?.command?.method) ? MAX_CHECKPOINT_BODY : MAX_BODY;
          if (!this.headerLength || this.headerLength > MAX_HEADER || bodyLength > bodyLimit) throw failure('response_limit', true);
          this.frame = Buffer.allocUnsafe(this.headerLength + bodyLength);
          this.frameUsed = 0;
        }
        const amount = Math.min(this.frame.length - this.frameUsed, chunk.length - offset);
        chunk.copy(this.frame, this.frameUsed, offset, offset + amount);
        offset += amount; this.frameUsed += amount;
        if (this.frameUsed === this.frame.length) {
          const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.frame.subarray(0, this.headerLength)));
          const bytes = new Uint8Array(this.frame.subarray(this.headerLength));
          this.frame = null; this.frameUsed = this.prefixUsed = 0;
          const pending = this.pending;
          if (!pending || header.version !== 1 || header.request_id !== pending.requestId || typeof header.ok !== 'boolean') throw failure('invalid_response', true);
          if (!header.ok && (bytes.length || typeof header.error?.code !== 'string' || !/^[a-z_]{1,64}$/.test(header.error.code) || typeof header.error.commit_uncertain !== 'boolean')) throw failure('invalid_response', true);
          if (header.ok && !successful(pending.command, header.result, bytes, pending.body)) throw failure('invalid_response', true);
          clearTimeout(pending.timer); this.pending = null;
          if (header.ok) pending.resolve({ result: header.result, bytes });
          else pending.reject(failure(header.error.code, header.error.commit_uncertain === true));
        }
      }
    } catch { this.abort(failure('invalid_response', true)); }
  }

  request(command, bytes = new Uint8Array(), lease = undefined, beforeDispatch = undefined) {
    if (this.closing || this.fatal) return Promise.reject(this.fatal ?? failure('host_closed'));
    let body, header;
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > (command?.method === 'checkpoint_cas' ? MAX_CHECKPOINT_BODY : MAX_BODY)) throw failure('request_limit');
      const requestId = (++this.sequence).toString();
      // Serialize/copy before enqueue: later caller changes cannot alter a retry.
      header = Buffer.from(JSON.stringify({ version: 1, request_id: requestId, command, ...(lease ? { lease } : {}) }));
      const cost = 8 + header.length + bytes.byteLength;
      if (header.length > MAX_HEADER || this.queuedCount >= MAX_REQUESTS || this.queuedBytes + cost > MAX_QUEUED_BYTES) throw failure('request_limit');
      body = Buffer.from(bytes);
      this.queuedBytes += cost; this.queuedCount++;
      const operation = this.tail.then(async () => {
        await this.ready;
        if (this.fatal || this.exited) throw this.fatal ?? failure('host_exited');
        // Reauthorize after queue/ready awaits, immediately before any bytes leave.
        beforeDispatch?.();
        const response = this.expect(requestId, JSON.parse(header.toString()).command, body);
        const prefix = Buffer.alloc(8);
        prefix.writeUInt32BE(header.length, 0); prefix.writeUInt32BE(body.length, 4);
        // One in-flight request; queued memory is bounded above. Node streams
        // retain at most this admitted frame until Rust consumes its input.
        this.child.stdin.write(prefix);
        this.child.stdin.write(header);
        this.child.stdin.write(body);
        return response;
      });
      this.tail = operation.catch(() => {}).finally(() => { this.queuedBytes -= cost; this.queuedCount--; });
      return operation;
    } catch (error) { return Promise.reject(error?.code ? error : failure('invalid_request')); }
  }

  fixtureFamilyEnroll() { return this.request({ method: 'fixture_family_enroll' }).then(reply => reply.result.family); }
  fixtureFamilyStatus() { return this.request({ method: 'fixture_family_status' }).then(reply => reply.result.sync); }
  fixtureFamilyOnce({ maxPush = 64, maxPages = 4 } = {}) {
    if (!Number.isInteger(maxPush) || maxPush < 0 || maxPush > 1000 || !Number.isInteger(maxPages) || maxPages < 0 || maxPages > 100) return Promise.reject(failure('request_limit'));
    return this.request({ method: 'fixture_family_once', max_push: maxPush, max_pages: maxPages }).then(reply => reply.result.sync);
  }
  fixtureFamilyApply(command, bytes = new Uint8Array()) {
    if (!familyCommand(command)) return Promise.reject(failure('invalid_family_command'));
    // Copy/serialization happens synchronously in request, including explicit
    // create_mode. Retry the exact command+bytes after an uncertain acknowledgement.
    return this.request({ method: 'fixture_family_apply', family: command }, bytes).then(reply => reply.result);
  }
  claimClient(clientId) { return this.request({ method: 'claim_client', client_id: clientId }).then(reply => Object.freeze({ ...reply.result.lease })); }
  releaseClient(reference) { return this.request({ method: 'release_client', reference }).then(reply => reply.result); }
  withClientLease(reference, beforeRequest = () => {}) {
    const captured = Object.freeze({ local_store_id: reference.local_store_id, client_id: reference.client_id, token: reference.token });
    const context = { request: (command, bytes) => { beforeRequest(command); return this.request(command, bytes, captured, () => beforeRequest(command)); } };
    const methods = ['identity', 'readPath', 'readPresentedById', 'readEntryById', 'listSnapshot', 'listEntries', 'prepareIntent', 'commitIntent', 'queryIntent', 'listIntents', 'acknowledgeIntent',
      'checkpointLoad', 'checkpointCompareAndSwap', 'checkpointList', 'checkpointChanges'];
    return Object.freeze(Object.fromEntries(methods.map(name => [name, (...args) => RustVaultService.prototype[name].apply(context, args)])));
  }
  checkpointLoad(scope, key) { return this.request({ method: 'checkpoint_load', scope, key }).then(checkpointResult); }
  checkpointCompareAndSwap(scope, change) {
    const bytes = checkpointBytes(change.encodedState);
    return this.request({ method: 'checkpoint_cas', scope, key: change.key, expected_revision: change.expectedRevision,
      next_revision: change.nextRevision, has_state: change.encodedState !== null }, bytes).then(checkpointResult);
  }
  checkpointList(scope, options) { return this.request({ method: 'checkpoint_list', scope, limit: options.limit, cursor: options.cursor ?? null }).then(reply => reply.result); }
  checkpointChanges(scope, options) { return this.request({ method: 'checkpoint_changes', scope, after: options.after, limit: options.limit, cursor: options.cursor ?? null }).then(reply => reply.result); }
  identity() { return this.request({ method: 'identity' }).then(reply => reply.result.identity); }
  listEntries() { return this.request({ method: 'list' }).then(reply => reply.result.entries); }
  readEntryById(id) {
    return this.request({ method: 'read', id }).then(({ result, bytes }) => ({ ...result, bytes }));
  }
  prepareIntent(clientId, request, bytes = new Uint8Array()) {
    return this.request({ method: 'prepare_intent', client_id: clientId, operation_id: request.operation_id, mutation: request.mutation }, bytes).then(reply => reply.result.intent);
  }
  commitIntent(reference) { return this.request({ method: 'commit_intent', reference }).then(reply => reply.result.intent); }
  queryIntent(reference) { return this.request({ method: 'query_intent', reference }).then(reply => reply.result.intent); }
  listIntents(clientId, cursor = '0', limit = 100) { return this.request({ method: 'list_intents', client_id: clientId, cursor, limit }).then(reply => reply.result); }
  acknowledgeIntent(reference, expected) { return this.request({ method: 'acknowledge_intent', reference, expected }).then(reply => reply.result.intent); }
  readPath(path) {
    return this.request({ method: 'read_path', path }).then(({ result, bytes }) => result.entry === null ? null : { ...result, bytes });
  }
  readPresentedById(id) { return this.request({ method: 'read_presented', id }).then(({ result, bytes }) => result.entry === null ? null : { ...result, bytes }); }
  listSnapshot() { return this.request({ method: 'list_snapshot' }).then(reply => reply.result); }
  changesAfter(cursor, limit = 100) { return this.request({ method: 'changes_after', cursor, limit }).then(reply => reply.result); }
  apply(operationId, mutation, bytes = new Uint8Array()) {
    return this.request({ method: 'apply', operation_id: operationId, mutation }, bytes).then(reply => reply.result);
  }
  reconcile(paths) { return this.request({ method: 'reconcile', paths }).then(reply => reply.result); }
  rescan() { return this.request({ method: 'rescan' }).then(reply => reply.result); }
  recover() { return this.request({ method: 'recover' }).then(reply => reply.result); }
  status() { return this.request({ method: 'status' }).then(reply => reply.result); }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.tail;
      if (!this.exited) {
        this.child.stdin.end();
        const timer = setTimeout(() => this.abort(failure('close_timeout', true)), this.timeoutMs);
        try { await this.exit; } finally { clearTimeout(timer); }
      }
    })();
    return this.closePromise;
  }
}
module.exports = { RustVaultService };
