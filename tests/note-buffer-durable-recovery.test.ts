import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { durableRecoveryFixture,recoveredDraft,externalText } from './helpers/durable-recovery-fixture.ts';

async function fixture(){const f=await durableRecoveryFixture();const vault=new Vault(f.adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});await buffer.load();return{f,vault,buffer};}

test('crashed conflicting draft loads visibly, remains navigable and explicit Save refuses stale overwrite',async()=>{
  const {f,vault,buffer}=await fixture();
  assert.equal(buffer.text,recoveredDraft);assert.equal(buffer.hasRecoveryConflict,true);assert.ok(buffer.error);
  await buffer.flushForNavigation();
  await assert.rejects(buffer.flush(),/draft preserved/);
  assert.equal(f.plans,0);assert.equal(await f.adapter.read('One.md'),externalText);
  const reopened=new NoteBuffer(vault,'One.md');await reopened.load();
  assert.equal(reopened.text,recoveredDraft);assert.equal(reopened.hasRecoveryConflict,true);
});

test('recovery copy durably preserves draft, adopts latest original and survives reopening',async()=>{
  const {f,vault,buffer}=await fixture();
  const result=await buffer.saveRecoveryCopy();assert.equal(result.resolved,true);
  assert.equal(await f.adapter.read(result.path),recoveredDraft);assert.equal(await f.adapter.read('One.md'),externalText);
  assert.equal(buffer.text,externalText);assert.equal(buffer.dirty,false);assert.equal(buffer.error,null);
  const reopened=new NoteBuffer(vault,'One.md');await reopened.load();assert.equal(reopened.text,externalText);assert.equal(reopened.hasRecoveryConflict,false);
});

test('failed recovery-copy create retains exact old checkpoint and draft',async()=>{
  const {f,buffer}=await fixture();const before=f.checkpoint.encodedState;f.failCreate();
  await assert.rejects(buffer.saveRecoveryCopy(),/Recovery create failed/);
  assert.equal(f.checkpoint.encodedState,before);assert.equal(buffer.text,recoveredDraft);assert.equal(buffer.hasRecoveryConflict,true);
});

test('typing during recovery-copy creation retains newer draft and original baseline',async()=>{
  const {f,buffer}=await fixture();let release!:()=>void;f.holdCreate(new Promise(resolve=>{release=resolve;}));
  const saving=buffer.saveRecoveryCopy();await new Promise(resolve=>setTimeout(resolve,0));
  buffer.update(recoveredDraft+' New typing.');release();
  const result=await saving;assert.equal(result.resolved,false);await buffer.flushForNavigation();
  assert.equal(await f.adapter.read(result.path),recoveredDraft);assert.equal(buffer.text,recoveredDraft+' New typing.');
  assert.equal(buffer.hasRecoveryConflict,true);assert.equal(JSON.parse(f.checkpoint.encodedState!).base.revision,'old-revision');
});

test('typing while the recovery checkpoint is in flight cannot adopt or silently rebase the newer draft',async()=>{
  const {f,buffer}=await fixture();let release!:()=>void;f.holdCheckpoint(new Promise(resolve=>{release=resolve;}));
  const saving=buffer.saveRecoveryCopy();await new Promise(resolve=>setTimeout(resolve,0));
  buffer.update(recoveredDraft+' Typed during checkpoint.');release();
  const result=await saving;assert.equal(result.resolved,false);await buffer.flushForNavigation();
  assert.equal(buffer.text,recoveredDraft+' Typed during checkpoint.');assert.equal(buffer.hasRecoveryConflict,true);
  const state=JSON.parse(f.checkpoint.encodedState!);assert.equal(state.base.revision,'old-revision');assert.equal(state.draft,buffer.text);
  await assert.rejects(buffer.flush(),/draft preserved/);assert.equal(await f.adapter.read('One.md'),externalText);
});


test('expected stable ID is checked by ID before any checkpoint adoption, including rename drift',async()=>{
  for(const renamed of [false,true]){
    const f=await durableRecoveryFixture(),vault=new Vault(f.adapter);await vault.initialize();let checkpoints=0;
    const load=f.adapter.durableWrites.checkpoints.load;
    f.adapter.durableWrites.checkpoints.load=async key=>{checkpoints++;return load(key);};
    if(renamed){const read=f.adapter.durableWrites.readTextById;f.adapter.durableWrites.readTextById=async id=>{const v=await read(id);return v?{...v,path:'Moved.md'}:v;};}
    const note=new NoteBuffer(vault,'One.md');
    await assert.rejects(note.load(renamed?'retained-note':'replacement'));
    assert.equal(checkpoints,0);assert.equal(note.savedDurableWitness,undefined);assert.equal(f.plans,0);
  }
});
test('expected ID remains immutable across retries and loaded-buffer reuse',async()=>{
  const f=await durableRecoveryFixture(),vault=new Vault(f.adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md');
  await note.load('retained-note');assert.equal(note.text,recoveredDraft);
  await assert.rejects(note.load('replacement'),/another entry/);
  await note.load();assert.equal(note.savedDurableWitness?.entryId,'retained-note');assert.equal(note.text,recoveredDraft);
});
test('rejected replacement admission cannot pin an already loaded buffer to the wrong entry',async()=>{
  const f=await durableRecoveryFixture(),vault=new Vault(f.adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md');
  await note.load();await assert.rejects(note.load('replacement'),/identity changed/);
  await note.load('retained-note');await note.load();
  assert.equal(note.savedDurableWitness?.entryId,'retained-note');assert.equal(note.text,recoveredDraft);
});
test('failed fresh identity admission does not pin the buffer, and queued loads validate the admitted identity',async()=>{
  const f=await durableRecoveryFixture(),vault=new Vault(f.adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md');
  await assert.rejects(note.load('replacement'));
  const admitted=note.load('retained-note'),rejected=note.load('replacement');
  await admitted;await assert.rejects(rejected,/another entry/);await note.load();
  assert.equal(note.savedDurableWitness?.entryId,'retained-note');assert.equal(f.plans,0);
});
test('superseded ID observation cannot load a checkpoint or resume recovery',async()=>{
  const f=await durableRecoveryFixture(),vault=new Vault(f.adapter);await vault.initialize();let current=true,loads=0;
  const read=f.adapter.durableWrites.readTextById;f.adapter.durableWrites.readTextById=async id=>{const result=await read(id);current=false;return result;};
  const load=f.adapter.durableWrites.checkpoints.load;f.adapter.durableWrites.checkpoints.load=async key=>{loads++;return load(key);};
  const note=new NoteBuffer(vault,'One.md');await assert.rejects(note.load('retained-note',()=>{if(!current)throw new Error('superseded');}),/superseded/);
  assert.equal(loads,0);assert.equal(f.plans,0);
});
