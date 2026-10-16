import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachmentMenuItems, showAttachmentMenu } from '../src/ui/attachment-menus.ts';
import type { AttachmentMenuActions, AttachmentMenuTarget } from '../src/ui/attachment-menus.ts';
import type { ContextMenuRequest } from '../src/platform/context-menu.ts';

const target = (overrides: Partial<AttachmentMenuTarget> = {}): AttachmentMenuTarget => ({ surface:'embed', image:true, local:true, isAlive:()=>true, ...overrides });
const all = Object.fromEntries(['copyImage','swapFile','removeImage','resetSize','openInNewTab','openToRight','rename','openExternal','reveal','deleteImage'].map(key=>[key,()=>{}])) as AttachmentMenuActions;
const labels = (items:ReturnType<typeof attachmentMenuItems>) => items.map(item=>'type' in item?'---':'label' in item?item.label:undefined);

test('local image actions preserve image/open/action/system/danger section order',()=>{
  const items=attachmentMenuItems(target({hasSize:true,isMac:true}),all);
  assert.deepEqual(labels(items),['Copy image','Swap file...','Remove image','Reset size','---','Open in new tab','Open to the right','---','Rename...','---','Open in default app','Reveal in Finder','---','Delete image']);
  assert.equal(items.find(item=>'id' in item&&item.id==='resetSize')?.['enabled'],true);
});

test('external images lack local file actions; reset is disabled without a width',()=>{
  const items=attachmentMenuItems(target({local:false}),all);
  assert.deepEqual(labels(items),['Copy image','Remove image','Reset size']);
  const reset=items.find(item=>'id' in item&&item.id==='resetSize');
  assert.equal(reset&&'enabled' in reset?reset.enabled:undefined,false);
  assert.deepEqual(attachmentMenuItems(target(),{}),[]);
  assert.deepEqual(labels(attachmentMenuItems(target({surface:'standalone'}),all)),['Copy image','---','Open in new tab','Open to the right','---','Rename...','---','Open in default app','Show in system explorer']);
  assert.deepEqual(labels(attachmentMenuItems(target({image:false}),{copyImage(){},openInNewTab(){}})),['Open in new tab']);
});

test('menu replies dispatch only offered enabled actions and preserve dismissal',async t=>{
  const dom=new JSDOM('<body></body>');t.after(()=>dom.window.close());
  let reply:string|null='copyImage',calls=0,requests:ContextMenuRequest[]=[];
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:async(request:ContextMenuRequest)=>{requests.push(request);return reply;}}});
  const event=()=>new dom.window.MouseEvent('contextmenu',{cancelable:true,view:dom.window});
  const actions={copyImage(){calls++;},resetSize(){calls+=100;}};
  const first=event();await showAttachmentMenu(first,target(),actions);assert.equal(first.defaultPrevented,true);assert.equal(calls,1);
  for(reply of ['resetSize','reveal','onError',null])await showAttachmentMenu(event(),target(),actions);
  assert.equal(calls,1);assert.equal(requests.length,5);
  const prevented=event();prevented.preventDefault();await showAttachmentMenu(prevented,target(),actions);
  await showAttachmentMenu(event(),target(),{});assert.equal(requests.length,5);
});

test('delayed replies and errors cannot act on a retired owner',async t=>{
  const dom=new JSDOM('<body></body>');t.after(()=>dom.window.close());
  let resolve!:(id:string)=>void,alive=true,calls=0,errors=0;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:()=>new Promise<string>(finish=>{resolve=finish;})}});
  const event=()=>new dom.window.MouseEvent('contextmenu',{view:dom.window});
  const context=target({isAlive:()=>alive});
  const pending=showAttachmentMenu(event(),context,{copyImage(){calls++;}});
  alive=false;resolve('copyImage');await pending;assert.equal(calls,0);
  alive=true;
  const failing=showAttachmentMenu(event(),context,{copyImage(){throw new Error('copy failed');},onError(){errors++;}});
  resolve('copyImage');await failing;assert.equal(errors,1);
});
