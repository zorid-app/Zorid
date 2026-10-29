import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse,stringify} from 'yaml';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {BaseController} from '../src/bases/controller.ts';
import {createBaseTableView} from '../src/bases/table-view.ts';
import type {BaseQueryResult} from '../src/bases/query.ts';
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
async function fixture(datatype:'number'|'checkbox'='number'){
 const existingGroup=false,retainedCommands=new Map<string,string>(),holds=new Map<string,number>(),claims=new Set<string>(),claimHistory:string[]=[],receipts=new Map<string,ReturnType<typeof structuredClone>>(),derivedAfterRetirement:string[]=[];let retired=false,loseReply=false;
 const inactive=()=>Object.assign(new Error('This vault session is no longer active. Reopen the vault before making another change.'),{code:'client_not_admitted',source:'host',commitUncertain:false});
 const checkDerived=(operation:string)=>{if(retired){derivedAfterRetirement.push(operation);throw inactive();}};
 const initialViews=[{id:'aaaaaaaaaaaa',type:'table',name:'Primary',...(existingGroup?{groupBy:{property:`note.${score}`,direction:'DESC'}}:{}),source:{kind:'collection',id:collectionId},order:['file.name',`note.${score}`,`note.${notes}`]},{id:'bbbbbbbbbbbb',type:'table',name:'Secondary',source:{kind:'collection',id:collectionId},order:['file.name',`note.${notes}`]}];
 const adapter=new Adapter({'Work.base':JSON.stringify({views:initialViews}),'One.md':`---\nScore: ${datatype==='checkbox'?'false':'1'}\nNotes: Original\n---\nExact body.\n`});
 let collection:DatabaseCollection={id:collectionId,name:'Tasks',revision:'schema-r1',deleted:false,properties:[{id:score,name:'Score',datatype,options:[]},{id:notes,name:'Notes',datatype:'text',options:[]}]};
 let member:DatabaseEntry={entryId:'One.md',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{[score]:datatype==='checkbox'?false:1,[notes]:'Original'},deleted:false,pendingProjection:false};
 const requests:DatabaseRequest[]=[],errors:unknown[]=[],buffers=new Map<string,NoteBuffer>();let hold:ReturnType<typeof deferred>|undefined,fail=false;
 const response=()=>structuredClone({collections:[collection],entries:[member],projection:{pending:0,issues:[]}});
 adapter.databases={async request(command){requests.push(structuredClone(command));if(command.op==='get'||command.op==='list'){checkDerived(command.op);return response();}
  if(command.op==='set_entry'){const encoded=JSON.stringify(command),prior=retainedCommands.get(command.operationId);if(retired&&prior!==encoded)throw inactive();if(prior&&prior!==encoded)throw new Error('Captured command changed');retainedCommands.set(command.operationId,encoded);if(receipts.has(command.operationId))return structuredClone(receipts.get(command.operationId));assert.equal(command.expectedRevision,member.revision);assert.equal(command.expectedCollectionRevision,collection.revision);await hold?.promise;if(retired&&!claims.has(command.operationId)||fail)throw inactive();const values={...member.values,...command.values};const frontmatter=Object.fromEntries(collection.properties.filter(field=>Object.hasOwn(values,field.id)).map(field=>[field.name,values[field.id]]));await adapter.write('One.md',`---\n${stringify(frontmatter)}---\nExact body.\n`);member={...member,values,revision:'member-r2',fileRevision:(await adapter.stat('One.md'))!.revision};const receipt=response();receipts.set(command.operationId,receipt);if(loseReply){loseReply=false;throw inactive();}return receipt;}
  if(command.op==='update'){assert.equal(command.expectedRevision,collection.revision);await hold?.promise;collection={...collection,name:command.name,revision:'schema-r2',properties:command.properties.map(field=>({...field,id:field.id??added,options:(field.options??[]).map((option,index)=>({...option,id:option.id??`option${String(index).padStart(6,'0')}`}))}))};return response();}
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
 const semantics=adapter.documentSemantics!,open=semantics.open,status=semantics.status;
 Object.assign(semantics,{status:async(...args:any[])=>{checkDerived('status');return(status as any)(...args);},open:async(...args:any[])=>{checkDerived('open');const pin=await(open as any)(...args);return{...pin,metadata:async(...input:any[])=>{checkDerived('metadata');return pin.metadata(...input);},base:async(...input:any[])=>{checkDerived('base');return pin.base(...input);}};}});
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
 const session=createBaseSession(host,{vault,basePath:'Work.base',canRecoverDatabaseEntry(request:DatabaseRequest){return request.op==='set_entry'&&!!holds.get(request.operationId)&&retainedCommands.get(request.operationId)===JSON.stringify(request);},holdRecoverDatabaseEntry(request:DatabaseRequest&{op:'set_entry'}){holds.set(request.operationId,(holds.get(request.operationId)??0)+1);let released=false;return()=>{if(!released){released=true;holds.set(request.operationId,holds.get(request.operationId)!-1);}};},claimRecoverDatabaseEntry(request:DatabaseRequest&{op:'set_entry'}){assert.equal(retainedCommands.get(request.operationId),JSON.stringify(request));claims.add(request.operationId);claimHistory.push(request.operationId);return()=>{claims.delete(request.operationId);};},validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);await until(()=>!!host.querySelector(`[role="gridcell"][data-property="note.${score}"]`));
 const cell=(property:string)=>host.querySelector<HTMLElement>(`[role="gridcell"][data-property="note.${property}"]`)!;
 const key=(element:Element,key:string)=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});element.dispatchEvent(event);return event;};
 const edit=(property:string,value:string)=>{cell(property).click();const input=cell(property).querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value=value;return input;};
 const pointer=(element:Element)=>{element.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));(element as HTMLElement).click();};
 return{adapter,vault,dom,doc,host,session,requests,errors,cell,key,edit,pointer,derivedAfterRetirement,claimHistory,loseReply(){loseReply=true;},retire(){retired=true;},restoreForCleanup(){retired=false;fail=false;},hold(){hold=deferred();return()=>{hold?.resolve();hold=undefined;};},fail(value=true){fail=value;},async saved(){return BaseDocument.parse(await adapter.read('Work.base'));},async close(){hold?.resolve();hold=undefined;fail=false;for(const input of doc.querySelectorAll('[data-base-editing] input,.bases-property-popover input'))key(input,'Escape');doc.querySelector<HTMLButtonElement>('.collection-property-picker-cancel')?.click();[...doc.querySelectorAll<HTMLButtonElement>('.collection-property-editor button')].find(button=>button.textContent==='Cancel')?.click();for(const button of doc.querySelectorAll<HTMLButtonElement>('[aria-label="Close"]'))button.click();await until(()=>!session.hasPendingChanges(),JSON.stringify({pending:host.innerText,portals:[...doc.querySelectorAll('.bases-toolbar-popover,.bases-property-popover')].map(e=>e.textContent),errors:errors.map(String)}));await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}


test('an unsubmitted raw property survives fresh session recovery without authoring until explicit submit',async()=>{
 const old=await fixture(),fresh=await fixture();try{
  const input=old.edit(score,'9.');input.focus();input.setSelectionRange(0,1,'backward');
  assert.equal(old.session.canRecoverAdmission!(),true,'raw input needs a separate non-authoring recovery capsule');
  const capsule=old.session.prepareAdmissionRecovery!();assert.equal(capsule.rawDrafts?.length,1);await capsule.settle();
  input.dispatchEvent(new old.dom.window.Event('blur'));old.key(input,'Enter');
  assert.equal(old.requests.filter(request=>request.op==='set_entry').length,0);assert.deepEqual(old.claimHistory,[]);
  const result=await fresh.session.restoreAdmissionDrafts!(capsule.rawDrafts!);assert.equal(result.restored.length,1);assert.equal(result.pending.length,0);assert.equal(result.conflicts.length,0);
  const restored=fresh.cell(score).querySelector<HTMLInputElement>('input')!;assert.ok(restored);assert.equal(restored.value,'9.');assert.equal(restored.selectionStart,0);assert.equal(restored.selectionEnd,1);assert.equal(restored.selectionDirection,'backward');assert.equal(fresh.doc.activeElement,restored);
  assert.equal(fresh.requests.filter(request=>request.op==='set_entry').length,0);assert.match(await fresh.adapter.read('One.md'),/Score: 1/);
  input.dispatchEvent(new old.dom.window.Event('blur'));old.key(input,'Enter');assert.equal(old.requests.filter(request=>request.op==='set_entry').length,0,'retired raw callbacks cannot write');
  restored.value='9';restored.dispatchEvent(new fresh.dom.window.Event('input',{bubbles:true}));fresh.key(restored,'Enter');await until(()=>fresh.requests.some(request=>request.op==='set_entry'));
  await until(()=>!fresh.session.hasPendingChanges());assert.equal(fresh.requests.filter(request=>request.op==='set_entry').length,1);assert.match(await fresh.adapter.read('One.md'),/Score: 9/);assert.deepEqual(fresh.errors,[]);
 }finally{old.restoreForCleanup();fresh.restoreForCleanup();await old.close();await fresh.close();}
});

test('raw Base titles restore with fresh witnesses and never rename on freeze or stale blur',async()=>{
 const oldDom=new JSDOM('<main></main>',{pretendToBeVisual:true}),newDom=new JSDOM('<main></main>',{pretendToBeVisual:true});
 const row={entryId:'note-id',path:'One.md',revision:'old-r1',values:{'file.name':{type:'string' as const,value:'One'}}};
 const result={version:1,view:{id:'view-id',type:'table',name:'Table'},rows:[row],groups:[{key:null,rows:[row]}],properties:['file.name'],groupOptions:[],availableProperties:['file.name'],diagnostics:[],scanned:1,matched:1} as unknown as BaseQueryResult;
 const oldCalls:unknown[]=[],freshCalls:unknown[]=[],old=createBaseTableView(oldDom.window.document.querySelector('main')!,{result,openFile(){},async renameFile(command){oldCalls.push(command);}}),freshRow={...row,revision:'fresh-r2'},fresh=createBaseTableView(newDom.window.document.querySelector('main')!,{result:{...result,version:22,rows:[freshRow],groups:[{key:null,rows:[freshRow]}]},openFile(){},async renameFile(command){freshCalls.push(command);}});
 try{
  assert.equal(old.editFileTitle('One.md','note-id'),true);const input=oldDom.window.document.querySelector<HTMLInputElement>('.zorid-bases-table-input')!;input.value='Raw name';input.setSelectionRange(1,5,'backward');const draft=old.captureRawDraft()!;assert.ok(draft);await draft.ready;input.dispatchEvent(new oldDom.window.Event('blur'));input.dispatchEvent(new oldDom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.deepEqual(oldCalls,[]);
  assert.equal(fresh.restoreRawDraft(draft),'restored');const restored=newDom.window.document.querySelector<HTMLInputElement>('.zorid-bases-table-input')!;assert.equal(restored.value,'Raw name');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,5);assert.equal(restored.selectionDirection,'backward');assert.deepEqual(freshCalls,[]);
  restored.dispatchEvent(new newDom.window.Event('blur'));await Promise.resolve();assert.deepEqual(freshCalls,[],'reconstruction blur cannot author the inherited raw draft');
  restored.dispatchEvent(new newDom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await until(()=>freshCalls.length===1);assert.deepEqual(freshCalls,[{version:22,path:'One.md',name:'Raw name',witness:{entryId:'note-id',revision:'fresh-r2'}}]);assert.deepEqual(oldCalls,[]);
 }finally{old.destroy();fresh.destroy();oldDom.window.close();newDom.window.close();}
});

for(const change of ['value','schema','actor'] as const)test(`a changed ${change} retains the exact raw candidate and never restores it into a different baseline`,async()=>{
 const old=await fixture(),fresh=await fixture(change==='schema'?'checkbox':'number');try{
  const input=old.edit(score,'9.');const capsule=old.session.prepareAdmissionRecovery!();await capsule.settle();
  if(change==='value'){await fresh.adapter.write('One.md','---\nScore: 2\nNotes: Original\n---\nExact body.\n');await fresh.vault.reload();await fresh.session.refresh();}
  if(change==='actor'){const identify=fresh.adapter.identify.bind(fresh.adapter);fresh.adapter.identify=(entry)=>({...identify(entry),...(entry.path==='One.md'?{entryId:'replacement-note-id'}:{})});await fresh.vault.reload();await fresh.session.refresh();}
  const result=await fresh.session.restoreAdmissionDrafts!(capsule.rawDrafts!);assert.equal(result.restored.length,0);assert.equal(result.pending.length,0);assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft,capsule.rawDrafts![0]);assert.equal(result.conflicts[0].draft.kind,'property');if(result.conflicts[0].draft.kind==='property')assert.equal(result.conflicts[0].draft.raw.state.input,'9.');assert.equal(fresh.cell(score).querySelector('input[type="text"]'),null);assert.equal(input.value,'9.');assert.equal(old.requests.filter(request=>request.op==='set_entry').length,0);assert.equal(fresh.requests.filter(request=>request.op==='set_entry').length,0);
 }finally{old.restoreForCleanup();fresh.restoreForCleanup();await old.close();await fresh.close();}
});

test('a composing Base title retains its final raw input before old editor teardown',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),row={entryId:'note-id',path:'One.md',revision:'r1',values:{'file.name':{type:'string' as const,value:'One'}}};
 const result={version:1,view:{type:'table',name:'Table'},rows:[row],groups:[{key:null,rows:[row]}],properties:['file.name'],availableProperties:[],groupOptions:[],diagnostics:[],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1}} as BaseQueryResult;
 const commands:unknown[]=[],table=createBaseTableView(dom.window.document.querySelector('main')!,{result,openFile(){},async renameFile(command){commands.push(command);}});
 try{
  table.editFileTitle('One.md','note-id');const input=dom.window.document.querySelector<HTMLInputElement>('.zorid-bases-table-input')!;input.dispatchEvent(new dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='未';const draft=table.captureRawDraft()!;let ready=false;void draft.ready.then(()=>{ready=true;});await Promise.resolve();assert.equal(ready,false);assert.equal(input.readOnly,false,'the OS composition still owns its original control');input.dispatchEvent(new dom.window.Event('blur'));assert.deepEqual(commands,[]);
  input.dispatchEvent(new dom.window.CompositionEvent('compositionend',{bubbles:true}));input.value='未確定';input.dispatchEvent(new dom.window.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'定'}));await draft.ready;assert.equal(draft.state.value,'未確定');assert.equal(input.readOnly,true);assert.deepEqual(commands,[]);
 }finally{table.destroy();dom.window.close();}
});
