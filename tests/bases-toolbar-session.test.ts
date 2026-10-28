import {openBaseToolbarPanel} from './helpers/base-toolbar.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
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
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean,reason:string){for(let i=0;i<250&&!check();i++)await tick();assert.ok(check(),reason);}
async function fixture(options:{readOnly?:boolean;viewName?:string;source?:string;files?:Record<string,string>}={}){
 class Adapter extends MemoryAdapter{
  fail=false;failPaths=new Set<string>();writes:{path:string;text:string}[]=[];
  override async write(path:string,text:string){if(this.fail&&path==='Work.base'||this.failPaths.has(path))throw new Error('Toolbar disk unavailable');await super.write(path,text);this.writes.push({path,text});}
 }
 const initial=options.source??source,adapter=new Adapter({'Work.base':initial,...notes,...options.files}),vault=new Vault(adapter);await vault.initialize();
 const dom=new JSDOM('<main></main><button id="outside">Outside control</button>',{pretendToBeVisual:true,url:'https://zorid.test/'}),doc=dom.window.document,host=doc.querySelector('main')!;
 const buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],publications:string[]=[],renamed:{basePath:string;index:number;from:string;to:string}[]=[];
 const getBuffer=async(path:string)=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000,storage:dom.window.localStorage});buffers.set(path,buffer);}await buffer.load();return buffer;};
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
 const unchangedNotes=async()=>{for(const[path,text]of Object.entries(notes))assert.equal(await adapter.read(path),text,path);};
 return{adapter,vault,dom,doc,host,buffers,errors,publications,renamed,getBuffer,session,dialog,control,click,change,key,submit,applied,configure,disk,paths,unchangedNotes,initial,
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

test('typed view filter changes actual rows while retaining the base-wide filter and note bytes',async()=>{
 const f=await fixture({files:{'Properties.yaml':'properties:\n  score: {type: number}\n'}});try{
  f.click('Filter');f.click('Add filter');f.change('Filter property','note.score');f.change('Condition','gt');f.change('Filter value','1','input');
  assert.equal(f.session.state.result!.rows.length,3);assert.equal(await f.adapter.read('Work.base'),source);
  await f.applied();assert.deepEqual(f.paths(),['Tasks/Alpha.md','Tasks/Gamma.md']);
  const saved=await f.disk();assert.equal(saved.getRoot('filters'),BaseDocument.parse(source).getRoot('filters'));assert.deepEqual(saved.views[0].filters,{and:['note["score"] > 1']});
  assert.deepEqual(saved.views.slice(1),BaseDocument.parse(source).views.slice(1));await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('sort and visible property order update real query results through guarded configuration writes',async()=>{
 const f=await fixture();try{
  f.click('Sort');f.click('Add sort');f.change('Sort property','note.score');f.change('Sort direction','ASC');await f.applied();
  assert.deepEqual(f.paths(),['Tasks/Beta.md','Tasks/Alpha.md','Tasks/Gamma.md']);
  f.click('Properties');const done=f.dialog()!.querySelector<HTMLInputElement>('input[data-property="note.done"]')!;assert.ok(done);done.click();f.click('Move score earlier');
  assert.ok(f.session.state.result!.properties.includes('note.done'));await f.applied();
  assert.deepEqual(f.session.state.result!.properties,['file.name','note.score','note.status']);assert.deepEqual((await f.disk()).views[0].order,['file.name','note.score','note.status']);
  await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('changing grouping resets manual column visibility and partitions the actual rows',async()=>{
 const f=await fixture();try{
  f.change('Base view','3');await until(()=>f.session.state.result?.view.type==='kanban','Board selected');
  f.click('Group');f.change('Group property','note.score');f.change('Group direction','DESC');await f.applied();
  const groups=f.session.state.result!.groups;assert.deepEqual(groups.map(group=>group.key),[{type:'number',value:3},{type:'number',value:2},{type:'number',value:1}]);
  const saved=await f.disk();assert.equal(saved.views[3].groupOrder,undefined);assert.deepEqual(saved.views[3].groupBy,{property:'note.score',direction:'DESC'});
  assert.deepEqual(saved.views.slice(0,3),BaseDocument.parse(source).views.slice(0,3));await f.unchangedNotes();
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
 const f=await fixture();try{
  const cell=f.host.querySelector('[data-path="Tasks/Alpha.md"][data-property="note.status"][role="gridcell"]')!;assert.ok(cell);f.key(cell,'Enter');const input=cell.querySelector('input')!;assert.ok(input);input.value='Retain property draft';
  f.click('Filter');assert.equal(f.dialog(),null);assert.equal(input.isConnected,true);assert.equal(input.value,'Retain property draft');
  f.change('Base view','1');assert.equal(f.control<HTMLSelectElement>('Base view').value,'0');await assert.rejects(f.session.close(),/Finish or cancel/);
  assert.equal(input.value,'Retain property draft');f.key(input,'Escape');await f.session.flush();assert.equal(await f.adapter.read('Work.base'),source);await f.unchangedNotes();
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
  await until(()=>!!f.dialog()?.textContent?.includes('Retry save'),'failed reference offers retained retry');
  assert.equal((await f.disk()).views[0].name,'Saved name');assert.equal(f.session.state.result!.view.name,'Saved name');assert.equal(f.renamed.length,1);
  assert.match(await f.vault.read('Links.md'),/#Table/);assert.match((await f.getBuffer('Links.md')).text,/#Saved name/);assert.equal(f.session.hasPendingChanges(),true);
  f.adapter.failPaths.clear();await f.session.flush();
  assert.equal(f.dialog(),null);assert.match(await f.vault.read('Links.md'),/#Saved name/);assert.equal(f.renamed.length,1);
  assert.equal(f.adapter.writes.filter(write=>write.path==='Work.base').length,1);assert.equal(f.adapter.writes.filter(write=>write.path==='Links.md').length,1);
  assert.equal(f.session.hasPendingChanges(),false);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('failed accepted save retains exact draft and Retry save persists it without replaying the configuration action',async()=>{
 const f=await fixture();try{
  f.adapter.fail=true;f.click('Sort');f.click('Add sort');f.change('Sort property','note.score');f.change('Sort direction','DESC');f.submit();
  await until(()=>!!f.dialog()?.textContent?.includes('Retry save'),'accepted failure offers persistence retry');
  const buffer=await f.getBuffer('Work.base'),draft=buffer.text;assert.equal(buffer.dirty,true);assert.equal(await f.adapter.read('Work.base'),source);assert.deepEqual(f.publications,['Work.base']);
  assert.equal(f.control<HTMLSelectElement>('Sort property').disabled,true);assert.equal(f.session.hasPendingChanges(),true);
  await assert.rejects(f.session.close(),/Toolbar disk unavailable/);assert.ok(f.dialog());
  f.adapter.fail=false;f.submit();await until(()=>!f.dialog(),'successful exact retry closes dialog');await f.session.flush();
  assert.equal(await f.adapter.read('Work.base'),draft);assert.equal(f.adapter.writes.filter(write=>write.path==='Work.base').length,1);assert.deepEqual(f.publications,['Work.base']);
  assert.deepEqual(f.paths(),['Tasks/Gamma.md','Tasks/Alpha.md','Tasks/Beta.md']);await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('failed Configure view command retains its exact shared draft and retries persistence once',async()=>{
 const f=await fixture();try{
  f.adapter.fail=true;f.configure();f.change('Layout','cards');
  f.doc.getElementById('outside')!.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));
  await until(()=>!!f.dialog()?.textContent?.includes('Retry save'),'failed view command offers exact persistence retry');
  const buffer=await f.getBuffer('Work.base'),draft=buffer.text;
  assert.equal(buffer.dirty,true);assert.equal(await f.adapter.read('Work.base'),source);
  assert.equal(BaseDocument.parse(draft).views[0].type,'cards');
  assert.equal(f.control<HTMLSelectElement>('Layout').disabled,true);assert.deepEqual(f.publications,['Work.base']);
  f.adapter.fail=false;f.submit();await until(()=>!f.dialog(),'retry closes the settled view menu');await f.session.flush();
  assert.equal(await f.adapter.read('Work.base'),draft);assert.deepEqual(f.publications,['Work.base']);
  assert.equal(f.session.state.result!.view.type,'cards');await f.unchangedNotes();
 }finally{await f.cleanup();}
});

test('retained retry refuses an externally changed file and keeps both external bytes and recoverable draft',async()=>{
 const f=await fixture();try{
  f.adapter.fail=true;f.click('Group');f.change('Group property','note.status');f.submit();
  await until(()=>!!f.dialog()?.textContent?.includes('Retry save'),'group failure retained');
  const buffer=await f.getBuffer('Work.base'),draft=buffer.text;f.adapter.fail=false;
  const external=source+'externalChange: preserve\n';await f.adapter.write('Work.base',external);
  f.submit();await until(()=>!!f.dialog()?.textContent?.includes('outside this editor'),'CAS error remains actionable');
  assert.equal(await f.adapter.read('Work.base'),external);assert.equal(buffer.text,draft);assert.equal(buffer.dirty,true);assert.ok(f.dialog());
  await f.unchangedNotes();
 }finally{
  // Restore only this disposable fixture even if an assertion failed, so cleanup
  // can settle its retained CAS draft without masking the original failure.
  f.adapter.fail=false;await f.adapter.write('Work.base',source);await f.cleanup();
 }
});


test('passive sibling view rebinding preserves its property draft until the saved rename refresh settles',async()=>{
 const f=await fixture({viewName:'Table'});try{
  const cell=f.host.querySelector('[data-path="Tasks/Alpha.md"][data-property="note.status"][role="gridcell"]')!;f.key(cell,'Enter');
  const input=cell.querySelector<HTMLInputElement>('input')!;input.value='Retained';
  assert.equal(f.session.rebindViewName('Other','Renamed'),false);assert.equal(f.session.rebindViewName('Table','Renamed'),true);
  const next=BaseDocument.parse(await f.vault.read('Work.base'));next.updateView(0,{name:'Renamed'});await f.vault.modify('Work.base',next.toString());await f.session.refresh();
  assert.equal(input.isConnected,true);assert.equal(input.value,'Retained');assert.equal(f.session.hasPendingChanges(),true);
  f.key(input,'Escape');await until(()=>f.session.state.result?.view.name==='Renamed','sibling refreshed binding');
  assert.equal(f.session.rebindViewName('Table','Renamed'),false);await f.unchangedNotes();
 }finally{await f.cleanup();}
});
