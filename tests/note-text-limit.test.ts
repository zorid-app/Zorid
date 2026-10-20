import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_NOTE_TEXT_BYTES,assertNoteTextChange} from '../src/core/note-text-limit.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {durableRecoveryFixture} from './helpers/durable-recovery-fixture.ts';

test('note limit counts UTF-8 bytes and permits the exact storage boundary',()=>{
  assert.equal(MAX_NOTE_TEXT_BYTES,1024*1024);
  assert.doesNotThrow(()=>assertNoteTextChange('small','a'.repeat(MAX_NOTE_TEXT_BYTES)));
  assert.throws(()=>assertNoteTextChange('small','a'.repeat(MAX_NOTE_TEXT_BYTES+1)),/1 MiB/);
  assert.doesNotThrow(()=>assertNoteTextChange('','é'.repeat(MAX_NOTE_TEXT_BYTES/2)));
  assert.throws(()=>assertNoteTextChange('','é'.repeat(MAX_NOTE_TEXT_BYTES/2)+'a'),/1 MiB/);
  assert.doesNotThrow(()=>assertNoteTextChange('','😀'.repeat(MAX_NOTE_TEXT_BYTES/4)));
  assert.throws(()=>assertNoteTextChange('','😀'.repeat(MAX_NOTE_TEXT_BYTES/4)+'a'),/1 MiB/);
});

test('existing oversized recovery drafts can shrink without permitting further growth',()=>{
  const old='a'.repeat(MAX_NOTE_TEXT_BYTES+100);
  assert.doesNotThrow(()=>assertNoteTextChange(old,old));
  assert.doesNotThrow(()=>assertNoteTextChange(old,old.slice(1)));
  assert.throws(()=>assertNoteTextChange(old,old+'a'),/1 MiB/);
  assert.throws(()=>assertNoteTextChange(old,'é'.repeat(old.length-1)),/1 MiB/);
});

test('durable buffer rejects an oversized edit without changing text, recovery or save state',async()=>{
  const f=await durableRecoveryFixture();const vault=new Vault(f.adapter);await vault.initialize();
  const note=new NoteBuffer(vault,'One.md',{debounceMs:600000});await note.load();
  const before=note.text,checkpoint=JSON.stringify(f.checkpoint),dirty=note.dirty,error=note.error,saved=note.savedText;
  assert.throws(()=>note.update('a'.repeat(MAX_NOTE_TEXT_BYTES+1)),/1 MiB/);
  assert.equal(note.text,before);assert.equal(note.savedText,saved);assert.equal(note.dirty,dirty);assert.equal(note.error,error);
  assert.equal(JSON.stringify(f.checkpoint),checkpoint);
  await note.closeMetadataProjection();
});


test('Markdown policy does not impose a size cap on other file types',async()=>{
  const f=await durableRecoveryFixture();const vault=new Vault(f.adapter);
  for(const path of ['Drawing.canvas','Image.png','Data.json']){
    const note=new NoteBuffer(vault,path);
    assert.doesNotThrow(()=>note.validateTextChange('a'.repeat(MAX_NOTE_TEXT_BYTES+1)));
  }
});
