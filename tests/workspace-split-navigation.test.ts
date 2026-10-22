import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';

const base='views:\n  - type: table\n    name: Table\n    order: [file.name, score]\n';
const note='---\nscore: 1\n---\nSelection body remains exact.\n';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function until(check:()=>boolean,label:string){const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end,label);await new Promise<void>(done=>setTimeout(done,5));}}
async function setup(t:TestContext,views:WorkspaceViewFactories={}){
 const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;
 const rect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});
 dom.window.Range.prototype.getBoundingClientRect=rect;dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const adapter=new MemoryAdapter({'Selection.base':base,'Selection note.md':note,'Other.md':'Other body\n'}),root=document.querySelector<HTMLElement>('#app')!;
 const workspace=new Workspace(root,createEditor,views),internal=workspace as any;
 t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 await workspace.start({adapter,id:'test:split-navigation',label:'Split navigation'});
 return {workspace,internal,adapter,root,tree:(path:string)=>{const row=root.querySelector<HTMLElement>(`.tree-row[data-path=${JSON.stringify(path)}]`);assert.ok(row);return row;}};
}

test('a newer explorer note intent survives an older split waiting on the same real clean Base flush',async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection.base');const source=f.workspace.activePane,tab=f.internal.current(source),buffer=f.workspace.buffers.get('Selection.base')!,session=source.baseView!;
 const gate=deferred(),flush=session.flush.bind(session);let calls=0;
 // Scheduler gate only: both callers still execute the original real flush.
 session.flush=async()=>{calls++;await gate.promise;await flush();};
 let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await until(()=>calls===1,'older split reached the clean source flush');
  const before=f.internal.navigationIntent.get(source);f.tree('Selection note.md').click();
  assert.equal(f.internal.navigationIntent.get(source),before+1,'the real explorer handler admitted the newer navigation intent');
  assert.equal(tab.path,'Selection.base');await until(()=>calls>=2,'newer explorer open reached the same flush');
  gate.resolve();await splitting;
  await until(()=>f.internal.current(f.workspace.activePane)?.path==='Selection note.md'&&!!f.workspace.activePane.editor,'newer explorer note must mount after the older split settles');
  assert.equal(f.workspace.activePane.editor!.getValue(),note);assert.equal(f.workspace.buffers.get('Selection.base'),buffer);assert.equal(buffer.dirty,false);assert.equal(await f.adapter.read('Selection.base'),base);assert.equal(await f.adapter.read('Selection note.md'),note);
 }finally{gate.resolve();await splitting;session.flush=flush;}
});

test('an older split render completion cannot steal focus from a newer committed explorer note',async t=>{
 const entered=deferred(),gate=deferred();let created=0;
 const f=await setup(t,{base:(container,options)=>{
  const session=createBaseSession(container,options);if(++created!==2)return session;
  const ready=session.ready.then(async()=>{entered.resolve();await gate.promise;});
  return new Proxy(session,{get(target,key,receiver){return key==='ready'?ready:Reflect.get(target,key,receiver);}});
 }});
 await f.workspace.openNote('Selection.base');const source=f.workspace.activePane,buffer=f.workspace.buffers.get('Selection.base')!;
 let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await entered.promise;assert.notEqual(f.workspace.activePane,source,'the split destination already owns its initial activation');
  source.element.focus();f.tree('Selection note.md').click();await until(()=>f.internal.current(source)?.path==='Selection note.md'&&!!source.editor,'newer explorer note committed in the selected source pane');source.editor!.focus();
  assert.equal(f.workspace.activePane,source);const focused=document.activeElement;assert.ok(source.element.contains(focused));
  gate.resolve();await splitting;assert.equal(f.workspace.activePane.id,source.id,'old render completion must not reactivate its destination');assert.equal(document.activeElement,focused,'newer editor keeps exact focus');
  assert.equal(source.editor!.getValue(),note);assert.equal(f.workspace.buffers.get('Selection.base'),buffer);assert.equal(await f.adapter.read('Selection.base'),base);assert.equal(await f.adapter.read('Selection note.md'),note);
 }finally{gate.resolve();await splitting;}
});

test('sequential and background-tab splits still clone the requested tab and keep source ownership intact',async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection note.md');const source=f.workspace.activePane,original=source.editor!,tab=f.internal.current(source),buffer=f.workspace.buffers.get('Selection note.md')!;
 await f.internal.split('right');const second=f.workspace.activePane;assert.notEqual(second,source);assert.equal(source.editor,original);assert.equal(second.editor!.getValue(),note);assert.equal(f.workspace.buffers.get('Selection note.md'),buffer);
 await f.workspace.openNote('Other.md',true,source);const active=f.internal.current(source),other=source.editor!;
 await f.internal.split('bottom',source,tab);assert.equal(f.internal.current(source),active);assert.equal(source.editor,other);assert.equal(f.workspace.activePane.editor!.getValue(),note);assert.equal(await f.adapter.read('Selection note.md'),note);assert.equal(await f.adapter.read('Other.md'),'Other body\n');
});

test('an incidental source view refresh does not cancel a split with unchanged navigation and tab ownership',async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection.base');const source=f.workspace.activePane,tab=f.internal.current(source),buffer=f.workspace.buffers.get('Selection.base')!,session=source.baseView!,version=source.renderVersion;
 const entered=deferred(),gate=deferred(),flush=session.flush.bind(session);
 session.flush=async()=>{await flush();entered.resolve();await gate.promise;};let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await entered.promise;
  // The normal metadata-refresh renderer can replace view DOM without a new
  // user navigation. It must not act as a synthetic navigation generation.
  await f.workspace.renderPane(source,{flush:false,refresh:true});assert.notEqual(source.renderVersion,version);assert.equal(f.internal.current(source),tab);
  gate.resolve();await splitting;assert.notEqual(f.workspace.activePane.id,source.id);assert.equal(f.internal.current(f.workspace.activePane).path,'Selection.base');assert.equal(f.workspace.buffers.get('Selection.base'),buffer);assert.equal(await f.adapter.read('Selection.base'),base);
 }finally{gate.resolve();await splitting;session.flush=flush;}
});
