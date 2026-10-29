import type {DocumentService} from './document-semantics.ts';
import type {BinaryStreams} from './binary-streams.ts';
import type { DurableWrites } from './durable-writes.ts';
import type { IndependentDraftProvider } from './independent-drafts.ts';

export interface VaultEntry {
  path: string;
  /** Authoritative stable identity, required for admitted binary streaming. */
  entryId?: string;
  type: 'file' | 'folder';
  /** Creation time in milliseconds, only when the adapter can provide it. */
  ctime?: number;
  /** Opaque committed identity/version token. Compare only for equality, never as a timestamp. */
  revision?: string;
  mtime: number;
  size: number;
}

export type RenameExpectedIdentity = Readonly<{entryId:string;revision:string}>;
export interface TextCreateReceipt {
  readonly operationId: string;
  readonly entryId: string;
  readonly revision: string;
  readonly path: string;
  readonly sequence: string;
}
/** A captured command owns one original request across uncertain replies. */
export interface CapturedTextCreate {
  readonly operationId: string;
  readonly entryId: string;
  readonly path: string;
  readonly text: string;
  run(): Promise<TextCreateReceipt>;
}

/** Paths are relative to the vault. Implementations must enforce the vault boundary. */
export interface VaultAdapter {
  /** Optional admitted Rust-owned metadata/index/Base read capability. */
  readonly documentSemantics?:DocumentService;
  /** Optional Rust-owned local collections; no sync enrollment or JS authority. */
  readonly databases?:import('./databases.ts').DatabaseService;
  /** Optional admitted bounded stage/pinned-read authority. */
  readonly binaryStreams?: BinaryStreams;
  /** Optional durable text-save protocol; commit/publication run through Vault. */
  readonly durableWrites?: DurableWrites;
  /** Independent local draft protection; this never acknowledges a core save. */
  readonly independentDrafts?: IndependentDraftProvider;
  /** Namespace commits are durable independently of optional backlink rewrites. */
  readonly durableNamespace?: boolean;
  list(): Promise<VaultEntry[]>;
  /** Read one entry's current metadata without listing the entire vault. Missing paths return null. */
  stat?(path: string): Promise<VaultEntry | null>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Explicit create, never overwrite; optional durable native creation consumer. */
  createText?(path: string, content: string): Promise<void>;
  /** Optional receipt-backed creation. Capture is inert; run replays only this
   * original command, including after its destination becomes occupied. */
  captureTextCreate?(path: string, content: string): CapturedTextCreate;
  /** Compare and write in one shared host queue; reject mismatches without writing. */
  compareAndWrite?(path: string, expectedContent: string, content: string, expectedIdentity?: {entryId:string;revision:string}): Promise<void>;
  /** Binary APIs preserve every byte; implementations must not retain mutable caller buffers. */
  readBinary?(path: string): Promise<Uint8Array>;
  writeBinary?(path: string, data: Uint8Array): Promise<void>;
  /** Explicit atomic create; reject an existing destination without overwriting it. */
  createBinary?(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Bind witnessed renames to the selected committed entry and revision. */
  rename(oldPath: string, newPath: string, expectedIdentity?: RenameExpectedIdentity): Promise<void>;
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
