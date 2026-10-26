import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {ContextMenuRequest} from '../src/platform/context-menu.ts';

const note='---\nstatus: Todo\nrank: 1\n---\nAlpha body.\n';
async function until(check:()=>boolean,label:string){const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end,label);await new Promise<void>(done=>setTimeout(done,5));}}
async function setup(t:TestContext,type:string){
 const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;
 const rect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});
 dom.window.Range.prototype.getBoundingClientRect=rect;dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const base=`filters: file.inFolder("Items")\nviews:\n  - type: ${type}\n    name: Files\n    groupBy: {property: status, direction: ASC}\n    order: [file.name, rank]\n`;
 const adapter=new MemoryAdapter({'Files.base':base,'Items/Alpha.md':note}),root=document.querySelector<HTMLElement>('#app')!;
 const workspace=new Workspace(root,createEditor);
 const requests:Array<{request:ContextMenuRequest;choose:(id:string|null)=>void}>=[];
 // Observe the public native-menu boundary; no renderer menu or workspace
 // action is substituted. Tests deliver the same opaque reply as the host.
 Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:(request:ContextMenuRequest)=>new Promise<string|null>(choose=>requests.push({request,choose})),dismissContextMenu:async()=>{for(const menu of requests)menu.choose(null);}}});
 t.after(async()=>{try{for(const menu of requests)menu.choose(null);await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 await workspace.start({adapter,id:'test:base-file-menu',label:'Base file menu'});await workspace.openNote('Files.base');
 const context=(target:Element)=>{const event=new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:53,clientY:71});target.dispatchEvent(event);return event;};
 const choose=(label:string)=>{const menu=requests.at(-1)!;const item=menu.request.items.find(item=>'id'in item&&item.label===label);assert.ok(item&&'id'in item,label);menu.choose(item.id);};
 const bookmarks=()=>JSON.parse(dom.window.localStorage.getItem('zorid:workspace:test:base-file-menu')??'{}').bookmarks;
 return {dom,workspace,root,adapter,base,requests,context,choose,bookmarks};
}

const layouts=[['cards','.bases-cards-item[data-path="Items/Alpha.md"]'],['list','.bases-list-item[data-path="Items/Alpha.md"] a.internal-link'],['kanban','.bases-kanban-card[data-path="Items/Alpha.md"]'],['table','[role="gridcell"][data-path="Items/Alpha.md"][data-property="file.name"]']] as const;
for(const[type,selector]of layouts)test(`${type} file context menu opens once and keeps the row target through native actions`,async t=>{
 const f=await setup(t,type),target=f.root.querySelector(selector);assert.ok(target,selector);
 const event=f.context(target);assert.equal(event.defaultPrevented,true);
 assert.equal(f.requests.length,1,'the containing Base must not replace the handled row menu');
 assert.deepEqual(f.requests[0].request.items.map(item=>'label'in item?item.label:null),['Open in new tab','Bookmark','Rename…','Move to trash']);
 assert.deepEqual({x:f.requests[0].request.x,y:f.requests[0].request.y},{x:53,y:71});assert.equal(f.root.querySelector('.context-menu'),null,'desktop bridge menus are native');
 f.choose('Bookmark');await until(()=>f.bookmarks()?.includes('Items/Alpha.md')??false,'row bookmark persists');
 assert.deepEqual(f.bookmarks(),['Items/Alpha.md'],'the Base was not bookmarked');
 f.context(target);assert.equal(f.requests.length,2);assert.ok(f.requests[1].request.items.some(item=>'label'in item&&item.label==='Remove bookmark'));
 const before=f.workspace.activePane.tabs.map(tab=>tab.id);f.choose('Open in new tab');
 await until(()=>f.workspace.activePane.tabs.length===before.length+1&&f.workspace.activePane.viewPath==='Items/Alpha.md','row note opens in a new tab');
 assert.deepEqual(f.workspace.activePane.tabs.slice(0,-1).map(tab=>tab.id),before);assert.equal(f.workspace.activePane.editor!.getValue(),note);
 assert.equal(await f.adapter.read('Files.base'),f.base);assert.equal(await f.adapter.read('Items/Alpha.md'),note);
});

test('unhandled Base background context menu still targets the Base file',async t=>{
 const f=await setup(t,'cards'),host=f.root.querySelector('.base-attachment-view')!;assert.ok(host);
 assert.equal(f.context(host).defaultPrevented,true);assert.equal(f.requests.length,1);
 f.choose('Bookmark');await until(()=>f.bookmarks()?.includes('Files.base')??false,'Base bookmark persists');
 assert.deepEqual(f.bookmarks(),['Files.base']);
 assert.equal(await f.adapter.read('Files.base'),f.base);assert.equal(await f.adapter.read('Items/Alpha.md'),note);
});
