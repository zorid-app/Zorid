import { BrowserVaultError } from '../core/browser-vault.ts';

export interface BrowserClientSlot {
  readonly slotId: string;
  readonly clientId: string;
  /** Call only after the worker has durably released its consumer. */
  release(options: { restore: boolean }): Promise<void>;
  /** Page retirement retains recovery selection; it is not a clean release. */
  retire(): void;
}
export interface BrowserClientSlotOptions {
  database: string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  locks?: Pick<LockManager, 'request'>;
  indexedDB?: IDBFactory;
}
type Row = { slotId: string; clientId: string; restore: boolean };
type Registry = { version: 1; slots: Row[] };
const STORE = 'registry', KEY = 'state', LIMIT = 1024;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const error = (code: string) => new BrowserVaultError(code, 'Browser client slots are unavailable; retain the original recovery identity');
const exactKeys = (v: object, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
function registry(value: unknown): Registry {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['version', 'slots'])) throw error('client_slot_registry_invalid');
  const r = value as Registry;
  if (r.version !== 1 || !Array.isArray(r.slots) || r.slots.length > LIMIT) throw error('client_slot_registry_invalid');
  const slots = new Set<string>(), clients = new Set<string>();
  for (const row of r.slots) {
    if (!row || typeof row !== 'object' || !exactKeys(row, ['slotId', 'clientId', 'restore']) ||
      !uuid(row.slotId) || !uuid(row.clientId) || typeof row.restore !== 'boolean' || slots.has(row.slotId) || clients.has(row.clientId)) {
      throw error('client_slot_registry_invalid');
    }
    slots.add(row.slotId); clients.add(row.clientId);
  }
  return r;
}
function openRegistry(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try { request = factory.open(name, 1); }
    catch { reject(error('client_slot_storage_unavailable')); return; }
    const fail = () => { settled = true; reject(error('client_slot_storage_unavailable')); };
    request.onblocked = fail;
    request.onerror = fail;
    request.onupgradeneeded = event => {
      if (settled || event.oldVersion !== 0) { request.transaction?.abort(); return; }
      request.result.createObjectStore(STORE).put({ version: 1, slots: [] }, KEY);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
        db.close(); settled = true; reject(error('client_slot_registry_invalid')); return;
      }
      db.onversionchange = () => db.close();
      settled = true; resolve(db);
    };
  });
}
/** Only synchronous work executes inside a strict transaction; locks are acquired outside it. */
function access(db: IDBDatabase, change?: (state: Registry) => void, track?: (tx: IDBTransaction | undefined) => void): Promise<Registry> {
  return new Promise((resolve, reject) => {
    let result: Registry, cause: unknown;
    let tx: IDBTransaction;
    try { tx = db.transaction(STORE, 'readwrite', { durability: 'strict' }); }
    catch { reject(error('client_slot_storage_unavailable')); return; }
    // A browser that cannot honor strict durability must not admit a consumer.
    if (tx.durability !== 'strict') { tx.abort(); reject(error('client_slot_storage_unavailable')); return; }
    track?.(tx);
    tx.oncomplete = () => { track?.(undefined); resolve(result); };
    tx.onabort = () => { track?.(undefined); reject(cause ?? error('client_slot_storage_unavailable')); };
    tx.onerror = () => { /* onabort is the terminal outcome. */ };
    const store = tx.objectStore(STORE), request = store.get(KEY);
    request.onsuccess = () => {
      try {
        result = registry(request.result);
        if (change) { change(result); registry(result); store.put(result, KEY); }
      } catch (failure) { cause = failure; tx.abort(); }
    };
  });
}
interface Hold { active(): boolean; drop(): void; done: Promise<void> }
async function holdSlot(locks: Pick<LockManager, 'request'>, name: string): Promise<Hold | undefined> {
  let finish!: () => void, admit!: (hold: Hold | undefined) => void, refuse!: (reason: unknown) => void;
  let active = false;
  const lifetime = new Promise<void>(resolve => { finish = resolve; });
  const ready = new Promise<Hold | undefined>((resolve, reject) => { admit = resolve; refuse = reject; });
  const done = Promise.resolve().then(() => locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { admit(undefined); return; }
    active = true;
    admit({ active: () => active, drop() { active = false; finish(); }, done });
    await lifetime; active = false;
  })).then(() => { active = false; }, () => { active = false; finish(); refuse(error('client_slot_ownership_lost')); });
  return ready;
}

/** Persistent production slot selection. Session storage contains only a preferred slot UUID.
 * Page slots supplement, and never replace, the worker's authority/client ownership lease.
 * No TTL, stealing, automatic identity replacement, or transaction spanning an await.
 */
export async function openBrowserClientSlot(options: BrowserClientSlotOptions): Promise<BrowserClientSlot> {
  if (!options || typeof options.database !== 'string' || !options.database || options.database.length > 512) throw error('invalid_client_slot_database');
  let storage: BrowserClientSlotOptions['storage'], locks: BrowserClientSlotOptions['locks'], factory: IDBFactory | undefined;
  try {
    storage = options.storage ?? globalThis.sessionStorage;
    locks = options.locks ?? globalThis.navigator?.locks;
    factory = options.indexedDB ?? globalThis.indexedDB;
  } catch { throw error('client_slot_storage_unavailable'); }
  if (!locks || typeof locks.request !== 'function') throw error('client_locks_unavailable');
  if (!storage || !factory) throw error('client_slot_storage_unavailable');
  const prefix = `zorid:client-slots:v1:${options.database}`, pointer = `${prefix}:preferred`;
  let preferred: string | null;
  try { preferred = storage.getItem(pointer); } catch { throw error('client_slot_storage_unavailable'); }
  if (preferred !== null && !uuid(preferred)) throw error('client_slot_pointer_invalid');
  const db = await openRegistry(factory, `${options.database}:client-slots:v1`);
  let hold: Hold | undefined;
  try {
    return await locks.request(`${prefix}:registry`, { mode: 'exclusive' }, async lock => {
      if (!lock) throw error('client_locks_unavailable');
      const state = await access(db);
      let row: Row | undefined;
      if (preferred !== null) {
        row = state.slots.find(item => item.slotId === preferred);
        if (!row) throw error('client_slot_unknown');
        hold = await holdSlot(locks!, `${prefix}:slot:${row.slotId}`);
        if (!hold) throw error('client_slot_in_use');
      } else {
        for (const candidate of [...state.slots.filter(item => item.restore), ...state.slots.filter(item => !item.restore)]) {
          hold = await holdSlot(locks!, `${prefix}:slot:${candidate.slotId}`);
          if (hold) { row = candidate; break; }
        }
        if (!row) {
          if (state.slots.length >= LIMIT) throw error('client_slot_registry_full');
          row = { slotId: crypto.randomUUID(), clientId: crypto.randomUUID(), restore: true };
          if (!uuid(row.slotId) || !uuid(row.clientId) || state.slots.some(item => item.slotId === row!.slotId || item.clientId === row!.clientId)) throw error('client_slot_registry_invalid');
          hold = await holdSlot(locks!, `${prefix}:slot:${row.slotId}`);
          if (!hold) throw error('client_slot_in_use');
        }
      }
      const selected = row, ownership = hold!;
      await access(db, current => {
        if (!ownership.active()) throw error('client_slot_ownership_lost');
        if (JSON.stringify(current) !== JSON.stringify(state)) throw error('client_slot_registry_changed');
        const found = current.slots.find(item => item.slotId === selected.slotId);
        if (found) found.restore = true; else current.slots.push(selected);
      });
      try { storage!.setItem(pointer, selected.slotId); }
      catch { throw error('client_slot_storage_unavailable'); }
      if (!ownership.active()) throw error('client_slot_ownership_lost');
      let retired = false, released = false, releasing: Promise<void> | undefined, pending: IDBTransaction | undefined;
      return Object.freeze({
        slotId: selected.slotId, clientId: selected.clientId,
        release({ restore }: { restore: boolean }) {
          if (typeof restore !== 'boolean') return Promise.reject(error('invalid_client_slot_release'));
          if (released) return Promise.resolve();
          if (retired || !ownership.active()) return Promise.reject(error('client_slot_ownership_lost'));
          if (releasing) return releasing;
          releasing = Promise.resolve().then(() => locks!.request(`${prefix}:registry`, { mode: 'exclusive' }, async registryLock => {
            if (!registryLock || retired || !ownership.active()) throw error('client_slot_ownership_lost');
            if (!restore) {
              try { if (storage!.getItem(pointer) === selected.slotId) storage!.removeItem(pointer); }
              catch { throw error('client_slot_storage_unavailable'); }
            }
            await access(db, current => {
              if (retired || !ownership.active()) throw error('client_slot_ownership_lost');
              const found = current.slots.find(item => item.slotId === selected.slotId);
              if (!found || found.clientId !== selected.clientId) throw error('client_slot_registry_invalid');
              found.restore = restore;
            }, tx => { pending = tx; });
            released = true; ownership.drop(); await ownership.done; db.close();
          })).then(() => {}).catch(failure => { releasing = undefined; throw failure instanceof BrowserVaultError ? failure : error('client_slot_storage_unavailable'); });
          return releasing;
        },
        retire() {
          if (retired || released) return;
          retired = true;
          try { pending?.abort(); } catch { /* A completed clean release needs no rollback. */ }
          ownership.drop(); db.close();
        },
      });
    });
  } catch (failure) {
    hold?.drop(); if (hold) await hold.done;
    db.close();
    throw failure instanceof BrowserVaultError ? failure : error('client_slot_storage_unavailable');
  }
}
