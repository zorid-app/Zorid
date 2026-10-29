import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {observerSource} from './observer.mjs';
function fixture({deferredEligibility=false}={}){
  let value='Fixture body',caret=0,now=1;const listeners=new Map(),microtasks=[],frames=[];
  const view={state:{doc:{get length(){return value.length;},sliceString:(a,b)=>value.slice(a,b)},selection:{main:{get head(){return caret;}}}}};
  const node={cmTile:{root:{view}},getAttribute:()=> 'true',closest:()=>null,getBoundingClientRect:()=>({width:100,height:100,top:0,bottom:100}),contains:other=>other===node};view.contentDOM=node;
  const title={value:deferredEligibility?'':'Note'};
  const pane={querySelector:selector=>selector==='.cm-content'?node:title,querySelectorAll:()=>[{textContent:'Fixture body'}]};
  const document={readyState:'loading',documentElement:{},querySelector:()=>pane,
    addEventListener:(key,handler)=>listeners.set(key,handler),removeEventListener:key=>listeners.delete(key)};
  const window={addEventListener(){},removeEventListener(){}};
  const context={window,document,performance:{now:()=>now++},innerHeight:800,
    MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>frames.push(fn),queueMicrotask:fn=>microtasks.push(fn)};
  vm.runInNewContext(observerSource({identity:'case',path:'Note.md',characters:value.length,prefix:'Fixture',visibleText:'Fixture body',markers:{ready:'x',deadline:'y'}}),context);
  const flush=()=>{while(frames.length)frames.shift()();};flush();
  return {window,node,listeners,flush,publishWithoutMutation(){title.value='Note';},edit(trusted,delayed=false){listeners.get('beforeinput')({data:'x',isTrusted:trusted,inputType:'insertText',target:node});let before;if(delayed){while(microtasks.length)microtasks.shift()();before=window.__zoridPackagedProbe.probes[0].accepted;}value='x'+value;caret=1;while(microtasks.length)microtasks.shift()();flush();return before;}};
}
test('actual injected observer records CodeMirror identity/viewport and trusted accepted edit',()=>{
  const f=fixture();assert.ok(f.window.__zoridPackagedProbe.ready);f.edit(true);
  const probe=f.window.__zoridPackagedProbe.probes[0];assert.equal(probe.accepted,true);assert.equal(probe.caretAfterPaint,1);
});
test('a synthetic edit changing the document is still rejected as input evidence',()=>{const f=fixture();f.edit(false);assert.equal(f.window.__zoridPackagedProbe.probes[0].accepted,false);});
test('input waits for the actual delayed CodeMirror transaction instead of assuming a beforeinput microtask is completion',()=>{
  const f=fixture();assert.equal(f.edit(true,true),undefined,'no applied verdict before CodeMirror changes');
  assert.equal(f.window.__zoridPackagedProbe.probes[0].accepted,true);
});
test('observer disposal removes event listeners instead of observing later cases',()=>{const f=fixture();f.window.__zoridPackagedProbe.dispose();assert.equal(f.listeners.has('beforeinput'),false);});

test('sampling detects editor eligibility published through a property without a DOM mutation or focus',()=>{
  const f=fixture({deferredEligibility:true}),state=f.window.__zoridPackagedProbe;assert.equal(state.ready,null);
  f.publishWithoutMutation();assert.equal(state.ready,null);
  const sample=state.sample();assert.equal(sample.ready,null,'two real animation frames still required');f.flush();
  assert.ok(state.ready);assert.equal(state.initial.prefixMatches,true);assert.equal(state.probes.length,0,'observation never injects an edit');
});
