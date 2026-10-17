import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCoreAdapter, BROWSER_CORE_VAULT_ID } from '../src/platform/browser-core.ts';
import type { BrowserCoreBackend } from '../src/platform/browser-core.ts';
import { BrowserVaultError } from '../src/core/browser-vault.ts';
import type { BrowserVaultRead } from '../src/core/browser-vault.ts';
import { afterDurableCommit } from '../src/platform/browser-core-events.ts';

function fixture() {
  const row: BrowserVaultRead = {entry:{id:'stable-file',path:'Note.md',kind:'file',revision:'revision-1',deleted:false},
    presentation:{id:'stable-file',ctime_ms:123,mtime_ms:456,size_bytes:3},bytes:new TextEncoder().encode('old')};
  const calls: {id:string;json:string}[] = [];
  let execution = async () => '{}';
  let reads = 0, closed = false;
  const backend: BrowserCoreBackend = {
    async inventory() { return [structuredClone(row)]; },
    async readEntry(path) { reads++; return path === row.entry.path ? structuredClone(row) : null; },
    async execute(id,json) { calls.push({id,json}); return execution(); },
    async intents() { return []; }, async acknowledge() {}, subscribe() { return () => {}; }, close() { closed = true; },
  };
  return {adapter:new BrowserCoreAdapter(backend), row, calls, setExecution(fn:()=>Promise<string>) { execution = fn; },
    get reads() { return reads; }, get closed() { return closed; }};
}

test('browser core preserves recovery identity and projects persisted stats without synthesizing time', async () => {
  const {adapter} = fixture();
  assert.equal(BROWSER_CORE_VAULT_ID, 'browser:default');
  assert.deepEqual(await adapter.stat('Note.md'), {path:'Note.md',type:'file',entryId:'stable-file',ctime:123,mtime:456,size:3,revision:'revision-1'});
  assert.deepEqual(await adapter.list(), [await adapter.stat('Note.md')]);
});
test('compare and write binds exact expected bytes to the revision from one coherent read', async () => {
  const f = fixture();
  await f.adapter.compareAndWrite('Note.md','old','new');
  assert.equal(f.reads,1);
  const request = JSON.parse(f.calls[0].json);
  assert.deepEqual(request.mutation,{type:'write',id:'stable-file',expected:'revision-1',content:[110,101,119]});
  assert.equal(request.operation_id,f.calls[0].id);
  await assert.rejects(f.adapter.compareAndWrite('Note.md','stale','overwrite'),{code:'content_conflict'});
  assert.equal(f.calls.length,1);
});
test('binary input is copied before waiting for the adapter queue', async () => {
  const f = fixture(), bytes = new Uint8Array([0,255,128]);
  const operation = f.adapter.writeBinary('Note.md',bytes); bytes.fill(42);
  await operation;
  assert.deepEqual(JSON.parse(f.calls[0].json).mutation.content,[0,255,128]);
  const read = await f.adapter.readBinary('Note.md'); read.fill(0);
  assert.equal(await f.adapter.read('Note.md'),'old');
});
test('UTF-8 BOM remains part of text through read, expected comparison and write encoding', async () => {
  const f = fixture(); f.row.bytes = new TextEncoder().encode('\uFEFFold');
  assert.equal(await f.adapter.read('Note.md'),'\uFEFFold');
  await f.adapter.compareAndWrite('Note.md','\uFEFFold','\uFEFFnew');
  assert.deepEqual(JSON.parse(f.calls[0].json).mutation.content,[239,187,191,110,101,119]);
  await assert.rejects(f.adapter.compareAndWrite('Note.md','old','new'),{code:'content_conflict'});
});
test('ambiguous acknowledgement retries the exact intent and does not create a second operation', async () => {
  const f = fixture(); let attempts = 0;
  f.setExecution(async () => { if (++attempts === 1) throw new BrowserVaultError('outcome_unknown','response lost'); return '{}'; });
  await assert.rejects(f.adapter.compareAndWrite('Note.md','old','new'),{code:'outcome_unknown'});
  await f.adapter.compareAndWrite('Note.md','old','new');
  assert.equal(f.calls.length,2); assert.deepEqual(f.calls[0],f.calls[1]);
  assert.equal(f.reads,1,'retry does not read newer metadata and mint a new revision request');
});
test('new input cannot bypass an unresolved earlier intent', async () => {
  const f = fixture();
  f.setExecution(async () => { throw new BrowserVaultError('outcome_unknown','response lost'); });
  await assert.rejects(f.adapter.write('Note.md','first'),{code:'outcome_unknown'});
  await assert.rejects(f.adapter.write('Note.md','second'),{code:'outcome_unknown'});
  assert.deepEqual(f.calls[0],f.calls[1]); assert.equal(f.reads,1);
});
test('Rust error during postcommit publication cannot masquerade as a rejected mutation', async () => {
  const f = fixture(); let committedCalls = 0;
  f.setExecution(async () => {
    committedCalls++;
    return afterDurableCommit('persisted-intent','original-receipt',async () => {
      if (committedCalls===1) throw new BrowserVaultError('invalid_operation_record','corrupt unrelated journal',undefined,'rust');
    });
  });
  await assert.rejects(f.adapter.write('Note.md','new'),{code:'outcome_unknown',source:'host'});
  await f.adapter.write('Note.md','new');
  assert.deepEqual(f.calls[0],f.calls[1]); assert.equal(f.reads,1);
});
test('known Rust rejection is distinct from ambiguous completion and stale revisions propagate', async () => {
  const f = fixture();
  f.setExecution(async () => { throw new BrowserVaultError('revision_conflict','changed',undefined,'rust'); });
  await assert.rejects(f.adapter.write('Note.md','first'),{code:'revision_conflict'});
  f.setExecution(async () => '{}');
  await f.adapter.write('Note.md','second');
  assert.notEqual(f.calls[0].id,f.calls[1].id);
  assert.equal(JSON.parse(f.calls[1].json).mutation.expected,'revision-1');
});
test('folder moves use stable identity and revision; trash exposes only retained logical deletion', async () => {
  const f = fixture(); f.row.entry.kind = 'folder'; delete f.row.bytes; f.row.presentation.size_bytes = 0;
  await f.adapter.rename('Note.md','Moved');
  assert.deepEqual(JSON.parse(f.calls[0].json).mutation,{type:'move',id:'stable-file',expected:'revision-1',path:'Moved'});
  await f.adapter.trash('Note.md');
  assert.deepEqual(JSON.parse(f.calls[1].json).mutation,{type:'delete',id:'stable-file',expected:'revision-1',recursive:true});
  assert.equal('remove' in f.adapter,false);
  await f.adapter.close(); assert.equal(f.closed,true);
  await assert.rejects(f.adapter.write('Note.md','late'),{code:'storage_closed'});
});

test('metadata-only stat and namespace commands do not read a large binary body',async()=>{
  const row:BrowserVaultRead={entry:{id:'large',path:'Large.bin',kind:'file',revision:'r1',deleted:false},presentation:{id:'large',ctime_ms:1,mtime_ms:2,size_bytes:67108864}};
  const calls:any[]=[];const backend:BrowserCoreBackend={async inventory(){return [row];},async readMetadata(path){return path==='Large.bin'?row:null;},async readEntry(){throw new Error('whole binary body forbidden');},async execute(_id,json){calls.push(JSON.parse(json));return '{}';},async intents(){return [];},async acknowledge(){},subscribe(){return()=>{};},close(){}};
  const adapter=new BrowserCoreAdapter(backend);assert.equal((await adapter.list())[0].entryId,'large');assert.equal((await adapter.stat('Large.bin'))!.size,67108864);await adapter.rename('Large.bin','Moved.bin');await adapter.trash('Large.bin');assert.deepEqual(calls.map(value=>value.mutation.type),['move','delete']);
});
