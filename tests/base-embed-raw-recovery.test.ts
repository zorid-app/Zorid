import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseEmbedSessions} from '../src/ui/base-embed-sessions.ts';
import type {BaseEmbedRecoveryIdentity} from '../src/ui/base-embed-sessions.ts';
import {inlineBaseRequest} from '../src/bases/inline-base.ts';
import type {BaseSession,BaseSessionRawDraft} from '../src/bases/session.ts';

const target=()=>({sourcePath:'Source.md',targetPath:'Work.base',viewName:'Table',viewId:'table-view',targetIdentity:Symbol('base'),sourceIdentity:Symbol('note'),occurrence:{}});
const raw=()=>({kind:'table',origin:{entryId:'base-entry',path:'Work.base',source:'saved-base',viewId:'table-view'},table:{kind:'title',value:'Unsubmitted name'}} as unknown as BaseSessionRawDraft);
function fixture(document:Document,identity:BaseEmbedRecoveryIdentity={sourceEntryId:'source-entry',sourceRevision:'source-1',sourceText:'![[Work.base#Table]]',targetEntryId:'base-entry'}){
 const views:{input:HTMLInputElement;restored:readonly BaseSessionRawDraft[];settled:number;value:BaseSession}[]=[];
 const manager=new BaseEmbedSessions({recoveryHost:document.body,recoveryIdentity:()=>identity,create(root){
  const input=document.createElement('input');input.value='';root.append(input);
  const view={input,restored:[] as readonly BaseSessionRawDraft[],settled:0,value:undefined as unknown as BaseSession};
  view.value={ready:Promise.resolve(),state:{version:0,source:'saved-base',result:null,error:null},refresh:async()=>{},selectView:async()=>{},setCurrentFile:async()=>{},rebindViewName:()=>false,
   hasPendingChanges:()=>false,canRecoverAdmission:()=>true,prepareAdmissionRecovery:()=>({rawDrafts:[raw()],settle:async()=>{view.settled++;}}),
   restoreAdmissionDrafts:async(drafts:readonly BaseSessionRawDraft[])=>{view.restored=drafts;input.value='Unsubmitted name';return{restored:drafts,pending:[],conflicts:[]};},flush:async()=>{},close:async()=>{root.remove();}};
  views.push(view);return view.value;
 }});return{manager,views};
}

test('a unique embedded raw draft restores through a new saved actor binding without sharing the old session',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc),fresh=fixture(doc,{sourceEntryId:'source-entry',sourceRevision:'source-2',sourceText:'![[Work.base#Table]]',targetEntryId:'base-entry'});
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;
  const captured=old.manager.prepareAdmissionRecovery();assert.equal(captured.rawDrafts?.length,1,'capture exposes component-owned raw state');await captured.settle();assert.equal(old.views[0].settled,1);
  await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;
  const result=await fresh.manager.restoreAdmissionDrafts(captured.rawDrafts!);
  assert.equal(result.restored.length,1);assert.deepEqual(result.pending,[]);assert.deepEqual(result.conflicts,[]);assert.equal(fresh.views[0].restored.length,1);assert.notEqual(fresh.views[0].value,old.views[0].value);assert.equal(fresh.views[0].input.value,'Unsubmitted name');
 }finally{await old.manager.close();await fresh.manager.close();dom.window.close();}
});

for(const field of ['sourceEntryId','targetEntryId','sourceText'] as const)test(`a changed ${field} preserves the raw candidate instead of choosing a same-path replacement`,async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc),identity={sourceEntryId:'source-entry',sourceRevision:'source-1',sourceText:'![[Work.base#Table]]',targetEntryId:'base-entry',[field]:'replacement'},fresh=fixture(doc,identity);
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();await captured.settle();await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;
  const result=await fresh.manager.restoreAdmissionDrafts(captured.rawDrafts);assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft,captured.rawDrafts[0]);assert.deepEqual(result.restored,[]);assert.deepEqual(fresh.views[0].restored,[]);assert.equal(fresh.views[0].input.value,'');
 }finally{await old.manager.close();await fresh.manager.close();dom.window.close();}
});

test('identical ordinary embeds are retained as ambiguous rather than assigning raw input by remount order',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc),fresh=fixture(doc);
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;await old.manager.mount(target(),doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();assert.equal(captured.rawDrafts.length,2);await captured.settle();
  await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;
  const result=await fresh.manager.restoreAdmissionDrafts(captured.rawDrafts);assert.equal(result.conflicts.length,2);assert.deepEqual(result.restored,[]);assert.ok(fresh.views.every(view=>view.restored.length===0));
 }finally{await old.manager.close();await fresh.manager.close();dom.window.close();}
});

test('different inline source spans restore only their exact fresh occurrence',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc),fresh=fixture(doc),block='```base\nviews: []\n```',source=block+'\n\n'+block;
 const first={...target(),inline:inlineBaseRequest(source,0,block.length)!},second={...target(),inline:inlineBaseRequest(source,block.length+2,source.length)!};
 try{
  await old.manager.mount(first,doc.querySelector('main')!).ready;await old.manager.mount(second,doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();await captured.settle();
  await fresh.manager.mount({...second,sourceIdentity:Symbol(),targetIdentity:Symbol()},doc.querySelector('aside')!).ready;await fresh.manager.mount({...first,sourceIdentity:Symbol(),targetIdentity:Symbol()},doc.querySelector('aside')!).ready;
  const result=await fresh.manager.restoreAdmissionDrafts(captured.rawDrafts);assert.equal(result.restored.length,2);assert.deepEqual(result.conflicts,[]);assert.equal(fresh.views[1].restored[0],captured.rawDrafts[0].draft);assert.equal(fresh.views[0].restored[0],captured.rawDrafts[1].draft);
 }finally{await old.manager.close();await fresh.manager.close();dom.window.close();}
});

test('an unmounted fresh occurrence stays externally pending and ready mount requests a checked retry',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc);let ready=0;const views:BaseSessionRawDraft[][]=[];
 const fresh=new BaseEmbedSessions({recoveryHost:doc.body,recoveryIdentity:()=>({sourceEntryId:'source-entry',sourceText:'![[Work.base#Table]]',targetEntryId:'base-entry'}),onAdmissionRestoreReady(){ready++;},create:()=>({ready:Promise.resolve(),state:{version:0,source:'',result:null,error:null},refresh:async()=>{},selectView:async()=>{},setCurrentFile:async()=>{},rebindViewName:()=>false,hasPendingChanges:()=>false,flush:async()=>{},close:async()=>{},restoreAdmissionDrafts:async drafts=>{views.push([...drafts]);return{restored:drafts,pending:[],conflicts:[]};}})});
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();await captured.settle();
  const pending=await fresh.restoreAdmissionDrafts(captured.rawDrafts);assert.deepEqual(pending.pending,captured.rawDrafts);assert.equal(views.length,0);
  await fresh.mount(target(),doc.querySelector('aside')!).ready;assert.equal(ready,1);const result=await fresh.restoreAdmissionDrafts(pending.pending);assert.equal(result.restored.length,1);assert.equal(views.length,1);
  await fresh.restoreAdmissionDrafts(captured.rawDrafts);assert.equal(views.length,1,'a repeated same-owner receipt must not invoke the fresh component again');
 }finally{await old.manager.close();await fresh.close();dom.window.close();}
});

test('a saved actor change during fresh raw restore cannot publish a stale acceptance receipt',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc),identity={sourceEntryId:'source-entry',sourceRevision:'source-1',sourceText:'![[Work.base#Table]]',targetEntryId:'base-entry'},fresh=fixture(doc,identity);let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();await captured.settle();await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;
  fresh.views[0].value.restoreAdmissionDrafts=async drafts=>{entered();await held;return{restored:drafts,pending:[],conflicts:[]};};
  const restoring=fresh.manager.restoreAdmissionDrafts(captured.rawDrafts);await started;identity.sourceEntryId='new-source-entry';release();
  const result=await restoring;assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft,captured.rawDrafts[0]);assert.deepEqual(result.restored,[]);
 }finally{release?.();await old.manager.close();await fresh.manager.close();dom.window.close();}
});

test('a deleted embedded actor is retained as conflict even before a fresh renderer can mount',async()=>{
 const dom=new JSDOM('<main></main>'),doc=dom.window.document,old=fixture(doc),fresh=new BaseEmbedSessions({recoveryHost:doc.body,recoveryIdentity:()=>undefined,create(){throw Error('a deleted target cannot create a renderer');}});
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();await captured.settle();
  const result=await fresh.restoreAdmissionDrafts(captured.rawDrafts);assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft,captured.rawDrafts[0]);assert.deepEqual(result.pending,[]);assert.deepEqual(result.restored,[]);
 }finally{await old.manager.close();await fresh.close();dom.window.close();}
});

test('a duplicate mounted during raw restoration cannot publish an unambiguous acceptance receipt',async()=>{
 const dom=new JSDOM('<main></main><aside></aside>'),doc=dom.window.document,old=fixture(doc),fresh=fixture(doc);let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 try{
  await old.manager.mount(target(),doc.querySelector('main')!).ready;const captured=old.manager.prepareAdmissionRecovery();await captured.settle();await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;
  fresh.views[0].value.restoreAdmissionDrafts=async drafts=>{entered();await held;return{restored:drafts,pending:[],conflicts:[]};};
  const restoring=fresh.manager.restoreAdmissionDrafts(captured.rawDrafts);await started;await fresh.manager.mount(target(),doc.querySelector('aside')!).ready;release();
  const result=await restoring;assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].draft,captured.rawDrafts[0]);assert.deepEqual(result.restored,[]);
 }finally{release?.();await old.manager.close();await fresh.manager.close();dom.window.close();}
});
