import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {blobBinarySource} from '../src/core/binary-transfer.ts';
import type {BinaryStreams,BinaryStageRequest,BinaryStageRef} from '../src/core/binary-streams.ts';
import type {VaultAdapter} from '../src/core/types.ts';
async function fixture(){
  const memory=new MemoryAdapter({'file.bin':new Uint8Array([1,2,3])}),calls:string[]=[];
  let revision='r1',currentEvent='e1',currentId='file',pending:BinaryStageRequest|undefined,data:number[]=[],beforeCommit:()=>Promise<void>=async()=>{};
  const ref:BinaryStageRef={localStoreId:'local',clientId:'client',operationId:'',stageId:'stage'};
  const stat=async(path:string)=>{const value=await memory.stat(path);return value?{...value,entryId:currentId,revision}:null;};
  const streams:BinaryStreams={limits:{maxFileBytes:'67108864',maxChunkBytes:2,smallReadBytes:'4'},
    begin:async input=>{calls.push('begin');pending=structuredClone(input);data=[];return{...ref,operationId:input.operationId};},
    append:async(_ref,input)=>{calls.push('append');data.push(...input.bytes);return{sequence:input.sequence,offset:input.offset,bytes:input.bytes.length,digest:'a'.repeat(64),acceptedLength:String(data.length)};},
    seal:async()=>({length:String(data.length),sha256:'b'.repeat(64)}),
    commit:async()=>{calls.push('commit');await beforeCommit();const target=pending!.target;
      if(target.kind==='create'){if(await memory.stat(target.path))throw Object.assign(new Error('peer exists'),{code:'revision_conflict'});await memory.createBinary(target.path,new Uint8Array(data));currentId=target.entryId;}
      else{if(target.entryId!==currentId||target.expectedRevision!==revision||target.expectedContentEvent!==currentEvent)throw Object.assign(new Error('peer changed'),{code:'revision_conflict'});await memory.writeBinary('file.bin',new Uint8Array(data));}
      revision='r2';currentEvent='e2';return 'receipt';},
    abort:async()=>{calls.push('abort');},query:async()=>{throw new Error('unused');},
    openRead:async input=>{calls.push('open');assert.equal(input.entryId,currentId);assert.equal(input.expectedRevision,revision);return{localStoreId:'local',clientId:'client',readId:'read',entryId:currentId,entryRevision:revision,selectedContentEvent:currentEvent,length:String((await memory.readBinary('file.bin')).length)};},
    read:async(_ref,input)=>{calls.push('read');const bytes=(await memory.readBinary('file.bin')).slice(Number(input.offset),Number(input.offset)+input.maxBytes),next=Number(input.offset)+bytes.length;return{bytes,nextOffset:String(next),eof:next===(await memory.stat('file.bin'))!.size};},
    closeRead:async()=>{calls.push('close');},
  };
  const adapter:VaultAdapter={binaryStreams:streams,list:async()=>Promise.all((await memory.list()).map(async item=>(await stat(item.path))!)),stat,read:path=>memory.read(path),write:(path,text)=>memory.write(path,text),mkdir:path=>memory.mkdir(path),rename:(a,b)=>memory.rename(a,b),trash:path=>memory.trash(path),
    createBinary:async()=>{throw new Error('legacy create called');},writeBinary:async()=>{throw new Error('legacy write called');},readBinary:async()=>{throw new Error('legacy read called');}};
  const vault=new Vault(adapter);await vault.initialize();
  return {vault,adapter,streams,calls,memory,request:()=>pending,setBeforeCommit(fn:()=>Promise<void>){beforeCommit=fn;},async peer(){revision='peer';currentEvent='peer-event';await memory.writeBinary('file.bin',new Uint8Array([9]));}};
}
test('Vault stream-capable convenience APIs bypass legacy binary calls and snapshot caller bytes',async()=>{
  const f=await fixture(),bytes=new Uint8Array([7,8,9]);const work=f.vault.createBinary('new.bin',bytes);bytes.fill(0);await work;
  assert.deepEqual(await f.memory.readBinary('new.bin'),new Uint8Array([7,8,9]));assert.equal(f.request()!.target.kind,'create');
});
test('Vault pins metadata identity/event then rejects a peer edit during streaming commit',async()=>{
  const f=await fixture();f.setBeforeCommit(()=>f.peer());await assert.rejects(f.vault.modifyBinaryStream('file.bin',blobBinarySource(new Blob(['new']))),{code:'revision_conflict'});
  assert.deepEqual(await f.memory.readBinary('file.bin'),new Uint8Array([9]));assert.deepEqual(f.request()!.target,{kind:'write',entryId:'file',expectedRevision:'r1',expectedContentEvent:'e1'});assert.ok(f.calls.indexOf('close')<f.calls.indexOf('begin'));assert.equal(f.vault.entries.get('file.bin')!.revision,'r1');
});
test('Vault small read uses bounded pin and large convenience write fails without fallback',async()=>{
  const f=await fixture();assert.deepEqual(await f.vault.readBinary('file.bin'),new Uint8Array([1,2,3]));assert.deepEqual(f.calls,['open','read','read','close']);
  assert.throws(()=>f.vault.createBinary('large.bin',new Uint8Array(5)),{code:'stream_required'});assert.deepEqual(f.calls,['open','read','read','close']);
});
test('Vault adapter replacement during a source read prevents further admission or publication',async()=>{
  const f=await fixture();let returned=false;
  await assert.rejects(f.vault.createBinaryStream('new.bin',{length:'3',read:async()=>{returned=true;f.vault.adapter=new MemoryAdapter();return new Uint8Array([7,8]);}}),{code:'intent_identity_mismatch'});
  assert.equal(returned,true);assert.deepEqual(f.calls,['begin']);assert.equal(await f.memory.stat('new.bin'),null);assert.equal(f.vault.entries.has('new.bin'),false);
});
test('stalled source leaves unrelated Vault writes available',async()=>{
  const f=await fixture();let resume!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{resume=resolve;});let first=true;
  const work=f.vault.createBinaryStream('new.bin',{length:'1',read:async()=>{if(!first)return null;first=false;entered();await wait;return new Uint8Array([7]);}});
  await started;await f.vault.create('unrelated.md','text');assert.equal(await f.vault.read('unrelated.md'),'text');resume();await work;
});
test('modification pin lookup never holds the metadata queue while waiting for binary I/O',async()=>{
  const f=await fixture(),original=f.streams.openRead;let resume!:()=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{resume=resolve;});
  f.streams.openRead=async input=>{entered();await wait;return original(input);};
  const modification=f.vault.modifyBinaryStream('file.bin',blobBinarySource(new Blob(['x'])));await started;
  let written=false;const unrelated=f.vault.create('unrelated.md','text').then(()=>{written=true;});
  await new Promise(resolve=>setImmediate(resolve));const responsive=written;resume();await Promise.all([modification,unrelated]);
  assert.equal(responsive,true);assert.equal(await f.vault.read('unrelated.md'),'text');
});
test('known commit receipt survives publication failure and no second commit runs',async()=>{
  const f=await fixture(),stat=f.adapter.stat!;let failPublication=false;f.setBeforeCommit(async()=>{failPublication=true;});f.adapter.stat=async path=>{if(failPublication&&path==='new.bin')throw new Error('stat failed');return stat(path);};
  await assert.rejects(f.vault.createBinaryStream('new.bin',blobBinarySource(new Blob(['x']))),error=>{assert.equal((error as any).code,'binary_publication_failed');assert.equal((error as any).binaryCommitted.receipt,'receipt');assert.equal((error as any).binaryCommitted.ref.stageId,'stage');return true;});
  assert.deepEqual(await f.memory.readBinary('new.bin'),new Uint8Array([120]));assert.equal(f.calls.filter(x=>x==='commit').length,1);
});
test('large Markdown binary publication and reload do not decode content',async()=>{
  const f=await fixture(),read=f.adapter.read;f.adapter.read=async path=>{if(path==='large.md')throw new Error('large whole text read');return read(path);};
  await f.vault.createBinaryStream('large.md',blobBinarySource(new Blob(['large content'])));assert.equal(f.vault.metadata.get('large.md'),undefined);assert.equal(f.vault.entries.get('large.md')!.size,13);await f.vault.reload();assert.equal(f.vault.entries.has('large.md'),true);
});
test('metadata rejection aborts sink without opening a pin',async()=>{
  const f=await fixture();let aborted=false;await assert.rejects(f.vault.readBinaryStream('absent.bin',{write:async()=>{},finish:async()=>{},abort:async()=>{aborted=true;}}));assert.equal(aborted,true);assert.deepEqual(f.calls,[]);
});
test('publication never binds a committed operation to a replacement at its old path',async()=>{
  const f=await fixture(),stat=f.adapter.stat!;let committed=false;f.setBeforeCommit(async()=>{committed=true;});f.adapter.stat=async path=>{const value=await stat(path);return value&&committed?{...value,entryId:'replacement'}:value;};
  await assert.rejects(f.vault.createBinaryStream('new.bin',blobBinarySource(new Blob(['x']))),error=>{assert.equal((error as any).code,'binary_publication_failed');assert.equal((error as any).binaryCommitted.receipt,'receipt');return true;});assert.equal(f.vault.entries.has('new.bin'),false);assert.equal(f.calls.filter(x=>x==='commit').length,1);
});
