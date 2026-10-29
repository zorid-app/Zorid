'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');
const gate=()=>{let resolve;return{promise:new Promise(done=>{resolve=done;}),resolve};};
async function turn(){for(let i=0;i<30;i++)await Promise.resolve();}
function transport(){
 const host=Object.create(RustVaultService.prototype),writes=[];let now=0;
 Object.assign(host,{capabilities:['local_recovery_maintenance'],sequence:0n,queuedBytes:0,queuedCount:0,tail:Promise.resolve(),ready:Promise.resolve(),closing:false,fatal:null,exited:false,activityClock:()=>now,activityEpoch:0,lastActivityAt:0,activityListeners:new Set(),child:{stdin:{write:value=>writes.push(Buffer.from(value))}},expect(){return Promise.resolve({result:{available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000},bytes:new Uint8Array()});}});
 return{host,writes,time(value){now=value;}};
}

test('private history waits for quiet and yields before bytes to any newly queued RPC',async()=>{
 const f=transport();f.time(300);
 const history=f.host.localRecoveryMaintenance(()=>{},250);
 const ordinary=f.host.request({method:'identity'});
 await assert.rejects(history,error=>error.code==='local_recovery_deferred');await ordinary;await f.host.tail;
 assert.equal(f.writes.length,3,'only the ordinary frame was dispatched');
 f.time(600);const reply=await f.host.localRecoveryMaintenance(()=>{},250);
 assert.equal(reply.available,true);assert.equal(f.writes.length,6);
 assert.equal(f.host.queuedCount,0);
});

test('quiet activity includes request settlement and history never marks itself as foreground activity',async()=>{
 const f=transport(),pending=gate();let notifications=0;
 f.host.subscribeActivity(()=>{notifications++;});f.host.expect=()=>pending.promise;
 const ordinary=f.host.request({method:'identity'});await turn();f.time(500);
 assert.equal(f.host.localRecoveryIdleDelay(250),null);
 pending.resolve({result:{},bytes:new Uint8Array()});await ordinary;await f.host.tail;
 assert.equal(f.host.localRecoveryIdleDelay(250),250);assert.equal(notifications,2);
 f.time(750);const epoch=f.host.activityEpoch;
 f.host.expect=async()=>({result:{available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000},bytes:new Uint8Array()});
 await f.host.localRecoveryMaintenance(()=>{},250);
 assert.equal(f.host.activityEpoch,epoch);assert.equal(f.host.localRecoveryIdleDelay(250),0);
});
function scheduler(){
 let now=0,activityAt=0,next=0,active=true,reply={available:true,ran:true,pending:true,failed_notes:0,retry_after_ms:1000};
 const timers=new Map(),activity=new Set(),events=[],calls=[];
 const host={root:'/owned-history-fixture',capabilities:['documents','document_runtime','local_recovery_maintenance'],
  subscribeActivity(listener){activity.add(listener);return()=>activity.delete(listener);},
  localRecoveryIdleDelay(quiet){return Math.max(0,quiet-(now-activityAt));},
  async localRecoveryMaintenance(guard){guard();calls.push({at:now,guard});if(typeof reply==='function')return reply(guard);return reply;},
  async listSnapshot(){return{entries:[],cursor:'0'};},async close(){events.push('host-close');},
 };
 const service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000,documentRuntime:true,now:()=>now,
  historySetTimeout(callback,delay){const id=++next;timers.set(id,{callback,at:now+delay});return id;},historyClearTimeout(id){timers.delete(id);}});
 service.startPolling=()=>{};service.notify=value=>events.push(value);
 service.documentScheduler={addOwner(){let retired;return{subscribe(_listener,onRetire){retired=onRetire;},async pause(){},resume(){},async prepareRelease(){},release(){retired?.();},async revoke(){retired?.();}};},async close(){}};
 return{host,service,timers,events,calls,
  admit(){return service.registerDocumentRuntimeOwner({host:{},assertActive(){if(!active)throw Object.assign(new Error('retired'),{code:'grant_retired'});}});},
  time(value){now=value;},activity(value){now=value;activityAt=value;for(const listener of activity)listener();},setReply(value){reply=value;},retire(){active=false;},
  async fire(value){now=value;const due=[...timers].filter(([,timer])=>timer.at<=now);for(const[id,timer]of due){timers.delete(id);timer.callback();}await turn();},
 };
}
test('history starts only with admission, preserves pending due across activity, then sleeps five minutes',async()=>{
 const f=scheduler();assert.equal(f.timers.size,0);const owner=f.admit();assert.equal(f.calls.length,0);
 await f.fire(249);assert.equal(f.calls.length,0);await f.fire(250);assert.equal(f.calls.length,1);
 assert.equal(f.service.historyNextDue,1250);f.activity(1200);assert.equal(f.service.historyNextDue,1250);
 await f.fire(1250);assert.equal(f.calls.length,1);
 f.setReply({available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000});
 await f.fire(1450);assert.equal(f.calls.length,2);assert.equal(f.service.historyNextDue,301450);
 await owner.pause();assert.equal(f.timers.size,0);await f.service.close();
});
test('history dispatch rechecks owner and does not expose its method or capability to leased contexts',async()=>{
 const f=transport();f.time(300);let active=true;
 const pending=f.host.localRecoveryMaintenance(()=>{if(!active)throw Object.assign(new Error('retired'),{code:'grant_retired'});},250);
 active=false;await assert.rejects(pending,error=>error.code==='grant_retired');assert.equal(f.writes.length,0);
 const leased=f.host.withClientLease({local_store_id:'store',client_id:'client',token:'token'});
 assert.equal(leased.localRecoveryMaintenance,undefined);assert.equal(leased.subscribeActivity,undefined);
 assert.equal(leased.capabilities.includes('local_recovery_maintenance'),false);
});

test('retired timer, replaced host and unavailable owner cannot dispatch history',async()=>{
 for(const change of ['paused','host','owner']){
  const f=scheduler(),owner=f.admit(),old=[...f.timers.values()][0].callback;
  if(change==='paused')await owner.pause();else if(change==='host')f.service.host={};else f.retire();
  f.time(1000);old();await turn();assert.equal(f.calls.length,0,change);assert.equal(f.events.length,0,change);
  f.service.host=f.host;await f.service.close();
 }
});

test('pause drains accepted history and rejects its late status without consuming the obligation',async()=>{
 const f=scheduler(),owner=f.admit(),held=gate();f.setReply(()=>held.promise);
 await f.fire(250);assert.equal(f.calls.length,1);let paused=false;
 const pause=owner.pause().then(()=>{paused=true;});await turn();assert.equal(paused,false);
 held.resolve({available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000});await pause;
 assert.equal(f.service.historyNextDue,0);assert.equal(f.service.historyLastStatus,null);assert.equal(f.events.length,0);
 owner.resume();assert.ok(f.timers.size);await f.service.close();
});

test('history failure stays diagnostic and backs off without poisoning ordinary reads',async()=>{
 const f=scheduler();f.admit();f.setReply(()=>Promise.reject(Object.assign(new Error('history unavailable'),{code:'local_recovery_unavailable'})));
 await f.fire(250);assert.equal(f.calls.length,1);assert.equal(f.service.historyLastError,'local_recovery_unavailable');
 assert.equal(f.service.historyNextDue,300250);assert.equal(f.events.length,0);assert.equal(f.service.runtimeFailed,undefined);
 assert.deepEqual(await f.service.list(),[]);await f.fire(1250);assert.equal(f.calls.length,1);await f.service.close();
});

test('close cancels scheduling, drains accepted history, then closes exactly the owned host',async()=>{
 const f=scheduler(),held=gate();f.admit();f.setReply(()=>held.promise);await f.fire(250);
 let closed=false;const closing=f.service.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);assert.equal(f.timers.size,0);assert.deepEqual(f.events,[]);
 held.resolve({available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000});await closing;
 assert.deepEqual(f.events,['host-close']);assert.equal(f.service.historyLastStatus,null);
 f.activity(1000);assert.equal(f.timers.size,0);
});
test('a backoff status does not claim a failed history store recovered without a successful step',async()=>{
 const f=scheduler();f.admit();f.setReply(()=>Promise.reject(Object.assign(new Error('history unavailable'),{code:'local_recovery_unavailable'})));
 await f.fire(250);assert.equal(f.service.historyLastError,'local_recovery_unavailable');
 f.setReply({available:true,ran:false,pending:true,failed_notes:0,retry_after_ms:1000});
 await f.fire(300250);assert.equal(f.service.historyLastError,'local_recovery_unavailable');
 f.setReply({available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000});
 await f.fire(301250);assert.equal(f.service.historyLastError,null);await f.service.close();
});
