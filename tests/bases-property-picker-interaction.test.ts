import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import {baseExpressionValue} from '../src/bases/expression.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {BasePropertyWidgetEdit,BasePropertyWidgetOptions,BasePropertyEditorCompletionIntent} from '../src/bases/property-widgets.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(definition:BasePropertyDefinition,value:unknown=null,rest:Partial<BasePropertyWidgetOptions>={}){
 const dom=new JSDOM('<main><div tabindex="0"></div><button>Outside</button></main>',{pretendToBeVisual:true}),doc=dom.window.document,cell=doc.querySelector<HTMLElement>('div')!,outside=doc.querySelector<HTMLButtonElement>('button')!,edits:BasePropertyWidgetEdit[]=[];
 const row={path:'One.md',values:{'note.field':baseExpressionValue(value)}};
 const dispose=mountBasePropertyWidget(cell,{row,property:'note.field',value:baseExpressionValue(value),version:1},{getDefinition:()=>definition,commit:edit=>{edits.push(edit);return{version:2,row:edit.row,value:edit.value};},...rest});
 const open=()=>{cell.click();return doc.querySelector<HTMLInputElement>('input')!;};
 const options=()=>[...doc.querySelectorAll<HTMLButtonElement>('[role="option"]')];
 const key=(input:HTMLInputElement,key:string)=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 return{dom,doc,cell,outside,edits,open,options,key,close(){dispose();dom.window.close();}};
}
test('pointer hover changes the active option without replacing the focused picker or list',()=>{
 const f=fixture({type:'select',options:[{value:'First'},{value:'Second'}]});try{
  const input=f.open(),list=f.doc.querySelector('[role="listbox"]')!,rows=f.options();rows[1].dispatchEvent(new f.dom.window.MouseEvent('mouseenter'));
  assert.equal(f.doc.activeElement,input);assert.equal(f.doc.querySelector('[role="listbox"]'),list);assert.equal(rows[0].getAttribute('aria-selected'),'false');assert.equal(rows[1].getAttribute('aria-selected'),'true');assert.equal(input.getAttribute('aria-activedescendant'),rows[1].id);
 }finally{f.close();}
});
test('typing and arrow navigation keep a stable accessible list identity and scroll the active option',()=>{
 const f=fixture({type:'select',options:[{value:'Alpha'},{value:'Beta'},{value:'Gamma'}]});try{
  const input=f.open(),list=f.doc.querySelector('[role="listbox"]')!,id=list.id;let scrolled=0;
  f.options()[1].scrollIntoView=()=>{scrolled++;};f.key(input,'ArrowDown');f.key(input,'ArrowDown');assert.equal(f.doc.querySelector('[role="listbox"]'),list);assert.equal(scrolled,1);assert.equal(input.getAttribute('aria-activedescendant'),f.options()[1].id);
  input.value='Beta';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.equal(f.doc.querySelector('[role="listbox"]')?.id,id);assert.equal(input.getAttribute('aria-activedescendant'),f.options()[0].id);
 }finally{f.close();}
});
test('Status opens with its current chip, blank search and no active option; blank Enter preserves the editor',async()=>{
 const f=fixture({type:'status',options:[{value:'Todo',category:'todo'},{value:'Done',category:'done'}]},'Done');try{
  const input=f.open();assert.equal(input.value,'');assert.equal(input.getAttribute('aria-activedescendant'),null);assert.equal(f.options().length,2);assert.equal(f.doc.querySelector('.multi-select-container .multi-select-pill-content')?.textContent,'Done');f.key(input,'Enter');await tick();assert.equal(f.edits.length,0);assert.equal(input.isConnected,true);
  f.key(input,'ArrowDown');assert.equal(input.getAttribute('aria-activedescendant'),f.options()[0].id);f.key(input,'Enter');await tick();assert.deepEqual(f.edits[0].value,baseExpressionValue('Todo'));assert.equal(f.doc.activeElement,f.cell);
 }finally{f.close();}
});
test('leaving the untouched blank Select search preserves the selected value without a clear write',async()=>{
 const f=fixture({type:'select',options:[{value:'Saved'}]},'Saved');try{f.open();f.outside.focus();await tick();assert.equal(f.edits.length,0);assert.equal(f.cell.textContent,'Saved');assert.equal(f.doc.activeElement,f.outside);}finally{f.close();}
});
for(const type of ['select','status'] as const)for(const query of ['Other','unknown query'])for(const reason of ['pointer','tab'] as const){
 test(`${type} ${reason} discards unchosen ${query==='Other'?'matching':'unmatched'} query without a mutation and completes unchanged`,async()=>{
  const calls:{intent:BasePropertyEditorCompletionIntent;version:unknown}[]=[],f=fixture({type,options:[{value:'Saved'},{value:'Other'}]},'Saved',{onEditorComplete(_element,presentation,intent){calls.push({intent,version:presentation.version});}});
  try{const input=f.open();input.value=query;input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));if(reason==='tab')f.key(input,'Tab');else{f.outside.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));f.outside.focus();}await tick();assert.equal(f.edits.length,0);assert.equal(f.cell.textContent,'Saved');assert.equal(f.doc.querySelector('.bases-property-popover'),null);assert.equal(calls.length,1);assert.equal(calls[0].intent.reason,reason);assert.equal(calls[0].version,1);}finally{f.close();}
 });
}
test('Enter on an unmatched configured option query never saves or implicitly dismisses it',async()=>{
 const f=fixture({type:'select',options:[{value:'Saved'}]},'Saved');try{const input=f.open();input.value='No match';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.key(input,'Enter');await tick();assert.equal(f.edits.length,0);assert.equal(input.value,'No match');assert.equal(input.isConnected,true);assert.equal(input.getAttribute('aria-invalid'),null);}finally{f.close();}
});
test('multiselect leaving an unmatched query preserves its accepted chips without a write',async()=>{
 const f=fixture({type:'multiselect',options:[{value:'Saved'},{value:'Other'}]},['Saved']);try{const input=f.open();input.value='No match';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.outside.focus();await tick();assert.equal(f.edits.length,0);assert.equal(f.cell.textContent,'Saved');assert.equal(f.doc.querySelector('.bases-property-popover'),null);}finally{f.close();}
});
test('creation requires activating the explicit create action before Enter and remains owned by its callback',async()=>{
 let definition:BasePropertyDefinition={type:'select',options:[]},created=0;
 const f=fixture(definition,null,{getDefinition:()=>definition,createOption(_property,value){created++;definition={...definition,options:[{value}]};}});try{
  const input=f.open();input.value='New option';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.key(input,'Enter');await tick();assert.equal(created,0);assert.equal(f.edits.length,0);
  f.key(input,'ArrowDown');const add=f.doc.querySelector('.bases-property-create-option')!;assert.equal(input.getAttribute('aria-activedescendant'),add.id);assert.equal(add.getAttribute('aria-selected'),'true');f.key(input,'Enter');await tick();assert.equal(created,1);assert.deepEqual(f.edits[0].value,baseExpressionValue('New option'));
 }finally{f.close();}
});
test('status choices display their configured labels, colors and grouped category names',()=>{
 const f=fixture({type:'status',options:[{value:'done',label:'Done',color:'green',category:'done'},{value:'todo',label:'Not started',color:'gray',category:'todo'},{value:'doing',label:'In progress',color:'blue',category:'in-progress'}]});try{
  f.open();assert.deepEqual([...f.doc.querySelectorAll('.bases-property-option-group')].map(e=>e.textContent),['To-do','In progress','Complete']);assert.deepEqual(f.options().map(e=>e.textContent),['Not started','In progress','Done']);assert.equal(f.options()[2].querySelector('.multi-select-pill')?.getAttribute('data-color'),'green');assert.equal(f.options()[2].querySelector('.multi-select-pill')?.getAttribute('data-category'),'done');
 }finally{f.close();}
});
test('successful single-choice pointer selection returns focus to its owner cell',async()=>{
 const f=fixture({type:'select',options:[{value:'One'}]});try{f.open();f.options()[0].click();await tick();assert.equal(f.edits.length,1);assert.equal(f.doc.querySelector('.bases-property-popover'),null);assert.equal(f.doc.activeElement,f.cell);}finally{f.close();}
});
test('multiselect selection stays open with focus on its search and accepted chip',async()=>{
 const f=fixture({type:'multiselect',options:[{value:'One'},{value:'Two'}]},[]);try{const input=f.open();f.options()[0].click();await tick();assert.equal(f.edits.length,1);assert.equal(f.doc.activeElement,input);assert.ok(f.doc.querySelector('.bases-property-popover'));assert.equal(f.doc.querySelector('.multi-select-pill-content')?.textContent,'One');assert.equal(f.options()[0].textContent,'Two');}finally{f.close();}
});
test('multiselect hover followed by Enter selects the hovered option even with blank search',async()=>{
 const f=fixture({type:'multiselect',options:[{value:'One'},{value:'Two'}]},[]);try{const input=f.open();f.options()[1].dispatchEvent(new f.dom.window.MouseEvent('mouseenter'));f.key(input,'Enter');await tick();assert.deepEqual(f.edits[0].value,baseExpressionValue(['Two']));assert.equal(f.doc.activeElement,input);assert.ok(f.doc.querySelector('.bases-property-popover'));}finally{f.close();}
});
test('choosing the already saved option closes without issuing another mutation',async()=>{
 const f=fixture({type:'select',options:[{value:'Saved'}]},'Saved');try{f.open();f.options()[0].click();await tick();assert.equal(f.edits.length,0);assert.equal(f.doc.querySelector('.bases-property-popover'),null);assert.equal(f.doc.activeElement,f.cell);}finally{f.close();}
});
for(const leave of ['outside focus','outside pointer','window blur','dispose'] as const){
 test(`a delayed single-choice save never reclaims focus after ${leave}`,async()=>{
  const dom=new JSDOM('<div tabindex="0"></div><button>Outside</button>',{pretendToBeVisual:true}),doc=dom.window.document,cell=doc.querySelector<HTMLElement>('div')!,outside=doc.querySelector<HTMLButtonElement>('button')!,row={path:'One.md',values:{}};let resolve!:(value:undefined)=>void;
  const gate=new Promise<undefined>(yes=>{resolve=yes;}),dispose=mountBasePropertyWidget(cell,{row,property:'note.field',value:baseExpressionValue(null),version:1},{getDefinition:()=>({type:'select',options:[{value:'Saved'}]}),commit:()=>gate});
  try{cell.click();doc.querySelector<HTMLButtonElement>('[role="option"]')!.click();assert.equal(cell.dataset.baseEditing,'pending');if(leave==='outside focus')outside.focus();else if(leave==='outside pointer')outside.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true}));else if(leave==='window blur')dom.window.dispatchEvent(new dom.window.Event('blur'));else dispose();resolve(undefined);await tick();assert.notEqual(doc.activeElement,cell);}finally{dispose();resolve(undefined);dom.window.close();}
 });
}
test('a rejected single-choice save keeps its exact search and owned focus for retry',async()=>{
 const dom=new JSDOM('<div tabindex="0"></div>',{pretendToBeVisual:true}),doc=dom.window.document,cell=doc.querySelector<HTMLElement>('div')!,row={path:'One.md',values:{}};
 const dispose=mountBasePropertyWidget(cell,{row,property:'note.field',value:baseExpressionValue(null),version:1},{getDefinition:()=>({type:'select',options:[{value:'Saved'}]}),commit:async()=>{throw new Error('Save failed');}});
 try{cell.click();const input=doc.querySelector<HTMLInputElement>('input')!;input.value='Sav';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));doc.querySelector<HTMLButtonElement>('[role="option"]')!.click();await tick();assert.equal(input.value,'Sav');assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(cell.dataset.baseEditing,'draft');assert.equal(doc.activeElement,input);}finally{dispose();dom.window.close();}
});
