import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {EditorHandle,EditorOptions} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {draftMetadataHarness,until} from './helpers/draft-metadata.ts';
async function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><main></main>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const core=draftMetadataHarness(),adapter=new MemoryAdapter({'One.md':'# Saved','Two.md':'# Second','Board.canvas':'{"nodes":[],"edges":[]}'}),root=document.querySelector<HTMLElement>('main')!,editors:{options:EditorOptions;refreshes:number}[]=[];
  const workspace=new Workspace(root,(host,options):EditorHandle=>{const input=document.createElement('textarea');input.value=options.value;host.append(input);const row={options,refreshes:0};editors.push(row);const stop=options.subscribeMetadata?.(()=>row.refreshes++);return {getValue:()=>input.value,setValue:v=>{input.value=v;},focus:()=>input.focus(),destroy:()=>{stop?.();input.remove();},insert:v=>{input.value+=v;options.onChange(input.value);}};});
  let releases=0;await workspace.start({adapter,id:'test:transient-metadata',label:'Draft metadata',release:async()=>{releases++;}});Object.defineProperty(adapter,'documentSemantics',{value:{draftsAvailable:true,drafts:core.service}});
  await workspace.openNote('One.md');const internal=workspace as any;
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
  return {workspace,internal,core,adapter,root,editors,get releases(){return releases;},outline(){internal.rightTab='outline';internal.renderRight();return root.querySelector<HTMLElement>('.right-content')!;}};
}
test('dirty outline receives exact core facts asynchronously with explicit pending and no pane rerender',async t=>{
  const ui=await setup(t),pane=ui.workspace.activePane,editor=pane.editor!,options=ui.editors.at(-1)!.options,outline=ui.outline();assert.equal(outline.querySelector('.outline-row')?.textContent,'Saved');assert.equal(ui.core.events.length,0);
  let renders=0;const render=ui.internal.renderPane;ui.internal.renderPane=()=>{renders++;assert.fail('metadata cannot rerender a pane');};
  const gate=ui.core.holdRequest();options.onChange('# Local text');await until(()=>ui.core.events.some(e=>e.op==='request'));assert.match(outline.textContent!,/Updating outline/);assert.doesNotMatch(outline.textContent!,/No headings found|Local text/);
  gate.resolve();await until(()=>outline.querySelector('.outline-row')?.textContent==='Rust supplied heading');assert.equal(pane.editor,editor);assert.equal(renders,0);assert.ok(ui.editors.at(-1)!.refreshes>0);ui.internal.renderPane=render;
});
test('both normal and Canvas metadata callbacks share one buffer analysis and fail closed while pending',async t=>{
  const ui=await setup(t),buffer=ui.workspace.buffers.get('One.md')!,gate=ui.core.holdRequest();buffer.update('# Draft');
  const normal=ui.editors.at(-1)!.options.wiki!,services=ui.internal.canvasEditorServices('Board.canvas',()=>ui.workspace.activePane,()=>{}),canvas=services.options.wiki;
  try{assert.equal(normal.metadata!('One.md')!.headings,undefined);assert.equal(canvas.metadata('One.md').aliases,undefined);await until(()=>ui.core.events.some(e=>e.op==='request'));assert.equal(ui.core.events.filter(e=>e.op==='request').length,1);gate.resolve();await until(()=>!!buffer.getMetadata());
    assert.equal(normal.metadata!('One.md')!.headings,buffer.getMetadata()!.headings);assert.equal(canvas.metadata('One.md').headings,buffer.getMetadata()!.headings);assert.equal(ui.core.events.filter(e=>e.op==='request').length,1);
  }finally{services.embeds.destroy();await services.baseSessions.close();}
});
test('capable failures show unavailable rather than parsed or empty dirty outline',async t=>{
  const ui=await setup(t);ui.core.invalidFacts();const outline=ui.outline();ui.editors.at(-1)!.options.onChange('# TS heading');await until(()=>outline.dataset.metadataStatus==='unavailable');assert.match(outline.textContent!,/unavailable/);assert.doesNotMatch(outline.textContent!,/TS heading|No headings found/);assert.equal(outline.querySelectorAll('.outline-row').length,0);
});
test('an old outline action cannot scroll after actual buffer revision or pane intent changes',async t=>{
  const ui=await setup(t),outline=ui.outline(),old=outline.querySelector<HTMLButtonElement>('.outline-row')!,target=document.createElement('div');target.id='heading-0';ui.workspace.activePane.element.append(target);let scrolls=0;target.scrollIntoView=()=>scrolls++;
  ui.editors.at(-1)!.options.onChange('# New draft');old.click();assert.equal(scrolls,0);await until(()=>outline.querySelector('.outline-row')?.textContent==='Rust supplied heading');const row=outline.querySelector<HTMLButtonElement>('.outline-row')!;
  await ui.workspace.openNote('Two.md');row.click();assert.equal(scrolls,0);
});
test('vault replacement waits draft owner acknowledgement before platform release and late facts cannot repaint',async t=>{
  const ui=await setup(t),outline=ui.outline(),gate=ui.core.holdRequest();ui.editors.at(-1)!.options.onChange('draft');await until(()=>ui.core.events.some(e=>e.op==='request'));
  let done=false;const opening=ui.workspace.openVault({adapter:new MemoryAdapter({'New.md':'# New'}),id:'test:new-draft-owner',label:'New'}).then(()=>{done=true;});await until(()=>ui.core.events.some(e=>e.op==='release_buffer'));assert.equal(done,false);assert.equal(ui.releases,0);gate.resolve();await opening;assert.equal(ui.core.subscriptions,0);assert.equal(ui.core.jobs.size,0);assert.equal(ui.releases,1);assert.doesNotMatch(outline.textContent??'',/Rust supplied heading/);
});

test('later buffer close failure preserves earlier completed retirement and Workspace teardown retry',async t=>{
  const ui=await setup(t);ui.outline();ui.editors.at(-1)!.options.onChange('first draft');const first=ui.workspace.buffers.get('One.md')!;await until(()=>first.metadataState?.status==='current');
  const second=await ui.internal.bufferFor('Two.md');second.update('second draft');second.getMetadata();await until(()=>second.metadataState?.status==='current');
  const request=ui.core.events.filter(e=>e.op==='request').at(-1)!;assert.equal(request.op,'request');const lease=request.buffer_lifetime;ui.core.failRelease(lease);
  await assert.rejects(ui.workspace.destroy());assert.equal(ui.releases,0);assert.equal(first.error,null);assert.equal(second.error,null);assert.equal(second.dirty,false);assert.throws(()=>first.update('too late'),/disposed/);
  ui.core.allowRelease(lease);await ui.workspace.flush();await ui.workspace.destroy();assert.equal(ui.releases,1);assert.equal(ui.core.subscriptions,0);assert.equal(ui.core.jobs.size,0);assert.equal(await ui.adapter.read('One.md'),'first draft');assert.equal(await ui.adapter.read('Two.md'),'second draft');
});
