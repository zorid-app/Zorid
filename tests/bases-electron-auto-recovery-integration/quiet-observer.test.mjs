// Passive DOM observer contracts, no Native/app or recovery acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {observeQuietRecovery,finishQuietRecovery} from './quiet-observer.mjs';
const setup=()=>new JSDOM('<main class="pane is-active"><div role="tab" data-tab-id="original" aria-selected="true"></div><div class="breadcrumbs">AutoBusy</div><div class="bases-session" data-base-controller-error="false"></div></main>',{pretendToBeVisual:true});
test('quiet observer records errors added and cleared between frames, including inert visible UI',async()=>{
  for(const mode of ['alert','controller','manual','inert']){const dom=setup(),doc=dom.window.document,observer=observeQuietRecovery(doc);try{
    if(mode==='controller'){const root=doc.querySelector('.bases-session');root.dataset.baseControllerError='true';root.dataset.baseControllerError='false';}
    else{const node=doc.createElement(mode==='manual'?'button':'div');if(mode==='manual')node.textContent='Retry save';else{node.setAttribute('role','alert');node.textContent='A failed';}if(mode==='inert')doc.querySelector('main').inert=true;doc.querySelector('main').append(node);node.remove();}
    await Promise.resolve();const result=observer.finish();assert.ok(result.events.length>0,mode);assert.equal(result.overflow,false);
  }finally{observer.finish();dom.window.close();}}
});
test('quiet observer excludes hidden controls, detects navigation and stops all frame/mutation observation',async()=>{
  const dom=setup(),doc=dom.window.document,observer=observeQuietRecovery(doc);try{const hidden=doc.createElement('div');hidden.hidden=true;hidden.innerHTML='<div role="alert">Hidden error</div><button>Review retained changes</button>';doc.body.append(hidden);const hiddenAlert=hidden.querySelector('[role="alert"]');hiddenAlert.firstChild.data='Another hidden error';hiddenAlert.firstChild.data='';await Promise.resolve();assert.deepEqual(observer.read().events,[]);doc.querySelector('.breadcrumbs').textContent='Peer';assert.equal(observer.read().sameSource,false);const result=observer.finish(),frames=result.frames;const alert=doc.createElement('div');alert.role='alert';alert.textContent='Late';doc.body.append(alert);await Promise.resolve();assert.deepEqual(observer.finish().events,[]);assert.equal(observer.finish().frames,frames);}finally{observer.finish();dom.window.close();}
});

test('observer error assertion survives group disposal and retains its cause if disposal also fails',async()=>{
  for(const cleanupFailure of [false,true]){const dom=setup(),doc=dom.window.document,observer=observeQuietRecovery(doc);let releases=0;try{await new Promise(resolve=>dom.window.requestAnimationFrame(resolve));const alert=doc.createElement('div');alert.setAttribute('role','alert');alert.textContent='Visible failed';doc.body.append(alert);const result=observer.finish();const c={cdp:{async call(method){if(method==='Runtime.callFunctionOn')return{result:{value:result}};assert.equal(method,'Runtime.releaseObjectGroup');releases++;if(cleanupFailure)throw Error('Pure peer disposal failure');return{};}}};
    await assert.rejects(finishQuietRecovery(c,{objectId:'pure-observer',group:'pure-group'}),error=>{assert.match(error.message,/Automatic recovery must not flash/);if(cleanupFailure){assert.ok(error instanceof AggregateError);assert.match(error.cause.message,/Automatic recovery must not flash/);}return true;});assert.equal(releases,1);
  }finally{observer.finish();dom.window.close();}}
});
