// Pure oracle descriptors only. Actual007 supplies the original receipt/digest
// timeline; generation/admission descriptors below are illustrative, not proof
// of a Native lease, application recovery or a completed GUI campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAutomaticLostCreateReplay} from './lost-create-auto.mjs';
const sha=letter=>letter.repeat(64),old='11111111-1111-4111-8111-111111111111',fresh='22222222-2222-4222-8222-222222222222';
function fixture(){
  const bodySha256='529e2839caab3c0e6720d1a3ca033e3a26e2445df027cc910471981409de75d9',commandSha256='3a78e0f96293d44f2003047a733f593c5f5b1ce414e5a7f201626ec4b43af6de',operationId='72c459fa-4f32-4260-ab9b-d1f05ae2e7cf';
  const dropped={kind:'dropped',generation:old,at:1793344886917,relayPid:78759,nativePid:78770,token:'a'.repeat(32),operationId,entryId:'becd432b-4c53-4daa-9be5-3e3347b35e05',revision:'e52dab30-eb7c-47b8-8d1d-aac98537b5a1',sequence:'17',bodySha256,requestId:'85',requestSha256:sha('a'),responseSha256:sha('b')};
  const admission=(generation,at,relayPid,nativePid,lease)=>({kind:'native-admission-response',method:'claim_client',generation,at,relayPid,nativePid,requestId:'1',ok:true,clientIdSha256:sha('c'),requestedClientIdSha256:sha('c'),localStoreIdSha256:sha('d'),leaseTokenSha256:sha(lease),requestSha256:sha('e'),responseSha256:sha('f')});
  const request=(generation,at,relayPid,nativePid,requestId)=>({kind:'native-write-request',method:'file_command',generation,at,relayPid,nativePid,requestId,operationId,commandSha256,bodySha256,clientIdSha256:sha('c')});
  const reply=(generation,at,relayPid,nativePid,requestId,requestHash,responseHash)=>({kind:'native-mutation-response',method:'file_command',generation,at,relayPid,nativePid,requestId,operationId,commandSha256,bodySha256,sequence:'17',ok:true,state:'committed',requestSha256:sha(requestHash),responseSha256:sha(responseHash)});
  const events=[admission(old,1793344886200,78759,78770,'1'),request(old,1793344886848,78759,78770,'85'),reply(old,1793344886915,78759,78770,'85','a','b'),dropped,{kind:'closed',generation:old,at:1793344886934,relayPid:78759,nativePid:78770,exitCode:0,signal:null},admission(fresh,1793344887050,78801,78802,'2'),request(fresh,1793344887081,78801,78802,'6'),reply(fresh,1793344887090,78801,78802,'6','3','4')];
  for(const row of [...events].filter(row=>row.kind==='native-write-request'))events.splice(events.indexOf(row),0,{...row,kind:'native-request',leaseClientIdSha256:sha('c'),leaseLocalStoreIdSha256:sha('d'),leaseTokenSha256:sha(row.generation===old?'1':'2')});
  const binding={appPid:78754,frameId:'original-frame',loaderId:'original-loader',url:'file:///owned/dist/index.html',paneBackendNodeId:42,tabId:'original-tab',basePath:'Create.base',viewLabel:'Create view',viewIndex:0,sourceEntryId:'original-base-entry',sourceRevision:'original-base-revision',sourceSha256:sha('5')};
  const generations=[{generation:old,appPid:78754,relayPid:78759,nativePid:78770,authenticatedAtLaunch:true,closeObservations:[{kind:'closed',exitCode:0,signal:null}]},{generation:fresh,appPid:78754,relayPid:78801,nativePid:78802,authenticatedAtLaunch:true,closeObservations:[]}];
  return{events,dropped,before:{...binding},after:{...binding},generations,current:{entryId:dropped.entryId,revision:dropped.revision},names:['.keep','Untitled.md'],bodySha256,actionStartedAt:1793344886840,actions:[{action:'button',label:'New',scope:'.pane.is-active .bases-session',at:1793344886841}],ui:{observed:true,disposed:false,mutationFrames:2,animationFrames:3,failures:[],overflow:false}};
}
test('one original New recovers the exact original receipt in the same mounted document',()=>{
  const input=fixture(),receipt=assertAutomaticLostCreateReplay(input);
  assert.equal(receipt.operationId,input.dropped.operationId);assert.equal(receipt.sequence,'17');assert.equal(receipt.transportReplays,1);
});
test('automatic lost create rejects changed operation, opaque bytes, receipt identity, source or user retry',()=>{
  const mutations=[
    f=>f.events.findLast(row=>row.kind==='native-mutation-response').operationId='new-operation',
    f=>f.events.findLast(row=>row.kind==='native-mutation-response').sequence='18',
    f=>f.events.findLast(row=>row.kind==='native-mutation-response').commandSha256=sha('7'),
    f=>f.events.findLast(row=>row.kind==='native-mutation-response').bodySha256=sha('7'),
    f=>f.events.findLast(row=>row.kind==='native-mutation-response').requestSha256='invalid',
    f=>f.events.splice(f.events.findIndex(row=>row.kind==='native-write-request'&&row.generation===fresh),1),
    f=>f.events.find(row=>row.kind==='native-write-request'&&row.generation===fresh).clientIdSha256=sha('7'),
    f=>f.events.find(row=>row.kind==='native-request'&&row.generation===fresh).leaseTokenSha256=sha('1'),
    f=>f.events.find(row=>row.kind==='native-request'&&row.generation===fresh).leaseClientIdSha256=sha('7'),
    f=>f.events.push({...f.events.find(row=>row.kind==='native-request'),method:'apply',requestId:'99'}),
    ...['file_command_compact','unknown_authoring_lane'].map(method=>f=>f.events.push({...f.events.find(row=>row.kind==='native-request'),method,requestId:'99',operationId:'unrequested',bodySha256:sha('7')})),
    ...[['database_request','set_entry'],['database_request','create_entry'],['database_request',undefined],['workblocks','title'],['documents','unknown'],['document_drafts','write_source']].map(([method,requestOp])=>f=>f.events.push({...f.events.find(row=>row.kind==='native-request'),method,requestOp,requestId:'99'})),
    f=>f.events.push({...f.events.findLast(row=>row.kind==='native-request'),operationId:'unrequested',requestId:'99'}),
    f=>f.current.entryId='replacement-entry',f=>f.current.revision='advanced-revision',f=>f.names.push('Untitled 1.md'),
    ...['appPid','frameId','loaderId','url','paneBackendNodeId','tabId','sourceEntryId','sourceRevision','sourceSha256','viewLabel','viewIndex'].map(key=>f=>f.after[key]=typeof f.after[key]==='number'?f.after[key]+1:'changed'),
    f=>f.actionStartedAt=1793344887100,f=>f.actions.push({...f.actions[0],at:f.actions[0].at+1}),...['key','text','select-value-model','custom-option','wheel','unknown-intervention'].map(action=>f=>f.actions.push({action})),
  ];
  for(const alter of mutations){const f=fixture();alter(f);assert.throws(()=>assertAutomaticLostCreateReplay(f));}
});
test('known native query and transient-analysis subcommands cannot be confused with source authoring',()=>{
  const f=fixture(),sample=f.events.find(row=>row.kind==='native-request');
  for(const[method,requestOp]of [['documents','base'],['database_request','list'],['database_request','get_entry'],['workblocks','read'],['document_drafts','upload_chunk'],['document_work','step']])f.events.push({...sample,method,requestOp,requestId:'passive-'+method,bodySha256:f.bodySha256});
  assert.equal(assertAutomaticLostCreateReplay(f).operationId,f.dropped.operationId,'A draft analysis upload of saved bytes is not a second source creation');
});
test('input dispatch precedes Native work even when recording its completed UI action comes later',()=>{
  const f=fixture();f.actions[0].at=1793344886850;assert.equal(assertAutomaticLostCreateReplay(f).sequence,'17');
});
test('fresh same-scope admission and every actual generation remain mandatory',()=>{
  const mutations=[
    f=>f.generations[1].authenticatedAtLaunch=false,f=>f.generations[1].nativePid=f.generations[0].nativePid,
    f=>f.generations[0].closeObservations=[],f=>f.generations[0].closeObservations[0].signal='SIGTERM',
    f=>f.events.splice(f.events.findIndex(row=>row.kind==='native-admission-response'&&row.generation===fresh),1),
    f=>f.events.find(row=>row.kind==='native-admission-response'&&row.generation===fresh).ok=false,
    f=>f.events.find(row=>row.kind==='native-admission-response'&&row.generation===fresh).leaseTokenSha256=sha('1'),
    f=>f.events.find(row=>row.kind==='native-admission-response'&&row.generation===fresh).clientIdSha256=sha('7'),
    f=>f.events.find(row=>row.kind==='native-admission-response'&&row.generation===fresh).localStoreIdSha256=sha('7'),
    f=>f.events.find(row=>row.kind==='native-admission-response'&&row.generation===fresh).at=1793344887100,
    f=>f.events.push({...f.events.find(row=>row.kind==='native-admission-response'&&row.generation===fresh)}),
    f=>f.events.findLast(row=>row.kind==='native-mutation-response').nativePid++,
    f=>f.ui.failures.push({category:'visible-alert'}),f=>f.ui.observed=false,f=>f.ui.disposed=true,f=>f.ui.animationFrames=0,f=>f.ui.mutationFrames=0,f=>f.ui.overflow=true,
  ];
  for(const alter of mutations){const f=fixture();alter(f);assert.throws(()=>assertAutomaticLostCreateReplay(f));}
});
test('replaying the same receipt again never permits another operation or raw token in public evidence',()=>{
  const f=fixture(),request={...f.events.findLast(row=>row.kind==='native-write-request'),requestId:'7',at:1793344887100},generic={...f.events.findLast(row=>row.kind==='native-request'),requestId:'7',at:request.at},reply={...f.events.findLast(row=>row.kind==='native-mutation-response'),requestId:'7',requestSha256:sha('8'),responseSha256:sha('9'),at:1793344887110,referenceToken:'must-not-be-copied'};
  f.events.push(generic,request,reply);const receipt=assertAutomaticLostCreateReplay(f);assert.equal(receipt.transportReplays,2);assert.equal(JSON.stringify(receipt).includes('must-not-be-copied'),false);
});
