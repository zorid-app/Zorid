import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { baseExpressionValue } from '../src/bases/expression.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';
import type { Vault } from '../src/core/vault.ts';
import { renderProperties } from '../src/ui/properties.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup() {
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),container=dom.window.document.querySelector('main')!;
  const original='---\nauthor: "[[Authors/Ada|literal alias]]"\ntitle: original\n---\nUnsaved body 🌱';
  let source=original,display:BaseExpressionValue|undefined,writes=0;
  const opened:unknown[]=[];const baselines:unknown[]=[];
  const vault={entries:new Map([['Properties.yaml',{path:'Properties.yaml',type:'file'}]]),read:async()=> 'properties:\n  author:\n    type: relation\n',on:()=>()=>{}} as unknown as Vault;
  const view=renderProperties(container,{vault,path:'Books/Note.md',getSource:()=>source,onChange:next=>{writes++;source=next;},getDisplayValue:(property,raw)=>{baselines.push({property,raw});return property==='author' && JSON.stringify(raw)===JSON.stringify(baseExpressionValue('[[Authors/Ada|literal alias]]'))?display:undefined;},getRelationTargets:()=>[],openLink:(path,witness)=>opened.push({path,witness})});
  const field=()=>container.querySelector<HTMLElement>('[data-property-key="author"] .metadata-property-value')!;
  return {dom,container,view,field,opened,baselines,original,get source(){return source;},get writes(){return writes;},set display(next:BaseExpressionValue|undefined){display=next;},close(){view.destroy();dom.window.close();}};
}
function resolved(label:string,revision='ada-1'):BaseExpressionValue {
  return {type:'namespace',name:label,presentation:{kind:'link',value:'Authors/Ada.md',label:baseExpressionValue(label),target:{entryId:'ada',revision}}};
}

test('ordinary relation display refreshes independently from raw text, forwards identity and preserves chip focus',async()=>{
  const s=setup();await tick();assert.equal(s.field().textContent,'[[Authors/Ada|literal alias]]');assert.equal(s.field().querySelector('[role="link"]'),null);
  s.display=resolved('Ada');s.view.refresh();let pill=s.field().querySelector<HTMLElement>('.multi-select-pill')!;assert.equal(pill.textContent,'Ada');
  pill.focus();s.display=resolved('Ada renamed','ada-2');s.view.refresh();const updated=s.field().querySelector<HTMLElement>('.multi-select-pill')!;
  assert.notEqual(updated,pill);assert.equal(updated.textContent,'Ada renamed');assert.equal(s.dom.window.document.activeElement,updated);
  pill.dispatchEvent(new s.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.equal(s.opened.length,0);
  updated.dispatchEvent(new s.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.deepEqual(s.opened,[{path:'Authors/Ada.md',witness:{entryId:'ada',revision:'ada-2'}}]);
  s.display=resolved('Ada renamed','ada-2');s.view.refresh();assert.equal(s.field().querySelector('.multi-select-pill'),updated);
  s.display=undefined;s.view.refresh();assert.equal(s.field().textContent,'[[Authors/Ada|literal alias]]');assert.equal(s.field().querySelector('[role="link"]'),null);
  assert.ok(s.baselines.some(value=>JSON.stringify(value)===JSON.stringify({property:'author',raw:baseExpressionValue('[[Authors/Ada|literal alias]]')})));assert.equal(s.writes,0);assert.equal(s.source,s.original);s.close();
});

test('async relation display refresh retains an active exact raw draft and later adopts the new label',async()=>{
  const s=setup();await tick();s.display=resolved('Ada');s.view.refresh();s.field().click();
  const input=s.dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;assert.equal(input.value,'[[Authors/Ada|literal alias]]');input.value='a draft';input.setSelectionRange(2,5);input.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));
  s.display=resolved('Later label','ada-3');s.view.refresh();assert.equal(s.dom.window.document.querySelector('[role="combobox"]'),input);assert.equal(s.dom.window.document.activeElement,input);assert.equal(input.value,'a draft');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);assert.equal(s.field().dataset.baseEditing,'draft');
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));s.view.refresh();assert.equal(s.field().textContent,'Later label');assert.equal(s.writes,0);assert.equal(s.source,s.original);s.close();
});
