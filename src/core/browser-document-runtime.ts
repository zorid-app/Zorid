import {BrowserVaultError} from './browser-vault.ts';
import type {BrowserIndexSnapshot} from './browser-document-index.ts';

/** Internal executor uses the single readonly shared projection. */
import type {DocumentRuntimeFailure,DocumentRuntimeProgress,DocumentRuntimeStage,DocumentRuntimeObservation,DocumentRuntimeCommand,DocumentRuntimeEffect,DocumentRuntimeIssued,DocumentRuntimeUpdate,DocumentRuntimeOutcome,DocumentRuntimeReduction,DocumentRuntimeSnapshot} from './document-runtime.ts';
export type {DocumentRuntimeFailure,DocumentRuntimeProgress,DocumentRuntimeStage,DocumentRuntimeObservation,DocumentRuntimeCommand,DocumentRuntimeEffect,DocumentRuntimeIssued,DocumentRuntimeUpdate,DocumentRuntimeOutcome,DocumentRuntimeReduction,DocumentRuntimeSnapshot} from './document-runtime.ts';
interface Free {free():void}
export interface BrowserDocumentRuntimeIssuedWasm extends Free {descriptorJson():string;completeJson(result:string):string}
export interface BrowserDocumentRuntimeOwnerWasm extends Free {commandJson(command:string):string;updateJson():string;snapshotJson():string;issued(lifetime:string,id:string):BrowserDocumentRuntimeIssuedWasm;replayJson(lifetime:string,id:string):string|undefined}
export interface BrowserDocumentRuntimeWasm {WasmDocumentRuntimeOwner?:new(lifetime:string,localStore:string)=>BrowserDocumentRuntimeOwnerWasm}
export interface BrowserDocumentRuntimeBackend {
  assertActive():void;
  observe():Promise<DocumentRuntimeObservation>;initialize():Promise<void>;recoverStage():Promise<DocumentRuntimeStage|null>;
  begin():Promise<DocumentRuntimeStage>;pump(snapshot:BrowserIndexSnapshot):Promise<DocumentRuntimeStage>;
  publish(snapshot:BrowserIndexSnapshot):Promise<BrowserIndexSnapshot>;discard(snapshot:BrowserIndexSnapshot):Promise<void>;rebuild():Promise<void>;
}
export interface BrowserDocumentIndexMaintenance {
  command(command:DocumentRuntimeCommand):DocumentRuntimeReduction;
  step(token:{readonly lifetime:string;readonly effectId:string}):Promise<DocumentRuntimeReduction>;
  update():DocumentRuntimeUpdate|null;
  /** Actual pending effect + existing ACK outcomes; never advances policy. */
  snapshot():DocumentRuntimeSnapshot|null;
  /** Retire/drain accepted work, preserving the partial backend stage. */
  close():Promise<void>;
}
const LIMIT=64*1024;
const fail=(code:string)=>new BrowserVaultError(code,'Shared document maintenance is unavailable');
const bytes=(text:string)=>new TextEncoder().encode(text).byteLength;
function bounded(value:unknown):string {let raw:string;try{raw=JSON.stringify(value);}catch{throw fail('invalid_request');}if(typeof raw!=='string'||bytes(raw)>LIMIT)throw fail('document_runtime_capacity');return raw;}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function decode<T>(raw:string):T {if(typeof raw!=='string'||bytes(raw)>LIMIT)throw fail('document_runtime_capacity');try{return freeze(JSON.parse(raw) as T);}catch{throw fail('document_runtime_invalid_result');}}
function wasm<T>(operation:()=>T):T {try{return operation();}catch(error){if(error instanceof BrowserVaultError)throw error;let code='document_runtime_invalid_result';try{const row=JSON.parse(String(error));if(typeof row.code==='string'&&['invalid_request','document_runtime_capacity','document_runtime_retired','document_runtime_expired','document_runtime_busy'].includes(row.code))code=row.code;}catch{}throw new BrowserVaultError(code,'Shared document maintenance rejected the operation',undefined,'rust');}}
function failure(error:unknown):DocumentRuntimeFailure {
  if(!(error instanceof BrowserVaultError))return 'unavailable';
  switch(error.code){case 'index_source_changed':return 'staleSource';case 'index_head_changed':return 'staleIndex';case 'index_stage_expired':return 'snapshotExpired';case 'index_rebuild_required':return 'rebuildRequired';
    case 'storage_corrupt':case 'invalid_wasm_result':case 'document_runtime_invalid_result':return 'invalidData';
    case 'client_ownership_lost':case 'client_not_admitted':case 'storage_closed':case 'index_closed':return 'fatal';default:return 'unavailable';}
}
/** One step executes one issued effect. All scheduling, budget/retry/rebuild and
 * source-hint decisions remain in Rust. No timers, listeners or frontend policy. */
export function browserDocumentRuntime(options:{authorityId:string;wasm:BrowserDocumentRuntimeWasm;backend:BrowserDocumentRuntimeBackend}):BrowserDocumentIndexMaintenance {
  type Owner={value:BrowserDocumentRuntimeOwnerWasm;alive:boolean;broken?:boolean;failed?:{key:string;code:string;source:'host'|'rust'}};
  let owner:Owner|undefined,closing=false,closePromise:Promise<void>|undefined;
  let pending:{key:string;promise:Promise<DocumentRuntimeReduction>}|undefined;
  function active(owned?:Owner){options.backend.assertActive();if(owned&&(!owned.alive||owner!==owned))throw fail('document_runtime_expired');}
  function acquire():Owner {active();if(closing)throw fail('document_runtime_retired');if(!owner){const Constructor=options.wasm.WasmDocumentRuntimeOwner;if(!Constructor)throw fail('document_runtime_unavailable');owner={value:wasm(()=>new Constructor(crypto.randomUUID(),options.authorityId)),alive:true};}return owner;}
  const command=(input:DocumentRuntimeCommand):DocumentRuntimeReduction=>{
    const owned=acquire();let captured:unknown=input;
    if(input?.kind==='wake'){if(!Number.isSafeInteger(input.monotonicMs)||input.monotonicMs<0)throw fail('invalid_request');captured={...input,monotonicMs:String(input.monotonicMs)};}
    const report=decode<DocumentRuntimeReduction>(wasm(()=>owned.value.commandJson(bounded(captured))));if(input?.kind==='retire')owned.failed=undefined;return report;
  };
  async function execute(effect:DocumentRuntimeEffect):Promise<unknown> {
    switch(effect.kind){
      case 'observe':return {kind:'observed',observation:await options.backend.observe()};
      case 'recoverStage':return {kind:'recovered',stage:await options.backend.recoverStage()};
      case 'initialize':await options.backend.initialize();return {kind:'done'};
      case 'begin':return {kind:'stage',stage:await options.backend.begin()};
      case 'pump':return {kind:'stage',stage:await options.backend.pump(effect.snapshot)};
      case 'publish':return {kind:'published',snapshot:await options.backend.publish(effect.snapshot)};
      case 'discard':await options.backend.discard(effect.snapshot);return {kind:'done'};
      case 'rebuild':await options.backend.rebuild();return {kind:'done'};
      default:throw fail('document_runtime_invalid_result');
    }
  }
  const maintenance:BrowserDocumentIndexMaintenance={command,
    step(input){
      active();if(closing)return Promise.reject(fail('document_runtime_retired'));
      if(!input||typeof input!=='object'||Object.keys(input).length!==2||typeof input.lifetime!=='string'||typeof input.effectId!=='string')return Promise.reject(fail('invalid_request'));
      const lifetime=input.lifetime,id=input.effectId,key=bounded({lifetime,effectId:id});
      if(pending)return pending.key===key?pending.promise:Promise.reject(fail('document_runtime_busy'));
      const owned=owner;if(!owned)return Promise.reject(fail('document_runtime_not_started'));
      if(owned.broken)return Promise.reject(fail('document_runtime_expired'));
      const replay=wasm(()=>owned.value.replayJson(lifetime,id));if(replay!==undefined){if(owned.failed?.key===key)return Promise.reject(new BrowserVaultError(owned.failed.code,'The admitted maintenance effect failed',undefined,owned.failed.source));return Promise.resolve(decode(replay));}
      // Capture the real opaque issued handle before any IO. No IDB transaction
      // or Rust RefCell borrow survives the synchronous call below.
      const issued=wasm(()=>owned.value.issued(lifetime,id));owned.failed=undefined;
      const task=Promise.resolve().then(async()=>{try{
        active(owned);const descriptor=decode<DocumentRuntimeIssued>(wasm(()=>issued.descriptorJson()));
        if(descriptor.lifetime!==lifetime||descriptor.effectId!==id)throw fail('document_runtime_expired');
        let result:unknown,operationError:unknown,failed=false;
        try{result=await execute(descriptor.effect);}catch(error){operationError=error;failed=true;}
        // Admission wins over an operation failure after the await. Never use
        // stale owner/source data to settle a new lifetime or expose a result.
        try{active(owned);}catch(error){operationError=error;failed=true;}
        if(failed){
          try{wasm(()=>issued.completeJson(bounded({kind:'failed',failure:failure(operationError)})));}catch{owned.broken=true;}
          const known=operationError instanceof BrowserVaultError&&/^[a-z][a-z0-9_]{0,127}$/.test(operationError.code)?operationError:undefined;
          if(!owned.broken&&wasm(()=>owned.value.replayJson(lifetime,id))!==undefined)owned.failed={key,code:known?.code??'document_runtime_unavailable',source:known?.source??'host'};
          throw operationError;
        }
        try{return decode<DocumentRuntimeReduction>(wasm(()=>issued.completeJson(bounded(result))));}catch(error){owned.broken=true;throw error;}
      }finally{issued.free();}});
      const accepted=task.finally(()=>{if(pending?.promise===accepted)pending=undefined;});pending={key,promise:accepted};return accepted;
    },
    update(){if(!owner)return null;active(owner);return decode(wasm(()=>owner!.value.updateJson()));},
    snapshot(){if(!owner)return null;active(owner);return decode(wasm(()=>owner!.value.snapshotJson()));},
    close(){if(closePromise)return closePromise;closing=true;const owned=owner;
      if(owned){owned.failed=undefined;try{wasm(()=>owned.value.commandJson('{"kind":"retire"}'));}catch{/* Retirement still drops this owner after its accepted step unwinds. */}}
      closePromise=(async()=>{try{await pending?.promise.catch(()=>{});}finally{if(owned){owned.alive=false;owned.value.free();if(owner===owned)owner=undefined;}}})();return closePromise;
    },
  };return maintenance;
}
