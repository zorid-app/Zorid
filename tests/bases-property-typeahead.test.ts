import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {baseExpressionValue} from '../src/bases/expression.ts';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyWidgetEdit,BasePropertyWidgetOptions} from '../src/bases/property-widgets.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(value:unknown,definition:BasePropertyDefinition,rest:Partial<BasePropertyWidgetOptions>={}){
 const dom=new JSDOM('<main><div tabindex="0"></div><button>Outside</button></main>',{pretendToBeVisual:true}),doc=dom.window.document,cell=doc.querySelector<HTMLElement>('div')!,edits:BasePropertyWidgetEdit[]=[],errors:unknown[]=[];
 const row={path:'One.md',values:{'note.field':baseExpressionValue(value)}};
 const dispose=mountBasePropertyWidget(cell,{row,property:'note.field',value:baseExpressionValue(value),version:1},{getDefinition:()=>definition,commit:edit=>{edits.push(edit);return{version:2,row:edit.row,value:edit.value};},onError:error=>errors.push(error),...rest});
 const key=(key:string,extra:KeyboardEventInit={},target:Element=cell,prevent=false)=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});if(prevent)event.preventDefault();target.dispatchEvent(event);return event;};
 cell.focus();return{dom,doc,cell,edits,errors,key,input:()=>doc.querySelector<HTMLInputElement>('.metadata-input-text')!,close(){dispose();dom.window.close();}};
}
for(const [type,value,key]of[['text','Original','Z'],['number',42,'8']]as const)test(`typing a printable key replaces the selected ${type} draft without saving before commit`,async()=>{
 const f=fixture(value,{type});try{assert.equal(f.key(key).defaultPrevented,true);const input=f.input();assert.ok(input);assert.equal(f.doc.activeElement,input);assert.equal(input.value,key);assert.equal(input.selectionStart,key.length);assert.equal(input.selectionEnd,key.length);assert.equal(f.edits.length,0);f.key('Enter',{},input);await tick();assert.deepEqual(f.edits[0].value,baseExpressionValue(type==='number'?8:'Z'));}finally{f.close();}
});
test('typing Space or a Unicode character begins a text draft; Escape preserves the saved value',()=>{
 for(const key of [' ','é','😀']){const f=fixture('Original',{type:'text'});try{f.key(key);assert.equal(f.input().value,key);f.key('Escape',{},f.input());assert.equal(f.cell.textContent,'Original');assert.equal(f.edits.length,0);}finally{f.close();}}
});
for(const type of ['select','status']as const)test(`typing in a selected ${type} seeds query only and preserves the saved chip until an explicit choice`,async()=>{
 const f=fixture('Saved',{type,options:[{value:'Saved'},{value:'Rust'}]});try{f.key('R');const input=f.input();assert.equal(input.value,'R');assert.equal(f.doc.querySelector('.multi-select-container .multi-select-pill-content')?.textContent,'Saved');assert.equal(f.doc.querySelector('[role="option"]')?.textContent,'Rust');assert.equal(f.edits.length,0);f.key('Escape',{},input);assert.equal(f.cell.textContent,'Saved');assert.equal(f.edits.length,0);}finally{f.close();}
});
for(const type of ['date','datetime']as const)test(`typing a partial ${type} uses exact raw text and cannot silently clear or save an invalid value`,async()=>{
 const saved=type==='date'?'2026-10-27':'2026-10-27T01:02:03.120',f=fixture(saved,{type});try{f.key('2');const input=f.input();assert.equal(input.type,'text');assert.equal(input.value,'2');assert.equal(f.edits.length,0);f.key('Enter',{},input);await tick();assert.equal(f.edits.length,0);assert.equal(input.value,'2');assert.equal(input.getAttribute('aria-invalid'),'true');f.key('Escape',{},input);assert.equal(f.cell.dataset.baseEditing,undefined);}finally{f.close();}
});
for(const type of ['list','tags','multiselect']as const)test(`typeahead keeps existing ${type} members and their raw types`,async()=>{
 const saved=type==='list'?[42,'Preserved']:['Preserved'],f=fixture(saved,{type,...(type==='multiselect'?{options:[{value:'Preserved'},{value:'Rust'}]}:{})});try{f.key('R');assert.equal(f.input().value,'R');assert.equal(f.edits.length,0);assert.match(f.doc.querySelector('.multi-select-container')?.textContent??'',/Preserved/);if(type==='list')assert.match(f.doc.querySelector('.multi-select-container')?.textContent??'',/42/);f.key('Escape',{},f.input());assert.equal(f.edits.length,0);}finally{f.close();}
});
test('multiple relation typeahead filters targets without replacing saved aliases',()=>{
 const f=fixture(['[[/Old.md|Saved alias]]'],{type:'relation',relation:{multiple:true}},{getRelationTargets:()=>[{path:'Rust.md',label:'Rust'}]});try{f.key('R');assert.equal(f.input().value,'R');assert.match(f.doc.querySelector('.multi-select-container')?.textContent??'',/Saved alias/);assert.equal(f.doc.querySelector('[role="option"]')?.textContent,'Rust');assert.equal(f.edits.length,0);}finally{f.close();}
});
for(const value of [false,true,null])test(`Space toggles selected checkbox ${value} through its existing acknowledged mutation`,async()=>{
 const f=fixture(value,{type:'checkbox'});try{assert.equal(f.key(' ').defaultPrevented,true);await tick();assert.deepEqual(f.edits[0].value,baseExpressionValue(value!==true));assert.equal(f.edits.length,1);assert.equal(f.doc.activeElement,f.cell);assert.equal(f.cell.querySelector<HTMLInputElement>('input')!.checked,value!==true);}finally{f.close();}
});
test('checkbox ignores arbitrary printable keys, repeated Space and authoring shortcuts',async()=>{
 const f=fixture(false,{type:'checkbox'});try{for(const [key,extra]of[['x',{}],[' ',{repeat:true}],[' ',{ctrlKey:true}],[' ',{metaKey:true}],[' ',{altKey:true}]]as const)f.key(key,extra);await tick();assert.equal(f.edits.length,0);assert.equal(f.input(),null);assert.equal(f.cell.querySelector<HTMLInputElement>('input')!.checked,false);}finally{f.close();}
});
test('a failed checkbox Space toggle retains saved state and remains retryable',async()=>{
 let fail=true;const f=fixture(false,{type:'checkbox'},{commit:edit=>{if(fail)throw new Error('Save failed');return{version:2,row:edit.row,value:edit.value};}});try{f.key(' ');await tick();assert.equal(f.cell.querySelector<HTMLInputElement>('input')!.checked,false);assert.equal(f.cell.dataset.baseEditing,'draft');assert.match(f.cell.title,/Save failed/);fail=false;f.key(' ');await tick();assert.equal(f.cell.querySelector<HTMLInputElement>('input')!.checked,true);}finally{f.close();}
});
test('Space can retry its own failed checkbox draft when the host blocks new edit admission',async()=>{
 let fail=true,admit=true;const f=fixture(false,{type:'checkbox'},{canBegin:()=>admit,commit:edit=>{if(fail){admit=false;throw new Error('Save failed');}return{version:2,row:edit.row,value:edit.value};}});try{f.key(' ');await tick();assert.equal(f.cell.dataset.baseEditing,'draft');assert.equal(f.cell.querySelector<HTMLInputElement>('input')!.checked,false);fail=false;f.key(' ');await tick();assert.equal(f.cell.querySelector<HTMLInputElement>('input')!.checked,true);}finally{f.close();}
});
test('modifiers, composition, prevented selection keys and non-printing keys cannot begin typeahead',()=>{
 for(const extra of[{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true}]){const f=fixture('Saved',{type:'text'});try{f.key('x',extra);assert.equal(f.input(),null);assert.equal(f.edits.length,0);}finally{f.close();}}
 for(const key of ['Dead','Unidentified','ArrowDown','Backspace','Delete','Tab','Escape','\n']){const f=fixture('Saved',{type:'text'});try{f.key(key);assert.equal(f.input(),null);}finally{f.close();}}
 const f=fixture('Saved',{type:'text'});try{f.key('x',{},f.cell,true);assert.equal(f.input(),null);}finally{f.close();}
});
test('readonly, stale and denied widgets cannot start a typed draft',()=>{
 for(const rest of[{readOnly:()=>true},{isCurrent:()=>false},{canBegin:()=>false}]){const f=fixture('Saved',{type:'text'},rest);try{f.key('x');assert.equal(f.input(),null);assert.equal(f.edits.length,0);}finally{f.close();}}
});
test('a live readonly change revokes typed scalar editing and checkbox Space before either can mutate',()=>{
 for(const type of ['text','checkbox']as const){let readonly=false;const f=fixture(type==='text'?'Saved':false,{type},{readOnly:()=>readonly});try{readonly=true;f.key(type==='text'?'x':' ');assert.equal(f.input(),null);assert.equal(f.edits.length,0);}finally{f.close();}}
});
test('typeahead and unmatched Enter never create an option automatically',async()=>{
 let created=0;const f=fixture('Saved',{type:'select',options:[{value:'Saved'}]},{createOption:()=>{created++;}});try{f.key('x');assert.equal(f.input().value,'x');assert.ok(f.doc.querySelector('.bases-property-create-option'));assert.equal(created,0);assert.equal(f.edits.length,0);f.key('Enter',{},f.input());await tick();assert.equal(created,0);assert.equal(f.edits.length,0);}finally{f.close();}
});
test('native input keydown and chip keydown never restart or replace the current draft',()=>{
 const f=fixture('Saved',{type:'text'});try{f.cell.click();const input=f.input();input.value='Typing';const event=f.key('x',{},input);assert.equal(event.defaultPrevented,false);assert.equal(f.input(),input);assert.equal(input.value,'Typing');assert.equal(f.edits.length,0);}finally{f.close();}
 const tags=fixture(['Saved'],{type:'tags'});try{const chip=tags.cell.querySelector('.multi-select-pill')!;tags.key('x',{},chip);assert.equal(tags.input(),null);assert.equal(tags.edits.length,0);}finally{tags.close();}
});
