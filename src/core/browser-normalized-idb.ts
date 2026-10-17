import { BrowserVaultError } from './browser-vault.ts';

/** Additive local persistence plumbing. No opener, migration, graph planner, proof or GC. */
export const browserNormalizedKeyPaths = {
  sync_source_headers: ['realmId', 'vaultId', 'updateId'],
  sync_source_payloads: ['realmId', 'vaultId', 'updateId'],
  sync_source_wires: ['realmId', 'vaultId', 'updateId'],
  sync_graph_records: ['realmId', 'vaultId', 'updateId'],
  sync_graph_activities: ['realmId', 'vaultId', 'updateId'],
  binary_stages: ['clientId', 'stageId'],
  binary_stage_chunks: ['clientId', 'stageId', 'sequenceOrder'],
  binary_reads: ['clientId', 'readId'],
  sync_materialization_refs: 'id',
  sync_publication_refs: ['id', 'revision'],
} as const;
export type NormalizedStore = keyof typeof browserNormalizedKeyPaths;
export type MetadataStore = Exclude<NormalizedStore, 'sync_source_payloads' | 'sync_source_wires'>;
export type MutableMetadataStore = 'binary_stages' | 'binary_reads' | 'sync_materialization_refs';
export const browserNormalizedStores = Object.freeze(Object.keys(browserNormalizedKeyPaths) as NormalizedStore[]);
export const normalizedLimits = Object.freeze({ payload: 1024 * 1024, wire: 1052720, metadataRow: 128 * 1024, metadataPage: 1024 * 1024, pageItems: 1000 });
export type MetadataValue = null | boolean | number | string | MetadataValue[] | { [key: string]: MetadataValue };
export interface SourceKey { realmId: string; vaultId: string; updateId: string }
export interface SourceHeader extends SourceKey { descriptor: MetadataValue }
export interface SourceInput { header: SourceHeader; payload?: Uint8Array; wire?: Uint8Array }
export type SourceBody = 'payload' | 'wire';
export interface SourceRead { header: SourceHeader; bytes: Uint8Array }
export type Abort = (error: unknown) => void;
const failure = (code: string) => new BrowserVaultError(code, 'Normalized browser storage rejected an unavailable or inconsistent record');
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const maximum = (1n << 64n) - 1n;
export function decimalU64(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > maximum) throw failure('invalid_decimal_u64');
  return value;
}
export function decimalOrder(value: unknown): string { return decimalU64(value).padStart(20, '0'); }
export function nextDecimalU64(value: unknown): string {
  const number = BigInt(decimalU64(value));
  if (number === maximum) throw failure('sequence_exhausted');
  return String(number + 1n);
}
/** Only call in the parent's fresh-format upgrade transaction. Never adopts old stores. */
export function createBrowserNormalizedSchema(db: IDBDatabase): void {
  if (browserNormalizedStores.some(name => db.objectStoreNames.contains(name))) throw failure('storage_schema_mismatch');
  for (const name of browserNormalizedStores) {
    const keyPath = browserNormalizedKeyPaths[name];
    const store = db.createObjectStore(name, { keyPath: typeof keyPath === 'string' ? keyPath : [...keyPath] });
    if (name === 'binary_stages') store.createIndex('by_operation', ['clientId', 'operationId'], { unique: true });
  }
}
const guards = new WeakMap<IDBTransaction, () => void>();
function guard(tx: IDBTransaction): void { guards.get(tx)?.(); }
function on<T>(tx: IDBTransaction, request: IDBRequest<T>, callback: (value: T) => void, abort: Abort): void {
  request.onsuccess = () => { try { guard(tx); callback(request.result); } catch (error) { abort(error); } };
}
export interface NormalizedTransactionOptions {
  authorityId: string;
  stores: readonly string[];
  mode: IDBTransactionMode;
  /** Worker-owned lease/admission/session guard; explicitly supplied by the host. */
  assertActive(): void;
}
/** No transaction spans an await. All requested writes and the authority check share one tx.
 * Start/helpers report a candidate result; only oncomplete resolves it. The parent owns
 * exact graph/source/CAS checks and must include every related store in this same tx.
 */
export function normalizedTransact<T>(db: IDBDatabase, options: NormalizedTransactionOptions,
  start: (tx: IDBTransaction, done: (value: T) => void, abort: Abort) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      if (!options || typeof options.authorityId !== 'string' || !options.authorityId || !Array.isArray(options.stores) ||
        !options.stores.length || !['readonly', 'readwrite'].includes(options.mode) || typeof options.assertActive !== 'function') throw failure('invalid_storage_transaction');
      options.assertActive();
      tx = db.transaction([...new Set(['control', ...options.stores])], options.mode, options.mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (error) { reject(error); return; }
    let value: T, reported = false, cause: unknown;
    const abort: Abort = error => { cause ??= error; try { tx.abort(); } catch { /* Terminal tx event settles the result. */ } };
    guards.set(tx, options.assertActive);
    tx.onabort = () => { guards.delete(tx); reject(cause ?? failure('storage_failure')); };
    tx.onerror = () => { /* Request errors abort normally; never resolve early. */ };
    tx.oncomplete = () => { guards.delete(tx); if (reported) resolve(value); else reject(failure('storage_protocol_error')); };
    if (options.mode === 'readwrite' && tx.durability !== 'strict') { abort(failure('strict_durability_unavailable')); return; }
    try {
      on(tx, tx.objectStore('control').get('local-store-id'), row => {
        if (row?.value !== options.authorityId) throw failure('storage_authority_mismatch');
        const returned: unknown = start(tx, result => { guard(tx); value = result; reported = true; }, abort);
        if (returned && typeof (returned as { then?: unknown }).then === 'function') throw failure('async_storage_callback');
      }, abort);
    } catch (error) { abort(error); }
  });
}
function metadata(value: unknown, maxBytes = normalizedLimits.metadataRow): { value: MetadataValue; encoded: string; bytes: number } {
  let nodes = 0, characters = 0;
  const text = (value: string) => { characters += value.length; if (characters > maxBytes) throw failure('storage_metadata_too_large'); return value; };
  const visit = (item: unknown, depth: number): MetadataValue => {
    if (++nodes > 65536 || depth > 64) throw failure('invalid_storage_metadata');
    if (typeof item === 'string') return text(item);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw failure('invalid_storage_metadata');
      return Array.from({ length: item.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property || !own(property, 'value')) throw failure('invalid_storage_metadata');
        return visit(property.value, depth + 1);
      });
    }
    if (typeof item !== 'object' || !item || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw failure('invalid_storage_metadata');
    const copy: { [key: string]: MetadataValue } = {};
    for (const key of Object.keys(item).sort()) {
      text(key);
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !own(property, 'value')) throw failure('invalid_storage_metadata');
      Object.defineProperty(copy, key, { value: visit(property.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  };
  const copy = visit(value, 0), encoded = JSON.stringify(copy), bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > maxBytes) throw failure('storage_metadata_too_large');
  return { value: copy, encoded, bytes };
}
function sourceKey(value: SourceKey): string[] {
  if (!value || ![value.realmId, value.vaultId, value.updateId].every(part => typeof part === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(part))) throw failure('invalid_source_identity');
  return [value.realmId, value.vaultId, value.updateId];
}
function header(value: unknown): SourceHeader {
  const copy = metadata(value).value as unknown as SourceHeader;
  if (!copy || Object.keys(copy).sort().join(',') !== 'descriptor,realmId,updateId,vaultId') throw failure('invalid_source_header');
  sourceKey(copy); return copy;
}
function bytes(value: unknown, kind: SourceBody): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > normalizedLimits[kind]) throw failure('source_body_too_large');
  return value.slice();
}
const bodyStore = (kind: SourceBody) => kind === 'payload' ? 'sync_source_payloads' : 'sync_source_wires';
function bodyRow(value: unknown, expected: string[], kind: SourceBody): Uint8Array {
  const row = value as SourceKey & { bytes: Uint8Array };
  if (!row || Object.keys(row).sort().join(',') !== 'bytes,realmId,updateId,vaultId' || JSON.stringify(sourceKey(row)) !== JSON.stringify(expected)) throw failure('storage_corrupt');
  return bytes(row.bytes, kind);
}
const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, index) => value === right[index]);
/** Immutable source identity, independently addable exact payload/wire bodies. This does
 * not authorize publication. verifyBinding is trusted synchronous WASM-backed host work,
 * mandatory even on retries; a header/digest alone is never a verification capability.
 */
export function addImmutableSource(tx: IDBTransaction, input: SourceInput,
  verifyBinding: (source: SourceInput) => void, done: (inserted: boolean) => void, abort: Abort): void {
  try {
    guard(tx);
    const candidate: SourceInput = { header: header(input?.header) };
    const kinds = (['payload', 'wire'] as const).filter(kind => input[kind] !== undefined);
    if (!kinds.length || typeof verifyBinding !== 'function') throw failure('invalid_source_input');
    for (const kind of kinds) candidate[kind] = bytes(input[kind], kind);
    const key = sourceKey(candidate.header), reads = new Map<string, unknown>();
    let remaining = 3;
    const loaded = () => {
      if (--remaining) return;
      const previous = reads.get('header');
      if (previous !== undefined && metadata(header(previous)).encoded !== metadata(candidate.header).encoded) throw failure('immutable_source_conflict');
      for (const kind of ['payload', 'wire'] as const) {
        const previousBody = reads.get(kind);
        if (previousBody !== undefined) {
          if (previous === undefined) throw failure('storage_corrupt');
          const retained = bodyRow(previousBody, key, kind);
          if (candidate[kind] !== undefined && !sameBytes(retained, candidate[kind]!)) throw failure('immutable_source_conflict');
          candidate[kind] ??= retained;
        }
      }
      const verificationInput = structuredClone(candidate);
      const verified: unknown = verifyBinding(verificationInput);
      if (verified && typeof (verified as { then?: unknown }).then === 'function') throw failure('async_storage_callback');
      guard(tx);
      let inserted = previous === undefined;
      if (previous === undefined) tx.objectStore('sync_source_headers').add(candidate.header);
      for (const kind of kinds) if (reads.get(kind) === undefined) {
        inserted = true;
        tx.objectStore(bodyStore(kind)).add({ realmId: key[0], vaultId: key[1], updateId: key[2], bytes: candidate[kind] });
      }
      done(inserted);
    };
    on(tx, tx.objectStore('sync_source_headers').get(key), row => { reads.set('header', row); loaded(); }, abort);
    for (const kind of ['payload', 'wire'] as const) on(tx, tx.objectStore(bodyStore(kind)).get(key), row => { reads.set(kind, row); loaded(); }, abort);
  } catch (error) { abort(error); }
}
/** One exact indexed body lookup; never scans byte-bearing stores. Missing body under an
 * existing descriptor is an explicit error for the host, never a fabricated empty file.
 */
export function getExactSource(tx: IDBTransaction, identity: SourceKey, kind: SourceBody,
  done: (source: SourceRead | null) => void, abort: Abort): void {
  try {
    const key = sourceKey(identity);
    if (kind !== 'payload' && kind !== 'wire') throw failure('invalid_source_input');
    const first = tx.objectStore('sync_source_headers').get(key);
    on(tx, first, value => {
      const descriptor = value === undefined ? null : header(value);
      if (descriptor && JSON.stringify(sourceKey(descriptor)) !== JSON.stringify(key)) throw failure('storage_corrupt');
      on(tx, tx.objectStore(bodyStore(kind)).get(key), row => {
        if (!descriptor) { if (row !== undefined) throw failure('storage_corrupt'); done(null); return; }
        if (row === undefined) throw failure('source_body_missing');
        done({ header: descriptor, bytes: bodyRow(row, key, kind) });
      }, abort);
    }, abort);
  } catch (error) { abort(error); }
}
function metadataKey(store: MetadataStore, row: MetadataValue): IDBValidKey {
  const fields = browserNormalizedKeyPaths[store], value = row as Record<string, MetadataValue>;
  const paths = typeof fields === 'string' ? [fields] : fields;
  if (!value || Array.isArray(value) || typeof value !== 'object' || paths.some(path => typeof value[path] !== 'string' || !value[path])) throw failure('invalid_storage_metadata');
  if (store === 'sync_source_headers') header(row);
  if (store === 'binary_stage_chunks') {
    const sequence = value.sequenceOrder as string;
    if (!/^[0-9]{20}$/.test(sequence) || decimalOrder(BigInt(sequence).toString()) !== sequence) throw failure('invalid_decimal_u64');
  }
  if (store === 'binary_stages' && (typeof value.operationId !== 'string' || !value.operationId)) throw failure('invalid_storage_metadata');
  return typeof fields === 'string' ? value[fields] as string : fields.map(field => value[field] as string);
}
function checkMetadataStore(store: MetadataStore): void {
  if (!own(browserNormalizedKeyPaths, store) || store === ('sync_source_payloads' as MetadataStore) || store === ('sync_source_wires' as MetadataStore)) throw failure('invalid_metadata_store');
}
export function putNormalizedMetadata(tx: IDBTransaction, store: MutableMetadataStore,
  row: MetadataValue, done: () => void, abort: Abort): void {
  try {
    guard(tx); checkMetadataStore(store);
    if (!['binary_stages', 'binary_reads', 'sync_materialization_refs'].includes(store)) throw failure('invalid_metadata_store');
    const copy = metadata(row).value; metadataKey(store, copy);
    on(tx, tx.objectStore(store).put(copy), () => done(), abort);
  } catch (error) { abort(error); }
}
export function addImmutableMetadata(tx: IDBTransaction, store: Exclude<MetadataStore, 'sync_source_headers'>,
  row: MetadataValue, done: (inserted: boolean) => void, abort: Abort): void {
  try {
    guard(tx); checkMetadataStore(store);
    if (store === ('sync_source_headers' as MetadataStore)) throw failure('invalid_metadata_store');
    const copy = metadata(row), key = metadataKey(store, copy.value);
    on(tx, tx.objectStore(store).get(key), previous => {
      if (previous !== undefined) {
        if (metadata(previous).encoded !== copy.encoded) throw failure('immutable_metadata_conflict');
        done(false); return;
      }
      on(tx, tx.objectStore(store).add(copy.value), () => done(true), abort);
    }, abort);
  } catch (error) { abort(error); }
}
export interface MetadataPageOptions { range?: IDBKeyRange; direction?: 'next' | 'prev'; limit: number; maxBytes: number }
export interface MetadataPage { items: MetadataValue[]; lastKey: IDBValidKey | null; complete: boolean; bytes: number }
/** Resume an incomplete page with a caller-scoped exclusive bound at lastKey. */
export function boundedMetadataPage(tx: IDBTransaction, store: MetadataStore, options: MetadataPageOptions,
  done: (page: MetadataPage) => void, abort: Abort): void {
  try {
    guard(tx); checkMetadataStore(store);
    if (!options || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > normalizedLimits.pageItems ||
      !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > normalizedLimits.metadataPage ||
      (options.direction !== undefined && options.direction !== 'next' && options.direction !== 'prev')) throw failure('invalid_metadata_page');
    const page: MetadataPage = { items: [], lastKey: null, complete: false, bytes: 0 };
    const cursor = tx.objectStore(store).openCursor(options.range, options.direction);
    on(tx, cursor, row => {
      if (!row) { page.complete = true; done(page); return; }
      const item = metadata(row.value); metadataKey(store, item.value);
      if (page.items.length === options.limit || page.bytes + item.bytes > options.maxBytes) {
        if (!page.items.length) throw failure('storage_metadata_page_too_small');
        done(page); return;
      }
      page.items.push(item.value); page.lastKey = structuredClone(row.primaryKey); page.bytes += item.bytes;
      row.continue();
    }, abort);
  } catch (error) { abort(error); }
}
