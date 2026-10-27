'use strict';
const { watch } = require('node:fs');
const { RustVaultService } = require('./rust-vault-service.cjs');
const { DocumentRuntimeScheduler } = require('./document-runtime.cjs');
const { normalizePath } = require('./vault-service.cjs');

function error(code, message = 'Rust vault operation failed.') { const value = new Error(message); value.code = code; return value; }
function requireDocumentRuntime(host) {
  if (!host.capabilities?.includes('document_runtime') || !host.capabilities?.includes('documents')) {
    throw error('document_runtime_unavailable', 'The desktop core does not support document indexing. Update Zorid and restart the app.');
  }
}
function metadata(state, presentation) {
  return { path: state.path, entryId:state.id, revision:state.revision, type: state.kind, mtime: presentation.mtime_ms, size: presentation.size_bytes,
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


/** NativeVault-backed filesystem service selected by trusted main startup.
 * The historical fixture option is internal, never a renderer capability. Durable mutation support
 * requires the shared host-intent API, not an in-memory operation-ID substitute.
 */
class CoreVaultFixtureService {
  static async open(root, options = {}) {
    if (options.fixture !== true) throw error('fixture_opt_in_required');
    const { pollMs = 750, rescanMs = 30000, documentRuntime = false } = options;
    if(typeof documentRuntime!=='boolean')throw error('invalid_runtime_option');
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60000 || !Number.isSafeInteger(rescanMs) || rescanMs < 1000 || rescanMs > 3600000) throw error('invalid_poll_interval');
    const host = await RustVaultService.open(root, options);
    try {
      if (documentRuntime) requireDocumentRuntime(host);
      for (const capability of ['read_path', 'list_snapshot', 'changes_after', 'rescan', 'prepare_intent', 'commit_intent', 'query_intent', 'list_intents', 'acknowledge_intent']) {
        if (!host.capabilities.includes(capability)) throw error('unsupported_host_capability');
      }
      const familyMode = options.familyMode === true;
      const service = new CoreVaultFixtureService(host, { pollMs, rescanMs, familyMode, documentRuntime });
      if (familyMode) {
        if(options.initializeLocal){
          if(!host.capabilities.includes('local_family_status')||!host.capabilities.includes('reconciliation_status')||!host.reconciliation)throw error('unsupported_host_capability');
          await host.localFamilyStatus();
        }else{
          if(!host.capabilities.includes('fixture_family_status'))throw error('unsupported_host_capability');
          await host.fixtureFamilyStatus();
        }
      } else {
        const scan = await host.rescan();
        if (!scan.finished || !scan.complete) throw error('scan_incomplete');
      }
      service.adopt(await host.listSnapshot());
      return service;
    } catch (reason) { await host.close(); throw reason; }
  }
  constructor(host, { pollMs, rescanMs, familyMode = false, documentRuntime = false }) {
    if (documentRuntime) requireDocumentRuntime(host);
    this.documentRuntimeEnabled=documentRuntime;
    this.documentRuntimeOwners=new Set();
    this.documentScheduler=null;
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
    this.reconciliation=host.reconciliation?structuredClone(host.reconciliation):null;
    if(documentRuntime&&host.exit&&typeof host.exit.then==='function')void host.exit.then(()=>{
      this.runtimeFailed=true;this.stopPolling();void this.documentScheduler?.close();
    });
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
    this.live();
    const entry = await this.host.readMetadata(normalizePath(input));
    return entry ? metadata(entry.entry, entry.presentation) : null;
  }
  async readBinary(input) {
    this.live();
    const path=normalizePath(input),observed=await this.host.readMetadata(path);
    if(!observed)throw error('not_found');
    if(!observed.has_content)throw error('not_file');
    const small=BigInt(this.host.binaryLimits?.smallReadBytes??String(16*1024*1024));
    if(BigInt(observed.presentation.size_bytes)>small)throw error('stream_required');
    const entry = await this.readEntry(path);
    if(entry&&(entry.entry.id!==observed.entry.id||entry.entry.revision!==observed.entry.revision))throw error('revision_conflict');
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
  // Runtime polling follows admitted vault ownership, independently of feature
  // listeners. Unsupported/explicit legacy mode retains the old subscription gate.
  runtimeOwner() {
    for(const owner of this.documentRuntimeOwners){
      if(owner.paused)continue;
      try{owner.assertActive();return owner;}
      catch{void owner.handle.revoke();}
    }
    return null;
  }
  syncPolling() {
    const needed=!this.closed&&!this.runtimeFailed&&(this.documentRuntimeEnabled?!!this.runtimeOwner():this.listeners.size>0);
    if(needed)this.startPolling();else this.stopPolling();
  }
  startPolling() {
    if(this.timer)return;
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
  stopPolling() {
    clearInterval(this.timer);this.timer=null;
    this.watcher?.close();this.watcher=null;
  }
  subscribe(listener) {
    this.live();
    if(typeof listener!=='function')throw error('invalid_listener');
    this.listeners.add(listener);this.syncPolling();
    return()=>{this.listeners.delete(listener);this.syncPolling();};
  }
  registerDocumentRuntimeOwner(options) {
    this.live();
    if(!this.documentRuntimeEnabled||this.runtimeFailed)throw error('unsupported_host_capability');
    this.ensureDocumentScheduler();
    const handle=this.documentScheduler.addOwner(options),owner={host:options.host,assertActive:options.assertActive,handle,paused:false};
    const remove=()=>{owner.paused=true;this.documentRuntimeOwners.delete(owner);this.syncPolling();};
    handle.subscribe(()=>{},remove);
    this.documentRuntimeOwners.add(owner);this.syncPolling();
    if(!this.documentRuntimeOwners.has(owner))throw error('client_ownership_lost');
    return Object.freeze({
      observe:handle.observe,control:handle.control,ackControl:handle.ackControl,ackOutcome:handle.ackOutcome,subscribe:handle.subscribe,
      pause:async()=>{owner.paused=true;this.syncPolling();await Promise.all([handle.pause(),this.polling]);},
      resume:()=>{owner.paused=false;handle.resume();this.needsScan=true;this.syncPolling();},
      prepareRelease:handle.prepareRelease,
      release:()=>{handle.release();remove();},
      revoke:async()=>{remove();await handle.revoke();},
    });
  }
  ensureDocumentScheduler(){
    if(!this.documentScheduler)this.documentScheduler=new DocumentRuntimeScheduler({
      ...(this.documentRuntimeEnabled&&this.host.capabilities?.includes('document_drafts')?{workHost:this.host}:{}),
      onError:()=>{if(this.host.fatal||this.host.exited){this.runtimeFailed=true;this.stopPolling();void this.documentScheduler.close().catch(()=>{});}},
    });
    return this.documentScheduler;
  }
  registerDocumentDraftOwner(options){
    this.live();if(!this.documentRuntimeEnabled||this.runtimeFailed||!this.host.capabilities?.includes('document_drafts')||typeof this.host.documentWork!=='function'||typeof options.host?.documentDrafts!=='function')throw error('unsupported_host_capability');
    return this.ensureDocumentScheduler().addDraftOwner(options);
  }
  releaseDocumentDraftClient(reference){
    this.live();if(!this.documentRuntimeEnabled||!this.host.capabilities?.includes('document_drafts'))throw error('unsupported_host_capability');
    return this.ensureDocumentScheduler().releaseDraftClient(reference);
  }
  documentRuntimeSourceHint() { this.documentScheduler?.sourceHint(); }
  databaseChanged() { this.live();this.notify({type:'change'}); }
  async poll() {
    if (this.closed) return;
    const owner=this.documentRuntimeEnabled?this.runtimeOwner():null;
    const host=this.documentRuntimeEnabled?owner?.host:this.host;
    if(!host)return;
    if (this.polling) return this.polling;
    const maintenanceGuard=owner?()=>{
      if(this.closed||this.runtimeFailed||owner.paused||!this.documentRuntimeOwners.has(owner))throw error('client_ownership_lost');
      owner.assertActive();
    }:null;
    const before=this.cursor;
    this.polling = this.pollNow(host,maintenanceGuard).then(()=>{if(this.cursor!==before)this.documentRuntimeSourceHint();}).catch(reason => {
      if(this.host.fatal||this.host.exited){this.runtimeFailed=true;this.stopPolling();void this.documentScheduler?.close();}
      if (!this.closed) this.notify({ type: 'error', message: 'Native vault reconciliation needs attention.', code: reason?.code ?? 'reconciliation_failed' });
    }).finally(() => { this.polling = null; });
    return this.polling;
  }
  async changePage(host=this.host) {
    for (;;) {
      try { return await host.changesAfter(this.cursor, this.pageLimit); }
      catch (reason) {
        if (reason?.code === 'response_limit' && this.pageLimit > 1) {
          this.pageLimit = Math.max(1, Math.floor(this.pageLimit / 2));
          continue;
        }
        if (reason?.code !== 'reload_required' && !(reason?.code === 'response_limit' && this.pageLimit === 1)) throw reason;
        // A typed journal discontinuity requires a complete coherent reload.
        // Do not interpret arbitrary storage corruption as permission to skip.
        const snapshot = await host.listSnapshot();
        this.adopt(snapshot);
        this.documentRuntimeSourceHint();
        this.notify({ type: 'change' });
        return null;
      }
    }
  }
  updateReconciliation(status) {
    if(!status)return;
    this.reconciliation=structuredClone(status);
    this.notify({type:'reconciliation',reconciliation:structuredClone(status)});
  }
  async scanNow(host=this.host,maintenanceGuard=null) {
    try {
      maintenanceGuard?.();
      // Rescan is trusted main-process maintenance, not an admitted client RPC.
      // Retain the selected owner's guard through the actual transport queue
      // and response; journal reads below still use that owner's leased host.
      const scan=maintenanceGuard
        ?(await this.host.request({method:'rescan'},undefined,undefined,maintenanceGuard)).result
        :await host.rescan();
      maintenanceGuard?.();
      this.lastScan=Date.now();
      this.documentScheduler?.wake();
      this.updateReconciliation(scan.reconciliation);
      if(!scan.complete)this.notify({type:'error',code:'scan_incomplete',message:'Native vault scan is incomplete; existing files are retained.'});
      return scan;
    } catch(reason) {
      maintenanceGuard?.();
      if(this.reconciliation)this.updateReconciliation({...this.reconciliation,complete:false,failure:'scan_failed'});
      throw reason;
    }
  }
  recoveryList(entryId,options) {this.live();return this.host.recoveryList(entryId,options);}
  recoveryRead(entryId,snapshotId) {this.live();return this.host.recoveryRead(entryId,snapshotId);}
  async retryReconciliation() {
    this.live();
    await this.scanNow();
    await this.poll();
    return this.reconciliation?structuredClone(this.reconciliation):null;
  }
  async pollNow(host=this.host,maintenanceGuard=null) {
    const hints = [...this.hints]; this.hints.clear();
    if (this.needsScan || (this.familyMode && hints.length) || Date.now() - this.lastScan >= this.rescanMs) {
      this.needsScan = false;
      await this.scanNow(host,maintenanceGuard);
    } else if (!this.familyMode && hints.length) {
      const report = await host.reconcile(hints);
      if (report.blocked.length) this.notify({ type: 'error', code: 'reconciliation_blocked', message: 'Native vault reconciliation retained conflicting data.' });
      // A new folder or an absent hint needs bounded traversal to discover its
      // descendants. A lookup/scan failure is never synthesized into a deletion.
      this.needsScan = true;
    }
    // Bound each poll; a busy vault continues from this cursor on the next tick.
    for (let pageCount = 0; pageCount < 8 && !this.closed; pageCount++) {
      const page = await this.changePage(host);
      if (!page) return;
      for (const change of page.changes) {
        let full = change.requires_full_reload;
        const paths = new Set();
        if (full) {
          this.adopt(await host.listSnapshot());
          this.documentRuntimeSourceHint();
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
  async prepareIntent(clientId, plan, sourceCapture) {
    this.live();
    if (typeof plan?.content_base64 !== 'string' || plan.content_base64.length > 22369624) throw error('invalid_body');
    const bytes = Buffer.from(plan.content_base64, 'base64');
    if (bytes.toString('base64') !== plan.content_base64) throw error('invalid_body');
    // Preparation is durable but inert. No commit is authorized here.
    const request = { operation_id: plan.operation_id, mutation: plan.mutation };
    return sourceCapture === undefined ? this.host.prepareIntent(clientId, request, bytes) : this.host.prepareIntent(clientId, request, bytes, sourceCapture);
  }
  async commitIntent(reference) {
    this.live();
    // Consumer must durably checkpoint this opaque token and the broker must
    // recheck its capability before calling. Host commits its stored bytes only.
    const reply=await this.host.commitIntent(reference);
    this.documentRuntimeSourceHint();
    return reply;
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
    this.stopPolling();
    this.listeners.clear();
    this.closing = (async () => { await this.documentScheduler?.close();this.documentRuntimeOwners.clear();if (this.polling) await this.polling; await this.host.close(); })();
    return this.closing;
  }
}
module.exports = { CoreVaultFixtureService };
