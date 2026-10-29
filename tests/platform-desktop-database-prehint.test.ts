import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlatformAdapter} from '../src/platform/index.ts';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {BaseAdmissionRecovery} from '../src/bases/session.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const collectionId='abcdefghijkl',rating='mnopqrstuvwx',scope={vaultId:'pre-hint-store',clientId:'pre-hint-window'};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function until(check:()=>boolean,message='Expected recovery state'){for(let n=0;n<100&&!check();n++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(check(),message);}
async function bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('The original caller was left waiting without a recovery owner')),250);})]);}finally{clearTimeout(timer!);}}
class Adapter extends MemoryAdapter{
 documentSemantics?:DocumentService;databases?:import('../src/core/databases.ts').DatabaseService;
 override async list(){return(await super.list()).map(row=>({...row,entryId:row.path==='One.md'?'one-note':'base-note',revision:row.path==='One.md'?'file-1':'base-1'}));}
 override async stat(path:string){const row=await super.stat(path);return row&&{...row,entryId:path==='One.md'?'one-note':'base-note',revision:path==='One.md'?'file-1':'base-1'};}
}
async function fixture(t:TestContext,{code='host_exited',uncertain=true,recoveryAvailable=true}={}){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),previous=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:dom.window});
 const baseSource=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Recovery',source:{kind:'collection',id:collectionId},order:['file.name',`note.${rating}`]}]}),adapter=new Adapter({'Work.base':baseSource,'One.md':'---\nRating: 1\n---\nExact body.\n'});
 const collection={id:collectionId,name:'Recovery',revision:'schema-1',deleted:false,properties:[{id:rating,name:'Rating',datatype:'number',options:[]}]};
 let member={entryId:'one-note',collectionId,revision:'entry-1',fileRevision:'file-1',path:'One.md',values:{[rating]:1},deleted:false,pendingProjection:false};
 const requests:{admission:string;command:DatabaseRequest}[]=[],receipts=new Map<string,string>(),nativeAck=gate(),backendAck=gate(),errors:unknown[]=[],paintedErrors:string[]=[],retireCallbacks:(()=>void)[]=[];
 let recoveries=0,applyCount=0,failRepair=false,foreign=false,original:Promise<DatabaseResponse>|undefined,originalSettled=false,retireNotices=0,oldDerivedCalls=0,retired=false;
 const response=()=>structuredClone({collections:[collection],entries:[member],projection:{pending:0,issues:[]}}),binding=(admissionId:string)=>({admissionId,scope:{...scope},databases:true});
 const bridge={getVault:async()=>({path:'/pre-hint',name:'Pre-hint'}),getDurableContext:async()=>binding('old'),releaseDurableContext:async()=>{},onChange:()=>()=>{},
  ...(recoveryAvailable?{recoverDurableContext:async()=>{recoveries++;await backendAck.promise;if(failRepair)throw Error('Recovery unavailable');return{...binding('fresh'),scope:foreign?{...scope,clientId:'foreign-window'}:{...scope}};}}:{}),
  onDocumentRuntimeNudge:(_root:string,admission:string,_listener:()=>void,onRetire:()=>void)=>{if(admission==='old')retireCallbacks.push(onRetire);return()=>{};},
  durableInvoke:async(_root:string,admission:string,method:string,args:any[])=>{
   assert.equal(method,'databaseCommand');const command=args[0].command as DatabaseRequest;requests.push({admission,command:structuredClone(command)});
   if(command.op==='set_entry'){
    const wire=JSON.stringify(command),prior=receipts.get(command.operationId);if(prior)assert.equal(wire,prior);else{receipts.set(command.operationId,wire);applyCount++;member={...member,revision:'entry-2',values:{...member.values,...command.values} as Record<string,number>};await adapter.write('One.md','---\nRating: 9\n---\nExact body.\n');}
    if(admission==='old'){await nativeAck.promise;if(command.operationId!=='secondary-success')return{databases:true,schemaVersion:1,ok:false,error:{code,source:'host',commitUncertain:uncertain}};}
   }
   return{databases:true,schemaVersion:1,ok:true,value:response()};
  },
 };
 Object.assign(dom.window,{zorid:bridge});const platform=(await createPlatformAdapter())!,service=platform.databases!;
 adapter.databases={request(command){const pending=service.request(command);if(command.op==='set_entry'&&!original){original=pending;void pending.then(()=>{originalSettled=true;},()=>{originalSettled=true;});}return pending;}};
 const snapshot={localStoreId:scope.vaultId,generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:scope.vaultId,watermark:'1'};
 const unavailable=async():Promise<never>=>{throw Error('Unexpected document effect');},current=()=>{if(retired){oldDerivedCalls++;throw Error('Old derived owner retired');}};
 adapter.documentSemantics={status:async()=>{current();return{source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true};},initialize:unavailable,rebuild:unavailable,begin:unavailable,pump:unavailable,publish:unavailable,discard:unavailable,
  open:async()=>{current();return{pinId:'fixture-pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unavailable,backlinks:unavailable,metadata:async()=>{current();return{source,snapshot,coverageComplete:true,value:{entry:{id:'base-note',revision:'base-1',path:'Work.base',kind:'file',deleted:false},metadata:null,exclusion:null}};},base:async()=>{current();return{source,snapshot,coverageComplete:true,value:{definition:{id:'base-note',revision:'base-1',path:'Work.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(baseSource).views[0],rows:[{entryId:'one-note',revision:'file-1',path:'One.md',values:{'file.name':{type:'string',value:'One'},[`note.${rating}`]:{type:'number',value:member.values[rating]}},editValues:{[`note.${rating}`]:{type:'number',value:member.values[rating]}}}],groups:[{key:null,keyId:null,entryIds:['one-note']}],groupOptions:[],properties:['file.name',`note.${rating}`],availableProperties:['file.name',`note.${rating}`],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}};}};}} as DocumentService;
 const vault=new Vault(adapter);await vault.initialize();const host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},onError:error=>errors.push(error),canRecoverDatabaseEntry:command=>platform.recovery?.containsCapturedSetEntry(command)===true,holdRecoverDatabaseEntry:command=>platform.recovery?.holdCapturedSetEntry(command)??(()=>{}),claimRecoverDatabaseEntry:command=>platform.recovery!.claimCapturedSetEntry(command),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path==='One.md'?'one-note':'base-note',revision:path==='One.md'?'file-1':'base-1'})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});
 await session.ready;await until(()=>host.querySelector(`[role="gridcell"][data-property="note.${rating}"]`)?.getAttribute('aria-readonly')==='false');
 const observe=()=>{for(const element of host.querySelectorAll('[data-base-editing].mod-error,[aria-invalid="true"],.bases-session-status'))if(element.matches('.mod-error,[aria-invalid="true"]')||/failed|error|retry|reconnect|no longer|unavailable|could not/i.test(element.textContent??''))paintedErrors.push(element.textContent??'');};
 const observer=new dom.window.MutationObserver(observe);observer.observe(host,{childList:true,attributes:true,characterData:true,subtree:true});
 let prepared:BaseAdmissionRecovery|undefined,repair:Promise<void>|undefined,stop:(()=>void)|undefined;
 const listen=(select=true,handoff?:Promise<void>)=>{stop=platform.recovery!.subscribe(()=>{retireNotices++;retired=true;const prepare=()=>{if(select&&session.canRecoverAdmission?.()){prepared=session.prepareAdmissionRecovery!();repair=platform.recovery!.recover().then(()=>prepared!.settle());void repair.catch(()=>{});}};if(handoff)return handoff.then(()=>{prepare();return repair;});prepare();});};
 const edit=()=>{const cell=host.querySelector<HTMLElement>(`[role="gridcell"][data-property="note.${rating}"]`)!;cell.click();const input=cell.querySelector<HTMLInputElement>('input');assert.ok(input,cell.outerHTML);input.value='9';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return input;};
 t.after(async()=>{nativeAck.resolve();backendAck.resolve();await repair?.catch(()=>{});stop?.();await platform.release?.().catch(()=>{});retired=false;for(const input of host.querySelectorAll('[data-base-editing] input'))input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await session.close().catch(()=>{});for(const buffer of buffers.values())await buffer.dispose();observer.disconnect();dom.window.close();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
 return{platform,session,host,adapter,requests,errors,paintedErrors,nativeAck,backendAck,edit,listen,get original(){return original!;},get originalSettled(){return originalSettled;},get recoveries(){return recoveries;},get retireNotices(){return retireNotices;},get applyCount(){return applyCount;},get oldDerivedCalls(){return oldDerivedCalls;},get repair(){return repair!;},failRepair(){failRepair=true;},foreignScope(){foreign=true;},retire(){for(const callback of retireCallbacks)callback();}};
}

for(const [code,uncertain] of [['host_exited',true],['client_not_admitted',false],['client_ownership_lost',true]] as const)test(`${code} before any retirement nudge keeps the original submitted widget promise pending through exact scoped repair without error paint`,async t=>{
 const f=await fixture(t,{code,uncertain});f.listen();const input=f.edit();await until(()=>f.applyCount===1);f.nativeAck.resolve();await until(()=>f.recoveries===1||f.originalSettled,'typed fatal rejection must deliver retirement before rejecting the original caller');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.originalSettled,false,JSON.stringify({errors:f.errors.map(error=>String(error)),paintedErrors:f.paintedErrors,retireNotices:f.retireNotices}));assert.equal(f.recoveries,1);assert.equal(input.isConnected,true);assert.deepEqual(f.errors,[]);assert.deepEqual(f.paintedErrors,[]);assert.equal(f.retireNotices,1);
 f.backendAck.resolve();await f.repair;await f.original;await until(()=>!f.session.hasPendingChanges());assert.equal(f.applyCount,1);assert.deepEqual(f.requests.filter(call=>call.command.op==='set_entry').map(call=>call.admission),['old','fresh']);const commands=f.requests.filter(call=>call.command.op==='set_entry').map(call=>call.command);assert.deepEqual(commands[1],commands[0]);assert.match(await f.adapter.read('One.md'),/Rating: 9/);assert.equal(f.oldDerivedCalls,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.paintedErrors,[]);
});

for(const listener of ['none','unselected'] as const)test(`a typed fatal request with ${listener} recovery owner rejects truthfully instead of waiting forever`,async t=>{
 const f=await fixture(t);if(listener==='unselected')f.listen(false);f.edit();await until(()=>f.applyCount===1);const rejected=assert.rejects(f.original,{code:'host_exited'});f.nativeAck.resolve();await rejected;await until(()=>f.errors.length>0);
 assert.equal(f.originalSettled,true);assert.equal(f.recoveries,0);assert.equal(f.requests.filter(call=>call.command.op==='set_entry').length,1);assert.equal(f.platform.recovery!.containsCapturedSetEntry(f.requests.find(call=>call.command.op==='set_entry')!.command),true);
});

test('an older database-only desktop bridge without recovery capability still rejects its fatal request',async t=>{
 const f=await fixture(t,{recoveryAvailable:false});assert.equal(f.platform.recovery,undefined);f.edit();await until(()=>f.applyCount===1);const rejected=assert.rejects(f.original,{code:'host_exited'});f.nativeAck.resolve();await rejected;assert.equal(f.originalSettled,true);assert.equal(f.recoveries,0);
});

for(const [code,uncertain] of [['database_transport_lost',true],['invalid_database_response',true],['collection_stale',true],['collection_stale',false],['revision_conflict',false],['idempotency_conflict',false],['host_exited',false]] as const)test(`${code}/${uncertain} is not promoted from a request error into authoritative admission retirement`,async t=>{
 const f=await fixture(t,{code,uncertain});f.listen();f.edit();await until(()=>f.applyCount===1);const rejected=assert.rejects(f.original,{code});f.nativeAck.resolve();await rejected;await until(()=>f.errors.length>0);assert.equal(f.retireNotices,0);assert.equal(f.recoveries,0);assert.equal(f.requests.filter(call=>call.command.op==='set_entry').length,1);
});

for(const failure of ['backend','foreign'] as const)test(`a selected typed fatal request reports a final ${failure} recovery failure truthfully without replay`,async t=>{
 const f=await fixture(t);f.listen();f.edit();await until(()=>f.applyCount===1);f.nativeAck.resolve();await until(()=>f.recoveries===1);assert.equal(f.originalSettled,false);assert.deepEqual(f.errors,[]);assert.deepEqual(f.paintedErrors,[]);
 if(failure==='backend')f.failRepair();else f.foreignScope();const expected=failure==='backend'?/Recovery unavailable/:/identity|scope/,originalRejected=assert.rejects(f.original,expected),repairRejected=assert.rejects(f.repair,expected);f.backendAck.resolve();await Promise.all([originalRejected,repairRejected]);await until(()=>f.errors.length>0);assert.equal(f.originalSettled,true);assert.equal(f.requests.filter(call=>call.command.op==='set_entry').length,1);
});

test('ordinary release cannot turn a typed fatal rejection into held automatic recovery',async t=>{
 const f=await fixture(t);f.listen();f.edit();await until(()=>f.applyCount===1);const rejected=assert.rejects(f.original,{code:'client_not_admitted'}),closing=f.platform.release!();f.nativeAck.resolve();await closing;await rejected;assert.equal(f.originalSettled,true);assert.equal(f.recoveries,0);assert.equal(f.retireNotices,0);
});

test('the original widget stays pending through an explicit asynchronous owner handoff before selection and exact repair',async t=>{
 const f=await fixture(t),handoff=gate();f.listen(true,handoff.promise);f.edit();await until(()=>f.applyCount===1);f.nativeAck.resolve();await until(()=>f.retireNotices===1);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.recoveries,0);assert.equal(f.originalSettled,false,'retirement delivery completion must cover asynchronous preflight handoff');assert.deepEqual(f.errors,[]);assert.deepEqual(f.paintedErrors,[]);handoff.resolve();await until(()=>f.recoveries===1);f.backendAck.resolve();await f.repair;await f.original;assert.deepEqual(f.errors,[]);assert.deepEqual(f.paintedErrors,[]);assert.equal(f.applyCount,1);
});

for(const second of ['secondary-error','secondary-success'] as const)test(`an unowned second ${second} after a fatal first request also settles truthfully`,async t=>{
 const f=await fixture(t);f.edit();await until(()=>f.applyCount===1);const submitted=f.requests.find(call=>call.command.op==='set_entry')!.command;assert.equal(submitted.op,'set_entry');if(submitted.op!=='set_entry')throw Error('Missing original command');
 const secondary=f.platform.databases!.request({...submitted,operationId:second}),firstRejected=assert.rejects(f.original,{code:'host_exited'}),secondRejected=assert.rejects(secondary,{code:second==='secondary-error'?'host_exited':'client_not_admitted'});f.nativeAck.resolve();await bounded(Promise.all([firstRejected,secondRejected]));assert.equal(f.recoveries,0);
});

test('a retirement nudge without any recovery owner cannot swallow a later fatal request rejection',async t=>{
 const f=await fixture(t);f.edit();await until(()=>f.applyCount===1);f.retire();const rejected=assert.rejects(f.original,{code:'host_exited'});f.nativeAck.resolve();await bounded(rejected);assert.equal(f.recoveries,0);
});

test('rejected asynchronous retirement listeners and their latched replay are observed without abandoning the original error',async t=>{
 const f=await fixture(t),stop=f.platform.recovery!.subscribe(async()=>{throw Error('Observer failure');});t.after(stop);f.edit();await until(()=>f.applyCount===1);const rejected=assert.rejects(f.original,{code:'host_exited'});f.nativeAck.resolve();await bounded(rejected);
 const late=f.platform.recovery!.subscribe(async()=>{throw Error('Late observer failure');});t.after(late);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.recoveries,0);
});
