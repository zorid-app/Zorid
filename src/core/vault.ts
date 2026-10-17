import { MetadataCache } from './metadata.ts';
import { isMarkdown, normalizePath, parentPath } from './types.ts';
import type { VaultAdapter, VaultChange, VaultEntry, VaultEvent } from './types.ts';
import type { DurableWrites, DurableWriteIntent, DurableWriteRead, DurableWriteRef } from './durable-writes.ts';

export type DurableCommitReceipt = Extract<DurableWriteIntent, { state: 'committed' }>['receipt'];
export type DurableWriteReconciliation =
  | { readonly status: 'current' | 'advanced'; readonly current: DurableWriteRead }
  | { readonly status: 'missing'; readonly current: null };
interface DurableBinding {
  adapter: VaultAdapter;
  capability: DurableWrites;
  checkpoints: DurableWrites['checkpoints'];
  vaultId: string;
  clientId: string;
}
function durableFailure(code: string, message: string): Error & { code: string; source: 'host' } {
  return Object.assign(new Error(message), { code, source: 'host' as const });
}
function copyRef(ref: DurableWriteRef): DurableWriteRef {
  return Object.freeze({ vaultId: ref.vaultId, clientId: ref.clientId, token: ref.token,
    operationId: ref.operationId, entryId: ref.entryId });
}
function sameRef(left: DurableWriteRef, right: DurableWriteRef): boolean {
  return left.vaultId === right.vaultId && left.clientId === right.clientId && left.token === right.token
    && left.operationId === right.operationId && left.entryId === right.entryId;
}
function validReceipt(receipt: DurableCommitReceipt): boolean {
  return typeof receipt.operationId === 'string' && receipt.operationId.length > 0
    && typeof receipt.entryId === 'string' && receipt.entryId.length > 0
    && typeof receipt.revision === 'string' && receipt.revision.length > 0
    && typeof receipt.sequence === 'string' && /^(0|[1-9][0-9]*)$/.test(receipt.sequence);
}
function sameReceipt(left: DurableCommitReceipt, right: DurableCommitReceipt): boolean {
  return left.operationId === right.operationId && left.sequence === right.sequence
    && left.entryId === right.entryId && left.revision === right.revision;
}

function relativePath(source: string, target: string): string {
  const from = parentPath(source).split('/').filter(Boolean), to = target.split('/');
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/');
}

/** Bound filesystem pressure and drain in-flight operations before rejecting a batch. */
async function mapConcurrent<T, R>(items: readonly T[], operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index]); }
      catch (error) { failed = true; throw error; }
    }
  }));
  const failure = workers.find(worker => worker.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}

export class Vault {
  adapter: VaultAdapter;
  entries = new Map<string, VaultEntry>();
  metadata = new MetadataCache();
  private listeners = new Map<VaultEvent, Set<(change: VaultChange) => void>>();
  private pending: Promise<unknown> = Promise.resolve();
  private contents = new Map<string, string>();

  constructor(adapter: VaultAdapter) { this.adapter = adapter; }

  on(event: VaultEvent, callback: (change: VaultChange) => void): () => void {
    let callbacks = this.listeners.get(event);
    if (!callbacks) { callbacks = new Set(); this.listeners.set(event, callbacks); }
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  }

  private emit(event: VaultEvent, change: VaultChange): void {
    for (const callback of this.listeners.get(event) ?? []) {
      try { callback(change); } catch (error) { console.error(`Vault ${event} listener failed`, error); }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  /** Rebuild into a temporary snapshot, so a failed read leaves the old index usable. */
  private async refresh(): Promise<void> {
    const entries = new Map<string, VaultEntry>();
    for (const entry of await this.adapter.list()) {
      const path = normalizePath(entry.path);
      if (entries.has(path)) throw new Error(`Adapter returned a duplicate path: ${path}`);
      entries.set(path, { ...entry, path });
    }
    const metadata = new MetadataCache(), contents = new Map<string, string>();
    metadata.setFiles([...entries.values()].filter(entry => entry.type === 'file').map(entry => entry.path));
    const notes = [...entries.values()].filter(entry => entry.type === 'file' && isMarkdown(entry.path));
    await mapConcurrent(notes, async entry => {
      const content = await this.adapter.read(entry.path);
      contents.set(entry.path, content);
      metadata.index(entry.path, content);
    });
    this.entries = entries;
    this.metadata = metadata;
    this.contents = contents;
  }

  initialize(): Promise<void> { return this.enqueue(async () => { await this.refresh(); this.emit('ready', { path: '' }); }); }
  load(): Promise<void> { return this.initialize(); }

  private captureDurableBinding(): DurableBinding {
    const adapter = this.adapter, capability = adapter.durableWrites;
    const checkpoints = capability?.checkpoints;
    const scope = checkpoints?.scope;
    if (!capability || !checkpoints || !scope?.vaultId || !scope.clientId) {
      throw durableFailure('durable_writes_unavailable', 'This vault has no scoped durable text-save capability');
    }
    return { adapter, capability, checkpoints, vaultId: scope.vaultId, clientId: scope.clientId };
  }

  private validateDurableBinding(binding: DurableBinding, ref?: DurableWriteRef): void {
    const scope = binding.capability.checkpoints?.scope;
    if (this.adapter !== binding.adapter || this.adapter.durableWrites !== binding.capability
        || binding.capability.checkpoints !== binding.checkpoints
        || scope?.vaultId !== binding.vaultId || scope.clientId !== binding.clientId
        || ref && (ref.vaultId !== binding.vaultId || ref.clientId !== binding.clientId)) {
      throw durableFailure('intent_identity_mismatch', 'Durable operation belongs to a different adapter or local storage authority');
    }
  }

  /** Copy one provider observation, including stats; never assemble read + stat. */
  private durableObservation(read: DurableWriteRead, expected: { path?: string; entryId?: string }): DurableWriteRead {
    if (!read || typeof read.content !== 'string' || typeof read.path !== 'string'
        || normalizePath(read.path) !== read.path || typeof read.entryId !== 'string' || !read.entryId
        || typeof read.revision !== 'string' || !read.revision
        || expected.path !== undefined && read.path !== expected.path
        || expected.entryId !== undefined && read.entryId !== expected.entryId
        || !read.stat || ![read.stat.ctime, read.stat.mtime, read.stat.size].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw durableFailure('durable_read_invalid', 'Durable read did not return the requested coherent file observation');
    }
    return Object.freeze({ path: read.path, content: read.content, entryId: read.entryId, revision: read.revision,
      stat: Object.freeze({ ctime: read.stat.ctime, mtime: read.stat.mtime, size: read.stat.size }) });
  }

  readDurableText(rawPath: string, validate?: () => void): Promise<DurableWriteRead> {
    const binding = this.captureDurableBinding(), path = normalizePath(rawPath);
    return this.enqueue(async () => {
      this.validateDurableBinding(binding); validate?.(); this.validateDurableBinding(binding);
      const read = await binding.capability.readText(path);
      this.validateDurableBinding(binding);
      return this.durableObservation(read, { path });
    });
  }

  readDurableTextById(entryId: string): Promise<DurableWriteRead | null> {
    const binding = this.captureDurableBinding();
    return this.enqueue(async () => {
      this.validateDurableBinding(binding);
      const read = await binding.capability.readTextById(entryId);
      this.validateDurableBinding(binding);
      return read === null ? null : this.durableObservation(read, { entryId });
    });
  }

  /** Admission may authorize one exact write. Publication is a separate read-only step. */
  commitDurableWrite(input: DurableWriteRef, options: { validate?: () => void } = {}): Promise<DurableWriteIntent> {
    const binding = this.captureDurableBinding(), ref = copyRef(input), validate = options.validate;
    return this.enqueue(async () => {
      this.validateDurableBinding(binding, ref);
      validate?.();
      this.validateDurableBinding(binding, ref);
      let outcome: DurableWriteIntent;
      try { outcome = await binding.capability.commit(ref); }
      catch (cause) {
        throw Object.assign(durableFailure('outcome_unknown', 'Commit did not return a validated terminal outcome; retain its original ref'), { cause });
      }
      this.validateDurableBinding(binding, ref);
      if (!sameRef(outcome.ref, ref)) throw durableFailure('intent_identity_mismatch', 'Commit returned another operation identity');
      if (outcome.state === 'committed') {
        if (!validReceipt(outcome.receipt) || outcome.receipt.operationId !== ref.operationId || outcome.receipt.entryId !== ref.entryId) {
          throw durableFailure('intent_outcome_mismatch', 'Commit receipt identifies another operation or entry');
        }
      } else if (outcome.state !== 'rejected' || outcome.error.operationId !== ref.operationId) {
        throw durableFailure('outcome_unknown', 'Commit did not return a terminal outcome for the original operation');
      }
      if (outcome.state === 'committed') {
        return Object.freeze({ state: 'committed', acknowledged: outcome.acknowledged, ref: copyRef(outcome.ref),
          receipt: Object.freeze({ ...outcome.receipt }) });
      }
      return Object.freeze({ state: 'rejected', acknowledged: outcome.acknowledged, ref: copyRef(outcome.ref),
        error: Object.freeze({ ...outcome.error, details: structuredClone(outcome.error.details) }) });
    });
  }

  /** Reconcile a historical receipt even after a view retires. Never writes or ACKs.
   * A newer/missing entry is a conflict observation, not evidence the write failed.
   * Those cases need separate coherent namespace recovery; no path-based
   * replacement is removed or rebound by a receipt for an older identity.
   */
  reconcileDurableWrite(input: DurableWriteRef, witness: DurableCommitReceipt): Promise<DurableWriteReconciliation> {
    const binding = this.captureDurableBinding(), ref = copyRef(input), receipt = Object.freeze({ ...witness });
    return this.enqueue(async () => {
      this.validateDurableBinding(binding, ref);
      if (!validReceipt(receipt) || receipt.operationId !== ref.operationId || receipt.entryId !== ref.entryId) {
        throw durableFailure('intent_outcome_mismatch', 'Receipt does not identify the checkpointed operation and entry');
      }
      let outcome: DurableWriteIntent | null;
      try { outcome = await binding.capability.query(ref); }
      catch (cause) {
        throw Object.assign(durableFailure('outcome_unknown', 'Historical write verification failed; preserve its original receipt'), { cause });
      }
      this.validateDurableBinding(binding, ref);
      if (!outcome) throw durableFailure('intent_not_found', 'Historical write intent is missing; reconciliation cannot recreate it');
      if (!sameRef(outcome.ref, ref) || outcome.state !== 'committed' || !sameReceipt(outcome.receipt, receipt)) {
        throw durableFailure('intent_outcome_mismatch', 'Historical receipt disagrees with the durable operation outcome');
      }
      let observed: DurableWriteRead | null;
      try { observed = await binding.capability.readTextById(ref.entryId); }
      catch (cause) {
        throw Object.assign(durableFailure('outcome_unknown', 'Historical write readback failed; preserve its original receipt'), { cause });
      }
      this.validateDurableBinding(binding, ref);
      if (observed === null) return { status: 'missing', current: null };
      const current = this.durableObservation(observed, { entryId: ref.entryId });
      if (current.revision !== receipt.revision) return { status: 'advanced', current };

      const path = current.path, old = this.entries.get(path), oldContent = this.contents.get(path);
      if (old && old.type !== 'file') throw durableFailure('durable_read_invalid', 'Committed file conflicts with a cached folder; refresh the namespace');
      const entry: VaultEntry = { path, type: 'file', revision: current.revision,
        ctime: current.stat.ctime, mtime: current.stat.mtime, size: current.stat.size };
      const entries = new Map(this.entries), contents = new Map(this.contents);
      entries.set(path, entry);
      if (isMarkdown(path)) contents.set(path, current.content);
      // Parse before publishing maps or dispatching events. indexBatch itself
      // parses every item before touching the existing metadata cache.
      if (isMarkdown(path)) this.metadata.indexBatch([[path, current.content]]);
      this.metadata.setFiles([...entries.values()].filter(item => item.type === 'file').map(item => item.path));
      this.entries = entries; this.contents = contents;
      if (!old) this.emit('create', { path, entry });
      else if (old.revision !== entry.revision || old.mtime !== entry.mtime || old.size !== entry.size
          || isMarkdown(path) && current.content !== oldContent) this.emit('modify', { path, entry });
      return { status: 'current', current };
    });
  }

  /** Refresh known files only when a watcher provides exact paths; structural changes rescan. */
  private async refreshPaths(rawPaths: readonly string[]): Promise<boolean> {
    if (!this.adapter.stat) return false;
    let paths: string[];
    try { paths = [...new Set(rawPaths.map(normalizePath))]; }
    catch { return false; } // A root/directory notification cannot identify a file snapshot.
    if (paths.some(path => this.entries.get(path)?.type !== 'file')) return false;
    const snapshots = await mapConcurrent(paths, async path => {
      const entry = await this.adapter.stat!(path);
      if (!entry || entry.type !== 'file') return null;
      if (normalizePath(entry.path) !== path) throw new Error(`Adapter returned mismatched stat path: ${path}`);
      return { ...entry, path };
    });
    if (snapshots.some(entry => !entry)) return false;
    const entries = new Map(snapshots.map(entry => [entry!.path, entry!]));
    // Always read Markdown content: timestamps and byte lengths can remain unchanged.
    const contents = new Map(await mapConcurrent(paths.filter(isMarkdown), async path =>
      [path, await this.adapter.read(path)] as const));
    const changes: VaultChange[] = [];
    for (const [path, entry] of entries) {
      const old = this.entries.get(path)!;
      // Exact attachment notifications invalidate viewers even when a replacement
      // preserves its stats. Duplicate binary events are preferable to stale media;
      // no-argument full scans still compare metadata without loading binary files.
      if (!isMarkdown(path) || old.revision !== entry.revision || old.mtime !== entry.mtime || old.size !== entry.size || this.contents.get(path) !== contents.get(path)) {
        changes.push({ path, entry });
      }
    }
    // No await or event dispatch may split publication of a batch. Parse first so a
    // failed read or parse leaves entries, contents and the metadata index unchanged.
    this.metadata.indexBatch([...contents].filter(([path, content]) => this.contents.get(path) !== content));
    for (const [path, entry] of entries) this.entries.set(path, entry);
    for (const [path, content] of contents) this.contents.set(path, content);
    for (const change of changes) this.emit('modify', change);
    return true;
  }

  /** Call from a platform file watcher. Deletions/moves appear as delete/create. */
  reload(paths?: readonly string[]): Promise<void> {
    const requestedPaths = paths ? [...paths] : undefined;
    return this.enqueue(async () => {
      if (requestedPaths && await this.refreshPaths(requestedPaths)) return;
      const previous = this.entries, contents = this.contents;
      await this.refresh();
      for (const [path, entry] of previous) if (!this.entries.has(path)) this.emit('delete', { path, entry });
      for (const [path, entry] of this.entries) {
        const old = previous.get(path);
        if (!old) this.emit('create', { path, entry });
        else if (old.revision !== entry.revision || old.mtime !== entry.mtime || old.size !== entry.size || contents.get(path) !== this.contents.get(path)) this.emit('modify', { path, entry });
      }
    });
  }

  private requireFile(path: string): VaultEntry {
    const entry = this.entries.get(path);
    if (!entry || entry.type !== 'file') throw new Error(`File does not exist: ${path}`);
    return entry;
  }

  private requireDestination(path: string): void {
    if (this.entries.has(path)) throw new Error(`Path already exists: ${path}`);
    const parent = parentPath(path);
    if (parent && this.entries.get(parent)?.type !== 'folder') throw new Error(`Parent folder does not exist: ${parent}`);
  }

  async read(rawPath: string, validate?: () => void): Promise<string> {
    await this.pending;
    validate?.();
    const path = normalizePath(rawPath);
    this.requireFile(path);
    return this.adapter.read(path);
  }

  async readBinary(rawPath: string, validate?: () => void): Promise<Uint8Array> {
    await this.pending;
    validate?.();
    const path = normalizePath(rawPath);
    this.requireFile(path);
    if (!this.adapter.readBinary) throw new Error('Vault adapter does not support binary reads');
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  /** Publish only this written file; attachment bytes never go through Markdown decoding. */
  private async publishBinary(path: string): Promise<VaultEntry> {
    const content = isMarkdown(path) ? await this.adapter.read(path) : undefined;
    const entry = this.adapter.stat
      ? await this.adapter.stat(path)
      : (await this.adapter.list()).find(item => normalizePath(item.path) === path);
    if (!entry || entry.type !== 'file' || normalizePath(entry.path) !== path) {
      throw new Error(`Written file is no longer available: ${path}`);
    }
    if (content !== undefined) {
      this.metadata.index(path, content);
      this.contents.set(path, content);
    } else if (!this.entries.has(path)) {
      this.metadata.setFiles([...this.entries.values()].filter(item => item.type === 'file').map(item => item.path).concat(path));
    }
    const updated = { ...entry, path };
    this.entries.set(path, updated);
    return updated;
  }

  createBinary(rawPath: string, data: Uint8Array): Promise<VaultEntry> {
    const bytes = new Uint8Array(data);
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      if (!this.adapter.writeBinary) throw new Error('Vault adapter does not support binary writes');
      // Check fresh directory metadata without reading unrelated notes. Other changed
      // files remain watcher work; publishing a partial vault refresh would be unsafe.
      const inventory = new Map<string, VaultEntry>();
      for (const entry of await this.adapter.list()) {
        const name = normalizePath(entry.path);
        if (inventory.has(name)) throw new Error(`Adapter returned a duplicate path: ${name}`);
        inventory.set(name, entry);
      }
      if (inventory.has(path)) throw new Error(`Path already exists: ${path}`);
      const parent = parentPath(path);
      if (parent && inventory.get(parent)?.type !== 'folder') throw new Error(`Parent folder does not exist: ${parent}`);
      // A newly discovered parent or a replaced cached directory is structural:
      // reconcile its descendants before adding a child to the visible tree.
      if (this.entries.get(path)?.type === 'folder' || (parent && this.entries.get(parent)?.type !== 'folder')) {
        await this.refresh();
        this.requireDestination(path);
      }
      await this.adapter.writeBinary(path, bytes);
      const entry = await this.publishBinary(path);
      this.emit('create', { path, entry });
      return entry;
    });
  }

  modifyBinary(rawPath: string, data: Uint8Array, options: { validate?: () => void } = {}): Promise<void> {
    const bytes = new Uint8Array(data);
    return this.enqueue(async () => {
      options.validate?.();
      const path = normalizePath(rawPath);
      this.requireFile(path);
      if (!this.adapter.writeBinary) throw new Error('Vault adapter does not support binary writes');
      await this.adapter.writeBinary(path, bytes);
      const entry = await this.publishBinary(path);
      this.emit('modify', { path, entry });
    });
  }

  /** Reuse the indexed Markdown snapshot for previews; watchers invalidate it. */
  async cachedRead(rawPath: string, validate?: () => void): Promise<string> {
    await this.pending;
    validate?.();
    const path = normalizePath(rawPath);
    this.requireFile(path);
    return this.contents.get(path) ?? this.adapter.read(path);
  }

  create(rawPath: string, text = ''): Promise<VaultEntry> {
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      await this.refresh();
      this.requireDestination(path);
      if (this.adapter.createText) await this.adapter.createText(path, text);
      else await this.adapter.write(path, text);
      await this.refresh();
      const entry = this.entries.get(path)!;
      this.emit('create', { path, entry });
      return entry;
    });
  }

  modify(rawPath: string, text: string, options: { expectedContent?: string; validate?: () => void } = {}): Promise<void> {
    return this.enqueue(async () => {
      options.validate?.();
      const path = normalizePath(rawPath);
      this.requireFile(path);
      if (options.expectedContent !== undefined && this.adapter.compareAndWrite) {
        await this.adapter.compareAndWrite(path, options.expectedContent, text);
      } else {
        if (options.expectedContent !== undefined && await this.adapter.read(path) !== options.expectedContent) {
          throw new Error(`File changed outside this editor: ${path}`);
        }
        await this.adapter.write(path, text);
      }
      // Only the written file needs reindexing. Read it back and use adapter metadata
      // rather than guessing timestamps or treating UTF-16 length as a byte count.
      const content = await this.adapter.read(path);
      const entry = this.adapter.stat
        ? await this.adapter.stat(path)
        : (await this.adapter.list()).find(item => normalizePath(item.path) === path);
      if (!entry || entry.type !== 'file' || normalizePath(entry.path) !== path) {
        throw new Error(`Written file is no longer available: ${path}`);
      }
      // Publish only after all I/O succeeds. Failed writes/reads retain the previous
      // snapshot and propagate the error so callers keep their recovery drafts.
      if (isMarkdown(path)) {
        this.metadata.index(path, content);
        this.contents.set(path, content);
      }
      const updated = { ...entry, path };
      this.entries.set(path, updated);
      this.emit('modify', { path, entry: updated });
    });
  }

  createFolder(rawPath: string, validate?: () => void): Promise<VaultEntry> {
    return this.enqueue(async () => {
      validate?.();
      const path = normalizePath(rawPath);
      await this.refresh();
      this.requireDestination(path);
      validate?.();
      await this.adapter.mkdir(path);
      await this.refresh();
      const entry = this.entries.get(path)!;
      this.emit('create', { path, entry });
      return entry;
    });
  }

  /** Move an entry without rewriting any note contents. */
  renameEntry(rawOld: string, rawNew: string, validate?: () => void): Promise<void> {
    return this.renameInternal(rawOld, rawNew, false, validate);
  }

  /** Update links resolved against the pre-move index, including links inside moved notes. */
  rename(rawOld: string, rawNew: string, validate?: () => void): Promise<void> {
    return this.renameInternal(rawOld, rawNew, true, validate);
  }

  private renameInternal(rawOld: string, rawNew: string, updateLinks: boolean, validate?: () => void): Promise<void> {
    return this.enqueue(async () => {
      validate?.();
      const oldPath = normalizePath(rawOld), newPath = normalizePath(rawNew);
      await this.refresh();
      if (!this.entries.has(oldPath)) throw new Error(`Path does not exist: ${oldPath}`);
      if (oldPath === newPath) return;
      this.requireDestination(newPath);
      if (newPath.startsWith(`${oldPath}/`)) throw new Error('Cannot move a folder inside itself');
      const moved = (path: string): string => path === oldPath || path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
      const changes: { old: string; path: string; before: string; after: string }[] = [];
      for (const [source, note] of updateLinks ? this.metadata.entries() : []) {
        const before = this.contents.get(source)!;
        let after = before;
        const newSource = moved(source);
        for (const link of [...note.links].reverse()) {
          const target = this.metadata.resolveLink(source, link.target, link.kind);
          if (!target) continue;
          const newTarget = moved(target);
          if (newTarget === target && newSource === source) continue;
          // Heading-only links remain local when the entire note moves.
          if (!link.target && source === target) continue;
          let replacement: string;
          if (link.kind === 'markdown') {
            replacement = link.target.startsWith('/') ? `/${newTarget}` : relativePath(newSource, newTarget);
            if (!/\.md$/i.test(link.target) && isMarkdown(newTarget) && !/%2e/i.test(link.target)) replacement = replacement.replace(/\.md$/i, '');
            if (link.target.startsWith('./') && !replacement.startsWith('.')) replacement = `./${replacement}`;
            // Spaces must be encoded in bare Markdown destinations. Angle-wrapped targets accept spaces.
            if (before[link.start - 1] !== '<') replacement = encodeURI(replacement).replace(/#/g, '%23').replace(/\(/g, '%28').replace(/\)/g, '%29');
          } else {
            replacement = /\.md$/i.test(link.target) ? newTarget : newTarget.replace(/\.md$/i, '');
          }
          after = after.slice(0, link.start) + replacement + after.slice(link.end);
        }
        if (after !== before) changes.push({ old: source, path: newSource, before, after });
      }
      const stableBacklinks = new Map<string,string>();
      if (this.adapter.durableNamespace && changes.length) {
        if (!this.adapter.durableWrites || !this.adapter.compareAndWrite) throw new Error('Durable backlink updates require coherent reads and compare-and-write');
        for (const change of changes) {
          const observed = await this.adapter.durableWrites.readText(change.old);
          if (observed.content !== change.before) throw new Error(`File changed before rename: ${change.old}`);
          stableBacklinks.set(change.old, observed.entryId);
        }
      }
      validate?.();
      await this.adapter.rename(oldPath, newPath);
      const written: typeof changes = [];
      if (this.adapter.durableNamespace) {
        let rewriteError: unknown;
        try {
          if (changes.length && !this.adapter.compareAndWrite) throw new Error('Durable backlink updates require compare-and-write');
          for (const change of changes) {
            const entryId = stableBacklinks.get(change.old)!;
            const observed = await this.adapter.durableWrites!.readTextById(entryId);
            if (!observed || observed.path !== change.path || observed.content !== change.before) throw new Error(`Backlink target changed during rename: ${change.path}`);
            await this.adapter.compareAndWrite!(change.path, change.before, change.after, {entryId,revision:observed.revision});
            written.push(change);
          }
        } catch (error) { rewriteError = error; }
        // The namespace receipt is already committed. Never issue compensating
        // writes/moves that could overwrite a concurrent edit or retry history.
        await this.refresh();
        this.emit('rename', { path: newPath, oldPath, entry: this.entries.get(newPath) });
        for (const change of written) this.emit('modify', { path: change.path, entry: this.entries.get(change.path) });
        if (rewriteError) throw new AggregateError([rewriteError], 'Rename committed, but some links could not be updated; existing contents were retained');
        return;
      }
      try {
        for (const change of changes) {
          if (await this.adapter.read(change.path) !== change.before) throw new Error(`File changed during rename: ${change.path}`);
          await this.adapter.write(change.path, change.after);
          written.push(change);
        }
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        for (const change of written.reverse()) {
          try { await this.adapter.write(change.path, change.before); } catch (recovery) { recoveryErrors.push(recovery); }
        }
        try { await this.adapter.rename(newPath, oldPath); } catch (recovery) { recoveryErrors.push(recovery); }
        await this.refresh();
        if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], 'Rename failed and could not be fully rolled back');
        throw error;
      }
      await this.refresh();
      this.emit('rename', { path: newPath, oldPath, entry: this.entries.get(newPath) });
      for (const change of changes) this.emit('modify', { path: change.path, entry: this.entries.get(change.path) });
    });
  }

  /** Permanently delete through an explicit adapter capability, preserving event ordering. */
  deleteEntry(rawPath: string, force = false, validate?: () => void): Promise<void> {
    return this.removeEntry(rawPath, force, validate);
  }

  trash(rawPath: string, validate?: () => void): Promise<void> {
    return this.removeEntry(rawPath, undefined, validate);
  }

  private removeEntry(rawPath: string, force?: boolean, validate?: () => void): Promise<void> {
    return this.enqueue(async () => {
      validate?.();
      const path = normalizePath(rawPath);
      if (force !== undefined && !this.adapter.remove) throw new Error('Vault adapter does not support permanent deletion');
      const entry = this.entries.get(path);
      if (!entry) throw new Error(`Path does not exist: ${path}`);
      const removed = [...this.entries.values()].filter(item => item.path === path || item.path.startsWith(`${path}/`));
      if (force !== undefined) {
        await this.adapter.remove!(path, force);
      } else {
        await this.adapter.trash(path);
      }
      await this.refresh();
      for (const item of removed) this.emit('delete', { path: item.path, entry: item });
    });
  }
}
