import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyWidgetEdit} from '../src/bases/property-widgets.ts';
import {pathReuseScalarFrame} from './bases-electron-safety-integration/campaign.mjs';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,10));
function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function setup(){
  const dom=new JSDOM('<main><div id="cell" tabindex="0"></div><button id="outside">Outside</button><section id="pointer-target"></section></main>',{pretendToBeVisual:true});
  const document=dom.window.document,element=document.querySelector<HTMLElement>('#cell')!,outside=document.querySelector<HTMLButtonElement>('#outside')!;
  const gate=deferred(),edits:BasePropertyWidgetEdit[]=[],errors:unknown[]=[];let current=true;
  const listeners=new Set<EventListenerOrEventListenerObject>();
  const untrack: (()=>void)[]=[];
  for(const target of [document,dom.window]){
    const add=target.addEventListener,remove=target.removeEventListener;
    const tracked=(name:string)=>['focusin','pointerdown','keydown','blur'].includes(name);
    Object.defineProperty(target,'addEventListener',{configurable:true,value:function(name:string,listener:EventListenerOrEventListenerObject,options?:unknown){if(tracked(name))listeners.add(listener);return add.call(this,name,listener,options as any);}});
    Object.defineProperty(target,'removeEventListener',{configurable:true,value:function(name:string,listener:EventListenerOrEventListenerObject,options?:unknown){if(tracked(name))listeners.delete(listener);return remove.call(this,name,listener,options as any);}});
    untrack.push(()=>{Object.defineProperty(target,'addEventListener',{configurable:true,value:add});Object.defineProperty(target,'removeEventListener',{configurable:true,value:remove});});
  }
  const value={type:'number' as const,value:3};
  const dispose=mountBasePropertyWidget(element,{row:{path:'Replace.md',values:{'note.score':value}},property:'note.score',value,version:1},{
    getDefinition:()=>({type:'number'}),isCurrent:()=>current,
    async commit(edit){edits.push(edit);await gate.promise;return {version:2,row:edit.row,value:edit.value};},
    onError:error=>errors.push(error),
  });
  function open(){
    element.click();const input=element.querySelector<HTMLInputElement>('input')!;assert.ok(input);assert.equal(document.activeElement,input);
    const disabled=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'disabled')!;
    // JSDOM keeps focus on disabled inputs. Model Chromium's automatic disable
    // blur using the real DOM accessors/blur; no app state or save reply changes.
    Object.defineProperty(input,'disabled',{configurable:true,get(){return disabled.get!.call(input);},set(value:boolean){
      disabled.set!.call(input,value);
      if(value&&document.activeElement===input){disabled.set!.call(input,false);input.blur();disabled.set!.call(input,true);}
    }});
    input.value='8';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));return input;
  }
  const key=(target:Element,key:string)=>target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  const fail=async()=>{gate.reject(new Error('The file changed or was replaced. Your draft was kept.'));await tick();};
  const close=()=>{dispose();gate.resolve();for(const restore of untrack)restore();dom.window.close();};
  return {dom,document,element,outside,gate,edits,errors,listeners,open,key,fail,dispose,close,retire(){current=false;}};
}

test('a failed scalar Enter restores owned focus after disable blur so one Escape cancels the retained draft',async()=>{
  const s=setup();try{
    const input=s.open();s.key(input,'Enter');assert.equal(input.disabled,true);assert.equal(s.document.activeElement,s.document.body);
    await tick();await s.fail();
    assert.equal(s.document.activeElement,input,'The original failed input must regain the keyboard ownership lost only by disabling');
    assert.equal(input.value,'8');assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(s.element.dataset.baseEditing,'draft');assert.equal(s.edits.length,1);
    const frame=pathReuseScalarFrame(s.document,'#cell input');assert.equal(frame.inputFocused,true);assert.equal(frame.value,'8');assert.equal(frame.invalid,'true');assert.equal(frame.editState,'draft');assert.equal(frame.disabled,false);assert.equal(frame.connected,true);assert.equal(frame.matches,1);
    assert.equal(s.listeners.size,0,'Settling removes all temporary document/window ownership observers');
    s.key(s.document.activeElement!,'Escape');
    assert.equal(s.element.querySelector('input'),null);assert.equal(s.element.dataset.baseEditing,undefined);assert.equal(s.element.textContent,'3');assert.equal(s.edits.length,1);
    assert.equal(pathReuseScalarFrame(s.document,'#cell input').matches,0);
  }finally{s.close();}
});

test('a successful scalar save does not restore the removed input or retain ownership observers',async()=>{
  const s=setup();try{
    const input=s.open();let focused=0;input.addEventListener('focus',()=>{focused++;});s.key(input,'Enter');await tick();s.gate.resolve();await tick();
    assert.equal(s.element.textContent,'8');assert.equal(input.isConnected,false);assert.equal(focused,0);assert.equal(s.listeners.size,0);assert.equal(s.edits.length,1);
  }finally{s.close();}
});

test('another focused control retains ownership even if it later blurs before the save fails',async()=>{
  for(const blurOutside of [false,true]){
    const s=setup();try{
      const input=s.open();s.key(input,'Enter');s.outside.focus();if(blurOutside)s.outside.blur();await tick();await s.fail();
      assert.equal(s.document.activeElement,blurOutside?s.document.body:s.outside);assert.equal(input.value,'8');assert.equal(s.edits.length,1);assert.equal(s.listeners.size,0);
      assert.equal(pathReuseScalarFrame(s.document,'#cell input').inputFocused,false,'The native receipt cannot infer keyboard focus merely from a retained draft');
    }finally{s.close();}
  }
});

test('outside pointer, window blur and pending Tab intent relinquish failed-input focus ownership',async()=>{
  for(const intent of ['pointer','window-blur','tab']){
    const s=setup();try{
      const input=s.open();s.key(input,'Enter');
      if(intent==='pointer')s.document.querySelector('#pointer-target')!.dispatchEvent(new s.dom.window.Event('pointerdown',{bubbles:true}));
      else if(intent==='window-blur')s.dom.window.dispatchEvent(new s.dom.window.Event('blur'));
      else s.key(s.document.body,'Tab');
      await tick();await s.fail();
      assert.equal(s.document.activeElement,s.document.body,intent);assert.equal(input.value,'8');assert.equal(s.edits.length,1);assert.equal(s.listeners.size,0);
    }finally{s.close();}
  }
});

test('a Tab-initiated scalar save and a normal blur save never recapture focus after failure',async()=>{
  for(const intent of ['tab','blur']){
    const s=setup();try{
      const input=s.open();if(intent==='tab')s.key(input,'Tab');else s.outside.focus();
      await tick();assert.equal(s.edits.length,1);await s.fail();
      assert.equal(s.document.activeElement,intent==='tab'?s.document.body:s.outside);assert.equal(input.value,'8');assert.equal(s.listeners.size,0);
    }finally{s.close();}
  }
});

test('retired, detached, replaced and disposed scalar editors never regain focus on a late failure',async()=>{
  for(const state of ['retired','detached','replaced','disposed']){
    const s=setup();try{
      const input=s.open();let focused=0;input.addEventListener('focus',()=>{focused++;});s.key(input,'Enter');await tick();
      if(state==='retired')s.retire();
      else if(state==='detached')s.element.remove();
      else if(state==='replaced')s.element.replaceChildren(s.document.createElement('input'));
      else{s.dispose();assert.equal(s.listeners.size,0,'Disposal releases observers even while the provider has not settled');}
      await s.fail();assert.equal(focused,0,state);assert.notEqual(s.document.activeElement,input);assert.equal(s.edits.length,1);assert.equal(s.listeners.size,0);
    }finally{s.close();}
  }
});

test('composition and IME Enter do not create a scalar save or an owned-focus continuation',async()=>{
  const s=setup();try{
    const input=s.open();input.dispatchEvent(new s.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
    input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
    await tick();assert.equal(s.edits.length,0);assert.equal(s.document.activeElement,input);assert.equal(input.value,'8');assert.equal(s.listeners.size,0);
  }finally{s.close();}
});
