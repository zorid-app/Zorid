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
 const f=setup();t.after(()=>f.dom.window.close());const old=f.bind(f.old);assert.ok(old);f.old.focus();f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.old.value='に';const recovery=old.prepareAdmissionRecovery();let settled=false;const done=recovery.settle().then(()=>{settled=true;});await tick();assert.equal(settled,false);f.old.value='日本';f.old.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));await done;const fresh=f.bind(f.fresh);assert.equal(fresh.restoreAdmissionDrafts(recovery.rawDrafts).restored,true);assert.equal(f.fresh.value,'日本');assert.deepEqual(f.saves,[]);
});
