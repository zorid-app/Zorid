import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const databaseName = 'zorid-core-vault:default-v1';
export const noteName = 'Functional browser note';
export const notePath = noteName + '.md';
export const marker = 'ZoridFunctionalUiMarker7c42';
export const source = 'Ordinary browser note.\n' + marker + '\n';
export const phaseNames = Object.freeze(['create-and-rename', 'keyboard-edit-and-durable-save', 'normal-reload', 'rich-search', 'open-search-result']);
export const harnessInputs = Object.freeze(['run.mjs', 'oracles.mjs', 'oracles.test.mjs', 'README.md'].map(name => 'tests/bases-web-integration/' + name));
export const faviconReceiptWaitMs = 1000;

// Discovery can report a Worker before its URL is assigned. Retain its real
// lifecycle instead of treating the initial empty URL as its final identity.
export function observeWorkerTarget(events, message) {
  const info = message.params?.targetInfo;
  const known = message.method === 'Target.targetDestroyed' && events.some(event => event.params?.targetInfo?.targetId === message.params?.targetId);
  if (!known && (!['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method) || info?.type !== 'worker')) return false;
  assert.ok(events.length < 128, 'Bounded raw Worker target events');
  events.push(structuredClone(message)); return true;
}

export function liveWorkerCandidate(evidence,snapshot=evidence.workerTargetSnapshot) {
  const { workerTargetEvents: events, normalPageTarget } = evidence;
  assert.ok(typeof normalPageTarget === 'string' && normalPageTarget.length > 0);
  const targets = snapshot?.targets;
  assert.ok(Array.isArray(events) && events.length <= 128 && Array.isArray(targets) && targets.length <= 64, 'Bounded Worker discovery evidence');
  assert.ok(Number.isInteger(snapshot.eventsThrough) && snapshot.eventsThrough >= 0 && snapshot.eventsThrough <= events.length && Number.isFinite(snapshot.capturedAt), 'Final snapshot has an exact lifecycle boundary');
  const workers = new Map();
  for (const [index, event] of events.slice(0, snapshot.eventsThrough).entries()) {
    if (event.method === 'Target.targetDestroyed') { const worker = workers.get(event.params.targetId); assert.ok(worker && !worker.destroyed, 'Destroyed Worker must have a unique earlier creation'); worker.destroyed = true; continue; }
    assert.ok(['Target.targetCreated', 'Target.targetInfoChanged'].includes(event.method));
    const info = event.params.targetInfo; assert.equal(info.type, 'worker'); assert.ok(typeof info.targetId === 'string' && info.targetId.length > 0);
    if (event.method === 'Target.targetCreated') { assert.equal(workers.has(info.targetId), false, 'Unique Worker creation'); workers.set(info.targetId, { created: index, createdParentId: info.parentId, observedUrls: info.url ? [info.url] : [], info: { ...info }, destroyed: false }); }
    else { const worker = workers.get(info.targetId); assert.ok(worker && !worker.destroyed, 'Worker URL changes require a live observed creation'); if (info.parentId !== undefined && worker.info.parentId !== undefined) assert.equal(info.parentId, worker.info.parentId, 'Worker parent cannot change'); if (info.url) worker.observedUrls.push(info.url); worker.info = { ...worker.info, ...info }; }
  }
  const seen = new Set(), matches = [];
  for (const info of targets) {
    assert.ok(typeof info.targetId === 'string' && !seen.has(info.targetId), 'Unique final target IDs'); seen.add(info.targetId);
    if (info.type !== 'worker') continue;
    if(info.parentId!==normalPageTarget)continue;
    const worker = workers.get(info.targetId);
    assert.ok(worker && !worker.destroyed, 'Final product Worker must have a live observed creation');
    assert.equal(worker.createdParentId, normalPageTarget, 'Created Worker belongs to the owned normal page');
    assert.equal(info.parentId, normalPageTarget, 'Final Worker belongs to the owned normal page');
    matches.push({ targetId: info.targetId, parentId: info.parentId, url: info.url, createdEvent: worker.created,observedUrls:worker.observedUrls });
  }
  assert.equal(matches.length, 1, 'Exactly one current actual product Worker target observed');
  return matches[0];
}

export const workerLocationExpression='({href:self.location.href,origin:self.location.origin,pathname:self.location.pathname})';
const workerSourceLimit=1024*1024;
const sourceDigest=source=>createHash('sha256').update(source).digest('hex');
function workerURL(href,origin){
  const url=new URL(href);assert.equal(url.origin,origin);assert.equal(url.pathname,'/src/platform/browser-core-worker.ts');
  assert.ok(!url.hash&&!url.username&&!url.password,'Exact normal Worker resource');return url;
}

export function productWorkerProof(evidence){
  const candidate=liveWorkerCandidate(evidence),inspection=evidence.workerInspection;
  assert.ok(inspection?.complete&&inspection.detached===true,'Actual owned Worker inspection and detach are required');
  assert.equal(inspection.targetId,candidate.targetId);assert.equal(inspection.parentId,evidence.normalPageTarget);
  assert.deepEqual(inspection.autoAttach?.request,workerAutoAttach);assert.equal(inspection.autoAttach.acknowledged,true);assert.equal(inspection.autoAttach.disabled,true);
  assert.ok(Array.isArray(inspection.protocolEvents)&&inspection.protocolEvents.length<=512,'Bounded raw Inspector receipts');
  const attachments=inspection.protocolEvents.filter(row=>row.method==='Target.attachedToTarget'),detachments=inspection.protocolEvents.filter(row=>row.method==='Target.detachedFromTarget');
  assert.equal(attachments.length,1);assert.equal(detachments.length,1);assert.deepEqual(attachments[0].params,inspection.attachedEvent);assert.equal(detachments[0].params.sessionId,inspection.sessionId);assert.ok(detachments[0].params.targetId===undefined||detachments[0].params.targetId===candidate.targetId);
  assert.equal(inspection.attachedEvent?.sessionId,inspection.sessionId);assert.equal(inspection.attachedEvent.targetInfo.targetId,candidate.targetId);assert.equal(inspection.attachedEvent.targetInfo.parentId,evidence.normalPageTarget);assert.equal(inspection.attachedEvent.targetInfo.type,'worker');assert.equal(inspection.attachedEvent.waitingForDebugger,false);assert.ok(typeof inspection.sessionId==='string'&&inspection.sessionId.length>0);
  const location=inspection.location,url=workerURL(location.href,evidence.origin);
  assert.equal(inspection.attachedEvent.targetInfo.url,url.href);assert.equal(location.origin,url.origin);assert.equal(location.pathname,url.pathname);
  for(const observed of [...candidate.observedUrls,candidate.url].filter(Boolean))assert.equal(observed,url.href,'Every nonempty target URL agrees with actual WorkerLocation');
  const after=liveWorkerCandidate(evidence,inspection.postSnapshot);assert.equal(after.targetId,candidate.targetId);
  assert.ok(inspection.postSnapshot.eventsThrough>=evidence.workerTargetSnapshot.eventsThrough&&inspection.postSnapshot.capturedAt>=evidence.workerTargetSnapshot.capturedAt,'Post-detach liveness follows the original snapshot');
  for(const observed of [...after.observedUrls,after.url].filter(Boolean))assert.equal(observed,url.href);
  assert.equal(inspection.locationExpression,workerLocationExpression,'Only the standard read-only WorkerLocation expression was evaluated');
  assert.deepEqual(inspection.commands.map(item=>item.method),['Runtime.evaluate','Debugger.enable','Debugger.getScriptSource']);
  assert.ok(inspection.commands.every((item,index)=>item.id===index+1&&item.replied===true&&item.ack?.status==='received'&&item.reply?.status==='received'&&!item.failure),'All three exact Inspector commands replied successfully');
  assert.ok(Array.isArray(inspection.scripts)&&inspection.scripts.length<=256,'Bounded retained script metadata');
  const entry=inspection.entryScript,parsed=inspection.scripts.filter(item=>item.url===url.href);
  assert.equal(parsed.length,1,'Exactly one actual entry script parsed in the attached Worker');assert.equal(parsed[0].scriptId,entry.scriptId);assert.equal(entry.url,url.href);
  assert.ok(typeof entry.source==='string'&&Buffer.byteLength(entry.source)>0&&Buffer.byteLength(entry.source)<=workerSourceLimit);
  assert.equal(entry.bytes,Buffer.byteLength(entry.source));assert.equal(entry.sha256,sourceDigest(entry.source),'Rehash the retained actual entry script');
  assert.equal(inspection.driverSource.url,url.href);assert.equal(inspection.driverSource.status,200);assert.equal(inspection.driverSource.bytes,entry.bytes);assert.equal(inspection.driverSource.sha256,entry.sha256,'Actual Worker entry source matches the separately labelled ordinary route');
  assert.ok(!inspection.failure&&!inspection.protocolFailure&&!inspection.detachFailure);
  assert.ok(evidence.requests.some(row=>row.path==='/src/platform/browser-core-worker.ts'&&row.method==='GET'&&row.statusCode===200&&/Chrome\//.test(row.userAgent)),'Actual browser fetched the normal product Worker');
  return{targetId:candidate.targetId,parentId:candidate.parentId,url:url.href,createdEvent:candidate.createdEvent,entrySourceSha256:entry.sha256};
}

// Reporting existing child Workers binds Chromium's renderer channel. This is
// enabled only after all UI phases, on the fresh owned parent page, never paused.
export const workerAutoAttach = Object.freeze({autoAttach:true,waitForDebuggerOnStart:false,flatten:false,filter:[{type:'worker',exclude:false},{exclude:true}]});
export const workerAutoDetach = Object.freeze({autoAttach:false,waitForDebuggerOnStart:false,flatten:false});
export async function inspectWorker({targetId,parentId,origin,ws,setAutoAttach,send,deadline,fetchSource,receipt,now=Date.now,rpcTimeoutMs=5000,cleanupTimeoutMs=5000}){
  assert.ok(Number.isInteger(rpcTimeoutMs)&&rpcTimeoutMs>0&&rpcTimeoutMs<=5000);
  assert.ok(Number.isInteger(cleanupTimeoutMs)&&cleanupTimeoutMs>0&&cleanupTimeoutMs<=5000);
  assert.ok(typeof parentId==='string'&&parentId.length>0,'Owned parent page');
  Object.assign(receipt,{targetId,parentId,commands:[],scripts:[],protocolEvents:[],autoAttach:{request:structuredClone(workerAutoAttach),acknowledged:false,disabled:false},detached:false,complete:false,locationExpression:workerLocationExpression});
  const pending=new Map();let sessionId,next=0,fatal,scriptWait,closing=false;
  let attachedResolve,attachedReject,detachedResolve;
  const attached=new Promise((resolve,reject)=>{attachedResolve=resolve;attachedReject=reject;});attached.catch(()=>{});
  const detached=new Promise(resolve=>{detachedResolve=resolve;});
  const remaining=()=>{const left=deadline-now();assert.ok(left>0,'Worker inspection workflow deadline');return Math.min(rpcTimeoutMs,left);};
  const limited=async(work,ms,label)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}};
  const fail=error=>{fatal??=error;receipt.protocolFailure=fatal.message;attachedReject(fatal);for(const item of pending.values())item.reject(fatal);scriptWait?.reject(fatal);};
  function retain(value){assert.ok(Buffer.byteLength(JSON.stringify(value))<=16384,'Bounded Inspector event metadata');assert.ok(receipt.protocolEvents.length<512,'Bounded Worker protocol records');receipt.protocolEvents.push({at:now(),...structuredClone(value)});}
  const listener=event=>{
    try{
      const outer=JSON.parse(event.data);
      if(outer.method==='Target.attachedToTarget'){
        const value=outer.params;retain({method:outer.method,params:value});
        assert.equal(closing,false,'No late Worker attachment during cleanup');
        assert.ok(typeof value?.sessionId==='string'&&value.sessionId.length>0&&value.sessionId.length<=256,'Owned Worker session');
        assert.equal(value.targetInfo?.targetId,targetId,'Only the prevalidated live Worker may attach');
        assert.equal(value.targetInfo.type,'worker');assert.equal(value.targetInfo.parentId,parentId,'Attached Worker belongs to the owned parent');
        assert.equal(value.waitingForDebugger,false,'The existing Worker must never wait for a debugger');
        assert.equal(sessionId,undefined,'Exactly one owned Worker attachment');
        workerURL(value.targetInfo.url,origin);
        sessionId=value.sessionId;receipt.sessionId=sessionId;receipt.attachedEvent=structuredClone(value);attachedResolve(value);return;
      }
      if(outer.method==='Target.detachedFromTarget'){
        retain({method:outer.method,params:outer.params});
        assert.equal(outer.params?.sessionId,sessionId,'Only the owned Inspector session may detach');
        assert.ok(outer.params.targetId===undefined||outer.params.targetId===targetId,'Detached Worker identity');
        assert.equal(closing,true,'Owned Worker Inspector detached unexpectedly');
        assert.equal(receipt.detached,false,'Unique owned Worker detach');receipt.detached=true;detachedResolve();return;
      }
      if(outer.method!=='Target.receivedMessageFromTarget')return;
      assert.ok(typeof outer.params?.message==='string'&&outer.params.message.length<=2*workerSourceLimit,'Bounded Worker Inspector reply');
      const message=JSON.parse(outer.params.message);
      retain({method:outer.method,sessionId:outer.params.sessionId,targetId:outer.params.targetId,message:{id:message.id,method:message.method,error:message.error,bytes:Buffer.byteLength(outer.params.message),sha256:sourceDigest(outer.params.message)}});
      assert.ok(sessionId&&outer.params.sessionId===sessionId,'Only the owned Worker session can send Inspector messages');
      assert.ok(outer.params.targetId===undefined||outer.params.targetId===targetId,'Worker Inspector target identity');
      if(message.id!==undefined){const item=pending.get(message.id);assert.ok(item,'Only the exact pending Worker request can receive a reply');message.error?item.reject(Error('Worker Inspector command failed: '+JSON.stringify(message.error))):item.resolve(message.result);return;}
      if(message.method==='Debugger.paused'||message.method==='Debugger.scriptFailedToParse'||message.method==='Runtime.exceptionThrown'||message.method==='Runtime.consoleAPICalled'&&message.params?.type==='error')throw Error('Worker Inspector observed a pause or runtime/script error: '+message.method);
      if(message.method!=='Debugger.scriptParsed')return;
      const value=message.params;assert.ok(receipt.scripts.length<256&&typeof value?.scriptId==='string'&&typeof value.url==='string'&&value.url.length<=4096,'Bounded parsed Worker script metadata');
      assert.ok(!receipt.scripts.some(item=>item.scriptId===value.scriptId),'Unique parsed Worker script ID');
      receipt.scripts.push({scriptId:value.scriptId,url:value.url,hash:value.hash,executionContextId:value.executionContextId,isModule:value.isModule,length:value.length});
      if(scriptWait&&value.url===receipt.location?.href)scriptWait.resolve(value.scriptId);
    }catch(error){fail(error);}
  };
  ws.addEventListener('message',listener);
  async function request(method,params={}){
    if(fatal)throw fatal;assert.ok(++next<=3,'Only the three declared read-only Worker requests');
    const id=next,command={id,method,sentAt:now(),ack:{status:'pending'},reply:{status:'pending'}};receipt.commands.push(command);
    const result=new Promise((resolve,reject)=>{let settled=false;pending.set(id,{resolve(value){assert.equal(settled,false,'Unique Worker reply');settled=true;command.reply={status:'received',at:now()};resolve(value);},reject(error){settled=true;command.reply={status:'failed',at:now(),error:error.message};reject(error);}});});result.catch(()=>{});
    const acknowledgement=Promise.resolve().then(()=>send(sessionId,JSON.stringify({id,method,params}))).then(value=>{command.ack={status:'received',at:now()};return value;},error=>{command.ack={status:'failed',at:now(),error:error.message};throw error;});
    try{
      const [,reply]=await limited(Promise.all([acknowledgement,result]),remaining(),'Worker Inspector reply deadline: '+method);
      command.replied=true;return reply;
    }catch(error){command.failure=error.message;throw error;}
    finally{pending.delete(id);}
  }
  let failure;
  try{
    const enabled=Promise.resolve().then(()=>setAutoAttach(structuredClone(workerAutoAttach))).then(()=>{receipt.autoAttach.acknowledged=true;receipt.autoAttach.acknowledgedAt=now();},error=>{receipt.autoAttach.failure=error.message;throw error;});
    await limited(Promise.all([enabled,attached]),remaining(),'Worker parent reporting deadline');if(fatal)throw fatal;
    const location=await request('Runtime.evaluate',{expression:workerLocationExpression,returnByValue:true,awaitPromise:false});assert.ok(!location.exceptionDetails,'WorkerLocation read must succeed');receipt.location=location.result?.value;
    const url=workerURL(receipt.location?.href,origin);assert.equal(receipt.location.origin,url.origin);assert.equal(receipt.location.pathname,url.pathname);assert.equal(receipt.attachedEvent.targetInfo.url,url.href);
    await request('Debugger.enable');if(fatal)throw fatal;
    const parsed=receipt.scripts.filter(item=>item.url===url.href);assert.ok(parsed.length<=1,'Unique entry script');let scriptId=parsed[0]?.scriptId;
    if(!scriptId){let timer;try{scriptId=await new Promise((resolve,reject)=>{scriptWait={resolve,reject};timer=setTimeout(()=>reject(Error('Actual Worker entry script was not observed')),remaining());});}finally{clearTimeout(timer);scriptWait=undefined;}}
    const entry=await request('Debugger.getScriptSource',{scriptId});assert.ok(typeof entry.scriptSource==='string'&&Buffer.byteLength(entry.scriptSource)<=workerSourceLimit,'Bounded actual Worker entry source');
    receipt.entryScript={scriptId,url:url.href,source:entry.scriptSource,bytes:Buffer.byteLength(entry.scriptSource),sha256:sourceDigest(entry.scriptSource)};
    receipt.driverSource=await fetchSource(url.href);assert.equal(receipt.driverSource.url,url.href);assert.equal(receipt.driverSource.status,200);assert.equal(receipt.driverSource.bytes,receipt.entryScript.bytes);assert.equal(receipt.driverSource.sha256,receipt.entryScript.sha256,'Loaded Worker entry bytes equal the ordinary served module');
    if(fatal)throw fatal;
  }catch(error){failure=error;receipt.failure=error.message;}
  finally{
    closing=true;for(const item of pending.values())item.reject(Error('Worker Inspector closing'));scriptWait?.reject(Error('Worker Inspector closing'));
    try{
      // This page session owns this fresh policy. Disabling it detaches only its
      // automatic sessions, including a late attach; it touches no foreign client.
      await limited(Promise.resolve().then(()=>setAutoAttach(structuredClone(workerAutoDetach))).then(()=>{receipt.autoAttach.disabled=true;receipt.autoAttach.disabledAt=now();}),cleanupTimeoutMs,'Worker parent reporting disable deadline');
      if(sessionId)await limited(detached,cleanupTimeoutMs,'Worker Inspector detach event deadline');
    }catch(error){receipt.detachFailure=error.message;failure??=error;}
    ws.removeEventListener('message',listener);
  }
  failure??=fatal;if(failure)throw failure;receipt.complete=true;return receipt;
}

// Handwritten persistence contract inspected at browser-streaming-vault.ts
// VERSION8, browser-normalized-idb.ts and browser-managed-records.ts. Normal
// browser-default never selects the legacyFixture/version6 opener.
const storageLayout = {
  metadata: ['id', [['by_path', 'path', false]]], content: ['id'], receipts: ['operation_id'], journal: ['sequence'], control: ['key'], presentation: ['id'],
  intents: [['client_id', 'intent_id'], [['by_operation', 'operation_id', true]]], checkpoint_heads: [['clientId', 'key']],
  checkpoint_revisions: [['clientId', 'revision'], [['by_creation', ['clientId', 'creationOrder'], true], ['by_global_sequence', 'order', true], ['by_key', ['clientId', 'key', 'order'], false], ['by_sequence', ['clientId', 'order'], true]]],
  sync_state: ['key'], sync_text: ['key'], sync_authored: ['key', [['by_pending_order', ['pending', 'order'], false]]], sync_envelopes: ['key'], sync_cursors: ['key'], sync_revisions: ['revision'],
  sync_source_headers: [['realmId', 'vaultId', 'updateId']], sync_source_payloads: [['realmId', 'vaultId', 'updateId']], sync_source_wires: [['realmId', 'vaultId', 'updateId']],
  sync_graph_records: [['realmId', 'vaultId', 'updateId']], sync_graph_activities: [['realmId', 'vaultId', 'updateId']],
  binary_stages: [['clientId', 'stageId'], [['by_operation', ['clientId', 'operationId'], true]]], binary_stage_chunks: [['clientId', 'stageId', 'sequenceOrder']],
  binary_reads: [['clientId', 'readId'], [['by_active', 'active', false], ['by_pin', ['clientId', 'pinId'], true]]],
  sync_materialization_refs: ['id'], sync_publication_refs: [['id', 'revision']],
  managed_collections: [['realmId', 'vaultId', 'owner', 'collection']], managed_records: [['realmId', 'vaultId', 'owner', 'collection', 'record', 'generation']],
  managed_receipts: [['realmId', 'vaultId', 'updateId'], [['by_retry', ['realmId', 'vaultId', 'owner', 'collection', 'updateId'], false]]],
  managed_operation_sources: [['realmId', 'vaultId', 'owner', 'collection', 'record', 'generation', 'operationId', 'updateId'], [['by_operation', ['realmId', 'vaultId', 'owner', 'collection', 'record', 'generation', 'operationId'], false]]],
  managed_local_operations: [['realmId', 'vaultId', 'owner', 'collection', 'operationId']],
  managed_changes: [['realmId', 'vaultId', 'sequenceOrder'], [['by_collection', ['realmId', 'vaultId', 'owner', 'collection', 'sequenceOrder'], false]]],
};
export const streamingStorageSchema = Object.freeze({ version: 8, stores: Object.keys(storageLayout).sort().map(name => { const [keyPath, indexes = []] = storageLayout[name]; return { name, keyPath, autoIncrement: false, indexes: indexes.map(([name, keyPath, unique]) => ({ name, keyPath, unique, multiEntry: false })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }; }) });
class StorageObservationFailure extends Error { constructor(code, message) { super(message); this.name = 'StorageObservationFailure'; this.code = code; } }

export function storageObservationSnapshot(probe) {
  if (!probe || !['ready', 'not-ready', 'fatal'].includes(probe.kind)) throw new StorageObservationFailure('invalid_storage_observation', 'Storage observer returned no classified evidence');
  if (probe.kind === 'fatal') throw new StorageObservationFailure(probe.code, probe.message);
  try {
    assert.equal(probe.schema.database, databaseName); assert.equal(probe.schema.version, streamingStorageSchema.version);
    assert.deepEqual(probe.schema.stores, streamingStorageSchema.stores);
    assert.deepEqual(probe.inventory.filter(row => row.name === databaseName), [{ name: databaseName, version: 8 }]);
    assert.equal(probe.snapshot.database, databaseName); assert.equal(probe.snapshot.version, 8);
    if (probe.kind === 'not-ready') {
      assert.equal(probe.code, 'entry_not_committed'); assert.deepEqual(probe.snapshot.entries, []); assert.deepEqual(probe.snapshot.contents, []);
    }
  } catch { throw new StorageObservationFailure('unsupported_storage_observation', 'Unexpected normal streaming storage schema or observer result'); }
  if (probe.kind === 'not-ready') throw Error('The UI-created note has not committed yet');
  return probe.snapshot;
}

/** No text-only error exemption. The sole ambient case is the browser's
 * automatic optional favicon GET with a matching observed HTTP404 response. */
export function classifyRuntimeErrors(events, network, origin, { observedAt = [], now = 0, final = false } = {}) {
  const exceptions = [], ambientNetworkErrors = [], pendingNetworkErrors = [];
  let favicon;
  try { const url = new URL(origin); if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin) favicon = origin + '/favicon.ico'; } catch { /* Unknown origin never grants an exception. */ }
  const records = new Map();
  for (const row of network) records.set(row.requestId, records.has(row.requestId) ? null : row);
  for (let index = 0; index < events.length; index++) {
    const event = events[index], entry = event?.params?.entry;
    const candidate = favicon && event?.method === 'Log.entryAdded' && entry?.source === 'network' && entry.level === 'error' && entry.url === favicon
      && entry.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)' && typeof entry.networkRequestId === 'string' && entry.networkRequestId.length > 0;
    if (!candidate) { exceptions.push(event); continue; }
    const receipt = records.get(entry.networkRequestId), request = receipt?.request, response = receipt?.response;
    const contradicted = records.has(entry.networkRequestId) && receipt === null || receipt && (receipt.requestCount > 1 || receipt.responseCount > 1)
      || request && (request.method !== 'GET' || request.url !== favicon || request.type !== 'Other' || request.initiatorType !== 'other' || request.initiatorHasStack !== false || request.redirected !== false)
      || response && (response.url !== favicon || response.status !== 404 || response.type !== 'Other');
    if (contradicted) { exceptions.push(event); continue; }
    if (request && response && receipt.requestCount === 1 && receipt.responseCount === 1) {
      ambientNetworkErrors.push({ reason: 'automatic-optional-favicon-404', event, receipt: structuredClone(receipt) }); continue;
    }
    const received = observedAt[index], expiresAt = received + faviconReceiptWaitMs;
    if (!final && Number.isFinite(received) && received <= now && now < expiresAt) pendingNetworkErrors.push({ event, index, expiresAt });
    else exceptions.push(event);
  }
  return { exceptions, ambientNetworkErrors, pendingNetworkErrors };
}

/** Pending correlation is a barrier, never permission to continue UI input.
 * The caller notifies on real network receipts or the bounded receipt deadline. */
export async function awaitRuntimeHealth(read, waitForChange) {
  for (;;) {
    const state = read(); assert.deepEqual(state.exceptions, [], 'Fatal renderer or unclassified network error');
    assert.equal(state.eventOverflow, 0, 'Runtime evidence overflow');
    if (!state.pendingNetworkErrors.length) return state;
    await waitForChange(Math.min(...state.pendingNetworkErrors.map(row => row.expiresAt)));
  }
}

/** A readiness assertion can be transient; a known runtime failure cannot.
 * Health checks sit outside the retry catch and retain the original100ms poll. */
export async function waitForObservation(check, { now, deadline, assertHealthy, pause, label }) {
  let last;
  while (now() < deadline) {
    await assertHealthy();
    let value;
    try { value = await check(); }
    catch (error) { await assertHealthy(); if (error instanceof StorageObservationFailure) throw error; last = error; await pause(100); continue; }
    await assertHealthy(); return value;
  }
  throw new Error(label + ': ' + (last?.message ?? 'deadline'));
}

export function trackedHarnessInputs(tracked) {
  for (const name of [...harnessInputs, 'tests/tasks-electron-integration/cdp.mjs', 'tests/bases-electron-integration/ui.mjs', 'tests/browser-workblocks-worker/cleanup.mjs']) assert.ok(tracked.includes(name), 'Executing harness input must be tracked in the frozen checkout: ' + name);
}

/** Late startup resources still have an owner after a workflow deadline. Their
 * close failures are retained for final acceptance rather than discarded. */
export function trackOwnedStartup(work, name, closeLate) {
  const state = { name, expired: false, creationSettled: false, cleanupStatus: 'not_required' };
  const settled = Promise.resolve(work).then(async resource => {
    state.creationSettled = true;
    if (state.expired) {
      state.cleanupStatus = 'running';
      try { await closeLate(resource); state.cleanupStatus = 'closed'; }
      catch (error) { state.cleanupStatus = 'failed'; state.cleanupError = String(error?.stack ?? error); }
    }
  }, error => { state.creationSettled = true; state.creationError = String(error?.stack ?? error); });
  return { state, settled };
}

export function finalEvidence(evidence) {
  assert.equal(evidence.workflowCompleted, true);
  assert.deepEqual(evidence.phases.map(({ name, status }) => ({ name, status })), phaseNames.map(name => ({ name, status: 'passed' })));
  assert.deepEqual(evidence.exceptions, [], 'Late renderer errors must fail final acceptance'); assert.equal(evidence.eventOverflow, 0);
  const classified = classifyRuntimeErrors(evidence.errorEvents, evidence.networkReceipts, evidence.origin, { final: true });
  assert.deepEqual(classified.exceptions, [], 'Unclassified final runtime error');
  assert.deepEqual(classified.ambientNetworkErrors, evidence.ambientNetworkErrors, 'Ambient error evidence must retain exact raw errors and correlated receipts');
  assert.deepEqual(evidence.pendingNetworkErrors, [], 'Final runtime receipts must not remain pending');
  assert.deepEqual(productWorkerProof(evidence), evidence.workerProof, 'Final acceptance retains correlated Worker evidence');
  assert.equal(evidence.provenanceVerified, true); assert.equal(evidence.finalProvenanceVerified, true);
  assert.equal(evidence.normalClose?.requested, true); assert.deepEqual(evidence.cleanup.failures, []);
  assert.equal(evidence.cleanup.chrome.exitCode, 0); assert.equal(evidence.cleanup.chrome.signalCode, null); assert.deepEqual(evidence.cleanup.chrome.signals, []);
  assert.equal(evidence.cleanup.vite.closeResolved, true);
  assert.equal(evidence.startupCleanupTimedOut, false);
  for (const resource of evidence.startupResources) {
    assert.equal(resource.creationSettled, true, 'Owned resource creation remains unresolved');
    assert.ok(!resource.cleanupError, 'Late owned resource cleanup failed');
    assert.ok(!resource.expired || !!resource.creationError || resource.cleanupStatus === 'closed', 'Late resource was not closed');
  }
}

export function savedNote(snapshot, expectedPath, expectedSource, previous) {
  assert.equal(snapshot.database, databaseName);
  assert.equal(snapshot.version, 8, 'The normal browser uses the inspected streaming schema version8');
  assert.equal(snapshot.entries.length, 1, 'Fresh normal vault contains exactly the one UI-created entry');
  const entry = snapshot.entries[0];
  assert.equal(entry.kind, 'file'); assert.equal(entry.deleted, false); assert.equal(entry.path, expectedPath);
  assert.ok(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 256);
  assert.ok(typeof entry.revision === 'string' && entry.revision.length > 0 && entry.revision.length <= 256);
  assert.equal(snapshot.contents.length, 1);
  assert.equal(snapshot.contents[0].id, entry.id);
  assert.deepEqual(snapshot.contents[0].bytes, [...new TextEncoder().encode(expectedSource)], 'Independent whole saved-byte oracle');
  if (previous) assert.equal(entry.id, previous.id, 'Normal rename/edit preserves entry identity');
  return structuredClone(entry);
}

export function editorFrame(frame, expectedTitle, expectedSource, focused = false) {
  assert.equal(frame.workspace, true); assert.equal(frame.desktopBridge, false); assert.equal(frame.fixtureMarker, false);
  assert.equal(frame.title, expectedTitle); assert.equal(frame.editors, 1); assert.equal(frame.connected, true);
  assert.equal(frame.editable, true); assert.equal(frame.text, expectedSource); assert.equal(frame.saveState, '');
  if (focused) assert.equal(frame.focusedEditor, true, 'Normal title Enter transfers focus; the harness never forces it');
}

export function reloadFrame(before, after, saved, reopened) {
  assert.ok(Number.isFinite(before) && Number.isFinite(after) && after > before, 'Reload creates a different normal document');
  assert.deepEqual(reopened, saved, 'Normal reload retains the exact saved entry and revision');
}

export function searchFrame(frame, entry) {
  assert.equal(frame.query, marker); assert.equal(frame.total, '1 match in 1 file'); assert.equal(frame.status, '');
  assert.equal(frame.groups.length, 1); const group = frame.groups[0];
  assert.equal(group.entryId, entry.id); assert.equal(group.path, notePath); assert.equal(group.title, noteName);
  assert.equal(group.badge, '1'); assert.equal(group.snippets.length, 1);
  assert.ok(group.snippets[0].text.includes(marker)); assert.deepEqual(group.snippets[0].marks, [marker]);
}

/** A serialized observational reader. It never creates an absent database or
 * issues a write transaction, and closes its connection at every outcome. */
export async function readOnlyDatabaseSnapshot(name, expected) {
  const observation = { inventory: [], schema: null };
  const fatal = (code, message) => ({ ...observation, kind: 'fatal', code, message });
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return fatal('storage_inventory_unavailable', 'Read-only database inventory unavailable');
  try { observation.inventory = (await indexedDB.databases()).map(row => ({ name: row.name ?? null, version: row.version ?? null })).sort((a, b) => String(a.name).localeCompare(String(b.name))); }
  catch { return fatal('storage_inventory_failed', 'Could not enumerate existing browser databases'); }
  if (observation.inventory.length > 32) return fatal('storage_inventory_limit', 'Unexpected database inventory size');
  const matches = observation.inventory.filter(row => row.name === name);
  if (matches.length !== 1) return fatal('normal_database_missing', 'Expected one already-existing normal browser database; observer will not create one');
  return new Promise(resolve => {
    let database, settled = false;
    const finish = value => { if (settled) return; settled = true; database?.close(); resolve(value); };
    const fail = (code, message) => finish(fatal(code, message));
    let opening;
    try { opening = indexedDB.open(name); } // No version: never request an upgrade.
    catch { fail('storage_open_failed', 'Could not open the existing database read-only'); return; }
    opening.onupgradeneeded = () => { opening.transaction?.abort(); fail('unexpected_storage_upgrade', 'Read-only observer refused database creation/upgrade'); };
    opening.onerror = () => fail('storage_open_failed', 'Read-only observer could not open existing database');
    opening.onblocked = () => fail('storage_open_blocked', 'Read-only observer database open blocked');
    opening.onsuccess = () => {
      database = opening.result;
      if (settled) { database.close(); return; }
      database.onversionchange = () => fail('storage_version_changed', 'Database version changed during observation');
      try {
        const stores = Array.from(database.objectStoreNames).sort();
        observation.schema = { database: name, version: database.version, stores: [] };
        if (!stores.length || stores.length > 128) { fail('unsupported_streaming_schema', 'Unexpected normal streaming store inventory size'); return; }
        const tx = database.transaction(stores, 'readonly');
        tx.onerror = tx.onabort = () => fail('storage_observation_failed', 'Read-only observer transaction failed');
        for (const storeName of stores) {
          const store = tx.objectStore(storeName), names = Array.from(store.indexNames).sort();
          if (names.length > 64) { tx.abort(); fail('storage_schema_limit', 'Unexpected index inventory size'); return; }
          observation.schema.stores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: names.map(indexName => { const index = store.index(indexName); return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }) });
        }
        // Capture the complete observed inventory/schema before comparison. A
        // version6/unknown layout is diagnostic evidence, never an adopted format.
        if (matches[0].version !== expected.version || database.version !== expected.version || JSON.stringify(observation.schema.stores) !== JSON.stringify(expected.stores)) {
          tx.abort(); fail('unsupported_streaming_schema', 'Expected the inspected normal streaming version8 store/key/index layout'); return;
        }
        const metadata = tx.objectStore('metadata'), content = tx.objectStore('content');
        const entries = metadata.getAll(), contents = content.getAll();
        tx.oncomplete = () => {
          if (settled) return;
          try {
            if (entries.result.length > 16 || contents.result.length > 16) { fail('storage_row_limit', 'Unexpected fixture storage inventory'); return; }
            const rows = contents.result.map(row => {
              if (!(row.bytes instanceof Uint8Array) || row.bytes.length > 65536) throw Error('Unexpected inline text-byte representation');
              return { id: row.id, bytes: Array.from(row.bytes) };
            });
            const snapshot = { database: name, version: database.version, entries: entries.result.filter(row => !row.deleted), contents: rows };
            if (!snapshot.entries.length && !rows.length) { finish({ ...observation, kind: 'not-ready', code: 'entry_not_committed', snapshot }); return; }
            if (snapshot.entries.length !== rows.length || snapshot.entries.some(entry => !rows.some(row => row.id === entry.id))) { fail('unsupported_inline_projection', 'Smoke note requires the complete ordinary inline-text projection'); return; }
            finish({ ...observation, kind: 'ready', snapshot });
          } catch { fail('unsupported_inline_projection', 'Smoke note requires Uint8Array inline text, not an encoded/chunked fallback'); }
        };
      } catch { fail('storage_observation_failed', 'Could not observe the existing streaming schema and inline text'); }
    };
  });
}
