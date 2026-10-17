import {createCanvasView} from '../src/canvas/view.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorSelection,Transaction} from '@codemirror/state';
import {undo,undoDepth,redo} from '@codemirror/commands';
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
const board=JSON.stringify({nodes:[],edges:[],custom:'preserved'});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0));};

test('actual Canvas picker inserts an editable linked note and persists only its file reference',async t=>{
  const{workspace,adapter,dom,root}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha'}),{canvas:createCanvasView});await workspace.openNote('Board.canvas');
  root.querySelector<HTMLButtonElement>('[aria-label="Add note"]')!.click();const input=document.querySelector<HTMLInputElement>('.command-input')!;input.value='A.md';input.dispatchEvent(new dom.window.Event('input'));input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();await workspace.flush();
  let saved=JSON.parse(await adapter.read('Board.canvas'));assert.equal(saved.nodes.length,1);assert.equal(saved.nodes[0].type,'file');assert.equal(saved.nodes[0].file,'A.md');assert.equal(saved.custom,'preserved');
  root.querySelector<HTMLButtonElement>('[aria-label="Edit note"]')!.click();await settle();const cm=EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;cm.dispatch({changes:{from:cm.state.doc.length,insert:' from Canvas'},annotations:Transaction.userEvent.of('input.type')});await workspace.flush();assert.equal(await adapter.read('A.md'),'Alpha from Canvas');saved=JSON.parse(await adapter.read('Board.canvas'));assert.equal(saved.nodes[0].text,undefined);assert.equal(undo(cm),true);await workspace.flush();assert.equal(await adapter.read('A.md'),'Alpha');
});

test('actual file-tree drop inserts note PDF and image cards atomically without moving source files',async t=>{
  const pdfCalls:string[]=[],pdf:WorkspaceViewFactories['pdf']=(parent,path)=>{pdfCalls.push(path);const element=document.createElement('div');parent.append(element);return{element,ready:Promise.resolve(),destroy(){element.remove();}} as ReturnType<NonNullable<WorkspaceViewFactories['pdf']>>;};
  const{workspace,adapter,dom,root}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','Paper.pdf':'pdf','image.png':'image'}),{canvas:createCanvasView,pdf});await workspace.openNote('Board.canvas');const tree=workspace as any;tree.treeSelection=new Set(['A.md','Paper.pdf','image.png']);
  const data=new Map<string,string>(),transfer={effectAllowed:'none',dropEffect:'none',setData:(key:string,value:string)=>data.set(key,value),getData:(key:string)=>data.get(key)||'',setDragImage(){}};
  const fire=(target:Element,type:string)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:200,clientY:150});Object.defineProperty(event,'dataTransfer',{value:transfer});target.dispatchEvent(event);return event;};
  fire(tree.treeRows.find((row:any)=>row.path==='A.md').element,'dragstart');const viewport=root.querySelector('.zorid-canvas-viewport')!;assert.equal(fire(viewport,'dragover').defaultPrevented,true);assert.equal(transfer.dropEffect,'copy');assert.equal(fire(viewport,'drop').defaultPrevented,true);await settle();await workspace.flush();
  const saved=JSON.parse(await adapter.read('Board.canvas'));assert.deepEqual(saved.nodes.map((node:any)=>node.file),['A.md','Paper.pdf','image.png']);assert.equal(new Set(saved.nodes.map((node:any)=>node.id)).size,3);assert.equal(saved.custom,'preserved');assert.deepEqual(pdfCalls,['Paper.pdf']);assert.ok(root.querySelector('.canvas-attachment-card img'));assert.equal(await adapter.read('A.md'),'Alpha');assert.equal(await adapter.read('Paper.pdf'),'pdf');assert.equal(await adapter.read('image.png'),'image');workspace.activePane.canvasView!.undo();await workspace.flush();assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes.length,0);
});
