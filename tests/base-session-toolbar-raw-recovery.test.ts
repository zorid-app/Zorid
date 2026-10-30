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
async function fixture(options:{source?:string;schemaType?:'number'|'text';revision?:number;actor?:string;empty?:boolean;viewId?:string}={}){
 class Adapter extends MemoryAdapter {
  documentSemantics?:DocumentService;databases?:DatabaseService;
  revisions=new Map<string,number>([['Work.base',options.revision??1]]);actors=new Map([['Work.base',options.actor??'base-actor'],['One.md','note-actor']]);
  writes:{path:string;text:string;expected:string;revision:string}[]=[];hold:Promise<void>|undefined;fail=false;queryHold:{entered:ReturnType<typeof gate>;finished:ReturnType<typeof gate>}|undefined;
  identify<T extends{path:string}>(entry:T){return{...entry,entryId:this.actors.get(entry.path)??entry.path,revision:`r${this.revisions.get(entry.path)??1}`};}
  override async list(){return(await super.list()).map(entry=>this.identify(entry));}
  override async stat(path:string){const entry=await super.stat(path);return entry&&this.identify(entry);}
  override async write(path:string,text:string){await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);}
  async compareAndWrite(path:string,expected:string,text:string){const revision=(await this.stat(path))!.revision;assert.equal(await this.read(path),expected,'the fresh saved source is the actual compare-and-write baseline');this.writes.push({path,text,expected,revision});await this.hold;if(this.fail)throw Error('Configuration save unavailable');await this.write(path,text);}
 }
 const adapter=new Adapter({'Work.base':options.source??initial,'One.md':'---\nScore: 1\n---\nBody unchanged.\n'});
 const collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:score,name:'Score',datatype:options.schemaType??'number',options:[]}]};
 adapter.databases={async request(command){assert.ok(command.op==='get'||command.op==='list','raw settings recovery cannot submit database commands');return{collections:[collection],entries:[{entryId:'note-actor',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{[score]:1},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};}} as DatabaseService;
 const entry=async(path:string)=>{const actor=(await adapter.stat(path))!;return{id:actor.entryId,path,revision:actor.revision,kind:'file'as const,deleted:false};};
 const unused=async():Promise<never>=>{throw Error('Unexpected document mutation');};
 adapter.documentSemantics={status:async()=>({source:published,snapshot,coveredSource:published,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'fresh-pin',source:published,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source:published,snapshot,coverageComplete:true,value:{entry:await entry('Work.base'),metadata:null,exclusion:null}}),base:async(input)=>{
   const queryHold=adapter.queryHold;if(queryHold){adapter.queryHold=undefined;queryHold.entered.resolve();await queryHold.finished.promise;}
   const view=BaseDocument.parse(await adapter.read('Work.base')).views[input.options?.viewIndex??0],actor=await entry('One.md'),values={'file.name':{type:'string'as const,value:'One'},[`note.${score}`]:{type:'number'as const,value:1}};
   const result:DocumentBaseResult={snapshotId:snapshot,view,rows:options.empty?[]:[{entryId:actor.id,revision:actor.revision,path:actor.path,values,editValues:values}],groups:[{key:null,keyId:null,entryIds:options.empty?[]:[actor.id]}],properties:['file.name',`note.${score}`],availableProperties:['file.name',`note.${score}`],groupOptions:[],counts:{scanned:1,matched:options.empty?0:1,afterGroupOrder:options.empty?0:1,afterSearch:options.empty?0:1,returned:options.empty?0:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1};
   return{source:published,snapshot,coverageComplete:true,value:{definition:await entry('Work.base'),result}};
  }})} as DocumentService;
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main><button id="outside">Outside</button>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[];
 const session=createBaseSession(host,{vault,basePath:'Work.base',viewId:options.viewId,openFile(){},validate(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:adapter.actors.get(path)??path,revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);await until(()=>!!host.querySelector('[role="gridcell"]'));
 const control=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label=${JSON.stringify(label)}]`);assert.ok(node,label);return node;};
 const edit=(label:string,value:string,event='input')=>{const input=control<HTMLInputElement>(label);input.value=value;input.dispatchEvent(new dom.window.Event(event,{bubbles:true}));return input;};
 const apply=()=>{const button=doc.querySelector<HTMLButtonElement>('.bases-toolbar-popover button[type="submit"]')!;assert.ok(button);button.click();};
 return{adapter,vault,dom,doc,host,session,buffers,errors,control,edit,apply,holdQuery(){const pending={entered:gate(),finished:gate()};adapter.queryHold=pending;return pending;},async cleanup(){adapter.fail=false;adapter.hold=undefined;doc.querySelector<HTMLButtonElement>('[aria-label="Cancel"]')?.click();try{await session.close();}finally{for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}}};
}

test('unsubmitted creation-folder settings recover into a fresh session without saving until explicit Apply',async()=>{
 const old=await fixture(),fresh=await fixture({revision:7});try{
  old.control<HTMLButtonElement>('New item options').click();const input=old.edit('New item folder','Unsubmitted folder');input.focus();input.setSelectionRange(2,9,'backward');
  assert.equal(old.session.canRecoverAdmission!(),true,'a raw toolbar form needs a non-authoring recovery capsule');const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(recovery.rawDrafts?.length,1);assert.equal(recovery.rawDrafts![0].kind,'toolbar');assert.equal(old.adapter.writes.length,0);
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,1);assert.equal(result.conflicts.length,0);const restored=fresh.control<HTMLInputElement>('New item folder');assert.equal(restored.value,'Unsubmitted folder');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,9);assert.equal(restored.selectionDirection,'backward');
  fresh.doc.querySelector<HTMLButtonElement>('#outside')!.focus();input.dispatchEvent(new old.dom.window.Event('blur'));old.apply();await tick();assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);assert.equal(await fresh.adapter.read('Work.base'),initial);
  fresh.apply();await until(()=>fresh.adapter.writes.length===1,()=>JSON.stringify({reason:'fresh explicit Apply must dispatch one current compare-and-write',errors:fresh.errors.map(String),dialog:fresh.doc.querySelector('.bases-toolbar-popover')?.textContent,buffers:[...fresh.buffers.values()].map(b=>({dirty:b.dirty,error:String(b.error),text:b.text}))}));await until(()=>!fresh.session.hasPendingChanges(),'the accepted current configuration must settle');assert.equal(fresh.adapter.writes[0].revision,'r7');assert.equal(fresh.adapter.writes[0].expected,initial);assert.equal(baseViewSetting(BaseDocument.parse(await fresh.adapter.read('Work.base')),0,'newItemFolder'),'Unsubmitted folder');assert.equal(await fresh.adapter.read('One.md'),'---\nScore: 1\n---\nBody unchanged.\n');assert.deepEqual(fresh.errors,[]);
 }finally{await old.cleanup();await fresh.cleanup();}
});

test('an in-flight accepted configuration resumes its original save without becoming raw settings',async()=>{
 const f=await fixture(),held=gate();try{
  f.control<HTMLButtonElement>('New item options').click();f.edit('New item folder','Accepted folder');f.adapter.hold=held.promise;f.apply();await until(()=>f.adapter.writes.length===1);
  assert.equal(f.session.canRecoverAdmission!(),true);const recovery=f.session.prepareAdmissionRecovery!();assert.equal(recovery.rawDrafts?.length??0,0,'an accepted command is not an unsubmitted raw settings capsule');assert.equal(f.control<HTMLInputElement>('New item folder').value,'Accepted folder');assert.equal(await f.adapter.read('Work.base'),initial);
  const settling=recovery.settle();held.resolve();await settling;await until(()=>!f.session.hasPendingChanges());assert.equal(f.adapter.writes.length,1);assert.equal(baseViewSetting(BaseDocument.parse(await f.adapter.read('Work.base')),0,'newItemFolder'),'Accepted folder');
 }finally{held.resolve();await f.cleanup();}
});

test('a failed accepted configuration remains owned by its original save and is not a raw-form bypass',async()=>{
 const f=await fixture();try{
  f.control<HTMLButtonElement>('New item options').click();f.edit('New item folder','Failed accepted folder');f.adapter.fail=true;f.apply();await until(()=>f.errors.length>0);
  assert.equal(f.session.canRecoverAdmission!(),false);assert.throws(()=>f.session.prepareAdmissionRecovery!(),/retained before reconnecting/);assert.equal(f.control<HTMLInputElement>('New item folder').value,'Failed accepted folder');assert.equal(f.adapter.writes.length,1);assert.equal(await f.adapter.read('Work.base'),initial);
 }finally{await f.cleanup();}
});

for(const change of ['source','schema','actor'] as const)test(`fresh ${change} conflict retains the original raw settings candidate without authoring`,async()=>{
 const changed=JSON.parse(initial);changed.views[0].name='Externally changed';
 const old=await fixture(),fresh=await fixture(change==='source'?{source:JSON.stringify(changed)}:change==='schema'?{schemaType:'text'}:{actor:'replacement-base'});try{
  old.control<HTMLButtonElement>('New item options').click();old.edit('New item folder','Exact unfinished folder');const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,0);assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft,recovery.rawDrafts![0]);const draft=result.conflicts[0].draft;assert.equal(draft.kind,'toolbar');if(draft.kind==='toolbar'){assert.equal(draft.raw.raw.kind,'new-item-settings');if(draft.raw.raw.kind==='new-item-settings')assert.equal(draft.raw.raw.folder,'Exact unfinished folder');}
  assert.equal(fresh.doc.querySelector('[aria-label="New item folder"]'),null);assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);
 }finally{await old.cleanup();await fresh.cleanup();}
});

test('raw settings keep their original source custody when that Base read was superseded before retirement',async()=>{
 const old=await fixture(),changed=JSON.parse(initial);changed.views[0].name='Externally changed';const fresh=await fixture({source:JSON.stringify(changed)});try{
  old.control<HTMLButtonElement>('New item options').click();old.edit('New item folder','Original actor raw folder');await old.adapter.write('Work.base',JSON.stringify(changed));old.vault.entries.set('Work.base',(await old.adapter.stat('Work.base'))!);
  assert.equal(old.session.canRecoverAdmission!(),true);const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(recovery.rawDrafts![0].origin.source,initial);
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,0);assert.equal(result.conflicts.length,1);assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);
 }finally{await old.cleanup();await fresh.cleanup();}
});

test('Session raw-settings recovery waits for the original IME final input without submitting it',async()=>{
 const old=await fixture(),fresh=await fixture();let input:HTMLInputElement|undefined,settling:Promise<void>|undefined;try{
  old.control<HTMLButtonElement>('New item options').click();input=old.control<HTMLInputElement>('New item folder');input.focus();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='未';
  assert.equal(old.session.canRecoverAdmission!(),true);const recovery=old.session.prepareAdmissionRecovery!();let settled=false;settling=recovery.settle().then(()=>{settled=true;});await tick();assert.equal(settled,false);assert.equal(input.readOnly,false,'the original composing native control remains mounted');
  input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'未確定'}));await tick();assert.equal(settled,false,'a task boundary cannot prove the final input was delivered');
  input.value='未確定';input.setSelectionRange(1,3,'backward');input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'定'}));await settling;
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,1);const restored=fresh.control<HTMLInputElement>('New item folder');assert.equal(restored.value,'未確定');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,3);assert.equal(restored.selectionDirection,'backward');assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);assert.equal(await fresh.adapter.read('Work.base'),initial);
 }finally{if(input&&settling){input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'Cleanup'}));input.value='Cleanup';input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,data:'Cleanup'}));await settling;}await old.cleanup();await fresh.cleanup();}
});

test('raw toolbar restoration uses the Base authority even when its fresh query has no note rows',async()=>{
 const old=await fixture(),fresh=await fixture({empty:true});try{
  old.control<HTMLButtonElement>('New item options').click();old.edit('New item folder','Draft beside empty result');const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(fresh.session.state.result!.rows.length,0);
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,1);assert.equal(result.pending.length,0);assert.equal(result.conflicts.length,0);assert.equal(fresh.control<HTMLInputElement>('New item folder').value,'Draft beside empty result');assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);
 }finally{await old.cleanup();await fresh.cleanup();}
});

test('an unfinished numeric filter survives Session recovery and only a fresh explicit Apply saves its corrected value',async()=>{
 const old=await fixture(),fresh=await fixture({revision:7});try{
  old.control<HTMLButtonElement>('Filter').click();old.control<HTMLButtonElement>('Add filter').click();old.edit('Filter property',`note.${score}`,'change');old.edit('Condition','gt','change');const input=old.edit('Filter value','9e');input.focus();input.setSelectionRange(0,2,'backward');
  assert.equal(old.session.canRecoverAdmission!(),true,'unfinished typed operands need their own raw model, not a serialized valid expression');const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(recovery.rawDrafts?.length,1);
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,1);assert.equal(result.conflicts.length,0);const restored=fresh.control<HTMLInputElement>('Filter value');assert.equal(restored.value,'9e');assert.equal(restored.selectionStart,0);assert.equal(restored.selectionEnd,2);assert.equal(restored.selectionDirection,'backward');
  fresh.doc.querySelector<HTMLButtonElement>('#outside')!.focus();input.dispatchEvent(new old.dom.window.Event('blur'));await tick();assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);assert.equal(await fresh.adapter.read('Work.base'),initial);
  fresh.edit('Filter value','9');fresh.apply();await until(()=>fresh.adapter.writes.length===1,'fresh explicit filter Apply must dispatch one source CAS');await until(()=>!fresh.session.hasPendingChanges());assert.equal(fresh.adapter.writes[0].revision,'r7');assert.equal(fresh.adapter.writes[0].expected,initial);assert.deepEqual(baseViewSetting(BaseDocument.parse(await fresh.adapter.read('Work.base')),0,'filters'),{and:[`note["${score}"] > 9`]});assert.deepEqual(fresh.errors,[]);assert.equal(old.adapter.writes.length,0);
 }finally{await old.cleanup();await fresh.cleanup();}
});

test('a fresh explicit view selection conflicts with older raw intent before its new query finishes',async()=>{
 const document=JSON.parse(initial),primary=document.views[0].id,secondary='bbbbbbbbbbbb';document.views.push({...document.views[0],id:secondary,name:'Secondary'});const source=JSON.stringify(document);
 const old=await fixture({source,viewId:secondary}),fresh=await fixture({source,viewId:secondary});let held:ReturnType<typeof fresh.holdQuery>|undefined,switching:Promise<void>|undefined;try{
  assert.equal(old.session.selectedViewIdentity,secondary);assert.equal(fresh.session.selectedViewIdentity,secondary);old.control<HTMLButtonElement>('New item options').click();old.edit('New item folder','Secondary unfinished folder');const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(recovery.rawDrafts![0].origin.viewId,secondary);
  held=fresh.holdQuery();switching=fresh.session.selectView(0);await held.entered.promise;assert.equal(fresh.session.selectedViewIdentity,primary);assert.equal(fresh.session.state.updating,true);
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,0);assert.equal(result.conflicts.length,1,'the new selected view is already authoritative while its derived read is pending');assert.equal(result.pending.length,0);assert.equal(result.conflicts[0].draft,recovery.rawDrafts![0]);assert.equal(fresh.doc.querySelector('[aria-label="New item folder"]'),null);assert.equal(old.adapter.writes.length,0);assert.equal(fresh.adapter.writes.length,0);
 }finally{held?.finished.resolve();await switching;await old.cleanup();await fresh.cleanup();}
});

test('clean view-search input is retained for host recovery without blocking healthy Session navigation',async()=>{
 const old=await fixture(),fresh=await fixture(),healthy=await fixture();try{
  for(const f of [old,healthy]){f.control<HTMLButtonElement>('Views').click();const input=f.edit('Find a view','Prim');input.focus();input.setSelectionRange(1,3,'backward');assert.equal(f.session.hasPendingChanges(),false,'a navigation query is not an authored configuration draft');}
  await healthy.session.flush({dismissCleanPanels:true});assert.equal(healthy.doc.querySelector('.bases-toolbar-popover'),null);assert.equal(healthy.adapter.writes.length,0,'ordinary clean navigation must not require Apply, retry or reconnect');
  assert.equal(old.session.canRecoverAdmission!(),true);const recovery=old.session.prepareAdmissionRecovery!();await recovery.settle();assert.equal(recovery.rawDrafts?.length,1,'recovery must capture raw-only query presence despite semantic hasDraft being false');assert.equal(old.adapter.writes.length,0);
  const result=await fresh.session.restoreAdmissionDrafts!(recovery.rawDrafts!);assert.equal(result.restored.length,1);const input=fresh.control<HTMLInputElement>('Find a view');assert.equal(input.value,'Prim');assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,3);assert.equal(input.selectionDirection,'backward');assert.equal(fresh.adapter.writes.length,0);assert.equal(fresh.session.hasPendingChanges(),false);
  await fresh.session.flush({dismissCleanPanels:true});assert.equal(fresh.doc.querySelector('.bases-toolbar-popover'),null);assert.equal(fresh.adapter.writes.length,0);
 }finally{await old.cleanup();await fresh.cleanup();await healthy.cleanup();}
});
