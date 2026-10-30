import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {openVersionHistory} from '../src/ui/version-history.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
const scope={vaultId:'history-store',clientId:'history-client'},version={entryId:'entry',snapshotId:'2',path:'Note.md',capturedAtMs:100,byteLength:3};
const failure=(code:string,source='host')=>({durableError:true,schemaVersion:1,error:{code,source,commitUncertain:false}});
async function fixture(t:TestContext){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:{admission:string;method:string;args:unknown[]}[]=[];
 let generation=1,legacy=0,failRead=false,foreign=false,listBusy=false;
 const binding=()=>({admissionId:'admission-'+generation,scope:{...scope,...(foreign?{vaultId:'foreign'}:{})},recoveryHistoryAvailable:true});
 const bridge={getVault:async()=>({path:'/history-fixture',name:'History'}),onChange:()=>()=>{},onDocumentRuntimeNudge:()=>()=>{},
  recoveryList:async()=>{legacy++;throw Error('Legacy history read is not retry authority');},recoveryRead:async()=>{legacy++;throw Error('Legacy history read is not retry authority');},
  async durableRequest(input:any){
   if(input.kind==='context')return binding();
   if(input.kind==='recover'){generation++;return binding();}
   if(input.kind==='release')return;
   assert.equal(input.kind,'invoke');calls.push({admission:input.admissionId,method:input.method,args:structuredClone(input.args)});
   if(input.method==='recoveryList'){if(listBusy){listBusy=false;return failure('storage_busy');}return{versions:[{...version}]};}
   if(input.method==='recoveryRead'){if(failRead){failRead=false;return failure('client_not_admitted');}return{version:{...version},content:'old'};}
   if(input.method==='listUnacknowledged')return[];
   throw Error('Unexpected '+input.method);
  }};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
 const platform=(await createPlatformAdapter())!;
 return{platform,calls,bridge,retireNext(){failRead=true;},busyList(){listBusy=true;},foreign(){foreign=true;},get legacy(){return legacy;},get generation(){return generation;}};
}

test('history uses the admitted typed transport with exact entry, cursor and snapshot',async t=>{
 const f=await fixture(t),history=f.platform.recoveryHistory!;assert.ok(history);
 const cursor={captured_at_ms:101,snapshot_id:'3'},page=await history.list('entry',{limit:20,before:cursor});cursor.snapshot_id='9';
 assert.equal(page.versions[0].entryId,'entry');assert.equal((await history.read('entry','2')).content,'old');assert.equal(f.legacy,0);
 assert.deepEqual(f.calls.map(row=>row.method),['recoveryList','recoveryRead']);assert.deepEqual(f.calls[0].args,['entry',{limit:20,before:{captured_at_ms:101,snapshot_id:'3'}}]);
 await f.platform.release!();
});

test('retained history forwards repeated same-scope availability and exact reads across recovery generations',async t=>{
 const f=await fixture(t),history=f.platform.recoveryHistory!;let available=0;const stop=history.subscribeAvailable!(()=>available++);
 f.retireNext();assert.equal((await history.read('entry','2')).content,'old');assert.equal(available,1);assert.equal(f.generation,2);
 f.retireNext();assert.equal((await history.read('entry','2')).content,'old');assert.equal(available,2);assert.equal(f.generation,3);
 assert.deepEqual(f.calls.filter(row=>row.method==='recoveryRead').map(row=>row.admission),['admission-1','admission-2','admission-2','admission-3']);stop();await f.platform.release!();
});

test('foreign recovery scope never grants a history availability event or fresh read authority',async t=>{
 const f=await fixture(t),history=f.platform.recoveryHistory!;let available=0;const stop=history.subscribeAvailable!(()=>available++);f.foreign();
 await assert.rejects(f.platform.recovery!.recover(),{code:'durable_recovery_scope_changed'});assert.equal(available,0);assert.equal(f.calls.length,0);stop();await f.platform.release!();
});


test('actual mounted history and typed platform heal list IO then retired preview without legacy reads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),dom=new JSDOM('<body></body>',{pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const[key,value]of Object.entries({document:dom.window.document,MutationObserver:dom.window.MutationObserver})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
 t.after(()=>{dom.window.close();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 f.busyList();const dialog=openVersionHistory({history:f.platform.recoveryHistory!,entryId:'entry',isCurrent:()=>true,restore:async()=>'restored'});
 await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(document.body.textContent!,/try again|unavailable/i);t.mock.timers.tick(500);await new Promise(resolve=>setImmediate(resolve));
 f.retireNext();document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(document.querySelector<HTMLTextAreaElement>('.version-history-preview')!.value,'old');assert.equal(f.generation,2);assert.equal(f.legacy,0);
 assert.deepEqual(f.calls.map(row=>row.method),['recoveryList','recoveryList','recoveryRead','recoveryRead']);assert.doesNotMatch(document.body.textContent!,/try again|unavailable/i);dialog.close();await f.platform.release!();
});

test('history release stops forwarded availability and forbids later reads from its old owner',async t=>{
 const f=await fixture(t),history=f.platform.recoveryHistory!;let available=0;history.subscribeAvailable!(()=>available++);
 const fresh=await f.platform.recovery!.recover();assert.equal(available,1);await f.platform.release!();await fresh.recovery!.recover();assert.equal(available,1);
 await assert.rejects(history.read('entry','2'),{code:'client_not_admitted'});await fresh.release!();
});
