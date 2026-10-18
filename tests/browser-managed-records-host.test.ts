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
  await worker.configure({endpoint:'https://fixture.invalid',realmId:'realm',vaultId:'vault',serverEpoch:'epoch',keyEpoch:1,bearerToken:'fixture',keyBytes:new Uint8Array(32)});
  const first=worker.recordsSession()!,second=worker.recordsSession()!;assert.equal(first.key,second.key);assert.equal(first.sessionToken,second.sessionToken);first.assertActive();
  worker.revoke();assert.equal(worker.recordsSession(),undefined);assert.throws(first.assertActive,{code:'sync_session_revoked'});assert.throws(guard,{code:'sync_session_revoked'});assert.equal(freed,1);
});
