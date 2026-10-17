import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Shared by Yjs/native and browser-WASM/native fixtures. This invokes the actual
// Rust example executable; it never delegates Rust operations to JavaScript.
const binary = process.env.ZORID_CRDT_INTEROP_BIN ?? fileURLToPath(new URL('../../target/debug/examples/interop', import.meta.url));
export function native(actor, updates, operations = [], remote_state_vector = null) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ actor, updates, operations, remote_state_vector }),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
