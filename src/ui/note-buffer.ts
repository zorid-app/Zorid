import { assertNoteTextChange } from '../core/note-text-limit.ts';
import { DurableNoteState } from './note-durable-state.ts';
import type { Vault } from '../core/vault.ts';
import { isMarkdown, normalizePath } from '../core/types.ts';
import type { NoteMetadata } from '../core/types.ts';
import type { ConditionalSavedSourceCapture, ConditionalSavedSourceWitness, ConditionalSavedSourceStatus,ConditionalSavedSourceRequest } from '../core/durable-writes.ts';
import { DocumentDraftProjection } from './document-draft-projection.ts';
import type { DraftMetadataState } from './document-draft-projection.ts';
import type {NoteDraftProtectionStatus} from './note-draft-protection.ts';

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
  private initialLoad?:{controller:AbortController};
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private autosaveEpoch=0;
  private autosaveRunningEpoch?:number;
  private autosaveRequested?:string;
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
  private independentRecoverySeen=false;

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

  /** Independent protection never clears dirty or claims a domain save. */
  get draftProtectionStatus():NoteDraftProtectionStatus|undefined{return this.durable?.draftProtectionStatus;}
  flushDraftProtection():Promise<void>{return this.durable?.flushDraftProtection()??Promise.resolve();}
  draftProtectionAvailable():void{this.durable?.draftProtectionAvailable();}
  get pendingCanonicalRecovery():boolean{return this.durable?.pendingCanonicalRecovery??false;}
  /** Only this proof permits mounting an editor or retaining a source operation. */
  get hasAdmittedContent():boolean{return this.loaded;}
  cancelInitialLoad():void{this.initialLoad?.controller.abort();}
  async disposeUnadmitted():Promise<void>{
    if(this.loaded)throw new Error('An admitted note must use its durable close barrier');
    this.disposed=true;this.cancelInitialLoad();this.durable?.stopDraftProtection();await this.closeMetadataProjection();
  }
  coreAdmissionAvailable(scope:{vaultId:string;clientId:string}):void{this.durable?.coreAdmissionAvailable(scope);}

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
    try{this.requireLoaded();}catch(error){return Promise.reject(error);}
    if(!this.durable)return Promise.resolve(undefined);
    return this.durable.captureConditionalSavedSource(witness,()=>{validate();if(this.disposing)throw new Error('This note buffer is closing');},run=>this.enqueueResult(run));
  }
  conditionalSavedSourceStatus(capture:ConditionalSavedSourceCapture):ConditionalSavedSourceStatus{return this.durable?.conditionalSavedSourceStatus(capture)??'foreign';}
  resumeConditionalSavedSourceOperation(request:ConditionalSavedSourceRequest,operationId:string,validate:()=>void):Promise<boolean>{
    return this.enqueueResult(async()=>{this.requireLoaded();validate();if(this.disposing||!this.durable)return false;
      const resumed=await this.durable.resumeConditionalSavedSourceOperation(request,operationId,()=>{validate();if(this.disposing)throw Error('This note buffer is closing');});this.syncDurable();return resumed;});
  }
  releaseConditionalSavedSource(capture:ConditionalSavedSourceCapture):Promise<void>{
    if(!this.durable)return Promise.reject(new Error('Conditional saved-source release is unavailable'));
    return this.durable.releaseConditionalSavedSource(capture);
  }

  private syncDurable():void {
    if(!this.durable)return;
    if(this.durable.ready){this.text=this.durable.text;this.savedText=this.durable.base.content;this.path=this.durable.base.path;}
    this.dirty=this.durable.dirty;this.error=this.durable.error;this.notify();
    if(this.loaded&&!this.independentRecoverySeen&&this.durable.recoveredIndependentDraft){this.independentRecoverySeen=true;
      if(this.dirty&&!this.hasRecoveryConflict)this.scheduleAutosave(this.options.debounceMs??400);}
  }
  private key(path = this.path): string {
    return `${this.options.storageKey ?? 'zorid:draft'}:${encodeURIComponent(path)}`;
  }
  private notify(): void {
    if(this.disposed)return;
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
    this.cancelTimer();this.autosaveEpoch++;
    this.autosaveRequested=undefined;
  }
  private canAutosave():boolean{return this.loaded&&!this.disposed&&!this.disposing&&!this.durable?.terminalCanonicalRecovery;}
  private scheduleAutosave(delay:number):void {
    if(!this.canAutosave()||!this.dirty||this.timer!==undefined)return;
    const epoch=this.autosaveEpoch;
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      if(epoch!==this.autosaveEpoch||!this.canAutosave())return;
      if(!this.dirty)return;
      if(this.autosaveRunningEpoch!==undefined){this.autosaveRequested=this.text;return;}
      this.autosaveRunningEpoch=epoch;this.autosaveRequested=undefined;
      let attemptedContent:string|undefined;
      const saving=this.enqueue(async()=>{if(epoch===this.autosaveEpoch&&this.canAutosave()&&this.dirty)await this.save(content=>{attemptedContent=content;});});
      void saving.then(()=>this.finishAutosave(epoch,undefined,attemptedContent),error=>this.finishAutosave(epoch,error,attemptedContent));
    },delay);
  }
  private finishAutosave(epoch:number,error?:unknown,attemptedContent?:string):void {
    this.autosaveRunningEpoch=undefined;
    const requested=this.autosaveRequested;this.autosaveRequested=undefined;
    // Preserve only an edit debounce the active save has not already consumed.
    const newerRequest=requested!==undefined&&requested!==attemptedContent&&this.text===requested;
    if(epoch!==this.autosaveEpoch){if(newerRequest)this.scheduleAutosave(this.options.debounceMs??400);return;}
    if(error===undefined){
      if(!this.dirty)this.cancelTimer();else this.scheduleAutosave(this.options.debounceMs??400);
    }else if(newerRequest)this.scheduleAutosave(this.options.debounceMs??400);
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
  private async readInitial<T>(operation:(check:()=>void)=>Promise<T>,validate:()=>void,signal?:AbortSignal):Promise<T>{
    const owner={controller:new AbortController()};this.initialLoad=owner;
    const cancelled=()=>Object.assign(new Error('The note load was cancelled'),{code:'note_load_cancelled'});
    let rejectCancellation!:(error:Error)=>void;
    const cancellation=new Promise<never>((_resolve,reject)=>{rejectCancellation=reject;});
    void cancellation.catch(()=>{});
    const cancel=()=>rejectCancellation(cancelled());
    owner.controller.signal.addEventListener('abort',cancel,{once:true});
    const abort=()=>owner.controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const check=()=>{if(owner.controller.signal.aborted||this.disposed||this.initialLoad!==owner)throw cancelled();validate();};
    try{
      check();
      // One provider call. Racing observes even a late rejection after cancellation.
      const value=await Promise.race([operation(check),cancellation]);
      check();return value;
    }finally{
      signal?.removeEventListener('abort',abort);owner.controller.signal.removeEventListener('abort',cancel);
      if(this.initialLoad===owner)this.initialLoad=undefined;
    }
  }
  load(expectedEntryId?:string,validate:()=>void=()=>{},options:{signal?:AbortSignal}={}): Promise<void> {
    return this.enqueue(async () => {
      validate();
      this.durable?.assertLoadScope();
      if(expectedEntryId!==undefined&&this.expectedEntryId!==undefined&&this.expectedEntryId!==expectedEntryId)throw new Error('This note buffer belongs to another entry');
      const admittedEntryId=expectedEntryId??this.expectedEntryId;
      if (this.loaded) {
        if(admittedEntryId!==undefined&&this.savedDurableWitness?.entryId!==admittedEntryId)throw new Error('The selected note identity changed; previous draft retained');
        this.expectedEntryId=admittedEntryId;
        return;
      }
      if (this.disposed) throw new Error('This note buffer is disposed');
      if(this.durable){
        await this.readInitial(check=>this.durable!.load(this.path,admittedEntryId,check,{deferRecovery:true}),validate,options.signal);
        validate();this.durable.assertLoadScope();this.expectedEntryId=admittedEntryId;this.loaded=true;
        const vault=this.vault,adapter=vault.adapter,writes=adapter.durableWrites!,scope={...writes.checkpoints.scope},entryId=this.durable.base.entryId;
        this.durable.startLoadRecovery(()=>{
          const selected=vault.entries.get(this.path);
          if(this.disposed||vault.adapter!==adapter||adapter.durableWrites!==writes||writes.checkpoints.scope.vaultId!==scope.vaultId||writes.checkpoints.scope.clientId!==scope.clientId
            ||this.durable?.base.entryId!==entryId||selected?.entryId&&selected.entryId!==entryId)throw Object.assign(new Error('The admitted note source owner changed; its draft is retained'),{code:'intent_identity_mismatch',source:'host'});
        });this.syncDurable();return;
      }
      if(admittedEntryId!==undefined)throw new Error('Stable note admission requires durable identity');
      const disk = await this.readInitial(()=>this.vault.read(this.path),validate,options.signal);
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
    if (changed) this.cancelTimer();
    // Repeated delivery of the same snapshot must not postpone a pending save.
    // persist still retries if its previous attempt failed.
    this.scheduleAutosave(this.options.debounceMs??400);
    this.notify();
  }

  private async save(attempt?:(content:string)=>void): Promise<void> {
    this.requireLoaded();attempt?.(this.text);
    if(this.durable){await this.durable.flush(()=>this.validateWrite(),attempt);this.syncDurable();if(!this.dirty)this.writeValidators.clear();return;}
    this.validateWrite();
    if (this.writeIntent !== undefined || this.conflict) {
      const disk = await this.readForReconciliation();
      this.validateWrite();
      const previousError=this.error;
      this.reconcileWrite(disk);
      if(this.dirty)this.error=previousError;
      if (!this.dirty) { this.writeValidators.clear(); this.persist(); this.notify(); return; }
    }
    // Retry cleanup after a successful file save. Dirty states below checkpoint
    // the latest text and write intent before attempting another file write.
    if (!this.dirty && this.recoveryPending) this.persist();
    while (this.dirty) {
      this.validateWrite();
      const content = this.text;
      attempt?.(content);
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
    if(!this.loaded)return Promise.resolve(); // No authoring or source mutation is admitted yet.
    this.cancelAutosave();
    this.durable?.retryCanonicalRecovery();
    // A completed retirement already saved this immutable buffer. Workspace
    // teardown may retry after a later buffer's independent close failed.
    if(this.disposed)return Promise.resolve();
    return this.enqueue(() => this.save()).then(()=>{if(!this.dirty)this.cancelTimer();});
  }

  get hasRecoveryConflict():boolean { return !!this.durable?.conflicted; }

  /** Retained conflicts stay navigable without turning navigation into a save. */
  flushForNavigation():Promise<void> {
    if(this.durable?.pendingCanonicalRecovery&&this.draftProtectionStatus)return this.flushDraftProtection();
    if(!this.hasRecoveryConflict)return this.flush();
    this.cancelAutosave();
    if(this.draftProtectionStatus)return this.durable!.preserveDraft().then(()=>this.syncDurable());
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
    this.durable?.draftProtectionAvailable();
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
    if(!this.loaded)return this.disposeUnadmitted();
    if(this.disposing)return this.disposing;
    this.cancelAutosave();
    this.durable?.retryCanonicalRecovery();
    // Reserve retirement before calling any save/provider code. Save remains
    // usable after a failed facts ACK, while editing cannot race the barrier.
    const closing=Promise.resolve().then(async()=>{
      // Start protection outside both save queues. Its ACK can complete while
      // Rust is blocked; it never authorizes pretending the source was saved.
      const protection=this.flushDraftProtection().then(()=>null,error=>error);
      await this.enqueue(async () => {
        if (this.disposed) return;
        try { await this.save(); }
        finally { this.cancelTimer(); }
      });
      let protectionError=await protection;
      // Saving can advance canonical text, operation phases and checkpoint
      // identity after the first barrier. Join that exact final protection too.
      try{await this.flushDraftProtection();protectionError=null;}catch(error){protectionError=error;}
      if(protectionError&&!this.durable?.coreCoversCurrentDraft)throw protectionError;
      await this.durable?.releaseUnattachedConditionalSavedSources();
      // Facts cleanup must never become a durable save failure.
      await this.closeMetadataProjection();this.disposed=true;this.durable?.stopDraftProtection();
    }).finally(()=>{if(this.disposing===closing)this.disposing=undefined;});
    this.disposing=closing;this.durable?.cancelPendingConditionalSavedSources();return closing;
  }
}
