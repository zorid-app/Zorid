import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {captureObserverFailure,observerSource,sampleObserverSource} from './observer.mjs';
function fixture({deferredEligibility=false}={}){
  let value='Fixture body',caret=0,now=1,top=0,editable='true',inert=false;const listeners=new Map(),microtasks=[],frames=[];
  const view={state:{doc:{get length(){return value.length;},sliceString:(a,b)=>value.slice(a,b)},selection:{main:{get head(){return caret;}}}}};
  const node={cmTile:{root:{view}},getAttribute:()=>editable,closest:()=>inert?{}:null,getBoundingClientRect:()=>({width:100,height:100,top,bottom:top+100}),contains:other=>other===node};view.contentDOM=node;
  const title={value:deferredEligibility?'':'Note'};
  const line={textContent:'Fixture body',outerHTML:'<div class="cm-line">Fixture body</div>',getBoundingClientRect:()=>node.getBoundingClientRect()};node.children=[line];
  const pane={querySelector:selector=>selector==='.cm-content'?node:title,querySelectorAll:()=>[line]};
  const document={readyState:'loading',documentElement:{},querySelector:()=>pane,
    addEventListener:(key,handler)=>listeners.set(key,handler),removeEventListener:key=>listeners.delete(key)};
  const window={addEventListener(){},removeEventListener(){}};
  const context={window,document,performance:{now:()=>now++},innerHeight:800,
    MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>frames.push(fn),queueMicrotask:fn=>microtasks.push(fn)};
  vm.runInNewContext(observerSource({identity:'case',path:'Note.md',characters:value.length,prefix:'Fixture',visibleText:'Fixture body',markers:{ready:'x',deadline:'y'}}),context);
  const flush=()=>{while(frames.length)frames.shift()();};flush();
  return {window,node,listeners,flush,evaluate:source=>vm.runInNewContext(source,context),setSource(source){value=source;},setTop(value){top=value;},setEditable(value){editable=value;},setInert(value){inert=value;},publishWithoutMutation(){title.value='Note';},edit(trusted,delayed=false){listeners.get('beforeinput')({data:'x',isTrusted:trusted,inputType:'insertText',target:node});let before;if(delayed){while(microtasks.length)microtasks.shift()();before=window.__zoridPackagedProbe.probes[0].accepted;}value='x'+value;caret=1;while(microtasks.length)microtasks.shift()();flush();return before;}};
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
  state.extraDiagnosticMethod=()=>true;const sample=f.evaluate(sampleObserverSource);assert.equal(sample.extraDiagnosticMethod,undefined);assert.equal(sample.ready,null,'two real animation frames still required');assert.equal(sample.readinessCheck.eligible,true);assert.equal(sample.readinessCheck.framesPending,true);f.flush();
  assert.ok(state.ready);assert.equal(state.initial.prefixMatches,true);assert.equal(state.probes.length,0,'observation never injects an edit');
});

test('snapshot sampling retains exact source and offscreen rejection',()=>{
  const wrong=fixture({deferredEligibility:true});wrong.publishWithoutMutation();wrong.setSource('Wrongxx body');wrong.evaluate(sampleObserverSource);wrong.flush();assert.equal(wrong.window.__zoridPackagedProbe.ready,null);
  const offscreen=fixture({deferredEligibility:true});offscreen.publishWithoutMutation();offscreen.setTop(900);offscreen.evaluate(sampleObserverSource);offscreen.flush();assert.equal(offscreen.window.__zoridPackagedProbe.ready,null);
});
test('two-frame acceptance rechecks source, editability, inert and viewport guards',()=>{
  for(const invalidate of [f=>f.setSource('Wrongxx body'),f=>f.setEditable('false'),f=>f.setInert(true),f=>f.setTop(900)]){
    const f=fixture({deferredEligibility:true});f.publishWithoutMutation();f.evaluate(sampleObserverSource);invalidate(f);f.flush();assert.equal(f.window.__zoridPackagedProbe.ready,null);
  }
});
test('failure capture preserves observer and actual selected editor diagnostics even without ready',async()=>{
  const f=fixture({deferredEligibility:true}),launch={errors:['original readiness failure'],cases:[{identity:'case'}]};
  await captureObserverFailure({evaluate:async source=>f.evaluate(source)},launch);
  assert.equal(launch.failureObservation.probe.ready,null);assert.equal(launch.failureObservation.contentDOMMatches,true);assert.equal(launch.failureObservation.prefix,'Fixture body');
  assert.equal(launch.failureObservation.firstLines[0].text,'Fixture body');assert.equal(launch.failureObservation.visibleContent[0].text,'Fixture body');
  assert.equal(launch.cases[0].failureObservation,launch.failureObservation);assert.deepEqual(launch.errors,['original readiness failure']);
  assert.equal(Object.values(launch.failureObservation.probe).some(value=>typeof value==='function'),false);
});
test('failure capture cannot mask the original failure when the renderer is unavailable',async()=>{
  const unattached={};await captureObserverFailure(null,unattached);assert.match(unattached.failureObservation.unavailable,/not attached/);
  const launch={errors:['original readiness failure']};await captureObserverFailure({evaluate:async()=>{throw Error('renderer gone');}},launch);
  assert.match(launch.failureObservation.error,/renderer gone/);assert.deepEqual(launch.errors,['original readiness failure']);
});
