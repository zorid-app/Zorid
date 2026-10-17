import { BrowserVaultError } from './browser-vault.ts';
import type { EntryState, BrowserVaultPresentation } from './browser-vault.ts';
import type { BrowserSync, BrowserSyncKey, EnvelopeMetadata, SyncDelivery, SyncCursor, SyncScope } from './browser-sync.ts';
import {
  normalizedTransact, browserNormalizedStores, addImmutableSource,
  addImmutableMetadata, putNormalizedMetadata, getExactSource, decimalU64, nextDecimalU64, normalizedLimits,
} from './browser-normalized-idb.ts';
import type { Abort, SourceHeader, SourceInput, SourceRead, SourceKey, MetadataValue } from './browser-normalized-idb.ts';

type Json = any;
export const browserStreamingSyncKeyPaths: Record<string, string> = {
  sync_state: 'key', sync_text: 'key', sync_authored: 'key', sync_envelopes: 'key',
  sync_cursors: 'key', sync_revisions: 'revision',
};
export const browserStreamingSyncStores = Object.freeze([...Object.keys(browserStreamingSyncKeyPaths), ...browserNormalizedStores]);
export const streamingSyncKeys = Object.freeze({ configuration: 'config', head: 'metadata-head' });
export interface StreamingPublication { entries: EntryState[]; presentation: BrowserVaultPresentation[]; sequence: string }
export type StreamingContent = {kind:'binary';reference:Json} | {kind:'text';bytes:Uint8Array;metadata:Json};
export interface StreamingRetainedRow {
  id:string; status:'normal'|'pending'|'recovery'|'tombstone'; fingerprint:string;
  entry:EntryState|null; presentation:BrowserVaultPresentation|null; content:StreamingContent|null; reason:Json;
}
export interface StreamingSourceDescriptor {
  version:1; metadata:EnvelopeMetadata; record:Json|null; activity:Json|null; summary_digest:number[];
}
interface Free { free():void }
export interface StreamingMetadataBuilder extends Free {
  restoreRecord(id:string,record:string,length:number,payloadDigest:Uint8Array,summaryDigest:Uint8Array):void;
  restoreActivity(id:string,activity:string,length:number,payloadDigest:Uint8Array,summaryDigest:Uint8Array):void;
  finish():StreamingMetadataState;
}
export interface StreamingVerificationSession extends Free {
  nextChunkJson():string|undefined; providePayload(manifestIndex:number,sequence:number,exact:Uint8Array):Uint8Array;
  finish():StreamingVerifiedSet;
}
export interface StreamingVerifiedSet extends Free {}
export interface StreamingRecovery extends Free { metadataJson():string; textBytes():Uint8Array|undefined }
export interface StreamingClassification extends Free { length():number; entryJson(index:number):string; textBytes(index:number):Uint8Array|undefined }
export interface StreamingMetadataState extends Free {
  metadataHeadJson():string; namespaceViewJson():string; verificationSession():StreamingVerificationSession;
  mutationRequirements(input:string):string; prepareMutation(input:string):StreamingCandidate;
  prepareBinaryMutation(input:string,batch:StreamingAuthoredBatch,built:StreamingBuiltManifest):StreamingCandidate;
  prepareAuthoredBatch(batch:StreamingAuthoredBatch,nextRevision:string):StreamingCandidate;
  classify(proof:StreamingVerifiedSet,texts:string):StreamingClassification;
  openBinaryRead(proof:StreamingVerifiedSet,referenceJson:string):StreamingBinaryReadPlan;
  recoveryContent(proof:StreamingVerifiedSet,texts:string,entryId:string):StreamingRecovery;
}
export interface StreamingCandidate extends Free {
  verificationSession():StreamingVerificationSession; payloadCount():number;
  payloadMetadataJson(index:number):string; payloadBytes(index:number):Uint8Array;
  finalize(proof:StreamingVerifiedSet):StreamingMetadataPlan;
}
export interface StreamingMetadataPlan extends Free {
  resultJson():string; nextState():StreamingMetadataState|undefined;
  recordDeltaJson(index:number):string; activityDeltaJson(index:number):string;
  payloadMetadataJson(index:number):string; payloadBytes(index:number):Uint8Array;
  textBytes():Uint8Array|undefined; receivedWireBytes():Uint8Array;
  checkPreconditions(actual:StreamingMetadataState,input:string,priorWire:Uint8Array):void;
  classify(texts:string):StreamingClassification;
}
export interface StreamingAuthoredBatch extends Free { pushPayload(bytes:Uint8Array):string }
export interface StreamingBuiltManifest extends Free { manifestJson():string }
export interface StreamingOpenedUpdate extends Free {
  metadataJson():string; exactWire():Uint8Array; matchesPayload(bytes:Uint8Array):boolean;
  exactPlaintext():Uint8Array; authenticatedDescriptorJson():string;
  prepareMetadataFile(state:StreamingMetadataState,nextRevision:string,priorWire:Uint8Array):StreamingCandidate;
  prepareMetadataText(state:StreamingMetadataState,input:string,priorWire:Uint8Array):StreamingCandidate;
}
export interface BrowserStreamingWasm {
  WasmMetadataStateBuilder: new(scope:string,revision:string)=>StreamingMetadataBuilder;
  WasmAuthoredMetadataBatch: new(scope:string)=>StreamingAuthoredBatch;
  validateFamilyCommand(input:string):string;
  checkFamilyCommandReplay(original:string,candidate:string):void;
  validateAuthoredSyncPayload(metadata:string,payload:Uint8Array):void;
  validateSyncWire(metadata:string,wire:Uint8Array):void;
  encodeFilePayload(input:string):Uint8Array;
  materializeTextState(input:string):Uint8Array;
  createEmptyTextState(input:string):string;
  rebindTextState(state:string,expectedRevision:string,nextRevision:string):string;
}
export interface BrowserStreamingSyncHost {
  db:IDBDatabase; authorityId:string; wasm:BrowserStreamingWasm;
  now():number; assertActive():void;
  readPublication(tx:IDBTransaction,done:(current:StreamingPublication)=>void,abort:Abort):void;
  publish(tx:IDBTransaction,rows:StreamingRetainedRow[],origin:{kind:'authored'|'received';update_id:string},
    forcedChanges:Json[]|undefined,current:StreamingPublication):{sequence:string};
}
export interface StreamingLocalInput { requestJson:string; familyCommandJson?:string; nextRevision:string }
export interface StreamingBinaryInput {
  target:Json; batch:StreamingAuthoredBatch; built:StreamingBuiltManifest;
  finalEventId:string; metadataRevision:string; graphRevision:string;
  /** Exact stable stage source identities; these are immutable payload rows. */
  sourceKeys:SourceKey[];
}
/** Only instances prepared by this engine carry private plan/proof ownership. */
export interface PreparedStreamingMutation { readonly changes:readonly Json[]; dispose():void }
export interface StreamingBinaryReadPlan extends Free {
  length():string; chunkCount():number; chunkJson(index:number):string;
  verifyPayload(index:number,exactPayload:Uint8Array):Uint8Array;
}
export interface StreamingReadInput { entryId:string; expectedRevision?:string; expectedContentEvent?:string; reference?:Json }
export interface PreparedStreamingRead {
  readonly reference:Json; readonly revision:string;
  length():string; chunkCount():number; chunkJson(index:number):string;
  verifyPayload(index:number,exactPayload:Uint8Array):Uint8Array;
  dispose():void;
}
export interface StreamingRecoveryReadInput { entryId:string; expectedContentEvent?:string; reference?:Json }
export interface StreamingRecoveryReadWitness { kind:'current_retained'; metadata_revision:string; entry_id:string; selected_content_event:string }
export interface PreparedStreamingRecoveryRead {
  readonly reference:Json; readonly witness:StreamingRecoveryReadWitness;
  length():string; chunkCount():number; chunkJson(index:number):string;
  verifyPayload(index:number,exactPayload:Uint8Array):Uint8Array; dispose():void;
}
export interface BrowserStreamingSyncEngine {
  api:BrowserSync & {readonly concurrentPreparation:true};
  prepareLocal(input:StreamingLocalInput):Promise<PreparedStreamingMutation>;
  /** Owns batch and built immediately on call, including every failure path. */
  prepareBinary(input:StreamingBinaryInput):Promise<PreparedStreamingMutation>;
  commitLocal(tx:IDBTransaction,prepared:PreparedStreamingMutation,current:StreamingPublication,
    done:(result:{sequence:string})=>void,abort:Abort):void;
  prepareRead(input:StreamingReadInput):Promise<PreparedStreamingRead>;
  commitRead(tx:IDBTransaction,prepared:PreparedStreamingRead,current:StreamingPublication,done:()=>void,abort:Abort):void;
  prepareRecoveryRead(input:StreamingRecoveryReadInput):Promise<PreparedStreamingRecoveryRead>;
  commitRecoveryRead(tx:IDBTransaction,prepared:PreparedStreamingRecoveryRead,current:StreamingPublication,done:()=>void,abort:Abort):void;
  /** Parent startup/inspection obtains metadata only, never a legacy graph. */
  validate():Promise<void>;
}

interface Configuration extends SyncScope { key_epoch:number; replica_id:string; incarnation_id:string }
interface Head { scope:SyncScope; version:string; record_count:number; activity_count:number }
interface GraphRow extends SourceKey { record?:Json; activity?:Json; summary_digest:number[] }
interface Snapshot {
  config:Configuration|null; head:Head|null; records:GraphRow[]; activities:GraphRow[];
  texts:Map<string,Json>; headers:Map<string,SourceHeader>; retained:Map<string,Json>;
  cursor:SyncCursor|null; publication:StreamingPublication;
}
interface Emission { metadata:EnvelopeMetadata; payload:Uint8Array }
interface InternalPrepared {
  snapshot:Snapshot; plan:StreamingMetadataPlan; result:Json; rows:StreamingRetainedRow[];
  texts:Map<string,Json>; sources:SourceInput[]; pins:Map<string,SourceHeader>;
  prior:Uint8Array; updateId:string; incoming:boolean; delivery?:SyncDelivery;
  expectedText:Json|null; revisions:string[]; used:boolean;
}
const textEncoder=new TextEncoder();
const stringify=(value:unknown)=>JSON.stringify(value);
const copy=<T>(value:T):T=>structuredClone(value);
const key=(value:SourceKey)=>[value.realmId,value.vaultId,value.updateId];
const keyString=(value:SourceKey)=>stringify(key(value));
const sourceKey=(metadata:EnvelopeMetadata):SourceKey=>({realmId:metadata.key.realm_id,vaultId:metadata.key.vault_id,updateId:metadata.key.update_id});
const textKey=(identity:Json)=>stringify([identity.realm_id,identity.vault_id,identity.entry_id,identity.bootstrap_id]);
const equals=(left:Json,right:Json):boolean=>{
  if(left===right)return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
  const keys=Object.keys(left).sort(), other=Object.keys(right).sort();
  return keys.length===other.length&&keys.every((name,index)=>name===other[index]&&equals(left[name],right[name]));
};
const sameBytes=(left:Uint8Array,right:Uint8Array)=>left.byteLength===right.byteLength&&left.every((byte,index)=>byte===right[index]);
const failure=(code:string,message='Streaming browser sync rejected inconsistent or unavailable state')=>new BrowserVaultError(code,message);
const rust=<T>(call:()=>T):T=>{try{return call();}catch(error){if(error instanceof BrowserVaultError)throw error;throw new BrowserVaultError('sync_plan_rejected','Shared Rust streaming planner rejected the operation',{reason:String(error)},'rust');}};
function boundedJson(raw:string,limit=32*1024*1024):Json {
  if(typeof raw!=='string'||raw.length>limit||textEncoder.encode(raw).byteLength>limit)throw failure('sync_input_too_large');
  return JSON.parse(raw);
}
function digest(value:unknown):Uint8Array {
  if(!Array.isArray(value)||value.length!==32||!value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255))throw failure('storage_corrupt');
  return new Uint8Array(value);
}
function descriptor(header:SourceHeader):StreamingSourceDescriptor {
  const value=header.descriptor as unknown as StreamingSourceDescriptor, metadata=value?.metadata;
  if(value?.version!==1||!metadata||metadata.format_version!==2||!['text','files'].includes(metadata.family)||
    metadata.key?.realm_id!==header.realmId||metadata.key?.vault_id!==header.vaultId||metadata.key?.update_id!==header.updateId||
    !Number.isInteger(metadata.payload_bytes)||metadata.payload_bytes<1||metadata.payload_bytes>1024*1024||
    (metadata.family==='files'?(!value.record||value.activity!==null||metadata.text_binding!==null):(!value.activity||value.record!==null||!metadata.text_binding)))throw failure('storage_corrupt');
  digest(metadata.payload_digest);digest(value.summary_digest);
  if(metadata.family==='files'){
    if(value.record.payload_bytes!==metadata.payload_bytes||!equals(value.record.payload_digest,metadata.payload_digest))throw failure('storage_corrupt');
  }else{
    const activity=value.activity,binding=metadata.text_binding!;
    if(activity.update_id!==header.updateId||!equals(activity.identity,{realm_id:header.realmId,vault_id:header.vaultId,entry_id:binding.entry_id,bootstrap_id:binding.text_bootstrap_id})||
      !equals(activity.namespace,binding.namespace)||activity.payload_bytes!==metadata.payload_bytes||!equals(activity.payload_digest,metadata.payload_digest))throw failure('storage_corrupt');
  }
  return value;
}
function assertScope(scope:SyncScope,metadata:EnvelopeMetadata):void {
  if(metadata.key.realm_id!==scope.realm_id||metadata.key.vault_id!==scope.vault_id)throw failure('sync_scope_conflict');
}
function read<T>(tx:IDBTransaction,request:IDBRequest<T>,callback:(value:T)=>void,abort:Abort,guard:()=>void):void {
  request.onsuccess=()=>{try{guard();callback(request.result);}catch(error){abort(error);}};
}
const baseStores=()=>[...browserStreamingSyncStores,'metadata','presentation','content','control','receipts','journal','intents'];

/** Fresh-format engine. Each prepare owns its metadata/proof snapshot; no mutable
 * graph cache or writer transaction spans asynchronous chunk reads. */
export function browserStreamingSync(host:BrowserStreamingSyncHost):BrowserStreamingSyncEngine {
  for(const name of ['WasmMetadataStateBuilder','WasmAuthoredMetadataBatch','validateFamilyCommand','checkFamilyCommandReplay','validateAuthoredSyncPayload','validateSyncWire','encodeFilePayload','materializeTextState','createEmptyTextState','rebindTextState'] as const)if(typeof host.wasm[name]!=='function')throw failure('sync_bindings_unavailable');
  const prepared=new WeakMap<PreparedStreamingMutation,InternalPrepared>();
  const active=()=>host.assertActive();
  const transact=<T>(mode:IDBTransactionMode,start:(tx:IDBTransaction,done:(value:T)=>void,abort:Abort)=>void)=>normalizedTransact(host.db,{authorityId:host.authorityId,stores:baseStores(),mode,assertActive:active},start);
  const fresh=()=>crypto.randomUUID();
  function capture(tx:IDBTransaction,done:(snapshot:Snapshot)=>void,abort:Abort):void {
    const authored=new Map<string,Json>(),envelopes=new Map<string,Json>(),orders=new Set<string>();
    const s:Snapshot={config:null,head:null,records:[],activities:[],texts:new Map(),headers:new Map(),retained:new Map(),cursor:null,publication:{entries:[],presentation:[],sequence:'0'}};
    read(tx,tx.objectStore('sync_state').get(streamingSyncKeys.configuration),config=>{
      s.config=config?.value??null;
      read(tx,tx.objectStore('sync_state').get(streamingSyncKeys.head),head=>{
        s.head=head?.value??null;
        if((s.config===null)!==(s.head===null))throw failure('storage_corrupt');
        if(s.config&&(!Number.isInteger(s.config.key_epoch)||s.config.key_epoch<1||!equals(s.head?.scope,{realm_id:s.config.realm_id,vault_id:s.config.vault_id})))throw failure('storage_corrupt');
        host.readPublication(tx,current=>{try{active();s.publication=copy(current);decimalU64(current.sequence);loadTables();}catch(error){abort(error);}},abort);
      },abort,active);
    },abort,active);
    function scan(store:string,accept:(row:Json)=>void,next:()=>void):void {
      let count=0,total=0;
      const request=tx.objectStore(store).openCursor();
      read(tx,request,cursor=>{
        if(!cursor){next();return;}
        if(++count>4096||(total+=textEncoder.encode(stringify(cursor.value)).byteLength)>128*1024*1024)throw failure('storage_metadata_too_large');
        accept(cursor.value);cursor.continue();
      },abort,active);
    }
    function loadTables():void {
      scan('sync_graph_records',row=>{if(!s.config||row.realmId!==s.config.realm_id||row.vaultId!==s.config.vault_id||!row.record)throw failure('storage_corrupt');s.records.push(row);},()=>
      scan('sync_graph_activities',row=>{if(!s.config||row.realmId!==s.config.realm_id||row.vaultId!==s.config.vault_id||!row.activity)throw failure('storage_corrupt');s.activities.push(row);},()=>{
        let textBytes=0;
        scan('sync_text',row=>{
          if(!row?.state||row.key!==textKey(row.state.identity)||s.texts.has(row.key))throw failure('storage_corrupt');
          textBytes+=textEncoder.encode(stringify(row.state)).byteLength;if(textBytes>8*1024*1024)throw failure('storage_metadata_too_large');
          s.texts.set(row.key,row.state);
        },()=>scan('sync_materialization_refs',row=>{if(!row?.id||s.retained.has(row.id))throw failure('storage_corrupt');s.retained.set(row.id,row);},()=>
          scan('sync_authored',row=>loadLedger(row,authored,true),()=>scan('sync_envelopes',row=>loadLedger(row,envelopes,false),loadHeaders))));
      }));
    }
    function loadLedger(row:Json,table:Map<string,Json>,local:boolean):void {
      const metadata=row?.metadata;
      if(!s.config||!metadata||!equals(row.key,[s.config.realm_id,s.config.vault_id,metadata.key?.update_id])||
        metadata.key?.realm_id!==s.config.realm_id||metadata.key?.vault_id!==s.config.vault_id||table.has(stringify(row.key)))throw failure('storage_corrupt');
      if(local){
        if(orders.has(row.order)||![0,1].includes(row.pending)||typeof row.sealed!=='boolean'||typeof row.order!=='string'||!/^\d{20}$/.test(row.order)||
          BigInt(row.order)>((1n<<64n)-1n)||BigInt(row.order)===0n||(row.pending===0&&!row.sealed))throw failure('storage_corrupt');
              orders.add(row.order);
      }else if(!['authored','received'].includes(row.direction))throw failure('storage_corrupt');
      table.set(stringify(row.key),row);
    }
    function loadHeaders():void {
      if(s.head&&(s.head.record_count!==s.records.length||s.head.activity_count!==s.activities.length))throw failure('storage_corrupt');
      const rows=[...s.records,...s.activities],graphKeys=new Set(rows.map(keyString));let index=0;
      if(graphKeys.size!==rows.length||[...authored.keys(),...envelopes.keys()].some(id=>!graphKeys.has(id)))throw failure('storage_corrupt');
      for(const row of s.activities){
        const identity=row.activity?.identity;
        if(!identity||!s.config||identity.realm_id!==s.config.realm_id||identity.vault_id!==s.config.vault_id||!s.texts.has(textKey(identity)))throw failure('storage_corrupt');
      }
      for(const text of s.texts.values())if(!s.config||text.identity.realm_id!==s.config.realm_id||text.identity.vault_id!==s.config.vault_id)throw failure('storage_corrupt');
      const next=()=>{
        if(index===rows.length){
          if(!s.config){done(s);return;}
          read(tx,tx.objectStore('sync_cursors').get([s.config.realm_id,s.config.vault_id]),row=>{
            s.cursor=row?.value??null;
            if(s.cursor&&(s.cursor.realm_id!==s.config!.realm_id||s.cursor.vault_id!==s.config!.vault_id||typeof s.cursor.server_epoch!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(s.cursor.server_epoch)))throw failure('storage_corrupt');
            if(s.cursor)decimalU64(s.cursor.after);
            read(tx,tx.objectStore('sync_state').get('authored-sequence'),counter=>{
              const sequence=decimalU64(counter?.value??'0');if([...orders].some(order=>BigInt(order)>BigInt(sequence)))throw failure('storage_corrupt');done(s);
            },abort,active);
          },abort,active);return;
        }
        const row=rows[index++],id=keyString(row),local=authored.get(id),envelope=envelopes.get(id);
        read(tx,tx.objectStore('sync_source_headers').get(key(row)),header=>{
          if(!header)throw failure('source_body_missing');
          const value=descriptor(header);
          if(!equals(value.record,row.record??null)||!equals(value.activity,row.activity??null)||!equals(value.summary_digest,row.summary_digest)||
            (!local&&!envelope)||(local&&!equals(local.metadata,value.metadata))||(envelope&&!equals(envelope.metadata,value.metadata))||
            (local?(local.sealed?envelope?.direction!=='authored':!!envelope):envelope?.direction!=='received'))throw failure('storage_corrupt');
          s.headers.set(id,header);
          read(tx,tx.objectStore('sync_source_payloads').getKey(key(row)),exists=>{
            if(exists===undefined)throw failure('source_body_missing');
            read(tx,tx.objectStore('sync_source_wires').getKey(key(row)),wire=>{
              if((wire!==undefined)!==!!envelope)throw failure('storage_corrupt');next();
            },abort,active);
          },abort,active);
        },abort,active);
      };next();
    }
  }

  const snapshot=async()=>{const result=await transact<Snapshot>('readonly',(tx,done,abort)=>capture(tx,done,abort));active();return result;};
  function enrolled(s:Snapshot):Configuration {if(!s.config||!s.head)throw failure('sync_not_enrolled');return s.config;}
  function state(s:Snapshot):StreamingMetadataState {
    const config=enrolled(s),builder=new host.wasm.WasmMetadataStateBuilder(stringify({realm_id:config.realm_id,vault_id:config.vault_id}),s.head!.version);
    let consumed=false;
    try{
      for(const row of s.records){const value=descriptor(s.headers.get(keyString(row))!);builder.restoreRecord(row.updateId,stringify(row.record),value.metadata.payload_bytes,digest(value.metadata.payload_digest),digest(value.summary_digest));}
      for(const row of s.activities){const value=descriptor(s.headers.get(keyString(row))!);builder.restoreActivity(row.updateId,stringify(row.activity),value.metadata.payload_bytes,digest(value.metadata.payload_digest),digest(value.summary_digest));}
      consumed=true;return rust(()=>builder.finish());
    }finally{if(!consumed)builder.free();}
  }
  async function exact(identity:SourceKey,kind:'payload'|'wire'):Promise<SourceRead> {
    active();const source=await transact<SourceRead>('readonly',(tx,done,abort)=>getExactSource(tx,identity,kind,value=>{if(!value){abort(failure('source_body_missing'));return;}done(value);},abort));active();descriptor(source.header);return source;
  }
  function pin(pins:Map<string,SourceHeader>,header:SourceHeader):void {
    const prior=pins.get(keyString(header));if(prior&&!equals(prior,header))throw failure('immutable_source_conflict');pins.set(keyString(header),copy(header));
  }
  async function verify(session:StreamingVerificationSession,pins:Map<string,SourceHeader>,overlays:Map<string,Emission>):Promise<StreamingVerifiedSet> {
    let consumed=false;
    try{for(;;){
      active();const raw=rust(()=>session.nextChunkJson());if(raw===undefined||raw===null)break;
      const request=boundedJson(raw,normalizedLimits.metadataRow),identity:SourceKey={realmId:request.scope.realm_id,vaultId:request.scope.vault_id,updateId:request.update_id};
      let payload:Uint8Array;const overlay=overlays.get(keyString(identity));
      if(overlay){payload=overlay.payload;}
      else {const source=await exact(identity,'payload');const value=descriptor(source.header);
        if(!equals(value.record,request.expected))throw failure('storage_corrupt');pin(pins,source.header);payload=source.bytes;}
      active();if(payload.byteLength>1024*1024)throw failure('sync_input_too_large');
      const chunk=rust(()=>session.providePayload(request.manifest_index,request.sequence,payload));
      if(chunk.byteLength>128*1024)throw failure('invalid_wasm_result');
    }
      active();consumed=true;return rust(()=>session.finish());
    }finally{if(!consumed)session.free();}
  }
  function sourceHeader(metadata:EnvelopeMetadata,record:Json|null,activity:Json|null,summary:number[]):SourceHeader {
    const value:StreamingSourceDescriptor={version:1,metadata:copy(metadata),record:copy(record),activity:copy(activity),summary_digest:copy(summary)};
    const header:SourceHeader={...sourceKey(metadata),descriptor:value as unknown as MetadataValue};descriptor(header);return header;
  }
  function fileMetadata(scope:SyncScope,id:string,record:Json):EnvelopeMetadata {
    return {key:{realm_id:scope.realm_id,vault_id:scope.vault_id,update_id:id},family:'files',format_version:2,payload_digest:record.payload_digest,payload_bytes:record.payload_bytes,text_binding:null};
  }
  function checkDelivery(s:Snapshot,delivery:SyncDelivery|undefined):void {
    if(!delivery)return;const config=enrolled(s);
    for(const cursor of [delivery.expected,delivery.next]){
      decimalU64(cursor.after);if(cursor.realm_id!==config.realm_id||cursor.vault_id!==config.vault_id||typeof cursor.server_epoch!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(cursor.server_epoch))throw failure('invalid_sync_cursor');
    }
    if(!equals(s.cursor,delivery.expected)||delivery.next.server_epoch!==delivery.expected.server_epoch||BigInt(delivery.next.after)!==BigInt(delivery.expected.after)+1n)throw failure('sync_cursor_conflict');
  }

  function persistedRow(row:StreamingRetainedRow):Json {
    return {...row,content:row.content?.kind==='text'?{kind:'text',metadata:row.content.metadata}:row.content};
  }
  function classifications(plan:StreamingMetadataPlan,texts:Map<string,Json>,s:Snapshot,forced:Json[]|undefined,revisions:Set<string>):StreamingRetainedRow[] {
    if(forced)for(const change of forced){const text=[...texts.values()].find(text=>text.identity.entry_id===change.after.id);
      if(text&&text.version!==change.after.revision){const next=boundedJson(rust(()=>host.wasm.rebindTextState(stringify(text),text.version,change.after.revision)),8*1024*1024);texts.set(textKey(next.identity),next);}}
    function run(rebind:boolean):StreamingRetainedRow[] {
      const result=rust(()=>plan.classify(stringify([...texts.values()]))),rows:StreamingRetainedRow[]=[];let textBytes=0,changed=false;
      try{const count=result.length();if(!Number.isInteger(count)||count<0||count>4096)throw failure('invalid_wasm_result');
        for(let index=0;index<count;index++){
          const classified=boundedJson(rust(()=>result.entryJson(index)),normalizedLimits.metadataRow),id=classified.identity.entry_id,outcome=classified.outcome;
          const previous=s.retained.get(id),fingerprint=stringify(classified);
          if(outcome.status!=='normal'){
            rows.push({id,status:outcome.status,fingerprint,entry:previous?.entry??null,presentation:previous?.presentation??null,
              content:previous?.content?.kind==='binary'?previous.content:null,reason:outcome});continue;
          }
          const timestamp=host.now();if(!Number.isSafeInteger(timestamp)||timestamp<0)throw failure('invalid_host_clock');
          let content:StreamingContent|null=null,bytesLength=0,revision:string;
          if(outcome.content?.kind==='text'){
            const metadata=outcome.content.content,bytes=rust(()=>result.textBytes(index));
            if(!(bytes instanceof Uint8Array)||bytes.byteLength>256*1024||String(bytes.byteLength)!==metadata.byte_length)throw failure('invalid_wasm_result');
            textBytes+=bytes.byteLength;if(textBytes>4*1024*1024)throw failure('sync_publication_budget_exceeded');
            const witness=metadata.witness,state=texts.get(textKey(witness.identity));
            if(!state||state.version!==witness.revision)throw failure('storage_corrupt');
            if(rebind&&previous&&previous.fingerprint!==fingerprint&&previous.entry?.revision===state.version){
              const nextRevision=fresh(),next=boundedJson(rust(()=>host.wasm.rebindTextState(stringify(state),state.version,nextRevision)),8*1024*1024);
              texts.set(textKey(next.identity),next);revisions.add(nextRevision);changed=true;
            }
            content={kind:'text',bytes,metadata};bytesLength=bytes.byteLength;revision=witness.revision;
          }else if(outcome.content?.kind==='binary'){
            const reference=outcome.content.content,length=BigInt(decimalU64(reference.manifest.bytes));
            if(length>64n*1024n*1024n)throw failure('invalid_wasm_result');
            content={kind:'binary',reference};bytesLength=Number(length);
            revision=previous?.fingerprint===fingerprint?previous.entry?.revision??fresh():fresh();
          }else{revision=previous?.fingerprint===fingerprint?previous.entry?.revision??fresh():fresh();}
          const forcedChange=forced?.find(change=>change.after.id===id);
          const entry:EntryState=forcedChange?copy(forcedChange.after):{id,path:outcome.path,kind:outcome.kind,deleted:false,revision};
          if(entry.deleted||entry.path!==outcome.path||entry.kind!==outcome.kind)throw failure('sync_projection_conflict');
          if(previous?.entry?.revision!==entry.revision)revisions.add(entry.revision);
          const presentation:BrowserVaultPresentation=previous?.fingerprint===fingerprint&&previous.presentation?copy(previous.presentation):{
            id,ctime_ms:previous?.presentation?.ctime_ms??timestamp,mtime_ms:timestamp,size_bytes:bytesLength};
          rows.push({id,status:'normal',fingerprint,entry,presentation,content,reason:outcome});
        }
      }finally{result.free();}
      return changed?run(false):rows;
    }
    return run(!forced);
  }
  async function finish(s:Snapshot,candidate:StreamingCandidate,emissions:Emission[],context:{updateId:string;incoming?:boolean;prior?:Uint8Array;delivery?:SyncDelivery;expectedText?:Json|null;incomingHeader?:SourceHeader;sourceKeys?:SourceKey[];initializeTexts?:boolean}):Promise<PreparedStreamingMutation> {
    const config=enrolled(s),pins=new Map(s.headers),overlays=new Map<string,Emission>();
    let plan:StreamingMetadataPlan|undefined,proof:StreamingVerifiedSet|undefined,candidateConsumed=false;
    try{
      for(const emission of emissions){assertScope(config,emission.metadata);overlays.set(keyString(sourceKey(emission.metadata)),emission);}
      proof=await verify(rust(()=>candidate.verificationSession()),pins,overlays);
      active();candidateConsumed=true;const consumedProof=proof;proof=undefined;plan=rust(()=>candidate.finalize(consumedProof));
      const output=boundedJson(rust(()=>plan!.resultJson())),sources:SourceInput[]=[];
      for(const field of ['record_delta_count','activity_delta_count','payload_count'])if(!Number.isInteger(output[field])||output[field]<0||output[field]>4096)throw failure('invalid_wasm_result');
      if(!Array.isArray(output.changes)||output.changes.length>4096||!Array.isArray(output.allocated_update_ids)||output.allocated_update_ids.length>4097)throw failure('invalid_wasm_result');
      const headers=new Map<string,SourceHeader>();
      for(let index=0;index<output.record_delta_count;index++){
        const delta=boundedJson(rust(()=>plan!.recordDeltaJson(index)),normalizedLimits.metadataRow),metadata=emissions.find(row=>row.metadata.key.update_id===delta.update_id)?.metadata??fileMetadata(config,delta.update_id,delta.record);
        const header=sourceHeader(metadata,delta.record,null,delta.summary_digest);headers.set(keyString(header),header);
      }
      for(let index=0;index<output.activity_delta_count;index++){
        const delta=boundedJson(rust(()=>plan!.activityDeltaJson(index)),128*1024),metadata=emissions.find(row=>row.metadata.key.update_id===delta.update_id)?.metadata??(context.incomingHeader?descriptor(context.incomingHeader).metadata:undefined);
        if(!metadata)throw failure('invalid_wasm_result');
        const header=sourceHeader(metadata,null,delta.activity,delta.summary_digest);headers.set(keyString(header),header);
      }
      if(context.incomingHeader){
        const expected=headers.get(keyString(context.incomingHeader));
        if(expected&&!equals(expected,context.incomingHeader))throw failure('storage_corrupt');
        headers.set(keyString(context.incomingHeader),context.incomingHeader);
      }
      for(const emission of emissions){
        const header=headers.get(keyString(sourceKey(emission.metadata)))??s.headers.get(keyString(sourceKey(emission.metadata)));
        if(!header||!equals(descriptor(header).metadata,emission.metadata))throw failure('invalid_wasm_result');
        rust(()=>host.wasm.validateAuthoredSyncPayload(stringify(emission.metadata),emission.payload));
        sources.push({header,payload:emission.payload,...(context.incoming?{wire:rust(()=>plan!.receivedWireBytes())}:{})});
      }
      const staged=new Set((context.sourceKeys??[]).map(keyString));
      for(const [id,header] of headers)if(!overlays.has(id)&&!s.headers.has(id)){
        if(!staged.delete(id))throw failure('binary_stage_source_mismatch');
        const actual=await transact<SourceHeader>('readonly',(tx,done,abort)=>read(tx,tx.objectStore('sync_source_headers').get(key(header)),value=>{if(!value)throw failure('source_body_missing');done(value);},abort,active));
        active();if(!equals(actual,header))throw failure('binary_stage_source_mismatch');pin(pins,actual);
      }
      if(staged.size)throw failure('binary_stage_source_mismatch');
      active();const texts=new Map(s.texts);if(output.next_text)texts.set(textKey(output.next_text.identity),output.next_text);
      const revisions=new Set<string>();
      const next=plan.nextState();if(next){try{
        revisions.add(boundedJson(next.metadataHeadJson()).version);
        if(context.initializeTexts){const view=boundedJson(next.namespaceViewJson(),128*1024*1024);
          for(const [entry,binding] of Object.entries(view.content_bindings) as [string,Json][])if(binding.kind==='text'){
            const identity={realm_id:config.realm_id,vault_id:config.vault_id,entry_id:entry,bootstrap_id:binding.text_bootstrap_id};
            if(!texts.has(textKey(identity))){const initial=boundedJson(rust(()=>host.wasm.createEmptyTextState(stringify({identity,version:fresh()}))),8*1024*1024);texts.set(textKey(identity),initial);revisions.add(initial.version);}
          }
        }
      }finally{next.free();}}
      if(output.next_text)revisions.add(output.next_text.version);
      const forced=context.incoming||!output.changes?.length?undefined:output.changes;
      for(const change of output.changes??[])revisions.add(change.after.revision);
      const rows=classifications(plan,texts,s,forced,revisions);
      const token:PreparedStreamingMutation=Object.freeze({changes:copy(output.changes??[]),dispose(){const value=prepared.get(token);if(value&&!value.used){value.used=true;value.plan.free();prepared.delete(token);}}});
      prepared.set(token,{snapshot:s,plan,result:output,rows,texts,sources,pins,prior:context.prior??new Uint8Array(),updateId:context.updateId,
        incoming:context.incoming??false,delivery:context.delivery,expectedText:context.expectedText??null,revisions:[...revisions],used:false});
      plan=undefined;return token;
    }finally{proof?.free();if(!candidateConsumed)candidate.free();plan?.free();}
  }
  function candidateEmissions(candidate:StreamingCandidate):Emission[] {
    try {
    const count=candidate.payloadCount();if(!Number.isInteger(count)||count<0||count>4096)throw failure('invalid_wasm_result');
    const emissions:Emission[]=[];let total=0;
    for(let index=0;index<count;index++){
      const metadata=boundedJson(rust(()=>candidate.payloadMetadataJson(index)),128*1024) as EnvelopeMetadata,payload=rust(()=>candidate.payloadBytes(index));
      if(!(payload instanceof Uint8Array)||payload.byteLength>1024*1024||(total+=payload.byteLength)>128*1024*1024)throw failure('invalid_wasm_result');
      emissions.push({metadata,payload});
    }return emissions;
    }catch(error){candidate.free();throw error;}
  }
  async function prepareLocal(input:StreamingLocalInput):Promise<PreparedStreamingMutation> {
    active();input=copy(input);const request=boundedJson(input.requestJson,4*1024*1024),canonical=rust(()=>host.wasm.validateFamilyCommand(input.familyCommandJson??stringify({version:1,request,create_mode:null}))),command=boundedJson(canonical,4*1024*1024);
    if(!equals(command.request,request))throw failure('family_command_mismatch');
    const s=await snapshot(),config=enrolled(s),graph=state(s);
    try{
      const text=request.mutation.type==='write'?[...s.texts.values()].find(text=>text.identity.entry_id===request.mutation.id)??null:null;
      const need=boundedJson(rust(()=>graph.mutationRequirements(stringify({command,entries:s.publication.entries,text}))));
      const graphRevision=fresh();let actor:number;do{actor=crypto.getRandomValues(new Uint32Array(1))[0];}while(text&&Object.hasOwn(text.actors,String(actor)));
      const allocation={metadata_revision:input.nextRevision,graph_revision:graphRevision,update_ids:Array.from({length:need.update_count},()=>fresh()),
        text:need.text==='none'?null:{actor:{actor,owner:{replica_id:config.replica_id,incarnation_id:config.incarnation_id}},new_text:need.text==='create'?{bootstrap_id:fresh(),empty_revision:fresh()}:null}};
      const candidate=rust(()=>graph.prepareMutation(stringify({command,entries:s.publication.entries,text,allocation})));
      return await finish(s,candidate,candidateEmissions(candidate),{updateId:allocation.update_ids[0],expectedText:text});
    }finally{graph.free();}
  }
  async function prepareBinary(input:StreamingBinaryInput):Promise<PreparedStreamingMutation> {
    const batch=input.batch,built=input.built;let graph:StreamingMetadataState|undefined,consumed=false;
    try{
      active();input={...input,target:copy(input.target),sourceKeys:copy(input.sourceKeys)};const s=await snapshot(),config=enrolled(s);graph=state(s);
      if(input.sourceKeys.some(identity=>identity.realmId!==config.realm_id||identity.vaultId!==config.vault_id)||new Set(input.sourceKeys.map(keyString)).size!==input.sourceKeys.length)throw failure('binary_stage_source_mismatch');
      const raw=stringify({entries:s.publication.entries,target:input.target,final_event_id:input.finalEventId,metadata_revision:input.metadataRevision,next_graph_revision:input.graphRevision});
      // wasm-bindgen consumes these by value even if the Rust call rejects.
      consumed=true;const candidate=rust(()=>graph!.prepareBinaryMutation(raw,batch,built));
      return await finish(s,candidate,candidateEmissions(candidate),{updateId:input.finalEventId,sourceKeys:input.sourceKeys});
    }finally{
      try{graph?.free();}catch{/* Cleanup must not mask a committed/prepared outcome. */}
      if(!consumed){try{batch.free();}catch{/* Preserve the original preparation failure. */}try{built.free();}catch{/* Both owned handles get a cleanup attempt. */}}
    }
  }

  function commitLocal(tx:IDBTransaction,token:PreparedStreamingMutation,current:StreamingPublication,done:(result:{sequence:string})=>void,abort:Abort):void {
    const value=prepared.get(token);
    if(!value||value.used){abort(failure('invalid_prepared_sync_plan'));return;}
    value.used=true;prepared.delete(token);
    let actualGraph:StreamingMetadataState|undefined;
    const close=()=>{actualGraph?.free();actualGraph=undefined;value.plan.free();};let closed=false;
    const release=()=>{if(!closed){closed=true;close();}};
    tx.addEventListener?.('abort',release,{once:true});tx.addEventListener?.('complete',release,{once:true});
    const reject:Abort=error=>{release();abort(error);};
    try{active();capture(tx,actual=>{
      try{
        if(!equals(actual.config,value.snapshot.config)||!equals(actual.publication,current)||!equals(actual.publication,value.snapshot.publication)||
          !equals([...actual.texts],[...value.snapshot.texts])||!equals([...actual.retained],[...value.snapshot.retained]))throw failure('sync_snapshot_conflict');
        checkDelivery(actual,value.delivery);
        const graph=state(actual),config=enrolled(actual);actualGraph=graph;
        const incomingKey:SourceKey={realmId:config.realm_id,vaultId:config.vault_id,updateId:value.updateId};
        read(tx,tx.objectStore('sync_source_wires').get(key(incomingKey)),wireRow=>{
          try{
            const prior=wireRow?.bytes??new Uint8Array();if(!(prior instanceof Uint8Array)||!sameBytes(prior,value.prior))throw failure('sync_update_collision');
            const updateIds:string[]=value.result.allocated_update_ids??[];let index=0;
            const checkIds=()=>{
              if(index===updateIds.length){checkRevisions();return;}
              const id=updateIds[index++];
              const identity=[config.realm_id,config.vault_id,id];
              read(tx,tx.objectStore('sync_source_headers').getKey(identity),exists=>{
                if(exists!==undefined&&!(value.pins.has(stringify(identity))&&!value.snapshot.headers.has(stringify(identity))))throw failure('sync_update_collision');
                read(tx,tx.objectStore('sync_authored').getKey(identity),authored=>{
                  if(authored!==undefined)throw failure('sync_update_collision');
                  read(tx,tx.objectStore('sync_envelopes').getKey(identity),received=>{if(received!==undefined)throw failure('sync_update_collision');checkIds();},reject,active);
                },reject,active);
              },reject,active);
            };
            let revisionIndex=0;
            const checkRevisions=()=>{
              if(revisionIndex===value.revisions.length){checkPins();return;}
              const revision=value.revisions[revisionIndex++];
              // A forced metadata revision can be shared by ancestors in this
              // same new plan, never by an earlier committed publication.
              read(tx,tx.objectStore('sync_revisions').getKey(revision),exists=>{if(exists!==undefined)throw failure('sync_revision_collision');checkRevisions();},reject,active);
            };
            const pins=[...value.pins.values()];let pinIndex=0;
            const checkPins=()=>{
              if(pinIndex===pins.length){checkPlan();return;}
              const expected=pins[pinIndex++];
              read(tx,tx.objectStore('sync_source_headers').get(key(expected)),header=>{
                if(!equals(header,expected))throw failure('immutable_source_conflict');
                read(tx,tx.objectStore('sync_source_payloads').getKey(key(expected)),exists=>{if(exists===undefined)throw failure('source_body_missing');checkPins();},reject,active);
              },reject,active);
            };
            const checkPlan=()=>{
              active();
              const actualText=value.expectedText?[...actual.texts.values()].find(text=>text.identity.entry_id===value.expectedText.identity.entry_id)??value.expectedText:null;
              rust(()=>value.plan.checkPreconditions(graph,stringify({entries:actual.publication.entries,text:actualText,allocated_ids_unused:true,cursor:actual.cursor}),prior));
              graph.free();actualGraph=undefined;writeSources();
            };
            checkIds();
          }catch(error){reject(error);}
        },reject,active);
      }catch(error){reject(error);}
    },reject);
    }catch(error){reject(error);}
    function writeSources():void {
      // The stage store and engine share one immutable-source quota. Promotion
      // of previously staged rows only changes graph/outbox membership.
      read(tx,tx.objectStore('control').get('binary-stream-usage:v1'),row=>{
        const usage=row?.value;
        if(!usage||usage.version!==1||!Number.isInteger(usage.stages)||usage.stages<0||usage.stages>4096||
          !Number.isInteger(usage.activeStages)||usage.activeStages<0||usage.activeStages>8||usage.activeStages>usage.stages||
          !Number.isInteger(usage.chunkRecords)||usage.chunkRecords<0||usage.chunkRecords>4096||
          !Number.isInteger(usage.pageRecords)||usage.pageRecords<0||usage.pageRecords>256||
          BigInt(decimalU64(usage.sourcePayloadBytes))>536870912n)throw failure('binary_usage_unavailable');
        const counters=copy(usage);let index=0;
        const next=()=>{
          if(index===value!.sources.length){tx.objectStore('control').put({key:'binary-stream-usage:v1',value:counters});writeDeltas();return;}
          const source=value!.sources[index++];
          read(tx,tx.objectStore('sync_source_headers').get(key(source.header)),header=>{
            read(tx,tx.objectStore('sync_source_payloads').getKey(key(source.header)),body=>{
              if((header===undefined)!==(body===undefined))throw failure(header===undefined?'storage_corrupt':'source_body_missing');
              const newPayload=body===undefined&&source.payload!==undefined,record=descriptor(source.header).record;
              const bytes=newPayload?BigInt(source.payload!.byteLength):0n,chunks=newPayload&&record?.body?.kind==='chunk'?1:0,pages=newPayload&&record?.body?.kind==='page'?1:0;
              if(BigInt(counters.sourcePayloadBytes)+bytes>536870912n||counters.chunkRecords+chunks>4096||counters.pageRecords+pages>256)throw failure('binary_quota_exceeded');
              addImmutableSource(tx,source,candidate=>{
                const meta=descriptor(candidate.header).metadata;
                if(candidate.payload)rust(()=>host.wasm.validateAuthoredSyncPayload(stringify(meta),candidate.payload!));
                if(candidate.wire)rust(()=>host.wasm.validateSyncWire(stringify(meta),candidate.wire!));
              },inserted=>{
                if(newPayload&&!inserted){reject(failure('storage_corrupt'));return;}
                counters.sourcePayloadBytes=String(BigInt(counters.sourcePayloadBytes)+bytes);counters.chunkRecords+=chunks;counters.pageRecords+=pages;next();
              },reject);
            },reject,active);
          },reject,active);
        };next();
      },reject,active);
    }
    function writeDeltas():void {
      const config=enrolled(value!.snapshot),records:Json[]=[],activities:Json[]=[];
      for(let index=0;index<value!.result.record_delta_count;index++){
        const row=boundedJson(rust(()=>value!.plan.recordDeltaJson(index)),normalizedLimits.metadataRow);
        records.push({realmId:config.realm_id,vaultId:config.vault_id,updateId:row.update_id,record:row.record,summary_digest:row.summary_digest});
      }
      for(let index=0;index<value!.result.activity_delta_count;index++){
        const row=boundedJson(rust(()=>value!.plan.activityDeltaJson(index)),128*1024);
        activities.push({realmId:config.realm_id,vaultId:config.vault_id,updateId:row.update_id,activity:row.activity,summary_digest:row.summary_digest});
      }
      let index=0;
      const next=()=>{
        if(index<records.length){addImmutableMetadata(tx,'sync_graph_records',records[index++],()=>next(),reject);return;}
        const position=index-records.length;
        if(position<activities.length){index++;addImmutableMetadata(tx,'sync_graph_activities',activities[position],()=>next(),reject);return;}
        writeHeaders();
      };next();
    }
    function writeHeaders():void {
      const config=enrolled(value!.snapshot),emissions=value!.sources.filter(source=>!value!.incoming),ids=value!.result.allocated_update_ids??[];
      for(const revision of value!.revisions)tx.objectStore('sync_revisions').add({revision});
      for(const [id,text] of value!.texts)if(!equals(value!.snapshot.texts.get(id),text))tx.objectStore('sync_text').put({key:id,state:text});
      const next=value!.plan.nextState();if(next){try{tx.objectStore('sync_state').put({key:streamingSyncKeys.head,value:boundedJson(rust(()=>next.metadataHeadJson()))});}finally{next.free();}}
      const incomingKey=[config.realm_id,config.vault_id,value!.updateId];
      if(value!.incoming&&value!.prior.byteLength===0){
        const meta=descriptor(value!.sources[0].header).metadata;
        tx.objectStore('sync_envelopes').add({key:incomingKey,metadata:meta,direction:'received'});
      }
      if(value!.delivery)tx.objectStore('sync_cursors').put({key:[config.realm_id,config.vault_id],value:value!.delivery.next});
      read(tx,tx.objectStore('sync_state').get('authored-sequence'),counter=>{
        let order=decimalU64(counter?.value??'0');
        // Staged chunk/page rows already have immutable source bodies, but are
        // admitted into outbox only in this same successful final transaction.
        const admitted=new Set<string>();
        const writeAuthored=(metadata:EnvelopeMetadata)=>{
          if(admitted.has(metadata.key.update_id))return;admitted.add(metadata.key.update_id);
          order=nextDecimalU64(order);tx.objectStore('sync_authored').add({key:[config.realm_id,config.vault_id,metadata.key.update_id],metadata,pending:1,order:order.padStart(20,'0'),sealed:false});
        };
        for(const id of ids){
          const identity=stringify([config.realm_id,config.vault_id,id]);
          const source=emissions.find(source=>source.header.updateId===id);
          const header=source?.header??value!.pins.get(identity);
          if(header)writeAuthored(descriptor(header).metadata);
          // An independently reserved Text bootstrap has no own envelope row.
        }
        if(emissions.some(source=>!admitted.has(source.header.updateId)))throw failure('invalid_wasm_result');
        tx.objectStore('sync_state').put({key:'authored-sequence',value:order});writePublications();
      },reject,active);
    }
    function writePublications():void {
      let index=0;
      const next=()=>{
        if(index===value!.rows.length){
          try{active();const result=host.publish(tx,value!.rows,{kind:value!.incoming?'received':'authored',update_id:value!.updateId},value!.incoming||!value!.result.changes?.length?undefined:value!.result.changes,current);
            if(!closed){closed=true;close();}done(result);
          }catch(error){reject(error);}return;
        }
        const row=value!.rows[index++],stored=persistedRow(row);
        putNormalizedMetadata(tx,'sync_materialization_refs',stored,()=>{
          if(row.status==='normal'&&row.entry){addImmutableMetadata(tx,'sync_publication_refs',{id:row.id,revision:row.entry.revision,row:stored},()=>next(),reject);}else next();
        },reject);
      };next();
    }
  }
  async function prepareReceive(updateId:string,wireInput:Uint8Array,keyInput:BrowserSyncKey,delivery?:SyncDelivery):Promise<PreparedStreamingMutation> {
    active();delivery=delivery?copy(delivery):undefined;if(!(wireInput instanceof Uint8Array)||wireInput.byteLength>1052720)throw failure('sync_input_too_large');
    const wire=wireInput.slice(),s=await snapshot(),config=enrolled(s);checkDelivery(s,delivery);
    const opened=rust(()=>keyInput.openSyncUpdate(stringify({realm_id:config.realm_id,vault_id:config.vault_id,update_id:updateId,key_epoch:config.key_epoch}),wire)) as unknown as StreamingOpenedUpdate;
    let ownedGraph:StreamingMetadataState|undefined;
    try{
      const graph=state(s);ownedGraph=graph;
      const metadata=boundedJson(opened.metadataJson(),128*1024) as EnvelopeMetadata;assertScope(config,metadata);
      if(metadata.key.update_id!==updateId)throw failure('sync_update_collision');
      const authenticated=boundedJson(opened.authenticatedDescriptorJson(),normalizedLimits.metadataRow),header=sourceHeader(metadata,authenticated.record??null,authenticated.activity??null,authenticated.summary_digest),payload=opened.exactPlaintext();
      const priorRow=await transact<Json>('readonly',(tx,done,abort)=>read(tx,tx.objectStore('sync_envelopes').get(key(header)),row=>done(row??null),abort,active));
      active();let prior:Uint8Array=new Uint8Array();if(priorRow){const retained=await exact(header,'wire');if(!equals(retained.header,header)||!sameBytes(retained.bytes,wire))throw failure('sync_update_collision');prior=retained.bytes;}
      const authored=await transact<Json>('readonly',(tx,done,abort)=>read(tx,tx.objectStore('sync_authored').get(key(header)),row=>done(row??null),abort,active));active();
      if(authored&&(!authored.sealed||!prior.byteLength))throw failure('sync_update_collision');
      let candidate:StreamingCandidate,expectedText:Json|null=null;
      if(metadata.family==='files')candidate=rust(()=>opened.prepareMetadataFile(graph,fresh(),prior));
      else{
        const binding=metadata.text_binding!;const identity={realm_id:config.realm_id,vault_id:config.vault_id,entry_id:binding.entry_id,bootstrap_id:binding.text_bootstrap_id};
        if(priorRow&&!s.texts.has(textKey(identity)))throw failure('storage_corrupt');
        expectedText=s.texts.get(textKey(identity))??boundedJson(rust(()=>host.wasm.createEmptyTextState(stringify({identity,version:fresh()}))),8*1024*1024);
        candidate=rust(()=>opened.prepareMetadataText(graph,stringify({state:expectedText,request:{expected_version:expectedText.version,next_version:fresh(),delivery:delivery??null},next_namespace_version:fresh(),cursor:s.cursor}),prior));
      }
      return await finish(s,candidate,[{metadata,payload}],{updateId,incoming:true,prior,delivery:delivery?copy(delivery):undefined,expectedText,incomingHeader:header});
    }finally{ownedGraph?.free();opened.free();}
  }

  function validateWire(keyInput:BrowserSyncKey,config:Configuration,metadata:EnvelopeMetadata,payload:Uint8Array,wire:Uint8Array):void {
    if(wire.byteLength>1052720)throw failure('sync_input_too_large');
    const opened=rust(()=>keyInput.openSyncUpdate(stringify({realm_id:config.realm_id,vault_id:config.vault_id,update_id:metadata.key.update_id,key_epoch:config.key_epoch}),wire));
    try{if(!equals(boundedJson(opened.metadataJson(),128*1024),metadata)||!opened.matchesPayload(payload))throw failure('sync_seal_mismatch');}finally{opened.free();}
  }
  function loadAuthored(tx:IDBTransaction,updateId:string,done:(value:{config:Configuration;row:Json;source:SourceRead})=>void,abort:Abort):void {
    read(tx,tx.objectStore('sync_state').get(streamingSyncKeys.configuration),configRow=>{
      const config=configRow?.value as Configuration;if(!config)throw failure('sync_not_enrolled');
      const identity:SourceKey={realmId:config.realm_id,vaultId:config.vault_id,updateId};
      read(tx,tx.objectStore('sync_authored').get(key(identity)),row=>{
        if(!row)throw failure('sync_update_not_found');
        getExactSource(tx,identity,'payload',source=>{try{if(!source||!equals(descriptor(source.header).metadata,row.metadata))throw failure('storage_corrupt');done({config,row,source});}catch(error){abort(error);}},abort);
      },abort,active);
    },abort,active);
  }
  async function seal(updateId:string,keyInput:BrowserSyncKey):Promise<Uint8Array> {
    active();const initial=await transact<{config:Configuration;row:Json;source:SourceRead}>('readonly',(tx,done,abort)=>loadAuthored(tx,updateId,done,abort));active();
    const {config,row,source}=initial;
    if(row.sealed){const retained=await exact(source.header,'wire');if(!equals(retained.header,source.header))throw failure('storage_corrupt');validateWire(keyInput,config,row.metadata,source.bytes,retained.bytes);return retained.bytes;}
    const header={envelope_version:1,purpose:'vault_update',suite:'xchacha20poly1305',realm_id:config.realm_id,vault_id:config.vault_id,update_id:updateId,key_epoch:config.key_epoch,
      origin_device_id:config.replica_id,document_format_version:1,required_features:[],optional_extensions:{}};
    const wire=rust(()=>keyInput.seal(stringify(header),source.bytes));validateWire(keyInput,config,row.metadata,source.bytes,wire);active();
    return transact<Uint8Array>('readwrite',(tx,done,abort)=>loadAuthored(tx,updateId,current=>{
      try{
        if(!equals(current.config,config)||!equals(current.row.metadata,row.metadata)||!equals(current.source.header,source.header)||!sameBytes(current.source.bytes,source.bytes))throw failure('sync_snapshot_conflict');
        if(current.row.sealed){getExactSource(tx,source.header,'wire',winner=>{try{if(!winner)throw failure('storage_corrupt');validateWire(keyInput,config,row.metadata,source.bytes,winner.bytes);done(winner.bytes);}catch(error){abort(error);}},abort);return;}
        read(tx,tx.objectStore('sync_source_wires').getKey(key(source.header)),existing=>{
          if(existing!==undefined)throw failure('sync_update_collision');
          addImmutableSource(tx,{header:source.header,wire},candidate=>{
            if(!candidate.payload)throw failure('source_body_missing');validateWire(keyInput,config,row.metadata,candidate.payload,wire);
          },()=>{
            active();tx.objectStore('sync_authored').put({...current.row,sealed:true});
            tx.objectStore('sync_envelopes').add({key:key(source.header),metadata:row.metadata,direction:'authored'});done(wire.slice());
          },abort);
        },abort,active);
      }catch(error){abort(error);}
    },abort));
  }
  const api:BrowserSync & {readonly concurrentPreparation:true}={
    concurrentPreparation:true,
    bindSession(guard){active();guard();return browserStreamingSync({...host,assertActive(){active();guard();}}).api;},
    enroll(input){const scope=copy(input);return transact<void>('readwrite',(tx,done,abort)=>capture(tx,s=>{
      try{
        if(!Number.isInteger(scope.key_epoch)||scope.key_epoch<1||scope.key_epoch>0xffffffff)throw failure('invalid_sync_epoch');
        if(s.config){if(!equals({realm_id:s.config.realm_id,vault_id:s.config.vault_id,key_epoch:s.config.key_epoch},scope))throw failure('sync_scope_conflict');done(undefined);return;}
        if(s.publication.entries.length||s.publication.sequence!=='0'||s.texts.size||s.records.length||s.activities.length)throw failure('sync_enrollment_requires_empty');
        read(tx,tx.objectStore('intents').openCursor(),intent=>{
          if(intent)throw failure('sync_enrollment_requires_empty');
          const version=fresh(),builder=new host.wasm.WasmMetadataStateBuilder(stringify({realm_id:scope.realm_id,vault_id:scope.vault_id}),version),graph=rust(()=>builder.finish());
          try{
            tx.objectStore('sync_state').add({key:streamingSyncKeys.configuration,value:{...scope,replica_id:fresh(),incarnation_id:fresh()}});
            tx.objectStore('sync_state').add({key:streamingSyncKeys.head,value:boundedJson(graph.metadataHeadJson())});
            tx.objectStore('sync_state').put({key:'authored-sequence',value:'0'});tx.objectStore('sync_revisions').add({revision:version});done(undefined);
          }finally{graph.free();}
        },abort,active);
      }catch(error){abort(error);}
    },abort));},
    async authorFile(raw){
      active();const payload=rust(()=>host.wasm.encodeFilePayload(raw));if(payload.byteLength>1024*1024)throw failure('sync_input_too_large');
      const s=await snapshot(),config=enrolled(s),graph=state(s),batch=new host.wasm.WasmAuthoredMetadataBatch(stringify({realm_id:config.realm_id,vault_id:config.vault_id}));
      let consumed=false;
      try{
        const reference=boundedJson(rust(()=>batch.pushPayload(payload)),normalizedLimits.metadataRow),metadata=fileMetadata(config,reference.update_id,reference.record);
        const existing=await transact<Json>('readonly',(tx,done,abort)=>read(tx,tx.objectStore('sync_authored').get(key(sourceKey(metadata))),row=>done(row??null),abort,active));
        active();if(existing){const retained=await exact(sourceKey(metadata),'payload');if(!sameBytes(retained.bytes,payload)||!equals(existing.metadata,metadata))throw failure('sync_update_collision');return stringify(metadata);}
        const candidate=rust(()=>graph.prepareAuthoredBatch(batch,fresh()));consumed=true;
        const token=await finish(s,candidate,[{metadata,payload}],{updateId:metadata.key.update_id,initializeTexts:true});
        try{await transact<{sequence:string}>('readwrite',(tx,done,abort)=>host.readPublication(tx,current=>commitLocal(tx,token,current,done,abort),abort));return stringify(metadata);}finally{token.dispose();}
      }finally{graph.free();if(!consumed)batch.free();}
    },
    async receive(updateId,wire,keyInput,delivery){
      const token=await prepareReceive(updateId,wire,keyInput,delivery),value=prepared.get(token)!;
      const duplicate=value.prior.byteLength>0;
      try{const result=await transact<{sequence:string}>('readwrite',(tx,done,abort)=>host.readPublication(tx,current=>commitLocal(tx,token,current,done,abort),abort));return {duplicate,sequence:result.sequence};}finally{token.dispose();}
    },
    setCursor(nextInput,expectedInput){const next=copy(nextInput),expected=copy(expectedInput);return transact<void>('readwrite',(tx,done,abort)=>capture(tx,s=>{
      try{
        const config=enrolled(s);decimalU64(next.after);
        if(next.realm_id!==config.realm_id||next.vault_id!==config.vault_id||typeof next.server_epoch!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(next.server_epoch))throw failure('invalid_sync_cursor');
        if(equals(s.cursor,next)){done(undefined);return;}
        if(!equals(s.cursor,expected)||next.after!=='0'||s.cursor?.server_epoch===next.server_epoch)throw failure('sync_cursor_conflict');
        tx.objectStore('sync_cursors').put({key:[config.realm_id,config.vault_id],value:next});done(undefined);
      }catch(error){abort(error);}
    },abort));},
    pending(limit){
      if(!Number.isInteger(limit)||limit<1||limit>1000)return Promise.reject(failure('invalid_sync_limit'));
      return transact('readonly',(tx,done,abort)=>{
        const rows:{metadata:EnvelopeMetadata;sealed:Uint8Array|null;accepted:boolean}[]=[];let metadataBytes=0,wireBytes=0;
        const cursor=tx.objectStore('sync_authored').index('by_pending_order').openCursor(IDBKeyRange.bound([1,''],[1,'\uffff']));
        read(tx,cursor,row=>{
          if(!row){done(rows);return;}
          const value=row.value;if(value.pending!==1||typeof value.order!=='string')throw failure('storage_corrupt');
          const length=textEncoder.encode(stringify(value.metadata)).byteLength;
          if(rows.length===limit||metadataBytes+length>1024*1024){done(rows);return;}
          metadataBytes+=length;
          if(!value.sealed){rows.push({metadata:copy(value.metadata),sealed:null,accepted:false});row.continue();return;}
          getExactSource(tx,sourceKey(value.metadata),'wire',source=>{try{
            if(!source||!equals(descriptor(source.header).metadata,value.metadata))throw failure('storage_corrupt');
            if(wireBytes+source.bytes.byteLength>8*1024*1024){done(rows);return;}
            wireBytes+=source.bytes.byteLength;rows.push({metadata:copy(value.metadata),sealed:source.bytes,accepted:false});row.continue();
          }catch(error){abort(error);}},abort);
        },abort,active);
      });
    },
    seal,
    acknowledge(updateId,wireInput){
      if(!(wireInput instanceof Uint8Array)||wireInput.byteLength>1052720)return Promise.reject(failure('sync_input_too_large'));
      const wire=wireInput.slice();return transact<void>('readwrite',(tx,done,abort)=>loadAuthored(tx,updateId,value=>{
        try{
          if(!value.row.sealed)throw failure('sync_ack_mismatch');
          getExactSource(tx,value.source.header,'wire',source=>{try{
            if(!source||!sameBytes(source.bytes,wire)||!equals(source.header,value.source.header))throw failure('sync_ack_mismatch');
            tx.objectStore('sync_authored').put({...value.row,pending:0});done(undefined);
          }catch(error){abort(error);}},abort);
        }catch(error){abort(error);}
      },abort));
    },
    async inspect(){const s=await snapshot();if(!s.config)return {scope:null,namespace:null,pending:[],cursor:null};const graph=state(s);try{
      const namespace=boundedJson(rust(()=>graph.namespaceViewJson()),128*1024*1024);
      return {scope:{realm_id:s.config.realm_id,vault_id:s.config.vault_id,key_epoch:s.config.key_epoch},namespace,pending:copy(namespace.namespace.pending),cursor:copy(s.cursor)};
    }finally{graph.free();}},
    async readRetained(id){
      const s=await snapshot(),row=s.retained.get(id);if(!row)return null;
      const graph=state(s);let proof:StreamingVerifiedSet|undefined,recovery:StreamingRecovery|undefined;
      try{
        proof=await verify(graph.verificationSession(),new Map(s.headers),new Map());active();
        recovery=rust(()=>graph.recoveryContent(proof!,stringify([...s.texts.values()]),id));
        const value=boundedJson(rust(()=>recovery!.metadataJson()),normalizedLimits.metadataRow);
        let bytes:Uint8Array|null=null,witness:Json=null,content:Json=null;
        if(value.status==='complete'&&value.content?.kind==='binary'){
          const reference=value.content.content;
          if(reference?.entry?.entry_id!==id||!equals(reference.scope,{realm_id:s.config!.realm_id,vault_id:s.config!.vault_id})||BigInt(decimalU64(reference.manifest?.bytes))>64n*1024n*1024n)throw failure('invalid_wasm_result');
          if(row.status==='normal'&&(row.content?.kind!=='binary'||!equals(row.content.reference,reference)))throw failure('storage_corrupt');
          witness={kind:'binary',event_id:reference.selected_event};content={kind:'binary_reference',reference:copy(reference)};
        }else if(value.status==='complete'&&value.content?.kind==='text'){
          const metadata=value.content.content,body=rust(()=>recovery!.textBytes()),retained=s.texts.get(textKey(metadata.witness?.identity));
          if(!(body instanceof Uint8Array)||body.byteLength>256*1024||String(body.byteLength)!==metadata.byte_length||
            metadata.witness?.kind!=='text'||metadata.witness.identity?.entry_id!==id||!retained||retained.version!==metadata.witness.revision)throw failure('invalid_wasm_result');
          if(row.status==='normal'&&(row.content?.kind!=='text'||!equals(row.content.metadata,metadata)))throw failure('storage_corrupt');
          bytes=body;witness={kind:'text',state:copy(retained)};content={kind:'text',...copy(metadata),bytes:body};
        }else if(value.status!=='pending')throw failure('invalid_wasm_result');
        else if(row.status==='normal'&&row.entry?.kind==='file')throw failure('storage_corrupt');
        return {...copy(row),bytes:row.status==='normal'?bytes:null,witness,recovery_content:content};
      }finally{recovery?.free();proof?.free();graph.free();}

    },
  };
  const reads=new WeakMap<PreparedStreamingRead|PreparedStreamingRecoveryRead,{snapshot:Snapshot;pins:Map<string,SourceHeader>;publicationRef:Json|null;kind:'published'|'recovery'}>();
  function readHandle(plan:StreamingBinaryReadPlan,reference:Json,revision:string):PreparedStreamingRead {
    let closed=false;const live=()=>{active();if(closed)throw failure('binary_read_closed');};
    const token:PreparedStreamingRead=Object.freeze({get reference(){return copy(reference);},revision,
      length(){live();return decimalU64(plan.length());},chunkCount(){live();return plan.chunkCount();},
      chunkJson(index:number){live();return plan.chunkJson(index);},
      verifyPayload(index:number,payload:Uint8Array){live();if(!(payload instanceof Uint8Array)||payload.byteLength>1024*1024)throw failure('sync_input_too_large');
        const bytes=rust(()=>plan.verifyPayload(index,payload));if(bytes.byteLength>128*1024)throw failure('invalid_wasm_result');return bytes;},
      dispose(){if(!closed){closed=true;reads.delete(token);plan.free();}},
    });return token;
  }
  async function prepareRead(input:StreamingReadInput):Promise<PreparedStreamingRead> {
    const request=copy(input),s=await snapshot(),graph=state(s);let proof:StreamingVerifiedSet|undefined;
    try{
      const row=s.retained.get(request.entryId),current=s.publication.entries.find(entry=>entry.id===request.entryId);
      let reference=request.reference;
      if(!reference){
        if(!row||row.status!=='normal'||row.content?.kind!=='binary'||!current||current.deleted)throw failure('binary_read_unavailable');
        if(request.expectedRevision!==undefined&&request.expectedRevision!==current.revision)throw failure('binary_read_revision_conflict');
        reference=copy(row.content.reference);
      }
      if(reference?.entry?.entry_id!==request.entryId||(request.expectedContentEvent!==undefined&&request.expectedContentEvent!==reference.selected_event))throw failure('binary_read_revision_conflict');
      const revision=request.reference?request.expectedRevision:current!.revision;
      if(typeof revision!=='string'||!revision)throw failure('binary_read_revision_conflict');
      let publicationRef:Json|null=null;
      if(request.reference){
        const published=await transact<Json>('readonly',(tx,done,abort)=>read(tx,tx.objectStore('sync_publication_refs').get([request.entryId,revision]),value=>done(value??null),abort,active));
        active();if(!published||published.id!==request.entryId||published.revision!==revision||published.row?.entry?.id!==request.entryId||
          published.row?.entry?.revision!==revision||published.row?.content?.kind!=='binary'||!equals(published.row.content.reference,reference))throw failure('binary_read_revision_conflict');
        publicationRef=published;
      }
      const pins=new Map(s.headers);proof=await verify(graph.verificationSession(),pins,new Map());active();
      const plan=rust(()=>graph.openBinaryRead(proof!,stringify(reference))),token=readHandle(plan,reference,revision);
      reads.set(token,{snapshot:s,pins,publicationRef,kind:'published'});return token;
    }finally{proof?.free();graph.free();}
  }
  function commitPinnedRead(tx:IDBTransaction,token:PreparedStreamingRead|PreparedStreamingRecoveryRead,kind:'published'|'recovery',current:StreamingPublication,done:()=>void,abort:Abort):void {
    const value=reads.get(token);if(!value||value.kind!==kind){abort(failure('invalid_prepared_binary_read'));return;}
    const reject:Abort=error=>{token.dispose();abort(error);};
    tx.addEventListener?.('abort',()=>token.dispose(),{once:true});
    capture(tx,actual=>{try{
      if(!equals(actual.config,value.snapshot.config)||!equals(actual.head,value.snapshot.head)||!equals(actual.records,value.snapshot.records)||
        !equals(actual.activities,value.snapshot.activities)||(kind==='recovery'&&(!equals([...actual.texts],[...value.snapshot.texts])||!equals([...actual.retained],[...value.snapshot.retained])))||!equals(actual.publication,current)||!equals(current,value.snapshot.publication))throw failure('sync_snapshot_conflict');
      const pins=[...value.pins.values()];let position=0;
      const next=()=>{
        if(position===pins.length){
          if(value.publicationRef){read(tx,tx.objectStore('sync_publication_refs').get([value.publicationRef.id,value.publicationRef.revision]),actual=>{
            if(!equals(actual,value.publicationRef))throw failure('binary_read_revision_conflict');active();reads.delete(token);done();
          },reject,active);}else{active();reads.delete(token);done();}return;
        }
        const expected=pins[position++];
        read(tx,tx.objectStore('sync_source_headers').get(key(expected)),header=>{
          if(!equals(header,expected))throw failure('immutable_source_conflict');
          read(tx,tx.objectStore('sync_source_payloads').getKey(key(expected)),exists=>{if(exists===undefined)throw failure('source_body_missing');next();},reject,active);
        },reject,active);
      };next();
    }catch(error){reject(error);}},reject);
  }
  function commitRead(tx:IDBTransaction,token:PreparedStreamingRead,current:StreamingPublication,done:()=>void,abort:Abort):void {
    commitPinnedRead(tx,token,'published',current,done,abort);
  }
  function commitRecoveryRead(tx:IDBTransaction,token:PreparedStreamingRecoveryRead,current:StreamingPublication,done:()=>void,abort:Abort):void {
    commitPinnedRead(tx,token,'recovery',current,done,abort);
  }
  async function prepareRecoveryRead(input:StreamingRecoveryReadInput):Promise<PreparedStreamingRecoveryRead> {
    const request=copy(input),s=await snapshot(),graph=state(s);let proof:StreamingVerifiedSet|undefined,recovery:StreamingRecovery|undefined,ownedPlan:StreamingBinaryReadPlan|undefined;
    try{
      if(!s.retained.has(request.entryId))throw failure('binary_recovery_read_unavailable');
      const pins=new Map(s.headers);proof=await verify(graph.verificationSession(),pins,new Map());active();
      recovery=rust(()=>graph.recoveryContent(proof!,stringify([...s.texts.values()]),request.entryId));
      const value=boundedJson(rust(()=>recovery!.metadataJson()),normalizedLimits.metadataRow);
      if(value.status!=='complete'||value.content?.kind!=='binary')throw failure('binary_recovery_read_unavailable');
      const reference=value.content.content;
      if(reference?.entry?.entry_id!==request.entryId||!equals(reference.scope,{realm_id:s.config!.realm_id,vault_id:s.config!.vault_id})||
        (request.expectedContentEvent!==undefined&&reference.selected_event!==request.expectedContentEvent)||(request.reference!==undefined&&!equals(request.reference,reference)))throw failure('binary_read_revision_conflict');
      ownedPlan=rust(()=>graph.openBinaryRead(proof!,stringify(reference)));const plan=ownedPlan;
      const witness:StreamingRecoveryReadWitness={kind:'current_retained',metadata_revision:s.head!.version,entry_id:request.entryId,selected_content_event:reference.selected_event};
      let closed=false;const live=()=>{active();if(closed)throw failure('binary_read_closed');};
      const token:PreparedStreamingRecoveryRead=Object.freeze({get reference(){return copy(reference);},get witness(){return copy(witness);},
        length(){live();return decimalU64(plan.length());},chunkCount(){live();return plan.chunkCount();},chunkJson(index:number){live();return plan.chunkJson(index);},
        verifyPayload(index:number,payload:Uint8Array){live();if(!(payload instanceof Uint8Array)||payload.byteLength>1024*1024)throw failure('sync_input_too_large');
          const bytes=rust(()=>plan.verifyPayload(index,payload));if(bytes.byteLength>128*1024)throw failure('invalid_wasm_result');return bytes;},
        dispose(){if(!closed){closed=true;reads.delete(token);plan.free();}},
      });
      reads.set(token,{snapshot:s,pins,publicationRef:null,kind:'recovery'});ownedPlan=undefined;return token;
    }finally{ownedPlan?.free();recovery?.free();proof?.free();graph.free();}
  }
  async function validate():Promise<void> {
    const s=await snapshot();if(!s.config)return;
    const graph=state(s);let proof:StreamingVerifiedSet|undefined,classification:StreamingClassification|undefined;
    try{
      // Decode every retained bounded CRDT, including hidden or dependency-pending
      // entries. Its partial visible bytes are discarded, never recovery proof.
      for(const text of s.texts.values()){
        let bytes:Uint8Array;try{bytes=host.wasm.materializeTextState(stringify(text));}catch{throw failure('storage_corrupt');}
        if(!(bytes instanceof Uint8Array)||bytes.byteLength>256*1024)throw failure('storage_corrupt');
      }
      proof=await verify(graph.verificationSession(),new Map(s.headers),new Map());active();
      classification=rust(()=>graph.classify(proof!,stringify([...s.texts.values()])));
      const count=classification.length();if(!Number.isInteger(count)||count<0||count>4096||count!==s.retained.size)throw failure('storage_corrupt');
      const visible=new Map(s.publication.entries.map(entry=>[entry.id,entry])),stats=new Map(s.publication.presentation.map(row=>[row.id,row]));
      const history:{id:string;revision:string;row:Json}[]=[],revisions=new Set<string>([s.head!.version,...[...s.texts.values()].map(text=>text.version)]);
      let totalTextBytes=0;
      for(let index=0;index<count;index++){
        const classified=boundedJson(rust(()=>classification!.entryJson(index)),normalizedLimits.metadataRow),id=classified.identity?.entry_id,outcome=classified.outcome,row=s.retained.get(id);
        if(!row||row.id!==id||row.status!==outcome?.status||row.fingerprint!==stringify(classified)||!equals(row.reason,outcome))throw failure('storage_corrupt');
        if(outcome.status!=='normal'){
          if(visible.has(id))throw failure('storage_corrupt');
          if(row.entry){
            if(row.entry.id!==id||!row.presentation||row.presentation.id!==id||row.content?.kind==='text')throw failure('storage_corrupt');
            revisions.add(row.entry.revision);history.push({id,revision:row.entry.revision,row});
          }else if(row.presentation||row.content)throw failure('storage_corrupt');
          continue;
        }
        const entry=visible.get(id),presentation=stats.get(id);
        if(!entry||!equals(entry,row.entry)||!equals(presentation,row.presentation)||entry.id!==id||entry.deleted||entry.path!==outcome.path||entry.kind!==outcome.kind)throw failure('storage_corrupt');
        let bytesLength=0;
        if(outcome.content?.kind==='binary'){
          if(row.content?.kind!=='binary'||!equals(row.content.reference,outcome.content.content))throw failure('storage_corrupt');
          const length=BigInt(decimalU64(outcome.content.content.manifest.bytes));if(length>64n*1024n*1024n)throw failure('invalid_wasm_result');bytesLength=Number(length);
        }else if(outcome.content?.kind==='text'){
          const metadata=outcome.content.content,bytes=rust(()=>classification!.textBytes(index));
          if(row.content?.kind!=='text'||!equals(row.content.metadata,metadata)||!(bytes instanceof Uint8Array)||bytes.byteLength>256*1024||String(bytes.byteLength)!==metadata.byte_length||
            metadata.witness?.revision!==entry.revision||!s.texts.has(textKey(metadata.witness?.identity)))throw failure('storage_corrupt');
          totalTextBytes+=bytes.byteLength;if(totalTextBytes>4*1024*1024)throw failure('sync_publication_budget_exceeded');bytesLength=bytes.byteLength;
        }else if(row.content!==null||entry.kind!=='folder')throw failure('storage_corrupt');
        if(!presentation||presentation.size_bytes!==bytesLength)throw failure('storage_corrupt');
        visible.delete(id);stats.delete(id);revisions.add(entry.revision);history.push({id,revision:entry.revision,row});
      }
      if(visible.size||stats.size)throw failure('storage_corrupt');
      await transact<void>('readonly',(tx,done,abort)=>capture(tx,actual=>{
        try{
          if(!equals(actual.config,s.config)||!equals(actual.head,s.head)||!equals(actual.records,s.records)||!equals(actual.activities,s.activities)||
            !equals([...actual.texts],[...s.texts])||!equals([...actual.retained],[...s.retained])||!equals(actual.publication,s.publication))throw failure('sync_snapshot_conflict');
          const expected=[...revisions];let position=0,historyPosition=0;
          const nextHistory=()=>{
            if(historyPosition===history.length){done();return;}
            const row=history[historyPosition++];
            read(tx,tx.objectStore('sync_publication_refs').get([row.id,row.revision]),stored=>{
              if(!stored||stored.id!==row.id||stored.revision!==row.revision||stored.row?.status!=='normal'||
                (row.row.status==='normal'?!equals(stored,row):(!equals(stored.row.entry,row.row.entry)||!equals(stored.row.presentation,row.row.presentation)||(row.row.content?.kind==='binary'?!equals(stored.row.content,row.row.content):stored.row.content?.kind==='binary'))))throw failure('storage_corrupt');nextHistory();
            },abort,active);
          };
          const nextRevision=()=>{
            if(position===expected.length){nextHistory();return;}
            const revision=expected[position++];if(typeof revision!=='string'||!revision)throw failure('storage_corrupt');
            read(tx,tx.objectStore('sync_revisions').getKey(revision),exists=>{if(exists===undefined)throw failure('storage_corrupt');nextRevision();},abort,active);
          };nextRevision();
        }catch(error){abort(error);}
      },abort));active();
    }finally{classification?.free();proof?.free();graph.free();}
  }
  return {api,prepareLocal,prepareBinary,commitLocal,prepareRead,commitRead,prepareRecoveryRead,commitRecoveryRead,validate};
}
