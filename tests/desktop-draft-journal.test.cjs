'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {openDraftJournal} = require('../desktop/draft-journal.cjs');

const scope = {vaultId:'local-vault',clientId:'client-one',incarnationId:'renderer-one'};
const change = (overrides={}) => ({entryId:'entry-one',writer:'checkpoint-writer',generation:1,
  expectedRevision:null,nextRevision:'1',baseline:{entryId:'entry-one',path:'Note.md',revision:'source-one',content:'Original body'},
  draft:'Protected body\n🌱\ud800',checkpointRevision:null,pendingOperation:null,...overrides});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-draft-journal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return path.join(directory,'journal');
}

test('acknowledged draft survives a fresh journal owner without the Rust host',async t=>{
  const directory=await fixture(t), journal=await openDraftJournal(directory), lease=journal.bind(scope);
  const receipt=await lease.compareAndSwap(change());
  assert.equal(receipt.revision,'1');
  lease.revoke();
  // Simulate profile ownership transfer after the old main process exits.
  const next=await openDraftJournal(directory), recovery=next.bind({...scope,incarnationId:'renderer-two'});
  const candidates=await recovery.list();
  assert.equal(candidates.length,1);
  const restored=await recovery.read(candidates[0]);
  assert.equal(restored.draft,'Protected body\n🌱\ud800');
  assert.deepEqual(restored.baseline,{entryId:'entry-one',path:'Note.md',revision:'source-one',content:'Original body'});
  assert.equal(restored.writer,'checkpoint-writer');
  assert.equal(restored.incarnationId,'renderer-one');
  assert.equal(restored.generation,1);
});
