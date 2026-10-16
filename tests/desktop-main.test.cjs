const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WindowBroker } = require('../desktop/window-broker.cjs');

test('main wiring creates empty authenticated windows and scopes vault picking to its caller', async () => {
  const windows = [], handlers = new Map();
  let template, pickerOwner, nextPick = '/second';
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length + 1, mainFrame: { url: '' },
        isDestroyed: () => this.destroyed, setWindowOpenHandler() {}, send() {} });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static getFocusedWindow() { return windows.find(window => !window.destroyed); }
    static getAllWindows() { return windows.filter(window => !window.destroyed); }
  }
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, whenReady: () => Promise.resolve(), getPath: () => '/state', quit() {} });
  const services = new Map();
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showOpenDialog: async owner => { pickerOwner = owner; return { filePaths: [nextPick], canceled: false }; }, showErrorBox: assert.fail },
    Menu: { buildFromTemplate: value => { template = value; return value; }, setApplicationMenu() {} }, shell: { openExternal() {} } };
  const mainPath = path.resolve(__dirname, '../desktop/main.cjs');
  const nativeRequire = name => {
    if (name === 'electron') return electron;
    if (name === 'node:fs/promises') return { readFile: async () => '{"path":"/first"}', mkdir: async () => {}, writeFile: async () => {} };
    if (name === './window-broker.cjs') return { WindowBroker };
    if (name === './context-menu.cjs') return { createContextMenuController: () => ({ close() {}, popup() {} }) };
    if (name === './vault-service.cjs') return { VaultService: { open: async root => {
      if (!services.has(root)) services.set(root, { root, watchers: 0, stops: 0, subscribe() { this.watchers++; return () => { this.watchers--; this.stops++; }; }, read: async () => 'base', write: async () => {} });
      return services.get(root);
    } } };
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), { require: nativeRequire, __dirname: path.dirname(mainPath), process: { platform: 'darwin', env: {} }, URL });
  await new Promise(resolve => setImmediate(resolve));
  const invoke = (window, name, ...args) => handlers.get(`zorid:${name}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  assert.equal(windows.length, 1);
  assert.deepEqual(invoke(windows[0], 'getWindowInfo'), { id: 'main', initialState: 'restore' });
  const created = await invoke(windows[0], 'newWindow');
  assert.equal(windows.length, 2);
  assert.equal(invoke(windows[1], 'getWindowInfo').initialState, 'empty');
  assert.equal(invoke(windows[1], 'getWindowInfo').id, created.id);
  assert.equal(invoke(windows[1], 'getVault').path, '/first');
  await invoke(windows[1], 'openVault');
  assert.equal(pickerOwner, windows[1]);
  assert.equal(invoke(windows[1], 'getVault').path, '/second');
  assert.equal(invoke(windows[0], 'getVault').path, '/first');
  const newWindowMenu = template.find(item => item.label === 'File').submenu[0];
  assert.equal(newWindowMenu.accelerator, 'CmdOrCtrl+Shift+N');
  newWindowMenu.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 3); assert.equal(invoke(windows[2], 'getVault').path, '/first');
  const savedURL = windows[0].webContents.mainFrame.url;
  windows[0].webContents.mainFrame.url = savedURL.replace('index.html', 'other.html');
  assert.throws(() => invoke(windows[0], 'getVault'), /Untrusted page/);
  windows[0].webContents.mainFrame.url = `${savedURL}#note`;
  assert.equal(invoke(windows[0], 'getVault').path, '/first');
  windows[1].destroy(); assert.throws(() => invoke(windows[1], 'getVault'), /Untrusted sender/);
  // Electron emits before-quit before the renderer's cancellable beforeunload.
  // A cancelled quit leaves windows open, so their grants/watchers must survive.
  assert.equal(services.get('/first').watchers, 1);
  app.emit('before-quit');
  assert.equal(services.get('/first').watchers, 1);
  assert.equal(invoke(windows[0], 'getVault').path, '/first');
  assert.equal(await invoke(windows[0], 'read', '/first', 'Note.md'), 'base');
  await invoke(windows[0], 'compareAndWrite', '/first', 'Note.md', 'base', 'saved');
  app.emit('will-quit');
  assert.equal(services.get('/first').watchers, 0);
  assert.equal(services.get('/first').stops, 1);
  app.emit('will-quit');
  assert.equal(services.get('/first').stops, 1);
  assert.throws(() => invoke(windows[0], 'getVault'), /Untrusted sender/);
});
