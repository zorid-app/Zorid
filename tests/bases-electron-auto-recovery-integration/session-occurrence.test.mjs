// Pure DOM/storage restoration fixture, never app or Native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {captureSessionOccurrence} from './session-occurrence.mjs';
import {sha256} from './oracles.mjs';
import {observeQuietRecovery,startQuietRecovery,finishQuietRecovery} from './quiet-observer.mjs';
const key='zorid:workspace:window:main:'+encodeURIComponent('desktop-core:owned-store:owned-client');
const oldTabId='10000000-0000-4000-8000-000000000001',newTabId='10000000-0000-4000-8000-000000000002',thirdTabId='10000000-0000-4000-8000-000000000003',peerTabId='10000000-0000-4000-8000-000000000004',freshPeerTabId='10000000-0000-4000-8000-000000000005';
const descriptor={kind:'note',path:'AutoHost.base',expectedEntryId:'original-entry',mode:'live',baseSource:false,history:['AutoHost.base'],historyIndex:0};
const session=tabId=>({activePaneId:'stable-pane',layout:{type:'leaf',paneId:'stable-pane'},panes:[{id:'stable-pane',active:0,tabs:[{...descriptor,id:tabId}]}]});
const markup=tabId=>`<main class="pane is-active"><div role="tab" data-tab-id="${tabId}" aria-selected="true"></div><div class="breadcrumbs">AutoHost</div><div class="bases-session" data-base-controller-error="false"></div></main>`;
test('Source-intended host shell rebuild preserves the serialized occurrence despite new pane and tab DOM',async()=>{
  const dom=new JSDOM(markup(oldTabId),{pretendToBeVisual:true,url:'https://owned.invalid'}),doc=dom.window.document;dom.window.localStorage.setItem(key,JSON.stringify(session(oldTabId)));const observer=observeQuietRecovery(doc,{kind:'host',occurrence:{windowId:'main',path:'AutoHost.base',entryId:'original-entry'}},captureSessionOccurrence);
  try{const before=JSON.parse(dom.window.localStorage.getItem(key));doc.body.innerHTML=markup(newTabId);dom.window.localStorage.setItem(key,JSON.stringify(session(newTabId)));const after=JSON.parse(dom.window.localStorage.getItem(key));assert.equal(before.activePaneId,after.activePaneId);assert.deepEqual(before.layout,after.layout);assert.equal(before.panes[0].id,after.panes[0].id);assert.deepEqual({...before.panes[0].tabs[0],id:undefined},{...after.panes[0].tabs[0],id:undefined});assert.equal(doc.querySelector('[data-tab-id]').dataset.tabId,after.panes[0].tabs[0].id);await new Promise(resolve=>dom.window.requestAnimationFrame(resolve));const result=observer.finish(),c={cdp:{async call(method){return method==='Runtime.callFunctionOn'?{result:{value:result}}:{};}}};await assert.doesNotReject(finishQuietRecovery(c,{objectId:'pure-observer',group:'pure-group',kind:'host'}));}
  finally{observer.finish();dom.window.close();}
});

function fixture(saved=session(oldTabId)){
  const dom=new JSDOM(markup(oldTabId),{pretendToBeVisual:true,url:'https://owned.invalid',runScripts:'outside-only'}),doc=dom.window.document,storage=dom.window.localStorage;storage.setItem(key,JSON.stringify(saved));return{dom,doc,storage,capture:()=>captureSessionOccurrence(doc,{windowId:'main',path:'AutoHost.base',entryId:'original-entry'}),close(){dom.window.close();}};
}
test('occurrence selection rejects missing, ambiguous, wrong-window, fake-actor and equivalent peer records',()=>{
  const cases=[f=>f.storage.clear(),f=>f.storage.setItem(key.replace('window:main:','window:peer:'),f.storage.getItem(key)),f=>{const value=f.storage.getItem(key);f.storage.removeItem(key);f.storage.setItem(key.replace('window:main:','window:peer:'),value);},f=>{const saved=session(oldTabId);saved.panes[0].tabs[0].expectedEntryId='foreign';f.storage.setItem(key,JSON.stringify(saved));},f=>{const saved=session(oldTabId);saved.panes[0].tabs.push({...saved.panes[0].tabs[0],id:peerTabId});f.doc.querySelector('main').insertAdjacentHTML('afterbegin',`<div role="tab" data-tab-id="${peerTabId}" aria-selected="false"></div>`);f.storage.setItem(key,JSON.stringify(saved));}];
  for(const change of cases){const f=fixture();try{change(f);assert.throws(f.capture);}finally{f.close();}}
});
test('the exact key, stable pane, fixed ordinal and every non-ID descriptor stay bound across restoration',()=>{
  for(const change of [
    f=>f.storage.removeItem(key),
    f=>{const saved=session(newTabId);saved.panes[0].id='foreign-pane';saved.activePaneId='foreign-pane';saved.layout.paneId='foreign-pane';f.storage.setItem(key,JSON.stringify(saved));},
    f=>{const saved=session(newTabId);saved.panes[0].tabs[0].path='Peer.base';f.storage.setItem(key,JSON.stringify(saved));},
    f=>{const saved=session(newTabId);saved.panes[0].tabs[0].viewState={scrollTop:99,scrollLeft:0};f.storage.setItem(key,JSON.stringify(saved));},
    f=>{const saved=session(newTabId);saved.layout={type:'branch',direction:'horizontal',children:[saved.layout],sizes:[1]};f.storage.setItem(key,JSON.stringify(saved));},
  ]){const f=fixture();try{const occurrence=f.capture();change(f);assert.equal(occurrence.read().valid,false);f.storage.setItem(key,JSON.stringify(session(oldTabId)));assert.equal(occurrence.read().valid,false,'A removed/retargeted occurrence cannot heal by matching a later path');}finally{f.close();}}
});
test('stored slot and replacement DOM must agree, with only one fresh identity rotation',()=>{
  const f=fixture();try{const occurrence=f.capture();f.storage.setItem(key,JSON.stringify(session(newTabId)));assert.equal(occurrence.read().valid,false,'New stored IDs cannot authorize an unrelated DOM target');f.doc.body.innerHTML=markup(newTabId);assert.equal(occurrence.read().valid,true);f.storage.setItem(key,JSON.stringify(session(thirdTabId)));f.doc.body.innerHTML=markup(thirdTabId);assert.equal(occurrence.read().valid,false);}finally{f.close();}
});
test('Source restore normalizations preserve the remaining complete descriptor and layout',()=>{
  const original=session(oldTabId);delete original.panes[0].tabs[0].baseSource;delete original.panes[0].tabs[0].history;delete original.panes[0].tabs[0].historyIndex;const f=fixture(original);try{const occurrence=f.capture(),restored=structuredClone(original);Object.assign(restored.panes[0].tabs[0],{id:newTabId,baseSource:false,history:[],historyIndex:-1});f.storage.setItem(key,JSON.stringify(restored));f.doc.body.innerHTML=markup(newTabId);assert.equal(occurrence.read().valid,true);}finally{f.close();}
});
test('host observer verifies the actual original key Core scope against real-claim hashes and exports only hashes',async()=>{
  for(const wrongScope of [false,true]){const f=fixture(),objects=new Map();let next=0,releases=0;const c={cdp:{evaluate:async()=>({id:'main'}),async call(method,params){if(method==='Runtime.evaluate'){const objectId='pure-'+(++next);objects.set(objectId,f.dom.window.eval(params.expression));return{result:{objectId}};}if(method==='Runtime.callFunctionOn'){const result=f.dom.window.eval('('+params.functionDeclaration+')').call(objects.get(params.objectId));return{result:{value:JSON.parse(JSON.stringify(result))}};}assert.equal(method,'Runtime.releaseObjectGroup');releases++;objects.clear();return{};}}};
    const claim={localStoreIdSha256:sha256('owned-store'),clientIdSha256:sha256(wrongScope?'foreign-client':'owned-client'),requestedClientIdSha256:sha256(wrongScope?'foreign-client':'owned-client')};try{if(wrongScope){await assert.rejects(startQuietRecovery(c,{kind:'host',path:'AutoHost.base',entryId:'original-entry',claim}));assert.equal(releases,1);}else{const observer=await startQuietRecovery(c,{kind:'host',path:'AutoHost.base',entryId:'original-entry',claim});await new Promise(resolve=>f.dom.window.requestAnimationFrame(resolve));const result=await finishQuietRecovery(c,observer),json=JSON.stringify(result);assert.equal(json.includes(key),false);assert.equal(json.includes('owned-client'),false);assert.equal(json.includes('owned-store'),false);assert.equal(result.occurrenceProof.keySha256,sha256(key));assert.equal(releases,1);}}finally{f.close();}
  }
});

test('fake replacement tab IDs cannot manufacture a matching stored and DOM occurrence',()=>{const f=fixture();try{const occurrence=f.capture();f.storage.setItem(key,JSON.stringify(session('replacement')));f.doc.body.innerHTML=markup('replacement');assert.equal(occurrence.read().valid,false);}finally{f.close();}});
test('rebuilt two-pane DOM cannot swap original logical positions when saved array order differs from layout',()=>{
  const saved=session(oldTabId);saved.panes.push({id:'peer-pane',active:0,tabs:[{...descriptor,path:'Peer.base',expectedEntryId:'peer-entry',history:['Peer.base'],id:peerTabId}]});saved.layout={type:'split',id:'split-root',direction:'horizontal',children:[{type:'leaf',paneId:'peer-pane'},{type:'leaf',paneId:'stable-pane'}],sizes:[1,1]};const f=fixture(saved),peer=id=>markup(id).replace('pane is-active','pane').replace('AutoHost</div>','Peer</div>');
  try{f.doc.body.innerHTML=peer(peerTabId)+markup(oldTabId);const occurrence=f.capture(),restored=structuredClone(saved);restored.panes[0].tabs[0].id=newTabId;restored.panes[1].tabs[0].id=freshPeerTabId;f.storage.setItem(key,JSON.stringify(restored));f.doc.body.innerHTML=peer(freshPeerTabId)+markup(newTabId);assert.equal(occurrence.read().valid,true,'The original DOM order may differ from saved pane-array order');f.doc.body.innerHTML=markup(newTabId)+peer(freshPeerTabId);assert.equal(occurrence.read().valid,false);f.doc.body.innerHTML=peer(freshPeerTabId)+markup(newTabId);assert.equal(occurrence.read().valid,false,'A wrong complete mapping remains rejected after a later matching reorder');}finally{f.close();}
});
test('wrong complete active or selected target stays rejected after a later matching state',()=>{
  const results=[];
  for(const mode of ['active','multiple-selected']){const saved=session(oldTabId);saved.panes[0].tabs.push({...descriptor,path:'Peer.base',expectedEntryId:'peer-entry',history:['Peer.base'],id:peerTabId});const f=fixture(saved);try{f.doc.querySelector('main').insertAdjacentHTML('beforeend',`<div role="tab" data-tab-id="${peerTabId}" aria-selected="false"></div>`);const occurrence=f.capture(),pane=f.doc.querySelector('main'),peer=f.doc.querySelector(`[data-tab-id="${peerTabId}"]`);if(mode==='active')pane.classList.remove('is-active');else peer.setAttribute('aria-selected','true');results.push(occurrence.read().valid);pane.classList.add('is-active');peer.setAttribute('aria-selected','false');results.push(occurrence.read().valid);}finally{f.close();}}
  assert.deepEqual(results,[false,false,false,false]);
});
