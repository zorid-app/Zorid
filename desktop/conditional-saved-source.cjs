'use strict';
// Pure optional-capability data boundary. Native owns capture authority,
// physical bytes, expiry and durable guard attachment; this module owns no IO.
const SOURCE_LIMIT = 8 * 1024 * 1024;
const PATH_LIMIT = 4096;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail = () => Object.assign(new Error('Invalid conditional saved-source data.'), { code: 'invalid_saved_source', source: 'host', commitUncertain: false });
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertyNames(value).length !== names.length || Object.getOwnPropertySymbols(value).length) return false;
  return names.every(name => {
    const field = Object.getOwnPropertyDescriptor(value, name);
    return field && field.enumerable && Object.hasOwn(field, 'value');
  });
}
function utf8Length(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw fail();
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw fail();
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw fail();
    else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (bytes > limit) throw fail();
  }
  return bytes;
}
function relative(value) {
  utf8Length(value, PATH_LIMIT);
  if (!value || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)
    || /^\.zorid(?:\/|$)/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw fail();
  return value;
}
function captureSavedSourceWitness(value) {
  if (!fields(value, ['entryId', 'revision', 'path']) || !identity(value.entryId) || !identity(value.revision)) throw fail();
  return Object.freeze({ entryId: value.entryId, revision: value.revision, path: relative(value.path) });
}
function captureSavedSourceId(value) { if (!identity(value)) throw fail(); return value; }
function captureSavedSourceGuard(value) {
  if (!fields(value, ['captureId', 'logicalWitness'])) throw fail();
  return Object.freeze({ captureId: captureSavedSourceId(value.captureId), logicalWitness: captureSavedSourceWitness(value.logicalWitness) });
}
function captureSavedSourceRequest(value) {
  if (!fields(value, ['captureId', 'logicalWitness']) || !uuid(value.captureId)) throw fail();
  return Object.freeze({ captureId: value.captureId, logicalWitness: captureSavedSourceWitness(value.logicalWitness) });
}
function sameWitness(left, right) { return left.entryId === right.entryId && left.revision === right.revision && left.path === right.path; }
function captureSavedSourceValue(value, expected) {
  const request = captureSavedSourceRequest(expected);
  if (!fields(value, ['captureId', 'logicalWitness', 'source'])) throw fail();
  const guard = captureSavedSourceGuard({ captureId: value.captureId, logicalWitness: value.logicalWitness });
  if (guard.captureId !== request.captureId || !sameWitness(guard.logicalWitness, request.logicalWitness)) throw fail();
  utf8Length(value.source, SOURCE_LIMIT);
  return Object.freeze({ ...guard, source: value.source });
}
function validSavedSourceReply(command, result, bytes) {
  try {
    if (!fields(result, ['capture']) || !fields(result.capture, ['capture_id', 'logical_witness', 'byte_length'])
      || !fields(result.capture.logical_witness, ['entry_id', 'revision', 'path']) || !uuid(command.capture_id) || result.capture.capture_id !== command.capture_id
      || !(bytes instanceof Uint8Array) || bytes.byteLength > SOURCE_LIMIT || !Number.isSafeInteger(result.capture.byte_length)
      || result.capture.byte_length !== bytes.byteLength) return false;
    const witness = captureSavedSourceWitness({ entryId: result.capture.logical_witness.entry_id, revision: result.capture.logical_witness.revision, path: result.capture.logical_witness.path });
    return sameWitness(witness, { entryId: command.entry_id, revision: command.revision, path: command.path });
  } catch { return false; }
}
function decodeSavedSourceReply(command, result, bytes) {
  if (!validSavedSourceReply(command, result, bytes)) throw fail();
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail(); }
  return captureSavedSourceValue({ captureId: result.capture.capture_id, logicalWitness: {
    entryId: result.capture.logical_witness.entry_id, revision: result.capture.logical_witness.revision, path: result.capture.logical_witness.path,
  }, source }, { captureId: command.capture_id, logicalWitness: { entryId: command.entry_id, revision: command.revision, path: command.path } });
}
function captureSavedSourceRequests(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 8
    || Object.getOwnPropertyNames(value).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) throw fail();
  const seen = new Set(), requests = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) throw fail();
    const row = field.value;
    if (!fields(row, ['captureId', 'logicalWitness', 'legacy']) || typeof row.legacy !== 'boolean'
      || !(row.legacy ? identity(row.captureId) : uuid(row.captureId)) || seen.has(row.captureId)) throw fail();
    seen.add(row.captureId);
    requests.push(Object.freeze({ captureId: row.captureId, logicalWitness: captureSavedSourceWitness(row.logicalWitness), legacy: row.legacy }));
  }
  return Object.freeze(requests);
}
function decodeSavedSourceRequestsReply(value) {
  if (!fields(value, ['requests'])) throw fail();
  // Validate the wire array before mapping, without invoking caller accessors.
  const rows = value.requests;
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 8
    || Object.getOwnPropertyNames(rows).length !== rows.length + 1 || Object.getOwnPropertySymbols(rows).length) throw fail();
  const mapped = [];
  for (let index = 0; index < rows.length; index++) {
    const field = Object.getOwnPropertyDescriptor(rows, String(index));
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) throw fail();
    const row = field.value;
    if (!fields(row, ['capture_id', 'logical_witness', 'legacy']) || !fields(row.logical_witness, ['entry_id', 'revision', 'path'])) throw fail();
    mapped.push({ captureId: row.capture_id, logicalWitness: { entryId: row.logical_witness.entry_id, revision: row.logical_witness.revision, path: row.logical_witness.path }, legacy: row.legacy });
  }
  return captureSavedSourceRequests(mapped);
}
function validSavedSourceRequestsReply(value) {
  try { decodeSavedSourceRequestsReply(value); return true; } catch { return false; }
}
module.exports = { SOURCE_LIMIT, PATH_LIMIT, captureSavedSourceWitness, captureSavedSourceId, captureSavedSourceGuard, captureSavedSourceRequest, captureSavedSourceValue, captureSavedSourceRequests, validSavedSourceReply, decodeSavedSourceReply, validSavedSourceRequestsReply, decodeSavedSourceRequestsReply };
