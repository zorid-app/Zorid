import {startCompletion,currentCompletions} from '@codemirror/autocomplete';
import {createCanvasView} from '../src/canvas/view.ts';
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
const board=(text:string)=>JSON.stringify({nodes:[{id:'text',type:'text',text,x:0,y:0,width:400,height:300}],edges:[],custom:{keep:true}});
async function until(check:()=>boolean,label:string){const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,5));}}
async function activate(root:HTMLElement,dom:JSDOM){root.querySelector('[data-node-id="text"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));await until(()=>!!root.querySelector('.zorid-canvas-note-editor .cm-editor'),'Canvas editor mounts');const view=EditorView.findFromDOM(root.querySelector('.zorid-canvas-note-editor .cm-editor')!)!;view.focus();return view;}
const captureCanvas=()=>{let options:any;return{get options(){return options;},factory(parent:HTMLElement,next:Parameters<typeof createCanvasView>[1]){options=next;return createCanvasView(parent,next);}};};
const paste=(dom:JSDOM,cm:EditorView,data:Record<string,string>,files:any[]=[])=>{const event=new dom.window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{types:Object.keys(data),getData:(type:string)=>data[type]??'',files,items:files.map(file=>({kind:'file',getAsFile:()=>file}))}});cm.contentDOM.dispatchEvent(event);return event;};

test('Canvas text services resolve from the Canvas path and expose dirty alias/heading metadata',async t=>{
  const canvas=captureCanvas(),{workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Folder/Board.canvas':board('Start'),'Folder/Target.md':'# Local','Other/Target.md':'# Other'}),{canvas:canvas.factory});await workspace.openNote('Folder/Board.canvas');const options=canvas.options.textEditorOptions;
  assert.equal(options.wiki.sourcePath(),'Folder/Board.canvas');assert.equal(options.wiki.resolvePath('Target','Folder/Board.canvas'),'Folder/Target.md');assert.equal(options.isUnresolved('Missing','wiki'),true);
  const target=await(workspace as any).bufferFor('Folder/Target.md');(workspace as any).updateMarkdownBuffer(target,'---\naliases: [Draft Alias]\n---\n# Unsaved Heading');assert.deepEqual(options.wiki.metadata('Folder/Target.md').aliases,['Draft Alias']);assert.equal(options.wiki.metadata('Folder/Target.md').headings[0].heading,'Unsaved Heading');
  workspace.settings.newLinkFormat='relative';assert.equal(options.wiki.linkText('Other/Target.md','Folder/Board.canvas'),'../Other/Target');const cm=await activate(root,dom);cm.dispatch({changes:{from:0,to:cm.state.doc.length,insert:'[[Draft A'},selection:{anchor:9},annotations:Transaction.userEvent.of('input.type')});assert.equal(startCompletion(cm),true);await until(()=>currentCompletions(cm.state).some(item=>item.label==='Draft Alias'),'dirty alias completion appears');assert.ok(root.querySelector('.cm-wiki-completion'));
  await workspace.flush();assert.equal(JSON.parse(await adapter.read('Folder/Board.canvas')).custom.keep,true);assert.equal(workspace.buffers.has('Folder/Board.md'),false);
});

test('text-card Reading and Live embeds share managed source-relative owners and refresh unsaved note edits',async t=>{
  const{workspace,root,dom}=await setup(t,new MemoryAdapter({'Folder/Board.canvas':board('![[Target]]\n\n![[photo.png]]'),'Folder/Target.md':'# Original embed','Other/Target.md':'Wrong target','Folder/photo.png':new Uint8Array([137,80,78,71])}));await workspace.openNote('Folder/Board.canvas');
  await until(()=>root.querySelector('.internal-embed')?.textContent?.includes('Original embed')===true,'Reading note embed');assert.doesNotMatch(root.textContent??'',/Wrong target/);const manager=workspace.activePane.embeds!;assert.ok(manager);
  const buffer=await(workspace as any).bufferFor('Folder/Target.md');(workspace as any).updateMarkdownBuffer(buffer,'# Unsaved embed');await until(()=>root.querySelector('.internal-embed')?.textContent?.includes('Unsaved embed')===true,'dirty referenced note refresh');
  const cm=await activate(root,dom);await until(()=>cm.dom.querySelector('.internal-embed')?.textContent?.includes('Unsaved embed')===true,'Live note embed');await until(()=>!!cm.dom.querySelector('img[src^="blob:"]'),'Live image bytes acquired');
  assert.equal(workspace.activePane.embeds,manager);await workspace.flush();root.querySelector<HTMLButtonElement>('[aria-label="Finish editing"]')?.click();
  await workspace.openNote('Other/Target.md');assert.equal((manager as any).states.size,0);assert.equal((manager as any).observed.size,0);
});

test('text-card HTML and binary paste use shared conversion/import settings and save only Canvas JSON text',async t=>{
  const canvas=captureCanvas(),{workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Folder/Board.canvas':board('')}),{canvas:canvas.factory});await workspace.openNote('Folder/Board.canvas');workspace.settings.attachmentFolderPath='./assets';const cm=await activate(root,dom);
  assert.equal(paste(dom,cm,{'text/html':'<p><strong>Bold</strong></p>'}).defaultPrevented,true);assert.match(cm.state.doc.toString(),/\*\*Bold\*\*/);
  const file={name:'photo.png',type:'image/png',arrayBuffer:async()=>new Uint8Array([0,255,137]).buffer};assert.equal(paste(dom,cm,{},[file]).defaultPrevented,true);await until(()=>cm.state.doc.toString().includes('.png'),`binary paste link: ${cm.state.doc.toString()}`);await workspace.flush();
  const imported=[...workspace.vault.entries.keys()].find(path=>path.startsWith('Folder/assets/Pasted image ')&&path.endsWith('.png'))!;assert.ok(imported);assert.deepEqual([...await adapter.readBinary(imported)],[0,255,137]);const saved=JSON.parse(await adapter.read('Folder/Board.canvas'));assert.match(saved.nodes[0].text,/Pasted image .*\.png/);assert.equal(saved.custom.keep,true);assert.equal(workspace.buffers.has('Folder/Board.md'),false);
  workspace.settings.autoConvertHtml=false;assert.equal(canvas.options.textEditorOptions.transfers.autoConvertHtml(),false);
});

test('late file paste cannot write into a replacement Canvas editor after navigation',async t=>{
  const canvas=captureCanvas(),{workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board('Original'),'Other.canvas':board('Replacement')}),{canvas:canvas.factory});await workspace.openNote('Board.canvas');let settled=false;const transfers=canvas.options.textEditorOptions.transfers,importFile=transfers.importFile;transfers.importFile=async(file:any)=>{try{return await importFile(file);}finally{settled=true;}};const cm=await activate(root,dom);
  let release!:(bytes:ArrayBuffer)=>void,started=false;const file={name:'late.png',type:'image/png',arrayBuffer:()=>{started=true;return new Promise<ArrayBuffer>(resolve=>release=resolve);}};paste(dom,cm,{},[file]);await until(()=>started,'file read starts');await workspace.openNote('Other.canvas');const replacement=await activate(root,dom);release(new Uint8Array([1]).buffer);
  await until(()=>settled,'retired editor import settles');assert.equal(replacement.state.doc.toString(),'Replacement');assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text,'Original');assert.equal(JSON.parse(await adapter.read('Other.canvas')).nodes[0].text,'Replacement');
});

test('text-card services follow a docked owner and retire with the moved Canvas',async t=>{
  const canvas=captureCanvas(),{workspace,root,dom}=await setup(t,new MemoryAdapter({'Folder/Board.canvas':board('![[Target]]'),'Folder/Target.md':'Target','B.md':'B'}),{canvas:canvas.factory});await workspace.openNote('Folder/Board.canvas');const source=workspace.activePane,tab=source.tabs[0],manager=source.embeds!,options=canvas.options.textEditorOptions,cm=await activate(root,dom);
  await(workspace as any).split('right');const target=workspace.activePane;await workspace.openNote('B.md',false,target);await(workspace as any).dockTab({sourcePaneId:source.id,tabId:tab.id,targetPaneId:target.id,edge:'center',index:0});assert.equal(target.embeds,manager);assert.equal(EditorView.findFromDOM(target.element.querySelector('.cm-editor')!),cm);assert.equal(options.wiki.sourcePath(),'Folder/Board.canvas');
  options.open('Target','wiki');await until(()=>target.tabs.find(tab=>tab.id===target.active)?.path==='Folder/Target.md'&&!target.canvasView,'docked owner navigates');assert.equal((manager as any).states.size,0);assert.equal(options.wiki.sourcePath(),null);assert.deepEqual(options.paths(),[]);assert.throws(()=>options.renderEmbed({kind:'wiki',target:'Target',label:'',from:0,to:11}),/closed/);
});

test('native vault-file paste reuses the existing attachment without reading or allocating a duplicate',async t=>{
  const{workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board(''),'Assets/photo.png':new Uint8Array([3,4,5])}));await workspace.openNote('Board.canvas');workspace.platform.id='desktop:/Vault';Object.defineProperty(window,'zorid',{configurable:true,value:{getPathForFile:()=>'/Vault/Assets/photo.png'}});const cm=await activate(root,dom);let reads=0;
  paste(dom,cm,{},[{name:'photo.png',type:'image/png',arrayBuffer:async()=>{reads++;throw new Error('Existing file bytes must not be copied');}}]);await until(()=>cm.state.doc.toString().includes('photo.png'),'existing file link');await workspace.flush();assert.equal(reads,0);assert.deepEqual([...workspace.vault.entries.keys()].filter(path=>/\.png$/.test(path)),['Assets/photo.png']);assert.deepEqual([...await adapter.readBinary('Assets/photo.png')],[3,4,5]);
});

test('failed Canvas construction releases its embed manager and retained service callbacks',async t=>{
  let workspaceRef:Workspace,manager:any,options:any,destroys=0;const canvas:WorkspaceViewFactories['canvas']=(parent,next)=>{options=next.textEditorOptions;manager=workspaceRef.activePane.embeds;const destroy=manager.destroy.bind(manager);manager.destroy=()=>{destroys++;destroy();};options.renderEmbed({kind:'wiki',target:'Target',from:0,to:11});throw new Error('Canvas construction failed');};
  const{workspace,root}=await setup(t,new MemoryAdapter({'Board.canvas':board(''),'Target.md':'Target'}),{canvas});workspaceRef=workspace;await workspace.openNote('Board.canvas');assert.match(root.textContent??'',/Canvas construction failed/);assert.equal(workspace.activePane.embeds,undefined);assert.equal(destroys,1);assert.equal(manager.states.size,0);assert.equal(options.wiki.sourcePath(),null);assert.throws(()=>options.renderEmbed({kind:'wiki',target:'Target',from:0,to:11}),/closed/);await workspace.openNote('Target.md');assert.equal(destroys,1);
});

test('vault replacement during text-card file read prevents destination allocation and replacement insertion',async t=>{
  const canvas=captureCanvas(),{workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Board.canvas':board('Original')}),{canvas:canvas.factory});await workspace.openNote('Board.canvas');let settled=false;const transfers=canvas.options.textEditorOptions.transfers,importFile=transfers.importFile;transfers.importFile=async(file:any)=>{try{return await importFile(file);}finally{settled=true;}};const cm=await activate(root,dom);let release!:(bytes:ArrayBuffer)=>void,started=false;
  paste(dom,cm,{},[{name:'late.png',type:'image/png',arrayBuffer:()=>{started=true;return new Promise<ArrayBuffer>(resolve=>release=resolve);}}]);await until(()=>started,'held imported file read');const next=new MemoryAdapter({'Next.canvas':board('Replacement')});await workspace.openVault({id:'replacement',label:'Next',adapter:next});await workspace.openNote('Next.canvas');const replacement=await activate(root,dom);release(new Uint8Array([7]).buffer);await until(()=>settled,'old vault import rejects');assert.equal(replacement.state.doc.toString(),'Replacement');assert.deepEqual([...workspace.vault.entries.keys()],['Next.canvas']);assert.equal((await adapter.list()).some(entry=>/\.png$/.test(entry.path)),false);
});

test('ordinary note edits invalidate each parked Canvas embed manager once before persistence',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'Board.canvas':board('![[Target]]'),'Target.md':'Original'}));await workspace.openNote('Board.canvas');const manager=workspace.activePane.embeds!,invalidate=manager.invalidate.bind(manager);let invalidations=0;manager.invalidate=path=>{if(path==='Target.md')invalidations++;invalidate(path);};await workspace.openNote('Target.md',true);
  const cm=EditorView.findFromDOM(workspace.activePane.element.querySelector('.cm-editor')!)!;cm.dispatch({changes:{from:0,to:cm.state.doc.length,insert:'Dirty target'},annotations:Transaction.userEvent.of('input.type')});assert.equal(invalidations,1);await workspace.flush();
});
