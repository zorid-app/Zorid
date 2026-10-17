import type { DurableWrites } from './durable-writes.ts';

export interface VaultEntry {
  path: string;
  type: 'file' | 'folder';
  /** Creation time in milliseconds, only when the adapter can provide it. */
  ctime?: number;
  /** Opaque committed identity/version token. Compare only for equality, never as a timestamp. */
  revision?: string;
  mtime: number;
  size: number;
}

/** Paths are relative to the vault. Implementations must enforce the vault boundary. */
export interface VaultAdapter {
  /** Optional durable text-save protocol; commit/publication run through Vault. */
  readonly durableWrites?: DurableWrites;
  list(): Promise<VaultEntry[]>;
  /** Read one entry's current metadata without listing the entire vault. Missing paths return null. */
  stat?(path: string): Promise<VaultEntry | null>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Explicit create, never overwrite; optional durable native creation consumer. */
  createText?(path: string, content: string): Promise<void>;
  /** Compare and write in one shared host queue; reject mismatches without writing. */
  compareAndWrite?(path: string, expectedContent: string, content: string): Promise<void>;
  /** Binary APIs preserve every byte; implementations must not retain mutable caller buffers. */
  readBinary?(path: string): Promise<Uint8Array>;
  writeBinary?(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  trash(path: string): Promise<void>;
  /** Permanently remove an entry. Forward force to the host deletion policy; never substitute trash. */
  remove?(path: string, force: boolean): Promise<void>;
  /** A host-provided URL usable by rendered media; unavailable adapters must omit it. */
  getResourcePath?(path: string): string;
  /** Changed vault-relative paths, or undefined when the watcher requires a full rescan. */
  subscribe?(listener: (paths?: readonly string[]) => void): () => void;
}

export interface Heading { heading: string; level: number; line: number }
export interface NoteLink {
  target: string;
  kind: 'wiki' | 'markdown';
  embed: boolean;
  /** Character range of the destination, excluding its heading/block fragment. */
  start: number;
  end: number;
  fragment: string;
}
export interface NoteMetadata {
  path: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  aliases: string[];
  headings: Heading[];
  links: NoteLink[];
}
export interface Backlink { source: string; link: NoteLink }
export type VaultEvent = 'create' | 'modify' | 'rename' | 'delete' | 'ready';
export interface VaultChange { path: string; oldPath?: string; entry?: VaultEntry }

export function normalizePath(path: string): string {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f]/.test(path)) {
    throw new Error('A nonempty vault-relative path is required');
  }
  const value = path.replace(/\\/g, '/');
  if (value.startsWith('/') || /^[a-z]:/i.test(value)) throw new Error('Absolute paths are not allowed');
  const segments = value.split('/');
  if (segments.includes('..')) throw new Error('Paths cannot escape their vault location');
  const result = segments.filter(segment => segment && segment !== '.').join('/');
  if (!result) throw new Error('The vault root is not a file path');
  return result;
}

export function parentPath(path: string): string { return path.slice(0, Math.max(0, path.lastIndexOf('/'))); }
export function isMarkdown(path: string): boolean { return /\.md$/i.test(path); }
