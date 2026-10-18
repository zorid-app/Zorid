'use strict';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>object(v)&&Object.keys(v).every(key=>names.includes(key));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const snapshotId=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const time=v=>Number.isSafeInteger(v)&&v>=0;
const cursor=v=>keys(v,['captured_at_ms','snapshot_id'])&&time(v.captured_at_ms)&&snapshotId(v.snapshot_id);
const path=v=>typeof v==='string'&&Buffer.byteLength(v)<=4096&&!/[\\\u0000-\u001f\u007f]/.test(v)&&!v.startsWith('/')&&!/^[A-Za-z]:/.test(v)&&!v.split('/').some(part=>!part||part==='.'||part==='..')&&!/^\.zorid(?:\/|$)/i.test(v);
const version=v=>keys(v,['snapshotId','entryId','path','capturedAtMs','byteLength'])&&snapshotId(v.snapshotId)&&id(v.entryId)&&path(v.path)&&time(v.capturedAtMs)&&Number.isSafeInteger(v.byteLength)&&v.byteLength>=0&&v.byteLength<=16*1024*1024;
const older=(value,before)=>value.capturedAtMs<before.captured_at_ms||value.capturedAtMs===before.captured_at_ms&&BigInt(value.snapshotId)<BigInt(before.snapshot_id);
function captureRecoveryList(entryId,options={}) {
  if(!id(entryId)||!keys(options,['limit','before'])||!Number.isInteger(options.limit)||options.limit<1||options.limit>100||(options.before!==undefined&&!cursor(options.before)))throw new Error('Invalid history request');
  return Object.freeze({method:'recovery_list',entry_id:entryId,limit:options.limit,...(options.before?{before:Object.freeze({...options.before})}:{})});
}
function captureRecoveryRead(entryId,selected) {
  if(!id(entryId)||!snapshotId(selected))throw new Error('Invalid history request');
  return Object.freeze({method:'recovery_read',entry_id:entryId,snapshot_id:selected});
}
function validRecoveryReply(command,result,bytes) {
  if(command.method==='recovery_read')return keys(result,['version'])&&version(result.version)&&result.version.entryId===command.entry_id&&result.version.snapshotId===command.snapshot_id&&bytes.length===result.version.byteLength;
  if(!keys(result,['versions','nextCursor'])||bytes.length||!Array.isArray(result.versions)||result.versions.length>command.limit)return false;
  let before=command.before;
  for(const row of result.versions){
    if(!version(row)||row.entryId!==command.entry_id||before&&!older(row,before))return false;
    before={captured_at_ms:row.capturedAtMs,snapshot_id:row.snapshotId};
  }
  return result.nextCursor===undefined?result.versions.length<command.limit:result.versions.length===command.limit&&cursor(result.nextCursor)&&result.nextCursor.captured_at_ms===before.captured_at_ms&&result.nextCursor.snapshot_id===before.snapshot_id;
}
module.exports={captureRecoveryList,captureRecoveryRead,validRecoveryReply};
