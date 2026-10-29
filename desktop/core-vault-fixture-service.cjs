'use strict';
const { watch } = require('node:fs');
const fs = require('node:fs/promises');
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
const HEALTHY_WATCH_AUDIT_MS = 5 * 60 * 1000;
const MAX_KNOWN_HINTS_PER_POLL = 16;
function sourceImportPending(status){const work=status?.work;return work?.pending===true&&(work.phase==='discovery'||work.phase==='import');}
async function physicalWatchRoot(root){
  const path=await fs.realpath(root),stat=await fs.stat(path,{bigint:true});
  if(!stat.isDirectory())throw error('invalid_watch_root');
  return {path,identity:`${stat.dev}:${stat.ino}`};
}
function watchState() { return { hints:new Set(), needsScan:false, healthy:false, watcher:null, active:false, started:false, token:null }; }
function recordWatchHint(state, file) {
  if (!state.active) return;
  const relative = file?.toString().replaceAll('\\', '/');
  if (relative === '.zorid' || relative?.startsWith('.zorid/')) return;
  try {
    if (relative && state.hints.size < 1024) state.hints.add(normalizePath(relative));
    else state.needsScan = true;
  } catch { state.needsScan = true; }
}
function startWatcher(root, state, factory) {
  if (state.watcher) return;
  if(state.started)state.needsScan=true;
  state.started=true;state.active=true;const token={};state.token=token;
  try {
    state.watcher = factory(root, {recursive:true}, (_event, file) => {if(state.token===token)recordWatchHint(state,file);});
    state.healthy = true;
    const current=state.watcher;
    current.on('error', () => { if (state.active&&state.watcher===current) { state.healthy=false; state.needsScan=true; } });
    current.on('close', () => { if (state.active&&state.watcher===current) { state.watcher=null; state.healthy=false; state.needsScan=true; } });
  } catch { state.healthy=false; state.needsScan=true; }
}
function stopWatcher(state) {
  state.active=false; state.healthy=false;state.token=null;
  const watcher=state.watcher;state.watcher=null;watcher?.close();
}

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
    // Observe public-file changes throughout native startup, before the initial
    // reconciliation completes. Buffered hints close the admission blind gap.
    const pendingWatch=watchState(),watchFactory=options.watchFactory??watch,readWatchRoot=options.watchRootIdentity??physicalWatchRoot;
    if(typeof watchFactory!=='function'||typeof readWatchRoot!=='function')throw error('invalid_watch_factory');
    let watchedRoot;
    if(options.familyMode===true){
      try{watchedRoot=await readWatchRoot(root);startWatcher(watchedRoot.path,pendingWatch,watchFactory);}
      catch{pendingWatch.needsScan=true;}
    }
    let host;
    try {
      host=await RustVaultService.open(root, options);
      if(options.familyMode===true){
        try{
          const admittedRoot=await readWatchRoot(host.root);
          if(!watchedRoot||watchedRoot.path!==admittedRoot.path||watchedRoot.identity!==admittedRoot.identity){
            stopWatcher(pendingWatch);pendingWatch.needsScan=true;
            startWatcher(admittedRoot.path,pendingWatch,watchFactory);
          }
        }catch{stopWatcher(pendingWatch);pendingWatch.needsScan=true;}
      }
      if (documentRuntime) requireDocumentRuntime(host);
      for (const capability of ['read_path', 'list_snapshot', 'changes_after', 'rescan', 'prepare_intent', 'commit_intent', 'query_intent', 'list_intents', 'acknowledge_intent']) {
        if (!host.capabilities.includes(capability)) throw error('unsupported_host_capability');
      }
      const familyMode = options.familyMode === true;
      const service = new CoreVaultFixtureService(host, { pollMs, rescanMs, familyMode, documentRuntime, pendingWatch, watchFactory });
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
    } catch (reason) { stopWatcher(pendingWatch); await host?.close(); throw reason; }
  }
  constructor(host, { pollMs, rescanMs, familyMode = false, documentRuntime = false, pendingWatch=watchState(), watchFactory=watch, now=Date.now, historySetTimeout=setTimeout, historyClearTimeout=clearTimeout }) {
    if (documentRuntime) requireDocumentRuntime(host);
    this.documentRuntimeEnabled=documentRuntime;
    this.documentRuntimeOwners=new Set();
    this.documentScheduler=null;this.pendingIndexSource=false;this.pendingIndexProgress=false;this.pendingIndexProgressHost=null;this.hasStartedPolling=false;this.reconciliationRetry=null;this.continuation=null;this.continuationFailed=false;
    this.host = host;
    this.familyMode = familyMode;
    this.root = host.root;
    this.pollMs = pollMs;
    this.rescanMs = rescanMs;
    this.now=now;this.watchFactory=watchFactory;this.watchState=pendingWatch;
    this.lastScan = this.now();
    this.entries = new Map();
    this.cursor = '0';
    this.pageLimit = 100;
    this.listeners = new Set();
    this.hints = this.watchState.hints;
    this.closed = false;
    this.historyHost=host;this.historyOwner=null;this.historyEpoch=0;this.historyTimer=null;this.historyToken=null;this.historyRun=null;
    this.historyNextDue=this.now();this.historyLastError=null;this.historyLastStatus=null;this.historyQuietMs=Math.min(250,Math.floor(pollMs/2));
    this.historySetTimeout=historySetTimeout;this.historyClearTimeout=historyClearTimeout;
    this.historyAvailable=host.capabilities?.includes('local_recovery_maintenance')&&typeof host.localRecoveryMaintenance==='function'&&typeof host.localRecoveryIdleDelay==='function'&&typeof host.subscribeActivity==='function';
    this.historyUnsubscribe=this.historyAvailable?host.subscribeActivity(()=>{this.cancelLocalRecoveryTimer();this.scheduleLocalRecovery();}):null;

    this.reconciliation=host.reconciliation?structuredClone(host.reconciliation):null;
    if(documentRuntime&&host.exit&&typeof host.exit.then==='function')void host.exit.then(()=>{
      this.runtimeFailed=true;this.stopPolling();void this.documentScheduler?.close();
    });
  }
  get watcher(){return this.watchState.watcher;}
  get needsScan(){return this.watchState.needsScan;}
  set needsScan(value){this.watchState.needsScan=value;}
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
    if(needed){this.hasStartedPolling=true;this.startPolling();}
    // Broker listeners arrive before the first renderer runtime admission. Keep
    // the already-bound startup watcher continuous during that interval: no
    // polling timer or native maintenance is admitted until an owner exists.
    // After an actual polling lifetime, pause/removal still closes the watcher
    // and preserves its genuine missed-observation obligation.
    else if(this.hasStartedPolling||this.closed||this.runtimeFailed)this.stopPolling();
    this.syncLocalRecovery();
  }
  cancelLocalRecoveryTimer(){
    if(this.historyTimer!==null)this.historyClearTimeout(this.historyTimer);
    this.historyTimer=null;this.historyToken=null;
  }
  syncLocalRecovery(){
    const owner=this.historyAvailable&&this.documentRuntimeEnabled&&!this.closed&&!this.runtimeFailed&&this.host===this.historyHost?this.runtimeOwner():null;
    if(owner!==this.historyOwner){this.historyEpoch++;this.historyOwner=owner;this.cancelLocalRecoveryTimer();}
    this.scheduleLocalRecovery();
  }
  localRecoveryGuard(host,owner,epoch){
    if(this.closed||this.runtimeFailed||this.host!==host||this.historyHost!==host||this.historyOwner!==owner||this.historyEpoch!==epoch||owner.paused||!this.documentRuntimeOwners.has(owner))throw error('local_recovery_owner_changed');
    owner.assertActive();
  }
  scheduleLocalRecovery(){
    if(!this.historyAvailable||this.historyTimer!==null||this.historyRun||!this.historyOwner)return;
    const host=this.historyHost,owner=this.historyOwner,epoch=this.historyEpoch;
    try{this.localRecoveryGuard(host,owner,epoch);}catch{return;}
    const quiet=host.localRecoveryIdleDelay(this.historyQuietMs);if(quiet===null)return;
    const delay=Math.max(0,this.historyNextDue-this.now(),quiet),token={};this.historyToken=token;
    this.historyTimer=this.historySetTimeout(()=>{
      if(this.historyToken!==token)return;this.historyTimer=null;this.historyToken=null;
      try{this.localRecoveryGuard(host,owner,epoch);}catch{return;}
      const run=(async()=>{
        try{
          const status=await host.localRecoveryMaintenance(()=>this.localRecoveryGuard(host,owner,epoch),this.historyQuietMs);
          this.localRecoveryGuard(host,owner,epoch);
          this.historyLastStatus=Object.freeze({...status});
          if(status.ran)this.historyLastError=status.failed_notes?'local_recovery_note_skipped':null;
          else if(!status.available)this.historyLastError='local_recovery_unavailable';
          this.historyNextDue=this.now()+status.retry_after_ms;
          if(!status.available)this.historyAvailable=false;
        }catch(reason){
          if(!['local_recovery_deferred','local_recovery_owner_changed','client_ownership_lost','grant_retired','client_not_admitted','durable_scope_changed'].includes(reason?.code)){
            this.historyLastError=reason?.code??'local_recovery_unavailable';this.historyNextDue=this.now()+300000;
          }
        }
      })();
      this.historyRun=run;void run.finally(()=>{if(this.historyRun===run)this.historyRun=null;this.scheduleLocalRecovery();});
    },delay);
    this.historyTimer?.unref?.();
  }
  startPolling() {
    this.continuationFailed=false;
    if(this.timer){this.scheduleContinuation();return;}
    startWatcher(this.root,this.watchState,this.watchFactory);
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref();
    void this.poll();
  }
  stopPolling() {
    clearInterval(this.timer);this.timer=null;
    clearImmediate(this.continuation);this.continuation=null;
    // A later admission must reconcile the interval with no active watcher.
    if(this.watchState.active)this.needsScan=true;
    stopWatcher(this.watchState);this.syncLocalRecovery();
  }
  scheduleContinuation() {
    if(this.continuation||this.continuationFailed||!this.timer||this.closed||this.runtimeFailed||this.reconciliation?.work?.pending!==true)return;
    if(this.documentRuntimeEnabled&&!this.runtimeOwner())return;
    this.continuation=setImmediate(()=>{this.continuation=null;void this.poll();});
    this.continuation.unref();
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
      pause:async()=>{owner.paused=true;this.syncPolling();await Promise.all([handle.pause(),this.polling,this.historyRun]);},
      resume:()=>{owner.paused=false;handle.resume();if(!this.watchState.active||!this.watchState.healthy||!this.watcher)this.needsScan=true;this.syncPolling();},
      prepareRelease:async()=>{owner.paused=true;this.syncPolling();await Promise.all([handle.prepareRelease(),this.historyRun]);},
      release:()=>{handle.release();remove();},
      revoke:async()=>{remove();await Promise.all([handle.revoke(),this.historyRun]);},
    });
  }
  ensureDocumentScheduler(){
    if(!this.documentScheduler){
      const host=this.host;
      this.documentScheduler=new DocumentRuntimeScheduler({
        ...(this.documentRuntimeEnabled&&host.capabilities?.includes('document_drafts')?{workHost:host}:{}),
        isSourceImportPending:()=>this.host===host&&!this.closed&&!this.runtimeFailed&&sourceImportPending(this.reconciliation),
        onError:()=>{if(this.host===host&&(host.fatal||host.exited)){this.runtimeFailed=true;this.stopPolling();void this.documentScheduler.close().catch(()=>{});}},
      });
    }
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
  flushIndexSourceNotification(maintenanceGuard,retry=false){
    if(!this.pendingIndexSource&&!this.pendingIndexProgress&&!retry)return false;
    maintenanceGuard?.();
    if(this.closed||this.runtimeFailed||!this.documentScheduler)return false;
    if(this.pendingIndexProgress&&this.pendingIndexProgressHost!==this.host){
      this.pendingIndexProgress=false;this.pendingIndexProgressHost=null;this.needsScan=true;
    }
    // Progress alone is not evidence to reset a failed transport. Genuine
    // journal advancement retains its existing Wake/retry behavior.
    if(this.pendingIndexSource)this.documentScheduler.wake();
    else if(this.pendingIndexProgress)this.documentScheduler.sourceImportProgress();
    else if(retry)this.documentScheduler.wake();
    else return false;
    this.pendingIndexSource=false;this.pendingIndexProgress=false;this.pendingIndexProgressHost=null;return true;
  }
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
    this.polling = this.pollNow(host,maintenanceGuard).then(result=>{
      if(result?.scanned)this.continuationFailed=false;
      if(this.cursor!==before||result?.reloaded)this.pendingIndexSource=true;
      const indexNotified=this.flushIndexSourceNotification(maintenanceGuard,result?.scanned&&this.documentScheduler?.needsRetry?.());
      return {indexNotified};
    }).catch(reason => {
      this.continuationFailed=reason?.code!=='client_ownership_lost';
      if(this.host.fatal||this.host.exited){this.runtimeFailed=true;this.stopPolling();void this.documentScheduler?.close();}
      // Accepted journal progress remains an indexing obligation even when later
      // filesystem maintenance fails. A retired owner cannot deliver it; retain
      // it for the next admitted poll instead of consuming the cursor silently.
      if(this.cursor!==before)this.pendingIndexSource=true;
      let indexNotified=false;
      try{indexNotified=this.flushIndexSourceNotification(maintenanceGuard);}catch{/* Retain for an active owner. */}
      if (!this.closed) this.notify({ type: 'error', message: 'Native vault reconciliation needs attention.', code: reason?.code ?? 'reconciliation_failed' });
      return {indexNotified};
    }).finally(() => { this.polling = null;this.scheduleContinuation(); });
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
        this.notify({ type: 'change' });
        return null;
      }
    }
  }
  updateReconciliation(status) {
    if(!status)return;
    const previous=this.reconciliation,oldWork=previous?.work,newWork=status.work;
    if((sourceImportPending(previous)&&!sourceImportPending(status))
      ||(oldWork?.pending===true&&newWork?.pending===false)
      ||(newWork?.phase==='publication'&&oldWork?.phase!=='publication')){
      this.pendingIndexProgress=true;this.pendingIndexProgressHost=this.host;
    }
    this.reconciliation=structuredClone(status);
    this.notify({type:'reconciliation',reconciliation:structuredClone(status)});
  }
  async scanNow(host=this.host,maintenanceGuard=null) {
    const authorityHost=this.host;
    const current=()=>{maintenanceGuard?.();if(this.closed||this.runtimeFailed||this.host!==authorityHost)throw error('client_ownership_lost');};
    try {
      current();
      // Rescan is trusted main-process maintenance, not an admitted client RPC.
      // Retain the selected owner's guard through the actual transport queue
      // and response; journal reads below still use that owner's leased host.
      const scan=maintenanceGuard
        ?(await authorityHost.request({method:'rescan'},undefined,undefined,current)).result
        :await host.rescan();
      current();
      this.lastScan=this.now();
      this.updateReconciliation(scan.reconciliation);
      if(!scan.complete&&scan.reconciliation?.work?.pending!==true)this.notify({type:'error',code:'scan_incomplete',message:'Native vault scan is incomplete; existing files are retained.'});
      return scan;
    } catch(reason) {
      // A response can arrive after the selected owner retires. Its native
      // inventory may already be partial even though this owner cannot publish
      // the status. Preserve observation duty for the next admitted owner.
      this.needsScan=true;
      this.continuationFailed=reason?.code!=='client_ownership_lost';
      current();
      if(this.reconciliation)this.updateReconciliation({...this.reconciliation,complete:false,...(this.reconciliation.work?{work:{...this.reconciliation.work,phase:'blocked',pending:false}}:{}),failure:'scan_failed'});
      // Poll merges this with any already accepted journal duty. An explicit
      // scan failure has no following poll, so deliver its progress-only wake.
      if(!this.polling)this.flushIndexSourceNotification(current);
      throw reason;
    }
  }
  recoveryList(entryId,options) {this.live();return this.host.recoveryList(entryId,options);}
  recoveryRead(entryId,snapshotId) {this.live();return this.host.recoveryRead(entryId,snapshotId);}
  async retryReconciliation() {
    this.live();
    // Multiple viewers may retry the same incomplete import. Share only the
    // currently accepted explicit retry; a later request is a fresh file check.
    if(this.reconciliationRetry)return this.reconciliationRetry;
    this.continuationFailed=false;
    const retry=(async()=>{
      // A continuation already owns the accepted inventory. Join its guarded
      // poll rather than queueing a second rescan of the same native work.
      if(this.reconciliation?.work?.pending===true){
        await this.poll();
        return this.reconciliation?structuredClone(this.reconciliation):null;
      }
      // Consume only the obligation that existed before this explicit pass.
      // Watch errors/new gaps during the awaited scan can set it again.
      this.needsScan=false;
      await this.scanNow();
      const polled=await this.poll();
      if(!polled?.indexNotified)
        this.flushIndexSourceNotification(null,this.documentScheduler?.needsRetry?.());
      return this.reconciliation?structuredClone(this.reconciliation):null;
    })();
    this.reconciliationRetry=retry;
    try{return await retry;}
    finally{if(this.reconciliationRetry===retry)this.reconciliationRetry=null;}
  }
  async pollNow(host=this.host,maintenanceGuard=null) {
    let scanned=false,pagesRemaining=8,journalComplete=true;
    const readChanges=async()=>{
      // One shared page budget across pre/post-maintenance journal reads.
      while(pagesRemaining>0&&!this.closed){
        pagesRemaining--;
        const page=await this.changePage(host);
        if(!page)return true;
        for(const change of page.changes){
          let full=change.requires_full_reload;
          const paths=new Set();
          if(full){this.adopt(await host.listSnapshot());this.notify({type:'change'});return true;}
          for(const value of change.entries){
            const before=this.entries.get(value.state.id);
            if(before&&before.state.path!==value.state.path)full=true;
            if(value.state.kind==='folder')full=true;
            if(value.state.deleted)this.entries.delete(value.state.id);
            else this.entries.set(value.state.id,value);
            if(visible(value.state.path))paths.add(value.state.path);
            if(before&&visible(before.state.path))paths.add(before.state.path);
          }
          this.cursor=change.cursor;
          if(full)this.notify({type:'rename',origin:change.origin,cursor:change.cursor});
          else for(const path of paths)this.notify({type:'change',path,origin:change.origin,cursor:change.cursor});
        }
        this.cursor=page.next_cursor;journalComplete=!page.has_more;
        if(journalComplete)break;
      }
      return false;
    };
    // Consume committed local commands before watcher echoes: a just-created or
    // renamed file can then take the exact native known-file observation path.
    if(await readChanges())return {scanned,reloaded:true};
    if(!journalComplete)return {scanned,reloaded:false};
    if(!this.watchState.watcher&&this.now()-this.lastScan>=this.rescanMs)
      startWatcher(this.root,this.watchState,this.watchFactory);
    const hints=[...this.hints];
    // Watch hints provide prompt discovery; a less frequent complete audit still
    // repairs silent watcher loss. Failed/unsupported watchers and partial scans
    // retain the original thirty-second fallback (or configured interval).
    const auditMs=this.familyMode&&this.watchState.healthy&&this.reconciliation?.complete===true
      ?Math.max(this.rescanMs,HEALTHY_WATCH_AUDIT_MS):this.rescanMs;
    const due=this.now()-this.lastScan>=auditMs;
    if(this.continuationFailed&&!due)return {scanned,reloaded:false};
    const known=new Set(hints.length?[...this.entries.values()].filter(row=>row.state.kind==='file'&&!row.state.deleted).map(row=>row.state.path):[]);
    const knownFiles=hints.length&&hints.every(path=>known.has(path));
    if(this.reconciliation?.work?.pending===true){
      // Hints collected while an inventory is in progress still belong to the
      // next observation. Do not acknowledge them with an older inventory.
      await this.scanNow(host,maintenanceGuard);scanned=true;
    }else if(this.needsScan||due||this.familyMode&&hints.length&&!knownFiles){
      this.hints.clear();this.needsScan=false;
      await this.scanNow(host,maintenanceGuard);scanned=true;
    }else if(hints.length){
      const selected=this.familyMode?hints.slice(0,MAX_KNOWN_HINTS_PER_POLL):hints;
      for(const path of selected)this.hints.delete(path);
      let report;
      try{
        maintenanceGuard?.();
        // The trusted owner retains its dispatch guard, without incorrectly
        // routing filesystem maintenance through a renderer client lease.
        report=maintenanceGuard
          ?(await this.host.request({method:'reconcile',paths:selected},undefined,undefined,maintenanceGuard)).result
          :await host.reconcile(selected);
        maintenanceGuard?.();
      }catch(reason){this.needsScan=true;throw reason;}
      if(report.blocked.length){
        this.notify({type:'error',code:'reconciliation_blocked',message:'Native vault reconciliation retained conflicting data.'});
        // Missing/replaced files can be one side of a namespace change. Native
        // known-file observation preserves those proofs; full discovery resolves.
        this.needsScan=false;await this.scanNow(host,maintenanceGuard);scanned=true;
      }else if(!this.familyMode)this.needsScan=true;
      if(await readChanges())return {scanned,reloaded:true};
      return {scanned,reloaded:false};
    }
    if(scanned&&await readChanges())return {scanned,reloaded:true};
    return {scanned,reloaded:false};
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
    this.listeners.clear();this.historyUnsubscribe?.();this.historyUnsubscribe=null;
    this.closing = (async () => { await this.documentScheduler?.close();this.documentRuntimeOwners.clear();if (this.polling) await this.polling;if(this.historyRun)await this.historyRun; await this.host.close(); })();
    return this.closing;
  }
}
module.exports = { CoreVaultFixtureService };
