import type { BaseSession } from '../bases/session.ts';
import { inlineBaseRequest } from '../bases/inline-base.ts';
import type { InlineBaseRequest } from '../bases/inline-base.ts';

export interface BaseEmbedTarget {
  sourcePath: string;
  targetPath: string;
  viewName: string;
  /** File incarnation, not its reusable path spelling. */
  targetIdentity: unknown;
  sourceIdentity: unknown;
  occurrence?: object;
  /** Inline configurations edit this original containing-note occurrence. */
  inline?: InlineBaseRequest;
}
/** Only the owning saved-source host receives this per-session acknowledgement.
 * Rendering a fresh request cannot authorize reuse of a previous source guard. */
export interface BaseEmbedCreationTarget extends BaseEmbedTarget {
  readonly onInlineSourceSaved?: (next: InlineBaseRequest) => boolean;
}
export interface BaseEmbedBinding { readonly ready: Promise<void>; detach(): void; }
interface Entry {
  target: BaseEmbedTarget;
  root: HTMLElement;
  ready: Promise<void>;
  session?: BaseSession;
  attached: boolean;
  lease?: object;
  inlineHandoff?: boolean;
  error?: unknown;
  settled: boolean;
  retiring?: Promise<void>;
}
type RenameAwareSession = BaseSession & { rebindViewName?(from: string, to: string): void };

/** A tab owns these sessions. Synchronous Markdown widget disposal only unmounts
 * a binding; it never closes a writable query or abandons its property draft. */
export class BaseEmbedSessions {
  private entries = new Set<Entry>();
  private recovery: HTMLElement;
  private closing = false;
  private closed = false;
  private flushing?: Promise<void>;
  private pruneQueued=false;

  private readonly options: {
    recoveryHost: HTMLElement;
    create(container: HTMLElement, target: BaseEmbedCreationTarget): BaseSession | Promise<BaseSession>;
  };
  constructor(options: BaseEmbedSessions['options']) {
    this.options=options;
    const document = options.recoveryHost.ownerDocument;
    this.recovery = document.createElement('section');
    this.recovery.className = 'base-embed-recovery';
    this.recovery.setAttribute('aria-label', 'Unfinished embedded Base edits');
    this.recovery.hidden = true;
    Object.assign(this.recovery.style, { overflow: 'auto', flex: '0 0 auto', maxHeight: '50%' });
    options.recoveryHost.append(this.recovery);
  }

  mount(target: BaseEmbedTarget, container: HTMLElement): BaseEmbedBinding {
    if (this.closed || this.closing) throw new Error('Embedded Bases are closing.');
    const matches = (entry: Entry) => (!entry.attached || !!entry.inlineHandoff && !!entry.lease && typeof target.occurrence === 'object' && target.occurrence !== null && entry.target.occurrence === target.occurrence)
      && !entry.retiring && !entry.error && entry.target.sourcePath === target.sourcePath
      && entry.target.sourceIdentity === target.sourceIdentity
      && entry.target.targetPath === target.targetPath && entry.target.viewName === target.viewName
      && entry.target.targetIdentity === target.targetIdentity
      && (!entry.target.inline && !target.inline || !!entry.target.inline && !!target.inline
        && entry.target.inline.from === target.inline.from && entry.target.inline.to === target.inline.to
        && entry.target.inline.documentText === target.inline.documentText);
    // An occurrence token is local to one editor extension. Reading rerenders
    // and mode changes may omit it; detached compatible sessions remain reusable.
    let entry = [...this.entries].find(value => matches(value) && value.target.occurrence === target.occurrence)
      ?? [...this.entries].find(matches);
    if (!entry) {
      const root = container.ownerDocument.createElement('div');
      root.className = 'base-embed-session interactive-child';
      // Existing Bases virtual views require a bounded scroll viewport.
      Object.assign(root.style,{display:'block',height:'var(--bases-embed-height, 320px)',minHeight:'160px',overflow:'hidden'});
      root.setAttribute('aria-label', `${target.targetPath}${target.viewName ? ` — ${target.viewName}` : ''}`);
      entry = { target: { ...target }, root, attached: true, settled:false, ready: Promise.resolve() };
      const created = entry;
      this.entries.add(created);
      created.ready = Promise.resolve().then(async () => {
        const openingName=created.target.viewName;
        const session=await this.options.create(root,{...created.target,
          ...(created.target.inline?{onInlineSourceSaved:(next:InlineBaseRequest)=>this.inlineSourceSaved(created,next)}:{})});
        created.session = session;
        // A sibling may save a rename while this renderer is still opening.
        // Rebind only the original captured name, never a locally selected view.
        if(openingName!==created.target.viewName)(session as RenameAwareSession).rebindViewName?.(openingName,created.target.viewName);
        await session.ready;
      }).catch(error => {
        created.error = error;
        const message = root.ownerDocument.createElement('p'); message.className = 'error-message';
        message.textContent = error instanceof Error ? error.message : String(error); root.append(message);
        throw error;
      }).finally(()=>{created.settled=true;this.pruneClean();});
      // The renderer observes ready too. Keep unmounted late failures handled.
      void created.ready.catch(() => {});
    }
    // CodeMirror may construct a replacement before destroying its old widget.
    // A saved own-source handoff is single-use and scoped to the same occurrence;
    // the retiring widget's lease must not detach its new owner.
    const lease={};entry.lease=lease;entry.inlineHandoff=false;
    entry.target={...entry.target,occurrence:target.occurrence};
    entry.attached = true;
    this.entries.delete(entry);this.entries.add(entry);
    container.append(entry.root);
    this.updateRecovery();
    let detached = false;
    return { ready: entry.ready, detach: () => {
      if (detached) return; detached = true;
      if(entry.lease!==lease)return;
      entry.attached = false;
      if (entry.session?.hasPendingChanges()) this.recover(entry);
      else entry.root.remove();
      this.updateRecovery();this.pruneClean();
    } };
  }

  /** A successful write by this exact source host advances only its own saved
   * fence binding. Keep its live query/selection; other sessions and external
   * source changes still need fresh guards and cannot claim this acknowledgement. */
  private inlineSourceSaved(entry:Entry,next:InlineBaseRequest):boolean {
    const previous=entry.target.inline;
    if(this.closed||!this.entries.has(entry)||entry.retiring||entry.error||!previous)return false;
    const verified=inlineBaseRequest(next.documentText,next.from,next.to);
    if(!verified||verified.contentFrom!==next.contentFrom||verified.contentTo!==next.contentTo||verified.source!==next.source)return false;
    const delta=verified.documentText.length-previous.documentText.length;
    if(verified.from!==previous.from||verified.contentFrom!==previous.contentFrom
      ||verified.contentTo!==previous.contentTo+delta||verified.to!==previous.to+delta
      ||verified.documentText.slice(0,verified.contentFrom)!==previous.documentText.slice(0,previous.contentFrom)
      ||verified.documentText.slice(verified.contentTo)!==previous.documentText.slice(previous.contentTo))return false;
    entry.inlineHandoff=verified.documentText!==previous.documentText;
    entry.target={...entry.target,inline:verified};
    return true;
  }

  /** Saved-name transition supplied by the owning controller before it rewrites
   * Markdown fragments. Reuse the same session/draft when that exact occurrence
   * remounts; a replaced Base incarnation and unrelated external source edits
   * retain their ordinary identity guards and cannot reclaim this binding. */
  renameViewBinding(basePath:string,from:string,to:string,targetIdentity:unknown):number {
    if(this.closed||targetIdentity===undefined||targetIdentity===null||from===to)return 0;
    let changed=0;
    for(const entry of this.entries){
      const target=entry.target;
      if(entry.retiring||entry.error||target.inline||target.targetPath!==basePath||target.targetIdentity!==targetIdentity||target.viewName!==from)continue;
      (entry.session as RenameAwareSession|undefined)?.rebindViewName?.(from,to);
      entry.target={...target,viewName:to};
      entry.root.setAttribute('aria-label',`${basePath}${to?` — ${to}`:''}`);
      changed++;
    }
    return changed;
  }

  /** Portal ownership follows an attached live binding, never a detached cache. */
  owns(node:Node):boolean {
    return !this.closed&&!this.closing&&[...this.entries].some(entry=>entry.attached&&!!entry.lease&&!entry.retiring&&!entry.error&&entry.root.isConnected&&entry.session?.owns?.(node)===true);
  }

  hasPendingChanges(): boolean { return [...this.entries].some(entry => entry.session?.hasPendingChanges()); }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    if([...this.entries].every(entry=>entry.settled&&!entry.retiring)&&!this.hasPendingChanges())return Promise.resolve();
    // Canvas blur, explicit Save and tab close may preflight the same manager.
    // Publish before invoking sessions so they never receive competing flushes.
    const pending=Promise.resolve().then(async()=>{
      do {
        for (const entry of this.entries) {
          // A failed initial load has no mutation to save and stays closable.
          await entry.retiring;
          if(!this.entries.has(entry))continue;
          await entry.ready.catch(() => {});
          try { if(entry.session?.hasPendingChanges())await entry.session.flush(); }
          catch (error) { if (!entry.attached) this.recover(entry); throw error; }
        }
        // An earlier view may accept another edit while a later view saves.
        // Revisit it; an unaccepted input draft rejects through session.flush.
      } while(this.hasPendingChanges());
    });
    this.flushing=pending;
    const clear=()=>{if(this.flushing===pending)this.flushing=undefined;};
    void pending.then(clear,clear);
    return pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) throw new Error('Embedded Bases are already closing.');
    this.closing = true;
    try {
      await this.flush();
      for (const entry of this.entries) {
        await entry.retiring;if(!this.entries.has(entry))continue;
        try { await entry.session?.close(); }
        catch (error) { if (!entry.attached) this.recover(entry); throw error; }
        entry.root.remove(); this.entries.delete(entry);
      }
      this.closed = true; this.recovery.remove();
    } finally { this.closing = false; }
  }

  /** Keep a small warm set for viewport remounts. Obsolete clean views must
   * not accumulate Vault listeners and thumbnails as a note is edited. */
  private pruneClean():void {
    if(this.pruneQueued||this.closed||this.closing)return;
    this.pruneQueued=true;
    queueMicrotask(()=>{
      this.pruneQueued=false;if(this.closed||this.closing)return;
      const clean=[...this.entries].filter(entry=>!entry.attached&&entry.settled&&!entry.retiring&&!entry.session?.hasPendingChanges());
      for(const entry of clean.slice(0,Math.max(0,clean.length-4))){
        const retiring=Promise.resolve().then(async()=>{
          try{await entry.session?.close();entry.root.remove();this.entries.delete(entry);}
          catch(error){entry.error=error;this.recover(entry);}
          finally{entry.retiring=undefined;this.updateRecovery();}
        });
        entry.retiring=retiring;
      }
    });
  }

  private recover(entry: Entry): void {
    if (!this.recovery.firstElementChild) {
      const message = this.recovery.ownerDocument.createElement('p');
      message.textContent = 'Finish or cancel these embedded Base edits before leaving this note.';
      this.recovery.append(message);
    }
    this.recovery.append(entry.root); this.updateRecovery();
  }
  private updateRecovery(): void {
    this.recovery.hidden = ![...this.entries].some(entry => entry.root.parentElement === this.recovery);
    if (this.recovery.hidden) this.recovery.replaceChildren();
  }
}
