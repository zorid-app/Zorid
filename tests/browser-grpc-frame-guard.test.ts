import test from 'node:test';
import assert from 'node:assert/strict';
import { guardGrpcWebFrames } from '../src/platform/browser-grpc-frame-guard.ts';

const limits={maxMessageBytes:32,maxTrailerBytes:32,maxBodyBytes:74};
function frame(flags:number,bytes:Uint8Array,declared=bytes.length):Uint8Array {
  const result=new Uint8Array(5+bytes.length);result[0]=flags;new DataView(result.buffer).setUint32(1,declared,false);result.set(bytes,5);return result;
}
function source(parts:Uint8Array[],cancelled?:()=>void):ReadableStream<Uint8Array> {return new ReadableStream({pull(c){const part=parts.shift();if(part)c.enqueue(part);else c.close();},cancel(){cancelled?.();}});}
async function collect(stream:ReadableStream<Uint8Array>):Promise<Uint8Array> {const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0;for(;;){const value=await reader.read();if(value.done)break;parts.push(value.value);size+=value.value.length;}const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;}
const text=new TextEncoder();
test('five-byte 0xffffffff envelope is rejected before any header is forwarded',async()=>{
  let cancelled=false;const stream=guardGrpcWebFrames(source([frame(0,new Uint8Array(0),0xffffffff)],()=>{cancelled=true;}),limits);
  await assert.rejects(stream.getReader().read(),{code:'sync_response_limit'});assert.equal(cancelled,true);
});
test('fragmented five-byte headers preserve exact body and captured protobuf bytes',async()=>{
  const bytes=Uint8Array.from([0,255,128,34]),data=frame(0,bytes),trailer=frame(128,text.encode('grpc-status: 0\r\n'));
  let captured:Uint8Array|undefined;const pieces=[...data,...trailer].map(value=>Uint8Array.of(value));
  const result=await collect(guardGrpcWebFrames(source(pieces),limits,{onMessage(value){captured=value;}}));
  assert.deepEqual(result,Uint8Array.from([...data,...trailer]));assert.deepEqual(captured,bytes);bytes.fill(42);assert.notDeepEqual(captured,bytes);
});
for(const flags of [1,2,129,255])test(`unsupported compression/flags ${flags} never reach the decoder`,async()=>{
  await assert.rejects(guardGrpcWebFrames(source([frame(flags,new Uint8Array(0))]),limits).getReader().read(),{code:'sync_invalid_response'});
});
test('unary extra data frame, duplicate trailer, and data after trailer are rejected',async()=>{
  for(const frames of [[frame(0,Uint8Array.of(1)),frame(0,Uint8Array.of(2))],[frame(128,new Uint8Array()),frame(128,new Uint8Array())],[frame(128,new Uint8Array()),frame(0,new Uint8Array())]]) {
    await assert.rejects(collect(guardGrpcWebFrames(source(frames),limits)),{code:'sync_invalid_response'});
  }
});
test('message, trailer and cumulative body limits are independent',async()=>{
  for(const [frames,bounds]of [[ [frame(0,new Uint8Array(),33)],limits ],[ [frame(128,new Uint8Array(),33)],limits ],[ [frame(0,new Uint8Array(20)),frame(128,new Uint8Array(20))],{...limits,maxBodyBytes:45} ]] as const) {
    await assert.rejects(collect(guardGrpcWebFrames(source([...frames]),bounds)),{code:'sync_response_limit'});
  }
});
test('truncated header and truncated payload reject without fabricating EOF',async()=>{
  for(const parts of [[Uint8Array.of(0,0,0)],[frame(0,Uint8Array.of(1),2)]])await assert.rejects(collect(guardGrpcWebFrames(source(parts),limits)),{code:'sync_invalid_response'});
});
test('abort interrupts a peer-controlled stalled read and cancellation never waits for peer',async()=>{
  const abort=new AbortController();let cancelled=false;
  const stalled=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}});
  const reader=guardGrpcWebFrames(stalled,limits,{signal:abort.signal}).getReader(),pending=reader.read();abort.abort();
  await assert.rejects(pending,{code:'sync_aborted'});assert.equal(cancelled,true);
});
test('separate calls capture isolated payloads and source errors retain rejection',async()=>{
  const captured:Uint8Array[]=[];
  await Promise.all([1,2].map(async n=>{await collect(guardGrpcWebFrames(source([frame(0,Uint8Array.of(n)),frame(128,new Uint8Array())]),limits,{onMessage:bytes=>{captured.push(bytes);}}));}));
  assert.deepEqual(captured.map(bytes=>bytes[0]).sort(),[1,2]);
  await assert.rejects(collect(guardGrpcWebFrames(new ReadableStream({start(c){c.error(new Error('source failed'));}}),limits)),/source failed/);
});
