import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentTasksRead,DocumentTransport} from '../src/core/document-semantics.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead} from '../src/core/durable-writes.ts';
import {createTaskPreset} from '../src/tasks/presets.ts';
import type {TasksHost} from '../src/tasks/controller.ts';
import {readProperties} from '../src/core/properties.ts';
registerHooks({load(url,context,next){if(url.endsWith('.css'))return{format:'module',source:'export {};',shortCircuit:true};return next(url,context);}});
const preset=createTaskPreset({type:'task-type',status:'status-prop',planned:'planned-prop',deadline:'deadline-prop',todo:'todo',working:'working',done:'done'});
const notePath='Tasks/Example.md',typePath='Types/Task.yaml';
const original='---\n# Preserve this YAML comment\ntype: task-type\nstatus: todo\nplanned: 2026-10-17\n---\n# Example\n\nBody and - [ ] ordinary checkbox.\n';
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(){
  const ids=new Map<string,string>(),revisions=new Map<string,number>(),checkpoints=new Map<string,any>(),intents=new Map<string,DurableWriteIntent>();let cpSequence=0,reads=0,plans=0,commits=0;
  const inputs=new Map<string,DurableWriteInput>(),creates:{path:string;source:string}[]=[];let createFault:((path:string,source:string)=>Promise<void>)|undefined;
  const scope={vaultId:'task-fixture-authority',clientId:'task-fixture-window'};
  class Adapter extends MemoryAdapter{
    durableWrites!:DurableWrites;
    decorate(entry:any){if(!entry)return null;if(!ids.has(entry.path))ids.set(entry.path,crypto.randomUUID());return{...entry,entryId:ids.get(entry.path),revision:'r'+(revisions.get(entry.path)??1),ctime:1,mtime:1};}
    async list(){return(await super.list()).map(entry=>this.decorate(entry));}
    async stat(path:string){return this.decorate(await super.stat(path));}
    async write(path:string,source:string){await super.write(path,source);revisions.set(path,(revisions.get(path)??1)+1);}
    async createText(path:string,source:string){creates.push({path,source});if(await this.stat(path))throw Object.assign(Error('create exists'),{commitUncertain:false});if(createFault)return createFault(path,source);await this.write(path,source);}
  }
  const adapter=new Adapter({[typePath]:preset.type.source,[notePath]:original,'Elsewhere.yaml':'unrelated: yaml\n','A.md':'Normal note'});
  const read=async(path:string):Promise<DurableWriteRead>=>{const entry=await adapter.stat(path);assert.ok(entry?.type==='file');return{path,entryId:entry.entryId!,revision:entry.revision!,content:await adapter.read(path),stat:{ctime:1,mtime:1,size:entry.size}};};
  const byId=async(id:string)=>{reads++;const entry=(await adapter.list()).find(entry=>entry.entryId===id);return entry?read(entry.path):null;};
  adapter.durableWrites={checkpoints:{scope,async load(key){return structuredClone(checkpoints.get(key)??null);},async compareAndSwap(change){assert.equal(checkpoints.get(change.key)?.revision??null,change.expectedRevision);const row={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(++cpSequence),deleted:change.encodedState===null,byteLength:change.encodedState?Buffer.byteLength(change.encodedState):0};checkpoints.set(change.key,row);return structuredClone(row);},async list(){return{items:[...checkpoints.values()],cursor:null,highWater:String(cpSequence)};},async changes(){return{items:[],cursor:null,highWater:String(cpSequence)};}},
    readText:read,readTextById:byId,
    async planWrite(input){plans++;const current=await read(input.path);assert.equal(current.entryId,input.expectedEntryId);assert.equal(current.revision,input.expectedRevision);assert.equal(current.content,input.expectedContent);inputs.set(input.operationId,structuredClone(input));return{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)};},
    async prepare(plan){const ref={...scope,token:plan.operationId,operationId:plan.operationId,entryId:plan.entryId};const intent={ref,state:'prepared',acknowledged:false} as const;intents.set(ref.token,intent);return structuredClone(intent);},
    async commit(ref){commits++;const input=inputs.get(ref.operationId)!;const current=await read(input.path);assert.equal(current.revision,input.expectedRevision);await adapter.write(input.path,input.content);const saved=await read(input.path);const result={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,sequence:String(commits),revision:saved.revision}} as const;intents.set(ref.token,result);return structuredClone(result);},
    async query(ref){return structuredClone(intents.get(ref.token)??null);},async listUnacknowledged(){return[];},async acknowledge(ref){const intent=intents.get(ref.token)!;intents.set(ref.token,{...intent,acknowledged:true} as DurableWriteIntent);},
  };
  const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}},source={localStoreId:'store',watermark:'1'};
  const witness=(path:string)=>({entryId:ids.get(path)!,revision:'r'+(revisions.get(path)??1)});
  const data=():DocumentTasksRead=>({definitions:[{id:witness(typePath).entryId,revision:witness(typePath).revision,path:typePath,kind:'file',deleted:false}],types:[{witness:witness(typePath),typeId:'task-type',label:'Task',status:{id:'status-prop',key:'status',label:'Status',datatype:'status',default:'todo',options:[{id:'todo',label:'To do',category:'not_started'},{id:'working',label:'In progress',category:'working'},{id:'done',label:'Done',category:'done'}]},plannedDay:null,deadline:null,captureDefaults:[['type','task-type'],['status','todo']]}],result:{snapshotId:snapshot,typeWitnesses:[witness(typePath)],coverageComplete:true,rows:[],groups:[],matched:0,truncated:false,diagnostics:[],typeDiagnostics:[],metadataIssues:[]}});
  const documents=createDocumentService({status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),open:async()=>({pinId:crypto.randomUUID(),source,snapshot,coverageComplete:true}),closePin:async()=>{},tasks:async()=>({snapshot,source,coverageComplete:true,value:data()})} as unknown as DocumentTransport);
  return{adapter,documents,witness,creates,read,createFault(fn:typeof createFault){createFault=fn;},get reads(){return reads;},get plans(){return plans;},get commits(){return commits;}};
}
async function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,DOMParser:dom.window.DOMParser,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.Range.prototype.getBoundingClientRect=()=>({x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0,toJSON(){return{};}});dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  dom.window.matchMedia=matchMedia as any;const f=fixture(),root=document.querySelector<HTMLElement>('#app')!,workspace=new Workspace(root);
  t.after(async()=>{try{for(const pane of [...workspace.panes,...(workspace as any).cachedViews.values()])if(pane.tasksView){pane.tasksView.controller.state.capture.title='';pane.tasksView.controller.state.drafts.clear();pane.tasksView.controller.state.unconfirmedCapture=null;}await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter:f.adapter,documentSemantics:f.documents,id:'test:tasks-host',label:'Test'});
  const host=(workspace as any).createTasksHost(f.documents,()=>workspace.activePane,()=>{}) as TasksHost;
  return{workspace,root,dom,f,host};
}

test('Tasks host inventory uses saved Types subtree IDs and rejects129 instead of truncating',async t=>{
  const{workspace,f,host}=await setup(t);assert.deepEqual(host.typeDefinitionIds(),[f.witness(typePath).entryId]);
  for(let i=0;i<128;i++)workspace.vault.entries.set('Types/Extra'+i+'.yaml',{path:'Types/Extra'+i+'.yaml',type:'file',entryId:'id'+i,revision:'r1',size:1,mtime:1});
  assert.throws(()=>host.typeDefinitionIds(),/128/);
});
test('capture validates raw destination before mutation and persists normal Markdown defaults without changing checkboxes',async t=>{
  const{f,host}=await setup(t),input={captureId:crypto.randomUUID(),title:'Captured',destination:'Tasks',typeWitness:f.witness(typePath),properties:{type:'task-type',status:'todo'}};
  for(const destination of ['a//b','../outside','/outside','a\\b','.zorid/private'])await assert.rejects(host.createTask({...input,captureId:crypto.randomUUID(),destination}),{commitUncertain:false});assert.equal(f.creates.length,0);
  await host.createTask(input);assert.equal(f.creates.length,1);assert.equal(f.creates[0].path,'Tasks/Captured.md');const source=await f.adapter.read('Tasks/Captured.md');assert.equal(readProperties(source).find(p=>p.key==='type')!.value,'task-type');assert.match(source,/# Captured/);assert.equal(await f.adapter.read(notePath),original);
});
test('uncertain ordinary create retains one fixed capture path and never sends a second create',async t=>{
  const{f,host}=await setup(t);f.createFault(async(path,source)=>{await f.adapter.write(path,source);throw Object.assign(Error('lost reply'),{commitUncertain:true});});
  const input={captureId:crypto.randomUUID(),title:'Unconfirmed',destination:'Tasks',typeWitness:f.witness(typePath),properties:{type:'task-type',status:'todo'}};
  await assert.rejects(host.createTask(input),{commitUncertain:true});await assert.rejects(host.createTask(input),/new create has not been sent/);assert.equal(f.creates.length,1);assert.match(await f.adapter.read('Tasks/Unconfirmed.md'),/# Unconfirmed/);
});
test('task edits use real NoteBuffer durable protocol and preserve body/YAML comments while changing mapped fields',async t=>{
  const{f,host}=await setup(t);await host.editTask({witness:f.witness(notePath),typeWitness:f.witness(typePath),expectedTypeId:'task-type',properties:{status:'working',planned:null}});
  const source=await f.adapter.read(notePath);assert.match(source,/# Preserve this YAML comment/);assert.equal(source.split('---\n').at(-1),original.split('---\n').at(-1));assert.equal(readProperties(source).find(p=>p.key==='status')!.value,'working');assert.equal(readProperties(source).some(p=>p.key==='planned'),false);assert.equal(f.plans,1);assert.equal(f.commits,1);
});
test('dirty/error buffer refusal happens before any native read; stale note and Type witnesses do not overwrite source',async t=>{
  const{workspace,f,host}=await setup(t),witness=f.witness(notePath),typeWitness=f.witness(typePath),input={witness,typeWitness,expectedTypeId:'task-type',properties:{status:'working'}};
  const buffer=await(workspace as any).bufferFor(notePath);buffer.update(buffer.text+'Dirty body');const reads=f.reads;
  await assert.rejects(host.editTask(input),/unsaved or failed/);assert.equal(f.reads,reads);await buffer.flush();
  await assert.rejects(host.editTask(input),/changed/);assert.match(await f.adapter.read(notePath),/Dirty body/);
  const fresh={...input,witness:f.witness(notePath)};await f.adapter.write(typePath,preset.type.source+'\n# Changed Type\n');await workspace.vault.reload();await assert.rejects(host.editTask(fresh),/changed/);assert.equal(readProperties(await f.adapter.read(notePath)).find(p=>p.key==='status')!.value,'todo');
});
test('semantic Type mismatch is rejected even with a current saved note witness',async t=>{
  const{f,host}=await setup(t);await assert.rejects(host.editTask({witness:f.witness(notePath),typeWitness:f.witness(typePath),expectedTypeId:'other-type',properties:{status:'working'}}),/different Type/);assert.equal(f.plans,0);assert.equal(await f.adapter.read(notePath),original);
});
test('preset never clobbers existing config; partial creation preserves first file and reports failure',async t=>{
  const{f,host}=await setup(t);await assert.rejects(host.installPreset(preset),/already exist/);assert.equal(await f.adapter.read(typePath),preset.type.source);assert.equal(f.creates.length,0);
  const alternate=createTaskPreset({type:'alternate',status:'a-status',planned:'a-plan',deadline:'a-due',todo:'a-todo',working:'a-work',done:'a-done'},{type:'Types/Alternate.yaml',base:'Bases/Alternate.base',destination:'OtherTasks'});
  f.createFault(async(path,source)=>{if(path.endsWith('.base'))throw Object.assign(Error('disk failed'),{commitUncertain:false});await f.adapter.write(path,source);});
  await assert.rejects(host.installPreset(alternate),/partly created/);assert.equal(await f.adapter.read('Types/Alternate.yaml'),alternate.type.source);assert.equal(await f.adapter.read(typePath),preset.type.source);
});
test('Tasks drafts park and split with live ownership, reject close/release, and non-note status hides note counts',async t=>{
  const{workspace,root,dom}=await setup(t);await(workspace as any).openTasks();const pane=workspace.activePane,view=pane.tasksView!;assert.ok(view);assert.equal(root.querySelector('.status-bar')!.textContent,'');
  const input=root.querySelector<HTMLInputElement>('.tasks-capture input')!;input.value='Retained draft';input.dispatchEvent(new dom.window.Event('input'));
  await workspace.openNote('A.md',true);assert.equal(pane.tasksView,undefined);const taskTab=pane.tabs.find(tab=>tab.kind==='tasks')!;await(workspace as any).selectTab(pane,taskTab);assert.equal(pane.tasksView,view);assert.equal(root.querySelector<HTMLInputElement>('.tasks-capture input')!.value,'Retained draft');
  await assert.rejects((workspace as any).closeTab(pane,taskTab),/unsaved or unconfirmed/);assert.equal(pane.runtime!.phase,'active');assert.equal(view.controller.phase,'active');assert.equal(root.querySelector<HTMLInputElement>('.tasks-capture input')!.disabled,false);await assert.rejects(workspace.flush(),/unsaved or unconfirmed/);
  view.controller.state.capture.title='';await(workspace as any).split('right',pane,taskTab);const moved=workspace.activePane;assert.ok(moved.tasksView);assert.equal(workspace.panes.length,2);await(workspace as any).closeTab(moved,moved.tabs[0]);assert.equal(workspace.panes.length,1);await tick();
});
test('global Tasks preflight failure rolls back prepared siblings before any view is disposed',async t=>{
  const{workspace,root}=await setup(t);await(workspace as any).openTasks();const first=workspace.activePane.tasksView!;await(workspace as any).split('right');const second=workspace.activePane.tasksView!;
  const prepare=second.prepareClose;second.prepareClose=async()=>{throw Error('retained pin close failed');};await assert.rejects(workspace.destroy(),/retained pin close failed/);assert.equal(first.controller.phase,'active');assert.equal(second.controller.phase,'active');assert.equal(root.querySelectorAll('.tasks-view').length,2);assert.equal(first.hasPendingChanges(),false);assert.ok([...root.querySelectorAll<HTMLButtonElement>('.tasks-view button')].some(button=>!button.disabled));second.prepareClose=prepare;
});
test('capture queued refresh rechecks original Type revision immediately before ordinary durable create',async t=>{
  const{workspace,f,host}=await setup(t);const witness=f.witness(typePath);let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve),list=f.adapter.list.bind(f.adapter),create=workspace.vault.create.bind(workspace.vault);let hold=false;
  f.adapter.list=async()=>{if(hold){hold=false;started();await gate;}return list();};workspace.vault.create=(path,source,validate)=>{hold=true;return create(path,source,validate);};
  const saving=host.createTask({captureId:crypto.randomUUID(),title:'Queued',destination:'Tasks',typeWitness:witness,properties:{type:'task-type',status:'todo'}});await ready;
  await f.adapter.write(typePath,preset.type.source+'\n# Changed during queued refresh\n');release();await assert.rejects(saving,/Type definition changed/);assert.equal(f.creates.length,0);assert.equal(await f.adapter.stat('Tasks/Queued.md'),null);
});
test('releasePlatform preflights all Tasks views and restores prepared siblings on failure',async t=>{
  const{workspace,root}=await setup(t);let releases=0;workspace.platform.release=async()=>{releases++;};await(workspace as any).openTasks();const first=workspace.activePane.tasksView!;await(workspace as any).split('right');const second=workspace.activePane.tasksView!,prepare=second.prepareClose;second.prepareClose=async()=>{throw Error('pin close still pending');};
  await assert.rejects((workspace as any).releasePlatform(),/pin close still pending/);assert.equal(releases,0);assert.equal(first.controller.phase,'active');assert.equal(second.controller.phase,'active');assert.equal(root.querySelectorAll('.tasks-view').length,2);second.prepareClose=prepare;
});
test('held global preparation fences new Tasks topology and restores commands on failure',async t=>{
  const{workspace,root}=await setup(t);workspace.platform.release=async()=>{};await(workspace as any).openTasks();const pane=workspace.activePane,view=pane.tasksView!,task=pane.tabs.find(tab=>tab.kind==='tasks')!,note=pane.tabs.find(tab=>tab.kind==='note')!;
  let entered!:()=>void,resume!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>resume=resolve),prepare=view.prepareClose;
  view.prepareClose=async()=>{entered();await gate;throw Error('held pin close failed');};const retiring=(workspace as any).releasePlatform();await ready;assert.equal(root.inert,true);
  await(workspace as any).openTasks();await(workspace as any).split('right');await(workspace as any).selectTab(pane,note);await(workspace as any).closeTab(pane,task);(workspace as any).executeHotkey('new-tab');
  assert.equal(workspace.panes.length,1);assert.equal(pane.tabs.length,2);assert.equal(pane.active,task.id);resume();await assert.rejects(retiring,/held pin close failed/);assert.notEqual(root.inert,true);assert.equal(view.controller.phase,'active');view.prepareClose=prepare;
  await(workspace as any).selectTab(pane,note);assert.equal(pane.active,note.id);
});

test('normal Tasks body open, durable editor save and split retain original identity without self-await',async t=>{
  const{workspace,f}=await setup(t);await(workspace as any).openTasks();const pane=workspace.activePane,view=pane.tasksView!;
  const originalWitness=f.witness(notePath),calls:Parameters<Workspace['openNote']>[]=[];
  const openNote=workspace.openNote.bind(workspace);workspace.openNote=(...args)=>{calls.push(args);return openNote(...args);};
  await Promise.race([view.controller.open({witness:f.witness(notePath),path:notePath,title:'Example',typeId:'task-type',statusId:'todo',statusLabel:'To do',category:'not_started',statusDefaulted:false,plannedDay:null,deadline:null}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Tasks Open body deadlocked')),1000).unref())]);
  const until=Date.now()+1000;while((pane.tabs.find(tab=>tab.id===pane.active)?.path!==notePath||!pane.viewReady)&&Date.now()<until)await tick();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,5),[notePath,true,pane,true,'']);assert.equal(typeof calls[0][5],'number');assert.equal(typeof calls[0][6],'function');assert.equal(calls[0][7],originalWitness.entryId);
  assert.equal(pane.tabs.find(tab=>tab.id===pane.active)?.expectedEntryId,originalWitness.entryId);assert.equal((workspace as any).buffers.get(notePath)?.savedDurableWitness?.entryId,originalWitness.entryId);
  assert.equal(pane.tabs.find(tab=>tab.id===pane.active)?.path,notePath);assert.equal(pane.viewReady,true);assert.equal(view.controller.state.busy,false);assert.equal(pane.tasksView,undefined);assert.equal((workspace as any).cachedViews.get(pane.tabs.find(tab=>tab.kind==='tasks'))?.tasksView,view);
  const editorDOM=pane.element.querySelector<HTMLElement>('.cm-editor');assert.ok(editorDOM);
  const editor=EditorView.findFromDOM(editorDOM);assert.ok(editor);
  const savedBody=original+'\nDurable body before split\n';
  editor.dispatch({changes:{from:editor.state.doc.length,insert:'\nDurable body before split\n'}});
  await workspace.flush();
  assert.equal(await f.adapter.read(notePath),savedBody);assert.equal(f.commits,1);
  assert.equal(workspace.vault.entries.get(notePath)?.entryId,originalWitness.entryId);
  assert.equal(workspace.vault.entries.get(notePath)?.revision,f.witness(notePath).revision);
  await(workspace as any).split('right');const split=workspace.activePane;
  assert.notEqual(split,pane);assert.equal(split.viewReady,true);assert.equal(split.editor?.getValue(),savedBody);
  assert.equal(split.tabs.find(tab=>tab.id===split.active)?.expectedEntryId,originalWitness.entryId);
  assert.equal(workspace.buffers.get(notePath)?.savedDurableWitness?.entryId,originalWitness.entryId);
  assert.equal(workspace.vault.entries.get(notePath)?.entryId,originalWitness.entryId);
});
