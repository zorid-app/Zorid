import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {observeOwnedChild,cleanupOwnedResources} from './cleanup.mjs';
// Source-helper checks only. This bounded child is Node, never Chrome or Vite.
test('owned child cleanup retains raw PID/exit and confirms owned profile absence',async()=>{
  const profile=await mkdtemp(path.join(tmpdir(),'zorid-workblock-cleanup-source-'));
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),childReceipt=observeOwnedChild(child);
  let closeCalls=0;
  try{
    await once(child,'spawn');
    const receipt=await cleanupOwnedResources({chrome:child,childReceipt,profile,server:{async close(){closeCalls++;}},exitWaitMs:1000});
    assert.deepEqual(receipt.failures,[]);assert.equal(receipt.chrome.pid,child.pid);assert.equal(receipt.chrome.confirmedExit,true);
    assert.ok(receipt.chrome.raw.events.some(event=>event.event==='spawn'&&event.pid===child.pid));
    assert.ok(receipt.chrome.raw.events.some(event=>event.event==='exit'));
    assert.equal(receipt.profile.removed,true);assert.equal(receipt.profile.absenceErrorCode,'ENOENT');
    assert.equal(receipt.vite.closeResolved,true);assert.equal(closeCalls,1);
    await assert.rejects(stat(profile),error=>error.code==='ENOENT');
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
    await rm(profile,{recursive:true,force:true});
  }
});
test('a server close failure is retained while independent owned profile cleanup still completes',async()=>{
  const profile=await mkdtemp(path.join(tmpdir(),'zorid-workblock-cleanup-failure-'));
  try{
    const receipt=await cleanupOwnedResources({profile,server:{async close(){throw new Error('deliberate close failure');}}});
    assert.equal(receipt.chrome.status,'not_started');assert.equal(receipt.vite.closeResolved,false);
    assert.equal(receipt.vite.status,'close_failed');assert.ok(receipt.failures.some(item=>item.resource==='vite'&&item.message.includes('deliberate close failure')));
    assert.equal(receipt.profile.removed,true);assert.equal(receipt.profile.absenceErrorCode,'ENOENT');
  }finally{await rm(profile,{recursive:true,force:true});}
});
