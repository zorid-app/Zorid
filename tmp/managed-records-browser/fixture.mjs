import {openAuthority} from './opener.mjs';

const output = document.querySelector('#result');
const enc = value => new TextEncoder().encode(value);
const dec = value => new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(value);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
function normalize(value) {
  if (value instanceof Uint8Array) return {$bytes:Array.from(value)};
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
const exact = (a,b,message) => assert(JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)), message);
const reject = async action => {
  try { await action(); } catch (error) { return {name:error.name, code:error.code, message:String(error.message ?? error)}; }
  throw new Error('Expected rejection');
};
const scope = {realm_id:'fixture-realm', vault_id:'fixture-vault'};
const names = new Set(), handles = new Set();
const prefix = 'zorid-core-vault:managed-browser-';
const report = {status:'running', started:new Date().toISOString(), userAgent:navigator.userAgent,
  groups:[], transactions:[], remainingGates:['Full retry 16-count/1MiB continuation boundaries',
    'Conflicting waiting forks and cross-tab lease loss/reacquisition', 'Signed-i64 sequence ceiling',
    'Worker lifecycle/product/native/mobile integration are outside this fixture']};
window.managedRecordsEvidence = report;
const publish = () => { output.textContent = JSON.stringify(report, null, 2); };
const identity = policy => ({realm:scope.realm_id, vault:scope.vault_id, owner:'synthetic-fixture',
  schema:{collection:policy.toLowerCase(), version:1, policy, fields:{
    max:{kind:'Integer',required:false,nullable:false,default:null},
    min:{kind:'Integer',required:false,nullable:false,default:null},
    title:{kind:'String',required:false,nullable:true,default:null}}}});
const recordScope = (policy='Synced', record='record', generation='extrema') => ({
  realm:scope.realm_id,vault:scope.vault_id,owner:'synthetic-fixture',collection:policy.toLowerCase(),record,generation,restores:null});
const collectionKey = r => ({realmId:r.realm,vaultId:r.vault,owner:r.owner,collection:r.schema.collection});
const command = (kind,title) => enc(JSON.stringify({command:kind,actions:[{action:'Write',field:'title',cell:{state:'Value',value:{type:'String',value:title}}}]}));
// Decimal literals are authored directly as UTF-8. Never round-trip an i64 through a JS Number.
const extrema = enc('{"command":"Create","actions":[{"action":"Write","field":"max","cell":{"state":"Value","value":{"type":"Integer","value":9223372036854775807}}},{"action":"Write","field":"min","cell":{"state":"Value","value":{"type":"Integer","value":-9223372036854775808}}}]}');
const revision = snapshot => {
  const meta = JSON.parse(snapshot.metadata); // Bounded digest metadata only; state/projection stay raw bytes.
  assert(Array.isArray(meta.revision) && meta.revision.length === 32, 'Missing Rust snapshot digest');
  return new Uint8Array(meta.revision);
};
const textCreate = () => ({family:'files',format_version:2,scope,id:'file-create',body:{kind:'events',events:[{
  id:'file-create',identity:{entry_id:'note',bootstrap_id:'file-create'},parents:[],effect:{kind:'create',entry_kind:'file',
    location:{parent:null,name:'fixture.md'},content:{kind:'text',text_bootstrap_id:'text-root',text_format:2}}}]}});
function recordPayload(id, rs, operations) {
  // Exact serde field order, not an admission decision. The real Rust opener validates these bytes.
  return enc(`{"family":"records","format_version":1,"id":${JSON.stringify(id)},"scope":${JSON.stringify(rs)},"operations":[${operations.join(',')}]}`);
}
function operation(id, rs, parents, cmd, version=1) {
  return `{"id":${JSON.stringify(id)},"parents":${JSON.stringify(parents)},"scope":${JSON.stringify(rs)},"schema_version":${version},"command":${dec(cmd)}}`;
}
async function raw(name) {
  assert(names.has(name) && name.startsWith(prefix), 'Raw access outside this run');
  return new Promise((resolve,reject) => {
    const r=indexedDB.open(name);
    r.onupgradeneeded=()=>{r.transaction.abort();reject(new Error('Unexpected missing fixture database'));};
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Raw open blocked'));
  });
}
async function dump(name) {
  const db=await raw(name);
  try { return await new Promise((resolve,reject) => {
    const stores=Array.from(db.objectStoreNames),tx=db.transaction(stores,'readonly'),result={};
    for(const name of stores){const rows=[],r=tx.objectStore(name).openCursor();result[name]=rows;
      r.onsuccess=()=>{const c=r.result;if(c){rows.push({key:normalize(c.primaryKey),value:normalize(c.value)});c.continue();}};}
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error??new Error('Dump aborted'));
  }); } finally { db.close(); }
}
async function remove(name) {
  assert(names.has(name)&&name.startsWith(prefix),'Deletion outside run');
  await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Fixture connection leak'));});
}
// Observe real Chrome transactions and inject a real abort after a managed state put succeeds.
// Neither wrapper produces a result or substitutes a storage transaction.
const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
let abortNextManagedPut = null;
IDBDatabase.prototype.transaction = function(stores, mode, options) {
  const tx=transaction.call(this,stores,mode,options);
  if(names.has(this.name)&&mode==='readwrite'){
    assert(options?.durability==='strict'&&tx.durability==='strict','Non-strict readwrite transaction');
    const row={database:this.name,stores:Array.from(tx.objectStoreNames),durability:tx.durability,outcome:'active'};
    report.transactions.push(row);tx.addEventListener('complete',()=>{row.outcome='complete';});tx.addEventListener('abort',()=>{row.outcome='abort';});
  }
  return tx;
};
IDBObjectStore.prototype.put = function(...args) {
  const request=put.apply(this,args);
  if(this.name==='managed_records'&&this.transaction.db.name===abortNextManagedPut){
    abortNextManagedPut=null;const tx=this.transaction;request.addEventListener('success',()=>tx.abort(),{once:true});
  }
  return request;
};
async function group(name, action) {
  report.active=name;publish();const started=performance.now();
  const evidence=await action();report.groups.push({name,status:'passed',ms:Math.round(performance.now()-started),evidence});publish();
}
let wasm,key;
async function open(name, clientId=crypto.randomUUID()) {
  const result=await openAuthority({name,wasm,clientId,assertActive(){}});handles.add(result);
  return {...result,name,clientId};
}
function close(handle) { handle.vault.close();for(const h of handles)if(h.vault===handle.vault)handles.delete(h); }
async function fresh(label) {
  const name=prefix+label+'-'+crypto.randomUUID();names.add(name);
  const h=await open(name);await h.vault.sync.enroll({...scope,key_epoch:1});return h;
}
async function register(h, policy='Synced') {
  const reg=identity(policy);return h.records.register(collectionKey(reg),enc(JSON.stringify(reg)));
}
async function snap(h, token, rs) {return h.records.snapshot(token,rs);}
async function apply(h, token, rs, id, cmd, expected) {
  return h.records.apply(token,{scope:rs,operation:id,command:cmd,expectedRevision:expected??revision(await snap(h,token,rs))});
}
function seal(id, bytes, envelopeScope=scope) {
  return key.seal(JSON.stringify({envelope_version:1,purpose:'vault_update',suite:'xchacha20poly1305',...envelopeScope,
    update_id:id,key_epoch:1,origin_device_id:'fixture-device',document_format_version:1,required_features:[],optional_extensions:{}}),bytes);
}
async function status(h,id) {
  const rows=(await dump(h.name)).managed_receipts;
  assert(rows,'No actual managed receipt store');return rows.find(row=>row.value.updateId===id)?.value.status;
}
async function main() {
  report.provenance=await fetch('/__managed_fixture_provenance').then(r=>{assert(r.ok,'Runner provenance required');return r.json();});
  const moduleUrl='/target/browser-wasm/generated/zorid_wasm.js';wasm=await import(/* @vite-ignore */ moduleUrl);await wasm.default();
  for(const name of ['prepareRecordsLocal','recordsSnapshot','validateRecordsRegistration','canonicalRecordsLocalRequest','finalizeRecordsLocalResult'])
    assert(typeof wasm[name]==='function',`SOURCE_GATE missing rebuilt WASM export ${name}`);
  key=new wasm.WasmVaultKey(new Uint8Array(32).fill(37));
  const a=await fresh('author'),b=await fresh('receiver'),rs=recordScope();let ta=await register(a),tb=await register(b);
  await group('local i64 extrema survive exact raw state/projection and reopen',async()=>{
    const result=await apply(a,ta,rs,'extrema',extrema);assert(result.localDurable&&!result.replay,'No durable local result');
    const before=await snap(a,ta,rs);
    for(const bytes of [before.state,before.projection]){
      const text=dec(bytes);assert(text.includes('9223372036854775807')&&text.includes('-9223372036854775808'),'Rounded i64 in durable bytes');
    }
    close(a);Object.assign(a,await open(a.name,a.clientId));ta=await register(a);
    const after=await snap(a,ta,rs);exact(after,before,'Raw snapshot changed on reopen');
    return {stateBytes:before.state.length,projectionBytes:before.projection.length,rawState:dec(before.state),rawProjection:dec(before.projection)};
  });
  await group('lost local response replays original raw result after later mutation and reopen',async()=>{
    const originalExpected=revision(await snap(a,ta,rs)),cmd=command('Patch','lost-response');
    const original=await apply(a,ta,rs,'lost-response',cmd,originalExpected); // Discarded by the simulated caller after commit.
    await apply(a,ta,rs,'later-edit',command('Patch','later'));
    close(a);Object.assign(a,await open(a.name,a.clientId));ta=await register(a);
    const before=await dump(a.name),retry=await apply(a,ta,rs,'lost-response',cmd,originalExpected);
    assert(retry.replay&&retry.localDurable,'Exact request was not replayed');exact(retry.result,original.result,'Replayed result changed');
    exact(await dump(a.name),before,'Replay wrote state/changes/outbox');return {originalResult:dec(original.result),replayedResult:dec(retry.result)};
  });
  await group('Local and Cache commit and replay without any sync outbox',async()=>{
    const evidence=[];
    for(const policy of ['Local','Cache']){
      const h=await fresh(policy),token=await register(h,policy),s=recordScope(policy),expected=revision(await snap(h,token,s));
      const first=await apply(h,token,s,'extrema',extrema,expected),before=await dump(h.name);
      const retry=await apply(h,token,s,'extrema',extrema,expected);exact(retry.result,first.result,'Local/cache replay result');
      assert(retry.replay,'Local/cache replay missing');exact(await dump(h.name),before,'Local/cache replay writes');
      exact(await h.vault.sync.pending(100),[],'Local/cache authored sync intent');
      assert((before.sync_authored??[]).length===0&&(before.sync_source_payloads??[]).length===0,'Local/cache retained sync source');
      evidence.push({policy,result:dec(first.result)});
    }return evidence;
  });
  await group('real encrypted records/file/text share one ordered cursor chain and never echo receives',async()=>{
    await a.vault.sync.authorFile(JSON.stringify(textCreate()));
    const note=await a.vault.readEntryById('note');
    await a.vault.mutate(JSON.stringify({operation_id:'text-write',mutation:{type:'write',id:'note',expected:note.entry.revision,content:Array.from(enc('actual encrypted text 😀'))}}));
    const pending=await a.vault.sync.pending(100),families=new Set(pending.map(row=>row.metadata.family));
    for(const family of ['records','files','text'])assert(families.has(family),`Missing ${family} from real authored stream`);
    let cursor={...scope,server_epoch:'fixture-epoch',after:'0'};await b.vault.sync.setCursor(cursor,null);
    const evidence=[];
    for(const row of pending){const id=row.metadata.key.update_id,wire=await a.vault.sync.seal(id,key),next={...cursor,after:String(BigInt(cursor.after)+1n)};
      await b.vault.sync.receive(id,wire,key,{expected:cursor,next});cursor=next;
      exact((await b.vault.sync.inspect()).cursor,cursor,'Mixed cursor failed');await a.vault.sync.acknowledge(id,wire);
      evidence.push({id,family:row.metadata.family,wireBytes:wire.length,after:cursor.after});
    }
    exact(await b.vault.sync.pending(100),[],'Received updates echoed');
    exact((await snap(b,tb,rs)).state,(await snap(a,ta,rs)).state,'Records diverged');
    exact(dec((await b.vault.readEntryById('note')).bytes),'actual encrypted text 😀','Encrypted text bytes');
    close(b);Object.assign(b,await open(b.name,b.clientId));tb=await register(b);
    exact((await b.vault.sync.inspect()).cursor,cursor,'Reopen lost mixed cursor');return evidence;
  });
  await group('tamper, wrong scope, unknown format and cursor gap leave every store unchanged',async()=>{
    const pendingScope=recordScope('Synced','rejected','rejected-create');
    const plain=recordPayload('rejected-create',pendingScope,[operation('rejected-create',pendingScope,[],command('Create','reject'))]);
    const cursor=(await b.vault.sync.inspect()).cursor,next={...cursor,after:String(BigInt(cursor.after)+1n)},good=seal('rejected-create',plain);
    const bad=good.slice();bad[bad.length-1]^=1;
    const cases=[['tamper',bad],['wrong-scope',seal('rejected-create',plain,{...scope,vault_id:'wrong-vault'})],
      ['unknown-format',seal('rejected-create',enc(dec(plain).replace('"format_version":1','"format_version":99')))]];
    const errors=[];
    for(const [name,wire] of cases){const before=await dump(b.name),error=await reject(()=>b.vault.sync.receive('rejected-create',wire,key,{expected:cursor,next}));
      exact(await dump(b.name),before,`${name} progressed durable stores`);errors.push({name,...error});}
    const before=await dump(b.name);errors.push({name:'cursor-gap',...await reject(()=>b.vault.sync.receive('rejected-create',good,key,{expected:cursor,next:{...next,after:String(BigInt(cursor.after)+2n)}}))});
    exact(await dump(b.name),before,'Cursor gap progressed durable stores');return errors;
  });
  await group('pending child and invalid child persist then bounded parent recovery retries through AEAD',async()=>{
    const s=recordScope('Synced','dependencies','parent'),parent=operation('parent',s,[],command('Create','parent'));
    const child=operation('child',s,['parent'],command('Patch','child'));
    const invalid=operation('invalid-child',s,['parent'],enc('{"command":"Patch","actions":[{"action":"Write","field":"title","cell":{"state":"Value","value":{"type":"Integer","value":1}}}]}'));
    await b.vault.sync.receive('child',seal('child',recordPayload('child',s,[child])),key);
    assert(await status(b,'child')==='waiting_dependencies','Child was not retained waiting');
    await b.vault.sync.receive('invalid-child',seal('invalid-child',recordPayload('invalid-child',s,[invalid])),key);
    const invalidBefore=await status(b,'invalid-child');
    close(b);Object.assign(b,await open(b.name,b.clientId));tb=await register(b);
    await b.vault.sync.receive('parent',seal('parent',recordPayload('parent',s,[parent])),key);
    const retries=[];for(let i=0;i<4&&(await status(b,'child'))!=='accepted';i++)retries.push(await b.records.retryPage(tb));
    assert(await status(b,'child')==='accepted','Parent/retry failed to recover retained child');
    assert(await status(b,'invalid-child')==='invalid_operation','Invalid child was accepted or retry stuck');
    const final=await snap(b,tb,s);assert(dec(final.projection).includes('child'),'Child missing from projection');
    return {invalidBefore,parent:await status(b,'parent'),child:await status(b,'child'),invalid:await status(b,'invalid-child'),retries};
  });
  await group('real strict transaction abort after state put rolls back all stores and survives reopen',async()=>{
    const before=await dump(a.name);abortNextManagedPut=a.name;
    const error=await reject(()=>apply(a,ta,rs,'aborted',command('Patch','must rollback')));
    assert(abortNextManagedPut===null,'Fault never reached actual managed state put');exact(await dump(a.name),before,'Abort left partial writes');
    close(a);Object.assign(a,await open(a.name,a.clientId));ta=await register(a);
    // Re-registration is canonical equality and must be inert.
    exact(await dump(a.name),before,'Reopen lost rollback evidence');
    const committed=await apply(a,ta,rs,'aborted',command('Patch','must rollback'));assert(!committed.replay,'Aborted operation left replay row');
    return {error,abortTransactions:report.transactions.filter(tx=>tx.outcome==='abort').length,result:dec(committed.result)};
  });
  assert(report.transactions.some(tx=>tx.outcome==='complete'),'No real strict completion observed');
  assert(report.transactions.some(tx=>tx.outcome==='abort'),'No real strict abort observed');
  report.status='passed-subset';
}
try {await main();} catch(error){report.status='failed';report.error={name:error.name,message:String(error.message??error),stack:error.stack};}
finally {
  for(const h of handles){try{h.vault.close();}catch{}}
  key?.free();IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.put=put;
  report.cleanup=[];
  for(const name of names){try{await remove(name);report.cleanup.push({name,status:'deleted'});}catch(error){report.cleanup.push({name,status:'failed',error:String(error)});report.status='failed';}}
  report.finished=new Date().toISOString();delete report.active;publish();
  window.managedRecordsEvidence=report;window.managedRecordsComplete=true;
}
