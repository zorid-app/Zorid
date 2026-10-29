import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {EditorHandle,EditorOptions} from '../src/ui/editor.ts';
import type {PdfViewOptions} from '../src/ui/pdf-view.ts';
import type {PlatformVault} from '../src/platform/index.ts';
import {durableRecoveryFixture,externalText,recoveredDraft} from './helpers/durable-recovery-fixture.ts';

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
  const opened:[string,string][]=[],presentations:{path:string;entryId:string;state:'ready'|'password'|'error'}[]=[];
  const adapter=adapterOverride??new IdentityAdapter({'A.md':'Alpha','B.md':'Beta','Bad.canvas':'{','Document.pdf':'%PDF-test','Clip.mp3':'test','Broken.base':'views: []','Picture.png':'bytes'});
  const platform:PlatformVault={adapter,id:'native-test',label:'Disposable',presentationSettled:async input=>{presentations.push(input);},...selection,noteOpened:async(path,id)=>{opened.push([path,id]);if(rejectHistory)throw new Error('stale history');}};
  const workspace=new Workspace(document.querySelector<HTMLElement>('#app')!,editor,views);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  if(savedSession)localStorage.setItem('zorid:workspace:native-test',JSON.stringify(savedSession));
  await workspace.start(platform);
  return{workspace,opened,presentations,adapter,platform,dom};
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


for(const editorOnly of [true,false])test(`${editorOnly?'native editor-only':'full workspace'} transient autosave recovers without a retry action`,async t=>{
  const f=await setup(t,{editorOnly,initialPath:'A.md',initialEntryId:'id_A_md'});
  const write=f.adapter.write.bind(f.adapter);f.adapter.write=async()=>{throw Object.assign(new Error('Disk unavailable: IPC checkpoint_cas operation-uuid schema_version'),{code:'io'});};
  try{
    const input=document.querySelector('textarea')!;input.value='Retained after transient failure';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    await assert.rejects(f.workspace.flush(),/Disk unavailable/);
    const status=document.querySelector<HTMLElement>('.native-document-status')!;
    assert.equal(status.hidden,true);assert.doesNotMatch(document.body.textContent??'',/Retry save|Could not save|Keep.*try again|IPC|checkpoint_cas|operation-uuid|schema_version|Disk unavailable/);
    f.adapter.write=write;
    for(let n=0;n<250&&f.workspace.buffers.get('A.md')!.dirty;n++)await new Promise(done=>setTimeout(done,5));
    assert.equal(f.workspace.buffers.get('A.md')!.dirty,false);assert.equal(await f.adapter.read('A.md'),'Retained after transient failure');assert.equal(status.hidden,true);
  }finally{f.adapter.write=write;}
});

for(const editorOnly of [true,false])test(`${editorOnly?'native editor-only':'full workspace'} terminal storage leaves a truthful copyable draft without retry-save UI`,async t=>{
  const f=await setup(t,{editorOnly,initialPath:'A.md',initialEntryId:'id_A_md'});
  let copied='';Object.defineProperty(f.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied=text;}}});
  const write=f.adapter.write.bind(f.adapter);f.adapter.write=async()=>{throw new Error('Disk unavailable: IPC checkpoint_cas operation-uuid schema_version');};
  try{
    const input=document.querySelector('textarea')!;input.value='Exact retained terminal draft';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    await assert.rejects(f.workspace.flush(),/Disk unavailable/);
    const status=document.querySelector<HTMLElement>('.native-document-status')!;
    assert.equal(status.hidden,false);assert.match(status.textContent??'',/Edits to.*A.*retained in this window/);
    assert.doesNotMatch(document.body.textContent??'',/Retry save|Could not save|Keep.*try again|IPC|checkpoint_cas|operation-uuid|schema_version|Disk unavailable/);
    if(!editorOnly)assert.equal(document.querySelector('.save-state')?.textContent,'Local draft');
    [...status.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Copy draft')!.click();await new Promise(done=>setTimeout(done,0));
    assert.equal(copied,'Exact retained terminal draft');assert.equal(f.workspace.buffers.get('A.md')!.dirty,true);assert.ok(f.workspace.buffers.get('A.md')!.error);
    assert.equal(await f.adapter.read('A.md'),'Alpha');
  }finally{f.adapter.write=write;await f.workspace.flush();}
});

test('retained conflict outside the selected native document has a visible recovery action',async t=>{
  const recovered=await durableRecoveryFixture();
  const f=await setup(t,{editorOnly:true},false,{},undefined,recovered.adapter);
  await f.workspace.openNote('Other.md');
  const status=document.querySelector<HTMLElement>('.native-document-status')!;
  assert.ok(status.nextElementSibling?.matches('.panes'),'the native document keeps its existing notice-before-editor layout');
  assert.equal(status.hidden,false);assert.match(status.textContent??'',/Retained draft for “One” needs attention/);
  await assert.rejects(f.workspace.flush(),/draft preserved/);
  const save=[...status.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Save recovery copy')!;
  assert.ok(save);save.click();await new Promise(done=>setTimeout(done,0));
  await f.workspace.flush();assert.equal(recovered.copies.length,1);
  assert.equal(await recovered.adapter.read(recovered.copies[0]),recoveredDraft);
  assert.equal(f.workspace.activePane.viewPath,'Other.md');assert.equal(status.hidden,true);
});

test('full workspace exposes background recovery while a real Base owns the active pane',async t=>{
  const recovered=await durableRecoveryFixture();
  await recovered.adapter.write('Work.base','views: [{type: table, name: Table, order: [file.name]}]\n');
  const f=await setup(t,{},false,{},undefined,recovered.adapter);
  await f.workspace.openNote('Work.base');
  assert.ok(document.querySelector('[role="grid"][aria-label="Table"]'),'real Base rendered');
  const status=document.querySelector<HTMLElement>('.native-document-status');
  assert.ok(status,'the full workspace mounts shared save and recovery notices');
  const panes=document.querySelector<HTMLElement>('.workspace-center > .panes')!;
  assert.equal(panes.nextElementSibling,status,'global recovery stays below pane navigation so notices cannot push tab controls under open panels');
  assert.equal(status.parentElement,panes.parentElement,'global recovery occupies its own area outside each pane');
  assert.equal(status.getAttribute('aria-label'),'Save and recovery notices');
  assert.equal(status.getAttribute('aria-live'),'polite');
  assert.equal(status.hidden,false);assert.match(status.textContent??'',/Retained draft for “One” needs attention/);
  const saves=[...status.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.textContent==='Save recovery copy');
  assert.equal(saves.length,1);assert.equal(saves[0].disabled,false);
  saves[0].click();
  const deadline=Date.now()+2000;
  while(!status.hidden){assert.ok(Date.now()<deadline,'recovery acknowledgement hides notice');await new Promise(done=>setTimeout(done,5));}
  await f.workspace.flush();
  assert.equal(recovered.copies.length,1);assert.equal(await recovered.adapter.read(recovered.copies[0]),recoveredDraft);
  assert.equal(await recovered.adapter.read('One.md'),externalText);
  assert.equal(recovered.plans,0,'recovery never tries to overwrite or rebase the original');
  assert.equal(f.workspace.activePane.viewPath,'Work.base','background recovery does not activate another note');
  assert.ok(document.querySelector('[role="grid"][aria-label="Table"]'));
});

test('full workspace uses the active note recovery banner and reveals background actions after navigation',async t=>{
  const recovered=await durableRecoveryFixture();
  const f=await setup(t,{},false,{},undefined,recovered.adapter);
  await f.workspace.openNote('One.md');
  const status=document.querySelector<HTMLElement>('.native-document-status');
  assert.ok(status);assert.equal(status.hidden,true,'current note already owns the full recovery banner');
  assert.equal(document.querySelector<HTMLElement>('.note-recovery')?.hidden,false);
  assert.equal([...document.querySelectorAll('button')].filter(button=>button.textContent==='Save recovery copy').length,1);
  await f.workspace.openNote('Other.md');
  assert.equal(status.hidden,false);
  assert.equal([...status.querySelectorAll('button')].filter(button=>button.textContent==='Save recovery copy').length,1);
  [...status.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Save recovery copy')!.click();
  const deadline=Date.now()+2000;
  while(!status.hidden){assert.ok(Date.now()<deadline,'background recovery resolves');await new Promise(done=>setTimeout(done,5));}
  await f.workspace.flush();
});


test('native foreground requests republish current state even before DOM visibility catches up',async t=>{
  let request:(()=>void|Promise<void>)|undefined;
  const states:unknown[]=[];
  const f=await setup(t,{editorOnly:true,initialPath:'A.md',initialEntryId:'id_A_md',nativeEditor:{
    setState:async state=>{states.push(state);},
    subscribe:(_action,onStateRequest)=>{request=onStateRequest;return()=>{};}
  }});
  const state={focused:true,editable:true,canUndo:true,canRedo:false};
  f.workspace.activePane.editor!.nativeState=()=>state;
  Object.defineProperty(f.dom.window.document,'visibilityState',{configurable:true,value:'hidden'});
  states.length=0;
  await request!();
  assert.deepEqual(states,[state],'native foreground is authoritative during WebKit visibility lag');
  for(const key of ['closing','startupFailed','platformReleased'] as const){
    (f.workspace as any)[key]=true;await request!();(f.workspace as any)[key]=false;
  }
  f.workspace.root.inert=true;await request!();f.workspace.root.inert=false;
  (f.workspace as any).vaultGeneration++;await request!();
  assert.deepEqual(states,[state],'quiescent and stale workspaces cannot restore the toolbar');
});

function presentationPdf(initial?:'password'|'error'){
  let notify:NonNullable<PdfViewOptions['onPresentationSettled']>|undefined,resolve!:()=>void;
  const ready=new Promise<void>(done=>{resolve=done;});
  const pdf:NonNullable<WorkspaceViewFactories['pdf']>=(host,_path,_resources,options)=>{
    host.textContent=initial==='password'?'Enter PDF password':initial==='error'?'Unable to display PDF':'Loading';
    notify=options?.onPresentationSettled;
    if(initial)notify?.(initial);
    return{ready,destroy(){},goToPage(){},setScale(){},rotate(){},showSearch(){},applySubpath(){},getSelectionSubpath(){return null;}};
  };
  return{pdf,emit:(state:'ready'|'password'|'error')=>notify?.(state),succeed(){notify?.('ready');resolve();}};
}
const presentationTick=()=>new Promise(done=>setTimeout(done,0));

for(const state of ['password','error'] as const)test(`initial PDF ${state} presentation survives opening/viewReady fences without successful history`,async t=>{
  const view=presentationPdf(state),f=await setup(t,{editorOnly:true,initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf});
  assert.deepEqual(f.presentations,[{path:'Document.pdf',entryId:'id_Document_pdf',state}]);assert.deepEqual(f.opened,[]);
  view.emit(state);assert.equal(f.presentations.length,1,'same runtime state is bounded/deduplicated');
  assert.equal(f.workspace.activePane.viewReady,true);
});

test('PDF success still records exactly one history open, independently of earlier password presentation',async t=>{
  const view=presentationPdf('password'),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf});
  assert.deepEqual(f.opened,[]);view.succeed();await presentationTick();
  assert.deepEqual(f.presentations.map(value=>value.state),['password','ready']);assert.deepEqual(f.opened,[['Document.pdf','id_Document_pdf']]);
  await f.workspace.renderPane(f.workspace.activePane);assert.equal(f.opened.length,1);assert.equal(f.presentations.length,2);
});

test('presentation rejection and synchronous exception cannot delay saving or lifecycle completion',async t=>{
  let handler:any,calls=0;const view=presentationPdf('password');
  const f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf',presentationSettled:()=>{calls++;if(calls===1)throw new Error('Native UI failed');return Promise.reject(new Error('Native UI unavailable'));},mobileLifecycle:{subscribe(callback){handler=callback;return()=>{};}}},false,{pdf:view.pdf});
  view.emit('error');await presentationTick();assert.equal(calls,2);await f.workspace.openNote('A.md');
  const input=document.querySelector('textarea')!;input.value='Saved';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await f.workspace.flush();
  let acked=false;await handler('background',async()=>{acked=true;});assert.equal(acked,true);assert.equal(await f.adapter.read('A.md'),'Saved');
});

test('parked/disposed PDF callbacks cannot reveal old content after navigation',async t=>{
  const view=presentationPdf(),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf});
  await f.workspace.openNote('A.md');const before=f.presentations.length;view.emit('password');view.emit('error');view.succeed();await presentationTick();
  assert.equal(f.presentations.length,before);assert.deepEqual(f.opened,[['A.md','id_A_md']]);
  await (f.workspace as any).clearCachedViews();view.emit('error');assert.equal(f.presentations.length,before);
});

test('presentation callbacks are invalidated at lifecycle admission even after background ACK restores editing',async t=>{
  let lifecycle:any;const view=presentationPdf(),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf',mobileLifecycle:{subscribe(handler){lifecycle=handler;return()=>{};}}},false,{pdf:view.pdf});
  await lifecycle('background',async()=>{view.emit('password');});assert.ok(!f.workspace.root.inert);
  view.emit('error');await presentationTick();assert.deepEqual(f.presentations,[]);assert.deepEqual(f.opened,[]);
});

for(const fence of ['closing','inert','startupFailed','platformReleased','generation','identity','detached','navigation'] as const)test(`native PDF presentation rejects ${fence} ownership fence`,async t=>{
  const view=presentationPdf(),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf}),workspace=f.workspace as any;
  const pane=f.workspace.activePane,restore:()=>void=(()=>{
    if(fence==='inert'){f.workspace.root.inert=true;return()=>{f.workspace.root.inert=false;};}
    if(fence==='generation'){workspace.vaultGeneration++;return()=>{workspace.vaultGeneration--;};}
    if(fence==='identity'){const entry=f.workspace.vault.entries.get('Document.pdf')!,before=entry.entryId;entry.entryId='replacement';return()=>{entry.entryId=before;};}
    if(fence==='detached'){const content=pane.content!,parent=content.parentElement!;content.remove();return()=>{parent.append(content);};}
    if(fence==='navigation'){const intents=workspace.navigationIntent,before=intents.get(pane);intents.set(pane,(before??0)+1);return()=>{if(before===undefined)intents.delete(pane);else intents.set(pane,before);};}
    workspace[fence]=true;return()=>{workspace[fence]=false;};
  })();
  view.emit('password');view.emit('error');await presentationTick();assert.deepEqual(f.presentations,[]);restore();
});

test('visible Canvas and Base load errors reveal native content without successful history',async t=>{
  const f=await setup(t);await f.workspace.openNote('Bad.canvas');await presentationTick();
  assert.deepEqual(f.presentations,[{path:'Bad.canvas',entryId:'id_Bad_canvas',state:'error'}]);assert.deepEqual(f.opened,[]);
  (f.workspace as any).viewFactories.base=(host:HTMLElement)=>{host.innerHTML='<div class="bases-session-status">Invalid Base</div>';return{ready:Promise.resolve(),state:{result:null,error:new Error('Invalid query')},flush:async()=>{},close:async()=>{},hasPendingChanges:()=>false};};
  await f.workspace.openNote('Broken.base');await presentationTick();assert.equal(f.presentations.at(-1)?.state,'error');assert.equal(f.presentations.at(-1)?.path,'Broken.base');assert.deepEqual(f.opened,[]);
});

test('asynchronous media visible errors reveal native content without treating settlement as successful history',async t=>{
  let fail!:()=>void;const f=await setup(t,{},false,{media:((host:HTMLElement)=>{host.innerHTML='<div class="zorid-media-view"><span class="zorid-media-status"></span></div>';let resolve!:()=>void;const ready=new Promise<void>(done=>{resolve=done;});fail=()=>{host.querySelector('div')!.classList.add('is-error');host.querySelector('span')!.textContent='Unable to play';resolve();};return{ready,destroy(){}};}) as any});
  await f.workspace.openNote('Clip.mp3');assert.deepEqual(f.presentations,[]);fail();await presentationTick();
  assert.deepEqual(f.presentations,[{path:'Clip.mp3',entryId:'id_Clip_mp3',state:'error'}]);assert.deepEqual(f.opened,[]);
});

test('image decoder error reveals existing error UI without successful history',async t=>{
  const f=await setup(t);await f.workspace.openNote('Picture.png');
  const image=f.workspace.activePane.content!.querySelector('img')!;assert.ok(image);
  image.dispatchEvent(new f.dom.window.Event('error'));await presentationTick();
  assert.deepEqual(f.presentations,[{path:'Picture.png',entryId:'id_Picture_png',state:'error'}]);assert.deepEqual(f.opened,[]);
});


test('retained PDF callbacks rearm only on explicit current activation',async t=>{
  const view=presentationPdf(),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf});
  const runtime=f.workspace.activePane.runtime;
  await f.workspace.openNote('Document.pdf');assert.equal(f.workspace.activePane.runtime,runtime);
  view.emit('password');assert.equal(f.presentations.at(-1)?.state,'password');
  const pdfTab=f.workspace.activePane.tabs.find(tab=>tab.path==='Document.pdf')!;
  await f.workspace.openNote('A.md',true);const before=f.presentations.length;
  view.emit('error');assert.equal(f.presentations.length,before);
  await (f.workspace as any).selectTab(f.workspace.activePane,pdfTab);
  assert.equal(f.workspace.activePane.runtime,runtime);
  view.emit('error');assert.equal(f.presentations.at(-1)?.path,'Document.pdf');assert.equal(f.presentations.at(-1)?.state,'error');
  await (f.workspace as any).selectTab(f.workspace.activePane,pdfTab);
  view.succeed();await presentationTick();assert.equal(f.presentations.at(-1)?.state,'ready');
  assert.equal(f.opened.filter(([path])=>path==='Document.pdf').length,1);
});

test('unsupported selected attachment reveals its existing unavailable message without history',async t=>{
  const adapter=new IdentityAdapter({'Unknown.zip':'bytes'});
  const f=await setup(t,{initialPath:'Unknown.zip',initialEntryId:'id_Unknown_zip'},false,{pdf:((host:HTMLElement)=>{host.textContent='PDF';return{ready:Promise.resolve(),destroy(){}};}) as any},undefined,adapter);
  assert.match(f.workspace.activePane.content!.textContent??'',/No viewer is available/);
  assert.deepEqual(f.presentations,[{path:'Unknown.zip',entryId:'id_Unknown_zip',state:'error'}]);assert.deepEqual(f.opened,[]);
});

test('PDF that becomes ready while parked reveals success only when explicitly restored',async t=>{
  const view=presentationPdf('password'),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf});
  const pdfTab=f.workspace.activePane.tabs.find(tab=>tab.path==='Document.pdf')!;
  await f.workspace.openNote('A.md',true);const before=f.presentations.length;
  view.succeed();await presentationTick();assert.equal(f.presentations.length,before);
  await (f.workspace as any).selectTab(f.workspace.activePane,pdfTab);
  assert.deepEqual(f.presentations.at(-1),{path:'Document.pdf',entryId:'id_Document_pdf',state:'ready'});
  assert.equal(f.opened.filter(([path])=>path==='Document.pdf').length,1);
});


for(const state of ['password','error'] as const)test(`PDF ${state} shown while parked is rederived from current visible UI on restoration`,async t=>{
  let host!:HTMLElement,emit!:(state:'password'|'error')=>void;
  const view=presentationPdf();
  const pdf:NonNullable<WorkspaceViewFactories['pdf']>=(parent,...args)=>{host=parent;emit=value=>args[2]?.onPresentationSettled?.(value);return view.pdf(parent,...args);};
  const f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf});
  const tab=f.workspace.activePane.tabs.find(tab=>tab.path==='Document.pdf')!;
  await f.workspace.openNote('A.md',true);const before=f.presentations.length;
  host.innerHTML=state==='password'?'<form class="zorid-pdf-password"><input type="password"></form>':'<div class="zorid-pdf-status">Unable to display PDF: test failure</div>';
  emit(state);await presentationTick();assert.equal(f.presentations.length,before);
  await (f.workspace as any).selectTab(f.workspace.activePane,tab);
  assert.deepEqual(f.presentations.at(-1),{path:'Document.pdf',entryId:'id_Document_pdf',state});
  assert.equal(f.opened.filter(([path])=>path==='Document.pdf').length,0);
});


function countPresentationQueries(content:HTMLElement){
  let count=0;
  const query=content.querySelector,all=content.querySelectorAll;
  content.querySelector=((...args:Parameters<typeof query>)=>{count++;return query.apply(content,args);}) as typeof query;
  content.querySelectorAll=((...args:Parameters<typeof all>)=>{count++;return all.apply(content,args);}) as typeof all;
  return()=>count;
}

test('final ready stops presentation subtree scans during subsequent editor mutations',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md'});
  await presentationTick();const content=f.workspace.activePane.content!,queries=countPresentationQueries(content);
  const text=document.createTextNode('typing');content.append(text);text.data='typing more';
  await presentationTick();text.data='typing again';await presentationTick();
  assert.equal(queries(),0,'settled Markdown edits must not scan the view subtree');
  assert.deepEqual(f.presentations.map(value=>value.state),['ready']);
});

test('password keeps initial error observation, final error stops scans, explicit PDF ready still delivers',async t=>{
  const view=presentationPdf('password'),f=await setup(t,{initialPath:'Document.pdf',initialEntryId:'id_Document_pdf'},false,{pdf:view.pdf});
  const content=f.workspace.activePane.content!,queries=countPresentationQueries(content);
  const error=document.createElement('div');error.className='error-message';error.textContent='Cannot display';content.append(error);
  await presentationTick();assert.ok(queries()>0,'password must retain observation until a final presentation');
  assert.deepEqual(f.presentations.map(value=>value.state),['password','error']);assert.deepEqual(f.opened,[]);
  const settled=queries();error.textContent='Updated error';content.append(document.createTextNode('later mutation'));
  await presentationTick();assert.equal(queries(),settled,'final error must stop subtree scans');
  error.remove();view.succeed();await presentationTick();
  assert.equal(f.presentations.at(-1)?.state,'ready');assert.equal(f.opened.length,1);
});


test('changed native launch identity reveals its visible error without acknowledging the replacement',async t=>{
  const settled:unknown[]=[];
  const f=await setup(t,{editorOnly:true,initialPath:'A.md',initialEntryId:'old-entry',presentationSettled:async value=>{settled.push(value);}});
  assert.deepEqual(settled,[{path:'A.md',entryId:'old-entry',state:'error'}]);
  assert.match(document.body.textContent??'',/selected note changed/);
  assert.equal(f.workspace.activePane.editor,undefined);assert.deepEqual(f.opened,[]);
  await f.workspace.flush();
  assert.equal(await f.adapter.read('A.md'),'Alpha');
});

test('missing native selection error delivery rejection does not fail vault admission',async t=>{
  const f=await setup(t,{editorOnly:true,initialPath:'Missing.md',initialEntryId:'missing-entry',presentationSettled:async()=>{throw new Error('native UI unavailable');}});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.match(document.body.textContent??'',/selected note changed/);assert.deepEqual(f.opened,[]);
  await f.workspace.openNote('A.md');assert.equal(f.workspace.activePane.editor?.getValue(),'Alpha');
});

// Finite command fixture uses one real Workspace/Vault, with authoritative IDs
// supplied by a small durable provider rather than a second host/bootstrap.
async function finiteNavigationFixture(t:TestContext,initialPath='A.md'){
  const adapter=new IdentityAdapter({'A.md':'Alpha','B.md':'Beta','C.md':'Gamma','Document.pdf':'%PDF-bytes'});
  const stat=adapter.stat.bind(adapter);adapter.stat=async path=>{const row=await stat(path);return row?{...row,entryId:'id_'+path.replaceAll('.','_'),revision:'rev1'}:row;};
  const heads=new Map<string,any>(),scope={vaultId:'store',clientId:'client'};
  const textReads:string[]=[];
  const read=async(path:string)=>{textReads.push(path);return({entryId:'id_'+path.replaceAll('.','_'),path,revision:'rev1',content:await adapter.read(path),stat:{ctime:1,mtime:1,size:(await adapter.read(path)).length}});};
  const unused=async():Promise<never>=>{throw new Error('Unexpected durable write');};
  (adapter as any).durableWrites={checkpoints:{scope,load:async(key:string)=>heads.get(key)??null,list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'}),compareAndSwap:async(change:any)=>{const head={...scope,version:1,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:'1',deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'','utf8')};heads.set(change.key,head);return head;}},
    readText:read,readTextById:async(id:string)=>{const row=(await adapter.list()).find(row=>row.entryId===id);return row?read(row.path):null;},planWrite:unused,prepare:unused,commit:unused,query:unused,listUnacknowledged:async()=>[],acknowledge:unused};
  let handler:any,lifecycle:any;
  const f=await setup(t,{editorOnly:true,initialPath,initialEntryId:'id_'+initialPath.replaceAll('.','_'),
    nativeDocumentNavigation:{subscribe(callback){handler=callback;return()=>{};}},
    mobileLifecycle:{subscribe(callback){lifecycle=callback;return()=>{};}}},false,{},undefined,adapter);
  f.workspace.root.inert=false; // JSDOM does not implement HTMLElement.inert's browser default.
  let current=true;
  const request={id:crypto.randomUUID(),sourceOwnerId:crypto.randomUUID(),nativeTabId:crypto.randomUUID(),localStoreId:'store',entryId:'id_B_md'};
  return{...f,heads,textReads,request,setCurrent(value:boolean){current=value;},navigate:(ready:(result:any)=>Promise<void>=async()=>{})=>handler(request,{isCurrent:()=>current,ready}),lifecycle:(reason:string,ack:()=>Promise<void>)=>lifecycle(reason,ack)};
}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{resolve,promise};}
async function waitFor(check:()=>boolean){for(let n=0;n<300;n++){if(check())return;await new Promise(done=>setTimeout(done,2));}assert.fail('finite navigation timed out');}

test('finite same-vault command retains source through ACK and never bootstraps a new Vault',async t=>{
  const f=await finiteNavigationFixture(t),vault=f.workspace.vault,source=f.workspace.activePane.editor!,ack=gate();let ready:any;
  vault.initialize=async()=>{assert.fail('same-vault navigation must not initialize');};
  const task=f.navigate(async result=>{ready=result;await ack.promise;});await waitFor(()=>!!ready);
  assert.equal(source.getValue(),'Alpha');assert.equal(f.workspace.vault,vault);assert.equal(f.workspace.root.inert,true);
  assert.deepEqual(f.opened,[['A.md','id_A_md']],'command must not publish fire-and-forget noteOpened');
  ack.resolve();await task;
  assert.equal(f.workspace.activePane.editor?.getValue(),'Beta');assert.equal(f.workspace.activePane.tabs.length,1);
  assert.equal((f.workspace as any).cachedViews.size,0);assert.equal(f.workspace.root.inert,false);
  assert.deepEqual(ready,{path:'B.md',entryId:'id_B_md',revision:'rev1',recovery:'none'});
});
test('finite source checkpoint failure leaves exact source runtime and never admits target',async t=>{
  const f=await finiteNavigationFixture(t),source=f.workspace.activePane.editor!;
  f.workspace.buffers.get('A.md')!.flushForNavigation=async()=>{throw new Error('checkpoint unavailable');};
  await assert.rejects(f.navigate(async()=>assert.fail('must not ACK')),/checkpoint unavailable/);
  assert.equal(f.workspace.activePane.editor,source);assert.equal(f.workspace.activePane.viewPath,'A.md');assert.equal(f.workspace.root.inert,false);assert.equal(f.workspace.buffers.has('B.md'),false);
  assert.deepEqual(f.opened,[['A.md','id_A_md'],['A.md','id_A_md']],'untouched source still needs fresh attestation after native begin');
  f.workspace.buffers.get('A.md')!.flushForNavigation=async()=>{};
});
test('missing target reattests the unchanged source without staging another runtime',async t=>{
  const f=await finiteNavigationFixture(t),runtime=f.workspace.activePane.runtime;
  f.request.entryId='missing-entry';await assert.rejects(f.navigate(),/unavailable/);
  assert.equal(f.workspace.activePane.runtime,runtime);assert.equal((f.workspace as any).cachedViews.size,0);
  assert.deepEqual(f.opened,[['A.md','id_A_md'],['A.md','id_A_md']]);
});
for(const failure of ['renderer','native ACK'])test(`finite ${failure} failure restores the retained source without recording target`,async t=>{
  const f=await finiteNavigationFixture(t),source=f.workspace.activePane.editor!;
  if(failure==='renderer')(f.workspace as any).editorFactory=(parent:HTMLElement,options:EditorOptions)=>{if(options.value==='Beta')throw new Error('target renderer failed');return editor(parent,options);};
  await assert.rejects(f.navigate(async()=>{throw new Error('native validation rejected');}));
  assert.equal(f.workspace.activePane.editor,source);assert.equal(f.workspace.activePane.viewPath,'A.md');assert.equal(f.workspace.root.inert,false);
  assert.deepEqual(f.opened,[['A.md','id_A_md'],['A.md','id_A_md']],'restored source needs fresh native attestation');assert.equal((f.workspace as any).cachedViews.size,0);
});
test('rejected navigation awaits drained target cleanup then fresh source attestation before settling, allowing retry',async t=>{
  const f=await finiteNavigationFixture(t),source=f.workspace.activePane.editor!,cleanup=gate(),attestation=gate();
  const dispose=(f.workspace as any).disposePaneViews.bind(f.workspace);let disposing=false,published=false,settled=false;
  (f.workspace as any).disposePaneViews=async(pane:any)=>{if(pane.viewPath==='B.md'){disposing=true;await cleanup.promise;}return dispose(pane);};
  f.platform.noteOpened=async(path,id)=>{
    assert.equal(disposing,true);assert.equal((f.workspace as any).cachedViews.size,0);assert.equal(f.workspace.root.inert,false);
    assert.equal(f.workspace.activePane.editor,source);assert.deepEqual([path,id],['A.md','id_A_md']);published=true;f.setCurrent(false);await attestation.promise;
  };
  const command=f.navigate(async()=>{throw new Error('native rejection');});void command.catch(()=>{settled=true;});
  await waitFor(()=>disposing);assert.equal(published,false);assert.equal(settled,false);
  cleanup.resolve();await waitFor(()=>published);assert.equal(settled,false);
  attestation.resolve();await assert.rejects(command,/native rejection/);assert.equal(settled,true);
  assert.equal((f.workspace as any).nativeOpened?.entryId,'id_A_md','the attestation itself invalidates command control, not the restored source');f.setCurrent(true);
  await f.navigate();assert.equal(f.workspace.activePane.viewPath,'B.md');
});
for(const fence of ['hidden','detached','identity','binding','ready'] as const)test(`held source attestation cannot mark dedup success after ${fence} changes`,async t=>{
  const f=await finiteNavigationFixture(t),pending=gate();let entered=false,undo=()=>{};
  f.platform.noteOpened=async()=>{entered=true;f.setCurrent(false);await pending.promise;};
  const command=f.navigate(async()=>{throw new Error('native rejection');});await waitFor(()=>entered);
  if(fence==='hidden')Object.defineProperty(f.dom.window.document,'visibilityState',{configurable:true,value:'hidden'});
  if(fence==='detached')f.workspace.activePane.content!.remove();
  if(fence==='identity'){const row=f.workspace.vault.entries.get('A.md')!;f.workspace.vault.entries.set('A.md',{...row,entryId:'replacement'});}
  if(fence==='binding'){const scope=(f.adapter as any).durableWrites.checkpoints.scope;scope.clientId='other-client';undo=()=>{scope.clientId='client';};}
  if(fence==='ready')f.workspace.activePane.viewReady=false;
  pending.resolve();await assert.rejects(command,/native rejection/);
  assert.equal((f.workspace as any).nativeOpened,undefined);undo();
});
test('failed restored-source attestation does not mark native open successful or block terminal settlement',async t=>{
  const f=await finiteNavigationFixture(t);let attempts=0;
  f.platform.noteOpened=async()=>{attempts++;throw new Error('source validation failed');};
  await assert.rejects(f.navigate(async()=>{throw new Error('native rejection');}),/native rejection/);
  assert.equal(attempts,1);assert.equal((f.workspace as any).nativeOpened,undefined);assert.equal(f.workspace.activePane.viewPath,'A.md');
});
for(const fence of ['identity','generation','runtime','hidden','intent','binding','cleanup','restore','detached'] as const)test(`restored source cannot reattest after ${fence} failure`,async t=>{
  const f=await finiteNavigationFixture(t),workspace=f.workspace as any;let attempts=0,undo=()=>{};
  f.platform.noteOpened=async()=>{attempts++;};
  if(fence==='cleanup'){const dispose=workspace.disposePaneViews.bind(workspace);workspace.disposePaneViews=async(pane:any)=>{if(pane.viewPath==='B.md')throw new Error('cleanup failed');return dispose(pane);};undo=()=>{workspace.disposePaneViews=dispose;};}
  if(fence==='restore'){const restore=workspace.restoreCachedViewNow.bind(workspace);workspace.restoreCachedViewNow=()=>false;undo=()=>{workspace.restoreCachedViewNow=restore;};}
  if(fence==='detached'){const restore=workspace.restoreCachedViewNow.bind(workspace);workspace.restoreCachedViewNow=(pane:any,tab:any)=>{const result=restore(pane,tab);pane.content?.remove();return result;};undo=()=>{workspace.restoreCachedViewNow=restore;};}
  await assert.rejects(f.navigate(async()=>{
    if(fence==='identity'){const row=f.workspace.vault.entries.get('A.md')!;f.workspace.vault.entries.set('A.md',{...row,entryId:'replacement'});}
    if(fence==='generation'){workspace.vaultGeneration++;undo=()=>{workspace.vaultGeneration--;};}
    if(fence==='runtime'){const ready=workspace.nativeReadyViews;workspace.nativeReadyViews=new WeakSet();undo=()=>{workspace.nativeReadyViews=ready;};}
    if(fence==='hidden'){Object.defineProperty(f.dom.window.document,'visibilityState',{configurable:true,value:'hidden'});}
    if(fence==='intent'){workspace.navigationIntent.set(f.workspace.activePane,999);}
    if(fence==='binding'){const scope=(f.adapter as any).durableWrites.checkpoints.scope;scope.clientId='other-client';undo=()=>{scope.clientId='client';};}
    throw new Error('native rejection');
  }));
  assert.equal(attempts,0);undo();
});
test('finite positive native ACK cannot be rolled back by subsequent cancellation',async t=>{
  const f=await finiteNavigationFixture(t);await f.navigate(async()=>{f.setCurrent(false);});
  assert.equal(f.workspace.activePane.viewPath,'B.md');assert.equal(f.workspace.root.inert,false);
});
test('spontaneous link from a provisional target publishes its own identity and retires the source tab',async t=>{
  const f=await finiteNavigationFixture(t),pending=gate();let ready=false;
  const command=f.navigate(async()=>{ready=true;await pending.promise;throw new Error('superseded native request');});
  await waitFor(()=>ready);await f.workspace.openNote('C.md');f.setCurrent(false);
  assert.deepEqual(f.opened,[['A.md','id_A_md'],['C.md','id_C_md']],'a reused provisional tab must not suppress the newer link');
  pending.resolve();await assert.rejects(command,/superseded native request/);
  assert.equal(f.workspace.activePane.viewPath,'C.md');assert.equal(f.workspace.activePane.tabs.length,1);
  assert.equal((f.workspace as any).cachedViews.size,0);assert.equal(f.workspace.root.inert,false);
  assert.deepEqual(f.opened,[['A.md','id_A_md'],['C.md','id_C_md']],'superseded rollback cannot reattest old source');
});
test('positive native ACK followed immediately by background retains the accepted target',async t=>{
  const f=await finiteNavigationFixture(t),pending=gate();let ready=false;
  const command=f.navigate(async()=>{ready=true;await pending.promise;});await waitFor(()=>ready);
  f.setCurrent(false);const transition=f.lifecycle('background',async()=>{});pending.resolve();
  await command;await transition;
  assert.equal(f.workspace.activePane.viewPath,'B.md');assert.equal(f.workspace.activePane.tabs.length,1);
  assert.equal(f.workspace.root.inert,false);assert.equal((f.workspace as any).cachedViews.size,0);
});
test('path reuse cannot adopt or recover the previous loaded buffer for another entry',async t=>{
  const f=await finiteNavigationFixture(t);await f.workspace.openNote('B.md');await f.workspace.openNote('A.md');
  const old=f.workspace.buffers.get('B.md')!,source=f.workspace.activePane.editor!,writes=(f.adapter as any).durableWrites;
  let loads=0;const load=writes.checkpoints.load;writes.checkpoints.load=async(key:string)=>{loads++;return load(key);};
  f.workspace.vault.reload=async()=>{const row=f.workspace.vault.entries.get('B.md')!;f.workspace.vault.entries.set('B.md',{...row,entryId:'replacement'});};
  const read=writes.readTextById;writes.readTextById=async(id:string)=>id==='replacement'?{...(await read('id_A_md')),entryId:'replacement',path:'B.md',content:'Replacement'}:read(id);
  f.request.entryId='replacement';
  await assert.rejects(f.navigate(),/another entry|identity changed/);
  assert.equal(f.workspace.activePane.editor,source);assert.equal(f.workspace.activePane.viewPath,'A.md');
  assert.equal(f.workspace.buffers.get('B.md'),old);assert.equal(old.savedDurableWitness?.entryId,'id_B_md');assert.equal(loads,0);
});
for(const reason of ['background','switchVault'])test(`finite cancellation drains before ${reason} captures inert restoration state`,async t=>{
  const f=await finiteNavigationFixture(t),pending=gate(),source=f.workspace.activePane.editor!;
  const writes=(f.adapter as any).durableWrites,read=writes.readTextById;let entered=false;
  writes.readTextById=async(id:string)=>{if(id==='id_B_md'){entered=true;await pending.promise;}return read(id);};
  const navigation=f.navigate();await waitFor(()=>entered);f.setCurrent(false);
  const transition=f.lifecycle(reason,async()=>{if(reason==='switchVault')throw new Error('stale lifecycle');});
  pending.resolve();await assert.rejects(navigation,/superseded/);
  if(reason==='switchVault')await assert.rejects(transition,/stale lifecycle/);else await transition;
  assert.equal(f.workspace.activePane.editor,source);assert.equal(f.workspace.root.inert,false);assert.equal((f.workspace as any).closing,false);
});
test('finite rejection detaches target before async teardown, so newer navigation is not overwritten',async t=>{
  const f=await finiteNavigationFixture(t),blocked=gate();let teardown=false;
  const dispose=(f.workspace as any).disposePaneViews.bind(f.workspace);
  (f.workspace as any).disposePaneViews=async(pane:any)=>{if(pane.viewPath==='B.md'){teardown=true;await blocked.promise;}return dispose(pane);};
  const command=f.navigate(async()=>{throw new Error('reject');});await waitFor(()=>teardown);
  assert.equal(f.workspace.activePane.viewPath,'A.md');await f.workspace.openNote('C.md');blocked.resolve();await assert.rejects(command);
  assert.equal(f.workspace.activePane.viewPath,'C.md');assert.equal(f.workspace.root.inert,false);
});


test('durable native PDF launch retains binary viewer path without text checkpoint admission',async t=>{
  const f=await finiteNavigationFixture(t,'Document.pdf');
  assert.ok(f.workspace.activePane.pdfView);assert.equal(f.workspace.activePane.viewPath,'Document.pdf');
  assert.deepEqual(f.textReads,[]);assert.equal(f.workspace.buffers.size,0);assert.equal(f.heads.size,0);
});


test('note opening errors preserve diagnostics internally and show ordinary-language copy',async t=>{
  const f=await setup(t);
  const read=f.adapter.read.bind(f.adapter);
  const diagnostic=new Error('IPC checkpoint_load operation-uuid schema_version /private/vault.sqlite');
  const logged:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{logged.push(args);});
  f.adapter.read=async path=>{if(path==='B.md')throw diagnostic;return read(path);};
  await f.workspace.openNote('B.md');
  assert.match(document.querySelector('.error-message')?.textContent??'',/couldn’t be opened/);
  assert.doesNotMatch(document.body.innerHTML,/IPC|checkpoint_load|operation-uuid|schema_version|private|sqlite/);
  assert.ok(logged.some(args=>args.includes(diagnostic)));
  f.adapter.read=read;
});

test('shared note-save command failures never surface checkpoint internals in notices',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md'});
  const write=f.adapter.write.bind(f.adapter);
  t.mock.method(console,'error',()=>{});
  f.adapter.write=async()=>{throw new Error('IPC checkpoint_cas operation-uuid schema_version');};
  const input=document.querySelector('textarea')!;input.value='Pending edit';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  (f.workspace as any).run(()=>f.workspace.flush());
  await new Promise(done=>setTimeout(done,0));
  assert.match(document.querySelector('.notice')?.textContent??'',/edits are retained in this window/);
  assert.doesNotMatch(document.body.innerHTML,/IPC|checkpoint_cas|operation-uuid|schema_version/);
  f.adapter.write=write;await f.workspace.flush();
});


test('recovery-copy failures show an actionable message without native details',async t=>{
  const recovered=await durableRecoveryFixture();
  const f=await setup(t,{editorOnly:true},false,{},undefined,recovered.adapter);
  t.mock.method(console,'error',()=>{});
  await f.workspace.openNote('One.md');
  const buffer=f.workspace.buffers.get('One.md')!,save=buffer.saveRecoveryCopy.bind(buffer);
  buffer.saveRecoveryCopy=async()=>{throw new Error('IPC operation-uuid checkpoint_cas schema_version');};
  const button=[...document.querySelectorAll<HTMLButtonElement>('.note-recovery button')].find(button=>button.textContent==='Save recovery copy')!;
  assert.ok(button);button.click();await new Promise(done=>setTimeout(done,0));
  assert.match([...document.querySelectorAll('.notice')].at(-1)?.textContent??'',/draft is retained here.*copy has not been confirmed/);
  assert.doesNotMatch(document.body.innerHTML,/IPC|operation-uuid|checkpoint_cas|schema_version/);
  buffer.saveRecoveryCopy=save;await save();await f.workspace.flush();
});


const historyVersion={snapshotId:'42',entryId:'id_A_md',path:'A.md',capturedAtMs:1_700_000_000_000,byteLength:12};
const noteHistory={list:async()=>({versions:[historyVersion]}),read:async()=>({version:historyVersion,content:'Older note α'})};
test('version history restores through the ordinary shared note save and refreshes the editor',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md',recoveryHistory:noteHistory});
  let writes=0;const write=f.adapter.write.bind(f.adapter);f.adapter.write=async(path,content)=>{writes++;await write(path,content);};
  await(f.workspace as any).showVersionHistory('A.md');await new Promise<void>(resolve=>setImmediate(resolve));
  document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await new Promise<void>(resolve=>setImmediate(resolve));
  const restore=[...document.querySelectorAll<HTMLButtonElement>('.version-history button')].find(button=>button.textContent==='Restore version')!;
  restore.click();await new Promise<void>(resolve=>setImmediate(resolve));await f.workspace.flush();
  assert.equal(await f.adapter.read('A.md'),'Older note α');assert.equal(writes,1);assert.equal(f.workspace.activePane.editor?.getValue(),'Older note α');assert.equal(document.querySelector('.version-history'),null);
});
test('version history preserves edits made while browsing and refuses a changed saved revision',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md',recoveryHistory:noteHistory});
  const stat=f.adapter.stat.bind(f.adapter);f.adapter.stat=async path=>{const value=await stat(path);return value?{...value,entryId:'id_'+path.replaceAll('.','_')}:null;};
  await(f.workspace as any).showVersionHistory('A.md');await new Promise<void>(resolve=>setImmediate(resolve));
  document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await new Promise<void>(resolve=>setImmediate(resolve));
  const input=document.querySelector<HTMLTextAreaElement>('.editor-host textarea')!;input.value='Current unsaved draft';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  const restore=[...document.querySelectorAll<HTMLButtonElement>('.version-history button')].find(button=>button.textContent==='Restore version')!;
  restore.click();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.match(document.querySelector('.version-history-message')!.textContent!,/Save your changes before restoring/);
  assert.equal(f.workspace.buffers.get('A.md')!.text,'Current unsaved draft');assert.equal(await f.adapter.read('A.md'),'Alpha');
  await f.workspace.flush();restore.click();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.match(document.querySelector('.version-history-message')!.textContent!,/This note changed/);
  assert.equal(await f.adapter.read('A.md'),'Current unsaved draft');
  [...document.querySelectorAll<HTMLButtonElement>('.version-history button')].find(button=>button.textContent==='Close')!.click();
});


test('command palette exposes Version history only for an available identified Markdown note',async t=>{
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md'});
  assert.equal((f.workspace as any).commands().some((command:{id:string})=>command.id==='version-history'),false);
  (f.platform as any).recoveryHistory=noteHistory;
  f.workspace.commandPalette();
  const input=document.querySelector<HTMLInputElement>('.command-input')!;input.value='Version history';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  const rows=document.querySelectorAll<HTMLElement>('.suggestion');assert.equal(rows.length,1);assert.equal(rows[0].textContent,'Version history');rows[0].click();
  await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(document.querySelector('.version-history'));
  [...document.querySelectorAll<HTMLButtonElement>('.version-history button')].find(button=>button.textContent==='Close')!.click();
  await f.workspace.openNote('Bad.canvas');assert.equal((f.workspace as any).commands().some((command:{id:string})=>command.id==='version-history'),false);
});
test('captured Version history command cannot target a replacement entry',async t=>{
  let reads=0;
  const f=await setup(t,{initialPath:'A.md',initialEntryId:'id_A_md',recoveryHistory:{...noteHistory,list:async()=>{reads++;return{versions:[]};}}});
  const command=(f.workspace as any).commands().find((command:{id:string})=>command.id==='version-history');assert.ok(command);
  const entry=f.workspace.vault.entries.get('A.md')!;f.workspace.vault.entries.set('A.md',{...entry,entryId:'replacement'});
  await command.action();assert.equal(reads,0);assert.equal(document.querySelector('.version-history'),null);
});

test('ambiguous protected versions stay accessible as exact read-only copies without replaying saved operations',async t=>{
  const recovered=await durableRecoveryFixture(),scope={...recovered.adapter.durableWrites.checkpoints.scope,incarnationId:'panel-current'};
  const base=await recovered.adapter.durableWrites.readTextById('retained-note');assert.ok(base);
  const branches=new Map<string,any>(),reads:unknown[]=[],mutations:unknown[]=[];
  for(const [writer,draft] of [['branch-a','Exact protected A\r\n<script>inert</script>'],['branch-b','Protected B']]){
    const value={...scope,incarnationId:'prior-panel',entryId:'retained-note',writer,revision:'1',generation:2,deleted:false,baseline:{entryId:base.entryId,path:base.path,revision:base.revision,content:base.content},draft,checkpointRevision:null,pendingOperation:'{"operation":"must never execute"}'};
    branches.set(value.incarnationId+':'+writer,value);
  }
  const receipt=(value:any)=>Object.fromEntries(['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'].map(key=>[key,value[key]]));
  const provider={scope,
    list:async({entryId}:any)=>[...branches.values()].filter(row=>!row.deleted&&row.entryId===entryId).map(receipt),
    read:async(address:any)=>{reads.push(address);return structuredClone(branches.get((address.incarnationId??scope.incarnationId)+':'+address.writer)??null);},
    compareAndSwap:async(change:any)=>{mutations.push(change);const value={...change,...scope,revision:change.nextRevision,deleted:false};branches.set(scope.incarnationId+':'+change.writer,value);return receipt(value);},
    retire:async(change:any)=>{mutations.push(change);const value={...scope,...change,revision:change.nextRevision,deleted:true};branches.set(change.incarnationId+':'+change.writer,value);return receipt(value);},
  };
  Object.assign(recovered.adapter,{independentDrafts:provider});
  const f=await setup(t,{editorOnly:true},false,{},undefined,recovered.adapter),buffer=f.workspace.buffers.get('One.md')!;assert.ok(buffer);
  await buffer.flushDraftProtection();const mutationsBefore=mutations.length,readsBefore=reads.length;
  for(const flag of ['closing','platformDraining']){
    const internal=f.workspace as any,opening=internal.showProtectedDrafts('One.md',buffer);internal[flag]=true;
    try{await opening;assert.equal(document.querySelector('.note-journal-recovery'),null,'a late import cannot open a retiring owner');assert.equal(reads.length,readsBefore);}
    finally{internal[flag]=false;internal.noteJournalPanel?.close();}
  }
  let copied='';Object.defineProperty(f.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied=text;}}});
  const versions=[...document.querySelectorAll<HTMLButtonElement>('.native-document-status button')].find(button=>button.textContent==='Protected drafts');assert.ok(versions);versions.click();
  for(let n=0;n<100&&!document.querySelector('.note-journal-recovery .version-history-version');n++)await new Promise(done=>setTimeout(done,5));
  const panel=document.querySelector<HTMLElement>('.note-journal-recovery')!;assert.ok(panel);assert.equal(reads.length,readsBefore,'listing versions must not read their bodies');
  panel.querySelector<HTMLButtonElement>('.version-history-version')!.click();
  const raw='Exact protected A\r\n<script>inert</script>';
  for(let n=0;n<100&&panel.querySelector<HTMLTextAreaElement>('textarea')!.value!==raw.replace(/\r\n/g,'\n');n++)await new Promise(done=>setTimeout(done,5));
  [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Copy preview text')!.click();await new Promise(done=>setTimeout(done,0));
  assert.equal(copied,raw);assert.equal(panel.querySelector('script'),null);assert.equal(mutations.length,mutationsBefore);assert.equal(recovered.plans,0);
  assert.equal(await recovered.adapter.read('One.md'),externalText);assert.equal(recovered.copies.length,0);
  assert.doesNotMatch(panel.textContent??'',/Create recovery copy|create a separate note/);
  [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Close')!.click();assert.equal(document.querySelector('.note-journal-recovery'),null);
  assert.ok(branches.has('prior-panel:branch-a'));assert.ok(branches.has('prior-panel:branch-b'));
  await buffer.saveRecoveryCopy();
});
