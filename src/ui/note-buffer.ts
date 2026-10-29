import { assertNoteTextChange } from '../core/note-text-limit.ts';
import { DurableNoteState } from './note-durable-state.ts';
import type { Vault } from '../core/vault.ts';
import { isMarkdown, normalizePath } from '../core/types.ts';
import type { NoteMetadata } from '../core/types.ts';
import type { ConditionalSavedSourceCapture, ConditionalSavedSourceWitness, ConditionalSavedSourceStatus } from '../core/durable-writes.ts';
import { DocumentDraftProjection } from './document-draft-projection.ts';
import type { DraftMetadataState } from './document-draft-projection.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface NoteBufferOptions {
  storage?: StorageLike;
  /** Vault-scoped recovery key prefix; the encoded note path is appended. */
  storageKey?: string;
  debounceMs?: number;
  onState?: () => void;
  /** Display facts changed; independent of save/error notifications. */
  onMetadata?: () => void;
}
interface Draft { base: string; content: string; pending?: string }
const autosaveRetryDelays=[500,1500,4000] as const;
const transientSaveCodes=new Set(['busy','io','timeout','request_timeout','outcome_unknown','transport_error','transport_lost','planning_transport_lost','temporarily_unavailable','checkpoint_unavailable','EAGAIN','EBUSY','EIO','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE']);
function retryableSaveError(error:unknown):boolean {
  const seen=new Set<unknown>();
  // Vault wraps commit uncertainty with its original cause. A terminal inner
  // rejection must not become retryable merely because that wrapper is unknown.
  for(let depth=0;depth<8;depth++){
    if(!error||typeof error!=='object'||seen.has(error))return false;
    seen.add(error);
    const value=error as {code?:unknown;message?:unknown;cause?:unknown};
    if(typeof value.code==='string'){
      if(!transientSaveCodes.has(value.code))return false;
    }else if(typeof value.message!=='string'||!/^Durable(?: editor)? request failed(?:; retain pending recovery state\.)?\.?$/.test(value.message))return false;
    if(value.cause===undefined)return true;
    error=value.cause;
  }
  return false;
}

/** A note's editor state, independent of any particular pane or editor widget. */
export class NoteBuffer {
  path: string;
  text = '';
  savedText = '';
  dirty = false;
  error: Error | null = null;
  private vault: Vault;
  private options: NoteBufferOptions;
  private durable?: DurableNoteState;
  private loaded = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private autosaveEpoch=0;
  private autosaveRetries=0;
  private autosaveRunningEpoch?:number;
  private autosaveRequested=false;
  private retryingAutosave=false;
  private pending: Promise<unknown> = Promise.resolve();
  private recoveryCheckpoint?: { key: string; draft: Draft | null };
  private recoveryBase?: { text: string; json: string };
  private recoveryIntent?: { text: string; json: string };
  private recoveryPending = false;
  // An attempted write may have reached disk even when modify rejects. Retain
  // its intent until a successful completion or an explicit disk read resolves it.
  private writeIntent?: string;
  private conflict = false;
  private writeValidators = new Set<() => void>();
  private metadataProjection?:DocumentDraftProjection;
  private metadataDemand=false;
  private metadataRetired=false;
  private metadataNotificationPending=false;
  private disposing?:Promise<void>;

  /** Clean buffers use committed facts. Only an actual unsaved Markdown read
   * starts transient analysis; subsequent revisions share this buffer owner. */
  getMetadata():NoteMetadata|undefined {
    if(this.disposed||this.disposing||this.metadataRetired||!this.loaded||!isMarkdown(this.path))return undefined;
    if(this.text===this.savedText)return this.vault.metadata.get(this.path);
    this.metadataDemand=true;
    if(!this.metadataProjection){
      const service=this.vault.adapter.documentSemantics;
      this.metadataProjection=new DocumentDraftProjection({owner:this.vault,service:service?.drafts,capable:service?.draftsAvailable===true,onChange:()=>this.metadataChanged()});
      this.metadataProjection.update(this.path,this.savedText,{demand:false});
    }
    this.observeMetadata();return this.metadataProjection.current;
  }
  get metadataState():DraftMetadataState|undefined{return this.metadataProjection?.state;}
  private observeMetadata():void {
    if(this.text===this.savedText)this.metadataDemand=false;
    this.metadataProjection?.update(this.path,this.text,{demand:this.metadataDemand&&isMarkdown(this.path)&&this.text!==this.savedText&&!this.metadataRetired});
  }
  private metadataChanged():void {
    if(this.metadataNotificationPending||this.metadataRetired||this.disposed)return;
    this.metadataNotificationPending=true;
    queueMicrotask(()=>{this.metadataNotificationPending=false;if(!this.metadataRetired&&!this.disposed)try{this.options.onMetadata?.();}catch(error){console.error('Note metadata listener failed',error);}});
  }
  /** Retire facts without changing the durable draft or save error. A failed
   * close remains owned by this buffer and is retried by calling again. */
  async closeMetadataProjection():Promise<void>{this.metadataRetired=true;this.cancelAutosave();await this.metadataProjection?.close();}

  /** A bounded retry is scheduled or running; the original error stays visible
   * to callers until the durable save actually succeeds. */
  get autosaveRetryPending():boolean {
    if(!this.error||!this.canAutosave()||!this.dirty||this.conflict||this.hasRecoveryConflict||!retryableSaveError(this.error))return false;
    // Durable state can publish its error before the outer save promise rejects.
    // Its first notification already belongs to this admitted automatic attempt.
    return this.retryingAutosave||this.autosaveRetries<autosaveRetryDelays.length
      &&(this.timer!==undefined||this.autosaveRunningEpoch===this.autosaveEpoch);
  }

  private validateWrite(): void { for (const validate of this.writeValidators) validate(); }

  constructor(vault: Vault, path: string, options: NoteBufferOptions = {}) {
    this.vault = vault;
    this.path = normalizePath(path);
    this.options = options;
    if(vault.adapter?.durableWrites)this.durable=new DurableNoteState(vault,vault.adapter.durableWrites,()=>this.syncDurable());
  }

  /** The committed baseline of this loaded draft, never a fresh path lookup. */
  get savedDurableWitness():Readonly<{entryId:string;revision:string;path:string}>|undefined {
    if(!this.loaded||!this.durable?.ready)return undefined;
    const base=this.durable.base;
    return Object.freeze({entryId:base.entryId,revision:base.revision,path:base.path});
  }

  /** Physical source is a separate observation for conditional history checks;
   * it never replaces savedText or the durable logical baseline. */
  captureConditionalSavedSource(witness:ConditionalSavedSourceWitness,validate:()=>void=()=>{}):Promise<ConditionalSavedSourceCapture|undefined>{
    if(this.disposing)return Promise.reject(new Error('This note buffer is closing'));
    return this.enqueueResult(async()=>{
      this.requireLoaded();if(this.disposing)throw new Error('This note buffer is closing');if(!this.durable)return undefined;
      const capture=await this.durable.captureConditionalSavedSource(witness,()=>{validate();if(this.disposing)throw new Error('This note buffer is closing');});
      try{validate();if(this.disposing)throw new Error('This note buffer is closing');}
      catch(error){if(capture)await this.durable.releaseConditionalSavedSource(capture);throw error;}
      return capture;
    });
  }
  conditionalSavedSourceStatus(capture:ConditionalSavedSourceCapture):ConditionalSavedSourceStatus{return this.durable?.conditionalSavedSourceStatus(capture)??'foreign';}
  releaseConditionalSavedSource(capture:ConditionalSavedSourceCapture):Promise<void>{
    if(!this.durable)return Promise.reject(new Error('Conditional saved-source release is unavailable'));
    return this.durable.releaseConditionalSavedSource(capture);
  }

  private syncDurable():void {
    if(!this.durable)return;
    if(this.durable.ready){this.text=this.durable.text;this.savedText=this.durable.base.content;this.path=this.durable.base.path;}
    this.dirty=this.durable.dirty;this.error=this.durable.error;this.notify();
  }
  private key(path = this.path): string {
    return `${this.options.storageKey ?? 'zorid:draft'}:${encodeURIComponent(path)}`;
  }
  private notify(): void {
    this.observeMetadata();
    try { this.options.onState?.(); } catch (error) { console.error('Note state listener failed', error); }
  }
  private rememberError(error: unknown): Error {
    this.error = error instanceof Error ? error : new Error(String(error));
    return this.error;
  }
  private recover(): Draft | undefined {
    const raw = this.options.storage?.getItem(this.key());
    if (!raw) return undefined;
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== 'object' || !('base' in draft) || !('content' in draft)
      || typeof draft.base !== 'string' || typeof draft.content !== 'string'
      || ('pending' in draft && typeof draft.pending !== 'string')) {
      throw new Error(`Invalid recovery draft: ${this.path}`);
    }
    const recovered: Draft = { base: draft.base, content: draft.content,
      ...('pending' in draft ? { pending: draft.pending as string } : {}) };
    this.recoveryCheckpoint = { key: this.key(), draft: recovered };
    return recovered;
  }
  private persist(): boolean {
    const storage = this.options.storage;
    if (!storage) return true;
    const key = this.key(), previous = this.recoveryCheckpoint;
    if (previous?.key === key && (this.dirty
      ? previous.draft?.base === this.savedText && previous.draft.content === this.text && previous.draft.pending === this.writeIntent
      : previous.draft === null)) { this.recoveryPending = false; return true; }
    try {
      if (this.dirty) {
        // Every distinct edit still reaches recovery storage synchronously.
        // Only the unchanged base's JSON escaping is reused; the payload format
        // keeps base/content, with optional pending write intent for crash recovery.
        if (this.recoveryBase?.text !== this.savedText) {
          this.recoveryBase = { text: this.savedText, json: JSON.stringify(this.savedText) };
        }
        if (this.writeIntent === undefined) this.recoveryIntent = undefined;
        else if (this.recoveryIntent?.text !== this.writeIntent) {
          this.recoveryIntent = { text: this.writeIntent, json: JSON.stringify(this.writeIntent) };
        }
        const pending = this.recoveryIntent ? `,"pending":${this.recoveryIntent.json}` : '';
        storage.setItem(key, `{"base":${this.recoveryBase.json},"content":${JSON.stringify(this.text)}${pending}}`);
        this.recoveryCheckpoint = { key, draft: { base: this.savedText, content: this.text,
          ...(this.writeIntent === undefined ? {} : { pending: this.writeIntent }) } };
      } else {
        storage.removeItem(key);
        this.recoveryCheckpoint = { key, draft: null };
        this.recoveryBase = undefined;
        this.recoveryIntent = undefined;
      }
      this.recoveryPending = false;
      return true;
    } catch (error) { this.recoveryPending = true; this.rememberError(error); return false; }
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private cancelAutosave():void {
    this.cancelTimer();this.autosaveEpoch++;this.autosaveRetries=0;
    this.autosaveRequested=false;this.retryingAutosave=false;
  }
  private canAutosave():boolean{return this.loaded&&!this.disposed&&!this.disposing;}
  private scheduleAutosave(delay:number):void {
    if(!this.canAutosave()||!this.dirty||this.timer!==undefined)return;
    const epoch=this.autosaveEpoch;
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      if(epoch!==this.autosaveEpoch||!this.canAutosave())return;
      if(!this.dirty){const retrying=this.retryingAutosave;this.retryingAutosave=false;this.autosaveRetries=0;if(retrying)this.notify();return;}
      if(this.autosaveRunningEpoch!==undefined){this.autosaveRequested=true;return;}
      this.autosaveRunningEpoch=epoch;this.autosaveRequested=false;
      const saving=this.enqueue(async()=>{if(epoch===this.autosaveEpoch&&this.canAutosave()&&this.dirty)await this.save();});
      void saving.then(()=>this.finishAutosave(epoch),error=>this.finishAutosave(epoch,error));
    },delay);
  }
  private finishAutosave(epoch:number,error?:unknown):void {
    this.autosaveRunningEpoch=undefined;
    const requested=this.autosaveRequested;this.autosaveRequested=false;
    if(epoch!==this.autosaveEpoch){if(requested)this.scheduleAutosave(this.options.debounceMs??400);return;}
    const wasRetrying=this.retryingAutosave;
    if(error!==undefined&&this.canAutosave()&&this.dirty&&!this.conflict&&!this.hasRecoveryConflict
      &&retryableSaveError(error)&&this.autosaveRetries<autosaveRetryDelays.length){
      this.retryingAutosave=true;this.scheduleAutosave(autosaveRetryDelays[this.autosaveRetries++]);
      this.notify();return;
    }
    this.retryingAutosave=false;
    if(error===undefined){
      this.autosaveRetries=0;
      if(!this.dirty)this.cancelTimer();else this.scheduleAutosave(this.options.debounceMs??400);
    }
    if(wasRetrying)this.notify();
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(async () => {
      try { await operation(); } catch (error) { this.rememberError(error); this.notify(); throw this.error; }
    });
    // The queue itself always recovers; callers still receive the original rejection.
    this.pending = result.catch(() => undefined);
    return result;
  }
  private requireLoaded(): void {
    if (!this.loaded) throw new Error('Load the note before editing it');
    if (this.disposed) throw new Error('This note buffer is disposed');
  }
  private updateDirty(): void {
    this.dirty = this.conflict || this.writeIntent !== undefined || this.text !== this.savedText;
  }
  private async readForReconciliation(): Promise<string> {
    if (this.writeIntent === undefined && !this.conflict) return this.vault.read(this.path);
    // A failed modify may have changed bytes without publishing contents/indexes.
    // Keep intent/dirty set through publication, so modify listeners do not treat
    // this as an already-clean buffer. Reconcile against the published snapshot;
    // even a return to the old base can leave an independently refreshed cache stale.
    await this.vault.reload([this.path]);
    return this.vault.cachedRead(this.path);
  }
  /** Content equality is the optimistic-write contract; stats are insufficient. */
  private reconcileWrite(disk: string): void {
    if (disk !== this.savedText && disk !== this.writeIntent) {
      this.conflict = true; this.updateDirty();
      throw new Error(`File changed outside this editor; recovery draft preserved: ${this.path}`);
    }
    this.savedText = disk;
    this.writeIntent = undefined;
    this.conflict = false;
    this.updateDirty();
    this.error = null;
  }

  private expectedEntryId?:string;
  load(expectedEntryId?:string,validate:()=>void=()=>{}): Promise<void> {
    return this.enqueue(async () => {
      validate();
      if(expectedEntryId!==undefined&&this.expectedEntryId!==undefined&&this.expectedEntryId!==expectedEntryId)throw new Error('This note buffer belongs to another entry');
      const admittedEntryId=expectedEntryId??this.expectedEntryId;
      if (this.loaded) {
        if(admittedEntryId!==undefined&&this.savedDurableWitness?.entryId!==admittedEntryId)throw new Error('The selected note identity changed; previous draft retained');
        this.expectedEntryId=admittedEntryId;
        return;
      }
      if (this.disposed) throw new Error('This note buffer is disposed');
      if(this.durable){await this.durable.load(this.path,admittedEntryId,validate);this.expectedEntryId=admittedEntryId;this.loaded=true;this.syncDurable();return;}
      if(admittedEntryId!==undefined)throw new Error('Stable note admission requires durable identity');
      const disk = await this.vault.read(this.path);
      this.text = this.savedText = disk;
      this.error = null;
      let draft: Draft | undefined;
      try { draft = this.recover(); } catch (error) { this.rememberError(error); }
      if (draft) {
        this.text = draft.content;
        this.savedText = draft.base;
        this.writeIntent = draft.pending;
        if (disk === draft.base || disk === draft.pending) { this.reconcileWrite(disk); this.persist(); }
        else {
          this.conflict = true; this.updateDirty();
          this.error = new Error(`File changed outside this editor; recovery draft preserved: ${this.path}`);
        }
      }
      this.loaded = true;
      this.notify();
    });
  }

  /** Check authoring before an editor applies its transaction. Recovery loads bypass this. */
  validateTextChange(text:string):void {
    if(this.durable&&isMarkdown(this.path))assertNoteTextChange(this.text,text);
  }

  update(text: string, options: { validateWrite?: () => void; conditionalSavedSource?:ConditionalSavedSourceCapture } = {}): void {
    this.requireLoaded();
    if(this.disposing)throw new Error('This note buffer is closing');
    this.validateTextChange(text);
    if(options.conditionalSavedSource){
      if(!this.durable)throw new Error('Conditional saved-source writes are unavailable');
      this.durable.validateConditionalSavedSource(options.conditionalSavedSource);
    }
    // Guards belong to the accepted draft, including failed writes and later retries.
    // Ordinary typing cannot discard the lifetime protection of an earlier edit.
    if (options.validateWrite) { options.validateWrite(); this.writeValidators.add(options.validateWrite); }
    const changed = text !== this.text;
    this.text = text;
    if(this.durable){this.durable.update(text,options.conditionalSavedSource);this.dirty=this.durable.dirty;}else this.updateDirty();
    if (!this.dirty) {this.writeValidators.clear();this.cancelAutosave();}
    if(!this.durable)this.persist();
    if (changed) {this.cancelTimer();this.autosaveRetries=0;}
    // Repeated delivery of the same snapshot must not postpone a pending save.
    // persist still retries if its previous attempt failed.
    this.scheduleAutosave(this.options.debounceMs??400);
    this.notify();
  }

  private async save(): Promise<void> {
    this.requireLoaded();
    if(this.durable){await this.durable.flush(()=>this.validateWrite());this.syncDurable();if(!this.dirty)this.writeValidators.clear();return;}
    this.validateWrite();
    if (this.writeIntent !== undefined || this.conflict) {
      const disk = await this.readForReconciliation();
      this.validateWrite();
      this.reconcileWrite(disk);
      if (!this.dirty) { this.writeValidators.clear(); this.persist(); this.notify(); return; }
    }
    // Retry cleanup after a successful file save. Dirty states below checkpoint
    // the latest text and write intent before attempting another file write.
    if (!this.dirty && this.recoveryPending) this.persist();
    while (this.dirty) {
      this.validateWrite();
      const content = this.text;
      this.writeIntent = content;
      this.updateDirty();
      this.persist();
      await this.vault.modify(this.path, content, { expectedContent: this.savedText, validate: () => this.validateWrite() });
      this.savedText = content;
      this.writeIntent = undefined;
      this.conflict = false;
      this.updateDirty();
      this.error = null;
      this.persist();
      this.notify();
      // Edits made during the write use the just-committed content as their base.
    }
    this.writeValidators.clear();
  }

  flush(): Promise<void> {
    this.cancelAutosave();
    // A completed retirement already saved this immutable buffer. Workspace
    // teardown may retry after a later buffer's independent close failed.
    if(this.disposed)return Promise.resolve();
    return this.enqueue(() => this.save()).then(()=>{if(!this.dirty)this.cancelTimer();});
  }

  get hasRecoveryConflict():boolean { return !!this.durable?.conflicted; }

  /** Retained conflicts stay navigable without turning navigation into a save. */
  flushForNavigation():Promise<void> {
    if(!this.hasRecoveryConflict)return this.flush();
    this.cancelAutosave();
    return this.enqueue(async()=>{await this.durable!.preserveDraft();this.syncDurable();});
  }

  saveRecoveryCopy():Promise<{path:string;resolved:boolean}> {
    this.cancelAutosave();
    return this.enqueueResult(async()=>{
      this.requireLoaded();
      if(!this.durable)throw new Error('Durable recovery is unavailable for this note');
      const result=await this.durable.saveRecoveryCopy();this.syncDurable();
      if(!this.dirty)this.writeValidators.clear();
      return result;
    });
  }

  private enqueueResult<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.pending.then(operation).catch(error=>{this.rememberError(error);this.notify();throw this.error;});
    this.pending=result.catch(()=>undefined);return result;
  }

  reload(): Promise<void> {
    return this.enqueue(async () => {
      this.requireLoaded();
      if(this.durable){await this.durable.reload();this.syncDurable();return;}
      const disk = await this.readForReconciliation();
      if (this.writeIntent !== undefined) { this.reconcileWrite(disk); this.persist(); this.notify(); return; }
      // Recheck after read: typing may have started while the adapter was busy.
      if (this.dirty) {
        if (disk !== this.savedText) throw new Error(`File changed outside this editor: ${this.path}`);
        if (this.conflict) { this.reconcileWrite(disk); this.persist(); this.notify(); }
        return;
      }
      this.text = this.savedText = disk;
      this.error = null;
      this.persist();
      this.notify();
    });
  }

  /** A collection property command may publish while the body is being edited.
   * Reconcile through the identity-bound provider, never a blind source reload. */
  refreshManagedProjection(validate:()=>void=()=>{}):Promise<void> {
    return this.enqueue(async()=>{
      this.requireLoaded();validate();
      if(!this.durable)throw new Error('Managed projection refresh requires durable note storage');
      await this.durable.refreshManagedProjection(()=>{validate();if(this.disposing||this.disposed)throw new Error('This note buffer is closing');});
      this.syncDurable();if(!this.dirty)this.writeValidators.clear();
    });
  }

  private async relocateNow(destination: string): Promise<void> {
    if(this.durable){await this.durable.reload(destination);this.syncDurable();return;}
    const oldPath = this.path;
    this.path = destination;
    const migrated = this.persist();
    if (migrated && oldPath !== destination) {
      try { this.options.storage?.removeItem(this.key(oldPath)); } catch (error) { this.rememberError(error); }
    }
    const disk = await this.readForReconciliation();
    // A rename can rewrite relative links. Never replace edits made during the move.
    if (!this.dirty) {
      this.text = this.savedText = disk;
      this.error = null;
    } else if (disk !== this.savedText && disk !== this.writeIntent) {
      this.conflict = true; this.updateDirty();
      this.error = new Error(`File changed during rename; editor draft preserved: ${this.path}`);
    } else {
      this.reconcileWrite(disk);
    }
    this.persist();
    this.notify();
  }

  /** Adopt a path already moved by Vault, including a containing folder's rename. */
  relocate(newPath: string): Promise<void> {
    this.cancelAutosave();
    return this.enqueue(async () => {
      this.requireLoaded();
      await this.relocateNow(normalizePath(newPath));
    });
  }

  rename(newPath: string): Promise<void> {
    this.cancelAutosave();
    return this.enqueue(async () => {
      const destination = normalizePath(newPath);
      await this.save();
      if (destination === this.path) return;
      await this.vault.rename(this.path, destination);
      await this.relocateNow(destination);
    });
  }

  dispose(): Promise<void> {
    if(this.disposing)return this.disposing;
    this.cancelAutosave();
    // Reserve retirement before calling any save/provider code. Save remains
    // usable after a failed facts ACK, while editing cannot race the barrier.
    const closing=Promise.resolve().then(async()=>{
      await this.enqueue(async () => {
        if (this.disposed) return;
        try { await this.save(); }
        finally { this.cancelTimer(); }
      });
      await this.durable?.releaseUnattachedConditionalSavedSources();
      // Facts cleanup must never become a durable save failure.
      await this.closeMetadataProjection();this.disposed=true;
    }).finally(()=>{if(this.disposing===closing)this.disposing=undefined;});
    this.disposing=closing;return closing;
  }
}
