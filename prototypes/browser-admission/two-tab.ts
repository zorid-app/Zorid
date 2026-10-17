import { BrowserCoreRuntime } from '../../src/platform/browser-core-runtime.ts';
import { admitBrowserFixtureClient } from '../../src/platform/browser-client-admission.ts';
import type { BrowserClientContext } from '../../src/platform/browser-client-admission.ts';
import type { DurableWriteIntent } from '../../src/core/durable-writes.ts';
import type { BrowserVaultIntent } from '../../src/core/browser-vault.ts';

declare const __ADMISSION_SOURCE__: string;
declare const __ADMISSION_WASM_SOURCE__: string;
const output = document.querySelector<HTMLPreElement>('#result')!;
const start = document.querySelector<HTMLButtonElement>('#run')!;
const confirmClosed = document.querySelector<HTMLButtonElement>('#closed')!;
const peerLink = document.querySelector<HTMLAnchorElement>('#peer')!;
const params = new URLSearchParams(location.search);
const peer = params.get('role') === 'peer';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runId = peer ? params.get('run')! : crypto.randomUUID();
if (!uuid.test(runId)) throw new Error('Invalid fixture run ID');
const database = `zorid-core-vault:two-tab-admission-${runId}`;
const channel = new BroadcastChannel(`zorid-admission-test:${runId}`);
const tabId = crypto.randomUUID();
const runtimes = new Set<BrowserCoreRuntime>();
const checks: string[] = [];
let authority = '', manifest: unknown, finished = false, started = false;
let owner: BrowserClientContext, ownerRuntime: BrowserCoreRuntime;
let clientId = '', otherClientId = '', marker: DurableWriteIntent, inert: DurableWriteIntent, race: DurableWriteIntent;
let checkpointState = '', peerTab = '', queue: Promise<unknown> = Promise.resolve();
let watchdog: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<string, {resolve:(value:any)=>void; reject:(error:Error)=>void}>();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function same(actual: unknown, expected: unknown, message: string) { assert(JSON.stringify(actual) === JSON.stringify(expected), message); }
function log(value: unknown) { output.textContent += `\n${JSON.stringify(value)}`; }
function pass(check: string) { checks.push(check); log({passed:checks.length,check}); }
function active() { assert(!finished, 'Fixture has ended'); }
async function deadline<T>(promise: Promise<T>, label: string, ms=15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]); }
  finally { clearTimeout(timer!); }
}
function touch() { clearTimeout(watchdog); watchdog=setTimeout(()=>void finish({ok:false,error:'Fixture watchdog expired'}),240000); }
async function open(client: string) {
  active();
  const runtime = await BrowserCoreRuntime.open({database,clientId:client,wasmModuleUrl:new URL('lib/core/zorid_wasm.js',location.href).href,allowNewVault:true,timeoutMs:15000});
  if (finished) { runtime.close(); throw new Error('Fixture ended during worker initialization'); }
  runtimes.add(runtime);
  const context=admitBrowserFixtureClient(runtime,{fixture:true,assertOwner:()=>runtime.assertActive()});
  if (authority) same(context.scope.vaultId,authority,'Authority changed'); else authority=context.scope.vaultId;
  return {runtime,context};
}
async function release(runtime: BrowserCoreRuntime, context: BrowserClientContext) {
  await context.release(gate=>gate.assertActive()); runtimes.delete(runtime);
}
async function checkpoint(context: BrowserClientContext, key: string, state: unknown) {
  const previous=await context.durableWrites.checkpoints.load(key);
  await context.durableWrites.checkpoints.compareAndSwap({key,expectedRevision:previous?.revision??null,nextRevision:crypto.randomUUID(),encodedState:JSON.stringify(state)});
}
async function prepare(context: BrowserClientContext, path: string, content: string) {
  const observation=await context.durableWrites.readText(path);
  const plan=await context.durableWrites.planWrite({path,content,expectedContent:observation.content,expectedEntryId:observation.entryId,expectedRevision:observation.revision,operationId:crypto.randomUUID()});
  const key=`fixture-write/${plan.operationId}`;
  await checkpoint(context,key,{plan});
  const intent=await context.durableWrites.prepare(plan);
  await checkpoint(context,key,{plan,ref:intent.ref});
  return {observation,intent};
}
async function settle(context: BrowserClientContext, intent: DurableWriteIntent) {
  const outcome=await context.durableWrites.commit(intent.ref);
  assert(outcome.state==='committed'||outcome.state==='rejected','Unsettled commit');
  await checkpoint(context,`fixture-write/${intent.ref.operationId}`,{ref:intent.ref,outcome});
  await context.durableWrites.acknowledge(intent.ref,outcome.state==='committed'
    ? {status:'committed',operationId:intent.ref.operationId,sequence:outcome.receipt.sequence}
    : {status:'rejected',operationId:intent.ref.operationId,code:outcome.error.code});
  return outcome;
}
async function create(path: string, content: string) {
  const operationId=crypto.randomUUID();
  const receipt=await ownerRuntime.execute(operationId,JSON.stringify({operation_id:operationId,mutation:{type:'create',id:crypto.randomUUID(),path,kind:'file',content:Array.from(new TextEncoder().encode(content))}}));
  await ownerRuntime.acknowledge(operationId,{status:'committed',receipt});
}
async function authorizeMarker() {
  // Exact synthetic prepared record only: simulate interruption after persisted authorization.
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(database);let settled=false;
    const timer=setTimeout(()=>end(new Error('Open marker database timed out')),15000);
    const end=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(request.result);};
    request.onerror=()=>end(request.error??new Error('Marker open failed'));
    request.onblocked=()=>end(new Error('Marker database blocked'));
    request.onupgradeneeded=()=>{request.transaction!.abort();end(new Error('Missing fixture database'));};
    request.onsuccess=()=>{if(settled||finished)request.result.close();else end();};
  });
  try { await deadline(new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['intents'],'readwrite',{durability:'strict'});
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Marker aborted'));tx.onerror=()=>{};
    const store=tx.objectStore('intents'),get=store.get([clientId,marker.ref.token]);
    get.onsuccess=()=>{const row=get.result as BrowserVaultIntent;if(row?.status!=='prepared'||row.operation_id!==marker.ref.operationId){tx.abort();return;}store.put({...row,status:'commit_requested'});};
  }),'Persist authorized marker'); } finally { db.close(); }
}
async function inspectOwner() {
  return {marker:await owner.durableWrites.query(marker.ref),inert:await owner.durableWrites.query(inert.ref),read:await owner.durableWrites.readText('recovery.md')};
}
async function handle(command: string) {
  active();touch();
  switch(command) {
    case 'hello':return {database,authority,clientId,otherClientId,marker,inert,checkpointState,source:__ADMISSION_SOURCE__,manifest};
    case 'inspect':return inspectOwner();
    case 'prepare-race': { const prepared=await prepare(owner,'shared.md','owner wins');race=prepared.intent;return prepared; }
    case 'commit-race':return settle(owner,race);
    case 'read':return owner.durableWrites.readText('shared.md');
    default:throw new Error('Unknown fixture command');
  }
}
channel.onmessage=event=>{
  const message=event.data;
  if(!message||message.runId!==runId||message.from===tabId||finished)return;
  if(message.type==='abort'){void finish({ok:false,error:'Other fixture tab aborted'});return;}
  if(message.type==='response'&&message.to===tabId){const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);message.ok?waiter.resolve(message.result):waiter.reject(new Error(message.error));}return;}
  if(peer||!started||message.type!=='request'||typeof message.id!=='string')return;
  if(peerTab&&peerTab!==message.from)return;
  if(!peerTab&&message.command!=='hello')return;
  peerTab=message.from;
  queue=queue.then(async()=>{
    try { const result=await handle(message.command);channel.postMessage({runId,from:tabId,to:message.from,type:'response',id:message.id,ok:true,result}); }
    catch(error){if(!finished)channel.postMessage({runId,from:tabId,to:message.from,type:'response',id:message.id,ok:false,error:String(error)});}
  });
};
async function rpc(command: string): Promise<any> {
  active();const id=crypto.randomUUID();
  try { return await deadline(new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});channel.postMessage({runId,from:tabId,type:'request',id,command});}),`Owner ${command}`); }
  finally { pending.delete(id); }
}
async function locksGone() {
  const until=Date.now()+10000;
  while((await navigator.locks.query()).held?.some(lock=>lock.name?.startsWith(`zorid:consumer:v1:${authority}:`))){assert(Date.now()<until,'Fixture client lock retained');await new Promise(resolve=>setTimeout(resolve,25));}
}
async function removeDatabase() {
  await deadline(new Promise<void>((resolve,reject)=>{
    const request=indexedDB.deleteDatabase(database);
    request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);
    // Other tab cleanup can still be closing its connection; deadline bounds the wait.
    request.onblocked=()=>log({cleanup:'waiting for fixture connections to close'});
  }),'Delete synthetic database');
}
async function finish(result: Record<string,unknown>) {
  if(finished)return;finished=true;clearTimeout(watchdog);start.disabled=true;confirmClosed.disabled=true;
  if(!result.ok)channel.postMessage({runId,from:tabId,type:'abort'});
  for(const waiter of pending.values())waiter.reject(new Error('Fixture ended'));pending.clear();
  for(const runtime of runtimes)runtime.close();runtimes.clear();
  let cleanupError: string|undefined;
  try { if(authority)await locksGone();await removeDatabase(); } catch(error){cleanupError=String(error);}
  channel.close();
  const final={...result,ok:result.ok===true&&!cleanupError,source:__ADMISSION_SOURCE__,wasmSource:__ADMISSION_WASM_SOURCE__,manifest,browser:navigator.userAgent,runId,database,authority,checks:[...checks],passed:checks.length,cleanup:{workersClosed:true,databasesDeleted:!cleanupError,...(cleanupError?{error:cleanupError}:{})}};
  (window as unknown as {__zoridTwoTabAdmissionResult:unknown}).__zoridTwoTabAdmissionResult=final;log(final);
}
async function runOwner() {
  clientId=crypto.randomUUID();otherClientId=crypto.randomUUID();
  ({runtime:ownerRuntime,context:owner}=await open(clientId));
  await create('shared.md','original');await create('recovery.md','before replay');
  inert=(await prepare(owner,'recovery.md','never authorized')).intent;
  marker=(await prepare(owner,'recovery.md','authorized after tab close')).intent;
  checkpointState=JSON.stringify({marker:marker.ref,inert:inert.ref});
  await checkpoint(owner,'tab-close-recovery',JSON.parse(checkpointState));await authorizeMarker();
  started=true;
  const url=new URL(location.href);url.search=new URLSearchParams({role:'peer',run:runId}).toString();
  peerLink.href=url.href;peerLink.textContent=url.href;peerLink.hidden=false;
  log({phase:'owner-ready',source:__ADMISSION_SOURCE__,runId,database,authority,peerUrl:url.href,instruction:'Open the peer URL in a second Chrome tab; keep this owner tab open until instructed.'});
}
async function runPeer() {
  const config=await rpc('hello');
  same(config.database,database,'Cross-run database mismatch');same(config.source,__ADMISSION_SOURCE__,'Fixture builds differ');same(config.manifest,manifest,'WASM builds differ');
  assert(uuid.test(config.clientId)&&uuid.test(config.otherClientId)&&config.clientId!==config.otherClientId,'Invalid client pair');
  authority=config.authority;clientId=config.clientId;otherClientId=config.otherClientId;
  try { const duplicate=await open(clientId);duplicate.runtime.close();throw new Error('Duplicate client admitted'); }
  catch(error){same((error as {code?:string}).code,'client_already_owned','Duplicate rejection mismatch');}
  const unchanged=await rpc('inspect');
  same(unchanged.read.content,'before replay','Rejected duplicate replayed mutation');same(unchanged.marker.state,'commit_requested','Duplicate changed authorization');same(unchanged.inert.state,'prepared','Duplicate executed inert intent');
  pass('Separate-tab duplicate client rejected before startup replay');

  let {runtime,context}=await open(otherClientId);
  same(await context.durableWrites.checkpoints.load('tab-close-recovery'),null,'Cross-client checkpoint leak');
  const ownerPrepared=await rpc('prepare-race');
  const peerPrepared=await prepare(context,'shared.md','peer wins');
  same(peerPrepared.observation,ownerPrepared.observation,'Race did not use the same coherent base');
  const outcomes:DurableWriteIntent[]=await Promise.all([rpc('commit-race'),settle(context,peerPrepared.intent)]);
  const winners=outcomes.filter(item=>item.state==='committed'),losers=outcomes.filter(item=>item.state==='rejected');
  assert(winners.length===1&&losers.length===1,'Concurrent CAS requires exactly one commit and one durable rejection');
  assert(losers[0].state==='rejected'&&losers[0].error.code==='revision_conflict','Stale writer did not report revision conflict');
  const read=await context.durableWrites.readText('shared.md');
  same(await rpc('read'),read,'Tabs did not reload the same committed observation');
  assert(winners[0].state==='committed'&&read.revision===winners[0].receipt.revision,'Read is not winning revision');
  same(read.content,outcomes[0].state==='committed'?'owner wins':'peer wins','Winner content mismatch');
  pass('Distinct tabs serialize same-revision edits: one commit, one durable conflict, coherent reload');

  await release(runtime,context);
  ({runtime,context}=await open(otherClientId));
  same(await context.durableWrites.readText('shared.md'),read,'Fresh worker did not reload winning observation');
  const next=await prepare(context,'shared.md',`${read.content}\nthen peer rebased explicitly`);
  const nextOutcome=await settle(context,next.intent);assert(nextOutcome.state==='committed','Fresh-base follow-up did not commit');
  const nextRead=await context.durableWrites.readText('shared.md');same(await rpc('read'),nextRead,'Owner did not observe follow-up');
  assert(nextRead.revision===nextOutcome.receipt.revision&&nextRead.revision!==read.revision,'Follow-up revision not advanced');
  await release(runtime,context);
  pass('Distinct client release/reopen reloads persisted winner; explicit fresh-base edit is observed by both tabs');

  const ownerLock=`zorid:consumer:v1:${authority}:${clientId}`;
  assert((await navigator.locks.query()).held?.some(lock=>lock.name===ownerLock),'Owner lost lease before tab-close phase');
  log({phase:'close-owner-tab',instruction:'Close the FIRST owner Chrome tab using the browser tab close control. Do not reload/navigate it or call runtime.close. Then click Verify owner tab closed here.'});
  confirmClosed.hidden=false;confirmClosed.disabled=false;
  await deadline(new Promise<void>(resolve=>{confirmClosed.onclick=()=>{confirmClosed.disabled=true;resolve();};}),'Operator closes owner tab',120000);
  await locksGone();
  ({runtime,context}=await open(clientId));
  same((await context.durableWrites.checkpoints.load('tab-close-recovery'))?.encodedState,config.checkpointState,'Owner checkpoint lost');
  const recovered=await context.durableWrites.query(config.marker.ref),inertResult=await context.durableWrites.query(config.inert.ref);
  assert(recovered?.state==='committed','Owner authorized operation did not replay');same(inertResult?.state,'prepared','Owner inert operation executed');
  same((await context.durableWrites.readText('recovery.md')).content,'authorized after tab close','Owner content not recovered');
  same(await context.durableWrites.readText('shared.md'),nextRead,'Tab-close recovery changed unrelated committed edit');
  await checkpoint(context,'recovered-outcome',{ref:recovered.ref,receipt:recovered.receipt});
  await context.durableWrites.acknowledge(recovered.ref,{status:'committed',operationId:recovered.ref.operationId,sequence:recovered.receipt.sequence});
  await release(runtime,context);
  pass('Actual owner tab close releases lifetime lease; same client reacquires and replays only authorized work');
  await finish({ok:true,outcomes:outcomes.map(item=>item.state),winner:read,finalRead:nextRead,ownerTabCloseConfirmed:true});
}
start.textContent=peer?'Run second-tab checks':'Initialize owner tab';
start.onclick=async()=>{
  start.disabled=true;touch();output.textContent=peer?'Second tab connecting…':'Initializing owner…';
  try {
    assert(!!navigator.locks&&!!window.BroadcastChannel,'Web Locks and BroadcastChannel required');
    manifest=await fetch(new URL('lib/core/manifest.json',location.href)).then(response=>{assert(response.ok,'Missing WASM manifest');return response.json();});
    same((manifest as {buildId:string}).buildId,__ADMISSION_WASM_SOURCE__,'WASM manifest mismatch');
    if(peer)await runPeer();else await runOwner();
  } catch(error){await finish({ok:false,error:String(error)});}
};
