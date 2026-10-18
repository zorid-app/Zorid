'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {captureRecoveryList,captureRecoveryRead,validRecoveryReply}=require('../desktop/recovery-history.cjs');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {dispatchVaultOperation}=require('../desktop/vault-dispatch.cjs');
const row=(overrides={})=>({snapshotId:'2',entryId:'note',path:'Note.md',capturedAtMs:100,byteLength:3,...overrides});
test('history request capture is bounded and detached from mutable caller cursors',()=>{
  const options={limit:20,before:{captured_at_ms:100,snapshot_id:'9'}};
  const command=captureRecoveryList('note',options);options.before.snapshot_id='1';assert.equal(command.before.snapshot_id,'9');
  for(const invalid of [{limit:0},{limit:101},{limit:1,before:{captured_at_ms:-1,snapshot_id:'1'}},{limit:1,before:{captured_at_ms:0,snapshot_id:'9223372036854775808'}}])assert.throws(()=>captureRecoveryList('note',invalid));
  for(const invalid of ['0','01','-1','1e3','9223372036854775808'])assert.throws(()=>captureRecoveryRead('note',invalid));
});
test('history replies enforce scope, strict ordering, matched cursors and exact body length',()=>{
  const command=captureRecoveryList('note',{limit:2});
  const result={versions:[row(),row({snapshotId:'1'})],nextCursor:{captured_at_ms:100,snapshot_id:'1'}};
  assert.equal(validRecoveryReply(command,result,Buffer.alloc(0)),true);
  for(const invalid of [
    {...result,versions:[row({entryId:'other'})]},
    {...result,versions:[row(),row()]},
    {...result,nextCursor:{captured_at_ms:100,snapshot_id:'2'}},
    {...result,versions:[row({path:'../Note.md'})]},
    {...result,versions:[row({path:'bad\u0000.md'})]},
    {...result,versions:[row({path:'bad\\name.md'})]},
  ])assert.equal(validRecoveryReply(command,invalid,Buffer.alloc(0)),false);
  const read=captureRecoveryRead('note','2');
  assert.equal(validRecoveryReply(read,{version:row()},Buffer.from('abc')),true);
  assert.equal(validRecoveryReply(read,{version:row({entryId:'other'})},Buffer.from('abc')),false);
  assert.equal(validRecoveryReply(read,{version:row()},Buffer.from('ab')),false);
  for(const path of ['../Note.md','bad\u0000.md','bad\\name.md','/private/Note.md','.zorid/recovery.sqlite'])assert.equal(validRecoveryReply(read,{version:row({path})},Buffer.from('abc')),false);
  assert.equal(validRecoveryReply(command,result,Buffer.from('x')),false);
});
test('UTF-8 history decoding preserves BOM and rejects malformed bytes instead of replacing them',async()=>{
  const content='\ufeffOlder α\n',bytes=Buffer.from(content);
  const context={request:async command=>({result:{version:row({snapshotId:command.snapshot_id,byteLength:bytes.length})},bytes})};
  const reply=await RustVaultService.prototype.recoveryRead.call(context,'note','2');assert.equal(reply.content,content);
  context.request=async()=>({result:{version:row({byteLength:1})},bytes:Buffer.from([255])});
  await assert.rejects(RustVaultService.prototype.recoveryRead.call(context,'note','2'),/encoded data/i);
});
test('history IPC retains the selected-root fence and only invokes the selected service',async()=>{
  let calls=0;
  const vault={root:'/selected',recoveryList:async()=>{calls++;return{versions:[]};}};
  assert.throws(()=>dispatchVaultOperation(vault,'/old','recoveryList',['note',{limit:20}]));assert.equal(calls,0);
  assert.deepEqual(await dispatchVaultOperation(vault,'/selected','recoveryList',['note',{limit:20}]),{versions:[]});assert.equal(calls,1);
});

test('preload exposes only the two bounded selected-vault history calls',async()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');let exposed;const calls=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,surface)=>{exposed=surface;}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return{};}},webUtils:{}})});
  await exposed.recoveryList('/selected','note',{limit:20});await exposed.recoveryRead('/selected','note','2');
  assert.equal(calls[0][0],'zorid:recoveryList');assert.equal(calls[0][1],'/selected');assert.equal(calls[1][0],'zorid:recoveryRead');assert.equal(calls[1][3],'2');
});
