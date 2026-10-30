import assert from 'node:assert/strict';

const hash=value=>assert.match(value,/^[a-f0-9]{64}$/,'An exact wire/body digest is required');
const uuid=value=>assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,'A canonical observed generation is required');
const fields=(row,names)=>Object.fromEntries(names.filter(name=>row[name]!==undefined).map(name=>[name,row[name]]));
// Closed against Native Command and the semantic endpoint request enums. These
// lanes read/maintain admitted state; file_command is the only accepted source
// operation in this scenario and is correlated separately below.
const ordinaryMethods=new Set(['identity','claim_client','release_client','checkpoint_load','checkpoint_cas','checkpoint_list','checkpoint_changes','list','list_snapshot','stat_path','read_path','read_presented','read','changes_after','capture_saved_source','release_saved_source','list_saved_source_requests','query_intent','list_intents','acknowledge_intent','reconcile','recover','rescan','local_family_status','status','file_command_status','recovery_list','recovery_read','local_recovery_maintenance']);
const subcommands={
  documents:new Set(['runtime_observe','runtime_snapshot','runtime_control','runtime_ack','runtime_outcome_ack','runtime_owner','runtime_owner_ack','runtime_step','status','initialize','rebuild','begin','stages','resume','pump','publish','discard','open','close','preview_open','preview_base','preview_close','metadata','metadata_rows','search','rich_start','rich_prepare','rich_page','rich_close','backlinks','tasks','base','property_targets']),
  document_drafts:new Set(['request','upload_begin','upload_chunk','upload_seal','progress','facts_prepare','facts_read','cancel','acknowledge','release_buffer','snapshot']),
  document_work:new Set(['next_turn','snapshot','step','close']),
  database_request:new Set(['list','get','get_entry']),workblocks:new Set(['read','window','changes']),
};
export function assertAutomaticLostCreateReplay({events,dropped,before,after,generations,current,names,bodySha256,actions,actionStartedAt,ui}){
  assert.equal(dropped.kind,'dropped');uuid(dropped.generation);hash(bodySha256);assert.equal(dropped.bodySha256,bodySha256);
  assert.equal(dropped.operationId.length>0,true);assert.equal(dropped.entryId.length>0,true);assert.equal(dropped.revision.length>0,true);assert.match(dropped.sequence,/^[1-9][0-9]*$/);
  assert.equal(events.filter(row=>row.kind==='dropped'&&row.token===dropped.token).length,1,'One consumed genuine dropped success');
  assert.deepEqual(events.find(row=>row.kind==='dropped'&&row.token===dropped.token),dropped);
  for(const name of ['requestSha256','responseSha256'])hash(dropped[name]);
  assert.deepEqual(after,before,'Same original app/document/pane/tab/source/view without navigation');
  for(const name of ['frameId','loaderId','url','tabId','sourceEntryId','sourceRevision'])assert.ok(typeof before[name]==='string'&&before[name]);
  assert.ok(Number.isSafeInteger(before.appPid)&&before.appPid>0);assert.ok(Number.isSafeInteger(before.paneBackendNodeId)&&before.paneBackendNodeId>0);hash(before.sourceSha256);
  assert.equal(before.basePath,'Create.base');assert.equal(before.viewLabel,'Create view');assert.equal(before.viewIndex,0);
  const owned=generations.filter(row=>row.appPid===before.appPid);assert.equal(owned.length,2,'Only the original and automatically replaced host generations');
  const original=owned.find(row=>row.generation===dropped.generation),fresh=owned.find(row=>row.generation!==dropped.generation);
  assert.ok(original&&fresh);uuid(fresh.generation);
  assert.equal(original.relayPid,dropped.relayPid);assert.equal(original.nativePid,dropped.nativePid);
  assert.notEqual(fresh.relayPid,original.relayPid);assert.notEqual(fresh.nativePid,original.nativePid);
  for(const generation of owned){assert.equal(generation.authenticatedAtLaunch,true,'Every generation has real ps launch authentication');assert.ok(Number.isSafeInteger(generation.relayPid)&&generation.relayPid>0);assert.ok(Number.isSafeInteger(generation.nativePid)&&generation.nativePid>0);}
  assert.ok(original.closeObservations.some(row=>row.kind==='closed'&&row.exitCode===0&&row.signal===null),'The deliberately dropped old host actually closed normally');
  const scoped=events.filter(row=>owned.some(generation=>generation.generation===row.generation));
  for(const row of scoped){const generation=owned.find(value=>value.generation===row.generation);assert.equal(row.relayPid,generation.relayPid);assert.equal(row.nativePid,generation.nativePid);assert.ok(Number.isSafeInteger(row.at)&&row.at>0);}
  assert.deepEqual(scoped.filter(row=>['watchdog-released','relay-failed'].includes(row.kind)),[],'A harness failure is not product recovery');
  const requests=scoped.filter(row=>row.kind==='native-write-request'&&row.method==='file_command');
  const replies=scoped.filter(row=>row.kind==='native-mutation-response'&&row.method==='file_command');
  assert.ok(replies.length>=2,'The lost original reply has at least one real same-mounted receipt replay');
  assert.equal(replies.filter(row=>row.generation===original.generation).length,1,'Only the original create was dispatched before the fault');
  assert.equal(replies[0].generation,original.generation);assert.ok(replies.slice(1).every(row=>row.generation===fresh.generation));
  assert.equal(requests.length,replies.length,'Every replayed create has exactly one observed dispatched request');
  const commandSha256=replies[0].commandSha256;hash(commandSha256);
  for(const reply of replies){
    assert.equal(reply.operationId,dropped.operationId,'Replay cannot issue another create operation');assert.equal(reply.ok,true);assert.equal(reply.state,'committed');assert.equal(reply.sequence,dropped.sequence,'Exact receipt replay cannot author another mutation');
    assert.equal(reply.commandSha256,commandSha256);assert.equal(reply.bodySha256,bodySha256);hash(reply.requestSha256);hash(reply.responseSha256);
    const dispatched=requests.filter(row=>row.generation===reply.generation&&row.requestId===reply.requestId);assert.equal(dispatched.length,1);
    for(const row of dispatched){assert.equal(row.operationId,dropped.operationId);assert.equal(row.commandSha256,commandSha256);assert.equal(row.bodySha256,bodySha256);assert.ok(row.at<=reply.at);}
  }
  assert.equal(replies[0].requestSha256,dropped.requestSha256);assert.equal(replies[0].responseSha256,dropped.responseSha256);assert.equal(replies[0].requestId,dropped.requestId);
  assert.ok(replies[0].at<=dropped.at);assert.ok(replies.slice(1).every(row=>row.at>dropped.at));
  const allRequests=scoped.filter(row=>row.kind==='native-request');assert.ok(allRequests.length>=requests.length,'All actual wire requests are passively observed');
  const claims=owned.map(generation=>{
    const create=allRequests.find(row=>row.method==='file_command'&&row.generation===generation.generation);assert.ok(create);
    const candidates=scoped.filter(row=>row.kind==='native-admission-response'&&row.method==='claim_client'&&row.generation===generation.generation&&row.ok===true&&row.leaseTokenSha256===create.leaseTokenSha256&&row.clientIdSha256===create.leaseClientIdSha256&&row.localStoreIdSha256===create.leaseLocalStoreIdSha256);
    assert.equal(candidates.length,1,'Exactly one positive real claim authenticates the replayed command lease');const row=candidates[0];
    for(const name of ['clientIdSha256','requestedClientIdSha256','localStoreIdSha256','leaseTokenSha256','requestSha256','responseSha256'])hash(row[name]);
    assert.equal(row.clientIdSha256,row.requestedClientIdSha256);assert.ok(row.at<requests.find(request=>request.generation===generation.generation).at,'Positive same-scope claim precedes original operation replay');return row;
  });
  assert.equal(claims[0].clientIdSha256,claims[1].clientIdSha256);assert.equal(claims[0].localStoreIdSha256,claims[1].localStoreIdSha256);assert.notEqual(claims[0].leaseTokenSha256,claims[1].leaseTokenSha256,'Replacement receives a genuinely fresh lease');
  for(const row of allRequests)assert.ok(row.method==='file_command'||ordinaryMethods.has(row.method)||subcommands[row.method]?.has(row.requestOp),'Every request must belong to the original create or a known non-authoring/maintenance lane');
  for(const request of requests){
    const claim=claims.find(row=>row.generation===request.generation);assert.equal(request.clientIdSha256,claim.clientIdSha256);
    const generic=allRequests.filter(row=>row.generation===request.generation&&row.requestId===request.requestId);assert.equal(generic.length,1);
    const row=generic[0];assert.equal(row.method,'file_command');assert.equal(row.operationId,dropped.operationId);assert.equal(row.commandSha256,commandSha256);assert.equal(row.bodySha256,bodySha256);
    assert.equal(row.clientIdSha256,claim.clientIdSha256);assert.equal(row.leaseClientIdSha256,claim.clientIdSha256);assert.equal(row.leaseLocalStoreIdSha256,claim.localStoreIdSha256);assert.equal(row.leaseTokenSha256,claim.leaseTokenSha256,'The exact original replay uses the real freshly claimed lease');
  }
  assert.equal(allRequests.filter(row=>row.method==='file_command').length,requests.length,'No unobserved alternate create request');
  const userActions=actions;
  assert.equal(userActions.length,1,'No user action may complete or retry automatic recovery');assert.equal(userActions[0].action,'button');assert.equal(userActions[0].label,'New');assert.equal(userActions[0].scope,'.pane.is-active .bases-session');assert.ok(Number.isSafeInteger(actionStartedAt)&&actionStartedAt>0&&actionStartedAt<=requests[0].at&&actionStartedAt<=userActions[0].at,'Input dispatch begins before the original command; UI action completion can follow fast Native work');
  assert.deepEqual(names,['.keep','Untitled.md'],'One original requested note, with no duplicate destination');
  assert.equal(current.entryId,dropped.entryId);assert.equal(current.revision,dropped.revision,'Current Native metadata still identifies the exact dropped receipt');
  assert.equal(ui.observed,true);assert.equal(ui.disposed,false,'Passive observation remains active through the sealed proof');assert.ok(ui.mutationFrames>0&&ui.animationFrames>0,'Passive observation spans mutation and visible-frame boundaries');assert.equal(ui.overflow,false);assert.deepEqual(ui.failures,[],'No visible error, retry/reopen control or original-target flash');
  return{operationId:dropped.operationId,entryId:dropped.entryId,revision:dropped.revision,sequence:dropped.sequence,bodySha256,commandSha256,transportReplays:replies.length-1,
    originalGeneration:original.generation,replacementGeneration:fresh.generation,
    replies:replies.map(row=>fields(row,['generation','at','relayPid','nativePid','requestId','operationId','sequence','commandSha256','bodySha256','requestSha256','responseSha256'])),
    admissions:claims.map(row=>fields(row,['generation','at','relayPid','nativePid','clientIdSha256','localStoreIdSha256','leaseTokenSha256','requestSha256','responseSha256']))};
}
