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

// The Canvas surface is injected here to exercise the real workspace adapter,
// NoteBuffer, Vault and CodeMirror without depending on the parallel card UI.
function canvasHost(){
  let options:any,owners:any[]=[];const sessions:any[]=[];
  return{
    get options(){return options;},sessions,
    factory(parent:HTMLElement,next:any){
      options=next;const owned:any[]=[];owners=owned;const element=document.createElement('div');parent.append(element);
      return{element,document:next.document,setDocument(){},undo(){},redo(){},
        async flush(){for(const session of owned)await session.flush();},hasPendingChanges:()=>owned.some(session=>session.hasPendingChanges()),
        destroy(){for(const session of [...owned])session.destroy();element.remove();}};
    },
    async open(path:string){
      const owned=owners,session=await options.openMarkdownFile(path),destroy=session.destroy.bind(session);
      session.destroy=()=>{destroy();const i=owned.indexOf(session);if(i>=0)owned.splice(i,1);const j=sessions.indexOf(session);if(j>=0)sessions.splice(j,1);};
      sessions.push(session);owned.push(session);return session;
    },
  };
}
const board=JSON.stringify({nodes:[],edges:[]});

test('Canvas sessions share edits with active and parked real note editors and each other',async t=>{
  const canvas=canvasHost(),{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','B.md':'Bravo'}),{canvas:canvas.factory});
  await workspace.openNote('A.md');const pane=workspace.activePane,note=live(pane),handle=pane.editor!,tab=pane.tabs[0];
  await workspace.openNote('Board.canvas',true);const first=await canvas.open('A.md'),second=await canvas.open('A.md'),updates:string[]=[];second.subscribe(text=>updates.push(text));
  first.update('Card edit','Alpha');assert.equal(note.state.doc.toString(),'Card edit');assert.deepEqual(updates,['Card edit']);assert.equal(first.hasPendingChanges(),true);
  await (workspace as any).selectTab(pane,tab);assert.equal(pane.editor,handle);
  note.dispatch({changes:{from:0,insert:'Note '},annotations:Transaction.userEvent.of('input.type')});assert.equal(first.getText(),'Note Card edit');assert.deepEqual(updates,['Card edit','Note Card edit']);
  assert.throws(()=>second.update('stale','Card edit'),/another editor/);await first.flush();assert.equal(await adapter.read('A.md'),'Note Card edit');
});

test('file-card source-relative links, dirty metadata, embeds and settings use current workspace services',async t=>{
  const canvas=canvasHost(),{workspace}=await setup(t,new MemoryAdapter({'Board.canvas':board,'Folder/A.md':'Alpha','Folder/Target.md':'# Target','Embed.md':'embedded'}),{canvas:canvas.factory});
  await workspace.openNote('Board.canvas');const session=await canvas.open('Folder/A.md'),options=session.editorOptions;
  assert.equal(options.wiki.sourcePath(),'Folder/A.md');assert.equal(options.wiki.resolvePath('Target','Folder/A.md'),'Folder/Target.md');assert.equal(options.isUnresolved('Target','wiki'),false);
  session.update('---\naliases: [Card alias]\n---\n# Draft heading','Alpha');assert.deepEqual(options.wiki.metadata('Folder/A.md').aliases,['Card alias']);
  const lease=options.renderEmbed({target:'Embed',kind:'wiki'});assert.ok(lease.dom);lease.destroy();
  workspace.settings.tabSize=8;assert.equal(options.listOptions.tabSize,8);
  await (workspace as any).split('right');const target=workspace.activePane,source=workspace.panes[0];
  await dock(workspace,{sourcePaneId:source.id,tabId:source.active,targetPaneId:target.id,edge:'center',index:0});
  options.open('Target','wiki');for(let i=0;i<30&&target.tabs.find(tab=>tab.id===target.active)?.path!=='Folder/Target.md';i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(target.tabs.find(tab=>tab.id===target.active)?.path,'Folder/Target.md');
});

test('a file-card session rejects an externally deleted and recreated note without losing its draft',async t=>{
  const canvas=canvasHost(),{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha'}),{canvas:canvas.factory});
  await workspace.openNote('Board.canvas');const session=await canvas.open('A.md');session.update('recover card text','Alpha');
  await adapter.trash('A.md');await workspace.vault.reload();await adapter.write('A.md','replacement');await workspace.vault.reload();
  assert.throws(()=>session.update('wrong','recover card text'),/no longer current/);await assert.rejects(session.flush(),/no longer current/);
  assert.equal(await adapter.read('A.md'),'replacement');assert.match(localStorage.getItem('zorid:draft:test:docking:A.md')!,/recover card text/);
  // Deliberately retained orphan draft blocks shutdown. Keep this test isolated
  // by dropping the buffer from this fixture's workspace after checking recovery.
  session.destroy();canvas.sessions.length=0;const orphan=workspace.buffers.get('A.md')!;workspace.buffers.delete('A.md');
  // Cancel its debounce timer without permitting a stale mutation.
  await assert.rejects(orphan.dispose(),/no longer current/);
});

test('external reload updates a live file-card session once and its close leaves the shared buffer usable',async t=>{
  const canvas=canvasHost(),{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha'}),{canvas:canvas.factory});
  await workspace.openNote('Board.canvas');const session=await canvas.open('A.md'),updates:string[]=[];session.subscribe(text=>updates.push(text));
  await adapter.write('A.md','external');await workspace.vault.reload(['A.md']);for(let i=0;i<30&&!updates.length;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(updates,['external']);session.update('accepted','external');session.destroy();canvas.sessions.length=0;await workspace.buffers.get('A.md')!.flush();assert.equal(await adapter.read('A.md'),'accepted');
});

test('failed referenced-note flush blocks Canvas navigation and retains the shared recovery draft',async t=>{
  const canvas=canvasHost(),{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','B.md':'Bravo'}),{canvas:canvas.factory});
  await workspace.openNote('Board.canvas');const pane=workspace.activePane,view=pane.canvasView,session=await canvas.open('A.md');session.update('recover this note','Alpha');
  const write=adapter.write.bind(adapter);adapter.write=async(path,text)=>{if(path==='A.md')throw new Error('note disk offline');return write(path,text);};
  await assert.rejects(workspace.openNote('B.md'),/note disk offline/);assert.equal(pane.canvasView,view);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)?.path,'Board.canvas');assert.equal(session.getText(),'recover this note');assert.match(localStorage.getItem('zorid:draft:test:docking:A.md')!,/recover this note/);
  adapter.write=write;await workspace.openNote('B.md');assert.equal(await adapter.read('A.md'),'recover this note');assert.equal(canvas.sessions.length,0);
});

for(const change of ['delete','rename','replace'] as const)for(const dirty of [false,true])test(`${change} of a ${dirty?'dirty':'clean'} referenced note ${dirty?'retains recovery':'does not trap Canvas navigation'}`,async t=>{
  const canvas=canvasHost(),{workspace,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board,'A.md':'Alpha','B.md':'Bravo'}),{canvas:canvas.factory});
  await workspace.openNote('Board.canvas');const pane=workspace.activePane,session=await canvas.open('A.md'),buffer=workspace.buffers.get('A.md')!;
  if(dirty)session.update('retained draft','Alpha');
  if(change==='rename')await workspace.vault.rename('A.md','Renamed.md');
  else{await adapter.trash('A.md');await workspace.vault.reload();if(change==='replace'){await adapter.write('A.md','replacement');await workspace.vault.reload();}}
  if(dirty){
    await assert.rejects(workspace.openNote('B.md'),/no longer current|replaced/);assert.equal(pane.tabs.find(tab=>tab.id===pane.active)?.path,'Board.canvas');assert.equal(buffer.text,'retained draft');assert.equal(buffer.dirty,true);
    session.destroy();for(const [path,owner] of workspace.buffers)if(owner===buffer)workspace.buffers.delete(path);await assert.rejects(buffer.dispose(),/no longer current|replaced/);
  }else{
    await session.flush();assert.equal(session.hasPendingChanges(),false);await workspace.openNote('B.md');assert.equal(pane.tabs.find(tab=>tab.id===pane.active)?.path,'B.md');assert.equal(canvas.sessions.length,0);
    if(change==='replace')assert.equal(await adapter.read('A.md'),'replacement');
  }
});
