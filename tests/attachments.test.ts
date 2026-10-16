import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { AttachmentResources, attachmentType, imageAlt } from '../src/ui/attachments.ts';
import { createImageView, openImageLightbox } from '../src/ui/image-view.ts';
import { MarkdownEmbeds } from '../src/ui/embeds.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';

async function until(predicate:()=>boolean,label:string){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(label);}
function dom(t:TestContext){
  const instance=new JSDOM('<!doctype html><button id="previous">Before</button><main></main>');
  const prior=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:instance.window.document});
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL,blobs=new Map<string,Blob>(),revoked:string[]=[];let count=0;
  URL.createObjectURL=blob=>{const key=`blob:test-${++count}`;blobs.set(key,blob);return key;};
  URL.revokeObjectURL=url=>{revoked.push(url);blobs.delete(url);};
  t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;instance.window.close();if(prior)Object.defineProperty(globalThis,'document',prior);else Reflect.deleteProperty(globalThis,'document');});
  return {instance,root:document.querySelector('main')!,blobs,revoked};
}
async function fixture(){const adapter=new MemoryAdapter({'Home.md':''});const vault=new Vault(adapter);await vault.initialize();await vault.createBinary('Picture.png',Uint8Array.of(0,255,128,10));return {adapter,vault};}

test('attachment MIME registration and dimension parser use integer final segments',()=>{
  assert.equal(attachmentType('Photo.JPG'),'image/jpeg');assert.equal(attachmentType('File.unknown'),'application/octet-stream');
  assert.deepEqual(imageAlt('caption| 0200 x 0100 '),{alt:'caption',width:200,height:100});
  assert.deepEqual(imageAlt('100'),{alt:'',width:100});assert.deepEqual(imageAlt('caption|0x0'),{alt:'caption',width:0});
  assert.deepEqual(imageAlt('alt|with pipe|200'),{alt:'alt|with pipe',width:200});
  for(const value of ['20%','20px','20X30','x30','20.5','hello'])assert.deepEqual(imageAlt(value),{alt:value});
});

test('object URLs share bytes until last release and invalidate without revoking active leases',async t=>{
  const {blobs,revoked}=dom(t),{vault}=await fixture();const resources=new AttachmentResources(vault);t.after(()=>resources.destroy());
  let reads=0;const original=vault.readBinary.bind(vault);vault.readBinary=async path=>{reads++;return original(path);};
  const [one,two]=await Promise.all([resources.acquire('Picture.png'),resources.acquire('Picture.png')]);
  assert.equal(reads,1);assert.equal(one.url,two.url);assert.equal(one.type,'image/png');
  assert.deepEqual(new Uint8Array(await blobs.get(one.url)!.arrayBuffer()),Uint8Array.of(0,255,128,10));
  await vault.modifyBinary('Picture.png',Uint8Array.of(22,33));const newer=await resources.acquire('Picture.png');
  assert.notEqual(newer.url,one.url);assert.deepEqual(revoked,[]);
  one.release();one.release();assert.deepEqual(revoked,[]);two.release();assert.deepEqual(revoked,[one.url]);
  newer.release();assert.equal(blobs.size,0);
});

test('closing resources during pending I/O prevents late object URLs and future reads',async t=>{
  const {blobs}=dom(t),{vault}=await fixture();let finish!:(bytes:Uint8Array)=>void;
  vault.readBinary=()=>new Promise(resolve=>finish=resolve);
  const resources=new AttachmentResources(vault),pending=resources.acquire('Picture.png');
  await new Promise(resolve=>setImmediate(resolve));resources.destroy();finish(Uint8Array.of(1));
  await assert.rejects(pending,/closed/);assert.equal(blobs.size,0);await assert.rejects(resources.acquire('Picture.png'),/closed/);
});

test('standalone image owns its byte resource and opens a separately owned lightbox',async t=>{
  const {root,blobs,instance}=dom(t),{vault}=await fixture();const resources=new AttachmentResources(vault);
  const view=createImageView(root,'Picture.png',resources);t.after(()=>{view.destroy();resources.destroy();});
  await until(()=>!!root.querySelector('img')?.src,'image source');assert.equal(blobs.size,1);
  root.querySelector('img')!.click();await until(()=>!!document.querySelector('.image-lightbox img')?.getAttribute('src'),'lightbox source');
  assert.equal(blobs.size,1);
  document.querySelector('.image-lightbox')!.dispatchEvent(new instance.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(document.querySelector('.image-lightbox'),null);assert.equal(blobs.size,1);
  view.destroy();assert.equal(blobs.size,0);
});

test('lightbox keyboard zoom clamps, gallery wraps and closing restores focus',async t=>{
  const {instance}=dom(t);let released=0;
  const load=(id:number)=>async()=>({url:`blob:${id}`,type:'image/png',release(){released++;}});
  const previous=document.getElementById('previous')!;previous.focus();
  const view=openImageLightbox([{alt:'one',load:load(1)},{alt:'two',load:load(2)}]);t.after(()=>view.destroy());
  const overlay=document.querySelector<HTMLElement>('.image-lightbox')!;
  const key=(key:string)=>overlay.dispatchEvent(new instance.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  await until(()=>document.querySelector('img')?.getAttribute('src')==='blob:1','first image');
  key('=');assert.match(document.querySelector('.image-lightbox-status')!.textContent!,/120%/);
  for(let i=0;i<30;i++)key('=');assert.match(document.querySelector('.image-lightbox-status')!.textContent!,/1000%/);
  key('ArrowLeft');await until(()=>document.querySelector('img')?.alt==='two'&&document.querySelector('img')?.getAttribute('src')==='blob:2','wrapped gallery');
  assert.match(document.querySelector('.image-lightbox-status')!.textContent!,/100%/);
  key('Escape');assert.equal(document.activeElement,previous);assert.equal(released,2);
});

test('wiki and Markdown images use lossless local resources with alt/dimensions and no note reads',async t=>{
  const {root,blobs}=dom(t),{vault}=await fixture();const resources=new AttachmentResources(vault);let textReads=0;
  const embeds=new MarkdownEmbeds({vault,resources,read:async()=>{textReads++;return '';},open:()=>{}});
  t.after(()=>{embeds.destroy();resources.destroy();});
  renderMarkdown(root,'![[Picture.png|caption|120x80]]\n![](<Picture.png>)',()=>{},undefined,{embed:request=>embeds.render(request,'Home.md')});
  await until(()=>[...root.querySelectorAll('img')].filter(img=>!!img.getAttribute('src')).length===2,'two image embeds');
  const [one,two]=root.querySelectorAll('img');assert.equal(one.alt,'caption');assert.equal(one.width,120);assert.equal(one.height,80);assert.equal(two.alt,'');
  assert.equal(textReads,0);assert.equal(blobs.size,1);embeds.destroy();assert.equal(blobs.size,0);
});
