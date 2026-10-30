import test from 'node:test';
import assert from 'node:assert/strict';
import {captureHistoryList,captureHistoryRead,decodeHistory} from '../src/platform/desktop-recovery-history.ts';
const version={entryId:'entry',snapshotId:'2',path:'Earlier.md',capturedAtMs:100,byteLength:3};
const rejected=(run:()=>unknown)=>assert.throws(run,{code:'invalid_durable_response',source:'protocol',commitUncertain:false});
test('history requests retain the exact entry/snapshot and copy their pagination cursor',()=>{
 const before={captured_at_ms:101,snapshot_id:'3'},request=captureHistoryList('entry',{limit:2,before});before.snapshot_id='9';assert.equal(request.method,'recoveryList');if(request.method==='recoveryList')assert.equal(request.options.before!.snapshot_id,'3');
 assert.deepEqual(captureHistoryRead('entry','2'),{method:'recoveryRead',entryId:'entry',snapshotId:'2'});
 for(const value of ['0','01','-1','9223372036854775808'])rejected(()=>captureHistoryRead('entry',value));
 let accessed=false;const options={limit:2};Object.defineProperty(options,'before',{enumerable:true,get(){accessed=true;return before;}});rejected(()=>captureHistoryList('entry',options));assert.equal(accessed,false);
});
test('exact BOM and Unicode selected bodies are retained without another whole-body copy',()=>{
 const content='\ufeffα😀\r\n',byteLength=Buffer.byteLength(content);const result=decodeHistory(captureHistoryRead('entry','2'),{version:{...version,byteLength},content});assert.ok('content'in result);assert.equal(result.content,content);
});
test('history DTO failures remain terminal protocol evidence instead of authorizing IO retries',()=>{
 const read=captureHistoryRead('entry','2');
 for(const value of [
  {version:{...version,entryId:'foreign'},content:'old'},
  {version:{...version,snapshotId:'3'},content:'old'},
  {version:{...version,path:'../secret'},content:'old'},
  {version:{...version,path:'.zorid/recovery.sqlite'},content:'old'},
  {version:{...version,byteLength:2},content:'old'},
  {version:{...version},content:'\ud800'},
  {version:{...version},content:'old',unknown:true},
 ])rejected(()=>decodeHistory(read,value));
 const page=captureHistoryList('entry',{limit:2,before:{captured_at_ms:101,snapshot_id:'3'}});
 assert.deepEqual(decodeHistory(page,{versions:[version,{...version,snapshotId:'1'}],nextCursor:{captured_at_ms:100,snapshot_id:'1'}}),{versions:[version,{...version,snapshotId:'1'}],nextCursor:{captured_at_ms:100,snapshot_id:'1'}});
 for(const value of [
  {versions:[version,version],nextCursor:{captured_at_ms:100,snapshot_id:'2'}},
  {versions:[{...version,entryId:'foreign'}]},
  {versions:[version,{...version,snapshotId:'1'}]},
  {versions:[version,{...version,snapshotId:'1'}],nextCursor:{captured_at_ms:100,snapshot_id:'2'}},
  {versions:[],nextCursor:{captured_at_ms:100,snapshot_id:'2'}},
 ])rejected(()=>decodeHistory(page,value));
});
