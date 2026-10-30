import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {openVersionHistory} from '../src/ui/version-history.ts';
import type {RecoveryHistory,RecoveryVersion} from '../src/platform/bridge';
const version=(snapshotId='2'):RecoveryVersion=>({snapshotId,entryId:'entry',path:'Note.md',capturedAtMs:1700000000000,byteLength:3});
const fault=(code:string,source='host')=>Object.assign(new Error(code),{code,source,commitUncertain:false});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(t:TestContext,overrides:Partial<RecoveryHistory>={}){
 const dom=new JSDOM('<body><button id="previous">History</button></body>',{pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),listeners=new Set<()=>void>();
 for(const[key,value]of Object.entries({document:dom.window.document,MutationObserver:dom.window.MutationObserver})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
 t.after(()=>{dom.window.close();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});t.mock.method(console,'error',()=>{});
 let current=true,restores=0;
 const history={list:async()=>({versions:[version(),version('1')]}),read:async(_id:string,id:string)=>({version:version(id),content:'old'}),subscribeAvailable(listener:()=>void){listeners.add(listener);return()=>listeners.delete(listener);},...overrides} as RecoveryHistory;
 const dialog=openVersionHistory({history,entryId:'entry',isCurrent:()=>current,restore:async()=>{restores++;return'restored';}});
 return{dom,dialog,listeners,history,retire(){current=false;},get restores(){return restores;}};
}
const preview=()=>document.querySelector<HTMLTextAreaElement>('.version-history-preview')!;
const row=(index=0)=>document.querySelectorAll<HTMLButtonElement>('.version-history-version')[index]!;

test('a mounted history page retries its exact cursor after typed temporary storage failure without a retry notice',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls:unknown[]=[];const f=fixture(t,{list:async(id,options)=>{calls.push({id,options:structuredClone(options)});if(calls.length===1)throw fault('storage_busy');return{versions:[version()]};}});
 await settle();assert.equal(calls.length,1);assert.doesNotMatch(document.body.textContent!,/try again|couldn.t be opened/i);
 t.mock.timers.tick(500);await settle();assert.deepEqual(calls,[{id:'entry',options:{limit:20}},{id:'entry',options:{limit:20}}]);assert.ok(row());f.dialog.close();
});

test('a mounted selected preview automatically retries the original snapshot and remains usable',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls:string[]=[];const f=fixture(t,{read:async(_id,id)=>{calls.push(id);if(calls.length===1)throw fault('filesystem_io_retryable');return{version:version(id),content:'old'};}});
 await settle();row().click();await settle();assert.equal(calls.length,1);assert.doesNotMatch(document.body.textContent!,/selecting it again|couldn.t be opened/i);
 t.mock.timers.tick(500);await settle();assert.deepEqual(calls,['2','2']);assert.equal(preview().value,'old');assert.equal(document.querySelector<HTMLButtonElement>('.mod-cta')!.disabled,false);f.dialog.close();
});

test('changing version cancels the held older preview and never adopts its late result',async t=>{
 const old=deferred<{version:RecoveryVersion;content:string}>(),calls:string[]=[];const f=fixture(t,{read:async(_id,id)=>{calls.push(id);return id==='2'?old.promise:{version:version(id),content:'new'};}});
 await settle();row().click();await settle();row(1).click();await settle();assert.deepEqual(calls,['2','1']);assert.equal(preview().value,'new');old.resolve({version:version('2'),content:'old'});await settle();assert.equal(preview().value,'new');f.dialog.close();
});

test('positive same-scope availability racing a retired read is not lost and close unsubscribes',async t=>{
 const held=deferred<{version:RecoveryVersion;content:string}>();let calls=0;const f=fixture(t,{read:async()=>++calls===1?held.promise:{version:version(),content:'old'}});
 await settle();row().click();await settle();assert.equal(f.listeners.size,1);for(const listener of f.listeners)listener();held.reject(fault('client_not_admitted'));await settle();assert.equal(calls,2);assert.equal(preview().value,'old');f.dialog.close();assert.equal(f.listeners.size,0);
});

test('admission errors never use elapsed time as authority and close cancels the wait',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const f=fixture(t,{read:async()=>{calls++;throw fault('client_not_admitted');}});
 await settle();row().click();await settle();t.mock.timers.tick(90000);await settle();assert.equal(calls,1);f.dialog.close();for(const listener of f.listeners)listener();await settle();assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(f.listeners.size,0);assert.equal(calls,1);
});

for(const [code,source]of [['permission_denied','host'],['storage_corrupt','host'],['invalid_durable_response','protocol'],['not_found','host'],['storage_busy','protocol']] as const)test(`terminal ${source} ${code} remains truthful and never retries`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const f=fixture(t,{read:async()=>{calls++;throw fault(code,source);}});
 await settle();row().click();await settle();assert.match(document.body.textContent!,/unavailable|couldn.t be opened/i);assert.doesNotMatch(document.body.textContent!,/try selecting|try again|reopen/i);t.mock.timers.tick(90000);await settle();assert.equal(calls,1);assert.equal(f.restores,0);f.dialog.close();
});


test('closing a held page cancels its continuation and ignores late rows',async t=>{
 const held=deferred<{versions:RecoveryVersion[]}>(),f=fixture(t,{list:()=>held.promise});f.dialog.close();held.resolve({versions:[version()]});await settle();assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(f.listeners.size,0);
});
