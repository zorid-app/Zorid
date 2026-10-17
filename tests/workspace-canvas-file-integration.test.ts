import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {undo,undoDepth} from '@codemirror/commands';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';


import type {TestContext} from 'node:test';
import type {DockIntent} from '../src/ui/tab-docking.ts';
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
const dock=(workspace:Workspace,intent:DockIntent)=>(workspace as any).dockTab(intent) as Promise<void>;
const live=(pane:Workspace['activePane'])=>EditorView.findFromDOM(pane.element.querySelector('.cm-editor')!)!;

test('combined real file-card CM edits synchronize cached note and retain identity through docking',async t=>{
  const board=JSON.stringify({nodes:[{id:'card',type:'file',file:'A.md',x:0,y:0,width:300,height:200}],edges:[]});
  const {workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','B.md':'Bravo'}));
  await workspace.openNote('A.md');const source=workspace.activePane,note=live(source);
  await workspace.openNote('Board.canvas',true);const tab=source.tabs[1];
  const ready=()=>source.element.querySelector<HTMLButtonElement>('[aria-label="Edit note"]');
  for(let i=0;i<50&&(!ready()||ready()!.disabled);i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(ready()?.disabled,false);ready()!.click();
  for(let i=0;i<50&&!source.element.querySelector('.zorid-canvas-note-editor .cm-editor');i++)await new Promise(resolve=>setTimeout(resolve,0));
  const editor=EditorView.findFromDOM(source.element.querySelector('.zorid-canvas-note-editor .cm-editor')!)!;assert.ok(editor);
  editor.dispatch({changes:{from:0,insert:'Card '},annotations:Transaction.userEvent.of('input.type')});
  assert.equal(workspace.buffers.get('A.md')!.text,'Card Alpha');assert.equal(note.state.doc.toString(),'Card Alpha');assert.equal(undoDepth(editor.state),1);
  await dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:source.id,edge:'right',index:0});await new Promise(resolve=>setTimeout(resolve,0));
  const target=workspace.activePane;assert.equal(EditorView.findFromDOM(target.element.querySelector('.zorid-canvas-note-editor .cm-editor')!),editor);assert.equal(editor.hasFocus,true);assert.equal(undoDepth(editor.state),1);
  await workspace.flush();assert.equal(await adapter.read('A.md'),'Card Alpha');assert.equal(await adapter.read('Board.canvas'),board);
  assert.equal(undo(editor),true);await workspace.flush();assert.equal(await adapter.read('A.md'),'Alpha');
});
