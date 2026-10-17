import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {BaseController, createBaseMutationHost} from '../src/bases/controller.ts';
import {createBaseSession} from '../src/bases/session.ts';

const config=(names=['First','Target'])=>`unknownRoot: keep\nfilters: 'file.ext == "md"'\nviews:\n${names.map(name=>`  - {type: table, name: ${name}, order: [file.name, status], unknownView: ${name}}`).join('\n')}\n`;
async function fixture(){
  const vault=new Vault(new MemoryAdapter({'Work.base':config(),'One.md':'---\nstatus: Todo\n---\nbody'}));await vault.initialize();
  const buffers=new Map<string,NoteBuffer>();
  const host={validate(){},async getBuffer(path:string){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});buffers.set(path,buffer);}await buffer.load();return buffer;}};
  return{vault,host,async dispose(){for(const buffer of buffers.values())await buffer.dispose();}};
}

test('named controller re-resolves before publishing and configuration edits target the new index',async()=>{
  const f=await fixture(),published:string[]=[];
  const controller=new BaseController({vault:f.vault,basePath:'Work.base',viewName:'Target',mutations:createBaseMutationHost(f.host),onChange:s=>{if(!s.error&&s.result)published.push(s.result.view.name);}});
  try{
    await controller.refresh();assert.equal(controller.selectedViewIndex,1);
    await f.vault.modify('Work.base',config(['Target','First']));await controller.refresh();assert.equal(controller.selectedViewIndex,0);
    await controller.updateView(controller.state.version,{limit:7});
    const document=BaseDocument.parse(await f.vault.read('Work.base'));
    assert.equal(document.views[0].limit,7);assert.equal(document.views[1].limit,undefined);
    assert.equal(document.getRoot('unknownRoot'),'keep');assert.equal(document.views[0].unknownView,'Target');
    assert.ok(published.every(name=>name==='Target'));
  }finally{controller.dispose();await f.dispose();}
});

test('missing exact name reports error and blocks stale mutations until restored',async()=>{
  const f=await fixture(),controller=new BaseController({vault:f.vault,basePath:'Work.base',viewName:'Target',mutations:createBaseMutationHost(f.host)});
  try{
    await controller.refresh();const version=controller.state.version;
    await f.vault.modify('Work.base',config(['First','target']));await controller.refresh();assert.match(controller.state.error!.message,/not found: Target/);
    await assert.rejects(controller.editProperty({version,path:'One.md',property:'status',value:'wrong'}),/stale/);
    await assert.rejects(controller.setView(0),/not found: Target/);
    await f.vault.modify('Work.base',config(['Target','First']));await controller.refresh();assert.equal(controller.state.error,null);assert.equal(controller.state.result!.view.name,'Target');
  }finally{controller.dispose();await f.dispose();}
});

test('explicit named selection follows the chosen name while unbound selection remains positional',async()=>{
  const f=await fixture(),mutations=createBaseMutationHost(f.host);
  const bound=new BaseController({vault:f.vault,basePath:'Work.base',viewName:'Target',mutations});
  const unbound=new BaseController({vault:f.vault,basePath:'Work.base',query:{viewIndex:1},mutations});
  try{
    await bound.refresh();await unbound.refresh();await bound.setView(0);
    await f.vault.modify('Work.base',config(['Target','First']));await bound.refresh();await unbound.refresh();
    assert.equal(bound.state.result!.view.name,'First');assert.equal(bound.selectedViewIndex,1);assert.equal(unbound.state.result!.view.name,'First');
    await unbound.setView(0);assert.equal(unbound.state.result!.view.name,'Target');
  }finally{bound.dispose();unbound.dispose();await f.dispose();}
});

test('named selection during an in-flight refresh never publishes the previous selection',async()=>{
  const f=await fixture(),published:string[]=[];
  const controller=new BaseController({vault:f.vault,basePath:'Work.base',viewName:'Target',mutations:createBaseMutationHost(f.host),onChange:s=>{if(!s.error)published.push(s.result!.view.name);}});
  const read=f.vault.read.bind(f.vault);let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});let delay=true;
  try{
    await controller.refresh();published.length=0;
    f.vault.read=async path=>{if(delay&&path==='Work.base'){delay=false;started();await gate;}return read(path);};
    const refreshing=controller.refresh();await ready;const selecting=controller.setView(0);release();await Promise.all([refreshing,selecting]);
    assert.deepEqual(published,['First']);
  }finally{release?.();f.vault.read=read;controller.dispose();await f.dispose();}
});

test('real session retains active draft through named reorder/removal and synchronizes selector after cancellation',async()=>{
  const f=await fixture(),dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!;
  const session=createBaseSession(host,{vault:f.vault,basePath:'Work.base',viewName:'Target',buffers:f.host,validate(){},openFile(){}});
  const key=(node:Element,value:string)=>node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
  try{
    await session.ready;assert.equal(host.querySelector('select')!.value,'1');
    const cell=host.querySelector('[data-property="note.status"][role="gridcell"]')!;key(cell,'Enter');const input=cell.querySelector('input')!;input.value='retained draft';
    await f.vault.modify('Work.base',config(['Target','First']));await session.refresh();assert.equal(input.isConnected,true);assert.equal(input.value,'retained draft');
    await f.vault.modify('Work.base',config(['First']));await session.refresh();assert.equal(input.isConnected,true);assert.match(host.textContent!,/not found: Target/);
    await assert.rejects(session.close(),/Finish or cancel/);
    key(input,'Escape');await f.vault.modify('Work.base',config(['Target','First']));await session.refresh();
    assert.equal(session.state.result!.view.name,'Target');assert.equal(host.querySelector('select')!.value,'0');
    await session.selectView(1);await f.vault.modify('Work.base',config(['First','Target']));await session.refresh();
    assert.equal(session.state.result!.view.name,'First');assert.equal(host.querySelector('select')!.value,'0');
  }finally{for(const input of host.querySelectorAll('input'))key(input,'Escape');await session.close();await f.dispose();dom.window.close();}
});
