import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {StateEffect} from '@codemirror/state';
import {completionStatus,currentCompletions,startCompletion,closeCompletion} from '@codemirror/autocomplete';
import {undoDepth} from '@codemirror/commands';
import {createEditor} from '../src/ui/editor.ts';
import {until} from './helpers/draft-metadata.ts';
function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><body><main></main><input id="other"></body>',{pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>(),listeners=new Set<()=>void>(),errors:unknown[]=[];
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:0,bottom:0,width:0,height:0,x:0,y:0,toJSON(){}});dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  dom.window.addEventListener('error',event=>{errors.push(event.error);event.preventDefault();});const oldLog=console.error;console.error=(...args)=>{errors.push(args);};
  let heading='Old heading',active=true,changes=0,stops=0;const host=document.querySelector<HTMLElement>('main')!;
  const editor=createEditor(host,{value:'[[Target#',mode:'source',paths:()=>['Target.md'],wiki:{metadata:()=>({headings:[{heading,level:1}]}),sourcePath:()=> 'Source.md'},isCurrent:()=>active,onChange:()=>{changes++;},open(){},subscribeMetadata(listener){listeners.add(listener);return()=>{stops++;listeners.delete(listener);};}}),view=EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  view.dispatch({selection:{anchor:view.state.doc.length}});let destroyed=false;const destroy=()=>{if(!destroyed){destroyed=true;editor.destroy();}};
  t.after(()=>{destroy();console.error=oldLog;dom.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}assert.deepEqual(errors,[]);});
  return {dom,view,editor,errors,destroy,get changes(){return changes;},get stops(){return stops;},get subscriptions(){return listeners.size;},set active(value:boolean){active=value;},deliver(value='New heading'){heading=value;for(const listener of [...listeners])listener();}};
}
test('async facts refresh an existing completion with no document/history change or focus move',async t=>{
  const f=setup(t);f.view.focus();startCompletion(f.view);await until(()=>currentCompletions(f.view.state).some(c=>c.label==='Old heading'));const selection=f.view.state.selection,history=undoDepth(f.view.state);
  f.deliver();f.deliver('Latest heading');await until(()=>currentCompletions(f.view.state).some(c=>c.label==='Latest heading'));assert.equal(currentCompletions(f.view.state).some(c=>c.label==='Old heading'),false);assert.ok(f.view.state.selection.eq(selection));assert.equal(undoDepth(f.view.state),history);assert.equal(f.changes,0);assert.equal(f.view.dom.ownerDocument.activeElement,f.view.contentDOM);
});
test('metadata delivery never opens a closed popup or steals focus from another control',async t=>{
  const f=setup(t),other=f.dom.window.document.querySelector<HTMLInputElement>('#other')!;other.focus();f.deliver();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(completionStatus(f.view.state),null);assert.equal(f.dom.window.document.activeElement,other);
  f.view.focus();startCompletion(f.view);await until(()=>currentCompletions(f.view.state).length>0);closeCompletion(f.view);f.deliver();other.focus();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(completionStatus(f.view.state),null);assert.equal(f.dom.window.document.activeElement,other);
});
test('metadata refresh requested inside a CodeMirror update is deferred and destruction removes queued ownership',async t=>{
  const f=setup(t);let delivered=false;
  f.view.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update=>{if(update.selectionSet&&!delivered){delivered=true;f.deliver();}}))});
  f.view.dispatch({selection:{anchor:0}});assert.equal(delivered,true);await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(f.errors,[]);
  f.deliver('Queued after update');f.destroy();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.subscriptions,0);assert.equal(f.stops,1);assert.equal(f.changes,0);
});
test('a retired presentation does not restart completion',async t=>{
  const f=setup(t);f.view.focus();startCompletion(f.view);await until(()=>currentCompletions(f.view.state).some(c=>c.label==='Old heading'));f.active=false;f.deliver();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(currentCompletions(f.view.state).some(c=>c.label==='New heading'),false);
});
