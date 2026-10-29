const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {WindowBroker} = require('../desktop/window-broker.cjs');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
const turn = () => new Promise(resolve => setImmediate(resolve));

// Execute actual main wiring with native open held, rather than measuring a
// substitute startup implementation. Packaged timing remains a separate gate.
async function fixture({persistFailure = false, navigationFailure = false, lateOpeningFailure = false} = {}) {
  const gate = deferred(), opened = deferred(), windows = [], handlers = new Map(), errors = [];
  let reads = 0, contexts = 0;
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.loaded = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {id:windows.length + 1, mainFrame:{url:''},
        isDestroyed:() => this.destroyed, setWindowOpenHandler() {}, send() {}});
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    loadFile(file) {
      if (navigationFailure) throw new Error('navigation failed synchronously');
      this.loaded = true; this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href;
      return Promise.resolve();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static getFocusedWindow() { return windows.find(w => !w.destroyed); }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
  }
  const app = new EventEmitter();
  Object.assign(app, {setName() {}, whenReady:() => Promise.resolve(), getPath:() => '/state', requestSingleInstanceLock:() => true, quit() {}});
  const service = {root:'/fixture', subscribe:() => () => {}, async read() { reads++; return 'body'; }};
  const mainPath = path.resolve(__dirname, '../desktop/main.cjs');
  const nativeRequire = name => {
    if (name === 'electron') return {app, BrowserWindow:FakeWindow, ipcMain:{handle:(key, callback) => handlers.set(key, callback)},
      dialog:{showErrorBox:(...args) => {
        errors.push(args);
        if (lateOpeningFailure && args[0] === 'Could not open Rust vault') throw new Error('late opening failure');
      }}, Menu:{buildFromTemplate:x => x, setApplicationMenu() {}}, shell:{}};
    if (name === 'node:fs/promises') return {readFile:async () => '{"path":"/fixture"}'};
    if (name === './editor-core.cjs') return {createEditorCoreManager:() => ({
      async open() { opened.resolve(); await gate.promise; return service; }, owns:() => false,
      async context() { contexts++; return {admissionId:'owned'}; }, async retire() {}, async close() {},
    })};
    if (name === './client-slots.cjs') return {openClientSlots:async () => ({listRestorable:async () => [],
      claim:async () => ({slotId:'primary',clientId:'client',vaultPath:'/fixture'}),
      async setVault() { if (persistFailure) throw new Error('slot write failed'); }, async release() {},
    })};
    if (name === './window-broker.cjs') return {WindowBroker};
    if (name === './context-menu.cjs') return {createContextMenuController:() => ({close() {}})};
    if (name === './vault-service.cjs') return {};
    if (name.startsWith('./')) return require(path.resolve(path.dirname(mainPath), name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {require:nativeRequire, __dirname:path.dirname(mainPath),
    process:{platform:'darwin',env:{}}, URL, structuredClone, setImmediate});
  await opened.promise; await turn();
  const window = windows[0];
  const invoke = (method, ...args) => handlers.get(`zorid:${method}`)({sender:window.webContents,senderFrame:window.webContents.mainFrame}, ...args);
  return {window, invoke, gate, errors, get reads() { return reads; }, get contexts() { return contexts; }};
}

test('renderer navigation overlaps native open while vault reads and admission wait for the full barrier', async () => {
  const f = await fixture();
  assert.equal(f.window.loaded, true, 'Chromium must begin loading before native open resolves');
  assert.equal(f.invoke('getWindowInfo').id, 'main');
  let settled = false;
  const selected = f.invoke('getVault').then(value => { settled = true; return value; });
  const read = f.invoke('read','/fixture','Note.md');
  const context = f.invoke('getDurableContext','/fixture');
  await turn();
  assert.equal(settled, false); assert.equal(f.reads, 0); assert.equal(f.contexts, 0);
  f.gate.resolve();
  assert.equal((await selected).path, '/fixture'); assert.equal(await read, 'body');
  assert.equal((await context).ok, true); assert.equal(f.contexts, 1);
  assert.deepEqual(f.errors, []); f.window.destroy();
});

test('opening barrier reauthenticates the renderer after its asynchronous wait', async () => {
  const f = await fixture();
  assert.equal(f.window.loaded, true);
  const selected = f.invoke('getVault');
  f.window.webContents.mainFrame.url = 'https://untrusted.example/';
  f.gate.resolve();
  await assert.rejects(selected, /Untrusted page/);
  assert.equal(f.reads, 0); assert.equal(f.contexts, 0); f.window.destroy();
});

test('failed opening cannot expose a partially bound vault or admit queued operations', async () => {
  const f = await fixture({persistFailure:true});
  assert.equal(f.window.loaded, true);
  const selected = f.invoke('getVault'), read = f.invoke('read','/fixture','Note.md');
  const selectedFailure = assert.rejects(selected, /slot write failed/);
  const readFailure = assert.rejects(read, /slot write failed/);
  f.gate.resolve(); await Promise.all([selectedFailure, readFailure]); await turn();
  assert.equal(f.reads, 0); assert.equal(f.contexts, 0); assert.equal(f.window.destroyed, true);
});

test('synchronous navigation failure still joins a late opening rejection', async () => {
  const f = await fixture({navigationFailure:true,lateOpeningFailure:true});
  assert.equal(f.window.destroyed, true);
  f.gate.resolve(); await turn(); await turn();
  assert.equal(f.reads, 0); assert.equal(f.contexts, 0);
  assert.ok(f.errors.some(([title]) => title === 'Could not start Zorid'));
  // node:test also treats any unhandled late rejection as a failing test.
});
