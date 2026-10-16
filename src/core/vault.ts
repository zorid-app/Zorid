import { MetadataCache } from './metadata.ts';
import { isMarkdown, normalizePath, parentPath } from './types.ts';
import type { VaultAdapter, VaultChange, VaultEntry, VaultEvent } from './types.ts';

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
      if (!isMarkdown(path) || old.mtime !== entry.mtime || old.size !== entry.size || this.contents.get(path) !== contents.get(path)) {
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
        else if (old.mtime !== entry.mtime || old.size !== entry.size || contents.get(path) !== this.contents.get(path)) this.emit('modify', { path, entry });
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

  async read(rawPath: string): Promise<string> {
    await this.pending;
    const path = normalizePath(rawPath);
    this.requireFile(path);
    return this.adapter.read(path);
  }

  async readBinary(rawPath: string): Promise<Uint8Array> {
    await this.pending;
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

  modifyBinary(rawPath: string, data: Uint8Array): Promise<void> {
    const bytes = new Uint8Array(data);
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      this.requireFile(path);
      if (!this.adapter.writeBinary) throw new Error('Vault adapter does not support binary writes');
      await this.adapter.writeBinary(path, bytes);
      const entry = await this.publishBinary(path);
      this.emit('modify', { path, entry });
    });
  }

  /** Reuse the indexed Markdown snapshot for previews; watchers invalidate it. */
  async cachedRead(rawPath: string): Promise<string> {
    await this.pending;
    const path = normalizePath(rawPath);
    this.requireFile(path);
    return this.contents.get(path) ?? this.adapter.read(path);
  }

  create(rawPath: string, text = ''): Promise<VaultEntry> {
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      await this.refresh();
      this.requireDestination(path);
      await this.adapter.write(path, text);
      await this.refresh();
      const entry = this.entries.get(path)!;
      this.emit('create', { path, entry });
      return entry;
    });
  }

  modify(rawPath: string, text: string, options: { expectedContent?: string } = {}): Promise<void> {
    return this.enqueue(async () => {
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

  createFolder(rawPath: string): Promise<VaultEntry> {
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      await this.refresh();
      this.requireDestination(path);
      await this.adapter.mkdir(path);
      await this.refresh();
      const entry = this.entries.get(path)!;
      this.emit('create', { path, entry });
      return entry;
    });
  }

  /** Move an entry without rewriting any note contents. */
  renameEntry(rawOld: string, rawNew: string): Promise<void> {
    return this.renameInternal(rawOld, rawNew, false);
  }

  /** Update links resolved against the pre-move index, including links inside moved notes. */
  rename(rawOld: string, rawNew: string): Promise<void> {
    return this.renameInternal(rawOld, rawNew, true);
  }

  private renameInternal(rawOld: string, rawNew: string, updateLinks: boolean): Promise<void> {
    return this.enqueue(async () => {
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
      await this.adapter.rename(oldPath, newPath);
      const written: typeof changes = [];
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
  deleteEntry(rawPath: string, force = false): Promise<void> {
    return this.removeEntry(rawPath, force);
  }

  trash(rawPath: string): Promise<void> {
    return this.removeEntry(rawPath);
  }

  private removeEntry(rawPath: string, force?: boolean): Promise<void> {
    return this.enqueue(async () => {
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
