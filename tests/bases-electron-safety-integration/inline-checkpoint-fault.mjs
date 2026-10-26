import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const sourceDigest=source=>createHash('sha256').update(source).digest('hex');
export function assertPreparedInlineWrite(held,{file,entryId,desired}){
  assert.equal(held.kind,'held');assert.equal(held.path,file);assert.equal(held.entryId,entryId);
  assert.equal(held.phase,'prepared');assert.equal(held.nativeState,'prepared');assert.equal(held.sequence,undefined);
  assert.match(held.token,/^[a-f0-9]{32}$/);assert.ok(held.nativeIntentToken&&held.operationId);
  assert.ok(Number.isSafeInteger(held.nativePid)&&held.nativePid>0&&Number.isSafeInteger(held.relayPid)&&held.relayPid>0);
  assert.equal(held.bodySha256,sourceDigest(desired),'The held inert preparation belongs to the exact whole containing-note source');
}
function noRelayFaults(events){assert.deepEqual(events.filter(event=>['watchdog-released','relay-failed'].includes(event.kind)),[],'A relay failure cannot satisfy the inline publication test');}
export function assertInlineCheckpointFailure(events,held){
  noRelayFaults(events);
  const index=events.findIndex(event=>event.kind==='held'&&event.token===held.token);assert.ok(index>=0,'The real prepared hold must be recorded');
  const negative=events.slice(index+1).find(event=>event.kind==='native-checkpoint-response'&&event.key==='note/v1/'+held.entryId&&!event.ok);
  assert.ok(negative,'A real checkpoint response must fail after the inert prepared reply');assert.equal(negative.errorCode,'checkpoint_storage');assert.equal(negative.commitUncertain,true);
  assert.match(negative.commandSha256,/^[a-f0-9]{64}$/);assert.match(negative.bodySha256,/^[a-f0-9]{64}$/);
  assert.equal(negative.nativePid,held.nativePid);assert.equal(negative.relayPid,held.relayPid);
  assert.equal(events.filter(event=>event.kind==='native-mutation-response'&&event.ok&&event.state==='committed'&&event.operationId===held.operationId).length,0,'The failed acknowledgement precedes any commit of this configuration');
  return negative;
}
export function assertOriginalInlineCheckpointRetry(events,{held,negative}){
  noRelayFaults(events);
  const index=events.findIndex(event=>event.kind==='native-checkpoint-response'&&!event.ok&&event.commandSha256===negative.commandSha256&&event.bodySha256===negative.bodySha256);assert.ok(index>=0);
  const replay=events.slice(index+1).find(event=>event.kind==='native-checkpoint-response'&&event.ok&&event.key===negative.key&&event.commandSha256===negative.commandSha256&&event.bodySha256===negative.bodySha256);
  assert.ok(replay,'The single original Retry first replays the exact failed checkpoint CAS');assert.equal(replay.nativePid,negative.nativePid);assert.equal(replay.relayPid,negative.relayPid);
  const prepared=events.filter(event=>event.kind==='native-prepared-write'&&event.entryId===held.entryId&&event.bodySha256===held.bodySha256);assert.equal(prepared.length,1,'Retry must not prepare a replacement configuration intent');assert.equal(prepared[0].token,held.nativeIntentToken);assert.equal(prepared[0].operationId,held.operationId);assert.equal(prepared[0].nativePid,held.nativePid);assert.equal(prepared[0].relayPid,held.relayPid);
  const commits=events.filter(event=>event.kind==='native-mutation-response'&&event.ok&&event.state==='committed'&&event.operationId===held.operationId);assert.equal(commits.length,1,'One actual commit of the original prepared configuration');
  const commit=commits[0];assert.equal(commit.method,'commit_intent');assert.equal(commit.referenceToken,held.nativeIntentToken);assert.equal(commit.preparedBodySha256,held.bodySha256);assert.equal(commit.nativePid,held.nativePid);assert.equal(commit.relayPid,held.relayPid);assert.ok(events.indexOf(commit)>events.indexOf(replay),'Original checkpoint replay precedes its original commit');
  return {replay,commit};
}

/** A real access failure on the runner-owned disposable lock. Keep a descriptor
 * to restore this exact inode; never chmod a replacement path during cleanup. */
export async function withDeniedOwnedVaultLock({vault,outputDirectory,evidence,label},run){
  const owned=await fs.realpath(vault),out=await fs.realpath(outputDirectory),privateDirectory=path.join(owned,'.zorid'),lock=path.join(privateDirectory,'vault.lock');
  assert.equal(path.resolve(vault),owned);assert.ok(owned.startsWith(path.join(out,'disposable')+path.sep),'Only a disposable vault under this owned evidence directory may lose lock access');
  assert.equal(await fs.realpath(privateDirectory),privateDirectory,'Private lock parent cannot redirect');
  const initial=await fs.lstat(lock);assert.ok(initial.isFile()&&!initial.isSymbolicLink());assert.equal(initial.uid,process.getuid());assert.equal(initial.nlink,1);
  const mode=initial.mode&0o7777;assert.equal(mode&0o600,0o600,'The owned lock starts readable and writable by its user');
  const handle=await fs.open(lock,constants.O_RDONLY|constants.O_NOFOLLOW);
  const sameLock=async()=>{const current=await fs.lstat(lock),opened=await handle.stat();for(const value of [current,opened]){assert.ok(value.isFile()&&!value.isSymbolicLink());assert.equal(value.dev,initial.dev);assert.equal(value.ino,initial.ino);assert.equal(value.uid,initial.uid);assert.equal(value.nlink,1);}return current;};
  let denied=false;
  try{
    await sameLock();await handle.chmod(0o000);denied=true;assert.equal((await sameLock()).mode&0o7777,0);
    evidence.actions.push({action:'owned-negative-inline-checkpoint-lock-access',label,lock,dev:initial.dev,ino:initial.ino,originalMode:mode,mode:'0000',phase:'after-real-inert-prepare-before-ref-checkpoint',at:Date.now()});
    return await run();
  }finally{
    try{if(denied){await handle.chmod(mode);const restored=await sameLock();assert.equal(restored.mode&0o7777,mode);evidence.actions.push({action:'restore-owned-inline-checkpoint-lock-access',label,lock,dev:initial.dev,ino:initial.ino,mode,at:Date.now()});}}
    finally{await handle.close();}
  }
}
