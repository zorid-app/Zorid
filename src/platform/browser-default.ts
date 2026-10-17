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

export const DEFAULT_BROWSER_DATABASE='zorid-core-vault:default-v1';
/** Normal browser commands retain the exact request after uncertain transport.
 * The admitted consumer owns durable command checkpoints and terminal ACKs. */
export function defaultBrowserAdapter(runtime:BrowserCoreRuntime,consumer:BrowserClientContext):VaultAdapter{
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
  return {
    durableWrites:consumer.durableWrites,durableNamespace:true,
    list:()=>facade.list(),stat:path=>facade.stat(path),read:path=>facade.read(path),readBinary:path=>facade.readBinary(path),subscribe:listener=>facade.subscribe(listener),
    createText:(path,content)=>execute({kind:'createText',path,content}),
    write:(path,content)=>execute({kind:'writeText',path,content}),
    compareAndWrite:(path,expectedContent,content,expectedIdentity)=>execute({kind:'writeText',path,content,expectedContent,...(expectedIdentity?{expectedEntryId:expectedIdentity.entryId,expectedRevision:expectedIdentity.revision}:{})}),
    createBinary:(path,data)=>execute({kind:'createBinary',path,data}),
    writeBinary:(path,data)=>execute({kind:'writeBinary',path,data}),
    mkdir:path=>execute({kind:'mkdir',path}),rename:(path,destination)=>execute({kind:'move',path,destination}),
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
    runtime=await BrowserCoreRuntime.open({database:DEFAULT_BROWSER_DATABASE,clientId:slot.clientId,allowNewVault:true,initializeLocal:true,
      wasmModuleUrl:new URL(modulePath,document.baseURI).href});
    let active=true;
    const opened=runtime;
    const consumer=admitBrowserClient(opened,{assertOwner:()=>{if(!active)throw new BrowserVaultError('client_ownership_lost','Browser tab no longer owns its vault');}});
    const adapter=defaultBrowserAdapter(opened,consumer);
    const retire=()=>{active=false;opened.close();slot.retire();};
    window.addEventListener('pagehide',retire,{once:true});
    const release=createBrowserRelease(consumer,slot,()=>{active=false;window.removeEventListener('pagehide',retire);});
    return {adapter,label:'Browser vault',id:`browser:core:${consumer.scope.vaultId}:client:${consumer.scope.clientId}`,
      legacyExport:legacyBrowserExport(),recoverCommands:()=>consumer.recoverCommands!(),
      release,
    };
  }catch(error){runtime?.close();slot.retire();throw error;}
}
