import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {documentDraftProjectionUsage} from '../src/ui/document-draft-projection.ts';
import {draftMetadataHarness,until} from './helpers/draft-metadata.ts';
async function setup(t:TestContext,options:{capable?:boolean;path?:string;onMetadata?:()=>void}={}){
  const path=options.path??'One.md',adapter=new MemoryAdapter({[path]:'# Saved'}),vault=new Vault(adapter),core=draftMetadataHarness();await vault.initialize();
  Object.defineProperty(adapter,'documentSemantics',{value:{draftsAvailable:options.capable!==false,drafts:core.service}});
  const note=new NoteBuffer(vault,path,{debounceMs:60_000,onMetadata:options.onMetadata});await note.load();t.after(()=>note.dispose());return {note,vault,adapter,core};
}
test('clean loads and actual unsaved edits remain lazy until metadata is read',async t=>{
  const {note,vault,core}=await setup(t);assert.equal(note.getMetadata(),vault.metadata.get('One.md'));assert.equal(note.metadataState,undefined);assert.equal(core.subscriptions,0);assert.equal(core.transportSubscriptions,1);
  note.update('# Local draft');assert.equal(core.events.length,0);assert.equal(note.getMetadata(),undefined);await until(()=>!!note.getMetadata());
  assert.equal(core.subscriptions,1);assert.equal(note.getMetadata()!.headings[0].heading,'Rust supplied heading');assert.equal(note.getMetadata()!.aliases[0],'Rust # Local draft');assert.equal(core.events.filter(e=>e.op==='request').length,1);
});
test('save completion withdraws demand; later edits need actual display demand and ABA revisions advance',async t=>{
  const {note,core}=await setup(t);note.update('A');note.getMetadata();await until(()=>note.metadataState?.status==='current');const first=note.metadataState!.textRevision;
  await note.flush();const count=core.events.filter(e=>e.op==='request').length;assert.equal(note.dirty,false);assert.equal(note.metadataState?.status,'unsupported');
  await note.flush();note.update('B');note.update('A');note.update('B');assert.equal(note.dirty,true);assert.equal(core.events.filter(e=>e.op==='request').length,count);assert.ok(BigInt(note.metadataState!.textRevision)>BigInt(first));
  note.getMetadata();await until(()=>note.metadataState?.status==='current');assert.equal(core.events.filter(e=>e.op==='request').length,count+1);
});
test('legacy dirty facts reuse one exact view per revision and clean reads stay committed',async t=>{
  const {note,vault,core}=await setup(t,{capable:false});note.update('# Local');const exact=note.getMetadata();assert.equal(exact!.headings[0].heading,'Local');assert.equal(note.getMetadata(),exact);assert.equal(note.metadataState?.origin,'legacy');
  await note.flush();assert.equal(note.getMetadata(),vault.metadata.get('One.md'));assert.equal(core.events.length,0);
});
test('non-Markdown buffers never enter transient or legacy Markdown analysis',async t=>{
  const {note,core}=await setup(t,{path:'Board.canvas'});note.update('{"nodes":[]}');assert.equal(note.getMetadata(),undefined);assert.equal(note.metadataState,undefined);assert.equal(core.events.length,0);
});
for(const failure of ['reject','facts'] as const)test(`capable ${failure} cannot fall back to local semantic parsing or a stale view`,async t=>{
  const {note,core}=await setup(t);if(failure==='reject')core.rejectRequests();else core.invalidFacts();note.update('# TS would find this');note.getMetadata();await until(()=>note.metadataState?.status==='unavailable');assert.equal(note.getMetadata(),undefined);assert.equal(note.metadataState?.origin,'core');assert.equal(note.error,null);
});
test('held admission is retired on close and disposal waits actual late cleanup',async t=>{
  const {note,core}=await setup(t),gate=core.holdRequest();note.update('draft');note.getMetadata();await until(()=>core.events.some(e=>e.op==='request'));
  let done=false;const close=note.dispose().then(()=>{done=true;});await until(()=>core.events.some(e=>e.op==='release_buffer'));assert.equal(done,false);gate.resolve();await close;assert.equal(core.subscriptions,0);assert.equal(core.transportSubscriptions,1);assert.equal(core.jobs.size,0);assert.equal(documentDraftProjectionUsage(core.service).bytes,0);
});
test('failed facts close stays retry-owned without becoming a durable save error',async t=>{
  const {note,core}=await setup(t);note.update('draft');note.getMetadata();await until(()=>note.metadataState?.status==='current');core.failRelease();core.failRelease();
  // Withdrawal can issue the first release during save; hold it until dispose
  // owns the same still-pending acknowledgement.
  const gate=core.holdRelease(),closing=note.dispose();await until(()=>core.events.some(e=>e.op==='release_buffer'));gate.resolve();assert.equal(note.dispose(),closing);assert.throws(()=>note.update('late edit'),/closing/);await assert.rejects(closing);assert.equal(note.error,null);assert.equal(note.dirty,false);await note.flush();await note.dispose();assert.equal(documentDraftProjectionUsage(core.service).bytes,0);
});
test('save status listeners never receive metadata errors and actual provider retirement does not block disposal',async t=>{
  let updates=0;const {note,core}=await setup(t,{onMetadata:()=>{updates++;}}),gate=core.holdRequest();note.update('draft');note.getMetadata();await until(()=>core.events.some(e=>e.op==='request'));core.retire();gate.resolve();await note.dispose();assert.equal(note.error,null);assert.equal(core.subscriptions,0);assert.equal(core.transportSubscriptions,0);const before=updates;await new Promise(resolve=>setTimeout(resolve,5));assert.equal(updates,before);
});

test('new typing after failed facts retirement still autosaves in the retained buffer',async t=>{
  const {note,core,adapter}=await setup(t);note.update('draft');note.getMetadata();await until(()=>note.metadataState?.status==='current');core.failRelease();core.failRelease();
  const gate=core.holdRelease(),closing=note.dispose();await until(()=>core.events.some(e=>e.op==='release_buffer'));gate.resolve();await assert.rejects(closing);
  t.mock.timers.enable({apis:['setTimeout']});note.update('Typing after cancelled close');t.mock.timers.tick(60_000);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(await adapter.read('One.md'),'Typing after cancelled close');assert.equal(note.dirty,false);assert.equal(note.error,null);await note.dispose();
});
