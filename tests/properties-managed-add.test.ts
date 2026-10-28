import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderProperties} from '../src/ui/properties.ts';
import type {PropertiesOptions} from '../src/ui/properties.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture(onAddProperty?:PropertiesOptions['onAddProperty']) {
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!;
  let managed=true,current=true,source='---\nrating: 4\n---\nExact body',writes=0;
  const errors:unknown[]=[];
  const view=renderProperties(host,{getSource:()=>source,isManaged:()=>managed,isCurrent:()=>current,onAddProperty,
    onChange:next=>{source=next;writes++;},onError:problem=>errors.push(problem)});
  const button=host.querySelector<HTMLButtonElement>('.metadata-add-button')!;
  return{dom,host,view,button,errors,get source(){return source;},get writes(){return writes;},
    setManaged(value:boolean){managed=value;view.refresh();},setCurrent(value:boolean){current=value;},
    close(){view.destroy();dom.window.close();}};
}

test('managed Add property routes to its schema owner without creating a YAML draft',async()=>{
  const calls:HTMLElement[]=[];const f=fixture(anchor=>{calls.push(anchor);});
  try{
    f.button.click();assert.deepEqual(calls,[f.button]);assert.equal(f.host.querySelector('.metadata-add-form'),null);
    assert.equal(f.writes,0);assert.equal(f.source,'---\nrating: 4\n---\nExact body');
    assert.equal(f.view.hasPendingChanges(),false,'the schema owner retains picker lifecycle');
    await tick();assert.equal(f.button.disabled,false);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('managed Add property suppresses duplicate invocations until its owner settles',async()=>{
  let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture(()=>{calls++;return gate;});
  try{
    f.button.click();f.button.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));assert.equal(calls,1);assert.equal(f.button.disabled,true);
    release();await tick();assert.equal(f.button.disabled,false);f.button.click();assert.equal(calls,2);assert.equal(f.writes,0);
  }finally{release();await tick();f.close();}
});

test('managed Add property reports synchronous and asynchronous hook failures and permits retry',async()=>{
  for(const asynchronous of [false,true]){
    let calls=0;const failure=new Error('Schema picker unavailable');
    const f=fixture(()=>{calls++;if(calls>1)return;if(asynchronous)return Promise.reject(failure);throw failure;});
    try{
      f.button.click();await tick();assert.deepEqual(f.errors,[failure]);assert.match(f.host.querySelector('.metadata-error')!.textContent!,/Schema picker unavailable/);
      assert.equal(f.button.disabled,false);assert.equal(f.host.querySelector('.metadata-add-form'),null);assert.equal(f.writes,0);
      f.button.click();await tick();assert.equal(calls,2);assert.equal(f.host.querySelector<HTMLElement>('.metadata-error')!.hidden,true);
    }finally{f.close();}
  }
});

test('retired or destroyed property panels cannot invoke a managed schema hook',()=>{
  let calls=0;const f=fixture(()=>{calls++;});
  try{
    f.setCurrent(false);f.button.click();assert.equal(calls,0);assert.equal(f.host.querySelector('.metadata-add-form'),null);
    f.setCurrent(true);f.view.destroy();f.button.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));assert.equal(calls,0);
  }finally{f.close();}
});

test('late managed-hook failures do not report against a retired or destroyed panel',async()=>{
  for(const destroyed of [false,true]){
    let reject!:(error:unknown)=>void;const gate=new Promise<void>((_resolve,fail)=>{reject=fail;});const f=fixture(()=>gate);
    try{
      f.button.click();if(destroyed)f.view.destroy();else f.setCurrent(false);
      reject(new Error('Late failure'));await tick();assert.deepEqual(f.errors,[]);assert.equal(f.writes,0);
    }finally{f.close();}
  }
});

test('late schema-hook failures do not attach errors after managed membership is lost',async()=>{
  let reject!:(error:unknown)=>void;const gate=new Promise<void>((_resolve,fail)=>{reject=fail;});const f=fixture(()=>gate);
  try{f.button.click();f.setManaged(false);reject(new Error('Old schema failure'));await tick();assert.deepEqual(f.errors,[]);f.button.click();assert.ok(f.host.querySelector('.metadata-add-form'));assert.equal(f.writes,0);}finally{f.close();}
});

test('ordinary notes keep the YAML add form even when a schema hook is available',()=>{
  let calls=0;const f=fixture(()=>{calls++;});
  try{
    f.setManaged(false);f.button.click();assert.equal(calls,0);assert.ok(f.host.querySelector('.metadata-add-form'));
    const name=f.host.querySelector<HTMLInputElement>('[aria-label="New property name"]')!;assert.equal(f.dom.window.document.activeElement,name);
    assert.equal(f.writes,0);assert.equal(f.view.hasPendingChanges(),true);
  }finally{f.close();}
});

test('managed legacy hosts without a schema hook retain their existing add form',()=>{
  const f=fixture();try{f.button.click();assert.ok(f.host.querySelector('.metadata-add-form'));assert.equal(f.writes,0);}finally{f.close();}
});
