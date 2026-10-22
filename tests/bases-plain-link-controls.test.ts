import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { baseExpressionValue } from '../src/bases/expression.ts';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
import type { BaseRelationTarget } from '../src/bases/property-widgets.ts';
import { renderProperties } from '../src/ui/properties.ts';
import type { Vault } from '../src/core/vault.ts';
const tick=()=>new Promise<void>(done=>setTimeout(done,10));
function fixture(){
 const dom=new JSDOM('<main><div></div></main>',{pretendToBeVisual:true}),element=dom.window.document.querySelector('div')!;
 const original='[[../Targets/Ada|Original alias]]',edits:unknown[]=[];
 let targets:readonly BaseRelationTarget[]|undefined=[{path:'Targets/Grace.md',label:'Grace',entryId:'grace',revision:'g1'}];
 const dispose=mountBasePropertyWidget(element,{property:'note.reference',row:{path:'Books/One.md',values:{}},version:1,value:baseExpressionValue(original)}, {
  getDefinition:()=>({type:'link'}),getRelationTargets:()=>targets,
  commit(edit){edits.push(edit.value);},
 });
 const open=()=>{element.click();return dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;};
 const search=(input:HTMLInputElement,text:string)=>{input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 const key=(input:HTMLInputElement,key:string)=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 return{dom,element,edits,original,open,search,key,setTargets(next:readonly BaseRelationTarget[]|undefined){targets=next;},close(){dispose();dom.window.close();}};
}
test('plain link selected choices reject replacement identities, revisions and unavailable advice',async()=>{
 for(const replacement of [[{path:'Targets/Grace.md',label:'Grace',entryId:'replacement',revision:'g2'}],[{path:'Targets/Grace.md',label:'Grace',entryId:'grace',revision:'g2'}],[],[{path:'Targets/Grace.md',label:'Grace',entryId:'grace',revision:'g1',missing:true}],undefined] as const){
  const f=fixture();try{
   const input=f.open();f.search(input,'Grace');const choice=f.dom.window.document.querySelector<HTMLButtonElement>('[role="option"]')!;assert.ok(choice);
   f.setTargets(replacement);choice.click();await tick();assert.deepEqual(f.edits,[]);assert.equal(f.element.dataset.baseEditing,'draft');assert.match(f.element.title,/unavailable|choice changed/i);assert.equal(input.value,'Grace');
  }finally{f.close();}
 }
});
test('plain links preserve exact aliases until explicit selection and allow manual URLs and wiki text without target advice',async()=>{
 const f=fixture();try{
  let input=f.open();assert.equal(input.value,f.original);f.key(input,'Escape');assert.deepEqual(f.edits,[]);assert.equal(f.element.textContent,f.original);
  input=f.open();f.search(input,'Grace');f.key(input,'Enter');await tick();assert.deepEqual(f.edits,[baseExpressionValue('[[/Targets/Grace.md]]')]);
 }finally{f.close();}
 for(const literal of ['https://example.org/path?q=a%20b#heading','[[../Unresolved|Keep this alias]]']){
  const f=fixture();try{f.setTargets(undefined);const input=f.open();f.search(input,literal);f.key(input,'Enter');await tick();assert.deepEqual(f.edits,[baseExpressionValue(literal)]);}finally{f.close();}
 }
});
test('ordinary note plain-link choices carry target revisions and reject same-path replacements',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),container=dom.window.document.querySelector('main')!;
 let source='---\nreference: null\n---\nUnsaved body\n',writes=0;
 const entries=new Map([['Properties.yaml',{path:'Properties.yaml',type:'file',entryId:'settings',revision:'s1'}],['Targets/Grace.md',{path:'Targets/Grace.md',type:'file',entryId:'grace',revision:'g1'}]]);
 const vault={entries,read:async()=> 'properties:\n  reference: {type: link}\n',on:()=>()=>{}} as unknown as Vault;
 const view=renderProperties(container,{vault,path:'Books/One.md',getSource:()=>source,onChange:next=>{writes++;source=next;}});
 try{
  await tick();container.querySelector<HTMLElement>('[data-property-key="reference"] .metadata-property-value')!.click();
  const input=dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;input.value='Grace';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  const choice=dom.window.document.querySelector<HTMLButtonElement>('[role="option"]')!;assert.ok(choice);
  entries.set('Targets/Grace.md',{path:'Targets/Grace.md',type:'file',entryId:'grace',revision:'g2'});choice.click();await tick();
  assert.equal(writes,0);assert.equal(source,'---\nreference: null\n---\nUnsaved body\n');assert.match(container.querySelector('[data-base-editing]')!.getAttribute('title')!,/choice changed/);
 }finally{view.destroy();dom.window.close();}
});
