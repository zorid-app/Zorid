import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { HOTKEY_STORAGE_KEY } from '../src/ui/hotkeys.ts';

async function setup(t:TestContext,native=false){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const rect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});
  dom.window.Range.prototype.getBoundingClientRect=rect;dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  let windows=0,released=0,command:((id:'close-tab')=>void)|undefined;const hints:unknown[]=[];
  if(native)Object.defineProperty(dom.window,'zorid',{value:{getWindowInfo:async()=>({id:'main',initialState:'restore'}),newWindow:async()=>{windows++;return{id:'new'};},setMenuHotkeys:async(value:unknown)=>{hints.push(value);},onCommand:(callback:typeof command)=>{command=callback;return()=>{released++;command=undefined;};}}});
  const root=document.querySelector<HTMLElement>('#app')!,workspace=new Workspace(root,createEditor);
  let destroyed=false;const destroy=async()=>{if(!destroyed){destroyed=true;await workspace.destroy();}};
  t.after(async()=>{try{await destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter:new MemoryAdapter({'Note.md':'plain text','Other.md':'other'}),id:'test:hotkeys',label:'Test'});await workspace.openNote('Note.md');
  const click=(label:string)=>{const node=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label||item.getAttribute('aria-label')===label);assert.ok(node,label);node.click();};
  const key=(target:EventTarget,key:string,extra={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});target.dispatchEvent(event);return event;};
  const refresh=()=>dom.window.dispatchEvent(new dom.window.StorageEvent('storage',{key:HOTKEY_STORAGE_KEY}));
  return {dom,workspace,root,click,key,refresh,destroy,hints,get windows(){return windows;},get released(){return released;},nativeCommand(){command?.('close-tab');}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));

test('normal Save keyboard input bypasses a hidden summary menu while visible menus and lifecycle fences still block it',async t=>{
 const ui=await setup(t),buffer=ui.workspace.buffers.get('Note.md')!;
 const panel=document.createElement('section');panel.className='bases-summary-editor';const field=document.createElement('textarea');field.setAttribute('aria-label','Retained configuration');field.readOnly=true;const menu=document.createElement('div');menu.className='bases-summary-actions';menu.setAttribute('role','menu');menu.hidden=true;panel.append(field,menu);document.body.append(panel);field.focus();
 const writes:string[]=[];const adapter=ui.workspace.vault.adapter,write=adapter.write.bind(adapter);adapter.write=async(path,text)=>{writes.push(text);await write(path,text);};buffer.update('Accepted retained A');
 assert.equal(ui.key(field,'s',{ctrlKey:true}).defaultPrevented,true,'the actual document Save shortcut must run through hidden summary chrome');
 for(let n=0;n<100&&buffer.dirty;n++)await tick();assert.equal(buffer.dirty,false);assert.equal(await adapter.read('Note.md'),'Accepted retained A');assert.deepEqual(writes,['Accepted retained A']);
 buffer.update('Protected newer B');
 menu.hidden=false;assert.equal(ui.key(field,'s',{ctrlKey:true}).defaultPrevented,false);await tick();assert.equal(writes.length,1,'a visible menu keeps the workspace shortcut fence');menu.hidden=true;
 ui.root.inert=true;assert.equal(ui.key(field,'s',{ctrlKey:true}).defaultPrevented,false);ui.root.inert=false;
 const recovering=(ui.workspace as unknown as {recoveringAdmissionVaults:WeakSet<unknown>}).recoveringAdmissionVaults;recovering.add(ui.workspace.vault);assert.equal(ui.key(field,'s',{ctrlKey:true}).defaultPrevented,false);recovering.delete(ui.workspace.vault);
 const modal=document.createElement('div');modal.className='modal-overlay';document.body.append(modal);assert.equal(ui.key(field,'s',{ctrlKey:true}).defaultPrevented,false);modal.remove();
 assert.equal(ui.key(field,'s',{ctrlKey:true,isComposing:true}).defaultPrevented,false);await tick();assert.equal(writes.length,1);assert.equal(buffer.text,'Protected newer B');assert.equal(await adapter.read('Note.md'),'Accepted retained A');panel.remove();
});
