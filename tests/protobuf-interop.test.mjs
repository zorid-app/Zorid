import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { BinaryCommandSchema, BeginStageSchema, StageStatusSchema } from '../src/generated/zorid/stream/v1/binary_pb.ts';

// Also consumed by Rust tests. Fixtures are generated using standard protobuf-es,
// not a hand-written codec; exact bytes are a pinned test vector, not canonical.
const fixture = name => new Uint8Array(readFileSync(new URL(`../proto/fixtures/${name}.bin`, import.meta.url)));

test('raw chunk bytes and uint64 above 2^53 interoperate with Rust', () => {
  const bytes = fixture('append');
  const value = fromBinary(BinaryCommandSchema, bytes);
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.requiredFeatures, ['binary-stream-v1']);
  assert.equal(value.command.case, 'append');
  assert.equal(value.command.value.offset, 9007199254740993n);
  assert.equal(value.command.value.sequence, 2);
  assert.deepEqual(value.command.value.data, Uint8Array.of(0, 255, 128, 1));
  assert.equal(value.command.value.stage.operationId, 'operation');
  assert.deepEqual(toBinary(BinaryCommandSchema, value), bytes);
});

test('oneof and optional zero presence remain explicit', () => {
  const bytes = fixture('begin-empty');
  const value = fromBinary(BinaryCommandSchema, bytes);
  assert.equal(value.command.case, 'begin');
  assert.equal(value.command.value.expectedLength, 0n);
  assert.equal(value.command.value.target.target.case, 'create');
  assert.deepEqual(toBinary(BinaryCommandSchema, value), bytes);
  assert.equal(create(BeginStageSchema).expectedLength, undefined);
  assert.equal(create(BeginStageSchema).target, undefined);
  assert.equal(create(StageStatusSchema).state.case, undefined);
});

test('unknown required features must be validated after raw decoding', () => {
  const value = fromBinary(BinaryCommandSchema, fixture('required-future'));
  assert.deepEqual(value.requiredFeatures, ['future-critical-behavior']);
  assert.equal(value.command.case, undefined);
});

test('truncated length-delimited messages fail raw decoding', () => {
  const bytes = fixture('append');
  assert.throws(() => fromBinary(BinaryCommandSchema, bytes.subarray(0, bytes.length - 1)));
});
