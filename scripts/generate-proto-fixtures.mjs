// Intentional fixture refresh only. Review binary changes before committing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { create, toBinary } from '@bufbuild/protobuf';
import { BinaryCommandSchema } from '../src/generated/zorid/stream/v1/binary_pb.ts';

const output = new URL('../proto/fixtures/', import.meta.url);
mkdirSync(output, { recursive: true });
const owner = { localStoreId: 'store', clientId: 'client' };
const fixtures = {
  append: {
    schemaVersion: 1, requiredFeatures: ['binary-stream-v1'],
    command: { case: 'append', value: {
      stage: { ...owner, operationId: 'operation', stageId: 'stage' },
      sequence: 2, offset: 9007199254740993n, data: Uint8Array.of(0, 255, 128, 1),
    } },
  },
  'begin-empty': {
    schemaVersion: 1,
    command: { case: 'begin', value: {
      owner, operationId: 'operation', expectedLength: 0n,
      target: { target: { case: 'create', value: { id: 'entry', path: 'Empty.bin' } } },
    } },
  },
  'required-future': { schemaVersion: 1, requiredFeatures: ['future-critical-behavior'] },
};
for (const [name, value] of Object.entries(fixtures)) {
  writeFileSync(new URL(`${name}.bin`, output), toBinary(BinaryCommandSchema, create(BinaryCommandSchema, value)));
}
