import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {baseExpressionValue} from '../src/bases/expression.ts';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {BasePropertyWidgetEdit} from '../src/bases/property-widgets.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(type:'select'|'status'|'multiselect',mode:'managed'|'legacy'|'missing'|'ambiguous'|'rejected'='managed'){
 const dom=new JSDOM('<div tabindex="0"></div>',{pretendToBeVisual:true}),doc=dom.window.document,cell=doc.querySelector<HTMLElement>('div')!,edits:BasePropertyWidgetEdit[]=[],errors:unknown[]=[];
 const original=type==='multiselect'?['opaque-red']:null,value=baseExpressionValue(original),row={path:'One.md',values:{'note.field':value}};
 let created=0,definition:BasePropertyDefinition={type,options:[{value:'opaque-red',label:'Red'}]};
 const dispose=mountBasePropertyWidget(cell,{row,property:'note.field',value,version:1},{getDefinition:()=>definition,
  createOption(_property,text,presentation){created++;if(mode==='rejected')throw new Error('Schema save failed');if(mode!=='missing')definition={...definition,options:[...definition.options!,{value:mode==='legacy'?text:'opaque-blue',label:text},...(mode==='ambiguous'?[{value:'other-blue',label:text}]:[])]};return{version:2,row:presentation.row,value};},
  commit(edit){edits.push(edit);return{version:3,row:edit.row,value:edit.value};},onError:error=>errors.push(error)});
 const search=(text:string)=>{cell.click();const input=doc.querySelector<HTMLInputElement>('input')!;input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));return input;};
 return{doc,cell,edits,errors,search,created:()=>created,close(){dispose();dom.window.close();}};
}
for(const type of ['select','status','multiselect']as const)test(`created managed ${type} chooses its refreshed opaque value after schema acknowledgment`,async()=>{
 const f=fixture(type);try{f.search('Blue');f.doc.querySelector<HTMLButtonElement>('.bases-property-create-option')!.click();await tick();assert.equal(f.created(),1);assert.equal(f.edits.length,1);assert.equal(f.edits[0].version,2);assert.deepEqual(f.edits[0].value,baseExpressionValue(type==='multiselect'?['opaque-red','opaque-blue']:'opaque-blue'));assert.deepEqual(f.errors,[]);assert.match((type==='multiselect'?f.doc.querySelector('.multi-select-container')?.textContent:f.cell.textContent)??'',/Blue/);}finally{f.close();}
});
for(const query of ['Red','opaque-red'])test(`existing option ${query==='Red'?'label':'value'} suppresses duplicate creation`,()=>{
 const f=fixture('select');try{f.search(query);assert.equal(f.doc.querySelector('.bases-property-create-option'),null);assert.equal(f.created(),0);assert.equal(f.edits.length,0);}finally{f.close();}
});
test('legacy created options whose stored value is their label still select normally',async()=>{
 const f=fixture('select','legacy');try{f.search('Blue');f.doc.querySelector<HTMLButtonElement>('.bases-property-create-option')!.click();await tick();assert.deepEqual(f.edits[0].value,baseExpressionValue('Blue'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});
for(const mode of ['missing','ambiguous','rejected']as const)test(`${mode} created-option response preserves the query without writing a fabricated selection`,async()=>{
 const f=fixture('select',mode);try{const input=f.search('Blue');f.doc.querySelector<HTMLButtonElement>('.bases-property-create-option')!.click();await tick();assert.equal(f.created(),1);assert.equal(f.edits.length,0);assert.equal(input.value,'Blue');assert.equal(input.disabled,false);assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(f.cell.dataset.baseEditing,'draft');assert.ok(f.errors.length);}finally{f.close();}
});
