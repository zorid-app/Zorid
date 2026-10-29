import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {DocumentSemanticsError} from '../src/core/document-semantics.ts';
import type {DocumentEntry, DocumentPage, DocumentPin, DocumentRelationshipPage, DocumentService, DocumentSnapshotId, DocumentStatus} from '../src/core/document-semantics.ts';
import {mountDocumentBacklinks} from '../src/ui/document-backlinks.ts';
import type {DocumentBacklinksOptions} from '../src/ui/document-backlinks.ts';

const target={id:'target',path:'Target.md'},source={localStoreId:'store',watermark:'1'};
const snapshot=(generation='1'):DocumentSnapshotId=>({localStoreId:'store',generationEpoch:'epoch',generation,versions:{schema:1,extraction:'md',resolver:'r',query:'q'}});
const entry=(id:string):DocumentEntry=>({id,path:`${id}.md`,revision:`${id}-revision`,kind:'file',deleted:false});
function page(generation='1',sources:readonly DocumentEntry[]=[entry('Linked')],coverage=true):DocumentPage<DocumentRelationshipPage>{
  return{cursor:null,result:{snapshot:snapshot(generation),source,coverageComplete:coverage,value:{snapshot:snapshot(generation),next:null,scanComplete:true,coverageComplete:coverage,complete:coverage,
    edges:sources.map(item=>({source:item,target:{...entry(target.id),path:target.path},linkIndex:0,link:{kind:'wiki',embed:false,target:'Target',fragment:'',destination:'Target',range:{bytes:[0,10],utf16:[0,10]},targetRange:{bytes:[2,8],utf16:[2,8]},definitionRange:null}}))}}};
}
function fixture(){
  const calls:string[]=[],pins:{pin:DocumentPin;closes:number}[]=[];
  let current='1',coverage=true,sources:readonly DocumentEntry[]=[entry('Linked')],openError:string|undefined,readError:string|undefined;
  let opening:(()=>Promise<void>)|undefined,closing:(()=>Promise<void>)|undefined;
  const unexpected=(name:string)=>async():Promise<never>=>{calls.push(name);throw Error(`Unexpected ${name}`);};
  const status:DocumentStatus={source,snapshot:snapshot(),coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true};
  const service:DocumentService={status:async()=>{calls.push('status');return status;},initialize:unexpected('initialize'),rebuild:unexpected('rebuild'),begin:unexpected('begin'),pump:unexpected('pump'),publish:unexpected('publish'),discard:unexpected('discard'),
    open:async()=>{
      calls.push('open');await opening?.();if(openError)throw new DocumentSemanticsError(openError);
      const generation=current,selected=sources,covered=coverage,owner={pin:null as unknown as DocumentPin,closes:0};
      const unused=unexpected('other-query');owner.pin={pinId:`pin-${pins.length}` as DocumentPin['pinId'],snapshot:snapshot(generation),source,coverageComplete:covered,
        close:async()=>{calls.push('close');owner.closes++;await closing?.();},
        backlinks:async()=>{calls.push('backlinks');if(readError)throw new DocumentSemanticsError(readError);return page(generation,selected,covered);},metadata:unused,search:unused,base:unused};
      pins.push(owner);return owner.pin;
    },maintenance:{observeAndSubscribe:unexpected('observeAndSubscribe'),requestFreshness(){calls.push('requestFreshness');throw Error('Unexpected freshness demand');}}};
  return{service,calls,pins,publish(generation:string,rows:readonly DocumentEntry[]){current=generation;sources=rows;},incomplete(){coverage=false;sources=[];},empty(){sources=[];},failOpen(code:string){openError=code;},failRead(code?:string){readError=code;},holdOpen(gate:()=>Promise<void>){opening=gate;},holdClose(gate:()=>Promise<void>){closing=gate;}};
}
function mount(t:TestContext,f:ReturnType<typeof fixture>,options:Partial<DocumentBacklinksOptions>={}){
  const dom=new JSDOM('<main></main>'),container=dom.window.document.querySelector<HTMLElement>('main')!;
  const view=mountDocumentBacklinks(container,{service:f.service,target,vaultIdentity:'vault',isCurrent:()=>true,onOpenStableEntry(){},freshness:'observe',...options});
  t.after(()=>{view.dispose();dom.window.close();});return{dom,container,view};
}
const maintenanceCalls=(calls:readonly string[])=>calls.filter(name=>!['open','backlinks','close'].includes(name));

test('passive backlinks read an admitted saved pin without status, freshness, or maintenance work',async t=>{
  const f=fixture(),ui=mount(t,f);await ui.view.ready;
  assert.deepEqual(f.calls,['open','backlinks','close']);assert.equal(f.pins[0].closes,1);
  assert.equal(ui.view.element.dataset.state,'historical');assert.match(ui.container.textContent!,/saved snapshot/i);
  assert.equal(ui.container.querySelector('[data-entry-id]')?.getAttribute('data-entry-id'),'Linked');assert.doesNotMatch(ui.container.textContent!,/Continue indexing/);
});
test('caller publication refresh replaces its prior pin and saved rows without requesting maintenance',async t=>{
  const f=fixture(),ui=mount(t,f);await ui.view.ready;f.publish('2',[entry('Published')]);
  await ui.view.refresh();assert.deepEqual(f.calls,['open','backlinks','close','open','backlinks','close']);
  assert.deepEqual(f.pins.map(owner=>owner.closes),[1,1]);assert.match(ui.container.textContent!,/Published/);assert.doesNotMatch(ui.container.textContent!,/Linked\.md/);
  assert.equal(ui.view.element.dataset.state,'historical');assert.deepEqual(maintenanceCalls(f.calls),[]);
});
for(const coverage of ['complete','incomplete'] as const)test(`passive ${coverage} zero matches never claim a current empty result`,async t=>{
  const f=fixture();if(coverage==='incomplete')f.incomplete();else f.empty();const ui=mount(t,f);await ui.view.ready;
  assert.equal(ui.view.element.dataset.state,coverage==='incomplete'?'incomplete':'historical');assert.match(ui.container.textContent!,/saved snapshot/i);
  assert.doesNotMatch(ui.container.textContent!,/No backlinks found|Continue indexing/);if(coverage==='incomplete')assert.match(ui.container.textContent!,/may be missing/);
  assert.deepEqual(maintenanceCalls(f.calls),[]);
});
for(const code of ['not_ready','index_not_ready','stale_source'] as const)test(`passive ${code} remains updating without a manual indexing demand`,async t=>{
  const f=fixture();f.failOpen(code);const ui=mount(t,f);await ui.view.ready;
  assert.equal(ui.view.element.dataset.state,'indexing');assert.match(ui.container.textContent!,/updating/i);assert.equal(ui.container.querySelector('button'),null);assert.deepEqual(maintenanceCalls(f.calls),[]);
});
for(const code of ['snapshot_expired','document_invalid_response','rebuild_required'] as const)test(`passive ${code} stays honest and actionable with exact pin cleanup`,async t=>{
  const f=fixture();f.failRead(code);const ui=mount(t,f);await ui.view.ready;
  assert.equal(ui.view.element.dataset.state,'unavailable');assert.equal(ui.container.querySelector('[role="alert"]')?.textContent?.length!>0,true);
  assert.ok(ui.container.querySelector('button'));assert.doesNotMatch(ui.container.textContent!,/No backlinks found|Continue indexing/);assert.equal(f.pins[0].closes,1);assert.deepEqual(maintenanceCalls(f.calls),[]);
});
test('default and explicit request mode keep their existing freshness demand path',async t=>{
  for(const freshness of [undefined,'request'] as const){
    const f=fixture();Object.assign(f.service,{maintenance:undefined});f.empty();const ui=mount(t,f,{freshness});await ui.view.ready;
    assert.deepEqual(f.calls,['status','open','backlinks','status','close']);assert.equal(ui.view.element.dataset.state,'empty');assert.match(ui.container.textContent!,/No backlinks found/);
  }
});
test('a cancelled passive open closes its late pin without installing stale rows',async t=>{
  const f=fixture();Object.assign(f.service,{maintenance:undefined});let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.holdOpen(async()=>{entered();await gate;});const ui=mount(t,f),ready=ui.view.ready;await started;ui.view.dispose();release();await ready;
  assert.deepEqual(f.calls,['open','close']);assert.equal(f.pins[0].closes,1);assert.equal(ui.container.children.length,0);
});
for(const mismatch of ['scope','snapshot'] as const)test(`passive ${mismatch} mismatch rejects the report without installing its rows`,async t=>{
  const f=fixture(),open=f.service.open;
  f.service.open=async()=>{const pin=await open();return mismatch==='scope'?{...pin,source:{...source,localStoreId:'foreign'}}:{...pin,backlinks:async()=>page('2')};};
  const ui=mount(t,f);await ui.view.ready;assert.equal(ui.view.element.dataset.state,'unavailable');assert.equal(ui.container.querySelector('[data-entry-id]'),null);
  assert.equal(f.pins[0].closes,1);assert.deepEqual(maintenanceCalls(f.calls),[]);
});
test('passive refresh retries its retained close before another pin can open',async t=>{
  const f=fixture();let attempts=0;f.holdClose(async()=>{if(++attempts===1)throw Error('Transient close failure');});
  const ui=mount(t,f);await ui.view.ready;assert.equal(ui.view.element.dataset.state,'unavailable');
  await ui.view.refresh();assert.deepEqual(f.calls,['open','backlinks','close','close','open','backlinks','close']);assert.equal(ui.view.element.dataset.state,'historical');assert.deepEqual(f.pins.map(owner=>owner.closes),[2,1]);
});
test('only an explicit corruption rebuild action overrides passive observation with foreground maintenance',async t=>{
  const f=fixture();Object.assign(f.service,{maintenance:undefined});f.failRead('rebuild_required');
  const ui=mount(t,f);await ui.view.ready;assert.deepEqual(maintenanceCalls(f.calls),[]);
  f.failRead();f.service.rebuild=async()=>{f.calls.push('rebuild');};
  const rebuild=[...ui.container.querySelectorAll('button')].find(button=>button.textContent==='Rebuild index');assert.ok(rebuild);rebuild.click();await ui.view.ready;
  assert.equal(f.calls.filter(call=>call==='rebuild').length,1);assert.equal(ui.view.element.dataset.state,'ready');
});
