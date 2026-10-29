import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCanvasMarkdownCard } from '../src/canvas/markdown-card.ts';
import type { CanvasMarkdownCardOptions, CanvasMarkdownSession } from '../src/canvas/markdown-card.ts';
import type { EditorHandle } from '../src/ui/editor.ts';

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
function fixture() {
  const dom=new JSDOM('<main></main>'), doc=dom.window.document;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  let current=true, created=0, focused=0, loads=0;
  const session:CanvasMarkdownSession={getText:()=> 'Original',update(){},subscribe:()=>()=>{},flush:async()=>{},hasPendingChanges:()=>false,destroy(){}};
  const factory:NonNullable<CanvasMarkdownCardOptions['editorFactory']>=()=>{created++;return {focus(){focused++;},getValue:()=> 'Original',setValue(){},destroy(){}} as EditorHandle;};
  const loading=deferred<typeof factory>();let nextLoad=loading.promise;
  const card=createCanvasMarkdownCard(doc,{load:()=>session,isCurrent:()=>current,loadEditor:()=>{loads++;return nextLoad;}});
  doc.querySelector('main')!.append(card.element,card.toolbar);
  return {card,session,factory,loading,retryLoad(){nextLoad=Promise.resolve(factory);},retire(){current=false;},counts:()=>({created,focused,loads}),close(){card.destroy();dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};
}

test('Canvas waits for its editor loader and constructs only the latest activation',async()=>{
  const f=fixture();try{
    const first=f.card.activate();void first.catch(()=>{});await tick();assert.equal(f.counts().loads,1);const latest=f.card.activate();void latest.catch(()=>{});await tick();
    assert.equal(f.counts().created,0);assert.equal(f.card.isEditing(),false);
    f.loading.resolve(f.factory);await Promise.all([first,latest]);
    assert.equal(f.counts().created,1);assert.equal(f.counts().focused,1);assert.equal(f.card.isEditing(),true);
    await f.card.deactivate();await f.card.activate();assert.equal(f.counts().created,1);
  }finally{f.close();}
});

for(const action of ['destroy','deactivate','retire','readOnly'] as const)test(`Canvas refuses a loaded editor after ${action}`,async()=>{
  const f=fixture();try{
    const activation=f.card.activate();void activation.catch(()=>{});await tick();assert.equal(f.counts().loads,1);
    if(action==='destroy')f.card.destroy();else if(action==='deactivate')await f.card.deactivate();else if(action==='retire')f.retire();else Object.defineProperty(f.session,'readOnly',{value:true});
    f.loading.resolve(f.factory);await activation;
    assert.equal(f.counts().created,0);assert.equal(f.counts().focused,0);assert.equal(f.card.isEditing(),false);
  }finally{f.close();}
});

test('an injected Canvas editor factory bypasses module loading',async()=>{
  const dom=new JSDOM('<main></main>'),doc=dom.window.document;let loads=0,created=0;
  const card=createCanvasMarkdownCard(doc,{load:()=>({getText:()=>'',update(){},subscribe:()=>()=>{},flush:async()=>{},hasPendingChanges:()=>false,destroy(){}}),
    loadEditor:async()=>{loads++;throw Error('must not load');},editorFactory:()=>{created++;return {focus(){},getValue:()=>'',setValue(){},destroy(){}} as EditorHandle;}});
  try{await card.activate();assert.equal(created,1);assert.equal(loads,0);}finally{card.destroy();dom.window.close();}
});

test('a rejected Canvas editor import leaves preview intact and permits retry',async()=>{
  const f=fixture();try{
    const activation=f.card.activate();void activation.catch(()=>{});await tick();assert.equal(f.counts().loads,1);f.loading.reject(Error('load failed'));await assert.rejects(activation,/load failed/);
    assert.equal(f.card.isEditing(),false);assert.equal(f.card.element.querySelector('.markdown-preview')?.textContent,'Original');assert.equal(f.counts().created,0);
    f.retryLoad();await f.card.activate();assert.equal(f.card.isEditing(),true);assert.equal(f.counts().created,1);
  }finally{f.close();}
});
