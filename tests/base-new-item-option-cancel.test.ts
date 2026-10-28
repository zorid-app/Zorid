import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {openBaseNewItemPopover} from '../src/ui/base-new-item-popover.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await tick();assert.ok(check());}
async function fixture(failure:Error,type:'select'|'multiselect'|'status'='multiselect'){
  const dom=new JSDOM('<button>Open</button>',{pretendToBeVisual:true}),source='---\nTags:\nRating: 1\n---\nExact body';
  const adapter=new MemoryAdapter({'Item.md':source}),vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'Item.md',{debounceMs:60000});await buffer.load();
  let definition:BasePropertyDefinition={type,options:[]},allow=false,calls=0;const errors:unknown[]=[],rejections=new Map<string,Error>();
  const popup=await openBaseNewItemPopover({anchor:dom.window.document.querySelector('button')!,vault,path:'Item.md',presentation:'side-peek',focusTitle:false,propertiesExpanded:true,
    getBuffer:async()=>buffer,validate(){},rename:async()=>{},openFile(){},onError:problem=>errors.push(problem),properties:{isManaged:()=>true,getDefinitions:()=>({Tags:definition,Rating:{type:'number'}}),
      onCreateOption:async(property,label)=>{calls++;assert.equal(property,'Tags');if(rejections.has(label))throw rejections.get(label);if(!allow)throw failure;definition={type,options:[...definition.options??[],{id:`assigned-${label}`,value:label,label,color:'blue'}]};}}});
  const field=()=>popup.element.querySelector<HTMLElement>('[data-property-key="Tags"] .metadata-property-value')!;
  const input=()=>dom.window.document.querySelector<HTMLInputElement>('.bases-property-popover input');
  async function create(label='New option'){const previous=calls;field().click();input()!.value=label;input()!.dispatchEvent(new dom.window.Event('input',{bubbles:true}));dom.window.document.querySelector<HTMLButtonElement>('.bases-property-create-option')!.click();await until(()=>calls>previous);await until(()=>!input()?.disabled);await tick();}
  async function cancel(){input()?.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();assert.equal(dom.window.document.querySelector('.bases-property-popover'),null);}
  return{dom,source,adapter,buffer,popup,errors,create,cancel,field,get calls(){return calls;},accept(){allow=true;},reject(label:string,problem:Error){rejections.set(label,problem);},async close(){if(popup.element.isConnected){allow=true;await create();await cancel();await popup.close();}await buffer.dispose();dom.window.close();}};
}

for(const type of ['select','multiselect','status'] as const)test(`Escape cancels a definitely rejected page ${type} option without blocking close`,async()=>{
  const failure=Object.assign(new Error('This change removes existing values'),{source:'host',commitUncertain:false}),f=await fixture(failure,type);
  try{
    await f.create();assert.equal(f.popup.hasPendingChanges(),true);assert.equal(f.field().closest('.metadata-property')?.querySelector<HTMLElement>('.metadata-property-error')?.hidden,false);
    await f.cancel();assert.equal(f.popup.hasPendingChanges(),false);await assert.doesNotReject(f.popup.close());assert.equal(f.popup.element.isConnected,false);assert.equal(await f.adapter.read('Item.md'),f.source);assert.equal(f.calls,1);
  }finally{await f.close();}
});

for(const receipt of [undefined,true] as const)test(`Escape retains an ${receipt===true?'explicitly uncertain':'unknown'} schema outcome until the same option retry succeeds`,async()=>{
  const failure=Object.assign(new Error('Option outcome is uncertain'),receipt===undefined?{}:{source:'host',commitUncertain:true}),f=await fixture(failure);
  try{
    await f.create();await f.cancel();assert.equal(f.popup.hasPendingChanges(),true);await assert.rejects(f.popup.close(),/outcome is uncertain/);assert.ok(f.popup.element.isConnected);assert.equal(await f.adapter.read('Item.md'),f.source);
    f.accept();await f.create();await until(()=>f.buffer.text.includes('New option'));await f.cancel();await f.popup.close();assert.equal(f.calls,2);assert.equal(f.popup.element.isConnected,false);assert.ok((await f.adapter.read('Item.md')).endsWith('Exact body'));
  }finally{await f.close();}
});

test('a separate accepted property edit cannot clear a canceled uncertain option outcome',async()=>{
  const f=await fixture(new Error('Retained schema outcome'));
  try{
    await f.create();await f.cancel();const field=f.popup.element.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;field.click();
    const input=field.querySelector<HTMLInputElement>('input')!;input.value='2';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await until(()=>f.buffer.text.includes('Rating: 2'));assert.equal(f.popup.hasPendingChanges(),true);await assert.rejects(f.popup.close(),/Retained schema outcome/);assert.ok(f.popup.element.isConnected);
  }finally{await f.close();}
});

test('creating Blue on the same property cannot settle an uncertain Red option',async()=>{
  const f=await fixture(new Error('Uncertain Red outcome'));
  try{
    await f.create('Red');await f.cancel();f.accept();await f.create('Blue');await until(()=>f.buffer.text.includes('Blue'));await f.cancel();
    assert.equal(f.popup.hasPendingChanges(),true);await assert.rejects(f.popup.close(),/Uncertain Red outcome/);assert.ok(f.popup.element.isConnected);
    await f.create('Red');await until(()=>f.buffer.text.includes('Red'));await f.cancel();await f.popup.close();assert.equal(f.calls,3);assert.ok((await f.adapter.read('Item.md')).includes('Blue'));assert.ok((await f.adapter.read('Item.md')).includes('Red'));
  }finally{await f.close();}
});

test('a definitely rejected Blue option cannot release an uncertain Red request on the same property',async()=>{
  const f=await fixture(new Error('Uncertain Red outcome'));
  try{
    await f.create('Red');await f.cancel();f.accept();f.reject('Blue',Object.assign(new Error('Blue rejected'),{source:'host',commitUncertain:false}));await f.create('Blue');await f.cancel();
    assert.equal(f.popup.hasPendingChanges(),true);await assert.rejects(f.popup.close(),/Uncertain Red outcome/);assert.ok(f.popup.element.isConnected);
    await f.create('Red');await until(()=>f.buffer.text.includes('Red'));await f.cancel();await f.popup.close();assert.equal(f.calls,3);
  }finally{await f.close();}
});
