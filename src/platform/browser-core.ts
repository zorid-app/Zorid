import type { VaultAdapter, VaultEntry } from '../core/types.ts';
import type { BrowserVaultIntent, BrowserVaultRead, BrowserVaultOutcome } from '../core/browser-vault.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import { vaultPath } from './path.ts';

/** Stable identity preserves the existing workspace/session/draft namespace. */
export const BROWSER_CORE_VAULT_ID = 'browser:default';
export interface BrowserCoreBackend {
  inventory(): Promise<BrowserVaultRead[]>;
  readEntry(path: string): Promise<BrowserVaultRead | null>;
  /** Persist exact intent before executing; retries must reuse both arguments. */
  execute(intentId: string, requestJson: string): Promise<string>;
  intents(): Promise<BrowserVaultIntent[]>;
  acknowledge(intentId: string, outcome: BrowserVaultOutcome): Promise<void>;
  subscribe(listener: (paths?: readonly string[]) => void): () => void;
  close(): void;
}
interface Mutation { type: string; id: string; [key: string]: unknown }
const metadata = ({entry, presentation}: BrowserVaultRead): VaultEntry & {revision:string} => ({
  path: entry.path, type: entry.kind, ctime: presentation.ctime_ms,
  mtime: presentation.mtime_ms, size: presentation.size_bytes, revision:entry.revision,
});
function failure(code: string, message: string): BrowserVaultError { return new BrowserVaultError(code, message); }

/** Compatibility facade for the current editor. No CRDT/remote-ingestion API. */
export class BrowserCoreAdapter implements VaultAdapter {
  private pending: Promise<unknown> = Promise.resolve();
  private unresolved?: { intentId: string; json: string; signature: string };
  private activeSignature = '';
  private closed = false;
  private readonly backend: BrowserCoreBackend;
  constructor(backend: BrowserCoreBackend) { this.backend = backend; }

  private enqueue(signature: string, operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(async () => {
      if (this.closed) throw failure('storage_closed', 'Browser vault is closed');
      // Finish this client's exact earlier intent before accepting a new command.
      // A failed recovery keeps the command blocked instead of minting another ID.
      if (this.unresolved) {
        const retry = this.unresolved.signature === signature;
        await this.executePrepared(this.unresolved);
        if (retry) return;
      }
      this.activeSignature = signature;
      return operation();
    });
    this.pending = result.catch(() => undefined); return result;
  }
  private async executePrepared(intent: {intentId: string; json: string; signature: string}): Promise<void> {
    this.unresolved = intent;
    try { await this.backend.execute(intent.intentId, intent.json); this.unresolved = undefined; }
    catch (error) {
      // A settled Rust rejection is definitive. Transport/I/O failures retain
      // the original intent; completion may already have occurred.
      if (error instanceof BrowserVaultError && (error.source === 'rust' || error.code === 'recovery_required')) this.unresolved = undefined;
      throw error;
    }
  }
  private commit(mutation: Mutation): Promise<void> {
    const intentId = crypto.randomUUID();
    return this.executePrepared({intentId, json: JSON.stringify({operation_id: intentId, mutation}), signature:this.activeSignature});
  }
  private async file(path: string): Promise<BrowserVaultRead> {
    const row = await this.backend.readEntry(path);
    if (!row) throw failure('ENOENT', `File not found: ${path}`);
    if (row.entry.kind !== 'file' || !row.bytes) throw failure('not_file', `Path is not a file: ${path}`);
    return row;
  }
  async list(): Promise<VaultEntry[]> {
    const rows = await this.backend.inventory();
    return rows.filter(row => !row.entry.path.split('/').some(part => part.startsWith('.'))).map(metadata).sort((a,b) => a.path.localeCompare(b.path));
  }
  async stat(input: string): Promise<VaultEntry | null> {
    const row = await this.backend.readEntry(vaultPath(input)); return row ? metadata(row) : null;
  }
  async read(input: string): Promise<string> { return new TextDecoder('utf-8', {fatal: true, ignoreBOM:true}).decode((await this.file(vaultPath(input))).bytes); }
  async readBinary(input: string): Promise<Uint8Array> { return (await this.file(vaultPath(input))).bytes!.slice(); }
  write(input: string, text: string): Promise<void> { return this.writeBinary(input, new TextEncoder().encode(text)); }
  writeBinary(input: string, data: Uint8Array): Promise<void> {
    const path = vaultPath(input), bytes = Array.from(data); // Snapshot before queue/await.
    return this.enqueue(JSON.stringify(['write', path, bytes]), async () => {
      const row = await this.backend.readEntry(path);
      if (row && row.entry.kind !== 'file') throw failure('not_file', `Path is not a file: ${path}`);
      await this.commit(row ? {type:'write', id:row.entry.id, expected:row.entry.revision, content:bytes}
        : {type:'create', id:crypto.randomUUID(), path, kind:'file', content:bytes});
    });
  }
  compareAndWrite(input: string, expectedContent: string, text: string): Promise<void> {
    const path = vaultPath(input), bytes = Array.from(new TextEncoder().encode(text));
    return this.enqueue(JSON.stringify(['compareAndWrite', path, expectedContent, bytes]), async () => {
      const row = await this.file(path);
      if (new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(row.bytes) !== expectedContent) {
        throw failure('content_conflict', `File changed outside this editor: ${path}`);
      }
      // The bytes and revision came from one read transaction. Rust's revision
      // check rejects any intervening writer, including an independent tab.
      await this.commit({type:'write', id:row.entry.id, expected:row.entry.revision, content:bytes});
    });
  }
  mkdir(input: string): Promise<void> {
    const path = vaultPath(input);
    return this.enqueue(JSON.stringify(['mkdir', path]), async () => {
      const row = await this.backend.readEntry(path);
      if (row?.entry.kind === 'folder') return;
      await this.commit({type:'create', id:crypto.randomUUID(), path, kind:'folder', content:null});
    });
  }
  rename(input: string, output: string): Promise<void> {
    const from = vaultPath(input), path = vaultPath(output);
    return this.enqueue(JSON.stringify(['rename', from, path]), async () => {
      const row = await this.backend.readEntry(from);
      if (!row) throw failure('ENOENT', `Entry not found: ${from}`);
      if (from === path) return;
      await this.commit({type:'move', id:row.entry.id, expected:row.entry.revision, path});
    });
  }
  trash(input: string): Promise<void> {
    const path = vaultPath(input);
    return this.enqueue(JSON.stringify(['trash', path]), async () => {
      const row = await this.backend.readEntry(path);
      if (!row) throw failure('ENOENT', `Entry not found: ${path}`);
      // Core logical deletion retains bytes/tombstones; never expose permanent
      // remove capability until a separately approved retention policy exists.
      await this.commit({type:'delete', id:row.entry.id, expected:row.entry.revision, recursive:true});
    });
  }
  subscribe(listener: (paths?: readonly string[]) => void): () => void { return this.backend.subscribe(listener); }
  /** Receipt-bearing seam for later NoteBuffer operation identity integration. */
  intents(): Promise<BrowserVaultIntent[]> { return this.backend.intents(); }
  /** Call only after the consumer durably reconciles the matching draft/command. */
  acknowledge(intentId: string, outcome: BrowserVaultOutcome): Promise<void> { return this.backend.acknowledge(intentId,outcome); }
  async close(): Promise<void> { await this.pending; this.closed = true; this.backend.close(); }
}
