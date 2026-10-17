import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { AcceptedReplySchema, PullReplySchema, HelloRequestSchema } from '../src/generated/zorid/sync/rpc/v1/relay_pb.ts';
const fixture=name=>new Uint8Array(readFileSync(new URL(`../proto/fixtures/${name}.bin`,import.meta.url)));
test('RPC accepted uses bigint and preserves control message presence',()=>{
 const bytes=fixture('rpc-accepted');const value=fromBinary(AcceptedReplySchema,bytes);
 assert.equal(value.sequence,9007199254740993n);assert.ok(value.control);
 assert.deepEqual(toBinary(AcceptedReplySchema,value),bytes);
});
test('RPC empty page keeps present zero positions and explicit completion',()=>{
 const bytes=fixture('rpc-empty-page');const value=fromBinary(PullReplySchema,bytes);
 assert.equal(value.next.after,0n);assert.equal(value.through,0n);assert.equal(value.complete,true);
 assert.deepEqual(toBinary(PullReplySchema,value),bytes);
 assert.equal(create(PullReplySchema).through,undefined);assert.equal(create(PullReplySchema).complete,undefined);
});
test('RPC incomplete page preserves false and exact opaque bytes',()=>{
 const bytes=fixture('rpc-incomplete-page');const value=fromBinary(PullReplySchema,bytes);
 assert.equal(value.complete,false);assert.deepEqual(value.items[0].exactWire,Uint8Array.of(0,255,128,1));
 assert.deepEqual(toBinary(PullReplySchema,value),bytes);
});
test('standard singular message merge accumulates required features in both orders',()=>{
 const first=toBinary(HelloRequestSchema,create(HelloRequestSchema,{offeredTransportMajors:[2],control:{requiredFeatures:['future']}}));
 const empty=toBinary(HelloRequestSchema,create(HelloRequestSchema,{control:{}}));
 for(const [a,b]of [[first,empty],[empty,first]]){
  const merged=new Uint8Array(a.length+b.length);merged.set(a);merged.set(b,a.length);
  assert.deepEqual(fromBinary(HelloRequestSchema,merged).control.requiredFeatures,['future']);
 }
});
