'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
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
  service.documentScheduler={wake(){calls.push('wake');notifications.push('wake');},sourceHint(){calls.push('hint');notifications.push('hint');},needsRetry(){return blocked;}};
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
  assert.deepEqual(calls,['watch','native','status']);assert.deepEqual([...service.hints],['During startup.md']);await service.close();assert.equal(closed,true);
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

async function startupOwnerFixture(t,{startupHint=false,rootChanged=false}={}){
  const original=RustVaultService.open,watchers=[];let scans=0,identityReads=0;
  const host={root:'/startup-owner-order',capabilities:['documents','document_runtime','read_path','list_snapshot','changes_after','rescan','prepare_intent','commit_intent','query_intent','list_intents','acknowledge_intent','local_family_status','reconciliation_status'],reconciliation:{complete:true},
    async localFamilyStatus(){},async listSnapshot(){return{entries:[],cursor:'0'};},async changesAfter(cursor){return{changes:[],next_cursor:cursor,has_more:false};},
    async request(command,_body,_lease,beforeDispatch){beforeDispatch?.();assert.equal(command.method,'rescan');scans++;return{result:{complete:true,reconciliation:{complete:true}}};},async close(){},
  };
  RustVaultService.open=async()=>{if(startupHint)watchers[0].callback('change','During startup.md');return host;};
  t.after(()=>{RustVaultService.open=original;});
  const service=await CoreVaultFixtureService.open(host.root,{fixture:true,familyMode:true,initializeLocal:true,documentRuntime:true,
    watchRootIdentity:async path=>({path,identity:rootChanged&&++identityReads>1?'replacement':'original'}),
    watchFactory(_root,_options,callback){const watcher=new EventEmitter();watcher.callback=callback;watcher.closed=false;watcher.close=()=>{watcher.closed=true;watcher.emit('close');};watchers.push(watcher);return watcher;},
  });
  service.documentScheduler={
    addOwner(){let retired;return{subscribe(_listener,onRetire){retired=onRetire;return()=>{};},async pause(){},resume(){},revoke(){retired?.();return Promise.resolve();},release(){retired?.();}};},
    wake(){},sourceHint(){},needsRetry(){return false;},async close(){},
  };
  t.after(()=>service.close());
  const register=(clientId='client')=>service.registerDocumentRuntimeOwner({host,clientId,localStoreId:'store',assertActive(){}});
  return{service,watchers,register,get scans(){return scans;}};
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

test('real owner pause stops the watcher and resume reconciles the genuine gap once',async t=>{
  const f=await startupOwnerFixture(t);f.service.subscribe(()=>{});const owner=f.register();await f.service.poll();assert.equal(f.scans,0);
  await owner.pause();assert.equal(f.watchers[0].closed,true);assert.equal(f.service.needsScan,true);
  owner.resume();await f.service.poll();assert.equal(f.scans,1);assert.equal(f.watchers.length,2);
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
