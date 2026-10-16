import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { MarkdownEmbeds } from '../src/ui/embeds.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail(label);
}
async function setup(t: TestContext, seed: Record<string,string>, read?: (path: string) => Promise<string>) {
  const dom = new JSDOM('<!doctype html><main></main>');
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable:true, value:dom.window.document });
  const vault = new Vault(new MemoryAdapter(seed)); await vault.initialize();
  const opened: unknown[][] = [];
  const embeds = new MarkdownEmbeds({vault, open:(...args)=>opened.push(args), read});
  const container = document.querySelector('main')!;
  t.after(() => { embeds.destroy(); dom.window.close(); if(prior)Object.defineProperty(globalThis,'document',prior);else Reflect.deleteProperty(globalThis,'document'); });
  const render = (text: string, source: string) => renderMarkdown(container,text,()=>{},undefined,{embed:request=>embeds.render(request,source)});
  return {dom, vault, embeds, opened, container, render};
}

test('note and heading embeds resolve nested Markdown links from the embedded file', async t => {
  const {container,opened,render}=await setup(t,{
    'Home.md':'', 'Folder/Note.md':'# Keep\n[child](./Child.md)\n## Sub\nvisible\n# Other\nhidden', 'Folder/Child.md':'child',
  });
  render('![[Folder/Note#Keep]]','Home.md');
  await until(()=>!!container.querySelector('.markdown-embed-content'),'embed loads');
  assert.match(container.textContent!,/visible/);assert.doesNotMatch(container.textContent!,/hidden/);
  const child=[...container.querySelectorAll('a')].find(a=>a.textContent==='child')!;
  child.click();assert.deepEqual(opened,[['Folder/Note.md','./Child.md','markdown']]);
});

test('duplicate embeds share one read and targeted source updates refresh both', async t => {
  let reads=0;
  const {container,vault,render}=await setup(t,{'Home.md':'','Note.md':'Before'},async()=>{reads++;return reads===1?'Before':'After';});
  render('![[Note]]\n![[Note]]','Home.md');
  await until(()=>container.querySelectorAll('.markdown-embed-content').length===2,'both loaded');
  assert.equal(reads,1);
  await vault.modify('Note.md','After');
  await until(()=>[...container.querySelectorAll('.markdown-embed-content')].every(n=>n.textContent==='After'),'both refreshed');
  assert.equal(reads,2);
});

test('cycle errors are bounded and missing notes resolve after a file is created', async t => {
  const {container,vault,render}=await setup(t,{'Home.md':'','A.md':'![[B]]','B.md':'![[A]]'});
  render('![[A]]\n![[Missing]]','Home.md');
  await until(()=>container.textContent!.includes('Recursive embed'),'cycle detected');
  assert.equal(container.querySelectorAll('.markdown-embed').length,4);
  assert.match(container.textContent!,/File not found/);
  await vault.create('Missing.md','Appeared');
  await until(()=>container.textContent!.includes('Appeared'),'created note resolved');
});

test('destroy prevents a late read from inserting content into a closed pane', async t => {
  let finish!: (value:string)=>void;
  const pending=new Promise<string>(resolve=>finish=resolve);
  const {container,embeds,render}=await setup(t,{'Home.md':'','Note.md':'original'},()=>pending);
  render('![[Note]]','Home.md');
  await new Promise(resolve=>setImmediate(resolve));
  embeds.destroy();finish('Too late');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(container.querySelector('.markdown-embed-content'),null);
});

test('releasing one live widget prevents its late render while sibling embeds stay active', async t => {
  let finish!: (value:string)=>void;
  const pending=new Promise<string>(resolve=>finish=resolve);
  const {container,embeds,vault}=await setup(t,{'Home.md':'','Slow.md':'old','Keep.md':'kept'},path=>path==='Slow.md'?pending:Promise.resolve('kept'));
  const removed=embeds.render({target:'Slow',kind:'wiki'},'Home.md');
  const kept=embeds.render({target:'Keep',kind:'wiki'},'Home.md');
  container.append(removed,kept);
  await until(()=>!!kept.querySelector('.markdown-embed-content'),'sibling loads');
  embeds.releaseEmbed(removed);embeds.releaseEmbed(removed);removed.remove();finish('late');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(removed.querySelector('.markdown-embed-content'),null);
  assert.match(kept.textContent!,/kept/);
  await vault.modify('Keep.md','new');
  await until(()=>!!kept.querySelector('.markdown-embed-content'),'sibling still owns updates');
});

test('embeds cap concurrent source loads and skip code and escaped syntax', async t => {
  let active=0,maximum=0;
  const seed:Record<string,string>={'Home.md':''};for(let i=0;i<12;i++)seed[`Note ${i}.md`]=`Note ${i}`;
  const {container,render}=await setup(t,seed,async path=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return seed[path];});
  render(Array.from({length:12},(_,i)=>`![[Note ${i}]]`).join('\n')+'\n`![[Note 0]]`\n\\![[Note 0]]\n```\n![[Note 0]]\n```','Home.md');
  await until(()=>container.querySelectorAll('.markdown-embed-content').length===12,'all embeds complete');
  assert.equal(maximum,4);assert.equal(container.querySelectorAll('.markdown-embed').length,12);
});

async function pdfSetup(t:TestContext,contextMenu?: import('../src/ui/embeds.ts').EmbedOptions['contextMenu']){
  const {vault,container,dom}=await setup(t,{'Home.md':'','Folder/Note.md':''});await vault.createBinary('Folder/Document.PDF',new Uint8Array([1,2,3]));
  const {AttachmentResources}=await import('../src/ui/attachments.ts');const resources=new AttachmentResources(vault);
  let acquisitions=0;const acquire=resources.acquire.bind(resources);resources.acquire=path=>{acquisitions++;return acquire(path);};
  const calls:{node:HTMLElement;path:string;resources:typeof resources;options:import('../src/ui/pdf-view.ts').PdfViewOptions;destroyed:number;reject:(error:Error)=>void}[]=[];
  const opens:string[]=[];
  const embeds=new MarkdownEmbeds({vault,resources,contextMenu,open(source,target){opens.push(source+':'+target);},pdfFactory(node,path,shared,options){
    let reject!:(error:Error)=>void;const ready=new Promise<void>((_,b)=>{reject=b;});const call={node,path,resources:shared,options:options??{},destroyed:0,reject};calls.push(call);
    const marker=dom.window.document.createElement('div');marker.className='fake-pdf-view';node.append(marker);
    return {ready,destroy(){call.destroyed++;marker.remove();},goToPage(){},setScale(){},rotate(){},showSearch(){},applySubpath(){},getSelectionSubpath(){return null;}};
  }});
  t.after(()=>{embeds.destroy();resources.destroy();});
  return {vault,container,embeds,calls,resources,opens,dom,get acquisitions(){return acquisitions;}};
}

test('local PDF embeds use the shared viewer with exact subpath and no duplicate outer lease',async t=>{
  const f=await pdfSetup(t),node=f.embeds.render({target:'Folder/Document.PDF#page=2&selection=0,1,2,3&height=300',kind:'wiki'},'Home.md');f.container.append(node);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'Folder/Document.PDF');assert.equal(f.calls[0].resources,f.resources);
  assert.equal(f.calls[0].options.embed,true);assert.equal(f.calls[0].options.subpath,'#page=2&selection=0,1,2,3&height=300');assert.equal(typeof f.calls[0].options.onOpenMenu,'function');assert.equal(node.querySelector('.embed-open'),null);assert.equal(f.acquisitions,0);
  assert.ok(node.classList.contains('pdf-embed'));assert.equal(node.querySelectorAll('.fake-pdf-view').length,1);
  assert.doesNotMatch(node.textContent??'',/not implemented/);
});

test('PDF modifications dispose the previous view before replacement, and unmount disposes only its owner',async t=>{
  const f=await pdfSetup(t),first=f.embeds.render({target:'Folder/Document.PDF',kind:'wiki'},'Home.md'),second=f.embeds.render({target:'./Document.PDF#page=3',kind:'markdown'},'Folder/Note.md');f.container.append(first,second);
  assert.equal(f.calls.length,2);await f.vault.modifyBinary('Folder/Document.PDF',new Uint8Array([4,5,6]));
  assert.equal(f.calls.length,4);assert.equal(f.calls[0].destroyed,1);assert.equal(f.calls[1].destroyed,1);assert.equal(f.calls[2].destroyed,0);
  f.embeds.releaseEmbed(first);f.embeds.releaseEmbed(first);assert.equal(f.calls[2].destroyed,1);assert.equal(f.calls[3].destroyed,0);
  f.embeds.destroy();assert.equal(f.calls[3].destroyed,1);assert.equal(f.calls[2].destroyed,1);
});

test('late PDF load rejection cannot append an error into a replacement or unmounted embed',async t=>{
  const f=await pdfSetup(t),node=f.embeds.render({target:'Folder/Document.PDF#page=2',kind:'wiki'},'Home.md');f.container.append(node);
  f.embeds.invalidate('Folder/Document.PDF');assert.equal(f.calls.length,2);f.calls[0].reject(new Error('old PDF failed'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(node.querySelector('.embed-error'),null);assert.equal(node.querySelectorAll('.fake-pdf-view').length,1);
  f.embeds.releaseEmbed(node);f.calls[1].reject(new Error('closed PDF failed'));await new Promise(resolve=>setImmediate(resolve));assert.equal(node.querySelector('.embed-error'),null);assert.equal(node.querySelector('.fake-pdf-view'),null);
});

test('deleting an embedded PDF releases its viewer and renders a missing-file result',async t=>{
  const f=await pdfSetup(t),node=f.embeds.render({target:'Folder/Document.PDF',kind:'wiki'},'Home.md');f.container.append(node);
  await f.vault.trash('Folder/Document.PDF');assert.equal(f.calls[0].destroyed,1);assert.equal(f.calls.length,1);assert.match(node.textContent??'',/File not found/);assert.equal(node.querySelector('.fake-pdf-view'),null);
});


test('PDF toolbar open menu forwards the live event and ignores replaced viewer controls',async t=>{
  const seen:MouseEvent[]=[];const f=await pdfSetup(t,event=>{seen.push(event);});
  const node=f.embeds.render({target:'Folder/Document.PDF#page=2',kind:'wiki'},'Home.md');f.container.append(node);
  const event=new f.dom.window.MouseEvent('click',{clientX:23,clientY:34});
  f.calls[0].options.onOpenMenu!(event);assert.equal(seen[0],event);
  f.embeds.invalidate('Folder/Document.PDF');f.calls[0].options.onOpenMenu!(event);assert.equal(seen.length,1);
  f.calls[1].options.onOpenMenu!(event);assert.equal(seen.length,2);
  f.embeds.releaseEmbed(node);f.calls[1].options.onOpenMenu!(event);assert.equal(seen.length,2);
});

test('PDF toolbar opens its source target when the host has no menu capability',async t=>{
  const f=await pdfSetup(t),node=f.embeds.render({target:'Folder/Document.PDF#page=2',kind:'wiki'},'Home.md');f.container.append(node);
  f.calls[0].options.onOpenMenu!(new f.dom.window.MouseEvent('click'));
  assert.deepEqual(f.opens,['Home.md:Folder/Document.PDF#page=2']);
});
