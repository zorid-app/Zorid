import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePasteReceipt} from './paste-probe.mjs';
const expected={'text/plain':'known fixture','text/markdown':'','obsidian/table':'','obsidian/bases-cells':''};
function event(data=expected,trusted=true){
  return{isTrusted:trusted,prevented:false,stopped:false,clipboardData:{types:Object.keys(data),getData:type=>data[type]??''},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
}
test('unexpected actual text/raw bytes and custom type names never enter the receipt',()=>{
  const secret='private-token-not-for-evidence',e=event({'text/plain':secret,'obsidian/bases-cells':secret,[secret]:secret});
  const receipt=nativePasteReceipt(e,expected);
  assert.equal(receipt.accepted,false);assert.equal(e.prevented,true);assert.equal(e.stopped,true);assert.equal(receipt.unknownFormatCount,1);assert.equal(JSON.stringify(receipt).includes(secret),false);
});
test('matching trusted fixture events reach normal product handlers unchanged',()=>{
  const e=event(),receipt=nativePasteReceipt(e,expected);assert.equal(receipt.accepted,true);assert.equal(e.prevented,false);assert.equal(e.stopped,false);assert.deepEqual(e.clipboardData.types,Object.keys(expected));
});
test('untrusted matching events cannot establish native evidence',()=>{
  const e=event(expected,false),receipt=nativePasteReceipt(e,expected);assert.equal(receipt.accepted,false);assert.equal(e.prevented,true);assert.equal(e.stopped,true);
});
test('clipboard read failures are discarded without exposing their native diagnostics',()=>{
  const secret='private-error-token',e=event();e.clipboardData.getData=()=>{throw Error(secret);};const receipt=nativePasteReceipt(e,expected);assert.equal(receipt.accepted,false);assert.equal(e.prevented,true);assert.equal(e.stopped,true);assert.equal(JSON.stringify(receipt).includes(secret),false);
});
