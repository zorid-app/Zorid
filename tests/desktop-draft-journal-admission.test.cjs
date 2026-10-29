'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const {openDraftJournal}=require('../desktop/draft-journal.cjs');
const {createDraftJournalAdmissionManager}=require('../desktop/draft-journal-admission.cjs');

let nextWindow=1;
const windowStub=()=>({isDestroyed:()=>false,webContents:{id:nextWindow++,isDestroyed:()=>false,mainFrame:{url:'file:///app/index.html'},send(){}}});
const event=record=>({sender:record.window.webContents,senderFrame:record.window.webContents.mainFrame});
const change=(overrides={})=>({entryId:'entry-one',writer:'writer-one',generation:1,expectedRevision:null,nextRevision:'1',baseline:{entryId:'entry-one',path:'Note.md',revision:'source-one',content:'Original'},draft:'Protected 🌱\ud800',checkpointRevision:null,pendingOperation:null,...overrides});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function fixture(t,fileSystem){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-journal-admission-'));
  const journal=await openDraftJournal(path.join(directory,'journal'),{...(fileSystem?{fileSystem}:{})});
  const broker=new WindowBroker({allowedURL:url=>url==='file:///app/index.html',openVault:async root=>({root,subscribe:()=>()=>{},host:{exited:false}})});
  const record=broker.register(windowStub(),{primary:true});record.clientSlot={clientId:'client-one',slotId:'primary'};
  await broker.select(record,'/vault-one');record.persistedVaultRoot='/vault-one';
  const manager=createDraftJournalAdmissionManager({journal,broker}),context={admissionId:'core-one',scope:{vaultId:'vault-one',clientId:'client-one'}};
  const grant=manager.attach(record,context);
  t.after(async()=>{manager.revoke(record);broker.dispose();await journal.close();await fs.rm(directory,{recursive:true,force:true});});
  return{journal,broker,record,manager,context,grant,send:(op,args=[],token=grant.token)=>manager.dispatch(record,event(record),'/vault-one',token,{op,args})};
}

test('trusted attachment is stable for one document and independent of Rust host replacement',async t=>{
  const f=await fixture(t),initial=f.manager.attach(f.record,f.context);assert.deepEqual(initial,f.grant);
  f.record.vault.service.host.exited=true;f.record.vault.service.closed=true;
  assert.equal((await f.send('compareAndSwap',[change()])).revision,'1');
  f.record.vault.service={root:'/vault-one',get host(){throw Error('journal must not contact Rust');}};
  assert.deepEqual(f.manager.attach(f.record,{...f.context,admissionId:'core-two'}),f.grant);
  assert.equal((await f.send('read',[{entryId:'entry-one',writer:'writer-one'}])).draft,change().draft);
  assert.throws(()=>f.manager.attach(f.record,{scope:{vaultId:'vault-one',clientId:'foreign-client'}}),{code:'draft_admission_denied'});
});

test('fresh document incarnation can recover same-client history but cannot CAS a prior incarnation',async t=>{
  const f=await fixture(t),receipt=await f.send('compareAndSwap',[change()]);f.manager.revoke(f.record);f.manager.revoke(f.record);
  await assert.rejects(f.send('list'),{code:'draft_lease_revoked'});
  const fresh=f.manager.attach(f.record,f.context);assert.notEqual(fresh.token,f.grant.token);assert.notEqual(fresh.scope.incarnationId,f.grant.scope.incarnationId);
  const send=(op,args=[])=>f.send(op,args,fresh.token);
  assert.deepEqual(await send('list'),[receipt]);assert.equal((await send('read',[receipt])).draft,change().draft);
  await assert.rejects(send('compareAndSwap',[change({incarnationId:receipt.incarnationId,expectedRevision:'1',nextRevision:'2'})]),{code:'invalid_draft_identity'});
  const retired=await send('retire',[receipt]);assert.equal(retired.deleted,true);assert.equal(retired.revision,'2');assert.deepEqual(await send('list'),[]);
  assert.deepEqual(await send('retire',[receipt]),retired,'exact retirement retry retains the same counter');
});

test('actual WindowBroker authentication rejects spoofed windows, frames, tokens and roots before storage',async t=>{
  const f=await fixture(t),dispatch=(record,ev,root,token)=>f.manager.dispatch(record,ev,root,token,{op:'list',args:[]});
  await assert.rejects(dispatch(f.record,{...event(f.record),sender:{...f.record.window.webContents}},'/vault-one',f.grant.token),{code:'draft_admission_denied'});
  await assert.rejects(dispatch(f.record,{...event(f.record),senderFrame:{}},'/vault-one',f.grant.token),{code:'draft_admission_denied'});
  await assert.rejects(dispatch(f.record,event(f.record),'/vault-one/../foreign',f.grant.token),{code:'draft_admission_denied'});
  await assert.rejects(dispatch(f.record,event(f.record),'/vault-one','forged-token'),{code:'draft_lease_revoked'});
  const other=f.broker.register(windowStub());other.clientSlot={clientId:'client-two',slotId:'other'};f.broker.bind(other,f.record.vault);
  await assert.rejects(dispatch(other,event(other),'/vault-one',f.grant.token),{code:'draft_lease_revoked'});
  await assert.rejects(dispatch(f.record,event(other),'/vault-one',f.grant.token),{code:'draft_admission_denied'});
  assert.deepEqual(await f.send('list'),[]);
});

for(const retire of ['generation','vault','frame','page','window','slot'])test(`old journal admission is denied after ${retire} replacement`,async t=>{
  const f=await fixture(t);
  if(retire==='generation')f.record.generation++;
  if(retire==='vault')await f.broker.select(f.record,'/vault-two');
  if(retire==='frame')f.record.window.webContents.mainFrame={url:'file:///app/index.html'};
  if(retire==='page')f.record.window.webContents.mainFrame.url='https://foreign.test/';
  if(retire==='window')f.broker.remove(f.record);
  if(retire==='slot')f.record.clientSlot={clientId:'client-two',slotId:'other'};
  await assert.rejects(f.send('compareAndSwap',[change()]),error=>['draft_admission_denied','draft_lease_revoked'].includes(error.code));
});

test('strict request allowlist rejects foreign scopes, traversal, unsafe shapes and arbitrary methods',async t=>{
  const f=await fixture(t),bad=[
    {op:'bind',args:[f.context.scope]},{op:'revoke',args:[]},{op:'__proto__',args:[]},{op:'list',args:['unexpected']},{op:'list',args:[],scope:f.context.scope},
    {op:'read',args:new Array(1)},
    {op:'read',args:[{entryId:'entry-one',writer:'writer-one',vaultId:'foreign-vault'}]},
    {op:'compareAndSwap',args:[change({clientId:'foreign-client'})]},
    {op:'compareAndSwap',args:[change({baseline:{...change().baseline,path:'../outside.md'}})]},
    {op:'retire',args:[{entryId:'entry-one',writer:'writer-one',revision:'1'}]},
  ];
  for(const request of bad)await assert.rejects(f.manager.dispatch(f.record,event(f.record),'/vault-one',f.grant.token,request),error=>error&&!(error instanceof Error)&&typeof error.code==='string'&&!('cause'in error));
  const accessor={op:'list',get args(){throw Error('must not execute accessors');}};
  await assert.rejects(f.manager.dispatch(f.record,event(f.record),'/vault-one',f.grant.token,accessor),{code:'invalid_draft_request'});
  assert.deepEqual(await f.send('list'),[]);
});

test('same-vault foreign client cannot inspect or retire another client receipt',async t=>{
  const f=await fixture(t),receipt=await f.send('compareAndSwap',[change()]);
  const other=f.broker.register(windowStub());other.clientSlot={clientId:'client-two',slotId:'other'};f.broker.bind(other,f.record.vault);
  const grant=f.manager.attach(other,{scope:{vaultId:'vault-one',clientId:'client-two'}});
  const send=(op,args=[])=>f.manager.dispatch(other,event(other),'/vault-one',grant.token,{op,args});
  assert.deepEqual(await send('list'),[]);await assert.rejects(send('read',[receipt]),{code:'invalid_draft_identity'});await assert.rejects(send('retire',[receipt]),{code:'invalid_draft_identity'});
  await assert.rejects(f.send('retire',[{...receipt,generation:2}]),{code:'draft_revision_conflict'});
  assert.equal((await f.send('read',[receipt])).draft,change().draft);
});

test('a replaced main frame gets a fresh incarnation without granting its old document token',async t=>{
  const f=await fixture(t),receipt=await f.send('compareAndSwap',[change()]);f.record.window.webContents.mainFrame={url:'file:///app/index.html'};
  const fresh=f.manager.attach(f.record,f.context);assert.notEqual(fresh.token,f.grant.token);assert.notEqual(fresh.scope.incarnationId,f.grant.scope.incarnationId);
  await assert.rejects(f.send('list'),{code:'draft_lease_revoked'});assert.deepEqual(await f.send('list',[],fresh.token),[receipt]);
});

test('request bodies are captured before waiting and do not adopt later caller mutations',async t=>{
  const f=await fixture(t),request=change(),pending=f.send('compareAndSwap',[request]);
  request.draft='Changed after dispatch';request.baseline.content='Changed baseline';request.entryId='wrong-entry';
  const receipt=await pending,read=await f.send('read',[receipt]);assert.equal(read.draft,change().draft);assert.equal(read.baseline.content,'Original');assert.equal(receipt.entryId,'entry-one');
});

for(const op of ['read','compareAndSwap'])test(`late ${op} response reauthenticates the IPC owner after storage returns`,async t=>{
  const f=await fixture(t),receipt=await f.send('compareAndSwap',[change()]);f.manager.revoke(f.record);
  const journal={bind(scope,check){const lease=f.journal.bind(scope,check);return{...lease,[op]:async(...args)=>{const result=await lease[op](...args);f.record.generation++;return result;}};}};
  const manager=createDraftJournalAdmissionManager({journal,broker:f.broker}),grant=manager.attach(f.record,f.context);t.after(()=>manager.revoke(f.record));
  await assert.rejects(manager.dispatch(f.record,event(f.record),'/vault-one',grant.token,{op,args:[op==='read'?receipt:change({entryId:'entry-two',baseline:{...change().baseline,entryId:'entry-two'}})]}),error=>error.code==='draft_lease_revoked'&&error.commitUncertain===(op==='compareAndSwap')&&!(error instanceof Error)&&!('cause'in error));
});

function heldFiles(stage){
  const entered=deferred(),release=deferred();let held=false;
  const io=new Proxy(fs,{get(target,key){
    if(key==='open'&&stage==='before')return async(file,...args)=>{const handle=await fs.open(file,...args);return new Proxy(handle,{get(object,method){if(method==='writeFile'&&String(file).includes('/branches/')&&!String(file).includes('/blobs/')&&path.basename(String(file)).startsWith('.draft-'))return async(...values)=>{if(!held){held=true;entered.resolve();await release.promise;}return handle.writeFile(...values);};const value=object[method];return typeof value==='function'?value.bind(object):value;}});};
    if(key==='rename'&&stage==='after')return async(from,to)=>{if(String(to).endsWith('/head.json')&&!held){held=true;entered.resolve();await release.promise;}return fs.rename(from,to);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  return{io,entered:entered.promise,release:release.resolve};
}

for(const stage of ['before','after'])test(`revocation denies queued storage and final publication ${stage} head-rename authorization`,{timeout:15000},async t=>{
  const held=heldFiles(stage);t.after(held.release);const f=await fixture(t,held.io);
  const pending=f.send('compareAndSwap',[change()]),rejected=assert.rejects(pending,error=>error.code==='draft_lease_revoked');await held.entered;
  const queued=f.send('compareAndSwap',[change({entryId:'entry-two',baseline:{...change().baseline,entryId:'entry-two'}})]),queuedRejected=assert.rejects(queued,{code:'draft_lease_revoked'});
  f.manager.revoke(f.record);held.release();await rejected;await queuedRejected;
  const fresh=f.manager.attach(f.record,f.context),list=await f.send('list',[],fresh.token);
  assert.equal(list.length,stage==='before'?0:1,'a rename already authorized/in flight may commit, but cannot return a success to the revoked owner');
});
