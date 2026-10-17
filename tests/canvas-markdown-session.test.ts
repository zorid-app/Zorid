import test from 'node:test';
import assert from 'node:assert/strict';
import {Vault,MemoryAdapter} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {createCanvasMarkdownBufferSession,NoteBufferSubscriptions} from '../src/ui/canvas-markdown-session.ts';

async function setup(t:import('node:test').TestContext){
  const adapter=new MemoryAdapter({'Note.md':'original'}),vault=new Vault(adapter),signals=new NoteBufferSubscriptions(),drafts=new Map<string,string>();await vault.initialize();
  const buffer=new NoteBuffer(vault,'Note.md',{debounceMs:60000,storage:{getItem:key=>drafts.get(key)??null,setItem:(key,value)=>{drafts.set(key,value);},removeItem:key=>{drafts.delete(key);}},onState:()=>signals.publish(buffer)});await buffer.load();
  let valid=true;const validate=()=>{if(!valid)throw new Error('File identity changed');};
  const sessions:ReturnType<typeof createCanvasMarkdownBufferSession>[]=[];
  const session=()=>{const result=createCanvasMarkdownBufferSession({buffer,validateWrite:validate,update:(text,validateWrite)=>buffer.update(text,{validateWrite}),subscribe:listener=>signals.subscribe(buffer,listener)});sessions.push(result);return result;};
  t.after(async()=>{valid=true;for(const owner of sessions)owner.destroy();await adapter.write('Note.md',buffer.savedText);await buffer.dispose();});
  return{adapter,vault,buffer,drafts,signals,session,invalidate(){valid=false;}};
}

test('two cards share one draft, suppress sender echo and reject stale expected text',async t=>{
  const {session,buffer}=await setup(t),a=session(),b=session(),own:string[]=[],peer:string[]=[];a.subscribe(text=>own.push(text));b.subscribe(text=>peer.push(text));
  a.update('first','original');assert.deepEqual(own,[]);assert.deepEqual(peer,['first']);assert.equal(b.getText(),'first');
  assert.throws(()=>b.update('stale','original'),/another editor/);assert.equal(buffer.text,'first');
  b.update('second','first');assert.deepEqual(own,['second']);assert.deepEqual(peer,['first']);
  await a.flush();assert.equal(a.hasPendingChanges(),false);assert.deepEqual(own,['second']);
});

test('external reload publishes once, disposal releases listeners without destroying the shared draft',async t=>{
  const {session,adapter,buffer}=await setup(t),a=session(),b=session(),updates:string[]=[];a.subscribe(text=>updates.push(text));
  await adapter.write('Note.md','external');await buffer.reload();assert.deepEqual(updates,['external']);
  a.update('accepted','external');a.destroy();assert.throws(()=>a.update('late','accepted'),/closed/);
  await b.flush();assert.equal(await adapter.read('Note.md'),'accepted');assert.equal(buffer.dirty,false);assert.deepEqual(updates,['external']);
});

test('failed save preserves shared draft and can retry after session disposal',async t=>{
  const {session,adapter,buffer,drafts}=await setup(t),owner=session();owner.update('recover me','original');
  const write=adapter.write.bind(adapter);adapter.write=async()=>{throw new Error('offline');};await assert.rejects(owner.flush(),/offline/);
  assert.equal(owner.hasPendingChanges(),true);assert.match([...drafts.values()][0],/recover me/);owner.destroy();adapter.write=write;
  await buffer.flush();assert.equal(await adapter.read('Note.md'),'recover me');
});

test('accepted draft retains identity guard after teardown and cannot overwrite a replacement file',async t=>{
  const {session,adapter,buffer,drafts,invalidate}=await setup(t),owner=session();owner.update('old card edit','original');owner.destroy();invalidate();
  await adapter.write('Note.md','replacement');await assert.rejects(buffer.flush(),/identity changed/);assert.equal(await adapter.read('Note.md'),'replacement');assert.equal(buffer.dirty,true);assert.match([...drafts.values()][0],/old card edit/);
});

test('queued write validates file identity again at the actual Vault mutation',async t=>{
  const {session,adapter,vault,buffer,invalidate}=await setup(t),owner=session();
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>started=resolve),write=adapter.write.bind(adapter);
  adapter.write=async(path,text)=>{if(path==='Block.md'){started();await gate;}return write(path,text);};
  const blocking=vault.create('Block.md','block');await began;
  const modify=vault.modify.bind(vault);let queued!:()=>void;const entered=new Promise<void>(resolve=>queued=resolve);
  vault.modify=async(...args)=>{queued();return modify(...args);};
  owner.update('queued','original');const saving=owner.flush();await entered;invalidate();release();await blocking;
  await assert.rejects(saving,/identity changed/);assert.equal(await adapter.read('Note.md'),'original');assert.equal(buffer.dirty,true);
});

test('settings refresh may publish identical text without treating save acknowledgements as edits',async t=>{
  const {session,signals,buffer}=await setup(t),owner=session(),updates:string[]=[];owner.subscribe(text=>updates.push(text));
  signals.publish(buffer);assert.deepEqual(updates,[]);signals.publish(buffer,true);assert.deepEqual(updates,['original']);
  owner.destroy();signals.publish(buffer,true);assert.deepEqual(updates,['original']);
});

test('invalidated file identity cannot deliver replacement content through an old subscription',async t=>{
  const {session,adapter,buffer,invalidate}=await setup(t),owner=session(),updates:string[]=[];owner.subscribe(text=>updates.push(text));invalidate();
  await adapter.write('Note.md','replacement');await buffer.reload();assert.deepEqual(updates,[]);assert.throws(()=>owner.getText(),/identity changed/);
});

test('clean invalidated sessions permit teardown but still reject edits; dirty sessions retain the guard',async t=>{
  const {session,buffer,invalidate}=await setup(t),owner=session();invalidate();
  await owner.flush();assert.equal(owner.hasPendingChanges(),false);assert.throws(()=>owner.update('wrong','original'),/identity changed/);
  buffer.update('peer draft');await assert.rejects(owner.flush(),/identity changed/);assert.equal(buffer.dirty,true);
});
