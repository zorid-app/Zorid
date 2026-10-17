import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../src/ui/workspace.ts';

function fixture() {
  let handler:any,removed=0;
  const events:string[]=[];
  const host:any={root:{inert:false},closing:false,startupFailed:false,platformReleased:false,vaultGeneration:1,
    platform:{mobileLifecycle:{subscribe(callback:any){handler=callback;return()=>{removed++;};}}},
    flush:async()=>{events.push('flush');},saveSession:()=>events.push('session')};
  Object.setPrototypeOf(host,Workspace.prototype);
  (Workspace.prototype as any).bindMobileLifecycle.call(host);
  return {host,events,run:(reason:string,ack=async()=>{events.push('ack');})=>handler(reason,ack),removed:()=>removed};
}
test('background flush/session completes before ACK and restores editing without destroy/release',async()=>{
  const f=fixture();await f.run('background',async()=>{assert.equal(f.host.root.inert,true);f.events.push('ack');});
  assert.deepEqual(f.events,['flush','session','ack']);assert.equal(f.host.closing,false);assert.equal(f.host.root.inert,false);
});
test('successful native switch stays quiescent after flush and ACK',async()=>{
  const f=fixture();await f.run('switchVault');assert.deepEqual(f.events,['flush','session','ack']);assert.equal(f.host.closing,true);assert.equal(f.host.root.inert,true);
});
for(const failure of ['flush','session','stale_lifecycle'])test(`failed ${failure} preserves editor and never acknowledges unsafe switch`,async()=>{
  const f=fixture(),error=new Error(failure);
  if(failure==='flush')f.host.flush=async()=>{throw error;};
  if(failure==='session')f.host.saveSession=()=>{throw error;};
  await assert.rejects(f.run('switchVault',async()=>{if(failure==='stale_lifecycle')throw error;f.events.push('ack');}),error);
  assert.equal(f.host.closing,false);assert.equal(f.host.root.inert,false);assert.ok(!f.events.includes('ack'));
});
test('duplicate lifecycle cannot enter flush while first is pending; generation changes forbid ACK',async()=>{
  const f=fixture();let resolve!:()=>void;f.host.flush=()=>new Promise<void>(r=>{resolve=r;});
  const first=f.run('background');await assert.rejects(f.run('switchVault'),/not ready/);f.host.vaultGeneration++;resolve();
  await assert.rejects(first,/changed during save/);assert.equal(f.host.root.inert,false);assert.ok(!f.events.includes('ack'));
});
test('rebinding cleans old subscription and captured callback cannot ACK another platform',async()=>{
  const f=fixture(),old=f.run;f.host.platform={};(Workspace.prototype as any).bindMobileLifecycle.call(f.host);assert.equal(f.removed(),1);
  await assert.rejects(old('switchVault'),/not ready/);assert.equal(f.host.root.inert,false);
});
