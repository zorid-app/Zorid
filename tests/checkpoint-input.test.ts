import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedUtf8, checkpointKey, checkpointRevision, checkpointStateLimit, snapshotCheckpointChange } from '../src/core/checkpoint-input.ts';

test('checkpoint validation snapshots exact strings and counts UTF-8 without lossy surrogate replacement',()=>{
  const input={key:'draft',expectedRevision:null,nextRevision:'01234567-89ab-4cde-8123-0123456789ab',encodedState:'\uFEFF😀\r\n'};
  const result=snapshotCheckpointChange(input);input.encodedState='changed';
  assert.equal(result.byteLength,9);assert.equal(result.change.encodedState,'\uFEFF😀\r\n');assert.equal(Object.isFrozen(result.change),true);
  assert.throws(()=>boundedUtf8('\ud800',100),{code:'invalid_checkpoint'});
  assert.throws(()=>boundedUtf8('\udc00',100),{code:'invalid_checkpoint'});
});
test('checkpoint keys and UUID fences are bounded and canonical',()=>{
  checkpointKey('😀'.repeat(256));
  assert.throws(()=>checkpointKey('😀'.repeat(257)),{code:'invalid_checkpoint'});
  assert.throws(()=>checkpointKey(''),{code:'invalid_checkpoint'});
  assert.throws(()=>checkpointKey('nul\0key'),{code:'invalid_checkpoint'});
  checkpointRevision('01234567-89ab-4cde-8123-0123456789ab');
  assert.throws(()=>checkpointRevision('01234567-89AB-4cde-8123-0123456789ab'),{code:'invalid_checkpoint'});
});
test('checkpoint state admits exact 32 MiB and rejects overflow before transport allocation',()=>{
  const input={key:'large',expectedRevision:null,nextRevision:'01234567-89ab-4cde-8123-0123456789ab',encodedState:'a'.repeat(checkpointStateLimit)};
  assert.equal(snapshotCheckpointChange(input).byteLength,checkpointStateLimit);
  assert.throws(()=>snapshotCheckpointChange({...input,encodedState:input.encodedState+'a'}),{code:'checkpoint_too_large'});
  assert.equal(snapshotCheckpointChange({...input,encodedState:null}).byteLength,0);
});
