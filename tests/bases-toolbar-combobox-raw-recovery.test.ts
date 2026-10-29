import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createBaseCombobox} from '../src/bases/toolbar-combobox.ts';
import type {BaseComboboxOptions} from '../src/bases/toolbar-combobox.ts';

function fixture(choices:readonly (readonly [string,string])[]=[['name','Name'],['status','Status'],['stage','Stage'],['due','Due date']],extra:Partial<BaseComboboxOptions>={}){
 const dom=new JSDOM('<main><select aria-label="Sort property"></select></main><button id="outside">Ordinary note</button>',{pretendToBeVisual:true}),doc=dom.window.document,select=doc.querySelector('select')!,owner=doc.querySelector('main')!;
 for(const [value,label]of choices){const option=doc.createElement('option');option.value=value;option.textContent=label;select.append(option);}const changes:string[]=[];select.addEventListener('change',()=>changes.push(select.value));let opened=0;
 const combobox=createBaseCombobox(select,{owner,searchable:true,onOpen(){opened++;},...extra}),button=doc.querySelector<HTMLButtonElement>('[role=combobox]')!;
 const key=(target:Element,key:string,extra:KeyboardEventInit={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});target.dispatchEvent(event);return event;};
 const search=()=>doc.querySelector<HTMLInputElement>('[role=searchbox]')!;
 return{dom,doc,select,owner,changes,combobox,button,key,search,get opened(){return opened;},type(value:string){search().value=value;search().dispatchEvent(new dom.window.Event('input',{bubbles:true}));},close(){combobox.destroy();dom.window.close();}};
}

test('a raw combobox query and active stable option restore without choosing or replaying change',async()=>{
 const old=fixture(),fresh=fixture();try{
  old.button.click();old.type('sta');old.key(old.search(),'ArrowDown');old.search().setSelectionRange(0,2,'backward');assert.equal(old.combobox.canCaptureAdmissionDraft?.(),true);const draft=old.combobox.captureFreeze!()!;await draft.ready;
  old.key(old.search(),'Enter');old.doc.querySelector<HTMLElement>('.is-active')!.click();old.doc.getElementById('outside')!.focus();assert.deepEqual(old.changes,[]);assert.equal(old.button.getAttribute('aria-expanded'),'true');assert.equal(old.button.disabled,true);assert.equal(old.select.disabled,true);assert.equal(old.search().readOnly,true);
  assert.equal(fresh.combobox.restoreAdmissionDraft!(draft),true);assert.equal(fresh.search().value,'sta');assert.equal(fresh.search().selectionStart,0);assert.equal(fresh.search().selectionEnd,2);assert.equal(fresh.search().selectionDirection,'backward');assert.equal(fresh.doc.querySelector('.is-active')?.textContent,'Stage');assert.equal(fresh.doc.activeElement,fresh.search());assert.deepEqual(fresh.changes,[]);assert.equal(fresh.opened,0,'restoration bypasses the onOpen interaction callback');
  fresh.key(fresh.search(),'Enter');assert.deepEqual(fresh.changes,['stage']);assert.equal(fresh.select.value,'stage');assert.deepEqual(old.changes,[]);
 }finally{old.close();fresh.close();}
});

test('a background popup retains its raw query caret without stealing fresh ordinary-note focus',async()=>{
 const old=fixture(),fresh=fixture();try{old.button.click();old.type('sta');old.search().setSelectionRange(1,3,'backward');old.search().blur();const draft=old.combobox.captureFreeze()!;await draft.ready;const ordinary=fresh.doc.getElementById('outside')!;ordinary.focus();assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);assert.equal(fresh.search().value,'sta');assert.equal(fresh.search().selectionStart,1);assert.equal(fresh.search().selectionEnd,3);assert.equal(fresh.search().selectionDirection,'backward');assert.equal(fresh.doc.activeElement,ordinary);assert.deepEqual(fresh.changes,[]);}finally{old.close();fresh.close();}
});

test('a detached old control may transfer raw custody but a detached fresh owner cannot accept it',async()=>{
 const old=fixture(),fresh=fixture();try{old.button.click();old.type('sta');old.owner.remove();assert.equal(old.combobox.canCaptureAdmissionDraft(),true);const draft=old.combobox.captureFreeze()!;await draft.ready;fresh.owner.remove();assert.equal(fresh.combobox.restoreAdmissionDraft(draft),false);assert.deepEqual(old.changes,[]);assert.deepEqual(fresh.changes,[]);}finally{old.close();fresh.close();}
});

for(const endBeforeCapture of [false,true])test(`combobox ${endBeforeCapture?'end-before-capture':'active'} composition retains the final native query before readiness`,async()=>{
 const old=fixture(),fresh=fixture();try{
  old.button.click();const input=old.search();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='st';if(endBeforeCapture)input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'sta'}));const draft=old.combobox.captureFreeze()!;let ready=false;void draft.ready.then(()=>{ready=true;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ready,false,'compositionend or a timer is not final DOM input evidence');assert.equal(input.readOnly,false);assert.equal(fresh.combobox.restoreAdmissionDraft(draft),false,'unfinished custody cannot move owners');
  if(!endBeforeCapture){const event=old.key(input,'Enter',{isComposing:true});assert.equal(event.defaultPrevented,false);input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'sta'}));}input.value='sta';input.setSelectionRange(1,2,'forward');input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,data:'sta'}));await draft.ready;assert.equal(input.readOnly,true);assert.equal(draft.state.query,'sta');assert.equal(draft.state.selectionStart,1);assert.equal(draft.state.selectionEnd,2);assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);assert.equal(fresh.search().value,'sta');assert.deepEqual(old.changes,[]);assert.deepEqual(fresh.changes,[]);
 }finally{old.close();fresh.close();}
});

for(const changed of ['value','choice','permission','local-input'] as const)test(`a fresh combobox with changed ${changed} refuses an older raw capsule without choosing`,async()=>{
 const old=fixture(undefined,{isCurrent:()=>false}),fresh=fixture(undefined,{isCurrent:()=>changed!=='permission'});try{
  old.button.click();old.type('sta');old.key(old.search(),'ArrowDown');const draft=old.combobox.captureFreeze()!;await draft.ready;
  if(changed==='value')fresh.select.value='due';if(changed==='choice')fresh.select.querySelector('option[value=stage]')!.remove();if(changed==='local-input'){fresh.button.click();fresh.type('newer');}
  assert.equal(fresh.combobox.restoreAdmissionDraft(draft),false);assert.deepEqual(fresh.changes,[]);assert.equal(fresh.select.value,changed==='value'?'due':'name');if(changed==='local-input')assert.equal(fresh.search().value,'newer');else assert.equal(fresh.doc.querySelector('[role=searchbox]'),null);
 }finally{old.close();fresh.close();}
});

for(const canceled of [false,true])test(`combobox ${canceled?'unchanged cancellation':'final input before end'} completes from actual native input evidence`,async()=>{
 const old=fixture(),fresh=fixture();try{
  old.button.click();const input=old.search();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
  if(!canceled){input.dispatchEvent(new old.dom.window.CompositionEvent('compositionupdate',{bubbles:true,data:'sta'}));input.value='sta';input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,data:'sta',isComposing:true}));}
  input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:canceled?'':'sta'}));const draft=old.combobox.captureFreeze()!;let ready=false;void draft.ready.then(()=>{ready=true;});await Promise.resolve();assert.equal(ready,true);assert.equal(draft.state.query,canceled?'':'sta');assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);assert.deepEqual(old.changes,[]);assert.deepEqual(fresh.changes,[]);
 }finally{old.close();fresh.close();}
});

test('pending raw capture keeps its original option presentation when a retired source mutates before final input',async()=>{
 const old=fixture(),fresh=fixture();try{old.button.click();const input=old.search();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='st';const draft=old.combobox.captureFreeze()!;const option=old.select.querySelector<HTMLOptionElement>('option[value=status]')!;option.value='retired';option.label='Changed elsewhere';input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'sta'}));input.value='sta';input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,data:'sta'}));await draft.ready;assert.equal(draft.state.activeValue,'status');assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);assert.equal(fresh.doc.querySelector('.is-active')?.textContent,'Status');assert.deepEqual(old.changes,[]);assert.deepEqual(fresh.changes,[]);}finally{old.close();fresh.close();}
});

test('an otherwise clean open popup reports raw ownership separately from readiness',async()=>{
 const old=fixture(),fresh=fixture();try{assert.equal(old.combobox.hasRawInput?.(),false);old.button.click();assert.equal(old.combobox.hasRawInput?.(),true);const draft=old.combobox.captureFreeze()!;await draft.ready;assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);assert.equal(fresh.combobox.hasRawInput?.(),true);fresh.key(fresh.search(),'Escape');assert.equal(fresh.combobox.hasRawInput?.(),false);assert.deepEqual(old.changes,[]);assert.deepEqual(fresh.changes,[]);}finally{old.close();fresh.close();}
});

test('a transferred custody receipt is idempotent without replacing newer input or accepting another winner',async()=>{
 const old=fixture(),other=fixture(),fresh=fixture();try{old.button.click();old.type('sta');const draft=old.combobox.captureFreeze()!;other.button.click();other.type('due');const another=other.combobox.captureFreeze()!;await Promise.all([draft.ready,another.ready]);assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);fresh.type('new local search');assert.equal(fresh.combobox.restoreAdmissionDraft(draft),true);assert.equal(fresh.search().value,'new local search');assert.equal(fresh.combobox.restoreAdmissionDraft(another),false);assert.equal(fresh.search().value,'new local search');assert.deepEqual(fresh.changes,[]);}finally{old.close();other.close();fresh.close();}
});
