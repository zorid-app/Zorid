import {CanvasDocument} from '../src/canvas/document.ts';
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
async function until(check:()=>boolean,label:string){const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,5));}}
function capturePdf(){const calls:{path:string;options:any;destroyed:boolean}[]=[];const factory:NonNullable<WorkspaceViewFactories['pdf']>=(parent,path,_resources,options)=>{const call={path,options,destroyed:false};calls.push(call);const node=document.createElement('div');parent.append(node);return{ready:Promise.resolve(),destroy(){call.destroyed=true;node.remove();},goToPage(){},setScale(){},rotate(){},showSearch(){},applySubpath(){},getSelectionSubpath(){return null;}};};return{calls,factory};}
const fragment='#page=2&selection=0,1,2,4',alias='Paper, page 2';
const expected='[[./Folder/Paper.pdf#page=2&selection=0,1,2,4|Paper, page 2]]';

test('standalone PDF links use the current settings and retire with their actual view/file identity',async t=>{
  const pdf=capturePdf(),{workspace,adapter}=await setup(t,new MemoryAdapter({'Folder/Paper.pdf':'pdf','Other.md':'note'}),{pdf:pdf.factory});workspace.settings.newLinkFormat='relative';await workspace.openNote('Folder/Paper.pdf');const first=pdf.calls[0];assert.equal(first.options.generateMarkdownLink(fragment,alias),expected);
  workspace.settings.useMarkdownLinks=true;assert.equal(first.options.generateMarkdownLink('#page=3','Paper [draft], page 3'),'[Paper \\[draft\\], page 3](./Folder/Paper.pdf#page=3)');await workspace.openNote('Other.md');assert.equal(first.destroyed,true);assert.equal(first.options.generateMarkdownLink(fragment,alias),null);
  await workspace.openNote('Folder/Paper.pdf');const replacement=pdf.calls.at(-1)!;await adapter.trash('Folder/Paper.pdf');await workspace.vault.reload();assert.equal(replacement.options.generateMarkdownLink(fragment,alias),null);
});

for(const mode of ['live','reading'] as const)test(`${mode} Markdown PDF embeds resolve the exact file but copy with empty source context`,async t=>{
  const pdf=capturePdf(),{workspace}=await setup(t,new MemoryAdapter({'Home.md':'![[Nested/Inner]]','Nested/Inner.md':'![[../Folder/Paper.pdf]]','Folder/Paper.pdf':'pdf','Other.md':'note'}),{pdf:pdf.factory});workspace.settings.newLinkFormat='relative';await workspace.openNote('Home.md');if(mode==='reading')await(workspace as any).toggleReading(workspace.activePane);
  await until(()=>pdf.calls.some(call=>!call.destroyed),'nested PDF embed mounts');const call=pdf.calls.findLast(call=>!call.destroyed)!;assert.equal(call.path,'Folder/Paper.pdf');assert.equal(call.options.generateMarkdownLink(fragment,alias),expected);assert.equal(call.options.embed,true);
  await workspace.openNote('Other.md');assert.equal(call.destroyed,true);assert.equal(call.options.generateMarkdownLink(fragment,alias),null);
});

test('Canvas file and text-embed PDF links share formatting and retire independently when cards are removed',async t=>{
  const pdf=capturePdf(),board=JSON.stringify({nodes:[{id:'file',type:'file',file:'Folder/Paper.pdf',x:0,y:0,width:300,height:300},{id:'text',type:'text',text:'![[Folder/Paper.pdf]]',x:400,y:0,width:300,height:300}],edges:[]}),{workspace}=await setup(t,new MemoryAdapter({'Boards/Board.canvas':board,'Folder/Paper.pdf':'pdf'}),{pdf:pdf.factory});workspace.settings.newLinkFormat='relative';await workspace.openNote('Boards/Board.canvas');await until(()=>pdf.calls.length===2,'both Canvas PDF owners mount');
  for(const call of pdf.calls){assert.equal(call.path,'Folder/Paper.pdf');assert.equal(call.options.generateMarkdownLink(fragment,alias),expected);}
  workspace.activePane.canvasView!.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}'));for(const call of pdf.calls){assert.equal(call.destroyed,true);assert.equal(call.options.generateMarkdownLink(fragment,alias),null);}
});

test('a PDF link callback cannot address a same-path file in a replacement vault',async t=>{
  const pdf=capturePdf(),{workspace}=await setup(t,new MemoryAdapter({'Folder/Paper.pdf':'old'}),{pdf:pdf.factory});await workspace.openNote('Folder/Paper.pdf');const old=pdf.calls[0];await workspace.openVault({id:'new',label:'new',adapter:new MemoryAdapter({'Folder/Paper.pdf':'replacement'})});await workspace.openNote('Folder/Paper.pdf');assert.equal(old.options.generateMarkdownLink(fragment,alias),null);assert.notEqual(pdf.calls.at(-1)!.options.generateMarkdownLink(fragment,alias),null);
});
