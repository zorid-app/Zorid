import type { CheckpointScope } from '../core/durable-checkpoints.ts';
import type { VaultEntry } from '../core/types';
import type { ContextMenuRequest } from './context-menu';

/** Positive conditional saved-source advertisement means the caller-owned V2
 * capture/release/bounded-list triple, with a same-scope independentJournal.
 * The old server-generated capture identity is never a fallback capability. */
export interface DesktopDurableContext { conditionalSavedSourceAvailable?:true; textCreateReceiptsAvailable?:true; workBlocks?:true; databases?:true; documentSemantics?:true; documentMaintenance?:true; metadataRowsAvailable?:boolean; propertyTargetsAvailable?:boolean; basePreviewAvailable?:boolean; draftsAvailable?:boolean; admissionId: string; scope: CheckpointScope; binaryLimits?:import('../core/binary-streams.ts').BinaryStreamLimits }
export interface DesktopIndependentJournalGrant {readonly token:string;readonly scope:import('../core/independent-drafts.ts').IndependentDraftScope}
export interface DesktopDurableContext {readonly independentJournal?:DesktopIndependentJournalGrant}
export interface DesktopIndependentJournalRequest {readonly vault:string;readonly token:string;readonly op:'list'|'read'|'compareAndSwap'|'retire'|'isRetiredIncarnation';readonly args:readonly unknown[]}
export interface DesktopReconciliation {
  work?: {phase: 'discovery' | 'import' | 'publication' | 'complete' | 'blocked'; pending: boolean; workUnits: number};
  scanId: string; complete: boolean; scanComplete: boolean; finished: boolean;
  observed: number; imported: number; namespaceApplied: number; issueCount: number; issuesTruncated: boolean;
  issues: readonly {path: string | null; code: 'scan_limit' | 'recovery_retained' | 'changed_during_scan' | 'reconciliation_blocked'}[];
  failure?: 'scan_failed';
}
export interface RecoveryCursor {captured_at_ms:number;snapshot_id:string}
export interface RecoveryVersion {snapshotId:string;entryId:string;path:string;capturedAtMs:number;byteLength:number}
export interface RecoveryHistory {
  list(entryId:string,options:{limit:number;before?:RecoveryCursor}):Promise<{versions:RecoveryVersion[];nextCursor?:RecoveryCursor}>;
  read(entryId:string,snapshotId:string):Promise<{version:RecoveryVersion;content:string}>;
}
export interface DesktopVault { path: string; name: string; reconciliation?: DesktopReconciliation }
export interface DesktopWindowInfo { id: string; initialState: 'restore' | 'empty' }
export interface VaultChange { vault?: string; type: string; path?: string; message?: string; reconciliation?: DesktopReconciliation }
/** Optional internal route over the existing admitted desktop IPC handlers. */
export type DesktopDurableRequest = {kind:'context';vault:string}
  | {kind:'recover'|'release';vault:string;admissionId:string}
  | {kind:'invoke';vault:string;admissionId:string;method:string;args:readonly unknown[]};
export interface DesktopDurableFailure {
  durableError:true;schemaVersion:1;
  error:{code:string;commitUncertain:boolean;source:'host'|'transport'|'protocol'};
}
export interface DesktopBridge {
  /** Independent main-owned draft storage; never routed through Rust. */
  independentJournal?(request:DesktopIndependentJournalRequest):Promise<unknown>;
  /** Successes/domain envelopes are unchanged; generic errors are plain data. */
  durableRequest?(request:DesktopDurableRequest):Promise<unknown>;
  getWindowInfo?(): Promise<DesktopWindowInfo>;
  newWindow?(): Promise<{ id: string }>;
  setMenuHotkeys?(bindings: { id: 'new-window' | 'close-tab'; shortcut: string }[]): Promise<void>;
  onCommand?(callback: (id: 'close-tab') => void): () => void;
  compareAndWrite?(vault: string, path: string, expectedContent: string, contents: string): Promise<void>;
  showContextMenu?(request: ContextMenuRequest): Promise<string | null>;
  dismissContextMenu?(): Promise<void>;
  getPathForFile?(file: File): string;
  getVault(): Promise<DesktopVault | null>;
  recoveryList?(vault:string,entryId:string,options:{limit:number;before?:RecoveryCursor}):ReturnType<RecoveryHistory['list']>;
  recoveryRead?(vault:string,entryId:string,snapshotId:string):ReturnType<RecoveryHistory['read']>;
  retryReconciliation?(vault: string): Promise<DesktopReconciliation>;
  /** Native close is held until this asynchronous save/release callback succeeds. */
  onBeforeClose?(handler: () => Promise<void>): () => void;
  getDurableContext?(vault: string): Promise<DesktopDurableContext | null>;
  /** Explicit replacement of a terminal admission; keeps its durable store/client scope. */
  recoverDurableContext?(vault: string, admissionId: string): Promise<DesktopDurableContext>;
  /** WorkBlock commands resolve a versioned plain-data envelope; decode after this bridge. */
  durableInvoke?(vault: string, admissionId: string, method: string, args: readonly unknown[]): Promise<unknown>;
  /** Dedicated derived-state hints; these must never become VaultChange events. */
  onDocumentRuntimeNudge?(vault:string,admissionId:string,callback:()=>void,onRetire:()=>void):()=>void;
  releaseDurableContext?(vault: string, admissionId: string): Promise<void>;
  openVault(): Promise<DesktopVault | null>;
  list(vault: string): Promise<VaultEntry[]>;
  stat(vault: string, path: string): Promise<VaultEntry | null>;
  read(vault: string, path: string): Promise<string>;
  readBinary(vault: string, path: string): Promise<Uint8Array>;
  write(vault: string, path: string, contents: string): Promise<void>;
  writeBinary(vault: string, path: string, contents: Uint8Array): Promise<void>;
  mkdir(vault: string, path: string): Promise<void>;
  rename(vault: string, from: string, to: string): Promise<void>;
  trash(vault: string, path: string): Promise<void>;
  remove?(vault: string, path: string, force: boolean): Promise<void>;
  onChange(callback: (change: VaultChange) => void): () => void;
}
declare global { interface Window { zorid?: DesktopBridge } }
