import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopIndependentDraftProvider} from '../src/platform/desktop-independent-drafts.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
import {startJournalApp} from './helpers/desktop-journal-app.cjs';
import type {DesktopBridge} from '../src/platform/bridge.ts';
import type {IndependentDraftChange} from '../src/core/independent-drafts.ts';
const scope={vaultId:'vault-one',clientId:'client-one',incarnationId:'document-one'},grant={token:'opaque-token',scope};
const change=():IndependentDraftChange=>({entryId:'entry-one',writer:'writer-one',generation:1,expectedRevision:null,nextRevision:'1',baseline:{entryId:'entry-one',path:'Note.md',revision:'source-one',content:'Original'},draft:'Exact raw draft 🌱\ud800',checkpointRevision:null,pendingOperation:null});
const envelope=(value:unknown)=>({independentJournal:true,schemaVersion:1,ok:true,value});
const receipt={...scope,entryId:'entry-one',writer:'writer-one',revision:'1',generation:1,deleted:false};

test('actual main/preload/platform provider retries a lost journal ACK with exact request identity and bytes',async t=>{
  const f=await startJournalApp(t),previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:f.bridge}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  const platform=(await createPlatformAdapter())!,provider=platform.adapter.independentDrafts!;assert.ok(provider);assert.equal(f.openCount,0);assert.deepEqual(f.journalRequests,[],'adapter construction never scans journal');
  f.loseReply();const input=change();await assert.rejects(provider.compareAndSwap(input),{code:'draft_transport_lost',commitUncertain:true});
  const saved=await provider.compareAndSwap(input);assert.deepEqual(f.journalRequests[0],f.journalRequests[1]);assert.equal(saved.revision,'1');assert.equal(saved.deleted,false);
  const selected=await provider.list({entryId:'entry-one'});assert.deepEqual(selected,[saved]);assert.deepEqual(f.journalRequests.at(-1).args,[{entryId:'entry-one'}]);
  const candidate=await provider.read({entryId:saved.entryId,writer:saved.writer,incarnationId:saved.incarnationId});assert.equal(candidate&&!candidate.deleted?candidate.draft:undefined,input.draft);
  await platform.release!();await assert.rejects(provider.list({entryId:'entry-one'}),{code:'draft_lease_revoked'});
});

test('fresh document provider reads a prior incarnation and maps flat exact retirement without mutation replanning',async t=>{
  const f=await startJournalApp(t),binding=await f.bridge.getDurableContext('/vault-one'),provider=createDesktopIndependentDraftProvider(f.bridge,'/vault-one',binding.scope,binding.independentJournal),saved=await provider.compareAndSwap(change());
  f.reload();const freshBinding=await f.bridge.getDurableContext('/vault-one'),fresh=createDesktopIndependentDraftProvider(f.bridge,'/vault-one',freshBinding.scope,freshBinding.independentJournal);
  assert.notEqual(fresh.scope.incarnationId,provider.scope.incarnationId);assert.deepEqual(await fresh.list({entryId:'entry-one'}),[saved]);
  const retired=await fresh.retire({entryId:saved.entryId,writer:saved.writer,incarnationId:saved.incarnationId,generation:saved.generation,expectedRevision:'1',nextRevision:'2'});
  assert.equal(retired.deleted,true);assert.equal(retired.incarnationId,saved.incarnationId);assert.deepEqual(f.journalRequests.at(-1).args,[saved]);assert.deepEqual(await fresh.list({entryId:'entry-one'}),[]);
  await assert.rejects(fresh.retire({entryId:saved.entryId,writer:saved.writer,incarnationId:saved.incarnationId,generation:saved.generation,expectedRevision:'1',nextRevision:'3'}),{code:'invalid_draft_revision'});
});

test('provider rejects foreign or malformed receipt/candidate data instead of acknowledging protection',async()=>{
  let reply:unknown=envelope({...receipt,clientId:'foreign'});const bridge:Pick<DesktopBridge,'independentJournal'>={independentJournal:async()=>reply};
  const provider=createDesktopIndependentDraftProvider(bridge,'/vault',scope,grant);
  await assert.rejects(provider.compareAndSwap(change()),{code:'invalid_draft_response'});
  reply=envelope([{...receipt,entryId:'unrelated'}]);await assert.rejects(provider.list({entryId:'entry-one'}),{code:'invalid_draft_response'});
  reply=envelope({...receipt,baseline:{...change().baseline,path:'../outside'},draft:'Do not adopt',checkpointRevision:null,pendingOperation:null});await assert.rejects(provider.read({entryId:'entry-one',writer:'writer-one'}),{code:'invalid_draft_response'});
  reply=envelope({...receipt,incarnationId:'prior-document'});await assert.rejects(provider.compareAndSwap(change()),{code:'invalid_draft_response'});
  reply={ok:true,value:receipt};await assert.rejects(provider.compareAndSwap(change()),{code:'invalid_draft_response'});
  const rows=[];Object.defineProperty(rows,'0',{get(){assert.fail('decoder must not invoke reply accessors');},enumerable:true});reply=envelope(rows);await assert.rejects(provider.list({entryId:'entry-one'}),{code:'invalid_draft_response'});
  assert.throws(()=>createDesktopIndependentDraftProvider(bridge,'/vault',scope,{token:'token',scope:{...scope,clientId:'foreign'}}),{code:'invalid_draft_response'});
});

test('storage failure stays separate from core saved state and next owned request heals without rebinding',async t=>{
  const f=await startJournalApp(t),binding=await f.bridge.getDurableContext('/vault-one'),provider=createDesktopIndependentDraftProvider(f.bridge,'/vault-one',binding.scope,binding.independentJournal);f.failOpen();
  await assert.rejects(provider.list({entryId:'entry-one'}),{code:'draft_storage_failure',commitUncertain:false,source:'main'});
  const saved=await provider.compareAndSwap(change());assert.equal(saved.revision,'1');assert.equal(f.openCount,2);assert.deepEqual((await f.bridge.getDurableContext('/vault-one')).independentJournal,binding.independentJournal);
});

test('actual preload bounds independent request and failure envelopes without exposing private errors',async t=>{
  const f=await startJournalApp(t),binding=await f.bridge.getDurableContext('/vault-one'),provider=createDesktopIndependentDraftProvider(f.bridge,'/vault-one',binding.scope,binding.independentJournal);
  const before=f.journalRequests.length;const invalid=await f.bridge.independentJournal({vault:'/vault-one',token:binding.independentJournal.token,op:'list',args:[],scope:{vaultId:'forged'}});
  assert.equal(invalid.error.code,'invalid_draft_request');assert.equal(f.journalRequests.length,before,'outer request rejection never reaches IPC');
  f.handlers.set('zorid:independentJournal',async()=>{throw Error('/private/not-for-renderer');});
  await assert.rejects(provider.list({entryId:'entry-one'}),{code:'draft_transport_lost',commitUncertain:true,source:'transport'});
  f.handlers.set('zorid:independentJournal',async()=>({independentJournal:true,schemaVersion:1,ok:false,error:{code:'draft_storage_failure',commitUncertain:false,source:'main',private:'/private/not-for-renderer'}}));
  await assert.rejects(provider.list({entryId:'entry-one'}),error=>error instanceof Error&&(error as any).code==='invalid_draft_response'&&(error as any).source==='protocol'&&!error.message.includes('/private'));
});
