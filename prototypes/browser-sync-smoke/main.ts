import { BrowserCoreRuntime } from '../../src/platform/browser-core-runtime.ts';
import { admitBrowserClient } from '../../src/platform/browser-client-admission.ts';
import type { BrowserClientContext } from '../../src/platform/browser-client-admission.ts';
import { blobBinarySource, writeBinarySource, readBinarySink, binaryLength } from '../../src/core/binary-transfer.ts';
import type { BinaryTarget, BinaryStageRef, BinaryReadRef } from '../../src/core/binary-streams.ts';
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const output=el<HTMLPreElement>('result');
const show=(value:unknown)=>{output.textContent=JSON.stringify(value,null,2);};
const url=new URL(location.href);
if(!url.searchParams.has('database'))url.searchParams.set('database',`zorid-core-vault:smoke-${crypto.randomUUID()}`);
if(!url.searchParams.has('client'))url.searchParams.set('client',crypto.randomUUID());
history.replaceState(null,'',url);
const database=url.searchParams.get('database')!,clientId=url.searchParams.get('client')!;
el('identity').textContent=`Database: ${database}; client: ${clientId}`;
const peer=new URL(url);peer.searchParams.set('database',`zorid-core-vault:smoke-${crypto.randomUUID()}`);peer.searchParams.set('client',crypto.randomUUID());
el<HTMLAnchorElement>('peer').href=peer.href;
let runtime:BrowserCoreRuntime|undefined;
let active=false,retired=false;
let consumer:BrowserClientContext|undefined;
const admitBinary=()=>{
  if(!runtime?.binaryStreams)throw Object.assign(new Error('binary capability is unavailable'),{code:'binary_streams_unavailable'});
  return consumer??=admitBrowserClient(runtime,{assertOwner(){if(retired)throw Object.assign(new Error('fixture retired'),{code:'client_ownership_lost'});}});
};
let diagnosticPhase='open';
const failure=(error:any)=>({status:'failed',code:typeof error?.code==='string'?error.code:'operation_failed',phase:diagnosticPhase,invariant:typeof error?.details?.invariant==='string'?error.details.invariant:undefined,message:error?.code==='storage_corrupt'?error.message:undefined});
function action(id:string,run:()=>Promise<unknown>){el<HTMLButtonElement>(id).onclick=async()=>{
  if(active)return;active=true;diagnosticPhase=id;
  try{if(!runtime)throw new Error('not_open');show(await run());}
  catch(error){show(failure(error));}
  finally{active=false;}
};}
const rows=async()=> (await runtime!.inventory()).map(({entry,presentation})=>({...entry,size:presentation.size_bytes}));
async function submit(mutation:unknown,create_mode:'text'|'binary'|null=null){
  const intentId=crypto.randomUUID();
  diagnosticPhase='prepare_family';
  await runtime!.prepareFamily(intentId,JSON.stringify({version:1,request:{operation_id:intentId,mutation},create_mode}));
  diagnosticPhase='commit_family';
  const receipt=await runtime!.commit(intentId);
  diagnosticPhase='ack_family';
  await runtime!.acknowledge(intentId,{status:'committed',receipt});
  diagnosticPhase='post_ack_inventory';
  return {status:'committed',files:await rows()};
}
const selected=async()=>{const row=await runtime!.readMetadata(el<HTMLInputElement>('path').value);if(!row)throw new Error('missing_path');return row;};
async function save(bytes:Uint8Array,mode:'text'){
  const path=el<HTMLInputElement>('path').value;
  diagnosticPhase='save_read_existing';
  const prior=await runtime!.readEntry(path);
  const mutation=prior?{type:'write',id:prior.entry.id,expected:prior.entry.revision,content:Array.from(bytes)}:
    {type:'create',id:crypto.randomUUID(),path,kind:'file',content:Array.from(bytes)};
  return submit(mutation,prior?null:mode);
}
action('configure',async()=>{
  const input=el<HTMLInputElement>('credentials'),file=input.files?.[0];
  if(!file||file.size>16384)throw new Error('invalid_credentials_file');
  let raw:any;let key:Uint8Array|undefined;
  try{
    raw=JSON.parse(await file.text());
    const rpc=raw.version===2&&raw.transport==='grpc',legacy=raw.version===1&&raw.transport===undefined;
    if((!rpc&&!legacy)||typeof raw.key_base64!=='string')throw new Error('invalid_credentials');
    key=Uint8Array.from(atob(raw.key_base64),c=>c.charCodeAt(0));
    await runtime!.configureSyncFixture({...(rpc?{version:2,transport:'grpc'}:{}),endpoint:raw.endpoint,realmId:raw.realm_id,vaultId:raw.vault_id,serverEpoch:raw.server_epoch,keyEpoch:raw.key_epoch,bearerToken:raw.bearer_token,keyBytes:key,allowLoopbackHttp:true,enrollEmpty:true});
    if(runtime!.binaryStreams)admitBinary();
    return {status:'configured',files:await rows()};
  }finally{key?.fill(0);if(raw){raw.bearer_token='';raw.key_base64='';}input.value='';}
});
action('sync',async()=>({sweep:await runtime!.syncOnce(),files:await rows()}));
action('list',rows);
action('save',()=>save(new TextEncoder().encode(el<HTMLTextAreaElement>('text').value),'text'));
type PendingBinary={file:File;path:string;operationId:string;entryId:string;identity?:{entryId:string;expectedRevision:string};target?:BinaryTarget;pin?:BinaryReadRef;ref?:BinaryStageRef};
let pendingBinary:PendingBinary|undefined;
action('save-binary',async()=>{
  const file=el<HTMLInputElement>('binary').files?.[0],path=el<HTMLInputElement>('path').value;
  if(!file||file.size>64*1024*1024)throw Object.assign(new Error('binary fixture exceeds the file limit'),{code:'too_large'});
  const client=admitBinary(),streams=client.binaryStreams!;
  if(pendingBinary&&(pendingBinary.file!==file||pendingBinary.path!==path))throw Object.assign(new Error('Retry the original retained File and path'),{code:'command_pending'});
  const owned=pendingBinary??={file,path,operationId:crypto.randomUUID(),entryId:crypto.randomUUID()};
  try{
    if(owned.pin&&!owned.target){await streams.closeRead(owned.pin);owned.pin=undefined;}
    if(!owned.target){
      if(!owned.identity){
        diagnosticPhase='binary_read_metadata';const prior=await runtime!.readMetadata(owned.path);
        if(!prior)owned.target={kind:'create',entryId:owned.entryId,path:owned.path};
        else{if(prior.entry.kind!=='file')throw Object.assign(new Error('binary destination is a folder'),{code:'not_file'});owned.identity={entryId:prior.entry.id,expectedRevision:prior.entry.revision};}
      }
      if(!owned.target){
        diagnosticPhase='binary_pin_target';owned.pin=await streams.openRead(owned.identity!);
        if(owned.pin.entryId!==owned.identity!.entryId||owned.pin.entryRevision!==owned.identity!.expectedRevision||!owned.pin.selectedContentEvent)throw Object.assign(new Error('pinned target changed'),{code:'invalid_binary_read'});
        owned.target={kind:'write',...owned.identity!,expectedContentEvent:owned.pin.selectedContentEvent};
      }
    }
    if(owned.pin){diagnosticPhase='binary_close_target';await streams.closeRead(owned.pin);owned.pin=undefined;}
    let completed=false;
    if(owned.ref){
      diagnosticPhase='binary_retry_query';const observed=await streams.query(owned.ref);
      if(['sealed','commit_requested','committed','rejected'].includes(observed.phase)){
        if(observed.phase==='sealed')await streams.seal(owned.ref,{finalLength:String(owned.file.size)});
        diagnosticPhase='binary_retry_commit';await streams.commit(owned.ref);completed=true;
      }else if(observed.phase!=='receiving')throw Object.assign(new Error('retained binary stage cannot receive'),{code:'invalid_stage_state'});
    }
    if(!completed){
      diagnosticPhase='binary_transfer';
      try{const result=await writeBinarySource(streams,{operationId:owned.operationId,target:owned.target!},blobBinarySource(owned.file),()=>client.assertActive());owned.ref=result.ref;}
      catch(error){if(error&&typeof error==='object'&&'binaryStage'in error)owned.ref=structuredClone(error.binaryStage) as BinaryStageRef;throw error;}
    }
    diagnosticPhase='post_commit_inventory';const files=await rows();
    if(pendingBinary===owned)pendingBinary=undefined;
    return {status:'committed',files};
  }catch(error){
    if(owned.ref){
      let terminal:Awaited<ReturnType<typeof streams.query>>|undefined;
      try{terminal=await streams.query(owned.ref);}catch{/* Unknown outcome keeps the immutable File and exact request. */}
      if(terminal?.phase==='rejected'&&terminal.outcome?.status==='rejected'){
        if(pendingBinary===owned)pendingBinary=undefined;
        throw Object.assign(new Error(terminal.outcome.error.message),terminal.outcome.error);
      }
    }
    if(!owned.target&&!owned.identity&&!owned.pin&&!owned.ref&&pendingBinary===owned)pendingBinary=undefined;
    throw error;
  }
});
action('folder',()=>submit({type:'create',id:crypto.randomUUID(),path:el<HTMLInputElement>('path').value,kind:'folder',content:null}));
action('move',async()=>{const row=await selected();return submit({type:'move',id:row.entry.id,expected:row.entry.revision,path:el<HTMLInputElement>('destination').value});});
action('delete',async()=>{const row=await selected();return submit({type:'delete',id:row.entry.id,expected:row.entry.revision,recursive:el<HTMLInputElement>('recursive').checked});});
action('read',async()=>{
  diagnosticPhase='read_metadata';const row=await runtime!.readMetadata(el<HTMLInputElement>('path').value);if(!row)return {missing:true};
  const size=row.presentation.size_bytes,previewLimit=16n*1024n*1024n;
  if(BigInt(size)>previewLimit)return {status:'stream_required',code:'stream_required',entry:row.entry,byteLength:size,maxPreviewBytes:Number(previewLimit)};
  let bytes=new Uint8Array();
  if(row.entry.kind==='file'&&runtime!.binaryStreams){
    const client=admitBinary(),streams=client.binaryStreams!,cap=binaryLength(streams.limits.smallReadBytes)<previewLimit?streams.limits.smallReadBytes:String(previewLimit);
    if(BigInt(size)>binaryLength(cap))return {status:'stream_required',code:'stream_required',entry:row.entry,byteLength:size};
    const privatePreview=new Uint8Array(size);let written=0,finished=false;
    diagnosticPhase='read_binary_preview';
    try{
      await readBinarySink(streams,{entryId:row.entry.id,expectedRevision:row.entry.revision},{
        async write(chunk,offset){if(Number(offset)!==written||written+chunk.length>privatePreview.length)throw Object.assign(new Error('preview size changed'),{code:'revision_conflict'});privatePreview.set(chunk,written);written+=chunk.length;},
        async finish(){if(written!==privatePreview.length)throw Object.assign(new Error('preview size changed'),{code:'revision_conflict'});finished=true;},
        async abort(){privatePreview.fill(0);},
      },{maxBytes:cap,validate:()=>client.assertActive()});
      if(!finished)throw new Error('preview_not_finished');bytes=privatePreview;
    }catch(error){
      // Text has no binary manifest; only that exact authority result permits
      // the bounded text-body path. Other read failures remain explicit.
      if(!error||typeof error!=='object'||!('code'in error)||error.code!=='binary_read_unavailable')throw error;
      diagnosticPhase='read_text_body';const current=await runtime!.readEntry(row.entry.path);if(!current||current.entry.id!==row.entry.id||current.entry.revision!==row.entry.revision)throw Object.assign(new Error('read revision changed'),{code:'revision_conflict'});bytes=Uint8Array.from(current.bytes??[]);
    }
  }else if(row.entry.kind==='file'){const current=await runtime!.readEntry(row.entry.path);if(!current||current.entry.id!==row.entry.id||current.entry.revision!==row.entry.revision)throw Object.assign(new Error('read revision changed'),{code:'revision_conflict'});bytes=Uint8Array.from(current.bytes??[]);}
  let text:string|undefined;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);el<HTMLTextAreaElement>('text').value=text;}catch{}
  diagnosticPhase='hash_bounded_preview';const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))).map(b=>b.toString(16).padStart(2,'0')).join('');
  return {entry:row.entry,byteLength:bytes.length,sha256:digest,text,firstBytes:Array.from(bytes.slice(0,64))};
});
action('recover',async()=>{let settled=0;for(const intent of await runtime!.intents()){if(intent.acknowledged)continue;if(intent.status==='committed'&&intent.receipt){await runtime!.acknowledge(intent.intent_id,{status:'committed',receipt:intent.receipt});settled++;}else if(intent.status==='rejected'&&intent.error){await runtime!.acknowledge(intent.intent_id,{status:'rejected',error:intent.error});settled++;}}const namespaceChanged=consumer?.recoverCommands?await consumer.recoverCommands():false;return {settled,namespaceChanged,files:await rows()};});
el('reload').onclick=()=>location.reload();
window.addEventListener('pagehide',()=>{retired=true;runtime?.close();});
void BrowserCoreRuntime.open({database,clientId,allowNewVault:true,wasmModuleUrl:new URL('lib/core/zorid_wasm.js',location.href).href,timeoutMs:60000})
.then(value=>{runtime=value;show({status:'open',database,clientId});})
.catch(error=>show({...failure(error),status:'open_failed'}));
