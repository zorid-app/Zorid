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
async function fixture({persistFailure = false, navigationFailure = false, lateOpeningFailure = false, slotsGate, restoreGate, claimGate, returnEarly = false, openFailure = false, windowFailure = false, primaryVault = '/fixture', lastVault = '/fixture', registryFailure = false, claimFailure = false} = {}) {
  const gate = deferred(), opened = deferred(), windows = [], handlers = new Map(), errors = [];
  let reads = 0, contexts = 0, opens = 0, lastVaultReads = 0;
  const events = [];
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); events.push('construct'); if (windowFailure) throw new Error('window failed'); this.destroyed = false; this.loaded = false;
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
    if (name === 'node:fs/promises') return {readFile:async () => { lastVaultReads++; return JSON.stringify({path:lastVault}); }};
    if (name === './editor-core.cjs') return {createEditorCoreManager:() => ({
      async open(directory) { opens++; events.push('open'); service.root = directory; opened.resolve(); if (openFailure) throw new Error('native open failed'); await gate.promise; return service; }, owns:() => false,
      async context() { contexts++; return {admissionId:'owned',scope:{vaultId:'fixture-store',clientId:'client'}}; }, bindIndependentJournal:(_broker,_record,_root,id) => id, async retire() {}, async close() { events.push('close'); await gate.promise; events.push('closed'); },
    })};
    if (name === './client-slots.cjs') return {openClientSlots:async () => { await slotsGate?.promise; if (registryFailure) throw new Error('registry unavailable'); return {listRestorable:async () => { await restoreGate?.promise; return []; },
      listExisting:async () => [{slotId:'primary',clientId:'client',vaultPath:primaryVault}],
      claim:async () => { events.push('claim'); await claimGate?.promise; if (claimFailure) throw new Error('claim unavailable'); return {slotId:'primary',clientId:'client',vaultPath:primaryVault}; },
      async setVault() { if (persistFailure) throw new Error('slot write failed'); }, async release() {},
    }; }};
    if (name === './draft-journal-admission.cjs') return {createDraftJournalAdmissionManager:() => ({attach:(_record,context) => ({token:'journal-token',scope:{...context.scope,incarnationId:'document'}}),revoke() {}})};
    if (name === './window-broker.cjs') return {WindowBroker};
    if (name === './context-menu.cjs') return {createContextMenuController:() => ({close() {}})};
    if (name === './vault-service.cjs') return {};
    if (name.startsWith('./')) return require(path.resolve(path.dirname(mainPath), name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {require:nativeRequire, __dirname:path.dirname(mainPath),
    process:{platform:'darwin',env:{}}, URL, structuredClone, setImmediate});
  if (!returnEarly) await opened.promise; await turn();
  const window = windows[0];
  const invoke = (method, ...args) => handlers.get(`zorid:${method}`)({sender:window.webContents,senderFrame:window.webContents.mainFrame}, ...args);
  return {window, windows, invoke, gate, errors, events, opened, app, get opens() { return opens; }, get lastVaultReads() { return lastVaultReads; }, get reads() { return reads; }, get contexts() { return contexts; }};
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


test('startup reads last-vault configuration while the client registry is still loading', async () => {
  const slotsGate = deferred();
  const f = await fixture({slotsGate, returnEarly:true});
  assert.equal(f.lastVaultReads, 1, 'independent configuration reads must begin together');
  assert.equal(f.windows.length, 0);
  slotsGate.resolve(); await f.opened.promise; f.gate.resolve(); await turn();
  f.windows[0].destroy();
});

test('primary native preopen overlaps durable client-slot claim and precedes window construction', async () => {
  const claimGate = deferred();
  const f = await fixture({claimGate, returnEarly:true});
  assert.equal(f.opens, 1, 'open the selected native vault while claim persistence is pending');
  assert.equal(f.windows.length, 0, 'the window still waits for its durable client identity');
  claimGate.resolve(); await turn();
  assert.equal(f.windows[0].loaded, true);
  assert.deepEqual(f.events.slice(0,3), ['open','claim','construct']);
  f.gate.resolve(); await turn();
  assert.equal(f.opens, 1, 'binding consumes the same preopen rather than reopening the host');
  f.windows[0].destroy();
});

test('failed preopen is observed once and falls back to the vault picker after registration', async () => {
  const f = await fixture({openFailure:true});
  await turn();
  assert.equal(f.opens, 1);
  assert.equal(f.invoke('getVault'), null);
  assert.equal(f.errors.filter(([title]) => title === 'Could not open Rust vault').length, 1);
  f.window.destroy();
});

test('window construction failure observes pending preopen and uses startup cleanup', async () => {
  const f = await fixture({windowFailure:true,returnEarly:true});
  assert.equal(f.opens, 1);
  assert.equal(f.errors.filter(([title]) => title === 'Could not start Zorid').length, 1);
  f.gate.resolve(); await turn();
});


test('quit during pending preopen closes Native and prevents a late window after slot claim', async () => {
  const claimGate = deferred();
  const f = await fixture({claimGate,returnEarly:true});
  assert.equal(f.opens, 1);
  let prevented = false;
  f.app.emit('will-quit', {preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.ok(f.events.includes('close'));
  claimGate.resolve(); await turn();
  assert.equal(f.windows.length, 0);
  f.gate.resolve(); await turn(); await turn();
  assert.ok(f.events.includes('closed'));
});


test('saved primary slot takes precedence over last-vault configuration for preopen and binding', async () => {
  const f = await fixture({primaryVault:'/primary',lastVault:'/last'});
  f.gate.resolve(); await turn();
  assert.equal(f.invoke('getVault').path, '/primary');
  assert.equal(f.opens, 1);
  f.window.destroy();
});

test('last vault supplies the primary preopen only when the primary slot has no saved vault', async () => {
  const f = await fixture({primaryVault:null,lastVault:'/last'});
  f.gate.resolve(); await turn();
  assert.equal(f.invoke('getVault').path, '/last');
  assert.equal(f.opens, 1);
  f.window.destroy();
});

test('empty startup does not open a Native service', async () => {
  const f = await fixture({primaryVault:null,lastVault:null,returnEarly:true});
  assert.equal(f.opens, 0);
  assert.equal(f.windows.length, 1);
  assert.equal(f.invoke('getVault'), null);
  f.window.destroy();
});

test('invalid registry never speculatively opens the last-vault path', async () => {
  const f = await fixture({registryFailure:true,returnEarly:true});
  assert.equal(f.opens, 0);
  assert.equal(f.windows.length, 0);
  assert.equal(f.errors.filter(([title]) => title === 'Could not start Zorid').length, 1);
});

test('failed durable slot claim leaves the preopen owned by manager shutdown', async () => {
  const f = await fixture({claimFailure:true,returnEarly:true});
  assert.equal(f.opens, 1);
  assert.equal(f.windows.length, 0);
  assert.equal(f.errors.filter(([title]) => title === 'Could not start Zorid').length, 1);
  f.app.emit('will-quit', {preventDefault() {}});
  assert.ok(f.events.includes('close'));
  f.gate.resolve(); await turn(); await turn();
  assert.ok(f.events.includes('closed'));
});
