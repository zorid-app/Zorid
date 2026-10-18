import type { BrowserStreamingManagedRecords } from '../core/browser-sync-streaming.ts';

export interface ManagedHostScope { realm_id:string; vault_id:string }
export type ManagedHostChange = Awaited<ReturnType<BrowserStreamingManagedRecords['changes']>>[number];
/** Compile-time first-party authority, never supplied by a worker message. */
export interface ManagedHostConsumer {
  readonly owner:string;
  readonly collection:string;
  registration(scope:ManagedHostScope):Uint8Array;
  /** Durable metadata only. Consumers read lossless state through their own internal binding. */
  changed(changes:readonly ManagedHostChange[]):void;
}

// Activation boundary: no product feature/schema has been approved yet. The real
// Worker fixture substitutes this module at build time with one fixed consumer.
export const browserManagedRecordConsumers:readonly ManagedHostConsumer[] = Object.freeze([]);
