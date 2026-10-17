import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseViewActions } from '../src/bases/view-actions.ts';
const source='# retained\nextra: {nested: [keep]}\nviews:\n  - type: kanban\n    name: Board\n    groupBy: {property: status, direction: ASC, custom: preserved}\n    groupOrder: [A, B]\n  - type: table\n    name: Other\n';
async function fixture(adapter=new MemoryAdapter({'Board.base':source,'One.md':'---\nstatus: A\n---\nbody'}),gate?:Promise<void>){
 const vault=new Vault(adapter);await vault.initialize();const buffers=new Map<string,NoteBuffer>();
 const getBuffer=async(path:string)=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});buffers.set(path,buffer);}await buffer.load();return buffer;};
 const controller=new BaseController({vault,basePath:'Board.base',mutations:createBaseMutationHost({validate(){},async getBuffer(path){await gate;return getBuffer(path);}}),delayMs:1000});await controller.refresh();
 return{vault,controller,getBuffer,actions:createBaseViewActions(controller,{validate(){}}),async stop(){for(const buffer of buffers.values())await buffer.dispose();controller.dispose();}};
}

test('queued group order detaches nested caller values before buffer loading',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const f=await fixture(undefined,gate);
 try{const order:(string|{future:string[]})[]=['B',{future:['captured']}];const saving=f.actions.requestGroupOrder({version:f.controller.state.version,property:'status',order});(order[1] as {future:string[]}).future.push('later');order.reverse();release();await saving;const document=BaseDocument.parse(await f.vault.read('Board.base'));assert.deepEqual(document.views[0].groupOrder,['B',{future:['captured']}]);assert.deepEqual(document.views[0].groupBy,{property:'status',direction:'ASC',custom:'preserved'});assert.match(document.toString(),/# retained/);assert.equal(document.views[1].name,'Other');}finally{release();await f.stop();}
});

test('view switch while a group-order action awaits loading rejects the old selected view edit',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const f=await fixture(undefined,gate);
 try{const saving=f.actions.requestGroupOrder({version:f.controller.state.version,property:'status',order:['B','A']});const rejected=assert.rejects(saving,/stale/);await f.controller.setView(1);release();await rejected;assert.equal(await f.vault.read('Board.base'),source);}finally{release();await f.stop();}
});

test('same absolute config request retries a failed draft without accepting a different dirty patch',async()=>{
 class Failing extends MemoryAdapter{fail=false;override async write(path:string,text:string){if(this.fail&&path==='Board.base')throw Error('disk full');return super.write(path,text);}}
 const adapter=new Failing({'Board.base':source,'One.md':'---\nstatus: A\n---\nbody'}),f=await fixture(adapter);
 try{const request={version:f.controller.state.version,property:'status',order:['B','A']};adapter.fail=true;await assert.rejects(f.actions.requestGroupOrder(request),/disk full/);const buffer=await f.getBuffer('Board.base');assert.equal(buffer.dirty,true);await assert.rejects(f.actions.requestGroupOrder(request),/disk full/);await assert.rejects(f.actions.requestGroupOrder({...request,order:['A']}),/unsaved|external/);adapter.fail=false;await f.actions.requestGroupOrder(request);assert.deepEqual(BaseDocument.parse(await f.vault.read('Board.base')).views[0].groupOrder,['B','A']);assert.equal(buffer.dirty,false);}finally{adapter.fail=false;await f.stop();}
});

for (const invalidation of ['external config', 'controller disposal', 'source recreation'] as const) {
 test(`failed config draft cannot overwrite after ${invalidation}`,async()=>{
  class Failing extends MemoryAdapter {
   fail=false;
   override async write(path:string,text:string){if(this.fail&&path==='Board.base')throw Error('disk full');return super.write(path,text);}
  }
  const adapter=new Failing({'Board.base':source,'One.md':'---\nstatus: A\n---\nbody'}),f=await fixture(adapter);
  try {
   const request={version:f.controller.state.version,property:'status',order:['B','A']};
   adapter.fail=true;
   await assert.rejects(f.actions.requestGroupOrder(request),/disk full/);
   const buffer=await f.getBuffer('Board.base'),draft=buffer.text;
   assert.equal(buffer.dirty,true);
   adapter.fail=false;
   let disk=source;
   if(invalidation==='external config') {
    // Bypass Vault events to exercise the actual persisted-content guard.
    disk=source+'# changed externally\n';await adapter.write('Board.base',disk);
   } else if(invalidation==='controller disposal') f.controller.dispose();
   else {
    // Identical bytes are a distinct file lifetime and must not revive an old draft.
    await f.vault.trash('Board.base');await f.vault.create('Board.base',source);
   }
   await assert.rejects(f.actions.requestGroupOrder(request),/stale|changed|conflict/i);
   await assert.rejects(buffer.flush(),/stale|changed|conflict/i);
   assert.equal(await f.vault.read('Board.base'),disk);
   assert.equal(buffer.text,draft);assert.equal(buffer.dirty,true);
  } finally {
   adapter.fail=false;
   // Invalidated drafts intentionally remain unsaved; dispose still cancels its timer.
   try {await f.stop();} catch {f.controller.dispose();}
  }
 });
}
