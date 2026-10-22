import {binaryLength,writeBinarySource,readBinarySink} from './binary-transfer.ts';
import {scheduleBinaryTransfer} from './binary-transfer-queue.ts';
import type {BinarySource,BinarySink} from './binary-transfer.ts';
import type {BinaryStreams,BinaryReadRef} from './binary-streams.ts';
import { MetadataCache } from './metadata.ts';
import {CommittedMetadataProjection} from './committed-metadata-frame.ts';
import type {CommittedMetadataFrame, CommittedMetadataState} from './committed-metadata-frame.ts';
import { isMarkdown, normalizePath, parentPath } from './types.ts';
import type { VaultAdapter, VaultChange, VaultEntry, VaultEvent } from './types.ts';
import type { DurableWrites, DurableWriteIntent, DurableWriteRead, DurableWriteRef } from './durable-writes.ts';

export type DurableCommitReceipt = Extract<DurableWriteIntent, { state: 'committed' }>['receipt'];
export interface VaultCreateOperation {
  readonly path: string;
  readonly text: string;
  readonly status: 'ready' | 'creating' | 'uncertain' | 'committed';
  /** Same captured destination/body/adapter on every retry; never pick another name. */
  run(): Promise<VaultEntry>;
}
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

  private readonly metadataProjection: CommittedMetadataProjection | undefined;
  private readonly metadataListeners = new Set<(state: CommittedMetadataState) => void>();
  private metadataRetired = false;
  private projectedMetadataFrame: CommittedMetadataFrame | null | undefined;

  constructor(adapter: VaultAdapter) {
    this.adapter = adapter;
    const service = adapter.documentSemantics;
    // Paging alone is not normal consumer activation: D-off providers keep the
    // legacy path until autonomous publication delivery is admitted too.
    if (service?.metadataRowsAvailable === true && typeof service.maintenance?.observeAndSubscribe === 'function') {
      this.metadataProjection = new CommittedMetadataProjection(service,
        () => this.adapter === adapter && this.adapter.documentSemantics === service,
        state => {
          if (this.projectedMetadataFrame !== state.frame) {
            this.projectedMetadataFrame = state.frame;
            const cache = new MetadataCache(path => {
              const live = this.entries.get(path), item = state.frame?.row(path);
              const witnessed = item?.kind === 'file' ? item.value.entry : undefined;
              return !this.metadataRetired && this.adapter === adapter && this.adapter.documentSemantics === service && !!live && live.type === 'file' && !!witnessed && live.entryId === witnessed.id && live.revision === witnessed.revision;
            });
            cache.adopt(state.frame?.metadata.entries() ?? [], this.filePaths());
            this.metadata = cache;
          }
          for (const callback of this.metadataListeners) {
            try { callback(state); } catch (error) { console.error('Vault metadata listener failed', error); }
          }
        });
    }
  }

  /** Undefined is legacy; pending/null on a capable provider is not empty facts. */
  get metadataFrame(): CommittedMetadataState | undefined { return this.metadataProjection?.state; }
  onMetadata(callback: (state: CommittedMetadataState) => void): () => void {
    if (this.metadataRetired) return () => {};
    this.metadataListeners.add(callback);
    return () => { this.metadataListeners.delete(callback); };
  }
  /** Permanent retirement; failed close acknowledgements remain retryable. */
  closeMetadataProjection(): Promise<void> {
    this.metadataRetired = true; this.metadataListeners.clear();
    if (!this.metadataProjection) return Promise.resolve();
    return this.metadataProjection.close().then(() => {
      // Keep retry ownership until every close ACK succeeds. After success no
      // Vault-owned cache/closure should keep a disposed frame's data alive.
      this.projectedMetadataFrame = undefined;
      this.metadata = new MetadataCache(() => false);
    });
  }
  private filePaths(): string[] { return [...this.entries.values()].filter(entry => entry.type === 'file').map(entry => entry.path); }
  private metadataChanged(): void {
    this.metadata.setFiles(this.filePaths());
    this.metadataProjection?.invalidate();
  }

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
    if (this.metadataProjection) {
      // Namespace inventory is metadata-only. Actual note/embed bodies stay lazy.
      const contents = new Map<string, string>();
      for (const [path, content] of this.contents) {
        const old = this.entries.get(path), current = entries.get(path);
        if (old?.entryId && old.revision && old.entryId === current?.entryId && old.revision === current.revision) contents.set(path, content);
      }
      this.entries = entries; this.contents = contents; this.metadataChanged();
      return;
    }
    const metadata = new MetadataCache(), contents = new Map<string, string>();
    metadata.setFiles([...entries.values()].filter(entry => entry.type === 'file').map(entry => entry.path));
    const notes = [...entries.values()].filter(entry => entry.type === 'file' && this.indexableMarkdown(this.adapter,entry));
    await mapConcurrent(notes, async entry => {
      const content = await this.adapter.read(entry.path);
      contents.set(entry.path, content);
      metadata.index(entry.path, content);
    });
    this.entries = entries;
    this.metadata = metadata;
    this.contents = contents;
  }

  initialize(): Promise<void> { return this.enqueue(async () => { await this.refresh(); await this.metadataProjection?.start(); this.emit('ready', { path: '' }); }); }
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
      const entry: VaultEntry = { path, type: 'file', entryId: current.entryId, revision: current.revision,
        ctime: current.stat.ctime, mtime: current.stat.mtime, size: current.stat.size };
      const entries = new Map(this.entries), contents = new Map(this.contents);
      entries.set(path, entry);
      if (isMarkdown(path)) contents.set(path, current.content);
      // Parse before publishing maps or dispatching events. indexBatch itself
      // parses every item before touching the existing metadata cache.
      if (!this.metadataProjection && isMarkdown(path)) this.metadata.indexBatch([[path, current.content]]);
      if (!this.metadataProjection) this.metadata.setFiles([...entries.values()].filter(item => item.type === 'file').map(item => item.path));
      this.entries = entries; this.contents = contents;
      if (this.metadataProjection) this.metadataChanged();
      if (!old) this.emit('create', { path, entry });
      else if (old.entryId !== entry.entryId || old.revision !== entry.revision || old.mtime !== entry.mtime || old.size !== entry.size
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
    if (this.metadataProjection && [...entries.values()].every(entry => entry.entryId && entry.revision)) {
      // Exact watcher notifications invalidate even unchanged stats. Active body
      // consumers reload lazily; unopened notes never incur semantic-only reads.
      for (const [path, entry] of entries) { this.contents.delete(path); this.entries.set(path, entry); }
      this.metadataChanged();
      for (const [path, entry] of entries) this.emit('modify', {path, entry});
      return true;
    }
    // Always read Markdown content: timestamps and byte lengths can remain unchanged.
    const contents = new Map(await mapConcurrent(paths.filter(path=>this.indexableMarkdown(this.adapter,entries.get(path)!)), async path =>
      [path, await this.adapter.read(path)] as const));
    const changes: VaultChange[] = [];
    for (const [path, entry] of entries) {
      const old = this.entries.get(path)!;
      // Exact attachment notifications invalidate viewers even when a replacement
      // preserves its stats. Duplicate binary events are preferable to stale media;
      // no-argument full scans still compare metadata without loading binary files.
      if (!isMarkdown(path) || old.entryId !== entry.entryId || old.revision !== entry.revision || old.mtime !== entry.mtime || old.size !== entry.size || this.contents.get(path) !== contents.get(path)) {
        changes.push({ path, entry });
      }
    }
    // No await or event dispatch may split publication of a batch. Parse first so a
    // failed read or parse leaves entries, contents and the metadata index unchanged.
    if (!this.metadataProjection) this.metadata.indexBatch([...contents].filter(([path, content]) => this.contents.get(path) !== content));
    for (const [path, entry] of entries) {
      if(isMarkdown(path)&&!contents.has(path)){this.contents.delete(path);this.metadata.remove(path);}
      this.entries.set(path, entry);
    }
    this.metadata.setFiles([...this.entries.values()].filter(entry=>entry.type==='file').map(entry=>entry.path));
    for (const [path, content] of contents) this.contents.set(path, content);
    if (this.metadataProjection) this.metadataChanged();
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
        else if (old.entryId !== entry.entryId || old.revision !== entry.revision || old.mtime !== entry.mtime || old.size !== entry.size || contents.get(path) !== this.contents.get(path)) this.emit('modify', { path, entry });
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

  private indexableMarkdown(adapter:VaultAdapter,entry:VaultEntry):boolean {
    return isMarkdown(entry.path)&&(!adapter.binaryStreams||Number.isSafeInteger(entry.size)&&entry.size>=0&&BigInt(entry.size)<=binaryLength(adapter.binaryStreams.limits.smallReadBytes));
  }

  private binaryBinding(): {adapter:VaultAdapter;streams:BinaryStreams;validate:()=>void} {
    const adapter=this.adapter,streams=adapter.binaryStreams;
    if(!streams)throw durableFailure('binary_streams_unavailable','This adapter has no binary stream capability');
    return {adapter,streams,validate:()=>{if(this.adapter!==adapter||adapter.binaryStreams!==streams)throw durableFailure('intent_identity_mismatch','Binary transfer belongs to a different adapter');}};
  }

  private async binaryIdentity(adapter:VaultAdapter,path:string):Promise<{entryId:string;expectedRevision:string}> {
    const entry=adapter.stat?await adapter.stat(path):(await adapter.list()).find(item=>normalizePath(item.path)===path);
    if(!entry||entry.type!=='file'||normalizePath(entry.path)!==path)throw durableFailure('not_found','Binary file does not exist');
    if(!entry.entryId||!entry.revision)throw durableFailure('binary_identity_unavailable','Adapter did not provide authoritative binary identity');
    return {entryId:entry.entryId,expectedRevision:entry.revision};
  }

  readBinaryStream(rawPath:string,sink:BinarySink,options:{validate?:()=>void;maxBytes?:string}={}):Promise<BinaryReadRef> {
    const binding=this.binaryBinding(),path=normalizePath(rawPath);
    const guard=options.validate,maxBytes=options.maxBytes;
    const output={write:sink.write.bind(sink),finish:sink.finish.bind(sink),abort:sink.abort.bind(sink)};
    const validate=()=>{binding.validate();guard?.();binding.validate();};
    const selected=this.enqueue(async()=>{validate();this.requireFile(path);const value=await this.binaryIdentity(binding.adapter,path);validate();return value;});
    // Preserve the original metadata selection while another transfer owns I/O.
    // The original promise is still awaited below; this only handles early rejection.
    void selected.catch(()=>undefined);
    return scheduleBinaryTransfer(binding.streams,async()=>{
      let identity:{entryId:string;expectedRevision:string};
      try{validate();identity=await selected;validate();}
      catch(error){try{await output.abort(error);}catch{}throw error;}
      return readBinarySink(binding.streams,identity,output,{maxBytes,validate});
    });
  }

  async readBinary(rawPath: string, validate?: () => void): Promise<Uint8Array> {
    const adapter=this.adapter,streams=adapter.binaryStreams;
    if(streams){
      const chunks:Uint8Array[]=[];let length=0,finished=false;
      await this.readBinaryStream(rawPath,{write:async bytes=>{chunks.push(bytes);length+=bytes.length;},finish:async()=>{finished=true;},abort:async()=>{chunks.length=0;length=0;}},{validate:()=>{if(this.adapter!==adapter||adapter.binaryStreams!==streams)throw durableFailure('intent_identity_mismatch','Binary adapter changed');validate?.();},maxBytes:streams.limits.smallReadBytes});
      if(!finished)throw durableFailure('binary_read_incomplete','Binary read did not finish');
      const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
    }
    await this.pending;validate?.();const path=normalizePath(rawPath);this.requireFile(path);
    if (!this.adapter.readBinary) throw new Error('Vault adapter does not support binary reads');
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  /** Publish only this written file; attachment bytes never go through Markdown decoding. */
  private async publishBinary(path: string, adapter=this.adapter, validate:()=>void=()=>{},expectedEntryId?:string): Promise<VaultEntry> {
    validate();const entry = adapter.stat
      ? await adapter.stat(path)
      : (await adapter.list()).find(item => normalizePath(item.path) === path);
    if (!entry || entry.type !== 'file' || normalizePath(entry.path) !== path) {
      throw new Error(`Written file is no longer available: ${path}`);
    }
    if(expectedEntryId!==undefined&&entry.entryId!==expectedEntryId)throw durableFailure('revision_conflict','Committed binary moved or was replaced before publication');
    validate();const content=!this.metadataProjection&&this.indexableMarkdown(adapter,entry)?await adapter.read(path):undefined;
    validate();if(expectedEntryId!==undefined&&this.entries.get(path)?.type==='folder'){
      for(const name of this.entries.keys())if(name.startsWith(path+'/')){this.entries.delete(name);this.contents.delete(name);this.metadata.remove(name);}
    }
    if(content===undefined&&isMarkdown(path)){this.contents.delete(path);this.metadata.remove(path);}
    if (content !== undefined) {
      this.metadata.index(path, content);
      this.contents.set(path, content);
    } else {
      this.metadata.setFiles([...this.entries.values()].filter(item => item.type === 'file').map(item => item.path).concat(path));
    }
    const updated = { ...entry, path };
    this.entries.set(path, updated);
    if (this.metadataProjection) this.metadataChanged();
    return updated;
  }

  private smallBinarySource(data:Uint8Array):BinarySource {
    const streams=this.adapter.binaryStreams;
    if(!streams||BigInt(data.byteLength)>binaryLength(streams.limits.smallReadBytes))throw durableFailure('stream_required','Use a binary source for this file size');
    // Preserve existing convenience API ownership: snapshot before any await.
    const snapshot=new Uint8Array(data);let offset=0;
    return {length:String(snapshot.length),read:async max=>{if(offset===snapshot.length)return null;const end=Math.min(snapshot.length,offset+max),bytes=snapshot.slice(offset,end);offset=end;return bytes;}};
  }

  private binaryPublicationFailure(error:unknown,committed:{ref:import('./binary-streams.ts').BinaryStageRef;receipt:string}):Error {
    return Object.assign(durableFailure('binary_publication_failed','Binary commit succeeded; publication must be reconciled without creating another operation'),{cause:error,binaryCommitted:Object.freeze({ref:Object.freeze({...committed.ref}),receipt:committed.receipt})});
  }

  createBinaryStream(rawPath:string,source:BinarySource,options:{validate?:()=>void}={}):Promise<VaultEntry> {
    const binding=this.binaryBinding(),path=normalizePath(rawPath),operationId=crypto.randomUUID(),entryId=crypto.randomUUID();
    const input={length:source.length,read:source.read.bind(source)},guard=options.validate;
    const validate=()=>{binding.validate();guard?.();binding.validate();};
    const ready=this.enqueue(async()=>{
      validate();const inventory=new Map<string,VaultEntry>();for(const item of await binding.adapter.list()){const name=normalizePath(item.path);if(inventory.has(name))throw new Error(`Adapter returned duplicate path: ${name}`);inventory.set(name,item);}validate();
      if(inventory.has(path))throw new Error(`Path already exists: ${path}`);
      const parent=parentPath(path);if(parent&&inventory.get(parent)?.type!=='folder')throw new Error(`Parent folder does not exist: ${parent}`);
      // Reconcile only required parents from this captured metadata inventory.
      // No async whole-vault refresh may mutate caches after adapter retirement.
      for(let name=parent;name;name=parentPath(name)){const folder=inventory.get(name);if(!folder||folder.type!=='folder')throw new Error(`Parent folder does not exist: ${name}`);this.contents.delete(name);this.metadata.remove(name);this.entries.set(name,{...folder,path:name});}
    });
    void ready.catch(()=>undefined);
    return scheduleBinaryTransfer(binding.streams,async()=>{
      await ready;validate();const committed=await writeBinarySource(binding.streams,{operationId,target:{kind:'create',entryId,path}},input,validate);
      try{return await this.enqueue(async()=>{validate();const entry=await this.publishBinary(path,binding.adapter,validate,entryId);validate();this.emit('create',{path,entry});return entry;});}
      catch(error){throw this.binaryPublicationFailure(error,committed);}
    });
  }

  modifyBinaryStream(rawPath:string,source:BinarySource,options:{validate?:()=>void}={}):Promise<void> {
    const binding=this.binaryBinding(),path=normalizePath(rawPath),operationId=crypto.randomUUID();
    const input={length:source.length,read:source.read.bind(source)},guard=options.validate;
    const validate=()=>{binding.validate();guard?.();binding.validate();};
    const selected=this.enqueue(async()=>{
      validate();this.requireFile(path);const value=await this.binaryIdentity(binding.adapter,path);validate();return value;
    });
    void selected.catch(()=>undefined);
    return scheduleBinaryTransfer(binding.streams,async()=>{
      const identity=await selected;validate();
      const pin=await binding.streams.openRead(identity);try{validate();if(pin.entryId!==identity.entryId||pin.entryRevision!==identity.expectedRevision||!pin.selectedContentEvent)throw durableFailure('invalid_binary_read','Pinned binary identity does not match');}finally{await binding.streams.closeRead(pin);}
      const captured={kind:'write' as const,...identity,expectedContentEvent:pin.selectedContentEvent};
      validate();const committed=await writeBinarySource(binding.streams,{operationId,target:captured},input,validate);
      try{await this.enqueue(async()=>{validate();const entry=await this.publishBinary(path,binding.adapter,validate,captured.entryId);validate();this.emit('modify',{path,entry});});}
      catch(error){throw this.binaryPublicationFailure(error,committed);}
    });
  }

  createBinary(rawPath: string, data: Uint8Array): Promise<VaultEntry> {
    if(this.adapter.binaryStreams)return this.createBinaryStream(rawPath,this.smallBinarySource(data));
    const bytes = new Uint8Array(data);
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      if (!this.adapter.createBinary) throw new Error('Vault adapter does not support explicit binary creation');
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
      await this.adapter.createBinary(path, bytes);
      const entry = await this.publishBinary(path);
      this.emit('create', { path, entry });
      return entry;
    });
  }

  modifyBinary(rawPath: string, data: Uint8Array, options: { validate?: () => void } = {}): Promise<void> {
    if(this.adapter.binaryStreams)return this.modifyBinaryStream(rawPath,this.smallBinarySource(data),options);
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

  create(rawPath: string, text = '', validate?: () => void): Promise<VaultEntry> {
    const adapter=this.adapter;
    return this.enqueue(async () => {
      const path = normalizePath(rawPath);
      await this.refresh();
      this.requireDestination(path);
      // Callers may admit a saved identity/owner only after the queued refresh.
      // Keep the final synchronous check adjacent to the durable dispatch.
      validate?.();
      if(this.adapter!==adapter)throw new Error('The vault adapter changed before file creation.');
      if (adapter.createText) await adapter.createText(path, text);
      else await adapter.write(path, text);
      await this.refresh();
      const entry = this.entries.get(path)!;
      this.emit('create', { path, entry });
      return entry;
    });
  }

  /** Explicit caller-retained creation, separate from unrelated one-shot creates.
   * An existing destination after an unacknowledged dispatch is not proof of
   * success. The void adapter API cannot establish its entry identity, so that
   * case requires host recovery rather than content matching or a second name.
   */
  createOperation(rawPath: string, text = '', validate?: () => void): VaultCreateOperation {
    const path = normalizePath(rawPath), adapter = this.adapter;
    let status: VaultCreateOperation['status'] = 'ready', inFlight: Promise<VaultEntry> | undefined;
    let dispatched = false, acknowledged = false, published: VaultEntry | undefined;
    const owner = this;
    const check = () => { validate?.(); if (owner.adapter !== adapter) throw new Error('The vault adapter changed before file creation.'); };
    return Object.freeze({ path, text, get status() { return status; }, run() {
      if (inFlight) return inFlight;
      if (published) { try { check(); return Promise.resolve(published); } catch (error) { return Promise.reject(error); } }
      const result = owner.enqueue(async () => {
        check(); status = 'creating';
        try {
          if (acknowledged) throw durableFailure('create_reconciliation_required', 'Creation was acknowledged but its original file identity could not be published. Recover the original operation before retrying; an existing replacement must not be adopted.');
          await owner.refresh(); check();
          if (!acknowledged) {
            if (dispatched && owner.entries.has(path)) throw durableFailure('create_reconciliation_required', 'Creation may already have committed. Recover its original operation before retrying; the existing file was not adopted or overwritten.');
            owner.requireDestination(path);
            check(); dispatched = true;
            if (adapter.createText) await adapter.createText(path, text); else await adapter.write(path, text);
            acknowledged = true;
          }
          await owner.refresh(); check();
          const entry = owner.entries.get(path);
          if (!entry || entry.type !== 'file') throw durableFailure('created_file_unavailable', 'The created file is no longer available; retry will not recreate it.');
          published = Object.freeze({ ...entry }); status = 'committed';
          owner.emit('create', { path, entry: published });
          return published;
        } catch (error) { status = dispatched ? 'uncertain' : 'ready'; throw error; }
      });
      const tracked = result.finally(() => { if (inFlight === tracked) inFlight = undefined; });
      inFlight = tracked; return tracked;
    } });
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
        if (!this.metadataProjection) this.metadata.index(path, content);
        this.contents.set(path, content);
      }
      const updated = { ...entry, path };
      this.entries.set(path, updated);
      if (this.metadataProjection) this.metadataChanged();
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
  rename(rawOld: string, rawNew: string, validate?: () => void, expectedIdentity?: Readonly<{ entryId: string; revision: string }>): Promise<void> {
    return this.renameInternal(rawOld, rawNew, true, validate, expectedIdentity && Object.freeze({ ...expectedIdentity }));
  }

  private renameInternal(rawOld: string, rawNew: string, updateLinks: boolean, validate?: () => void, expectedIdentity?: Readonly<{ entryId: string; revision: string }>): Promise<void> {
    return this.enqueue(async () => {
      validate?.();
      const oldPath = normalizePath(rawOld), newPath = normalizePath(rawNew);
      await this.refresh();
      const observed = this.entries.get(oldPath);
      if (expectedIdentity && (typeof expectedIdentity.entryId !== 'string' || !expectedIdentity.entryId || typeof expectedIdentity.revision !== 'string' || !expectedIdentity.revision)) {
        throw durableFailure('revision_conflict', 'Saved rename identity is incomplete');
      }
      if (expectedIdentity && (!observed || observed.entryId !== expectedIdentity.entryId || observed.revision !== expectedIdentity.revision)) {
        throw durableFailure('revision_conflict', 'The saved file changed before rename');
      }
      if (!observed) throw new Error(`Path does not exist: ${oldPath}`);
      if (oldPath === newPath) return;
      this.requireDestination(newPath);
      if (newPath.startsWith(`${oldPath}/`)) throw new Error('Cannot move a folder inside itself');
      const moved = (path: string): string => path === oldPath || path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
      const changes: { old: string; path: string; before: string; after: string }[] = [];
      // Link rewrites need fresh source spans, not historical frame facts. This
      // temporary mutation-local parser is deliberately separate from metadata
      // publication. All existing post-move identity/read/CAS fences remain.
      let renameMetadata = this.metadata, renameContents = this.contents;
      if (updateLinks && this.metadataProjection) {
        renameMetadata = new MetadataCache(); renameContents = new Map();
        renameMetadata.setFiles(this.filePaths());
        const candidates = [...this.entries.values()].filter(entry => entry.type === 'file' && this.indexableMarkdown(this.adapter, entry));
        for (const [path, content] of await mapConcurrent(candidates, async entry => [entry.path, await this.adapter.read(entry.path)] as const)) {
          renameContents.set(path, content); renameMetadata.index(path, content);
        }
      }
      for (const [source, note] of updateLinks ? renameMetadata.entries() : []) {
        const before = renameContents.get(source)!;
        let after = before;
        const newSource = moved(source);
        for (const link of [...note.links].reverse()) {
          const target = renameMetadata.resolveLink(source, link.target, link.kind);
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
      const rename: (oldPath: string, newPath: string, expected?: Readonly<{ entryId: string; revision: string }>) => Promise<void> = this.adapter.rename.bind(this.adapter);
      await rename(oldPath, newPath, expectedIdentity);
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
