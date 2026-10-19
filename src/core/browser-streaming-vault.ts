import { browserManagedKeyPaths, browserManagedIndexes, createBrowserManagedSchema } from './browser-managed-records.ts';
import type { BrowserStreamingManagedRecords } from './browser-sync-streaming.ts';
import {createBrowserDocumentIndexBackend} from './browser-document-index.ts';
import type {BrowserDocumentIndexMaintenance} from './browser-document-runtime.ts';
import type {BrowserDocumentIndex,BrowserDocumentIndexWasm} from './browser-document-index.ts';
import {createBrowserBinaryStageStore} from './browser-binary-stage-store.ts';
import type {BrowserBinaryStageWasm,BrowserBinaryStageStore,BrowserBinaryUsage} from './browser-binary-stage-store.ts';
import type {BinaryStreams,BinaryStageRef,BinaryReadRef} from './binary-streams.ts';
import {BrowserVaultError} from './browser-vault.ts';
import type {BrowserVault,BrowserVaultOptions,BrowserVaultRead,BrowserVaultIntent,BrowserVaultOutcome,EntryState,BrowserVaultPresentation} from './browser-vault.ts';
import {browserCheckpoints} from './browser-checkpoints.ts';
import {browserNormalizedKeyPaths,browserNormalizedStores,createBrowserNormalizedSchema,normalizedTransact,nextDecimalU64,decimalU64,getExactSource} from './browser-normalized-idb.ts';
import {browserStreamingSync,browserStreamingSyncKeyPaths,browserStreamingSyncStores} from './browser-sync-streaming.ts';
import type {BrowserStreamingSyncHost,BrowserStreamingWasm,StreamingPublication,StreamingRetainedRow,PreparedStreamingMutation,PreparedStreamingRead,PreparedStreamingRecoveryRead,StreamingRecoveryReadInput} from './browser-sync-streaming.ts';

/** Fresh development format; the old database is rejected and retained, never
 * adopted, cleared or silently rebound to an empty logical vault. */
const VERSION=8,metadataBudget=128*1024*1024,textFileBudget=256*1024,textTotalBudget=4*1024*1024,receiptBudget=24*1024;
const basePaths:Record<string,string|string[]>={metadata:'id',content:'id',receipts:'operation_id',journal:'sequence',control:'key',presentation:'id',intents:['client_id','intent_id'],checkpoint_heads:['clientId','key'],checkpoint_revisions:['clientId','revision']};
const stores=[...Object.keys(basePaths),...browserStreamingSyncStores];
const fail=(code:string,message='Browser streaming authority could not complete the operation')=>new BrowserVaultError(code,message);
const same=(a:any,b:any):boolean=>{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const left=Object.keys(a).sort(),right=Object.keys(b).sort();return left.length===right.length&&left.every((key,index)=>key===right[index]&&same(a[key],b[key]));};
const encoded=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const operationId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
function core<T>(action:()=>string):T{
  let raw:string;try{raw=action();}catch(error){let code='rust_input_rejected';try{const parsed=JSON.parse(String(error));if(typeof parsed.code==='string')code=parsed.code;}catch{}throw new BrowserVaultError(code,'Shared Rust planner rejected the operation',undefined,'rust');}
  try{return JSON.parse(raw);}catch{throw fail('invalid_wasm_result');}
}
export interface BrowserRecoveryReadRef {pinId:string;entryId:string;reference:any;witness:PreparedStreamingRecoveryRead['witness'];length:string}
export interface BrowserStreamingVault extends BrowserVault {
  readonly documentIndex?:BrowserDocumentIndex;
  /** Internal lazy host maintenance; no Worker completion/control endpoint. */
  readonly documentMaintenance?:BrowserDocumentIndexMaintenance;
  /** Internal trusted host seam; no public worker registration endpoint. */
  readonly managedRecords?:BrowserStreamingManagedRecords;
  openRecoveryBinaryRead(requestedReadId:string,input:StreamingRecoveryReadInput):Promise<BrowserRecoveryReadRef>;
  readRecoveryBinaryRange(ref:BrowserRecoveryReadRef,input:{offset:string;maxBytes:number}):ReturnType<BinaryStreams['read']>;
  closeRecoveryBinaryRead(ref:BrowserRecoveryReadRef):Promise<void>;
  validateStorage():Promise<void>;
  binaryStreams():Promise<BinaryStreams>;
  openBinaryRead(requestedReadId:string,input:Parameters<BinaryStreams['openRead']>[0]):Promise<BinaryReadRef>;
  cleanupReadPins():Promise<void>;
  closeBinaryReadRequest(requestedReadId:string,input:Parameters<BinaryStreams['openRead']>[0]):Promise<void>;
  readMetadata(path:string):Promise<BrowserVaultRead|null>;
  readMetadataById(id:string):Promise<BrowserVaultRead|null>;
}
export interface BrowserStreamingVaultOptions extends Omit<BrowserVaultOptions,'wasm'> {
  wasm:BrowserVaultOptions['wasm']&BrowserStreamingWasm&BrowserBinaryStageWasm;
  /** Worker installs this closure before any admitted operation or recovery. */
  assertActive():void;
  clientId:string;
  /** Trusted internal host key supplier for retained managed-record retry. */
  managedRecordsSession?:BrowserStreamingSyncHost['recordsSession'];
}
export async function openBrowserStreamingVault(options:BrowserStreamingVaultOptions):Promise<BrowserStreamingVault>{
  const {name,wasm,now=Date.now}=options;
  if(!operationId(options.clientId))throw fail('invalid_client_identity');
  if(!name.startsWith('zorid-core-vault:')||name.length>240)throw fail('invalid_database_name');
  let closed=false;
  const active=()=>{if(closed)throw fail('storage_closed');options.assertActive();};
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    let failure:unknown,rejected=false;const opening=indexedDB.open(name,VERSION);
    opening.onupgradeneeded=event=>{try{
      if(event.oldVersion!==0)throw fail('storage_schema_mismatch','Existing vault format requires an explicit verified conversion; its original data remains retained');
      const database=opening.result;
      for(const [store,keyPath] of Object.entries(basePaths))database.createObjectStore(store,{keyPath});
      const tx=opening.transaction!,control=tx.objectStore('control');
      for(const [key,value] of Object.entries({'local-store-id':crypto.randomUUID(),sequence:'0','intent-sequence':'0','checkpoint-sequence':'0'}))control.add({key,value});
      control.add({key:'binary-stream-usage:v1',value:{version:1,stages:0,activeStages:0,sourcePayloadBytes:'0',chunkRecords:0,pageRecords:0}});
      tx.objectStore('metadata').createIndex('by_path','path');
      tx.objectStore('intents').createIndex('by_operation','operation_id',{unique:true});
      const revisions=tx.objectStore('checkpoint_revisions');
      revisions.createIndex('by_key',['clientId','key','order']);revisions.createIndex('by_sequence',['clientId','order'],{unique:true});
      revisions.createIndex('by_global_sequence','order',{unique:true});revisions.createIndex('by_creation',['clientId','creationOrder'],{unique:true});
      for(const [store,keyPath] of Object.entries(browserStreamingSyncKeyPaths))database.createObjectStore(store,{keyPath});
      tx.objectStore('sync_authored').createIndex('by_pending_order',['pending','order']);
      tx.objectStore('sync_state').add({key:'authored-sequence',value:'0'});
      createBrowserNormalizedSchema(database);
      createBrowserManagedSchema(database);
      tx.objectStore('binary_reads').createIndex('by_pin',['clientId','pinId'],{unique:true});
      tx.objectStore('binary_reads').createIndex('by_active','active');
    }catch(error){failure=error;opening.transaction!.abort();}};
    opening.onerror=()=>reject(failure??opening.error??fail('storage_failure'));
    opening.onblocked=()=>{rejected=true;reject(fail('storage_blocked'));};
    opening.onsuccess=()=>{if(rejected){opening.result.close();return;}try{
      const database=opening.result;
      if(database.version!==VERSION||!same(Array.from(database.objectStoreNames).sort(),[...stores].sort()))throw fail('storage_schema_mismatch');
      const tx=database.transaction(stores,'readonly');
      for(const [store,path] of Object.entries({...basePaths,...browserStreamingSyncKeyPaths,...browserNormalizedKeyPaths,...browserManagedKeyPaths})){
        const object=tx.objectStore(store);if(!same(object.keyPath,path)||object.autoIncrement)throw fail('storage_schema_mismatch');
        const managedIndexes=browserManagedIndexes[store as keyof typeof browserManagedIndexes]??[];
        const expected=managedIndexes.length?managedIndexes.map(index=>index.name):store==='metadata'?['by_path']:store==='intents'||store==='binary_stages'?['by_operation']:store==='binary_reads'?['by_active','by_pin']:store==='sync_authored'?['by_pending_order']:store==='checkpoint_revisions'?['by_creation','by_global_sequence','by_key','by_sequence']:[];
        if(!same(Array.from(object.indexNames).sort(),expected))throw fail('storage_schema_mismatch');
        const indexPaths:Record<string,[string|string[],boolean]>={
          ...Object.fromEntries(managedIndexes.map(index=>[index.name,[[...index.keyPath],index.unique]])),
          ...(store==='binary_reads'?{by_pin:[['clientId','pinId'],true] as [string[],boolean],by_active:['active',false] as [string,boolean]}:{}),
          ...(store==='metadata'?{by_path:['path',false] as [string,boolean]}:{}),
          ...(store==='intents'?{by_operation:['operation_id',true] as [string,boolean]}:{}),
          ...(store==='binary_stages'?{by_operation:[['clientId','operationId'],true] as [string[],boolean]}:{}),
          ...(store==='sync_authored'?{by_pending_order:[['pending','order'],false] as [string[],boolean]}:{}),
          ...(store==='checkpoint_revisions'?{by_key:[['clientId','key','order'],false] as [string[],boolean],by_sequence:[['clientId','order'],true] as [string[],boolean],by_global_sequence:['order',true] as [string,boolean],by_creation:[['clientId','creationOrder'],true] as [string[],boolean]}:{}),
        };
        for(const [indexName,[keyPath,unique]] of Object.entries(indexPaths)){const index=object.index(indexName);if(!same(index.keyPath,keyPath)||index.unique!==unique||index.multiEntry)throw fail('storage_schema_mismatch');}
      }
      resolve(database);
    }catch(error){opening.result.close();reject(error);}};
  });
  const close=()=>{closed=true;db.close();};db.onversionchange=close;db.onclose=()=>{closed=true;};
  // Opening the authority is read-only and precedes the worker lifetime lease.
  const authorityId=await new Promise<string>((resolve,reject)=>{const tx=db.transaction(['control'],'readonly'),read=tx.objectStore('control').get('local-store-id');let value:string;
    read.onsuccess=()=>{value=read.result?.value;if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))tx.abort();};tx.onabort=()=>reject(fail('storage_corrupt'));tx.oncomplete=()=>resolve(value);
  }).catch(error=>{close();throw error;});
  const transact=<T>(mode:IDBTransactionMode,start:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void)=>void)=>normalizedTransact(db,{authorityId,stores,mode,assertActive:active},start);
  const on=<T>(request:IDBRequest<T>,callback:(value:T)=>void,abort:(error:unknown)=>void)=>{request.onsuccess=()=>{try{active();callback(request.result);}catch(error){abort(error);}};};
  function rows<T>(tx:IDBTransaction,store:string,done:(values:T[])=>void,abort:(error:unknown)=>void):void{
    const result:T[]=[];let bytes=0;const read=tx.objectStore(store).openCursor();on(read,function next(cursor){if(!cursor){done(result);return;}
      const value=cursor.value;bytes+=encoded(value);if(bytes>metadataBudget)throw fail('storage_metadata_too_large');result.push(value);cursor.continue();},abort);
  }
  function readPublication(tx:IDBTransaction,done:(current:StreamingPublication)=>void,abort:(error:unknown)=>void):void{
    let entries:EntryState[]|undefined,presentation:BrowserVaultPresentation[]|undefined,sequence:string|undefined;
    const finish=()=>{if(!entries||!presentation||sequence===undefined)return;
      wasm.validateSnapshot(JSON.stringify(entries));const byId=new Map(presentation.map(row=>[row.id,row]));
      if(byId.size!==presentation.length||entries.length!==presentation.length)throw fail('storage_corrupt');
      for(const entry of entries){const stat=byId.get(entry.id);if(!stat||![stat.ctime_ms,stat.mtime_ms,stat.size_bytes].every(value=>Number.isSafeInteger(value)&&value>=0)||entry.kind==='folder'&&stat.size_bytes!==0)throw fail('storage_corrupt');}
      done({entries,presentation,sequence});};
    rows<EntryState>(tx,'metadata',value=>{entries=value;finish();},abort);rows<BrowserVaultPresentation>(tx,'presentation',value=>{presentation=value;finish();},abort);
    on(tx.objectStore('control').get('sequence'),row=>{sequence=decimalU64(row?.value);finish();},abort);
  }
  const engine=browserStreamingSync({db,authorityId,wasm,now,assertActive:active,recordsSession:options.managedRecordsSession,readPublication,publish(tx,retained,origin,forced,current){
    const visible=retained.filter(row=>row.status==='normal'),next:EntryState[]=visible.map(row=>{if(!row.entry||!row.presentation)throw fail('storage_corrupt');return row.entry;});
    wasm.validateSnapshot(JSON.stringify(next));const previous=new Map(current.entries.map(entry=>[entry.id,entry]));
    const changes:{before:EntryState|null;after:EntryState|null}[]=[];
    for(const row of visible){const before=previous.get(row.id)??null;if(!same(before,row.entry))changes.push({before,after:row.entry});previous.delete(row.id);}
    for(const before of previous.values())changes.push({before,after:null});
    if(forced){const expected=forced.map(change=>({before:change.before,after:change.after.deleted?null:change.after}));const order=(items:typeof changes)=>[...items].sort((a,b)=>(a.after?.id??a.before!.id).localeCompare(b.after?.id??b.before!.id));if(!same(order(changes),order(expected)))throw fail('sync_projection_conflict');}
    let textBytes=0;for(const row of visible){
      if(row.entry!.kind==='file'&&!row.content)throw fail('storage_corrupt');
      if(row.content?.kind==='text'){if(!(row.content.bytes instanceof Uint8Array)||row.content.bytes.length>textFileBudget)throw fail('text_output_limit');textBytes+=row.content.bytes.length;if(textBytes>textTotalBudget)throw fail('text_output_limit');}
      tx.objectStore('metadata').put(row.entry!);tx.objectStore('presentation').put(row.presentation!);
      if(row.content?.kind==='text')tx.objectStore('content').put({id:row.id,bytes:row.content.bytes});else tx.objectStore('content').delete(row.id);
    }
    for(const {before,after} of changes)if(!after&&before){tx.objectStore('metadata').delete(before.id);tx.objectStore('presentation').delete(before.id);tx.objectStore('content').delete(before.id);}
    if(forced||!changes.length)return{sequence:current.sequence};const sequence=nextDecimalU64(current.sequence);
    tx.objectStore('journal').add({sequence,origin:{kind:'sync',direction:origin.kind,update_id:origin.update_id},changes});tx.objectStore('control').put({key:'sequence',value:sequence});return{sequence};
  }});
  function intentKey(clientId:string,intentId:string):[string,string]{if(!operationId(clientId)||!operationId(intentId))throw fail('invalid_intent_identity');return[clientId,intentId];}
  function metadataById(tx:IDBTransaction,id:string,done:(row:BrowserVaultRead|null)=>void,abort:(error:unknown)=>void):void{
    on(tx.objectStore('metadata').get(id),entry=>{
      if(!entry||entry.deleted){done(null);return;}
      on(tx.objectStore('presentation').get(id),presentation=>{if(!presentation||presentation.id!==id)throw fail('storage_corrupt');if(entry.id!==id||!operationId(entry.revision)||!['file','folder'].includes(entry.kind)||typeof entry.path!=='string'||!entry.path||![presentation.ctime_ms,presentation.mtime_ms,presentation.size_bytes].every(value=>Number.isSafeInteger(value)&&value>=0))throw fail('storage_corrupt');done({entry,presentation});},abort);
    },abort);
  }
  const readMetadataById=(id:string)=>transact<BrowserVaultRead|null>('readonly',(tx,done,abort)=>metadataById(tx,id,done,abort));
  const readMetadata=(path:string)=>transact<BrowserVaultRead|null>('readonly',(tx,done,abort)=>{
    let found:EntryState|undefined;on(tx.objectStore('metadata').index('by_path').openCursor(IDBKeyRange.only(path)),cursor=>{
      if(cursor){const entry=cursor.value as EntryState;if(!entry.deleted){if(found)throw fail('storage_corrupt');found=entry;}cursor.continue();return;}
      if(!found){done(null);return;}metadataById(tx,found.id,done,abort);
    },abort);
  });
  // Installed below by the pinned-read authority; never a fallback to full graph bytes.
  let readBinarySmall: (id:string)=>Promise<Uint8Array>=async()=>{throw fail('binary_streams_unavailable');};
  async function withBody(row:BrowserVaultRead|null):Promise<BrowserVaultRead|null>{
    if(!row||row.entry.kind==='folder')return row;
    const inline=await transact<Uint8Array|undefined>('readonly',(tx,done,abort)=>on(tx.objectStore('content').get(row.entry.id),body=>{
      if(!body){done(undefined);return;}if(!(body.bytes instanceof Uint8Array)||body.bytes.length>textFileBudget)throw fail('storage_corrupt');done(body.bytes.slice());
    },abort));
    const bytes=inline??await readBinarySmall(row.entry.id);
    // Metadata and content must remain one revision; a concurrent replacement is
    // an explicit conflict rather than a mixed observation for text-save CAS.
    const current=await readMetadataById(row.entry.id);
    if(!current||current.entry.revision!==row.entry.revision||current.entry.path!==row.entry.path||bytes.length!==row.presentation.size_bytes)throw fail('revision_conflict');
    return {...row,bytes};
  }
  const readIntents=(clientId:string)=>transact<BrowserVaultIntent[]>('readonly',(tx,done,abort)=>{
    intentKey(clientId,'lookup');const result:BrowserVaultIntent[]=[];on(tx.objectStore('intents').openCursor(IDBKeyRange.bound([clientId,''],[clientId,'\uffff'])),cursor=>{
      if(!cursor){result.sort((a,b)=>BigInt(a.order)<BigInt(b.order)?-1:BigInt(a.order)>BigInt(b.order)?1:0);done(result);return;}
      const row=cursor.value as BrowserVaultIntent;intentKey(row.client_id,row.intent_id);decimalU64(row.order);
      if(row.client_id!==clientId||!['prepared','commit_requested','committed','rejected'].includes(row.status)||typeof row.acknowledged!=='boolean'||!row.request_json||row.status==='committed'&&!row.receipt||row.status==='rejected'&&!row.error)throw fail('storage_corrupt');
      const request=JSON.parse(row.request_json);if(request.operation_id!==row.operation_id)throw fail('storage_corrupt');core(()=>wasm.checkIdempotency(`{"request":${row.request_json},"record":null}`));
      if(row.family_command_json!==undefined){const command=core<any>(()=>wasm.validateFamilyCommand(row.family_command_json!));if(!same(command.request,request))throw fail('storage_corrupt');}
      if(row.status==='committed')core(()=>wasm.checkIdempotency(JSON.stringify({request,record:{request,result:JSON.parse(row.receipt!)}})));
      result.push(row);cursor.continue();
    },abort);
  });
  const prepareIntent=async(clientId:string,intentId:string,requestJson:string,familyCommandJson?:string):Promise<void>=>{
    const key=intentKey(clientId,intentId);if(typeof requestJson!=='string'||new TextEncoder().encode(requestJson).length>4*1024*1024)throw fail('request_limit');
    core(()=>wasm.checkIdempotency(`{"request":${requestJson},"record":null}`));const request=JSON.parse(requestJson);
    if(familyCommandJson!==undefined){const canonical=core<any>(()=>wasm.validateFamilyCommand(familyCommandJson!));if(!same(canonical.request,request))throw fail('intent_conflict');familyCommandJson=JSON.stringify(canonical);}
    await transact<void>('readwrite',(tx,done,abort)=>{
      const intents=tx.objectStore('intents');let previous:any,owner:any,receipt:any,loaded=0;
      const ready=()=>{if(++loaded!==3)return;
        if(owner&&(owner.client_id!==clientId||owner.intent_id!==intentId)||receipt&&!owner)throw fail('intent_operation_owned');
        if(previous){if(previous.request_json!==requestJson||previous.family_command_json!==familyCommandJson)throw fail('intent_conflict');done();return;}
        on(tx.objectStore('control').get('intent-sequence'),row=>{const order=nextDecimalU64(row?.value);intents.add({client_id:clientId,intent_id:intentId,operation_id:request.operation_id,request_json:requestJson,...(familyCommandJson===undefined?{}:{family_command_json:familyCommandJson}),order,acknowledged:false,status:'prepared'});tx.objectStore('control').put({key:'intent-sequence',value:order});done();},abort);
      };
      on(intents.get(key),row=>{previous=row;ready();},abort);on(intents.index('by_operation').get(request.operation_id),row=>{owner=row;ready();},abort);on(tx.objectStore('receipts').get(request.operation_id),row=>{receipt=row;ready();},abort);
    });
  };
  function committedReceipt(tx:IDBTransaction,intent:BrowserVaultIntent,done:(receipt:string|undefined)=>void,abort:(error:unknown)=>void):void{
    on(tx.objectStore('receipts').get(intent.operation_id),row=>{
      if(!row){if(intent.status==='committed')throw fail('storage_corrupt');done(undefined);return;}
      const request=JSON.parse(intent.request_json);const decision=core<any>(()=>wasm.checkIdempotency(JSON.stringify({request,record:row.record})));
      if(decision.status!=='replay'||row.family_command_json!==intent.family_command_json)throw fail('storage_corrupt');const receipt=JSON.stringify(decision.result);
      if(intent.status==='committed'&&intent.receipt!==receipt)throw fail('storage_corrupt');done(receipt);
    },abort);
  }
  async function executeIntent(clientId:string,intentId:string):Promise<string>{
    const key=intentKey(clientId,intentId);
    const intent=await transact<BrowserVaultIntent>('readwrite',(tx,done,abort)=>on(tx.objectStore('intents').get(key),row=>{
      if(!row)throw fail('intent_not_found');
      if(row.status==='prepared'){const requested={...row,status:'commit_requested'};tx.objectStore('intents').put(requested);done(requested);}else if(['commit_requested','committed','rejected'].includes(row.status))done(row);else throw fail('storage_corrupt');
    },abort));
    if(intent.status==='rejected')throw new BrowserVaultError(intent.error!.code,intent.error!.message,intent.error!.details,intent.error!.source);
    // Receipt replay precedes graph, target and resource validation.
    const replay=await transact<string|undefined>('readonly',(tx,done,abort)=>{committedReceipt(tx,intent,done,abort);});if(replay!==undefined)return replay;
    let prepared:PreparedStreamingMutation|undefined;
    try{
      prepared=await engine.prepareLocal({requestJson:intent.request_json,familyCommandJson:intent.family_command_json,nextRevision:crypto.randomUUID()});
      const changes=prepared.changes;
      return await transact<string>('readwrite',(tx,done,abort)=>on(tx.objectStore('intents').get(key),current=>{
        if(!current||current.request_json!==intent.request_json||current.family_command_json!==intent.family_command_json||!['commit_requested','committed'].includes(current.status))throw fail('intent_conflict');
        committedReceipt(tx,current,prior=>{if(prior!==undefined){done(prior);return;}
          readPublication(tx,publication=>{
            const sequence=nextDecimalU64(publication.sequence),request=JSON.parse(intent.request_json),result={operation_id:intent.operation_id,sequence,changes};
            const record={request,result};core(()=>wasm.checkIdempotency(JSON.stringify({request,record})));
            const receipt=JSON.stringify(result);if(new TextEncoder().encode(receipt).length>receiptBudget)throw new BrowserVaultError('too_large','Commit receipt exceeds the declared transport limit',undefined,'rust');
            engine.commitLocal(tx,prepared!,publication,()=>{
              tx.objectStore('receipts').add({operation_id:intent.operation_id,record,...(intent.family_command_json===undefined?{}:{family_command_json:intent.family_command_json})});
              tx.objectStore('journal').add({sequence,request,result});tx.objectStore('control').put({key:'sequence',value:sequence});tx.objectStore('intents').put({...current,status:'committed',receipt});done(receipt);
            },abort);
          },abort);
        },abort);
      },abort));
    }catch(error){
      // Only a Rust semantic rejection is terminal. Storage/lifecycle/CAS loss
      // preserves the original authorization for exact restart recovery.
      if(error instanceof BrowserVaultError&&error.source==='rust'){
        const raced=await transact<string|undefined>('readwrite',(tx,done,abort)=>on(tx.objectStore('intents').get(key),current=>{
          if(!current||current.request_json!==intent.request_json||current.family_command_json!==intent.family_command_json)throw fail('intent_conflict');
          committedReceipt(tx,current,receipt=>{if(receipt!==undefined){done(receipt);return;}if(current.status==='commit_requested')tx.objectStore('intents').put({...current,status:'rejected',error:{code:error.code,message:error.message,details:error.details,source:error.source}});done(undefined);},abort);
        },abort));if(raced!==undefined)return raced;
      }
      throw error;
    }finally{prepared?.dispose();}
  }
  const inventory=()=>transact<BrowserVaultRead[]>('readonly',(tx,done,abort)=>readPublication(tx,current=>{
    const stats=new Map(current.presentation.map(row=>[row.id,row]));done(current.entries.filter(entry=>!entry.deleted).map(entry=>({entry,presentation:stats.get(entry.id)!})));
  },abort));
  const binaryLimits=Object.freeze({maxFileBytes:'67108864',maxChunkBytes:128*1024,smallReadBytes:'16777216'});
  let stageStore:BrowserBinaryStageStore|undefined,binaryCapability:BinaryStreams|undefined;
  const boundStage=(ref:BinaryStageRef)=>{const copy={...ref};if(copy.localStoreId!==authorityId||copy.clientId!==options.clientId||!operationId(copy.operationId)||!operationId(copy.stageId))throw fail('owner_mismatch');return copy;};
  const commitKey=(ref:BinaryStageRef)=>'binary-commit/v1/'+ref.clientId+'/'+ref.stageId;
  async function commitBinary(input:BinaryStageRef):Promise<string>{
    const ref=boundStage(input);active();
    const authorized=await transact<any>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_stages').get([ref.clientId,ref.stageId]),stage=>{
      if(!stage||stage.operationId!==ref.operationId||stage.authorityId!==authorityId||stage.clientId!==options.clientId)throw fail('owner_mismatch');
      if(stage.phase==='committed'&&stage.outcome?.status==='committed'){done({terminal:stage.outcome.receipt});return;}
      if(stage.phase==='rejected'&&stage.outcome?.status==='rejected')throw new BrowserVaultError(stage.outcome.error.code,stage.outcome.error.message,stage.outcome.error.details,stage.outcome.error.source);
      if(!['sealed','commit_requested'].includes(stage.phase)||!stage.finalized)throw fail('invalid_stage_state');
      on(tx.objectStore('control').get(commitKey(ref)),row=>{
        if(row){const request=row.value;if(request.operationId!==ref.operationId||!same(request.target,stage.request.target)||request.stageId!==ref.stageId)throw fail('storage_corrupt');if(stage.phase!=='commit_requested')throw fail('storage_corrupt');done({stage,request});return;}
        if(stage.phase!=='sealed')throw fail('storage_corrupt');
        const request={version:1,operationId:ref.operationId,stageId:ref.stageId,target:stage.request.target,finalEventId:crypto.randomUUID(),metadataRevision:crypto.randomUUID(),graphRevision:crypto.randomUUID()};
        const requested={...stage,phase:'commit_requested',generation:nextDecimalU64(stage.generation)};
        tx.objectStore('control').add({key:commitKey(ref),value:request});tx.objectStore('binary_stages').put(requested);done({stage:requested,request});
      },abort);
    },abort));
    if(authorized.terminal!==undefined)return authorized.terminal;
    let staged:Awaited<ReturnType<BrowserBinaryStageStore['takeSealed']>>|undefined,prepared:PreparedStreamingMutation|undefined,stageHandlesTransferred=false;
    try{
      staged=await stageStore!.takeSealed(ref);active();
      const original=authorized.request;
      const target=original.target.kind==='create'?{type:'create',id:original.target.entryId,path:original.target.path}:{type:'write',id:original.target.entryId,expected_revision:original.target.expectedRevision,expected_content_event:original.target.expectedContentEvent};
      stageHandlesTransferred=true; // Engine owns both opaque handles from this call, including failure.
      prepared=await engine.prepareBinary({target,batch:staged.batch,built:staged.built,finalEventId:original.finalEventId,metadataRevision:original.metadataRevision,graphRevision:original.graphRevision,sourceKeys:staged.sourceRefs.map(row=>({realmId:row.header.realmId,vaultId:row.header.vaultId,updateId:row.header.updateId}))});
      return await transact<string>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_stages').get([ref.clientId,ref.stageId]),current=>{
        if(current?.phase==='committed'&&current.outcome?.status==='committed'){done(current.outcome.receipt);return;}
        if(!current||current.phase!=='commit_requested'||current.generation!==staged!.stageGeneration||!same(current.request,staged!.request))throw fail('revision_conflict');
        on(tx.objectStore('control').get(commitKey(ref)),row=>{if(!row||!same(row.value,original))throw fail('storage_corrupt');
          readPublication(tx,publication=>{
            const sequence=nextDecimalU64(publication.sequence),changes=prepared!.changes,receipt=JSON.stringify({operation_id:ref.operationId,sequence,changes});
            if(new TextEncoder().encode(receipt).length>receiptBudget)throw fail('too_large');
            engine.commitLocal(tx,prepared!,publication,()=>{
              on(tx.objectStore('control').get('binary-stream-usage:v1'),row=>{const usage=row?.value as BrowserBinaryUsage;if(usage?.version!==1||!Number.isInteger(usage.activeStages)||usage.activeStages<1)throw fail('storage_corrupt');
                tx.objectStore('binary_stages').put({...current,phase:'committed',generation:nextDecimalU64(current.generation),outcome:{status:'committed',receipt}});
                tx.objectStore('control').put({key:'binary-stream-usage:v1',value:{...usage,activeStages:usage.activeStages-1}});
                tx.objectStore('journal').add({sequence,origin:{kind:'binary',operation_id:ref.operationId},changes});tx.objectStore('control').put({key:'sequence',value:sequence});done(receipt);
              },abort);
            },abort);
          },abort);
        },abort);
      },abort));
    }catch(error){
      const terminal=error instanceof BrowserVaultError&&(error.source==='rust'||error.code==='too_large');
      if(terminal){const raced=await transact<string|undefined>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_stages').get([ref.clientId,ref.stageId]),current=>{
        if(current?.phase==='committed'&&current.outcome?.status==='committed'){done(current.outcome.receipt);return;}
        if(current?.phase!=='commit_requested'||current.operationId!==ref.operationId)throw fail('storage_corrupt');
        on(tx.objectStore('control').get('binary-stream-usage:v1'),row=>{const usage=row?.value as BrowserBinaryUsage;if(usage?.version!==1||usage.activeStages<1)throw fail('storage_corrupt');
          tx.objectStore('binary_stages').put({...current,phase:'rejected',generation:nextDecimalU64(current.generation),outcome:{status:'rejected',error:{code:error.code,message:error.message,source:error.source}}});tx.objectStore('control').put({key:'binary-stream-usage:v1',value:{...usage,activeStages:usage.activeStages-1}});done(undefined);
        },abort);
      },abort));if(raced!==undefined)return raced;}
      throw error;
    }finally{prepared?.dispose();if(!stageHandlesTransferred){staged?.batch.free();staged?.built.free();}}
  }
  interface ReadRow {mode:'published';version:1;localStoreId:string;clientId:string;readId:string;pinId:string;active:0|1;request:Parameters<BinaryStreams['openRead']>[0];reference:any;entryRevision:string;length:string}
  const readCache=new Map<string,{row:ReadRow;plan:PreparedStreamingRead}>();
  const readRef=(row:ReadRow):BinaryReadRef=>({localStoreId:authorityId,clientId:options.clientId,readId:row.pinId,entryId:row.request.entryId,entryRevision:row.entryRevision,selectedContentEvent:row.reference.selected_event,length:row.length});
  function validRead(value:any):ReadRow {if(!value||value.mode!=='published'||value.version!==1||value.localStoreId!==authorityId||value.clientId!==options.clientId||!operationId(value.readId)||!operationId(value.pinId)||![0,1].includes(value.active)||!operationId(value.request?.entryId)||!operationId(value.entryRevision)||!operationId(value.reference?.selected_event)||value.reference?.entry?.entry_id!==value.request.entryId)throw fail('storage_corrupt');decimalU64(value.length);return value;}
  async function openBinaryRead(requestedReadId:string,input:Parameters<BinaryStreams['openRead']>[0]):Promise<BinaryReadRef>{
    const request={...input};active();if(!operationId(requestedReadId)||!operationId(request.entryId))throw fail('invalid_request');
    const prior=await transact<ReadRow|undefined>('readonly',(tx,done,abort)=>on(tx.objectStore('binary_reads').get([options.clientId,requestedReadId]),row=>done(row?validRead(row):undefined),abort));
    active();if(prior&&!same(prior.request,request))throw fail('idempotency_conflict');if(prior?.active===0)throw fail('binary_read_closed');
    if(prior&&readCache.has(prior.pinId))return readRef(prior);
    const plan=await engine.prepareRead({...request,...(prior?{reference:prior.reference,expectedRevision:prior.entryRevision}:{} )});
    const row:ReadRow=prior??{mode:'published',version:1,localStoreId:authorityId,clientId:options.clientId,readId:requestedReadId,pinId:crypto.randomUUID(),active:1,request,reference:plan.reference,entryRevision:plan.revision,length:plan.length()};
    try{
      if(!same(plan.reference,row.reference)||plan.revision!==row.entryRevision||plan.length()!==row.length)throw fail('storage_corrupt');
      await transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_reads').get([options.clientId,requestedReadId]),current=>{
        if(prior?!same(current,prior):current!==undefined)throw fail('revision_conflict');
        on(tx.objectStore('binary_reads').index('by_active').count(1),count=>{if(!prior&&count>=4)throw fail('too_large');
          readPublication(tx,publication=>engine.commitRead(tx,plan,publication,()=>{if(!prior)tx.objectStore('binary_reads').add(row);done();},abort),abort);
        },abort);
      },abort));active();readCache.set(row.pinId,{row,plan});return readRef(row);
    }catch(error){plan.dispose();throw error;}
  }
  const capturedRead=(input:BinaryReadRef)=>{const ref={...input};if(ref.localStoreId!==authorityId||ref.clientId!==options.clientId||!operationId(ref.readId))throw fail('owner_mismatch');return ref;};
  async function readRow(ref:BinaryReadRef):Promise<ReadRow>{return transact<ReadRow>('readonly',(tx,done,abort)=>on(tx.objectStore('binary_reads').index('by_pin').get([options.clientId,ref.readId]),value=>{if(!value)throw fail('binary_read_closed');const row=validRead(value);if(!same(readRef(row),ref))throw fail('owner_mismatch');if(!row.active)throw fail('binary_read_closed');done(row);},abort));}
  async function planRange(plan:Pick<PreparedStreamingRead,'chunkCount'|'chunkJson'|'verifyPayload'>,lengthText:string,range:{offset:string;maxBytes:number}){
    const offset=BigInt(decimalU64(range.offset)),length=BigInt(decimalU64(lengthText)),max=range.maxBytes;
    if(!Number.isInteger(max)||max<1||max>128*1024||offset>length)throw fail('invalid_request');
    const size=Number(length-offset<BigInt(max)?length-offset:BigInt(max)),output=new Uint8Array(size);let copied=0;
    for(let index=0;index<plan.chunkCount()&&copied<size;index++){
      active();const chunk=JSON.parse(plan.chunkJson(index)),start=BigInt(decimalU64(chunk.offset)),end=start+BigInt(decimalU64(chunk.length));if(end<=offset+BigInt(copied))continue;
      if(start>offset+BigInt(copied))throw fail('storage_corrupt');
      const source=await transact<any>('readonly',(tx,done,abort)=>getExactSource(tx,{realmId:chunk.scope.realm_id,vaultId:chunk.scope.vault_id,updateId:chunk.update_id},'payload',done,abort));
      active();if(!source||!same(source.header.descriptor?.record,chunk.expected)||!same(source.header.descriptor?.summary_digest,chunk.summary_digest))throw fail('immutable_source_conflict');
      const bytes=plan.verifyPayload(index,source.bytes),from=Number(offset+BigInt(copied)-start),take=Math.min(size-copied,bytes.length-from);if(take<1||BigInt(bytes.length)!==end-start)throw fail('storage_corrupt');output.set(bytes.subarray(from,from+take),copied);copied+=take;
    }
    if(copied!==size)throw fail('storage_corrupt');active();return{bytes:output,nextOffset:String(offset+BigInt(size)),eof:offset+BigInt(size)===length};
  }
  async function rangeRead(input:BinaryReadRef,range:{offset:string;maxBytes:number}){
    const ref=capturedRead(input);let row=await readRow(ref),cached=readCache.get(ref.readId);
    if(!cached){await openBinaryRead(row.readId,row.request);cached=readCache.get(ref.readId);if(!cached)throw fail('storage_corrupt');}
    if(!same(cached.row,row))throw fail('storage_corrupt');const result=await planRange(cached.plan,row.length,range);
    row=await readRow(ref);if(!same(cached.row,row))throw fail('binary_read_closed');active();return result;
  }
  async function closeBinaryRead(input:BinaryReadRef):Promise<void>{const ref=capturedRead(input);await transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_reads').index('by_pin').get([options.clientId,ref.readId]),value=>{if(!value){done();return;}const row=validRead(value);if(!same(readRef(row),ref))throw fail('owner_mismatch');tx.objectStore('binary_reads').delete([options.clientId,row.readId]);done();},abort));readCache.get(ref.readId)?.plan.dispose();readCache.delete(ref.readId);}
  async function cleanupReadPins():Promise<void>{await transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_reads').index('by_active').openCursor(IDBKeyRange.only(1)),cursor=>{if(!cursor){done();return;}if(cursor.value.clientId===options.clientId){const row=validAnyRead(cursor.value);cursor.delete();}cursor.continue();},abort));for(const item of readCache.values())item.plan.dispose();readCache.clear();for(const item of recoveryCache.values())item.plan.dispose();recoveryCache.clear();}
  async function closeBinaryReadRequest(requestedReadId:string,input:Parameters<BinaryStreams['openRead']>[0]):Promise<void>{
    const request={...input};if(!operationId(requestedReadId))throw fail('invalid_request');let pinId:string|undefined;
    await transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_reads').get([options.clientId,requestedReadId]),value=>{if(value){const row=validRead(value);if(!same(row.request,request))throw fail('idempotency_conflict');pinId=row.pinId;tx.objectStore('binary_reads').delete([options.clientId,row.readId]);}done();},abort));
    if(pinId){readCache.get(pinId)?.plan.dispose();readCache.delete(pinId);}
  }
  interface RecoveryReadRow {mode:'recovery';version:1;localStoreId:string;clientId:string;readId:string;pinId:string;active:1;request:StreamingRecoveryReadInput;reference:any;witness:PreparedStreamingRecoveryRead['witness'];length:string}
  const recoveryCache=new Map<string,{row:RecoveryReadRow;plan:PreparedStreamingRecoveryRead}>();
  const recoveryRef=(row:RecoveryReadRow):BrowserRecoveryReadRef=>({pinId:row.pinId,entryId:row.request.entryId,reference:structuredClone(row.reference),witness:{...row.witness},length:row.length});
  function validRecoveryRead(value:any):RecoveryReadRow {
    if(!value||value.mode!=='recovery'||value.version!==1||value.localStoreId!==authorityId||value.clientId!==options.clientId||!operationId(value.readId)||!operationId(value.pinId)||value.active!==1||!operationId(value.request?.entryId)||value.reference?.entry?.entry_id!==value.request.entryId||value.witness?.kind!=='current_retained'||value.witness.entry_id!==value.request.entryId||!operationId(value.witness.metadata_revision)||value.witness.selected_content_event!==value.reference?.selected_event)throw fail('storage_corrupt');
    decimalU64(value.length);return value;
  }
  function validAnyRead(value:any):ReadRow|RecoveryReadRow{return value?.mode==='recovery'?validRecoveryRead(value):validRead(value);}
  async function openRecoveryBinaryRead(requestedReadId:string,input:StreamingRecoveryReadInput):Promise<BrowserRecoveryReadRef>{
    const request=structuredClone(input);active();if(!operationId(requestedReadId)||!operationId(request.entryId))throw fail('invalid_request');
    const prior=await transact<RecoveryReadRow|undefined>('readonly',(tx,done,abort)=>on(tx.objectStore('binary_reads').get([options.clientId,requestedReadId]),row=>done(row?validRecoveryRead(row):undefined),abort));
    if(prior&&!same(prior.request,request))throw fail('idempotency_conflict');if(prior&&recoveryCache.has(prior.pinId))return recoveryRef(prior);
    const plan=await engine.prepareRecoveryRead({...request,...(prior?{reference:prior.reference,expectedContentEvent:prior.witness.selected_content_event}:{})});
    const row:RecoveryReadRow=prior??{mode:'recovery',version:1,localStoreId:authorityId,clientId:options.clientId,readId:requestedReadId,pinId:crypto.randomUUID(),active:1,request,reference:plan.reference,witness:plan.witness,length:plan.length()};
    try{
      if(!same(plan.reference,row.reference)||!same(plan.witness,row.witness)||plan.length()!==row.length)throw fail('recovery_read_conflict');
      await transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_reads').get([options.clientId,requestedReadId]),current=>{
        if(prior?!same(current,prior):current!==undefined)throw fail('revision_conflict');
        on(tx.objectStore('binary_reads').index('by_active').count(1),count=>{if(!prior&&count>=4)throw fail('too_large');
          readPublication(tx,publication=>engine.commitRecoveryRead(tx,plan,publication,()=>{if(!prior)tx.objectStore('binary_reads').add(row);done();},abort),abort);
        },abort);
      },abort));active();recoveryCache.set(row.pinId,{row,plan});return recoveryRef(row);
    }catch(error){plan.dispose();throw error;}
  }
  async function recoveryRow(input:BrowserRecoveryReadRef):Promise<RecoveryReadRow>{
    const ref=structuredClone(input);if(!operationId(ref.pinId))throw fail('invalid_request');
    return transact<RecoveryReadRow>('readonly',(tx,done,abort)=>on(tx.objectStore('binary_reads').index('by_pin').get([options.clientId,ref.pinId]),value=>{if(!value)throw fail('binary_read_closed');const row=validRecoveryRead(value);if(!same(recoveryRef(row),ref))throw fail('owner_mismatch');done(row);},abort));
  }
  async function readRecoveryBinaryRange(input:BrowserRecoveryReadRef,range:{offset:string;maxBytes:number}){
    const ref=structuredClone(input),row=await recoveryRow(ref);let cached=recoveryCache.get(ref.pinId);
    if(!cached){await openRecoveryBinaryRead(row.readId,row.request);cached=recoveryCache.get(ref.pinId);if(!cached)throw fail('storage_corrupt');}
    if(!same(cached.row,row))throw fail('storage_corrupt');const result=await planRange(cached.plan,row.length,range);
    if(!same(await recoveryRow(ref),row))throw fail('binary_read_closed');active();return result;
  }
  async function closeRecoveryBinaryRead(input:BrowserRecoveryReadRef):Promise<void>{
    const ref=structuredClone(input);if(!operationId(ref.pinId))throw fail('invalid_request');
    await transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('binary_reads').index('by_pin').get([options.clientId,ref.pinId]),value=>{
      if(value){const row=validRecoveryRead(value);if(!same(recoveryRef(row),ref))throw fail('owner_mismatch');tx.objectStore('binary_reads').delete([options.clientId,row.readId]);}done();
    },abort));recoveryCache.get(ref.pinId)?.plan.dispose();recoveryCache.delete(ref.pinId);
  }
  readBinarySmall=async id=>{const metadata=await readMetadataById(id);if(!metadata||metadata.entry.kind!=='file')throw fail('not_found');if(BigInt(metadata.presentation.size_bytes)>BigInt(binaryLimits.smallReadBytes))throw fail('stream_required');const ref=await openBinaryRead(crypto.randomUUID(),{entryId:id,expectedRevision:metadata.entry.revision});try{if(BigInt(ref.length)>BigInt(binaryLimits.smallReadBytes))throw fail('stream_required');const bytes=new Uint8Array(Number(ref.length));let offset='0';for(;;){const part=await rangeRead(ref,{offset,maxBytes:128*1024});bytes.set(part.bytes,Number(offset));offset=part.nextOffset;if(part.eof)return bytes;}}finally{await closeBinaryRead(ref);}};
  async function binaryStreams():Promise<BinaryStreams>{
    active();if(binaryCapability)return binaryCapability;
    const status=await engine.api.inspect();active();if(!status.scope)throw fail('not_enrolled');
    stageStore=createBrowserBinaryStageStore({db,authorityId,clientId:options.clientId,scope:{realmId:status.scope.realm_id,vaultId:status.scope.vault_id},assertActive:active,wasm,allocateId:()=>crypto.randomUUID(),limits:{maxFileBytes:binaryLimits.maxFileBytes,maxChunkBytes:binaryLimits.maxChunkBytes,maxPayloadBytes:1048576,maxStages:4096,maxActiveStages:8,maxSourceBytes:'536870912',maxChunkRecords:4096,maxPageRecords:256}});
    // Pinned read functions are installed with the same authority before exposure.
    binaryCapability={limits:binaryLimits,begin:input=>stageStore!.begin(input),append:(ref,input)=>stageStore!.append(ref,input),query:ref=>stageStore!.query(ref),seal:(ref,input)=>stageStore!.seal(ref,input),abort:ref=>stageStore!.abort(ref),commit:commitBinary,
      openRead:input=>openBinaryRead(crypto.randomUUID(),input),read:rangeRead,closeRead:closeBinaryRead};
    return binaryCapability;
  }
  const documentBackend=typeof (wasm as unknown as Partial<BrowserDocumentIndexWasm>).WasmDocumentIndexBuilder==='function'?createBrowserDocumentIndexBackend({db,authorityId,clientId:options.clientId,wasm:wasm as unknown as BrowserDocumentIndexWasm,assertActive:active,readPublication}):undefined;
  const documentIndex=documentBackend?.index;
  const vault:BrowserStreamingVault={authorityId,documentIndex,documentMaintenance:documentBackend?.maintenance,managedRecords:engine.managedRecords,sync:engine.api,openRecoveryBinaryRead,readRecoveryBinaryRange,closeRecoveryBinaryRead,binaryStreams,openBinaryRead,cleanupReadPins,closeBinaryReadRequest,
    validateStorage:()=>engine.validate(),
    checkpoints:clientId=>browserCheckpoints(db,authorityId,clientId),
    inventory,readMetadata,readMetadataById,
    readEntry:async path=>withBody(await readMetadata(path)),readEntryById:async id=>withBody(await readMetadataById(id)),
    async readBytes(id){const row=await withBody(await readMetadataById(id));if(!row?.bytes)throw fail('not_found');return row.bytes;},
    prepareIntent,
    async prepareFamilyIntent(clientId,intentId,commandJson){const command=core<any>(()=>wasm.validateFamilyCommand(commandJson));await prepareIntent(clientId,intentId,JSON.stringify(command.request),JSON.stringify(command));},
    intents:readIntents,executeIntent,
    async mutate(requestJson){const request=JSON.parse(requestJson);if(!operationId(request.operation_id))throw fail('invalid_request');await prepareIntent(options.clientId,request.operation_id,requestJson);return executeIntent(options.clientId,request.operation_id);},
    snapshot:()=>transact<string>('readonly',(tx,done,abort)=>readPublication(tx,current=>done(JSON.stringify({entries:current.entries,sequence:current.sequence})),abort)),
    acknowledgeIntent(clientId,intentId,outcome){const key=intentKey(clientId,intentId);return transact<void>('readwrite',(tx,done,abort)=>on(tx.objectStore('intents').get(key),row=>{
      if(!row||!['committed','rejected'].includes(row.status)||outcome.status!==row.status||(outcome.status==='committed'?outcome.receipt!==row.receipt:!same(outcome.error,row.error)))throw fail('intent_outcome_mismatch');
      tx.objectStore('intents').put({...row,acknowledged:true});done();
    },abort));},
    changesSince(after){decimalU64(after);return transact<{sequence:string;paths?:string[]}>('readonly',(tx,done,abort)=>{
      let events:any[]|undefined,sequence:string|undefined;const finish=()=>{if(!events||sequence===undefined)return;
        if(BigInt(after)>BigInt(sequence))throw fail('storage_corrupt');let expected=BigInt(after),structural=false;const paths=new Set<string>();
        for(const event of events.filter(row=>BigInt(decimalU64(row.sequence))>BigInt(after)).sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1)){
          if(BigInt(event.sequence)!==++expected)throw fail('storage_corrupt');
          let changes:any[];if(event.origin?.kind==='sync'){if(!['authored','received'].includes(event.origin.direction)||!operationId(event.origin.update_id)||!Array.isArray(event.changes))throw fail('storage_corrupt');changes=event.changes;}
          else if(event.origin?.kind==='binary'){if(!Array.isArray(event.changes))throw fail('storage_corrupt');changes=event.changes;}
          else {const decision=core<any>(()=>wasm.checkIdempotency(JSON.stringify({request:event.request,record:{request:event.request,result:event.result}})));if(decision.status!=='replay'||decision.result.sequence!==event.sequence)throw fail('storage_corrupt');changes=event.result.changes;}
          for(const {before,after:entry} of changes){if(!before||!entry||before.path!==entry.path||before.deleted!==entry.deleted||before.kind!==entry.kind)structural=true;if(entry?.kind==='file')paths.add(entry.path);}
        }
        if(expected!==BigInt(sequence))throw fail('storage_corrupt');done({sequence,...(structural?{}:{paths:[...paths]})});
      };
      rows<any>(tx,'journal',value=>{events=value;finish();},abort);on(tx.objectStore('control').get('sequence'),row=>{sequence=decimalU64(row?.value);finish();},abort);
    });},close:()=>{void documentIndex?.close().catch(()=>{});stageStore?.dispose();for(const item of readCache.values())item.plan.dispose();readCache.clear();for(const item of recoveryCache.values())item.plan.dispose();recoveryCache.clear();close();},
  };
  return vault;
}
