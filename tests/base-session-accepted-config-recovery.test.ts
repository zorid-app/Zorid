import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument,baseViewSetting} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import type {DocumentBaseResult,DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseService} from '../src/core/databases.ts';

const collectionId='abcdefghijkl',score='mnopqrstuvwx';
const initial=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Primary',source:{kind:'collection',id:collectionId},order:['file.name',`note.${score}`]}]});
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},published={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,3));
async function until(check:()=>boolean,reason:string|(()=>string)='Expected mounted session state'){for(let n=0;n<160&&!check();n++)await tick();assert.ok(check(),typeof reason==='function'?reason():reason);}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
async function fixture(options:{source?:string;schemaType?:'number'|'text';revision?:number;actor?:string;empty?:boolean;viewId?:string;legacy?:boolean;references?:boolean;summaries?:boolean}={}){
 class Adapter extends MemoryAdapter {
  documentSemantics?:DocumentService;databases?:DatabaseService;
  revisions=new Map<string,number>([['Work.base',options.revision??1]]);actors=new Map([['Work.base',options.actor??'base-actor'],['One.md','note-actor']]);
  writes:{path:string;text:string;expected:string;revision:string}[]=[];hold:Promise<void>|undefined;fail=false;failure:Error|undefined;failurePath:string|undefined;queryHold:{entered:ReturnType<typeof gate>;finished:ReturnType<typeof gate>}|undefined;
  identify<T extends{path:string}>(entry:T){return{...entry,entryId:this.actors.get(entry.path)??entry.path,revision:`r${this.revisions.get(entry.path)??1}`};}
  override async list(){return(await super.list()).map(entry=>this.identify(entry));}
  override async stat(path:string){const entry=await super.stat(path);return entry&&this.identify(entry);}
  override async write(path:string,text:string){await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);}
  async compareAndWrite(path:string,expected:string,text:string){const revision=(await this.stat(path))!.revision;assert.equal(await this.read(path),expected,'the fresh saved source is the actual compare-and-write baseline');this.writes.push({path,text,expected,revision});const injected=this.failure&&(!this.failurePath||path===this.failurePath)?this.failure:undefined;await this.hold;if(injected)throw injected;if(this.fail)throw Error('Configuration save unavailable');await this.write(path,text);}
 }
 const adapter=new Adapter({'Work.base':options.source??initial,'One.md':options.references?'[[Work.base#Primary]]':'---\nScore: 1\n---\nBody unchanged.\n',...(options.references?{'Two.md':'[[Work.base#Primary]]'}:{})});
 const collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:score,name:'Score',datatype:options.schemaType??'number',options:[]}]};
 adapter.databases={async request(command){assert.ok(command.op==='get'||command.op==='list','raw settings recovery cannot submit database commands');return{collections:[collection],entries:[{entryId:'note-actor',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{[score]:1},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};}} as DatabaseService;
 const entry=async(path:string)=>{const actor=(await adapter.stat(path))!;return{id:actor.entryId,path,revision:actor.revision,kind:'file'as const,deleted:false};};
 const unused=async():Promise<never>=>{throw Error('Unexpected document mutation');};
 if(!options.legacy)adapter.documentSemantics={status:async()=>({source:published,snapshot,coveredSource:published,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'fresh-pin',source:published,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source:published,snapshot,coverageComplete:true,value:{entry:await entry('Work.base'),metadata:null,exclusion:null}}),base:async(input)=>{
   const queryHold=adapter.queryHold;if(queryHold){adapter.queryHold=undefined;queryHold.entered.resolve();await queryHold.finished.promise;}
   const view=BaseDocument.parse(await adapter.read('Work.base')).views[input.options?.viewIndex??0],actor=await entry('One.md'),values={'file.name':{type:'string'as const,value:'One'},[`note.${score}`]:{type:'number'as const,value:1}};
   const result:DocumentBaseResult={snapshotId:snapshot,view,rows:options.empty?[]:[{entryId:actor.id,revision:actor.revision,path:actor.path,values,editValues:values}],groups:[{key:null,keyId:null,entryIds:options.empty?[]:[actor.id]}],properties:['file.name',`note.${score}`],availableProperties:['file.name',`note.${score}`],groupOptions:[],counts:{scanned:1,matched:options.empty?0:1,afterGroupOrder:options.empty?0:1,afterSearch:options.empty?0:1,returned:options.empty?0:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,...(options.summaries?{summaries:{[`note.${score}`]:{type:'number' as const,value:1}},summaryPreviews:{Sum:{type:'number' as const,value:1}}}:{})};
   return{source:published,snapshot,coverageComplete:true,value:{definition:await entry('Work.base'),result}};
  }})} as DocumentService;
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main><button id="outside">Outside</button>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[];
 const session=createBaseSession(host,{vault,basePath:'Work.base',viewId:options.viewId,openFile(){},validate(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:adapter.actors.get(path)??path,revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);await until(()=>!!host.querySelector('[role="gridcell"]'));
 const control=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label=${JSON.stringify(label)}]`);assert.ok(node,label);return node;};
 const edit=(label:string,value:string,event='input')=>{const input=control<HTMLInputElement>(label);input.value=value;input.dispatchEvent(new dom.window.Event(event,{bubbles:true}));return input;};
 const apply=()=>{const button=doc.querySelector<HTMLButtonElement>('.bases-toolbar-popover button[type="submit"]')!;assert.ok(button);button.click();};
 return{adapter,vault,dom,doc,host,session,buffers,errors,control,edit,apply,holdQuery(){const pending={entered:gate(),finished:gate()};adapter.queryHold=pending;return pending;},async cleanup(){adapter.fail=false;adapter.hold=undefined;doc.querySelector<HTMLButtonElement>('[aria-label="Cancel"]')?.click();try{await session.close();}finally{for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}}};
}

test('accepted Base configuration retains its original owner through admission recovery',async()=>{
 const f=await fixture(),held=gate();let settling:Promise<void>|undefined;try{
  f.control<HTMLButtonElement>('New item options').click();f.edit('New item folder','Accepted folder');f.adapter.hold=held.promise;f.apply();await until(()=>f.adapter.writes.length===1);
  assert.equal(f.session.canRecoverAdmission!(),true,'an accepted exact Base save must not block automatic same-scope admission');
  const capsule=f.session.prepareAdmissionRecovery!();assert.equal(capsule.rawDrafts?.length??0,0,'accepted source is not an unsubmitted draft');
  let settled=false;settling=capsule.settle().then(()=>{settled=true;});await tick();assert.equal(settled,false,'no fake acknowledgement while original write is held');
  held.resolve();await settling;assert.equal(f.adapter.writes.length,1,'the original accepted write runs once');
  assert.equal(baseViewSetting(BaseDocument.parse(await f.adapter.read('Work.base')),0,'newItemFolder'),'Accepted folder');
  assert.equal(f.session.hasPendingChanges(),false);assert.equal(f.doc.querySelector('button[type="submit"]')?.textContent==='Retry save',false);
 }finally{held.resolve();await settling?.catch(()=>{});await f.cleanup();}
});

test('typed host loss resumes only the accepted exact Base source after positive admission',async()=>{
 const f=await fixture();let settling:Promise<void>|undefined;try{
  f.control<HTMLButtonElement>('New item options').click();f.edit('New item folder','Host interrupted folder');f.adapter.failure=Object.assign(new Error('Fixture host exited'),{code:'host_exited',source:'host'});f.apply();await until(()=>f.adapter.writes.length===1);await tick();
  assert.equal(f.doc.querySelector('button[type="submit"]')?.textContent,'Apply','routine host loss exposes no Retry save');assert.deepEqual(f.errors,[]);
  assert.equal(f.session.canRecoverAdmission!(),true);const capsule=f.session.prepareAdmissionRecovery!();await tick();assert.equal(f.adapter.writes.length,1,'no retry before checked positive admission');assert.equal(await f.adapter.read('Work.base'),initial);
  f.adapter.failure=undefined;settling=capsule.settle();await settling;assert.equal(f.adapter.writes.length,2);assert.equal(f.adapter.writes[0].text,f.adapter.writes[1].text);assert.equal(f.adapter.writes[0].expected,f.adapter.writes[1].expected);assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.errors,[]);
 }finally{f.adapter.failure=undefined;await settling?.catch(()=>{});await f.cleanup();}
});

test('a newer raw filter remains unsubmitted while its accepted predecessor settles',async()=>{
 const old=await fixture(),held=gate();let settling:Promise<void>|undefined,fresh:Awaited<ReturnType<typeof fixture>>|undefined;try{
  old.control<HTMLButtonElement>('Filter').click();old.control<HTMLButtonElement>('Add filter').click();old.edit('Filter property',`note.${score}`,'change');old.edit('Condition','gt','change');old.adapter.hold=held.promise;old.edit('Filter value','9');await until(()=>old.adapter.writes.length===1);
  const newer=old.edit('Filter value','9e');newer.focus();newer.setSelectionRange(0,2,'backward');
  assert.equal(old.session.canRecoverAdmission!(),true);const capsule=old.session.prepareAdmissionRecovery!();settling=capsule.settle();held.resolve();await settling;
  assert.equal(old.adapter.writes.length,1,'newer raw invalid text is never automatically authored');assert.equal(capsule.rawDrafts?.length,1);
  const saved=await old.adapter.read('Work.base');assert.deepEqual(baseViewSetting(BaseDocument.parse(saved),0,'filters'),{and:[`note["${score}"] > 9`]});assert.equal(capsule.rawDrafts![0].origin.source,saved,'newer raw draft belongs to the confirmed accepted configuration');
  fresh=await fixture({source:saved,revision:2});const restored=await fresh.session.restoreAdmissionDrafts!(capsule.rawDrafts!);assert.equal(restored.restored.length,1);assert.equal(restored.conflicts.length,0);assert.equal(fresh.control<HTMLInputElement>('Filter value').value,'9e');assert.equal(fresh.adapter.writes.length,0);
 }finally{held.resolve();await settling?.catch(()=>{});await old.cleanup();await fresh?.cleanup();}
});

test('accepted view rename resumes its original reference plan and never repeats completed files',async()=>{
 const source=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Primary',order:['file.name']}]});
 const f=await fixture({source,legacy:true,references:true});let settling:Promise<void>|undefined;try{
  f.adapter.failurePath='Two.md';f.adapter.failure=Object.assign(new Error('Fixture host exited publishing second reference'),{code:'host_exited',source:'host'});
  f.control<HTMLButtonElement>('Settings').click();const input=f.edit('View name','Renamed');input.dispatchEvent(new f.dom.window.Event('blur'));await until(()=>f.adapter.writes.some(write=>write.path==='Two.md'));
  await tick();assert.deepEqual(f.errors,[]);assert.equal(f.doc.querySelector('button[type="submit"]')?.textContent,'Apply');assert.equal(await f.adapter.read('One.md'),'[[Work.base#Renamed]]');assert.equal(await f.adapter.read('Two.md'),'[[Work.base#Primary]]');
  assert.equal(f.session.canRecoverAdmission!(),true);const capsule=f.session.prepareAdmissionRecovery!();f.adapter.failure=undefined;settling=capsule.settle();await settling;
  assert.equal(f.adapter.writes.filter(write=>write.path==='Work.base').length,1);assert.equal(f.adapter.writes.filter(write=>write.path==='One.md').length,1);assert.equal(f.adapter.writes.filter(write=>write.path==='Two.md').length,2);assert.equal(await f.adapter.read('Two.md'),'[[Work.base#Renamed]]');assert.equal(f.session.hasPendingChanges(),false);assert.deepEqual(f.errors,[]);
 }finally{f.adapter.failure=undefined;await settling?.catch(()=>{});await f.cleanup();}
});

test('accepted summary publication survives host loss and restores newer name and expression as raw input',async()=>{
 const source=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Primary',source:{kind:'collection',id:collectionId},order:['file.name',`note.${score}`],summaries:{[`note.${score}`]:'Sum'},summaryDefinitions:{Sum:'values.sum()'}}]});
 const old=await fixture({source,summaries:true});let settling:Promise<void>|undefined,fresh:Awaited<ReturnType<typeof fixture>>|undefined;try{
  old.host.querySelector<HTMLElement>(`[data-summary-property="note.${score}"]`)!.click();await until(()=>!!old.doc.querySelector('[aria-label="Edit Sum"]'));old.control<HTMLButtonElement>('Edit Sum').click();await until(()=>!!old.doc.querySelector('[aria-label="Summary expression"]'));
  old.adapter.failure=Object.assign(new Error('Fixture summary host exited'),{code:'host_exited',source:'host'});old.edit('Summary expression','values.length');await until(()=>old.adapter.writes.length===1);await tick();
  old.edit('Summary expression','values.sum() +');const name=old.edit('Summary name','Unsubmitted summary name');name.focus();name.setSelectionRange(2,8,'backward');
  assert.equal(old.session.canRecoverAdmission!(),true);const capsule=old.session.prepareAdmissionRecovery!();assert.equal(capsule.rawDrafts?.length,1);assert.equal(capsule.rawDrafts![0].kind,'summary');assert.deepEqual(old.errors,[]);
  old.adapter.failure=undefined;settling=capsule.settle();await settling;assert.equal(old.adapter.writes.length,2,'only original accepted source is retried');const saved=await old.adapter.read('Work.base');assert.equal((baseViewSetting(BaseDocument.parse(saved),0,'summaryDefinitions') as Record<string,string>).Sum,'values.length');
  fresh=await fixture({source:saved,revision:2,summaries:true});const result=await fresh.session.restoreAdmissionDrafts!(capsule.rawDrafts!);assert.equal(result.restored.length,1);assert.equal(result.conflicts.length,0);assert.equal(fresh.control<HTMLInputElement>('Summary name').value,'Unsubmitted summary name');assert.equal(fresh.control<HTMLTextAreaElement>('Summary expression').value,'values.sum() +');assert.equal(fresh.control<HTMLInputElement>('Summary name').selectionDirection,'backward');assert.equal(fresh.adapter.writes.length,0);fresh.control<HTMLInputElement>('Summary name').dispatchEvent(new fresh.dom.window.Event('blur'));await tick();assert.equal(fresh.adapter.writes.length,0,'restoration never submits raw summary input');
 }finally{old.adapter.failure=undefined;await settling?.catch(()=>{});await old.cleanup();if(fresh){fresh.doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')?.click();await fresh.cleanup().catch(()=>{fresh!.dom.window.close();});}}
});

test('a terminal configuration conflict exposes exact read-only review and copy without retrying or reporting Saved',async()=>{
 const f=await fixture();try{
  f.control<HTMLButtonElement>('New item options').click();f.edit('New item folder','Retained conflict folder');f.adapter.fail=true;f.apply();await until(()=>f.errors.length>0);
  assert.equal(f.session.canRecoverAdmission!(),false,'a real terminal failure cannot authorize routine replay');assert.equal(f.session.hasPendingChanges(),true);const desired=f.buffers.get('Work.base')!.text;
  const review=f.doc.querySelector<HTMLButtonElement>('button[type="submit"]')!;assert.equal(review.textContent,'Review retained changes');review.click();
  const original=f.control<HTMLTextAreaElement>('Original saved configuration'),accepted=f.control<HTMLTextAreaElement>('Accepted configuration');assert.equal(original.value,initial);assert.equal(accepted.value,desired);assert.equal(original.readOnly,true);assert.equal(accepted.readOnly,true);
  let copied:string|undefined;Object.defineProperty(f.dom.window.navigator,'clipboard',{value:{async writeText(text:string){copied=text;}},configurable:true});[...f.doc.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Copy accepted configuration')!.click();await tick();assert.equal(copied,desired);
  assert.equal(f.adapter.writes.length,1,'Review/Copy dispatches no persistence retry');assert.equal(await f.adapter.read('Work.base'),initial);assert.equal(f.session.hasPendingChanges(),true);assert.equal(f.doc.body.textContent!.includes('Retry save'),false);
 }finally{await f.cleanup();}
});

test('a late old-host rejection consumes admission that completed while the original accepted write was held',{timeout:2000},async()=>{
 const f=await fixture(),held=gate();let settling:Promise<void>|undefined;try{
  f.control<HTMLButtonElement>('New item options').click();f.edit('New item folder','Late reply folder');f.adapter.hold=held.promise;f.adapter.failure=Object.assign(new Error('Old host late exit'),{code:'host_exited',source:'host'});f.apply();await until(()=>f.adapter.writes.length===1);
  const capsule=f.session.prepareAdmissionRecovery!();let settled=false;settling=capsule.settle().then(()=>{settled=true;});await tick();f.adapter.failure=undefined;f.adapter.hold=undefined;held.resolve();
  await until(()=>settled,'the already-checked fresh admission must wake the late original failure');await settling;assert.equal(f.adapter.writes.length,2);assert.equal(f.session.hasPendingChanges(),false);assert.equal(f.adapter.writes.every(write=>write.text===f.adapter.writes[0].text),true);
 }finally{f.adapter.failure=undefined;held.resolve();await settling?.catch(()=>{});await f.cleanup();}
});

test('ordinary shared-buffer resolution acknowledges only accepted A and retains newer toolbar B without authoring it',async()=>{
 const f=await fixture(),held=gate();try{
  f.control<HTMLButtonElement>('Filter').click();f.control<HTMLButtonElement>('Add filter').click();f.edit('Filter property',`note.${score}`,'change');f.edit('Condition','gt','change');f.adapter.hold=held.promise;f.adapter.fail=true;f.edit('Filter value','9');await until(()=>f.adapter.writes.length===1);f.edit('Filter value','9e');held.resolve();await until(()=>f.errors.length>0);
  assert.equal(f.control<HTMLInputElement>('Filter value').disabled,true);f.adapter.fail=false;f.adapter.hold=undefined;await assert.rejects(f.session.flush(),/Finish or cancel/);
  const input=f.control<HTMLInputElement>('Filter value');assert.equal(input.value,'9e');assert.equal(input.disabled,false);assert.equal(f.adapter.writes.length,2,'only A is retried through ordinary shared-buffer Save');assert.equal(f.session.canRecoverAdmission!(),true,'B is now raw custody, not a stranded failed A');
  const capsule=f.session.prepareAdmissionRecovery!();await capsule.settle();assert.equal(capsule.rawDrafts?.length,1);assert.equal(capsule.rawDrafts![0].kind,'toolbar');assert.equal(f.adapter.writes.length,2);assert.deepEqual(baseViewSetting(BaseDocument.parse(await f.adapter.read('Work.base')),0,'filters'),{and:[`note["${score}"] > 9`]});
 }finally{held.resolve();f.adapter.fail=false;await f.cleanup();}
});
