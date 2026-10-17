import {createCanvasView} from '../src/canvas/view.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorSelection,Transaction} from '@codemirror/state';
import {HOTKEY_STORAGE_KEY,HotkeyPreferences} from '../src/ui/hotkeys.ts';
import {undo,undoDepth} from '@codemirror/commands';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';


import type {TestContext} from 'node:test';
async function setup(t:TestContext,adapter=new MemoryAdapter({'A.md':'Alpha','B.md':'Bravo','C.md':'Charlie','Target.md':'Target'}),factories:WorkspaceViewFactories={}){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const rect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});
  dom.window.Range.prototype.getBoundingClientRect=rect;
  dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  const root=document.querySelector<HTMLElement>('#app')!;
  const editorOptions=new Map<unknown,import('../src/ui/editor.ts').EditorOptions>();
  const destroyed=new Set<unknown>();
  const workspace=new Workspace(root,(parent,options)=>{const handle=createEditor(parent,options),dispose=handle.destroy;handle.destroy=()=>{destroyed.add(handle);dispose();};editorOptions.set(handle,options);return handle;},factories);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:docking',label:'Test'});
  return{dom,root,workspace,adapter,editorOptions,destroyed};
}

async function until(check:()=>boolean,label:string){const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,5));}}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function shortcut(view:EditorView,key='b'){const event=new window.KeyboardEvent('keydown',{key,ctrlKey:true,altKey:true,bubbles:true,cancelable:true});view.contentDOM.dispatchEvent(event);return event;}
function select(view:EditorView,text:string){const from=view.state.doc.toString().indexOf(text);assert.notEqual(from,-1);view.focus();view.dispatch({selection:EditorSelection.range(from,from+text.length)});}
function preferences(workspace:Workspace):HotkeyPreferences{return(workspace as any).hotkeys;}
const binding=(key:string)=>[{key,modifiers:['Mod','Alt'] as const}].map(value=>({...value,modifiers:[...value.modifiers]}));
const canvasSeed=()=>JSON.stringify({nodes:[{id:'text',type:'text',text:'Canvas text',x:0,y:0,width:400,height:300},{id:'file',type:'file',file:'Target.md',x:500,y:0,width:400,height:300}],edges:[],custom:{keep:true}});
async function canvasEditor(pane:Workspace['activePane'],id:string){const node=pane.element.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;assert.ok(node);node.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true}));await until(()=>!!node.querySelector('.zorid-canvas-note-editor .cm-editor'),'Canvas editor mounts');const view=EditorView.findFromDOM(node.querySelector('.zorid-canvas-note-editor .cm-editor')!)!;view.focus();return view;}

test('shared editor hotkeys update live and cached note editors without replacing history or selection',async t=>{
  const{workspace,editorOptions}=await setup(t);await workspace.openNote('A.md');const first=workspace.activePane.editor!,view=EditorView.findFromDOM(workspace.activePane.element.querySelector('.cm-editor')!)!,tab=workspace.activePane.tabs.find(tab=>tab.id===workspace.activePane.active)!;
  view.dispatch({changes:{from:view.state.doc.length,insert:' retained'},annotations:Transaction.userEvent.of('input.type')});select(view,'Alpha');const depth=undoDepth(view.state);assert.equal(editorOptions.get(first)!.hotkeys,preferences(workspace));
  await workspace.openNote('B.md',true);const second=workspace.activePane.editor!,secondView=EditorView.findFromDOM(workspace.activePane.element.querySelector('.cm-editor')!)!;select(secondView,'Bravo');
  preferences(workspace).set('editor-bold',binding('b'));await tick();assert.equal(workspace.activePane.editor,second);assert.equal(secondView.state.selection.main.to,5);assert.equal(shortcut(secondView).defaultPrevented,true);assert.equal(secondView.state.doc.toString(),'**Bravo**');
  await(workspace as any).selectTab(workspace.activePane,tab);assert.equal(workspace.activePane.editor,first);assert.equal(undoDepth(view.state),depth);assert.equal(view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to),'Alpha');view.focus();assert.equal(shortcut(view).defaultPrevented,true);assert.equal(view.state.doc.toString(),'**Alpha** retained');
  assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),'Alpha retained');assert.equal(undoDepth(view.state),depth);
  preferences(workspace).set('editor-bold',binding('q'));await tick();assert.equal(shortcut(view).defaultPrevented,false);select(view,'Alpha');assert.equal(shortcut(view,'q').defaultPrevented,true);assert.equal(view.state.doc.toString(),'**Alpha** retained');await workspace.flush();
});

test('cross-window preference reload reaches retained Canvas text and linked-note editors through shared services',async t=>{
  let options:Parameters<typeof createCanvasView>[1]|undefined;
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':canvasSeed(),'Target.md':'Linked note','Other.md':'Other'}),{canvas:(parent,value)=>{options=value;return createCanvasView(parent,value);}});
  await workspace.openNote('Board.canvas');const pane=workspace.activePane,canvas=pane.canvasView!,source=preferences(workspace);assert.equal(options!.textEditorOptions!.hotkeys,source);
  const text=await canvasEditor(pane,'text'),linked=await canvasEditor(pane,'file');select(linked,'Linked');const linkedSelection=linked.state.selection.main;
  const external=new HotkeyPreferences(localStorage,'other');external.set('editor-bold',binding('b'));window.dispatchEvent(new window.StorageEvent('storage',{key:HOTKEY_STORAGE_KEY}));await tick();
  assert.equal(pane.canvasView,canvas);assert.equal(EditorView.findFromDOM(pane.element.querySelector('[data-node-id="file"] .cm-editor')!),linked);assert.equal(linked.state.selection.main.from,linkedSelection.from);assert.equal(linked.state.selection.main.to,linkedSelection.to);
  assert.equal(shortcut(linked).defaultPrevented,true);await workspace.flush();assert.equal(await adapter.read('Target.md'),'**Linked** note');
  const sameText=await canvasEditor(pane,'text');assert.equal(sameText,text);select(text,'Canvas');assert.equal(shortcut(text).defaultPrevented,true);await workspace.flush();const json=JSON.parse(await adapter.read('Board.canvas'));assert.equal(json.nodes.find((node:any)=>node.id==='text').text,'**Canvas** text');assert.deepEqual(json.custom,{keep:true});
  external.set('editor-bold',[]);window.dispatchEvent(new window.StorageEvent('storage',{key:HOTKEY_STORAGE_KEY}));await tick();assert.equal(shortcut(text).defaultPrevented,false);assert.equal(text.state.doc.toString(),'**Canvas** text');
  assert.equal(undo(text),true);await workspace.flush();assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes.find((node:any)=>node.id==='text').text,'Canvas text');
});

test('cached Canvas editors receive later hotkey changes and release subscriptions with their tab',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'Board.canvas':canvasSeed(),'Target.md':'Linked note','Other.md':'Other'}));const source=preferences(workspace),subscribe=source.subscribe.bind(source);let active=0;
  source.subscribe=listener=>{active++;const unsubscribe=subscribe(listener);let closed=false;return()=>{if(!closed){closed=true;active--;unsubscribe();}};};
  await workspace.openNote('Board.canvas');const pane=workspace.activePane,tab=pane.tabs.find(tab=>tab.id===pane.active)!,canvas=pane.canvasView!,text=await canvasEditor(pane,'text'),linked=await canvasEditor(pane,'file');await workspace.flush();assert.equal(active,2);
  await workspace.openNote('Other.md',true);assert.equal(active,3);source.set('editor-bold',binding('b'));await tick();
  await(workspace as any).selectTab(pane,tab);assert.equal(pane.canvasView,canvas);assert.equal(await canvasEditor(pane,'text'),text);select(text,'Canvas');assert.equal(shortcut(text).defaultPrevented,true);await workspace.flush();
  await(workspace as any).closeTab(pane,tab);assert.equal(active,1);const previousText=text.state.doc.toString(),previousLinked=linked.state.doc.toString();source.set('editor-bold',[]);await tick();assert.equal(text.state.doc.toString(),previousText);assert.equal(linked.state.doc.toString(),previousLinked);
});
