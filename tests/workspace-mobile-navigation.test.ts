import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {EditorHandle,EditorOptions} from '../src/ui/editor.ts';
import type {PlatformVault} from '../src/platform/index.ts';
import {durableRecoveryFixture,recoveredDraft} from './helpers/durable-recovery-fixture.ts';

function editor(parent:HTMLElement,options:EditorOptions):EditorHandle {
  const input=document.createElement('textarea');input.value=options.value;parent.append(input);
  input.oninput=()=>options.onChange(input.value);
  return {getValue:()=>input.value,setValue:value=>{input.value=value;},focus:()=>input.focus(),destroy:()=>input.remove(),insert:text=>{input.value+=text;options.onChange(input.value);}};
}
class IdentityAdapter extends MemoryAdapter {
  async list(){return(await super.list()).map(entry=>({...entry,entryId:'id_'+entry.path.replaceAll('.','_')}));}
}
async function setup(t:TestContext,selection:Partial<PlatformVault>={},rejectHistory=false,views:WorkspaceViewFactories={},savedSession?:unknown,adapterOverride?:MemoryAdapter){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const opened:[string,string][]=[];
  const adapter=adapterOverride??new IdentityAdapter({'A.md':'Alpha','B.md':'Beta','Bad.canvas':'{','Document.pdf':'%PDF-test','Clip.mp3':'test','Broken.base':'views: []'});
  const platform:PlatformVault={adapter,id:'native-test',label:'Disposable',...selection,noteOpened:async(path,id)=>{opened.push([path,id]);if(rejectHistory)throw new Error('stale history');}};
  const workspace=new Workspace(document.querySelector<HTMLElement>('#app')!,editor,views);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  if(savedSession)localStorage.setItem('zorid:workspace:native-test',JSON.stringify(savedSession));
  await workspace.start(platform);
  return{workspace,opened,adapter,platform,dom};
}

test('native-selected note opens after admission and records successful activation by stable ID',async t=>{
  const f=await setup(t,{initialPath:'B.md',initialEntryId:'id_B_md'});
  assert.equal(f.workspace.activePane.viewPath,'B.md');assert.equal(f.workspace.activePane.editor?.getValue(),'Beta');
  assert.deepEqual(f.opened,[['B.md','id_B_md']]);
  await f.workspace.renderPane(f.workspace.activePane);assert.equal(f.opened.length,1,'render refresh is not another open');
  await f.workspace.openNote('A.md');await f.workspace.openNote('B.md');
  assert.deepEqual(f.opened,[['B.md','id_B_md'],['A.md','id_A_md'],['B.md','id_B_md']]);
});

test('native path reuse cannot activate or record a different entry',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'old-entry'});
  assert.equal(f.workspace.activePane.editor,undefined);assert.deepEqual(f.opened,[]);
  assert.match(document.body.textContent??'',/selected note changed/);
});

test('failed native history notification does not fail editing or save',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md'},true);
  const input=document.querySelector('textarea')!;input.value='Changed';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  await f.workspace.flush();assert.equal(await f.adapter.read('A.md'),'Changed');
  await f.workspace.openNote('B.md');assert.equal(f.workspace.activePane.editor?.getValue(),'Beta');
});

test('closing and stale/inactive rendered views cannot notify native Recents',async t=>{
  const f=await setup(t);await f.workspace.openNote('A.md');f.opened.length=0;
  const pane=f.workspace.activePane,notify=(Workspace.prototype as any).notifyNativeNoteOpened;
  (f.workspace as any).nativeOpened=undefined;(f.workspace as any).closing=true;notify.call(f.workspace,pane);
  (f.workspace as any).closing=false;pane.viewTabId='stale';notify.call(f.workspace,pane);
  assert.deepEqual(f.opened,[]);
});

test('a failed note renderer is not recorded as a successful open',async t=>{
  const f=await setup(t);(f.workspace as any).editorFactory=()=>{throw new Error('render failed');};
  await f.workspace.openNote('A.md');assert.equal(f.workspace.activePane.editor,undefined);assert.deepEqual(f.opened,[]);
});


test('failed Canvas parsing is not recorded as a successful open',async t=>{
  const f=await setup(t);await f.workspace.openNote('Bad.canvas');
  assert.equal(f.workspace.activePane.canvasView,undefined);assert.deepEqual(f.opened,[]);
});

test('pending and rejected PDF load cannot record a successful native open',async t=>{
  let reject!:(error:Error)=>void;const ready=new Promise<void>((_,r)=>{reject=r;});
  const f=await setup(t,{},false,{pdf:((host:HTMLElement)=>{host.textContent='Loading';return{ready,destroy(){}};}) as any});
  await f.workspace.openNote('Document.pdf');assert.deepEqual(f.opened,[]);
  reject(new Error('PDF failed'));await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(f.opened,[]);
});

test('PDF success records once only while its rendered runtime still owns the active view',async t=>{
  let resolve!:()=>void;const ready=new Promise<void>(r=>{resolve=r;});
  const f=await setup(t,{},false,{pdf:((host:HTMLElement)=>{host.textContent='Loading';return{ready,destroy(){}};}) as any});
  await f.workspace.openNote('Document.pdf');assert.deepEqual(f.opened,[]);
  resolve();await new Promise(done=>setTimeout(done,0));assert.deepEqual(f.opened,[['Document.pdf','id_Document_pdf']]);
});

test('a late PDF success after navigation cannot record the old inactive view',async t=>{
  let resolve!:()=>void;const ready=new Promise<void>(r=>{resolve=r;});
  const f=await setup(t,{},false,{pdf:((host:HTMLElement)=>{host.textContent='Loading';return{ready,destroy(){}};}) as any});
  await f.workspace.openNote('Document.pdf');await f.workspace.openNote('A.md');resolve();
  await new Promise(done=>setTimeout(done,0));assert.deepEqual(f.opened,[['A.md','id_A_md']]);
});

test('settled media error promise alone is not metadata/read success',async t=>{
  const f=await setup(t,{},false,{media:((host:HTMLElement)=>{host.textContent='Unable to play';return{ready:Promise.resolve(),destroy(){}};}) as any});
  await f.workspace.openNote('Clip.mp3');await new Promise(done=>setTimeout(done,0));assert.deepEqual(f.opened,[]);
});


test('resolved Base ready with a retained parse/query error is not successful history',async t=>{
  const f=await setup(t,{},false,{base:((host:HTMLElement)=>{host.textContent='Invalid Base';return{ready:Promise.resolve(),state:{result:null,error:new Error('Invalid query')},flush:async()=>{},close:async()=>{},hasPendingChanges:()=>false};}) as any});
  await f.workspace.openNote('Broken.base');await new Promise(done=>setTimeout(done,0));assert.deepEqual(f.opened,[]);
});


test('native editor-only selection renders document without workspace frames and saves normally',async t=>{
  const f=await setup(t,{editorOnly:true,initialPath:'A.md',initialEntryId:'id_A_md'});
  assert.equal(f.workspace.activePane.editor?.getValue(),'Alpha');
  assert.equal(document.querySelector('.ribbon,.sidebar,.right-sidebar,.status-bar,.tab-bar,.pane-toolbar'),null);
  assert.ok(document.querySelector('.note-title'));
  const input=document.querySelector('textarea')!;input.value='Saved without workspace frames';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  await f.workspace.flush();assert.equal(await f.adapter.read('A.md'),'Saved without workspace frames');
  await f.workspace.openNote('B.md',true);assert.equal(f.workspace.panes.length,1);assert.equal(f.workspace.activePane.tabs.length,1);
  await f.workspace.openNote('A.md');assert.equal(f.workspace.activePane.editor?.getValue(),'Saved without workspace frames');
});

test('native New note intent uses normal shared creation once after admission',async t=>{
  const f=await setup(t,{editorOnly:true,createNoteOnOpen:true});
  assert.equal(f.workspace.activePane.viewPath,'Untitled.md');
  assert.equal(await f.adapter.read('Untitled.md'),'');
  await f.workspace.renderPane(f.workspace.activePane);
  assert.equal([...f.workspace.vault.entries.keys()].filter(path=>path.startsWith('Untitled')).length,1);
});


test('native selected document does not restore unrelated workspace panes',async t=>{
  const saved={panes:[{tabs:[{path:'A.md',kind:'note',mode:'live'}],active:0},{tabs:[{path:'B.md',kind:'note',mode:'live'}],active:0}]};
  const f=await setup(t,{editorOnly:true,initialPath:'B.md',initialEntryId:'id_B_md'},false,{},saved);
  assert.equal(f.workspace.panes.length,1);assert.equal(f.workspace.activePane.tabs.length,1);
  assert.equal(f.workspace.activePane.editor?.getValue(),'Beta');
});


test('native editor-only autosave errors stay visible and retry the shared save',async t=>{
  const f=await setup(t,{editorOnly:true,initialPath:'A.md',initialEntryId:'id_A_md'});
  const write=f.adapter.write.bind(f.adapter);f.adapter.write=async()=>{throw new Error('Disk unavailable');};
  const input=document.querySelector('textarea')!;input.value='Retained after failure';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  await assert.rejects(f.workspace.flush(),/Disk unavailable/);
  const status=document.querySelector<HTMLElement>('.native-document-status')!;
  assert.equal(status.hidden,false);assert.match(status.textContent??'',/Could not save.*A.*draft is retained.*Disk unavailable/);
  f.adapter.write=write;status.querySelector<HTMLButtonElement>('button')!.click();
  await new Promise(done=>setTimeout(done,0));await f.workspace.flush();
  assert.equal(await f.adapter.read('A.md'),'Retained after failure');assert.equal(status.hidden,true);
});

test('retained conflict outside the selected native document has a visible recovery action',async t=>{
  const recovered=await durableRecoveryFixture();
  const f=await setup(t,{editorOnly:true},false,{},undefined,recovered.adapter);
  await f.workspace.openNote('Other.md');
  const status=document.querySelector<HTMLElement>('.native-document-status')!;
  assert.equal(status.hidden,false);assert.match(status.textContent??'',/Retained draft for “One” needs attention/);
  await assert.rejects(f.workspace.flush(),/draft preserved/);
  const save=[...status.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Save recovery copy')!;
  assert.ok(save);save.click();await new Promise(done=>setTimeout(done,0));
  await f.workspace.flush();assert.equal(recovered.copies.length,1);
  assert.equal(await recovered.adapter.read(recovered.copies[0]),recoveredDraft);
  assert.equal(f.workspace.activePane.viewPath,'Other.md');assert.equal(status.hidden,true);
});
