'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {startJournalApp}=require('./helpers/desktop-journal-app.cjs');
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const context=async f=>(await f.bridge.getDurableContext('/vault-one'));
const send=(f,grant,op,args=[])=>f.bridge.independentJournal({vault:'/vault-one',token:grant.token,op,args});

test('main and preload expose one authenticated lazy journal grant independently of core host calls',async t=>{
  const f=await startJournalApp(t),first=await context(f);assert.ok(first.independentJournal);assert.equal(f.openCount,0,'context admission never opens storage');
  assert.deepEqual((await context(f)).independentJournal,first.independentJournal);
  const held=gate();f.holdCore(held.promise);const core=f.bridge.durableInvoke('/vault-one','core-one','commit',[{}]);
  assert.deepEqual(await send(f,first.independentJournal,'list'),{independentJournal:true,schemaVersion:1,ok:true,value:[]});assert.equal(f.openCount,1);held.resolve();await core;
  const recovered=await f.bridge.recoverDurableContext('/vault-one','core-one');assert.deepEqual(recovered.independentJournal,first.independentJournal,'host replacement retains document grant');
});

test('same-frame same-URL reload rejects a late positive core acknowledgement before attaching journal',async t=>{
  const f=await startJournalApp(t),held=gate();f.holdContext(held.promise);const pending=f.invoke('getDurableContext','/vault-one');await Promise.resolve();f.reload();held.resolve();
  const reply=await pending;assert.equal(reply.ok,false);assert.equal(reply.error.code,'draft_admission_denied');assert.equal(f.openCount,0);
});

test('successful release and full document reload revoke old tokens while same-document navigation does not',async t=>{
  const f=await startJournalApp(t),first=await context(f),grant=first.independentJournal;
  f.window.webContents.emit('did-start-navigation', {isMainFrame:true,isSameDocument:true});assert.equal((await send(f,grant,'list')).ok,true);
  f.reload();assert.equal((await send(f,grant,'list')).error.code,'draft_lease_revoked');
  const fresh=(await context(f)).independentJournal;assert.notEqual(fresh.token,grant.token);await f.bridge.releaseDurableContext('/vault-one','core-one');assert.equal((await send(f,fresh,'list')).error.code,'draft_lease_revoked');
});
test('navigation uses installed Electron details-first API and retains deprecated argument fallback',async t=>{
  const f=await startJournalApp(t),grant=(await context(f)).independentJournal;
  f.window.webContents.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});assert.equal((await send(f,grant,'list')).ok,true,'subframes cannot revoke the main document');
  f.window.webContents.emit('did-start-navigation',{},f.window.webContents.mainFrame.url,true,true);assert.equal((await send(f,grant,'list')).ok,true,'legacy same-document navigation retains its grant');
  f.window.webContents.emit('did-start-navigation',{},f.window.webContents.mainFrame.url,false,true);assert.equal((await send(f,grant,'list')).error.code,'draft_lease_revoked');
});

test('IPC rejects spoofed frames, roots and capabilities as bounded plain data',async t=>{
  const f=await startJournalApp(t),grant=(await context(f)).independentJournal,input={vault:'/vault-one',token:grant.token,op:'list',args:[]},handler=f.handlers.get('zorid:independentJournal');
  const spoof=await handler({...f.event(),senderFrame:{}},input);assert.equal(spoof.ok,false);assert.equal(spoof.error.code,'draft_admission_denied');
  const wrong=await f.bridge.independentJournal({...input,vault:'/foreign'});assert.equal(wrong.error.code,'draft_admission_denied');
  assert.equal((await f.bridge.independentJournal({...input,token:'forged'})).error.code,'draft_lease_revoked');
  assert.equal((await f.bridge.independentJournal({...input,op:'bind'})).error.code,'invalid_draft_request');assert.equal(f.openCount,0);
});

test('filesystem open failure is a truthful journal failure and heals on the next request with the same grant',async t=>{
  const f=await startJournalApp(t);f.failOpen();const grant=(await context(f)).independentJournal;
  assert.equal((await send(f,grant,'list')).error.code,'draft_storage_failure');assert.deepEqual((await context(f)).independentJournal,grant);
  assert.equal((await send(f,grant,'list')).ok,true);assert.equal(f.openCount,2);
});

test('late recovered core acknowledgement cannot attach after same-URL reload',async t=>{
  const f=await startJournalApp(t);await context(f);const held=gate();f.holdRecovery(held.promise);
  const pending=f.invoke('recoverDurableContext','/vault-one','core-one');await Promise.resolve();f.reload();held.resolve();assert.equal((await pending).error.code,'draft_admission_denied');
});

test('late release acknowledgement cannot revoke a newly attached document grant',async t=>{
  const f=await startJournalApp(t);await context(f);const held=gate();f.holdRelease(held.promise);
  const pending=f.invoke('releaseDurableContext','/vault-one','core-one');await Promise.resolve();f.reload();const fresh=(await context(f)).independentJournal;held.resolve();
  assert.equal((await pending).error.code,'draft_admission_denied');assert.equal((await send(f,fresh,'list')).ok,true);
});

test('revocation during lazy filesystem opening denies old requests before binding storage',async t=>{
  const f=await startJournalApp(t),grant=(await context(f)).independentJournal,held=gate();f.holdOpen(held.promise);
  const pending=send(f,grant,'list');await new Promise(resolve=>setImmediate(resolve));f.reload();held.resolve();assert.equal((await pending).error.code,'draft_lease_revoked');
  const fresh=(await context(f)).independentJournal;assert.equal((await send(f,fresh,'list')).ok,true);assert.equal(f.openCount,1);
});

for(const replacement of ['frame','generation','renderGone','vault'])test(`actual main journal token is fenced on ${replacement}`,async t=>{
  const f=await startJournalApp(t),grant=(await context(f)).independentJournal;
  if(replacement==='frame')f.window.webContents.mainFrame={url:f.window.webContents.mainFrame.url};
  if(replacement==='generation')f.record.generation++;
  if(replacement==='renderGone')f.window.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  if(replacement==='vault')await f.bridge.openVault();
  assert.equal((await send(f,grant,'list')).ok,false);assert.equal(f.openCount,0);
});

for(const op of ['list','compareAndSwap'])test(`main rechecks document ownership after the journal manager resolves ${op}`,async t=>{
  const f=await startJournalApp(t),grant=(await context(f)).independentJournal;
  f.afterJournal(()=>f.reload());
  const args=op==='list'?[]:[{entryId:'entry',writer:'writer',generation:1,expectedRevision:null,nextRevision:'1',baseline:{entryId:'entry',path:'Note.md',revision:'r1',content:'Original'},draft:'Retained exact bytes',checkpointRevision:null,pendingOperation:null}];
  const reply=await send(f,grant,op,args);assert.equal(reply.ok,false);assert.equal(reply.error.code,'draft_admission_denied');assert.equal(reply.error.commitUncertain,op==='compareAndSwap');
  if(op==='compareAndSwap'){const fresh=(await context(f)).independentJournal;assert.equal((await send(f,fresh,'list',[{entryId:'entry'}])).value.length,1,'an unacknowledged committed journal remains recoverable');}
});
