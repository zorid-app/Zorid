// Intentional fixture refresh only. Review binary changes before committing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { create, toBinary } from '@bufbuild/protobuf';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { BinaryCommandSchema } from '../src/generated/zorid/stream/v1/binary_pb.ts';

import { AcceptedReplySchema, PullReplySchema, HelloRequestSchema } from '../src/generated/zorid/sync/rpc/v1/relay_pb.ts';

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
  'read-open': {schemaVersion:1,command:{case:'openRead',value:{owner,id:'entry',expectedRevision:'revision',readId:'read-operation'}}},
};
for (const [name, value] of Object.entries(fixtures)) {
  writeFileSync(new URL(`${name}.bin`, output), toBinary(BinaryCommandSchema, create(BinaryCommandSchema, value)));
}

const rpcFixtures = {
  'rpc-accepted': [AcceptedReplySchema, {transportMajor:2,vaultId:'vault',updateId:'update',serverEpoch:'epoch',sequence:9007199254740993n,control:{}}],
  'rpc-empty-page': [PullReplySchema, {transportMajor:2,items:[],next:{serverEpoch:'epoch',after:0n,control:{}},through:0n,complete:true,control:{}}],
  'rpc-incomplete-page': [PullReplySchema, {transportMajor:2,items:[{sequence:1n,exactWire:Uint8Array.of(0,255,128,1)}],next:{serverEpoch:'epoch',after:1n,control:{}},through:2n,complete:false,control:{}}],
};
for(const [name,[schema,value]] of Object.entries(rpcFixtures))writeFileSync(new URL(`${name}.bin`,output),toBinary(schema,create(schema,value)));

// Balanced unknown groups built only with the standard runtime writer. These
// fixtures check the standard decoder depth boundary, not a custom parser.
const hello = toBinary(HelloRequestSchema, create(HelloRequestSchema, {offeredTransportMajors:[2],control:{}}));
for (const depth of [8,128]) {
  const writer = new BinaryWriter().raw(hello);
  for (let i=0;i<depth;i++) writer.tag(100,WireType.StartGroup);
  for (let i=0;i<depth;i++) writer.tag(100,WireType.EndGroup);
  writeFileSync(new URL(`rpc-hello-groups-${depth}.bin`,output),writer.finish());
}
