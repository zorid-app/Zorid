import type { VaultAdapter, VaultEntry } from '../core/types';
import { vaultPath } from './path.ts';
import { base64ToBytes, bytesToBase64 } from './binary.ts';

interface StoredEntry extends VaultEntry { content?: string; binary?: string }
type Records = Record<string, StoredEntry>;

/** A preview vault for the browser. Desktop/mobile use actual filesystem adapters. */
export class BrowserAdapter implements VaultAdapter {
  private readonly key = 'zorid.browser-vault.v1';
  private readonly listeners = new Set<(paths?: readonly string[]) => void>();
  private readRecords(): Records {
    const saved = localStorage.getItem(this.key);
    // Vault filenames are user data, including names such as __proto__.
    // A dictionary without Object.prototype keeps those names ordinary keys.
    return Object.assign(Object.create(null), saved ? JSON.parse(saved) as Records : {});
  }
  private commit(records: Records, paths?: readonly string[]): void {
    localStorage.setItem(this.key, JSON.stringify(records));
    this.listeners.forEach(listener => listener(paths));
  }
  private parents(records: Records, file: string): void {
    const segments = file.split('/');
    for (let count = 1; count < segments.length; count++) {
      const parent = segments.slice(0, count).join('/');
      if (records[parent]?.type === 'file') throw new Error('A parent path is a file');
      records[parent] ??= { path: parent, type: 'folder', mtime: Date.now(), size: 0 };
    }
  }
  async list(): Promise<VaultEntry[]> {
    return Object.values(this.readRecords())
      .filter(entry => !entry.path.split('/').some(part => part.startsWith('.')))
      .map(({ content: _, binary: _binary, ...entry }) => entry)
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async stat(input: string): Promise<VaultEntry | null> {
    const stored = this.readRecords()[vaultPath(input)];
    if (!stored) return null;
    const { content: _, binary: _binary, ...entry } = stored;
    return entry;
  }
  async read(input: string): Promise<string> {
    const entry = this.readRecords()[vaultPath(input)];
    if (!entry || entry.type !== 'file') throw new Error('File not found');
    return entry.binary !== undefined ? new TextDecoder().decode(base64ToBytes(entry.binary)) : entry.content ?? '';
  }
  async readBinary(input: string): Promise<Uint8Array> {
    const entry = this.readRecords()[vaultPath(input)];
    if (!entry || entry.type !== 'file') throw new Error('File not found');
    return entry.binary !== undefined ? base64ToBytes(entry.binary) : new TextEncoder().encode(entry.content ?? '');
  }
  async writeBinary(input: string, data: Uint8Array): Promise<void> {
    const path = vaultPath(input);
    const binary = bytesToBase64(data);
    const records = this.readRecords();
    if (records[path]?.type === 'folder') throw new Error('Path is a folder');
    this.parents(records, path);
    records[path] = { path, type: 'file', mtime: Date.now(), size: data.byteLength, binary };
    this.commit(records, [path]);
  }
  async write(input: string, content: string): Promise<void> {
    const path = vaultPath(input);
    const records = this.readRecords();
    if (records[path]?.type === 'folder') throw new Error('Path is a folder');
    this.parents(records, path);
    records[path] = { path, type: 'file', mtime: Date.now(), size: new TextEncoder().encode(content).length, content };
    this.commit(records, [path]);
  }
  async mkdir(input: string): Promise<void> {
    const path = vaultPath(input);
    const records = this.readRecords();
    if (records[path]?.type === 'file') throw new Error('Path is a file');
    this.parents(records, path);
    records[path] ??= { path, type: 'folder', mtime: Date.now(), size: 0 };
    this.commit(records);
  }
  async rename(input: string, output: string): Promise<void> {
    const from = vaultPath(input);
    const to = vaultPath(output);
    if (from === to) return;
    if (to.startsWith(`${from}/`)) throw new Error('Cannot move a folder into itself');
    const records = this.readRecords();
    if (!records[from]) throw new Error('File or folder not found');
    if (records[to]) throw new Error('Destination already exists');
    this.parents(records, to);
    const moved = Object.keys(records).filter(path => path === from || path.startsWith(`${from}/`));
    for (const old of moved) {
      const path = to + old.slice(from.length);
      records[path] = { ...records[old], path, mtime: Date.now() };
      delete records[old];
    }
    this.commit(records);
  }
  async trash(input: string): Promise<void> {
    const path = vaultPath(input);
    if (path === '.trash' || path.startsWith('.trash/')) throw new Error('Cannot trash the recovery folder');
    await this.rename(path, `.trash/${Date.now()}-${crypto.randomUUID()}/${path}`);
  }
  subscribe(listener: (paths?: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    const storageListener = (event: StorageEvent) => { if (event.key === this.key) listener(); };
    window.addEventListener('storage', storageListener);
    return () => { this.listeners.delete(listener); window.removeEventListener('storage', storageListener); };
  }
}
