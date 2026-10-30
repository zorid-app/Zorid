import test from 'node:test';
import type {TestContext} from 'node:test';
import {createPlatformAdapter} from '../src/platform/index.ts';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import type {DocumentService,DocumentBaseResult} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseService} from '../src/core/databases.ts';
const collectionId='eeeeeeeeeeee',snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,4));
async function until(check:()=>boolean|Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await tick();}assert.ok(await check());}
class Adapter extends MemoryAdapter{
 documentSemantics?:DocumentService;databases?:DatabaseService;revision=1;
 override async list(){return(await super.list()).map(entry=>({...entry,entryId:entry.path,revision:`r${this.revision}`}));}
 override async stat(path:string){const entry=await super.stat(path);return entry&&{...entry,entryId:entry.path,revision:`r${this.revision}`};}
 override async write(path:string,text:string){await super.write(path,text);this.revision++;}
}
async function fixture(t:TestContext,{databaseRetires=true}={}){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let nativeDone!:()=>void;const nativeGate=new Promise<void>(resolve=>{nativeDone=resolve;});let foreign=false;const nativeCalls:{admission:string;command:DatabaseRequest}[]=[];
 let nativeCollection:DatabaseCollection|undefined;const scope={vaultId:'collection-admission-store',clientId:'collection-admission-window'},binding=(admissionId:string)=>({admissionId,scope,databases:true});
 const bridge={getVault:async()=>({path:'/collection-admission',name:'Collection admission'}),getDurableContext:async()=>binding('old'),recoverDurableContext:async()=>({...binding('fresh'),scope:foreign?{...scope,clientId:'foreign-window'}:scope}),releaseDurableContext:async()=>{},onChange:()=>()=>{},durableInvoke:async(_root:string,admission:string,_method:string,args:any[])=>{
  const command=args[0].command as DatabaseRequest;nativeCalls.push({admission,command:structuredClone(command)});
  if(command.op==='create'){nativeCollection??={id:collectionId,name:command.name,revision:'schema-r1',deleted:false,properties:[]};if(admission==='old'&&databaseRetires){await nativeGate;return{databases:true,schemaVersion:1,ok:false,error:{code:'client_not_admitted',source:'host',commitUncertain:false}};}}
  return{databases:true,schemaVersion:1,ok:true,value:{collections:nativeCollection?[nativeCollection]:[],entries:[],projection:{pending:0,issues:[]}}};
 }};Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});const platform=(await createPlatformAdapter())!;
 const delayedSchema=false;
 const adapter=new Adapter({'Empty.base':'views: []\n'}),requests:DatabaseRequest[]=[],errors:unknown[]=[],buffers=new Map<string,NoteBuffer>();let collection:DatabaseCollection|undefined,release!:()=>void;
 let schemaGate=delayedSchema?new Promise<void>(resolve=>{release=resolve;}):Promise.resolve();if(!delayedSchema)release=()=>{};
 adapter.databases={request(command){requests.push(structuredClone(command));return platform.databases!.request(command);}};
 const actor=async()=>{const entry=(await adapter.stat('Empty.base'))!;return{id:entry.entryId,revision:entry.revision,path:entry.path,kind:'file'as const,deleted:false};},unused=async():Promise<never>=>{throw new Error('Unexpected document operation');};
 // Echo the saved definition and collection schema from the transport. There
 // are no rows or fields to manufacture or inject into the rendered table.
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:await actor(),metadata:null,exclusion:null}}),base:async input=>{
   const view=BaseDocument.parse(await adapter.read('Empty.base')).views[input.options?.viewIndex??0];assert.ok(view);const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[],groups:[{key:null,keyId:null,entryIds:[]}],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,refreshHint:{dependency:'none',timezone:'UTC',nextWakeMs:null}};return{source,snapshot,coverageComplete:true,value:{definition:await actor(),result}};
  }})}as DocumentService;
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
 const session=createBaseSession(host,{vault,basePath:'Empty.base',validate(){},openFile(){},onError:error=>errors.push(error),canRecoverDatabaseMutation:command=>(platform.recovery as any)?.containsCapturedDatabaseMutation(command)===true,holdRecoverDatabaseMutation:command=>(platform.recovery as any)?.holdCapturedDatabaseMutation(command),claimRecoverDatabaseMutation:command=>(platform.recovery as any)?.claimCapturedDatabaseMutation(command),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:`r${adapter.revision}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.equal(session.state.result,null);
 t.after(async()=>{nativeDone();await tick();await session.close().catch(()=>{});await platform.release?.();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
 return{adapter,vault,requests,errors,doc,host,session,nativeCalls,platform,nativeDone,buffers,foreignScope(){foreign=true;}};
}

test('a real mounted Base chooser with a submitted captured create is eligible for exact admission continuation',async t=>{
 const f=await fixture(t),create=[...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!;assert.ok(create);create.click();await until(()=>f.requests.some(request=>request.op==='create')).catch(error=>{assert.fail(String(error)+' '+f.errors.map(String).join(' | ')+' '+f.host.textContent);});
 assert.equal(f.session.canRecoverAdmission?.(),true,'a submitted immutable collection create must select its original command and configuration follow-up before retiring derived owners');
 const prepared=f.session.prepareAdmissionRecovery!();f.nativeDone();await f.platform.recovery!.recover();await prepared.settle();assert.deepEqual(f.errors,[]);assert.equal(f.nativeCalls.filter(call=>call.command.op==='create').length,2);assert.deepEqual(f.nativeCalls.filter(call=>call.command.op==='create').map(call=>call.command)[0],f.nativeCalls.filter(call=>call.command.op==='create').map(call=>call.command)[1]);
 const saved=BaseDocument.parse(await f.adapter.read('Empty.base'));assert.deepEqual(saved.views[0].source,{kind:'collection',id:collectionId});
});

test('an unsubmitted configured collection form remains raw custody and cannot authorize admission replay',async t=>{
 const f=await fixture(t),tasks=[...f.doc.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Tasks')!;tasks.click();const name=f.doc.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;name.value='Unsubmitted custom name';name.dispatchEvent(new f.doc.defaultView!.Event('input',{bubbles:true}));assert.equal(f.session.canRecoverAdmission?.(),false);assert.equal(f.nativeCalls.some(call=>call.command.op==='create'),false);assert.equal(name.value,'Unsubmitted custom name');
});
test('a newer raw shared Base draft survives exact collection recovery without being merged or replaced',async t=>{
 const f=await fixture(t);[...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!.click();await until(()=>f.requests.some(request=>request.op==='create'));
 const buffer=new NoteBuffer(f.vault,'Empty.base');Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path:'Empty.base',entryId:'Empty.base',revision:`r${f.adapter.revision}`})});f.buffers.set('Empty.base',buffer);await buffer.load();const raw='views: []\n# newer raw user configuration\n';buffer.update(raw);assert.equal(f.session.canRecoverAdmission?.(),true);const prepared=f.session.prepareAdmissionRecovery!();f.nativeDone();await f.platform.recovery!.recover();await assert.rejects(prepared.settle(),/draft|unsaved|newer|configuration/i);assert.equal(buffer.text,raw);assert.equal(await f.adapter.read('Empty.base'),'views: []\n');const commands=f.nativeCalls.filter(call=>call.command.op==='create');assert.equal(commands.length,2);assert.deepEqual(commands[1].command,commands[0].command);assert.equal(buffer.dirty,true);
});
test('a foreign admission cannot settle or link the original generated collection into its Base source',async t=>{
 const f=await fixture(t);[...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!.click();await until(()=>f.requests.some(request=>request.op==='create'));assert.equal(f.session.canRecoverAdmission?.(),true);f.session.prepareAdmissionRecovery!();f.foreignScope();f.nativeDone();await assert.rejects(f.platform.recovery!.recover(),/identity|scope/);assert.equal(f.nativeCalls.filter(call=>call.command.op==='create').length,1);assert.equal(await f.adapter.read('Empty.base'),'views: []\n');
});

test('a confirmed original Base source save held across admission is acknowledged once without retrying its old revision',async t=>{
 const f=await fixture(t,{databaseRetires:false}),write=f.adapter.write.bind(f.adapter);let sourceDone!:()=>void,sourceStarted=false;const sourceGate=new Promise<void>(done=>{sourceDone=done;});t.after(()=>sourceDone());f.adapter.write=async(path,text)=>{if(path==='Empty.base'){sourceStarted=true;await sourceGate;}await write(path,text);};
 [...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!.click();await until(()=>sourceStarted);assert.equal(f.session.canRecoverAdmission?.(),true);const prepared=f.session.prepareAdmissionRecovery!();await f.platform.recovery!.recover();const settling=prepared.settle();sourceDone();await settling;const saved=BaseDocument.parse(await f.adapter.read('Empty.base'));assert.deepEqual(saved.views[0].source,{kind:'collection',id:collectionId});assert.equal(f.nativeCalls.filter(call=>call.command.op==='create').length,1,'known database receipt is reused, not resubmitted');assert.equal(f.buffers.get('Empty.base')!.dirty,false);assert.deepEqual(f.errors,[]);
});

test('an already accepted source draft keeps stable write custody through handoff and its original temporary retry',async t=>{
 const f=await fixture(t,{databaseRetires:false}),write=f.adapter.write.bind(f.adapter);let release!:()=>void,started=false,writes=0;const gate=new Promise<void>(done=>{release=done;});t.after(()=>release());f.adapter.write=async(path,text)=>{if(path==='Empty.base'&&++writes===1){started=true;await gate;throw Object.assign(Error('Temporary source storage busy'),{code:'storage_busy',source:'host',commitUncertain:false});}await write(path,text);};
 [...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!.click();await until(()=>started);t.mock.timers.enable({apis:['setTimeout']});assert.equal(f.session.canRecoverAdmission?.(),true);const prepared=f.session.prepareAdmissionRecovery!();await f.platform.recovery!.recover();const settling=prepared.settle();let outcome:unknown='pending';void settling.then(()=>{outcome='saved';},error=>{outcome=error;});release();for(let n=0;n<30;n++)await new Promise<void>(done=>setImmediate(done));t.mock.timers.tick(500);for(let n=0;n<30;n++)await new Promise<void>(done=>setImmediate(done));t.mock.timers.reset();assert.notEqual(outcome,'pending',JSON.stringify({writes,dirty:f.buffers.get('Empty.base')!.dirty,error:String(f.buffers.get('Empty.base')!.error)}));await settling;assert.equal(writes,2);assert.equal(f.buffers.get('Empty.base')!.dirty,false);assert.deepEqual(BaseDocument.parse(await f.adapter.read('Empty.base')).views[0].source,{kind:'collection',id:collectionId});assert.equal(f.nativeCalls.filter(call=>call.command.op==='create').length,1);assert.deepEqual(f.errors,[]);
});
