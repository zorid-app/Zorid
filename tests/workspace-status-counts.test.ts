import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {EditorOptions,EditorHandle} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';

async function setup(t:TestContext,files:Record<string,string>){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>(),frames=new Map<number,FrameRequestCallback>(),idle=new Map<number,IdleRequestCallback>();let sequence=0;
  dom.window.requestAnimationFrame=callback=>{const id=++sequence;frames.set(id,callback);return id;};
  dom.window.cancelAnimationFrame=id=>{frames.delete(id);};
  dom.window.requestIdleCallback=callback=>{const id=++sequence;idle.set(id,callback);return id;};
  dom.window.cancelIdleCallback=id=>{idle.delete(id);};
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame,cancelAnimationFrame:dom.window.cancelAnimationFrame,matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const factory=(parent:HTMLElement,options:EditorOptions):EditorHandle=>{
    const body=document.createElement('textarea');body.setAttribute('aria-label','Note body');body.value=options.value;parent.append(body);
    body.addEventListener('input',()=>{options.validateChange?.(body.value);options.onChange(body.value);});
    return{getValue:()=>body.value,setValue:value=>{body.value=value;},focus:()=>body.focus(),insert:value=>{body.value+=value;options.onChange(body.value);},destroy:()=>body.remove()};
  };
  const root=document.querySelector<HTMLElement>('#app')!,workspace=new Workspace(root,factory),adapter=new MemoryAdapter(files);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:deferred-counts',label:'Test'});
  return{dom,workspace,root,frames,idle,adapter,
    frame(){const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(0);},
    idleTurn(){assert.ok(idle.size,'expected one idle count slice');const[id,callback]=idle.entries().next().value!;idle.delete(id);callback({didTimeout:false,timeRemaining:()=>8});},
    drain(){for(let turns=0;idle.size&&turns<256;turns++){const[id,callback]=idle.entries().next().value!;idle.delete(id);callback({didTimeout:false,timeRemaining:()=>8});}assert.equal(idle.size,0);},
    type(value:string){const body=root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note body"]')!;assert.ok(body);body.value=value;body.dispatchEvent(new dom.window.Event('input',{bubbles:true}));},
    status:()=>root.querySelector('.status-bar')!.textContent!,
  };
}

test('a mounted selected editor is usable while counts wait for paint and idle',async t=>{
  const ui=await setup(t,{'Note.md':'Original 🌱 words'});await ui.workspace.openNote('Note.md');
  assert.equal(ui.workspace.activePane.viewReady,true);assert.ok(ui.root.querySelector('textarea'));
  assert.match(ui.status(),/… words/);assert.match(ui.status(),/… characters/);assert.equal(ui.idle.size,0);
  ui.type('Typed before count readiness');assert.equal(ui.workspace.buffers.get('Note.md')!.text,'Typed before count readiness');
  assert.match(ui.status(),/… words/);ui.frame();assert.equal(ui.idle.size,0);ui.frame();assert.equal(ui.idle.size,1);
  ui.drain();assert.match(ui.status(),/4 words/);assert.match(ui.status(),/28 characters/);
});
