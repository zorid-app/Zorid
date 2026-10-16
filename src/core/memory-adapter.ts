import { normalizePath, parentPath } from './types.ts';
import type { VaultAdapter, VaultEntry } from './types.ts';

/** Browser-safe adapter for previews and tests. Seed files create their parent folders. */
export class MemoryAdapter implements VaultAdapter {
  private files = new Map<string, string | Uint8Array>();
  private records = new Map<string, VaultEntry>();

  constructor(seed: Record<string, string | Uint8Array> = {}) {
    for (const [rawPath, content] of Object.entries(seed)) {
      const path = normalizePath(rawPath);
      const segments = path.split('/');
      for (let i = 1; i < segments.length; i++) {
        const folder = segments.slice(0, i).join('/');
        if (this.records.get(folder)?.type === 'file') throw new Error(`Not a folder: ${folder}`);
        this.records.set(folder, { path: folder, type: 'folder', size: 0, mtime: Date.now() });
      }
      if (this.records.get(path)?.type === 'folder') throw new Error(`Not a file: ${path}`);
      this.files.set(path, typeof content === 'string' ? content : new Uint8Array(content));
      this.recordFile(path, content);
    }
  }

  private recordFile(path: string, content: string | Uint8Array): void {
    this.records.set(path, { path, type: 'file', size: typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength, mtime: Date.now() });
  }

  private requireParent(path: string): void {
    const parent = parentPath(path);
    if (parent && this.records.get(parent)?.type !== 'folder') throw new Error(`Parent folder does not exist: ${parent}`);
  }

  async list(): Promise<VaultEntry[]> { return [...this.records.values()].map(entry => ({ ...entry })); }
  async stat(rawPath: string): Promise<VaultEntry | null> {
    const entry = this.records.get(normalizePath(rawPath));
    return entry ? { ...entry } : null;
  }
  async read(rawPath: string): Promise<string> {
    const path = normalizePath(rawPath);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File does not exist: ${path}`);
    return typeof content === 'string' ? content : new TextDecoder('utf-8', { ignoreBOM: true }).decode(content);
  }
  async write(rawPath: string, content: string): Promise<void> {
    const path = normalizePath(rawPath);
    this.requireParent(path);
    if (this.records.get(path)?.type === 'folder') throw new Error(`Not a file: ${path}`);
    this.files.set(path, content);
    this.recordFile(path, content);
  }
  async readBinary(rawPath: string): Promise<Uint8Array> {
    const path = normalizePath(rawPath);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File does not exist: ${path}`);
    return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  }
  async writeBinary(rawPath: string, data: Uint8Array): Promise<void> {
    const path = normalizePath(rawPath);
    this.requireParent(path);
    if (this.records.get(path)?.type === 'folder') throw new Error(`Not a file: ${path}`);
    const content = new Uint8Array(data);
    this.files.set(path, content);
    this.recordFile(path, content);
  }
  async mkdir(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    this.requireParent(path);
    if (this.records.has(path)) throw new Error(`Path already exists: ${path}`);
    this.records.set(path, { path, type: 'folder', size: 0, mtime: Date.now() });
  }
  async rename(rawOld: string, rawNew: string): Promise<void> {
    const oldPath = normalizePath(rawOld), newPath = normalizePath(rawNew);
    if (oldPath === newPath) return;
    if (!this.records.has(oldPath)) throw new Error(`Path does not exist: ${oldPath}`);
    this.requireParent(newPath);
    if (this.records.has(newPath)) throw new Error(`Path already exists: ${newPath}`);
    if (newPath.startsWith(`${oldPath}/`)) throw new Error('Cannot move a folder inside itself');
    const moved = [...this.records.values()].filter(entry => entry.path === oldPath || entry.path.startsWith(`${oldPath}/`));
    for (const entry of moved) {
      const path = newPath + entry.path.slice(oldPath.length);
      this.records.delete(entry.path);
      this.records.set(path, { ...entry, path, mtime: Date.now() });
      if (entry.type === 'file') {
        const content = this.files.get(entry.path)!;
        this.files.delete(entry.path);
        this.files.set(path, content);
      }
    }
  }
  async trash(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (!this.records.has(path)) throw new Error(`Path does not exist: ${path}`);
    for (const key of this.records.keys()) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.records.delete(key);
        this.files.delete(key);
      }
    }
  }
}
