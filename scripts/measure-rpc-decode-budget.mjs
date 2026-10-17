// Opt-in measurement, not an approved production resource bound. No parallel cases.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  AppendRequestSchema, HelloRequestSchema, HelloReplySchema, PullReplySchema,
} from '../src/generated/zorid/sync/rpc/v1/relay_pb.ts';

// Snapshot of root-approved RPC caps; Rust example uses production constants.
const CONTROL_CAP = 4096;
const APPEND_CAP = 1056816;
const PULL_CAP = 2138208;
const CASES = [
  'pull-items', 'append-extensions', 'pull-extensions', 'append-features',
  'pull-features', 'hello-packed', 'reply-packed', 'pull-truncated',
  'pull-unknown-retain', 'pull-unknown-discard',
];
const args = process.argv.slice(2);
let selected;
let iterations = 1;
let timeout = 30000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--list') { console.log(CASES.join('\n')); process.exit(0); }
  if (args[i] === '--case') { selected = args[++i]; assert(selected, '--case requires a name'); }
  else if (args[i] === '--iterations') iterations = Number(args[++i]);
  else if (args[i] === '--timeout-ms') timeout = Number(args[++i]);
  else throw new Error('Usage: measure-rpc-decode-budget.mjs [--list] [--case CASE] [--iterations 1..10] [--timeout-ms N]');
}
assert(Number.isInteger(iterations) && iterations >= 1 && iterations <= 10, 'iterations must be 1..10');
assert(Number.isInteger(timeout) && timeout >= 1 && timeout <= 120000, 'timeout must be 1..120000 ms');
if (selected === undefined) {
  for (const name of CASES) {
    // Each case receives a fresh process; the loop never overlaps decoders.
    const result = spawnSync(process.execPath, [
      '--expose-gc', fileURLToPath(import.meta.url), '--case', name, '--iterations', String(iterations),
    ], { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} else {
  assert(CASES.includes(selected), 'unknown case');
  assert.equal(typeof globalThis.gc, 'function', 'run selected cases with node --expose-gc');
  run(selected);
}

function basePull() {
  return {
    transportMajor: 2, control: {}, next: { serverEpoch: 'epoch', after: 0n, control: {} },
    through: 0n, complete: true,
  };
}
function baseAppend(control) {
  return {
    context: { transportMajor: 2, control }, vaultId: 'vault', updateId: 'update', exactWire: Uint8Array.of(0),
  };
}
function fit(schema, cap, unit, make) {
  let count = Math.floor(cap / unit);
  while (true) {
    // Fixture construction and encoding happen before the decoder memory baseline.
    const bytes = toBinary(schema, create(schema, make(count)));
    if (bytes.length <= cap) return { bytes, count, cap, schema };
    count -= Math.ceil((bytes.length - cap) / unit);
    assert(count >= 0, 'fixture overhead exceeds cap');
  }
}
function fixture(name) {
  if (name === 'pull-items' || name === 'pull-truncated') {
    const value = fit(PullReplySchema, PULL_CAP, 2, count => ({
      ...basePull(), items: Array.from({ length: count }, () => ({})),
    }));
    if (name === 'pull-truncated') value.bytes = value.bytes.subarray(0, value.bytes.length - 1);
    return value;
  }
  if (name.endsWith('-extensions') || name.endsWith('-features')) {
    const append = name.startsWith('append-');
    return fit(append ? AppendRequestSchema : PullReplySchema, append ? APPEND_CAP : PULL_CAP, 2, count => {
      const control = name.endsWith('-extensions')
        ? { optionalExtensions: Array.from({ length: count }, () => ({})) }
        : { requiredFeatures: Array(count).fill('') };
      return append ? baseAppend(control) : { ...basePull(), control };
    });
  }
  if (name === 'hello-packed') {
    return fit(HelloRequestSchema, CONTROL_CAP, 1, count => ({ offeredTransportMajors: Array(count).fill(0), control: {} }));
  }
  if (name === 'reply-packed') {
    return fit(HelloReplySchema, CONTROL_CAP, 1, count => ({
      selectedTransportMajor: 2, realmId: 'realm', serverEpoch: 'epoch', suite: 'xchacha20poly1305',
      maxWireBytes: 1052720n, maxPageWireBytes: 2105440n, maxPageItems: 64,
      envelopeVersions: Array(count).fill(0), control: {},
    }));
  }
  // HelloReply.control is tag 9, unknown to PullReply. Repeating whole standard
  // encoder outputs exercises protobuf merge/unknown behavior without a scanner,
  // custom wire encoder or descriptor reflection.
  const part = toBinary(HelloReplySchema, create(HelloReplySchema, { control: {} }));
  const count = Math.floor(PULL_CAP / part.length);
  const bytes = new Uint8Array(count * part.length);
  for (let i = 0; i < count; i++) bytes.set(part, i * part.length);
  return { bytes, count, cap: PULL_CAP, schema: PullReplySchema };
}
function memory() {
  return { ...process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS };
}
function delta(after, before) {
  return Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
}
function counts(value) {
  const control = value.context?.control ?? value.control;
  return {
    items: value.items?.length ?? 0,
    extensions: control?.optionalExtensions?.length ?? 0,
    features: control?.requiredFeatures?.length ?? 0,
    offered: value.offeredTransportMajors?.length ?? 0,
    envelopeVersions: value.envelopeVersions?.length ?? 0,
    unknownFields: value.$unknown?.length ?? 0,
  };
}
function run(name) {
  const { bytes, count, cap, schema } = fixture(name);
  assert(bytes.length <= cap, 'fixture must fit the approved method frame cap');
  const readUnknownFields = name !== 'pull-unknown-discard';
  const options = { readUnknownFields, recursionLimit: 100 };
  // Warm the pinned runtime's generated reader, then collect fixture builder
  // temporaries. The encoded input remains live throughout every measurement.
  fromBinary(schema, new Uint8Array(), options);
  globalThis.gc();
  const fixtureBaseline = memory();
  const measurements = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    globalThis.gc();
    const before = memory();
    const started = performance.now();
    let value;
    let decoded = false;
    try { value = fromBinary(schema, bytes, options); decoded = true; }
    catch (error) {
      if (name !== 'pull-truncated') throw error;
    }
    const decodeMs = performance.now() - started;
    const afterDecode = memory(); // Before allocating report/count objects.
    const observed = decoded ? counts(value) : undefined;
    assert.equal(decoded, name !== 'pull-truncated', 'unexpected wire decode outcome');
    if (name === 'pull-unknown-retain') assert.equal(observed.unknownFields, count);
    if (name === 'pull-unknown-discard') assert.equal(observed.unknownFields, 0);
    value = undefined;
    globalThis.gc();
    const afterDrop = memory();
    measurements.push({ iteration, decoded, decodeMs, observed, before, afterDecode, afterDrop,
      decodeDelta: delta(afterDecode, before), retainedDelta: delta(afterDrop, before) });
  }
  console.log(JSON.stringify({
    case: name, runtime: 'protobuf-es', node: process.version, wireBytes: bytes.length,
    frameCap: cap, fixtureElements: count, readUnknownFields, recursionLimit: options.recursionLimit,
    domainValidation: 'not run; production Rust validation is measured by the Rust companion',
    fixtureBaseline, measurements,
    limitations: 'single decode; heap snapshots are sampled, not allocation peaks; maxRSS includes fixture construction and cannot reset; no approved resource bound',
  }));
}
