import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { BaseController } from '../src/bases/controller.ts';
import { createBaseViewActions } from '../src/bases/view-actions.ts';
const source = 'filters: file.ext == "md"\nviews:\n  - type: table\n    name: Table\n    order: [status]\n  - type: list\n    name: List\n    order: [status]\n';
const note = '---\nstatus: original\n---\nBody\n';
const settle = async () => { for (let i = 0; i < 2; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };
async function fixture(adapter = new MemoryAdapter({'Work.base':source, 'One.md':note}), gate?: Promise<void>) {
  const vault = new Vault(adapter); await vault.initialize();
  const dom = new JSDOM('<main></main>', {pretendToBeVisual:true});
  const container = dom.window.document.querySelector<HTMLElement>('main')!;
  const buffers = new Map<string,NoteBuffer>(), publications: {previous:string; next:string}[] = [];
  const getBuffer = async (path:string) => {
    let buffer = buffers.get(path);
    if (!buffer) { buffer = new NoteBuffer(vault,path,{debounceMs:60000}); buffers.set(path,buffer); }
    await buffer.load(); return buffer;
  };
  const session = createBaseSession(container,{vault,basePath:'Work.base',validate(){},openFile(){},buffers:{
    async getBuffer(path){ await gate; return getBuffer(path); }, validate(){},
    onBufferChange(_path,buffer,previous){publications.push({previous,next:buffer.text});},
  }});
  await session.ready;
  const key = (node:Element,key:string) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  const edit = (value:string) => {
    const cell = container.querySelector<HTMLElement>('[role=gridcell][data-property="note.status"]')!;
    assert.ok(cell); key(cell,'Enter'); const input = cell.querySelector<HTMLInputElement>('input')!; assert.ok(input); input.value=value; return input;
  };
  const stop = async () => {
    const input = container.querySelector('.zorid-bases-table-input,[data-base-editing] input,[data-base-editing] textarea'); if(input)key(input,'Escape');
    await session.close(); for(const buffer of buffers.values())await buffer.dispose(); dom.window.close();
  };
  return {vault,dom,container,buffers,getBuffer,session,key,edit,publications,stop};
}

test('close waits for an accepted action still loading its shared dirty buffer',async()=>{
  let release!:()=>void; const gate = new Promise<void>(resolve=>{release=resolve;});
  const f = await fixture(undefined,gate);
  try {
    const buffer = await f.getBuffer('One.md'); buffer.update(note+'Unsaved peer typing\n');
    const input=f.edit('new'); f.key(input,'Enter');
    let closed=false;const closing=f.session.close().then(()=>{closed=true;});await settle();
    assert.equal(closed,false); assert.ok(f.container.querySelector('.bases-session'));
    release();await closing;
    assert.match(await f.vault.read('One.md'),/status: new/);assert.match(await f.vault.read('One.md'),/Unsaved peer typing/);
    assert.equal(buffer.dirty,false);assert.equal(f.container.childElementCount,0);
    assert.equal(f.publications[0].previous,note+'Unsaved peer typing\n');
  } finally {release();await f.stop();}
});

test('persistent CAS failure preserves draft and session until retry and edit cancellation',async()=>{
  class Failing extends MemoryAdapter { fail=false; override async write(path:string,text:string){if(this.fail&&path==='One.md')throw Error('disk full');return super.write(path,text);} }
  const adapter=new Failing({'Work.base':source,'One.md':note}),f=await fixture(adapter);
  try {
    adapter.fail=true;const input=f.edit('new');f.key(input,'Enter');await settle();
    await assert.rejects(f.session.close(),/disk full/);
    assert.ok(f.container.querySelector('.bases-session'));const buffer=await f.getBuffer('One.md');assert.equal(buffer.dirty,true);assert.match(buffer.text,/status: new/);assert.equal(await f.vault.read('One.md'),note);
    adapter.fail=false;f.key(input,'Escape');await f.session.close();assert.match(await f.vault.read('One.md'),/status: new/);
  } finally {adapter.fail=false;await f.stop();}
});

test('unaccepted text drafts block view switching and closing without changing disk',async()=>{
 const f=await fixture();try{const input=f.edit('unfinished');await assert.rejects(f.session.selectView(1),/Finish or cancel/);await assert.rejects(f.session.close(),/Finish or cancel/);assert.equal(input.value,'unfinished');assert.equal(await f.vault.read('One.md'),note);f.key(input,'Escape');await f.session.selectView(1);assert.equal(f.session.state.result?.view.name,'List');}finally{await f.stop();}
});

test('a deferred successful result cannot clear a newer query error after cancelling a draft',async()=>{
 const f=await fixture();try{const input=f.edit('unfinished');await f.vault.modify('One.md',note.replace('original','changed'));await f.session.refresh();await f.vault.modify('Work.base','views: invalid');await f.session.refresh();assert.ok(f.session.state.error);f.key(input,'Escape');await settle();assert.equal(f.container.querySelector('.bases-session-status')?.textContent,f.session.state.error?.message);}finally{await f.stop();}
});

test('file.folder root group maps to a relative root filename',async()=>{
 const vault=new Vault(new MemoryAdapter({'Work.base':'views:\n  - type: kanban\n    name: Board\n    groupBy: {property: file.folder, direction: ASC}\n','Root.md':'root','Folder/One.md':'one'}));await vault.initialize();let destination:string|undefined;
 const controller=new BaseController({vault,basePath:'Work.base',mutations:{async transform(){throw Error('unused');},async rename(_path,target,validate){validate();destination=target;}},delayMs:1000});
 try{await controller.refresh();const result=controller.state.result!;const from=result.groups.find(group=>group.rows.some(row=>row.path==='Folder/One.md'))!;const to=result.groups.find(group=>group.key?.type==='string'&&group.key.value==='/')!;await createBaseViewActions(controller,{validate(){},canRename:true}).requestMove({version:result.version,path:'Folder/One.md',property:'file.folder',source:from.key!,destination:to.key!});assert.equal(destination,'One.md');}finally{controller.dispose();}
});

for (const type of ['cards','list'] as const) test(`${type} composing blur and pending save preserve source ownership until close completes`,async()=>{
 let release!:()=>void;
 class Delayed extends MemoryAdapter { gate?:Promise<void>; override async write(path:string,text:string){if(path==='One.md')await this.gate;return super.write(path,text);} }
 const config=source.replace('type: table',`type: ${type}`),adapter=new Delayed({'Work.base':config,'One.md':note});
 const f=await fixture(adapter);
 try {
  const cell=f.container.querySelector<HTMLElement>('[data-property="note.status"]')!;
  cell.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));
  const input=cell.querySelector<HTMLInputElement>('input')!;assert.ok(input);
  input.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='中';
  input.dispatchEvent(new f.dom.window.Event('blur'));
  f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
  const scroller=f.container.querySelector<HTMLElement>('.bases-virtual-scroll')!;scroller.scrollTop=10000;scroller.dispatchEvent(new f.dom.window.Event('scroll'));
  await assert.rejects(f.session.close(),/Finish or cancel/);
  assert.equal(input.isConnected,true);assert.equal(await f.vault.read('One.md'),note);
  adapter.gate=new Promise<void>(resolve=>{release=resolve;});
  input.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'中文'}));input.value='中文';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await settle();
  assert.equal(input.disabled,true);let closed=false;const closing=f.session.close().then(()=>{closed=true;});await settle();assert.equal(closed,false);assert.equal(input.isConnected,true);
  release();await closing;assert.match(await f.vault.read('One.md'),/status: 中文/);assert.equal(f.container.childElementCount,0);
 }finally{release?.();await f.stop();}
});
