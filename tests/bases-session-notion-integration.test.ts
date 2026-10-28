import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse,stringify} from 'yaml';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
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
async function fixture(){
 const initialViews=[{id:'aaaaaaaaaaaa',type:'table',name:'Primary',source:{kind:'collection',id:collectionId},order:['file.name',`note.${score}`,`note.${notes}`]},{id:'bbbbbbbbbbbb',type:'table',name:'Secondary',source:{kind:'collection',id:collectionId},order:['file.name',`note.${notes}`]}];
 const adapter=new Adapter({'Work.base':JSON.stringify({views:initialViews}),'One.md':'---\nScore: 1\nNotes: Original\n---\nExact body.\n'});
 let collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:score,name:'Score',datatype:'number',options:[]},{id:notes,name:'Notes',datatype:'text',options:[]}]};
 let member:DatabaseEntry={entryId:'One.md',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{[score]:1,[notes]:'Original'},deleted:false,pendingProjection:false};
 const requests:DatabaseRequest[]=[],errors:unknown[]=[],buffers=new Map<string,NoteBuffer>();let hold:ReturnType<typeof deferred>|undefined,fail=false;
 const response=()=>structuredClone({collections:[collection],entries:[member],projection:{pending:0,issues:[]}});
 adapter.databases={async request(command){requests.push(structuredClone(command));if(command.op==='get'||command.op==='list')return response();
  if(command.op==='set_entry'){assert.equal(command.expectedRevision,member.revision);assert.equal(command.expectedCollectionRevision,collection.revision);await hold?.promise;if(fail)throw new Error('Property save rejected');const values={...member.values,...command.values};const frontmatter=Object.fromEntries(collection.properties.filter(field=>Object.hasOwn(values,field.id)).map(field=>[field.name,values[field.id]]));await adapter.write('One.md',`---\n${stringify(frontmatter)}---\nExact body.\n`);member={...member,values,revision:'member-r2',fileRevision:(await adapter.stat('One.md'))!.revision};return response();}
  if(command.op==='update'){assert.equal(command.expectedRevision,collection.revision);await hold?.promise;collection={...collection,name:command.name,revision:'schema-r2',properties:command.properties.map(field=>({...field,id:field.id??added,options:(field.options??[]).map((option,index)=>({...option,id:option.id??`option${index}`}))}))};return response();}
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
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
 const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);await until(()=>!!host.querySelector(`[role="gridcell"][data-property="note.${score}"]`));
 const cell=(property:string)=>host.querySelector<HTMLElement>(`[role="gridcell"][data-property="note.${property}"]`)!;
 const key=(element:Element,key:string)=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});element.dispatchEvent(event);return event;};
 const edit=(property:string,value:string)=>{cell(property).click();const input=cell(property).querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value=value;return input;};
 const pointer=(element:Element)=>{element.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));(element as HTMLElement).click();};
 return{adapter,vault,dom,doc,host,session,requests,errors,cell,key,edit,pointer,hold(){hold=deferred();return()=>{hold?.resolve();hold=undefined;};},fail(){fail=true;},async saved(){return BaseDocument.parse(await adapter.read('Work.base'));},async close(){hold?.resolve();hold=undefined;fail=false;for(const input of doc.querySelectorAll('[data-base-editing] input'))key(input,'Escape');doc.querySelector<HTMLButtonElement>('.collection-property-picker-cancel')?.click();[...doc.querySelectorAll<HTMLButtonElement>('.collection-property-editor button')].find(button=>button.textContent==='Cancel')?.click();for(const button of doc.querySelectorAll<HTMLButtonElement>('[aria-label="Close"]'))button.click();await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('managed session Tab waits for accepted saved value then selects the adjacent cell without editing it',async()=>{
 const f=await fixture();try{const release=f.hold(),input=f.edit(score,'7');assert.equal(f.key(input,'Tab').defaultPrevented,true);await until(()=>f.requests.some(request=>request.op==='set_entry'));assert.equal(f.cell(score).dataset.baseEditing,'pending');assert.equal(f.cell(notes).querySelector('input'),null);const focusEvents:string[]=[];f.doc.addEventListener('focusin',event=>{const element=event.target as HTMLElement;focusEvents.push(element.closest<HTMLElement>('[data-property]')?.dataset.property??element.tagName);});release();await until(()=>f.cell(score).textContent==='7'&&!f.session.hasPendingChanges());await tick();assert.equal(f.doc.activeElement,f.cell(notes),JSON.stringify({focusEvents,active:(f.doc.activeElement as HTMLElement)?.outerHTML.slice(0,100),value:f.cell(score).textContent,errors:f.errors.map(error=>String(error))}));assert.equal(f.cell(notes).querySelector('input'),null);assert.equal(f.cell(score).textContent,'7');assert.match(await f.adapter.read('One.md'),/Exact body\.\n$/);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('managed session replays exactly one destination edit after outside pointer save acknowledgement',async()=>{
 const f=await fixture();try{const release=f.hold();f.edit(score,'8');f.pointer(f.cell(notes));await until(()=>f.requests.some(request=>request.op==='set_entry'));assert.equal(f.cell(notes).querySelector('input'),null);release();await until(()=>!!f.cell(notes).querySelector('input'));assert.equal(f.doc.activeElement,f.cell(notes).querySelector('input'));assert.equal(f.requests.filter(request=>request.op==='set_entry').length,1);assert.equal(f.cell(notes).querySelector<HTMLInputElement>('input')!.value,'Original');assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('failed managed outside save retains its draft and never replays the destination',async()=>{
 const f=await fixture();try{const release=f.hold();f.fail();const input=f.edit(score,'9');f.pointer(f.cell(notes));await until(()=>f.requests.some(request=>request.op==='set_entry'));release();await until(()=>input.getAttribute('aria-invalid')==='true');assert.equal(input.value,'9');assert.equal(f.cell(score).dataset.baseEditing,'draft');assert.equal(f.cell(notes).querySelector('input'),null);assert.match(await f.adapter.read('One.md'),/Score: 1/);assert.ok(f.errors.length>0);assert.ok(f.errors.every(error=>error instanceof Error&&error.message==='Property save rejected'));}finally{await f.close();}
});
test('trailing Add property saves schema and appends only to the captured view',async()=>{
 const f=await fixture();try{f.host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')!.click();const name=f.doc.querySelector<HTMLInputElement>('[aria-label="Type property name…"]')!;assert.equal(f.doc.activeElement,name);name.value='Summary';name.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.key(name,'Enter');await until(async()=>(await f.saved()).views[0].order?.includes(`note.${added}`)??false);const saved=await f.saved();assert.deepEqual(saved.views[0].order,['file.name',`note.${score}`,`note.${notes}`,`note.${added}`]);assert.deepEqual(saved.views[1].order,['file.name',`note.${notes}`]);assert.ok(f.host.querySelector(`[role="columnheader"][data-property="note.${added}"]`));assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('pending property creation cannot retarget visibility after an external saved view reorder',async()=>{
 const f=await fixture();try{const release=f.hold();f.host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')!.click();const name=f.doc.querySelector<HTMLInputElement>('[aria-label="Type property name…"]')!;name.value='Summary';f.key(name,'Enter');await until(()=>f.requests.some(request=>request.op==='update'));await assert.rejects(f.session.selectView(1),/Finish or cancel/);const before=await f.saved();await f.adapter.write('Work.base',JSON.stringify({views:[before.views[1],before.views[0]]}));await f.vault.reload();await f.session.refresh();release();await until(()=>!f.doc.querySelector('.collection-property-picker'));const saved=await f.saved();assert.equal(saved.views[0].id,'bbbbbbbbbbbb');assert.deepEqual(saved.views[0].order,['file.name',`note.${notes}`]);assert.deepEqual(saved.views[1].order,['file.name',`note.${score}`,`note.${notes}`]);assert.equal(f.requests.filter(request=>request.op==='update').length,1);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('Settings uses the collection label and its Edit properties command mounts the actual collection editor',async()=>{
 const f=await fixture();try{f.host.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click();const settings=f.doc.querySelector<HTMLElement>('[data-panel="View settings"]')!;assert.equal(settings.querySelector('[data-setting="source"] .bases-settings-row-value')?.textContent,'Tasks');settings.querySelector<HTMLButtonElement>('[data-setting="edit-properties"]')!.click();await until(()=>!!f.doc.querySelector('.collection-property-editor'));assert.equal(f.doc.querySelector('[data-panel="View settings"]'),null);assert.equal(f.doc.querySelector<HTMLInputElement>('[aria-label="Collection name"]')?.value,'Tasks');assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
