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
  await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();
});
