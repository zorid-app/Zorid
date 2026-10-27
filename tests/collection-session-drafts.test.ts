import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseService,DatabaseCollection} from '../src/core/databases.ts';
const collection:DatabaseCollection={id:'abcdefghijkl',name:'Books',revision:'schema-r1',deleted:false,properties:[]};
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await tick();assert.ok(check());}
class Adapter extends MemoryAdapter{
  documentSemantics?:DocumentService;databases?:DatabaseService;
  override async list(){return(await super.list()).map(entry=>({...entry,entryId:entry.path,revision:'r1'}));}
  override async stat(path:string){const entry=await super.stat(path);return entry&&{...entry,entryId:path,revision:'r1'};}
}
test('dirty or uncertain collection schema draft blocks view menus and source replacement',async()=>{
  const adapter=new Adapter({'Work.base':'views:\n - {type: table, name: Books, source: {kind: collection, id: abcdefghijkl}}\n'});
  adapter.databases={async request(command){if(command.op==='update')throw new Error('Reply lost');return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};}};
  const unused=async():Promise<never>=>{throw new Error('unexpected operation');};
  adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,
      metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},metadata:null,exclusion:null}}),
      base:async()=>({source,snapshot,coverageComplete:true,value:{definition:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(await adapter.read('Work.base')).views[0],rows:[],groups:[{key:null,keyId:null,entryIds:[]}],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}}),
    }),
  } as unknown as DocumentService;
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[];
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  await session.ready;await until(()=>!![...host.querySelectorAll('button')].find(button=>button.textContent==='Add property'));
  [...host.querySelectorAll('button')].find(button=>button.textContent==='Add property')!.click();const editor=host.querySelector('.collection-property-editor')!,name=editor.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;name.value='Draft books';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  host.querySelector<HTMLButtonElement>('[aria-label="Views"]')!.click();await tick();assert.equal(dom.window.document.querySelector('.bases-toolbar-popover'),null);assert.equal(name.value,'Draft books');assert.equal(editor.isConnected,true);
  [...editor.querySelectorAll('button')].find(button=>button.textContent==='Apply')!.click();await until(()=>editor.querySelector('[role="alert"]')?.textContent==='Reply lost');
  host.querySelector<HTMLButtonElement>('[aria-label="Change view source"]')!.click();host.querySelector<HTMLButtonElement>('[aria-label="Views"]')!.click();await tick();assert.equal(host.querySelector('.collection-source-chooser'),null);assert.equal(editor.isConnected,true);assert.equal(name.value,'Draft books');assert.equal(session.hasPendingChanges(),true);
  [...editor.querySelectorAll('button')].find(button=>button.textContent==='Cancel')!.click();await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();
});

test('empty Base first view onboarding saves an independent untyped source with browsing controls',async()=>{
  const adapter=new MemoryAdapter({'Work.base':'views: []\n','Idea.md':'---\nscore: 3\n---\nIdea body'}),vault=new Vault(adapter);await vault.initialize();
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>();
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;
  assert.ok(host.querySelector('.collection-source-chooser'));[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith('Notes in your vault'))!.click();
  await until(()=>!host.querySelector('.collection-source-chooser')&&!!session.state.result&&!session.hasPendingChanges());
  const source=BaseDocument.parse(await vault.read('Work.base'));assert.deepEqual(source.views[0].source,{kind:'untyped'});assert.equal(host.querySelector('[aria-label="Properties"]'),null);assert.equal(host.querySelector('[aria-label="Group"]'),null);assert.ok(host.querySelector('[aria-label="Filter"]'));assert.ok(host.querySelector('[aria-label="Sort"]'));assert.ok(!vault.entries.has('Properties.yaml'));
  host.querySelector<HTMLButtonElement>('[aria-label="Views"]')!.click();dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Configure view View"]')!.click();const remove=dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Delete view"]')!;assert.equal(remove.disabled,false);remove.click();
  await until(()=>BaseDocument.parse(session.state.source).views.length===0&&!!host.querySelector('.collection-source-chooser'));assert.equal(host.querySelector('.bases-session-toolbar')?.hasAttribute('hidden'),true);
  await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();
});

test('uncertain New stays bound to its original collection view and retries the identical request',async()=>{
  const original='views:\n - {id: aaaaaaaaaaaa, type: table, name: Books, source: {kind: collection, id: abcdefghijkl}}\n - {id: bbbbbbbbbbbb, type: list, name: Notes, source: {kind: untyped}}\n';
  const adapter=new Adapter({'Work.base':original}),requests:unknown[]=[],errors:unknown[]=[],opened:string[]=[];let first=true;
  adapter.databases={async request(command){if(command.op==='create_entry'){requests.push(structuredClone(command));const pending=first;first=false;if(!pending)await adapter.write(command.path,'Body');return{collections:[collection],entries:[{entryId:command.entryId,collectionId:collection.id,revision:'member-r1',fileRevision:pending?null:'r1',path:command.path,values:{},deleted:false,pendingProjection:pending}],projection:{pending:pending?1:0,issues:[]}};}return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};}};
  const unused=async():Promise<never>=>{throw new Error('unexpected operation');};
  adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},metadata:null,exclusion:null}}),
      base:async(input:{options?:{viewIndex?:number}})=>({source,snapshot,coverageComplete:true,value:{definition:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(await adapter.read('Work.base')).views[input.options?.viewIndex??0],rows:[],groups:[{key:null,keyId:null,entryIds:[]}],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}}),
    }),
  } as unknown as DocumentService;
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!;
  const buffers=new Map<string,NoteBuffer>();
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile:path=>opened.push(path),onError:error=>errors.push(error),buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;
  host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();await until(()=>errors.length>0);assert.equal(session.hasPendingChanges(),true);assert.equal(requests.length,1);
  await assert.rejects(session.selectView(1),/Finish or cancel/);host.querySelector<HTMLButtonElement>('[aria-label="Change view source"]')!.click();assert.equal(host.querySelector('.collection-source-chooser'),null);
  // An external source edit cannot retarget the accepted operation either.
  await vault.modify('Work.base',original.replace('source: {kind: collection, id: abcdefghijkl}','source: {kind: untyped}'));await session.refresh();
  host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();await tick();assert.equal(requests.length,1);assert.ok(errors.some(error=>String(error).includes('original collection view')));
  await vault.modify('Work.base',original);await session.refresh();host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();await until(()=>opened.length===1);assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();
});

async function creationSession(options:{base:string;files?:Record<string,string>;collections?:DatabaseCollection[];browsingCatalog?:boolean;beforeRead?:(path:string)=>Promise<void>;mutation:(command:import('../src/core/databases.ts').DatabaseRequest,adapter:Adapter)=>Promise<import('../src/core/databases.ts').DatabaseResponse>}){
  const adapter=new Adapter({'Work.base':options.base,...options.files}),errors:unknown[]=[],requests:import('../src/core/databases.ts').DatabaseRequest[]=[],opened:string[]=[];
  const read=adapter.read.bind(adapter);adapter.read=async path=>{await options.beforeRead?.(path);return read(path);};
  adapter.databases={async request(command){if(['create_entry','set_entry'].includes(command.op)){requests.push(structuredClone(command));return options.mutation(command,adapter);}return{collections:options.collections??[collection],entries:[],projection:{pending:0,issues:[]}};}};
  const unused=async():Promise<never>=>{throw new Error('unexpected operation');};
  adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},metadata:null,exclusion:null}}),base:async(input:{options?:{viewIndex?:number}})=>({source,snapshot,coverageComplete:true,value:{definition:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(await adapter.read('Work.base')).views[input.options?.viewIndex??0],rows:options.browsingCatalog?[{entryId:'Sample.md',revision:'r1',path:'Sample.md',values:{'file.name':{type:'string',value:'Sample'},'file.folder':{type:'string',value:''}},editValues:{}}]:[],groups:[{key:null,keyId:null,entryIds:options.browsingCatalog?['Sample.md']:[]}],groupOptions:[],properties:options.browsingCatalog?['file.name','file.folder']:['file.name'],availableProperties:options.browsingCatalog?['file.name','file.folder','note.score','formula.double']:['file.name'],counts:{scanned:options.browsingCatalog?1:0,matched:options.browsingCatalog?1:0,afterGroupOrder:options.browsingCatalog?1:0,afterSearch:options.browsingCatalog?1:0,returned:options.browsingCatalog?1:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}})})} as unknown as DocumentService;
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>();
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile:path=>opened.push(path),onError:error=>errors.push(error),buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;
  return{adapter,vault,dom,host,session,requests,errors,opened,async close(){await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('a source replaced during template IO cannot publish New into the replacement collection',async()=>{
  const a='views:\n - {id: aaaaaaaaaaaa, type: table, name: Books, source: {kind: collection, id: abcdefghijkl}, newItemTemplate: Template.md}\n';
  let release!:()=>void,entered!:()=>void,hold=false;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const other={...collection,id:'mnopqrstuvwx',name:'Projects'};
  const f=await creationSession({base:a,files:{'Template.md':'Template body'},collections:[collection,other],beforeRead:async path=>{if(hold&&path==='Template.md'){entered();await gate;}},mutation:async()=>{throw new Error('must not publish');}});
  hold=true;f.host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();await started;
  await f.vault.modify('Work.base',a.replace('id: abcdefghijkl','id: mnopqrstuvwx'));await f.session.refresh();release();
  await until(()=>f.errors.some(error=>String(error).includes('view source changed')));assert.equal(f.requests.length,0);assert.equal(f.opened.length,0);await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('definitive non-commit New rejection releases its old attempt and allows fresh planning',async()=>{
  const base='views:\n - {id: aaaaaaaaaaaa, type: table, name: Books, source: {kind: collection, id: abcdefghijkl}}\n';let first=true;
  const f=await creationSession({base,mutation:async(command,adapter)=>{
    if(first){first=false;await adapter.write('Untitled.md','Other writer');throw Object.assign(new Error('Path occupied'),{source:'host',commitUncertain:false,code:'path_occupied'});}
    assert.equal(command.op,'create_entry');if(command.op!=='create_entry')throw new Error('wrong command');await adapter.write(command.path,'Created body');return{collections:[collection],entries:[{entryId:command.entryId,collectionId:collection.id,revision:'member-r1',fileRevision:'r1',path:command.path,values:{},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};
  }});
  f.host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();await until(()=>f.errors.length>0&&!f.session.hasPendingChanges());assert.equal(f.requests.length,1);
  f.host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();await until(()=>f.opened.length===1);assert.equal(f.requests.length,2);const [old,next]=f.requests;assert.equal(old.op,'create_entry');assert.equal(next.op,'create_entry');if(old.op==='create_entry'&&next.op==='create_entry'){assert.notEqual(old.operationId,next.operationId);assert.notEqual(old.entryId,next.entryId);assert.equal(next.path,'Untitled 1.md');}await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('rendered untyped source keeps metadata Filter and Sort catalogs without property columns',async()=>{
  const base='views:\n - id: aaaaaaaaaaaa\n   type: table\n   name: Notes\n   source: {kind: untyped}\n   order: [file.name, file.folder]\n   filters: note["score"] == 3\n   sort: [{property: note.score, direction: ASC}]\n';
  const f=await creationSession({base,files:{'Sample.md':'---\nscore: 3\n---\nSample body'},browsingCatalog:true,mutation:async()=>{throw new Error('browsing must not edit properties');}});
  assert.ok(f.host.querySelector('.zorid-bases-table'));const columns=[...f.host.querySelectorAll<HTMLElement>('[role="columnheader"]')].map(column=>column.title);assert.deepEqual(columns,['file.name','file.folder']);assert.equal(f.host.querySelector('[data-property="note.score"]'),null);assert.equal(f.host.querySelector('[data-property="formula.double"]'),null);assert.equal(f.host.querySelector('[aria-label="Properties"]'),null);
  f.host.querySelector<HTMLButtonElement>('[aria-label="Filter"]')!.click();const filter=f.dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Filter property"]')!;assert.ok(filter);assert.ok([...filter.options].some(option=>option.value==='note.score'));assert.ok([...filter.options].some(option=>option.value==='formula.double'));f.host.querySelector<HTMLButtonElement>('[aria-label="Filter"]')!.click();
  f.host.querySelector<HTMLButtonElement>('[aria-label="Sort"]')!.click();const sort=f.dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Sort property"]')!;assert.ok(sort);assert.ok([...sort.options].some(option=>option.value==='note.score'));assert.ok([...sort.options].some(option=>option.value==='formula.double'));f.host.querySelector<HTMLButtonElement>('[aria-label="Sort"]')!.click();assert.equal(f.requests.length,0);await f.close();
});
