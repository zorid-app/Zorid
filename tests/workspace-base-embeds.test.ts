import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorSelection,Transaction} from '@codemirror/state';
import {undo,undoDepth,redo} from '@codemirror/commands';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {CanvasDocument} from '../src/canvas/document.ts';


import type {TestContext} from 'node:test';
const base = `pluginRoot: { keep: yes }\nfilters: 'file.name == "One"'\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n  - {type: cards, name: Cards, order: [file.name, status]}\n  - {type: list, name: List, order: [file.name, status]}\n  - type: kanban\n    name: Board\n    order: [file.name, status]\n    groupBy: {property: status, direction: ASC}\n    groupOrder: [Todo, Done]\n`;
const note='---\nstatus: Todo\n---\nbody\n';
async function setup(t:TestContext,adapter=new MemoryAdapter({'Work.base':base,'One.md':note,'Other.md':'Other','Source.md':'Intro\n\n![[Work.base#Table]]\n\nEnd'}),factories:WorkspaceViewFactories={}){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const rect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});
  dom.window.Range.prototype.getBoundingClientRect=rect;
  dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  const root=document.querySelector<HTMLElement>('#app')!;
  const editorOptions=new Map<unknown,import('../src/ui/editor.ts').EditorOptions>();
  const destroyed=new Set<unknown>();
  const workspace=new Workspace(root,(parent,options)=>{const handle=createEditor(parent,options),dispose=handle.destroy;handle.destroy=()=>{destroyed.add(handle);dispose();};editorOptions.set(handle,options);return handle;},factories);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:docking',label:'Test'});
  return{dom,root,workspace,adapter,editorOptions,destroyed};
}
async function until(check:()=>boolean,label:string){const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,5));}}

function key(node:Element,key:string){node.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function startEdit(root:ParentNode,value:string){const cell=root.querySelector('[data-property="note.status"][role="gridcell"]')!;assert.ok(cell);key(cell,'Enter');const input=cell.querySelector('input')!;assert.ok(input);input.value=value;return input;}
function cm(workspace:Workspace){return EditorView.findFromDOM(workspace.activePane.element.querySelector('.cm-editor')!)!;}

async function openEmbed(workspace:Workspace){await workspace.openNote('Source.md');await until(()=>!!workspace.activePane.element.querySelector('.zorid-bases-table'),'embedded Base mounts');}

test('Live Base file embeds edit through shared buffers and keep the containing note editor',async t=>{
  const{workspace,adapter}=await setup(t);await openEmbed(workspace);
  const handle=workspace.activePane.editor,view=cm(workspace),before=view.state.doc.toString();
  const input=startEdit(workspace.activePane.element,'Done');key(input,'Enter');
  await until(()=>!input.isConnected,'embedded property commits');await workspace.flush();
  assert.match(await adapter.read('One.md'),/status: Done/);assert.equal(workspace.activePane.editor,handle);assert.equal(view.state.doc.toString(),before);
  assert.equal(await adapter.read('Work.base'),base);
});

test('uncommitted embedded Base edit blocks navigation, mode change and close before source mutation',async t=>{
  const{workspace}=await setup(t);await openEmbed(workspace);const pane=workspace.activePane,tab=pane.tabs.find(tab=>tab.id===pane.active)!,handle=pane.editor;
  const input=startEdit(pane.element,'retain draft');
  try{
    await assert.rejects(workspace.openNote('Other.md'),/Finish or cancel/);
    await assert.rejects((workspace as any).toggleReading(pane),/Finish or cancel/);assert.equal(tab.mode,'live');
    await assert.rejects((workspace as any).closeTab(pane,tab),/Finish or cancel/);
    assert.equal(pane.editor,handle);assert.equal(input.isConnected,true);assert.equal(input.value,'retain draft');
    const event=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
  }finally{key(input,'Escape');}
  await(workspace as any).toggleReading(pane);await until(()=>!!pane.element.querySelector('.markdown-preview .zorid-bases-table'),'Reading Base mounts');
  const next=startEdit(pane.element,'Reading saved');key(next,'Enter');await until(()=>!next.isConnected,'Reading edit commits');await workspace.flush();
});

test('source removal retains a visible editable Base draft and remount reuses its DOM',async t=>{
  const{workspace}=await setup(t);await openEmbed(workspace);const pane=workspace.activePane,view=cm(workspace),source=view.state.doc.toString();
  const input=startEdit(pane.element,'recover me'),session=input.closest('.base-embed-session')!;
  try{
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'Embed removed'}});
    await until(()=>!!pane.element.querySelector('.base-embed-recovery input'),'detached draft is visible');
    assert.equal(input.isConnected,true);assert.equal(pane.element.querySelector('.base-embed-recovery')!.hasAttribute('hidden'),false);
    await assert.rejects(workspace.openNote('Other.md'),/Finish or cancel/);
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:source}});
    await until(()=>session.closest('.internal-embed')!==null,'original session remounts');assert.equal(input.value,'recover me');
  }finally{key(input,'Escape');}
});

test('failed embedded property writes retain recovery and retry before navigation',async t=>{
  const{workspace,adapter}=await setup(t);await openEmbed(workspace);const write=adapter.write.bind(adapter);let fail=true;
  adapter.write=async(path,text)=>{if(path==='One.md'&&fail)throw new Error('disk unavailable');await write(path,text);};
  const input=startEdit(workspace.activePane.element,'Done');key(input,'Enter');
  try{await until(()=>!!workspace.buffers.get('One.md')?.error,'failed write visible');await assert.rejects(workspace.openNote('Other.md'),/disk unavailable/);assert.equal(input.isConnected,true);assert.equal(input.value,'Done');assert.match(JSON.stringify(localStorage),/Done/);}
  finally{fail=false;key(input,'Enter');await until(()=>!input.isConnected,'retry saved');await workspace.flush();}
  await workspace.openNote('Other.md');assert.match(await adapter.read('One.md'),/status: Done/);
});

test('named views select exactly and missing names never silently choose a different view',async t=>{
  const{workspace}=await setup(t);await openEmbed(workspace);const view=cm(workspace);
  view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'Intro\n\n![[Work.base#Cards]]\n\nEnd'}});
  await until(()=>!!workspace.activePane.element.querySelector('.bases-cards-container'),'named Cards mounts');
  view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'Intro\n\n![[Work.base#Missing]]\n\nEnd'}});
  await until(()=>workspace.activePane.element.textContent!.includes('Base view not found: Missing'),'missing view error');
  assert.equal(workspace.activePane.element.querySelector('.internal-embed .zorid-bases-table'),null);await workspace.openNote('Other.md');
});

test('embedded query this context is the containing Markdown file',async t=>{
  const config=`filters: 'file == this.file'\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n`;
  const{workspace}=await setup(t,new MemoryAdapter({'Work.base':config,'Source.md':'---\nstatus: Owner\n---\nIntro\n\n![[Work.base]]','Other.md':'Other'}));await openEmbed(workspace);
  const table=workspace.activePane.element.querySelector('.zorid-bases-table')!;assert.match(table.textContent!,/Source/);assert.match(table.textContent!,/Owner/);assert.doesNotMatch(table.textContent!,/Other/);
});

test('navigation awaits an accepted embedded write while source and session stay alive',async t=>{
  const{workspace,adapter}=await setup(t);await openEmbed(workspace);const pane=workspace.activePane,root=pane.element.querySelector('.bases-session')!,write=adapter.write.bind(adapter);
  let release!:()=>void,started=false,finished=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  adapter.write=async(path,text)=>{if(path==='One.md'){started=true;await gate;}await write(path,text);};
  const input=startEdit(pane.element,'Done');key(input,'Enter');let navigation:Promise<void>|undefined;
  try{await until(()=>started,'save starts');navigation=workspace.openNote('Other.md').then(()=>{finished=true;});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(finished,false);assert.equal(root.isConnected,true);assert.equal(pane.viewPath,'Source.md');release();await navigation;assert.match(await adapter.read('One.md'),/status: Done/);assert.equal(root.isConnected,false);}
  finally{release();await navigation;adapter.write=write;}
});

test('retired Base targets retain actionable drafts and cannot edit replacement files',async t=>{
  const{workspace,adapter}=await setup(t);await openEmbed(workspace);const input=startEdit(workspace.activePane.element,'old target draft');
  try{
    await workspace.vault.rename('Work.base','Moved.base');
    await until(()=>!!workspace.activePane.element.querySelector('.base-embed-recovery input'),'renamed target draft recovered');
    await adapter.write('Work.base',base);await workspace.vault.reload();key(input,'Enter');
    await until(()=>workspace.activePane.element.textContent!.includes('Base file changed'),'retired write rejected');
    assert.equal(await adapter.read('One.md'),note);assert.equal(input.value,'old target draft');assert.equal(input.isConnected,true);
    await assert.rejects(workspace.openNote('Other.md'),/Finish or cancel/);
  }finally{key(input,'Escape');}
  await workspace.openNote('Other.md');
});

test('deleted source retains draft recovery and rejects later edits before target mutation',async t=>{
  const{workspace,adapter}=await setup(t);await openEmbed(workspace);const input=startEdit(workspace.activePane.element,'closed source');
  try{await adapter.trash('Source.md');await workspace.vault.reload();key(input,'Enter');await until(()=>workspace.activePane.element.textContent!.includes('source document changed'),'source guard rejects');assert.equal(input.isConnected,true);assert.equal(await adapter.read('One.md'),note);await assert.rejects(workspace.openNote('Other.md'),/Finish or cancel/);}
  finally{key(input,'Escape');}
});

test('editing the source during a delayed close leaves embedded sessions usable after close rejection',async t=>{
  const{workspace,adapter}=await setup(t);await openEmbed(workspace);const pane=workspace.activePane,tab=pane.tabs.find(tab=>tab.id===pane.active)!,view=cm(workspace),root=pane.element.querySelector('.bases-session')!,write=adapter.write.bind(adapter);
  let release!:()=>void,started=false;const gate=new Promise<void>(resolve=>{release=resolve;});adapter.write=async(path,text)=>{if(path==='Source.md'){started=true;await gate;}await write(path,text);};
  view.dispatch({changes:{from:view.state.doc.length,insert:' first'}});const closing=(workspace as any).closeTab(pane,tab);void closing.catch(()=>{});
  try{await until(()=>started,'source save is pending');view.dispatch({changes:{from:view.state.doc.length,insert:' second'}});release();await assert.rejects(closing,/changed while closing/);assert.equal(root.isConnected,true);assert.equal(pane.runtime?.phase,'active');await until(()=>root.querySelector('[data-property="note.status"][role="gridcell"]')?.getAttribute('aria-disabled')==='false'&&root.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false','same retained Base admits edits after saved-source invalidation');const input=startEdit(pane.element,'Still editable');key(input,'Enter');await until(()=>!input.isConnected,'retained Base still writes');await workspace.flush();assert.match(await adapter.read('One.md'),/Still editable/);}
  finally{release();await closing.catch(()=>{});adapter.write=write;}
});

for(const kind of ['text','file'] as const)test(`Canvas ${kind} card embedded Base edits save and block destructive replacement`,async t=>{
  const text='Intro\n\n![[Work.base#Table]]\n\nEnd';
  const seed=JSON.stringify({nodes:[{id:'card',type:kind,...(kind==='text'?{text}:{file:'Source.md'}),x:0,y:0,width:450,height:450}],edges:[],custom:{keep:true}});
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':seed,'Source.md':text,'Work.base':base,'One.md':note,'Other.md':'Other'}));
  await workspace.openNote('Board.canvas');const pane=workspace.activePane,canvas=pane.canvasView!;
  await until(()=>!!pane.element.querySelector('.zorid-bases-table'),'Canvas Base preview mounts');const input=startEdit(pane.element,'Canvas saved');
  try{
    assert.equal(canvas.hasPendingChanges(),true);assert.throws(()=>canvas.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}')),/unsaved|embedded/i);
    await assert.rejects(workspace.openNote('Other.md'),/Finish or cancel/);assert.equal(input.isConnected,true);assert.equal(input.value,'Canvas saved');
    key(input,'Enter');await until(()=>!input.isConnected,'Canvas embedded edit commits');await workspace.flush();assert.match(await adapter.read('One.md'),/Canvas saved/);assert.equal(await adapter.read('Board.canvas'),seed);
  }finally{if(input.isConnected)key(input,'Escape');}
  await workspace.openNote('Other.md');assert.equal(pane.canvasView,undefined);
});

test('standalone Base keeps its own this.file context after sharing the embed factory',async t=>{
  const config=`filters: 'file == this.file'\nviews:\n  - {type: table, name: Table, order: [file.name]}\n`;
  const{workspace}=await setup(t,new MemoryAdapter({'Work.base':config,'Source.md':'Source'}));await workspace.openNote('Work.base');assert.deepEqual(workspace.activePane.baseView!.state.result!.rows.map(row=>row.path),['Work.base']);
});

test('a replaced nested source mounts a fresh writable session instead of reusing retired guards',async t=>{
  const outer='Intro\n\n![[Inner]]\n\nEnd',inner='![[Work.base#Table]]';
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Source.md':outer,'Inner.md':inner,'Work.base':base,'One.md':note,'Other.md':'Other'}));await openEmbed(workspace);
  const first=workspace.activePane.element.querySelector('.bases-session');await adapter.trash('Inner.md');await workspace.vault.reload();await adapter.write('Inner.md',inner);await workspace.vault.reload();
  await until(()=>!!workspace.activePane.element.querySelector('.bases-session')&&workspace.activePane.element.querySelector('.bases-session')!==first,'fresh nested session');
  const input=startEdit(workspace.activePane.element,'New source');key(input,'Enter');await until(()=>!input.isConnected,'fresh source write allowed');await workspace.flush();assert.match(await adapter.read('One.md'),/New source/);
});

test('a missing named view can recover after its Base configuration is repaired',async t=>{
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Source.md':'Intro\n\n![[Work.base#Added]]\n\nEnd','Work.base':base,'One.md':note,'Other.md':'Other'}));await workspace.openNote('Source.md');
  await until(()=>workspace.activePane.element.textContent!.includes('Base view not found: Added'),'missing view shown');
  await adapter.write('Work.base',base.replace('name: Table','name: Added'));await workspace.vault.reload(['Work.base']);
  await until(()=>!!workspace.activePane.element.querySelector('.zorid-bases-table'),'repaired named view mounts');const input=startEdit(workspace.activePane.element,'Recovered');key(input,'Enter');await until(()=>!input.isConnected,'repaired view writes');await workspace.flush();assert.match(await adapter.read('One.md'),/Recovered/);
});

test('named embedded views follow configuration reorder and show removal without falling back',async t=>{
  const table='  - {type: table, name: Table, order: [file.name, status]}\n',cards='  - {type: cards, name: Cards, order: [file.name, status]}\n',prefix=`filters: 'file.name == "One"'\nviews:\n`;
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Source.md':'Intro\n\n![[Work.base#Cards]]\n\nEnd','Work.base':prefix+table+cards,'One.md':note,'Other.md':'Other'}));await workspace.openNote('Source.md');
  await until(()=>!!workspace.activePane.element.querySelector('.bases-cards-container'),'Cards shown');const root=workspace.activePane.element.querySelector('.bases-session')!;
  await adapter.write('Work.base',prefix+cards+table);await workspace.vault.reload(['Work.base']);await until(()=>workspace.activePane.element.querySelector<HTMLSelectElement>('.bases-session select')?.value==='0','Cards follows reordered index');assert.equal(workspace.activePane.element.querySelector('.bases-session'),root);assert.ok(root.querySelector('.bases-cards-container'));
  await adapter.write('Work.base',prefix+table);await workspace.vault.reload(['Work.base']);await until(()=>root.textContent!.includes('Base view not found: Cards'),'missing name visible');assert.equal(root.querySelector('.zorid-bases-table'),null);
});

test('Markdown view fragments decode URL spelling while wiki percent names remain literal',async t=>{
  const config=`filters: 'file.name == "One"'\nviews:\n  - {type: cards, name: 'My View', order: [file.name]}\n  - {type: table, name: 'My%20View', order: [file.name, status]}\n`;
  const{workspace}=await setup(t,new MemoryAdapter({'Source.md':'Intro\n\n![](Work.base#My%20View)\n\n![[Work.base#My%20View]]\n\nEnd','Work.base':config,'One.md':note}));await workspace.openNote('Source.md');
  await until(()=>!!workspace.activePane.element.querySelector('.bases-cards-container')&&!!workspace.activePane.element.querySelector('.zorid-bases-table'),'both exact names mount');
  assert.deepEqual([...workspace.activePane.element.querySelectorAll<HTMLSelectElement>('.bases-session select')].map(select=>select.selectedOptions[0].textContent),['My View','My%20View']);
});

test('normal Base New opens a selected popup title and saves full template, title, body and properties through shared buffers',async t=>{
  const template='---\nstatus: Todo\ncustom: Keep\n---\n# Full copied body\nLiteral {{date}}\n';
  const config='newItemFolder: Books\nnewItemTemplate: Templates/Book.md\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n';
  const{workspace,adapter,dom}=await setup(t,new MemoryAdapter({'Work.base':config,'Templates/Book.md':template,'Books/Existing.md':'Existing'}));
  await workspace.openNote('Work.base');await until(()=>!!workspace.activePane.element.querySelector('.bases-session [aria-label="New"]'),'New available');
  workspace.activePane.element.querySelector<HTMLButtonElement>('.bases-session [aria-label="New"]')!.click();
  await until(()=>!!document.querySelector('.bases-new-item-popover'),'new note popup opens');
  const popup=document.querySelector<HTMLElement>('.bases-new-item-popover')!,title=popup.querySelector<HTMLElement>('.inline-title')!;
  assert.equal(popup.style.width,'452px');assert.equal(document.activeElement,title);assert.equal(dom.window.getSelection()?.toString(),title.textContent);
  const created=[...workspace.buffers].find(([path])=>path.startsWith('Books/')&&path!=='Books/Existing.md')!;
  assert.ok(created);assert.equal(created[1].text,template);assert.equal(await adapter.read(created[0]),template);
  title.textContent='New book';title.dispatchEvent(new dom.window.Event('input',{bubbles:true}));key(title,'Enter');
  await until(()=>workspace.buffers.has('Books/New book.md')&&!!popup.querySelector('.cm-editor'),'title rename and body expand');
  const body=EditorView.findFromDOM(popup.querySelector('.cm-editor')!)!;body.dispatch({changes:{from:body.state.doc.length,insert:'\nWritten in popup'}});
  popup.querySelector<HTMLElement>('.metadata-properties-heading')!.click();const status=popup.querySelector<HTMLInputElement>('[aria-label="status value"]')!;
  status.value='Done';status.dispatchEvent(new dom.window.Event('input',{bubbles:true}));status.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await workspace.flush();const saved=await adapter.read('Books/New book.md');assert.match(saved,/status: Done/);assert.match(saved,/custom: Keep/);assert.match(saved,/Literal \{\{date\}\}/);assert.ok(saved.endsWith('Written in popup'));
  assert.equal(await adapter.read('Templates/Book.md'),template);assert.equal(workspace.activePane.viewPath,'Work.base');
});

test('workspace unload guards popup-only title drafts and failed shutdown retains its body for retry',async t=>{
  const config='views:\n  - {type: table, name: Table, order: [file.name]}\n';
  const{workspace,adapter,dom}=await setup(t,new MemoryAdapter({'Work.base':config}));await workspace.openNote('Work.base');
  workspace.activePane.element.querySelector<HTMLButtonElement>('.bases-session [aria-label="New"]')!.click();await until(()=>!!document.querySelector('.bases-new-item-popover'),'popup opens');
  const popup=document.querySelector<HTMLElement>('.bases-new-item-popover')!,title=popup.querySelector<HTMLElement>('.inline-title')!;
  title.textContent='Retained';title.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  key(title,'Enter');await until(()=>workspace.buffers.has('Retained.md')&&!!popup.querySelector('.cm-editor'),'renamed popup editor');
  const body=EditorView.findFromDOM(popup.querySelector('.cm-editor')!)!;body.dispatch({changes:{from:body.state.doc.length,insert:'Keep failed popup body'}});
  const write=adapter.write.bind(adapter);adapter.write=async(path,source)=>{if(path==='Retained.md')throw new Error('Popup disk failure');await write(path,source);};
  await assert.rejects(workspace.destroy(),/Popup disk failure/);assert.ok(popup.isConnected);assert.match(workspace.buffers.get('Retained.md')!.text,/Keep failed popup body/);
  adapter.write=write;await workspace.flush();assert.match(await adapter.read('Retained.md'),/Keep failed popup body/);
});

test('an embedded Base property draft inside New blocks workspace shutdown until it is committed',async t=>{
  const config='newItemTemplate: Template.md\nfilters: \'file.name == "One"\'\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n';
  const{workspace,adapter,dom}=await setup(t,new MemoryAdapter({'Work.base':config,'One.md':note,'Template.md':'---\nstatus: Todo\n---\nIntro\n\n![[Work.base#Table]]\n\nEnd'}));
  await workspace.openNote('Work.base');workspace.activePane.element.querySelector<HTMLButtonElement>('.bases-session [aria-label="New"]')!.click();
  await until(()=>!!document.querySelector('.bases-new-item-popover'),'popup opens');const popup=document.querySelector<HTMLElement>('.bases-new-item-popover')!;
  popup.querySelector<HTMLElement>('.bases-new-item-body-preview')!.click();await until(()=>!!popup.querySelector('.zorid-bases-table'),'nested Base mounts through popup editor services');
  const input=startEdit(popup,'Done');
  const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  await assert.rejects(workspace.destroy(),/Finish|cancel|edit/);assert.ok(popup.isConnected);assert.equal(input.value,'Done');
  key(input,'Enter');await until(()=>!input.isConnected,'nested edit settles');await workspace.flush();assert.match(await adapter.read('One.md'),/status: Done/);
});

test('sidebar-only property drafts guard unload and sidebar file/visibility survive vault reopen',async t=>{
  const{workspace,adapter,dom}=await setup(t);await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  const sidebar=document.querySelector<HTMLElement>('.sidebar-base-host')!;const input=startEdit(sidebar,'Done');
  const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  key(input,'Escape');await workspace.flush();workspace.root.classList.add('right-hidden');
  await workspace.openVault({adapter,id:'test:docking',label:'Test'});
  assert.ok(document.querySelector('.sidebar-base-host .bases-session'));assert.equal(workspace.root.classList.contains('right-hidden'),true);
  assert.equal((workspace as any).sidebarBase.path,'Work.base');assert.equal((workspace as any).sidebarBase.context,'One.md');
});

test('a clean sidebar Base follows a file rename and remains editable with the same main-note context',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  const previous=(workspace as any).sidebarBase;await workspace.vault.rename('Work.base','Renamed.base');
  await until(()=>(workspace as any).sidebarBase?.path==='Renamed.base','clean sidebar remounts renamed Base');
  assert.notEqual((workspace as any).sidebarBase.session,previous.session);assert.equal((workspace as any).sidebarBase.context,'One.md');
  const sidebar=document.querySelector<HTMLElement>('.sidebar-base-host')!,input=startEdit(sidebar,'Done');key(input,'Enter');await until(()=>!input.isConnected,'renamed sidebar property saves');
  await workspace.flush();assert.match(await adapter.read('One.md'),/status: Done/);assert.equal(workspace.activePane.viewPath,'One.md');
});

test('a clean sidebar Base follows folder rename without changing the selected sidebar tab or hidden state',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'Bases/Work.base':base,'One.md':note}));await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Bases/Work.base');
  (workspace as any).rightTab='outline';(workspace as any).renderRight();workspace.root.classList.add('right-hidden');
  await workspace.vault.rename('Bases','Moved');await until(()=>(workspace as any).sidebarBase?.path==='Moved/Work.base','sidebar follows containing folder');
  assert.equal((workspace as any).rightTab,'outline');assert.equal(workspace.root.classList.contains('right-hidden'),true);assert.equal((workspace as any).sidebarBase.context,'One.md');
});

test('a sidebar Base rename preserves its dirty property DOM until cancellation and explicit reopening',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  const previous=(workspace as any).sidebarBase,sidebar=document.querySelector<HTMLElement>('.sidebar-base-host')!,input=startEdit(sidebar,'Unaccepted');
  await workspace.vault.rename('Work.base','Renamed.base');await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal((workspace as any).sidebarBase,previous);assert.equal(input.isConnected,true);assert.equal(input.value,'Unaccepted');await assert.rejects(workspace.flush(),/Finish|cancel|edit/);assert.equal(await adapter.read('One.md'),note);
  key(input,'Escape');workspace.root.querySelector<HTMLButtonElement>('[aria-label="Bases"]')!.click();
  await until(()=>(workspace as any).sidebarBase?.path==='Renamed.base','cancelled retained sidebar can reopen renamed target');
  const current=document.querySelector<HTMLElement>('.sidebar-base-host')!,accepted=startEdit(current,'Done');key(accepted,'Enter');await until(()=>!accepted.isConnected,'reopened sidebar edits');await workspace.flush();assert.match(await adapter.read('One.md'),/status: Done/);
});

test('a newer explicit sidebar target supersedes a queued background rename remount',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'Work.base':base,'Other.base':base,'One.md':note}));await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  let opened:Promise<void>|undefined;const stop=workspace.vault.on('rename',()=>{opened=(workspace as any).openBaseSidebar('Other.base');});
  try{await workspace.vault.rename('Work.base','Renamed.base');await opened;await new Promise(resolve=>setTimeout(resolve,60));assert.equal((workspace as any).sidebarBase.path,'Other.base');assert.equal((workspace as any).sidebarBasePath,'Other.base');}
  finally{stop();}
});

test('a newer sidebar target joins an in-flight rename teardown and mounts after it',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'Work.base':base,'Other.base':base,'One.md':note}));await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  const previous=(workspace as any).sidebarBase,close=previous.session.close.bind(previous.session);let calls=0,opened:Promise<void>|undefined;
  previous.session.close=()=>{calls++;const result=close();if(calls===1){opened=(workspace as any).openBaseSidebar('Other.base');void opened!.catch(()=>{});}return result;};
  await workspace.vault.rename('Work.base','Renamed.base');await until(()=>!!opened,'new request starts during old close');await opened;
  assert.equal(calls,1);assert.equal((workspace as any).sidebarBase.path,'Other.base');assert.equal((workspace as any).sidebarBasePath,'Other.base');
  assert.notEqual((workspace as any).sidebarBase,previous);assert.ok(document.querySelector('.sidebar-base-host .bases-session'));
});

test('failed shared sidebar teardown retains its draft and can retry after cancellation',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'Work.base':base,'Other.base':base,'One.md':note}));await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  const previous=(workspace as any).sidebarBase,input=startEdit(previous.host,'Unaccepted'),close=previous.session.close.bind(previous.session);let release!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});previous.session.close=async()=>{calls++;await gate;await close();};
  const first=(workspace as any).openBaseSidebar('Other.base'),second=(workspace as any).openBaseSidebar('Other.base');
  const settled=Promise.allSettled([first,second]);release();const results=await settled;
  try{
    assert.equal(calls,1);assert.ok(results.every(result=>result.status==='rejected'&&/Finish|cancel|edit/.test(String(result.reason))));
    assert.equal((workspace as any).sidebarBase,previous);assert.equal(input.isConnected,true);assert.equal(input.value,'Unaccepted');
  }finally{key(input,'Escape');}
  await (workspace as any).openBaseSidebar('Other.base');assert.equal(calls,2);assert.equal((workspace as any).sidebarBase.path,'Other.base');assert.ok(document.querySelector('.sidebar-base-host .bases-session'));
});

test('a destination replacement during clean sidebar teardown is not adopted by the rename remount',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('One.md');await (workspace as any).openBaseSidebar('Work.base');
  const previous=(workspace as any).sidebarBase,close=previous.session.close.bind(previous.session);let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  previous.session.close=async()=>{started();await gate;await close();};
  await workspace.vault.rename('Work.base','Renamed.base');await entered;
  await workspace.vault.trash('Renamed.base');await workspace.vault.create('Renamed.base','views: [{type: list, name: Replacement}]\n');release();
  await until(()=>!!document.querySelector('.notice')?.textContent?.includes('selected sidebar Base changed'),'replacement identity rejection is visible');
  assert.equal((workspace as any).sidebarBase,previous);assert.equal(await adapter.read('One.md'),note);assert.match(await adapter.read('Renamed.base'),/Replacement/);
});

test('Create Base retries its retained uncertain operation without allocating a second filename',async t=>{
  const{workspace,adapter,dom}=await setup(t,new MemoryAdapter({}));const write=adapter.write.bind(adapter);let writes=0;
  adapter.write=async(path,source)=>{await write(path,source);if(path==='Untitled.base'&&++writes===1)throw new Error('Creation acknowledgement lost');};
  await assert.rejects((workspace as any).newBase(),/acknowledgement lost/);
  await assert.rejects((workspace as any).newBase(),/already have committed|Recover its original operation/);
  assert.deepEqual((await adapter.list()).filter(entry=>entry.path.endsWith('.base')).map(entry=>entry.path),['Untitled.base']);assert.equal(writes,1);
  const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  await assert.rejects(workspace.flush(),/creation is unconfirmed/);
  // This legacy disposable fixture has no receipt API. Retire only its test handle after proving both guards.
  (workspace as any).pendingBaseCreation=undefined;
});


const fencedRenameConfig=`# keep this Base comment\nfilters: 'file.name == "A"'\nviews:\n  - { type: table, name: Fence old, order: [ file.name, score ] }\n`;
const fencedRenameSource='Before\n\n```base\n'+fencedRenameConfig+'```\n\nLiteral fragment sentinel: ![[Work.base#Table]]\nAfter\n';
const fencedRenameExpected=fencedRenameSource.replace('name: Fence old','name: Fence renamed');
async function startFencedRename(t:TestContext){
  // Inline hosts require a stable containing actor/revision even in this
  // explicitly legacy storage fixture. Native guard identity is covered by the
  // separate physical-CAS provider campaign.
  class FencedAdapter extends MemoryAdapter{
    revisions=new Map<string,number>();
    identify<T extends{path:string}>(entry:T){return{...entry,entryId:`fixture:${entry.path}`,revision:`r${this.revisions.get(entry.path)??1}`};}
    override async list(){return(await super.list()).map(entry=>this.identify(entry));}
    override async stat(path:string){const entry=await super.stat(path);return entry&&this.identify(entry);}
    override async write(path:string,text:string){await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);}
  }
  const fixture=await setup(t,new FencedAdapter({'Source.md':fencedRenameSource,'A.md':'---\nscore: 1\n---\nA body\n','Work.base':base,'Other.md':'Other'}));
  await fixture.workspace.openNote('Source.md');const pane=fixture.workspace.activePane;
  await until(()=>!!pane.element.querySelector('.cm-live-base [role="grid"][aria-label="Fence old"]'),'inline table mounts');
  const cell=pane.element.querySelector<HTMLElement>('.cm-live-base [role="gridcell"][data-path="A.md"][data-property="note.score"]')!;
  cell.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));
  fixture.dom.window.dispatchEvent(new fixture.dom.window.MouseEvent('pointerup',{bubbles:true,button:0}));key(cell,'Escape');
  assert.equal(pane.element.querySelector<HTMLElement>('.cm-live-base [role="gridcell"][tabindex="0"]')?.dataset.property,'note.score');
  const trigger=pane.element.querySelector<HTMLButtonElement>('.cm-live-base [aria-label="Views"]')!;assert.ok(trigger);trigger.click();
  const configure=document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!;assert.ok(configure);configure.click();
  const input=document.querySelector<HTMLInputElement>('[aria-label="View name"]')!;assert.ok(input);input.focus();input.value='Fence renamed';input.dispatchEvent(new fixture.dom.window.Event('input',{bubbles:true}));
  const sessionRoot=pane.element.querySelector('.cm-live-base .bases-session')!;
  return{...fixture,pane,input,sessionRoot};
}
function selectedFencedCell(pane:Workspace['activePane']){
  const cell=pane.element.querySelector<HTMLElement>('.cm-live-base [role="grid"][aria-label="Fence renamed"] [role="gridcell"][tabindex="0"]');
  return cell&&{path:cell.dataset.path,property:cell.dataset.property};
}
function closeFencedRename(){const panel=document.querySelector('[role="dialog"][aria-label="View options"]');[...panel?.querySelectorAll<HTMLButtonElement>('button')??[]].find(button=>button.textContent==='Cancel')?.click();}

test('own saved fenced view rename keeps logical row/property selection and remains writable',async t=>{
  const{workspace,adapter,pane,input,sessionRoot}=await startFencedRename(t);key(input,'Enter');
  await until(()=>!!pane.element.querySelector('[role="grid"][aria-label="Fence renamed"]'),'own saved source remounts the renamed fence');
  closeFencedRename();await until(()=>document.querySelector('[role="dialog"][aria-label="View options"]')===null,'configuration panel closes');
  assert.equal(pane.element.querySelector('.cm-live-base .bases-session'),sessionRoot,'own saved host retains its original session');
  assert.deepEqual(selectedFencedCell(pane),{path:'A.md',property:'note.score'});
  assert.equal(await adapter.read('Source.md'),fencedRenameExpected);assert.equal(await adapter.read('Work.base'),base);
  const selected=pane.element.querySelector<HTMLElement>('.cm-live-base [role="gridcell"][data-path="A.md"][data-property="note.score"]')!;key(selected,'Enter');
  const edit=selected.querySelector<HTMLInputElement>('input')!;assert.ok(edit);edit.value='31';key(edit,'Enter');await until(()=>!edit.isConnected,'same fenced property remains writable');await workspace.flush();
  assert.equal(await adapter.read('A.md'),'---\nscore: 31\n---\nA body\n');assert.equal(await adapter.read('Source.md'),fencedRenameExpected);
});

test('terminal fenced configuration review does not acknowledge remount and ordinary Save retains selection',async t=>{
  const fixture=await startFencedRename(t),{workspace,adapter,pane,input}=fixture,write=adapter.write.bind(adapter);let fail=true,attempts=0;
  adapter.write=async(path,text)=>{if(path==='Source.md'){attempts++;if(fail)throw new Error('fenced save unavailable');}await write(path,text);};
  try{
    key(input,'Enter');await until(()=>!!workspace.buffers.get('Source.md')?.error,'failed containing save is retained');
    assert.equal(await adapter.read('Source.md'),fencedRenameSource);assert.equal(cm(workspace).state.doc.toString(),fencedRenameSource);
    assert.equal(pane.element.querySelector<HTMLElement>('.cm-live-base [role="gridcell"][tabindex="0"]')?.dataset.property,'note.score');
    await assert.rejects(workspace.openNote('Other.md'),/fenced save unavailable/);
    const attemptsBeforeReview=attempts;[...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button=>button.textContent==='Review retained changes')!.click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="Accepted configuration"]')!.readOnly,true);assert.equal(attempts,attemptsBeforeReview,'Review cannot persist or remount the containing note');assert.equal(await adapter.read('Source.md'),fencedRenameSource);fail=false;await workspace.flush();
    await until(()=>!!pane.element.querySelector('[role="grid"][aria-label="Fence renamed"]'),'ordinary Save acknowledges the exact retained rename');
    closeFencedRename();assert.deepEqual(selectedFencedCell(pane),{path:'A.md',property:'note.score'});assert.equal(await adapter.read('Source.md'),fencedRenameExpected);
  }finally{fail=false;adapter.write=write;closeFencedRename();}
});

test('a superseded inline host cannot acknowledge or publish peer text after its awaited durable flush',async t=>{
  const{workspace,adapter,pane,input}=await startFencedRename(t),write=adapter.write.bind(adapter),runtime=pane.runtime;
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let hold=true;
  adapter.write=async(path,text)=>{await write(path,text);if(path==='Source.md'&&hold){hold=false;entered();await gate;}};
  try{
    key(input,'Enter');await started;
    // Negative ownership fault: the awaited host's runtime is superseded. No
    // positive UI state is installed through this test-only retirement seam.
    pane.runtime=undefined;release();
    await until(()=>workspace.buffers.get('Source.md')?.savedText===fencedRenameExpected&&!!document.querySelector('.bases-toolbar-error')?.textContent,'late completion rejects its retired owner');
    assert.equal(await adapter.read('Source.md'),fencedRenameExpected,'the already durable write is not rolled back');
    assert.equal(cm(workspace).state.doc.toString(),fencedRenameSource,'retired completion cannot overwrite peer editor text');
    assert.equal(pane.element.querySelector('[role="grid"][aria-label="Fence renamed"]'),null);
    pane.runtime=runtime;input.focus();key(input,'Enter');
    await until(()=>!!pane.element.querySelector('[role="grid"][aria-label="Fence renamed"]'),'ordinary guarded retry acknowledges the saved fence');
    closeFencedRename();assert.deepEqual(selectedFencedCell(pane),{path:'A.md',property:'note.score'});
  }finally{pane.runtime=runtime;release();adapter.write=write;closeFencedRename();}
});


test('explicit Workspace Save completes an exact failed inline configuration and settles its toolbar',async t=>{
  const{workspace,adapter,pane,input,sessionRoot}=await startFencedRename(t),write=adapter.write.bind(adapter);let fail=true;
  adapter.write=async(path,text)=>{if(path==='Source.md'&&fail)throw new Error('fenced save unavailable');await write(path,text);};
  try{
    key(input,'Enter');await until(()=>!!workspace.buffers.get('Source.md')?.error&&!!document.querySelector('.bases-toolbar-error'),'failed command retains toolbar');
    fail=false;await workspace.flush();
    assert.equal(document.querySelector('[role="dialog"][aria-label="View options"]'),null,'successful explicit Save acknowledges only its failed toolbar');
    await until(()=>!!pane.element.querySelector('[role="grid"][aria-label="Fence renamed"]'),'retry query renders');
    assert.equal(pane.element.querySelector('.cm-live-base .bases-session'),sessionRoot);
    assert.deepEqual(selectedFencedCell(pane),{path:'A.md',property:'note.score'});
    assert.equal(await adapter.read('Source.md'),fencedRenameExpected);await workspace.openNote('Other.md');
  }finally{fail=false;adapter.write=write;closeFencedRename();}
});


async function startNestedFencedRename(t:TestContext){
  const config='newItemTemplate: Template.md\nviews:\n  - {type: table, name: Table, order: [file.name]}\n';
  const fixture=await setup(t,new MemoryAdapter({'Work.base':config,'Template.md':fencedRenameSource,'A.md':'---\nscore: 1\n---\nA body\n'}));
  const{workspace,dom}=fixture;await workspace.openNote('Work.base');
  workspace.activePane.element.querySelector<HTMLButtonElement>('.bases-session [aria-label="New"]')!.click();
  await until(()=>!!document.querySelector('.bases-new-item-popover'),'New opens');
  const popup=document.querySelector<HTMLElement>('.bases-new-item-popover')!;
  popup.querySelector<HTMLElement>('.bases-new-item-body-preview')!.click();
  await until(()=>!!popup.querySelector('[role="grid"][aria-label="Fence old"]'),'nested inline table mounts');
  const path=[...workspace.buffers.keys()].find(path=>path!=='Template.md'&&path!=='A.md'&&path!=='Work.base')!;assert.ok(path);
  const cell=popup.querySelector<HTMLElement>('[role="gridcell"][data-path="A.md"][data-property="note.score"]')!;
  cell.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup',{bubbles:true,button:0}));key(cell,'Escape');
  popup.querySelector<HTMLButtonElement>('.cm-live-base [aria-label="Views"]')!.click();
  document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!.click();
  const input=document.querySelector<HTMLInputElement>('[aria-label="View name"]')!;input.focus();input.value='Fence renamed';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  return{...fixture,popup,path,input,sessionRoot:popup.querySelector('.cm-live-base .bases-session')!,view:EditorView.findFromDOM(popup.querySelector('.cm-editor')!)!};
}

test('nested New inline source publication waits for durable acknowledgement including Vault modify refresh',async t=>{
  const{workspace,adapter,popup,path,input,sessionRoot,view}=await startNestedFencedRename(t),write=adapter.write.bind(adapter);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let held=true,observed=false;
  adapter.write=async(target,text)=>{if(target===path&&held){held=false;entered();await gate;}await write(target,text);};
  const stop=workspace.vault.on('modify',entry=>{if(entry.path===path){observed=true;assert.equal(view.state.doc.toString(),fencedRenameSource,'Vault refresh cannot publish before host ack');}});
  try{
    key(input,'Enter');await started;
    assert.equal(view.state.doc.toString(),fencedRenameSource);assert.equal(popup.querySelector('.cm-live-base .bases-session'),sessionRoot);
    release();await until(()=>!!popup.querySelector('[role="grid"][aria-label="Fence renamed"]'),'acknowledged nested fence remounts');closeFencedRename();
    assert.equal(observed,true);assert.equal(popup.querySelector('.cm-live-base .bases-session'),sessionRoot);
    assert.equal(popup.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.dataset.property,'note.score');assert.equal(await adapter.read(path),fencedRenameExpected);await workspace.flush();
  }finally{stop();release();adapter.write=write;closeFencedRename();}
});

test('nested New failed inline save retains source and explicit Workspace Save completes its own retry',async t=>{
  const{workspace,adapter,popup,path,input,sessionRoot,view}=await startNestedFencedRename(t),write=adapter.write.bind(adapter);let fail=true;
  adapter.write=async(target,text)=>{if(target===path&&fail)throw new Error('nested save unavailable');await write(target,text);};
  try{
    key(input,'Enter');await until(()=>!!workspace.buffers.get(path)?.error&&!!document.querySelector('.bases-toolbar-error'),'nested save fails');
    assert.equal(view.state.doc.toString(),fencedRenameSource);assert.equal(await adapter.read(path),fencedRenameSource);assert.equal(popup.querySelector('.cm-live-base .bases-session'),sessionRoot);
    fail=false;await workspace.flush();
    assert.equal(document.querySelector('[role="dialog"][aria-label="View options"]'),null);
    assert.equal(popup.querySelector('.cm-live-base .bases-session'),sessionRoot);assert.equal(popup.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.dataset.property,'note.score');assert.equal(await adapter.read(path),fencedRenameExpected);
  }finally{fail=false;adapter.write=write;closeFencedRename();}
});


test('terminal inline duplicate review preserves its original command until ordinary Save settles it once',async t=>{
  const{workspace,adapter,pane,input}=await startFencedRename(t),write=adapter.write.bind(adapter);let fail=true,writes=0;
  // Cancel the unsubmitted rename draft before choosing the independent command.
  closeFencedRename();pane.element.querySelector<HTMLButtonElement>('.cm-live-base [aria-label="Views"]')!.click();
  document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!.click();
  adapter.write=async(path,text)=>{if(path==='Source.md'){writes++;if(fail)throw new Error('duplicate save unavailable');}await write(path,text);};
  try{
    [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button=>button.textContent==='Duplicate view')!.click();
    await until(()=>!!workspace.buffers.get('Source.md')?.error&&!![...document.querySelectorAll('button')].find(button=>button.textContent==='Review retained changes'),'duplicate persistence fails');
    const beforeReview=writes;[...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button=>button.textContent==='Review retained changes')!.click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(writes,beforeReview,'Review cannot duplicate or retry persistence');assert.equal(await adapter.read('Source.md'),fencedRenameSource);assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="Accepted configuration"]')!.readOnly,true);fail=false;await workspace.flush();
    await until(()=>workspace.buffers.get('Source.md')?.dirty===false&&!document.querySelector('[role="dialog"][aria-label="View options"]'),'retained duplicate closes after retry');
    const source=await adapter.read('Source.md');assert.equal((source.match(/name: Fence old/g)??[]).length,2);assert.match(source,/name: Fence old 2/);assert.equal(writes,2,'one failed persistence plus one exact retry');await workspace.flush();
  }finally{fail=false;adapter.write=write;closeFencedRename();}
});

test('generic inline retry acknowledgement preserves a newer configuration draft typed during the failed write',async t=>{
  const{workspace,adapter,pane,input}=await startFencedRename(t),write=adapter.write.bind(adapter);let release!:()=>void,entered!:()=>void,fail=true;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  adapter.write=async(path,text)=>{if(path==='Source.md'&&fail){entered();await gate;throw new Error('newer draft save unavailable');}await write(path,text);};
  try{
    key(input,'Enter');await started;
    input.value='Newer unaccepted draft';input.dispatchEvent(new window.Event('input',{bubbles:true}));release();
    await until(()=>!!workspace.buffers.get('Source.md')?.error&&!!document.querySelector('.bases-toolbar-error'),'failed first command settles');
    fail=false;await assert.rejects(workspace.flush(),/Finish or cancel/);
    assert.equal(input.isConnected,true);assert.equal(input.value,'Newer unaccepted draft');assert.equal(await adapter.read('Source.md'),fencedRenameExpected,'only first accepted name is persisted');
    closeFencedRename();await workspace.flush();
  }finally{fail=false;release();adapter.write=write;closeFencedRename();}
});

test('foreign containing-buffer edits permanently retire an exact inline retry even after identical bytes return',async t=>{
  let sourceHost:import('../src/bases/session.ts').BaseSessionOptions['inlineSource'];
  const fakeBase=(_host:HTMLElement,options:any)=>{if(options.inlineSource)sourceHost=options.inlineSource;return{ready:Promise.resolve(),state:{error:null},refresh:async()=>{},flush:async()=>{},close:async()=>{},hasPendingChanges:()=>false} as any;};
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Source.md':fencedRenameSource,'A.md':'A'}),{base:fakeBase});
  await workspace.openNote('Source.md');await until(()=>!!sourceHost,'saved inline host exists');const write=adapter.write.bind(adapter);let fail=true;
  adapter.write=async(path,text)=>{if(path==='Source.md'&&fail)throw new Error('held write unavailable');await write(path,text);};
  try{
    await assert.rejects(sourceHost!.transform(fencedRenameConfig,fencedRenameConfig.replace('Fence old','Fence renamed'),()=>{}),/held write unavailable/);
    const retry=sourceHost!.captureSaveRetry!()!;assert.ok(retry);
    const buffer=workspace.buffers.get('Source.md')!;buffer.update(fencedRenameExpected+'Foreign');buffer.update(fencedRenameExpected);
    fail=false;await assert.rejects(retry(),/retained inline configuration changed/);assert.equal(sourceHost!.captureSaveRetry!(),undefined);assert.equal(await adapter.read('Source.md'),fencedRenameSource);
    buffer.update(fencedRenameSource);await workspace.flush();
  }finally{fail=false;adapter.write=write;}
});


test('an awaited inline configuration acknowledgement cannot close a replacement toolbar panel',async t=>{
  const{workspace,adapter,pane,input}=await startFencedRename(t),write=adapter.write.bind(adapter),read=adapter.read.bind(adapter);let fail=true,intercept=true,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  adapter.write=async(path,text)=>{if(path==='Source.md'&&fail)throw new Error('retained name unavailable');await write(path,text);};
  try{
    key(input,'Enter');await until(()=>!!workspace.buffers.get('Source.md')?.error&&!!document.querySelector('.bases-toolbar-error'),'accepted rename fails');fail=false;
    adapter.read=async path=>{const source=await read(path);if(path==='Source.md'&&source===fencedRenameExpected&&intercept){intercept=false;entered();await gate;}return source;};
    const saving=workspace.flush();const settled=saving.then(()=>({error:undefined}),error=>({error}));await started;
    closeFencedRename();pane.element.querySelector<HTMLButtonElement>('.cm-live-base [aria-label="Views"]')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!.click();
    const newer=document.querySelector<HTMLInputElement>('[aria-label="View name"]')!;newer.focus();newer.value='Replacement panel draft';newer.dispatchEvent(new window.Event('input',{bubbles:true}));
    release();const result=await settled;assert.match(String(result.error),/Finish or cancel/);assert.equal(newer.isConnected,true);assert.equal(newer.value,'Replacement panel draft');assert.equal(await adapter.read('Source.md'),fencedRenameExpected);
    closeFencedRename();await workspace.flush();
  }finally{fail=false;release();adapter.write=write;adapter.read=read;closeFencedRename();}
});


test('a superseded subscribed New host releases its clean hold without publishing into its peer editor',async t=>{
  const{workspace,adapter,popup,path,input,view}=await startNestedFencedRename(t),write=adapter.write.bind(adapter);
  closeFencedRename();await workspace.openNote(path);const peer=cm(workspace);
  popup.querySelector<HTMLButtonElement>('.cm-live-base [aria-label="Views"]')!.click();document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!.click();
  const name=document.querySelector<HTMLInputElement>('[aria-label="View name"]')!;name.focus();name.value='Fence renamed';name.dispatchEvent(new window.Event('input',{bubbles:true}));
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let held=true;const buffer=workspace.buffers.get(path)!;
  adapter.write=async(target,text)=>{await write(target,text);if(target===path&&held){held=false;entered();await gate;}};
  try{
    key(name,'Enter');await started;
    // Negative actor retirement: remove its exact containing-buffer admission
    // while the accepted physical write is awaiting acknowledgement.
    workspace.buffers.delete(path);release();
    await until(()=>buffer.savedText===fencedRenameExpected&&!!document.querySelector('.bases-toolbar-error'),'superseded nested completion rejects');
    assert.equal(await adapter.read(path),fencedRenameExpected);assert.equal(view.state.doc.toString(),fencedRenameSource);assert.equal(peer.state.doc.toString(),fencedRenameSource,'rejected actor must not reach New subscriber peer publication');
    workspace.buffers.set(path,buffer);name.focus();key(name,'Enter');await until(()=>!!popup.querySelector('[role="grid"][aria-label="Fence renamed"]'),'current owner can explicitly retry');closeFencedRename();await workspace.flush();
  }finally{workspace.buffers.set(path,buffer);release();adapter.write=write;closeFencedRename();}
});


test('unrelated pane navigation does not retry another pane inline hold but explicit Workspace Save completes it',async t=>{
  const{workspace,adapter,pane}=await startFencedRename(t);closeFencedRename();
  await(workspace as any).split('right',pane);const other=workspace.activePane;assert.notEqual(other,pane);await workspace.openNote('Other.md',false,other);
  pane.element.querySelector<HTMLButtonElement>('.cm-live-base [aria-label="Views"]')!.click();document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!.click();
  const input=document.querySelector<HTMLInputElement>('[aria-label="View name"]')!;input.focus();input.value='Fence renamed';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  const write=adapter.write.bind(adapter);let fail=true,writes=0;
  adapter.write=async(path,text)=>{if(path==='Source.md'){writes++;if(fail)throw new Error('other pane save unavailable');}await write(path,text);};
  try{
    key(input,'Enter');await until(()=>!!workspace.buffers.get('Source.md')?.error&&!!document.querySelector('.bases-toolbar-error'),'second pane retains failed own save');const failedWrites=writes;
    await workspace.openNote('A.md',false,other);
    assert.equal(other.viewPath,'A.md');assert.equal(pane.viewPath,'Source.md');assert.equal(writes,failedWrites,'unrelated navigation does not retry the other source');assert.equal(await adapter.read('Source.md'),fencedRenameSource);
    fail=false;await workspace.flush();await until(()=>!!pane.element.querySelector('[role="grid"][aria-label="Fence renamed"]'),'global Save acknowledges held source');assert.equal(await adapter.read('Source.md'),fencedRenameExpected);assert.equal(document.querySelector('[role="dialog"][aria-label="View options"]'),null);
  }finally{fail=false;adapter.write=write;closeFencedRename();}
});
