import type { PlatformVault } from './index.ts';
import type { VaultAdapter } from '../core/types.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import { BrowserCoreRuntime } from './browser-core-runtime.ts';
import { BrowserCoreAdapter } from './browser-core.ts';
import { admitBrowserClient } from './browser-client-admission.ts';
import type { BrowserClientContext } from './browser-client-admission.ts';
import type { BrowserFileCommandInput } from './browser-file-commands.ts';
import { openBrowserClientSlot } from './browser-client-slots.ts';
import type { BrowserClientSlot } from './browser-client-slots.ts';
import { legacyBrowserExport } from './browser-legacy-export.ts';
import { binaryLength, writeBinarySource } from '../core/binary-transfer.ts';
import { scheduleBinaryTransfer } from '../core/binary-transfer-queue.ts';
import type { BinaryTarget, BinaryStageRef, BinaryReadRef } from '../core/binary-streams.ts';
import { vaultPath } from './path.ts';
import {createDocumentService} from '../core/document-semantics.ts';
import type {DocumentSemanticsCapability} from '../core/document-semantics.ts';
import {decodeTextCreateReceipt} from '../core/text-create.ts';
import type {TextCreateReceipt} from '../core/types.ts';

export const DEFAULT_BROWSER_DATABASE='zorid-core-vault:default-v1';
/** Normal browser commands retain the exact request after uncertain transport.
 * The admitted consumer owns durable command checkpoints and terminal ACKs. */
export function defaultBrowserAdapter(runtime:BrowserCoreRuntime,consumer:BrowserClientContext):VaultAdapter&DocumentSemanticsCapability{
  if(!consumer.fileCommand||!consumer.recoverCommands)throw new BrowserVaultError('file_commands_unavailable','Browser core has no admitted file-command consumer');
  const facade=new BrowserCoreAdapter(runtime);
  const pending=new Map<string,{signature:string;request:BrowserFileCommandInput}>();
  type WithoutIdentity<T>=T extends unknown?Omit<T,'operationId'|'entryId'>:never;
  type Input=WithoutIdentity<BrowserFileCommandInput>;
  const execute=(input:Input):Promise<void>=>{
    const captured=structuredClone(input),key=`${captured.kind}:${captured.path}`;
    const signature=JSON.stringify({...captured,...('data'in captured&&captured.data?{data:Array.from(captured.data)}:{})});
    const prior=pending.get(key);
    if(prior&&prior.signature!==signature)return Promise.reject(new BrowserVaultError('command_pending','Finish the retained operation for this path before changing its request'));
    const owned=prior??{signature,request:{...captured,operationId:crypto.randomUUID(),entryId:crypto.randomUUID()} as BrowserFileCommandInput};
    pending.set(key,owned);
    return consumer.fileCommand!(owned.request).then(()=>{if(pending.get(key)===owned)pending.delete(key);},error=>{
      if(error instanceof BrowserVaultError&&['invalid_request','not_found','revision_conflict','idempotency_conflict','invalid_path','invalid_text'].includes(error.code)&&pending.get(key)===owned)pending.delete(key);
      throw error;
    });
  };
  const streams=consumer.binaryStreams;
  type BinaryPending={kind:'createBinary'|'writeBinary';path:string;bytes:Uint8Array;operationId:string;entryId:string;identity?:{entryId:string;expectedRevision:string};target?:BinaryTarget;pin?:BinaryReadRef;ref?:BinaryStageRef;inFlight?:Promise<void>};
  const binaryPending=new Map<string,BinaryPending>();
  const sameBytes=(left:Uint8Array,right:Uint8Array)=>left.length===right.length&&left.every((value,index)=>value===right[index]);
  function binary(kind:BinaryPending['kind'],inputPath:string,data:Uint8Array):Promise<void>{
    try{
      const path=vaultPath(inputPath);
      if(!(data instanceof Uint8Array)||BigInt(data.byteLength)>binaryLength(streams!.limits.smallReadBytes)||data.byteLength>16*1024*1024)throw new BrowserVaultError('stream_required','Use a binary source for this file size');
      const prior=binaryPending.get(path);
      if(prior&&(prior.kind!==kind||!sameBytes(prior.bytes,data)))throw new BrowserVaultError('command_pending','Finish the retained binary operation before changing its request');
      if(prior?.inFlight)return prior.inFlight;
      // Snapshot once before metadata, pinning, or any other asynchronous work.
      const owned:BinaryPending=prior??{kind,path,bytes:data.slice(),operationId:crypto.randomUUID(),entryId:crypto.randomUUID()};
      binaryPending.set(path,owned);
      // Select metadata immediately, even while another transfer owns I/O.
      // Keep only the original scalar witnesses; retries must not select a replacement.
      const selected=!owned.target&&!owned.identity&&kind==='writeBinary'?(async()=>{
        const row=await (runtime.readMetadata?.(path)??runtime.readEntry(path));
        if(!row)return {target:{kind:'create',entryId:owned.entryId,path} as BinaryTarget};
        if(row.entry.kind!=='file')throw new BrowserVaultError('not_file','Binary destination is not a file');
        return {identity:{entryId:row.entry.id,expectedRevision:row.entry.revision}};
      })():undefined;
      void selected?.catch(()=>undefined);
      const transfer=async()=>{
        if(owned.pin&&!owned.target){await streams!.closeRead(owned.pin);owned.pin=undefined;}
        if(!owned.target){
          if(kind==='createBinary')owned.target={kind:'create',entryId:owned.entryId,path};
          else{
            if(!owned.identity){
              const selection=await selected!;
              if(selection.target)owned.target=selection.target;
              else owned.identity=selection.identity;
            }
            if(!owned.target){
              const identity=owned.identity!;
              owned.pin=await streams!.openRead(identity);
              if(owned.pin.entryId!==identity.entryId||owned.pin.entryRevision!==identity.expectedRevision||!owned.pin.selectedContentEvent)throw new BrowserVaultError('invalid_binary_read','Binary pin does not match the original destination');
              owned.target={kind:'write',...identity,expectedContentEvent:owned.pin.selectedContentEvent};
            }
          }
        }
        if(owned.pin){await streams!.closeRead(owned.pin);owned.pin=undefined;}
        if(owned.ref){
          const observed=await streams!.query(owned.ref);
          if(observed.phase==='sealed'||observed.phase==='commit_requested'||observed.phase==='committed'||observed.phase==='rejected'){
            if(observed.phase==='sealed')await streams!.seal(owned.ref,{finalLength:String(owned.bytes.length)});
            await streams!.commit(owned.ref);return;
          }
          if(observed.phase!=='receiving')throw new BrowserVaultError('invalid_stage_state','Retained binary operation cannot accept bytes');
        }
        let offset=0;
        const source={length:String(owned.bytes.length),async read(max:number){if(offset===owned.bytes.length)return null;const end=Math.min(owned.bytes.length,offset+max),chunk=owned.bytes.slice(offset,end);offset=end;return chunk;}};
        try{const completed=await writeBinarySource(streams!,{operationId:owned.operationId,target:owned.target!},source);owned.ref=completed.ref;}
        catch(error){if(error&&typeof error==='object'&&'binaryStage'in error)owned.ref=structuredClone(error.binaryStage) as BinaryStageRef;throw error;}
      };
      // The owning outcome lookup is part of this transfer's FIFO reservation.
      const result=scheduleBinaryTransfer(streams!,()=>transfer().then(()=>{if(binaryPending.get(path)===owned)binaryPending.delete(path);},async error=>{
        // Only the owning retained stage's terminal evidence can release a
        // binary request. Transport errors and semantic-looking error codes
        // alone never permit a replacement operation.
        if(owned.ref){
          let rejected:import('../core/binary-streams.ts').BinaryOperationOutcome|undefined;
          try{const observed=await streams!.query(owned.ref);if(observed.phase==='rejected'&&observed.outcome?.status==='rejected')rejected=observed.outcome;}catch{/* Preserve the original uncertainty when outcome lookup fails. */}
          if(rejected?.status==='rejected'){
            if(binaryPending.get(path)===owned)binaryPending.delete(path);
            const terminal=rejected.error;throw new BrowserVaultError(terminal.code,terminal.message,terminal.details,terminal.source);
          }
        }
        // Only metadata-only failures may release the captured destination. Any
        // pin/stage uncertainty retains its original request for an exact retry.
        if(!owned.target&&!owned.identity&&!owned.pin&&!owned.ref&&binaryPending.get(path)===owned)binaryPending.delete(path);
        throw error;
      }));
      const tracked=result.finally(()=>{if(owned.inFlight===tracked)owned.inFlight=undefined;});
      owned.inFlight=tracked;return tracked;
    }catch(error){return Promise.reject(error);}
  }
  return {
    durableWrites:consumer.durableWrites,durableNamespace:true,...(consumer.documentIndex?{documentSemantics:createDocumentService(consumer.documentIndex)}:{}),...(streams?{binaryStreams:streams}:{}),
    ...(consumer.createTextReceipt?{captureTextCreate(rawPath:string,text:string){
      const path=vaultPath(rawPath);
      if(typeof text!=='string')throw new BrowserVaultError('invalid_text','Text creation requires a string');
      const request=Object.freeze({kind:'createText' as const,path,content:text,operationId:crypto.randomUUID(),entryId:crypto.randomUUID()});
      const key=`createText:${path}`,owned={signature:JSON.stringify({kind:'createText',path,content:text}),request};
      let receipt:TextCreateReceipt|undefined,inFlight:Promise<TextCreateReceipt>|undefined;
      return Object.freeze({path,text,operationId:request.operationId,entryId:request.entryId,run(){
        try{consumer.assertActive();}catch(error){return Promise.reject(error);}
        if(receipt)return Promise.resolve(receipt);
        if(inFlight)return inFlight;
        const prior=pending.get(key);
        if(prior&&prior!==owned)return Promise.reject(new BrowserVaultError('command_pending','A different creation is still pending for this path'));
        pending.set(key,owned);
        const result=consumer.createTextReceipt!(request).then(raw=>{
          consumer.assertActive();const committed=decodeTextCreateReceipt(raw,request);receipt=committed;
          if(pending.get(key)===owned)pending.delete(key);
          return committed;
        },error=>{
          if(error instanceof BrowserVaultError&&['invalid_request','not_found','revision_conflict','idempotency_conflict','invalid_path','invalid_text'].includes(error.code)&&pending.get(key)===owned)pending.delete(key);
          throw error;
        });
        const tracked=result.finally(()=>{if(inFlight===tracked)inFlight=undefined;});inFlight=tracked;return tracked;
      }});
    }}:{}),
    list:()=>facade.list(),stat:path=>facade.stat(path),read:path=>facade.read(path),readBinary:path=>facade.readBinary(path),subscribe:listener=>facade.subscribe(listener),
    createText:(path,content)=>execute({kind:'createText',path,content}),
    write:(path,content)=>execute({kind:'writeText',path,content}),
    compareAndWrite:(path,expectedContent,content,expectedIdentity)=>execute({kind:'writeText',path,content,expectedContent,...(expectedIdentity?{expectedEntryId:expectedIdentity.entryId,expectedRevision:expectedIdentity.revision}:{})}),
    createBinary:(path,data)=>streams?binary('createBinary',path,data):execute({kind:'createBinary',path,data}),
    writeBinary:(path,data)=>streams?binary('writeBinary',path,data):execute({kind:'writeBinary',path,data}),
    mkdir:path=>execute({kind:'mkdir',path}),rename:(path,destination,expectedIdentity)=>execute({kind:'move',path,destination,...(expectedIdentity!==undefined?{expectedEntryId:expectedIdentity.entryId,expectedRevision:expectedIdentity.revision}:{})}),
    trash:path=>execute({kind:'trash',path}),remove:(path,force)=>execute({kind:'delete',path,force}),
  };
}

/** Keep release phases after unknown acknowledgments. A registry retry must
 * never re-enter an already released worker, and consumer retry must skip commands. */
export function createBrowserRelease(consumer:Pick<BrowserClientContext,'recoverCommands'|'release'>,slot:Pick<BrowserClientSlot,'release'>,completed:()=>void):()=>Promise<void>{
  let commandsSettled=false,consumerReleased=false,released=false,pending:Promise<void>|undefined;
  return ()=>{
    if(released)return Promise.resolve();
    if(pending)return pending;
    pending=(async()=>{
      if(!commandsSettled){await consumer.recoverCommands!();commandsSettled=true;}
      if(!consumerReleased){await consumer.release(()=>{});consumerReleased=true;}
      await slot.release({restore:false});
      released=true;completed();
    })().finally(()=>{pending=undefined;});
    return pending;
  };
}

/** Static assets + IndexedDB + Rust/WASM only. Sync credentials are never a
 * prerequisite, and opening a tab never creates an HTTP sync session. */
export async function openDefaultBrowserVault():Promise<PlatformVault>{
  const modulePath=typeof __ZORID_CORE_MODULE_PATH__==='string'?__ZORID_CORE_MODULE_PATH__:'';
  if(!modulePath)throw new BrowserVaultError('core_assets_missing','This build does not include browser Rust assets. Use the browser build.');
  const slot=await openBrowserClientSlot({database:DEFAULT_BROWSER_DATABASE});
  let runtime:BrowserCoreRuntime|undefined;
  try{
    runtime=await BrowserCoreRuntime.open({database:DEFAULT_BROWSER_DATABASE,clientId:slot.clientId,allowNewVault:true,initializeLocal:true,documentMaintenance:true,
      wasmModuleUrl:new URL(modulePath,document.baseURI).href});
    let active=true;
    const opened=runtime;
    const consumer=admitBrowserClient(opened,{assertOwner:()=>{if(!active)throw new BrowserVaultError('client_ownership_lost','Browser tab no longer owns its vault');}});
    if(!consumer.workBlocks)throw new BrowserVaultError('workblocks_unavailable','Browser WorkBlock registration is not ready');
    const adapter=defaultBrowserAdapter(opened,consumer);
    const retire=()=>{active=false;opened.close();slot.retire();};
    window.addEventListener('pagehide',retire,{once:true});
    const release=createBrowserRelease(consumer,slot,()=>{active=false;window.removeEventListener('pagehide',retire);});
    return {adapter,workBlocks:consumer.workBlocks,...(adapter.documentSemantics?{documentSemantics:adapter.documentSemantics}:{}),label:'Browser vault',id:`browser:core:${consumer.scope.vaultId}:client:${consumer.scope.clientId}`,
      legacyExport:legacyBrowserExport(),recoverCommands:()=>consumer.recoverCommands!(),
      release,
    };
  }catch(error){runtime?.close();slot.retire();throw error;}
}
