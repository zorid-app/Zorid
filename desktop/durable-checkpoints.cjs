'use strict';
const MAX_STATE = 32 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const number = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
function fail(code, uncertain = false) { return Object.assign(new Error('Durable checkpoint request failed.'), { code, commitUncertain: uncertain }); }
function validText(value, limit) {
  if (typeof value !== 'string') throw fail('checkpoint_invalid');
  if (value.length > limit) throw fail('checkpoint_limit');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw fail('checkpoint_invalid');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw fail('checkpoint_invalid');
  }
  if (Buffer.byteLength(value, 'utf8') > limit) throw fail('checkpoint_limit');
}
function key(value) { validText(value, 1024); if (!value.length || value.includes('\0')) throw fail('checkpoint_invalid'); return value; }
/** Called by transport before allocation, including for direct private callers. */
function checkpointBytes(value) {
  if (value === null) return Buffer.alloc(0);
  validText(value, MAX_STATE);
  return Buffer.from(value, 'utf8');
}
/** @returns {import('../src/core/durable-checkpoints').DurableCheckpoints} */
function desktopCheckpoints(host, providedScope, active) {
  const scope = Object.freeze({ vaultId: providedScope.vaultId, clientId: providedScope.clientId });
  function bound(value) { if (value?.vaultId !== scope.vaultId || value?.clientId !== scope.clientId) throw fail('checkpoint_scope_mismatch'); }
  function checkpoint(value, requestedKey) {
    if (value === null) return null;
    bound(value);
    if (value.key !== requestedKey) throw fail('checkpoint_scope_mismatch');
    return Object.freeze({ ...value });
  }
  function options(value, changes) {
    active();
    const captured = { limit: value?.limit, cursor: value?.cursor, ...(changes ? { after: value?.after } : {}) };
    if (!Number.isSafeInteger(captured.limit) || captured.limit < 1 || captured.limit > 1000) throw fail('checkpoint_limit');
    if (captured.cursor !== undefined) { validText(captured.cursor, 2048); if (!captured.cursor) throw fail('checkpoint_invalid'); }
    if (changes && !number(captured.after)) throw fail('checkpoint_invalid');
    return Object.freeze(captured);
  }
  function page(value) {
    for (const item of value.items) bound(item);
    return Object.freeze({ ...value, items: Object.freeze(value.items.map(item => Object.freeze({ ...item }))) });
  }
  async function readPage(input, changes) {
    let requested = options(input, changes);
    for (;;) {
      try { return page(await (changes ? host.checkpointChanges(scope, requested) : host.checkpointList(scope, requested))); }
      catch (reason) {
        if (reason?.code !== 'response_limit' || requested.limit <= 1) throw reason;
        requested = Object.freeze({ ...requested, limit: Math.max(1, Math.floor(requested.limit / 2)) });
      }
    }
  }
  return Object.freeze({
    scope,
    async load(inputKey) { active(); const captured = key(inputKey); return checkpoint(await host.checkpointLoad(scope, captured), captured); },
    async compareAndSwap(input) {
      active();
      const change = Object.freeze({ key: key(input?.key), expectedRevision: input.expectedRevision,
        nextRevision: input.nextRevision, encodedState: input.encodedState });
      if (!(change.expectedRevision === null || uuid(change.expectedRevision)) || !uuid(change.nextRevision)) throw fail('checkpoint_invalid');
      if (change.encodedState !== null) validText(change.encodedState, MAX_STATE);
      const value = await host.checkpointCompareAndSwap(scope, change);
      // Invalid replies after CAS never prove that the checkpoint failed to commit.
      try {
        const result = checkpoint(value, change.key);
        if (!result || result.revision !== change.nextRevision || result.encodedState !== change.encodedState) throw fail('outcome_unknown', true);
        return result;
      } catch { throw fail('outcome_unknown', true); }
    },
    async list(input) { return readPage(input, false); },
    async changes(input) { return readPage(input, true); },
  });
}
module.exports = { desktopCheckpoints, checkpointBytes };
