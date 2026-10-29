import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import * as widgets from '../src/bases/property-widgets.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {BasePropertyWidgetEdit,BasePropertyWidgetOptions} from '../src/bases/property-widgets.ts';
import {baseExpressionValue} from '../src/bases/expression.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
function fixture(raw:unknown=1,definition:BasePropertyDefinition={type:'number'},entryId='note-1',version=1,options:Partial<BasePropertyWidgetOptions>={}){
  const dom=new JSDOM('<main><div tabindex="0"></div><button>Outside</button></main>',{pretendToBeVisual:true});
  const document=dom.window.document,element=document.querySelector('div')!,outside=document.querySelector('button')!,edits:BasePropertyWidgetEdit[]=[];
  const presentation={row:{path:'Note.md',entryId,revision:`revision-${version}`,values:{'note.value':baseExpressionValue(raw)}},property:'note.value',value:baseExpressionValue(raw),version};
  const dispose=widgets.mountBasePropertyWidget(element,presentation,{getDefinition:()=>definition,commit:edit=>{edits.push(edit);return{row:edit.row,version:version+1,value:edit.value};},...options});
  const open=()=>{element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));const input=document.querySelector<HTMLInputElement>('input.metadata-input')!;assert.ok(input);return input;};
  const key=(input:HTMLInputElement,key:string)=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  return{dom,document,element,outside,edits,dispose,open,key,close(){dispose();dom.window.close();}};
}

test('raw number capture freezes blur and stale submit; fresh presentation restores exact text and caret without a write',async()=>{
  const old=fixture(),fresh=fixture(1,{type:'number'},'note-1',17);
  try{
    const input=old.open();input.value='9.';input.setSelectionRange(1,2,'backward');
    const draft=widgets.captureBasePropertyRawDraft(old.element);assert.ok(draft);await draft.ready;assert.equal(draft.state.multiple,false);
    old.outside.focus();old.key(input,'Enter');await tick();assert.deepEqual(old.edits,[]);assert.equal(input.value,'9.');
    assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);
    const restored=fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!;
    assert.equal(restored.value,'9.');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,2);assert.equal(restored.selectionDirection,'backward');assert.equal(fresh.document.activeElement,restored);assert.deepEqual(fresh.edits,[]);
    old.dispose();old.key(input,'Enter');input.dispatchEvent(new old.dom.window.Event('blur'));await tick();assert.deepEqual(old.edits,[]);
    restored.value='9';fresh.key(restored,'Enter');await tick();assert.equal(fresh.edits.length,1);assert.equal(fresh.edits[0].version,17);assert.equal(fresh.edits[0].row.revision,'revision-17');assert.deepEqual(fresh.edits[0].value,{type:'number',value:9});
  }finally{old.close();fresh.close();}
});

test('a composing draft waits for natural final input and never completes its deferred blur',async()=>{
  const old=fixture('before',{type:'text'}),fresh=fixture('before',{type:'text'},'note-1',4);
  try{
    const input=old.open();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='に';
    const draft=widgets.captureBasePropertyRawDraft(old.element)!;assert.ok(draft);let ready=false;void draft.ready.then(()=>{ready=true;});
    old.outside.focus();await tick();assert.equal(ready,false);assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),false);assert.deepEqual(old.edits,[]);
    input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'日本語'}));assert.equal(ready,false);await tick();assert.equal(ready,false,'a task boundary alone does not prove the final native input arrived');
    input.value='日本語';input.setSelectionRange(3,3);input.dispatchEvent(new old.dom.window.Event('input',{bubbles:true}));
    await draft.ready;assert.equal(draft.state.input,'日本語');assert.deepEqual(old.edits,[]);assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);
    const restored=fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!;assert.equal(restored.value,'日本語');assert.equal(restored.selectionStart,3);assert.deepEqual(fresh.edits,[]);
  }finally{old.close();fresh.close();}
});

test('restoring list chip edit retains its untouched tokens and unsubmitted raw input',async()=>{
  const old=fixture(['First','Second'],{type:'list'}),fresh=fixture(['First','Second'],{type:'list'},'note-1',8);
  try{
    const input=old.open();old.element.querySelector<HTMLElement>('.multi-select-pill')!.dispatchEvent(new old.dom.window.MouseEvent('dblclick',{bubbles:true,cancelable:true}));input.value='First draft';input.setSelectionRange(2,7,'forward');
    const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;assert.equal(draft.state.multiple,true);assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);
    const restored=fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!;assert.equal(restored.value,'First draft');assert.deepEqual([...fresh.element.querySelectorAll('.multi-select-pill-content')].map(node=>node.textContent),['First','Second']);assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,7);assert.deepEqual(fresh.edits,[]);
    fresh.key(restored,'Enter');await tick();assert.deepEqual(fresh.edits[0].value,baseExpressionValue(['First draft','Second']));assert.equal(fresh.edits[0].version,8);
  }finally{old.close();fresh.close();}
});

test('changed actor, schema or saved value rejects restoration without opening a new editor',async()=>{
  const old=fixture();const mismatches=[fixture(1,{type:'number'},'replacement'),fixture(1,{type:'text'}),fixture(2)];
  try{const input=old.open();input.value='9.';const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;
    for(const fresh of mismatches){assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),false);assert.equal(fresh.element.querySelector('.metadata-input'),null);assert.deepEqual(fresh.edits,[]);}
    assert.equal(draft.state.input,'9.','the owner can retain and present the conflicting raw candidate');
  }finally{old.close();for(const fresh of mismatches)fresh.close();}
});

test('a captured option search cannot create schema or choose a value through old callbacks',async()=>{
  let creations=0;const definition:BasePropertyDefinition={type:'select',options:[{value:'Before'}]};
  const old=fixture('Before',definition,'note-1',1,{createOption:()=>{creations++;}}),fresh=fixture('Before',definition,'note-1',5);
  try{
    const input=old.open();input.value='New choice';input.dispatchEvent(new old.dom.window.Event('input',{bubbles:true}));const create=old.document.querySelector<HTMLButtonElement>('.bases-property-create-option')!;assert.ok(create);
    const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;create.click();old.key(input,'Enter');old.outside.focus();await tick();assert.equal(creations,0);assert.deepEqual(old.edits,[]);
    assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);assert.equal(fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!.value,'New choice');assert.deepEqual(fresh.edits,[]);
  }finally{old.close();fresh.close();}
});

test('pending and already submitted failed edits cannot become unsubmitted recovery capsules',async()=>{
  let reject!:(error:Error)=>void;const old=fixture(1,{type:'number'},'note-1',1,{commit:()=>new Promise<void>((_yes,no)=>{reject=no;})});
  try{
    const input=old.open();input.value='9';old.key(input,'Enter');assert.equal(widgets.canCaptureBasePropertyRawDraft(old.element),false);assert.equal(widgets.captureBasePropertyRawDraft(old.element),undefined);
    reject(Error('Host reply lost'));await tick();input.value='10';input.dispatchEvent(new old.dom.window.Event('input',{bubbles:true}));assert.equal(widgets.basePropertyEditRecovery(old.element),undefined,'the raw state no longer equals the submitted command');assert.equal(widgets.canCaptureBasePropertyRawDraft(old.element),false,'the earlier submitted command still owns its outcome');assert.equal(widgets.captureBasePropertyRawDraft(old.element),undefined);
  }finally{old.close();}
});

test('equivalent freshly decoded schema ordering does not manufacture a raw draft conflict',async()=>{
  const old=fixture('Before',{type:'select',options:[{value:'Before',label:'Prior'}]}),fresh=fixture('Before',{options:[{label:'Prior',value:'Before'}],type:'select'},'note-1',6);
  try{old.open().value='Search';const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);assert.equal(fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!.value,'Search');assert.deepEqual(fresh.edits,[]);}finally{old.close();fresh.close();}
});

test('a background control retains selection without stealing foreground focus during restore',async()=>{
  const old=fixture(),fresh=fixture();
  try{const input=old.open();input.value='9.';input.setSelectionRange(1,2);Object.defineProperty(old.document,'hasFocus',{value:()=>false});const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;fresh.outside.focus();assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);assert.equal(fresh.document.activeElement,fresh.outside);assert.equal(fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!.selectionStart,1);await tick();assert.deepEqual(fresh.edits,[]);}finally{old.close();fresh.close();}
});

test('a focused list-chip remove control keeps its own keyboard target after raw restoration',async()=>{
  const old=fixture(['First','Second'],{type:'list'}),fresh=fixture(['First','Second'],{type:'list'},'note-1',7);
  try{const input=old.open();input.value='Unsubmitted';old.element.querySelector<HTMLButtonElement>('[aria-label="Remove Second"]')!.focus();const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);assert.equal(fresh.document.activeElement,fresh.element.querySelector('[aria-label="Remove Second"]'));assert.equal(fresh.document.querySelector<HTMLInputElement>('input.metadata-input')!.value,'Unsubmitted');assert.deepEqual(fresh.edits,[]);}finally{old.close();fresh.close();}
});

test('programmatic focus transfer during reconstruction cannot submit a restored raw control',async()=>{
  const old=fixture(),fresh=fixture(1,{type:'number'},'note-1',7);
  try{old.open().value='9.';const draft=widgets.captureBasePropertyRawDraft(old.element)!;await draft.ready;assert.equal(widgets.restoreBasePropertyRawDraft(fresh.element,draft),true);const input=fresh.element.querySelector<HTMLInputElement>('input.metadata-input')!;
    fresh.outside.focus();await tick();assert.deepEqual(fresh.edits,[]);assert.equal(input.value,'9.');assert.equal(input.isConnected,true);
    input.focus();input.value='11';input.dispatchEvent(new fresh.dom.window.Event('input',{bubbles:true}));fresh.outside.focus();await tick();assert.equal(fresh.edits.length,1);assert.equal(fresh.edits[0].version,7);assert.deepEqual(fresh.edits[0].value,{type:'number',value:11});
  }finally{old.close();fresh.close();}
});

for(const update of [true,false])test(`a confirmed final input before compositionend settles without waiting for another input (update=${update})`,async()=>{
  const old=fixture('before',{type:'text'});
  try{const input=old.open();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));const draft=widgets.captureBasePropertyRawDraft(old.element)!;
    if(update)input.dispatchEvent(new old.dom.window.CompositionEvent('compositionupdate',{bubbles:true,data:'日本語'}));
    input.value='日本語';input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,isComposing:true,data:'日本語',inputType:'insertCompositionText'}));input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'日本語'}));
    await Promise.race([draft.ready,tick().then(()=>{throw Error('The already observed final input must settle readiness');})]);assert.equal(draft.state.input,'日本語');assert.deepEqual(old.edits,[]);
  }finally{old.close();}
});

test('an unchanged natural composition cancellation settles without inventing a final input',async()=>{
  const old=fixture('before',{type:'text'});
  try{const input=old.open();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));const draft=widgets.captureBasePropertyRawDraft(old.element)!;
    input.dispatchEvent(new old.dom.window.CompositionEvent('compositionupdate',{bubbles:true,data:''}));input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:''}));
    await Promise.race([draft.ready,tick().then(()=>{throw Error('An unchanged cancellation has no missing input event');})]);assert.equal(draft.state.input,'before');assert.deepEqual(old.edits,[]);
  }finally{old.close();}
});

test('raw custody retains the original mounted actor after its write authority becomes stale',async()=>{
  let current=true;const old=fixture(1,{type:'number'},'actor-A',1,{isCurrent:()=>current}),replacement=fixture(1,{type:'number'},'actor-B',2);
  try{
    const input=old.open();input.value='9.';input.setSelectionRange(1,2,'backward');current=false;
    assert.equal(widgets.canCaptureBasePropertyRawDraft(old.element),true,'stale write authority must not discard an unsubmitted local draft');
    const draft=widgets.captureBasePropertyRawDraft(old.element)!;assert.ok(draft);await draft.ready;assert.equal(draft.target.entryId,'actor-A');assert.equal(draft.state.input,'9.');
    old.key(input,'Enter');old.outside.focus();await tick();assert.deepEqual(old.edits,[]);
    assert.equal(widgets.restoreBasePropertyRawDraft(replacement.element,draft),false,'same path never transfers actor-A raw state into actor-B');assert.equal(replacement.element.querySelector('.metadata-input'),null);assert.deepEqual(replacement.edits,[]);assert.equal(draft.state.input,'9.');
  }finally{old.close();replacement.close();}
});
