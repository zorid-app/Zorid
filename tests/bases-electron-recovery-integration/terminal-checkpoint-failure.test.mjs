// Actual004 normalized metadata only. This pure contract executes no Native/app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {NoteLoadSupervisor} from '../../src/ui/note-load-supervisor.ts';
import {terminalLockCheckpointFailure} from './terminal-checkpoint-failure.mjs';
const key='note/v1/df25eebc-ab7d-4450-bfc9-215f55a74c5b';
const response={at:1793342824230,relayPid:30552,nativePid:30563,kind:'native-checkpoint-response',key,commandSha256:'cf041dfbfaa1dde8e4b582595cc5d6e4298d37ee5d3637df9144cfa2034e650f',bodySha256:'7949f903046b54fec1fa819f3909ae22b516cd1545176de0cf177509f6a7d5ef',requestSha256:'70b6fcd99485b0f0e8061adc42b9bb582775aa3325d8b82bf5b9571f19b81350',responseSha256:'4f16ce4d2dab851c403d36172b2b8abcc8dbe70302a96676ee93c3cae2533398',ok:false,errorCode:'filesystem_failed',commitUncertain:true};
const request={at:1793342824229,relayPid:30552,nativePid:30563,kind:'native-write-request',method:'checkpoint_cas',requestId:'99',key,expectedRevision:'99481ba9-8090-495e-b110-dc9e2d9e1d14',nextRevision:'a3430dcc-00e0-4cd1-b779-9bf98ff5f810',commandSha256:response.commandSha256,bodySha256:response.bodySha256};
const held={at:1793342823839,relayPid:30552,nativePid:30563,kind:'held',token:'d3dcb9a7fe661b4874c6fcbf206235b9',entryId:key.slice(8),operationId:'5c7887ee-3d2d-41bc-89a3-006cb01fd6b9',phase:'prepared',nativeState:'prepared',nativeIntentToken:'4cc01739-1f7b-4667-b4c4-d1d9e59df354'};
const original=()=>[structuredClone(held),structuredClone(request),structuredClone(response)];
test('actual004 permission-denied checkpoint is the exact terminal filesystem failure',()=>{assert.equal(terminalLockCheckpointFailure([held,request,response],key,held),response);});

test('terminal lock denial requires exact method/key/command/body, original host and preparation order',()=>{
  for(const alter of [
    rows=>rows[2].errorCode='checkpoint_storage',rows=>rows[2].errorCode='filesystem_io_retryable',rows=>rows[2].commitUncertain=false,
    rows=>rows[1].method='commit_intent',rows=>rows[1].key='note/v1/foreign',rows=>rows[1].commandSha256='a'.repeat(64),rows=>rows[1].bodySha256='b'.repeat(64),
    rows=>rows[2].nativePid++,rows=>rows[1].relayPid++,rows=>rows[1].at=held.at-1,rows=>rows[2].requestSha256='invalid',
    rows=>rows[0].phase='committed',rows=>rows.splice(1,1),rows=>rows.splice(1,0,structuredClone(rows[1])),rows=>rows.push(structuredClone(rows[2])),
    rows=>rows.reverse(),
  ]){const rows=original();alter(rows);assert.throws(()=>terminalLockCheckpointFailure(rows,key,held));}
  assert.equal(terminalLockCheckpointFailure([held,request],key,held),false,'No reply yet is not a fault acceptance');
});
test('actual frontend policy rejects uncertain filesystem denial without automatic retry or admission wake',async()=>{
  for(const failure of [Object.assign(new Error('Permission denied'),{source:'host',code:response.errorCode,commitUncertain:response.commitUncertain}),Object.assign(new Error('Protected original mutation'),{source:'host',code:'outcome_unknown',cause:Object.assign(new Error('Permission denied'),{source:'host',code:response.errorCode,commitUncertain:true})})]){
    const supervisor=new NoteLoadSupervisor();let calls=0;
    try{await assert.rejects(supervisor.run(async()=>{calls++;throw failure;}),error=>error===failure);assert.equal(calls,1);assert.equal(supervisor.pending,false);supervisor.wake();supervisor.admissionAvailable();await Promise.resolve();assert.equal(calls,1,'Uncertainty retains the original terminal request without authorizing automatic replay');}finally{supervisor.stop();}
  }
});
test('typed transient filesystem IO keeps one exact closure and resumes without any Save command',async()=>{
  const supervisor=new NoteLoadSupervisor(),requestIdentity={},calls=[];let seen,notify;const notified=new Promise(resolve=>{notify=resolve;});
  try{const result=supervisor.run(async()=>{calls.push(requestIdentity);if(calls.length===1)throw Object.assign(new Error('Interrupted'),{source:'host',code:'filesystem_io_retryable',commitUncertain:true});return requestIdentity;},()=>{},{onError:failure=>{seen=failure;notify();}});await notified;assert.equal(supervisor.pending,true);assert.equal(seen.code,'filesystem_io_retryable');supervisor.wake();assert.equal(await result,requestIdentity);assert.deepEqual(calls,[requestIdentity,requestIdentity]);}finally{supervisor.stop();}
});
