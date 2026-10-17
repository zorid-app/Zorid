'use strict';
// Validation for the private native fixture transport, never sync wire decoding.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const scope = value => object(value) && id(value.realm_id) && id(value.vault_id);
const sameScope = (a, b) => scope(a) && scope(b) && a.realm_id === b.realm_id && a.vault_id === b.vault_id;
function familyStatus(value) {
  if (!object(value) || !scope(value.scope) || !object(value.limits)
    || !['max_file_bytes', 'max_graph_encoded_bytes', 'max_records'].every(key => Number.isSafeInteger(value.limits[key]) && value.limits[key] > 0)
    || !count(value.graph_records) || value.graph_records > value.limits.max_records
    || !Number.isSafeInteger(value.graph_encoded_bytes) || value.graph_encoded_bytes < 0 || value.graph_encoded_bytes > value.limits.max_graph_encoded_bytes
    || !['pending_authored', 'pending_dependencies', 'pending_projection', 'recovery_entries'].every(key => decimal(value[key]))) return false;
  return value.cursor === null || object(value.cursor) && sameScope(value.cursor, value.scope)
    && id(value.cursor.server_epoch) && decimal(value.cursor.after);
}
function syncStatus(value) {
  if (!object(value) || value.scope !== 'fixture_families_v2' || value.family_sync_supported !== true
    || value.all_file_sync_supported !== false || value.synced !== false || !familyStatus(value.family)
    || !Array.isArray(value.pending_envelopes) || value.pending_envelopes.length > 1000
    || value.pending_envelope_sample !== value.pending_envelopes.length
    || value.pending_envelope_sample_complete !== (value.pending_envelopes.length < 1000)
    || !Array.isArray(value.unsupported_capabilities) || value.unsupported_capabilities.length > 32
    || !value.unsupported_capabilities.every(item => typeof item === 'string' && /^[a-z_]{1,64}$/.test(item))
    || !value.unsupported_capabilities.includes('production_enrollment')) return false;
  let previous = '';
  for (const pending of value.pending_envelopes) {
    if (!object(pending) || !sameScope(pending.scope, value.family.scope) || !id(pending.update_id)
      || pending.update_id <= previous || !['text', 'files'].includes(pending.family)
      || typeof pending.sealed !== 'boolean' || pending.accepted !== false) return false;
    previous = pending.update_id;
  }
  return true;
}
function syncReport(value, command) {
  if (!syncStatus(value) || !['server_accepted', 'locally_received', 'locally_applied_updates', 'duplicate_receipts',
    'dependency_pending_receipts', 'receive_projection_pending'].every(key => count(value[key]))
    || value.server_accepted > command.max_push || value.locally_received > command.max_pages * 64
    || typeof value.pull_snapshot_complete !== 'boolean') return false;
  for (const key of ['locally_applied_updates', 'duplicate_receipts', 'dependency_pending_receipts', 'receive_projection_pending']) {
    if (value[key] > value.locally_received) return false;
  }
  return command.max_pages === 0
    ? value.pull_through === null && !value.pull_snapshot_complete && value.locally_received === 0
    : decimal(value.pull_through);
}
function familyCommand(value) {
  if (!object(value) || value.version !== 1 || !Object.hasOwn(value, 'create_mode') || !object(value.request)
    || !id(value.request.operation_id) || !object(value.request.mutation) || !id(value.request.mutation.id)) return false;
  const mutation = value.request.mutation;
  if (!['create', 'write', 'move', 'delete'].includes(mutation.type)) return false;
  return mutation.type === 'create' && mutation.kind === 'file'
    ? value.create_mode === 'text' || value.create_mode === 'binary' : value.create_mode === null;
}
module.exports = { familyStatus, syncStatus, syncReport, familyCommand };
