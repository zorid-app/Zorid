import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blobBinarySource,writeBinarySource,readBinarySink} from '../src/core/binary-transfer.ts';
import type {BinaryStreams,BinaryStageRef,BinaryReadRef} from '../src/core/binary-streams.ts';
const ref:BinaryStageRef={localStoreId:'store',clientId:'client',operationId:'operation',stageId:'stage'};
const pin:BinaryReadRef={localStoreId:'store',clientId:'client',readId:'read',entryId:'entry',entryRevision:'revision',selectedContentEvent:'event',length:'3'};
function fixture(){
  const calls:string[]=[],received:Uint8Array[]=[];
  const streams={limits:{maxFileBytes:'67108864',maxChunkBytes:2,smallReadBytes:'4'},
    async begin(input){calls.push('begin');assert.equal(input.expectedLength,'3');return ref;},
    async append(_ref,input){calls.push('append');received.push(input.bytes);return{sequence:input.sequence,offset:input.offset,bytes:input.bytes.length,digest:'a'.repeat(64),acceptedLength:String(BigInt(input.offset)+BigInt(input.bytes.length))};},
    async seal(){calls.push('seal');return{length:'3',sha256:'b'.repeat(64)};},
    async commit(){calls.push('commit');return 'receipt';},
    async closeRead(){calls.push('close');},async openRead(){calls.push('open');return pin;},
    async read(_ref,input){calls.push('read');const offset=Number(input.offset),bytes=new Uint8Array([1,2,3]).slice(offset,offset+input.maxBytes);return{bytes,nextOffset:String(offset+bytes.length),eof:offset+bytes.length===3};},
    async abort(){calls.push('abort');},async query(){throw new Error('not used');},
  } satisfies BinaryStreams;
  return {streams,calls,received};
}
const input={operationId:'operation',target:{kind:'create' as const,entryId:'entry',path:'file.bin'}};
test('Blob source slices bounded chunks and stage receives exact sequential offsets',async()=>{
  const f=fixture(),source=blobBinarySource(new Blob([new Uint8Array([1,2,3])]));
  const result=await writeBinarySource(f.streams,input,source);
  assert.equal(result.receipt,'receipt');assert.deepEqual(f.received,[new Uint8Array([1,2]),new Uint8Array([3])]);
  assert.deepEqual(f.calls,['begin','append','append','seal','commit']);
});
test('source length mismatch retains original stage without seal/commit/abort',async()=>{
  const f=fixture();await assert.rejects(writeBinarySource(f.streams,input,{length:'3',read:async()=>null}),error=>{
    assert.deepEqual((error as any).binaryStage,ref);return true;
  });assert.deepEqual(f.calls,['begin']);
});
test('uncertain commit error carries stage and never starts another operation',async()=>{
  const f=fixture();f.streams.commit=async()=>{f.calls.push('commit');throw Object.assign(new Error('lost'),{code:'outcome_unknown',commitUncertain:true});};
  await assert.rejects(writeBinarySource(f.streams,input,blobBinarySource(new Blob(['abc']))),error=>{assert.equal((error as any).code,'outcome_unknown');assert.equal((error as any).commitUncertain,true);assert.deepEqual((error as any).binaryStage,ref);return true;});assert.equal(f.calls.filter(x=>x==='begin').length,1);assert.ok(!f.calls.includes('abort'));
});
test('oversized source is rejected before creating stage',async()=>{
  const f=fixture();await assert.rejects(writeBinarySource(f.streams,input,{length:'67108865',read:async()=>{throw new Error('no');}}),{code:'too_large'});assert.deepEqual(f.calls,[]);
});
test('sink closes exact pinned EOF before publishing',async()=>{
  const f=fixture(),bytes:number[]=[];
  await readBinarySink(f.streams,{entryId:'entry',expectedRevision:'revision'},{write:async chunk=>{bytes.push(...chunk);},finish:async()=>{f.calls.push('finish');},abort:async()=>{f.calls.push('discard');}});
  assert.deepEqual(bytes,[1,2,3]);assert.deepEqual(f.calls,['open','read','read','close','finish']);
});
test('small read limit rejects pinned length before any chunk or output allocation',async()=>{
  const f=fixture();await assert.rejects(readBinarySink(f.streams,{entryId:'entry'},{write:async()=>{throw new Error('no');},finish:async()=>{throw new Error('no');},abort:async()=>{f.calls.push('discard');}},{maxBytes:'2'}),{code:'stream_required'});assert.deepEqual(f.calls,['open','close','discard']);
});
test('incorrect EOF aborts private output and closes pin without finish',async()=>{
  const f=fixture();f.streams.read=async()=>({bytes:new Uint8Array([1]),nextOffset:'1',eof:true});
  await assert.rejects(readBinarySink(f.streams,{entryId:'entry'},{write:async()=>{f.calls.push('write');},finish:async()=>{f.calls.push('finish');},abort:async()=>{f.calls.push('discard');}}),{code:'invalid_binary_read'});assert.deepEqual(f.calls,['open','close','discard']);
});
test('generation invalidation during source read retains inert stage',async()=>{
  const f=fixture();let active=true;
  await assert.rejects(writeBinarySource(f.streams,input,{length:'3',read:async()=>{active=false;return new Uint8Array([1,2]);}},()=>{if(!active)throw Object.assign(new Error('retired'),{code:'client_not_admitted'});}),{code:'client_not_admitted'});assert.deepEqual(f.calls,['begin']);
});
test('lost begin acknowledgement retains original complete operation request',async()=>{
  const f=fixture();f.streams.begin=async()=>{throw Object.assign(new Error('lost begin'),{code:'outcome_unknown'});};
  await assert.rejects(writeBinarySource(f.streams,input,blobBinarySource(new Blob(['abc']))),error=>{assert.deepEqual((error as any).binaryOperation,{...input,expectedLength:'3'});assert.equal((error as any).binaryStage,undefined);return true;});
});
test('short source pulls coalesce into canonical chunks before durable append',async()=>{
  const f=fixture();let next=0;await writeBinarySource(f.streams,input,{length:'3',read:async()=>next<3?new Uint8Array([++next]):null});
  assert.deepEqual(f.received,[new Uint8Array([1,2]),new Uint8Array([3])]);
});
