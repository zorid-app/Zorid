'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const {createDraftJournalAdmissionManager}=require('../desktop/draft-journal-admission.cjs');

let nextWindow=10000;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const event=record=>({sender:record.window.webContents,senderFrame:record.window.webContents.mainFrame});
async function fixture(t,quiesceCore){
  const broker=new WindowBroker({allowedURL:url=>url==='file:///app/index.html',openVault:async root=>({root,subscribe:()=>()=>{}})});
  const records=[],journalCalls=[];
  const journal={bind(scope,check){check();return{revoke(){},list(){journalCalls.push('list');return[];}};}};
  const manager=createDraftJournalAdmissionManager({journal,broker,...(quiesceCore?{quiesceCore}:{})});
  async function add(){
    const window={isDestroyed:()=>false,webContents:{id:nextWindow++,isDestroyed:()=>false,mainFrame:{url:'file:///app/index.html'},send(){}}};
    const record=broker.register(window);record.clientSlot={clientId:'client-one'};
    await broker.select(record,'/vault-one');record.persistedVaultRoot='/vault-one';records.push(record);
    const grant=manager.attach(record,{admissionId:'core-one',scope:{vaultId:'vault-one',clientId:'client-one'}});
    return{record,grant,send:(target,token=grant.token)=>manager.dispatch(record,event(record),'/vault-one',token,{op:'isRetiredIncarnation',args:[target]})};
  }
  const first=await add();
  t.after(()=>{for(const record of records)manager.revoke(record);broker.dispose();});
  return{...first,manager,add,journalCalls};
}

test('no retired-owner certificate exists without the trusted core barrier',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.send('prior-incarnation'),{code:'draft_admission_denied'});
  assert.deepEqual(f.journalCalls,[]);
});

test('certifying an inactive incarnation waits for accepted core calls to settle',async t=>{
  const hold=deferred();let calls=0,settled=false;
  const f=await fixture(t,async(record,root,grant)=>{calls++;assert.equal(record,f.record);assert.equal(root,'/vault-one');assert.deepEqual(grant,f.grant);await hold.promise;});
  const result=f.send('prior-incarnation').finally(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(settled,false);
  hold.resolve();assert.equal(await result,true);assert.deepEqual(f.journalCalls,[]);
});

test('all registered live owners remain protected, including a temporarily blocked owner',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;});const other=await f.add();
  assert.equal(await f.send(f.grant.scope.incarnationId),false);
  other.record.vaultSelectionPending=true;
  assert.equal(await f.send(other.grant.scope.incarnationId),false);
  assert.equal(calls,0,'known live owners require no core or journal work');
  other.record.vaultSelectionPending=false;f.manager.revoke(other.record);
  assert.equal(await f.send(other.grant.scope.incarnationId),true);assert.equal(calls,1);
});

test('revocation and replacement during the barrier deny the old certificate',async t=>{
  const hold=deferred();const f=await fixture(t,()=>hold.promise);
  const pending=f.send('prior-incarnation');await new Promise(resolve=>setImmediate(resolve));
  f.manager.revoke(f.record);f.manager.attach(f.record,{admissionId:'core-two',scope:{vaultId:'vault-one',clientId:'client-one'}});
  hold.resolve();await assert.rejects(pending,{code:'draft_lease_revoked'});
});

test('a failed core barrier cannot turn unknown ownership into retirement',async t=>{
  const f=await fixture(t,async()=>{throw Object.assign(Error('unsettled'),{code:'draft_lease_revoked'});});
  await assert.rejects(f.send('prior-incarnation'),{code:'draft_lease_revoked'});
});

test('a false or malformed core barrier result cannot authorize retirement',async t=>{
  const f=await fixture(t,async()=>false);
  await assert.rejects(f.send('prior-incarnation'),{code:'draft_admission_denied'});
});

test('certificate requests cannot select another scope or execute array accessors',async t=>{
  let calls=0,executed=0;const f=await fixture(t,async()=>{calls++;});
  await assert.rejects(f.send('prior-incarnation','foreign-token'),{code:'draft_lease_revoked'});
  await assert.rejects(f.send({incarnationId:'prior',clientId:'foreign-client'}),{code:'invalid_draft_identity'});
  const args=[];Object.defineProperty(args,0,{get(){executed++;return'prior';},enumerable:true});
  await assert.rejects(f.manager.dispatch(f.record,event(f.record),'/vault-one',f.grant.token,{op:'isRetiredIncarnation',args}),{code:'invalid_draft_request'});
  assert.equal(executed,0);assert.equal(calls,0);
});
