import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {EditorOptions,EditorHandle} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead} from '../src/core/durable-writes.ts';
import type {PlatformVault} from '../src/platform/index.ts';

async function setup(t:TestContext,files:Record<string,string>,features:Partial<PlatformVault>={},bridge?:unknown,providedAdapter?:MemoryAdapter){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>(),frames=new Map<number,FrameRequestCallback>(),idle=new Map<number,IdleRequestCallback>();let sequence=0;
  dom.window.requestAnimationFrame=callback=>{const id=++sequence;frames.set(id,callback);return id;};
  dom.window.cancelAnimationFrame=id=>{frames.delete(id);};
  dom.window.requestIdleCallback=callback=>{const id=++sequence;idle.set(id,callback);return id;};
  dom.window.cancelIdleCallback=id=>{idle.delete(id);};
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame,cancelAnimationFrame:dom.window.cancelAnimationFrame,matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  if(bridge)Object.assign(dom.window,{zorid:bridge});
  const factory=(parent:HTMLElement,options:EditorOptions):EditorHandle=>{
    const body=document.createElement('textarea');body.setAttribute('aria-label','Note body');body.value=options.value;parent.append(body);
    body.addEventListener('input',()=>{options.validateChange?.(body.value);options.onChange(body.value);});
    return{getValue:()=>body.value,setValue:value=>{body.value=value;},focus:()=>body.focus(),insert:value=>{body.value+=value;options.onChange(body.value);},destroy:()=>body.remove()};
  };
  const root=document.querySelector<HTMLElement>('#app')!,workspace=new Workspace(root,factory),adapter=providedAdapter??new MemoryAdapter(files);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:load-cancellation',label:'Test',...features});
  return{dom,workspace,root,frames,idle,adapter,
    frame(){const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(0);},
    idleTurn(){assert.ok(idle.size,'expected one idle count slice');const[id,callback]=idle.entries().next().value!;idle.delete(id);callback({didTimeout:false,timeRemaining:()=>8});},
    drain(){for(let turns=0;idle.size&&turns<256;turns++){const[id,callback]=idle.entries().next().value!;idle.delete(id);callback({didTimeout:false,timeRemaining:()=>8});}assert.equal(idle.size,0);},
    type(value:string){const body=root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note body"]')!;assert.ok(body);body.value=value;body.dispatchEvent(new dom.window.Event('input',{bubbles:true}));},
    status:()=>root.querySelector('.status-bar')!.textContent!,
  };
}


function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function promptly(pending:Promise<unknown>){let done=false;void pending.then(()=>{done=true;},()=>{done=true;});for(let i=0;i<30&&!done;i++)await turn();assert.equal(done,true,'initial-read cancellation must settle without the held provider or retry timer');await pending;}
function holdFirstRead(ui:Awaited<ReturnType<typeof setup>>){
  const held=gate(),entered=gate(),read=ui.workspace.vault.read.bind(ui.workspace.vault);let reads=0;
  ui.workspace.vault.read=async(path,validate)=>{if(path==='One.md'&&++reads===1){entered.resolve();await held.promise;}return read(path,validate);};
  return{held,entered,get reads(){return reads;}};
}

test('switching a mounted held initial read opens the next editor promptly and returning starts a fresh load',async t=>{
  const ui=await setup(t,{'One.md':'Original one','Two.md':'Second body'}),f=holdFirstRead(ui);
  const opening=ui.workspace.openNote('One.md',true);await f.entered.promise;
  try{
    await promptly(ui.workspace.openNote('Two.md',true));await promptly(opening);
    assert.equal(ui.workspace.activePane.viewReady,true);assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Second body');
    assert.equal(ui.root.querySelector('.error-message'),null);
    await promptly(ui.workspace.openNote('One.md'));
    assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Original one');assert.equal(f.reads,2);
    f.held.resolve();await turn();assert.equal(ui.root.querySelector('.error-message'),null);
  }finally{f.held.resolve();await opening;}
});

test('closing a held initial note does not wait for a provider and never caches a blank ready view',async t=>{
  const ui=await setup(t,{'One.md':'Original one'}),f=holdFirstRead(ui),opening=ui.workspace.openNote('One.md');await f.entered.promise;
  try{
    const pane=ui.workspace.activePane;await promptly((ui.workspace as any).closeTab(pane,pane.tabs.find(tab=>tab.id===pane.active)));
    await promptly(opening);assert.equal(pane.viewPath,null);assert.equal(ui.root.querySelector('.error-message'),null);
    await promptly(ui.workspace.openNote('One.md'));assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Original one');
  }finally{f.held.resolve();await opening;}
});

test('canceling a shared-buffer joiner leaves its healthy creator read intact and admitted edits still save',async t=>{
  const ui=await setup(t,{'One.md':'Original one','Two.md':'Second body'}),f=holdFirstRead(ui),creator=ui.workspace.activePane;
  const opening=ui.workspace.openNote('One.md',false,creator);await f.entered.promise;
  const joiner=(ui.workspace as any).addPane(),joining=ui.workspace.openNote('One.md',false,joiner);await turn();
  try{
    await promptly(ui.workspace.openNote('Two.md',false,joiner));await promptly(joining);assert.equal(f.reads,1);
    assert.equal(creator.viewReady,false);f.held.resolve();await opening;
    assert.equal(creator.viewReady,true);const body=creator.element.querySelector<HTMLTextAreaElement>('textarea')!;body.value='Admitted D3';body.dispatchEvent(new ui.dom.window.Event('input',{bubbles:true}));
    await ui.workspace.flush();assert.equal(await ui.adapter.read('One.md'),'Admitted D3');
  }finally{f.held.resolve();await Promise.all([opening,joining]);}
});

test('a creator abort completes empty-buffer cleanup before a valid shared-buffer joiner retries',async t=>{
  const ui=await setup(t,{'One.md':'Original one','Two.md':'Second body'}),f=holdFirstRead(ui),creator=ui.workspace.activePane;
  const opening=ui.workspace.openNote('One.md',false,creator);await f.entered.promise;
  const empty=ui.workspace.buffers.get('One.md')!,joiner=(ui.workspace as any).addPane(),joining=ui.workspace.openNote('One.md',false,joiner);await turn();
  try{
    await promptly(ui.workspace.openNote('Two.md',false,creator));await promptly(opening);await promptly(joining);
    assert.notEqual(ui.workspace.buffers.get('One.md'),empty);assert.equal(empty.hasAdmittedContent,false);assert.equal(f.reads,2);
    assert.equal(joiner.viewReady,true);assert.equal(joiner.element.querySelector<HTMLTextAreaElement>('textarea')!.value,'Original one');
    f.held.resolve();await turn();assert.equal(joiner.element.querySelectorAll('textarea').length,1);assert.equal(ui.root.querySelector('.error-message'),null);
  }finally{f.held.resolve();await Promise.all([opening,joining]);}
});

test('window close cancels an initial read before waiting on the native opening transition',async t=>{
  const ui=await setup(t,{'One.md':'Original one'}),f=holdFirstRead(ui),opening=ui.workspace.openNote('One.md');await f.entered.promise;
  // The native initial-note path is part of this same serialized transition.
  (ui.workspace as any).vaultTransition=opening;
  try{await promptly(ui.workspace.destroy());await promptly(opening);assert.equal(ui.root.childElementCount,0);}
  finally{f.held.resolve();await opening;}
});


test('switching to an existing tab cancels its predecessor read and Save alone leaves a current initial read alive',async t=>{
  const ui=await setup(t,{'One.md':'Original one','Two.md':'Second body'});await ui.workspace.openNote('Two.md');
  const pane=ui.workspace.activePane,second=pane.tabs.find(tab=>tab.id===pane.active)!,f=holdFirstRead(ui),opening=ui.workspace.openNote('One.md',true);await f.entered.promise;
  try{
    await ui.workspace.flush();await (ui.workspace as any).selectTab(pane,pane.tabs.find(tab=>tab.id===pane.active));await turn();assert.equal(f.reads,1);assert.equal(pane.viewReady,false);
    await promptly((ui.workspace as any).selectTab(pane,second));await promptly(opening);
    assert.equal(pane.editor?.getValue(),'Second body');assert.equal(ui.root.querySelector('.error-message'),null);
  }finally{f.held.resolve();await opening;}
});

test('a failed navigation flush restarts only the canceled selected initial view without an edit',async t=>{
  const ui=await setup(t,{'One.md':'Original one','Two.md':'Second body'}),f=holdFirstRead(ui),opening=ui.workspace.openNote('One.md');await f.entered.promise;
  try{
    const pane=ui.workspace.activePane;let failed=false;
    (pane as any).canvasView={flush:async()=>{if(!failed){failed=true;throw Error('Injected navigation flush failure');}},destroy(){}};
    await assert.rejects(ui.workspace.openNote('Two.md'),/Injected navigation flush failure/);await promptly(opening);
    for(let i=0;i<30&&!pane.viewReady;i++)await turn();
    assert.equal(pane.viewPath,'One.md');assert.equal(pane.viewReady,true);assert.equal(pane.editor?.getValue(),'Original one');assert.equal(f.reads,2);
    assert.equal(ui.root.querySelector('.error-message'),null);
  }finally{f.held.resolve();await opening;}
});

for(const mode of ['direct','desktop'] as const)test(`a failed ${mode} window close rearms its canceled selected initial read`,async t=>{
  let close!:()=>Promise<void>,fail=false;
  const ui=await setup(t,{'One.md':'Original one'},{},{onBeforeClose(handler:()=>Promise<void>){close=handler;return()=>{};},async dismissContextMenu(){if(fail)throw Error('Injected close cleanup failure');}}),f=holdFirstRead(ui),opening=ui.workspace.openNote('One.md');await f.entered.promise;
  try{
    fail=true;await assert.rejects(mode==='direct'?ui.workspace.destroy():close(),/Injected close cleanup failure/);fail=false;await promptly(opening);
    for(let i=0;i<30&&!ui.workspace.activePane.viewReady;i++)await turn();
    assert.equal(ui.workspace.activePane.viewReady,true);assert.equal(ui.workspace.activePane.editor?.getValue(),'Original one');assert.equal(f.reads,2);
  }finally{fail=false;f.held.resolve();await opening;}
});


function durableFixture(){
  const ids=new Map([['One.md','one'],['Two.md','two']]),revisions=new Map<string,number>(),heads=new Map<string,any>(),inputs=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>();
  let sequence=0;const scope={vaultId:'cancel-vault',clientId:'cancel-window'},commitEntered=gate(),commitHeld=gate();let holdCommit=false;
  class Adapter extends MemoryAdapter{
    durableWrites!:DurableWrites;
    identify(entry:any){return entry?{...entry,entryId:ids.get(entry.path),revision:`r${revisions.get(entry.path)??1}`}:null;}
    async list(){return(await super.list()).map(entry=>this.identify(entry));}
    async stat(path:string){return this.identify(await super.stat(path));}
    async write(path:string,text:string){await super.write(path,text);revisions.set(path,(revisions.get(path)??1)+1);}
  }
  const adapter=new Adapter({'One.md':'Original one','Two.md':'Second body'});
  const read=async(path:string):Promise<DurableWriteRead>=>{const entry=await adapter.stat(path);assert.ok(entry);return{path,entryId:entry.entryId!,revision:entry.revision!,content:await adapter.read(path),stat:{ctime:1,mtime:1,size:entry.size}};};
  adapter.durableWrites={checkpoints:{scope,async load(key){return structuredClone(heads.get(key)??null);},async compareAndSwap(change){assert.equal(heads.get(change.key)?.revision??null,change.expectedRevision);const head={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(++sequence),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'')};heads.set(change.key,head);return structuredClone(head);},async list(){return{items:[],cursor:null,highWater:String(sequence)};},async changes(){return{items:[],cursor:null,highWater:String(sequence)};}},
    readText:read,readTextById:async id=>{const entry=(await adapter.list()).find(entry=>entry.entryId===id);return entry?read(entry.path):null;},
    async planWrite(input){const current=await read(input.path);assert.equal(current.entryId,input.expectedEntryId);assert.equal(current.revision,input.expectedRevision);assert.equal(current.content,input.expectedContent);inputs.set(input.operationId,structuredClone(input));return{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)};},
    async prepare(plan){const ref={...scope,token:plan.operationId,operationId:plan.operationId,entryId:plan.entryId};intents.set(ref.token,{ref,state:'prepared',acknowledged:false});return structuredClone(intents.get(ref.token)!);},
    async commit(ref){if(holdCommit){commitEntered.resolve();await commitHeld.promise;}const input=inputs.get(ref.operationId)!;await adapter.write(input.path,input.content);const saved=await read(input.path),intent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,sequence:String(++sequence),revision:saved.revision}} as const;intents.set(ref.token,intent);return structuredClone(intent);},
    async query(ref){return structuredClone(intents.get(ref.token)??null);},async listUnacknowledged(){return[];},async acknowledge(ref){intents.set(ref.token,{...intents.get(ref.token)!,acknowledged:true} as DurableWriteIntent);},
  };
  return{adapter,ids,commitEntered,commitHeld,holdCommit(){holdCommit=true;}};
}

test('a trusted same-path replacement cancels the stale initial actor before a new pane joins',async t=>{
  const f=durableFixture(),ui=await setup(t,{}, {},undefined,f.adapter),held=gate(),entered=gate(),read=f.adapter.durableWrites.readTextById.bind(f.adapter.durableWrites);let first=true;
  f.adapter.durableWrites.readTextById=async id=>{const value=await read(id);if(first){first=false;entered.resolve();await held.promise;}return value;};
  const creator=ui.workspace.activePane,opening=ui.workspace.openNote('One.md',false,creator);await entered.promise;
  try{
    f.ids.set('One.md','replacement');ui.workspace.vault.entries.set('One.md',(await f.adapter.stat('One.md'))!);
    const joiner=(ui.workspace as any).addPane(),joining=ui.workspace.openNote('One.md',false,joiner);
    await promptly(opening);assert.equal(creator.viewReady,false);assert.equal(ui.root.querySelector('.error-message'),null);
    assert.equal(ui.workspace.buffers.get('One.md')!.hasAdmittedContent,false);
    // Vault still serializes an already-dispatched provider read. Cancellation
    // retires the old actor without granting the replacement that old result.
    held.resolve();await joining;
    assert.equal(joiner.editor?.getValue(),'Original one');assert.equal(ui.workspace.buffers.get('One.md')!.savedDurableWitness?.entryId,'replacement');
    await (ui.workspace as any).selectTab(creator,creator.tabs.find((tab:any)=>tab.id===creator.active));assert.equal(creator.editor?.getValue(),'Original one');
  }finally{held.resolve();await opening;}
});

test('navigation keeps an admitted D3 Core save barrier alive through its held commit',async t=>{
  const f=durableFixture(),ui=await setup(t,{}, {},undefined,f.adapter);await ui.workspace.openNote('One.md');f.holdCommit();ui.type('Durable D3');
  const saving=ui.workspace.flush();await f.commitEntered.promise;let moved=false;const moving=ui.workspace.openNote('Two.md').then(()=>{moved=true;});
  try{await turn();assert.equal(moved,false,'admitted source writes retain their actual save barrier');assert.equal(ui.workspace.buffers.get('One.md')!.text,'Durable D3');}
  finally{f.commitHeld.resolve();await saving;await moving;}
  assert.equal(await f.adapter.read('One.md'),'Durable D3');assert.equal(ui.workspace.buffers.get('One.md')!.dirty,false);assert.equal(ui.workspace.activePane.editor?.getValue(),'Second body');
});


test('a superseding navigation veto restores its canceled selected initial note',async t=>{
  const ui=await setup(t,{'One.md':'Original one','Two.md':'Second body'}),f=holdFirstRead(ui),opening=ui.workspace.openNote('One.md');await f.entered.promise;
  try{
    await ui.workspace.openNote('Two.md',false,ui.workspace.activePane,true,'',undefined,()=>false);await promptly(opening);
    for(let i=0;i<30&&!ui.workspace.activePane.viewReady;i++)await turn();
    assert.equal(ui.workspace.activePane.editor?.getValue(),'Original one');assert.equal(f.reads,2);assert.equal(ui.root.querySelector('.error-message'),null);
  }finally{f.held.resolve();await opening;}
});
