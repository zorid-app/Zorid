import { BrowserCoreRuntime } from '../../src/platform/browser-core-runtime.ts';
import { admitBrowserFixtureClient } from '../../src/platform/browser-client-admission.ts';
import type { BrowserClientContext } from '../../src/platform/browser-client-admission.ts';
import type { BrowserVaultIntent } from '../../src/core/browser-vault.ts';

declare const __ADMISSION_SOURCE__: string;
declare const __ADMISSION_WASM_SOURCE__: string;
const prefix = 'zorid-core-vault:admission-fixture-';
const checks: string[] = [];
const runtimes = new Set<BrowserCoreRuntime>(), databases = new Set<string>(), authorities = new Set<string>();
const output = document.querySelector<HTMLPreElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const wasmModuleUrl = new URL('lib/core/zorid_wasm.js', location.href).href;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function same(actual: unknown, expected: unknown, message: string) { assert(JSON.stringify(actual) === JSON.stringify(expected), message); }
function log(value: unknown) { output.textContent += `\n${JSON.stringify(value)}`; }
function pass(name: string) { checks.push(name); log({passed:checks.length,check:name}); }
function errorCode(error: unknown) { return (error as {code?:string})?.code; }
async function rejects(action: () => Promise<unknown>, code: string) {
  try { await action(); } catch (error) { same(errorCode(error),code,'Unexpected error code'); return; }
  throw new Error(`Expected rejection: ${code}`);
}
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
async function deadline<T>(operation: Promise<T>, label: string, ms=10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]); }
  finally { clearTimeout(timer!); }
}
async function unlocked(authority: string, client: string) {
  const name=`zorid:consumer:v1:${authority}:${client}`, until=Date.now()+5000;
  while ((await navigator.locks.query()).held?.some(lock=>lock.name===name)) {
    assert(Date.now()<until,'Terminated/released worker retained client lock');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}
async function open(database:string,clientId:string) {
  const runtime=await BrowserCoreRuntime.open({database,clientId,wasmModuleUrl,allowNewVault:true,timeoutMs:10000});
  runtimes.add(runtime); authorities.add(runtime.durableScope!.vaultId); return runtime;
}
function admit(runtime:BrowserCoreRuntime) { return admitBrowserFixtureClient(runtime,{fixture:true,assertOwner:()=>runtime.assertActive()}); }
function close(runtime:BrowserCoreRuntime) { runtime.close(); runtimes.delete(runtime); }
async function release(runtime:BrowserCoreRuntime,context:BrowserClientContext) {
  await context.release(async gate=>{gate.assertActive();}); runtimes.delete(runtime);
  await unlocked(context.scope.vaultId,context.scope.clientId);
}
async function raw(database:string):Promise<IDBDatabase> {
  assert(databases.has(database)&&database.startsWith(prefix),'Raw access requires this run’s synthetic database');
  return new Promise((resolve,reject)=>{
    let settled=false;
    const request=indexedDB.open(database);
    const timer=setTimeout(()=>finish(new Error('Open fixture database timed out')),10000);
    const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(request.result);};
    request.onerror=()=>finish(request.error??new Error('Fixture open failed'));
    request.onblocked=()=>finish(new Error('Fixture database open blocked'));
    request.onupgradeneeded=()=>{request.transaction!.abort();finish(new Error('Fixture database unexpectedly missing'));};
    request.onsuccess=()=>{if(settled)request.result.close();else finish();};
  });
}
/** Simulate crash after the durable authorization marker, before application.
 * Only this run's exact prepared row changes phase; request bytes stay untouched. */
async function markCommitRequested(database:string,clientId:string,intentId:string,operationId:string) {
  const db=await raw(database);
  try { await deadline(new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['intents'],'readwrite',{durability:'strict'}), store=tx.objectStore('intents');
    assert(tx.durability==='strict','Strict fixture mutation unavailable');
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Fixture marker aborted'));tx.onerror=()=>{};
    const request=store.get([clientId,intentId]);request.onsuccess=()=>{
      const row=request.result as BrowserVaultIntent;
      if(!row||row.status!=='prepared'||row.operation_id!==operationId){tx.abort();return;}
      store.put({...row,status:'commit_requested'});
    };
  }),'Persist commit-requested marker'); } finally { db.close(); }
}
async function holdTransactions(database:string) {
  const db=await raw(database), started=deferred<void>();let keep=true;
  let tx:IDBTransaction;
  try { tx=db.transaction(Array.from(db.objectStoreNames),'readwrite',{durability:'strict'}); }
  catch(error){db.close();throw error;}
  const finished=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Blocking fixture transaction aborted'));tx.onerror=()=>{};});
  void finished.catch(()=>{}); // Keep early abort observed until cleanup awaits it.
  // A real same-database IDB transaction stalls the real worker, not a mock RPC.
  const pump=()=>{const request=tx.objectStore('control').get('local-store-id');request.onsuccess=()=>{started.resolve();if(keep)pump();};};
  try { pump();await deadline(Promise.race([started.promise,finished.then(()=>{throw new Error('Blocking transaction ended before acquisition');})]),'Acquire blocking transaction'); }
  catch(error){keep=false;try{tx.abort();}catch{}db.close();throw error;}
  return async()=>{keep=false;try{await deadline(finished,'Release blocking transaction');}finally{try{tx.abort();}catch{}db.close();}};
}
function trace(runtime:BrowserCoreRuntime) {
  // Test-only observation of the real runtime transport; never substitutes a worker.
  const worker=(runtime as unknown as {worker:Worker}).worker;
  const original=worker.postMessage.bind(worker), calls:string[]=[];
  worker.postMessage=((message:{operation:string})=>{calls.push(message.operation);original(message);}) as typeof worker.postMessage;
  return calls;
}
async function deleteFixture(database:string) {
  assert(databases.has(database)&&database.startsWith(prefix),'Deletion requires this run’s synthetic database');
  await deadline(new Promise<void>((resolve,reject)=>{
    const request=indexedDB.deleteDatabase(database);
    request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Fixture deletion blocked by leaked connection'));
  }),'Delete fixture database');
}
async function run() {
  assert(!!navigator.locks&&typeof navigator.locks.query==='function','Web Locks unavailable');
  const manifest=await fetch(new URL('lib/core/manifest.json',location.href)).then(response=>{assert(response.ok,'Missing WASM manifest');return response.json();});
  assert(manifest.buildId===__ADMISSION_WASM_SOURCE__,'Declared WASM source/manifest mismatch');
  const database=prefix+crypto.randomUUID(),client=crypto.randomUUID(),otherClient=crypto.randomUUID();databases.add(database);
  let runtime=await open(database,client), context=admit(runtime);
  const authority=context.scope.vaultId, entryId=crypto.randomUUID(),createId=crypto.randomUUID();
  const initial='original note';
  const receipt=await runtime.execute(createId,JSON.stringify({operation_id:createId,mutation:{type:'create',id:entryId,path:'note.md',kind:'file',content:Array.from(new TextEncoder().encode(initial))}}));
  await runtime.acknowledge(createId,{status:'committed',receipt});
  const observed=await context.durableWrites.readText('note.md');
  const planInput={path:'note.md',expectedEntryId:observed.entryId,expectedRevision:observed.revision,expectedContent:observed.content};
  const inert=await context.durableWrites.prepare(await context.durableWrites.planWrite({...planInput,operationId:crypto.randomUUID(),content:'must stay inert'}));
  const authorized=await context.durableWrites.prepare(await context.durableWrites.planWrite({...planInput,operationId:crypto.randomUUID(),content:'authorized recovery'}));
  const checkpoint={key:`note/v1/${entryId}`,expectedRevision:null,nextRevision:crypto.randomUUID(),encodedState:JSON.stringify({inert:inert.ref,authorized:authorized.ref})};
  await context.durableWrites.checkpoints.compareAndSwap(checkpoint);
  await markCommitRequested(database,client,authorized.ref.token,authorized.ref.operationId);
  await rejects(()=>open(database,client),'client_already_owned');
  same((await context.durableWrites.readText('note.md')).content,initial,'Rejected duplicate replayed an authorized operation');
  same((await context.durableWrites.query(authorized.ref))?.state,'commit_requested','Duplicate changed the stored authorization phase');
  same((await context.durableWrites.query(inert.ref))?.state,'prepared','Duplicate executed inert preparation');
  pass('Duplicate client is rejected before startup replay; prepared and authorized records stay unchanged');

  const other=await open(database,otherClient),otherContext=admit(other);
  same(otherContext.scope.vaultId,authority,'Distinct client changed local authority');
  same(await otherContext.durableWrites.checkpoints.load(checkpoint.key),null,'Distinct client accessed another consumer checkpoint');
  same((await otherContext.durableWrites.readText('note.md')).content,initial,'Distinct client cannot read shared vault');
  await release(other,otherContext);
  pass('Distinct client owns a concurrent lease and shares notes while checkpoint namespaces remain separate');

  await release(runtime,context);
  runtime=await open(database,client);context=admit(runtime);
  same(context.scope.vaultId,authority,'Release/reopen changed authority');
  same((await context.durableWrites.checkpoints.load(checkpoint.key))?.encodedState,checkpoint.encodedState,'Checkpoint did not survive reacquisition');
  same((await context.durableWrites.readText('note.md')).content,'authorized recovery','Authorized startup replay failed');
  const committed=await context.durableWrites.query(authorized.ref);assert(committed?.state==='committed','Recovery has no durable receipt');
  same((await context.durableWrites.query(inert.ref))?.state,'prepared','Recovery executed merely prepared intent');
  await context.durableWrites.acknowledge(authorized.ref,{status:'committed',operationId:authorized.ref.operationId,sequence:committed.receipt.sequence});
  pass('Ordered release permits exact-client reacquisition and replays only authorized intent with durable checkpoint retained');

  close(runtime);await unlocked(authority,client);
  runtime=await open(database,client);context=admit(runtime);
  same((await context.durableWrites.checkpoints.load(checkpoint.key))?.encodedState,checkpoint.encodedState,'Abrupt worker termination lost checkpoint');
  same((await context.durableWrites.query(inert.ref))?.state,'prepared','Worker restart authorized inert preparation');
  same((await context.durableWrites.readText('note.md')).content,'authorized recovery','Worker restart lost committed note');
  pass('Abrupt runtime worker termination releases lease; exact client restarts with durable checkpoint and inert preparation');

  // Isolate this fault trace from optional visibility refresh hints, then drain any already queued hint.
  const timing=runtime as unknown as {visibility:()=>void;timeoutMs:number};
  document.removeEventListener('visibilitychange',timing.visibility);
  await runtime.inventory();
  const calls=trace(runtime),stop=await holdTransactions(database);
  // Short deadline only after real worker/WASM initialization, avoiding cold-start timing assumptions.
  timing.timeoutMs=250;
  const timingOut=rejects(()=>runtime.inventory(),'outcome_unknown');
  const absentKey=`timeout/${crypto.randomUUID()}`;
  const queued=rejects(()=>context.durableWrites.checkpoints.compareAndSwap({key:absentKey,expectedRevision:null,nextRevision:crypto.randomUUID(),encodedState:'must never send'}),'storage_closed');
  try { await deadline(Promise.all([timingOut,queued]),'Timed-out worker and queued request',5000); }
  finally { await stop();close(runtime); }
  same(calls,['inventory'],'A queued mutation was sent after timeout');await unlocked(authority,client);
  runtime=await open(database,client);context=admit(runtime);
  same(await context.durableWrites.checkpoints.load(absentKey),null,'Queued timeout mutation changed durable state');
  same((await context.durableWrites.readText('note.md')).content,'authorized recovery','Timeout changed existing content');
  await release(runtime,context);
  pass('Real IDB stall times out worker, leaves queued checkpoint unsent, and exact-client restart confirms no write');
  return {source:__ADMISSION_SOURCE__,manifest,browser:navigator.userAgent,database,client,otherClient,authority,timeoutPosted:calls,checks:[...checks],passed:checks.length};
}
button.onclick=async()=>{
  button.disabled=true;checks.length=0;output.textContent=`Browser: ${navigator.userAgent}`;
  let result:Record<string,unknown>,cleanupError:string|undefined;
  try {result={ok:true,...await run()};}
  catch(error){result={ok:false,source:__ADMISSION_SOURCE__,checks:[...checks],passed:checks.length,databases:[...databases],error:String(error),code:errorCode(error)};}
  finally {
    for(const runtime of runtimes)runtime.close();runtimes.clear();
    try {
      const until=Date.now()+5000;
      while((await navigator.locks.query()).held?.some(lock=>[...authorities].some(id=>lock.name?.startsWith(`zorid:consumer:v1:${id}:`)))){
        assert(Date.now()<until,'Cleanup found retained fixture client locks');await new Promise(resolve=>setTimeout(resolve,20));
      }
      for(const name of databases)await deleteFixture(name);
    } catch(error){cleanupError=String(error);}
    databases.clear();authorities.clear();button.disabled=false;
  }
  result!.cleanup={workersClosed:runtimes.size===0,databasesDeleted:!cleanupError,...(cleanupError?{error:cleanupError}:{})};
  if(cleanupError)result!.ok=false;
  (window as unknown as {__zoridBrowserAdmissionResult:unknown}).__zoridBrowserAdmissionResult=result!;
  log(result!);
};
