import { BrowserVaultError } from './browser-vault.ts';
import type { EntryState, BrowserVaultPresentation } from './browser-vault.ts';

/** Trusted host plumbing only. Causal/path/content rules are owned by Rust v2. */
type Json = any;
export interface SyncPlan { resultJson():string; checkPreconditions(actual:string):void; free():void }
export interface AuthoredSyncPlan extends SyncPlan { metadataJson():string }
export interface OpenedSyncUpdate {
  metadataJson():string; exactWire():Uint8Array; matchesPayload(bytes:Uint8Array):boolean;
  planText(input:string):SyncPlan; planFile(input:string):SyncPlan; free():void;
}
export interface BrowserSyncKey { openSyncUpdate(context:string,wire:Uint8Array):OpenedSyncUpdate; seal(header:string,bytes:Uint8Array):Uint8Array }
export interface BrowserSyncWasm {
  createEmptyFileState(input:string):string; inspectFileState(input:string):string;
  createEmptyTextState(input:string):string; materializeTextState(input:string):Uint8Array;
  materializeFile(state:string,manifest:string):string;
  materializeRetainedFile(state:string,identity:string,eventId:string):string;
  verifyRetainedFileContent(state:string,identity:string,eventId:string,content:string):void;
  classifyFileMaterializations(state:string,texts:string):string;
  recoveryFileContent(state:string,texts:string,entryId:string):string;
  validateFamilyCommand(input:string):string;
  checkFamilyCommandReplay(original:string,candidate:string):void;
  familyMutationRequirements(input:string):string;
  planFamilyMutation(input:string):AuthoredSyncPlan;
  rebindTextState(state:string,expectedRevision:string,nextRevision:string):string;
  planTextReplace(input:string,bytes:Uint8Array):AuthoredSyncPlan;
  planFileMutation(input:string):AuthoredSyncPlan;
  encodeFilePayload(input:string):Uint8Array;
  validateAuthoredSyncPayload(metadata:string,bytes:Uint8Array):void;
  validateSyncWire(metadata:string,wire:Uint8Array):void;
}
export interface SyncScope { realm_id:string; vault_id:string }
export interface SyncCursor extends SyncScope { server_epoch:string; after:string }
export interface SyncDelivery { expected:SyncCursor; next:SyncCursor }
interface Configuration extends SyncScope { key_epoch:number; replica_id:string; incarnation_id:string }
interface CommonEnvelopeMetadata {
  key:SyncScope & {update_id:string}; payload_digest:number[]; payload_bytes:number;
}
export type EnvelopeMetadata = (CommonEnvelopeMetadata & {
  family:'text'|'files'; format_version:2;
  text_binding:null|{entry_id:string;text_bootstrap_id:string;namespace:{bootstrap_id:string;parents:string[]}};
}) | (CommonEnvelopeMetadata & { family:'records'; format_version:1; text_binding:null });

interface Authored { key:string[]; metadata:EnvelopeMetadata; payload:Uint8Array; sealed:Uint8Array|null; accepted:boolean }
interface Wire { key:string[]; metadata:EnvelopeMetadata; direction:'authored'|'received'; exact_wire:Uint8Array }
export interface Retained { id:string; status:'normal'|'pending'|'recovery'|'tombstone'; fingerprint:string; entry:EntryState|null; bytes:Uint8Array|null; presentation:BrowserVaultPresentation|null; reason:Json; witness:{kind:'text';state:Json}|{kind:'binary';event_id:string}|null }
interface Publication { key:string; row:Retained }
interface Snapshot {
  config:Configuration|null; graph:Json|null; view:Json|null; texts:Map<string,Json>;
  authored:Map<string,Authored>; wires:Map<string,Wire>; cursors:Map<string,SyncCursor>;
  retained:Map<string,Retained>; publications:Map<string,Publication>; revisions:Set<string>; reserved:Set<string>; counts:{authored:number;wires:number;publications:number;revisions:number}; hasLegacyIntents:boolean; published:SyncPublication;
}
export interface BrowserSync {
  /** Trusted normalized host prepares outside the worker edit queue; final IDB CAS serializes commits. */
  readonly concurrentPreparation?:true;
  /** Trusted worker admission; revocation fences new sync transactions, not local editing. */
  bindSession(assertActive:()=>void):BrowserSync;
  /** Explicit empty fixture enrollment. Does not infer identities from paths. */
  enroll(scope:SyncScope & {key_epoch:number}):Promise<void>;
  /** Typed current file-v2 payload; fixture-only local empty-text initialization. */
  authorFile(payloadJson:string):Promise<string>;
  /** Authenticates using independently selected scope/epoch. Transport validates page chain. */
  receive(updateId:string,wire:Uint8Array,key:BrowserSyncKey,delivery?:SyncDelivery):Promise<{duplicate:boolean;sequence:string}>;
  setCursor(next:SyncCursor,expected:SyncCursor|null):Promise<void>;
  pending(limit:number):Promise<{metadata:EnvelopeMetadata;sealed:Uint8Array|null;accepted:boolean}[]>;
  seal(updateId:string,key:BrowserSyncKey):Promise<Uint8Array>;
  acknowledge(updateId:string,exactWire:Uint8Array):Promise<void>;
  inspect():Promise<{scope:(SyncScope & {key_epoch:number})|null;namespace:Json;pending:Json;cursor:SyncCursor|null}>;
  readRetained(id:string):Promise<(Retained & {recovery_content:Json|null})|null>;
}
export type SyncTransaction = <T>(mode:IDBTransactionMode,start:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void)=>void)=>Promise<T>;
export interface SyncPublication { entries:EntryState[]; contents:{id:string;bytes:Uint8Array}[]; presentation:BrowserVaultPresentation[]; sequence:string }
export interface BrowserSyncHost {
  transact:SyncTransaction; wasm:Partial<BrowserSyncWasm>;
  now():number;
  validatePublication(current:SyncPublication):void;
  /** Same transaction callback; never a post-save listener. */
  publish(tx:IDBTransaction,rows:Retained[],origin:{kind:'authored'|'received';update_id:string},forcedRevision:{changes:Json[]}|undefined,current:SyncPublication):{sequence:string};
}
export const browserSyncStores = ['sync_state','sync_text','sync_authored','sync_envelopes','sync_cursors','sync_materializations','sync_publications','sync_revisions'] as const;
export const browserSyncKeyPaths:Record<string,string> = {sync_state:'key',sync_text:'key',sync_authored:'key',sync_envelopes:'key',sync_cursors:'key',sync_materializations:'id',sync_publications:'key',sync_revisions:'revision'};
const fail=(code:string,message:string)=>new BrowserVaultError(code,message);
const json=(value:unknown)=>JSON.stringify(value);
const equal=(a:any,b:any):boolean=>{
  if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)!==Array.isArray(b))return false;const left=Object.keys(a).sort(),right=Object.keys(b).sort();
  return left.length===right.length&&left.every((key,i)=>key===right[i]&&equal(a[key],b[key]));
};
const bytesEqual=(a:Uint8Array,b:Uint8Array)=>a.byteLength===b.byteLength && a.every((v,i)=>v===b[i]);
const keyOf=(value:SyncScope & {update_id:string})=>[value.realm_id,value.vault_id,value.update_id];
const idKey=(identity:Json)=>json([identity.realm_id,identity.vault_id,identity.entry_id,identity.bootstrap_id]);
const scopeKey=(scope:SyncScope)=>[scope.realm_id,scope.vault_id];
const maximum=(1n<<64n)-1n;
const position=(value:unknown):bigint=>{
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>maximum)throw fail('invalid_sync_cursor','Invalid decimal receive cursor');
  return BigInt(value);
};
const bounded=(value:string,cap=32*1024*1024)=>{
  if(typeof value!=='string'||value.length>cap||new TextEncoder().encode(value).byteLength>cap)throw fail('sync_input_too_large','Serialized sync input exceeds host bound');
  return value;
};
const clone=<T>(value:T):T=>structuredClone(value);
const wireCopy=(bytes:Uint8Array):Uint8Array=>{if(!(bytes instanceof Uint8Array)||bytes.byteLength>2*1024*1024)throw fail('sync_input_too_large','Wire exceeds host bound');return bytes.slice();};
function rust<T>(call:()=>T):T {try{return call();}catch(error){throw new BrowserVaultError('sync_plan_rejected','Shared Rust sync planner rejected the operation',{reason:String(error)},'rust');}}
function stored<T>(call:()=>T):T {try{return call();}catch{throw fail('storage_corrupt','Persisted sync state failed shared Rust validation');}}
function requireWasm(value:Partial<BrowserSyncWasm>):BrowserSyncWasm {
  for(const name of ['createEmptyFileState','inspectFileState','createEmptyTextState','materializeTextState','materializeFile','materializeRetainedFile','verifyRetainedFileContent','classifyFileMaterializations','recoveryFileContent','validateFamilyCommand','checkFamilyCommandReplay','familyMutationRequirements','planFamilyMutation','rebindTextState','planTextReplace','planFileMutation','encodeFilePayload','validateAuthoredSyncPayload','validateSyncWire'] as const) {
    if(typeof value[name]!=='function')throw fail('sync_bindings_unavailable','Complete current-format Rust sync bindings are required');
  }
  return value as BrowserSyncWasm;
}
/** IDB requests are chained synchronously; result delivery belongs to host tx.oncomplete. */
export function browserSync(host:BrowserSyncHost,assertActive:()=>void=()=>{}):{api:BrowserSync;localWrite:(tx:IDBTransaction,request:Json,revision:string,changes:Json[],commandJson:string|undefined,done:(managed:boolean)=>void,abort:(error:unknown)=>void)=>void;validate:(tx:IDBTransaction,done:()=>void,abort:(error:unknown)=>void)=>void;admitMutation:(tx:IDBTransaction,request:Json,commandJson:string|undefined,done:(canonicalCommand:string|undefined)=>void,abort:(error:unknown)=>void)=>void} {
  function load(tx:IDBTransaction,done:(snapshot:Snapshot)=>void,abort:(error:unknown)=>void):void {
    const names=[...browserSyncStores,'metadata','content','presentation','control','journal','intents','receipts'],requests=names.map(name=>tx.objectStore(name).getAll());let remaining=requests.length;
    const complete=()=>{if(--remaining)return;let invariant='publication_cache';try{
      const tables=Object.fromEntries(names.map((name,index)=>[name,requests[index].result]));
      const published:SyncPublication={entries:tables.metadata,contents:tables.content,presentation:tables.presentation,sequence:tables.control.find((row:Json)=>row.key==='sequence')?.value};
      host.validatePublication(published);
      const controls=new Map(tables.sync_state.map((row:Json)=>[row.key,row.value]));
      const config=(controls.get('config')??null) as Configuration|null;
      if(!config){if(requests.slice(0,browserSyncStores.length).some(r=>r.result.length))throw fail('storage_corrupt','Sync records exist without enrollment');done({config:null,graph:null,view:null,texts:new Map(),authored:new Map(),wires:new Map(),cursors:new Map(),retained:new Map(),publications:new Map(),revisions:new Set(),reserved:new Set(),counts:{authored:0,wires:0,publications:0,revisions:0},hasLegacyIntents:tables.intents.length>0||tables.receipts.length>0,published});return;}
      invariant='enrollment_graph';
      const wasm=requireWasm(host.wasm),graph=controls.get('graph'),counts=controls.get('counts') as Snapshot['counts'];
      if(!graph||!equal((graph as Json).scope,{realm_id:config.realm_id,vault_id:config.vault_id})||!Number.isInteger(config.key_epoch)||config.key_epoch<1||config.key_epoch>0xffffffff||typeof config.replica_id!=='string'||typeof config.incarnation_id!=='string')throw fail('storage_corrupt','Invalid sync enrollment');
      const view=stored(()=>JSON.parse(wasm.inspectFileState(bounded(json(graph)))));
      if(!counts||counts.authored!==tables.sync_authored.length||counts.wires!==tables.sync_envelopes.length||counts.publications!==tables.sync_publications.length||counts.revisions!==tables.sync_revisions.length)throw fail('storage_corrupt','Sync identity fences are missing');
      invariant='text_states';
      const texts=new Map<string,Json>();
      for(const row of tables.sync_text){stored(()=>wasm.materializeTextState(bounded(json(row.state))));if(row.key!==idKey(row.state.identity)||row.state.identity.realm_id!==config.realm_id||row.state.identity.vault_id!==config.vault_id)throw fail('storage_corrupt','Text state identity mismatch');texts.set(row.key,row.state);}
      invariant='envelope_ledger';
      const authored=new Map<string,Authored>(),wires=new Map<string,Wire>();
      const checkMetadata=(row:Authored|Wire)=>{if(!row?.metadata||row.metadata.family==='records'||!equal(row.key,keyOf(row.metadata.key))||row.metadata.key.realm_id!==config.realm_id||row.metadata.key.vault_id!==config.vault_id)throw fail('storage_corrupt','Envelope scope/key mismatch');};
      for(const row of tables.sync_authored){checkMetadata(row);if(!(row.payload instanceof Uint8Array)||typeof row.accepted!=='boolean'||(row.sealed!==null && !(row.sealed instanceof Uint8Array))||(row.accepted&&!row.sealed))throw fail('storage_corrupt','Invalid authored envelope');stored(()=>wasm.validateAuthoredSyncPayload(json(row.metadata),row.payload));authored.set(json(row.key),row);}
      for(const row of tables.sync_envelopes){checkMetadata(row);if(!(row.exact_wire instanceof Uint8Array)||!['authored','received'].includes(row.direction))throw fail('storage_corrupt','Invalid wire ledger');stored(()=>wasm.validateSyncWire(json(row.metadata),row.exact_wire));wires.set(json(row.key),row);}
      for(const [key,row] of authored){const wire=wires.get(key);if(row.sealed?(!wire||wire.direction!=='authored'||!equal(wire.metadata,row.metadata)||!bytesEqual(row.sealed,wire.exact_wire)):wire!==undefined)throw fail('storage_corrupt','Authored wire and common ledger disagree');}
      for(const [key,row] of wires)if(row.direction==='authored'&&!authored.has(key))throw fail('storage_corrupt','Authored ledger has no durable intent');
      invariant='cursor_scope';
      const cursors=new Map<string,SyncCursor>();for(const row of tables.sync_cursors){checkCursor(row.value,config);if(!equal(row.key,scopeKey(row.value)))throw fail('storage_corrupt','Cursor scope mismatch');cursors.set(json(row.key),row.value);}
      invariant='materialization_rows';
      const retained=new Map<string,Retained>();for(const row of tables.sync_materializations){if(typeof row.id!=='string'||!['normal','pending','recovery','tombstone'].includes(row.status)||(row.bytes!==null && !(row.bytes instanceof Uint8Array)))throw fail('storage_corrupt','Invalid retained materialization');retained.set(row.id,row);}
      invariant='publication_history';
      const publications=new Map<string,Publication>();
      for(const publication of tables.sync_publications){if(!publication?.row?.entry||publication.key!==json([publication.row.id,publication.row.entry.revision])||publication.row.status!=='normal')throw fail('storage_corrupt','Invalid immutable publication identity');publications.set(publication.key,publication);}
      checkPublicationBudget(publications);
      invariant='revision_fences';
      const revisions=new Set<string>(tables.sync_revisions.map((row:Json)=>row.revision));
      if(revisions.size>8192||[...revisions].some(value=>typeof value!=='string'||!value||value.length>128)||!revisions.has((graph as Json).version)||[...texts.values()].some(state=>!revisions.has(state.version))||[...publications.values()].some(value=>!revisions.has(value.row.entry!.revision)))throw fail('storage_corrupt','Revision history fence is missing or malformed');
      const snapshot:Snapshot={config,graph,view,texts,authored,wires,cursors,retained,publications,revisions,reserved:new Set(),counts,hasLegacyIntents:tables.intents.length>0||tables.receipts.length>0,published};
      invariant='namespace_payload_provenance';
      for(const [id,payload] of Object.entries((graph as Json).records)){
        const key=json([config.realm_id,config.vault_id,id]),meta=authored.get(key)?.metadata??wires.get(key)?.metadata;
        if(meta?.family!=='files')throw fail('storage_corrupt','Namespace record has no common identity fence');
        stored(()=>wasm.validateAuthoredSyncPayload(json(meta),new TextEncoder().encode(json(payload))));
      }
      invariant='text_activity_provenance';
      for(const [id,value] of Object.entries((graph as Json).activities)){
        const activity=value as Json,key=json([config.realm_id,config.vault_id,id]),meta=authored.get(key)?.metadata??wires.get(key)?.metadata;
        if(meta?.family!=='text'||!meta.text_binding||activity.update_id!==id||!equal(activity.identity,textIdentity(config,meta.text_binding.entry_id,meta.text_binding.text_bootstrap_id))||!equal(activity.namespace,meta.text_binding.namespace)||!equal(activity.payload_digest,meta.payload_digest)||activity.payload_bytes!==meta.payload_bytes)throw fail('storage_corrupt','Text activity differs from immutable common ledger provenance');
      }
      for(const row of [...authored.values(),...wires.values()])if(!(row.metadata.key.update_id in (row.metadata.family==='text'?(graph as Json).activities:(graph as Json).records)))throw fail('storage_corrupt','Sync envelope lost its retained causal record');
      invariant='journal_history';
      const journal=tables.journal as Json[];
      if(BigInt(journal.length)!==position(published.sequence)||journal.map(row=>position(row.sequence)).sort((a,b)=>a<b?-1:a>b?1:0).some((value,index)=>value!==BigInt(index+1)))throw fail('storage_corrupt','Publication journal history is incomplete');
      for(const event of journal)for(const change of event.changes??event.result?.changes??[]){if(change.after&&!revisions.has(change.after.revision))throw fail('storage_corrupt','Commit journal lost a historical metadata revision fence');}
      invariant='historical_publication';
      for(const {row} of publications.values()) {
        const viewEntry=view.namespace.entries[row.id];
        if(!viewEntry||!row.entry||!journal.some(event=>(event.changes??event.result?.changes??[]).some((change:Json)=>equal(change.before,row.entry)||equal(change.after,row.entry)))||row.entry.id!==row.id||row.entry.kind!==viewEntry.kind||row.entry.deleted)throw fail('storage_corrupt','Immutable publication lacks exact historical metadata');
        if(!row.presentation||row.presentation.id!==row.id||![row.presentation.ctime_ms,row.presentation.mtime_ms,row.presentation.size_bytes].every(value=>Number.isSafeInteger(value)&&value>=0)||row.presentation.size_bytes!==(row.bytes?.byteLength??0))throw fail('storage_corrupt','Historical publication presentation is malformed');
        if(row.reason?.status!=='normal'||row.reason.path!==row.entry.path||row.reason.kind!==row.entry.kind||!equal(stored(()=>JSON.parse(row.fingerprint)),{identity:viewEntry.identity,outcome:row.reason}))throw fail('storage_corrupt','Historical classifier witness differs from immutable publication');
        if(row.bytes!==null){
          if(!(row.bytes instanceof Uint8Array)||!row.witness)throw fail('storage_corrupt','Published content lacks its historical witness');
          const verified=stored(()=>{
            if(row.witness!.kind==='text'){
              const state=(row.witness as {state:Json}).state;
              if(state.version!==row.entry!.revision||state.identity.entry_id!==row.id||state.identity.realm_id!==config.realm_id||state.identity.vault_id!==config.vault_id||view.content_bindings[row.id]?.text_bootstrap_id!==state.identity.bootstrap_id)throw new Error('historical text identity');
              const historicalTexts=[...texts.values()].filter(text=>text.identity.entry_id!==row.id);historicalTexts.push(state);
              const verified=JSON.parse(wasm.recoveryFileContent(bounded(json(graph),8*1024*1024),bounded(json(historicalTexts),8*1024*1024),row.id));
              if(!verified||!equal(row.reason.content,{digest:verified.digest,witness:verified.witness}))throw new Error('historical text classifier witness');
              return new Uint8Array(verified.bytes);
            }
            const expected=row.reason.content;
            if(expected?.witness?.kind!=='binary'||expected.witness.selected_event!==(row.witness as {event_id:string}).event_id)throw new Error('historical binary classifier witness');
            wasm.verifyRetainedFileContent(bounded(json(graph),8*1024*1024),json(viewEntry.identity),(row.witness as {event_id:string}).event_id,bounded(json({...expected,bytes:Array.from(row.bytes!)})));
            return row.bytes!;

          });
          if(!bytesEqual(verified,row.bytes))throw fail('storage_corrupt','Published content differs from historical witness');
        }else if(row.witness!==null||row.entry.kind!=='folder'||row.reason.content!==null)throw fail('storage_corrupt','Published file lacks bytes');
      }
      invariant='retained_baseline';
      for(const row of retained.values()) {
        if(row.entry){const original=publications.get(json([row.id,row.entry.revision]))?.row;
          if(!original||!equal(row.entry,original.entry)||!equal(row.bytes,original.bytes)||!equal(row.presentation,original.presentation)||!equal(row.witness,original.witness))throw fail('storage_corrupt','Retained baseline differs from immutable publication');
        }else if(row.bytes!==null||row.presentation!==null||row.witness!==null)throw fail('storage_corrupt','Unpublished identity has fabricated baseline');
      }
      invariant='derived_classification';
      const textCount=texts.size,derived=stored(()=>materializations(snapshot));
      if(texts.size!==textCount || derived.length!==retained.size || derived.some(row=>retained.get(row.id)?.fingerprint!==row.fingerprint||retained.get(row.id)?.status!==row.status||!equal(retained.get(row.id)?.reason,row.reason)))throw fail('storage_corrupt','Retained publication does not match causal state');
      invariant='visible_publication_agreement';
      const visible=derived.filter(row=>row.status==='normal');
      if(visible.length!==published.entries.length || visible.some(row=>!equal(row.entry,published.entries.find(entry=>entry.id===row.id))||!equal(row.presentation,published.presentation.find(stat=>stat.id===row.id)) || (row.bytes!==null && !bytesEqual(row.bytes,published.contents.find(value=>value.id===row.id)?.bytes??new Uint8Array()))))throw fail('storage_corrupt','Published cache differs from verified causal materialization');
      done(snapshot);
    }catch(error){abort(error instanceof BrowserVaultError&&error.code==='storage_corrupt'?new BrowserVaultError(error.code,error.message,{invariant},error.source):error);}};
    for(const request of requests)request.onsuccess=complete;
  }
  const transaction=<T>(mode:IDBTransactionMode,run:(tx:IDBTransaction,s:Snapshot,done:(value:T)=>void)=>void):Promise<T>=>{assertActive();return host.transact(mode,(tx,done,abort)=>load(tx,s=>{try{assertActive();run(tx,s,done);}catch(error){abort(error);}},abort));};
  function enrolled(s:Snapshot):Configuration {if(!s.config)throw fail('sync_not_enrolled','Explicit sync enrollment is required');return s.config;}
  function checkCursor(cursor:SyncCursor,scope:SyncScope):void {position(cursor?.after);if(cursor.realm_id!==scope.realm_id||cursor.vault_id!==scope.vault_id||typeof cursor.server_epoch!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(cursor.server_epoch))throw fail('invalid_sync_cursor','Receive cursor has wrong scope or epoch');}
  function updateUnused(s:Snapshot,key:string[]):boolean{return !s.authored.has(json(key))&&!s.wires.has(json(key));}
  function saveCounts(tx:IDBTransaction,s:Snapshot):void {tx.objectStore('sync_state').put({key:'counts',value:{authored:s.authored.size,wires:s.wires.size,publications:s.publications.size,revisions:s.revisions.size}});}
  function saveAuthored(tx:IDBTransaction,s:Snapshot,plan:{metadataJson():string},payload:Uint8Array):EnvelopeMetadata {
    const metadata=JSON.parse(plan.metadataJson()) as EnvelopeMetadata,key=keyOf(metadata.key);
    if(!updateUnused(s,key))throw fail('sync_update_collision','Update ID already belongs to a sync operation');
    const row:Authored={key,metadata,payload,sealed:null,accepted:false};
    tx.objectStore('sync_authored').add(row);s.authored.set(json(key),row);saveCounts(tx,s);return metadata;
  }
  function textIdentity(config:Configuration,id:string,bootstrap:string):Json {return {realm_id:config.realm_id,vault_id:config.vault_id,entry_id:id,bootstrap_id:bootstrap};}
  function freshRevision(s:Snapshot):string {
    for(let attempt=0;attempt<16;attempt++){const revision=crypto.randomUUID();if(!s.revisions.has(revision)&&!s.reserved.has(revision)){s.reserved.add(revision);return revision;}}
    throw fail('sync_revision_collision','Could not allocate an unused local revision');
  }
  function ensureText(s:Snapshot,identity:Json):Json {
    const key=idKey(identity);let state=s.texts.get(key);
    if(!state){state=JSON.parse(requireWasm(host.wasm).createEmptyTextState(json({identity,version:freshRevision(s)})));s.texts.set(key,state);}return state;
  }
  function saveStates(tx:IDBTransaction,s:Snapshot):void {
    s.revisions.add(s.graph.version);for(const state of s.texts.values())s.revisions.add(state.version);
    for(const publication of s.publications.values())s.revisions.add(publication.row.entry!.revision);
    if(s.revisions.size>8192)throw fail('sync_history_limit','Local revision history requires explicit retention policy');
    for(const revision of s.revisions)tx.objectStore('sync_revisions').put({revision});
    tx.objectStore('sync_state').put({key:'graph',value:s.graph});
    for(const [key,state] of s.texts)tx.objectStore('sync_text').put({key,state});
  }
  // Fixture admission limits, not GC: retain every publication needed for recovery.
  function checkPublicationBudget(rows:Map<string,Publication>):void {
    if(rows.size>4096)throw fail('sync_history_limit','Publication history requires explicit compaction/retention policy');
    let total=0;
    for(const {row} of rows.values()){
      total+=row.bytes?.byteLength??0;
      if(row.witness?.kind==='text')total+=new TextEncoder().encode(bounded(json(row.witness.state),8*1024*1024)).byteLength;
      if(total>32*1024*1024)throw fail('sync_history_limit','Retained publication content/snapshots exceed fixture budget');
    }
  }
  /** Rust supplies all visibility, dependency, ancestry and verified-content decisions. */
  function materializations(s:Snapshot):Retained[] {
    const wasm=requireWasm(host.wasm),result:Retained[]=[];
    const classified=rust(()=>JSON.parse(wasm.classifyFileMaterializations(bounded(json(s.graph),8*1024*1024),bounded(json([...s.texts.values()]),8*1024*1024))));
    for(const [id,classification] of Object.entries(classified) as [string,Json][]){
      const previous=s.retained.get(id),outcome=classification.outcome,status=outcome.status as Retained['status'];
      const content=outcome.content??null,summary={...outcome};if(content)summary.content={digest:content.digest,witness:content.witness};
      const fingerprint=json({identity:classification.identity,outcome:summary});
      if(previous?.fingerprint===fingerprint){
        if(previous.status!==status||!equal(previous.reason,summary))throw fail('storage_corrupt','Retained visibility contradicts Rust classification');
        if(status==='normal' && (!previous.entry||previous.entry.id!==id||previous.entry.path!==outcome.path||previous.entry.kind!==outcome.kind||previous.entry.deleted||!previous.presentation||previous.presentation.id!==id||previous.presentation.size_bytes!==(content?.bytes.length??0)||![previous.presentation.ctime_ms,previous.presentation.mtime_ms].every(value=>Number.isSafeInteger(value)&&value>=0)||(content && (!previous.bytes||!bytesEqual(previous.bytes,new Uint8Array(content.bytes))))))throw fail('storage_corrupt','Retained bytes or presentation contradict Rust materialization');
        // Forced local plans may update an ancestor's metadata revision while
        // its namespace/content classification stays identical. Keep the read
        // snapshot immutable so that this later change can be detected.
        result.push(clone(previous));continue;
      }
      if(status!=='normal'){
        result.push({id,status,fingerprint,entry:previous?.entry??null,bytes:previous?.bytes??null,presentation:previous?.presentation??null,reason:summary,witness:previous?.witness??null});continue;
      }
      const timestamp=host.now();if(!Number.isSafeInteger(timestamp)||timestamp<0)throw fail('invalid_host_clock','Invalid display timestamp');
      let witness:Retained['witness']=null;
      if(content?.witness.kind==='text'){
        const state=s.texts.get(idKey(content.witness.identity));if(!state||state.version!==content.witness.revision)throw fail('storage_corrupt','Classified text witness has no exact retained state');
        witness={kind:'text',state};
      }else if(content?.witness.kind==='binary')witness={kind:'binary',event_id:content.witness.selected_event};
      const bytes=content?new Uint8Array(content.bytes):null;
      result.push({id,status,fingerprint,entry:{id,path:outcome.path,kind:outcome.kind,deleted:false,revision:content?.witness.kind==='text'?content.witness.revision:freshRevision(s)},bytes,presentation:{id,ctime_ms:previous?.presentation?.ctime_ms??timestamp,mtime_ms:timestamp,size_bytes:bytes?.byteLength??0},reason:summary,witness});
    }
    return result;
  }
  function commitGraph(tx:IDBTransaction,s:Snapshot,output:Json,origin:{kind:'authored'|'received';update_id:string},forced?:{changes:Json[]}):{sequence:string} {
    if(output.namespace.next_state)s.graph=output.namespace.next_state;
    s.view=JSON.parse(requireWasm(host.wasm).inspectFileState(bounded(json(s.graph))));
    let rows=materializations(s),rebound=false;
    // Host CAS revisions track local publication. A namespace-only transition
    // must not reuse a prior metadata revision for different visible state.
    for(const row of rows){const previous=s.retained.get(row.id);
      if(row.status==='normal'&&row.witness?.kind==='text'&&previous&&row.fingerprint!==previous.fingerprint&&row.entry!.revision===previous.entry?.revision){
        const state=JSON.parse(requireWasm(host.wasm).rebindTextState(json(row.witness.state),row.witness.state.version,freshRevision(s)));s.texts.set(idKey(state.identity),state);rebound=true;
      }
    }
    if(rebound)rows=materializations(s);
    if(forced)for(const change of forced.changes){const row=rows.find(row=>row.id===change.after.id);
      if(change.after.deleted){if(row?.status==='normal')throw fail('sync_projection_conflict','Deleted entry is still published');continue;}
      if(!row?.entry||row.status!=='normal'||row.entry.path!==change.after.path||row.entry.kind!==change.after.kind)throw fail('sync_projection_conflict','Family command differs from shared publication');
      row.entry={...change.after};
    }
    for(const row of rows)if(row.status==='normal'&&row.entry){const key=json([row.id,row.entry.revision]);if(s.publications.has(key)&&!equal(s.publications.get(key)!.row,row))throw fail('sync_revision_collision','Publication revision already belongs to different immutable content');if(!s.publications.has(key)){const publication={key,row:clone(row)};s.publications.set(key,publication);tx.objectStore('sync_publications').add(publication);}}
    checkPublicationBudget(s.publications);saveStates(tx,s);saveCounts(tx,s);
    // A classifier fingerprint excludes host metadata revisions. Core plans
    // also bump ancestors, so compare the complete persisted publication row.
    for(const row of rows)if(!equal(s.retained.get(row.id),row))tx.objectStore('sync_materializations').put(row);
    return host.publish(tx,rows,origin,forced,s.published);
  }
  const api:BrowserSync={
    bindSession(guard){assertActive();guard();return browserSync(host,()=>{assertActive();guard();}).api;},
    enroll(input){const scope=clone(input);return transaction<void>('readwrite',(tx,s,done)=>{
      const config:Configuration={...scope,replica_id:crypto.randomUUID(),incarnation_id:crypto.randomUUID()};
      if(s.config){if(!equal({realm_id:s.config.realm_id,vault_id:s.config.vault_id,key_epoch:s.config.key_epoch},scope))throw fail('sync_scope_conflict','Vault already has another sync enrollment');done(undefined);return;}
      if(!Number.isInteger(scope.key_epoch)||scope.key_epoch<1||scope.key_epoch>0xffffffff)throw fail('invalid_sync_epoch','Key epoch must be positive u32');
      const graph=JSON.parse(requireWasm(host.wasm).createEmptyFileState(json({scope:{realm_id:scope.realm_id,vault_id:scope.vault_id},version:freshRevision(s)})));
      if(s.published.entries.length||s.published.sequence!=='0'||s.hasLegacyIntents)throw fail('sync_enrollment_requires_empty','Only an explicitly empty new vault may enroll');
      tx.objectStore('sync_state').add({key:'config',value:config});tx.objectStore('sync_state').add({key:'graph',value:graph});tx.objectStore('sync_revisions').add({revision:graph.version});tx.objectStore('sync_state').add({key:'counts',value:{authored:0,wires:0,publications:0,revisions:1}});done(undefined);
    });},
    authorFile(payloadJson){const canonical=rust(()=>requireWasm(host.wasm).encodeFilePayload(bounded(payloadJson))),source=new TextDecoder('utf-8',{fatal:true}).decode(canonical);return transaction<string>('readwrite',(tx,s,done)=>{
      const config=enrolled(s),payload=JSON.parse(source);if(!equal(payload.scope,{realm_id:config.realm_id,vault_id:config.vault_id}))throw fail('sync_scope_conflict','Authored payload scope mismatch');
      const original=s.authored.get(json([config.realm_id,config.vault_id,payload.id]));
      if(original){if(original.metadata.family!=='files'||!bytesEqual(original.payload,canonical))throw fail('sync_update_collision','Authored namespace identity has another exact payload');done(json(original.metadata));return;}
      const plan=rust(()=>requireWasm(host.wasm).planFileMutation(`{"state":${json(s.graph)},"payload":${source},"next_version":${json(freshRevision(s))}}`));
      try{const output=JSON.parse(plan.resultJson()),meta=JSON.parse(plan.metadataJson()) as EnvelopeMetadata;
        plan.checkPreconditions(json({state:s.graph,update_id_unused:updateUnused(s,keyOf(meta.key))}));
        saveAuthored(tx,s,plan,new Uint8Array(output.payload_bytes));
        for(const [id,binding] of Object.entries(output.namespace.view.content_bindings) as [string,Json][])if(binding.kind==='text')ensureText(s,textIdentity(config,id,binding.text_bootstrap_id));
        commitGraph(tx,s,output,{kind:'authored',update_id:meta.key.update_id});done(json(meta));
      }finally{plan.free();}
    });},
    setCursor(nextInput,expectedInput){const next=clone(nextInput),expected=clone(expectedInput);return transaction('readwrite',(tx,s,done)=>{
      const config=enrolled(s);checkCursor(next,config);const key=scopeKey(config),current=s.cursors.get(json(key))??null;
      if(equal(current,next)){done(undefined);return;}
      if(!equal(current,expected))throw fail('sync_cursor_conflict','Receive cursor changed');
      if(position(next.after)!==0n || current?.server_epoch===next.server_epoch)throw fail('sync_cursor_conflict','Only initial binding or explicit new-epoch reset to zero is allowed; receive exclusively advances progress');
      tx.objectStore('sync_cursors').put({key,value:next});done(undefined);
    });},
    receive(updateId,wireInput,key,deliveryInput){const wire=wireCopy(wireInput),delivery=clone(deliveryInput);
      return transaction<{duplicate:boolean;sequence:string}>('readwrite',(tx,s,done)=>{
        const config=enrolled(s),context={realm_id:config.realm_id,vault_id:config.vault_id,update_id:updateId,key_epoch:config.key_epoch};
        const opened=rust(()=>key.openSyncUpdate(json(context),wire));
        try{const metadata=JSON.parse(opened.metadataJson()) as EnvelopeMetadata,ledgerKey=keyOf(metadata.key),prior=s.wires.get(json(ledgerKey)),authored=s.authored.get(json(ledgerKey));
          if(prior&&(!equal(prior.metadata,metadata)||!bytesEqual(prior.exact_wire,wire)))throw fail('sync_update_collision','Update ID has different wire bytes or family');
          if(authored&&(!authored.sealed||!bytesEqual(authored.sealed,wire)))throw fail('sync_update_collision','Incoming update conflicts with authored identity');
          const cursor=s.cursors.get(json(scopeKey(config)))??null;
          if(delivery){checkCursor(delivery.expected,config);checkCursor(delivery.next,config);if(!equal(cursor,delivery.expected)||delivery.next.server_epoch!==delivery.expected.server_epoch||position(delivery.next.after)!==position(delivery.expected.after)+1n)throw fail('sync_cursor_conflict','Delivery is not the next admitted cursor item');}
          let plan:SyncPlan;const revision=freshRevision(s);
          if(metadata.family==='records')throw fail('sync_records_requires_streaming','Managed records require normalized streaming storage');
          if(metadata.family==='text'){
            const binding=metadata.text_binding!;const identity=textIdentity(config,binding.entry_id,binding.text_bootstrap_id),state=ensureText(s,identity);
            const previous=prior?{identity,update_id:updateId,exact_wire:Array.from(prior.exact_wire)}:null;
            const input={state,namespace_state:s.graph,request:{expected_version:state.version,next_version:revision,delivery:delivery??null},next_namespace_version:freshRevision(s),prior:previous,cursor};
            plan=rust(()=>opened.planText(json(input)));
            try{plan.checkPreconditions(json({state,namespace_state:s.graph,prior:previous,cursor}));const output=JSON.parse(plan.resultJson());if(output.text.next_state)s.texts.set(idKey(identity),output.text.next_state);
              finish(output);
            }finally{plan.free();}
          }else{
            const previous=prior?{scope:{realm_id:config.realm_id,vault_id:config.vault_id},id:updateId,exact_wire:Array.from(prior.exact_wire)}:null;
            plan=rust(()=>opened.planFile(json({state:s.graph,prior:previous,next_version:revision})));
            try{plan.checkPreconditions(json({state:s.graph,prior:previous}));finish(JSON.parse(plan.resultJson()));}finally{plan.free();}
          }
          function finish(output:Json){
            if(!prior){const row:Wire={key:ledgerKey,metadata,direction:'received',exact_wire:wire};tx.objectStore('sync_envelopes').add(row);s.wires.set(json(ledgerKey),row);saveCounts(tx,s);}
            if(delivery)tx.objectStore('sync_cursors').put({key:scopeKey(config),value:delivery.next});
            const result=commitGraph(tx,s,output,{kind:'received',update_id:updateId});done({duplicate:!!prior,sequence:result.sequence});
          }
        }finally{opened.free();}
      });
    },
    pending(limit){if(!Number.isInteger(limit)||limit<1||limit>1000)return Promise.reject(fail('invalid_sync_limit','Limit must be 1–1000'));return transaction('readonly',(_tx,s,done)=>done([...s.authored.values()].filter(row=>!row.accepted).slice(0,limit).map(row=>({metadata:clone(row.metadata),sealed:row.sealed?.slice()??null,accepted:row.accepted}))));},
    async seal(updateId,key){
      const initial=await transaction<{config:Configuration;row:Authored}>('readonly',(_tx,s,done)=>{const config=enrolled(s),row=s.authored.get(json([config.realm_id,config.vault_id,updateId]));if(!row)throw fail('sync_update_not_found','No authored update');done({config,row:clone(row)});});
      const c=initial.config,context={realm_id:c.realm_id,vault_id:c.vault_id,update_id:updateId,key_epoch:c.key_epoch};
      if(initial.row.sealed){const verified=stored(()=>key.openSyncUpdate(json(context),initial.row.sealed!));try{if(!equal(JSON.parse(verified.metadataJson()),initial.row.metadata)||!verified.matchesPayload(initial.row.payload))throw fail('storage_corrupt','Persisted sealed wire differs from authored payload');return initial.row.sealed;}finally{verified.free();}}
      const header={envelope_version:1,purpose:'vault_update',suite:'xchacha20poly1305',...context,origin_device_id:c.replica_id,document_format_version:1,required_features:[],optional_extensions:{}};
      const candidate=rust(()=>key.seal(json(header),initial.row.payload));
      const opened=rust(()=>key.openSyncUpdate(json(context),candidate));
      try{if(!equal(JSON.parse(opened.metadataJson()),initial.row.metadata)||!opened.matchesPayload(initial.row.payload))throw fail('sync_seal_mismatch','Sealed candidate differs from authored payload');}
      finally{opened.free();}
      return transaction('readwrite',(tx,s,done)=>{
        if(!equal(s.config,c))throw fail('sync_scope_conflict','Sync enrollment changed while sealing');
        const row=s.authored.get(json(initial.row.key));if(!row||!equal(row.metadata,initial.row.metadata)||!bytesEqual(row.payload,initial.row.payload))throw fail('storage_corrupt','Authored payload changed while sealing');
        if(row.sealed){const winner=stored(()=>key.openSyncUpdate(json(context),row.sealed!));try{if(!equal(JSON.parse(winner.metadataJson()),row.metadata)||!winner.matchesPayload(row.payload))throw fail('storage_corrupt','Concurrent seal winner differs from authored payload');done(row.sealed.slice());return;}finally{winner.free();}}
        if(s.wires.has(json(row.key)))throw fail('sync_update_collision','Update ID acquired a conflicting wire');
        const next={...row,sealed:candidate};tx.objectStore('sync_authored').put(next);
        const record:Wire={key:row.key,metadata:row.metadata,direction:'authored',exact_wire:candidate};tx.objectStore('sync_envelopes').add(record);s.wires.set(json(row.key),record);saveCounts(tx,s);done(candidate.slice());
      });
    },
    acknowledge(updateId,wireInput){const wire=wireCopy(wireInput);return transaction('readwrite',(tx,s,done)=>{const c=enrolled(s),row=s.authored.get(json([c.realm_id,c.vault_id,updateId]));if(!row?.sealed||!bytesEqual(row.sealed,wire))throw fail('sync_ack_mismatch','Acknowledge only the persisted exact wire');tx.objectStore('sync_authored').put({...row,accepted:true});done(undefined);});},
    inspect(){return transaction('readonly',(_tx,s,done)=>done({scope:s.config?{realm_id:s.config.realm_id,vault_id:s.config.vault_id,key_epoch:s.config.key_epoch}:null,namespace:clone(s.view),pending:clone(s.view?.namespace.pending??[]),cursor:s.config?clone(s.cursors.get(json(scopeKey(s.config)))??null):null}));},
    readRetained(id){return transaction('readonly',(_tx,s,done)=>{const row=s.retained.get(id);done(row?{...clone(row),recovery_content:stored(()=>JSON.parse(requireWasm(host.wasm).recoveryFileContent(bounded(json(s.graph)),bounded(json([...s.texts.values()])),id)))}:null);});},
  };
  const canonicalCommand=(request:Json,commandJson:string|undefined):string=>rust(()=>requireWasm(host.wasm).validateFamilyCommand(bounded(commandJson??json({version:1,request,create_mode:null}),4*1024*1024)));
  return {api,validate(tx,done,abort){load(tx,()=>done(),abort);},admitMutation(tx,request,commandJson,done,abort){load(tx,s=>{try{
    if(!s.config){if(commandJson!==undefined)throw fail('sync_not_enrolled','Family commands require explicit sync enrollment');done(undefined);return;}
    done(canonicalCommand(request,commandJson));
  }catch(error){abort(error);}},abort);},localWrite(tx,request,revision,changes,commandJson,done,abort){load(tx,s=>{try{
    if(!s.config){if(commandJson!==undefined)throw fail('sync_not_enrolled','Family commands require explicit sync enrollment');done(false);return;}
    const wasm=requireWasm(host.wasm),command=JSON.parse(canonicalCommand(request,commandJson));
    const state=request.mutation.type==='write'?[...s.texts.values()].find(text=>text.identity.entry_id===request.mutation.id)??null:null;
    if(s.revisions.has(revision))throw fail('sync_revision_collision','Metadata revision was used by an earlier commit');s.reserved.add(revision);
    const input={command,entries:s.published.entries,graph:s.graph,text:state};
    const need=JSON.parse(rust(()=>wasm.familyMutationRequirements(bounded(json(input)))));
    const actor=()=>{let value:number;do{value=crypto.getRandomValues(new Uint32Array(1))[0];}while(state&&Object.hasOwn(state.actors,String(value)));return {actor:value,owner:{replica_id:s.config!.replica_id,incarnation_id:s.config!.incarnation_id}};};
    const allocation={metadata_revision:revision,graph_revision:freshRevision(s),update_ids:Array.from({length:need.update_count},()=>crypto.randomUUID()),text:need.text==='none'?null:{actor:actor(),new_text:need.text==='create'?{bootstrap_id:crypto.randomUUID(),empty_revision:freshRevision(s)}:null}};
    const plan=rust(()=>wasm.planFamilyMutation(bounded(json({...input,allocation}))));
    try{
      const output=JSON.parse(plan.resultJson()),metadata=JSON.parse(plan.metadataJson()) as EnvelopeMetadata[];
      const unused=output.allocated_update_ids.every((id:string)=>updateUnused(s,[s.config!.realm_id,s.config!.vault_id,id])&&![...s.texts.values()].some(text=>text.identity.bootstrap_id===id));
      plan.checkPreconditions(json({entries:s.published.entries,graph:s.graph,text:state,allocated_ids_unused:unused}));
      if(!equal(output.changes,changes))throw fail('sync_projection_conflict','Core receipt and family mutation changes differ');
      for(const change of output.changes)s.revisions.add(change.after.revision);
      const payloads=output.authored_files.map((file:Json)=>file.payload_bytes);
      if(output.text)payloads.push(output.text.plan.authored.payload_bytes);
      if(metadata.length!==payloads.length)throw fail('invalid_wasm_result','Family envelope metadata count mismatch');
      for(let index=0;index<metadata.length;index++)saveAuthored(tx,s,{metadataJson:()=>json(metadata[index])},new Uint8Array(payloads[index]));
      if(output.text){const next=output.text.plan.next_state;s.texts.set(idKey(next.identity),next);}
      for(const change of output.changes){const current=[...s.texts.values()].find(text=>text.identity.entry_id===change.after.id);
        if(current&&current.version!==change.after.revision)s.texts.set(idKey(current.identity),JSON.parse(wasm.rebindTextState(json(current),current.version,change.after.revision)));
      }
      commitGraph(tx,s,{namespace:{next_state:output.next_graph}},{kind:'authored',update_id:metadata[0].key.update_id},{changes});done(true);
    }finally{plan.free();}
  }catch(error){abort(error);}},abort);}};
}
