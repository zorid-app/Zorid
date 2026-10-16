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
import type {DockIntent} from '../src/ui/tab-docking.ts';
async function setup(t:TestContext,adapter=new MemoryAdapter({'A.md':'Alpha','B.md':'Bravo','C.md':'Charlie','Target.md':'Target'}),factories:WorkspaceViewFactories={}){
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
const dock=(workspace:Workspace,intent:DockIntent)=>(workspace as any).dockTab(intent) as Promise<void>;
const live=(pane:Workspace['activePane'])=>EditorView.findFromDOM(pane.element.querySelector('.cm-editor')!)!;

test('edge split and center merge preserve actual editors, undo, dirty text, selection and destination callbacks',async t=>{
  const {workspace,adapter,editorOptions,destroyed}=await setup(t);
  await workspace.openNote('A.md');const source=workspace.activePane,tabA=source.tabs[0],editorA=source.editor!,viewA=live(source);
  viewA.dispatch({changes:{from:0,insert:'a'},annotations:Transaction.userEvent.of('input.type')});
  await workspace.openNote('B.md',true);const tabB=source.tabs.find(tab=>tab.id===source.active)!,editorB=source.editor!,viewB=live(source);
  assert.equal(destroyed.has(editorA),false,'switching away parks the existing view');
  await (workspace as any).split('right');await workspace.openNote('C.md');const target=workspace.activePane,editorC=target.editor!,viewC=live(target);
  viewC.dispatch({changes:{from:0,insert:'c'},annotations:Transaction.userEvent.of('input.type')});await workspace.flush();
  viewB.dispatch({changes:{from:0,insert:'b'},annotations:Transaction.userEvent.of('input.type')});
  viewB.dispatch({selection:EditorSelection.range(4,1)});source.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop=73;
  let writes=0;const write=adapter.write.bind(adapter);adapter.write=async()=>{writes++;throw new Error('disk offline');};
  await dock(workspace,{sourcePaneId:source.id,tabId:tabB.id,targetPaneId:target.id,edge:'left',index:0});
  const moved=workspace.activePane;
  assert.notEqual(moved,source);assert.equal(moved.tabs[0],tabB);assert.equal(moved.editor,editorB);assert.equal(live(moved),viewB);
  assert.equal(source.tabs[0],tabA);assert.equal(source.editor,editorA);assert.equal(live(source),viewA);
  assert.equal(undoDepth(viewB.state),1);assert.equal(viewB.state.selection.main.anchor,4);assert.equal(viewB.state.selection.main.head,1);
  assert.equal(moved.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop,73);
  assert.equal(workspace.buffers.get('B.md')!.text,'bBravo');assert.equal(workspace.buffers.get('B.md')!.dirty,true);assert.equal(writes,0,'a move does not demand a successful disk write');
  assert.equal(editorOptions.get(editorB)!.wiki!.sourcePath!(),'B.md','cached metadata callbacks follow new pane owner');
  await dock(workspace,{sourcePaneId:moved.id,tabId:tabB.id,targetPaneId:target.id,edge:'center',index:1});
  assert.equal(workspace.panes.includes(moved),false);assert.equal(target.editor,editorB);assert.equal(live(target),viewB);assert.equal(destroyed.has(editorC),false);
  assert.equal(undo(viewB),true);assert.equal(workspace.buffers.get('B.md')!.text,'Bravo');
  adapter.write=write;
  await (workspace as any).selectTab(target,target.tabs.find(tab=>tab.path==='C.md'));
  assert.equal(target.editor,editorC);assert.equal(live(target),viewC);assert.equal(undoDepth(viewC.state),1);assert.equal(undo(viewC),true);
  await (workspace as any).selectTab(target,tabB);
  editorOptions.get(editorB)!.open('Target','wiki');await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(target.tabs.find(tab=>tab.id===target.active)?.path,'Target.md');assert.equal(source.tabs[0].path,'A.md','moved open callback cannot navigate former owner');
});

test('same-pane reorder preserves active identity; sole-tab edge move retains stable pane and editor',async t=>{
  const {workspace}=await setup(t);await workspace.openNote('A.md');await workspace.openNote('B.md',true);
  const source=workspace.activePane,tabA=source.tabs[0],active=source.active,editor=source.editor!,view=live(source);
  view.dispatch({changes:{from:0,insert:'!'},annotations:Transaction.userEvent.of('input.type')});
  await dock(workspace,{sourcePaneId:source.id,tabId:tabA.id,targetPaneId:source.id,edge:'center',index:1});
  assert.equal(source.tabs[1],tabA);assert.equal(source.active,active);assert.equal(source.editor,editor);assert.equal(undoDepth(view.state),1);
  await (workspace as any).split('right');const sole=workspace.activePane,soleEditor=sole.editor!,soleView=live(sole);
  await dock(workspace,{sourcePaneId:sole.id,tabId:sole.active,targetPaneId:source.id,edge:'top',index:0});
  assert.equal(workspace.activePane,sole);assert.equal(sole.editor,soleEditor);assert.equal(live(sole),soleView);assert.equal(workspace.panes.length,2);
});

test('real delegated drag listeners target nested tab-strip nodes and build an edge split',async t=>{
  const {workspace,dom}=await setup(t);await workspace.openNote('A.md');await workspace.openNote('B.md',true);
  const source=workspace.activePane,tab=source.tabs.find(tab=>tab.id===source.active)!,editor=source.editor!;
  const geometry=(element:HTMLElement,x:number,y:number,width:number,height:number)=>{element.getBoundingClientRect=()=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height,toJSON(){return{};}});};
  geometry(source.element,0,0,600,600);const bar=source.element.querySelector<HTMLElement>('.tab-bar')!;geometry(bar,0,0,600,30);
  for(const[index,node]of [...bar.querySelectorAll<HTMLElement>('.tab')].entries())geometry(node,index*100,0,100,30);
  const node=[...bar.querySelectorAll<HTMLElement>('.tab')].find(node=>node.dataset.tabId===tab.id)!;
  const transfer={effectAllowed:'none',dropEffect:'none',setData(){}};
  const drag=(type:string,target:Element,x:number,y:number)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,buttons:1,clientX:x,clientY:y});Object.defineProperty(event,'dataTransfer',{value:transfer});target.dispatchEvent(event);return event;};
  drag('dragstart',node.querySelector('.tab-title')!,150,20);assert.equal(drag('dragover',source.element,590,300).defaultPrevented,true);
  drag('drop',source.element,590,300);await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(workspace.panes.length,2);assert.equal(workspace.activePane.editor,editor);assert.equal(workspace.activePane.active,tab.id);
});

test('cached tab views are destroyed on close and vault replacement, not on temporary hiding',async t=>{
  const {workspace,destroyed}=await setup(t);await workspace.openNote('A.md');const pane=workspace.activePane,tab=pane.tabs[0],editor=pane.editor!;
  await workspace.openNote('B.md',true);assert.equal(destroyed.has(editor),false);
  await (workspace as any).closeTab(pane,tab);assert.equal(destroyed.has(editor),true);
  const second=pane.editor!;await workspace.openNote('C.md',true);assert.equal(destroyed.has(second),false);
  await workspace.openVault({adapter:new MemoryAdapter({'Other.md':'other'}),id:'test:other',label:'Other'});assert.equal(destroyed.has(second),true);
});

test('active table child, parent undo and reversed child selection survive cross-pane attachment',async t=>{
  const {workspace,dom}=await setup(t,new MemoryAdapter({'A.md':'| H |\n| --- |\n| first |','B.md':'Bravo'}));
  await workspace.openNote('B.md');await (workspace as any).split('right');const target=workspace.activePane;
  const source=workspace.panes[0];await workspace.openNote('A.md',false,source);
  const tab=source.tabs[0],parent=live(source),handle=source.editor!;
  const cell=source.element.querySelector<HTMLElement>('td')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  const child=EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;assert.ok(child);assert.equal(child.hasFocus,true);
  child.dispatch({changes:{from:0,insert:'X'},annotations:Transaction.userEvent.of('input.type')});child.dispatch({selection:EditorSelection.range(4,1)});
  const selection=child.state.selection.toJSON();
  await dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0});
  await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(target.editor,handle);assert.equal(live(target),parent);assert.equal(EditorView.findFromDOM(target.element.querySelector('.cm-live-table .cm-editor')!),child);
  assert.equal(child.hasFocus,true);assert.deepEqual(child.state.selection.toJSON(),selection);assert.equal(undoDepth(parent.state),1);
  child.dispatch({changes:{from:0,insert:'Y'},annotations:Transaction.userEvent.of('input.type')});assert.match(workspace.buffers.get('A.md')!.text,/YXfirst/);
});

test('reorder and edge docking retain multiple carets, folds, and redo state without rebuilding chrome content',async t=>{
  const {workspace}=await setup(t,new MemoryAdapter({'A.md':'before\n# Heading\nbody\n# End\nlast','B.md':'Bravo'}));
  await workspace.openNote('B.md');await workspace.openNote('A.md',true);const pane=workspace.activePane,tab=pane.tabs[1],handle=pane.editor!,view=live(pane);
  view.dispatch({changes:{from:0,insert:'X'},annotations:Transaction.userEvent.of('input.type')});
  view.dispatch({selection:EditorSelection.create([EditorSelection.range(5,1),EditorSelection.cursor(view.state.doc.length)],1)});handle.fold!('foldAll');
  const selection=view.state.selection.toJSON(),folds=handle.getViewState!().folds;
  await dock(workspace,{sourcePaneId:pane.id,tabId:tab.id,targetPaneId:pane.id,edge:'center',index:0});
  await workspace.renderPane(pane);assert.equal(pane.editor,handle);assert.deepEqual(view.state.selection.toJSON(),selection);assert.deepEqual(handle.getViewState!().folds,folds);
  await dock(workspace,{sourcePaneId:pane.id,tabId:tab.id,targetPaneId:pane.id,edge:'bottom',index:0});
  assert.equal(workspace.activePane.editor,handle);assert.deepEqual(view.state.selection.toJSON(),selection);assert.deepEqual(handle.getViewState!().folds,folds);
  assert.equal(undo(view),true);assert.equal(view.state.doc.toString().startsWith('X'),false);assert.equal(redo(view),true);assert.equal(view.state.doc.toString().startsWith('X'),true);
});

test('failed DOM attachment restores both owners, tab order, active pane and split topology',async t=>{
  const {workspace}=await setup(t);await workspace.openNote('A.md');const source=workspace.activePane,tab=source.tabs[0],a=source.editor!;
  await (workspace as any).split('right');await workspace.openNote('B.md');const target=workspace.activePane,b=target.editor!;
  const before=(workspace as any).splitLayout.serialize(),tabs=target.tabs.slice(),append=target.element.appendChild;
  target.element.appendChild=function(node){if(node===source.content||node===((workspace as any).cachedViews.get(tab)?.content))throw new Error('attachment blocked');return append.call(this,node) as typeof node;};
  await assert.rejects(dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0}),/attachment blocked/);
  target.element.appendChild=append;
  assert.deepEqual((workspace as any).splitLayout.serialize(),before);assert.equal(source.editor,a);assert.equal(target.editor,b);assert.equal(workspace.activePane,target);assert.deepEqual(target.tabs,tabs);assert.equal(source.tabs[0],tab);assert.equal(source.content?.parentElement,source.element);
});

test('real Canvas pending card draft and focus move intact without committing or reconstructing the view',async t=>{
  const sourceText=JSON.stringify({nodes:[{id:'a',type:'text',x:0,y:0,width:200,height:100,text:'Original'}],edges:[]});
  const {workspace,adapter,dom}=await setup(t,new MemoryAdapter({'Board.canvas':sourceText,'B.md':'Bravo'}));
  await workspace.openNote('B.md');await (workspace as any).split('right');const target=workspace.activePane,source=workspace.panes[0];
  await workspace.openNote('Board.canvas',false,source);const tab=source.tabs[0],view=source.canvasView!,surface=view.element;
  source.element.querySelector<HTMLElement>('[data-node-id="a"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));
  const input=surface.querySelector<HTMLTextAreaElement>('textarea')!;input.value='Pending card draft';input.setSelectionRange(8,3,'backward');input.focus();
  const world=surface.querySelector<HTMLElement>('.zorid-canvas-world')!,transform=world.style.transform;
  await dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0});await Promise.resolve();
  assert.equal(target.canvasView,view);assert.equal(view.element,surface);assert.equal(surface.querySelector('textarea'),input);assert.equal(document.activeElement,input);assert.equal(input.value,'Pending card draft');assert.equal(world.style.transform,transform);
  assert.equal(await adapter.read('Board.canvas'),sourceText,'moving does not commit the live card editor');assert.equal(view.hasPendingChanges(),true);
  await view.flush();assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text,'Pending card draft');
  view.undo();await view.flush();assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text,'Original');
});

test('PDF semantic state and Markdown embed owners survive same-window moves and cached activation',async t=>{
  const semantic={page:1,scale:1,rotation:0,searches:0,destroyed:0};let creations=0;
  const {workspace}=await setup(t,new MemoryAdapter({'Paper.pdf':new Uint8Array([37,80,68,70]),'A.md':'![[Embed]]','Embed.md':'## Embedded\nbody','B.md':'Bravo'}),{
    pdf(parent){creations++;parent.append(document.createElement('canvas'));return{ready:Promise.resolve(),destroy(){semantic.destroyed++;},goToPage(page){semantic.page=Number(page);},setScale(scale){semantic.scale=Number(scale);},rotate(degrees){semantic.rotation+=degrees;},showSearch(){semantic.searches++;},applySubpath(){},getSelectionSubpath(){return null;}};},
  });
  await workspace.openNote('Paper.pdf');const source=workspace.activePane,tab=source.tabs[0],pdf=source.pdfView!;pdf.goToPage(7);pdf.setScale(1.75);pdf.rotate(90);pdf.showSearch();
  await workspace.openNote('A.md',true);const embedTab=source.tabs[1],editor=source.editor!,embeds=source.embeds!;
  for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));
  const embedded=source.element.querySelector('.internal-embed');assert.ok(embedded);
  await (workspace as any).split('right');await workspace.openNote('B.md');const target=workspace.activePane;
  await dock(workspace,{sourcePaneId:source.id,tabId:embedTab.id,targetPaneId:target.id,edge:'center',index:1});
  assert.equal(target.editor,editor);assert.equal(target.embeds,embeds);assert.equal(target.element.querySelector('.internal-embed'),embedded);
  assert.equal(source.pdfView,pdf);assert.equal(creations,1);assert.deepEqual(semantic,{page:7,scale:1.75,rotation:90,searches:1,destroyed:0});
  await dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0});
  assert.equal(target.pdfView,pdf);assert.equal(creations,1);assert.equal(semantic.destroyed,0);
  await (workspace as any).selectTab(target,embedTab);assert.equal(target.embeds,embeds);assert.equal(target.element.querySelector('.internal-embed'),embedded);
});

test('parked real editor reconciles external text without losing its identity or overwriting the newer file',async t=>{
  const {workspace,adapter}=await setup(t);await workspace.openNote('A.md');const pane=workspace.activePane,tab=pane.tabs[0],handle=pane.editor!,editor=live(pane);
  await workspace.openNote('B.md',true);await adapter.write('A.md','External replacement');await workspace.vault.reload(['A.md']);
  for(let i=0;i<30&&workspace.buffers.get('A.md')!.text!=='External replacement';i++)await new Promise(resolve=>setTimeout(resolve,0));
  await (workspace as any).selectTab(pane,tab);assert.equal(pane.editor,handle);assert.equal(editor.state.doc.toString(),'External replacement');
  editor.dispatch({changes:{from:editor.state.doc.length,insert:'!'},annotations:Transaction.userEvent.of('input.type')});await workspace.flush();assert.equal(await adapter.read('A.md'),'External replacement!');
});

test('a close invalidated by an edit retains tab ownership and live history for a later retry',async t=>{
  const {workspace,adapter}=await setup(t);await workspace.openNote('A.md');const pane=workspace.activePane,tab=pane.tabs[0],handle=pane.editor!,editor=live(pane);
  editor.dispatch({changes:{from:0,insert:'first '},annotations:Transaction.userEvent.of('input.type')});
  const original=adapter.write.bind(adapter);let release!:()=>void,started!:()=>void;const start=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
  adapter.write=async(path,value)=>{started();await gate;return original(path,value);};
  const close=(workspace as any).closeTab(pane,tab);await start;
  editor.dispatch({changes:{from:0,insert:'second '},annotations:Transaction.userEvent.of('input.type')});release();
  await assert.rejects(close,/changed while closing/);adapter.write=original;
  assert.equal(pane.editor,handle);assert.equal(pane.tabs[0],tab);assert.equal(pane.runtime?.phase,'active');assert.equal(editor.state.doc.toString(),'second first Alpha');
  await (workspace as any).closeTab(pane,tab);assert.equal(pane.tabs.includes(tab),false);
});

test('a topology failure after successful attach rolls the moved runtime back as well as tab arrays',async t=>{
  const {workspace}=await setup(t);await workspace.openNote('A.md');const source=workspace.activePane,tab=source.tabs[0],a=source.editor!;
  await (workspace as any).split('right');await workspace.openNote('B.md');const target=workspace.activePane,b=target.editor!;
  const layout=(workspace as any).splitLayout,tree=layout.serialize(),remove=layout.remove;
  layout.remove=()=>{throw new Error('layout removal blocked');};
  await assert.rejects(dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0}),/layout removal blocked/);layout.remove=remove;
  assert.equal(source.editor,a);assert.equal(target.editor,b);assert.equal(source.runtime?.owner.paneId,source.id);assert.equal(target.runtime?.owner.paneId,target.id);assert.deepEqual(layout.serialize(),tree);assert.equal(workspace.panes.length,2);assert.equal(source.content?.parentElement,source.element);
  live(source).dispatch({changes:{from:0,insert:'source '}});assert.equal(workspace.buffers.get('A.md')!.text,'source Alpha');assert.equal(workspace.buffers.get('B.md')!.text,'Bravo');
});

test('navigation history travels with a moved tab and its toolbar follows the destination owner',async t=>{
  const {workspace}=await setup(t);await workspace.openNote('A.md');const source=workspace.activePane;
  await workspace.openNote('C.md');const tab=source.tabs[0],c=source.editor!;
  await workspace.openNote('B.md',true);await (workspace as any).split('right');const target=workspace.activePane;
  await dock(workspace,{sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0});
  assert.equal(target.editor,c);assert.deepEqual(target.history,['A.md','C.md']);assert.equal(target.historyIndex,1);
  const back=target.content!.querySelector<HTMLButtonElement>('[aria-label="Navigate back"]')!;assert.equal(back.disabled,false);back.click();
  for(let i=0;i<30&&target.tabs.find(tab=>tab.id===target.active)?.path!=='A.md';i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(target.tabs.find(tab=>tab.id===target.active)?.path,'A.md');assert.equal(source.tabs.find(tab=>tab.id===source.active)?.path,'B.md');assert.deepEqual(target.history,['A.md','C.md']);
});

test('external deletion promptly releases a clean parked PDF without rebuilding the active editor',async t=>{
  let retired=0;
  const {workspace,adapter}=await setup(t,new MemoryAdapter({'Paper.pdf':new Uint8Array([37,80,68,70]),'B.md':'Bravo'}),{
    pdf(parent){parent.append(document.createElement('canvas'));return{ready:Promise.resolve(),destroy(){retired++;},goToPage(){},setScale(){},rotate(){},showSearch(){},applySubpath(){},getSelectionSubpath(){return null;}};},
  });
  await workspace.openNote('Paper.pdf');const pane=workspace.activePane,tab=pane.tabs[0],runtime=pane.runtime!;
  await workspace.openNote('B.md',true);const editor=pane.editor!;
  await adapter.trash('Paper.pdf');await workspace.vault.reload();
  for(let i=0;i<30&&tab.path!==null;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(tab.path,null);assert.equal(retired,1);assert.equal(runtime.phase,'disposed');assert.equal((workspace as any).cachedViews.has(tab),false);assert.equal(pane.editor,editor);
  await (workspace as any).closeTab(pane,tab);assert.equal(retired,1,'closing the now-empty tab does not dispose its former viewer twice');
});

test('external deletion retains a parked Markdown editor with dirty text and its recovery draft',async t=>{
  const {workspace,adapter,destroyed}=await setup(t);await workspace.openNote('A.md');const pane=workspace.activePane,tab=pane.tabs[0],handle=pane.editor!,view=live(pane);
  await workspace.openNote('B.md',true);view.dispatch({changes:{from:0,insert:'Recover '},annotations:Transaction.userEvent.of('input.type')});
  await adapter.trash('A.md');await workspace.vault.reload();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(tab.path,'A.md');assert.equal(destroyed.has(handle),false);assert.equal((workspace as any).cachedViews.get(tab)?.editor,handle);assert.match(localStorage.getItem('zorid:draft:test:docking:A.md')!,/Recover Alpha/);
  await adapter.write('A.md','Alpha');await workspace.vault.reload();await workspace.flush();assert.equal(await adapter.read('A.md'),'Recover Alpha');
});

test('external deletion retains an uncommitted parked Canvas card draft',async t=>{
  const sourceText=JSON.stringify({nodes:[{id:'a',type:'text',x:0,y:0,width:200,height:100,text:'Original'}],edges:[]});
  const {workspace,adapter,dom}=await setup(t,new MemoryAdapter({'Board.canvas':sourceText,'B.md':'Bravo'}));
  await workspace.openNote('Board.canvas');const pane=workspace.activePane,tab=pane.tabs[0],view=pane.canvasView!;
  await workspace.openNote('B.md',true);
  view.element.querySelector<HTMLElement>('[data-node-id="a"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));
  const input=view.element.querySelector<HTMLTextAreaElement>('textarea')!;input.value='Retained card draft';
  await adapter.trash('Board.canvas');await workspace.vault.reload();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(tab.path,'Board.canvas');assert.equal((workspace as any).cachedViews.get(tab)?.canvasView,view);assert.equal(view.hasPendingChanges(),true);assert.equal(input.value,'Retained card draft');
  await adapter.write('Board.canvas',sourceText);await workspace.vault.reload();await workspace.flush();assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text,'Retained card draft');
});

test('rejected cached retirement keeps the deleted tab path and live owner available for recovery',async t=>{
  const {workspace,adapter}=await setup(t);await workspace.openNote('A.md');const pane=workspace.activePane,tab=pane.tabs[0],editor=pane.editor!,runtime=pane.runtime!,buffer=workspace.buffers.get('A.md')!;
  await workspace.openNote('B.md',true);const flush=buffer.flush.bind(buffer);buffer.flush=async()=>{throw new Error('retirement write guard rejected');};
  await adapter.trash('A.md');await workspace.vault.reload();
  for(let i=0;i<30&&!document.body.textContent?.includes('retirement write guard rejected');i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(document.body.textContent!,/retirement write guard rejected/);assert.equal(tab.path,'A.md');assert.equal((workspace as any).cachedViews.get(tab)?.editor,editor);assert.equal(runtime.phase,'active');
  buffer.flush=flush;
});
