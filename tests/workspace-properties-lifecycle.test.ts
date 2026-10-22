import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';

const source='---\nstatus: Todo\nitems: [one, two]\n---\nOriginal body\n';
async function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const adapter=new MemoryAdapter({'Note.md':source,'Other.md':'Other'}),root=document.querySelector<HTMLElement>('#app')!;
  const workspace=new Workspace(root,(host,options)=>{const input=document.createElement('textarea');input.value=options.value;host.append(input);return{getValue:()=>input.value,setValue:value=>{input.value=value;},focus:()=>input.focus(),destroy:()=>input.remove(),insert:value=>{input.value+=value;options.onChange(input.value);}};});
  t.after(async()=>{try{
    // Explicitly discard only these disposable, intentionally unresolved fixture controls.
    for(const pane of (workspace as any).loadedViews()){pane.properties?.destroy();pane.properties=undefined;}
    await workspace.destroy();
  }finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:property-lifecycle',label:'Test'});await workspace.openNote('Note.md');return{dom,adapter,workspace,root};
}
function draft(root:ParentNode,kind:'scalar'|'list'|'add'){
  if(kind==='add')root.querySelector<HTMLButtonElement>('.metadata-add-button')!.click();
  const input=root.querySelector<HTMLInputElement|HTMLTextAreaElement>(kind==='scalar'?'[data-property-key="status"] .metadata-property-value input':kind==='list'?'[data-property-key="items"] textarea':'[aria-label="New property name"]')!;assert.ok(input);input.value='Unsubmitted draft';input.dispatchEvent(new window.Event('input',{bubbles:true}));return input;
}
for(const kind of ['scalar','list','add'] as const){
  test(`ordinary ${kind} property draft blocks global flush without losing DOM`,async t=>{const f=await setup(t),pane=f.workspace.activePane,input=draft(pane.element,kind),editor=pane.editor;await assert.rejects(f.workspace.flush(),/Finish editing/);assert.equal(pane.editor,editor);assert.equal(input.isConnected,true);assert.equal(input.value,'Unsubmitted draft');assert.equal(await f.adapter.read('Note.md'),source);});
  test(`ordinary ${kind} property draft blocks Ctrl+W and participates in beforeUnload`,async t=>{const f=await setup(t),pane=f.workspace.activePane,input=draft(pane.element,kind),editor=pane.editor;
    const unload=new f.dom.window.Event('beforeunload',{cancelable:true});f.dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
    document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'w',metaKey:true,bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pane.viewPath,'Note.md');assert.equal(pane.editor,editor);assert.equal(input.isConnected,true);assert.equal(input.value,'Unsubmitted draft');});
  test(`external deletion retains an ordinary ${kind} property draft in its original tab`,async t=>{const f=await setup(t),pane=f.workspace.activePane,input=draft(pane.element,kind),editor=pane.editor;await f.workspace.vault.trash('Note.md');await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pane.viewPath,'Note.md');assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.path,'Note.md');assert.equal(pane.editor,editor);assert.equal(input.isConnected,true);assert.equal(input.value,'Unsubmitted draft');assert.equal(f.workspace.vault.entries.has('Note.md'),false);});
}
test('a queued accepted property save settles once before navigation retires the ordinary note',async t=>{
  const f=await setup(t),pane=f.workspace.activePane,input=pane.element.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-value input')!,write=f.adapter.write.bind(f.adapter);let release!:()=>void,started=false,writes=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.adapter.write=async(path,value)=>{if(path==='Note.md'){started=true;writes++;await gate;}await write(path,value);};input.value='Done';input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('change',{bubbles:true}));let finished=false;const navigation=f.workspace.openNote('Other.md').then(()=>{finished=true;});
  try{for(let n=0;!started&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(started,true);assert.equal(finished,false);assert.equal(pane.viewPath,'Note.md');assert.equal(input.isConnected,true);release();await navigation;assert.equal(writes,1);assert.match(await f.adapter.read('Note.md'),/status: Done/);assert.equal(pane.viewPath,'Other.md');}
  finally{release();await navigation;f.adapter.write=write;}
});
test('a retained property draft cannot write into a recreated path after external deletion',async t=>{
  const f=await setup(t),pane=f.workspace.activePane,input=draft(pane.element,'scalar');await f.workspace.vault.trash('Note.md');await f.workspace.vault.create('Note.md','---\nstatus: Replacement\n---\nNew identity');input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await assert.rejects(pane.properties!.flush(),/no longer active|replaced|removed/);assert.equal(input.isConnected,true);assert.equal(input.value,'Unsubmitted draft');assert.match(await f.adapter.read('Note.md'),/Replacement/);assert.doesNotMatch(await f.adapter.read('Note.md'),/Unsubmitted/);
});
