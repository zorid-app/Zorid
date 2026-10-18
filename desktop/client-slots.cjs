'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const failure = code => Object.assign(new Error('Desktop client identity registry unavailable.'), {code});
const slotId = value => value === 'primary' || typeof value === 'string' && value.startsWith('window-') && uuid(value.slice(7));
function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.slots) || state.slots.length > 1024) throw failure('invalid_client_registry');
  const slots = new Set(), clients = new Set();
  for (const row of state.slots) {
    if (!row || !slotId(row.slotId) || !uuid(row.clientId) || typeof row.restore !== 'boolean'
      || !(row.vaultPath === null || typeof row.vaultPath === 'string' && path.isAbsolute(row.vaultPath) && !row.vaultPath.includes('\0'))
      || slots.has(row.slotId) || clients.has(row.clientId)) throw failure('invalid_client_registry');
    slots.add(row.slotId); clients.add(row.clientId);
  }
}
/** Main-process only. Caller MUST hold Electron's single-instance lock for this
 * userData profile for the entire registry lifetime. This is not a process lock.
 * Claim before admitting a native client. Changing vault or release(restore:false)
 * requires successful editor flush and terminal checkpoint handling, then admission
 * drain. On failure preserve the stored path and restore eligibility.
 * Renderer reload retains its claim. Never delete identities on normal close.
 */
async function openClientSlots(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw failure('invalid_client_registry_path');
  let state = {version: 1, slots: []};
  try {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw failure('invalid_client_registry');
      state = JSON.parse(await handle.readFile('utf8')); validate(state);
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const claimed = new Set();
  let tail = Promise.resolve(), poisoned = false;
  const copy = row => Object.freeze({...row});
  const serial = action => {
    const task = tail.then(() => { if (poisoned) throw failure('client_registry_write_uncertain'); return action(); });
    tail = task.catch(() => {}); return task;
  };
  async function persist(next) {
    validate(next);
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) throw failure('client_registry_limit');
    const directory = path.dirname(file), temporary = path.join(directory, `.client-slots-${randomUUID()}.tmp`);
    let handle;
    try {
      await fs.mkdir(directory, {recursive: true, mode: 0o700});
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, file);
      // Windows does not expose directory fsync through Node's filesystem API.
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      state = next;
    } catch (error) {
      // A rename may already have committed. Never allocate new identities from
      // stale memory after ambiguous persistence; reopening reads the saved head.
      poisoned = true;
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  return Object.freeze({
    listExisting() { return serial(async () => state.slots.map(copy)); },
    listRestorable() { return serial(async () => state.slots.filter(row => row.slotId !== 'primary' && row.restore).sort((a,b) => a.slotId.localeCompare(b.slotId)).map(copy)); },
    claim(options = {}) { return serial(async () => {
      if (options.existingOnly !== undefined && typeof options.existingOnly !== 'boolean' || options.primary !== undefined && typeof options.primary !== 'boolean' || options.slotId !== undefined && !slotId(options.slotId)
        || options.primary && options.slotId && options.slotId !== 'primary') throw failure('invalid_client_slot');
      const wanted = options.primary ? 'primary' : options.slotId;
      let row = wanted ? state.slots.find(row => row.slotId === wanted) : state.slots.find(row => row.slotId !== 'primary' && !row.restore && !claimed.has(row.slotId));
      if (options.existingOnly && (!wanted || !row || row.clientId !== options.expectedClientId || row.vaultPath !== options.expectedVaultPath)) throw failure('client_slot_not_found');
      if (wanted && claimed.has(wanted)) throw failure('client_slot_in_use');
      if (!row) {
        if (options.existingOnly) throw failure('client_slot_not_found');
        if (wanted && wanted !== 'primary') throw failure('client_slot_not_found');
        row = {slotId: wanted || `window-${randomUUID()}`, clientId: randomUUID(), vaultPath: null, restore: true};
      }
      const selected = {...row, restore: true};
      await persist({version: 1, slots: [...state.slots.filter(item => item.slotId !== row.slotId), selected]});
      claimed.add(row.slotId); return copy(selected);
    }); },
    setVault(id, vaultPath) { return serial(async () => {
      if (!claimed.has(id) || !(vaultPath === null || typeof vaultPath === 'string' && path.isAbsolute(vaultPath) && !vaultPath.includes('\0'))) throw failure('invalid_client_slot');
      await persist({version: 1, slots: state.slots.map(row => row.slotId === id ? {...row, vaultPath} : row)});
    }); },
    release(id, {restore = false} = {}) { return serial(async () => {
      if (!claimed.has(id) || typeof restore !== 'boolean') throw failure('invalid_client_slot');
      await persist({version: 1, slots: state.slots.map(row => row.slotId === id ? {...row, restore} : row)});
      claimed.delete(id);
    }); },
  });
}
module.exports = {openClientSlots};
