import { Vault as CoreVault } from '../core/vault.ts';
import { normalizePath, parentPath } from '../core/types.ts';
import type { VaultChange, VaultEntry, VaultEvent } from '../core/types.ts';
import { Events } from './events.ts';
import type { ErrorReporter } from './events.ts';

/** ctime is absent until the platform can supply a genuine creation timestamp. */
export interface FileStats { ctime?: number; mtime: number; size: number }
export interface DataWriteOptions { ctime?: number; mtime?: number }

export abstract class TAbstractFile {
  vault: Vault;
  path: string;
  parent: TFolder | null = null;
  constructor(vault: Vault, path: string) { this.vault = vault; this.path = path; }
  get name(): string { return this.path.slice(this.path.lastIndexOf('/') + 1); }
}

export class TFile extends TAbstractFile {
  stat: FileStats = { mtime: 0, size: 0 };
  get extension(): string { const dot = this.name.lastIndexOf('.'); return dot < 0 ? '' : this.name.slice(dot + 1); }
  get basename(): string { const dot = this.name.lastIndexOf('.'); return dot < 0 ? this.name : this.name.slice(0, dot); }
  toString(): string { return this.path; }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean { return this.path === '/'; }
}

/**
 * These callbacks must operate in the host vault's queue and publish its normal
 * events before resolving. They must invoke validate inside that queue before I/O.
 * They are intentionally separate from core.rename
 * (which rewrites links) and core.trash (which cannot select the trash policy).
 */
export interface VaultApiHost {
  name: string;
  configDir: string;
  /** Supply a compatible adapter only once the host has implemented that surface. */
  adapter?: unknown;
  getFileStats?(entry: VaultEntry): FileStats;
  rename?(oldPath: string, newPath: string, validate: () => void): Promise<void>;
  delete?(path: string, force: boolean, validate: () => void): Promise<void>;
  trash?(path: string, system: boolean, validate: () => void): Promise<void>;
  getResourcePath?(path: string): string;
  reportError?: ErrorReporter;
}

/** A bounded plugin API over a real core vault; see docs/plugin-vault-api.md. */
export class Vault extends Events {
  readonly configDir: string;
  readonly adapter: unknown;
  private core: CoreVault;
  private host: VaultApiHost;
  private root: TFolder;
  private files = new Map<string, TAbstractFile>();
  private removed = new Map<string, TAbstractFile>();
  private caches = new WeakMap<TFile, string>();
  private revision = 0;
  private detach: (() => void)[] = [];
  private disposed = false;

  constructor(core: CoreVault, host: VaultApiHost) {
    super(host.reportError);
    this.core = core;
    this.host = host;
    this.configDir = host.configDir;
    this.adapter = host.adapter;
    this.root = new TFolder(this, '/');
    this.files.set('/', this.root);
    this.reconcile();
    for (const event of ['ready', 'create', 'modify', 'rename', 'delete'] as const) {
      this.detach.push(core.on(event, change => this.receive(event, change)));
    }
  }

  /** Host lifecycle extension. Dispose when the vault closes, not per plugin. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const detach of this.detach.splice(0)) detach();
    this.caches = new WeakMap();
    this.removed.clear();
  }

  private reconcile(): void {
    const live = new Set(['/']);
    for (const entry of this.core.entries.values()) {
      const path = entry.path;
      live.add(path);
      let file = this.files.get(path);
      if (!file || (entry.type === 'file') !== (file instanceof TFile)) {
        if (file) {
          file.parent = null;
          if (file instanceof TFolder) file.children.length = 0;
          this.removed.set(path, file);
        }
        file = entry.type === 'file' ? new TFile(this, path) : new TFolder(this, path);
        this.files.set(path, file);
      }
      if (file instanceof TFile) file.stat = this.host.getFileStats?.(entry) ?? {
        ...(entry.ctime === undefined ? {} : { ctime: entry.ctime }), mtime: entry.mtime, size: entry.size,
      };
    }
    for (const [path, file] of this.files) {
      if (!live.has(path)) {
        this.files.delete(path);
        this.removed.set(path, file);
        file.parent = null;
        if (file instanceof TFolder) file.children.length = 0;
        if (file instanceof TFile) this.caches.delete(file);
      }
    }
    for (const file of this.files.values()) if (file instanceof TFolder) file.children.length = 0;
    for (const file of this.files.values()) {
      if (file === this.root) continue;
      const parent = this.files.get(parentPath(file.path) || '/');
      file.parent = parent instanceof TFolder ? parent : null;
      file.parent?.children.push(file);
    }
  }

  private receive(event: VaultEvent, change: VaultChange): void {
    this.revision++;
    // Core publishes a deletion batch synchronously; keep detached identities
    // through that batch only, including descendants removed by its first event.
    queueMicrotask(() => this.removed.clear());
    // A core folder rename is one event. Preserve every descendant's identity.
    if (event === 'rename' && change.oldPath) {
      const oldPath = change.oldPath;
      const moved = [...this.files].filter(([path]) => path === oldPath || path.startsWith(`${oldPath}/`));
      for (const [path] of moved) this.files.delete(path);
      for (const [path, file] of moved) {
        file.path = change.path + path.slice(oldPath.length);
        this.files.set(file.path, file);
      }
    }
    const before = event === 'ready' ? new Set(this.files.values()) : undefined;
    const deleted = event === 'delete' ? this.removed.get(change.path) ?? this.files.get(change.path) : undefined;
    this.reconcile();
    if (event === 'ready') {
      this.caches = new WeakMap();
      for (const file of this.files.values()) if (file !== this.root && !before!.has(file)) this.trigger('create', file);
      return;
    }
    if (event === 'delete') {
      this.removed.delete(change.path);
      if (deleted) this.trigger('delete', deleted);
      return;
    }
    const file = this.files.get(change.path);
    if (file instanceof TFile) this.caches.delete(file);
    if (file) {
      if (event === 'rename') this.trigger(event, file, change.oldPath);
      else this.trigger(event, file);
    }
  }

  getName(): string { return this.host.name; }
  getRoot(): TFolder { return this.root; }
  getAbstractFileByPath(path: string): TAbstractFile | null { return this.files.get(path) ?? null; }
  getFileByPath(path: string): TFile | null { const file = this.files.get(path); return file instanceof TFile ? file : null; }
  getFolderByPath(path: string): TFolder | null { const file = this.files.get(path); return file instanceof TFolder ? file : null; }
  getAllLoadedFiles(): TAbstractFile[] { return [...this.files.values()]; }
  getAllFolders(includeRoot = false): TFolder[] {
    return [...this.files.values()].filter((file): file is TFolder => file instanceof TFolder && (includeRoot || file !== this.root));
  }
  static recurseChildren(root: TFolder, callback: (file: TAbstractFile) => unknown): void {
    const remaining: TAbstractFile[] = [root];
    while (remaining.length) {
      const file = remaining.pop()!;
      callback(file);
      if (file instanceof TFolder) remaining.push(...file.children);
    }
  }
  getFiles(): TFile[] {
    const files: TFile[] = [];
    Vault.recurseChildren(this.root, file => { if (file instanceof TFile) files.push(file); });
    return files;
  }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter(file => file.extension === 'md'); }

  private requireLive(file: TAbstractFile): string {
    if (this.disposed) throw new Error('Vault API has been disposed');
    if (file.vault !== this || this.files.get(file.path) !== file) throw new Error('File does not belong to this live vault');
    return file.path;
  }
  private guard(file: TAbstractFile, path: string): () => void {
    return () => {
      if (this.requireLive(file) !== path) throw new Error('File moved before the operation could run');
    };
  }
  private requireFile(file: TFile): string {
    const path = this.requireLive(file);
    if (!(file instanceof TFile)) throw new Error('Expected a file');
    return path;
  }
  private requireWritable(options?: DataWriteOptions): void {
    if (this.disposed) throw new Error('Vault API has been disposed');
    if (options?.ctime !== undefined || options?.mtime !== undefined) throw new Error('Host does not support write timestamps');
  }
  private cache(file: TFile, text: string): void {
    if (text.length <= 65536) this.caches.set(file, text);
    else this.caches.delete(file);
  }
  async read(file: TFile): Promise<string> {
    const path = this.requireFile(file), revision = this.revision;
    const text = (await this.core.read(path, this.guard(file, path))).replace(/^\uFEFF/, '');
    this.guard(file, path)();
    if (!this.disposed && this.revision === revision && this.files.get(path) === file) this.cache(file, text);
    return text;
  }
  async cachedRead(file: TFile): Promise<string> {
    this.requireFile(file);
    return this.caches.get(file) ?? this.read(file);
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const path = this.requireFile(file), revision = this.revision;
    const bytes = await this.core.readBinary(path, this.guard(file, path));
    this.guard(file, path)();
    if (!this.disposed && this.revision === revision && this.files.get(path) === file && file.extension === 'md' && bytes.byteLength <= 65536) {
      this.cache(file, new TextDecoder().decode(bytes));
    }
    return new Uint8Array(bytes).buffer;
  }
  async create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
    this.requireWritable(options);
    const entry = await this.core.create(path, data);
    return this.requireCreated(entry.path, TFile);
  }
  async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile> {
    this.requireWritable(options);
    const entry = await this.core.createBinary(path, new Uint8Array(data));
    return this.requireCreated(entry.path, TFile);
  }
  async createFolder(path: string): Promise<TFolder> {
    this.requireWritable();
    const entry = await this.core.createFolder(path);
    return this.requireCreated(entry.path, TFolder);
  }
  private requireCreated<T extends TAbstractFile>(path: string, kind: new (vault: Vault, path: string) => T): T {
    const file = this.files.get(path);
    if (!(file instanceof kind)) throw new Error(`Created entry is not available: ${path}`);
    return file;
  }
  async modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    this.requireWritable(options);
    const path = this.requireFile(file);
    await this.core.modify(path, data, { validate: this.guard(file, path) });
  }
  async modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    this.requireWritable(options);
    const path = this.requireFile(file);
    await this.core.modifyBinary(path, new Uint8Array(data), { validate: this.guard(file, path) });
  }
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = this.requireLive(file), path = normalizePath(newPath);
    if (oldPath === path) return;
    if (file === this.root) throw new Error('Cannot rename the vault root');
    if (!this.host.rename) throw new Error('Host does not support Vault.rename without link rewriting');
    await this.host.rename(oldPath, path, this.guard(file, oldPath));
  }
  async delete(file: TAbstractFile, force = false): Promise<void> {
    const path = this.requireLive(file);
    if (file === this.root) return;
    if (!this.host.delete) throw new Error('Host does not support permanent deletion');
    await this.host.delete(path, force, this.guard(file, path));
  }
  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    const path = this.requireLive(file);
    if (file === this.root) return;
    if (!this.host.trash) throw new Error('Host does not support selecting system or local trash');
    await this.host.trash(path, system, this.guard(file, path));
  }
  getResourcePath(file: TFile): string {
    const path = this.requireFile(file);
    if (!this.host.getResourcePath) throw new Error('Host does not provide resource URLs');
    return this.host.getResourcePath(path);
  }
}
