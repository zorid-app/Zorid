import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {baseExpressionValue} from '../src/bases/expression.ts';
import type {BaseExpressionValue} from '../src/bases/expression.ts';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {BasePropertyWidgetEdit} from '../src/bases/property-widgets.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function freeze(value:BaseExpressionValue):BaseExpressionValue {
  if(value.type==='list'){value.value.forEach(freeze);Object.freeze(value.value);}
  if(value.type==='object'){Object.values(value.value).forEach(freeze);Object.freeze(value.value);}
  return Object.freeze(value);
}
function fixture(source:unknown[],definition?:BasePropertyDefinition){
  const dom=new JSDOM('<main><div></div><button>Outside</button></main>',{pretendToBeVisual:true});
  const element=dom.window.document.querySelector('div')!,raw=freeze(baseExpressionValue(source));
  assert.equal(raw.type,'list');
  const original=JSON.stringify(raw),edits:BasePropertyWidgetEdit[]=[],row={path:'Mixed.md',values:{},entryId:'mixed',revision:'r1'};
  let reject=false;
  const dispose=mountBasePropertyWidget(element,{row,property:'note.items',value:raw,version:1},{getDefinition:()=>definition,getEditableValue:()=>raw,
    commit:edit=>{edits.push(edit);if(reject)throw new Error('Save failed');return{row,version:2,value:edit.value};}});
  const input=()=>element.querySelector<HTMLInputElement>('input')!;
  const key=(target:Element,key:string)=>target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  const open=()=>element.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  const add=async(text:string,keyName='Enter')=>{input().value=text;key(input(),keyName);await tick();};
  const pills=()=>element.querySelectorAll<HTMLElement>('.multi-select-pill');
  return{dom,element,raw,original,edits,input,key,open,add,pills,reject(value:boolean){reject=value;},close(){assert.equal(JSON.stringify(raw),original,'rendering and editing never mutate original typed values');dispose();dom.window.close();}};
}
const mixed=[42,true,null,[7,'nested'],{nested:[false,3]},'[[../People/Ada#^block|Ada alias]]'];

for(const key of ['Enter','Tab'])test(`adding list text with ${key} retains every untouched raw type and nested value`,async()=>{
  const f=fixture(mixed);try{
    f.open();await f.add('new text',key);
    assert.deepEqual(f.edits.at(-1)?.value,baseExpressionValue([...mixed,'new text']));
    const next=f.edits.at(-1)!.value;assert.equal(next.type,'list');
    if(next.type==='list'&&f.raw.type==='list')f.raw.value.forEach((item,index)=>assert.equal(next.value[index],item,'untouched nodes retain identity'));
  }finally{f.close();}
});

for(const removed of [0,1])test(`removing chip ${removed} distinguishes numeric and text values with identical labels`,async()=>{
  const source=[42,'42',true,{keep:[1,false]},'[[A|alias]]'];const f=fixture(source);try{
    f.open();f.pills()[removed].querySelector<HTMLButtonElement>('button')!.click();await tick();
    assert.deepEqual(f.edits.at(-1)?.value,baseExpressionValue(source.filter((_value,index)=>index!==removed)));
    assert.equal(f.edits.length,1,'remove changes only its selected index');
  }finally{f.close();}
});

for(const key of ['Enter','Tab'])test(`accepting unchanged typed-chip display with ${key} preserves the original value`,async()=>{
  const f=fixture([42,true,{keep:3}]);try{
    f.open();f.key(f.pills()[0],'Enter');assert.equal(f.input().value,'42');f.key(f.input(),key);await tick();
    assert.equal(f.edits.length,0,'unchanged display is not permission to coerce the value');
    if(!f.input())f.open();await f.add('after');assert.deepEqual(f.edits.at(-1)?.value,baseExpressionValue([42,true,{keep:3},'after']));
  }finally{f.close();}
});

test('explicitly changing one typed chip creates text only at that index',async()=>{
  const f=fixture(mixed);try{
    f.open();f.key(f.pills()[0],'Enter');await f.add('43');
    assert.deepEqual(f.edits.at(-1)?.value,baseExpressionValue(['43',...mixed.slice(1)]));
  }finally{f.close();}
});

test('a failed list save retries a stable typed snapshot without changing older attempts',async()=>{
  const f=fixture(mixed);try{
    f.open();f.reject(true);await f.add('first');
    const first=f.edits[0].value,encoded=JSON.stringify(first);
    assert.equal(f.element.dataset.baseEditing,'draft');assert.equal(f.input().getAttribute('aria-invalid'),'true');
    f.reject(false);await f.add('second');
    assert.deepEqual(f.edits.at(-1)?.value,baseExpressionValue([...mixed,'first','second']));
    assert.equal(JSON.stringify(first),encoded,'later draft changes cannot mutate an issued snapshot');
  }finally{f.close();}
});

test('configured tags still append new text without retyping existing strings',async()=>{
  const f=fixture(['alpha','beta'],{type:'tags'});try{f.open();await f.add('gamma');assert.deepEqual(f.edits.at(-1)?.value,baseExpressionValue(['alpha','beta','gamma']));}finally{f.close();}
});
