// Disposable-vault counterpart: Electron's own main process talks directly to
// the existing Rust stdio host. No additional Node broker or HTTP server.
const {app, BrowserWindow, ipcMain, Menu} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const MAX_HEADER = 1024 * 1024, MAX_BODY = 32 * 1024 * 1024, MAX_QUEUED = 64 * 1024 * 1024;
const failure = (code, uncertain = false) => Object.assign(new Error(code), {code, commitUncertain: uncertain});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let window, host, allowedClose = false, pendingClose, lifecycleReady = false, quitRequested = false;
let data, root, client, entryURL;
const bench = process.env.ZORID_NATIVE_BENCH === '1';

function trustedDirectory(value, create = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw failure('native_fixture_path');
  if (create) fs.mkdirSync(value, {recursive: true});
  const canonical = fs.realpathSync(value);
  if (!canonical.startsWith('/private/tmp/') || !canonical.includes('zorid-tauri-native-')
    || !fs.statSync(canonical).isDirectory()) throw failure('native_fixture_path');
  return canonical;
}
function clientIdentity(directory) {
  const file = path.join(directory, 'native-client-id');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(existing))
      throw failure('native_client_identity');
    return existing.toLowerCase();
  }
  const value = randomUUID(), fd = fs.openSync(file, 'wx', 0o600);
  try {fs.writeFileSync(fd, value); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  return value;
}
function frame(header, body) {
  const bytes = Buffer.from(header, 'utf8'), prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(bytes.length, 0); prefix.writeUInt32BE(body.length, 4);
  return Buffer.concat([prefix, bytes, body]);
}
class RustHost {
  constructor(executable) {
    this.buffer = Buffer.alloc(0); this.tail = Promise.resolve(); this.queuedBytes = 0; this.queuedCount = 0;
    this.lease = null; this.reconciliation = null; this.fatal = null; this.closing = false; this.closed = false;
    this.startup = new Promise((resolve, reject) => {this.waiter = {id: '0', resolve, reject};});
    this.child = spawn(executable, ['--vault', root, '--initialize-local'], {
      env: {...process.env, ZORID_LOCAL_DATA_DIR: data}, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.exit = new Promise(resolve => {this.child.once('exit', (code, signal) => {
      this.closed = true; resolve({code, signal});
      if (!this.closing || code !== 0 || this.waiter) this.abort(failure('native_host_exited', true));
    });});
    this.child.once('error', () => this.abort(failure('native_host_spawn', false)));
    this.child.stdout.on('data', bytes => this.receive(bytes));
    this.child.stdout.on('error', () => this.abort(failure('native_host_stdout', true)));
    this.child.stdin.on('error', () => this.abort(failure('native_host_stdin', true)));
    this.child.stderr.on('data', bytes => process.stderr.write(bytes));
    this.ready = this.startup.then(reply => {
      if (reply.envelope.ok !== true || reply.envelope.result?.transport !== 'zorid-native-stdio' || reply.body.length)
        throw failure('native_core_unavailable');
      this.reconciliation = reply.envelope.result.reconciliation;
    });
    this.ready.catch(() => {});
  }
  abort(error) {
    this.fatal ??= error;
    if (this.waiter) {this.waiter.reject(error); this.waiter = null;}
  }
  receive(bytes) {
    if (this.fatal) return;
    try {
      if (this.buffer.length + bytes.length > MAX_HEADER + MAX_BODY + 8) throw failure('native_response_limit', true);
      this.buffer = Buffer.concat([this.buffer, bytes]);
      while (this.buffer.length >= 8) {
        const head = this.buffer.readUInt32BE(0), body = this.buffer.readUInt32BE(4);
        if (head < 1 || head > MAX_HEADER || body > MAX_BODY) throw failure('native_response_limit', true);
        if (this.buffer.length < 8 + head + body) return;
        const header = this.buffer.subarray(8, 8 + head).toString('utf8');
        const envelope = JSON.parse(header), waiter = this.waiter;
        if (!waiter || envelope.version !== 1 || envelope.request_id !== waiter.id || typeof envelope.ok !== 'boolean')
          throw failure('native_response_invalid', true);
        const payload = Buffer.from(this.buffer.subarray(8 + head, 8 + head + body));
        this.buffer = this.buffer.subarray(8 + head + body); this.waiter = null;
        waiter.resolve({header, body: payload, envelope});
      }
    } catch (error) {this.abort(error.code ? error : failure('native_response_invalid', true));}
  }
  enqueue(action, charge = 0, closing = false) {
    if (this.fatal || this.closed || this.closing && !closing) return Promise.reject(this.fatal || failure('native_core_unavailable'));
    if (this.queuedCount >= 32 || this.queuedBytes + charge > MAX_QUEUED) return Promise.reject(failure('native_queue_full'));
    this.queuedCount++; this.queuedBytes += charge;
    const task = this.tail.then(async () => {await this.ready; if (this.fatal) throw this.fatal; return action();});
    this.tail = task.catch(() => {});
    return task.finally(() => {this.queuedCount--; this.queuedBytes -= charge;});
  }
  async exchange(header, body) {
    if (this.fatal || this.waiter) throw this.fatal || failure('native_host_busy');
    const parsed = JSON.parse(header);
    const response = new Promise((resolve, reject) => {this.waiter = {id: parsed.request_id, resolve, reject};});
    const timeout = setTimeout(() => this.abort(failure('native_response_timeout', true)), 60000);
    try {
      this.child.stdin.write(frame(header, body), error => {if (error) this.abort(failure('native_host_write', true));});
      return await response;
    } finally {clearTimeout(timeout);}
  }
  request(input) {
    if (!input || typeof input.header !== 'string' || typeof input.body !== 'string'
      || Object.keys(input).length !== 2 || Buffer.byteLength(input.header) > MAX_HEADER || input.body.length > Math.ceil(MAX_BODY / 3) * 4)
      return Promise.reject(failure('native_frame_limit'));
    let header, body;
    try {
      header = JSON.parse(input.header); body = Buffer.from(input.body, 'base64');
      if (body.toString('base64') !== input.body || header.version !== 1 || !/^[1-9][0-9]{0,63}$/.test(header.request_id)
        || typeof header.command?.method !== 'string') throw failure('native_request_invalid');
    } catch {return Promise.reject(failure('native_request_invalid'));}
    const method = header.command.method;
    if (body.length > (method.startsWith('checkpoint_') ? MAX_BODY : MAX_BODY / 2)) return Promise.reject(failure('native_frame_limit'));
    // The stdio host is trusted-main capable. Preserve EmbeddedHost's renderer boundary.
    if (['apply', 'fixture_family_enroll', 'fixture_family_once', 'fixture_family_apply', 'fixture_family_status',
      'reconcile', 'recover', 'rescan', 'document_drafts', 'document_work'].includes(method)
      || method === 'documents' && String(header.command.request?.command?.op).startsWith('preview_'))
      return Promise.reject(failure('client_operation_unsupported'));
    if (method === 'claim_client' && header.command.client_id !== client) return Promise.reject(failure('native_client_mismatch'));
    return this.enqueue(async () => {
      const reply = await this.exchange(input.header, body);
      if (reply.envelope.ok && method === 'claim_client') {
        const lease = reply.envelope.result?.lease;
        if (lease?.client_id !== client || typeof lease.token !== 'string' || typeof lease.local_store_id !== 'string')
          throw failure('native_response_invalid', true);
        this.lease = lease;
      }
      if (reply.envelope.ok && method === 'release_client' && reply.envelope.result?.released === true
        && equal(this.lease, reply.envelope.result.reference)) this.lease = null;
      return {header: reply.header, body: reply.body.toString('base64')};
    }, Buffer.byteLength(input.header) + input.body.length);
  }
  refresh() {
    return this.enqueue(async () => {
      const reply = await this.exchange(JSON.stringify({version: 1, request_id: '18446744073709551613', command: {method: 'rescan'}}), Buffer.alloc(0));
      if (!reply.envelope.ok || !reply.envelope.result?.reconciliation) throw failure('native_refresh_failed');
      this.reconciliation = reply.envelope.result.reconciliation;
      return {reconciliation: this.reconciliation};
    });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.enqueue(async () => {
      if (this.lease) {
        const reference = this.lease;
        const reply = await this.exchange(JSON.stringify({version: 1, request_id: '18446744073709551614', command: {method: 'release_client', reference}}), Buffer.alloc(0));
        if (!reply.envelope.ok || reply.envelope.result?.released !== true || !equal(reference, reply.envelope.result.reference))
          throw failure('native_release_failed', true);
        this.lease = null;
      }
      this.child.stdin.end();
      const outcome = await Promise.race([this.exit, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(failure('native_close_timeout', true)), 10000); timer.unref();
      })]);
      if (outcome.code !== 0 || outcome.signal !== null) throw failure('native_close_failed', true);
      return {released: true};
    }, 0, true);
    return this.closePromise.catch(error => {this.closePromise = null; this.closing = false; throw error;});
  }
}

function authorize(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== entryURL)
    throw failure('native_sender');
}
async function benchmark(command, args) {
  if (!bench) throw failure('native_bench_disabled');
  if (command === 'tauri_bench_close') {window.close(); return {requested: true};}
  if (command === 'tauri_bench_control') {
    const file = path.join(data, 'control.json');
    try {if ((await fsp.stat(file)).size > 2 * 1024 * 1024) throw failure('native_bench_limit'); return JSON.parse(await fsp.readFile(file, 'utf8'));}
    catch (error) {if (error.code === 'ENOENT') return {phase: null}; throw error;}
  }
  const input = args?.input, encoded = JSON.stringify(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || encoded.length > 2 * 1024 * 1024) throw failure('native_bench_limit');
  const phase = input.phase, name = ['single', 'tabs', 'large'].includes(phase) ? 'phase-' + phase + '.json'
    : phase === undefined || phase === 'save' ? 'report.json' : null;
  if (!name) throw failure('native_bench_phase');
  const file = path.join(data, name), temporary = file + '.tmp';
  await fsp.writeFile(temporary, encoded); await fsp.rename(temporary, file); return {written: true};
}
async function main() {
  root = trustedDirectory(process.env.ZORID_NATIVE_VAULT); data = trustedDirectory(process.env.ZORID_NATIVE_DATA, true);
  client = clientIdentity(data);
  app.setName('Zorid Native Electron Prototype'); app.setPath('userData', path.join(data, 'electron-profile'));
  const executable = process.env.ZORID_NATIVE_HOST || '/Users/ctk/Applications/Zorid.app/Contents/Resources/native/zorid-desktop-host';
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw failure('native_host_path');
  const index = path.resolve(__dirname, '../dist/index.html'); entryURL = pathToFileURL(index).href;
  host = new RustHost(executable);
  ipcMain.handle('zorid-native:invoke', async (event, command, args) => {
    authorize(event);
    if (['tauri_bench_control', 'tauri_bench_report', 'tauri_bench_close'].includes(command)) return benchmark(command, args);
    if (command === 'tauri_lifecycle_ready') {lifecycleReady = true; return;}
    if (command === 'tauri_lifecycle_ack') {
      const input = args?.input;
      if (!input || input.id !== pendingClose || typeof input.ok !== 'boolean') throw failure('native_close_token');
      if (!input.ok) {pendingClose = null; return {closed: false};}
      try {await host.close(); allowedClose = true; setImmediate(() => window.close()); return {closed: true};}
      catch (error) {pendingClose = null; throw error;}
    }
    if (command === 'tauri_context') return host.enqueue(() => ({name: path.basename(root), clientId: client,
      reconciliation: host.reconciliation, documentSemantics: true}));
    if (command === 'tauri_refresh') return host.refresh();
    if (command === 'tauri_request') return host.request(args?.input);
    throw failure('native_command_unsupported');
  });
  await app.whenReady(); Menu.setApplicationMenu(null);
  window = new BrowserWindow({width: 1280, height: 870, useContentSize: true, minWidth: 640, minHeight: 480,
    title: 'Zorid Native Electron Prototype — disposable fixtures',
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: bench ? ['--zorid-native-bench'] : []}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => {if (url !== entryURL) event.preventDefault();});
  window.on('close', event => {
    if (allowedClose) return;
    event.preventDefault(); if (!lifecycleReady || pendingClose) return;
    pendingClose = randomUUID();
    window.webContents.send('zorid-native:event', {event: 'tauri:lifecycle', payload: {id: pendingClose, reason: 'switchVault'}});
  });
  window.webContents.on('console-message', (_event, ...args) => console.log('renderer', ...args));
  await window.loadFile(index);
}
app.on('before-quit', event => {
  if (allowedClose) return;
  event.preventDefault(); if (window && !window.isDestroyed()) window.close(); quitRequested = true;
});
app.on('window-all-closed', () => {if (allowedClose || quitRequested) app.quit();});
main().catch(error => {
  console.error('Native Electron prototype failed:', error.code || error.message);
  host?.child.kill('SIGTERM'); app.exit(1);
});
