'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {RustVaultService,reconciliationStatus}=require('../desktop/rust-vault-service.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');

function fixture(options={}){
  const calls=[],notifications=[];let change=false,blocked=false,reload=false,pendingRows=[],hintBlocked=false,hintChange=false;
  const host={root:'/unused-maintenance-triggers',capabilities:[],
    async rescan(){calls.push('rescan');return{complete:true,finished:true,imported:0,reconciliation:{complete:true}};},
    async reconcile(paths){calls.push('reconcile:'+paths.join(','));if(hintChange){change=true;hintChange=false;}return{imported:[],projected:[],blocked:hintBlocked?[{path:paths[0],code:'reconciliation_blocked'}]:[]};},
    async changesAfter(cursor){calls.push('changes');if(reload){reload=false;throw Object.assign(Error('reload'),{code:'reload_required'});}const next=change?'1':cursor;const changes=change?[{cursor:next,origin:{kind:'local_command',operation_id:'external'},requires_full_reload:false,entries:pendingRows}]:[];change=false;pendingRows=[];return{changes,next_cursor:next,has_more:false};},
    async listSnapshot(){calls.push('snapshot');return{entries:[],cursor:'1'};},
  };
  const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000,familyMode:true,...options});
  service.documentScheduler={wake(){calls.push('wake');notifications.push('wake');},sourceHint(){calls.push('hint');notifications.push('hint');},sourceImportProgress(){calls.push('progress');notifications.push('progress');},needsRetry(){return blocked;}};
  return{service,host,calls,notifications,changed(rows=[]){change=true;pendingRows=rows;},blocked(){blocked=true;},reload(){reload=true;},blockHint(){hintBlocked=true;},hintChanges(){hintChange=true;}};
}

test('unchanged maintenance scans do not wake or hint the document index',async()=>{
  const f=fixture();for(let i=0;i<3;i++){f.service.needsScan=true;await f.service.poll();}
  assert.deepEqual(f.calls,['changes','rescan','changes','changes','rescan','changes','changes','rescan','changes']);
  assert.deepEqual(f.notifications,[]);assert.equal(f.service.cursor,'0');
});

test('a scan with actual journal changes sends one wake after journal observation',async()=>{
  const f=fixture();f.service.needsScan=true;f.changed();await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes','wake']);assert.deepEqual(f.notifications,['wake']);assert.equal(f.service.cursor,'1');
});

test('journal-only source change still wakes once and can repair a failed index owner',async()=>{
  const f=fixture();f.blocked();f.changed();await f.service.poll();
  assert.deepEqual(f.calls,['changes','wake']);assert.deepEqual(f.notifications,['wake']);
});

test('unchanged maintenance scan preserves retries for a blocked index owner',async()=>{
  const f=fixture();f.blocked();f.service.needsScan=true;await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes','wake']);assert.deepEqual(f.notifications,['wake']);
});

test('explicit Retry checks files without waking a healthy unchanged index',async()=>{
  const f=fixture();await f.service.retryReconciliation();
  assert.deepEqual(f.calls,['rescan','changes']);assert.deepEqual(f.notifications,[]);
});

test('explicit Retry with a real source change does not send a second indexing notification',async()=>{
  const f=fixture();f.changed();await f.service.retryReconciliation();
  assert.deepEqual(f.calls,['rescan','changes','wake']);assert.deepEqual(f.notifications,['wake']);
});

test('typed journal reload produces one wake even without an ordinary changes page',async()=>{
  const f=fixture();f.reload();await f.service.poll();
  assert.deepEqual(f.calls,['changes','snapshot','wake']);assert.deepEqual(f.notifications,['wake']);assert.equal(f.service.cursor,'1');
});

function watchFixture(){
  let clock=0;const watchers=[];
  const f=fixture({now:()=>clock,watchFactory(_root,options,callback){
    assert.equal(options.recursive,true);const watcher=new EventEmitter();watcher.callback=callback;watcher.closed=false;
    watcher.close=()=>{watcher.closed=true;watcher.emit('close');};watchers.push(watcher);return watcher;
  }});
  f.service.reconciliation={complete:true};
  return{...f,watchers,advance(ms){clock+=ms;},event(file){watchers.at(-1).callback('change',file);}};
}
const entry=(path,id=path)=>({state:{id,path,kind:'file',deleted:false,revision:'revision'},presentation:{}});
async function started(t,f){f.service.startPolling();t.after(()=>f.service.stopPolling());await f.service.poll();f.calls.length=0;}

test('family watcher ignores private writes and idle30-second audits; retains five-minute safety audit',async t=>{
  const f=watchFixture();await started(t,f);assert.equal(f.watchers.length,1);
  f.event('.zorid');f.event('.zorid/vault.sqlite-wal');assert.equal(f.service.hints.size,0);assert.equal(f.service.needsScan,false);
  f.advance(30000);await f.service.poll();assert.deepEqual(f.calls,['changes']);assert.deepEqual(f.notifications,[]);
  f.calls.length=0;f.advance(270000);await f.service.poll();assert.deepEqual(f.calls,['changes','rescan','changes']);assert.deepEqual(f.notifications,[]);
});

test('own known-file watcher echo uses native exact observation without a full scan or index wake',async t=>{
  const f=watchFixture();f.service.entries.set('one',entry('One.md','one'));await started(t,f);
  f.event('One.md');await f.service.poll();
  assert.deepEqual(f.calls,['changes','reconcile:One.md','changes']);assert.deepEqual(f.notifications,[]);assert.equal(f.service.hints.size,0);
});

test('journal-first processing recognizes an own newly-created file before its watcher echo',async t=>{
  const f=watchFixture();await started(t,f);f.changed([entry('New.md','new')]);f.event('New.md');await f.service.poll();
  assert.deepEqual(f.calls,['changes','reconcile:New.md','changes','wake']);assert.deepEqual(f.notifications,['wake']);
});

test('external known-file edit imports through native observation and wakes index once',async t=>{
  const f=watchFixture();f.service.entries.set('one',entry('One.md','one'));await started(t,f);f.hintChanges();f.event('One.md');await f.service.poll();
  assert.deepEqual(f.calls,['changes','reconcile:One.md','changes','wake']);assert.deepEqual(f.notifications,['wake']);
});

for(const path of ['New.md','New folder'])test(`unknown watcher path ${path} retains full namespace discovery`,async t=>{
  const f=watchFixture();await started(t,f);f.event(path);await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes']);assert.deepEqual(f.notifications,[]);
});

test('folder hint retains recursive discovery instead of treating it as a known-file echo',async t=>{
  const f=watchFixture();f.service.entries.set('folder',{state:{id:'folder',path:'Folder',kind:'folder',deleted:false}});await started(t,f);f.event('Folder');await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes']);
});

test('missing, replaced or blocked known-file proof falls back to full discovery',async t=>{
  const f=watchFixture();f.service.entries.set('one',entry('One.md','one'));await started(t,f);f.blockHint();f.event('One.md');await f.service.poll();
  assert.deepEqual(f.calls,['changes','reconcile:One.md','rescan','changes']);
});

for(const reason of ['unknown-name','unsafe-name','overflow','watch-error'])test(`watcher ${reason} preserves full discovery and fallback`,async t=>{
  const f=watchFixture();await started(t,f);
  if(reason==='unknown-name')f.event(null);
  if(reason==='unsafe-name')f.event('../outside.md');
  if(reason==='overflow')for(let n=0;n<1025;n++)f.event(`Note${n}.md`);
  if(reason==='watch-error')f.watchers.at(-1).emit('error',Error('watch unavailable'));
  assert.equal(f.service.needsScan,true);assert.ok(f.service.hints.size<=1024);await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes']);
  if(reason==='watch-error'){f.calls.length=0;f.advance(30000);await f.service.poll();assert.deepEqual(f.calls,['changes','rescan','changes']);}
});

test('unsupported recursive watcher preserves original periodic discovery',async t=>{
  let clock=0;const f=fixture({now:()=>clock,watchFactory(){throw Error('unsupported');}});f.service.startPolling();t.after(()=>f.service.stopPolling());await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes']);f.calls.length=0;clock=30000;await f.service.poll();assert.deepEqual(f.calls,['changes','rescan','changes']);
});

test('paused and replaced watcher callbacks cannot enqueue stale hints; resume reconciles missed interval',async t=>{
  const f=watchFixture();await started(t,f);const old=f.watchers[0];f.service.stopPolling();old.callback('change','Old.md');assert.equal(f.service.hints.size,0);
  f.service.startPolling();await f.service.poll();old.callback('change','Late.md');assert.equal(f.service.hints.size,0);assert.equal(old.closed,true);assert.equal(f.watchers.length,2);
  assert.deepEqual(f.calls,['changes','rescan','changes']);
});

test('known-file hint bursts are bounded and remaining paths stay queued',async t=>{
  const f=watchFixture();for(let n=0;n<20;n++)f.service.entries.set(String(n),entry(`N${n}.md`,String(n)));await started(t,f);for(let n=0;n<20;n++)f.event(`N${n}.md`);
  await f.service.poll();const observed=f.calls.find(call=>call.startsWith('reconcile:')).slice(10).split(',');assert.equal(observed.length,16);assert.equal(f.service.hints.size,4);
  f.calls.length=0;await f.service.poll();assert.equal(f.calls.find(call=>call.startsWith('reconcile:')).slice(10).split(',').length,4);assert.equal(f.service.hints.size,0);
});

test('family watcher is installed before native startup and retains startup hints',async t=>{
  const original=RustVaultService.open;const calls=[];let callback,closed=false;
  const host={root:'/unused-early-watch',capabilities:['read_path','list_snapshot','changes_after','rescan','prepare_intent','commit_intent','query_intent','list_intents','acknowledge_intent','local_family_status','reconciliation_status'],reconciliation:{complete:true},async localFamilyStatus(){calls.push('status');},async listSnapshot(){return{entries:[],cursor:'0'};},async close(){calls.push('close');}};
  RustVaultService.open=async()=>{calls.push('native');callback('change','During startup.md');return host;};t.after(()=>{RustVaultService.open=original;});
  const service=await CoreVaultFixtureService.open(host.root,{fixture:true,familyMode:true,initializeLocal:true,watchRootIdentity:async path=>({path,identity:'root'}),watchFactory(_root,_options,onEvent){calls.push('watch');callback=onEvent;const watcher=new EventEmitter();watcher.close=()=>{closed=true;};return watcher;}});
  assert.deepEqual(calls,['watch','native']);assert.deepEqual([...service.hints],['During startup.md']);await service.close();assert.equal(closed,true);
});

test('failed native startup closes its buffered watcher',async t=>{
  const original=RustVaultService.open;let closed=false;RustVaultService.open=async()=>{throw Error('native failed');};t.after(()=>{RustVaultService.open=original;});
  await assert.rejects(CoreVaultFixtureService.open('/unused-early-watch',{fixture:true,familyMode:true,watchRootIdentity:async path=>({path,identity:'root'}),watchFactory(){const watcher=new EventEmitter();watcher.close=()=>{closed=true;};return watcher;}}),/native failed/);assert.equal(closed,true);
});


for(const maintenance of ['rescan','reconcile'])test(`confirmed journal progress still wakes once after later ${maintenance} failure`,async()=>{
  const f=fixture();f.changed();
  if(maintenance==='rescan'){f.service.needsScan=true;f.host.rescan=async()=>{f.calls.push('rescan');throw Error('temporary scan failure');};}
  else{f.service.entries.set('one',entry('One.md','one'));f.service.hints.add('One.md');f.host.reconcile=async()=>{f.calls.push('reconcile');throw Error('temporary observation failure');};}
  await f.service.poll();assert.equal(f.service.cursor,'1');assert.deepEqual(f.notifications,['wake']);
  f.calls.length=0;await f.service.poll();assert.deepEqual(f.notifications,['wake'],'empty later poll must not duplicate the accepted-source notification');
});

test('startup physical-root change rebinds watcher and retains full discovery',async t=>{
  const original=RustVaultService.open,watchers=[];let identityReads=0;
  const host={root:'/canonical-new',capabilities:['read_path','list_snapshot','changes_after','rescan','prepare_intent','commit_intent','query_intent','list_intents','acknowledge_intent','local_family_status','reconciliation_status'],reconciliation:{complete:true},async localFamilyStatus(){},async listSnapshot(){return{entries:[],cursor:'0'};},async close(){}};
  RustVaultService.open=async()=>host;t.after(()=>{RustVaultService.open=original;});
  const service=await CoreVaultFixtureService.open('/selected-old',{fixture:true,familyMode:true,initializeLocal:true,
    watchRootIdentity:async()=>++identityReads===1?{path:'/canonical-old',identity:'old-inode'}:{path:'/canonical-new',identity:'new-inode'},
    watchFactory(root,_options,callback){const watcher=new EventEmitter();watcher.root=root;watcher.callback=callback;watcher.closed=false;watcher.close=()=>{watcher.closed=true;};watchers.push(watcher);return watcher;},
  });
  assert.equal(watchers.length,2);assert.equal(watchers[0].closed,true);assert.equal(watchers[1].root,host.root);assert.equal(service.needsScan,true);
  watchers[0].callback('change','Retired-root.md');assert.equal(service.hints.size,0);
  watchers[1].callback('change','Actual-root.md');assert.deepEqual([...service.hints],['Actual-root.md']);await service.close();assert.equal(watchers[1].closed,true);
});

test('incomplete reconciliation retains the thirty-second fallback even with a healthy watcher',async t=>{
  const f=watchFixture();f.service.reconciliation={complete:false};await started(t,f);f.advance(30000);await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes']);
});


test('unknown reconciliation status retains thirty-second fallback with a healthy watcher',async t=>{
  const f=watchFixture();f.service.reconciliation=null;await started(t,f);f.advance(30000);await f.service.poll();
  assert.deepEqual(f.calls,['changes','rescan','changes']);
});

async function startupOwnerFixture(t,{startupHint=false,rootChanged=false,exit}={}){
  const original=RustVaultService.open,watchers=[],nativeCalls=[],notifications=[];let scans=0,identityReads=0,externalChange=false,journalChange=false;
  const host={root:'/startup-owner-order',capabilities:['documents','document_runtime','read_path','list_snapshot','changes_after','rescan','prepare_intent','commit_intent','query_intent','list_intents','acknowledge_intent','local_family_status','reconciliation_status'],reconciliation:{complete:true},
    ...(exit?{exit}:{}),
    async localFamilyStatus(){},async listSnapshot(){return{entries:[],cursor:'0'};},async changesAfter(cursor){nativeCalls.push('changes');const changed=journalChange;journalChange=false;return{changes:changed?[{cursor:'1',origin:{kind:'local_command',operation_id:'external'},requires_full_reload:false,entries:[{...entry('One.md','one'),state:{...entry('One.md','one').state,revision:'fresh-revision'}}]}]:[],next_cursor:changed?'1':cursor,has_more:false};},
    async request(command,_body,_lease,beforeDispatch){beforeDispatch?.();nativeCalls.push(command.method);if(command.method==='reconcile'){if(externalChange){journalChange=true;externalChange=false;}return{result:{imported:[],projected:[],blocked:[]}};}assert.equal(command.method,'rescan');scans++;return{result:{complete:true,reconciliation:{complete:true}}};},async close(){},
  };
  RustVaultService.open=async()=>{if(startupHint)watchers[0].callback('change','During startup.md');return host;};
  t.after(()=>{RustVaultService.open=original;});
  const service=await CoreVaultFixtureService.open(host.root,{fixture:true,familyMode:true,initializeLocal:true,documentRuntime:true,
    watchRootIdentity:async path=>({path,identity:rootChanged&&++identityReads>1?'replacement':'original'}),
    watchFactory(_root,_options,callback){const watcher=new EventEmitter();watcher.callback=callback;watcher.closed=false;watcher.close=()=>{watcher.closed=true;watcher.emit('close');};watchers.push(watcher);return watcher;},
  });
  service.documentScheduler={
    addOwner(){let retired;return{subscribe(_listener,onRetire){retired=onRetire;return()=>{};},async pause(){},resume(){},revoke(){retired?.();return Promise.resolve();},release(){retired?.();}};},
    wake(){notifications.push('wake');},sourceHint(){},sourceImportProgress(){},needsRetry(){return false;},async close(){},
  };
  t.after(()=>service.close());
  const register=(clientId='client',assertActive=()=>{})=>service.registerDocumentRuntimeOwner({host,clientId,localStoreId:'store',assertActive});
  return{service,watchers,register,nativeCalls,notifications,changeKnownFile(){externalChange=true;},get scans(){return scans;}};
}

test('broker subscription before first runtime admission preserves the continuous startup watcher and performs no scan',async t=>{
  const f=await startupOwnerFixture(t),firstWatcher=f.watchers[0];
  const unsubscribe=f.service.subscribe(()=>{});f.register();await f.service.poll();
  assert.equal(f.scans,0,'subscribing before admission must not manufacture a missed-watch interval');
  assert.equal(f.watchers.length,1);assert.equal(f.service.watcher,firstWatcher);assert.equal(firstWatcher.closed,false);assert.equal(f.service.needsScan,false);
  unsubscribe();await f.service.poll();assert.equal(f.scans,0,'feature listener changes do not stop an admitted owner');
});

test('continuous pre-admission watcher still delivers a real startup change after broker subscription',async t=>{
  const f=await startupOwnerFixture(t,{startupHint:true});f.service.subscribe(()=>{});f.register();await f.service.poll();
  assert.equal(f.scans,1);assert.equal(f.watchers.length,1,'the original watcher stayed live while its hint was retained');
});

test('physical startup-root replacement still requires discovery despite pre-owner subscription',async t=>{
  const f=await startupOwnerFixture(t,{rootChanged:true});f.service.subscribe(()=>{});f.register();await f.service.poll();
  assert.equal(f.scans,1);assert.equal(f.watchers.length,2,'only the proven root replacement reinstalls the watcher');
});

test('healthy last-owner pause preserves watcher coverage and resume does not manufacture a scan',async t=>{
  const f=await startupOwnerFixture(t);f.service.subscribe(()=>{});const owner=f.register();await f.service.poll();assert.equal(f.scans,0);
  await owner.pause();assert.equal(f.service.timer,null);assert.equal(f.service.continuation,null);
  assert.equal(f.watchers[0].closed,false);assert.equal(f.service.needsScan,false);
  owner.resume();await f.service.poll();assert.equal(f.scans,0);assert.equal(f.watchers.length,1);
});

test('known-file hints while paused stay metadata-only and import targeted freshness on resume',async t=>{
  const f=await startupOwnerFixture(t),owner=f.register();f.service.entries.set('one',entry('One.md','one'));await f.service.poll();await owner.pause();
  f.nativeCalls.length=0;f.changeKnownFile();f.watchers[0].callback('change','One.md');await f.service.poll();await turn();
  assert.deepEqual(f.nativeCalls,[]);assert.equal(f.service.hints.has('One.md'),true);assert.equal(f.service.timer,null);
  owner.resume();await f.service.poll();assert.deepEqual(f.nativeCalls,['changes','reconcile','changes']);
  assert.equal(f.scans,0);assert.equal(f.watchers.length,1);assert.equal(f.service.entries.get('one').state.revision,'fresh-revision');assert.deepEqual(f.notifications,['wake']);
});

for(const reason of ['unknown-path','unknown-name','unsafe-name','overflow','watch-error','watch-close'])test(`paused watcher ${reason} still requires complete discovery on resume`,async t=>{
  const f=await startupOwnerFixture(t),owner=f.register();await f.service.poll();await owner.pause();f.nativeCalls.length=0;
  const watcher=f.watchers[0];
  if(reason==='unknown-path')watcher.callback('rename','New.md');
  if(reason==='unknown-name')watcher.callback('rename',null);
  if(reason==='unsafe-name')watcher.callback('rename','../outside.md');
  if(reason==='overflow')for(let n=0;n<1025;n++)watcher.callback('change',`N${n}.md`);
  if(reason==='watch-error')watcher.emit('error',Error('watch lost'));
  if(reason==='watch-close')watcher.close();
  await f.service.poll();assert.deepEqual(f.nativeCalls,[]);assert.ok(f.service.hints.size<=1024);
  owner.resume();await f.service.poll();assert.equal(f.scans,1);
});

for(const action of ['release','revoke'])test(`last paused owner ${action} closes its watcher and later admission repairs the gap`,async t=>{
  const f=await startupOwnerFixture(t),owner=f.register();await f.service.poll();await owner.pause();
  await owner[action]();assert.equal(f.watchers[0].closed,true);assert.equal(f.service.needsScan,true);
  f.watchers[0].callback('change','Stale.md');assert.equal(f.service.hints.has('Stale.md'),false);
  f.register('next');await f.service.poll();assert.equal(f.scans,1);assert.equal(f.watchers.length,2);
});

test('a paused owner whose grant fails cannot retain passive watcher ownership',async t=>{
  const f=await startupOwnerFixture(t);let active=true;
  const owner=f.register('client',()=>{if(!active)throw Object.assign(Error('retired'),{code:'grant_retired'});});
  await f.service.poll();await owner.pause();active=false;f.service.syncPolling();await turn();
  assert.equal(f.service.documentRuntimeOwners.size,0);assert.equal(f.watchers[0].closed,true);assert.equal(f.service.needsScan,true);
});

test('failed first grant closes the pre-admission watcher without native polling',async t=>{
  const f=await startupOwnerFixture(t);assert.throws(()=>f.register('bad',()=>{throw Object.assign(Error('retired'),{code:'grant_retired'});}),{code:'client_ownership_lost'});
  assert.equal(f.watchers[0].closed,true);assert.equal(f.service.timer,null);assert.deepEqual(f.nativeCalls,[]);
});

test('runtime failure closes a passive watcher and cancels paused maintenance',async t=>{
  let finish;const exit=new Promise(resolve=>{finish=resolve;});const f=await startupOwnerFixture(t,{exit}),owner=f.register();await f.service.poll();await owner.pause();
  finish();await turn();assert.equal(f.watchers[0].closed,true);assert.equal(f.service.timer,null);assert.equal(f.service.continuation,null);assert.equal(f.service.needsScan,true);
});

test('closing before any runtime owner arrives still retires the early startup watcher',async t=>{
  const f=await startupOwnerFixture(t);f.service.subscribe(()=>{});await f.service.close();assert.equal(f.watchers[0].closed,true);
});


test('resuming one owner does not rescan while another owner kept the same watcher continuous',async t=>{
  const f=await startupOwnerFixture(t);f.service.subscribe(()=>{});const first=f.register('first');f.register('second');await f.service.poll();
  await first.pause();assert.equal(f.watchers[0].closed,false);assert.equal(f.service.needsScan,false);
  first.resume();await f.service.poll();assert.equal(f.scans,0);assert.equal(f.watchers.length,1);assert.equal(f.service.needsScan,false);
});


test('concurrent explicit reconciliation retries share one in-flight physical pass',async()=>{
  const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
  f.host.rescan=async()=>{f.calls.push('rescan');await gate;return{complete:true,reconciliation:{complete:true}};};
  const first=f.service.retryReconciliation(),second=f.service.retryReconciliation();
  await Promise.resolve();const scans=f.calls.filter(call=>call==='rescan').length;release();const replies=await Promise.all([first,second]);
  assert.equal(scans,1);assert.deepEqual(replies,[{complete:true},{complete:true}]);assert.deepEqual(f.notifications,[]);
});

test('a shared reconciliation failure rejects each caller and permits a fresh later retry',async()=>{
  const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});const failure=Object.assign(Error('transient'),{code:'temporary_scan_failure'});
  f.host.rescan=async()=>{f.calls.push('rescan');await gate;throw failure;};
  const pending=Promise.allSettled([f.service.retryReconciliation(),f.service.retryReconciliation()]);release();const replies=await pending;
  assert.equal(f.calls.filter(call=>call==='rescan').length,1);assert.equal(replies.every(reply=>reply.status==='rejected'&&reply.reason===failure),true);
  f.host.rescan=async()=>{f.calls.push('rescan');return{complete:true,reconciliation:{complete:true}};};await f.service.retryReconciliation();
  assert.equal(f.calls.filter(call=>call==='rescan').length,2);assert.deepEqual(f.notifications,[]);
});

test('a separate later explicit retry performs a new physical check',async()=>{
  const f=fixture();await f.service.retryReconciliation();await f.service.retryReconciliation();
  assert.equal(f.calls.filter(call=>call==='rescan').length,2);assert.deepEqual(f.notifications,[]);
});

test('explicit Retry retains index error recovery without manufacturing a source change',async()=>{
  const f=fixture();f.blocked();await f.service.retryReconciliation();
  assert.deepEqual(f.calls,['rescan','changes','wake']);assert.deepEqual(f.notifications,['wake']);assert.equal(f.service.cursor,'0');
});

test('concurrent explicit retries with a real source change notify the index once',async()=>{
  const f=fixture();f.changed();await Promise.all([f.service.retryReconciliation(),f.service.retryReconciliation()]);
  assert.equal(f.calls.filter(call=>call==='rescan').length,1);assert.deepEqual(f.notifications,['wake']);assert.equal(f.service.cursor,'1');
});

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const workStatus=(phase='discovery')=>({complete:phase==='complete',work:{phase,pending:['discovery','import','publication'].includes(phase),workUnits:1}});

test('interactive import continuations yield event-loop turns, share explicit Retry and keep new hints',async t=>{
  const f=watchFixture();f.service.reconciliation=workStatus();const notices=[];f.service.listeners.add(change=>notices.push(change));
  let release,scans=0,active=0,maximum=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.host.rescan=async()=>{scans++;maximum=Math.max(maximum,++active);if(scans===1)await gate;active--;return{complete:scans>=3,reconciliation:workStatus(scans>=3?'complete':'publication')};};
  f.service.startPolling();t.after(()=>f.service.stopPolling());await turn();assert.equal(scans,1);
  const retry=f.service.retryReconciliation();await turn();assert.equal(scans,1,'Retry must join the existing continuation');
  f.event('Unobserved-later.md');release();await retry;
  assert.equal(scans,1,'one RPC per event-loop turn');assert.equal(f.service.hints.has('Unobserved-later.md'),true);
  for(let n=0;n<8&&scans<3;n++)await turn();
  f.service.stopPolling();assert.equal(scans,3);assert.equal(maximum,1);assert.deepEqual(f.notifications,['progress','progress']);
  assert.equal(notices.some(change=>change.type==='error'),false,'a voluntary yield is ordinary progress');
});

test('blocked and failed interactive work do not schedule a busy continuation',async t=>{
  for(const failure of [false,true]){
    const f=watchFixture();f.service.reconciliation=workStatus();let scans=0;
    f.host.rescan=async()=>{scans++;if(failure)throw Object.assign(Error('transient'),{code:'temporary_scan_failure'});return{complete:false,reconciliation:workStatus('blocked')};};
    f.service.startPolling();t.after(()=>f.service.stopPolling());await f.service.poll();for(let n=0;n<4;n++)await turn();
    assert.equal(scans,1);assert.equal(f.service.continuation,null);f.service.stopPolling();
  }
});

test('retiring the last admitted owner cancels a queued import continuation',async t=>{
  const f=await startupOwnerFixture(t);f.service.reconciliation=workStatus();
  f.service.host.request=async(command,_body,_lease,beforeDispatch)=>{beforeDispatch?.();assert.equal(command.method,'rescan');return{result:{complete:false,reconciliation:workStatus()}};};
  const owner=f.register();await f.service.poll();assert.ok(f.service.continuation);
  await owner.pause();for(let n=0;n<3;n++)await turn();assert.equal(f.service.continuation,null);assert.equal(f.service.polling,null);
});

test('partial native reply after owner retirement preserves discovery duty for another admitted owner',async t=>{
  const f=await startupOwnerFixture(t);const first=f.register('first');f.register('second');await f.service.poll();
  let release,scans=0;const gate=new Promise(resolve=>{release=resolve;});
  f.service.host.request=async(command,_body,_lease,beforeDispatch)=>{beforeDispatch?.();assert.equal(command.method,'rescan');scans++;if(scans===1)await gate;return{result:{complete:false,reconciliation:workStatus()}};};
  f.service.hints.add('Late.md');const pending=f.service.poll();await turn();const paused=first.pause();release();await Promise.all([pending,paused]);
  assert.equal(scans,1);assert.equal(f.service.reconciliation.complete,true,'the retired owner cannot publish its response');assert.equal(f.service.needsScan,true);
  await f.service.poll();f.service.stopPolling();assert.equal(scans,2,'the other owner resumes before the five-minute audit');assert.equal(f.service.reconciliation.work.pending,true);
});


test('a failed continuation publishes coherent stopped work instead of stale pending progress',async()=>{
  const f=fixture();f.service.reconciliation={scanId:'scan',complete:false,scanComplete:true,finished:true,observed:1,imported:0,namespaceApplied:0,issueCount:0,issuesTruncated:false,issues:[],work:{phase:'publication',pending:true,workUnits:1}};
  f.host.rescan=async()=>{throw Object.assign(Error('unavailable'),{code:'temporary_scan_failure'});};
  await assert.rejects(f.service.scanNow(),{code:'temporary_scan_failure'});
  assert.equal(f.service.reconciliation.work.pending,false);assert.equal(f.service.reconciliation.work.phase,'blocked');
  assert.equal(f.service.reconciliation.failure,'scan_failed');assert.equal(reconciliationStatus(f.service.reconciliation),true);
});
