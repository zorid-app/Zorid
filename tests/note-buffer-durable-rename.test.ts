import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {browserDurableWrites} from '../src/platform/browser-durable-writes.ts';
import type {BrowserCoreBackend} from '../src/platform/browser-core.ts';
import type {BrowserVaultIntent,BrowserVaultRead} from '../src/core/browser-vault.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

// Real Vault/NoteBuffer/browser durable facade. Only persistence transport is a
// controlled fixture; actual browser UI/IDB failure is retained separately.
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}
async function fixture(t:TestContext){
 const scope={vaultId:'authority',clientId:'client'},started=deferred(),release=deferred(),checkpointStarted=deferred();let checkpoint:Checkpoint|null=null;
 const row:BrowserVaultRead={entry:{id:'stable-note',path:'One.md',revision:'original',kind:'file',deleted:false},bytes:new TextEncoder().encode(''),presentation:{id:'stable-note',ctime_ms:1,mtime_ms:1,size_bytes:0}};
 const intents=new Map<string,BrowserVaultIntent>();let sequence=0,plans=0,checkpointHold:Promise<void>|undefined;
 class Adapter extends MemoryAdapter{
  override async rename(from:string,to:string){started.resolve();await release.promise;await super.rename(from,to);row.entry={...row.entry,path:to,revision:'renamed'};}
  override async list(){return(await super.list()).map(e=>e.path===row.entry.path?{...e,entryId:row.entry.id,revision:row.entry.revision}:e);}
 }
 const adapter=new Adapter({'One.md':''});const unsupported=async():Promise<never>=>{throw Error('Unexpected legacy execution');};
 const backend:BrowserCoreBackend={durableScope:scope,checkpoints:{scope,load:async()=>structuredClone(checkpoint),compareAndSwap:async change=>{
  if(checkpointHold&&JSON.parse(change.encodedState!).base.path==='Two.md'){checkpointStarted.resolve();await checkpointHold;}assert.equal(change.expectedRevision,checkpoint?.revision??null);checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(++sequence),deleted:false,byteLength:0};return structuredClone(checkpoint);
 },list:unsupported,changes:unsupported},inventory:async()=>[structuredClone(row)],readEntry:async path=>path===row.entry.path?structuredClone(row):null,readEntryById:async id=>id===row.entry.id?structuredClone(row):null,execute:unsupported,
 prepare:async(token,json)=>{plans++;const request=JSON.parse(json);intents.set(token,{client_id:scope.clientId,intent_id:token,operation_id:request.operation_id,request_json:json,order:'1',acknowledged:false,status:'prepared'});},
 commit:async token=>{const intent=intents.get(token)!,request=JSON.parse(intent.request_json),before=structuredClone(row.entry);assert.equal(request.mutation.id,row.entry.id);assert.equal(request.mutation.expected,row.entry.revision,'actual browser facade must retain fresh exact CAS');row.bytes=new Uint8Array(request.mutation.content);row.entry={...row.entry,revision:'written-'+(++sequence)};row.presentation.size_bytes=row.bytes.length;await adapter.write(row.entry.path,new TextDecoder().decode(row.bytes));intent.status='committed';intent.receipt=JSON.stringify({operation_id:intent.operation_id,sequence:String(sequence),changes:[{before,after:row.entry}]});return intent.receipt;},
 intents:async()=>structuredClone([...intents.values()]),acknowledge:async token=>{intents.get(token)!.acknowledged=true;},subscribe:()=>()=>{},close(){}};
 const writes=browserDurableWrites(backend,scope,()=>false);Object.assign(adapter,{durableWrites:writes});const vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});await buffer.load('stable-note');t.after(()=>buffer.dispose().catch(()=>{}));
 return{adapter,vault,buffer,row,started,release,writes,checkpointStarted,get plans(){return plans;},get checkpoint(){return checkpoint;},holdCheckpoint(p?:Promise<void>){checkpointHold=p;}};
}

test('typing during owned durable rename keeps the draft and saves at the new path after duplicate relocate',async t=>{
 const f=await fixture(t);let relocation:Promise<void>|undefined;const stop=f.vault.on('rename',change=>{relocation=f.buffer.relocate(change.path);void relocation.catch(()=>{});});
 const renaming=f.buffer.rename('Two.md');await f.started.promise;f.buffer.update('Ordinary browser note.\nExact retained draft\n');f.release.resolve();
 try{await renaming;await relocation;assert.equal(f.buffer.path,'Two.md');assert.equal(f.buffer.error,null);assert.equal(f.buffer.hasRecoveryConflict,false);assert.equal(f.buffer.text,'Ordinary browser note.\nExact retained draft\n');assert.deepEqual(f.buffer.savedDurableWitness,{entryId:'stable-note',path:'Two.md',revision:'renamed'});await f.buffer.flush();assert.equal(await f.adapter.read('Two.md'),f.buffer.text);assert.equal(f.buffer.dirty,false);assert.equal(f.plans,1);const reopened=new NoteBuffer(f.vault,'Two.md');await reopened.load('stable-note');assert.equal(reopened.text,f.buffer.text);assert.equal(reopened.dirty,false);await reopened.dispose();}
 finally{stop();await f.buffer.dispose().catch(()=>{});}
});

test('known relocation still refuses changed bytes, a different destination and a replacement identity',async t=>{
 for(const changed of ['content','destination','identity']as const){const f=await fixture(t);f.buffer.update('Retained user draft');f.row.entry={...f.row.entry,path:changed==='destination'?'Elsewhere.md':'Two.md',revision:'peer',...(changed==='identity'?{id:'replacement'}:{})};if(changed==='content')f.row.bytes=new TextEncoder().encode('Peer content');
  await assert.rejects(f.buffer.relocate('Two.md'));assert.equal(f.buffer.text,'Retained user draft');assert.equal(f.buffer.savedDurableWitness?.revision,'original');assert.equal(f.plans,0);await assert.rejects(f.buffer.dispose());
 }
});

test('ordinary durable reload retains strict same-byte revision conflicts without a known move',async t=>{
 const f=await fixture(t);f.buffer.update('Retained user draft');f.row.entry.revision='peer-same-bytes';await assert.rejects(f.buffer.reload(),/entry changed/);assert.equal(f.buffer.text,'Retained user draft');assert.equal(f.buffer.savedDurableWitness?.revision,'original');assert.equal(f.plans,0);await assert.rejects(f.buffer.dispose());
});


test('typing during relocation checkpoint persistence retains the latest draft and fresh saved witness',async t=>{
 const f=await fixture(t),gate=deferred();f.buffer.update('First draft');f.release.resolve();await f.vault.rename('One.md','Two.md');f.holdCheckpoint(gate.promise);
 const moving=f.buffer.relocate('Two.md');await f.checkpointStarted.promise;f.buffer.update('Latest draft during checkpoint');gate.resolve();await moving;const deadline=Date.now()+1000;while(JSON.parse(f.checkpoint!.encodedState!).draft!==f.buffer.text&&Date.now()<deadline)await new Promise(r=>setTimeout(r,1));
 assert.equal(f.buffer.text,'Latest draft during checkpoint');assert.equal(f.buffer.hasRecoveryConflict,false);const state=JSON.parse(f.checkpoint!.encodedState!);assert.equal(state.draft,f.buffer.text);assert.equal(state.base.path,'Two.md');assert.equal(state.base.revision,'renamed');
 await f.buffer.flush();assert.equal(await f.adapter.read('Two.md'),f.buffer.text);assert.equal(f.plans,1);await f.buffer.dispose();
});

test('a known move never clears an already established durable conflict',async t=>{
 const f=await fixture(t);f.buffer.update('Retained conflict');f.row.entry.revision='peer';await assert.rejects(f.buffer.reload());f.release.resolve();await f.vault.rename('One.md','Two.md');
 await assert.rejects(f.buffer.relocate('Two.md'));assert.equal(f.buffer.hasRecoveryConflict,true);assert.equal(f.buffer.text,'Retained conflict');assert.equal(f.buffer.savedDurableWitness?.revision,'original');assert.equal(f.plans,0);await assert.rejects(f.buffer.dispose());
});
