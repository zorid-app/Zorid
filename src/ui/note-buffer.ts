import type { Vault } from '../core/vault.ts';
import { normalizePath } from '../core/types.ts';

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
}
interface Draft { base: string; content: string }

/** A note's editor state, independent of any particular pane or editor widget. */
export class NoteBuffer {
  path: string;
  text = '';
  savedText = '';
  dirty = false;
  error: Error | null = null;
  private vault: Vault;
  private options: NoteBufferOptions;
  private loaded = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private recoveryCheckpoint?: { key: string; draft: Draft | null };
  private recoveryBase?: { text: string; json: string };
  private recoveryPending = false;

  constructor(vault: Vault, path: string, options: NoteBufferOptions = {}) {
    this.vault = vault;
    this.path = normalizePath(path);
    this.options = options;
  }

  private key(path = this.path): string {
    return `${this.options.storageKey ?? 'zorid:draft'}:${encodeURIComponent(path)}`;
  }
  private notify(): void {
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
      || typeof draft.base !== 'string' || typeof draft.content !== 'string') {
      throw new Error(`Invalid recovery draft: ${this.path}`);
    }
    const recovered = { base: draft.base, content: draft.content };
    this.recoveryCheckpoint = { key: this.key(), draft: recovered };
    return recovered;
  }
  private persist(): boolean {
    const storage = this.options.storage;
    if (!storage) return true;
    const key = this.key(), previous = this.recoveryCheckpoint;
    if (previous?.key === key && (this.dirty
      ? previous.draft?.base === this.savedText && previous.draft.content === this.text
      : previous.draft === null)) { this.recoveryPending = false; return true; }
    try {
      if (this.dirty) {
        // Every distinct edit still reaches recovery storage synchronously.
        // Only the unchanged base's JSON escaping is reused; the payload format
        // remains exactly {base, content} for existing recovery readers.
        if (this.recoveryBase?.text !== this.savedText) {
          this.recoveryBase = { text: this.savedText, json: JSON.stringify(this.savedText) };
        }
        storage.setItem(key, `{"base":${this.recoveryBase.json},"content":${JSON.stringify(this.text)}}`);
        this.recoveryCheckpoint = { key, draft: { base: this.savedText, content: this.text } };
      } else {
        storage.removeItem(key);
        this.recoveryCheckpoint = { key, draft: null };
        this.recoveryBase = undefined;
      }
      this.recoveryPending = false;
      return true;
    } catch (error) { this.recoveryPending = true; this.rememberError(error); return false; }
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
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

  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded) return;
      if (this.disposed) throw new Error('This note buffer is disposed');
      const disk = await this.vault.read(this.path);
      this.text = this.savedText = disk;
      this.error = null;
      let draft: Draft | undefined;
      try { draft = this.recover(); } catch (error) { this.rememberError(error); }
      if (draft) {
        this.text = draft.content;
        this.savedText = draft.base;
        this.dirty = this.text !== this.savedText;
        if (draft.base !== disk) this.error = new Error(`File changed outside this editor; recovery draft preserved: ${this.path}`);
      }
      this.loaded = true;
      this.notify();
    });
  }

  update(text: string): void {
    this.requireLoaded();
    const changed = text !== this.text;
    this.text = text;
    this.dirty = text !== this.savedText;
    this.persist();
    if (changed) this.cancelTimer();
    // Repeated delivery of the same snapshot must not postpone a pending save.
    // persist still retries if its previous attempt failed.
    if (this.dirty && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => { /* Error and recovery draft remain on the buffer. */ });
      }, this.options.debounceMs ?? 400);
    }
    this.notify();
  }

  private async save(): Promise<void> {
    this.requireLoaded();
    // Retry a failed synchronous recovery write at explicit save/close boundaries
    // before disk I/O. A failed disk write must still have a chance to recover.
    if (this.dirty || this.recoveryPending) this.persist();
    while (this.dirty) {
      const content = this.text;
      await this.vault.modify(this.path, content, { expectedContent: this.savedText });
      this.savedText = content;
      this.dirty = this.text !== content;
      this.error = null;
      this.persist();
      this.notify();
      // Edits made during the write use the just-committed content as their base.
    }
  }

  flush(): Promise<void> {
    this.cancelTimer();
    return this.enqueue(() => this.save());
  }

  reload(): Promise<void> {
    return this.enqueue(async () => {
      this.requireLoaded();
      const disk = await this.vault.read(this.path);
      // Recheck after read: typing may have started while the adapter was busy.
      if (this.dirty) {
        if (disk !== this.savedText) throw new Error(`File changed outside this editor: ${this.path}`);
        return;
      }
      this.text = this.savedText = disk;
      this.error = null;
      this.persist();
      this.notify();
    });
  }

  private async relocateNow(destination: string): Promise<void> {
    const oldPath = this.path;
    this.path = destination;
    const migrated = this.persist();
    if (migrated && oldPath !== destination) {
      try { this.options.storage?.removeItem(this.key(oldPath)); } catch (error) { this.rememberError(error); }
    }
    const disk = await this.vault.read(this.path);
    // A rename can rewrite relative links. Never replace edits made during the move.
    if (!this.dirty) {
      this.text = this.savedText = disk;
      this.error = null;
    } else if (disk !== this.savedText) {
      this.error = new Error(`File changed during rename; editor draft preserved: ${this.path}`);
    } else {
      this.error = null;
    }
    this.persist();
    this.notify();
  }

  /** Adopt a path already moved by Vault, including a containing folder's rename. */
  relocate(newPath: string): Promise<void> {
    return this.enqueue(async () => {
      this.requireLoaded();
      await this.relocateNow(normalizePath(newPath));
    });
  }

  rename(newPath: string): Promise<void> {
    return this.enqueue(async () => {
      const destination = normalizePath(newPath);
      await this.save();
      if (destination === this.path) return;
      await this.vault.rename(this.path, destination);
      await this.relocateNow(destination);
    });
  }

  dispose(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      try { await this.save(); this.disposed = true; }
      finally { this.cancelTimer(); }
    });
  }
}
