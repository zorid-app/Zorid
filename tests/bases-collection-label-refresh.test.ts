import {openBaseToolbarPanel} from './helpers/base-toolbar.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseService} from '../src/core/databases.ts';

const property='mnopqrstuvwx',a='abcdefghijkl',b='bbbbbbbbbbbb';
const collections:DatabaseCollection[]=[{id:a,name:'Books',revision:'schema-a',deleted:false,properties:[{id:property,name:'Rating',datatype:'number',options:[]}]},{id:b,name:'Projects',revision:'schema-b',deleted:false,properties:[{id:property,name:'Budget',datatype:'number',options:[]}]}];
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await tick();assert.ok(check());}
class Adapter extends MemoryAdapter{
  documentSemantics?:DocumentService;databases?:DatabaseService;
  override async list(){return(await super.list()).map(entry=>({...entry,entryId:entry.path,revision:'r1'}));}
  override async stat(path:string){const entry=await super.stat(path);return entry&&{...entry,entryId:path,revision:'r1'};}
}
async function fixture(initiallyHeld=false){
  const base=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Books',source:{kind:'collection',id:a},order:['file.name',`note.${property}`]},{id:'bbbbbbbbbbbb',type:'table',name:'Projects',source:{kind:'collection',id:b},order:['file.name',`note.${property}`]},{id:'cccccccccccc',type:'table',name:'Notes',source:{kind:'untyped'}}]});
  const adapter=new Adapter({'Work.base':base});let gate:Promise<void>|undefined,release:()=>void=()=>{},requests=0;
  const pause=()=>{gate=new Promise<void>(resolve=>{release=()=>{gate=undefined;resolve();};});};if(initiallyHeld)pause();
  adapter.databases={async request(){requests++;await gate;return{collections,entries:[],projection:{pending:0,issues:[]}};}};
  const unused=async():Promise<never>=>{throw new Error('unexpected core effect');},actor={id:'Work.base',revision:'r1',path:'Work.base',kind:'file' as const,deleted:false};
  adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:actor,metadata:null,exclusion:null}}),
      base:async(input:{options?:{viewIndex?:number}})=>({source,snapshot,coverageComplete:true,value:{definition:actor,result:{snapshotId:snapshot,view:BaseDocument.parse(base).views[input.options?.viewIndex??0],rows:[],groups:[{key:null,keyId:null,entryIds:[]}],groupOptions:[],properties:['file.name',`note.${property}`],availableProperties:['file.name',`note.${property}`],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}})})} as unknown as DocumentService;
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>();
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  const panel=()=>doc.querySelector<HTMLElement>('.bases-toolbar-popover[data-panel="Properties"]')!;
  const open=()=>{openBaseToolbarPanel(doc,'Properties');return panel();};
  const closePanel=()=>{const search=panel()?.querySelector<HTMLInputElement>('input[type="search"]');search?.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));};
  return {session,host,doc,open,panel,closePanel,pause,release:()=>release(),requests:()=>requests,async close(){release();await session.ready;closePanel();await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('an open Properties menu receives human labels after its initial delayed schema load',async()=>{
  const f=await fixture(true);try{
    await until(()=>!!f.host.querySelector('[data-toolbar-action="settings"]'));
    const panel=f.open(),search=panel.querySelector<HTMLInputElement>('input[type="search"]')!;assert.ok(panel.textContent?.includes(property));
    search.value='Rating';search.dispatchEvent(new f.doc.defaultView!.Event('input',{bubbles:true}));
    f.release();await f.session.ready;await until(()=>f.panel()?.querySelector<HTMLInputElement>(`input[data-property="note.${property}"]`)?.parentElement?.textContent==='Rating');
    assert.equal(f.panel(),panel);assert.equal(f.doc.activeElement,search);assert.equal(search.value,'Rating');assert.equal(panel.textContent?.includes(property),false);
  }finally{await f.close();}
});

test('same-source reload keeps friendly names while another source cannot reuse its cached labels',async()=>{
  const f=await fixture();try{
    await f.session.ready;f.pause();const count=f.requests(),refresh=f.session.refresh();await until(()=>f.requests()>count);
    assert.ok(f.open().textContent?.includes('Rating'),'same-source schema load preserves presentation only');
    f.release();await refresh;f.closePanel();f.pause();const nextCount=f.requests();await f.session.selectView(1);await until(()=>f.requests()>nextCount);
    const panel=f.open();assert.equal(panel.textContent?.includes('Rating'),false,'other collection cannot borrow the old name for the same property ID');
    f.release();await until(()=>panel.querySelector<HTMLInputElement>(`input[data-property="note.${property}"]`)?.parentElement?.textContent==='Budget');assert.equal(panel.textContent?.includes('Rating'),false);
    f.closePanel();await f.session.selectView(2);openBaseToolbarPanel(f.doc,'Properties');assert.equal(f.panel(),null);assert.equal(f.doc.querySelector('[data-setting="property-visibility"]'),null);assert.equal(f.doc.querySelector('[data-setting="group"]'),null);f.doc.querySelector<HTMLButtonElement>('[data-panel-action="close"]')!.click();
  }finally{await f.close();}
});
