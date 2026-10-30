// Passive DOM-observer contracts only, never painted native/app evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {observeLostCreateUi,captureLostCreateUi,lostCreateUiFrame,disposeLostCreateUi} from './lost-create-ui.mjs';
function fixture(){
  const dom=new JSDOM('<main class="pane is-active"><div class="tab is-active" data-tab-id="original-tab"></div><div class="breadcrumbs">Create</div><div class="bases-session" data-base-controller-error="false" data-base-controller-updating="false"><div class="bases-toolbar-tabs"><button class="bases-toolbar-tab" aria-selected="true" aria-label="Create view">Create</button></div><button aria-label="New">New</button><div class="bases-session-content" aria-busy="false"></div><div role="status">Recovering…</div></div></main>',{pretendToBeVisual:true,runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
  return{dom,doc:dom.window.document,close(){dom.window.close();}};
}
test('lost-create observer reads the original target without DOM changes and permits honest pending status',async()=>{
  const f=fixture(),before=f.doc.body.outerHTML,observer=observeLostCreateUi(f.doc);
  try{const frame=observer.frame();assert.equal(frame.settled,true);assert.equal(frame.tabId,'original-tab');assert.equal(frame.viewLabel,'Create view');assert.equal(frame.viewIndex,0);assert.deepEqual(frame.failures,[]);assert.equal(f.doc.body.outerHTML,before);await new Promise(resolve=>f.dom.window.requestAnimationFrame(resolve));assert.ok(observer.frame().animationFrames>0);}finally{observer.dispose();f.close();}
});
test('visible alert/status/manual recovery flashes remain recorded after normal presentation returns',async()=>{
  for(const html of ['<div role="alert">Request failed</div>','<div role="status">New is uncertain</div>','<button>Retry save</button>','<button disabled>Reopen vault</button>','<div class="bases-configuration-review">Retained</div>']){
    const f=fixture(),observer=observeLostCreateUi(f.doc);
    try{const node=f.doc.createElement('section');node.innerHTML=html;f.doc.body.append(node);await Promise.resolve();assert.ok(observer.frame().failures.length>0);node.remove();await Promise.resolve();assert.ok(observer.frame().failures.length>0,'An earlier observed failure cannot disappear from the receipt');}finally{observer.dispose();f.close();}
  }
});
test('hidden controls do not count as visible recovery, while replaced pane/tab/source targets fail',()=>{
  const f=fixture(),observer=observeLostCreateUi(f.doc);
  try{const hidden=f.doc.createElement('button');hidden.textContent='Retry save';hidden.hidden=true;f.doc.body.append(hidden);assert.deepEqual(observer.frame().failures,[]);f.doc.querySelector('.tab').dataset.tabId='other';assert.ok(observer.frame().failures.some(row=>row.category==='original-tab-changed'));f.doc.querySelector('.breadcrumbs').textContent='Other';assert.ok(observer.frame().failures.some(row=>row.category==='original-source-changed'));f.doc.querySelector('.pane').replaceWith(f.doc.querySelector('.pane').cloneNode(true));assert.ok(observer.frame().failures.some(row=>row.category==='original-pane-changed'));}finally{observer.dispose();f.close();}
});
test('disposal disconnects passive observation and cancels its scheduled frame',async()=>{
  const f=fixture(),observer=observeLostCreateUi(f.doc);
  try{observer.dispose();observer.dispose();const before=observer.frame();f.doc.querySelector('[role="status"]').textContent='Recovering normally';await new Promise(resolve=>f.dom.window.requestAnimationFrame(resolve));const after=observer.frame();assert.equal(after.disposed,true);assert.equal(after.mutationFrames,before.mutationFrames);assert.equal(after.animationFrames,before.animationFrames);}finally{f.close();}
});
test('a visible recovery control overriding inherited hidden visibility is still observed',()=>{
  const f=fixture(),observer=observeLostCreateUi(f.doc);
  try{const parent=f.doc.createElement('section');parent.style.visibility='hidden';const button=f.doc.createElement('button');button.textContent='Retry save';button.style.visibility='visible';parent.append(button);f.doc.body.append(parent);assert.ok(observer.frame().failures.some(row=>row.category==='visible-manual-recovery-control'));}finally{observer.dispose();f.close();}
});
function peer(f){
  const objects=new Map(),calls=[];let sequence=0;
  const keep=value=>{const objectId='passive-peer-'+(++sequence);objects.set(objectId,value);return{objectId};};
  return{objects,calls,async call(method,params){calls.push(method);
    if(method==='Runtime.evaluate')return{result:keep(f.dom.window.eval(params.expression))};
    if(method==='Runtime.callFunctionOn'){const result=f.dom.window.eval('('+params.functionDeclaration+')').apply(objects.get(params.objectId));return{result:params.returnByValue?{value:result}:keep(result)};}
    if(method==='DOM.describeNode')return{node:{backendNodeId:42}};
    if(method==='Runtime.releaseObjectGroup'){objects.clear();return{};}throw Error('Unexpected observer CDP call '+method);
  }};
}
test('remote observation releases its own object group on success and terminal capture failure',async()=>{
  for(const failure of [null,'DOM.describeNode']){
    const f=fixture(),cdp=peer(f),call=cdp.call.bind(cdp);cdp.call=async(method,params)=>{if(method===failure)throw Error('pure terminal failure');return call(method,params);};
    try{if(failure)await assert.rejects(captureLostCreateUi({cdp}),/pure terminal failure/);else{const original=await captureLostCreateUi({cdp});assert.equal(original.paneBackendNodeId,42);assert.equal((await lostCreateUiFrame({cdp},original)).settled,true);await disposeLostCreateUi({cdp},original);}assert.equal(cdp.objects.size,0);assert.equal(cdp.calls.at(-1),'Runtime.releaseObjectGroup');}finally{f.close();}
  }
});
