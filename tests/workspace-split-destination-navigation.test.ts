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

test('a newer explorer intent survives the destination split initial render assigning its first version',async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection.base');const source=f.workspace.activePane,originalBuffer=f.workspace.buffers.get('Selection.base')!;
 const renderEntered=deferred(),renderGate=deferred(),openEntered=deferred(),openGate=deferred();
 const dispose=f.internal.disposePaneViews.bind(f.internal),flush=f.internal.flushPane.bind(f.internal);
 let heldRender=false,heldOpen=false,destination:any;
 f.internal.disposePaneViews=async(pane:any)=>{
  await dispose(pane);
  if(pane!==source&&!heldRender){heldRender=true;destination=pane;assert.equal(pane.renderVersion,0);renderEntered.resolve();await renderGate.promise;}
 };
 f.internal.flushPane=async(pane:any)=>{
  await flush(pane);
  if(pane===destination&&!heldOpen){heldOpen=true;openEntered.resolve();await openGate.promise;}
 };
 let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await renderEntered.promise;
  assert.equal(f.workspace.activePane,destination,'the ordinary split has activated its destination');
  assert.equal(f.internal.current(destination).path,'Selection.base');
  const navigation=f.internal.navigationIntent.get(destination)??0;
  f.tree('Selection note.md').click();await openEntered.promise;
  assert.equal(f.internal.navigationIntent.get(destination),navigation+1,'the actual explorer handler admitted the newer note intent');
  assert.equal(destination.renderVersion,0,'the new open captured the destination before its initial version assignment');
  renderGate.resolve();await splitting;
  assert.notEqual(destination.renderVersion,0,'the older split initial render assigned a version while newer navigation awaited flush');
  openGate.resolve();
  await until(()=>f.internal.current(destination)?.path==='Selection note.md'&&!!destination.editor,'the admitted newer explorer note must mount after initial split rendering');
  assert.equal(f.workspace.activePane,destination);assert.equal(destination.editor.getValue(),note);
  assert.equal(f.workspace.buffers.get('Selection.base'),originalBuffer);assert.equal(originalBuffer.dirty,false);
  assert.equal(await f.adapter.read('Selection.base'),base);assert.equal(await f.adapter.read('Selection note.md'),note);
 }finally{renderGate.resolve();openGate.resolve();await splitting;f.internal.disposePaneViews=dispose;f.internal.flushPane=flush;}
});

for(const changed of ['mode','path','kind','replacement','identity'] as const)test(`the initial-version exemption rejects a changed origin ${changed}`,async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection.base');const source=f.workspace.activePane;
 const renderEntered=deferred(),renderGate=deferred(),openEntered=deferred(),openGate=deferred();
 const dispose=f.internal.disposePaneViews.bind(f.internal),flush=f.internal.flushPane.bind(f.internal),open=f.internal.openNote.bind(f.internal);
 let heldRender=false,heldOpen=false,destination:any,opening:Promise<void>|undefined;
 f.internal.disposePaneViews=async(pane:any)=>{await dispose(pane);if(pane!==source&&!heldRender){heldRender=true;destination=pane;renderEntered.resolve();await renderGate.promise;}};
 f.internal.flushPane=async(pane:any)=>{await flush(pane);if(pane===destination&&!heldOpen){heldOpen=true;openEntered.resolve();await openGate.promise;}};
 f.internal.openNote=(...args:any[])=>{const operation=open(...args);if(args[0]==='Selection note.md')opening=operation;return operation;};
 let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await renderEntered.promise;assert.equal(destination.renderVersion,0);
  f.tree('Selection note.md').click();await openEntered.promise;assert.ok(opening);
  const original=f.internal.current(destination);
  // Independent origin changes are injected while the actual explorer flush
  // waits; no render reply, editor value or navigation result is substituted.
  if(changed==='replacement')destination.tabs[destination.tabs.indexOf(original)]={...original};
  else if(changed==='identity'){original.id='changed-initial-tab-id';destination.active=original.id;}
  else if(changed==='mode')original.mode=original.mode==='reading'?'live':'reading';
  else if(changed==='path')original.path='Other.md';
  else original.kind='graph';
  const current=f.internal.current(destination),path=current.path,kind=current.kind,mode=current.mode;
  openGate.resolve();await opening;
  assert.equal(destination.renderVersion,0,'origin rejection happens even before the older view establishes a version');
  assert.equal(f.internal.current(destination),current);assert.equal(current.path,path);assert.equal(current.kind,kind);assert.equal(current.mode,mode);
  assert.notEqual(current.path,'Selection note.md','the rejected opener cannot author its target into the changed tab');
  renderGate.resolve();await splitting;
  assert.equal(await f.adapter.read('Selection.base'),base);assert.equal(await f.adapter.read('Selection note.md'),note);assert.equal(await f.adapter.read('Other.md'),'Other body\n');
 }finally{renderGate.resolve();openGate.resolve();await splitting;f.internal.disposePaneViews=dispose;f.internal.flushPane=flush;f.internal.openNote=open;}
});

test('a newer explorer navigation still supersedes an opener waiting in the initial destination',async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection.base');const source=f.workspace.activePane;
 const renderEntered=deferred(),renderGate=deferred(),openEntered=deferred(),openGate=deferred();
 const dispose=f.internal.disposePaneViews.bind(f.internal),flush=f.internal.flushPane.bind(f.internal),open=f.internal.openNote.bind(f.internal);
 let heldRender=false,heldOpen=false,destination:any,opening:Promise<void>|undefined,newer:Promise<void>|undefined;
 f.internal.disposePaneViews=async(pane:any)=>{await dispose(pane);if(pane!==source&&!heldRender){heldRender=true;destination=pane;renderEntered.resolve();await renderGate.promise;}};
 f.internal.flushPane=async(pane:any)=>{await flush(pane);if(pane===destination&&!heldOpen){heldOpen=true;openEntered.resolve();await openGate.promise;}};
 f.internal.openNote=(...args:any[])=>{const operation=open(...args);if(args[0]==='Selection note.md')opening=operation;if(args[0]==='Other.md')newer=operation;return operation;};
 let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await renderEntered.promise;f.tree('Selection note.md').click();await openEntered.promise;
  f.tree('Other.md').click();await until(()=>!!newer,'newer actual explorer open starts');await newer;
  assert.equal(f.internal.current(destination).path,'Other.md');assert.equal(destination.editor.getValue(),'Other body\n');
  openGate.resolve();await opening;renderGate.resolve();await splitting;
  assert.equal(f.internal.current(destination).path,'Other.md');assert.equal(destination.editor.getValue(),'Other body\n');assert.equal(f.workspace.activePane,destination);
  assert.equal(await f.adapter.read('Selection note.md'),note);assert.equal(await f.adapter.read('Other.md'),'Other body\n');
 }finally{renderGate.resolve();openGate.resolve();await splitting;f.internal.disposePaneViews=dispose;f.internal.flushPane=flush;f.internal.openNote=open;}
});

test('an established view retains its render-version fence across an incidental refresh',async t=>{
 const f=await setup(t);await f.workspace.openNote('Selection.base');const pane=f.workspace.activePane,version=pane.renderVersion;
 assert.notEqual(version,0);const entered=deferred(),gate=deferred(),flush=f.internal.flushPane.bind(f.internal);
 let held=false;f.internal.flushPane=async(target:any)=>{await flush(target);if(target===pane&&!held){held=true;entered.resolve();await gate.promise;}};
 let opening:Promise<void>|undefined;
 try{
  opening=f.workspace.openNote('Selection note.md');await entered.promise;
  await f.workspace.renderPane(pane,{flush:false,refresh:true});assert.notEqual(pane.renderVersion,version);
  gate.resolve();await opening;assert.equal(f.internal.current(pane).path,'Selection.base');assert.ok(pane.baseView);assert.equal(pane.editor,undefined);
  assert.equal(await f.adapter.read('Selection.base'),base);assert.equal(await f.adapter.read('Selection note.md'),note);
 }finally{gate.resolve();await opening;f.internal.flushPane=flush;}
});

test('an older split ready completion cannot replace or refocus its destination after a newer explorer note mounts',async t=>{
 const entered=deferred(),gate=deferred();let created=0;
 const f=await setup(t,{base:(container,options)=>{const session=createBaseSession(container,options);if(++created!==2)return session;const ready=session.ready.then(async()=>{entered.resolve();await gate.promise;});return new Proxy(session,{get(target,key,receiver){return key==='ready'?ready:Reflect.get(target,key,receiver);}});}});
 await f.workspace.openNote('Selection.base');const source=f.workspace.activePane;let splitting:Promise<void>|undefined;
 try{
  splitting=f.internal.split('right');await entered.promise;const destination=f.workspace.activePane;assert.notEqual(destination,source);assert.notEqual(destination.renderVersion,0);
  f.tree('Selection note.md').click();await until(()=>f.internal.current(destination)?.path==='Selection note.md'&&!!destination.editor,'newer explorer note mounts in the initial split destination');
  destination.editor.focus();const focused=document.activeElement;gate.resolve();await splitting;
  assert.equal(f.workspace.activePane,destination);assert.equal(f.internal.current(destination).path,'Selection note.md');assert.equal(destination.editor.getValue(),note);assert.equal(document.activeElement,focused);
  assert.equal(await f.adapter.read('Selection.base'),base);assert.equal(await f.adapter.read('Selection note.md'),note);
 }finally{gate.resolve();await splitting;}
});
