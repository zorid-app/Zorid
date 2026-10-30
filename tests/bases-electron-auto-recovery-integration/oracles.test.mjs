// Illustrative metadata contracts only: no synthetic record establishes a real
// Native fault/admission. Actual runs must obtain these facts from the relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BaseDocument} from '../../src/bases/document.ts';
import {autoSources} from './campaign.mjs';
import {sha256,sanitized,assertOriginalPreparation,assertBusyCheckpoint,assertAutomaticCompletion,assertFreshAdmission,assertNoNewAuthoring,assertActualLeasedRequests,assertRealHeldChildLoss} from './oracles.mjs';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,entryId=id(1),revision=id(2),operationId=id(3),generation=id(4),fresh=id(5),source='S0',accepted='A',newer='B',client=sha256('client'),store=sha256('store'),capture=sha256('capture'),token=sha256('token'),key='note/v1/'+entryId;
function trace(){
  let at=0;const event=(kind,fields={})=>({kind,at:++at,generation,relayPid:10,nativePid:11,...fields});
  const claim=event('native-admission-response',{method:'claim_client',ok:true,requestedClientIdSha256:client,clientIdSha256:client,localStoreIdSha256:store,leaseTokenSha256:sha256('lease1'),requestSha256:sha256('claimrequest'),responseSha256:sha256('claimreply')});
  const captured=event('native-source-capture-response',{ok:true,captureIdSha256:capture,requestedCaptureIdSha256:capture,clientIdSha256:client,logicalWitnessSha256:sha256(JSON.stringify({entryId,revision,path:'AutoBusy.base'})),bodySha256:sha256(source),requestSha256:sha256('capturerequest'),responseSha256:sha256('capturereply')});
  const prepare=event('native-write-request',{method:'prepare_intent',entryId,expectedRevision:revision,operationId,bodySha256:sha256(accepted),sourceCaptureSha256:capture,clientIdSha256:client,mutationSha256:sha256('mutation'),commandSha256:sha256('prepare')});
  const prepared=event('native-prepared-write',{entryId,operationId,bodySha256:sha256(accepted),nativeIntentTokenSha256:token});
  const held=event('held',{token:'fault-token',path:'AutoBusy.base',entryId,operationId,phase:'prepared',nativeState:'prepared',bodySha256:sha256(accepted),nativeIntentTokenSha256:token});
  const request=event('native-write-request',{method:'checkpoint_cas',requestId:'6',key,expectedRevision:id(7),nextRevision:id(8),commandSha256:sha256('CAS'),bodySha256:sha256('opaque checkpoint')});
  const failure=event('native-checkpoint-response',{key,ok:false,errorCode:'storage_busy',commitUncertain:true,commandSha256:request.commandSha256,bodySha256:request.bodySha256,requestSha256:sha256('failedrequest'),responseSha256:sha256('busy')});
  const replay=event('native-write-request',{...request,at:8,requestId:'7'}),saved=event('native-checkpoint-response',{...failure,at:9,ok:true,errorCode:undefined,commitUncertain:undefined,requestSha256:sha256('retryrequest'),responseSha256:sha256('saved')});
  const commit=event('native-mutation-response',{at:10,method:'commit_intent',ok:true,state:'committed',referenceTokenSha256:token,operationId,sequence:'1',commandSha256:sha256('commitcommand'),bodySha256:sha256(''),requestSha256:sha256('commitrequest'),responseSha256:sha256('commitreply')});
  return{events:[claim,captured,prepare,prepared,held,request,failure,replay,saved,commit],claim,captured,prepare,prepared,held,request,failure,replay,saved,commit};
}
const preparation=t=>assertOriginalPreparation(t.events,{held:t.held,path:'AutoBusy.base',entryId,revision,source,accepted});
test('supported scene literals match the real whole-source transform and preserve sibling view',()=>{
  const scene={collectionId:'abcdefghijkl',scorePropertyId:'mnopqrstuvwx',collectionName:'Native recovery fixture'};
  for(const view of ['AutoBusy','AutoHost']){const s=autoSources(scene,view),doc=BaseDocument.parse(s.original),sibling=structuredClone(doc.views[1]);doc.editViewSummary(0,'Total','Total','values.length');assert.equal(doc.toString(),s.accepted);assert.deepEqual(doc.views[1],sibling);doc.editViewSummary(0,'Total','Total','values.sum() + 7');assert.equal(doc.toString(),s.newer);assert.deepEqual(doc.views[1],sibling);}
});
test('automatic busy completion requires original capture, operation, token and exact CAS replay',()=>{const t=trace();assert.equal(preparation(t),t.prepare);const checkpoint=assertBusyCheckpoint(t.events,{held:t.held,key});assert.equal(checkpoint.failure,t.failure);assert.equal(assertAutomaticCompletion(t.events,{held:t.held,entryId,accepted,newer,checkpoint}),t.commit);});
test('busy/prepare oracles reject terminal codes, changed hashes/guard/revision and ordering',()=>{
  for(const change of [t=>t.failure.errorCode='filesystem_failed',t=>t.failure.commitUncertain=false,t=>t.request.method='file_command',t=>t.request.nextRevision='',t=>t.replay.expectedRevision=id(90),t=>t.prepare.commandSha256=undefined,t=>t.prepare.sourceCaptureSha256=sha256('foreign'),t=>t.captured.logicalWitnessSha256=sha256('foreign'),t=>t.captured.requestedCaptureIdSha256=sha256('foreign'),t=>t.events.reverse(),t=>t.commit.operationId=id(90),t=>t.prepared.nativeIntentTokenSha256=sha256('foreign')]){const t=trace();change(t);assert.throws(()=>{preparation(t);const checkpoint=assertBusyCheckpoint(t.events,{held:t.held,key});assertAutomaticCompletion(t.events,{held:t.held,entryId,accepted,newer,checkpoint});});}
});
test('fresh admission must authorize the original client and fresh generation before original A completion',()=>{
  const t=trace(),after={...t.claim,at:9,generation:fresh,relayPid:20,nativePid:21,leaseTokenSha256:sha256('lease2')};t.commit.generation=fresh;t.commit.at=10;t.events.splice(-1,0,after);
  const proof=()=>assertFreshAdmission(t.events,generation,{prepare:t.prepare,held:t.held,commit:t.commit,killedAt:8});assert.equal(proof().after,after);
  for(const key of ['clientIdSha256','localStoreIdSha256','requestedClientIdSha256']){const old=after[key];after[key]=sha256('foreign');assert.throws(proof);after[key]=old;}
  after.leaseTokenSha256=t.claim.leaseTokenSha256;assert.throws(proof);after.leaseTokenSha256=sha256('lease2');t.commit.generation=generation;assert.throws(proof);
});
test('wire inventory rejects any B dispatch, direct source mutation, unknown method or opaque new database request',()=>{
  const t=trace(),wire={kind:'native-request',generation,at:6,method:'read_path',requestId:'1',commandSha256:sha256('read'),bodySha256:sha256('')};
  const check=events=>assertNoNewAuthoring(events,{held:t.held,prepare:t.prepare,newer,baseline:[]});check([wire]);
  for(const change of [e=>e.bodySha256=sha256(newer),e=>e.method='file_command',e=>e.method='create_text',e=>e.method='apply',e=>e.method='binary',e=>e.method='unknown_writer',e=>e.method='database_request',e=>{e.method='documents';e.requestOp='new_source_writer';},...['request','upload_begin','upload_chunk','upload_seal'].map(op=>e=>{e.method='document_drafts';e.requestOp=op;})]){const altered=structuredClone(wire);change(altered);assert.throws(()=>check([altered]));}
  const read={...wire,method:'database_request',requestOp:'get'};assertNoNewAuthoring([read],{held:t.held,prepare:t.prepare,newer,baseline:[read]});read.requestOp='compose';assert.throws(()=>assertNoNewAuthoring([read],{held:t.held,prepare:t.prepare,newer,baseline:[read]}));
  const direct={kind:'native-mutation-response',method:'file_command',ok:true,state:'committed',bodySha256:sha256(newer)};assert.throws(()=>assertAutomaticCompletion([...t.events,direct],{held:t.held,entryId,accepted,newer}));
});
test('exported evidence has a strict primitive schema and never leaks nested/raw authority or source bodies',()=>{
  const t=trace();t.held.nativeIntentToken='secret';t.held.clientId='secret';t.held.reference={token:'secret'};t.held.body='source';t.held.lease={token:'secret'};const output=JSON.stringify(sanitized(t.events));assert.equal(output.includes('secret'),false);assert.equal(output.includes('source"'),false);assert.equal(output.includes(token),true);
});

test('actual dispatched source request lease hashes must match its preceding positive claim',()=>{
  const t=trace(),wire={...t.prepare,kind:'native-request',leaseTokenSha256:t.claim.leaseTokenSha256,leaseClientIdSha256:client,leaseLocalStoreIdSha256:store};t.events.splice(t.events.indexOf(t.prepare),0,wire);const check=()=>assertActualLeasedRequests(t.events,{held:t.held,key,requests:[wire]});check();
  for(const field of ['leaseTokenSha256','leaseClientIdSha256','leaseLocalStoreIdSha256','clientIdSha256']){const old=wire[field];wire[field]=sha256('foreign');assert.throws(check);wire[field]=old;}
  wire.leaseTokenSha256=undefined;assert.throws(check);
});

test('genuine held Native loss requires discarded original ACK and exact intentional SIGKILL/EOF proof',()=>{
  const held={generation,nativePid:11,relayPid:10,responseSha256:sha256('withheld')},fault={at:20,nativePid:11,relayPid:10},discard={kind:'held-child-closed',generation,nativePid:11,relayPid:10,at:21,exitCode:null,signal:'SIGKILL',withheldResponseSha256:held.responseSha256},closed={kind:'closed',generation,nativePid:11,relayPid:10,at:22,exitCode:null,signal:'SIGKILL',nativeTerminatedDuringHold:true,failed:false},admission={after:{at:23}};
  const check=()=>assertRealHeldChildLoss([discard,closed],{held,fault,admission});assert.equal(check().discard,discard);
  discard.withheldResponseSha256=sha256('other');assert.throws(check);discard.withheldResponseSha256=held.responseSha256;closed.nativeTerminatedDuringHold=false;assert.throws(check);closed.nativeTerminatedDuringHold=true;discard.exitCode=0;assert.throws(check);
});

test('final busy proof correlates the earlier observed failure across fresh event reads',()=>{
  const t=trace(),checkpoint=structuredClone(assertBusyCheckpoint(t.events,{held:t.held,key}));assert.equal(assertAutomaticCompletion(t.events,{held:t.held,entryId,accepted,newer,checkpoint}),t.commit);
  checkpoint.failure.responseSha256=sha256('missing earlier failure');assert.throws(()=>assertAutomaticCompletion(t.events,{held:t.held,entryId,accepted,newer,checkpoint}));
});

test('host fresh admission ignores prior sealed busy-phase generations without weakening this replay',()=>{
  const t=trace(),after={...t.claim,at:9,generation:fresh,leaseTokenSha256:sha256('lease2')};t.commit.generation=fresh;t.events.splice(-1,0,after);t.events.unshift({kind:'native-write-request',generation:id(90),at:0,method:'prepare_intent',operationId:id(91)});assert.ok(assertFreshAdmission(t.events,generation,{prepare:t.prepare,held:t.held,commit:t.commit,killedAt:8}));
});
test('unmatched foreign commit or query dispatch cannot pass the sealed closed wire inventory',()=>{
  const t=trace();for(const method of ['commit_intent','query_intent']){const request={kind:'native-request',generation,at:6,requestId:'foreign',method,commandSha256:sha256('foreign reference'),bodySha256:sha256('')};assert.throws(()=>assertNoNewAuthoring([request],{held:t.held,prepare:t.prepare,newer,baseline:[]}));}
  const request={kind:'native-request',generation,at:9,requestId:'exact',method:'commit_intent',commandSha256:t.commit.commandSha256,bodySha256:t.commit.bodySha256};t.commit.requestId=request.requestId;assertNoNewAuthoring([request,t.commit],{held:t.held,prepare:t.prepare,newer,baseline:[]});
});
