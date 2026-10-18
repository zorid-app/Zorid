import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserCoreAdapter} from '../src/platform/browser-core.ts';
import type {BrowserCoreBackend} from '../src/platform/browser-core.ts';
import type {BrowserVaultRead} from '../src/core/browser-vault.ts';
import {BrowserVaultError} from '../src/core/browser-vault.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';

async function fixture(){
  const scope={vaultId:'browser-authority',clientId:'browser-client'};
  const original='Original browser baseline 😀',peer='Independent peer content α';
  const row:BrowserVaultRead={entry:{id:'entry',revision:'original-revision',path:'Note.md',kind:'file',deleted:false},bytes:new TextEncoder().encode(original),presentation:{id:'entry',ctime_ms:1,mtime_ms:2,size_bytes:new TextEncoder().encode(original).length}};
  let checkpoint:Checkpoint|null=null,prepares=0,commits=0,readError:Error|undefined;
  const backend:BrowserCoreBackend={durableScope:scope,
    checkpoints:{scope,load:async()=>checkpoint?structuredClone(checkpoint):null,compareAndSwap:async change=>{assert.equal(change.expectedRevision,checkpoint?.revision??null);checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(Number(checkpoint?.sequence??'0')+1),deleted:change.encodedState===null,byteLength:new TextEncoder().encode(change.encodedState??'').length,encodedState:change.encodedState};return structuredClone(checkpoint);},list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    inventory:async()=>[structuredClone(row)],readEntry:async()=>{if(readError)throw readError;return structuredClone(row);},readEntryById:async id=>row.entry.id===id?structuredClone(row):null,
    execute:async()=>{throw new Error('Unexpected legacy execution');},prepare:async()=>{prepares++;throw new Error('Unexpected preparation');},commit:async()=>{commits++;throw new Error('Unexpected commit');},intents:async()=>[],acknowledge:async()=>{throw new Error('Unexpected acknowledgment');},subscribe:()=>()=>{},close(){},
  };
  const adapter=new BrowserCoreAdapter(backend,scope),vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'Note.md',{debounceMs:60_000});await buffer.load();
  return{adapter,backend,buffer,original,peer,row,get checkpoint(){return checkpoint;},get prepares(){return prepares;},get commits(){return commits;},failRead(error:Error){readError=error;},advance(kind:'revision'|'identity'|'content'){
    if(kind==='revision')row.entry.revision='peer-revision';if(kind==='identity'){row.entry.id='replacement';row.presentation.id='replacement';}
    row.bytes=new TextEncoder().encode(peer);row.presentation.size_bytes=row.bytes.length;
  }};
}

for(const kind of ['revision','identity','content'] as const)test(`browser confirmed ${kind} preflight mismatch exposes exact retained draft without preparing a write`,async()=>{
  const f=await fixture(),draft='Retained live browser draft 😀';f.buffer.update(draft);f.advance(kind);
  await assert.rejects(f.buffer.flush(),error=>error instanceof DurableWritePlanningError&&error.code==='revision_conflict'&&error.source==='host'&&!error.commitUncertain);
  assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.buffer.text,draft);assert.equal(f.prepares,0);assert.equal(f.commits,0);assert.equal(new TextDecoder().decode(f.row.bytes),f.peer);
  const state=JSON.parse(f.checkpoint!.encodedState!);assert.equal(state.conflict,true);assert.equal(state.draft,draft);assert.equal(state.base.entryId,'entry');assert.equal(state.base.revision,'original-revision');assert.equal(state.base.content,f.original);assert.equal(state.operation,undefined);
});
test('browser upstream runtime rejection remains the same error and does not manufacture a confirmed conflict',async()=>{
  for(const source of ['host','rust'] as const)for(const code of ['revision_conflict','outcome_unknown','quota_exceeded']){
    const f=await fixture(),error=new BrowserVaultError(code,'Runtime did not provide an observation',undefined,source);f.buffer.update('Pending draft');f.failRead(error);
    await assert.rejects(f.buffer.flush(),actual=>actual===error);assert.equal(f.buffer.hasRecoveryConflict,false);assert.equal(f.buffer.text,'Pending draft');assert.equal(f.prepares,0);assert.equal(f.commits,0);
    const state=JSON.parse(f.checkpoint!.encodedState!);assert.equal(state.conflict,false);assert.equal(state.draft,'Pending draft');assert.equal(state.base.entryId,'entry');assert.equal(state.base.revision,'original-revision');assert.equal(state.base.content,f.original);assert.equal(state.operation,undefined);
  }
});
test('browser invalid UTF-8 observation remains a decoding failure rather than a planning conflict',async()=>{
  const f=await fixture();f.buffer.update('Pending draft');f.row.bytes=new Uint8Array([255]);f.row.presentation.size_bytes=1;
  await assert.rejects(f.buffer.flush(),error=>!(error instanceof DurableWritePlanningError));assert.equal(f.buffer.hasRecoveryConflict,false);assert.equal(f.prepares,0);
});
