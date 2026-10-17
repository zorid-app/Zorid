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


import type {TestContext} from 'node:test';
const base = `pluginRoot: { keep: yes }\nfilters: 'file.ext == "md"'\nviews:\n  - {type: table, name: Table, order: [file.name, status]}\n  - {type: cards, name: Cards, order: [file.name, status]}\n  - {type: list, name: List, order: [file.name, status]}\n  - type: kanban\n    name: Board\n    order: [file.name, status]\n    groupBy: {property: status, direction: ASC}\n    groupOrder: [Todo, Done]\n`;
const note='---\nstatus: Todo\n---\nbody\n';
async function setup(t:TestContext,adapter=new MemoryAdapter({'Work.base':base,'One.md':note,'Other.md':'Other'}),factories:WorkspaceViewFactories={}){
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

test('actual Workspace routes .base to all four existing views and preserves configuration',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Work.base');const session=workspace.activePane.baseView!;assert.ok(session);
  for(const[index,selector]of ['.zorid-bases-table','.bases-cards-container','.bases-list-container','.bases-kanban-view'].entries()){
    await session.selectView(index);assert.ok(workspace.activePane.element.querySelector(selector),selector);
  }
  assert.equal(await adapter.read('Work.base'),base);assert.equal(workspace.buffers.get('Work.base')!.text,base);
  await workspace.openNote('Other.md',true);const tab=workspace.activePane.tabs.find(tab=>tab.path==='Work.base')!;
  await(workspace as any).selectTab(workspace.activePane,tab);assert.equal(workspace.activePane.baseView,session);assert.ok(workspace.activePane.element.querySelector('.bases-kanban-view'));
});

test('Base property edits preserve another pane dirty body, actual CM undo and multiple selections',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('One.md');const notePane=workspace.activePane;await(workspace as any).split();await workspace.openNote('Work.base');
  const view=EditorView.findFromDOM(notePane.element.querySelector('.cm-editor')!)!,handle=notePane.editor!;
  view.dispatch({changes:{from:view.state.doc.length,insert:'unsaved body'},annotations:Transaction.userEvent.of('input')});
  const from=view.state.doc.toString().indexOf('body'),last=view.state.doc.length;
  view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(from+2),EditorSelection.range(last-4,last)],1)});const depth=undoDepth(view.state);
  const input=startEdit(workspace.activePane.element,'Completed longer');key(input,'Enter');
  await until(()=>!input.isConnected,'property commits');await workspace.flush();
  assert.equal(notePane.editor,handle);assert.equal(view.state.doc.toString(),await adapter.read('One.md'));assert.match(view.state.doc.toString(),/unsaved body$/);
  assert.equal(view.state.selection.ranges.length,2);assert.equal(view.state.sliceDoc(view.state.selection.ranges[1].from,view.state.selection.ranges[1].to),'body');assert.equal(undoDepth(view.state),depth);
  assert.equal(undo(view),true);assert.match(view.state.doc.toString(),/status: Completed longer/);assert.doesNotMatch(view.state.doc.toString(),/unsaved body/);await workspace.flush();
});

test('uncommitted Base draft blocks navigation, tab close and vault switch without changing ownership',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('Work.base');const pane=workspace.activePane,tab=pane.tabs.find(tab=>tab.id===pane.active)!,session=pane.baseView!,runtime=pane.runtime!;
  const input=startEdit(pane.element,'keep draft');
  try{
    await assert.rejects(workspace.openNote('Other.md'),/Finish or cancel/);assert.equal(tab.path,'Work.base');assert.equal(pane.baseView,session);
    await assert.rejects((workspace as any).closeTab(pane,tab),/Finish or cancel/);assert.equal(runtime.phase,'active');assert.ok(pane.tabs.includes(tab));
    await assert.rejects(workspace.openVault({adapter:new MemoryAdapter({'New.md':'new'}),id:'new',label:'new'}),/Finish or cancel/);
    assert.equal(pane.baseView,session);assert.equal(input.value,'keep draft');assert.equal(input.isConnected,true);
    const event=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
  }finally{key(input,'Escape');}
});

test('failed Base persistence retains shared recovery, property input and original tab until retry',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Work.base');const session=workspace.activePane.baseView!,write=adapter.write.bind(adapter);let fail=true;
  adapter.write=async(path,text)=>{if(path==='One.md'&&fail)throw new Error('disk unavailable');await write(path,text);};
  const input=startEdit(workspace.activePane.element,'Done');key(input,'Enter');
  try{
    await until(()=>!!workspace.buffers.get('One.md')?.error,'failed save visible');await assert.rejects(workspace.openNote('Other.md'),/disk unavailable/);
    assert.equal(workspace.activePane.baseView,session);assert.equal(input.isConnected,true);assert.equal(input.value,'Done');assert.equal(workspace.buffers.get('One.md')!.dirty,true);assert.match(JSON.stringify(localStorage),/Done/);assert.equal(await adapter.read('One.md'),note);
  }finally{fail=false;key(input,'Enter');await until(()=>!input.isConnected,'same-value retry completes');await workspace.flush();}
  assert.match(await adapter.read('One.md'),/status: Done/);await workspace.openNote('Other.md');assert.equal(workspace.activePane.baseView,undefined);
});

test('external Base modification keeps active property draft and same session, including a cached tab',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Work.base');const session=workspace.activePane.baseView!,input=startEdit(workspace.activePane.element,'draft');
  try{await adapter.write('Work.base',base+'externalOption: true\n');await workspace.vault.reload(['Work.base']);await session.refresh();assert.equal(workspace.activePane.baseView,session);assert.equal(input.isConnected,true);assert.equal(input.value,'draft');}
  finally{key(input,'Escape');}
  await workspace.openNote('Other.md',true);await adapter.write('Work.base',base+'externalOption: changed\n');await workspace.vault.reload(['Work.base']);await session.refresh();
  const tab=workspace.activePane.tabs.find(tab=>tab.path==='Work.base')!;await(workspace as any).selectTab(workspace.activePane,tab);assert.equal(workspace.activePane.baseView,session);assert.match(session.state.source,/externalOption: changed/);
});

test('same-window edge docking retains an uncommitted Base input and session without saving',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Other.md');const destination=workspace.activePane;await(workspace as any).split();const source=workspace.activePane;await workspace.openNote('Work.base',true);const tab=source.tabs.find(tab=>tab.id===source.active)!,session=source.baseView!,input=startEdit(source.element,'unsaved property');
  try{
    input.focus();input.setSelectionRange(2,6);await(workspace as any).dockTab({sourcePaneId:source.id,targetPaneId:destination.id,tabId:tab.id,edge:'right',index:0});
    assert.equal(workspace.activePane.baseView,session);assert.equal(workspace.activePane.element.contains(input),true);assert.equal(input.value,'unsaved property');assert.equal(document.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,6);assert.equal(await adapter.read('One.md'),note);
    key(input,'Enter');await until(()=>!input.isConnected,'docked property write completes');assert.match(await adapter.read('One.md'),/unsaved property/);
  }finally{if(input.isConnected)key(input,'Escape');}
});

test('navigation waits for accepted Base persistence before disposing the actual session',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Work.base');const pane=workspace.activePane,session=pane.baseView!,node=pane.element.querySelector('.bases-session')!,write=adapter.write.bind(adapter);
  let release!:()=>void,started=false,finished=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  adapter.write=async(path,text)=>{if(path==='One.md'){started=true;await gate;}await write(path,text);};
  const input=startEdit(pane.element,'Done');key(input,'Enter');let navigation:Promise<void>|undefined;
  try{
    await until(()=>started,'accepted save reaches adapter');navigation=workspace.openNote('Other.md').then(()=>{finished=true;});
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(finished,false);assert.equal(pane.baseView,session);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.path,'Work.base');assert.equal(node.isConnected,true);
    release();await navigation;assert.match(await adapter.read('One.md'),/status: Done/);assert.equal(node.parentElement,null);assert.equal(pane.baseView,undefined);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.path,'Other.md');
  }finally{release();await navigation;adapter.write=write;}
});

test('deleting a clean cached Base releases its session instead of retaining detached query subscriptions',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Work.base');const tab=workspace.activePane.tabs.find(tab=>tab.id===workspace.activePane.active)!,root=workspace.activePane.element.querySelector('.bases-session')!;
  await workspace.openNote('Other.md',true);assert.ok(root.parentElement);await adapter.trash('Work.base');await workspace.vault.reload();
  await until(()=>tab.path===null,'deleted cached Base retires');assert.equal(root.parentElement,null);assert.equal((workspace as any).cachedViews.has(tab),false);
});

test('a delayed Base edit cannot mutate a same-path recreated source and its draft remains cancelable',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Work.base');const pane=workspace.activePane,session=pane.baseView!,read=adapter.read.bind(adapter);
  let release!:()=>void,started=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  adapter.read=async path=>{if(path==='One.md'&&!started){started=true;await gate;}return read(path);};
  const input=startEdit(pane.element,'must not save');key(input,'Enter');
  try{
    await until(()=>started,'shared note load pending');await adapter.trash('Work.base');await workspace.vault.reload();await adapter.write('Work.base',base+'replacement: true\n');await workspace.vault.reload();release();
    await until(()=>input.getAttribute('aria-invalid')==='true','stale edit rejects');assert.equal(pane.baseView,session);assert.equal(input.isConnected,true);assert.equal(input.value,'must not save');assert.equal(await read('One.md'),note);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.path,'Work.base');
  }finally{release();adapter.read=read;key(input,'Escape');}
  await workspace.openNote('Other.md');assert.equal(pane.baseView,undefined);
});

test('a conflicting recovered Base configuration rejects before replacing the current Markdown editor',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('Other.md');const pane=workspace.activePane,handle=pane.editor!,buffer=await(workspace as any).bufferFor('Work.base');
  buffer.update(base+'localDraft: true\n');await adapter.write('Work.base',base+'externalChange: true\n');
  try{
    await assert.rejects(workspace.openNote('Work.base'),/outside this editor/);assert.equal(pane.editor,handle);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)!.path,'Other.md');assert.equal(pane.baseView,undefined);assert.equal(buffer.dirty,true);assert.match(buffer.text,/localDraft: true/);assert.match(await adapter.read('Work.base'),/externalChange: true/);
  }finally{await adapter.write('Work.base',base);await buffer.flush();}
});

test('Base file links retain modifier new-tab intent and reject events from a retired view',async t=>{
  let options:Parameters<NonNullable<WorkspaceViewFactories['base']>>[1]|undefined;
  const {createBaseSession}=await import('../src/bases/session.ts');
  const{workspace}=await setup(t,undefined,{base:(host,value)=>{options=value;return createBaseSession(host,value);}});await workspace.openNote('Work.base');const session=workspace.activePane.baseView!,saved=options!;
  saved.openFile('One.md',new window.MouseEvent('auxclick',{button:1}));await until(()=>workspace.activePane.tabs.some(tab=>tab.path==='One.md'),'middle button opens note tab');assert.equal(workspace.activePane.tabs.length,2);
  const tab=workspace.activePane.tabs.find(tab=>tab.path==='Work.base')!;await(workspace as any).closeTab(workspace.activePane,tab);saved.openFile('Other.md',new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true}));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(workspace.activePane.tabs.length,1);assert.equal(workspace.activePane.tabs[0].path,'One.md');assert.equal(session.hasPendingChanges(),false);
});

test('Cards local thumbnail aliases resolve through shared attachment leases and release on close',async t=>{
  const config=base.replace('{type: cards, name: Cards, order: [file.name, status]}','{type: cards, name: Cards, order: [file.name, status], image: cover}');
  const{workspace}=await setup(t,new MemoryAdapter({'Work.base':config,'One.md':'---\ncover: "[[photo.png|Cover]]"\nstatus: Todo\n---\nbody','photo.png':new Uint8Array([1,2,3]),'Other.md':'Other'}));
  const resources=(workspace as any).attachments,acquire=resources.acquire.bind(resources);let released=0,acquired:string[]=[];
  resources.acquire=async(path:string)=>{acquired.push(path);const lease=await acquire(path);return{...lease,release(){released++;lease.release();}};};
  await workspace.openNote('Work.base');await workspace.activePane.baseView!.selectView(1);await until(()=>!!workspace.activePane.element.querySelector('.bases-cards-cover img'),'local image mounts');assert.deepEqual(acquired,['photo.png']);
  await workspace.openNote('Other.md');assert.equal(released,1);
});

test('Kanban folder move uses guarded Vault rename and migrates an existing peer buffer',async t=>{
  const config='filters: \'file.ext == "md"\'\nviews:\n  - type: kanban\n    name: Folders\n    groupBy: {property: file.folder, direction: ASC}\n';
  const{workspace,adapter}=await setup(t,new MemoryAdapter({'Work.base':config,'One.md':note,'Folder/Two.md':'two'}));
  await workspace.openNote('One.md');const notePane=workspace.activePane,buffer=workspace.buffers.get('One.md')!;await(workspace as any).split();await workspace.openNote('Work.base');
  const root=workspace.activePane.element.querySelector('.bases-kanban-view')!,card=root.querySelector('[data-path="One.md"]')!,column=[...root.querySelectorAll('.bases-kanban-column')].find(node=>node.textContent?.includes('Folder'))!;assert.ok(column);
  const data={effectAllowed:'',dropEffect:'',setData(){},getData(){return'One.md';}};
  const drag=new window.Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(drag,'dataTransfer',{value:data});card.dispatchEvent(drag);
  const drop=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:data});column.dispatchEvent(drop);
  await until(()=>workspace.vault.entries.has('Folder/One.md'),'folder move persists');await until(()=>buffer.path==='Folder/One.md'&&notePane.viewPath==='Folder/One.md','peer buffer and tab relocate');
  assert.equal(workspace.buffers.get('Folder/One.md'),buffer);assert.equal(notePane.tabs.find(tab=>tab.id===notePane.active)!.path,'Folder/One.md');assert.equal(await adapter.read('Folder/One.md'),note);assert.equal(await adapter.stat('One.md'),null);
});

test('a fresh Base result cannot apply an old dirty shared buffer to a recreated target file',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('One.md');const notePane=workspace.activePane,buffer=workspace.buffers.get('One.md')!;
  await(workspace as any).split();await workspace.openNote('Work.base');const view=EditorView.findFromDOM(notePane.element.querySelector('.cm-editor')!)!;
  view.dispatch({changes:{from:view.state.doc.length,insert:'old incarnation draft'},annotations:Transaction.userEvent.of('input')});
  await adapter.trash('One.md');await workspace.vault.reload();await adapter.write('One.md',note);await workspace.vault.reload();await workspace.activePane.baseView!.refresh();
  const input=startEdit(workspace.activePane.element,'must not commit');key(input,'Enter');
  try{
    await until(()=>!input.isConnected||input.getAttribute('aria-invalid')==='true','mutation settles');assert.equal(input.isConnected,true);assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(await adapter.read('One.md'),note);assert.match(buffer.text,/old incarnation draft/);
  }finally{if(input.isConnected)key(input,'Escape');buffer.update(note);await buffer.flush();}
});

test('Base property changes map a parked Markdown selection once and retain its undo history on restore',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('One.md');const handle=workspace.activePane.editor!,view=cm(workspace),tab=workspace.activePane.tabs.find(tab=>tab.id===workspace.activePane.active)!;
  view.dispatch({changes:{from:view.state.doc.length,insert:'retained body'},annotations:Transaction.userEvent.of('input')});const end=view.state.doc.length;
  view.dispatch({selection:EditorSelection.range(end-4,end)});const depth=undoDepth(view.state);await workspace.openNote('Work.base',true);
  const input=startEdit(workspace.activePane.element,'Longer status');key(input,'Enter');await until(()=>!input.isConnected,'parked peer update commits');
  await(workspace as any).selectTab(workspace.activePane,tab);assert.equal(workspace.activePane.editor,handle);assert.equal(undoDepth(view.state),depth);assert.equal(view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to),'body');
  assert.equal(undo(view),true);assert.match(view.state.doc.toString(),/status: Longer status/);assert.doesNotMatch(view.state.doc.toString(),/retained body/);await workspace.flush();
});
