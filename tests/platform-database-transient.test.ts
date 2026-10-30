import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
import {DatabaseMutationSupervisor} from '../src/platform/database-mutation-recovery.ts';
import type {DatabaseRequest,DesktopDatabaseRequest} from '../src/core/databases.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const command=():DatabaseRequest=>({op:'set_entry',operationId:'original-cell-command',entryId:'one',expectedRevision:'before',expectedCollectionRevision:'schema-before',values:{rating000001:9}});
const value={collections:[{id:'collection01',name:'Notes',revision:'schema-before',deleted:false,properties:[]}],entries:[{entryId:'one',collectionId:'collection01',revision:'after',fileRevision:'file-after',path:'One.md',values:{rating000001:9},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};
async function fixture(t:TestContext,code='storage_busy',source='host',failures=1){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:DesktopDatabaseRequest[]=[];
 const bridge={getVault:async()=>({path:'/cell-recovery',name:'Cell recovery'}),getDurableContext:async()=>({admissionId:'same',scope:{vaultId:'cell-store',clientId:'cell-window'},databases:true}),releaseDurableContext:async()=>{},onChange:()=>()=>{},
 durableInvoke:async(_root:string,admission:string,method:string,args:unknown[])=>{assert.equal(admission,'same');assert.equal(method,'databaseCommand');calls.push(structuredClone(args[0]) as DesktopDatabaseRequest);return calls.length<=failures?{databases:true,schemaVersion:1,ok:false,error:{code,source,commitUncertain:false}}:{databases:true,schemaVersion:1,ok:true,value};}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});const platform=(await createPlatformAdapter())!;
 t.after(async()=>{await platform.release?.();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});return{platform,calls};
}
for(const code of ['storage_busy','storage_io_retryable','storage_capacity','filesystem_io_retryable','lock_timeout'])test(`${code} retries only the immutable exact set_entry and joins its original promise`,async t=>{
 const f=await fixture(t,code);t.mock.timers.enable({apis:['setTimeout']});const input=command(),original=structuredClone(input),pending=f.platform.databases!.request(input);let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});await tick();assert.equal(settled,false);assert.equal(f.platform.databases!.request(original),pending);
 if(input.op==='set_entry')input.values.rating000001=2;t.mock.timers.tick(499);await tick();assert.equal(f.calls.length,1);t.mock.timers.tick(1);assert.deepEqual(await pending,value);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);assert.deepEqual(f.calls[1].command,original);
});
test('repeated temporary errors back off at capped delays without health probes',async t=>{
 const f=await fixture(t,'storage_busy','host',6);t.mock.timers.enable({apis:['setTimeout']});const pending=f.platform.databases!.request(command());await tick();for(const [index,delay] of [500,1500,4000,30000,30000,30000].entries()){t.mock.timers.tick(delay-1);await tick();assert.equal(f.calls.length,index+1);t.mock.timers.tick(1);await tick();assert.equal(f.calls.length,index+2);}await pending;
});
for(const [code,source] of [['permission_denied','host'],['collection_stale','host'],['idempotency_conflict','host'],['storage_busy','protocol'],['storage_busy','transport'],['database_transport_lost','host'],['source_capture_capacity','host']])test(`${code}/${source} does not authorize automatic cell replay`,async t=>{
 const f=await fixture(t,code,source);t.mock.timers.enable({apis:['setTimeout']});await assert.rejects(f.platform.databases!.request(command()));t.mock.timers.tick(90000);await tick();assert.equal(f.calls.length,1);
});
test('ordinary release cancels a cell backoff and cannot dispatch a late retry',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});const pending=f.platform.databases!.request(command()),rejected=assert.rejects(pending,{code:'client_not_admitted'});await tick();await f.platform.release!();await rejected;t.mock.timers.tick(90000);await tick();assert.equal(f.calls.length,1);
});
test('a healthy cell command does not add any retry or query',async t=>{
 const f=await fixture(t,'storage_busy','host',0);assert.deepEqual(await f.platform.databases!.request(command()),value);assert.equal(f.calls.length,1);
});
for(const failure of [Object.assign(Error('Foreign wrapper'),{code:'storage_busy',source:'host',cause:Object.assign(Error('Foreign'),{code:'permission_denied',source:'protocol'})}),Object.assign(Error('Unknown wrapper'),{cause:Object.assign(Error('Busy'),{code:'storage_busy',source:'host'})}),Object.assign(Object.create({code:'storage_busy',source:'host'}),{message:'Inherited provenance'})])test(`database supervisor rejects untrusted wrapper ${failure.message} without retry`,async t=>{
 const io=new DatabaseMutationSupervisor();t.after(()=>io.stop());t.mock.timers.enable({apis:['setTimeout']});let calls=0;await assert.rejects(io.run(async()=>{calls++;throw failure;},()=>{}),error=>error===failure);t.mock.timers.tick(90000);await tick();assert.equal(calls,1);
});

test('a real submitted property widget never paints a temporary save error or authors another operation',async t=>{
 const f=await fixture(t),dom=new JSDOM('<main><div></div></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('div')!,errors:unknown[]=[];t.after(()=>dom.window.close());t.mock.timers.enable({apis:['setTimeout']});
 const dispose=mountBasePropertyWidget(host,{row:{path:'One.md',entryId:'one',revision:'before',values:{'note.rating000001':{type:'number',value:1}}},property:'note.rating000001',value:{type:'number',value:1},version:1},{getDefinition:()=>({type:'number'}),commit:async edit=>{await f.platform.databases!.request(command());return{version:2,row:edit.row,value:edit.value};},onError:error=>errors.push(error)});t.after(dispose);
 host.click();const input=host.querySelector('input')!;input.value='9';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();assert.equal(host.dataset.baseEditing,'pending');assert.equal(input.hasAttribute('aria-invalid'),false);assert.equal(host.classList.contains('mod-error'),false);assert.deepEqual(errors,[]);
 t.mock.timers.tick(500);await tick();assert.equal(host.hasAttribute('data-base-editing'),false);assert.equal(host.textContent,'9');assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);assert.deepEqual(errors,[]);
});

test('replacement-context typed retirement still notifies its positive-scope recovery owner without a second capsule timer',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:string[]=[];const scope={vaultId:'replace-store',clientId:'replace-window'},binding=(admissionId:string)=>({admissionId,scope,databases:true});
 const bridge={getVault:async()=>({path:'/replacement',name:'Replacement'}),getDurableContext:async()=>binding('old'),recoverDurableContext:async()=>binding('fresh'),releaseDurableContext:async()=>{},onChange:()=>()=>{},durableInvoke:async(_root:string,admission:string)=>{calls.push(admission);return{databases:true,schemaVersion:1,ok:false,error:{source:'host',code:admission==='old'?'client_not_admitted':'client_ownership_lost',commitUncertain:true}};}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});const platform=(await createPlatformAdapter())!,input=command();await assert.rejects(platform.databases!.request(input),{code:'client_not_admitted'});t.after(platform.recovery!.claimCapturedSetEntry(input));const fresh=await platform.recovery!.recover();let notified=0;t.after(fresh.recovery!.subscribe(()=>{notified++;}));await assert.rejects(platform.databases!.request(input),{code:'client_ownership_lost'});await tick();assert.equal(notified,1);assert.deepEqual(calls,['old','fresh']);
});

for(const selection of ['live','unclaimed','canceled'] as const)test(`a second retirement ${selection} owner can only continue the same borrowed capsule through a positive next context`,async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:{admission:string;request:unknown}[]=[],scope={vaultId:'chain-store',clientId:'chain-window'},binding=(admissionId:string)=>({admissionId,scope,databases:true});let freshDone!:()=>void,oldDone!:()=>void;const freshGate=new Promise<void>(resolve=>{freshDone=resolve;}),oldGate=new Promise<void>(resolve=>{oldDone=resolve;});let recoveries=0;
 const bridge={getVault:async()=>({path:'/chain',name:'Chain'}),getDurableContext:async()=>binding('old'),recoverDurableContext:async()=>binding(++recoveries===1?'fresh':'next'),releaseDurableContext:async()=>{},onChange:()=>()=>{},durableInvoke:async(_root:string,admission:string,_method:string,args:unknown[])=>{calls.push({admission,request:structuredClone(args[0])});if(admission==='old'){await oldGate;return{databases:true,schemaVersion:1,ok:true,value};}if(admission==='fresh'){await freshGate;return{databases:true,schemaVersion:1,ok:false,error:{source:'host',code:'host_exited',commitUncertain:true}};}return{databases:true,schemaVersion:1,ok:true,value};}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});t.after(()=>{oldDone();freshDone();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});const platform=(await createPlatformAdapter())!,input=command(),releaseHold=platform.recovery!.holdCapturedSetEntry(input),pending=platform.databases!.request(input);t.after(releaseHold);const firstClaim=platform.recovery!.claimCapturedSetEntry(input);t.after(firstClaim);const fresh=await platform.recovery!.recover();assert.equal(fresh.recovery!.containsCapturedSetEntry(input),true,'replacement exposes the original exact capsule');assert.equal(fresh.databases!.request(input),pending,'there is only the original outer promise');let next:Promise<import('../src/platform/index.ts').PlatformVault>|undefined,secondClaim:(()=>void)|undefined;
 if(selection==='live'){t.after(fresh.recovery!.subscribe(()=>{secondClaim=fresh.recovery!.claimCapturedSetEntry(input);t.after(secondClaim);next=fresh.recovery!.recover();}));freshDone();assert.deepEqual(await pending,value);const latest=(await next)!;firstClaim();secondClaim!();releaseHold();for(const owner of [platform,fresh,latest])assert.equal(owner.recovery!.containsCapturedSetEntry(input),false,'final owner release retires every receipt alias');assert.deepEqual(calls.map(call=>call.admission),['old','fresh','next']);assert.deepEqual(calls[2].request,calls[0].request);}
 else{if(selection==='canceled'){const cancel=fresh.recovery!.claimCapturedSetEntry(input);cancel();}const rejected=assert.rejects(pending,{code:'host_exited'});freshDone();await rejected;await fresh.recovery!.recover();assert.deepEqual(calls.map(call=>call.admission),['old','fresh']);}
});

test('releasing the final explicit edit claim cancels its active retry timer',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),scope={vaultId:'cancel-store',clientId:'cancel-window'};let calls=0;const binding=(admissionId:string)=>({admissionId,scope,databases:true});
 const bridge={getVault:async()=>({path:'/cancel',name:'Cancel'}),getDurableContext:async()=>binding('old'),recoverDurableContext:async()=>binding('fresh'),releaseDurableContext:async()=>{},onChange:()=>()=>{},durableInvoke:async()=>{calls++;return{databases:true,schemaVersion:1,ok:false,error:{source:'host',code:'storage_busy',commitUncertain:false}};}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});const platform=(await createPlatformAdapter())!;t.after(()=>platform.release?.());t.mock.timers.enable({apis:['setTimeout']});const input=command(),pending=platform.databases!.request(input),rejected=assert.rejects(pending,{code:'note_load_cancelled'}),cancel=platform.recovery!.claimCapturedSetEntry(input);await tick();cancel();cancel();await rejected;t.mock.timers.tick(90000);await tick();assert.equal(calls,1);
});
