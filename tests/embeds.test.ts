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
