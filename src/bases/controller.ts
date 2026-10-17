import { BaseDocument } from './document.ts';
import type { BaseValue, BaseViewPatch } from './document.ts';
import { executeBaseQuery, normalizeBaseProperty } from './query.ts';
import type { BaseQueryOptions, BaseQueryResult } from './query.ts';
import { readProperties, removeProperty, setProperty } from '../core/properties.ts';
import { isMarkdown, normalizePath } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import type { NoteBuffer } from '../ui/note-buffer.ts';

export interface BaseMutationHost {
  /** Run transform once against the latest shared draft, validating after all awaits. */
  transform(path: string, transform: (source: string) => string, validate: () => void, validateWrite?: () => void): Promise<void>;
  /** Must validate inside the host's serialized rename transaction. */
  rename?(path: string, destination: string, validate: () => void): Promise<void>;
}
export interface BaseBufferHost {
  /** Must return the workspace's shared buffer, including existing dirty drafts. */
  getBuffer(path: string): NoteBuffer | Promise<NoteBuffer>;
  validate(): void;
  onBufferChange?(path: string, buffer: NoteBuffer, previousText: string): void;
  rename?: BaseMutationHost['rename'];
}
/** No private buffers or direct disk writes: use the same recovery/CAS path as typing. */
export function createBaseMutationHost(options: BaseBufferHost): BaseMutationHost {
  let pending: Promise<unknown> = Promise.resolve();
  return {
    transform(path, transform, validate, validateWrite = validate) {
      const result = pending.then(async () => {
        options.validate(); validate();
        const buffer = await options.getBuffer(path);
        await buffer.load();
        options.validate(); validate();
        if (buffer.path !== path) throw new Error('The edited file moved');
        const source = buffer.text, next = transform(source);
        // Transform is synchronous: no intervening editor input may be discarded.
        options.validate(); validate();
        if (buffer.text !== source) throw new Error('The edited buffer changed');
        // A previous failed save may already contain this exact transformed draft.
        // Retrying must still persist it (or report the continuing failure).
        if (next === source && !buffer.dirty && !buffer.error) return;
        buffer.update(next, { validateWrite: () => { options.validate(); validateWrite(); } });
        options.onBufferChange?.(path, buffer, source);
        // Do not replay or roll back a failed write: recovery draft owns that state.
        await buffer.flush();
      });
      pending = result.catch(() => undefined);
      return result;
    },
    ...(options.rename ? { rename: options.rename } : {}),
  };
}

export interface BaseControllerState {
  readonly version: number;
  readonly source: string;
  readonly result: BaseQueryResult | null;
  readonly error: Error | null;
}
export interface BaseControllerOptions {
  vault: Vault;
  basePath: string;
  mutations: BaseMutationHost;
  query?: BaseQueryOptions;
  /** A fixed coalescing window; sustained events cannot postpone refresh forever. */
  delayMs?: number;
  onChange?(state: BaseControllerState): void;
}
export interface BasePropertyEdit {
  readonly version: number;
  readonly path: string;
  readonly property: string;
  readonly value: BaseValue;
}

export class BaseController {
  private options: BaseControllerOptions;
  private path: string;
  private query: BaseQueryOptions;
  private epoch = 0;
  private version = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private subscriptions: (() => void)[];
  private signature = '';
  private identities = new Map<string, number>();
  private nextIdentity = 0;
  private refreshing = false;
  private requested = false;
  private current: BaseControllerState = Object.freeze({ version: 0, source: '', result: null, error: null });

  constructor(options: BaseControllerOptions) {
    this.options = options; this.path = normalizePath(options.basePath);
    this.query = { ...options.query };
    for (const path of options.vault.entries.keys()) this.identities.set(path, ++this.nextIdentity);
    this.subscriptions = (['create', 'modify', 'rename', 'delete', 'ready'] as const).map(event => options.vault.on(event, change => {
      if (event === 'delete' || event === 'rename') {
        const previous = change.oldPath ?? change.path;
        for (const path of this.identities.keys()) if (path === previous || path.startsWith(previous + '/')) this.identities.delete(path);
      }
      for (const path of options.vault.entries.keys()) if (!this.identities.has(path)) this.identities.set(path, ++this.nextIdentity);
      this.epoch++;
      this.schedule();
    }));
    this.schedule();
  }

  get state(): BaseControllerState { return this.current; }
  get basePath(): string { return this.path; }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, Math.max(0, Math.min(1000, this.options.delayMs ?? 30)));
  }

  /** Refresh failures are represented in state; mutation failures reject to the caller. */
  refresh(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const refresh = async () => {
      if (this.disposed) return;
      const epoch = this.epoch;
      try {
        const source = await this.options.vault.read(this.path);
        if (this.disposed || epoch !== this.epoch) { this.schedule(); return; }
        const files = [...this.options.vault.entries.values()].filter(entry => entry.type === 'file').map(entry => {
          const metadata = this.options.vault.metadata.get(entry.path);
          return { path: entry.path, ctime: entry.ctime, mtime: entry.mtime, size: entry.size,
            properties: metadata?.frontmatter, tags: metadata?.tags };
        });
        const version = this.version + 1;
        const result = executeBaseQuery(BaseDocument.parse(source), { version, files }, { currentFilePath: this.path, ...this.query });
        const signature = JSON.stringify([source, this.identities.get(this.path), result.rows.map(row => this.identities.get(row.path)), { ...result, version: 0 }]);
        if (signature === this.signature && !this.current.error) return;
        this.version = version; this.signature = signature;
        this.publish({ version, source, result, error: null });
      } catch (error) {
        if (!this.disposed && epoch === this.epoch) this.publish({ ...this.current, error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    this.requested = true;
    if (this.refreshing) return this.pending;
    this.refreshing = true;
    this.pending = (async () => {
      do { this.requested = false; await refresh(); } while (this.requested && !this.disposed);
    })().finally(() => { this.refreshing = false; });
    return this.pending;
  }

  private publish(state: BaseControllerState): void {
    this.current = Object.freeze(state);
    try { this.options.onChange?.(this.current); } catch (error) { console.error('Bases observer failed', error); }
  }

  setView(viewIndex: number): Promise<void> {
    this.query = { ...this.query, viewIndex }; this.epoch++;
    return this.refresh();
  }

  private guard(version: number, path: string): { validate: () => void; validateWrite: () => void } {
    const epoch = this.epoch, identity = this.identities.get(path), base = this.identities.get(this.path);
    const validateWrite = () => {
      if (this.disposed || !identity || this.identities.get(path) !== identity || !base || this.identities.get(this.path) !== base) {
        throw new Error('This base result is stale; refresh before editing');
      }
    };
    const validate = () => {
      validateWrite();
      if (this.current.error || !this.current.result || version !== this.current.version || epoch !== this.epoch) throw new Error('This base result is stale; refresh before editing');
    };
    validate(); return { validate, validateWrite };
  }

  editProperty(edit: BasePropertyEdit): Promise<void> { return this.writeProperty(edit); }

  private async writeProperty(edit: BasePropertyEdit, remove = false): Promise<void> {
    const path = normalizePath(edit.path), { validate, validateWrite } = this.guard(edit.version, path);
    if (!this.current.result!.rows.some(row => row.path === path)) throw new Error('The file is not in this base result');
    const property = normalizeBaseProperty(edit.property);
    if (!property.startsWith('note.')) throw new Error('Only note properties can be edited as frontmatter');
    if (!isMarkdown(path)) throw new Error('This file cannot contain Markdown properties');
    const key = property.slice(5);
    // Detach mutable caller arrays/maps before an asynchronous host queue can use them.
    const value = structuredClone(edit.value);
    await this.options.mutations.transform(path, source => {
      validate();
      const properties = readProperties(source);
      const existing = properties.find(item => item.key === key) ?? properties.find(item => item.key.toLowerCase() === key.toLowerCase());
      return remove ? (existing ? removeProperty(source, existing.key) : source) : setProperty(source, existing?.key ?? key, value);
    }, validate, validateWrite);
    await this.refresh();
  }

  /** Kanban membership is the persisted group property, never a transient visual order. */
  moveToGroup(edit: Omit<BasePropertyEdit, 'property'>): Promise<void> {
    const group = this.current.result?.view.groupBy;
    if (!group || typeof group !== 'object' || Array.isArray(group) || !('property' in group) || typeof group.property !== 'string') {
      return Promise.reject(new Error('This view has no editable grouping property'));
    }
    // Reference Kanban clears the key for the empty group; table null edits remain values.
    if (edit.value === null) return this.writeProperty({ ...edit, property: group.property }, true);
    const current = this.current.result?.rows.find(row => row.path === edit.path)?.values[normalizeBaseProperty(group.property)];
    if (current?.type === 'list' && !Array.isArray(edit.value)) return Promise.reject(new Error('List-valued group membership requires an explicit list destination'));
    return this.editProperty({ ...edit, property: group.property });
  }

  async renameFile(version: number, path: string, destination: string): Promise<void> {
    path = normalizePath(path); destination = normalizePath(destination);
    const { validate } = this.guard(version, path);
    if (!this.options.mutations.rename) throw new Error('The host does not provide guarded file renaming');
    if (!this.current.result!.rows.some(row => row.path === path)) throw new Error('The file is not in this base result');
    await this.options.mutations.rename(path, destination, validate);
    await this.refresh();
  }

  async updateView(version: number, patch: BaseViewPatch): Promise<void> {
    const { validate, validateWrite } = this.guard(version, this.path), index = this.query.viewIndex ?? 0;
    const detached = structuredClone(patch);
    await this.options.mutations.transform(this.path, source => {
      validate();
      if (source !== this.current.source) throw new Error('The base configuration has an unsaved or external edit');
      const document = BaseDocument.parse(source); document.updateView(index, detached); return document.toString();
    }, validate, validateWrite);
    await this.refresh();
  }

  dispose(): void {
    this.disposed = true; this.epoch++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = [];
  }
}
