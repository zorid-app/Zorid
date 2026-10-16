'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { dispatchVaultOperation } = require('./vault-dispatch.cjs');

// Owns grants and a single operation queue per canonical vault, across renderers.
class WindowBroker {
  constructor({ openVault, allowedURL }) {
    this.openVault = openVault;
    this.allowedURL = allowedURL;
    this.windows = new Map();
    this.vaults = new Map();
  }
  register(window, { primary = false, initialState = 'empty' } = {}) {
    const id = primary ? 'main' : randomUUID();
    if ([...this.windows.values()].some(record => record.id === id)) throw new Error('Window identity already in use');
    const record = { id, window, webContentsId: window.webContents.id, initialState, vault: null, generation: 0 };
    this.windows.set(record.webContentsId, record);
    return record;
  }
  assertLive(record) {
    if (this.windows.get(record.webContentsId) !== record || record.window.isDestroyed() || record.window.webContents.isDestroyed()) throw new Error('Window is no longer available');
  }
  authenticate(event) {
    const record = this.windows.get(event.sender.id);
    if (!record || record.window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted sender');
    this.assertLive(record);
    if (!this.allowedURL(event.senderFrame.url)) throw new Error('Untrusted page');
    return record;
  }
  info(record) { this.assertLive(record); return { id: record.id, initialState: record.initialState }; }
  describe(record) { this.assertLive(record); return record.vault ? { path: record.vault.service.root, name: path.basename(record.vault.service.root) } : null; }
  async select(record, directory) {
    this.assertLive(record);
    const generation = ++record.generation;
    const service = await this.openVault(directory);
    this.assertLive(record);
    if (generation !== record.generation) throw new Error('Vault selection superseded');
    let entry = this.vaults.get(service.root);
    if (!entry) {
      entry = { service, tail: Promise.resolve(), members: new Set(), unsubscribe: null };
      this.vaults.set(service.root, entry);
    }
    this.bind(record, entry);
    return this.describe(record);
  }
  bind(record, entry) {
    this.assertLive(record);
    this.detach(record);
    record.generation++;
    record.vault = entry;
    if (!entry) return;
    entry.members.add(record);
    if (!entry.unsubscribe) entry.unsubscribe = entry.service.subscribe(change => this.broadcast(entry, change));
  }
  detach(record) {
    const entry = record.vault;
    record.vault = null;
    if (entry) {
      entry.members.delete(record);
      if (!entry.members.size) { entry.unsubscribe?.(); entry.unsubscribe = null; }
    }
  }
  broadcast(entry, change) {
    for (const record of entry.members) {
      try {
        this.assertLive(record);
        if (record.vault !== entry || !this.allowedURL(record.window.webContents.mainFrame.url)) continue;
        record.window.webContents.send('zorid:change', { ...change, vault: entry.service.root });
      } catch { /* A renderer closing or navigating must not fail a committed write or another recipient. */ }
    }
  }
  dispatch(record, expectedRoot, method, args, reauthorize = () => this.assertLive(record)) {
    this.assertLive(record);
    const entry = record.vault;
    const generation = record.generation;
    const check = () => {
      reauthorize();
      if (!entry) throw new Error('Open a vault first');
      if (record.vault !== entry || record.generation !== generation || typeof expectedRoot !== 'string' || expectedRoot !== entry.service.root) throw new Error('The selected vault changed. The old vault operation was not applied.');
    };
    check();
    // Snapshot bytes before an operation waits behind another window's write.
    const captured = args.map(value => value instanceof Uint8Array ? new Uint8Array(value) : value);
    const operation = entry.tail.then(async () => {
      check();
      let result;
      if (method === 'compareAndWrite') {
        const [file, expected, contents] = captured;
        if (typeof expected !== 'string' || typeof contents !== 'string') throw new TypeError('Expected and new content must be strings');
        if (await entry.service.read(file) !== expected) throw new Error(`File changed outside this editor: ${file}`);
        // Revalidate after the read, before committing a caller's write.
        check();
        await entry.service.write(file, contents);
      } else result = await dispatchVaultOperation(entry.service, expectedRoot, method, captured);
      if (['write', 'writeBinary', 'compareAndWrite', 'mkdir', 'rename', 'trash', 'remove'].includes(method)) {
        this.broadcast(entry, method === 'rename' ? { type: 'rename' } : { type: 'change', path: captured[0] });
      }
      return result;
    });
    entry.tail = operation.catch(() => {});
    return operation;
  }
  remove(record) {
    this.detach(record);
    record.generation++;
    if (this.windows.get(record.webContentsId) === record) this.windows.delete(record.webContentsId);
  }
  dispose() {
    for (const record of [...this.windows.values()]) this.remove(record);
    this.vaults.clear();
  }
}
module.exports = { WindowBroker };
