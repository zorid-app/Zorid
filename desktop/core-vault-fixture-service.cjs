'use strict';
const { watch } = require('node:fs');
const { RustVaultService } = require('./rust-vault-service.cjs');
const { normalizePath } = require('./vault-service.cjs');

function error(code) { const value = new Error('Core vault fixture operation failed.'); value.code = code; return value; }
function metadata(state, presentation) {
  return { path: state.path, type: state.kind, mtime: presentation.mtime_ms, size: presentation.size_bytes,
    ...(presentation.ctime_ms ? { ctime: presentation.ctime_ms } : {}) };
}
function visible(path) { return !path.split('/').some(part => part.startsWith('.')); }
function validText(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return Buffer.byteLength(value, 'utf8') <= 16 * 1024 * 1024;
}


/** Actual NativeVault-backed filesystem service, enabled only by explicit fixture
 * construction. Only the trusted disposable-vault startup opt-in selects it. Durable mutation support
 * requires the shared host-intent API, not an in-memory operation-ID substitute.
 */
class CoreVaultFixtureService {
  static async open(root, options = {}) {
    if (options.fixture !== true) throw error('fixture_opt_in_required');
    const { pollMs = 750, rescanMs = 30000 } = options;
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60000 || !Number.isSafeInteger(rescanMs) || rescanMs < 1000 || rescanMs > 3600000) throw error('invalid_poll_interval');
    const host = await RustVaultService.open(root, options);
    try {
      for (const capability of ['read_path', 'list_snapshot', 'changes_after', 'rescan', 'prepare_intent', 'commit_intent', 'query_intent', 'list_intents', 'acknowledge_intent']) {
        if (!host.capabilities.includes(capability)) throw error('unsupported_host_capability');
      }
      const familyMode = options.familyMode === true;
      const service = new CoreVaultFixtureService(host, { pollMs, rescanMs, familyMode });
      if (familyMode) {
        if (!host.capabilities.includes('fixture_family_status')) throw error('unsupported_host_capability');
        // Must already be enrolled in the trusted startup configuration. Opening
        // a UI never initializes/migrates storage or adopts physical files.
        await host.fixtureFamilyStatus();
      } else {
        const scan = await host.rescan();
        if (!scan.finished || !scan.complete) throw error('scan_incomplete');
      }
      service.adopt(await host.listSnapshot());
      return service;
    } catch (reason) { await host.close(); throw reason; }
  }
  constructor(host, { pollMs, rescanMs, familyMode = false }) {
    this.host = host;
    this.familyMode = familyMode;
    this.root = host.root;
    this.pollMs = pollMs;
    this.rescanMs = rescanMs;
    this.lastScan = Date.now();
    this.entries = new Map();
    this.cursor = '0';
    this.pageLimit = 100;
    this.listeners = new Set();
    this.hints = new Set();
    this.needsScan = false;
    this.closed = false;
  }
  live() { if (this.closed) throw error('vault_closed'); }
  adopt(snapshot) {
    this.entries = new Map(snapshot.entries.map(value => [value.state.id, value]));
    this.cursor = snapshot.cursor;
  }
  async list(input = '') {
    this.live();
    const prefix = normalizePath(input, true);
    const snapshot = await this.host.listSnapshot();
    // This call does not advance the notification cursor: another subscriber
    // must still receive commits observed incidentally by a list request.
    return snapshot.entries.filter(value => visible(value.state.path)
      && (!prefix || value.state.path.startsWith(prefix + '/')))
      .map(value => metadata(value.state, value.presentation)).sort((a, b) => a.path.localeCompare(b.path));
  }
  async readEntry(input) { this.live(); return this.host.readPath(normalizePath(input)); }
  async stat(input) {
    const entry = await this.readEntry(input);
    return entry ? metadata(entry.entry, entry.presentation) : null;
  }
  async readBinary(input) {
    const entry = await this.readEntry(input);
    if (!entry) throw error('not_found');
    if (!entry.has_content) throw error('not_file');
    return new Uint8Array(entry.bytes);
  }
  async read(input) {
    const bytes = await this.readBinary(input);
    // Refuse lossy decoding: an unknown/binary file must survive a text-open
    // attempt without replacement characters being saved over its original bytes.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw error('not_utf8'); }
  }
  notify(change) {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* Observer failure never undoes a commit. */ }
    }
  }
  subscribe(listener) {
    this.live();
    if (typeof listener !== 'function') throw error('invalid_listener');
    this.listeners.add(listener);
    if (!this.timer) {
      try {
        if (!this.familyMode) this.watcher = watch(this.root, { recursive: true }, (_event, file) => {
          if (this.closed) return;
          const relative = file?.toString().replaceAll('\\', '/');
          if (relative === '.zorid' || relative?.startsWith('.zorid/')) return;
          try {
            if (relative && this.hints.size < 1024) this.hints.add(normalizePath(relative));
            else this.needsScan = true;
          } catch { this.needsScan = true; }
        });
        this.watcher?.on('error', () => { this.needsScan = true; });
      } catch { this.needsScan = true; }
      this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
      this.timer.unref();
      void this.poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.timer); this.timer = null;
        this.watcher?.close(); this.watcher = null;
      }
    };
  }
  async poll() {
    if (this.closed) return;
    if (this.polling) return this.polling;
    this.polling = this.pollNow().catch(reason => {
      if (!this.closed) this.notify({ type: 'error', message: 'Native vault reconciliation needs attention.', code: reason?.code ?? 'reconciliation_failed' });
    }).finally(() => { this.polling = null; });
    return this.polling;
  }
  async changePage() {
    for (;;) {
      try { return await this.host.changesAfter(this.cursor, this.pageLimit); }
      catch (reason) {
        if (reason?.code === 'response_limit' && this.pageLimit > 1) {
          this.pageLimit = Math.max(1, Math.floor(this.pageLimit / 2));
          continue;
        }
        if (reason?.code !== 'reload_required' && !(reason?.code === 'response_limit' && this.pageLimit === 1)) throw reason;
        // A typed journal discontinuity requires a complete coherent reload.
        // Do not interpret arbitrary storage corruption as permission to skip.
        const snapshot = await this.host.listSnapshot();
        this.adopt(snapshot);
        this.notify({ type: 'change' });
        return null;
      }
    }
  }
  async pollNow() {
    const hints = [...this.hints]; this.hints.clear();
    if (!this.familyMode && (this.needsScan || Date.now() - this.lastScan >= this.rescanMs)) {
      this.needsScan = false;
      const scan = await this.host.rescan();
      this.lastScan = Date.now();
      if (!scan.complete) this.notify({ type: 'error', code: 'scan_incomplete', message: 'Native vault scan is incomplete; existing files are retained.' });
    } else if (!this.familyMode && hints.length) {
      const report = await this.host.reconcile(hints);
      if (report.blocked.length) this.notify({ type: 'error', code: 'reconciliation_blocked', message: 'Native vault reconciliation retained conflicting data.' });
      // A new folder or an absent hint needs bounded traversal to discover its
      // descendants. A lookup/scan failure is never synthesized into a deletion.
      this.needsScan = true;
    }
    // Bound each poll; a busy vault continues from this cursor on the next tick.
    for (let pageCount = 0; pageCount < 8 && !this.closed; pageCount++) {
      const page = await this.changePage();
      if (!page) return;
      for (const change of page.changes) {
        let full = change.requires_full_reload;
        const paths = new Set();
        if (full) {
          this.adopt(await this.host.listSnapshot());
          this.notify({ type: 'change' });
          return;
        }
        for (const value of change.entries) {
          const before = this.entries.get(value.state.id);
          if (before && before.state.path !== value.state.path) full = true;
          if (value.state.kind === 'folder') full = true;
          if (value.state.deleted) this.entries.delete(value.state.id);
          else this.entries.set(value.state.id, value);
          if (visible(value.state.path)) paths.add(value.state.path);
          if (before && visible(before.state.path)) paths.add(before.state.path);
        }
        this.cursor = change.cursor;
        if (full) this.notify({ type: 'rename', origin: change.origin, cursor: change.cursor });
        else for (const path of paths) this.notify({ type: 'change', path, origin: change.origin, cursor: change.cursor });
      }
      this.cursor = page.next_cursor;
      if (!page.has_more) break;
    }
  }
  /** Read-only plan. Retain this exact immutable value until prepare returns a
   * token; retrying prepare with it preserves identity after an unknown ACK.
   * A fresh read/plan must never be used to retry an existing operation ID.
   */
  async planWrite(input, bytes, options = {}) {
    this.live();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16 * 1024 * 1024) throw error('invalid_body');
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    const { operationId, entryId, expectedRevision } = options;
    if (options.expectedBytes !== undefined && (!(options.expectedBytes instanceof Uint8Array) || options.expectedBytes.byteLength > 16 * 1024 * 1024)) throw error('invalid_body');
    if (!validId(operationId)) throw error('invalid_operation_id');
    // Copy before the await so caller mutation cannot change the planned write.
    const content = Buffer.from(bytes).toString('base64');
    const expected = options.expectedBytes === undefined ? undefined : Buffer.from(options.expectedBytes);
    const path = normalizePath(input);
    const current = await this.host.readPath(path);
    let mutation;
    if (current) {
      if (!current.has_content) throw error('not_file');
      if ((entryId !== undefined && current.entry.id !== entryId)
        || (expectedRevision !== undefined && current.entry.revision !== expectedRevision)
        || (expected !== undefined && !expected.equals(Buffer.from(current.bytes)))) throw error('revision_conflict');
      mutation = { type: 'write', id: current.entry.id, expected: current.entry.revision };
    } else {
      if (expected !== undefined || expectedRevision !== undefined) throw error('revision_conflict');
      if (!validId(entryId)) throw error('new_entry_id_required');
      mutation = { type: 'create', id: entryId, path, kind: 'file' };
    }
    return Object.freeze({ operation_id: operationId, mutation: Object.freeze(mutation), content_base64: content });
  }
  async planTextWrite(input, content, options = {}) {
    if (!validText(content) || (options.expectedContent !== undefined && !validText(options.expectedContent))) throw error('invalid_text');
    if (options.expectedContent !== undefined && options.expectedBytes !== undefined) throw error('ambiguous_precondition');
    return this.planWrite(input, Buffer.from(content, 'utf8'), { ...options,
      expectedBytes: options.expectedContent === undefined ? options.expectedBytes : Buffer.from(options.expectedContent, 'utf8') });
  }
  async prepareIntent(clientId, plan) {
    this.live();
    if (typeof plan?.content_base64 !== 'string' || plan.content_base64.length > 22369624) throw error('invalid_body');
    const bytes = Buffer.from(plan.content_base64, 'base64');
    if (bytes.toString('base64') !== plan.content_base64) throw error('invalid_body');
    // Preparation is durable but inert. No commit is authorized here.
    return this.host.prepareIntent(clientId, { operation_id: plan.operation_id, mutation: plan.mutation }, bytes);
  }
  async commitIntent(reference) {
    this.live();
    // Consumer must durably checkpoint this opaque token and the broker must
    // recheck its capability before calling. Host commits its stored bytes only.
    return this.host.commitIntent(reference);
  }
  async queryIntent(reference) { this.live(); return this.host.queryIntent(reference); }
  async listIntents(clientId, cursor = '0', limit = 100) { this.live(); return this.host.listIntents(clientId, cursor, limit); }
  async acknowledgeIntent(reference, expected) {
    this.live();
    // Consumer has durably reconciled this exact receipt/rejection before ACK.
    return this.host.acknowledgeIntent(reference, expected);
  }
  // Legacy void writes lack a durable consumer checkpoint/receipt handshake.
  // They cannot be enabled merely because the host now stores prepared intents.
  async write() { throw error('durable_consumer_required'); }
  async writeBinary() { throw error('durable_consumer_required'); }
  async compareAndWrite() { throw error('durable_consumer_required'); }
  async mkdir() { throw error('durable_consumer_required'); }
  async rename() { throw error('native_namespace_pending'); }
  async trash() { throw error('native_namespace_pending'); }
  async remove() { throw error('native_namespace_pending'); }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer); this.timer = null;
    this.watcher?.close(); this.watcher = null;
    this.listeners.clear();
    this.closing = (async () => { if (this.polling) await this.polling; await this.host.close(); })();
    return this.closing;
  }
}
module.exports = { CoreVaultFixtureService };
