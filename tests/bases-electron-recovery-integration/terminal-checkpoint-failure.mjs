import assert from 'node:assert/strict';
const digest=value=>assert.match(value,/^[a-f0-9]{64}$/,'Exact relay frame/command/body digest required');
/** One terminal denial from the exact checkpoint CAS dispatched after the
 * original inert preparation. This is not a general error-code acceptance set. */
export function terminalLockCheckpointFailure(events,key,held){
  const failures=events.filter(event=>event.kind==='native-checkpoint-response'&&event.key===key&&event.ok===false);
  if(!failures.length)return false;
  assert.equal(failures.length,1,'One original failed checkpoint acknowledgement required');
  const row=failures[0];
  // Native lock-open PermissionDenied maps to filesystem_failed. Uncertainty
  // preserves this exact CAS; it does not authorize automatic retry.
  assert.equal(row.errorCode,'filesystem_failed');assert.equal(row.commitUncertain,true);
  assert.equal(held.kind,'held');assert.equal(held.phase,'prepared');assert.equal(held.nativeState,'prepared');assert.ok(held.nativeIntentToken&&held.operationId);assert.equal(key,'note/v1/'+held.entryId);
  const responseIndex=events.indexOf(row),heldIndex=events.findIndex(event=>event.kind==='held'&&event.token===held.token);
  assert.ok(heldIndex>=0&&heldIndex<responseIndex,'The original held preparation precedes its checkpoint error');
  assert.deepEqual(events[heldIndex],held,'The exact original held preparation must remain in the same event stream');
  for(const name of ['commandSha256','bodySha256','requestSha256','responseSha256'])digest(row[name]);
  const requests=events.slice(heldIndex+1,responseIndex).filter(event=>event.kind==='native-write-request'&&event.method==='checkpoint_cas'&&event.key===key&&event.commandSha256===row.commandSha256&&event.bodySha256===row.bodySha256);
  assert.equal(requests.length,1,'Failure must correlate to one exact original checkpoint_cas command and body');
  const request=requests[0];assert.match(request.requestId,/^[1-9][0-9]*$/);assert.equal(typeof request.nextRevision,'string');assert.ok(request.nextRevision);assert.ok(request.expectedRevision===null||typeof request.expectedRevision==='string'&&request.expectedRevision.length>0);
  for(const name of ['relayPid','nativePid']){assert.ok(Number.isSafeInteger(held[name])&&held[name]>0);assert.equal(request[name],held[name]);assert.equal(row[name],held[name]);}
  assert.ok(Number.isSafeInteger(held.at)&&Number.isSafeInteger(request.at)&&Number.isSafeInteger(row.at)&&held.at<=request.at&&request.at<=row.at,'Checkpoint failure must follow its genuine held preparation and exact request');
  return row;
}
