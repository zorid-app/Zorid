import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyEditorCompletionIntent,BasePropertyWidgetAcknowledgement,BasePropertyWidgetEdit} from '../src/bases/property-widgets.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {BasePropertyPresentation} from '../src/bases/presentation-common.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred(){let resolve!:(ack?:BasePropertyWidgetAcknowledgement)=>void,reject!:(error:Error)=>void;const promise=new Promise<BasePropertyWidgetAcknowledgement|void>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(definition:BasePropertyDefinition={type:'text'},value:any={type:'string',value:'Original'}){
 const dom=new JSDOM('<main><div id="cell" tabindex="0"></div><button id="outside">Outside</button></main>',{pretendToBeVisual:true}),doc=dom.window.document,element=doc.querySelector<HTMLElement>('#cell')!,outside=doc.querySelector<HTMLButtonElement>('#outside')!;
 const gate=deferred(),edits:BasePropertyWidgetEdit[]=[],calls:{element:HTMLElement;presentation:BasePropertyPresentation;intent:BasePropertyEditorCompletionIntent;editing:string|undefined}[]=[],errors:unknown[]=[];let live=true;
 const row={path:'One.md',entryId:'one',revision:'r1',values:{'note.field':value}};
 const dispose=mountBasePropertyWidget(element,{row,property:'note.field',value,version:1},{getDefinition:()=>definition,isCurrent:()=>live,commit(edit){edits.push(edit);return gate.promise;},onEditorComplete(element,presentation,intent){calls.push({element,presentation,intent,editing:element.dataset.baseEditing});},onError:error=>errors.push(error)});
 const key=(target:Element,key:string,shiftKey=false)=>{const event=new dom.window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true});target.dispatchEvent(event);return event;};
 const open=()=>{element.click();return doc.querySelector<HTMLInputElement>('input')!;};
 const accept=async()=>{gate.resolve({version:2,row:{...row,revision:'r2'},value:edits.at(-1)?.value});await tick();};
 const pointer=()=>{const event=new dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0});outside.dispatchEvent(event);};
 return{dom,doc,element,outside,gate,edits,calls,errors,row,key,open,accept,pointer,retire(){live=false;},dispose,close(){dispose();gate.resolve();dom.window.close();}};
}
for(const [key,shiftKey,expected] of [['Enter',false,{reason:'enter',key:'Enter',shiftKey:false}],['Enter',true,{reason:'enter',key:'Enter',shiftKey:true}],['Tab',false,{reason:'tab',key:'Tab',direction:1}],['Tab',true,{reason:'tab',key:'Tab',direction:-1}]] as const){
 test(`accepted ${shiftKey?'Shift+':''}${key} emits one completion after pending state clears`,async()=>{
  const f=fixture();try{const input=f.open();input.value='Changed';const event=f.key(input,key,shiftKey);assert.equal(event.defaultPrevented,true);assert.equal(f.calls.length,0);assert.equal(f.element.dataset.baseEditing,'pending');await f.accept();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].intent,expected);assert.equal(f.calls[0].element,f.element);assert.equal(f.calls[0].editing,undefined);assert.equal(f.calls[0].presentation.version,2);assert.equal(f.calls[0].presentation.row.revision,'r2');assert.equal(input.isConnected,false);assert.equal(f.edits.length,1);}finally{f.close();}
 });
}
test('unchanged Tab completes without a write; Escape cancellation does not complete',()=>{
 const f=fixture();try{const input=f.open();f.key(input,'Tab',true);assert.equal(f.edits.length,0);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].intent,{reason:'tab',key:'Tab',direction:-1});assert.equal(f.calls[0].presentation.version,1);f.key(f.open(),'Escape');assert.equal(f.calls.length,1);}finally{f.close();}
});
test('outside pointer completion retains its actual target without reclaiming focus',async()=>{
 const f=fixture();try{const input=f.open();input.value='Changed';f.pointer();f.outside.focus();assert.equal(f.calls.length,0);await f.accept();assert.equal(f.calls.length,1);const intent=f.calls[0].intent;assert.equal(intent.reason,'pointer');if(intent.reason==='pointer')assert.equal(intent.target,f.outside);assert.equal(f.doc.activeElement,f.outside);}finally{f.close();}
});
test('validation errors and rejected writes keep their draft without completion',async()=>{
 const invalid=fixture({type:'number'},{type:'number',value:3});try{const input=invalid.open();input.value='not-a-number';invalid.key(input,'Enter');await tick();assert.equal(invalid.edits.length,0);assert.equal(invalid.calls.length,0);assert.equal(input.isConnected,true);}finally{invalid.close();}
 const failed=fixture();try{const input=failed.open();input.value='Unaccepted';failed.key(input,'Tab');failed.gate.reject(new Error('Not saved'));await tick();assert.equal(failed.calls.length,0);assert.equal(input.isConnected,true);assert.equal(input.value,'Unaccepted');assert.equal(failed.element.dataset.baseEditing,'draft');}finally{failed.close();}
});
test('a later outside pointer cannot silently replace a pending Enter intent',async()=>{
 const f=fixture();try{const input=f.open();input.value='Changed';f.key(input,'Enter');f.pointer();await f.accept();assert.equal(f.calls.length,1);assert.equal(f.calls[0].intent.reason,'enter');}finally{f.close();}
});
test('retired, detached and disposed editors cannot emit a late successful continuation',async()=>{
 for(const state of ['retired','detached','disposed']){const f=fixture();try{const input=f.open();input.value='Changed';f.key(input,'Enter');if(state==='retired')f.retire();else if(state==='detached')f.element.remove();else f.dispose();await f.accept();assert.equal(f.calls.length,0,state);}finally{f.close();}}
});
test('picker Enter completing an offered choice emits its key intent after acknowledgement',async()=>{
 const f=fixture({type:'select',options:[{value:'Original'},{value:'Done'}]});try{const input=f.open();input.value='Done';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.key(input,'Enter');assert.equal(f.calls.length,0);await f.accept();assert.equal(f.calls.length,1);assert.equal(f.calls[0].intent.reason,'enter');assert.equal(f.doc.querySelector('.bases-property-popover'),null);}finally{f.close();}
});

test('plain blur saves without completion or reclaiming another control focus',async()=>{
 const f=fixture();try{const input=f.open();input.value='Changed';f.outside.focus();await tick();assert.equal(f.edits.length,1);await f.accept();assert.equal(f.calls.length,0);assert.equal(f.doc.activeElement,f.outside);}finally{f.close();}
});
test('unchanged outside pointer completion neither writes nor forces owner focus',()=>{
 const f=fixture();try{f.open();f.outside.focus();f.pointer();assert.equal(f.edits.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].intent.reason,'pointer');assert.equal(f.doc.activeElement,f.outside);}finally{f.close();}
});
test('completion callback failures report independently after the value was accepted',async()=>{
 const dom=new JSDOM('<div tabindex="0"></div>',{pretendToBeVisual:true}),element=dom.window.document.querySelector<HTMLElement>('div')!,errors:unknown[]=[];
 const value={type:'string' as const,value:'Saved'},row={path:'One.md',values:{'note.field':value}};
 const dispose=mountBasePropertyWidget(element,{row,property:'note.field',value,version:1},{getDefinition:()=>({type:'text'}),commit:edit=>({version:2,row:edit.row,value:edit.value}),onEditorComplete(){throw new Error('Navigation failed');},onError:error=>errors.push(error)});
 try{element.click();const input=element.querySelector<HTMLInputElement>('input')!;input.value='Accepted';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();assert.equal(element.textContent,'Accepted');assert.equal(element.dataset.baseEditing,undefined);assert.match(String(errors[0]),/Navigation failed/);}finally{dispose();dom.window.close();}
});
