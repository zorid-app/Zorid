/** Browser persistence host for the initialized, shared Rust/WASM vault planner.
 * No production platform selection uses this adapter yet. */
export interface BrowserVaultWasm {
  planMutation(input: string): string;
  checkIdempotency(input: string): string;
  validateSnapshot(input: string): void;
}

export class BrowserVaultError extends Error {
  readonly code: string; readonly details: unknown; readonly source: 'host' | 'rust';
  constructor(code: string, message: string, details: unknown = undefined, source: 'host' | 'rust' = 'host') {
    super(message); this.name = 'BrowserVaultError'; this.code = code; this.details = details; this.source = source;
  }
}

export interface BrowserVaultOptions {
  name: string;
  /** Must already be initialized; these calls must be synchronous. */
  wasm: BrowserVaultWasm;
  /** Host display clock only; never used as a revision or ordering token. */
  now?: () => number;
  /** Trusted fixture injection only. Never populate this from mutation JSON. */
  testHooks?: { afterMetadataWrite?(abort: () => void): void; afterCommitRequested?(): void };
}

export interface BrowserVault {
  /** Persistent local storage authority; distinct from database name or sync vault ID. */
  readonly authorityId: string;
  /** Serialized Rust MutationRequest in; serialized original CommitResult out. */
  mutate(requestJson: string): Promise<string>;
  /** Transaction-consistent {entries, sequence}; includes retained tombstones. */
  snapshot(): Promise<string>;
  /** Retained bytes by stable ID, including tombstones; returns a fresh copy. */
  readBytes(id: string): Promise<Uint8Array>;
  readEntry(path: string): Promise<BrowserVaultRead | null>;
  inventory(): Promise<BrowserVaultRead[]>;
  prepareIntent(clientId: string, intentId: string, requestJson: string): Promise<void>;
  intents(clientId: string): Promise<BrowserVaultIntent[]>;
  executeIntent(clientId: string, intentId: string): Promise<string>;
  acknowledgeIntent(clientId: string, intentId: string, outcome: BrowserVaultOutcome): Promise<void>;
  changesSince(sequence: string): Promise<{sequence: string; paths?: string[]}>;
  close(): void;
}

export interface BrowserVaultPresentation { id: string; ctime_ms: number; mtime_ms: number; size_bytes: number }
export interface BrowserVaultRead { entry: EntryState; presentation: BrowserVaultPresentation; bytes?: Uint8Array }
export interface BrowserVaultIntent {
  client_id: string; intent_id: string; operation_id: string; request_json: string;
  order: string;
  acknowledged: boolean;
  status: 'prepared' | 'commit_requested' | 'committed' | 'rejected'; receipt?: string;
  error?: { code: string; message: string; details?: unknown; source: 'host' | 'rust' };
}
export type BrowserVaultOutcome = {status:'committed';receipt:string} | {status:'rejected';error:NonNullable<BrowserVaultIntent['error']>};

// Wire shapes are data plumbing only. All mutation/path/replay rules run in Rust.
export interface EntryState { id: string; path: string; kind: 'file' | 'folder'; revision: string; deleted: boolean }
interface EntryChange { before: EntryState | null; after: EntryState }
interface Request { operation_id: string; mutation: { type: string; id: string; content?: number[] | null } }
interface Receipt { operation_id: string; sequence: string; changes: EntryChange[] }
interface RecordValue { request: Request; result: Receipt }
type Decision = { status: 'new' } | { status: 'replay'; result: Receipt };
const stores = ['metadata', 'content', 'receipts', 'journal', 'outbox', 'control', 'presentation', 'intents'];
const keyPaths: Record<string, string | string[]> = { metadata: 'id', content: 'id', receipts: 'operation_id', journal: 'sequence', outbox: 'sequence', control: 'key', presentation: 'id', intents: ['client_id', 'intent_id'] };
const maxSequence = 18446744073709551615n;

function hostError(code: string, message: string, details?: unknown): BrowserVaultError {
  return new BrowserVaultError(code, message, details);
}
function storageError(error: unknown): BrowserVaultError {
  if (error instanceof BrowserVaultError) return error;
  const name = error instanceof Error || error instanceof DOMException ? error.name : 'UnknownError';
  return hostError(name === 'QuotaExceededError' ? 'storage_quota_exceeded' : 'storage_failure',
    error instanceof Error ? error.message : String(error), { name });
}
function rustCall<T>(call: () => string): T {
  let json: string;
  try { json = call(); }
  catch (error) {
    const message = String(error);
    try {
      const details = JSON.parse(message) as { code?: unknown };
      if (typeof details.code === 'string') throw new BrowserVaultError(details.code, message, details, 'rust');
    } catch (decoded) { if (decoded instanceof BrowserVaultError) throw decoded; }
    throw new BrowserVaultError('rust_input_rejected', message, undefined, 'rust');
  }
  try { return JSON.parse(json) as T; }
  catch { throw hostError('invalid_wasm_result', 'Initialized Rust binding returned invalid JSON'); }
}
function currentSequence(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw hostError('storage_corrupt', 'Invalid stored commit sequence');
  }
  const sequence = BigInt(value);
  if (sequence > maxSequence) throw hostError('storage_corrupt', 'Stored commit sequence exceeds u64');
  return sequence;
}

function validateSchema(db: IDBDatabase): void {
  if (JSON.stringify(Array.from(db.objectStoreNames).sort()) !== JSON.stringify([...stores].sort())) {
    throw hostError('storage_schema_mismatch', 'Unexpected browser vault object stores');
  }
  const tx = db.transaction(stores, 'readonly');
  for (const name of stores) {
    const store = tx.objectStore(name);
    const indexes = Array.from(store.indexNames);
    if (JSON.stringify(store.keyPath) !== JSON.stringify(keyPaths[name]) || store.autoIncrement ||
        JSON.stringify(indexes) !== JSON.stringify(name === 'intents' ? ['by_operation'] : [])) {
      throw hostError('storage_schema_mismatch', `Unexpected schema for ${name}`);
    }
    if (name === 'intents') {
      const index = store.index('by_operation');
      if (index.keyPath !== 'operation_id' || !index.unique || index.multiEntry) throw hostError('storage_schema_mismatch', 'Invalid global operation ownership index');
    }
  }
}

/** Storage representation/integrity checks, not path or mutation rules. */
function validateContent(entries: EntryState[], contents: { id: string; bytes: Uint8Array }[]): void {
  const byId = new Map(contents.map(row => [row?.id, row]));
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.path !== 'string' ||
        typeof entry.revision !== 'string' || typeof entry.deleted !== 'boolean' ||
        (entry.kind !== 'file' && entry.kind !== 'folder')) {
      throw hostError('storage_corrupt', 'Stored metadata has invalid field types');
    }
    const content = byId.get(entry.id);
    if (entry.kind === 'file' ? !(content?.bytes instanceof Uint8Array) : content !== undefined) {
      throw hostError('storage_corrupt', 'Metadata and retained byte content disagree', { id: entry.id });
    }
    byId.delete(entry.id);
  }
  if (byId.size) throw hostError('storage_corrupt', 'Orphaned byte content has no metadata');
}

function validatePresentation(entries: EntryState[], contents: { id: string; bytes: Uint8Array }[], rows: BrowserVaultPresentation[]): void {
  validateContent(entries, contents);
  const byId = new Map(rows.map(row => [row?.id, row]));
  const bytes = new Map(contents.map(row => [row.id, row.bytes.byteLength]));
  for (const entry of entries) {
    const row = byId.get(entry.id);
    if (!row || ![row.ctime_ms, row.mtime_ms, row.size_bytes].every(value => Number.isSafeInteger(value) && value >= 0) ||
        row.size_bytes !== (bytes.get(entry.id) ?? 0)) throw hostError('storage_corrupt', 'Invalid stored presentation metadata', { id: entry.id });
    byId.delete(entry.id);
  }
  if (byId.size) throw hostError('storage_corrupt', 'Orphaned presentation metadata');
}
function intentKey(clientId: string, intentId: string): string[] {
  if (![clientId, intentId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw hostError('invalid_intent_identity', 'Client and intent identities must be bounded opaque identifiers');
  }
  return [clientId, intentId];
}

export async function openBrowserVault(options: BrowserVaultOptions): Promise<BrowserVault> {
  const { name, wasm, testHooks, now = Date.now } = options;
  if (!name.startsWith('zorid-core-vault:') || name.length > 240) {
    throw hostError('invalid_database_name', 'Use a named zorid-core-vault: database');
  }
  if (typeof wasm?.planMutation !== 'function' || typeof wasm?.checkIdempotency !== 'function' || typeof wasm?.validateSnapshot !== 'function') {
    throw hostError('invalid_wasm_bindings', 'Initialized synchronous Rust bindings are required');
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let rejected = false;
    const opening = indexedDB.open(name, 4);
    let schemaError: BrowserVaultError | undefined;
    opening.onupgradeneeded = event => {
      if (event.oldVersion !== 0) {
        schemaError = hostError('storage_schema_mismatch', 'Existing vault requires an explicit verified migration; original database retained');
        opening.transaction!.abort(); return;
      }
      const database = opening.result;
      database.createObjectStore('metadata', { keyPath: 'id' });
      database.createObjectStore('content', { keyPath: 'id' });
      database.createObjectStore('receipts', { keyPath: 'operation_id' });
      database.createObjectStore('journal', { keyPath: 'sequence' });
      database.createObjectStore('outbox', { keyPath: 'sequence' });
      const control = database.createObjectStore('control', { keyPath: 'key' });
      control.add({ key: 'sequence', value: '0' });
      control.add({ key: 'intent-sequence', value: '0' });
      control.add({ key: 'local-store-id', value: crypto.randomUUID() });
      database.createObjectStore('presentation', { keyPath: 'id' });
      database.createObjectStore('intents', { keyPath: ['client_id', 'intent_id'] }).createIndex('by_operation','operation_id',{unique:true});
    };
    opening.onerror = () => reject(schemaError ?? storageError(opening.error));
    opening.onblocked = () => {
      rejected = true;
      reject(hostError('storage_blocked', 'Another connection is blocking this database version'));
    };
    opening.onsuccess = () => {
      if (rejected) opening.result.close();
      else {
        try { validateSchema(opening.result); resolve(opening.result); }
        catch (error) { opening.result.close(); reject(error); }
      }
    };
  }).catch(error => { throw storageError(error); });
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };
  const validateDomain = (entries: EntryState[]) => {
    try { wasm.validateSnapshot(JSON.stringify(entries)); }
    catch (error) { throw hostError('storage_corrupt', 'Persisted metadata failed shared Rust snapshot validation', {reason:String(error)}); }
  };

  function transact<T>(mode: IDBTransactionMode,
    start: (tx: IDBTransaction, result: (value: T) => void, abort: (error: unknown) => void) => void): Promise<T> {
    if (closed) return Promise.reject(hostError('storage_closed', 'Browser vault is closed'));
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
      catch (error) { reject(storageError(error)); return; }
      let value: T, hasResult = false, rejected: BrowserVaultError | undefined;
      const abort = (error: unknown) => {
        rejected ??= storageError(error);
        try { tx.abort(); } catch { /* Already aborting: onabort still owns settlement. */ }
      };
      tx.onabort = () => reject(rejected ?? storageError(tx.error ?? new Error('Transaction aborted')));
      tx.onerror = () => { /* Request failures abort by default; no early success. */ };
      tx.oncomplete = () => {
        if (hasResult) resolve(value);
        else reject(hostError('storage_protocol_error', 'Transaction completed without a result'));
      };
      if (mode === 'readwrite' && tx.durability !== 'strict') {
        abort(hostError('strict_durability_unavailable', 'Browser did not honor strict durability'));
        return;
      }
      try { start(tx, result => { value = result; hasResult = true; }, abort); }
      catch (error) { abort(error); }
    });
  }

  const authorityId = await transact<string>('readonly', (tx, done, abort) => {
    const read = tx.objectStore('control').get('local-store-id');
    read.onsuccess = () => {
      const value = read.result?.value;
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        abort(hostError('storage_corrupt','Missing or invalid persistent local storage authority')); return;
      }
      done(value);
    };
  }).catch(error => { close(); throw error; });

  const mutate = async (requestJson: string, tracked?: BrowserVaultIntent): Promise<string> => {
      let request: Request;
      if (typeof requestJson !== 'string') throw hostError('invalid_request_json', 'Mutation request must be serialized JSON');
      try { request = JSON.parse(requestJson) as Request; }
      catch { throw hostError('invalid_request_json', 'Mutation request must be serialized JSON'); }
      // Immutable string input was parsed into a private snapshot. Rust validates
      // the original JSON before the ID is used as an IDB key, including duplicate
      // fields that JSON.parse would normalize away. No TS domain validator.
      rustCall<Decision>(() => wasm.checkIdempotency(`{"request":${requestJson},"record":null}`));
      return transact<string>('readwrite', (tx, done, abort) => {
        const receipts = tx.objectStore('receipts');
        const lookup = receipts.get(request.operation_id);
        const ownerLookup = tx.objectStore('intents').index('by_operation').get(request.operation_id);
        const trackedLookup = tracked ? tx.objectStore('intents').get(intentKey(tracked.client_id, tracked.intent_id)) : undefined;
        let lookedUp = tracked ? 3 : 2;
        const processLookup = () => {
          if (--lookedUp) return;
          try {
            const owner = ownerLookup.result as BrowserVaultIntent | undefined;
            if (owner && (!tracked || owner.client_id !== tracked.client_id || owner.intent_id !== tracked.intent_id)) {
              throw hostError('intent_operation_owned', 'Operation ID belongs to a prepared intent; use its exact owner token');
            }
            if (tracked) {
              if (!owner) throw hostError('storage_corrupt', 'Prepared intent lost its operation ownership fence');
              const stored = trackedLookup!.result as BrowserVaultIntent | undefined;
              if (!stored || stored.request_json !== requestJson) throw hostError('storage_corrupt', 'Prepared intent was lost or changed');
              if (stored.status === 'rejected') throw new BrowserVaultError(stored.error!.code, stored.error!.message, stored.error!.details, stored.error!.source);
              if (stored.status === 'committed' && lookup.result === undefined) throw hostError('storage_corrupt', 'Committed intent has no operation receipt');
              if (!['commit_requested', 'committed'].includes(stored.status)) throw hostError('intent_not_authorized', 'Prepared intent has no durable commit authorization');
            }
            if (lookup.result !== undefined && (!lookup.result || !Object.hasOwn(lookup.result, 'record') || lookup.result.record == null)) {
              throw hostError('storage_corrupt', 'Stored receipt envelope is missing its Rust operation record');
            }
            let decision: Decision;
            try {
              decision = rustCall<Decision>(() => wasm.checkIdempotency(JSON.stringify({
                request, record: lookup.result === undefined ? null : lookup.result.record,
              })));
            } catch (error) {
              // A settled intent is verifying an existing receipt, never issuing
              // a new command that could receive a semantic rejection.
              if (trackedLookup?.result?.status === 'committed') throw hostError('storage_corrupt', 'Committed intent failed Rust receipt validation');
              throw error;
            }
            if (trackedLookup?.result?.status === 'committed' &&
                (decision.status !== 'replay' || trackedLookup.result.receipt !== JSON.stringify(decision.result))) {
              throw hostError('storage_corrupt', 'Intent receipt disagrees with committed Rust operation record');
            }
            const commitIntent = (receipt: string) => {
              if (tracked) tx.objectStore('intents').put({ ...trackedLookup!.result, status: 'committed', receipt });
            };
            if (decision.status === 'replay') {
              const receipt = JSON.stringify(decision.result); commitIntent(receipt); done(receipt); return;
            }
            const metadata = tx.objectStore('metadata');
            const all = metadata.getAll();
            const contents = tx.objectStore('content').getAll();
            const presentation = tx.objectStore('presentation').getAll();
            const sequenceRequest = tx.objectStore('control').get('sequence');
            let remaining = 4;
            const planned = () => {
              if (--remaining !== 0) return;
              try {
                validatePresentation(all.result, contents.result, presentation.result);
                validateDomain(all.result);
                const timestamp = now();
                if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw hostError('invalid_host_clock', 'Display timestamp must be nonnegative integer milliseconds');
                const previous = currentSequence(sequenceRequest.result?.value);
                if (previous === maxSequence) throw hostError('sequence_exhausted', 'Local commit sequence exhausted');
                const sequence = String(previous + 1n);
                const changes = rustCall<EntryChange[]>(() => wasm.planMutation(JSON.stringify({
                  request, entries: all.result, next_revision: crypto.randomUUID(),
                })));
                const result: Receipt = { operation_id: request.operation_id, sequence, changes };
                const record: RecordValue = { request, result };
                // Validate the receipt using Rust before persisting host-assembled fields.
                const validated = rustCall<Decision>(() => wasm.checkIdempotency(JSON.stringify({ request, record })));
                if (validated.status !== 'replay') throw hostError('invalid_wasm_result', 'Rust did not validate the new receipt');
                for (const [index, change] of changes.entries()) {
                  const write = metadata.put(change.after);
                  const previousStats = (presentation.result as BrowserVaultPresentation[]).find(row => row.id === change.after.id);
                  const bytes = (contents.result as {id: string; bytes: Uint8Array}[]).find(row => row.id === change.after.id)?.bytes;
                  const modifiedBytes = request.mutation.id === change.after.id && ['create', 'write'].includes(request.mutation.type) ? request.mutation.content : undefined;
                  tx.objectStore('presentation').put({ id: change.after.id, ctime_ms: previousStats?.ctime_ms ?? timestamp,
                    mtime_ms: timestamp, size_bytes: change.after.kind === 'folder' ? 0 : modifiedBytes?.length ?? bytes?.byteLength ?? 0 });
                  if (index === 0 && testHooks?.afterMetadataWrite) write.onsuccess = () => {
                    try { testHooks.afterMetadataWrite!(() => abort(hostError('fixture_abort', 'Trusted fixture aborted after metadata write'))); }
                    catch (error) { abort(error); }
                  };
                }
                const mutation = request.mutation;
                if (mutation.type === 'write' || (mutation.type === 'create' && mutation.content != null)) {
                  tx.objectStore('content').put({ id: mutation.id, bytes: new Uint8Array(mutation.content!) });
                }
                // Moves and logical deletions retain content by stable ID.
                receipts.add({ operation_id: request.operation_id, record });
                tx.objectStore('journal').add({ sequence, request, result });
                tx.objectStore('outbox').add({ sequence, operation_id: request.operation_id,
                  bytes: new TextEncoder().encode(JSON.stringify({ request, result })) });
                tx.objectStore('control').put({ key: 'sequence', value: sequence });
                const receipt = JSON.stringify(result); commitIntent(receipt); done(receipt);
              } catch (error) { abort(error); }
            };
            all.onsuccess = planned;
            contents.onsuccess = planned;
            presentation.onsuccess = planned;
            sequenceRequest.onsuccess = planned;
          } catch (error) { abort(error); }
        };
        lookup.onsuccess = processLookup;
        ownerLookup.onsuccess = processLookup;
        if (trackedLookup) trackedLookup.onsuccess = processLookup;
      });
  };

  const inventory = (): Promise<BrowserVaultRead[]> => transact('readonly', (tx, done, abort) => {
    const entries = tx.objectStore('metadata').getAll();
    const contents = tx.objectStore('content').getAll();
    const presentation = tx.objectStore('presentation').getAll();
    let remaining = 3;
    const read = () => {
      if (--remaining) return;
      try {
        validatePresentation(entries.result, contents.result, presentation.result);
        validateDomain(entries.result);
        const contentMap = new Map((contents.result as {id: string; bytes: Uint8Array}[]).map(row => [row.id, row.bytes]));
        const stats = new Map((presentation.result as BrowserVaultPresentation[]).map(row => [row.id, row]));
        done((entries.result as EntryState[]).filter(entry => !entry.deleted).map(entry => ({entry, presentation: stats.get(entry.id)!,
          ...(entry.kind === 'file' ? {bytes: contentMap.get(entry.id)!.slice()} : {})})));
      } catch (error) { abort(error); }
    };
    entries.onsuccess = read; contents.onsuccess = read; presentation.onsuccess = read;
  });
  const readIntents = (clientId: string): Promise<BrowserVaultIntent[]> => {
    intentKey(clientId, 'lookup');
    return transact('readonly', (tx, done, abort) => {
      const read = tx.objectStore('intents').getAll();
      read.onsuccess = () => {
        try {
          const rows = (read.result as BrowserVaultIntent[]).filter(row => row.client_id === clientId);
          for (const row of rows) {
            intentKey(row.client_id, row.intent_id);
            if (typeof row.request_json !== 'string' || !['prepared', 'commit_requested', 'committed', 'rejected'].includes(row.status) ||
                typeof row.acknowledged !== 'boolean' || (['prepared','commit_requested'].includes(row.status) && row.acknowledged) ||
                currentSequence(row.order) === 0n ||
                (row.status === 'committed' && typeof row.receipt !== 'string') ||
                (row.status === 'rejected' && (typeof row.error?.code !== 'string' || typeof row.error.message !== 'string' || row.error.source !== 'rust'))) throw hostError('storage_corrupt', 'Invalid stored intent');
            try {
              const request = JSON.parse(row.request_json);
              if (row.operation_id !== request.operation_id) throw hostError('storage_corrupt','Intent operation identity disagrees with exact request');
              rustCall(() => wasm.checkIdempotency(`{"request":${row.request_json},"record":null}`));
              if (row.status === 'committed') rustCall(() => wasm.checkIdempotency(JSON.stringify({request,record:{request,result:JSON.parse(row.receipt!)}})));
            } catch { throw hostError('storage_corrupt', 'Stored intent request failed Rust validation'); }
          }
          done(rows.sort((a,b) => BigInt(a.order) < BigInt(b.order) ? -1 : BigInt(a.order) > BigInt(b.order) ? 1 : 0));
        } catch (error) { abort(error); }
      };
    });
  };
  return {
    authorityId,
    mutate,
    inventory,
    async readEntry(path) { return (await inventory()).find(row => row.entry.path === path) ?? null; },
    intents: readIntents,
    acknowledgeIntent(clientId, intentId, outcome) {
      const key = intentKey(clientId, intentId);
      return transact('readwrite', (tx, done, abort) => {
        const store = tx.objectStore('intents'), read = store.get(key);
        read.onsuccess = () => {
          const row = read.result as BrowserVaultIntent | undefined;
          if (!row || !outcome || !['committed','rejected'].includes(row.status) || row.status !== outcome.status ||
              (outcome.status === 'committed' ? row.receipt !== outcome.receipt : JSON.stringify(row.error) !== JSON.stringify(outcome.error))) {
            abort(hostError('intent_outcome_mismatch', 'Acknowledge only the exact observed settled intent outcome')); return;
          }
          store.put({...row,acknowledged:true}); done(undefined);
        };
      });
    },
    changesSince(sequence) {
      const previous = currentSequence(sequence);
      return transact('readonly', (tx, done, abort) => {
        const journal = tx.objectStore('journal').getAll(), control = tx.objectStore('control').get('sequence');
        let remaining = 2;
        const read = () => {
          if (--remaining) return;
          try {
            const current = currentSequence(control.result?.value);
            if (previous > current) throw hostError('storage_corrupt', 'Observed sequence moved backwards');
            const events = (journal.result as {sequence:string;request:Request;result:Receipt}[])
              .filter(row => currentSequence(row.sequence) > previous)
              .sort((a,b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1);
            let expected = previous; let structural = false; const paths = new Set<string>();
            for (const event of events) {
              if (currentSequence(event.sequence) !== ++expected || event.result.sequence !== event.sequence) throw hostError('storage_corrupt', 'Commit journal is not contiguous');
              try { rustCall(() => wasm.checkIdempotency(JSON.stringify({request:event.request,record:{request:event.request,result:event.result}}))); }
              catch (error) { throw hostError('storage_corrupt', 'Stored commit journal failed Rust receipt validation', {reason:String(error)}); }
              for (const {before,after} of event.result.changes) {
                if (!before || before.path !== after.path || before.deleted !== after.deleted) structural = true;
                if (after.kind === 'file') paths.add(after.path);
              }
            }
            if (expected !== current) throw hostError('storage_corrupt', 'Commit journal is missing a durable event');
            done({sequence:String(current), ...(structural ? {} : {paths:[...paths]})});
          } catch (error) { abort(error); }
        };
        journal.onsuccess = read; control.onsuccess = read;
      });
    },
    prepareIntent(clientId, intentId, requestJson) {
      const key = intentKey(clientId, intentId);
      // Preserve original serialized input, including duplicate-field rejection.
      let request: Request;
      try { request = JSON.parse(requestJson) as Request; } catch { return Promise.reject(hostError('invalid_request_json', 'Intent request must be JSON')); }
      rustCall<Decision>(() => wasm.checkIdempotency(`{"request":${requestJson},"record":null}`));
      return transact('readwrite', (tx, done, abort) => {
        const store = tx.objectStore('intents'), read = store.get(key), owner = store.index('by_operation').get(request.operation_id);
        const receipt = tx.objectStore('receipts').get(request.operation_id);
        let remaining = 3;
        const prepared = () => {
          if (--remaining) return;
          if (receipt.result !== undefined && !owner.result) { abort(hostError('intent_operation_owned','Operation ID already has a receipt outside this intent')); return; }
          if (owner.result && (owner.result.client_id !== clientId || owner.result.intent_id !== intentId)) { abort(hostError('intent_operation_owned','Operation ID already belongs to another intent')); return; }
          if (read.result !== undefined && read.result.request_json !== requestJson) { abort(hostError('intent_conflict', 'Intent ID already has different request bytes')); return; }
          if (read.result !== undefined) { done(undefined); return; }
          const control = tx.objectStore('control'), order = control.get('intent-sequence');
          order.onsuccess = () => {
            try {
              const previous = currentSequence(order.result?.value);
              if (previous === maxSequence) throw hostError('sequence_exhausted', 'Intent preparation sequence exhausted');
              const next = String(previous + 1n);
              store.add({client_id: clientId, intent_id: intentId, operation_id:request.operation_id, request_json: requestJson, status: 'prepared', order:next, acknowledged:false});
              control.put({key:'intent-sequence', value:next}); done(undefined);
            } catch (error) { abort(error); }
          };
        };
        read.onsuccess = prepared; owner.onsuccess = prepared; receipt.onsuccess = prepared;
      });
    },
    async executeIntent(clientId, intentId) {
      intentKey(clientId, intentId);
      let intent = (await readIntents(clientId)).find(row => row.intent_id === intentId);
      if (!intent) throw hostError('intent_not_found', 'Prepared intent does not exist');
      if (intent.status === 'rejected') throw new BrowserVaultError(intent.error!.code, intent.error!.message, intent.error!.details, intent.error!.source);
      // This method is an explicit commit request. Persist authorization before
      // applying bytes; startup recovery must never call it for merely prepared
      // records whose caller may have crashed before checkpointing the token.
      await transact<void>('readwrite', (tx, done, abort) => {
        const store = tx.objectStore('intents'), read = store.get([clientId,intentId]);
        read.onsuccess = () => {
          const row = read.result as BrowserVaultIntent | undefined;
          if (!row) { abort(hostError('intent_not_found', 'Prepared intent does not exist')); return; }
          if (row.request_json !== intent!.request_json) { abort(hostError('storage_corrupt','Prepared intent changed before commit authorization')); return; }
          if (row.status === 'prepared') store.put({...row,status:'commit_requested'});
          else if (!['commit_requested','committed','rejected'].includes(row.status)) { abort(hostError('storage_corrupt','Invalid intent phase')); return; }
          done(undefined);
        };
      });
      testHooks?.afterCommitRequested?.();
      intent = (await readIntents(clientId)).find(row => row.intent_id === intentId);
      if (!intent) throw hostError('intent_not_found', 'Prepared intent does not exist');
      if (intent.status === 'rejected') throw new BrowserVaultError(intent.error!.code, intent.error!.message, intent.error!.details, intent.error!.source);
      // Even a committed record is rechecked against Rust receipt storage; never
      // trust an orphaned host intent as proof of a commit.
      try { return await mutate(intent.request_json, intent); }
      catch (error) {
        const failure = storageError(error);
        if (failure.source === 'rust' && ['invalid_operation_record', 'rust_input_rejected'].includes(failure.code)) {
          throw hostError('storage_corrupt', 'Prepared operation could not validate its stored Rust receipt', {cause:failure.code});
        }
        // Only Rust domain/input rejection is definitively rejected. I/O, quota,
        // transport loss and lifecycle errors leave the exact intent pending.
        if (failure.source === 'rust') {
          const racedCommit = await transact<boolean>('readwrite', (tx, done) => {
            const store = tx.objectStore('intents'), read = store.get([clientId, intentId]);
            read.onsuccess = () => {
              if (read.result?.status === 'commit_requested') store.put({...intent, status: 'rejected', error: {
                code: failure.code, message: failure.message, details: failure.details, source: failure.source }});
              done(read.result?.status === 'committed');
            };
          });
          if (racedCommit) return mutate(intent.request_json, intent);
        }
        throw failure;
      }
    },
    snapshot() {
      return transact<string>('readonly', (tx, done, abort) => {
        const entries = tx.objectStore('metadata').getAll();
        const contents = tx.objectStore('content').getAll();
        const presentation = tx.objectStore('presentation').getAll();
        const sequence = tx.objectStore('control').get('sequence');
        let remaining = 4;
        const read = () => {
          if (--remaining !== 0) return;
          try {
            validatePresentation(entries.result, contents.result, presentation.result); currentSequence(sequence.result?.value);
            validateDomain(entries.result);
            done(JSON.stringify({ entries: entries.result, sequence: sequence.result.value }));
          }
          catch (error) { abort(error); }
        };
        entries.onsuccess = read; contents.onsuccess = read; presentation.onsuccess = read; sequence.onsuccess = read;
      });
    },
    readBytes(id) {
      return transact<Uint8Array>('readonly', (tx, done, abort) => {
        const metadata = tx.objectStore('metadata').getAll();
        const read = tx.objectStore('content').get(id);
        let remaining = 2;
        const completed = () => {
          if (--remaining !== 0) return;
          try {
            validateDomain(metadata.result);
            const entry = (metadata.result as EntryState[]).find(row => row.id === id);
            validateContent(entry === undefined ? [] : [entry], read.result === undefined ? [] : [read.result]);
            if (read.result === undefined) throw hostError('content_not_found', 'No retained content for entry', { id });
            done(read.result.bytes.slice());
          } catch (error) { abort(error); }
        };
        read.onsuccess = completed; metadata.onsuccess = completed;
      });
    },
    close,
  };
}
