import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorSelection, EditorState, StateEffect} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {createEditor, type EditorOptions} from '../src/ui/editor.ts';

// Real CM plugins, scroll targets and scrollHandler delivery with controlled RAF.
// Synthetic rectangles prove scheduling/ownership, never device pixel visibility.
function setup(t:TestContext, options:Partial<EditorOptions>={}){
  const dom=new JSDOM('<!doctype html><body><input id="title"><div class="note-scroll"><div id="host"></div></div>',{pretendToBeVisual:true});
  const win=dom.window,frames=new Map<number,FrameRequestCallback>();let next=0;
  win.requestAnimationFrame=callback=>{frames.set(++next,callback);return next;};win.cancelAnimationFrame=id=>{frames.delete(id);};
  const viewport=Object.assign(new win.EventTarget(),{height:600,width:800,offsetTop:0,offsetLeft:0,scale:1});Object.defineProperty(win,'visualViewport',{configurable:true,value:viewport});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const[key,value]of Object.entries({window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,Node:win.Node,Text:win.Text,Window:win.Window,MutationObserver:win.MutationObserver,getComputedStyle:win.getComputedStyle.bind(win),requestAnimationFrame:win.requestAnimationFrame,cancelAnimationFrame:win.cancelAnimationFrame})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const rect=()=>({top:0,left:0,right:800,bottom:24,width:800,height:24,x:0,y:0,toJSON(){return{};}});
  win.HTMLElement.prototype.getBoundingClientRect=()=>({...rect(),bottom:400,height:400});
  for(const[key,value]of Object.entries({clientHeight:400,clientWidth:800,offsetHeight:400,offsetWidth:800,scrollHeight:1000,scrollWidth:800}))Object.defineProperty(win.HTMLElement.prototype,key,{configurable:true,get:()=>value});
  win.Range.prototype.getBoundingClientRect=rect;win.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  const host=win.document.querySelector<HTMLElement>('#host')!,calls:{view:EditorView;head:number;y:string}[]=[],errors:unknown[]=[];
  win.addEventListener('error',event=>{errors.push(event.error);event.preventDefault();});
  const editor=createEditor(host,{value:'first\nsecond\nthird',mode:'source',paths:()=>[],onChange(){},open(){},onNativeEditorState(){},...options});
  const view=EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  const capture=(target:EditorView)=>target.dispatch({effects:StateEffect.appendConfig.of(EditorView.scrollHandler.of((view,range,options)=>{calls.push({view,head:range.head,y:options.y});return true;}))});
  capture(view);
  let dead=false;const destroy=()=>{if(!dead){dead=true;editor.destroy();}};
  const frame=()=>{const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(0);};
  const settle=()=>{for(let i=0;i<12&&frames.size;i++)frame();};
  const event=(target:EventTarget,type:string)=>target.dispatchEvent(new win.Event(type,{bubbles:true,cancelable:true}));
  const pointer=(target:EventTarget,type:string,x=10,y=10,id=1,primary=true)=>{
    const event=new win.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});
    Object.defineProperties(event,{pointerId:{value:id},isPrimary:{value:primary}});return target.dispatchEvent(event);
  };
  const cursor=(head:number)=>view.dispatch({selection:{anchor:head},userEvent:'select.pointer'});
  view.focus();settle();calls.length=0;
  t.after(()=>{destroy();dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}assert.deepEqual(errors,[],'no asynchronous editor errors');});
  return{dom,win,editor,view,host,calls,capture,viewport,frame,settle,event,pointer,cursor,destroy};
}

test('native pointer selection reveals the caret without a character or selection rewrite',t=>{
  const f=setup(t),before=f.view.state.doc;
  f.pointer(f.view.contentDOM,'pointerdown');f.cursor(12);f.settle();assert.deepEqual(f.calls,[],'do not scroll during a held pointer');
  f.pointer(f.view.contentDOM,'pointerup');f.settle();
  assert.deepEqual(f.calls.map(call=>[call.head,call.y]),[[12,'nearest']]);assert.equal(f.view.state.doc,before);assert.equal(f.view.state.selection.main.head,12);assert.equal(document.activeElement,f.view.contentDOM);
  f.settle();assert.equal(f.calls.length,1,'own reveal cannot loop');
});

test('focused caret is revealed after focus and both keyboard viewport resize paths',t=>{
  const f=setup(t);document.querySelector<HTMLInputElement>('#title')!.focus();f.settle();f.view.focus();f.settle();assert.equal(f.calls.length,1);
  f.calls.length=0;f.event(f.win,'resize');f.event(f.viewport,'resize');f.settle();assert.equal(f.calls.length,1,'resize coalesces at layout settlement');
});

test('manual scrolling does not pull the old caret back; a fresh tap may reveal',t=>{
  const f=setup(t);f.event(document.querySelector('.note-scroll')!,'scroll');f.settle();assert.deepEqual(f.calls,[]);
  f.event(f.view.contentDOM,'wheel');f.event(f.win,'resize');f.settle();assert.deepEqual(f.calls,[],'resize during manual scroll does not reclaim old caret');
  f.pointer(f.view.contentDOM,'pointerdown');f.cursor(9);f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.equal(f.calls.at(-1)?.head,9);
});

for(const reason of ['scroll','wheel','drag','pointercancel','touchcancel','focus','owner','detach','dispose','document','composition','modal','search','readonly','multiselection'] as const)test(`deferred native reveal rejects ${reason}`,t=>{
  let current=true;const f=setup(t,{isCurrent:()=>current});f.cursor(10);f.frame(); // measure has queued the deferred dispatch
  if(reason==='scroll')f.event(document.querySelector('.note-scroll')!,'scroll');
  if(reason==='wheel')f.event(f.view.contentDOM,'wheel');
  if(reason==='drag')f.event(f.view.contentDOM,'dragstart');
  if(reason==='pointercancel')f.event(f.view.contentDOM,'pointercancel');
  if(reason==='touchcancel')f.event(f.view.contentDOM,'touchcancel');
  if(reason==='focus')document.querySelector<HTMLInputElement>('#title')!.focus();
  if(reason==='owner')current=false;
  if(reason==='detach')f.host.remove();
  if(reason==='dispose')f.destroy();
  if(reason==='document')f.view.dispatch({changes:{from:0,insert:'new'}});
  if(reason==='composition')f.event(f.view.contentDOM,'compositionstart');
  if(reason==='modal'){const modal=document.createElement('div');modal.setAttribute('aria-modal','true');document.body.append(modal);}
  if(reason==='search'){const search=document.createElement('div');search.className='cm-search';f.view.dom.append(search);}
  if(reason==='readonly')f.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});
  if(reason==='multiselection')f.view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(4)])});
  f.settle();assert.deepEqual(f.calls,[]);
});

test('latest caret replaces deferred work and selection drags stay browser-owned',t=>{
  const f=setup(t);f.cursor(5);f.frame();f.cursor(13);f.settle();assert.deepEqual(f.calls.map(call=>call.head),[13]);
  f.calls.length=0;f.pointer(f.view.contentDOM,'pointerdown');f.pointer(f.view.contentDOM,'pointermove',30,30);f.cursor(8);f.pointer(f.view.contentDOM,'pointerup',30,30);f.settle();assert.deepEqual(f.calls,[]);
});

test('desktop editors do not enable native caret reveal',t=>{
  const f=setup(t,{onNativeEditorState:undefined});f.cursor(12);f.event(f.win,'resize');f.settle();assert.deepEqual(f.calls,[]);
});

for(const tag of ['button','a','audio','video'])test(`native ${tag} gesture does not request caret scrolling`,t=>{
  const f=setup(t),widget=document.createElement(tag);f.view.contentDOM.append(widget);
  f.pointer(widget,'pointerdown');f.cursor(12);f.pointer(widget,'pointerup');f.event(f.win,'resize');f.settle();assert.deepEqual(f.calls,[]);
});

test('typing retains CM scrolling without an additional helper reveal',t=>{
  const f=setup(t);f.view.dispatch({...f.view.state.replaceSelection('x'),userEvent:'input.type',scrollIntoView:true});f.settle();assert.equal(f.calls.length,1);
});

test('a focused table cell reveals its own caret, never the parent source selection',async t=>{
  const f=setup(t,{mode:'live',value:'| Head | Other |\n| --- | --- |\n| cell text | more |'});
  const cell=f.host.querySelector<HTMLElement>('.cm-live-table td')!;assert.ok(cell);
  cell.dispatchEvent(new f.win.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  const child=EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;assert.ok(child);f.capture(child);
  for(let i=0;i<8;i++)await Promise.resolve();f.settle();f.calls.length=0;
  f.pointer(child.contentDOM,'pointerdown');child.dispatch({selection:{anchor:3},userEvent:'select.pointer'});f.pointer(child.contentDOM,'pointerup');f.settle();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].view,child);assert.equal(f.calls[0].head,3);
  f.calls.length=0;f.event(f.viewport,'resize');f.settle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].view,child);
});


test('additional native pointer cancels reveal until a new single-pointer caret intent',t=>{
  const f=setup(t);f.pointer(f.view.contentDOM,'pointerdown');f.pointer(f.view.contentDOM,'pointerdown',12,12,2,false);f.cursor(12);
  f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.deepEqual(f.calls,[],'first up cannot reveal while another finger remains');
  f.pointer(f.view.contentDOM,'pointerup',12,12,2,false);f.event(f.viewport,'resize');f.settle();assert.deepEqual(f.calls,[]);
  f.pointer(f.view.contentDOM,'pointerdown');f.cursor(9);f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.equal(f.calls[0]?.head,9);
});

test('only the tracked pointer can finish deferred selection reveal',t=>{
  const f=setup(t);f.pointer(f.view.contentDOM,'pointerdown');f.cursor(12);f.pointer(f.view.contentDOM,'pointerup',10,10,2,false);f.settle();assert.deepEqual(f.calls,[]);
  f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.equal(f.calls[0]?.head,12);
});

test('minor native touch jitter preserves a tap while scroll movement cancels',t=>{
  const f=setup(t);f.pointer(f.view.contentDOM,'pointerdown');f.cursor(12);
  const move=new f.win.Event('touchmove',{bubbles:true});Object.defineProperty(move,'touches',{value:[{clientX:11,clientY:11}]});f.view.contentDOM.dispatchEvent(move);
  f.pointer(f.view.contentDOM,'pointerup',11,11);f.settle();assert.equal(f.calls[0]?.head,12);
});


for(const reason of ['document replacement','scroll'] as const)test(`held-pointer reveal cannot reacquire intent after ${reason}`,t=>{
  const f=setup(t);f.pointer(f.view.contentDOM,'pointerdown');f.cursor(12);
  if(reason==='document replacement')f.view.dispatch({changes:{from:0,insert:'replacement '}});
  else f.event(document.querySelector('.note-scroll')!,'scroll');
  const selection=f.view.state.selection;
  f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.deepEqual(f.calls,[]);assert.ok(f.view.state.selection.eq(selection));
  f.pointer(f.view.contentDOM,'pointerdown');f.cursor(9);f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.equal(f.calls[0]?.head,9,'a new caret intent remains usable');
});


test('keyboard resize during a held tap is deferred until that pointer ends even with an unchanged caret',t=>{
  const f=setup(t);f.pointer(f.view.contentDOM,'pointerdown');f.event(f.viewport,'resize');f.settle();assert.deepEqual(f.calls,[]);
  f.pointer(f.view.contentDOM,'pointerup');f.settle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].head,f.view.state.selection.main.head);
});

for(const reason of ['drag','cancel'] as const)test(`keyboard resize cannot revive a ${reason} gesture`,t=>{
  const f=setup(t);f.pointer(f.view.contentDOM,'pointerdown');f.cursor(12);
  if(reason==='drag')f.pointer(f.view.contentDOM,'pointermove',30,30);else f.event(f.view.contentDOM,'pointercancel');
  f.event(f.viewport,'resize');f.settle();assert.deepEqual(f.calls,[]);
  f.pointer(f.view.contentDOM,'pointerup',30,30);f.event(f.win,'resize');f.settle();assert.deepEqual(f.calls,[]);
});
