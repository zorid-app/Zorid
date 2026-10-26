import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {Workspace} from '../../src/ui/workspace.ts';
import type {EditorHandle, EditorOptions} from '../../src/ui/editor.ts';
import {durableRecoveryFixture, externalText, recoveredDraft} from '../helpers/durable-recovery-fixture.ts';
import {recoveryCopyNoticeFrame, saveRecoveryCopyFor} from './recovery-notice.mjs';

async function until(check:()=>boolean) {const end=Date.now()+2000;while(!check()){assert.ok(Date.now()<end);await new Promise(done=>setTimeout(done,5));}}
function editor(parent:HTMLElement,options:EditorOptions):EditorHandle {
  const input=document.createElement('textarea');input.value=options.value;parent.append(input);input.oninput=()=>options.onChange(input.value);
  return {getValue:()=>input.value,setValue:value=>{input.value=value;},focus:()=>input.focus(),destroy:()=>input.remove(),insert:text=>{input.value+=text;options.onChange(input.value);}};
}
async function fixture(t:TestContext) {
  const recovered=await durableRecoveryFixture();
  await recovered.adapter.write('Replace.md','Original replacement source.');
  // Load the retained conflict lazily, after the unrelated capture error, so
  // actual Workspace rendering reproduces the native first-Retry/second-Copy rows.
  recovered.adapter.durableWrites.checkpoints.list=async()=>({items:[],cursor:null,highWater:'1'});
  recovered.adapter.durableWrites.captureSavedSource=async()=>{throw new Error('Owned fixture capture refused');};
  recovered.adapter.durableWrites.releaseSavedSource=async()=>{};
  const dom=new JSDOM('<body><main id="app"></main></body>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  // JSDOM has no layout. Visibility is modeled only for locator-unit assertions;
  // real bounds, unobscured hit testing and actual input remain native gates.
  dom.window.HTMLElement.prototype.getClientRects=function(){return (this.closest('[hidden]')?[]:[new dom.window.DOMRect(0,0,100,20)]) as unknown as DOMRectList;};
  const workspace=new Workspace(document.querySelector<HTMLElement>('#app')!,editor);
  t.after(async()=>{try{
    const one=workspace.buffers.get('One.md');if(one?.hasRecoveryConflict)await one.saveRecoveryCopy();
    await workspace.destroy();
  }finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter:recovered.adapter,id:'test:recovery-notice-locator',label:'Disposable'});
  await workspace.openNote('Other.md');
  const replace=await(workspace as any).bufferFor('Replace.md');
  await assert.rejects(replace.captureConditionalSavedSource(replace.savedDurableWitness),/capture refused/);
  await(workspace as any).bufferFor('One.md');
  const region=document.querySelector<HTMLElement>('.native-document-status')!;
  assert.equal(region.hidden,false);assert.equal(region.children.length,2);
  assert.match(region.children[0].textContent??'',/Could not save “Replace”/);
  assert.match(region.children[1].textContent??'',/Retained draft for “One”/);
  return {dom,workspace,recovered,region};
}

test('two real workspace notices select the exact retained note without scoping to an earlier Retry-only row',async t=>{
  const f=await fixture(t),doc=f.dom.window.document;
  const first=doc.querySelector('.native-document-notice')!;
  assert.equal([...first.querySelectorAll('button')].filter(button=>button.textContent==='Save recovery copy').length,0,'legacy singular scope cannot locate the visible second-row action');
  const calls:{label:string;scope:string;notice:string|null}[]=[];
  const c={evidence:{actions:[] as unknown[]},ui:{
    async wait(expression:string){const frame=runInNewContext(`(()=>{${expression}})()`,{document:doc});assert.ok(frame);return frame;},
    async button(label:string,scope:string){
      const root=doc.querySelector(scope)!;
      const buttons=[...root.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.getClientRects().length&&!button.closest('[hidden]')&&button.textContent?.trim()===label);
      assert.equal(buttons.length,1);assert.equal(buttons[0].disabled,false);
      calls.push({label,scope,notice:buttons[0].closest('.native-document-notice')!.querySelector('p')!.textContent});buttons[0].click();
    },
  }};
  await saveRecoveryCopyFor(c,'One.md');
  await until(()=>f.recovered.copies.length===1&&!f.region.textContent?.includes('Retained draft for “One”'));
  assert.equal(calls.length,1);assert.equal(calls[0].notice,'Retained draft for “One” needs attention.');
  assert.equal(await f.recovered.adapter.read(f.recovered.copies[0]),recoveredDraft);
  assert.equal(await f.recovered.adapter.read('One.md'),externalText);assert.equal(await f.recovered.adapter.read('Replace.md'),'Original replacement source.');
  assert.equal(f.workspace.activePane.viewPath,'Other.md');assert.equal(f.recovered.plans,0);
  assert.match(f.region.textContent??'',/Could not save “Replace”/,'targeted copy does not retry or clear the unrelated failure');
  assert.equal(c.evidence.actions.length,1);
});

test('exact-note preflight refuses wrong, ambiguous, hidden or disabled recovery actions',async t=>{
  const f=await fixture(t),doc=f.dom.window.document;
  assert.equal(recoveryCopyNoticeFrame(doc,'Other.md'),false);
  assert.equal(recoveryCopyNoticeFrame(doc,'../One.md'),false);
  assert.equal(recoveryCopyNoticeFrame(doc,'/One.md'),false);
  const ready=recoveryCopyNoticeFrame(doc,'One.md');assert.equal(ready.notice,'Retained draft for “One” needs attention.');assert.equal(ready.visibleNotices,2);
  const copy=[...f.region.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Save recovery copy')!;
  copy.disabled=true;assert.equal(recoveryCopyNoticeFrame(doc,'One.md'),false);copy.disabled=false;
  f.region.hidden=true;assert.equal(recoveryCopyNoticeFrame(doc,'One.md'),false);f.region.hidden=false;
  copy.setAttribute('aria-disabled','true');assert.equal(recoveryCopyNoticeFrame(doc,'One.md'),false);copy.removeAttribute('aria-disabled');
  copy.setAttribute('inert','');assert.equal(recoveryCopyNoticeFrame(doc,'One.md'),false);copy.removeAttribute('inert');
  const extra=copy.cloneNode(true);f.region.children[0].append(extra);assert.equal(recoveryCopyNoticeFrame(doc,'One.md'),false);extra.remove();
  const duplicate=f.region.children[1].cloneNode(true);f.region.append(duplicate);assert.equal(recoveryCopyNoticeFrame(doc,'One.md'),false);duplicate.remove();
  assert.ok(recoveryCopyNoticeFrame(doc,'One.md'));
  assert.equal(f.recovered.copies.length,0);assert.equal(f.recovered.plans,0);
});
