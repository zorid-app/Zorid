/** Local raw-draft protection is independent of domain saves/checkpoints. Main
 * binds this scope from trusted admission; it is not a renderer scope grant. */
export interface IndependentDraftScope {readonly vaultId:string;readonly clientId:string;readonly incarnationId:string}
export interface IndependentDraftBaseline {readonly entryId:string;readonly path:string;readonly revision:string;readonly content:string}
export interface IndependentDraftAddress {readonly entryId:string;readonly writer:string;readonly incarnationId?:string}
export interface IndependentDraftListOptions {readonly entryId:string}
export interface IndependentDraftReceipt extends IndependentDraftScope {
  readonly entryId:string;readonly writer:string;readonly revision:string;readonly generation:number;readonly deleted:boolean;
}
export interface IndependentDraftChange {
  readonly entryId:string;readonly writer:string;readonly generation:number;
  readonly expectedRevision:string|null;readonly nextRevision:string;
  readonly baseline:IndependentDraftBaseline;readonly draft:string;readonly checkpointRevision:string|null;
  /** Exact opaque recovery capsule. Storage does not parse or replay it. */
  readonly pendingOperation:string|null;
}
export interface IndependentDraftRetirement {
  readonly entryId:string;readonly writer:string;readonly incarnationId:string;readonly generation:number;
  readonly expectedRevision:string;readonly nextRevision:string;
}
export interface IndependentDraftCandidate extends IndependentDraftReceipt {
  readonly deleted:false;readonly baseline:IndependentDraftBaseline;readonly draft:string;
  readonly checkpointRevision:string|null;readonly pendingOperation:string|null;
}
export type IndependentDraftRead=IndependentDraftCandidate|(IndependentDraftReceipt&{readonly deleted:true})|null;
/** A bound provider preserves competing incarnations/lineages. Revisions are
 * positive decimal u64 counters; an uncertain CAS/retirement retries its exact
 * original request. Reading a head never authorizes rebasing that request. */
export interface IndependentDraftProvider {
  readonly scope:IndependentDraftScope;
  /** Trusted same-vault/client certificate after prior Core RPC ownership has
   * drained. A different incarnation ID alone is never proof of retirement.
   * Legacy absence cannot authorize cleanup; unknown failures must reject. */
  isRetiredIncarnation?(incarnationId:string):Promise<boolean>;
  compareAndSwap(request:IndependentDraftChange):Promise<IndependentDraftReceipt>;
  retire(request:IndependentDraftRetirement):Promise<IndependentDraftReceipt>;
  read(address:IndependentDraftAddress):Promise<IndependentDraftRead>;
  /** Ordinary note opening selects one entry; a recovery overview may list all. */
  list(options?:IndependentDraftListOptions):Promise<readonly IndependentDraftReceipt[]>;
}
