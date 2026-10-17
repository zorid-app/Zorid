import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserSyncWorker} from '../src/platform/browser-sync-worker.ts';
import type {BrowserSyncFixtureCredentials} from '../src/platform/browser-sync-worker.ts';
const credentials=():BrowserSyncFixtureCredentials=>({endpoint:'http://127.0.0.1:1234',realmId:'realm',vaultId:'vault',serverEpoch:'epoch',keyEpoch:1,bearerToken:'secret',keyBytes:new Uint8Array(32).fill(1),allowLoopbackHttp:true,enrollEmpty:true});
const encoder=new TextEncoder();
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(){
  const events:string[]=[],pending=[{metadata:{key:{update_id:'outgoing'}}}];
  let cursor:any=null,freed=0,changed=0,owner=true,guard=()=>{};
  let hello:()=>Promise<Uint8Array>=async()=>encoder.encode('{"raw":1,"raw":2}');
  const received:any[]=[];
  const storage:any={
    bindSession(check:()=>void){guard=check;return storage;},
    async enroll(){guard();events.push('enroll');},
    async inspect(){guard();return{scope:{realm_id:'realm',vault_id:'vault',key_epoch:1},cursor};},
    async setCursor(next:any){guard();cursor=next;events.push('initial-cursor');},
    async pending(){guard();return pending;},
    async seal(){guard();events.push('durable-seal');return new Uint8Array([4,5]);},
    async acknowledge(){guard();events.push('durable-ack');pending.length=0;},
    async receive(id:string,wire:Uint8Array,key:unknown,delivery:any){guard();assert.deepEqual(delivery.expected,cursor);cursor=delivery.next;received.push({id,wire,delivery});events.push('atomic-receive');},
  };
  const wasm:any={
    WasmVaultKey:class{free(){freed++;}seal(){guard();return new Uint8Array();}openSyncUpdate(){guard();}},
    encodeSyncCursor(input:string){events.push('rust-cursor');return input;},
    decodeSyncHello(expected:string,raw:Uint8Array){assert.deepEqual(JSON.parse(expected),{realm_id:'realm',server_epoch:'epoch'});assert.equal(new TextDecoder().decode(raw),'{"raw":1,"raw":2}');events.push('rust-hello');},
    decodeSyncAccepted(expected:string){assert.deepEqual(JSON.parse(expected),{vault_id:'vault',update_id:'outgoing',server_epoch:'epoch'});events.push('rust-ack');return '{}';},
    decodeSyncPage(expected:string){assert.deepEqual(JSON.parse(expected),{server_epoch:'epoch',after:'0',through:null});events.push('rust-page');return JSON.stringify({items:[{sequence:'1',wire:[8,9]}],through:'1',complete:true});},
    syncEnvelopeUpdateId(){events.push('rust-route');return 'incoming';},
  };
  const transport:any={
    hello:()=>hello(),
    async upload(id:string,wire:Uint8Array){assert.equal(id,'outgoing');assert.deepEqual(wire,new Uint8Array([4,5]));events.push('http-upload');return new Uint8Array();},
    async pull(cursorJson:string){assert.deepEqual(JSON.parse(cursorJson),{server_epoch:'epoch',after:'0'});events.push('http-pull');return new Uint8Array();},
    close(){events.push('http-close');},
  };
  const host:any={storage,wasm,assertOwner(){if(!owner)throw new Error('owner lost');},async local(op:()=>Promise<unknown>){return op();},async changed(check:()=>void){check();changed++;}};
  const worker=new BrowserSyncWorker(host,()=>transport);
  return{worker,events,received,wasm,host,pending,get freed(){return freed;},get changed(){return changed;},get cursor(){return cursor;},setHello(fn:typeof hello){hello=fn;},retire(){owner=false;}};
}
test('sweep persists exact wire before upload, decodes raw ACK before acceptance, atomically receives cursor',async()=>{
  const f=fixture(),input=credentials();await f.worker.configure(input);
  assert.ok(input.keyBytes.every(value=>value===0));
  assert.deepEqual(await f.worker.once(),{uploaded:1,received:1,complete:true});
  assert.deepEqual(f.events,['enroll','initial-cursor','rust-hello','durable-seal','http-upload','rust-ack','durable-ack','rust-cursor','http-pull','rust-page','rust-route','atomic-receive']);
  assert.equal(f.cursor.after,'1');assert.equal(f.changed,1);assert.equal(f.received[0].id,'incoming');
  f.worker.revoke();assert.equal(f.freed,1);f.worker.revoke();assert.equal(f.freed,1);
});
test('revoke during HTTP fences later storage work and frees key exactly once',async()=>{
  const f=fixture(),response=deferred<Uint8Array>(),entered=deferred<void>();
  f.setHello(()=>{entered.resolve();return response.promise;});
  await f.worker.configure(credentials());
  const pending=f.worker.once();await entered.promise;f.worker.revoke();response.resolve(encoder.encode('{}'));
  await assert.rejects(pending,{code:'sync_session_revoked'});
  assert.equal(f.freed,1);assert.ok(!f.events.includes('durable-seal'));assert.equal(f.changed,0);
  await assert.rejects(f.worker.once(),{code:'sync_not_configured'});
});
test('revoke fences queued enrollment before it mutates storage',async()=>{
  const f=fixture(),gate=deferred<void>();
  f.host.local=async(op:()=>Promise<unknown>)=>{await gate.promise;return op();};
  const configured=f.worker.configure(credentials());f.worker.revoke();gate.resolve();
  await assert.rejects(configured,{code:'sync_session_revoked'});
  assert.deepEqual(f.events,['http-close']);assert.equal(f.freed,1);
});
test('concurrent sweep requests coalesce, and network waiting does not occupy local scheduler',async()=>{
  const f=fixture(),gate=deferred<Uint8Array>(),entered=deferred<void>();
  f.setHello(()=>{entered.resolve();return gate.promise;});await f.worker.configure(credentials());
  const first=f.worker.once(),second=f.worker.once();assert.equal(first,second);await entered.promise;
  let ran=false;await f.host.local(async()=>{ran=true;});assert.equal(ran,true);
  gate.resolve(encoder.encode('{"raw":1,"raw":2}'));await first;assert.equal(f.events.filter(e=>e==='http-upload').length,1);
});
test('raw codec rejection never acknowledges an upload and does not expose secret errors',async()=>{
  const f=fixture();f.wasm.decodeSyncAccepted=()=>{throw new Error('secret-token and private payload');};
  await f.worker.configure(credentials());await assert.rejects(f.worker.once(),{code:'sync_protocol_rejected',message:'Browser sync session could not complete'});
  assert.ok(!f.events.includes('durable-ack'));assert.equal(f.pending.length,1);
});
