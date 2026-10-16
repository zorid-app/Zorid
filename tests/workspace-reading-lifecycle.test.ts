import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { EditorHandle } from '../src/ui/editor.ts';

async function settle(){for(let index=0;index<20;index++)await Promise.resolve();}
async function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><main></main>',{url:'https://zorid.test/'}),doc=dom.window.document;
  const pending:{source:string;resolve:(node:HTMLElement)=>void}[]=[],workers:DeferredWorker[]=[];
  class DeferredWorker {
    onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;terminated=0;job:any;
    constructor(){workers.push(this);}
    postMessage(job:unknown){this.job=job;}
    terminate(){this.terminated++;}
    complete(){this.onmessage?.({data:{id:this.job.id,tokens:[{from:0,to:3,classes:['keyword']}]}});}
  }
  const previous=new Map<string,PropertyDescriptor|undefined>();
  const media=(query:string)=>({matches:false,media:query,addEventListener(){},removeEventListener(){}});
  for(const [key,value]of Object.entries({window:dom.window,document:doc,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,matchMedia:media,Worker:DeferredWorker})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=media as any;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const append=doc.head.append.bind(doc.head);
  doc.head.append=(...nodes:(Node|string)[])=>{
    append(...nodes);
    for(const node of nodes)if(typeof node!=='string'&&node instanceof dom.window.HTMLScriptElement&&node.dataset.zoridMathjax){
      (dom.window as any).MathJax={startup:{promise:Promise.resolve()},tex2chtmlPromise:(source:string)=>new Promise<HTMLElement>(resolve=>pending.push({source,resolve})),chtmlStylesheet:()=>null};
      queueMicrotask(()=>node.dispatchEvent(new dom.window.Event('load')));
    }
  };
  const workspace=new Workspace(doc.querySelector('main')!, (parent,options):EditorHandle=>{
    const input=doc.createElement('textarea');input.value=options.value;parent.append(input);
    return{getValue:()=>input.value,setValue:value=>input.value=value,focus:()=>input.focus(),destroy:()=>input.remove(),insert:value=>{input.value+=value;options.onChange(input.value);}};
  });
  let closed=false;const destroy=async()=>{if(!closed){await workspace.destroy();closed=true;}};
  t.after(async()=>{try{await destroy();dom.window.dispatchEvent(new dom.window.Event('pagehide'));await settle();}finally{dom.window.close();for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter:new MemoryAdapter({'Old.md':'$old$\n\n```js\nlet old = 1;\n```','New.md':'new'}),id:'reading-lifecycle',label:'test'});
  await workspace.openNote('Old.md');await(workspace as any).toggleReading();await settle();
  assert.equal(pending.length,1);assert.equal(workers.length,1);
  const pane=workspace.activePane,preview=pane.element.querySelector<HTMLElement>('.markdown-preview')!,math=preview.querySelector<HTMLElement>('.math')!,code=preview.querySelector<HTMLElement>('code')!,copy=preview.querySelector<HTMLButtonElement>('.zorid-code-copy')!,refresh=pane.refreshPreview!;
  const finish=async()=>{const node=doc.createElement('mjx-container');node.textContent='late output';pending[0].resolve(node);workers[0].complete();await settle();};
  return{workspace,dom,doc,pane,preview,math,code,copy,refresh,pending,workers,finish,destroy};
}

for(const action of ['navigation','mode','rerender','vault','destroy','split-close'] as const)test(`Reading ${action} disposes pending math and code before pane retirement`,async t=>{
  const ui=await setup(t);
  switch(action){
    case'navigation':await ui.workspace.openNote('New.md');break;
    case'mode':await(ui.workspace as any).toggleReading();break;
    case'rerender':await ui.workspace.renderPane(ui.pane);break;
    case'vault':await ui.workspace.openVault({adapter:new MemoryAdapter({'New.md':'new'}),id:'replacement',label:'replacement'});break;
    case'destroy':await ui.destroy();break;
    case'split-close':{
      await(ui.workspace as any).split('right');
      await(ui.workspace as any).closeTab(ui.pane,ui.pane.tabs.find(tab=>tab.id===ui.pane.active));break;
    }
  }
  assert.equal(ui.workers[0].terminated,1);
  assert.equal(ui.copy.onclick,null);
  await ui.finish();
  assert.equal(ui.math.textContent,'old');assert.equal(ui.math.classList.contains('is-loaded'),false);
  assert.equal(ui.code.classList.contains('is-highlighted'),false);
  const count=ui.preview.childNodes.length;ui.refresh();await settle();
  assert.equal(ui.preview.childNodes.length,count,'retired refresh must not recreate resources');
});

test('Reading refresh retires only old resources while new output remains live',async t=>{
  const ui=await setup(t);ui.refresh();await settle();
  const fresh=ui.preview.querySelector<HTMLElement>('.math')!;
  assert.notEqual(fresh,ui.math);assert.equal(ui.workers[0].terminated,1);assert.equal(ui.copy.onclick,null);
  await ui.finish();
  assert.equal(ui.math.textContent,'old');assert.equal(fresh.textContent,'late output');assert.ok(fresh.classList.contains('is-loaded'));
  assert.equal(ui.workers.length,2);ui.workers[1].complete();await settle();
  assert.ok(ui.preview.querySelector('code')!.classList.contains('is-highlighted'));
});

test('partial Reading render failure disposes already-created asynchronous output',async t=>{
  const ui=await setup(t);await ui.workspace.openNote('New.md');
  const original=ui.doc.createElement.bind(ui.doc);
  ui.doc.createElement=((name:string,options?:ElementCreationOptions)=>{
    if(name==='pre')throw new Error('injected renderer failure');
    const node=original(name,options);return node;
  }) as typeof ui.doc.createElement;
  await ui.workspace.openNote('Old.md');ui.doc.createElement=original;
  const failed=ui.pane.element.querySelector<HTMLElement>('.math')!;
  assert.ok(failed);assert.match(ui.pane.element.textContent??'',/injected renderer failure/);
  assert.equal(ui.pane.refreshPreview,undefined);await ui.finish();
  assert.equal(failed.textContent,'old');assert.equal(failed.classList.contains('is-loaded'),false);
});

test('failed in-place Reading refresh retires partial math output before propagating the error',async t=>{
  const ui=await setup(t),original=ui.doc.createElement.bind(ui.doc);
  ui.doc.createElement=((name:string,options?:ElementCreationOptions)=>{
    if(name==='pre')throw new Error('injected refresh failure');return original(name,options);
  }) as typeof ui.doc.createElement;
  try{assert.throws(()=>ui.refresh(),/injected refresh failure/);}finally{ui.doc.createElement=original;}
  const failed=ui.preview.querySelector<HTMLElement>('.math')!;
  assert.ok(failed);assert.equal(ui.pane.embeds,undefined);assert.equal(ui.workers[0].terminated,1);
  await ui.finish();assert.equal(failed.textContent,'old');assert.equal(failed.classList.contains('is-loaded'),false);
});
