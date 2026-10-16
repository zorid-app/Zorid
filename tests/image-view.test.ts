import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createImageView } from '../src/ui/image-view.ts';
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
