import {openBaseToolbarPanel} from './helpers/base-toolbar.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse} from 'yaml';
import {executeBaseQuery} from '../src/bases/query.ts';
import type {BaseExpressionValue} from '../src/bases/expression.ts';
import type {DocumentService,DocumentBaseResult,DocumentBaseValue} from '../src/core/document-semantics.ts';
import type {DatabaseService,DatabaseCollection,DatabaseEntry,DatabaseRequest,DatabaseResponse,DatabaseValue} from '../src/core/databases.ts';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';

const source=`# preserve this comment\npluginRoot: {future: keep}\nfilters: 'file.ext == "md" && file.name != "Outside"'\nviews:\n - {type: table, name: Table, order: [file.name, status, score, done], pluginView: keep}\n - {type: cards, name: Cards, order: [file.name, status, score, done]}\n - {type: list, name: List, order: [file.name, status, score, done]}\n - type: kanban\n   name: Board\n   order: [file.name, status, score, done]\n   groupBy: {property: status, direction: ASC}\n   groupOrder: [Todo, Done]\n`;
const notes={
 'Tasks/Alpha.md':'---\nstatus: Todo\nscore: 2\ndone: false\n---\nAlpha body\n',
 'Tasks/Beta.md':'---\nstatus: Done\nscore: 1\ndone: true\n---\nBeta body\n',
 'Tasks/Gamma.md':'---\nstatus: Todo\nscore: 3\ndone: false\n---\nGamma body\n',
 'Outside.md':'---\nstatus: Todo\nscore: 99\n---\nOutside body\n',
};
const collectionId='abcdefghijkl',fields={status:'statusfieldx',score:'scorevalueid',done:'donefieldxyz'};
const property=(name:keyof typeof fields)=>`note.${fields[name]}`;
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean,reason:string){for(let i=0;i<250&&!check();i++)await tick();assert.ok(check(),reason);}
async function fixture(options:{managed?:boolean;readOnly?:boolean;viewName?:string;source?:string;files?:Record<string,string>}={}){
 class Adapter extends MemoryAdapter{
  documentSemantics?:DocumentService;databases?:DatabaseService;actors=new Map<string,string>();revisions=new Map<string,number>();generation=1;
  actor(path:string){let id=this.actors.get(path);if(!id){id=crypto.randomUUID();this.actors.set(path,id);}return id;}
  identify<T extends{path:string}>(entry:T){return options.managed?{...entry,entryId:this.actor(entry.path),revision:`r${this.revisions.get(entry.path)??1}`}:entry;}
  override async list(){return(await super.list()).map(entry=>this.identify(entry));}
  override async stat(path:string){const entry=await super.stat(path);return entry&&this.identify(entry);}
  fail=false;failPaths=new Set<string>();writes:{path:string;text:string}[]=[];attempts:{path:string;text:string}[]=[];
  override async write(path:string,text:string){this.attempts.push({path,text});if(this.fail&&path==='Work.base'||this.failPaths.has(path))throw new Error('Toolbar disk unavailable');await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);this.generation++;this.writes.push({path,text});}
 }
 let initial=options.source??source;
 if(options.managed){const document=BaseDocument.parse(initial);for(const[index,view]of document.views.entries())document.updateView(index,{id:['tableviewaaa','cardsviewaaa','listviewaaaa','kanbanviewaa'][index],source:{kind:'collection',id:collectionId},order:(view.order as string[]).map(value=>value in fields?property(value as keyof typeof fields):value),...(view.groupBy?{groupBy:{property:property('status'),direction:'ASC'}}:{})});initial=document.toString();}
 const adapter=new Adapter({'Work.base':initial,...notes,...options.files}),seedNotes={...notes},requests:DatabaseRequest[]=[];
 if(options.managed){
  // Supported collection transport simulation. Rust projection maps each stable
  // field ID to property.name; managed seeds add the production identity/type
  // markers while preserving every original note byte after those two lines.
  const collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:fields.status,name:'status',datatype:'text',options:[]},{id:fields.score,name:'score',datatype:'number',options:[]},{id:fields.done,name:'done',datatype:'checkbox',options:[]}]};
  const members=new Map<string,DatabaseEntry>();
  for(const[path,text]of Object.entries(notes))if(path.startsWith('Tasks/')){
   seedNotes[path as keyof typeof notes]=text.replace('---\n',`---\n_id: ${adapter.actor(path)}\n_type: Tasks\n`);await adapter.write(path,seedNotes[path as keyof typeof notes]);adapter.revisions.set(path,1);
   const values=parse(text.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string,DatabaseValue>;
   members.set(path,{entryId:adapter.actor(path),collectionId,revision:'member-r1',fileRevision:'r1',path,values:Object.fromEntries(collection.properties.map(field=>[field.id,values[field.name]??null])),deleted:false,pendingProjection:false});
  }
  adapter.writes.length=adapter.attempts.length=0;adapter.generation=1;
  const response=():DatabaseResponse=>structuredClone({collections:[collection],entries:[...members.values()],projection:{pending:0,issues:[]}});
  adapter.databases={async request(command){
   requests.push(structuredClone(command));
   assert.ok(command.op==='get'||command.op==='list','these raw-input guards must never submit a database mutation');
   if(command.op==='get')assert.equal(command.collectionId,collectionId);return response();
  }};
  const documentValue=(value:BaseExpressionValue):DocumentBaseValue=>{
   switch(value.type){case'null':case'number':case'string':case'boolean':case'date':return value;case'list':return{type:'list',value:value.value.map(documentValue)};case'object':return{type:'object',value:Object.entries(value.value).map(([key,item])=>[key,documentValue(item)] as const)};case'namespace':return{type:'file',path:value.name};case'error':return{type:'error',code:value.error.code,message:value.error.message};default:throw Error(`Unexpected fixture query value ${value.type}`);}
  };
  const snapshot=()=>({localStoreId:'toolbar-store',generationEpoch:'toolbar-epoch',generation:String(adapter.generation),versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}}),published=()=>({localStoreId:'toolbar-store',watermark:String(adapter.generation)});
  const unused=async():Promise<never>=>{throw Error('Unexpected document fixture operation');};
  adapter.documentSemantics={status:async()=>({source:published(),snapshot:snapshot(),coveredSource:published(),current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,open:async()=>{
   const generation=adapter.generation,pinSnapshot=snapshot(),pinSource=published(),pinEntries=new Map((await adapter.list()).map(entry=>[entry.path,entry])),pinTexts=new Map<string,string>();
   for(const entry of pinEntries.values())if(entry.type==='file')pinTexts.set(entry.path,await adapter.read(entry.path));
   const pinMembers=structuredClone([...members.values()]);assert.equal(adapter.generation,generation,'a read pin cannot combine different source generations');
   const actor=(path:string)=>{const entry=pinEntries.get(path);assert.ok(entry);return{id:entry.entryId!,revision:entry.revision!,path,kind:'file' as const,deleted:false};};
   return{pinId:'toolbar-pin',source:pinSource,snapshot:pinSnapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async id=>{const entry=[...pinEntries.values()].find(entry=>entry.entryId===id);assert.ok(entry);return{source:pinSource,snapshot:pinSnapshot,coverageComplete:true,value:{entry:actor(entry.path),metadata:null,exclusion:null}};},base:async input=>{
    const saved=BaseDocument.parse(pinTexts.get('Work.base')!),view=saved.views[input.options?.viewIndex??0],{source:_source,...queryView}=view;
    const files=pinMembers.map(member=>{const entry=pinEntries.get(member.path)!,frontmatter=parse(pinTexts.get(member.path)!.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string,unknown>;assert.equal(entry.entryId,member.entryId);assert.equal(entry.revision,member.fileRevision);return{path:member.path,size:entry.size,mtime:entry.mtime,properties:Object.fromEntries(collection.properties.map(field=>[field.id,frontmatter[field.name]??null]))};});
    // Query rules are evaluated from the accepted scoped configuration and saved
    // member bytes. This client-integration fixture does not claim Rust parity.
    const query=executeBaseQuery(BaseDocument.parse(JSON.stringify({views:[queryView]})),{version:generation,files},{viewIndex:0,searchTerms:input.options?.searchTerms});
    const rows=await Promise.all(query.rows.map(async row=>{const identity=actor(row.path),values=Object.fromEntries(Object.entries(row.values).map(([key,value])=>[key,documentValue(value)]));return{entryId:identity.id,revision:identity.revision,path:row.path,values,editValues:values};})),byPath=new Map(rows.map(row=>[row.path,row]));
    const result:DocumentBaseResult={snapshotId:pinSnapshot,view,rows,groups:query.groups.map(group=>({key:group.key===null?null:documentValue(group.key),keyId:group.key===null?null:JSON.stringify(group.key),entryIds:group.rows.map(row=>byPath.get(row.path)!.entryId)})),groupOptions:query.groupOptions.map(group=>({key:documentValue(group.key),keyId:JSON.stringify(group.key),count:group.count,listed:group.listed})),properties:query.properties,availableProperties:query.availableProperties,counts:query.counts,diagnostics:query.diagnostics,relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1};
    return{source:pinSource,snapshot:pinSnapshot,coverageComplete:true,value:{definition:actor('Work.base'),result}};
   }};
  }} as DocumentService;
 }
 const vault=new Vault(adapter);await vault.initialize();
 const dom=new JSDOM('<main></main><button id="outside">Outside control</button>',{pretendToBeVisual:true,url:'https://zorid.test/'}),doc=dom.window.document,host=doc.querySelector('main')!;
 const buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],publications:string[]=[],renamed:{basePath:string;index:number;from:string;to:string}[]=[];
 const getBuffer=async(path:string)=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000,storage:dom.window.localStorage});if(options.managed)Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:adapter.actor(path),revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;};
 const session=createBaseSession(host,{vault,basePath:'Work.base',readOnly:options.readOnly,viewName:options.viewName,
  buffers:options.readOnly?undefined:{getBuffer,validate(){},onBufferChange(path){publications.push(path);}},validate(){},openFile(){},onViewRenamed:event=>renamed.push(event),onError:error=>errors.push(error)});
 await session.ready;assert.equal(session.state.error,null);
 const dialog=()=>doc.querySelector<HTMLElement>('[role="dialog"]');
 const control=<T extends HTMLElement>(label:string,scope:ParentNode=doc)=>{const node=scope.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,`control ${label}`);return node;};
 const click=(label:string,scope:ParentNode=doc)=>{if(label==='Group'||label==='Properties'||label==='Results'){openBaseToolbarPanel(doc,label);return;}control<HTMLButtonElement>(label,scope).click();};
 const change=(label:string,value:string,event='change')=>{const node=control<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(label);node.value=value;node.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
 const key=(node:Element,value:string)=>node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
 const submit=()=>{const form=dialog()?.querySelector('form');assert.ok(form,'open form');form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));};
 const applied=async()=>{doc.getElementById('outside')!.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true}));await until(()=>!dialog(),'outside click saves and closes the menu');await session.flush();};
 const configure=()=>{click('Views');click(`Configure view ${session.state.result!.view.name}`);};
 const disk=async()=>BaseDocument.parse(await vault.read('Work.base'));
 const paths=()=>session.state.result!.rows.map(row=>row.path);
 const unchangedNotes=async()=>{for(const[path,text]of Object.entries(seedNotes)){assert.equal(await adapter.read(path),text,path);if(options.managed&&path.startsWith('Tasks/'))assert.equal(text.replace(/_id: [^\n]+\n_type: Tasks\n/,''),notes[path as keyof typeof notes],'managed marker migration preserves the complete original note bytes');}};
 return{adapter,vault,dom,doc,host,buffers,errors,requests,seedNotes,publications,renamed,getBuffer,session,dialog,control,click,change,key,submit,applied,configure,disk,paths,unchangedNotes,initial,
  async cleanup(){adapter.fail=false;adapter.failPaths.clear();const cancel=dialog()?.querySelector<HTMLButtonElement>('[aria-label="Cancel"]');cancel?.click();for(const input of host.querySelectorAll('.bases-session-content input,.bases-session-content textarea'))key(input,'Escape');await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('actual session switches all existing views without writing configuration or notes',async()=>{
 const f=await fixture();try{
  for(const[index,type]of ['table','cards','list','kanban'].entries()){
   f.change('Base view',String(index));await until(()=>f.session.state.result?.view.type===type,`select ${type}`);
   assert.equal(f.control<HTMLSelectElement>('Base view').value,String(index));
  }
  assert.equal(await f.adapter.read('Work.base'),source);assert.equal(f.adapter.writes.length,0);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('view configuration automatically changes only the selected view layout/name and preserve extensions',async()=>{
 const f=await fixture();try{
  f.configure();f.change('Layout','cards');f.change('View name','Current tasks','input');
  assert.equal(f.session.state.result!.view.type,'table');assert.equal(await f.adapter.read('Work.base'),source);
  await f.applied();const document=await f.disk();assert.equal(document.views[0].type,'cards');assert.equal(document.views[0].name,'Current tasks');
  assert.equal(document.views[0].pluginView,'keep');assert.deepEqual(document.getRoot('pluginRoot'),{future:'keep'});assert.match(document.toString(),/# preserve this comment/);
  assert.deepEqual(document.views.slice(1),BaseDocument.parse(source).views.slice(1));await until(()=>!!f.host.querySelector('.bases-cards-container'),'accepted layout mounts Cards');await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('typed collection-view filter derives actual rows while preserving unrelated root configuration and note bytes',async()=>{
 const f=await fixture({managed:true});try{
  f.click('Filter');f.click('Add filter');f.change('Filter property',property('score'));f.change('Condition','gt');f.change('Filter value','1','input');
  assert.equal(f.session.state.result!.rows.length,3);assert.equal(await f.adapter.read('Work.base'),f.initial);
  await f.applied();assert.deepEqual(f.paths(),['Tasks/Alpha.md','Tasks/Gamma.md']);
  const saved=await f.disk();assert.equal(saved.getRoot('filters'),BaseDocument.parse(f.initial).getRoot('filters'));assert.deepEqual(saved.views[0].filters,{and:[`note["${fields.score}"] > 1`]});
  assert.deepEqual(saved.views.slice(1),BaseDocument.parse(f.initial).views.slice(1));await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('sort and visible property order update real query results through guarded configuration writes',async()=>{
 const f=await fixture({managed:true});try{
  f.click('Sort');f.click('Add sort');f.change('Sort property',property('score'));f.change('Sort direction','ASC');await f.applied();
  assert.deepEqual(f.paths(),['Tasks/Beta.md','Tasks/Alpha.md','Tasks/Gamma.md']);
  f.click('Properties');const done=f.dialog()!.querySelector<HTMLInputElement>('input[data-property="note.donefieldxyz"]')!;assert.ok(done);done.click();f.click('Move score earlier');
  assert.ok(f.session.state.result!.properties.includes(property('done')));await f.applied();
  assert.deepEqual(f.session.state.result!.properties,['file.name',property('score'),property('status')]);assert.deepEqual((await f.disk()).views[0].order,['file.name',property('score'),property('status')]);
  await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('changing grouping resets manual column visibility and partitions the actual rows',async()=>{
 const f=await fixture({managed:true});try{
  f.change('Base view','3');await until(()=>f.session.state.result?.view.type==='kanban','Board selected');
  f.click('Group');f.change('Group property',property('score'));f.change('Group direction','DESC');await f.applied();
  const groups=f.session.state.result!.groups;assert.deepEqual(groups.map(group=>group.key),[{type:'number',value:3},{type:'number',value:2},{type:'number',value:1}]);
  const saved=await f.disk();assert.equal(saved.views[3].groupOrder,undefined);assert.deepEqual(saved.views[3].groupBy,{property:property('score'),direction:'DESC'});
  assert.deepEqual(saved.views.slice(0,3),BaseDocument.parse(f.initial).views.slice(0,3));await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('dirty toolbar drafts survive refresh and block view switching/close until explicitly reverted',async()=>{
 const f=await fixture();try{
  f.configure();const input=f.control<HTMLInputElement>('View name');input.focus();f.change('View name','Unsaved name','input');
  await f.vault.modify('Tasks/Alpha.md',notes['Tasks/Alpha.md']+'external note update\n');await f.session.refresh();
  assert.equal(f.control('View name'),input);assert.equal(input.value,'Unsaved name');assert.equal(f.session.hasPendingChanges(),true);
  await assert.rejects(f.session.selectView(1),/Finish or cancel/);await assert.rejects(f.session.close(),/Finish or cancel/);
  assert.equal(input.isConnected,true);assert.equal(await f.adapter.read('Work.base'),source);
  f.change('View name','Table','input');input.dispatchEvent(new f.dom.window.Event('blur'));await f.applied();await f.session.selectView(1);
  assert.equal(f.session.state.result!.view.name,'Cards');assert.equal(await f.adapter.read('Work.base'),source);
 }finally{await f.cleanup();}
});

test('an active property input blocks opening configuration panels and changing views without losing typed text',async()=>{
 const f=await fixture({managed:true});try{
  const cell=f.host.querySelector('[data-path="Tasks/Alpha.md"][data-property="note.statusfieldx"][role="gridcell"]')!;assert.ok(cell);f.key(cell,'Enter');const input=cell.querySelector('input')!;assert.ok(input);input.value='Retain property draft';
  f.click('Filter');assert.equal(f.dialog(),null);assert.equal(input.isConnected,true);assert.equal(input.value,'Retain property draft');
  f.change('Base view','1');assert.equal(f.control<HTMLSelectElement>('Base view').value,'0');await assert.rejects(f.session.close(),/Finish or cancel/);
  assert.equal(input.value,'Retain property draft');f.key(input,'Escape');await f.session.flush();assert.equal(await f.adapter.read('Work.base'),f.initial);assert.equal(f.requests.some(request=>request.op==='set_entry'),false,'unsubmitted property input never reaches the database authoring boundary');await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('readonly sessions retain view switching while exposing no toolbar mutation controls',async()=>{
 const f=await fixture({readOnly:true});try{
  for(const label of ['Filter','Sort','Properties','Group','Settings','View options'])assert.equal(f.host.querySelector(`button[aria-label="${label}"]`),null,label);
  f.change('Base view','1');await until(()=>f.session.state.result?.view.type==='cards','readonly view switch');
  assert.equal(f.buffers.size,0);assert.equal(f.adapter.writes.length,0);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('named-view embeds rename saved references and retain their selected binding',async()=>{
 const before='![[Work.base#Table]]\n[Open](Work.base#Table)\n';
 const f=await fixture({viewName:'Table',files:{'Links.md':before}});try{
  f.configure();f.change('View name','Current tasks','input');f.change('Layout','list');await f.applied();
  assert.equal(f.session.state.result!.view.name,'Current tasks');assert.equal(f.session.state.result!.view.type,'list');
  assert.equal((await f.disk()).views[0].name,'Current tasks');assert.deepEqual(f.renamed,[{basePath:'Work.base',index:0,from:'Table',to:'Current tasks'}]);
  assert.match(await f.vault.read('Links.md'),/Work.base#Current tasks/);assert.doesNotMatch(await f.vault.read('Links.md'),/#Table/);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('partial named-view reference failure retries the original retained note before generic flushing',async()=>{
 const f=await fixture({viewName:'Table',files:{'Links.md':'![[Work.base#Table]]\n'}});try{
  f.adapter.failPaths.add('Links.md');f.configure();f.change('View name','Saved name','input');
  f.doc.getElementById('outside')!.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));
  await until(()=>!!f.dialog()?.textContent?.includes('Review retained changes'),'terminal reference failure retains a reviewable exact draft');
  assert.equal((await f.disk()).views[0].name,'Saved name');assert.equal(f.session.state.result!.view.name,'Saved name');assert.equal(f.renamed.length,1);
  assert.match(await f.vault.read('Links.md'),/#Table/);assert.match((await f.getBuffer('Links.md')).text,/#Saved name/);assert.equal(f.session.hasPendingChanges(),true);
  const attempts=f.adapter.attempts.length;f.submit();await tick();assert.equal(f.adapter.attempts.length,attempts,'Review does not repeat the original reference plan');assert.equal(f.control<HTMLTextAreaElement>('Accepted configuration').value,(await f.getBuffer('Work.base')).text);assert.match(await f.vault.read('Links.md'),/#Table/);
  f.adapter.failPaths.clear();await f.session.flush();
  assert.equal(f.dialog(),null);assert.match(await f.vault.read('Links.md'),/#Saved name/);assert.equal(f.renamed.length,1);
  assert.equal(f.adapter.writes.filter(write=>write.path==='Work.base').length,1);assert.equal(f.adapter.writes.filter(write=>write.path==='Links.md').length,1);
  assert.equal(f.session.hasPendingChanges(),false);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('terminal accepted save retains exact reviewable draft and ordinary Save persists it without replaying the configuration action',async()=>{
 const f=await fixture();try{
  f.adapter.fail=true;f.click('Sort');f.click('Add sort');f.change('Sort property','note.score');f.change('Sort direction','DESC');f.submit();
  await until(()=>!!f.dialog()?.textContent?.includes('Review retained changes'),'terminal accepted failure offers read-only review');
  const buffer=await f.getBuffer('Work.base'),draft=buffer.text;assert.equal(buffer.dirty,true);assert.equal(await f.adapter.read('Work.base'),source);assert.deepEqual(f.publications,['Work.base']);
  assert.equal(f.control<HTMLSelectElement>('Sort property').disabled,true);assert.equal(f.session.hasPendingChanges(),true);
  await assert.rejects(f.session.close(),/Toolbar disk unavailable/);assert.ok(f.dialog());
  const attempts=f.adapter.attempts.length;f.submit();await tick();assert.equal(f.control<HTMLTextAreaElement>('Original saved configuration').value,source);assert.equal(f.control<HTMLTextAreaElement>('Accepted configuration').value,draft);assert.equal(f.control<HTMLTextAreaElement>('Accepted configuration').readOnly,true);assert.equal(f.adapter.attempts.length,attempts,'Review never dispatches a persistence retry');
  f.adapter.fail=false;await f.session.flush();assert.equal(f.dialog(),null,'ordinary Save acknowledges only the exact accepted configuration');
  assert.equal(await f.adapter.read('Work.base'),draft);assert.equal(f.adapter.writes.filter(write=>write.path==='Work.base').length,1);assert.deepEqual(f.publications,['Work.base']);
  assert.deepEqual(f.paths(),['Tasks/Gamma.md','Tasks/Alpha.md','Tasks/Beta.md']);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('failed Configure view command retains its exact shared draft and retries persistence once',async()=>{
 const f=await fixture();try{
  f.adapter.fail=true;f.configure();f.change('Layout','cards');
  f.doc.getElementById('outside')!.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));
  await until(()=>!!f.dialog()?.textContent?.includes('Review retained changes'),'terminal view command exposes its retained sources for review');
  const buffer=await f.getBuffer('Work.base'),draft=buffer.text;
  assert.equal(buffer.dirty,true);assert.equal(await f.adapter.read('Work.base'),source);
  assert.equal(BaseDocument.parse(draft).views[0].type,'cards');
  assert.equal(f.control<HTMLSelectElement>('Layout').disabled,true);assert.deepEqual(f.publications,['Work.base']);
  const attempts=f.adapter.attempts.length;f.submit();await tick();assert.equal(f.control<HTMLTextAreaElement>('Accepted configuration').value,draft);assert.equal(f.adapter.attempts.length,attempts,'Review does not rerun Configure view');
  f.adapter.fail=false;await f.session.flush();assert.equal(f.dialog(),null,'ordinary Save closes the acknowledged view menu');
  assert.equal(await f.adapter.read('Work.base'),draft);assert.deepEqual(f.publications,['Work.base']);
  assert.equal(f.session.state.result!.view.type,'cards');await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('ordinary Save of a retained terminal draft refuses an externally changed file and keeps both external bytes and recoverable draft',async()=>{
 const f=await fixture();try{
  f.adapter.fail=true;f.click('Sort');f.click('Add sort');f.change('Sort property','note.score');f.change('Sort direction','DESC');f.submit();
  await until(()=>!!f.dialog()?.textContent?.includes('Review retained changes'),'terminal configuration failure is retained for review');
  const buffer=await f.getBuffer('Work.base'),draft=buffer.text;f.adapter.fail=false;
  const external=source+'externalChange: preserve\n';await f.adapter.write('Work.base',external);
  const attempts=f.adapter.attempts.length;f.submit();await tick();assert.equal(f.control<HTMLTextAreaElement>('Accepted configuration').value,draft);assert.equal(f.adapter.attempts.length,attempts,'Review cannot overwrite external bytes');await assert.rejects(f.session.flush(),/outside this editor/);
  assert.equal(await f.adapter.read('Work.base'),external);assert.equal(buffer.text,draft);assert.equal(buffer.dirty,true);assert.ok(f.dialog());
  await f.unchangedNotes();
 }finally{
  // Restore only this disposable fixture even if an assertion failed, so cleanup
  // can settle its retained CAS draft without masking the original failure.
  f.adapter.fail=false;await f.adapter.write('Work.base',source);await f.cleanup();
 }
});


test('passive sibling view rebinding preserves its property draft until the saved rename refresh settles',async()=>{
 const f=await fixture({managed:true,viewName:'Table'});try{
  const cell=f.host.querySelector('[data-path="Tasks/Alpha.md"][data-property="note.statusfieldx"][role="gridcell"]')!;f.key(cell,'Enter');
  const input=cell.querySelector<HTMLInputElement>('input')!;input.value='Retained';
  assert.equal(f.session.rebindViewName('Other','Renamed'),false);assert.equal(f.session.rebindViewName('Table','Renamed'),true);
  const next=BaseDocument.parse(await f.vault.read('Work.base'));next.updateView(0,{name:'Renamed'});await f.vault.modify('Work.base',next.toString());await f.session.refresh();
  assert.equal(input.isConnected,true);assert.equal(input.value,'Retained');assert.equal(f.session.hasPendingChanges(),true);
  f.key(input,'Escape');await until(()=>f.session.state.result?.view.name==='Renamed','sibling refreshed binding');
  assert.equal(f.session.rebindViewName('Table','Renamed'),false);assert.equal(f.requests.some(request=>request.op==='set_entry'),false,'passive rebinding never submits the retained property draft');await f.unchangedNotes();
 }finally{await f.cleanup();}
});
