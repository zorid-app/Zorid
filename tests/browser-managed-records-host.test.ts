import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserManagedRecordsHost } from '../src/platform/browser-managed-records-host.ts';
import { BrowserSyncWorker } from '../src/platform/browser-sync-worker.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
  let tail:Promise<unknown>=Promise.resolve(),active=true,session=true,registered=0,retries=0,notifications=0,disposed=0;
  const received:string[][]=[],failures:unknown[]=[];
  let retry=async()=>({changed:false,exhausted:true});
  let changes=async(_after:string)=>[] as any[];
  const host=createBrowserManagedRecordsHost({
    records:{async register(){registered++;return {dispose(){disposed++;}};},retryPage(){retries++;return retry();},changes(_handle,after){return changes(after);}} as any,
    consumers:[{owner:'firstparty',collection:'fixture',registration:()=>new Uint8Array(),changed(rows){received.push(rows.map(row=>row.sequence));}}],
    async scope(){return {realm_id:'realm',vault_id:'vault'};},hasSession:()=>session,
    assertActive(){if(!active)throw new Error('owner lost');},
    local<T>(operation:()=>Promise<T>){const task=tail.then(operation);tail=task.catch(()=>{});return task;},
    notify(){notifications++;},failed(error){failures.push(error);},
  });
  return {host,received,failures,get registered(){return registered;},get retries(){return retries;},get notifications(){return notifications;},get disposed(){return disposed;},
    retry(fn:typeof retry){retry=fn;},changes(fn:typeof changes){changes=fn;},lose(){active=false;},session(value:boolean){session=value;}};
}
test('coalesces triggers, stops at no progress, registers once and catches missed changes',async()=>{
  const f=fixture(),hold=gate();f.retry(async()=>{await hold.promise;return {changed:false,exhausted:true};});
  const one=f.host.trigger();assert.equal(f.host.trigger(),one);hold.resolve();await one;
  assert.equal(f.registered,1);assert.ok(f.retries<=2);
  f.changes(async after=>after==='0'?[{sequence:'9007199254740993'}]:[]);
  await f.host.trigger();await f.host.trigger();assert.deepEqual(f.received,[['9007199254740993']]);assert.equal(f.notifications,1);assert.equal(f.registered,1);
});
test('one trigger has a finite four-page budget even for endless continuation',async()=>{
  const f=fixture();f.retry(async()=>({changed:false,exhausted:false}));await f.host.trigger();assert.equal(f.retries,4);
  await f.host.trigger();assert.equal(f.retries,8);
});
test('coalesced external hint gets one bounded follow-up after rejected retained retry',async()=>{
  const f=fixture(),entered=gate(),release=gate();let calls=0;
  f.retry(async()=>{calls++;if(calls===1){entered.resolve();await release.promise;throw new Error('revoked retry');}return {changed:false,exhausted:true};});
  const task=f.host.trigger();await entered.promise;assert.equal(f.host.trigger(),task);release.resolve();await task;
  assert.equal(calls,2);assert.equal(f.failures.length,1);
});
test('absence of key skips retry and still delivers durable change catch-up',async()=>{
  const f=fixture();f.session(false);f.changes(async()=>[{sequence:'1'}]);await f.host.trigger();assert.equal(f.retries,0);assert.equal(f.notifications,1);
});
test('close fences queued work and drains in-flight durable completion without stale notification',async()=>{
  const f=fixture(),entered=gate(),complete=gate();f.retry(async()=>{entered.resolve();await complete.promise;return {changed:true,exhausted:true};});
  const pending=f.host.trigger();await entered.promise;f.host.stop();let drained=false;const drain=f.host.drain().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);complete.resolve();await pending;await drain;
  assert.equal(f.notifications,0);assert.equal(f.disposed,1);await f.host.trigger();assert.equal(f.retries,1);
});
test('owner loss after durable return suppresses notification and reports failure',async()=>{
  const f=fixture();f.changes(async()=>{f.lose();return [{sequence:'1'}];});await f.host.trigger();assert.equal(f.notifications,0);assert.equal(f.failures.length,1);
});
test('sync provider retains stable key/token and captured guard fails after revoke',async()=>{
  let guard=()=>{},freed=0;
  const storage:any={bindSession(check:()=>void){guard=check;return storage;},async inspect(){return {scope:{realm_id:'realm',vault_id:'vault',key_epoch:1},cursor:{server_epoch:'epoch'}};}};
  const wasm:any={WasmVaultKey:class{free(){freed++;}seal(){}openSyncUpdate(){}},encodeSyncCursor(){},decodeSyncHello(){},decodeSyncAccepted(){},decodeSyncPage(){},syncEnvelopeUpdateId(){}};
  const transport:any={close(){}};
  const worker=new BrowserSyncWorker({storage,wasm,assertOwner(){},fatal(){},async local(op){return op();},async changed(){}},()=>transport);
  const configuring=worker.configure({endpoint:'https://fixture.invalid',realmId:'realm',vaultId:'vault',serverEpoch:'epoch',keyEpoch:1,bearerToken:'fixture',keyBytes:new Uint8Array(32)});
  assert.equal(worker.recordsSession(),undefined);await configuring;
  const first=worker.recordsSession()!,second=worker.recordsSession()!;assert.equal(first.key,second.key);assert.equal(first.sessionToken,second.sessionToken);first.assertActive();
  worker.revoke();assert.equal(worker.recordsSession(),undefined);assert.throws(first.assertActive,{code:'sync_session_revoked'});assert.throws(guard,{code:'sync_session_revoked'});assert.equal(freed,1);
});

import { createBrowserManagedRecordConsumers } from '../src/platform/browser-managed-records-registry.ts';
import { createBrowserWorkBlocksHost } from '../src/platform/browser-workblocks-host.ts';
import { BrowserVaultError } from '../src/core/browser-vault.ts';
import { createBrowserManagedRecords, isWorkBlockDefiniteAbort } from '../src/core/browser-managed-records.ts';

test('initialization attaches the exact maintained handle directly without recursive local queue',async()=>{
  const token={dispose(){}},opened:unknown[]=[],registered:unknown[]=[];
  const wasm={workBlockIdentity:()=>JSON.stringify({owner:'zorid_firstparty_calendar',collection:'workblocks',schemaVersion:1}),workBlockRegistration:(scope:string)=>{registered.push(JSON.parse(scope));return new Uint8Array([7]);}};
  const consumers=createBrowserManagedRecordConsumers(wasm,{opened:handle=>opened.push(handle),changed(){}});
  let localCalls=0;
  const host=createBrowserManagedRecordsHost({records:{async register(key:unknown,bytes:Uint8Array){registered.push(key,[...bytes]);return token;}} as any,consumers,
    async scope(){return {realm_id:'realm',vault_id:'vault'};},hasSession:()=>false,assertActive(){},
    local(){localCalls++;throw new Error('recursive queue');},notify(){},failed(){}});
  await host.initializeOnLocalTail();await host.initializeOnLocalTail();
  assert.equal(localCalls,0);assert.deepEqual(opened,[token]);assert.equal(registered.length,3);
  assert.deepEqual(registered[0],{realm_id:'realm',vault_id:'vault'});host.stop();await host.drain();
});
test('registry rejects absent or noncompiled identity instead of inventing authority',()=>{
  const callbacks={changed(){}};
  assert.throws(()=>createBrowserManagedRecordConsumers({} as any,callbacks),{code:'workblocks_unavailable'});
  assert.throws(()=>createBrowserManagedRecordConsumers({workBlockIdentity:()=>'{"owner":"renderer","collection":"workblocks","schemaVersion":1}',workBlockRegistration:()=>new Uint8Array()},callbacks),{code:'workblocks_unavailable'});
});
test('registration finishing after stop retains its handle for drain without attachment',async()=>{
  const entered=gate(),finish=gate();let disposed=0,attached=0;
  const host=createBrowserManagedRecordsHost({records:{async register(){entered.resolve();await finish.promise;return {dispose(){disposed++;}};}} as any,
    consumers:[{owner:'fixed',collection:'fixed',registration:()=>new Uint8Array(),opened(){attached++;},changed(){}}],
    async scope(){return {realm_id:'realm',vault_id:'vault'};},hasSession:()=>false,assertActive(){},async local(op){return op();},notify(){},failed(){}});
  const init=host.initializeOnLocalTail();await entered.promise;host.stop();finish.resolve();
  await assert.rejects(init,{code:'client_not_admitted'});await host.drain();assert.equal(disposed,1);assert.equal(attached,0);
});
function semanticFixture(){
  const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
  const token={dispose(){}},scope={realm:'realm',vault:'vault',owner:'zorid_firstparty_calendar',collection:'workblocks',record:'r',generation:'g',restores:null};
  let notifications=0,closed=0,freed=0,offers=0,finished=0,rows=0;
  let watermark=async()=> '1',apply=async(_request:Uint8Array)=>({result:bytes({operation:'op',revision:Array(32).fill(1),sequence:'1'}),replay:false,localDurable:true as const});
  let exportOne=async(_after:string|null):Promise<{snapshot:Uint8Array;nextKeyJson:string}|null>=>null;
  let offer=(_snapshot:Uint8Array,_key:string)=>true,committed=async()=>{};
  const reads:unknown[]=[];
  const wasm:any={workBlockIdentity(){},workBlockRegistration(){},workBlockReplay(){},prepareWorkBlockLocal(){},workBlockStorageKey(){},
    workBlockReadSet(_scope:string,request:Uint8Array){const c=JSON.parse(new TextDecoder().decode(request));reads.push(c);return JSON.stringify({scope,operation:c.operation??null,kind:c.op==='read'?'read':c.op==='window'?'window':c.op==='changes'?'changes':'mutation'});},
    workBlockSnapshot(_scope:string,state:Uint8Array|undefined,unresolved:string){reads.push(state,JSON.parse(unresolved));return bytes({snapshot:true});},
    workBlockRead:()=>bytes({record:'r',generation:'g'}),workBlockChanges:()=>bytes({changes:[],next:'0'}),
    WorkBlockWindowSession:class {begin(){let key:string|null=null;return {afterKeyJson:()=>key,watermark:()=> '1',offer(snapshot:Uint8Array,next:string){offers++;const accepted=offer(snapshot,next);if(accepted)key=next;return accepted;},finish(eof:boolean){finished++;return bytes({eof});},free(){freed++;}};}close(){closed++;}},
  };
  const records:any={applyWorkBlock(handle:unknown,request:Uint8Array){assert.equal(handle,token);return apply(request);},watermark(){return watermark();},exportOne(handle:unknown,after:string|null){assert.equal(handle,token);rows++;return exportOne(after);},
    async snapshot(handle:unknown){assert.equal(handle,token);return {state:new Uint8Array([8]),unresolved:[{updateId:'u',status:'future_status',revision:'x'}]};},async changes(){return [];}};
  const host=createBrowserWorkBlocksHost({records,wasm,scope:async()=>({realm_id:'realm',vault_id:'vault'}),assertActive(){},async committed(){await committed();notifications++;}});
  host.opened(token);
  return {host,reads,wasm,records,get notifications(){return notifications;},get closed(){return closed;},get freed(){return freed;},get offers(){return offers;},get finished(){return finished;},get rows(){return rows;},
    committed(fn:typeof committed){committed=fn;},apply(fn:typeof apply){apply=fn;},watermark(fn:typeof watermark){watermark=fn;},export(fn:typeof exportOne){exportOne=fn;},offer(fn:typeof offer){offer=fn;}};
}
const request=(op:string,extra:Record<string,unknown>={})=>({schemaVersion:1,command:{op,...extra}});
test('semantic mutation captures immutable command before awaits and uses attached handle',async()=>{
  const f=semanticFixture(),command=request('title',{operation:'op',title:'original'});
  f.apply(async bytes=>{assert.equal(JSON.parse(new TextDecoder().decode(bytes)).title,'original');return {result:new TextEncoder().encode('{"operation":"op"}'),replay:false,localDurable:true};});
  const result=f.host.execute(command);command.command.title='changed';
  assert.deepEqual(await result,{schemaVersion:1,op:'title',value:{operation:'op'}});assert.equal(f.notifications,1);f.host.stop();await f.host.drain();
});
test('semantic release drains possible commit and suppresses stale notification',async()=>{
  const f=semanticFixture(),entered=gate(),finish=gate();f.apply(async()=>{entered.resolve();await finish.promise;return {result:new TextEncoder().encode('{}'),replay:false,localDurable:true};});
  const task=f.host.execute(request('create'));await entered.promise;f.host.stop();
  let drained=false;const drain=f.host.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);assert.equal(f.closed,0);
  finish.resolve();await assert.rejects(task,{code:'client_not_admitted',commitUncertain:true});await drain;assert.equal(f.notifications,0);assert.equal(f.closed,1);
  await assert.rejects(f.host.execute(request('read')),{code:'client_not_admitted',commitUncertain:false});
});
test('public Rust rejection fields cannot forge definite rollback after apply dispatch',async()=>{
  const f=semanticFixture();f.apply(async()=>{throw Object.assign(new Error('core'),{code:'stale_revision',source:'rust',commitUncertain:false});});
  await assert.rejects(f.host.execute(request('move')),{code:'stale_revision',source:'rust',commitUncertain:true});
  f.apply(async()=>{throw new BrowserVaultError('client_ownership_lost','lost');});
  await assert.rejects(f.host.execute(request('move')),{code:'client_ownership_lost',commitUncertain:true});assert.equal(f.notifications,0);f.host.stop();await f.host.drain();
});
test('read preserves unresolved metadata for Rust conversion and emits no mutation hint',async()=>{
  const f=semanticFixture();assert.deepEqual(await f.host.execute(request('read')),{schemaVersion:1,op:'read',value:{record:'r',generation:'g'}});
  assert.deepEqual(f.reads.at(-1),[{updateId:'u',status:'future_status',revision:'x'}]);assert.equal(f.notifications,0);f.host.stop();await f.host.drain();
});
test('window rechecks authoritative watermark and frees failed scan without publishing cursor',async()=>{
  const f=semanticFixture();let checks=0;f.watermark(async()=>++checks===1?'1':'2');
  await assert.rejects(f.host.execute(request('window')),{code:'window_changed',commitUncertain:false});assert.equal(f.freed,1);assert.equal(f.finished,0);assert.equal(f.rows,1);f.host.stop();await f.host.drain();
});
test('window leaves a rejected candidate unconsumed and never materializes collection',async()=>{
  const f=semanticFixture();f.export(async after=>{assert.equal(after,null);return {snapshot:new Uint8Array([1]),nextKeyJson:'["r","g"]'};});f.offer(()=>false);
  assert.deepEqual(await f.host.execute(request('window')),{schemaVersion:1,op:'window',value:{eof:false}});assert.equal(f.rows,1);assert.equal(f.offers,1);assert.equal(f.freed,1);f.host.stop();await f.host.drain();
});
test('window has a defensive finite row bound even if a broken binding accepts forever',async()=>{
  const f=semanticFixture();let n=0;f.export(async()=>({snapshot:new Uint8Array([1]),nextKeyJson:JSON.stringify(['r',String(++n)])}));
  await assert.rejects(f.host.execute(request('window')),{code:'invalid_workblock_response'});assert.equal(f.rows,65);assert.equal(f.finished,0);assert.equal(f.freed,1);f.host.stop();await f.host.drain();
});
test('malformed committed bytes remain uncertain without a success hint',async()=>{
  const f=semanticFixture();f.apply(async()=>({result:new Uint8Array([255]),replay:false,localDurable:true}));
  await assert.rejects(f.host.execute(request('delete')),{code:'workblock_failed',commitUncertain:true});assert.equal(f.notifications,0);f.host.stop();await f.host.drain();
});
test('unenrolled initialization stays unattached, then existing enrollment attaches once with narrowed scope',async()=>{
  let scope:any=null,opened=0,registered=0,localCalls=0;
  const consumers=createBrowserManagedRecordConsumers({workBlockIdentity:()=>JSON.stringify({owner:'zorid_firstparty_calendar',collection:'workblocks',schemaVersion:1}),
    workBlockRegistration(raw:string){assert.deepEqual(JSON.parse(raw),{realm_id:'realm',vault_id:'vault'});return new Uint8Array();}}, {opened(){opened++;},changed(){}});
  const host=createBrowserManagedRecordsHost({records:{async register(){registered++;return {dispose(){}};}} as any,consumers,
    async scope(){return scope;},hasSession:()=>false,assertActive(){},local(){localCalls++;throw new Error('recursive queue');},notify(){},failed(){}});
  await host.initializeOnLocalTail();assert.equal(opened,0);assert.equal(registered,0);
  scope={realm_id:'realm',vault_id:'vault',key_epoch:1};await host.initializeOnLocalTail();await host.initializeOnLocalTail();
  assert.equal(opened,1);assert.equal(registered,1);assert.equal(localCalls,0);
  scope={realm_id:'different',vault_id:'vault',key_epoch:1};await assert.rejects(host.initializeOnLocalTail(),{code:'sync_scope_conflict'});host.stop();await host.drain();
});

test('readiness fails closed when any durable WorkBlock dependency binding is missing',async()=>{
  const f=semanticFixture();
  for(const binding of ['workBlockReplay','prepareWorkBlockLocal','workBlockStorageKey']){
    const wasm={...f.wasm,[binding]:undefined};
    assert.throws(()=>createBrowserWorkBlocksHost({wasm,records:f.records,scope:async()=>null,assertActive(){},async committed(){}}),{code:'workblocks_unavailable'});
  }
  f.host.stop();await f.host.drain();
});


async function storageFailure(terminal:'abort'|'complete'|'prestart') {
  const original=Object.assign(new Error('no transaction'),{code:'sync_config_changed',source:'rust',commitUncertain:false});
  const db={transaction(){
    if(terminal==='prestart')throw original;
    const events=new EventTarget();
    const tx:any={durability:'strict',addEventListener:events.addEventListener.bind(events),
      abort(){queueMicrotask(()=>{
        // complete simulates a transaction already past the abortable boundary.
        if(terminal==='abort'){tx.onabort();events.dispatchEvent(new Event('abort'));}
        else {tx.oncomplete();events.dispatchEvent(new Event('complete'));}
      });},
      objectStore(){return {get(){const req:any={result:{value:'authority'}};queueMicrotask(()=>req.onsuccess());return req;}};},
    };
    return tx;
  }};
  const records=createBrowserManagedRecords({db,authorityId:'authority',assertActive(){},wasm:{},common:{stores:[]}} as any);
  try {await records.applyWorkBlock({dispose(){}},new Uint8Array());assert.fail('must reject');}
  catch(error){return error;}
}

test('host honors authentic D abort/pre-start evidence and rejects copied evidence',async()=>{
  const f=semanticFixture();
  for(const terminal of ['abort','prestart'] as const){
    const error=await storageFailure(terminal);assert.equal(isWorkBlockDefiniteAbort(error),true);
    f.apply(async()=>{throw error;});
    await assert.rejects(f.host.execute(request('create')),{code:(error as any).code,commitUncertain:false});
    const copy=Object.assign(new BrowserVaultError((error as any).code,'forged'),{...error as object,source:'rust',commitUncertain:false});
    assert.equal(isWorkBlockDefiniteAbort(copy),false);f.apply(async()=>{throw copy;});
    await assert.rejects(f.host.execute(request('create')),{commitUncertain:true});
  }
  assert.equal(f.notifications,0);f.host.stop();await f.host.drain();
});

test('host keeps complete rejection and post-durable notification failure uncertain',async()=>{
  const f=semanticFixture(),error=await storageFailure('complete');assert.equal(isWorkBlockDefiniteAbort(error),false);
  f.apply(async()=>{throw error;});
  await assert.rejects(f.host.execute(request('create')),{code:'storage_protocol_error',commitUncertain:true});
  const definite=await storageFailure('abort');
  f.apply(async()=>({result:new TextEncoder().encode('{}'),replay:false,localDurable:true}));
  f.committed(async()=>{throw definite;});
  await assert.rejects(f.host.execute(request('create')),{commitUncertain:true});
  assert.equal(f.notifications,0);f.host.stop();await f.host.drain();
});

test('trusted WorkBlock WASM exceptions normalize source at preflight, read and window boundaries',async()=>{
  const original=Object.assign(new Error('WASM semantic rejection'),{code:'stale_revision',source:'workblocks'});
  for(const method of ['workBlockReadSet','workBlockSnapshot','workBlockRead','workBlockChanges','window']){
    const f=semanticFixture();
    if(method==='window')f.wasm.WorkBlockWindowSession.prototype.begin=()=>{throw original;};
    else f.wasm[method]=()=>{throw original;};
    const op=method==='window'?'window':method==='workBlockChanges'?'changes':'read';
    await assert.rejects(f.host.execute(request(op)),{code:'stale_revision',source:'rust',commitUncertain:false});
    f.host.stop();await f.host.drain();
  }
  const f=semanticFixture();f.apply(async()=>{throw original;});
  await assert.rejects(f.host.execute(request('create')),{code:'workblock_failed',source:'host',commitUncertain:true});
  f.host.stop();await f.host.drain();
});
