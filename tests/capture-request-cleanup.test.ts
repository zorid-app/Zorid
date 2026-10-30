import test from 'node:test';
import assert from 'node:assert/strict';
import {claimCaptureRequest,reserveCaptureRequestCleanup,retryCaptureRequestCleanups} from '../src/ui/capture-request-cleanup.ts';
const scope=()=>({vaultId:crypto.randomUUID(),clientId:'client'});

test('live claims block cleanup only for the exact vault/client/request and remain until explicitly released',()=>{
  const a=scope(),owner={},claim=claimCaptureRequest(a,'request',owner);
  assert.equal(reserveCaptureRequestCleanup(a,'request'),undefined);
  const other=reserveCaptureRequestCleanup({...a,clientId:'other'},'request');assert.ok(other);other.finish();
  claim.release();const reserved=reserveCaptureRequestCleanup(a,'request');assert.ok(reserved);reserved.finish();
});
test('a claim arriving during evidence lookup invalidates reservation and waits without adopting the ID',async()=>{
  const a=scope(),reservation=reserveCaptureRequestCleanup(a,'old')!;let waiting:Promise<void>|undefined;
  assert.throws(()=>claimCaptureRequest(a,'old',{}),(error:any)=>{waiting=error.wait;return error.code==='capture_cleanup_pending';});
  assert.equal(reservation.seal(),false);assert.ok(waiting);reservation.finish();await waiting;
  const claim=claimCaptureRequest(a,'old',{});assert.equal(reserveCaptureRequestCleanup(a,'old'),undefined);claim.release();
});
test('a sealed Native release blocks adoption through lost ACK and terminal settlement',async()=>{
  const a=scope(),reservation=reserveCaptureRequestCleanup(a,'old')!;assert.equal(reservation.seal(),true);
  assert.throws(()=>claimCaptureRequest(a,'old',{}),{code:'capture_cleanup_pending'});assert.equal(reservation.owns(),true);
  reservation.settled();reservation.finish();assert.throws(()=>claimCaptureRequest(a,'old',{}),{code:'capture_request_released'});
  assert.equal(reserveCaptureRequestCleanup(a,'old'),undefined);
});
test('a sealed failure retains the exact release continuation and blocks adoption until its ACK, including without a pending Native row',async()=>{
  const a=scope();let calls=0;const reservation=reserveCaptureRequestCleanup(a,'old',async()=>{if(++calls===1)throw Error('Malformed ACK after Native release');})!;
  assert.equal(reservation.seal(),true);await assert.rejects(reservation.release(),/Malformed/);reservation.finish();
  assert.throws(()=>claimCaptureRequest(a,'old',{}),{code:'capture_cleanup_unsettled'});assert.equal(reserveCaptureRequestCleanup(a,'old'),undefined);
  await retryCaptureRequestCleanups(a);assert.equal(calls,2);assert.throws(()=>claimCaptureRequest(a,'old',{}),{code:'capture_request_released'});
});
test('eight unresolved sealed continuations are bounded without evicting a fence',async()=>{
  const a=scope();for(let i=0;i<8;i++){const reservation=reserveCaptureRequestCleanup(a,String(i),async()=>{throw Error('Unknown ACK');})!;assert.ok(reservation);assert.equal(reservation.seal(),true);await assert.rejects(reservation.release());}
  assert.equal(reserveCaptureRequestCleanup(a,'ninth'),undefined);assert.throws(()=>claimCaptureRequest(a,'0',{}),{code:'capture_cleanup_unsettled'});
});
