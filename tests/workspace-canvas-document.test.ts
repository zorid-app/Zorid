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
function canvasFactory(){
  let options:any;
  return{get options(){return options;},factory(parent:HTMLElement,next:any){options=next;const element=document.createElement('div');parent.append(element);return{element,document:next.document,setDocument(){},undo(){},redo(){},async flush(){},hasPendingChanges:()=>false,destroy(){element.remove();}};}};
}
const board=JSON.stringify({nodes:[],edges:[]});
function transfer(){const data=new Map<string,string>();return{effectAllowed:'none',dropEffect:'none',setData:(type:string,text:string)=>data.set(type,text),getData:(type:string)=>data.get(type)??'',setDragImage(){}} as unknown as DataTransfer;}
function dispatchDrag(dom:JSDOM,target:Element,type:string,dataTransfer:DataTransfer){const event=new dom.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:dataTransfer});target.dispatchEvent(event);return event;}

test('actual file-tree controller exposes selected documents to Canvas despite stopped drag propagation',async t=>{
  const canvas=canvasFactory(),{workspace,dom}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','Paper.pdf':'pdf','image.png':'image'}),{canvas:canvas.factory});await workspace.openNote('Board.canvas');
  const tree=workspace as any,row=tree.treeRows.find((row:any)=>row.path==='A.md');assert.ok(row);tree.treeSelection=new Set(['A.md','Paper.pdf','image.png']);
  const data=transfer();dispatchDrag(dom,row.element,'dragstart',data);assert.equal(data.effectAllowed,'copyMove');assert.deepEqual(canvas.options.filePathsFromDrop(data),['A.md','Paper.pdf','image.png']);
  assert.equal(workspace.vault.entries.has('A.md'),true);dispatchDrag(dom,row.element,'dragend',data);assert.deepEqual(canvas.options.filePathsFromDrop(data),[]);
});

test('Workspace picker returns current note/PDF/image paths and cancels a retired Canvas owner',async t=>{
  const canvas=canvasFactory(),{workspace,dom}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','Paper.pdf':'pdf','image.png':'image'}),{canvas:canvas.factory});await workspace.openNote('Board.canvas');const old=canvas.options;
  for(const path of ['A.md','Paper.pdf','image.png']){const pending=old.chooseFile(path.endsWith('.md')?'note':'media');assert.equal(document.querySelectorAll('[role=option]').length,path.endsWith('.md')?1:2);const input=document.querySelector<HTMLInputElement>('.command-input')!;input.value=path;input.dispatchEvent(new dom.window.Event('input'));input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(await pending,path);}
  const pending=old.chooseFile();await workspace.openNote('A.md');document.querySelector('input.command-input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(await pending,null);assert.equal(await old.chooseFile(),null);
});

test('vault switch cancels pending Canvas picker and invalidates former local tree drag',async t=>{
  const canvas=canvasFactory(),{workspace,dom}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha'}),{canvas:canvas.factory});await workspace.openNote('Board.canvas');const old=canvas.options,data=transfer(),row=(workspace as any).treeRows.find((row:any)=>row.path==='A.md');dispatchDrag(dom,row.element,'dragstart',data);const pending=old.chooseFile();
  await workspace.openVault({adapter:new MemoryAdapter({'A.md':'New vault'}),id:'new',label:'New'});assert.equal(await pending,null);assert.deepEqual(old.filePathsFromDrop(data),[]);assert.equal(document.querySelector('[role=dialog]'),null);
});

test('Canvas renderer delegates PDF fragments and image bytes to owned shared viewers',async t=>{
  const canvas=canvasFactory(),pdfCalls:any[]=[],destroyed:string[]=[];
  const pdf:WorkspaceViewFactories['pdf']=(parent,path,resources,options)=>{const element=document.createElement('div');parent.append(element);pdfCalls.push({path,resources,options});return{element,ready:Promise.resolve(),destroy(){destroyed.push(path);element.remove();}} as ReturnType<NonNullable<WorkspaceViewFactories['pdf']>>;};
  const{workspace}=await setup(t,new MemoryAdapter({'Board.canvas':board,'Paper.pdf':'pdf','image.png':'image'}),{canvas:canvas.factory,pdf});await workspace.openNote('Board.canvas');
  const pdfOwner=canvas.options.renderFile('Paper.pdf','#page=2');assert.equal(pdfCalls.length,1);assert.equal(pdfCalls[0].options.subpath,'#page=2');assert.equal(pdfCalls[0].options.embed,true);assert.equal(pdfOwner.element.dataset.kind,'pdf');pdfOwner.destroy();pdfOwner.destroy();assert.deepEqual(destroyed,['Paper.pdf']);
  const imageOwner=canvas.options.renderFile('image.png'),image=imageOwner.element.querySelector('img');assert.ok(image);for(let i=0;i<10&&!image.src;i++)await new Promise(resolve=>setTimeout(resolve,0));assert.match(image.src,/^blob:/);imageOwner.destroy();assert.equal(image.getAttribute('src'),null);
  const missing=canvas.options.renderFile('missing.pdf');assert.match(missing.element.textContent,/File not found/);assert.equal(pdfCalls.length,1);missing.destroy();
});

test('Canvas copy capability preserves existing file-tree move behavior',async t=>{
  const canvas=canvasFactory(),{workspace,adapter,dom}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','Folder/Keep.md':'Keep'}),{canvas:canvas.factory});await workspace.openNote('Board.canvas');
  const tree=workspace as any,data=transfer(),source=tree.treeRows.find((row:any)=>row.path==='A.md').element,target=tree.treeRows.find((row:any)=>row.path==='Folder').element;
  dispatchDrag(dom,source,'dragstart',data);assert.equal(data.effectAllowed,'copyMove');assert.equal(dispatchDrag(dom,target,'dragover',data).defaultPrevented,true);assert.equal(data.dropEffect,'move');dispatchDrag(dom,target,'drop',data);
  for(let i=0;i<30&&!workspace.vault.entries.has('Folder/A.md');i++)await new Promise(resolve=>setTimeout(resolve,0));assert.equal(await adapter.read('Folder/A.md'),'Alpha');assert.equal(workspace.vault.entries.has('A.md'),false);assert.deepEqual(JSON.parse(await adapter.read('Board.canvas')).nodes,[]);
});
