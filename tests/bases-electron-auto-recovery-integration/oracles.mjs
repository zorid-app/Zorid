import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>assert.match(value,/^[a-f0-9]{64}$/,'Required bounded digest');
const uuid=value=>assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const common=['kind','at','generation','relayPid','nativePid'];
const fields={
  'native-request':['requestId','method','requestOp','operationId','entryId','key','clientIdSha256','leaseTokenSha256','leaseClientIdSha256','leaseLocalStoreIdSha256','commandSha256','bodySha256'],
  'native-write-request':['requestId','method','operationId','entryId','expectedRevision','nextRevision','key','commandSha256','bodySha256','sourceCaptureSha256','clientIdSha256','mutationSha256'],
  'native-source-capture-response':['requestId','ok','requestedCaptureIdSha256','captureIdSha256','clientIdSha256','logicalWitnessSha256','bodySha256','requestSha256','responseSha256'],
  'native-admission-response':['requestId','method','ok','requestedClientIdSha256','clientIdSha256','localStoreIdSha256','leaseTokenSha256','requestSha256','responseSha256'],
  'native-prepared-write':['entryId','operationId','bodySha256','nativeIntentTokenSha256'],
  'held':['path','operationId','entryId','bodySha256','phase','nativeState','nativeIntentTokenSha256','requestId','requestSha256','responseSha256'],
  'native-checkpoint-response':['key','commandSha256','bodySha256','requestSha256','responseSha256','ok','errorCode','commitUncertain'],
  'native-mutation-response':['method','requestId','commandSha256','bodySha256','preparedBodySha256','referenceTokenSha256','operationId','sequence','ok','errorCode','commitUncertain','state','requestSha256','responseSha256'],
  'native-intent-query-response':['method','requestId','commandSha256','bodySha256','preparedBodySha256','referenceTokenSha256','nativeIntentTokenSha256','entryId','operationId','sequence','ok','errorCode','commitUncertain','state','requestSha256','responseSha256'],
  'closed':['exitCode','signal','failed','dropped','nativeTerminatedDuringHold'],'held-child-closed':['exitCode','signal','withheldResponseSha256'],
};
export function sanitized(events){return events.map(event=>Object.fromEntries([...common,...(fields[event.kind]??[])].filter(key=>Object.hasOwn(event,key)).map(key=>{const value=event[key];assert.ok(value===null||['string','number','boolean','undefined'].includes(typeof value),'Evidence schemas never export nested authority/body values');return[key,value];})));}
export function assertOriginalPreparation(events,{held,path,entryId,revision,source,accepted}){
  assert.equal(held.kind,'held');assert.equal(held.phase,'prepared');assert.equal(held.nativeState,'prepared');assert.equal(held.path,path);assert.equal(held.entryId,entryId);assert.equal(held.bodySha256,sha256(accepted));uuid(held.generation);uuid(held.operationId);hash(held.nativeIntentTokenSha256);
  const prepared=events.filter(event=>event.kind==='native-prepared-write'&&event.operationId===held.operationId);assert.ok(prepared.length>=1);
  for(const event of prepared){assert.equal(event.entryId,entryId);assert.equal(event.bodySha256,sha256(accepted));assert.equal(event.nativeIntentTokenSha256,held.nativeIntentTokenSha256);}
  const requests=events.filter(event=>event.kind==='native-write-request'&&event.method==='prepare_intent'&&event.operationId===held.operationId);assert.ok(requests.length>=1);const request=requests[0];
  assert.equal(request.entryId,entryId);assert.equal(request.expectedRevision,revision);assert.equal(request.bodySha256,sha256(accepted));for(const name of ['sourceCaptureSha256','clientIdSha256','mutationSha256','commandSha256','bodySha256'])hash(request[name]);assert.equal(request.generation,held.generation);for(const name of ['nativePid','relayPid'])assert.equal(request[name],held[name]);
  const heldIndex=events.findIndex(event=>event.kind==='held'&&event.generation===held.generation&&event.operationId===held.operationId);assert.ok(events.indexOf(request)<heldIndex);const initialPrepared=prepared.find(event=>event.generation===held.generation);assert.ok(initialPrepared&&events.indexOf(request)<events.indexOf(initialPrepared)&&events.indexOf(initialPrepared)<heldIndex);
  for(const event of requests){assert.equal(event.operationId,held.operationId);for(const key of ['entryId','expectedRevision','bodySha256','sourceCaptureSha256','clientIdSha256','mutationSha256','commandSha256'])assert.equal(event[key],request[key],'Exact original prepare command/source capture is retained');}
  const captures=events.filter(event=>event.kind==='native-source-capture-response'&&event.ok&&event.captureIdSha256===request.sourceCaptureSha256);assert.ok(captures.length>=1);
  const initialCapture=captures.find(event=>event.generation===held.generation&&events.indexOf(event)<events.indexOf(request));assert.ok(initialCapture,'Original source capture must precede its first prepare in the original generation');for(const name of ['nativePid','relayPid'])assert.equal(initialCapture[name],held[name]);
  const witness=sha256(JSON.stringify({entryId,revision,path}));for(const event of captures){assert.equal(event.requestedCaptureIdSha256,event.captureIdSha256);assert.equal(event.clientIdSha256,request.clientIdSha256);assert.equal(event.logicalWitnessSha256,witness);assert.equal(event.bodySha256,sha256(source));hash(event.requestSha256);hash(event.responseSha256);}
  return request;
}
export function assertBusyCheckpoint(events,{held,key}){
  const failures=events.filter(event=>event.kind==='native-checkpoint-response'&&event.key===key&&!event.ok);
  if(!failures.length)return false;
  const failure=failures[0];for(const candidate of failures){for(const name of ['relayPid','nativePid'])assert.equal(candidate[name],held[name]);for(const name of ['commandSha256','bodySha256','requestSha256','responseSha256'])hash(candidate[name]);assert.equal(candidate.errorCode,'storage_busy');assert.equal(candidate.commitUncertain,true);assert.equal(candidate.generation,held.generation);assert.equal(candidate.commandSha256,failure.commandSha256);assert.equal(candidate.bodySha256,failure.bodySha256);}assert.equal(failure.errorCode,'storage_busy');assert.equal(failure.commitUncertain,true);assert.equal(failure.generation,held.generation);
  const requests=events.slice(0,events.indexOf(failure)).filter(event=>event.kind==='native-write-request'&&event.method==='checkpoint_cas'&&event.key===key&&event.commandSha256===failure.commandSha256&&event.bodySha256===failure.bodySha256);assert.equal(requests.length,1);
  const request=requests[0];assert.ok(events.indexOf(request)>events.findIndex(event=>event.kind==='held'&&event.operationId===held.operationId));assert.equal(request.generation,held.generation);for(const name of ['relayPid','nativePid']){assert.equal(request[name],held[name]);assert.equal(failure[name],held[name]);}for(const value of [failure.commandSha256,failure.bodySha256,failure.requestSha256,failure.responseSha256])hash(value);if(request.expectedRevision!==null)uuid(request.expectedRevision);uuid(request.nextRevision);assert.ok(request.at>=held.at&&failure.at>=request.at);
  return{failure,request};
}
export function assertAutomaticCompletion(events,{held,entryId,accepted,newer,checkpoint}){
  const writes=events.filter(event=>event.kind==='native-prepared-write'&&event.entryId===entryId);
  assert.ok(writes.length>=1);for(const event of writes){assert.equal(event.bodySha256,sha256(accepted),'Newer raw B must never be prepared');assert.equal(event.operationId,held.operationId);assert.equal(event.nativeIntentTokenSha256,held.nativeIntentTokenSha256);}
  assert.equal(events.filter(event=>['native-write-request','native-request'].includes(event.kind)&&event.bodySha256===sha256(newer)).length,0,'No source-authoring route may dispatch raw B');
  for(const event of events.filter(event=>['native-mutation-response','native-intent-query-response'].includes(event.kind))){assert.ok(['commit_intent','query_intent'].includes(event.method),'No direct/file-command source authoring during automatic recovery');assert.equal(event.referenceTokenSha256,held.nativeIntentTokenSha256);for(const name of ['commandSha256','bodySha256','requestSha256','responseSha256'])hash(event[name]);if(event.nativeIntentTokenSha256!==undefined)assert.equal(event.nativeIntentTokenSha256,held.nativeIntentTokenSha256);if(event.entryId!==undefined)assert.equal(event.entryId,entryId);if(event.ok&&event.state==='committed')assert.equal(event.operationId,held.operationId);}
  const commits=events.filter(event=>event.kind==='native-mutation-response'&&event.method==='commit_intent'&&event.ok&&event.state==='committed'&&event.referenceTokenSha256===held.nativeIntentTokenSha256);
  assert.equal(commits.length,1,'Original A has one genuine successful commit ACK');const commit=commits[0];assert.equal(commit.operationId,held.operationId);assert.match(commit.sequence,/^[1-9][0-9]*$/);hash(commit.requestSha256);hash(commit.responseSha256);
  assert.equal(events.filter(event=>event.kind==='native-mutation-response'&&event.ok&&event.preparedBodySha256===sha256(newer)).length,0);
  if(checkpoint){const replayRequests=events.filter(event=>event.kind==='native-write-request'&&event.method==='checkpoint_cas'&&event.key===checkpoint.request.key&&event.commandSha256===checkpoint.request.commandSha256&&event.bodySha256===checkpoint.request.bodySha256);assert.ok(replayRequests.length>=2);for(const event of replayRequests){assert.equal(event.expectedRevision,checkpoint.request.expectedRevision);assert.equal(event.nextRevision,checkpoint.request.nextRevision);}
    const replays=events.filter(event=>event.kind==='native-checkpoint-response'&&event.ok&&event.key===checkpoint.failure.key&&event.commandSha256===checkpoint.failure.commandSha256&&event.bodySha256===checkpoint.failure.bodySha256);assert.equal(replays.length,1,'The completed original reference checkpoint is not written again');const replay=replays[0];const failureIndex=events.findIndex(event=>event.kind==='native-checkpoint-response'&&event.responseSha256===checkpoint.failure.responseSha256&&event.requestSha256===checkpoint.failure.requestSha256);assert.ok(failureIndex>=0,'The observed original failure must remain in the final sealed wire trace');assert.ok(events.indexOf(replay)>failureIndex&&events.indexOf(replay)<events.indexOf(commit));}
  return commit;
}
export function assertFreshAdmission(events,originalGeneration,{prepare,held,commit,killedAt}){
  const before=events.filter(event=>event.kind==='native-admission-response'&&event.method==='claim_client'&&event.ok&&event.generation===originalGeneration).at(-1);assert.ok(before,'Positive original admission required');assert.equal(prepare.generation,originalGeneration);assert.equal(prepare.clientIdSha256,before.clientIdSha256);assert.equal(before.requestedClientIdSha256,before.clientIdSha256);assert.ok(events.indexOf(before)<events.indexOf(prepare)&&before.at<=held.at);
  const after=events.filter(event=>event.kind==='native-admission-response'&&event.method==='claim_client'&&event.ok&&event.generation===commit.generation).at(-1);assert.ok(after,'Completion must belong to the fresh positive admission');uuid(after.generation);assert.notEqual(after.generation,originalGeneration);
  for(const value of [before.clientIdSha256,before.localStoreIdSha256,before.leaseTokenSha256,before.requestSha256,before.responseSha256,after.clientIdSha256,after.localStoreIdSha256,after.leaseTokenSha256,after.requestSha256,after.responseSha256])hash(value);
  assert.equal(after.requestedClientIdSha256,after.clientIdSha256);assert.equal(after.clientIdSha256,before.clientIdSha256);assert.equal(after.localStoreIdSha256,before.localStoreIdSha256);assert.notEqual(after.leaseTokenSha256,before.leaseTokenSha256);assert.ok(after.at>=killedAt&&events.indexOf(after)<events.indexOf(commit));
  const heldIndex=events.findIndex(event=>event.kind==='held'&&event.generation===originalGeneration&&event.operationId===held.operationId);assert.ok(heldIndex>=0);
  for(const event of events.slice(heldIndex+1).filter(event=>['native-source-capture-response','native-write-request','native-prepared-write'].includes(event.kind)&&event.generation!==originalGeneration)){assert.equal(event.generation,after.generation);assert.ok(events.indexOf(event)>events.indexOf(after),'Fresh scope must be positively admitted before exact replay');}
  return{before,after};
}
/** Closed-world wire inventory: known read/derived-maintenance operations may
 * continue, while the only source mutation remains the exact accepted intent. */
export function assertNoNewAuthoring(events,{held,prepare,newer,baseline}){
  const simple=new Set(['identity','claim_client','release_client','checkpoint_load','checkpoint_list','checkpoint_changes','list','read','read_path','read_presented','list_snapshot','stat_path','changes_after','capture_saved_source','release_saved_source','list_saved_source_requests','query_intent','list_intents','acknowledge_intent','reconciliation_status','status','local_family_status']);
  const documents=new Set(['status','initialize','rebuild','begin','stages','resume','pump','publish','discard','open','close','metadata','metadata_rows','search','backlinks','base','property_targets','tasks','rich_start','rich_prepare','rich_page','rich_close','preview_open','preview_base','preview_close','runtime_observe','runtime_control','runtime_ack','runtime_outcome_ack','runtime_snapshot','runtime_step','runtime_owner','runtime_owner_ack']);
  // These only inspect/derive/release an existing draft job. New semantic
  // source admission and every upload route are forbidden during this proof.
  const drafts=new Set(['progress','facts_prepare','facts_read','cancel','acknowledge','release_buffer','snapshot']);
  const work=new Set(['snapshot','next_turn','step','close']);
  const requests=events.filter(event=>event.kind==='native-request');assert.ok(requests.length,'Complete passive wire request inventory required');
  for(const event of requests){hash(event.commandSha256);hash(event.bodySha256);assert.notEqual(event.bodySha256,sha256(newer),'Unsubmitted B cannot be sent on any Native request');
    if(['commit_intent','query_intent'].includes(event.method)){const kind=event.method==='commit_intent'?'native-mutation-response':'native-intent-query-response',responses=events.filter(response=>response.kind===kind&&response.generation===event.generation&&response.requestId===event.requestId&&response.commandSha256===event.commandSha256&&response.bodySha256===event.bodySha256);assert.equal(responses.length,1,'Every intent dispatch must close with one observed exact response before sealing');const response=responses[0];assert.equal(response.referenceTokenSha256,held.nativeIntentTokenSha256);assert.equal(response.operationId,held.operationId);continue;}
    if(simple.has(event.method)||event.method==='checkpoint_cas')continue;
    if(event.method==='prepare_intent'){assert.equal(event.operationId,held.operationId);assert.equal(event.entryId,held.entryId);assert.equal(event.commandSha256,prepare.commandSha256);assert.equal(event.bodySha256,prepare.bodySha256);continue;}
    if(event.method==='documents'){assert.ok(documents.has(event.requestOp),'Unknown document authoring/maintenance operation');continue;}
    if(event.method==='document_drafts'){assert.ok(drafts.has(event.requestOp));continue;}
    if(event.method==='document_work'){assert.ok(work.has(event.requestOp));continue;}
    if(event.method==='workblocks'){assert.ok(['read','window','changes'].includes(event.requestOp));continue;}
    if(event.method==='database_request'){assert.ok(['list','get','get_entry'].includes(event.requestOp),'Only explicit Native collection reads are admitted');assert.ok(baseline.some(prior=>prior.kind==='native-request'&&prior.method==='database_request'&&prior.commandSha256===event.commandSha256&&prior.bodySha256===event.bodySha256),'Only the exact pre-input collection read command is allowed');continue;}
    assert.fail('Unexpected source-authoring or unknown Native method: '+event.method);
  }
}

/** Source-authoring/capture requests must carry the actual lease returned by a
 * preceding positive claim in that very generation. No liveness inference. */
export function assertActualLeasedRequests(events,{held,key,requests:inventory}){
  const source=new Set(['prepare_intent','commit_intent','query_intent','acknowledge_intent','capture_saved_source']);
  assert.ok(Array.isArray(inventory));const selected=new Set([...inventory,...events.filter(event=>event.kind==='native-request'&&event.method==='capture_saved_source'&&event.entryId===held.entryId)]);
  const requests=[...selected].filter(event=>event.kind==='native-request'&&(source.has(event.method)||event.method==='checkpoint_cas'&&event.key===key));assert.ok(requests.length);
  for(const request of requests){const claims=events.slice(0,events.indexOf(request)).filter(event=>event.kind==='native-admission-response'&&event.method==='claim_client'&&event.ok&&event.generation===request.generation);const claim=claims.at(-1);assert.ok(claim,'Source/capture dispatch requires prior positive admission');assert.equal(claim.requestedClientIdSha256,claim.clientIdSha256);
    for(const name of ['leaseTokenSha256','leaseClientIdSha256','leaseLocalStoreIdSha256'])hash(request[name]);assert.equal(request.leaseTokenSha256,claim.leaseTokenSha256);assert.equal(request.leaseClientIdSha256,claim.clientIdSha256);assert.equal(request.leaseLocalStoreIdSha256,claim.localStoreIdSha256);if(source.has(request.method))assert.equal(request.clientIdSha256,claim.clientIdSha256);
    assert.ok(request.at>=claim.at);if(request.method==='prepare_intent'){assert.equal(request.operationId,held.operationId);assert.equal(request.entryId,held.entryId);}
  }
}

export function assertRealHeldChildLoss(events,{held,fault,admission}){
  const closes=events.filter(event=>event.generation===held.generation),discard=closes.find(event=>event.kind==='held-child-closed'),closed=closes.find(event=>event.kind==='closed');assert.ok(discard&&closed,'Actual held Native EOF and relay terminal close required');
  for(const event of [discard,closed]){assert.equal(event.exitCode,null);assert.equal(event.signal,'SIGKILL');assert.equal(event.nativePid,fault.nativePid);assert.equal(event.relayPid,fault.relayPid);assert.ok(event.at>=fault.at);}
  assert.equal(discard.withheldResponseSha256,held.responseSha256,'The original inert reply was withheld and discarded, never delivered');hash(discard.withheldResponseSha256);assert.equal(closed.nativeTerminatedDuringHold,true);assert.equal(closed.failed,false);assert.ok(closed.at>=discard.at&&admission.after.at>=discard.at);return{discard,closed};
}
