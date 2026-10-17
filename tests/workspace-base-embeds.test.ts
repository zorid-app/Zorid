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
  try{await until(()=>started,'source save is pending');view.dispatch({changes:{from:view.state.doc.length,insert:' second'}});release();await assert.rejects(closing,/changed while closing/);assert.equal(root.isConnected,true);assert.equal(pane.runtime?.phase,'active');const input=startEdit(pane.element,'Still editable');key(input,'Enter');await until(()=>!input.isConnected,'retained Base still writes');await workspace.flush();assert.match(await adapter.read('One.md'),/Still editable/);}
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

