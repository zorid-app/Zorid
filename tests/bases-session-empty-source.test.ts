import test from 'node:test';
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
async function fixture(delayedSchema:boolean){
 const adapter=new Adapter({'Empty.base':'views: []\n'}),requests:DatabaseRequest[]=[],errors:unknown[]=[],buffers=new Map<string,NoteBuffer>();let collection:DatabaseCollection|undefined,release!:()=>void;
 let schemaGate=delayedSchema?new Promise<void>(resolve=>{release=resolve;}):Promise.resolve();if(!delayedSchema)release=()=>{};
 adapter.databases={async request(command){requests.push(structuredClone(command));if(command.op==='create'){assert.equal(command.preset,'blank');collection={id:collectionId,name:command.name,revision:'schema-r1',deleted:false,properties:[]};}else if(command.op==='get')await schemaGate;else assert.equal(command.op,'list');return{collections:collection?[collection]:[],entries:[],projection:{pending:0,issues:[]}};}};
 const actor=async()=>{const entry=(await adapter.stat('Empty.base'))!;return{id:entry.entryId,revision:entry.revision,path:entry.path,kind:'file'as const,deleted:false};},unused=async():Promise<never>=>{throw new Error('Unexpected document operation');};
 // Echo the saved definition and collection schema from the transport. There
 // are no rows or fields to manufacture or inject into the rendered table.
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:await actor(),metadata:null,exclusion:null}}),base:async input=>{
   const view=BaseDocument.parse(await adapter.read('Empty.base')).views[input.options?.viewIndex??0];assert.ok(view);const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[],groups:[{key:null,keyId:null,entryIds:[]}],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,refreshHint:{dependency:'none',timezone:'UTC',nextWakeMs:null}};return{source,snapshot,coverageComplete:true,value:{definition:await actor(),result}};
  }})}as DocumentService;
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
 const session=createBaseSession(host,{vault,basePath:'Empty.base',validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:`r${adapter.revision}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.equal(session.state.result,null);
 return{adapter,vault,requests,errors,doc,host,session,release:()=>release(),holdSchema(){schemaGate=new Promise<void>(resolve=>{release=resolve;});return()=>release();},async close(){release();for(const input of doc.querySelectorAll('input'))input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}
test('creating a new empty source retains real table authoring controls after delayed schema loading',async()=>{
 const f=await fixture(true);try{
  const create=[...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!;assert.ok(create);create.click();await until(()=>f.requests.some(request=>request.op==='get'));assert.equal(f.host.querySelector('.zorid-bases-table-add-property'),null,'an unresolved schema cannot grant table authoring');f.release();
  await until(()=>!!f.session.state.result&&!f.session.hasPendingChanges()&&!f.doc.querySelector('.collection-source-chooser'));await tick();
  const table=f.host.querySelector<HTMLElement>('.zorid-bases-table')!;assert.ok(table);assert.ok(table.querySelector('.zorid-bases-table-new'),'the real table must expose New page after its authoring capability settles');assert.ok(table.querySelector('.zorid-bases-table-add-property'),'the real table must expose its trailing Add property control');assert.equal(table.querySelector('[role="columnheader"]')?.textContent?.trim(),'Name');assert.equal(f.host.textContent?.includes(collectionId),false,'opaque collection IDs must not replace the friendly source label');
  const saved=BaseDocument.parse(await f.adapter.read('Empty.base'));assert.deepEqual(saved.views[0].source,{kind:'collection',id:collectionId});assert.equal(f.requests.filter(request=>request.op==='create').length,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('an empty collection table regains real authoring controls after switching views through an equal schema reload',async()=>{
 const f=await fixture(false);try{
  [...f.doc.querySelectorAll<HTMLButtonElement>('.collection-source-chooser button')].find(button=>button.textContent==='New empty data source')!.click();await until(()=>!!f.session.state.result&&!f.session.hasPendingChanges()&&!f.doc.querySelector('.collection-source-chooser'));
  assert.ok(f.host.querySelector('.zorid-bases-table-new'));const saved=BaseDocument.parse(await f.adapter.read('Empty.base'));await f.adapter.write('Empty.base',JSON.stringify({views:[saved.views[0],{...saved.views[0],id:'bbbbbbbbbbbb',name:'Secondary'}]}));await f.vault.reload();await f.session.refresh();
  const gets=f.requests.filter(request=>request.op==='get').length,release=f.holdSchema();await f.session.selectView(1);await until(()=>f.requests.filter(request=>request.op==='get').length>gets&&f.session.state.result?.view.name==='Secondary');
  assert.equal(f.host.querySelector('.zorid-bases-table-add-property'),null,'the newly selected table cannot author through unresolved schema authority');release();await until(()=>f.host.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false');await tick();
  const table=f.host.querySelector('.zorid-bases-table')!;assert.ok(table.querySelector('.zorid-bases-table-new'),'equal schema presentation must still restore the New page capability');assert.ok(table.querySelector('.zorid-bases-table-add-property'),'equal schema presentation must still restore trailing Add property');assert.equal(table.querySelector('[role="columnheader"]')?.textContent?.trim(),'Name');assert.equal(f.host.textContent?.includes(collectionId),false);table.querySelector<HTMLButtonElement>('.zorid-bases-table-add-property')!.click();assert.ok(f.doc.querySelector('.collection-property-picker'));assert.equal(f.doc.activeElement,f.doc.querySelector('[aria-label="Type property name…"]'));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
