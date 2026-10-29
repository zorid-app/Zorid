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

test('word whitespace and Unicode codepoint counts retain the previous exact semantics',async t=>{
  const ui=await setup(t,{'Note.md':'Seed'});await ui.workspace.openNote('Note.md');
  const separators=['\t','\n','\v','\f','\r',' ','\u00a0','\u1680','\u2000','\u2001','\u2002','\u2003','\u2004','\u2005','\u2006','\u2007','\u2008','\u2009','\u200a','\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff'];
  for(const text of ['',separators.join(''),separators.map(space=>`alpha${space}beta`).join(' '),
    'alpha\u0085beta\u180einside\u200bword','👩‍👩‍👧‍👦 e\u0301 中文 \ud800 \udc00']){
    ui.type(text);ui.frame();ui.frame();ui.drain();
    const words=text.trim()?text.trim().split(/\s+/u).length:0;
    assert.equal(ui.root.querySelector('.status-word-count')!.textContent,`${words} words`);
    assert.equal(ui.root.querySelector('.status-character-count')!.textContent,`${[...text].length} characters`);
  }
});

test('rapid edits retarget one pending job and unchanged status publications reuse exact cached counts',async t=>{
  const ui=await setup(t,{'Note.md':'Initial words'});await ui.workspace.openNote('Note.md');ui.frame();ui.frame();
  assert.equal(ui.idle.size,1);
  ui.type('First obsolete text');ui.type('Second obsolete text with more words');ui.type('Latest 🌱 only now');
  assert.equal(ui.idle.size,1);assert.match(ui.status(),/… words/);
  ui.drain();assert.match(ui.status(),/4 words/);assert.match(ui.status(),/17 characters/);
  for(let change=0;change<20;change++)ui.type('Latest 🌱 only now');
  ui.frame();ui.frame();assert.equal(ui.idle.size,0,'identical immutable text never reschedules scanning');
  assert.match(ui.status(),/4 words/);
});

test('large sources yield within both the time budget and UTF16 quantum, including split surrogate pairs',async t=>{
  const text='a'.repeat(32767)+'🌱 b',ui=await setup(t,{'Large.md':text});await ui.workspace.openNote('Large.md');ui.frame();ui.frame();
  const original=String.prototype.charCodeAt,clockDescriptor=Object.getOwnPropertyDescriptor(ui.dom.window.performance,'now');let scanned=0,clock=0;
  String.prototype.charCodeAt=function(index:number){if(String(this)===text)scanned++;return original.call(this,index);};
  Object.defineProperty(ui.dom.window.performance,'now',{configurable:true,value:()=>++clock});
  try{ui.idleTurn();assert.ok(scanned>0&&scanned<32768,'expired time budget must yield before the maximum quantum');assert.match(ui.status(),/… words/);}
  finally{String.prototype.charCodeAt=original;if(clockDescriptor)Object.defineProperty(ui.dom.window.performance,'now',clockDescriptor);else Reflect.deleteProperty(ui.dom.window.performance,'now');}
  ui.drain();assert.match(ui.status(),/2 words/);assert.match(ui.status(),/32770 characters/);
  ui.type(text+'!');ui.frame();ui.frame();
  scanned=0;String.prototype.charCodeAt=function(index:number){if(String(this)===text+'!')scanned++;return original.call(this,index);};
  try{ui.idleTurn();assert.ok(scanned<=32768);assert.match(ui.status(),/… characters/);}
  finally{String.prototype.charCodeAt=original;}
  ui.drain();assert.match(ui.status(),/32771 characters/);
});

test('typing during a partial scan resets its progress and never publishes the superseded source',async t=>{
  const ui=await setup(t,{'Note.md':'old '.repeat(20000)});await ui.workspace.openNote('Note.md');ui.frame();ui.frame();ui.idleTurn();
  assert.match(ui.status(),/… words/);assert.equal(ui.idle.size,1);
  ui.type('Final😀');assert.equal(ui.idle.size,1);assert.match(ui.status(),/… words/);
  ui.drain();assert.match(ui.status(),/1 words/);assert.match(ui.status(),/6 characters/);
});

test('switching selected notes cancels stale work and returning to a counted buffer needs no rescan',async t=>{
  const ui=await setup(t,{'One.md':'First note','Two.md':'Second'});await ui.workspace.openNote('One.md');ui.frame();ui.frame();
  const obsolete=[...ui.idle.values()][0];assert.ok(obsolete);
  await ui.workspace.openNote('Two.md');assert.equal(ui.idle.size,0);
  obsolete({didTimeout:false,timeRemaining:()=>8});assert.match(ui.status(),/… words/);
  ui.frame();ui.frame();ui.drain();assert.match(ui.status(),/1 words/);assert.match(ui.status(),/6 characters/);
  await ui.workspace.openNote('One.md');ui.frame();ui.frame();ui.drain();assert.match(ui.status(),/2 words/);
  await ui.workspace.openNote('Two.md');ui.frame();ui.frame();assert.equal(ui.idle.size,0);assert.match(ui.status(),/6 characters/);
});

test('vault replacement and destruction cancel callbacks and deny late publications',async t=>{
  const ui=await setup(t,{'Old.md':'Old source'});await ui.workspace.openNote('Old.md');ui.frame();ui.frame();const old=[...ui.idle.values()][0];
  await ui.workspace.openVault({adapter:new MemoryAdapter({'Fresh.md':'Fresh'}),id:'test:fresh-counts',label:'Fresh'});await ui.workspace.openNote('Fresh.md');
  old({didTimeout:false,timeRemaining:()=>8});ui.frame();ui.frame();ui.drain();assert.match(ui.status(),/5 characters/);
  ui.type('Still editable while counts are held');ui.frame();ui.frame();const late=[...ui.idle.values()][0];assert.ok(late);
  await ui.workspace.destroy();assert.equal(ui.idle.size,0);assert.equal(ui.frames.size,0);
  late({didTimeout:false,timeRemaining:()=>8});assert.equal(ui.root.childElementCount,0);
});

test('browsers without requestIdleCallback still update counts after paint through yielding timers',async t=>{
  const ui=await setup(t,{'Note.md':'Fallback 🌱 text'});
  Object.defineProperty(ui.dom.window,'requestIdleCallback',{configurable:true,value:undefined});
  await ui.workspace.openNote('Note.md');assert.match(ui.status(),/… words/);ui.frame();ui.frame();
  const end=Date.now()+1000;while(ui.status().includes('…')){if(Date.now()>end)assert.fail('fallback counts did not finish');await new Promise(resolve=>setTimeout(resolve,5));}
  assert.match(ui.status(),/3 words/);assert.match(ui.status(),/15 characters/);
});
