import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse} from 'yaml';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {UI} from './bases-electron-integration/ui.mjs';
import {closeMenu,editCondition} from './bases-electron-config-integration/controls.mjs';

const source='# Preserve this configuration fixture.\nfixtureSentinel: config-keep\nviews:\n  - type: table\n    name: Configuration\n    order:\n      - file.name\n      - note.score\n    sort:\n      - property: note.score\n        direction: ASC\n';
const note='---\nscore: 1\nstatus: Todo\nenabled: false\n---\nBody sentinel\n';
const tick=()=>new Promise<void>(done=>setTimeout(done,5));
async function until(check:()=>boolean|Promise<boolean>,label:string){for(let n=0;n<500;n++){if(await check())return;await tick();}assert.ok(await check(),label);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}

async function fixture(baseSource=source){
  const adapter=new MemoryAdapter({'Configuration.base':baseSource,'A.md':note,'Properties.yaml':'properties:\n  enabled:\n    type: checkbox\n  status:\n    type: text\n'}),vault=new Vault(adapter);await vault.initialize();
  const dom=new JSDOM('<section class="pane is-active"><main></main></section>',{pretendToBeVisual:true,runScripts:'outside-only'}),doc=dom.window.document,host=doc.querySelector('main')!;
  // JSDOM's selector engine lacks CSS :nth-child(N of selector). Resolve the
  // campaign's exact direct-child class subset against real DOM children;
  // other selectors still use the original engine without substitution.
  const query=doc.querySelector.bind(doc);
  doc.querySelector=((selector:string)=>{
    const match=/^(.*) > \.bases-filter-condition:nth-child\(([1-9]\d*) of \.bases-filter-condition\)(.*)$/.exec(selector);
    if(!match)return query(selector);
    const owner=query(match[1]),row=owner&&[...owner.children].filter(node=>node.classList.contains('bases-filter-condition'))[Number(match[2])-1];
    if(!row)return null;const suffix=match[3].trim();return suffix?row.querySelector(suffix.startsWith('>')?':scope '+suffix:suffix):row;
  }) as typeof doc.querySelector;
  const release=deferred(),buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],actions:unknown[]=[],keys:string[]=[],clicks:string[]=[];let holding=false,entered=false;
  const session=createBaseSession(host,{vault,basePath:'Configuration.base',validate(){},openFile(){},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});const owned=buffer,flush=buffer.flush.bind(buffer);buffer.flush=async()=>{await flush();if(holding&&path==='Configuration.base'&&owned.savedText.includes('direction: DESC')){entered=true;await release.promise;}};buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  const ui=new UI({evaluate:async(expression:string)=>structuredClone(dom.window.eval(expression)),async call(){throw new Error('Only the explicitly modelled public test inputs are allowed');}},actions);
  const wait=ui.wait.bind(ui);ui.wait=(body:string,label:string,timeout?:number)=>wait(body,label,Math.min(timeout??20000,1000));
  ui.key=async(key:string)=>{keys.push(key);assert.equal(key,'Escape');doc.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));};
  ui.idle=async()=>{await until(()=>host.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false','actual current session settles');};
  ui.select=async(selector:string,value:string)=>{const model=doc.querySelector<HTMLSelectElement>(selector);assert.ok(model,selector);assert.equal(model.tagName,'SELECT');model.value=value;model.dispatchEvent(new dom.window.Event('change',{bubbles:true}));const presented=model.hidden?model.nextElementSibling as HTMLElement:model;presented?.focus();};
  ui.type=async(selector:string,value:string)=>{const input=doc.querySelector<HTMLInputElement>(selector);assert.ok(input,selector);assert.notEqual(input.type,'checkbox','text insertion is not a checkbox activation');input.focus();input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  ui.click=async(selector:string)=>{const input=doc.querySelector<HTMLElement>(selector);assert.ok(input,selector);clicks.push(selector);input.focus();input.click();};
  const button=(label:string)=>{const element=doc.querySelector<HTMLButtonElement>(`button[aria-label=${JSON.stringify(label)}]`);assert.ok(element,label);return element;};
  await session.ready;await ui.idle();
  return{adapter,vault,dom,doc,host,session,button,errors,keys,clicks,c:{ui,evidence:{actions}},get entered(){return entered;},hold(){holding=true;},release(){holding=false;release.resolve();},
    async cleanup(){holding=false;release.resolve();const failures:unknown[]=[];const attempt=async(action:()=>unknown|Promise<unknown>)=>{try{await action();}catch(error){failures.push(error);}};await attempt(()=>until(()=>!session.hasPendingChanges(),'all real configuration operations settle'));await attempt(()=>session.close());for(const buffer of buffers.values())await attempt(()=>buffer.dispose());await attempt(()=>dom.window.close());if(failures.length)throw new AggregateError(failures,'Config fixture cleanup failed');}};
}

test('configuration close does not issue its parent key while the real saved sort acknowledgement is held',async()=>{
  const f=await fixture();let closing:Promise<void>|undefined;
  try{
    f.button('Sort').click();f.hold();await f.c.ui.select('[role="dialog"][aria-label="Sort"] select[aria-label="Sort direction"]','DESC');
    await until(()=>f.entered,'real configuration flush reaches its post-save tail');
    assert.equal(await f.adapter.read('Configuration.base'),source.replace('direction: ASC','direction: DESC'));assert.equal(await f.vault.read('Configuration.base'),await f.adapter.read('Configuration.base'));
    assert.equal(f.doc.querySelector('[role="dialog"] [role="alert"]')!.textContent,'Saving…');
    closing=closeMenu(f.c,'Sort');await tick();
    assert.deepEqual(f.keys,[],'readable exact bytes do not yet authorize the close key');
    f.release();await closing;assert.deepEqual(f.keys,['Escape']);assert.equal(f.doc.querySelector('[role="dialog"]'),null);assert.deepEqual(f.errors,[]);assert.equal(await f.vault.read('A.md'),note);
  }finally{f.release();await closing?.catch(()=>{});await f.cleanup();}
});

test('configuration text entry reaches the actual nested operand host',async()=>{
  const f=await fixture();try{
    f.button('Filter').click();const owner='[role="dialog"][aria-label="Filter"] .bases-filter-section:nth-of-type(2) .bases-filter-tree > .bases-filter-group';
    await editCondition(f.c,owner,0,'note.status','eq','Todo');
    assert.ok(f.doc.querySelector(`${owner} .bases-filter-operand-host input[aria-label="Filter value"]`),'real renderer wraps the operand');
    await closeMenu(f.c,'Filter');assert.deepEqual(parse(await f.vault.read('Configuration.base')).views[0].filters,{and:['note["status"] == "Todo"']});
    assert.equal(await f.vault.read('A.md'),note);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('configuration Boolean false is authored by real indeterminate checkbox activation',async()=>{
  const f=await fixture();try{
    f.button('Filter').click();const owner='[role="dialog"][aria-label="Filter"] .bases-filter-section:nth-of-type(2) .bases-filter-tree > .bases-filter-group';
    await editCondition(f.c,owner,0,'note.enabled','eq',false);
    await closeMenu(f.c,'Filter');assert.deepEqual(parse(await f.vault.read('Configuration.base')).views[0].filters,{and:['note["enabled"] == false']});
    assert.equal(f.clicks.length,2,'real checkbox activation first resolves indeterminate, then selects false');assert.equal(await f.vault.read('A.md'),note);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('configuration can close a complete Group draft on a real Kanban without a table marker',async()=>{
  const board=source.replace('type: table','type: kanban').replace('    sort:\n','    groupBy:\n      property: note.status\n      direction: ASC\n    sort:\n');
  const f=await fixture(board);try{
    assert.equal(f.host.querySelector('[role="grid"]'),null);assert.ok(f.host.querySelector('.bases-kanban-view'));
    f.button('Group').click();await f.c.ui.select('[role="dialog"][aria-label="Group"] select[aria-label="Group direction"]','DESC');
    assert.equal(await f.adapter.read('Configuration.base'),board,'the complete draft has not yet reached its debounce save');
    await closeMenu(f.c,'Group');assert.deepEqual(f.keys,['Escape']);assert.equal(f.doc.querySelector('[role="dialog"]'),null);
    assert.equal(parse(await f.vault.read('Configuration.base')).views[0].groupBy.direction,'DESC');assert.equal(await f.vault.read('A.md'),note);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('configuration layout recovery closes View options using its Views trigger from an unsupported renderer',async()=>{
  const unknown=source.replace('type: table','type: future-grid');const f=await fixture(unknown);try{
    assert.equal(f.host.querySelector('[role="grid"]'),null);assert.match(f.host.textContent!,/Unsupported base view/);
    f.button('Views').click();f.button('Configure view Configuration').click();
    await f.c.ui.select('[role="dialog"][aria-label="View options"] select[aria-label="Layout"]','table');
    await closeMenu(f.c,'View options');assert.deepEqual(f.keys,['Escape']);assert.equal(f.doc.querySelector('[role="dialog"]'),null);
    assert.equal(parse(await f.vault.read('Configuration.base')).views[0].type,'table');assert.ok(f.host.querySelector('[role="grid"]'));assert.equal(await f.vault.read('A.md'),note);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});
