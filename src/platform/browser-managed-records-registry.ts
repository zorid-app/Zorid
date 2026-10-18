import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserStreamingManagedRecords } from '../core/browser-sync-streaming.ts';
import type { ManagedCollectionHandle } from '../core/browser-managed-records.ts';

export interface ManagedHostScope { realm_id:string; vault_id:string }
export type ManagedHostChange = Awaited<ReturnType<BrowserStreamingManagedRecords['changes']>>[number];
/** Compile-time first-party authority, never supplied by a worker message. */
export interface ManagedHostConsumer {
  readonly owner:string;
  readonly collection:string;
  registration(scope:ManagedHostScope):Uint8Array;
  opened?(handle:ManagedCollectionHandle):void;
  /** Durable metadata only. Consumers read lossless state through their own internal binding. */
  changed(changes:readonly ManagedHostChange[]):void;
}
export interface WorkBlockRegistrationWasm {
  workBlockIdentity():string;
  workBlockRegistration(enrolledScopeJson:string):Uint8Array;
}
/** Called only after loading the application WASM; renderer input cannot select
 * owner, schema or collection. Exactly one compiled first-party consumer. */
export function createBrowserManagedRecordConsumers(wasm:WorkBlockRegistrationWasm,
  callbacks:Pick<ManagedHostConsumer,'opened'|'changed'>):readonly ManagedHostConsumer[] {
  if(typeof wasm.workBlockIdentity!=='function'||typeof wasm.workBlockRegistration!=='function')
    throw new BrowserVaultError('workblocks_unavailable','Compiled WorkBlock registration is unavailable');
  const identity=JSON.parse(wasm.workBlockIdentity());
  if(identity?.owner!=='zorid_firstparty_calendar'||identity?.collection!=='workblocks'||identity?.schemaVersion!==1)
    throw new BrowserVaultError('workblocks_unavailable','Compiled WorkBlock identity is inconsistent');
  return Object.freeze([Object.freeze({owner:identity.owner as string,collection:identity.collection as string,
    registration:(scope:ManagedHostScope)=>wasm.workBlockRegistration(JSON.stringify({realm_id:scope.realm_id,vault_id:scope.vault_id})),
    opened:callbacks.opened,changed:callbacks.changed})]);
}
