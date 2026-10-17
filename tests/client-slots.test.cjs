'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {openClientSlots} = require('../desktop/client-slots.cjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-client-slots-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  return path.join(directory,'client-slots.json');
}
test('primary and concurrent secondary claims stay distinct and reload cannot duplicate a claim',async t => {
  const registry = await openClientSlots(await fixture(t));
  const [primary,a,b] = await Promise.all([registry.claim({primary:true}),registry.claim(),registry.claim()]);
  assert.equal(new Set([primary.clientId,a.clientId,b.clientId]).size,3);
  await assert.rejects(registry.claim({slotId:a.slotId}),{code:'client_slot_in_use'});
  await assert.rejects(registry.claim({primary:true}),{code:'client_slot_in_use'});
});
test('crash restart restores exact client identities and vault ownership',async t => {
  const file = await fixture(t), first = await openClientSlots(file);
  const primary = await first.claim({primary:true}), secondary = await first.claim();
  await first.setVault(primary.slotId,path.resolve('/vault-primary'));
  await first.setVault(secondary.slotId,path.resolve('/vault-secondary'));
  // Simulates next process after OS singleton lock transfers; old registry unused.
  const next = await openClientSlots(file), restored = await next.listRestorable();
  assert.equal(restored.length,1); assert.equal(restored[0].clientId,secondary.clientId);
  assert.equal((await next.claim({primary:true})).clientId,primary.clientId);
  assert.equal((await next.claim({slotId:secondary.slotId})).vaultPath,path.resolve('/vault-secondary'));
});
test('clean close reuses a slot and normal app quit retains secondary restoration',async t => {
  const file=await fixture(t), registry=await openClientSlots(file), original=await registry.claim();
  await registry.release(original.slotId,{restore:false});
  assert.deepEqual(await registry.listRestorable(),[]);
  const reused=await registry.claim();assert.equal(reused.clientId,original.clientId);
  await registry.release(reused.slotId,{restore:true});
  const next=await openClientSlots(file);assert.equal((await next.listRestorable())[0].slotId,original.slotId);
  const other=await next.claim();assert.notEqual(other.slotId,original.slotId,'pending restoration slot cannot be stolen');
});
test('malformed or duplicate identity registry never silently rotates clients',async t => {
  const file=await fixture(t), registry=await openClientSlots(file), row=await registry.claim({primary:true});
  await fs.writeFile(file,JSON.stringify({version:1,slots:[row,{...row,slotId:'window-'+row.clientId}]}));
  await assert.rejects(openClientSlots(file),{code:'invalid_client_registry'});
  await fs.writeFile(file,'not json');await assert.rejects(openClientSlots(file));
  assert.equal(await fs.readFile(file,'utf8'),'not json');
});
