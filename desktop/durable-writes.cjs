'use strict';
const { desktopCheckpoints } = require('./durable-checkpoints.cjs');
const { captureSavedSourceWitness, captureSavedSourceId, captureSavedSourceGuard, captureSavedSourceValue } = require('./conditional-saved-source.cjs');
// Optional shared DurableWrites capability. No startup, renderer bridge or
// checkpoint persistence is selected here; the trusted owner supplies a service.
const LIMIT = 8 * 1024 * 1024;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sequence = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
function failure(code, uncertain = false) {
  return Object.assign(new Error('Durable desktop write could not be reconciled.'), { code, commitUncertain: uncertain });
}
function text(value) {
  if (typeof value !== 'string') throw failure('invalid_text');
  if (value.length > LIMIT) throw failure('encoded_plan_too_large');
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure('invalid_text');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw failure('invalid_text');
  }
  if (Buffer.byteLength(value, 'utf8') > LIMIT) throw failure('encoded_plan_too_large');
}
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw failure('not_utf8'); }
}
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

/** @returns {Promise<import('../src/core/durable-writes').DurableWrites>} */
async function desktopDurableWrites(service, { clientId } = {}) {
  if (!identity(clientId)) throw failure('invalid_client_id');
  const host = service.host;
  const conditionalSources = host.capabilities?.includes('conditional_saved_source') === true;
  if (conditionalSources && !['captureSavedSource', 'releaseSavedSource'].every(name => typeof host[name] === 'function')) throw failure('unsupported_host_capability');
  const authority = await host.identity();
  const vaultId = authority.local_store_id;
  if (!identity(vaultId)) throw failure('invalid_authority');
  function active() { if (service.closed) throw failure('storage_closed'); }
  function bound(value) {
    active();
    if (!value || value.vaultId !== vaultId || value.clientId !== clientId || !identity(value.operationId) || !identity(value.entryId)) throw failure('intent_identity_mismatch');
  }
  function snapshotRef(value) {
    bound(value);
    if (!identity(value.token)) throw failure('intent_identity_mismatch');
    return Object.freeze({ vaultId, clientId, token: value.token, operationId: value.operationId, entryId: value.entryId });
  }
  function observation(row) {
    if (!row.has_content) throw failure('not_file');
    const p = row.presentation;
    if (!p || p.id !== row.entry.id || ![p.ctime_ms, p.mtime_ms, p.size_bytes].every(value => Number.isSafeInteger(value) && value >= 0) || p.size_bytes !== row.bytes.length) throw failure('invalid_presentation');
    return Object.freeze({ path: row.entry.path, content: decode(row.bytes), entryId: row.entry.id, revision: row.entry.revision,
      stat: Object.freeze({ ctime: p.ctime_ms, mtime: p.mtime_ms, size: p.size_bytes }) });
  }
  function nativeRef(ref) { return { client_id: clientId, token: ref.token }; }
  function view(row, expected) {
    if (!row || row.client_id !== clientId || ![row.token, row.operation_id, row.entry_id].every(identity)) throw failure('intent_identity_mismatch');
    if (row.mutation_kind !== 'write') throw failure('intent_kind_unsupported');
    const ref = Object.freeze({ vaultId, clientId, token: row.token, operationId: row.operation_id, entryId: row.entry_id });
    if (expected && (expected.token !== ref.token || expected.operationId !== ref.operationId || expected.entryId !== ref.entryId)) throw failure('intent_identity_mismatch');
    if (row.state === 'prepared' || row.state === 'commit_requested') {
      if (row.acknowledged !== false) throw failure('invalid_intent_state');
      return Object.freeze({ ref, state: row.state, acknowledged: false });
    }
    if (typeof row.acknowledged !== 'boolean') throw failure('invalid_intent_state');
    if (row.state === 'committed') {
      if (row.receipt?.operation_id !== ref.operationId || !sequence(row.receipt.sequence)) throw failure('intent_identity_mismatch');
      const target = row.receipt.changes?.find(change => change.after?.id === ref.entryId)?.after;
      if (!target || target.deleted || target.kind !== 'file' || !identity(target.revision)) throw failure('intent_identity_mismatch');
      return Object.freeze({ ref, state: 'committed', acknowledged: row.acknowledged,
        receipt: Object.freeze({ operationId: ref.operationId, sequence: row.receipt.sequence, entryId: ref.entryId, revision: target.revision }) });
    }
    if (row.state !== 'rejected' || typeof row.error?.code !== 'string') throw failure('invalid_intent_state');
    return Object.freeze({ ref, state: 'rejected', acknowledged: row.acknowledged,
      error: Object.freeze({ operationId: ref.operationId, code: row.error.code, message: 'The stored write was rejected; its original request is retained.' }) });
  }
  async function required(ref) {
    const row = await host.queryIntent(nativeRef(ref));
    if (!row) throw failure('intent_not_found');
    view(row, ref); // Reject foreign/non-write tokens before authorizing commit.
    return row;
  }
  function parsePlan(plan) {
    bound(plan);
    if (plan.version !== 1) throw failure('invalid_write_plan');
    text(plan.encodedPlan);
    let parsed;
    try { parsed = JSON.parse(plan.encodedPlan); } catch { throw failure('invalid_write_plan'); }
    // This private provider owns canonical JSON. Reject duplicate/unknown fields
    // rather than parsing one request but submitting a normalized different one.
    const guarded = !!parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'source_capture');
    if (guarded && !conditionalSources) throw failure('unsupported_host_capability');
    if (guarded) captureSavedSourceId(parsed.source_capture);
    if (JSON.stringify(parsed) !== plan.encodedPlan || !keys(parsed, ['operation_id', 'mutation', 'content_base64', ...(guarded ? ['source_capture'] : [])])
      || !keys(parsed.mutation, ['type', 'id', 'expected']) || parsed.operation_id !== plan.operationId
      || parsed.mutation.type !== 'write' || parsed.mutation.id !== plan.entryId || !identity(parsed.mutation.expected)
      || typeof parsed.content_base64 !== 'string') throw failure('invalid_write_plan');
    const bytes = Buffer.from(parsed.content_base64, 'base64');
    if (bytes.toString('base64') !== parsed.content_base64) throw failure('invalid_write_plan');
    decode(bytes); // This capability is for text writes, not arbitrary byte mutations.
    return Object.freeze({ native: Object.freeze({ operation_id: parsed.operation_id, mutation: Object.freeze(parsed.mutation), content_base64: parsed.content_base64 }), sourceCapture: guarded ? parsed.source_capture : undefined });
  }
  return Object.freeze({
    checkpoints: desktopCheckpoints(host, { vaultId, clientId }, active),
    async captureSavedSource(input) {
      active();
      if (!conditionalSources) throw failure('unsupported_host_capability');
      const witness = captureSavedSourceWitness(input);
      const value = await host.captureSavedSource(clientId, witness);
      active();
      return captureSavedSourceValue(value, witness);
    },
    async releaseSavedSource(input) {
      active();
      if (!conditionalSources) throw failure('unsupported_host_capability');
      const captureId = captureSavedSourceId(input);
      await host.releaseSavedSource(clientId, captureId);
    },
    async readText(path) {
      active();
      const row = await service.readEntry(path);
      if (!row) throw failure('not_found');
      return observation(row);
    },
    async readTextById(entryId) {
      active();
      if (!identity(entryId)) throw failure('invalid_entry_id');
      let row;
      try { row = await host.readPresentedById(entryId); }
      catch (reason) { if (reason?.code === 'not_found') return null; throw reason; }
      if (row === null) return null;
      if (row.entry.id !== entryId) throw failure('intent_identity_mismatch');
      return observation(row);
    },
    async planWrite(input) {
      active();
      if (!input || !identity(input.operationId) || !identity(input.expectedEntryId) || !identity(input.expectedRevision)) throw failure('invalid_write_plan');
      const { operationId, path, expectedEntryId, expectedRevision, expectedContent, content } = input;
      let guard;
      if (Object.hasOwn(input, 'conditionalSavedSource')) {
        if (!conditionalSources) throw failure('unsupported_host_capability');
        guard = captureSavedSourceGuard(input.conditionalSavedSource);
        if (guard.logicalWitness.entryId !== expectedEntryId || guard.logicalWitness.revision !== expectedRevision || guard.logicalWitness.path !== path) throw failure('intent_identity_mismatch');
      }
      text(content); text(expectedContent);
      // Base64 is ASCII. Bound it before allocating the binary copy or JSON.
      const contentSize = Buffer.byteLength(content, 'utf8');
      const overhead = JSON.stringify({ operation_id: operationId, mutation: { type: 'write', id: expectedEntryId, expected: expectedRevision }, content_base64: '', ...(guard ? { source_capture: guard.captureId } : {}) }).length;
      if (overhead + 4 * Math.ceil(contentSize / 3) > LIMIT) throw failure('encoded_plan_too_large');
      const native = await service.planTextWrite(path, content, { operationId, entryId: expectedEntryId, expectedRevision, expectedContent });
      if (native.operation_id !== operationId || native.mutation.type !== 'write' || native.mutation.id !== expectedEntryId || native.mutation.expected !== expectedRevision) throw failure('intent_identity_mismatch');
      const encodedPlan = JSON.stringify({ ...native, ...(guard ? { source_capture: guard.captureId } : {}) });
      text(encodedPlan);
      return Object.freeze({ version: 1, vaultId, clientId, operationId, entryId: expectedEntryId, encodedPlan });
    },
    async prepare(plan) {
      const { native, sourceCapture } = parsePlan(plan);
      // Capture wrapper identities before awaiting host preparation.
      const operationId = plan.operationId, entryId = plan.entryId;
      const row = sourceCapture === undefined ? await service.prepareIntent(clientId, native) : await service.prepareIntent(clientId, native, sourceCapture);
      try {
        const result = view(row);
        if (result.ref.operationId !== operationId || result.ref.entryId !== entryId) throw failure('outcome_unknown', true);
        return result;
      } catch { throw failure('outcome_unknown', true); }
    },
    async commit(inputRef) {
      const ref = snapshotRef(inputRef);
      await required(ref);
      active(); // Caller still owns broker reauthorization immediately before this call.
      try {
        const result = view(await host.commitIntent(nativeRef(ref)), ref);
        if (result.state !== 'committed' && result.state !== 'rejected') throw failure('outcome_unknown', true);
        return result;
      } catch (reason) {
        // A request may have durably recorded authorization even if its reply
        // cannot be validated. Retain ref and reconcile, never manufacture a retry.
        if (reason?.commitUncertain) throw reason;
        throw failure('outcome_unknown', true);
      }
    },
    async query(inputRef) {
      const ref = snapshotRef(inputRef);
      const row = await host.queryIntent(nativeRef(ref));
      return row === null ? null : view(row, ref);
    },
    async listUnacknowledged() {
      active();
      const result = [];
      let cursor = '0';
      // Never return a partial list as complete. Retained history is bounded at
      // this consumer boundary until native filtered enumeration is available.
      for (let count = 0; count < 100; count++) {
        const page = await host.listIntents(clientId, cursor, 100);
        for (const row of page.intents) if (!row.acknowledged && row.mutation_kind === 'write') result.push(view(row));
        if (!page.has_more) return result;
        cursor = page.next_cursor;
      }
      throw failure('intent_enumeration_limit');
    },
    async acknowledge(inputRef, inputExpected) {
      const ref = snapshotRef(inputRef);
      if (!inputExpected) throw failure('intent_outcome_mismatch');
      const expected = Object.freeze({ ...inputExpected });
      const actual = view(await required(ref), ref);
      if (expected.operationId !== ref.operationId || !(expected.status === 'committed' && actual.state === 'committed' && expected.sequence === actual.receipt.sequence
        || expected.status === 'rejected' && actual.state === 'rejected' && expected.code === actual.error.code)) throw failure('intent_outcome_mismatch');
      const wire = expected.status === 'committed'
        ? { state: 'committed', operation_id: expected.operationId, sequence: expected.sequence }
        : { state: 'rejected', operation_id: expected.operationId, code: expected.code };
      const settled = view(await host.acknowledgeIntent(nativeRef(ref), wire), ref);
      if (!settled.acknowledged) throw failure('outcome_unknown', true);
    },
  });
}
module.exports = { desktopDurableWrites };
