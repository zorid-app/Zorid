import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceDigest,assertPreparedInlineWrite,assertInlineCheckpointFailure,assertOriginalInlineCheckpointRetry,withDeniedOwnedVaultLock} from './inline-checkpoint-fault.mjs';

const desired='# Host 😀\n```base\nviews: [{type: table, name: New}]\n```\n',file='Owned/Host.md',entryId='entry1';
const identity={relayPid:101,nativePid:102};
const held={kind:'held',...identity,path:file,entryId,phase:'prepared',nativeState:'prepared',token:'a'.repeat(32),nativeIntentToken:'native1',operationId:'op1',bodySha256:sourceDigest(desired)};
const prepared={kind:'native-prepared-write',...identity,entryId,token:held.nativeIntentToken,operationId:held.operationId,bodySha256:held.bodySha256};
const negative={kind:'native-checkpoint-response',...identity,key:'note/v1/'+entryId,ok:false,errorCode:'checkpoint_storage',commitUncertain:true,commandSha256:'b'.repeat(64),bodySha256:'c'.repeat(64)};
const replay={...negative,ok:true,errorCode:undefined,commitUncertain:undefined};
const commit={kind:'native-mutation-response',...identity,method:'commit_intent',ok:true,state:'committed',operationId:held.operationId,referenceToken:held.nativeIntentToken,preparedBodySha256:held.bodySha256};

test('prepared checkpoint failure requires exact whole source, real correlation and no logical commit',()=>{
  assertPreparedInlineWrite(held,{file,entryId,desired});
  for(const edit of [v=>v.path='Other.md',v=>v.entryId='other',v=>v.phase='committed',v=>v.nativeState='committed',v=>v.sequence='2',v=>v.bodySha256=sourceDigest(desired+'x'),v=>v.nativePid=undefined,v=>v.token='wrong']){const wrong=structuredClone(held);edit(wrong);assert.throws(()=>assertPreparedInlineWrite(wrong,{file,entryId,desired}));}
  assert.equal(assertInlineCheckpointFailure([prepared,held,negative],held),negative);
  for(const events of [[prepared,held],[prepared,negative,held],[prepared,held,{...negative,errorCode:'projection_pending'}],[prepared,held,{...negative,commitUncertain:false}],[prepared,held,{...negative,nativePid:999}],[prepared,held,{...negative,commandSha256:undefined}],[prepared,held,negative,commit],[prepared,held,negative,{kind:'watchdog-released'}]])assert.throws(()=>assertInlineCheckpointFailure(events,held));
});
test('original retry requires the identical failed checkpoint CAS before its exact prepared intent commits once',()=>{
  const events=[prepared,held,negative,replay,commit],proof={held,negative};
  assert.deepEqual(assertOriginalInlineCheckpointRetry(events,proof),{replay,commit});
  for(const wrong of [[prepared,held,negative,commit,replay],[prepared,held,negative,{...replay,commandSha256:'d'.repeat(64)},commit],[prepared,held,negative,{...replay,bodySha256:'d'.repeat(64)},commit],[prepared,held,negative,{...replay,nativePid:999},commit],[prepared,held,negative,replay,{...commit,referenceToken:'replacement'}],[prepared,held,negative,replay,{...commit,preparedBodySha256:'d'.repeat(64)}],[prepared,held,negative,replay,{...commit,nativePid:999}],[prepared,held,negative,replay,commit,commit],[prepared,{...prepared,token:'replacement'},held,negative,replay,commit],[prepared,held,negative,replay,commit,{kind:'relay-failed'}]])assert.throws(()=>assertOriginalInlineCheckpointRetry(wrong,proof));
});

async function fixture(t){
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-inline-lock-fault-'))),out=path.join(base,'evidence'),vault=path.join(out,'disposable','vault'),privateDirectory=path.join(vault,'.zorid'),lock=path.join(privateDirectory,'vault.lock');
  await fs.mkdir(privateDirectory,{recursive:true});await fs.writeFile(lock,'',{mode:0o600});await fs.writeFile(path.join(vault,'Host.md'),'Original public source\n');
  const evidence={actions:[]};t.after(()=>fs.rm(base,{recursive:true,force:true}));
  return {base,out,vault,privateDirectory,lock,evidence,options:{vault,outputDirectory:out,evidence,label:'owned-inline-fixture'}};
}
test('owned fault denies and restores the exact inode while public source remains readable and unchanged',async t=>{
  const f=await fixture(t),before=await fs.lstat(f.lock);
  assert.equal(await withDeniedOwnedVaultLock(f.options,async()=>{const denied=await fs.lstat(f.lock);assert.equal(denied.mode&0o7777,0);assert.equal(denied.ino,before.ino);assert.equal(await fs.readFile(path.join(f.vault,'Host.md'),'utf8'),'Original public source\n');return 'actual body';}),'actual body');
  const after=await fs.lstat(f.lock);assert.equal(after.mode&0o7777,before.mode&0o7777);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(f.evidence.actions.length,2);assert.equal(f.evidence.actions[0].ino,f.evidence.actions[1].ino);
});
test('callback failure restores the exact lock in finally and retains the original failure',async t=>{
  const f=await fixture(t),failure=new Error('actual observation failed');
  await assert.rejects(withDeniedOwnedVaultLock(f.options,async()=>{throw failure;}),error=>error===failure);
  assert.equal((await fs.stat(f.lock)).mode&0o7777,0o600);assert.equal(f.evidence.actions.length,2);
});
test('an unowned vault and symlinked lock or private directory fail before changing permissions',async t=>{
  const f=await fixture(t),foreign=path.join(f.base,'foreign');await fs.mkdir(path.join(foreign,'.zorid'),{recursive:true});await fs.writeFile(path.join(foreign,'.zorid','vault.lock'),' ',{mode:0o600});
  const unreachable=()=>{throw Error('an unowned fault body must not run');};
  await assert.rejects(withDeniedOwnedVaultLock({...f.options,vault:foreign},unreachable));
  await fs.rename(f.lock,f.lock+'.original');await fs.symlink(f.lock+'.original',f.lock);await assert.rejects(withDeniedOwnedVaultLock(f.options,unreachable));assert.equal((await fs.stat(f.lock+'.original')).mode&0o7777,0o600);await fs.unlink(f.lock);await fs.rename(f.lock+'.original',f.lock);
  await fs.rename(f.privateDirectory,f.privateDirectory+'.original');await fs.symlink(f.privateDirectory+'.original',f.privateDirectory);await assert.rejects(withDeniedOwnedVaultLock(f.options,unreachable));assert.equal((await fs.stat(path.join(f.privateDirectory+'.original','vault.lock'))).mode&0o7777,0o600);
  assert.deepEqual(f.evidence.actions,[]);
});
test('hardlinked lock is rejected without changing either link',async t=>{
  const f=await fixture(t),other=path.join(f.vault,'Other lock');await fs.link(f.lock,other);
  await assert.rejects(withDeniedOwnedVaultLock(f.options,async()=>{throw Error('must not run');}));assert.equal((await fs.stat(other)).mode&0o7777,0o600);assert.deepEqual(f.evidence.actions,[]);
});
test('a replaced lock path fails the fixture and cleanup restores only the original open inode',async t=>{
  const f=await fixture(t),retained=f.lock+'.retained',before=await fs.stat(f.lock);
  await assert.rejects(withDeniedOwnedVaultLock(f.options,async()=>{await fs.rename(f.lock,retained);await fs.writeFile(f.lock,'Replacement sentinel',{mode:0o640});}));
  assert.equal((await fs.stat(retained)).ino,before.ino);assert.equal((await fs.stat(retained)).mode&0o7777,0o600);assert.equal((await fs.stat(f.lock)).mode&0o7777,0o640);assert.equal(await fs.readFile(f.lock,'utf8'),'Replacement sentinel');
});
