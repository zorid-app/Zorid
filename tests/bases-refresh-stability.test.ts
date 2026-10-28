import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseService} from '../src/core/databases.ts';

const field='mnopqrstuvwx',collectionId='abcdefghijkl';
const collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:field,name:'Status',datatype:'select',options:[{id:'optiontodo01',name:'Todo'},{id:'optiondone01',name:'Done'}]}]};
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
class Adapter extends MemoryAdapter{
 documentSemantics?:DocumentService;databases?:DatabaseService;
 override async list(){return(await super.list()).map(entry=>({...entry,entryId:entry.path,revision:'r1'}));}
 override async stat(path:string){const entry=await super.stat(path);return entry&&{...entry,entryId:path,revision:'r1'};}
}
async function fixture(readOnly=false){
 const base=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Tasks',source:{kind:'collection',id:collectionId},order:['file.name',`note.${field}`]}]});
 const adapter=new Adapter({'Work.base':base,'One.md':'---\nStatus: Todo\n---\nBody'}),requests:string[]=[],errors:unknown[]=[];let schemaGate:Promise<void>|undefined,releaseSchema:()=>void=()=>{},queryGate:Promise<void>|undefined,releaseQuery:()=>void=()=>{},currentCollection=structuredClone(collection),currentValue='Todo',queryError:Error|undefined;
 adapter.databases={async request(command){requests.push(command.op);await schemaGate;return{collections:[currentCollection],entries:[{entryId:'One.md',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{[field]:'optiontodo01'},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};}};
 const actor={id:'Work.base',revision:'r1',path:'Work.base',kind:'file' as const,deleted:false},unused=async():Promise<never>=>{throw new Error('unexpected operation');};
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,
   metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:actor,metadata:null,exclusion:null}}),
   base:async()=>{await queryGate;if(queryError)throw queryError;return({source,snapshot,coverageComplete:true,value:{definition:actor,result:{snapshotId:snapshot,view:BaseDocument.parse(base).views[0],rows:[{entryId:'One.md',revision:'r1',path:'One.md',values:{'file.name':{type:'string',value:'One'},[`note.${field}`]:{type:'string',value:currentValue}},editValues:{[field]:'optiontodo01'}}],groups:[{key:null,keyId:null,entryIds:['One.md']}],groupOptions:[],properties:['file.name',`note.${field}`],availableProperties:['file.name',`note.${field}`],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,refreshHint:{dependency:'none',timezone:'UTC',nextWakeMs:null}}}});},
  })} as unknown as DocumentService;
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
 const buffers=new Map<string,NoteBuffer>();
 const session=createBaseSession(host,{vault,basePath:'Work.base',readOnly,validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;await tick();
 const cell=()=>host.querySelector<HTMLElement>(`[role=gridcell][data-property="note.${field}"]`)!;
 return{session,host,doc,dom,cell,requests,errors,setSchema(){currentCollection={...currentCollection,revision:'schema-r2',properties:[{id:field,name:'Stage',datatype:'text',options:[]}]};},setValue(){currentValue='Done';},failQuery(){queryError=new Error('Refresh failed');},holdQuery(){queryGate=new Promise<void>(resolve=>{releaseQuery=()=>{queryGate=undefined;resolve();};});return()=>releaseQuery();},holdSchema(){schemaGate=new Promise<void>(resolve=>{releaseSchema=()=>{schemaGate=undefined;resolve();};});return()=>releaseSchema();},async close(){releaseSchema();releaseQuery();doc.querySelector<HTMLInputElement>('.bases-property-popover input')?.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('repeated unchanged BaseSession refreshes do not announce recurring foreground Updating',async()=>{
 const f=await fixture();try{
  const pulses:string[]=[];
  for(let n=0;n<3;n++){const refresh=f.session.refresh();pulses.push(f.host.querySelector('.bases-session-status')!.textContent??'');await refresh;await tick();}
  assert.deepEqual(pulses,['','',''],'same-data background revalidation must not flash Updating on every hint');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('unchanged refreshes retain the exact visible select cell and an open selector input/focus',async()=>{
 const f=await fixture();try{
  const original=f.cell();assert.ok(original);assert.match(original.textContent??'',/Todo/);
  await f.session.refresh();await tick();assert.equal(f.cell(),original,'unchanged schema/results must not replace the visible select field');
  original.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  const popup=f.doc.querySelector<HTMLElement>('.bases-property-popover')!,input=popup?.querySelector<HTMLInputElement>('input')!;assert.ok(input,'actual managed select field opens its real picker');input.value='Do';input.focus();
  for(let n=0;n<3;n++){await f.session.refresh();await tick();assert.equal(f.cell(),original);assert.equal(f.doc.querySelector('.bases-property-popover'),popup);assert.equal(f.doc.activeElement,input);assert.equal(input.value,'Do');}
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});


test('concurrent same-source schema reads retain presentation, share one lookup and revoke editing until settled',async()=>{
 const f=await fixture();try{
  const cell=f.cell(),count=f.requests.length,release=f.holdSchema(),refresh=f.session.refresh();
  await tick();assert.equal(f.requests.length-count,1,'controller completion and public refresh join the same exact-proof lookup');
  assert.equal(cell.isConnected,true);assert.equal(f.cell(),cell);cell.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.equal(f.doc.querySelector('.bases-property-popover'),null,'stale schema is presentation, never editing authority');
  release();await refresh;await tick();assert.equal(f.cell(),cell);assert.equal(cell.isConnected,true);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('real schema and row value changes still update the current Base after revalidation',async()=>{
 const f=await fixture();try{
  const original=f.cell();f.setValue();await f.session.refresh();await tick();assert.match(f.cell().textContent??'',/Done/);
  f.setSchema();await f.session.refresh();await tick();assert.ok([...f.host.querySelectorAll('[role=columnheader]')].some(node=>node.textContent?.includes('Stage')));assert.notEqual(f.cell(),original);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('slow refresh retains rows and shows delayed Updating, then exposes real query errors',async()=>{
 const f=await fixture();try{
  const original=f.cell(),release=f.holdQuery(),refresh=f.session.refresh();assert.equal(f.host.querySelector('.bases-session-status')!.textContent,'');
  await new Promise(resolve=>setTimeout(resolve,380));assert.equal(f.host.querySelector('.bases-session-status')!.textContent,'Updating…');assert.equal(f.cell(),original);
  f.failQuery();release();await refresh;await tick();assert.equal(f.host.querySelector('.bases-session-status')!.textContent,'Refresh failed');
 }finally{await f.close();}
});

test('read-only select presentation remains stable and cannot open an editor after unchanged refresh',async()=>{
 const f=await fixture(true);try{
  const original=f.cell();await f.session.refresh();await tick();assert.equal(f.cell(),original);
  original.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.equal(f.doc.querySelector('.bases-property-popover'),null);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
