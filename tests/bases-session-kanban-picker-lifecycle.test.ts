import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse} from 'yaml';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import type {DocumentBaseResult,DocumentService} from '../src/core/document-semantics.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';

const original='---\nstatus: "Working" # keep this comment\npriority: High\n---\nKeep body 🌱 exactly.\n';
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,8));
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await tick();}assert.ok(await check());}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}

async function fixture(){
  class Adapter extends MemoryAdapter {
    documentSemantics?:DocumentService;
    revisions=new Map<string,number>();writes=0;
    identify<T extends {path:string}>(row:T){return {...row,entryId:row.path,revision:'r'+(this.revisions.get(row.path)??1)};}
    override async list(){return (await super.list()).map(row=>this.identify(row));}
    override async stat(path:string){const row=await super.stat(path);return row&&this.identify(row);}
    override async write(path:string,text:string){await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);if(path==='Items/Alpha.md')this.writes++;}
  }
  const base='views:\n  - type: list\n    name: List\n    order: [file.name, status, priority]\n  - type: kanban\n    name: Board\n    order: [file.name, status, priority]\n    groupBy: {property: status, direction: ASC}\n';
  const adapter=new Adapter({'Work.base':base,'Items/Alpha.md':original,'Properties.yaml':'properties:\n  status:\n    type: status\n    options:\n      - {value: Working, category: in-progress}\n      - {value: Complete, category: done}\n  priority:\n    type: select\n    options: [{value: High}]\n'});
  const source={localStoreId:'store',watermark:'1'},snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}};
  type Frame={entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};let frame:Frame|undefined;const gates=new Set<Frame>();
  const unused=async():Promise<never>=>{throw Error('Unexpected transport operation');};
  adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>({pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async id=>{const row=(await adapter.stat(id))!;return {source,snapshot,coverageComplete:true,value:{entry:{id:row.entryId,revision:row.revision,path:row.path,kind:'file' as const,deleted:false},metadata:null,exclusion:null}};},
      base:async input=>{
        const pending=frame;if(pending){frame=undefined;pending.entered.resolve();await pending.release.promise;}
        // Echo a sealed core transport frame. No TS predicate/group evaluation:
        // the fixture publishes exactly its two configured status destinations.
        const document=BaseDocument.parse(await adapter.read('Work.base')),view=document.views[input.options?.viewIndex??0];
        const raw=parse((await adapter.read('Items/Alpha.md')).match(/^---\n([\s\S]*?)\n---/)![1]) as {status:string;priority:string};
        const identity=(await adapter.stat('Items/Alpha.md'))!,definition=(await adapter.stat('Work.base'))!;
        const row={entryId:identity.entryId,revision:identity.revision,path:identity.path,values:{'file.name':{type:'string' as const,value:'Alpha'},'note.status':{type:'string' as const,value:raw.status},'note.priority':{type:'string' as const,value:raw.priority}}};
        const groups=view.type==='kanban'?['Working','Complete'].map(name=>({key:{type:'string' as const,value:name},keyId:name,editKey:name,entryIds:raw.status===name?[identity.entryId]:[]})):[{key:null,keyId:null,entryIds:[identity.entryId]}];
        const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[row],groups,groupOptions:[],properties:['file.name','note.status','note.priority'],availableProperties:['file.name','note.status','note.priority'],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1};
        return {source,snapshot,coverageComplete:true,value:{definition:{id:definition.entryId,revision:definition.revision,path:definition.path,kind:'file' as const,deleted:false},result}};
      }})};
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector<HTMLElement>('main')!;
  const resize=new Map<object,()=>void>();
  class ResizeObserver {callback:()=>void;constructor(callback:()=>void){this.callback=callback;}observe(){resize.set(this,this.callback);}unobserve(){}disconnect(){resize.delete(this);}}
  Object.defineProperty(dom.window,'ResizeObserver',{value:ResizeObserver,configurable:true});
  const frames=new Map<number,FrameRequestCallback>();let nextFrame=0;
  dom.window.requestAnimationFrame=callback=>{frames.set(++nextFrame,callback);return nextFrame;};dom.window.cancelAnimationFrame=id=>{frames.delete(id);};
  const buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],opened:string[]=[];
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile:path=>{opened.push(path);},onError:error=>errors.push(error),buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:'r'+(adapter.revisions.get(path)??1)})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  await session.ready;await session.selectView(1);assert.ifError(session.state.error);
  const status=()=>host.querySelector<HTMLElement>('.bases-kanban-card[data-path="Items/Alpha.md"] .bases-metadata-value[data-property="note.status"]')!;
  const click=(node:HTMLElement)=>{node.focus();node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true,button:0}));};
  const key=(node:Element,value:string)=>node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
  return {adapter,vault,dom,doc,host,session,status,click,key,errors,opened,
    delayFrame(){assert.equal(frame,undefined);const pending={entered:deferred(),release:deferred()};frame=pending;gates.add(pending);return pending;},
    async paint(){for(const callback of [...resize.values()])callback();const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(0);await tick();},
    async cleanup(){for(const pending of gates)pending.release.resolve();for(const input of doc.querySelectorAll('.bases-property-popover input'))key(input,'Escape');await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('first enabled Kanban status picker survives ordinary paints, prevents row navigation and publishes a saved destination',async()=>{
  const f=await fixture();try{
    const cell=f.status();assert.equal(cell.getAttribute('aria-disabled'),'false');f.click(cell);
    const input=f.doc.querySelector<HTMLInputElement>('.bases-property-popover input[role="combobox"]');assert.ok(input);assert.equal(f.doc.activeElement,input);assert.equal(cell.dataset.baseEditing,'draft');
    const drag=new f.dom.window.Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(drag,'dataTransfer',{value:{}});cell.closest('.bases-kanban-card')!.dispatchEvent(drag);assert.equal(drag.defaultPrevented,true,'An owned picker draft cannot turn into a card drag');
    f.host.querySelector('.bases-kanban-view')!.dispatchEvent(new f.dom.window.Event('scroll'));f.host.querySelector('.bases-kanban-column-body')!.dispatchEvent(new f.dom.window.Event('scroll'));await f.paint();
    assert.equal(f.status(),cell);assert.equal(f.doc.activeElement,input);assert.deepEqual(f.opened,[]);assert.equal(f.adapter.writes,0);
    input.value='Complete';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.key(input,'Enter');
    await until(async()=>await f.vault.read('Items/Alpha.md')===original.replace('"Working"','"Complete"'));
    await until(()=>f.status()?.closest('[role="listbox"]')?.getAttribute('aria-label')==='Complete');assert.deepEqual(f.errors,[]);assert.deepEqual(f.opened,[]);
  }finally{await f.cleanup();}
});

test('ordinary Kanban paint retires a pre-click DOM node; the retained stale node cannot activate or navigate',async()=>{
  const f=await fixture();try{
    const stale=f.status();await f.paint();assert.equal(stale.isConnected,false);assert.notEqual(f.status(),stale);f.click(stale);
    assert.equal(f.doc.querySelector('.bases-property-popover'),null);assert.equal(f.adapter.writes,0);assert.deepEqual(f.opened,[]);
    f.click(f.status());assert.ok(f.doc.querySelector('.bases-property-popover input'));assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('query-pending Kanban field rejects activation without a draft or save, then a fresh enabled field admits its own explicit click',async()=>{
  const f=await fixture();try{
    const pending=f.delayFrame(),refresh=f.session.setCurrentFile('Items/Alpha.md');await pending.entered.promise;
    const blocked=f.status();assert.equal(f.host.querySelector('.bases-session-content')?.getAttribute('aria-busy'),'true');assert.equal(blocked.getAttribute('aria-disabled'),'true');f.click(blocked);
    assert.equal(f.doc.querySelector('.bases-property-popover'),null);assert.equal(blocked.dataset.baseEditing,undefined);assert.equal(f.adapter.writes,0);assert.deepEqual(f.opened,[]);
    pending.release.resolve();await refresh;await until(()=>f.status()?.getAttribute('aria-disabled')==='false');f.click(f.status());assert.ok(f.doc.querySelector('.bases-property-popover input'));assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});
