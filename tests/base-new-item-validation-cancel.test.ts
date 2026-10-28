import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {openBaseNewItemPopover} from '../src/ui/base-new-item-popover.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await tick();assert.ok(check());}
async function fixture(type:BasePropertyDefinition['type'],raw:string){
  const dom=new JSDOM('<button>Open</button>',{pretendToBeVisual:true}),source=`---\nField: ${raw}\nOther: Initial\n---\nExact body`;
  const adapter=new MemoryAdapter({'Item.md':source}),vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'Item.md',{debounceMs:60000});await buffer.load();const errors:unknown[]=[];
  const popup=await openBaseNewItemPopover({anchor:dom.window.document.querySelector('button')!,vault,path:'Item.md',presentation:'side-peek',focusTitle:false,propertiesExpanded:true,
    getBuffer:async()=>buffer,validate(){},rename:async()=>{},openFile(){},onError:problem=>errors.push(problem),properties:{isManaged:()=>true,getDefinitions:()=>({Field:{type},Other:{type:'text'}})}});
  const field=(name='Field')=>popup.element.querySelector<HTMLElement>(`[data-property-key="${name}"] .metadata-property-value`)!;
  function edit(draft:string,name='Field'){const owner=field(name);owner.click();const input=owner.querySelector<HTMLInputElement>('input')!;assert.ok(input);assert.equal(input.type,'text','the real value editor must accept an invalid text draft');input.value=draft;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));return input;}
  const key=(input:Element,key:string)=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  return{dom,source,adapter,buffer,popup,errors,field,edit,key,async close(){try{await popup.close();}catch{}await buffer.dispose();dom.window.close();}};
}

for(const[type,raw]of [['number','1'],['date','legacy-date'],['datetime','2026-10-28T10:30:00+02:00']] as const)test(`canceling a page ${type} parser error restores close readiness without saving the invalid draft`,async()=>{
  const f=await fixture(type,raw);try{
    const input=f.edit('not-a-valid-value');f.key(input,'Enter');await until(()=>f.errors.length>0);assert.equal(f.popup.hasPendingChanges(),true);await assert.rejects(f.popup.close());
    input.focus();f.key(input,'Escape');await tick();assert.equal(input.isConnected,false);assert.equal(f.field().hasAttribute('data-base-editing'),false);
    await assert.doesNotReject(f.popup.close(),'a canceled parser error must not leave an orphan property alert');assert.equal(f.popup.element.isConnected,false);assert.equal(await f.adapter.read('Item.md'),f.source);
  }finally{await f.close();}
});

test('canceling a parser error while another property save is pending clears only after that save settles',async()=>{
  const f=await fixture('number','1'),write=f.adapter.write.bind(f.adapter);let release!:()=>void,started=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});f.adapter.write=async(path,text)=>{started=true;await gate;await write(path,text);};
  try{
    const other=f.edit('Accepted text','Other');f.key(other,'Enter');await until(()=>started);
    const input=f.edit('invalid number');f.key(input,'Enter');await until(()=>f.errors.length>0);f.key(input,'Escape');await tick();assert.equal(f.popup.hasPendingChanges(),true,'accepted pending writes remain owned');
    release();await until(()=>!f.buffer.dirty&&!other.isConnected);await assert.doesNotReject(f.popup.close());const saved=await f.adapter.read('Item.md');assert.match(saved,/Field: 1/);assert.match(saved,/Other: Accepted text/);assert.ok(saved.endsWith('Exact body'));
  }finally{release();await f.close();}
});
