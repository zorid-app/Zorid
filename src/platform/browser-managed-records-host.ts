import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserStreamingManagedRecords } from '../core/browser-sync-streaming.ts';
import type { ManagedCollectionHandle } from '../core/browser-managed-records.ts';
import type { ManagedHostConsumer, ManagedHostScope } from './browser-managed-records-registry.ts';

interface Host {
  records:BrowserStreamingManagedRecords;
  consumers:readonly ManagedHostConsumer[];
  scope():Promise<ManagedHostScope|null>;
  hasSession():boolean;
  assertActive():void;
  local<T>(operation:()=>Promise<T>):Promise<T>;
  notify():void;
  failed(error:unknown):void;
}
/** Event-driven maintenance on the worker's existing local tail. No timer,
 * network loop, second database or public registration/owner capability. */
export function createBrowserManagedRecordsHost(host:Host) {
  if(host.consumers.length>4)throw new BrowserVaultError('managed_host_capacity','First-party host registry exceeds its bounded budget');
  const entries:Array<{consumer:ManagedHostConsumer;handle:ManagedCollectionHandle;after:string}>=[];
  let stopped=false, pending:Promise<void>|undefined,again=false,scopeId:string|undefined;
  const active=()=>{host.assertActive();if(stopped)throw new BrowserVaultError('client_not_admitted','Managed host is closing');};
  async function maintain() {
    active();
    const scope=await host.scope();active();
    if(!scope)return;
    const identity=JSON.stringify([scope.realm_id,scope.vault_id]);
    if(scopeId!==undefined&&scopeId!==identity)throw new BrowserVaultError('sync_scope_conflict','Managed host scope changed');
    scopeId=identity;
    for(const consumer of host.consumers.slice(entries.length)){
      active();
      const handle=await host.records.register({realmId:scope.realm_id,vaultId:scope.vault_id,owner:consumer.owner,collection:consumer.collection},consumer.registration(scope));
      active();entries.push({consumer,handle,after:'0'});
    }
    // Each round is at most four existing adapter pages (16 receipts / 1 MiB
    // each) and four 64-row change pages. Yield to other local operations at
    // this finite budget; further work waits for a new host trigger.
    for(let round=0;round<4;round++){
      again=false;let more=false;
      for(const entry of entries){
        active();
        if(host.hasSession()){
          const retry=await host.records.retryPage(entry.handle);active();
          more ||= retry.changed||!retry.exhausted;
        }
        const changes=await host.records.changes(entry.handle,entry.after,64);active();
        if(changes.length){
          entry.consumer.changed(changes);active();
          // Advance only after delivery. A failed callback is retried on the
          // next external trigger; consumers must tolerate repeated metadata.
          entry.after=changes.at(-1)!.sequence;
          host.notify();active();
        }
        more ||= changes.length===64;
      }
      if(!more&&!again)break;
    }
  }
  function trigger():Promise<void> {
    if(stopped||!host.consumers.length)return Promise.resolve();
    if(pending){again=true;return pending;}
    const task=host.local(maintain);
    pending=task.catch(error=>{if(!stopped)host.failed(error);}).finally(()=>{pending=undefined;});
    return pending;
  }
  return {
    trigger,
    /** Synchronous admission fence, before the release operation is queued. */
    stop(){stopped=true;},
    async drain(){await pending;for(const entry of entries)entry.handle.dispose();entries.length=0;},
  };
}
