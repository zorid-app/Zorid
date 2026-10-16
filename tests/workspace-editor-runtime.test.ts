import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorSelection,Transaction} from '@codemirror/state';
import {undo,undoDepth} from '@codemirror/commands';
import {Workspace} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';

// Real workspace and CM lifecycle. Geometry is synthetic: this tests identity,
// selection/history and persistence, not native pointer coordinates or pixels.
test('workspace nested splits and divider changes retain the actual live editor and undo history',async t=>{
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
  const workspace=new Workspace(root,createEditor);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter:new MemoryAdapter({'Note.md':'plain text\n# Heading\nend'}),id:'test:cm-layout',label:'Test'});
  await workspace.openNote('Note.md');
  const original=workspace.activePane,editor=original.editor!,editorDOM=original.element.querySelector('.cm-editor')!;
  const view=EditorView.findFromDOM(editorDOM)!;
  view.dispatch({changes:{from:0,insert:'X'},annotations:Transaction.userEvent.of('input.type')});
  view.dispatch({selection:EditorSelection.range(8,2)});view.focus();
  original.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop=64;
  await (workspace as any).split('right');
  await (workspace as any).split('bottom');
  assert.ok(workspace.activePane.element.contains(document.activeElement),'active split owns keyboard focus');
  assert.equal(original.editor,editor);
  assert.equal(original.element.querySelector('.cm-editor'),editorDOM);
  assert.equal(EditorView.findFromDOM(editorDOM),view);
  assert.equal(view.state.selection.main.anchor,8);assert.equal(view.state.selection.main.head,2);
  assert.equal(undoDepth(view.state),1);
  const separator=root.querySelector<HTMLElement>('.split-layout-separator')!;
  separator.parentElement!.getBoundingClientRect=rect;
  separator.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  assert.equal(EditorView.findFromDOM(editorDOM),view);
  assert.equal(original.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop,64);
  assert.equal(undo(view),true);
  assert.equal(view.state.doc.toString(),'plain text\n# Heading\nend');
  await workspace.flush();
  assert.equal(await workspace.vault.read('Note.md'),'plain text\n# Heading\nend');
});
