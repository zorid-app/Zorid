// Pure DOM/input-peer contract checks, never app or Native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {UI} from '../bases-electron-integration/ui.mjs';
import {captureFocusedSummaryInput,continueFocusedSummaryInput,disposeFocusedSummaryInput,observeSummaryInput,focusedSummaryFrame,summaryOwner,summaryEditor,summaryBase} from './focused-summary-input.mjs';
const selector='[role="dialog"][aria-label="Edit summary"] .cm-content[aria-label="Summary expression"]';
function fixture(){
  const dom=new JSDOM('<main class="pane is-active"><div class="breadcrumbs">Failures / Live</div><div class="bases-session"></div></main><section role="dialog" aria-label="Edit summary"><fieldset><textarea aria-label="Summary expression" hidden>values.length</textarea><div class="cm-content" contenteditable="true" role="textbox" aria-label="Summary expression" aria-readonly="false" tabindex="0">values.length</div></fieldset></section><div role="listbox">length</div>',{pretendToBeVisual:true,runScripts:'outside-only'}),document=dom.window.document,editor=document.querySelector(selector),owner=editor.closest('[role="dialog"]'),base=document.querySelector('.bases-session'),events=[];
  const bounds={x:20,y:20,width:300,height:60,top:20,left:20,right:320,bottom:80};
  for(const element of [editor,owner,base]){element.getClientRects=()=>[bounds];element.getBoundingClientRect=()=>bounds;element.scrollIntoView=()=>{};}
  document.elementFromPoint=()=>document.querySelector('[role="listbox"]');editor.focus();
  const range=document.createRange();range.selectNodeContents(editor);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
  const objects=new Map(),ids=new WeakMap();let next=0;const keep=value=>{const objectId='pure-peer-'+(++next);objects.set(objectId,value);return{objectId};};
  const cdp={afterKey:undefined,evaluate:expression=>dom.window.eval(expression),async call(method,params){events.push({method,params});
    if(method==='Runtime.evaluate')return{result:keep(dom.window.eval(params.expression))};
    if(method==='Runtime.callFunctionOn'){const result=dom.window.eval('('+params.functionDeclaration+')').apply(objects.get(params.objectId),(params.arguments??[]).map(arg=>arg.value));return{result:params.returnByValue?{value:result}:keep(result)};}
    if(method==='DOM.describeNode'){const node=objects.get(params.objectId);if(!ids.has(node))ids.set(node,ids.has(owner)?102:101);return{node:{backendNodeId:ids.get(node)}};}
    if(method==='Runtime.releaseObjectGroup'){objects.clear();return{};}
    if(method==='Input.dispatchKeyEvent'&&params.type==='keyDown'&&params.commands?.includes('selectAll')){const range=document.createRange();range.selectNodeContents(editor);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);}
    if(method==='Input.dispatchKeyEvent'&&params.type==='keyUp')cdp.afterKey?.();
    if(method==='Input.insertText'){editor.textContent=params.text;document.querySelector('textarea').value=params.text;}return{};}};
  const ui=new UI(cdp,events);ui.wait=async(body,label)=>{const result=await ui.dom(body);assert.ok(result,label);return result;};
  const c={ui,cdp,evidence:{actions:events}},original={selector,owner,editor,base,document};
  return{dom,document,editor,owner,base,events,c,original,objects,close(){dom.window.close();}};
}
test('the original focused Summary editor accepts keyboard replacement while completion covers its center',async()=>{
  const f=fixture();try{assert.equal(f.document.activeElement,f.editor);assert.equal(f.editor.contains(f.document.elementFromPoint(170,50)),false);f.document.getSelection().collapse(f.editor.firstChild,2);assert.equal(f.document.getSelection().isCollapsed,true);const original=await captureFocusedSummaryInput(f.c,'Failures / Live');try{await continueFocusedSummaryInput(f.c,original,'values.sum() + 7','values.length');assert.deepEqual(f.events.filter(e=>e.method?.startsWith('Input.')).map(e=>e.method),['Input.dispatchKeyEvent','Input.dispatchKeyEvent','Input.insertText']);assert.equal(f.editor.textContent,'values.sum() + 7');assert.equal(f.events.find(e=>e.action==='focused-summary-keyboard-continuation').replacementSha256.length,64);}finally{await disposeFocusedSummaryInput(f.c,original);}assert.equal(f.objects.size,0);}finally{f.close();}
});

const inputCalls=f=>f.events.filter(event=>event.method?.startsWith('Input.'));
test('blurred, retired, replaced, peer, hidden, disabled, inert and wrong-source editors reject without input',async()=>{
  const cases=[
    f=>f.editor.blur(),f=>f.owner.remove(),f=>f.editor.replaceWith(f.editor.cloneNode(true)),f=>f.owner.replaceWith(f.owner.cloneNode(true)),
    f=>f.owner.append(f.editor.cloneNode(true)),f=>f.document.body.append(f.owner.cloneNode(true)),
    f=>f.editor.hidden=true,f=>f.owner.hidden=true,f=>f.editor.style.visibility='hidden',f=>f.owner.style.display='none',
    f=>f.editor.setAttribute('aria-disabled','true'),f=>f.owner.querySelector('fieldset').disabled=true,f=>f.owner.querySelector('textarea').readOnly=true,
    f=>f.owner.setAttribute('inert',''),f=>f.editor.setAttribute('contenteditable','false'),f=>f.editor.setAttribute('aria-readonly','true'),
    f=>f.base.replaceWith(f.base.cloneNode(true)),f=>f.document.querySelector('.breadcrumbs').textContent='Another source',
    f=>f.owner.querySelector('textarea').value='other A',f=>f.editor.textContent='other A',
    f=>{const range=f.document.createRange();range.selectNodeContents(f.base);const selection=f.document.getSelection();selection.removeAllRanges();selection.addRange(range);},
  ];
  for(const alter of cases){const f=fixture(),original=await captureFocusedSummaryInput(f.c,'Failures / Live');try{alter(f);await assert.rejects(continueFocusedSummaryInput(f.c,original,'values.sum() + 7','values.length'),/Original Summary editor/);assert.equal(inputCalls(f).length,0);}finally{await disposeFocusedSummaryInput(f.c,original);assert.equal(f.objects.size,0);f.close();}}
});
test('passive original-editor observers reject active, settling and key229 composition',async()=>{
  for(const events of [
    [['compositionstart',{}]],[['compositionstart',{}],['compositionend',{}]],
    [['keydown',{isComposing:true,keyCode:229}]],
  ]){const f=fixture(),original=await captureFocusedSummaryInput(f.c,'Failures / Live');try{for(const[type,options]of events)f.editor.dispatchEvent(type==='keydown'?new f.dom.window.KeyboardEvent(type,{bubbles:true,...options}):new f.dom.window.CompositionEvent(type,{bubbles:true,...options}));await assert.rejects(continueFocusedSummaryInput(f.c,original,'values.sum() + 7','values.length'),/Original Summary editor/);assert.equal(inputCalls(f).length,0);}finally{await disposeFocusedSummaryInput(f.c,original);f.close();}}
});
test('focus, identity or complete-selection loss after selectAll aborts before insertText without a pointer fallback',async()=>{
  for(const alter of [f=>f.editor.blur(),f=>f.editor.replaceWith(f.editor.cloneNode(true)),f=>{const range=f.document.createRange();range.setStart(f.editor.firstChild,2);range.collapse(true);const selection=f.document.getSelection();selection.removeAllRanges();selection.addRange(range); }]){const f=fixture(),original=await captureFocusedSummaryInput(f.c,'Failures / Live');try{f.c.cdp.afterKey=()=>alter(f);await assert.rejects(continueFocusedSummaryInput(f.c,original,'values.sum() + 7','values.length'),/Original Summary editor/);assert.deepEqual(inputCalls(f).map(e=>e.method),['Input.dispatchKeyEvent','Input.dispatchKeyEvent']);}finally{await disposeFocusedSummaryInput(f.c,original);f.close();}}
});
test('observer disposal removes every exact-editor listener and permanently retires its guard',()=>{
  const f=fixture(),added=[],removed=[],add=f.editor.addEventListener.bind(f.editor),remove=f.editor.removeEventListener.bind(f.editor);
  f.editor.addEventListener=(type,listener,options)=>{added.push([type,listener]);add(type,listener,options);};f.editor.removeEventListener=(type,listener,options)=>{removed.push([type,listener]);remove(type,listener,options);};
  try{const observer=observeSummaryInput(f.document,{owner:summaryOwner,editor:summaryEditor,base:summaryBase},'Failures / Live',focusedSummaryFrame);assert.ok(observer.frame('values.length'));observer.dispose();observer.dispose();assert.deepEqual(removed,added);assert.equal(observer.frame('values.length'),false);}finally{f.close();}
});
test('capture and terminal input failures dispose listeners before releasing their remote object group',async()=>{
  for(const failingMethod of ['DOM.describeNode','Input.insertText']){
    const f=fixture(),added=[],removed=[],add=f.editor.addEventListener.bind(f.editor),remove=f.editor.removeEventListener.bind(f.editor),call=f.c.cdp.call.bind(f.c.cdp);
    f.editor.addEventListener=(type,listener,options)=>{added.push([type,listener]);add(type,listener,options);};f.editor.removeEventListener=(type,listener,options)=>{removed.push([type,listener]);remove(type,listener,options);};
    f.c.cdp.call=async(method,params)=>{if(method===failingMethod)throw Error('pure-peer terminal failure');return call(method,params);};
    try{if(failingMethod==='DOM.describeNode')await assert.rejects(captureFocusedSummaryInput(f.c,'Failures / Live'),/pure-peer terminal failure/);else{const original=await captureFocusedSummaryInput(f.c,'Failures / Live');try{await assert.rejects(continueFocusedSummaryInput(f.c,original,'values.sum() + 7','values.length'),/pure-peer terminal failure/);}finally{await disposeFocusedSummaryInput(f.c,original);}}assert.deepEqual(removed,added);assert.equal(added.length,5);assert.equal(f.objects.size,0);assert.equal(f.events.at(-1).method,'Runtime.releaseObjectGroup');}finally{f.close();}
  }
});
