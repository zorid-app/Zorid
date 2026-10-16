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
test('numbered shortcut to the already active tab preserves actual editor identity, selection and undo',async t=>{
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
  const pane=workspace.activePane,editor=pane.editor!,editorDOM=pane.element.querySelector('.cm-editor')!;
  const view=EditorView.findFromDOM(editorDOM)!;
  view.dispatch({changes:{from:0,insert:'X'},annotations:Transaction.userEvent.of('input.type')});
  view.dispatch({selection:EditorSelection.range(8,2)});
  const event=new dom.window.KeyboardEvent('keydown',{key:'1',ctrlKey:true,bubbles:true,cancelable:true});
  document.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(event.defaultPrevented,true);assert.equal(pane.editor,editor);assert.equal(EditorView.findFromDOM(editorDOM),view);
  assert.equal(undoDepth(view.state),1);assert.equal(view.state.selection.main.anchor,8);assert.equal(view.state.selection.main.head,2);
  assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),'plain text\n# Heading\nend');
});
