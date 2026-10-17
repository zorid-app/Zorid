import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { undoDepth } from '@codemirror/commands';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { HOTKEY_STORAGE_KEY, HotkeyPreferences } from '../src/ui/hotkeys.ts';

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

test('Settings rebind executes through real editor events without replacing its selection/history',async t=>{
  const ui=await setup(t),pane=ui.workspace.activePane,editor=pane.editor!,dom=pane.element.querySelector('.cm-editor')!,view=EditorView.findFromDOM(dom)!;
  view.dispatch({changes:{from:0,insert:'X'},annotations:Transaction.userEvent.of('input.type'),selection:{anchor:3}});
  ui.workspace.showSettings();ui.click('Hotkeys');const search=document.querySelector<HTMLInputElement>('[aria-label="Search hotkeys"]')!;search.value='Toggle left';search.dispatchEvent(new ui.dom.window.Event('input'));
  const add=document.querySelector<HTMLButtonElement>('.hotkey-add')!;add.click();ui.key(add,'l',{ctrlKey:true,altKey:true});
  assert.equal(new HotkeyPreferences(localStorage,'other').label('toggle-left'),'Ctrl+Alt+L');ui.click('Close settings');
  assert.equal(pane.editor,editor);assert.equal(EditorView.findFromDOM(dom),view);assert.equal(view.state.selection.main.head,3);assert.equal(undoDepth(view.state),1);
  assert.equal(ui.key(view.contentDOM,'l',{ctrlKey:true,altKey:true}).defaultPrevented,true);await tick();assert.equal(ui.root.classList.contains('left-hidden'),true);
  const preferences=new HotkeyPreferences(localStorage,'other');preferences.set('toggle-left',[]);ui.refresh();
  assert.equal(ui.key(view.contentDOM,'l',{ctrlKey:true,altKey:true}).defaultPrevented,false);await tick();assert.equal(ui.root.classList.contains('left-hidden'),true);
});
test('cross-window preferences refresh visible and cached hints while removing old native-window binding',async t=>{
  const ui=await setup(t,true),preferences=new HotkeyPreferences(localStorage,'other');
  const firstEditor=ui.workspace.activePane.editor;await ui.workspace.openNote('Other.md',true);
  preferences.set('toggle-reading',[{key:'e',modifiers:['Mod','Alt']}]);preferences.set('new-window',[{key:'n',modifiers:['Mod','Alt']}]);ui.refresh();
  assert.equal(document.querySelector('[aria-label="Switch to reading view (Ctrl+Alt+E)"]')!==null,true);
  assert.equal(ui.key(document,'N',{ctrlKey:true,shiftKey:true}).defaultPrevented,false);await tick();assert.equal(ui.windows,0);
  assert.equal(ui.key(document,'n',{ctrlKey:true,altKey:true}).defaultPrevented,true);await tick();assert.equal(ui.windows,1);
  assert.ok(JSON.stringify(ui.hints.at(-1)).includes('Ctrl+Alt+N'));
  ui.key(document,'1',{ctrlKey:true});await tick();assert.equal(ui.workspace.activePane.editor,firstEditor);assert.ok(document.querySelector('[aria-label="Switch to reading view (Ctrl+Alt+E)"]'));
  await ui.destroy();assert.equal(ui.released,1);
});
test('capture Escape leaves Settings open and native close-tab obeys modal ownership',async t=>{
  const ui=await setup(t,true);await ui.workspace.openNote('Other.md',true);const count=ui.workspace.activePane.tabs.length;
  ui.workspace.showSettings();ui.click('Hotkeys');const add=document.querySelector<HTMLButtonElement>('[data-command="graph"] .hotkey-add')!;add.click();
  assert.equal(ui.key(add,'Escape').defaultPrevented,true);assert.ok(document.querySelector('.settings-modal'));
  ui.nativeCommand();await tick();assert.equal(ui.workspace.activePane.tabs.length,count);
  ui.key(add,'Escape');assert.equal(document.querySelector('.settings-modal'),null);
  ui.nativeCommand();await tick();assert.equal(ui.workspace.activePane.tabs.length,count-1);
});

test('corrupt conflicting preferences cannot revive a default through legacy shortcut fallback',async t=>{
  const ui=await setup(t);localStorage.setItem(HOTKEY_STORAGE_KEY,JSON.stringify({graph:[{key:'n',modifiers:['Mod']}]}));ui.refresh();
  const before=ui.workspace.vault.entries.size;assert.equal(ui.key(document,'n',{ctrlKey:true}).defaultPrevented,false);await tick();assert.equal(ui.workspace.vault.entries.size,before);
});

test('image modal blocks native and keyboard workspace commands',async t=>{
  const ui=await setup(t,true);await ui.workspace.openNote('Other.md',true);
  const count=ui.workspace.activePane.tabs.length;
  const {openImageLightbox}=await import('../src/ui/image-view.ts');
  const lightbox=openImageLightbox([{alt:'Test',load:async()=>({url:'data:image/png;base64,',release(){}})}]);
  try {ui.nativeCommand();ui.key(document,'w',{ctrlKey:true});await tick();assert.equal(ui.workspace.activePane.tabs.length,count);}
  finally {lightbox.destroy();}
});
