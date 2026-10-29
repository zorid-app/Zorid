'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createLazyDraftJournal}=require('../desktop/lazy-draft-journal.cjs');
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const scope={vaultId:'vault',clientId:'client',incarnationId:'document'};
test('failed opening retries the next owned request and successful binding survives later operation failure',async()=>{
  let opens=0,binds=0,failOperation=true;const owner={bind(actual,check){binds++;assert.deepEqual(actual,scope);check();return{list:async()=>{if(failOperation){failOperation=false;throw Error('Later operation failed');}return[];},revoke(){}};},close:async()=>{}};
  const proxy=createLazyDraftJournal(async()=>{if(++opens===1)throw Error('Open failed');return owner;}),lease=proxy.bind(scope,()=>{});
  assert.equal(opens,0);await assert.rejects(lease.list(),{code:'draft_storage_failure'});await assert.rejects(lease.list(),/Later operation failed/);assert.deepEqual(await lease.list(),[]);
  assert.equal(opens,2);assert.equal(binds,1,'successful bind must never repeat its incarnation');await proxy.close();
});
test('pending shared open snapshots requests and revocation denies obsolete bindings immediately',async()=>{
  const held=gate();let opens=0,binds=0,published;
  const proxy=createLazyDraftJournal(async()=>{opens++;await held.promise;return{bind(_scope,check){binds++;return{compareAndSwap:async value=>{check();published=value;return value;},revoke(){}};},close:async()=>{}};});
  const old=proxy.bind(scope,()=>{}),request={generation:1,baseline:{content:'Original'},draft:'Exact raw draft'},pending=old.compareAndSwap(request),rejection=assert.rejects(pending,{code:'draft_lease_revoked'});
  old.revoke();const current=proxy.bind({...scope,incarnationId:'fresh'},()=>{}),next=current.compareAndSwap(request);request.generation=2;request.baseline.content='Changed';request.draft='Changed';held.resolve();
  await rejection;await next;assert.equal(opens,1);assert.equal(binds,1);assert.equal(published.generation,1);assert.equal(published.baseline.content,'Original');assert.equal(published.draft,'Exact raw draft');await proxy.close();
});
test('close revokes wrappers before waiting for pending open and joins successful owner close',async()=>{
  const held=gate();let closed=false;const proxy=createLazyDraftJournal(async()=>{await held.promise;return{bind(){assert.fail('closed proxy must not bind');},close:async()=>{closed=true;}};});
  const lease=proxy.bind(scope,()=>{}),pending=lease.list(),rejected=assert.rejects(pending,{code:'draft_lease_revoked'}),closing=proxy.close();
  await assert.rejects(lease.list(),{code:'draft_lease_revoked'});held.resolve();await rejected;await closing;assert.equal(closed,true);
});
test('revocation after a real mutation result retains acknowledgement uncertainty',async()=>{
  let valid=true;const proxy=createLazyDraftJournal(async()=>({bind:()=>({compareAndSwap:async()=>{valid=false;return{revision:'1'};},revoke(){}}),close:async()=>{}})),lease=proxy.bind(scope,()=>valid);
  await assert.rejects(lease.compareAndSwap({draft:'retained'}),{code:'draft_lease_revoked',commitUncertain:true});await proxy.close();
});
