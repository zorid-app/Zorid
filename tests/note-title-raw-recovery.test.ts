import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {bindNoteTitleFocus} from '../src/ui/note-title-focus.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const dom=new JSDOM('<!doctype html><body><input id="old" value="Original"><input id="fresh" value="Original">',{pretendToBeVisual:true});
 const old=dom.window.document.querySelector<HTMLInputElement>('#old')!,fresh=dom.window.document.querySelector<HTMLInputElement>('#fresh')!,saves:string[]=[],errors:unknown[]=[];
 const bind=(input:HTMLInputElement)=>bindNoteTitleFocus(input,{save:async value=>{saves.push(value);},isCurrent:()=>true,focusBody:()=>{},onError:error=>errors.push(error)});
 const key=(input:HTMLInputElement)=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 return{dom,old,fresh,saves,errors,bind,key};
}
test('raw note title survives a fresh binding without blur submission and later Enter uses only the new owner',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);assert.ok(old,'title binding must expose its raw draft owner');
 f.old.focus();f.old.value='Unsaved title';f.old.setSelectionRange(2,7,'backward');const recovery=old.prepareAdmissionRecovery();f.old.dispatchEvent(new f.dom.window.FocusEvent('blur'));f.key(f.old);await recovery.settle();await tick();assert.deepEqual(f.saves,[]);
 const fresh=f.bind(f.fresh),restored=fresh.restoreAdmissionDrafts(recovery.rawDrafts);assert.equal(restored.restored,true);assert.equal(f.fresh.value,'Unsaved title');assert.equal(f.fresh.selectionStart,2);assert.equal(f.fresh.selectionEnd,7);assert.equal(f.fresh.selectionDirection,'backward');assert.equal(f.dom.window.document.activeElement,f.fresh);assert.deepEqual(f.saves,[]);
 f.key(f.old);await tick();assert.deepEqual(f.saves,[],'late old key cannot submit');f.key(f.fresh);await tick();assert.deepEqual(f.saves,['Unsaved title']);assert.deepEqual(f.errors,[]);
});
test('a changed fresh title leaves the raw candidate available without applying it',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);assert.ok(old);f.old.value='My raw title';const recovery=old.prepareAdmissionRecovery();await recovery.settle();f.fresh.value='External title';const fresh=f.bind(f.fresh),result=fresh.restoreAdmissionDrafts(recovery.rawDrafts);assert.equal(result.restored,false);assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft.value,'My raw title');assert.equal(f.fresh.value,'External title');assert.deepEqual(f.saves,[]);
});
test('title recovery waits for natural composition completion and never synthesizes submission',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);assert.ok(old);f.old.focus();f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.old.value='に';const recovery=old.prepareAdmissionRecovery();let settled=false;const done=recovery.settle().then(()=>{settled=true;});await tick();assert.equal(settled,false);f.old.value='日本';f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{data:'日本',bubbles:true}));f.old.dispatchEvent(new f.dom.window.InputEvent('input',{data:'日本',isComposing:false,bubbles:true}));await done;const fresh=f.bind(f.fresh);assert.equal(fresh.restoreAdmissionDrafts(recovery.rawDrafts).restored,true);assert.equal(f.fresh.value,'日本');assert.deepEqual(f.saves,[]);
});

test('restoring another raw owner cannot blur-submit a restored title',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);f.old.focus();f.old.value='Still unsubmitted';const recovery=old.prepareAdmissionRecovery();await recovery.settle();const fresh=f.bind(f.fresh);fresh.restoreAdmissionDrafts(recovery.rawDrafts);const other=f.dom.window.document.createElement('input');f.dom.window.document.body.append(other);other.focus();await tick();assert.deepEqual(f.saves,[]);f.key(f.fresh);await tick();assert.deepEqual(f.saves,['Still unsubmitted']);
});

test('title waits beyond compositionend for a delayed final native input',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);f.old.focus();f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.old.value='に';const recovery=old.prepareAdmissionRecovery();let settled=false;const done=recovery.settle().then(()=>{settled=true;});f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{data:'日本',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(settled,false);f.old.value='日本';f.old.dispatchEvent(new f.dom.window.InputEvent('input',{data:'日本',isComposing:false,bubbles:true}));await done;assert.equal(recovery.rawDrafts.value,'日本');assert.deepEqual(f.saves,[]);
});
test('title accepts final input before compositionend and an unchanged canceled composition',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionupdate',{data:'日本',bubbles:true}));f.old.value='日本';f.old.dispatchEvent(new f.dom.window.InputEvent('input',{data:'日本',isComposing:true,bubbles:true}));const recovery=old.prepareAdmissionRecovery();f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{data:'日本',bubbles:true}));await recovery.settle();assert.equal(recovery.rawDrafts.value,'日本');const fresh=f.bind(f.fresh);f.fresh.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));const canceled=fresh.prepareAdmissionRecovery();f.fresh.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{data:'',bubbles:true}));await canceled.settle();assert.equal(canceled.rawDrafts.value,'Original');assert.deepEqual(f.saves,[]);
});

test('a noncomposing captured title is native read-only while the replacement is being prepared',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);f.old.value='Retained';const recovery=old.prepareAdmissionRecovery();assert.equal(f.old.readOnly,true,'no new native edit or composition may begin after capture');await recovery.settle();const fresh=f.bind(f.fresh);fresh.restoreAdmissionDrafts(recovery.rawDrafts);assert.equal(f.fresh.readOnly,false);
});
test('an active title composition stays writable until confirmed final input then freezes',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.old.value='に';const recovery=old.prepareAdmissionRecovery();assert.equal(f.old.readOnly,false);f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{data:'日本',bubbles:true}));f.old.value='日本';f.old.dispatchEvent(new f.dom.window.InputEvent('input',{data:'日本',isComposing:false,bubbles:true}));await recovery.settle();assert.equal(f.old.readOnly,true);assert.equal(recovery.rawDrafts.value,'日本');
});

test('title natural cancellation after intermediate composition input settles the unchanged raw value',async t=>{
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionupdate',{data:'に',bubbles:true}));f.old.value='に';f.old.dispatchEvent(new f.dom.window.InputEvent('input',{data:'に',isComposing:true,bubbles:true}));const recovery=old.prepareAdmissionRecovery();f.old.value='Original';f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{data:'',bubbles:true}));await recovery.settle();assert.equal(recovery.rawDrafts.value,'Original');assert.equal(f.old.readOnly,true);assert.deepEqual(f.saves,[]);
});
