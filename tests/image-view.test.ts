import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createImageView, openImageLightbox } from '../src/ui/image-view.ts';
import type { AttachmentResources, AttachmentLease } from '../src/ui/attachments.ts';
import type { ContextMenuRequest } from '../src/platform/context-menu.ts';

function setup(t:TestContext){
  const dom=new JSDOM('<body><main></main></body>'),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  t.after(()=>{dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');});
  const requests:ContextMenuRequest[]=[];let reply:string|null=null;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:async(request:ContextMenuRequest)=>{requests.push(request);return reply;}}});
  return {dom,root:document.querySelector('main')!,requests,setReply:(value:string|null)=>{reply=value;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const resources=(lease:AttachmentLease)=>({acquire:async()=>lease}) as AttachmentResources;
const event=(dom:JSDOM,node:Element)=>node.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));

test('standalone menu exposes only host capabilities and copies bytes rather than object URLs',async t=>{
  const {dom,root,requests,setReply}=setup(t),copied:unknown[][]=[],opened:string[]=[],revealed:string[]=[];
  const lease={url:'blob:owned',type:'image/png',arrayBuffer:async()=>Uint8Array.of(0,255,9).buffer,release(){}};
  const view=createImageView(root,'Assets/photo.png',resources(lease),{copyImage:(...args)=>{copied.push(args);},openExternal:path=>{opened.push(path);},reveal:path=>{revealed.push(path);},isMac:true});t.after(()=>view.destroy());
  await tick();const image=root.querySelector('img')!;
  for(const id of ['copyImage','openExternal','reveal']){setReply(id);event(dom,image);await tick();}
  assert.deepEqual(requests[0].items.map(item=>'type' in item?'---':'label' in item?item.label:undefined),['Copy image','---','Open in default app','Reveal in Finder']);
  assert.deepEqual(new Uint8Array(copied[0][0] as ArrayBuffer),Uint8Array.of(0,255,9));assert.deepEqual(copied[0].slice(1),['image/png','Assets/photo.png']);
  assert.deepEqual(opened,['Assets/photo.png']);assert.deepEqual(revealed,['Assets/photo.png']);
});

test('no capabilities leaves the browser context event untouched',async t=>{
  const {dom,root,requests}=setup(t);const view=createImageView(root,'photo.png',resources({url:'blob:x',type:'image/png',release(){}}));t.after(()=>view.destroy());
  await tick();assert.equal(event(dom,root.querySelector('img')!),true);assert.equal(requests.length,0);
});

test('destroying viewer during menu reply or byte read cancels the host side effect',async t=>{
  const {dom,root,setReply}=setup(t);let copied=0,released=0,finish!:(bytes:ArrayBuffer)=>void;
  const view=createImageView(root,'photo.png',resources({url:'blob:x',type:'image/png',arrayBuffer:()=>new Promise(resolve=>{finish=resolve;}),release(){released++;}}),{copyImage(){copied++;}});
  await tick();setReply('copyImage');event(dom,root.querySelector('img')!);await tick();view.destroy();finish(new ArrayBuffer(1));await tick();
  assert.equal(copied,0);assert.equal(released,1);
  let reply!:(id:string)=>void,opened=0;
  dom.window.zorid.showContextMenu=()=>new Promise(resolve=>{reply=resolve;});
  const next=createImageView(root,'next.png',resources({url:'blob:next',type:'image/png',release(){}}),{openExternal(){opened++;}});
  await tick();event(dom,root.querySelector('img')!);next.destroy();reply('openExternal');await tick();assert.equal(opened,0);
});

test('a newer menu supersedes a delayed older reply and copy failures reach the live owner',async t=>{
  const {dom,root}=setup(t);const replies:((id:string)=>void)[]=[],errors:unknown[]=[];let opened=0;
  dom.window.zorid.showContextMenu=()=>new Promise(resolve=>replies.push(resolve));
  const view=createImageView(root,'photo.png',resources({url:'blob:x',type:'image/png',arrayBuffer:async()=>{throw new Error('bytes failed');},release(){}}),{openExternal(){opened++;},copyImage(){assert.fail('cannot copy missing bytes');},onError:error=>errors.push(error)});t.after(()=>view.destroy());
  await tick();const image=root.querySelector('img')!;event(dom,image);event(dom,image);
  replies[0]('openExternal');replies[1]('copyImage');await tick();assert.equal(opened,0);assert.equal(errors.length,1);assert.match(String(errors[0]),/bytes failed/);
});

test('image busy spans acquisition and decoding, then clears on load, error and late disposal',async t=>{
  const {dom,root}=setup(t);let resolve!:(lease:AttachmentLease)=>void,released=0;
  const view=createImageView(root,'photo.png',{acquire:()=>new Promise(r=>{resolve=r;})} as AttachmentResources);
  const container=root.querySelector<HTMLElement>('.image-container')!,image=root.querySelector('img')!;
  assert.equal(container.dataset.nativeLoading,'true');assert.equal(container.getAttribute('aria-busy'),'true');
  resolve({url:'blob:owned',type:'image/png',release(){released++;}});await tick();
  assert.equal(container.dataset.nativeLoading,'true','URL acquisition is not decoded image success');
  image.dispatchEvent(new dom.window.Event('load'));assert.equal(container.hasAttribute('data-native-loading'),false);assert.equal(container.getAttribute('aria-busy'),'false');
  view.destroy();assert.equal(released,1);
  const failed=createImageView(root,'bad.png',resources({url:'blob:bad',type:'image/png',release(){}}));await tick();
  const failedNode=root.querySelector<HTMLElement>('.image-container')!;root.querySelector('img')!.dispatchEvent(new dom.window.Event('error'));
  assert.equal(failedNode.getAttribute('aria-busy'),'false');assert.match(failedNode.textContent!,/Unable to display/);failed.destroy();
  const late=createImageView(root,'late.png',{acquire:()=>new Promise(r=>{resolve=r;})} as AttachmentResources);
  const removed=root.querySelector<HTMLElement>('.image-container')!;late.destroy();resolve({url:'blob:late',type:'image/png',release(){released++;}});await tick();
  assert.equal(removed.getAttribute('aria-busy'),'false');assert.equal(removed.hasAttribute('data-native-loading'),false);assert.equal(released,2);assert.equal(root.querySelector('img'),null);
});

test('lightbox stale acquisition and callbacks cannot settle a newer image load',async t=>{
  const {dom}=setup(t);let first!:(lease:AttachmentLease)=>void,second!:(lease:AttachmentLease)=>void,releases=0;
  const view=openImageLightbox([{alt:'first',load:()=>new Promise(r=>{first=r;})},{alt:'second',load:()=>new Promise(r=>{second=r;})}]);
  const stage=document.querySelector<HTMLElement>('.image-lightbox-stage')!,overlay=document.querySelector<HTMLElement>('.image-lightbox')!;
  assert.equal(stage.dataset.nativeLoading,'true');overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  first({url:'blob:first',type:'image/png',release(){releases++;}});await tick();assert.equal(releases,1);assert.equal(stage.dataset.nativeLoading,'true');
  second({url:'blob:second',type:'image/png',release(){releases++;}});await tick();
  stage.querySelector('img')!.dispatchEvent(new dom.window.Event('error'));assert.equal(stage.getAttribute('aria-busy'),'false');assert.match(overlay.textContent!,/Unable to display/);
  view.destroy();assert.equal(releases,2);assert.equal(stage.hasAttribute('data-native-loading'),false);
});

test('image acquisition rejection clears loading and displays its existing error',async t=>{
  const {root}=setup(t);const view=createImageView(root,'bad.png',{acquire:async()=>{throw new Error('Storage unavailable');}} as unknown as AttachmentResources);
  await tick();const container=root.querySelector<HTMLElement>('.image-container')!;
  assert.equal(container.hasAttribute('data-native-loading'),false);assert.equal(container.getAttribute('aria-busy'),'false');assert.match(container.textContent!,/Storage unavailable/);view.destroy();
});

test('lightbox late decode callback and pending close leave the current generation loading state intact',async t=>{
  const {dom}=setup(t);let next!:(lease:AttachmentLease)=>void,releases=0;
  const lease=(url:string)=>({url,type:'image/png',release(){releases++;}});
  const view=openImageLightbox([{alt:'first',load:async()=>lease('blob:first')},{alt:'next',load:()=>new Promise(r=>{next=r;})}]);
  await tick();const overlay=document.querySelector<HTMLElement>('.image-lightbox')!,stage=overlay.querySelector<HTMLElement>('.image-lightbox-stage')!,image=stage.querySelector('img')!;
  const oldLoad=image.onload!;image.dispatchEvent(new dom.window.Event('load'));assert.equal(stage.getAttribute('aria-busy'),'false');
  overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(stage.dataset.nativeLoading,'true');
  oldLoad.call(image,new dom.window.Event('load'));assert.equal(stage.dataset.nativeLoading,'true');
  view.destroy();assert.equal(stage.getAttribute('aria-busy'),'false');next(lease('blob:late'));await tick();
  assert.equal(releases,2);assert.equal(stage.hasAttribute('data-native-loading'),false);assert.equal(document.querySelector('.image-lightbox'),null);
});
