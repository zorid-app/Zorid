import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {EditorOptions,EditorHandle} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {PlatformVault} from '../src/platform/index.ts';

async function setup(t:TestContext,files:Record<string,string>,features:Partial<PlatformVault>={},bridge?:unknown){
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
  const root=document.querySelector<HTMLElement>('#app')!,workspace=new Workspace(root,factory),adapter=new MemoryAdapter(files);
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
