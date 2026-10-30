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

test('a failed page performs one request and never schedules or subscribes for automatic retries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const f=fixture(t,{list:async()=>{calls++;throw fault('storage_busy');}});
 await settle();assert.equal(calls,1);assert.match(document.body.textContent!,/Version history is unavailable/);assert.equal(f.listeners.size,0);
 t.mock.timers.tick(90000);for(const listener of f.listeners)listener();await settle();assert.equal(calls,1);assert.equal(document.querySelector('[role=dialog]')?.getAttribute('aria-busy'),'false');f.dialog.close();
});

test('a failed preview reads once per explicit selection, without elapsed-time or availability retries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls:string[]=[];const f=fixture(t,{read:async(_id,id)=>{calls.push(id);if(calls.length===1)throw fault('filesystem_io_retryable');return{version:version(id),content:'old'};}});
 await settle();row().click();await settle();assert.deepEqual(calls,['2']);assert.match(document.body.textContent!,/This saved version is unavailable/);assert.equal(f.listeners.size,0);
 t.mock.timers.tick(90000);for(const listener of f.listeners)listener();await settle();assert.deepEqual(calls,['2']);assert.equal(row().disabled,false);
 row().click();await settle();assert.deepEqual(calls,['2','2']);assert.equal(preview().value,'old');assert.equal(document.querySelector<HTMLButtonElement>('.mod-cta')!.disabled,false);f.dialog.close();
});

for(const outcome of ['fulfilled','rejected'] as const)test(`a superseded ${outcome} read cannot validate, paint errors, or finish the current selection`,async t=>{
 const old=deferred<{version:RecoveryVersion;content:string}>(),next=deferred<{version:RecoveryVersion;content:string}>(),calls:string[]=[];let staleValidation=0;
 const f=fixture(t,{read:async(_id,id)=>{calls.push(id);return id==='2'?old.promise:next.promise;}});
 await settle();row().click();await settle();assert.equal(row(1).disabled,false,'selection remains switchable while the first request is held');row(1).click();await settle();
 assert.deepEqual(calls,['2','1']);if(outcome==='fulfilled')old.resolve({get version(){staleValidation++;throw Error('obsolete metadata must not be read');},content:'old'});else old.reject(fault('storage_corrupt'));
 await settle();assert.equal(staleValidation,0);assert.equal(preview().value,'');assert.equal(document.querySelector('[role=dialog]')?.getAttribute('aria-busy'),'true');assert.equal(document.querySelector<HTMLButtonElement>('.mod-cta')!.disabled,true);assert.equal(document.querySelector('.version-history-message')!.textContent,'');
 next.resolve({version:version('1'),content:'new'});await settle();assert.equal(preview().value,'new');assert.equal(document.querySelector('[role=dialog]')?.getAttribute('aria-busy'),'false');f.dialog.close();
});

test('an admission failure is unavailable immediately and a different explicit selection remains usable',async t=>{
 let calls=0;const f=fixture(t,{read:async(_id,id)=>{calls++;if(id==='2')throw fault('client_not_admitted');return{version:version(id),content:'new'};}});
 await settle();row().click();await settle();assert.match(document.body.textContent!,/unavailable/);assert.equal(document.querySelector('[role=dialog]')?.getAttribute('aria-busy'),'false');assert.equal(f.listeners.size,0);
 row(1).click();await settle();assert.equal(calls,2);assert.equal(preview().value,'new');f.dialog.close();
});

for(const [code,source]of [['permission_denied','host'],['storage_corrupt','host'],['invalid_durable_response','protocol'],['not_found','host'],['storage_busy','protocol']] as const)test(`terminal ${source} ${code} remains truthful and never retries`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const f=fixture(t,{read:async()=>{calls++;throw fault(code,source);}});
 await settle();row().click();await settle();assert.match(document.body.textContent!,/unavailable|couldn.t be opened/i);assert.doesNotMatch(document.body.textContent!,/try selecting|try again|reopen/i);t.mock.timers.tick(90000);await settle();assert.equal(calls,1);assert.equal(f.restores,0);f.dialog.close();
});


test('closing a held page cancels its continuation and ignores late rows',async t=>{
 const held=deferred<{versions:RecoveryVersion[]}>();let inspected=0;const f=fixture(t,{list:()=>held.promise});f.dialog.close();held.resolve({get versions(){inspected++;return[version()];}});await settle();assert.equal(inspected,0);assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(f.listeners.size,0);
});


for(const outcome of ['fulfilled','rejected'] as const)test(`closing a held ${outcome} preview prevents late adoption`,async t=>{
 const held=deferred<{version:RecoveryVersion;content:string}>();let inspected=0;const f=fixture(t,{read:()=>held.promise});
 await settle();row().click();await settle();const detached=preview();f.dialog.close();
 if(outcome==='fulfilled')held.resolve({get version(){inspected++;return version();},content:'old'});else held.reject(fault('permission_denied'));
 await settle();assert.equal(inspected,0);assert.equal(detached.value,'');assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(f.restores,0);
});

test('a stale vault owner ignores a held page before inspecting its results',async t=>{
 const held=deferred<{versions:RecoveryVersion[]}>();let inspected=0;const f=fixture(t,{list:()=>held.promise});f.retire();held.resolve({get versions(){inspected++;return[version()];}});await settle();assert.equal(inspected,0);assert.equal(document.querySelector('[role=dialog]'),null);
});

test('restoration closes the dialog only after its save actually completes',async t=>{
 const f=fixture(t),held=deferred<void>();let saves=0;
 f.dialog.close();const dialog=openVersionHistory({history:f.history,entryId:'entry',isCurrent:()=>true,restore:async content=>{assert.equal(content,'old');saves++;await held.promise;return'restored';}});
 await settle();row().click();await settle();document.querySelector<HTMLButtonElement>('.mod-cta')!.click();await settle();assert.equal(saves,1);assert.ok(document.querySelector('[role=dialog]'));held.resolve();await settle();assert.equal(document.querySelector('[role=dialog]'),null);dialog.close();assert.equal(saves,1);
});
