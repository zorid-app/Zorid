import type { BaseSession } from '../bases/session.ts';
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
export interface BaseEmbedBinding { readonly ready: Promise<void>; detach(): void; }
interface Entry {
  target: BaseEmbedTarget;
  root: HTMLElement;
  ready: Promise<void>;
  session?: BaseSession;
  attached: boolean;
  error?: unknown;
  settled: boolean;
  retiring?: Promise<void>;
}

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
    create(container: HTMLElement, target: BaseEmbedTarget): BaseSession | Promise<BaseSession>;
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
    const matches = (entry: Entry) => !entry.attached && !entry.retiring && !entry.error && entry.target.sourcePath === target.sourcePath
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
      entry = { target, root, attached: true, settled:false, ready: Promise.resolve() };
      const created = entry;
      this.entries.add(created);
      created.ready = Promise.resolve().then(() => this.options.create(root, target)).then(async session => {
        created.session = session;
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
    entry.attached = true;
    this.entries.delete(entry);this.entries.add(entry);
    container.append(entry.root);
    this.updateRecovery();
    let detached = false;
    return { ready: entry.ready, detach: () => {
      if (detached) return; detached = true;
      entry.attached = false;
      if (entry.session?.hasPendingChanges()) this.recover(entry);
      else entry.root.remove();
      this.updateRecovery();this.pruneClean();
    } };
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
