import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse,stringify} from 'yaml';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {BaseController} from '../src/bases/controller.ts';
import type {DocumentService,DocumentBaseResult,DocumentBaseValue} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseEntry,DatabaseRequest,DatabaseService,DatabaseValue} from '../src/core/databases.ts';

const collectionId='abcdefghijkl',score='mnopqrstuvwx',notes='nnnnnnnnnnnn',added='qqqqqqqqqqqq';
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,4));
async function until(check:()=>boolean|Promise<boolean>,message='Expected integrated session state'){for(let n=0;n<150;n++){if(await check())return;await tick();}assert.ok(await check(),message);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
class Adapter extends MemoryAdapter{
 documentSemantics?:DocumentService;databases?:DatabaseService;revisions=new Map<string,number>();
 identify<T extends{path:string}>(entry:T){return{...entry,entryId:entry.path,revision:`r${this.revisions.get(entry.path)??1}`};}
 override async list(){return(await super.list()).map(entry=>this.identify(entry));}
 override async stat(path:string){const entry=await super.stat(path);return entry&&this.identify(entry);}
 override async write(path:string,text:string){await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);}
}
function documentValue(value:DatabaseValue):DocumentBaseValue{if(value===null)return{type:'null'};if(Array.isArray(value))return{type:'list',value:value.map(item=>({type:'string',value:item}))};return{type:typeof value,value}as DocumentBaseValue;}
async function fixture(datatype:'number'|'checkbox'='number'){
 const existingGroup=false,retainedCommands=new Map<string,string>(),holds=new Map<string,number>(),claims=new Set<string>(),claimHistory:string[]=[],receipts=new Map<string,ReturnType<typeof structuredClone>>(),derivedAfterRetirement:string[]=[];let retired=false,loseReply=false;
 const inactive=()=>Object.assign(new Error('This vault session is no longer active. Reopen the vault before making another change.'),{code:'client_not_admitted',source:'host',commitUncertain:false});
 const checkDerived=(operation:string)=>{if(retired){derivedAfterRetirement.push(operation);throw inactive();}};
 const initialViews=[{id:'aaaaaaaaaaaa',type:'table',name:'Primary',...(existingGroup?{groupBy:{property:`note.${score}`,direction:'DESC'}}:{}),source:{kind:'collection',id:collectionId},order:['file.name',`note.${score}`,`note.${notes}`]},{id:'bbbbbbbbbbbb',type:'table',name:'Secondary',source:{kind:'collection',id:collectionId},order:['file.name',`note.${notes}`]}];
 const adapter=new Adapter({'Work.base':JSON.stringify({views:initialViews}),'One.md':`---\nScore: ${datatype==='checkbox'?'false':'1'}\nNotes: Original\n---\nExact body.\n`});
 let collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:score,name:'Score',datatype,options:[]},{id:notes,name:'Notes',datatype:'text',options:[]}]};
 let member:DatabaseEntry={entryId:'One.md',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{[score]:datatype==='checkbox'?false:1,[notes]:'Original'},deleted:false,pendingProjection:false};
 const requests:DatabaseRequest[]=[],errors:unknown[]=[],buffers=new Map<string,NoteBuffer>();let hold:ReturnType<typeof deferred>|undefined,fail=false;
 const response=()=>structuredClone({collections:[collection],entries:[member],projection:{pending:0,issues:[]}});
 adapter.databases={async request(command){requests.push(structuredClone(command));if(command.op==='get'||command.op==='list'){checkDerived(command.op);return response();}
  if(command.op==='set_entry'){const encoded=JSON.stringify(command),prior=retainedCommands.get(command.operationId);if(retired&&prior!==encoded)throw inactive();if(prior&&prior!==encoded)throw new Error('Captured command changed');retainedCommands.set(command.operationId,encoded);if(receipts.has(command.operationId))return structuredClone(receipts.get(command.operationId));assert.equal(command.expectedRevision,member.revision);assert.equal(command.expectedCollectionRevision,collection.revision);await hold?.promise;if(retired&&!claims.has(command.operationId)||fail)throw inactive();const values={...member.values,...command.values};const frontmatter=Object.fromEntries(collection.properties.filter(field=>Object.hasOwn(values,field.id)).map(field=>[field.name,values[field.id]]));await adapter.write('One.md',`---\n${stringify(frontmatter)}---\nExact body.\n`);member={...member,values,revision:'member-r2',fileRevision:(await adapter.stat('One.md'))!.revision};const receipt=response();receipts.set(command.operationId,receipt);if(loseReply){loseReply=false;throw inactive();}return receipt;}
  if(command.op==='update'){assert.equal(command.expectedRevision,collection.revision);await hold?.promise;collection={...collection,name:command.name,revision:'schema-r2',properties:command.properties.map(field=>({...field,id:field.id??added,options:(field.options??[]).map((option,index)=>({...option,id:option.id??`option${String(index).padStart(6,'0')}`}))}))};return response();}
  throw new Error(`Unexpected database operation ${command.op}`);
 }};
 const actor=async()=>{const entry=(await adapter.stat('Work.base'))!;return{id:entry.entryId,revision:entry.revision,path:entry.path,kind:'file'as const,deleted:false};},unused=async():Promise<never>=>{throw new Error('Unexpected document operation');};
 // The fake transport echoes published bytes, stable file identities and the
 // saved selected view. It never changes session DOM or emulates query rules.
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:await actor(),metadata:null,exclusion:null}}),
   base:async(input)=>{const view=BaseDocument.parse(await adapter.read('Work.base')).views[input.options?.viewIndex??0],identity=(await adapter.stat('One.md'))!,frontmatter=parse((await adapter.read('One.md')).match(/^---\n([\s\S]*?)\n---/)![1]);const values:Record<string,DocumentBaseValue>={'file.name':{type:'string',value:'One'}};for(const field of collection.properties)values[`note.${field.id}`]=documentValue(frontmatter[field.name]??null);const properties=(view.order as string[]|undefined)??Object.keys(values);
    const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[{entryId:identity.entryId,revision:identity.revision,path:identity.path,values,editValues:values}],groups:[{key:null,keyId:null,entryIds:[identity.entryId]}],groupOptions:[],properties,availableProperties:Object.keys(values),counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,refreshHint:{dependency:'none',timezone:'UTC',nextWakeMs:null}};return{source,snapshot,coverageComplete:true,value:{definition:await actor(),result}};},
  })}as DocumentService;
 const semantics=adapter.documentSemantics!,open=semantics.open,status=semantics.status;
 Object.assign(semantics,{status:async(...args:any[])=>{checkDerived('status');return(status as any)(...args);},open:async(...args:any[])=>{checkDerived('open');const pin=await(open as any)(...args);return{...pin,metadata:async(...input:any[])=>{checkDerived('metadata');return pin.metadata(...input);},base:async(...input:any[])=>{checkDerived('base');return pin.base(...input);}};}});
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
 const session=createBaseSession(host,{vault,basePath:'Work.base',canRecoverDatabaseEntry(request:DatabaseRequest){return request.op==='set_entry'&&!!holds.get(request.operationId)&&retainedCommands.get(request.operationId)===JSON.stringify(request);},holdRecoverDatabaseEntry(request:DatabaseRequest&{op:'set_entry'}){holds.set(request.operationId,(holds.get(request.operationId)??0)+1);let released=false;return()=>{if(!released){released=true;holds.set(request.operationId,holds.get(request.operationId)!-1);}};},claimRecoverDatabaseEntry(request:DatabaseRequest&{op:'set_entry'}){assert.equal(retainedCommands.get(request.operationId),JSON.stringify(request));claims.add(request.operationId);claimHistory.push(request.operationId);return()=>{claims.delete(request.operationId);};},validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);await until(()=>!!host.querySelector(`[role="gridcell"][data-property="note.${score}"]`));
 const cell=(property:string)=>host.querySelector<HTMLElement>(`[role="gridcell"][data-property="note.${property}"]`)!;
 const key=(element:Element,key:string)=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});element.dispatchEvent(event);return event;};
 const edit=(property:string,value:string)=>{cell(property).click();const input=cell(property).querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value=value;return input;};
 const pointer=(element:Element)=>{element.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));(element as HTMLElement).click();};
 return{adapter,vault,dom,doc,host,session,requests,errors,cell,key,edit,pointer,derivedAfterRetirement,claimHistory,loseReply(){loseReply=true;},retire(){retired=true;},restoreForCleanup(){retired=false;fail=false;},hold(){hold=deferred();return()=>{hold?.resolve();hold=undefined;};},fail(value=true){fail=value;},async saved(){return BaseDocument.parse(await adapter.read('Work.base'));},async close(){hold?.resolve();hold=undefined;fail=false;for(const input of doc.querySelectorAll('[data-base-editing] input,.bases-property-popover input'))key(input,'Escape');doc.querySelector<HTMLButtonElement>('.collection-property-picker-cancel')?.click();[...doc.querySelectorAll<HTMLButtonElement>('.collection-property-editor button')].find(button=>button.textContent==='Cancel')?.click();for(const button of doc.querySelectorAll<HTMLButtonElement>('[aria-label="Close"]'))button.click();await until(()=>!session.hasPendingChanges(),JSON.stringify({pending:host.innerText,portals:[...doc.querySelectorAll('.bases-toolbar-popover,.bases-property-popover')].map(e=>e.textContent),errors:errors.map(String)}));await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}


test('captured pending numeric edit settles after admission replacement without touching retired derived handles',async()=>{
 const f=await fixture();try{const release=f.hold(),input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.requests.some(request=>request.op==='set_entry'));
  const command=f.requests.find(request=>request.op==='set_entry')!;f.retire();const recovery=(f.session as any).prepareAdmissionRecovery?.();release();await recovery?.settle();
  await until(()=>!f.session.hasPendingChanges(),'acknowledged Rating9 must not leave a stale-session widget draft');
  assert.equal(parse((await f.adapter.read('One.md')).match(/^---\n([\s\S]*?)\n---/)![1]).Score,9);assert.deepEqual(f.derivedAfterRetirement,[],'recovery must rebuild views instead of refreshing retired pins');assert.deepEqual(f.errors,[]);assert.deepEqual(f.requests.filter(request=>request.op==='set_entry'),[command]);
 }finally{f.restoreForCleanup();await f.close();}
});

test('already rejected unchanged managed draft replays its exact captured command and clears only after acknowledgement',async()=>{
 const f=await fixture();try{f.fail();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.errors.length>0);const command=f.requests.find(request=>request.op==='set_entry')!;
  assert.equal(f.session.hasPendingChanges(),true);f.retire();f.fail(false);const recovery=(f.session as any).prepareAdmissionRecovery?.();await recovery?.settle();
  await until(()=>!f.session.hasPendingChanges(),'the captured failed edit must be reconciled automatically');assert.deepEqual(f.requests.filter(request=>request.op==='set_entry'),[command,command]);assert.deepEqual(f.derivedAfterRetirement,[]);assert.match(await f.adapter.read('One.md'),/Score: 9/);
 }finally{f.restoreForCleanup();await f.close();}
});

test('raw typing changed after a rejected submission remains retained and blocks admission handoff',async()=>{
 const f=await fixture();try{f.fail();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.errors.length>0);input.value='10';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.retire();
  assert.equal((f.session as any).canRecoverAdmission?.()??false,false);assert.equal(input.value,'10');assert.equal(f.session.hasPendingChanges(),true);assert.equal(f.requests.filter(request=>request.op==='set_entry').length,1);assert.match(await f.adapter.read('One.md'),/Score: 1/);
 }finally{f.restoreForCleanup();await f.close();}
});

test('an already committed numeric edit uses the exact original receipt after a lost acknowledgement',async()=>{
 const f=await fixture();try{f.loseReply();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.errors.length>0);const command=f.requests.find(request=>request.op==='set_entry')!;assert.match(await f.adapter.read('One.md'),/Score: 9/);
  f.retire();const recovery=f.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.requests.filter(request=>request.op==='set_entry'),[command,command]);assert.ok((await f.adapter.read('One.md')).endsWith('Exact body.\n'));assert.deepEqual(f.derivedAfterRetirement,[]);
 }finally{f.restoreForCleanup();await f.close();}
});

test('a canceled rejected edit is not selected when a different current widget reconnects',async()=>{
 const f=await fixture();try{f.fail();let input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.errors.length>0);const canceled=f.requests.find(request=>request.op==='set_entry')!;f.key(input,'Escape');f.fail(false);
  const release=f.hold();input=f.edit(score,'10');f.key(input,'Enter');await until(()=>f.requests.filter(request=>request.op==='set_entry').length===2);const current=f.requests.filter(request=>request.op==='set_entry')[1]!;
  f.retire();const recovery=f.session.prepareAdmissionRecovery!();release();await recovery.settle();assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.claimHistory,[(current as any).operationId]);assert.ok(!f.claimHistory.includes((canceled as any).operationId));assert.match(await f.adapter.read('One.md'),/Score: 10/);
 }finally{f.restoreForCleanup();await f.close();}
});

test('a clean Base can retire its derived owners through an empty recovery capsule',async()=>{
 const f=await fixture();try{f.retire();assert.equal(f.session.canRecoverAdmission!(),true);const capsule=f.session.prepareAdmissionRecovery!();assert.equal(f.session.prepareAdmissionRecovery!(),capsule);await capsule.settle();assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.claimHistory,[]);assert.equal(f.requests.filter(request=>request.op==='set_entry').length,0);assert.deepEqual(f.derivedAfterRetirement,[]);
 }finally{f.restoreForCleanup();await f.close();}
});

test('a new unsubmitted numeric draft cannot masquerade as a clean recovery capsule',async()=>{
 const f=await fixture();try{const input=f.edit(score,'9');f.retire();assert.equal(f.session.canRecoverAdmission!(),false);assert.throws(()=>f.session.prepareAdmissionRecovery!(),/Unsubmitted/);assert.equal(input.value,'9');assert.equal(f.session.hasPendingChanges(),true);assert.deepEqual(f.claimHistory,[]);
 }finally{f.restoreForCleanup();await f.close();}
});

for(const operation of ['close','flush'] as const)test(`${operation} cannot dispose or finish a Base before its prepared admission capsule settles`,async()=>{
 const f=await fixture();let releasePending=()=>{};let finishing:Promise<void>|undefined,recovery:ReturnType<NonNullable<typeof f.session.prepareAdmissionRecovery>>|undefined;try{const release=(releasePending=f.hold()),input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.requests.some(request=>request.op==='set_entry'));f.retire();recovery=f.session.prepareAdmissionRecovery!();finishing=f.session[operation]();
  const result=await Promise.race([finishing.then(()=>'finished',()=> 'rejected'),new Promise<string>(resolve=>setTimeout(()=>resolve('waiting'),20))]);assert.equal(result,'rejected','the owner barrier must reject without disposing or waiting on an unacknowledged write');assert.equal(f.host.isConnected,true);release();await recovery.settle();
 }finally{releasePending();f.restoreForCleanup();await finishing?.catch(()=>{});if(recovery)await recovery.settle().catch(()=>{});await f.close();}
});

test('resubmitting an unchanged failed widget preserves its operation and selects the current editor attempt',async()=>{
 const f=await fixture();try{f.fail();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.errors.length>0);const failureCount=f.errors.length,original=f.requests.find(request=>request.op==='set_entry')!;
  f.key(input,'Enter');await until(()=>f.errors.length>failureCount);assert.deepEqual(f.requests.filter(request=>request.op==='set_entry'),[original,original]);f.retire();f.fail(false);assert.equal(f.session.canRecoverAdmission!(),true);await f.session.prepareAdmissionRecovery!().settle();assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.requests.filter(request=>request.op==='set_entry'),[original,original,original]);
 }finally{f.restoreForCleanup();await f.close();}
});

test('canceling a rejected widget then submitting the same value owns a new command before deferred cleanup',async()=>{
 const f=await fixture();try{f.fail();let input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.errors.length>0);const canceled=f.requests.find(request=>request.op==='set_entry')!;f.key(input,'Escape');f.fail(false);const release=f.hold();input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.requests.filter(request=>request.op==='set_entry').length===2);const next=f.requests.filter(request=>request.op==='set_entry')[1]!;
  assert.notEqual((next as any).operationId,(canceled as any).operationId,'a canceled editor lifetime must not lend its old command to a new edit');f.retire();const recovery=f.session.prepareAdmissionRecovery!();release();await recovery.settle();assert.deepEqual(f.claimHistory,[(next as any).operationId]);assert.equal(f.session.hasPendingChanges(),false);
 }finally{f.restoreForCleanup();await f.close();}
});

test('retirement interrupts an already waiting close before disposal while healthy pending closes still wait',async()=>{
 const f=await fixture();let release=()=>{},finishing:Promise<void>|undefined,recovery:ReturnType<NonNullable<typeof f.session.prepareAdmissionRecovery>>|undefined;
 try{release=f.hold();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.requests.some(request=>request.op==='set_entry'));finishing=f.session.close();const closeOutcome=finishing.then(()=>'closed',error=>String((error as any).code));await tick();f.retire();assert.equal(f.session.canRecoverAdmission!(),true,'the reversible pending-save phase must still admit exact recovery');recovery=f.session.prepareAdmissionRecovery!();
  assert.equal(await Promise.race([closeOutcome,new Promise<string>(resolve=>setTimeout(()=>resolve('blocked'),30))]),'base_admission_recovery_pending');assert.equal(f.host.isConnected,true);assert.deepEqual(f.errors,[],'owned recovery interruption must not flash a failure notice');release();await recovery.settle();assert.equal(f.session.hasPendingChanges(),false);
 }finally{release();f.restoreForCleanup();await finishing?.catch(()=>{});await recovery?.settle().catch(()=>{});await f.close();}
});

test('an ordinary healthy close continues waiting for its accepted numeric edit and then succeeds',async()=>{
 const f=await fixture();let release=()=>{};try{release=f.hold();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.requests.some(request=>request.op==='set_entry'));const closing=f.session.close();assert.equal(await Promise.race([closing.then(()=>'closed'),new Promise<string>(resolve=>setTimeout(()=>resolve('waiting'),15))]),'waiting');release();await closing;assert.equal(f.session.hasPendingChanges(),false);assert.match(await f.adapter.read('One.md'),/Score: 9/);
 }finally{release();f.restoreForCleanup();await f.close();}
});

test('a rejected checkbox preserves its submitted ownership through controlled display rollback',async()=>{
 const f=await fixture('checkbox');try{f.fail();const checkbox=f.cell(score).querySelector<HTMLInputElement>('input[type="checkbox"]')!;assert.equal(checkbox.checked,false);checkbox.click();await until(()=>f.errors.length>0);await tick();const original=f.requests.find(request=>request.op==='set_entry')!;assert.equal(checkbox.checked,false,'ordinary failure presentation retains the saved baseline');f.retire();f.fail(false);assert.equal(f.session.canRecoverAdmission!(),true);await f.session.prepareAdmissionRecovery!().settle();assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.requests.filter(request=>request.op==='set_entry'),[original,original]);assert.equal(f.cell(score).querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,true);assert.match(await f.adapter.read('One.md'),/Score: true/);
 }finally{f.restoreForCleanup();await f.close();}
});

test('a preempted finish cannot continue old configuration acknowledgements after its pending edit resolves',async t=>{
 const f=await fixture();let release=()=>{},closing:Promise<void>|undefined,expired=false,oldActions=0;const acknowledge=BaseController.prototype.acknowledgeConfigurationRetry;
 t.mock.method(BaseController.prototype,'acknowledgeConfigurationRetry',function(this:BaseController){if(expired)oldActions++;return acknowledge.call(this);});
 try{release=f.hold();const input=f.edit(score,'9');f.key(input,'Enter');await until(()=>f.requests.some(request=>request.op==='set_entry'));closing=f.session.close();const rejected=assert.rejects(closing,{code:'base_admission_recovery_pending'});await tick();expired=true;f.retire();const capsule=f.session.prepareAdmissionRecovery!();await rejected;release();await capsule.settle();await tick();assert.equal(oldActions,0);
 }finally{release();f.restoreForCleanup();await closing?.catch(()=>{});expired=false;await f.close();}
});
