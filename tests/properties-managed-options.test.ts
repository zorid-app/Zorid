import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderProperties} from '../src/ui/properties.ts';
import {readProperties} from '../src/core/properties.ts';
import type {PropertiesOptions} from '../src/ui/properties.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await tick();assert.ok(check());}
function fixture(type:'select'|'multiselect'|'status'='select',callbacks:Pick<PropertiesOptions,'onCreateOption'|'onPropertyDefinitionChange'>={}) {
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!;
  let source=`---\nchoice: ${type==='multiselect'?'[First]':'First'}\n---\nExact body`,current=true,writes=0,removedDefinition=false;
  let definition:BasePropertyDefinition={type,options:[{id:'first-id',value:'First',label:'First',color:'gray',...(type==='status'?{category:'todo' as const}:{})}]};
  const errors:unknown[]=[],calls:Array<{property:string;label:string}>=[];
  const view=renderProperties(host,{getSource:()=>source,isManaged:()=>true,isCurrent:()=>current,getDefinitions:()=>removedDefinition?{}:{choice:definition},
    onChange:next=>{writes++;source=next;},onError:problem=>errors.push(problem),
    onCreateOption:async(property,label)=>{calls.push({property,label});definition={...definition,options:[...definition.options??[],{id:'assigned-id',value:label,label,color:'blue',...(type==='status'?{category:'in-progress' as const}:{})}]};},...callbacks});
  const field=host.querySelector<HTMLElement>('[data-property-key="choice"] .metadata-property-value')!;
  const input=()=>dom.window.document.querySelector<HTMLInputElement>('.bases-property-popover input')!;
  function query(label:string){field.click();input().value=label;input().dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
  const create=()=>dom.window.document.querySelector<HTMLButtonElement>('.bases-property-create-option')!.click();
  const value=()=>readProperties(source).find(property=>property.key==='choice')!.value;
  return{dom,host,view,field,errors,calls,input,query,create,value,get writes(){return writes;},get source(){return source;},set source(next:string){source=next;},
    get definition(){return definition;},set definition(next:BasePropertyDefinition){definition=next;},setCurrent(next:boolean){current=next;},removeDefinition(){removedDefinition=true;view.refresh();},close(){view.destroy();dom.window.close();}};
}

for(const type of ['select','multiselect','status'] as const)test(`managed ${type} can create a named option with assigned schema metadata`,async()=>{
  const f=fixture(type);try{
    f.query('New choice');f.create();await until(()=>f.writes===1);await until(()=>!f.input()?.disabled);f.input()?.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await f.view.flush();
    assert.deepEqual(f.calls,[{property:'choice',label:'New choice'}]);assert.deepEqual(f.value(),type==='multiselect'?['First','New choice']:'New choice');
    assert.equal(f.definition.options?.at(-1)?.id,'assigned-id');assert.equal(f.definition.options?.at(-1)?.color,'blue');assert.ok(f.source.endsWith('Exact body'));assert.deepEqual(f.errors,[]);
    assert.equal(f.host.querySelector('option[value="rollup"]'),null,'the dedicated hook does not enable schema conversion');assert.equal(f.host.querySelector<HTMLSelectElement>('.metadata-property-type')!.disabled,true);
  }finally{f.close();}
});

test('the dedicated option hook wins over generic schema editing and preserves later note body edits',async()=>{
  let release!:()=>void,started=false,genericCalls=0,f:ReturnType<typeof fixture>;const gate=new Promise<void>(resolve=>{release=resolve;});
  f=fixture('select',{onCreateOption:async(property,label)=>{assert.equal(property,'choice');started=true;await gate;f.definition={...f.definition,options:[...f.definition.options??[],{id:'assigned',value:label,label,color:'green'}]};},onPropertyDefinitionChange:()=>{genericCalls++;}});
  try{
    f.query('Second');f.create();await until(()=>started);f.source=f.source.replace('Exact body','Newer body');release();await until(()=>f.writes===1);await f.view.flush();
    assert.equal(genericCalls,0);assert.equal(f.value(),'Second');assert.ok(f.source.endsWith('Newer body'));assert.deepEqual(f.errors,[]);
  }finally{release();f.close();}
});

test('a rejected managed option keeps its search and can retry without a note mutation',async()=>{
  let fail=true,f:ReturnType<typeof fixture>;
  f=fixture('select',{onCreateOption:async(_property,label)=>{if(fail)throw new Error('Schema unavailable');f.definition={...f.definition,options:[...f.definition.options??[],{id:'accepted',value:label,color:'orange'}]};}});
  try{
    f.query('Second');f.create();await until(()=>f.errors.length===1);assert.equal(f.input().value,'Second');assert.equal(f.writes,0);assert.equal(f.value(),'First');
    fail=false;f.create();await until(()=>f.writes===1);await f.view.flush();assert.equal(f.value(),'Second');
  }finally{f.close();}
});

test('a removed managed definition cannot invoke option creation through its retained editor',async()=>{
  const f=fixture();try{f.query('Second');f.removeDefinition();f.create();await until(()=>f.errors.length>0);assert.deepEqual(f.calls,[]);assert.equal(f.writes,0);assert.equal(f.value(),'First');assert.match(String(f.errors.at(-1)),/definition changed/);}finally{f.close();}
});

for(const change of ['missing','ambiguous','type'] as const)test(`unconfirmed ${change} option refresh cannot write a selection`,async()=>{
  let f:ReturnType<typeof fixture>;
  f=fixture('select',{onCreateOption:async(_property,label)=>{
    if(change==='missing')return;
    if(change==='type'){f.definition={type:'text'};return;}
    const option={id:'new-id',value:label,label,color:'green'};
    f.definition={...f.definition,options:[...f.definition.options??[],option,...(change==='ambiguous'?[{...option,id:'duplicate-id'}]:[])]};
  }});
  try{f.query('Second');f.create();await until(()=>f.errors.length>0);assert.equal(f.writes,0);assert.equal(f.value(),'First');assert.equal(f.input().value,'Second');assert.match(String(f.errors.at(-1)),/could not be confirmed/);}finally{f.close();}
});

test('the managed option hook accepts an assigned option value resolved by its exact label',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture('select',{onCreateOption:async(_property,label)=>{f.definition={...f.definition,options:[...f.definition.options??[],{id:'assigned-id',value:'assigned-value',label,color:'green'}]};}});
  try{f.query('Second');f.create();await until(()=>f.writes===1);await f.view.flush();assert.equal(f.value(),'assigned-value');assert.deepEqual(f.errors,[]);}finally{f.close();}
});

for(const change of ['raw','retired','destroyed'] as const)test(`late managed option creation cannot select into a ${change} property owner`,async()=>{
  let release!:()=>void,started=false,f:ReturnType<typeof fixture>;const gate=new Promise<void>(resolve=>{release=resolve;});
  f=fixture('select',{onCreateOption:async(_property,label)=>{started=true;await gate;f.definition={...f.definition,options:[...f.definition.options??[],{value:label}]};}});
  try{
    f.query('Second');f.create();await until(()=>started);if(change==='raw')f.source=f.source.replace('choice: First','choice: External');else if(change==='retired')f.setCurrent(false);else f.view.destroy();
    release();await tick();await tick();assert.equal(f.writes,0);assert.equal(f.value(),change==='raw'?'External':'First');
  }finally{release();f.close();}
});

test('legacy generic schema creation retains its strict accepted-definition check',async()=>{
  let f:ReturnType<typeof fixture>;f=fixture('select',{onCreateOption:undefined,onPropertyDefinitionChange:async(_property,next)=>{f.definition={...next,options:next.options?.map(option=>({...option,color:'blue'}))};}});
  try{f.query('Second');f.create();await until(()=>f.errors.length>0);assert.equal(f.writes,0);assert.equal(f.value(),'First');assert.match(String(f.errors.at(-1)),/settings changed/);}finally{f.close();}
});
