import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

// Build once before running: cargo build -p zorid-crdt --example interop -j 1.
// Override for an external CARGO_TARGET_DIR or Windows executable.
const binary = process.env.ZORID_CRDT_INTEROP_BIN ?? fileURLToPath(new URL('../../target/debug/examples/interop', import.meta.url));
const bytes = value => Array.from(value);
const apply = (doc, update) => Y.applyUpdate(doc, Uint8Array.from(update));
const text = doc => doc.getText('content').toString();
function native(actor, updates, operations = [], remote_state_vector = null) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ actor, updates, operations, remote_state_vector }),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function browser(actor, updates = []) {
  const doc = new Y.Doc();
  doc.clientID = actor; // Deterministic, unique fixture actor; not production allocation.
  doc.getText('content');
  for (const update of updates) apply(doc, update);
  return doc;
}
const insert = (index, value) => ({ op: 'insert', index, text: value });
const remove = (index, length) => ({ op: 'delete', index, length });

// Native seed -> independent JS and native offline edits -> both merge -> native restart.
const seed = native(1, [], [insert(0, 'Hello 🦀 world')]);
const js = browser(2, [seed.snapshot]);
const jsBefore = bytes(Y.encodeStateVector(js));
js.getText('content').delete(9, 5);
js.getText('content').insert(9, '世界');
const jsUpdate = bytes(Y.encodeStateAsUpdate(js, Uint8Array.from(jsBefore)));
const rust = native(3, [seed.snapshot], [insert(8, ' Rust'), insert(13, '!')]);
apply(js, rust.diff);
apply(js, rust.diff);
const merged = native(4, [seed.snapshot, rust.diff, jsUpdate, jsUpdate], [], bytes(Y.encodeStateVector(js)));
assert.equal(text(js), 'Hello 🦀 Rust! 世界');
assert.equal(merged.text, text(js));
apply(js, merged.diff);
assert.equal(text(js), merged.text);
assert.equal(native(5, [merged.snapshot]).text, merged.text);

// JS changes depend on earlier unsent changes: reverse delivery, then duplicates.
const author = browser(10);
author.getText('content').insert(0, 'a🦀z');
const jsSeed = bytes(Y.encodeStateAsUpdate(author));
let vector = Y.encodeStateVector(author);
author.getText('content').insert(3, ' first');
const first = bytes(Y.encodeStateAsUpdate(author, vector));
vector = Y.encodeStateVector(author);
author.getText('content').insert(9, ' second');
author.getText('content').delete(0, 1);
const second = bytes(Y.encodeStateAsUpdate(author, vector));
const reverse = native(11, [second, second, jsSeed, first, first]);
assert.equal(reverse.text, text(author));
assert.equal(reverse.text, '🦀 first secondz');
const replay = browser(12, [reverse.snapshot]);
assert.equal(text(replay), text(author));

// Native incremental updates in reverse order are also integrated by Yjs.
const n1 = native(20, [], [insert(0, 'a🦀z')]);
const n2 = native(21, [n1.snapshot], [insert(3, ' first')]);
const n3 = native(22, [n2.snapshot], [insert(9, ' second'), remove(0, 1)]);
const reverseJs = browser(23, [n3.diff, n3.diff, n1.snapshot, n2.diff, n2.diff]);
assert.equal(text(reverseJs), n3.text);
assert.equal(text(reverseJs), '🦀 first secondz');

// A deletion advances the delete set, not the insertion state vector. Exchange it
// even when vectors are equal; vector equality must never stand in for saved/synced.
const deletionJs = browser(30, [seed.snapshot]);
const beforeDelete = bytes(Y.encodeStateVector(deletionJs));
deletionJs.getText('content').delete(9, 5);
assert.deepEqual(bytes(Y.encodeStateVector(deletionJs)), beforeDelete);
const deletionRust = native(31, [seed.snapshot, bytes(Y.encodeStateAsUpdate(deletionJs, Uint8Array.from(beforeDelete)))]);
assert.equal(deletionRust.text, 'Hello 🦀 ');
const nativeDelete = native(32, [seed.snapshot], [remove(9, 5)], seed.state_vector);
const deletionReceiver = browser(33, [seed.snapshot, nativeDelete.diff]);
assert.equal(text(deletionReceiver), 'Hello 🦀 ');

// Deterministic diverse UTF-16 content: combining marks, RTL, CJK, ZWJ emoji.
const unicode = 'A e\u0301 العربية 中文 👩‍💻\n';
const unicodeSeed = native(40, [], [insert(0, unicode)]);
const unicodeJs = browser(41, [unicodeSeed.snapshot]);
unicodeJs.getText('content').insert(unicode.length, 'tail');
const unicodeRust = native(42, [unicodeSeed.snapshot], [insert(2, 'native ')]);
apply(unicodeJs, unicodeRust.diff);
const unicodeMerged = native(43, [unicodeRust.snapshot, bytes(Y.encodeStateAsUpdate(unicodeJs))]);
assert.equal(unicodeMerged.text, text(unicodeJs));
assert.equal(unicodeMerged.text, 'A native e\u0301 العربية 中文 👩‍💻\ntail');

for (const doc of [js, author, replay, reverseJs, deletionJs, deletionReceiver, unicodeJs]) doc.destroy();
console.log('PASS: native↔Yjs concurrent text, duplicates, out-of-order dependencies, state-vector catch-up, deletion-only delivery, UTF-16, restart replay');
