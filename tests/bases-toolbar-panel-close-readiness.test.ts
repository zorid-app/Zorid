import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {UI} from './bases-electron-integration/ui.mjs';
import {closeAcknowledgedToolbarPanel,filterCloseReadiness} from './bases-electron-filter-integration/close-readiness.mjs';

const source='fixtureSentinel: keep\nviews:\n  - name: Source\n    type: table\n    order: [ file.name, note.sourceA ]\n';
const tall=source+'    rowHeight: tall\n';
const note='---\nsourceA: L0\nuntouched: keep\n---\nKeep this source body.\n';
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
async function until(check:()=>boolean|Promise<boolean>,label:string){for(let n=0;n<500;n++){if(await check())return;await tick();}assert.ok(await check(),label);}

async function fixture(){
 const adapter=new MemoryAdapter({'Clipboard.base':source,'Source 01.md':note,'Properties.yaml':'properties:\n  sourceA: {type: text}\n'}),vault=new Vault(adapter);await vault.initialize();
 const dom=new JSDOM('<section class="pane is-active"><main></main></section>',{pretendToBeVisual:true,runScripts:'outside-only'}),doc=dom.window.document,host=doc.querySelector('main')!;
 const buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],actions:any[]=[],keys:string[]=[];let holding=true,entered=false,release!:()=>void;const tail=new Promise<void>(resolve=>{release=resolve;});
 const session=createBaseSession(host,{vault,basePath:'Clipboard.base',validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});const flush=buffer.flush.bind(buffer),owned=buffer;buffer.flush=async()=>{await flush();if(holding&&path==='Clipboard.base'&&owned.savedText.includes('rowHeight: tall')){entered=true;await tail;}};buffers.set(path,buffer);}await buffer.load();return buffer;}}});
 const button=(label:string)=>{const element=doc.querySelector<HTMLButtonElement>(`button[aria-label=${JSON.stringify(label)}]`);assert.ok(element,label);return element;};
 const panel=()=>doc.querySelector<HTMLElement>('[role="dialog"][aria-label="View options"]');
 const ui=new UI({evaluate:async(expression:string)=>structuredClone(dom.window.eval(expression)),async call(){throw Error('Acknowledgement readiness cannot inject input');}},actions);
 const wait=ui.wait.bind(ui);ui.wait=(body:string,label:string,timeout?:number)=>wait(body,label,Math.min(timeout??20000,3000));
 ui.key=async key=>{keys.push(key);assert.equal(key,'Escape');doc.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));};
 await session.ready;await until(()=>host.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false','initial saved table');
 return {adapter,vault,dom,doc,host,session,errors,actions,keys,button,panel,c:{ui,evidence:{actions}},get entered(){return entered;},release(){holding=false;release();},async cleanup(){holding=false;release();await until(()=>!session.hasPendingChanges(),'finish real operations');await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('a durable Tall setting waits for its real acknowledgement before one Escape closes View options',async()=>{
 const f=await fixture();let closing:Promise<void>|undefined;
 try{
  f.button('Views').click();f.button('Configure view Source').click();
  const rowHeight=f.panel()!.querySelector<HTMLSelectElement>('select[aria-label="Row height"]')!;assert.ok(rowHeight);
  rowHeight.value='tall';rowHeight.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
  (rowHeight.nextElementSibling as HTMLButtonElement).focus();
  await until(()=>f.entered,'the real durable write reaches its acknowledgement tail');
  assert.equal(await f.adapter.read('Clipboard.base'),tall);assert.equal(await f.vault.read('Clipboard.base'),tall);
  assert.equal(f.host.querySelector('.bases-session-content')!.getAttribute('aria-busy'),'true');assert.equal(f.panel()!.querySelector('[role="alert"]')!.textContent,'Saving…');
  for(let attempt=0;attempt<3;attempt++){const early=new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});f.doc.activeElement!.dispatchEvent(early);assert.equal(early.defaultPrevented,false);assert.ok(f.panel(),'A bounded number of early close keys is not an acknowledged close');}
  assert.equal(filterCloseReadiness(f.doc,'View options','Views').ready,false);
  closing=closeAcknowledgedToolbarPanel(f.c,{panelName:'View options',triggerLabel:'Views',action:'clipboard-view-options-close-ready'});
  await tick();assert.deepEqual(f.keys,[],'Readable saved bytes cannot authorize another close key while the save is pending');
  f.release();await closing;
  assert.deepEqual(f.keys,['Escape']);assert.equal(f.panel(),null);assert.equal(await f.vault.read('Clipboard.base'),tall);assert.equal(await f.vault.read('Source 01.md'),note);
  assert.equal(f.host.querySelector<HTMLElement>('.zorid-bases-table')!.style.getPropertyValue('--zorid-base-row-height'),'120px');assert.deepEqual(f.errors,[]);
  const receipt=f.actions.find(action=>action.action==='clipboard-view-options-close-ready');assert.equal(receipt.ready,true);assert.equal(receipt.panelName,'View options');assert.equal(receipt.triggerLabel,'Views');assert.equal(receipt.requireTable,true);
 }finally{f.release();await closing?.catch(()=>{});await f.cleanup();}
});

test('non-table closing is an explicit opt-out and still rejects any stale table that is present',()=>{
 const dom=new JSDOM('<section class="pane is-active"><div class="bases-session" data-base-controller-version="4" data-base-controller-updating="false" data-base-controller-error="false"><button aria-label="Group" aria-expanded="true"></button><div class="bases-session-content" aria-busy="false"></div></div></section><section role="dialog" aria-label="Group"><button id="focused">Done</button><div role="alert"></div></section>'),doc=dom.window.document;
 try{
  doc.querySelector<HTMLButtonElement>('#focused')!.focus();
  assert.equal(filterCloseReadiness(doc,'Group','Group').ready,false,'The default does not waive the table requirement');
  assert.equal(filterCloseReadiness(doc,'Group','Group',0 as unknown as boolean).ready,false,'Falsy non-Boolean values cannot weaken the default');
  const frame=()=>filterCloseReadiness(doc,'Group','Group',false);assert.equal(frame().ready,true);assert.equal(frame().gridPresent,false);
  const content=doc.querySelector('.bases-session-content')!,table=doc.createElement('div');table.setAttribute('role','grid');table.setAttribute('data-base-rendered-version','3');content.append(table);assert.equal(frame().ready,false,'Opting out never accepts a stale table that is actually mounted');table.setAttribute('data-base-rendered-version','4');assert.equal(frame().ready,true);
  for(const [element,attribute,value]of [[content,'aria-busy','true'],[doc.querySelector('.bases-session')!,'data-base-controller-updating','true'],[doc.querySelector('.bases-session')!,'data-base-controller-error','true'],[doc.querySelector('button[aria-label="Group"]')!,'aria-expanded','false']]as const){const before=element.getAttribute(attribute);element.setAttribute(attribute,value);assert.equal(frame().ready,false,attribute);if(before===null)element.removeAttribute(attribute);else element.setAttribute(attribute,before);}
  const panel=doc.querySelector('[role="dialog"]')!,completion=doc.createElement('div');completion.className='cm-tooltip-autocomplete';panel.append(completion);assert.equal(frame().ready,false);completion.remove();
  panel.querySelector('[role="alert"]')!.textContent='Could not save';assert.equal(frame().ready,false);panel.querySelector('[role="alert"]')!.textContent='';assert.equal(frame().ready,true);
 }finally{dom.window.close();}
});

test('one scoped child popup Escape precedes the acknowledged parent close and final absence assertion',async()=>{
 const dom=new JSDOM('<section class="pane is-active"><div class="bases-session" data-base-controller-version="4" data-base-controller-updating="false" data-base-controller-error="false"><button aria-label="Views" aria-expanded="true"></button><div class="bases-session-content" aria-busy="false"><div role="grid" data-base-rendered-version="4"></div></div></div></section><section role="dialog" aria-label="View options"><button id="focused" role="combobox" aria-expanded="true">Row height</button><div role="listbox">Tall</div></section>',{runScripts:'outside-only'}),doc=dom.window.document,actions:any[]=[],keys:string[]=[],waits:string[]=[];
 try{
  const panel=doc.querySelector('[role="dialog"]')!,focused=doc.querySelector<HTMLButtonElement>('#focused')!;focused.focus();(doc.querySelector('[role="listbox"]') as HTMLElement).getClientRects=()=>[{} as DOMRect]as unknown as DOMRectList;
  const evaluate=(body:string)=>structuredClone(dom.window.eval(`(()=>{${body}})()`));
  const c={evidence:{actions},ui:{dom:async(body:string)=>evaluate(body),async wait(body:string,label:string){waits.push(label);const result=evaluate(body);assert.ok(result,label);return result;},async key(key:string){keys.push(key);assert.equal(key,'Escape');if(keys.length===1){doc.querySelector('[role="listbox"]')!.remove();focused.setAttribute('aria-expanded','false');}else panel.remove();}}};
  await closeAcknowledgedToolbarPanel(c,{panelName:'View options',triggerLabel:'Views',action:'clipboard-view-options-close-ready'});
  assert.deepEqual(keys,['Escape','Escape']);assert.deepEqual(waits,['Current View options close input is settled','View options closes after acknowledgement']);assert.equal(actions.length,1);assert.equal(actions[0].ready,true);assert.equal(doc.querySelector('[role="dialog"]'),null);
 }finally{dom.window.close();}
});
