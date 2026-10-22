import type { TextCreateReceipt } from './types.ts';

const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw Object.assign(new Error('The original text creation receipt is unavailable or does not match its captured request'), { code: 'invalid_create_receipt', commitUncertain: true }); }

/** Decode the original Rust CommitResult, never a current-path observation or
 * content equality. Native and browser use the same receipt identity rules. */
export function decodeTextCreateReceipt(raw: unknown, expected: { readonly operationId: string; readonly entryId: string; readonly path: string }): TextCreateReceipt {
  if (!object(raw) || raw.operation_id !== expected.operationId || !identity(raw.operation_id)
    || typeof raw.sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(raw.sequence) || BigInt(raw.sequence) > 18446744073709551615n
    || !Array.isArray(raw.changes) || !raw.changes.length || raw.changes.length > 8192) return invalid();
  const matches = raw.changes.filter(change => object(change) && object(change.after) && change.after.id === expected.entryId);
  if (matches.length !== 1) return invalid();
  const change = matches[0];
  if (!object(change) || change.before !== null || !object(change.after)) return invalid();
  const after = change.after;
  if (after.id !== expected.entryId || !identity(after.id) || !identity(after.revision) || after.path !== expected.path || after.kind !== 'file' || after.deleted !== false) return invalid();
  return Object.freeze({ operationId: raw.operation_id, entryId: after.id, revision: after.revision, path: expected.path, sequence: raw.sequence });
}
