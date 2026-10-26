import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {UI} from './bases-electron-integration/ui.mjs';
import {closeTypedFilter,filterCloseReadiness} from './bases-electron-filter-integration/close-readiness.mjs';

const source='views:\n  - type: table\n    name: Typed\n    order: [ file.name, note.items ]\n    filters: \'note["items"] == ["red", "blue"]\'\n';
const note='---\nitems: [red, blue]\nkeep: original\n---\nBody sentinel\n';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}
const tick=()=>new Promise<void>(done=>setTimeout(done,5));
async function until(check:()=>boolean|Promise<boolean>,label:string){for(let n=0;n<500;n++){if(await check())return;await tick();}assert.ok(await check(),label);}

async function fixture(){
  const adapter=new MemoryAdapter({'Typed.base':source,'A.md':note,'Properties.yaml':'properties:\n  items:\n    type: list\n'}),vault=new Vault(adapter);await vault.initialize();
  const dom=new JSDOM('<section class="pane is-active"><main></main></section>',{pretendToBeVisual:true,runScripts:'outside-only'}),doc=dom.window.document,host=doc.querySelector('main')!;
  const buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],release=deferred();let holding=false,entered=false;
  const session=createBaseSession(host,{vault,basePath:'Typed.base',validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});const original=buffer.flush.bind(buffer),owned=buffer;buffer.flush=async()=>{await original();if(holding&&path==='Typed.base'&&owned.savedText.includes('["red", "blue"]')){entered=true;await release.promise;}};buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  const panel=()=>doc.querySelector<HTMLElement>('[role="dialog"][aria-label="Filter"]');
  const button=(label:string)=>{const element=doc.querySelector<HTMLButtonElement>(`[aria-label=${JSON.stringify(label)}]`);assert.ok(element,label);return element;};
  const actions:unknown[]=[],keys:string[]=[],ui=new UI({evaluate:async(expression:string)=>structuredClone(dom.window.eval(expression)),async call(){throw new Error('Readiness must not inject input');}},actions);
  const wait=ui.wait.bind(ui);ui.wait=(body:string,label:string,timeout?:number)=>wait(body,label,Math.min(timeout??20000,3000));
  ui.key=async(key:string)=>{keys.push(key);assert.equal(key,'Escape');doc.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));};
  await session.ready;await until(()=>host.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false','initial saved result');
  return{adapter,vault,dom,doc,host,session,errors,panel,button,actions,keys,c:{ui,evidence:{actions}},hold(){holding=true;},get entered(){return entered;},release(){holding=false;release.resolve();},
    async cleanup(){
      holding=false;release.resolve();const failures:unknown[]=[];
      const attempt=async(action:()=>unknown|Promise<unknown>)=>{try{await action();}catch(error){failures.push(error);}};
      await attempt(()=>until(()=>!session.hasPendingChanges(),'release all real operations'));
      await attempt(()=>session.close());
      for(const buffer of buffers.values())await attempt(()=>buffer.dispose());
      await attempt(()=>dom.window.close());
      if(failures.length)throw new AggregateError(failures,'Filter fixture cleanup failed');
    }};
}

test('real Filter list round-trip waits for acknowledgement before one fresh Escape closes it',async()=>{
  const f=await fixture();let closing:Promise<void>|undefined;
  try{
    f.button('Filter').click();f.button('Remove item blue').focus();f.button('Remove item blue').click();
    await until(async()=>(await f.adapter.read('Typed.base')).includes('["red"]')&&f.panel()?.querySelector('[role="alert"]')?.textContent==='','first removal fully acknowledged');
    const input=f.panel()!.querySelector<HTMLInputElement>('input[aria-label="Filter value"]')!;assert.ok(input);input.focus();input.value='blue';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    f.hold();f.button('Add item').focus();f.button('Add item').click();await until(()=>f.entered,'actual list round-trip reaches its post-flush acknowledgement gate');
    assert.equal(await f.adapter.read('Typed.base'),source);assert.equal(await f.vault.read('Typed.base'),source,'normal logical read also sees the exact round-trip bytes');
    assert.equal(f.panel()!.querySelector('[role="alert"]')!.textContent,'Saving…');assert.equal(f.host.querySelector('.bases-session-content')!.getAttribute('aria-busy'),'true');assert.ok(f.panel()!.contains(f.doc.activeElement));
    const escape=new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});f.doc.activeElement!.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented,false,'pending save does not admit the close key');
    assert.ok(f.panel(),'The early key leaves the exact pending draft visible');
    assert.equal(filterCloseReadiness(f.doc).ready,false);
    closing=closeTypedFilter(f.c);
    await tick();assert.deepEqual(f.keys,[],'A readable saved source cannot authorize the fresh close input while acknowledgement is held');
    f.release();await closing;
    assert.deepEqual(f.keys,['Escape']);assert.equal(f.panel(),null);assert.equal(await f.adapter.read('Typed.base'),source);assert.equal(await f.vault.read('A.md'),note);assert.deepEqual(f.errors,[]);
    assert.equal((f.actions.find((action:any)=>action.action==='typed-filter-close-ready') as any).ready,true);
  }finally{f.release();await closing?.catch(()=>{});await f.cleanup();}
});

test('a complete dirty list edit can still use its single Escape to submit before the auto-save timer',async()=>{
  const f=await fixture();try{
    f.button('Filter').click();f.button('Remove item blue').focus();f.button('Remove item blue').click();
    assert.equal(await f.adapter.read('Typed.base'),source,'the valid new draft has not started its debounce save');
    assert.equal(filterCloseReadiness(f.doc).ready,true,'ready does not require an unsubmitted complete draft to be discarded');
    await closeTypedFilter(f.c);
    assert.deepEqual(f.keys,['Escape']);assert.equal(f.panel(),null);
    assert.equal(await f.adapter.read('Typed.base'),source.replace('["red", "blue"]','["red"]'));assert.equal(await f.vault.read('A.md'),note);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('public close readiness rejects save errors, query changes, stale renders and unowned focus without input',async()=>{
  const f=await fixture();try{
    f.button('Filter').click();f.button('Remove item blue').focus();
    assert.equal(filterCloseReadiness(f.doc).ready,true);
    const session=f.host.querySelector<HTMLElement>('.bases-session')!,content=session.querySelector<HTMLElement>('.bases-session-content')!,grid=content.querySelector<HTMLElement>('[role="grid"]')!,alert=f.panel()!.querySelector<HTMLElement>('[role="alert"]')!;
    for(const[node,name,value]of [[content,'aria-busy','true'],[session,'data-base-controller-updating','true'],[session,'data-base-controller-error','true'],[grid,'data-base-rendered-version','999'],[session,'data-base-controller-version','not-a-version'],[f.button('Filter'),'aria-expanded','false']] as const){
      const previous=node.getAttribute(name);node.setAttribute(name,value);assert.equal(filterCloseReadiness(f.doc).ready,false,`${name} must be current`);if(previous===null)node.removeAttribute(name);else node.setAttribute(name,previous);
    }
    for(const message of ['Saving…','Could not apply: retained draft']){alert.textContent=message;assert.equal(filterCloseReadiness(f.doc).ready,false);}alert.textContent='';
    const focused=f.doc.activeElement as HTMLElement;focused.setAttribute('inert','');assert.equal(filterCloseReadiness(f.doc).ready,false);focused.removeAttribute('inert');
    const combo=f.panel()!.querySelector<HTMLElement>('[role="combobox"]')!;const expanded=combo.getAttribute('aria-expanded');combo.setAttribute('aria-expanded','true');assert.equal(filterCloseReadiness(f.doc).ready,false);if(expanded===null)combo.removeAttribute('aria-expanded');else combo.setAttribute('aria-expanded',expanded);
    f.button('Filter').focus();assert.equal(filterCloseReadiness(f.doc).ready,false,'outside focus cannot authorize a parent close');focused.focus();
    assert.equal(filterCloseReadiness(f.doc).ready,true);assert.deepEqual(f.keys,[]);
    f.panel()!.remove();assert.equal(filterCloseReadiness(f.doc).ready,false,'a retired panel cannot own the close key');
  }finally{await f.cleanup();}
});
