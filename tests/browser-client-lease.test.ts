import test from 'node:test';
import assert from 'node:assert/strict';
import { claimBrowserClient } from '../src/platform/browser-client-lease.ts';

const scope = {vaultId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222'};
function fixture() {
  const held = new Map<string, { reject(error: Error): void }>();
  const options: LockOptions[] = [];
  const request = async (name: string, option: LockOptions, callback: (lock: Lock|null) => Promise<void>) => {
    options.push(option);
    if (held.has(name)) return callback(null);
    let reject!: (error: Error) => void;
    const lost = new Promise<void>((_, fail) => { reject = fail; });
    const owner = {reject}; held.set(name, owner);
    try { await Promise.race([callback({name,mode:'exclusive'} as Lock),lost]); }
    finally { if (held.get(name) === owner) held.delete(name); }
  };
  return {locks:{request} as Pick<LockManager,'request'>, held, options,
    lose() { const [name, owner] = [...held][0]; held.delete(name); owner.reject(new Error('lock lost')); }};
}

test('lifetime lease excludes the same authority/client and releases for exact restart identity', async () => {
  const f = fixture(), lease = await claimBrowserClient(f.locks, scope, () => assert.fail('unexpected loss'));
  lease.assertActive();
  await assert.rejects(claimBrowserClient(f.locks, {...scope}, () => {}), {code:'client_already_owned'});
  assert.deepEqual(f.options[0], {mode:'exclusive',ifAvailable:true});
  assert.equal(f.held.size,1);
  await lease.release(); await lease.release();
  assert.throws(() => lease.assertActive(), {code:'client_ownership_lost'});
  const restarted = await claimBrowserClient(f.locks, {...scope}, () => {});
  restarted.assertActive(); await restarted.release(); assert.equal(f.held.size,0);
});
test('different clients and recreated authorities have separate ownership locks', async () => {
  const f=fixture();
  const a=await claimBrowserClient(f.locks,scope,()=>{});
  const b=await claimBrowserClient(f.locks,{...scope,clientId:'33333333-3333-4333-8333-333333333333'},()=>{});
  const c=await claimBrowserClient(f.locks,{...scope,vaultId:'44444444-4444-4444-8444-444444444444'},()=>{});
  assert.equal(f.held.size,3); await Promise.all([a.release(),b.release(),c.release()]);
});
test('unavailable Web Locks and invalid identity fail closed without fallback', async () => {
  await assert.rejects(claimBrowserClient(undefined,scope,()=>{}),{code:'client_locks_unavailable'});
  const f=fixture();
  await assert.rejects(claimBrowserClient(f.locks,{...scope,clientId:'tab-name'},()=>{}),{code:'invalid_client_identity'});
  assert.equal(f.held.size,0); assert.equal(f.options.length,0);
});
test('lost lock revokes the old lease and never silently reclaims or changes client identity', async () => {
  const f=fixture(); let observed!: (error:unknown)=>void;
  const lost=new Promise(resolve=>{observed=resolve;});
  const lease=await claimBrowserClient(f.locks,scope,error=>observed(error));
  f.lose(); assert.equal((await lost as {code:string}).code,'client_ownership_lost');
  assert.throws(()=>lease.assertActive(),{code:'client_ownership_lost'});
  await assert.rejects(lease.release(),{code:'client_ownership_lost'});
  assert.equal(f.options.length,1,'no autonomous re-admission');
  const next=await claimBrowserClient(f.locks,scope,()=>{}); await next.release();
});
