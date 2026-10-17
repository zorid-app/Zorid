const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WindowBroker } = require('../desktop/window-broker.cjs');

test('main wiring creates empty authenticated windows and scopes vault picking to its caller', async () => {
  const windows = [], handlers = new Map();
  let template, pickerOwner, nextPick = '/second',pickerWait;
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
  Object.assign(app, { setName() {}, whenReady: () => Promise.resolve(), getPath: () => '/state', requestSingleInstanceLock: () => true, quit() {} });
  const services = new Map(), removals = [];
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showOpenDialog: async owner => { pickerOwner = owner; if(pickerWait)await pickerWait; return { filePaths: [nextPick], canceled: false }; }, showErrorBox: assert.fail },
    Menu: { buildFromTemplate: value => { template = value; return value; }, setApplicationMenu() {} }, shell: { openExternal() {} } };
  const mainPath = path.resolve(__dirname, '../desktop/main.cjs');
  let slotNumber=0;
  const retirements=[];
  const openService=async root=>{
    if (!services.has(root)) services.set(root, { root, watchers: 0, stops: 0, subscribe() { this.watchers++; return () => { this.watchers--; this.stops++; }; }, read: async () => 'base', write: async () => {}, remove: async (target, force) => { removals.push([root, target, force]); } });
    return services.get(root);
  };
  const nativeRequire = name => {
    if (name === './editor-core.cjs') return { createEditorCoreManager: () => ({open:openService,owns:()=>false,requireReleased(){},retire:async(_broker,_record,service)=>{retirements.push(service.root);},close:async()=>{}}) };
    if (name === './client-slots.cjs') return {openClientSlots:async()=>({listRestorable:async()=>[],claim:async({primary}={})=>({slotId:primary?'primary':`window-${++slotNumber}`,clientId:'client',vaultPath:null}),setVault:async()=>{},release:async()=>{}})};
    if (name === 'electron') return electron;
    if (name === 'node:fs/promises') return { readFile: async () => '{"path":"/first"}', mkdir: async () => {}, writeFile: async () => {} };
    if (name === './menu-hotkeys.cjs') return require('../desktop/menu-hotkeys.cjs');
    if (name === './window-broker.cjs') return { WindowBroker };
    if (name === './context-menu.cjs') return { createContextMenuController: () => ({ close() {}, popup() {} }) };
    if (name === './vault-service.cjs') return {VaultService:{open:openService}};
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
  let finishPicker;pickerWait=new Promise(resolve=>{finishPicker=resolve;});
  const switching=invoke(windows[1], 'openVault');
  await assert.rejects(invoke(windows[1], 'openVault'),/switching/);
  finishPicker();await switching;pickerWait=null;
  assert.equal(pickerOwner, windows[1]);
  assert.equal(invoke(windows[1], 'getVault').path, '/second');
  assert.equal(invoke(windows[0], 'getVault').path, '/first');
  assert.deepEqual(retirements,['/first'],'switch retires its old admission without detaching the surviving window');
  // Exercise actual main registration, broker grants, and service forwarding.
  assert.ok(handlers.has('zorid:remove'));
  await invoke(windows[0], 'remove', '/first', 'Owned.md', false);
  await invoke(windows[1], 'remove', '/second', 'Folder', true);
  assert.throws(() => invoke(windows[0], 'remove', '/second', 'Foreign.md', true), /vault|grant|authorized/i);
  assert.throws(() => handlers.get('zorid:remove')({sender:windows[0].webContents,senderFrame:{url:windows[0].webContents.mainFrame.url}}, '/first', 'Child.md', true), /Untrusted/);
  assert.deepEqual(removals, [['/first','Owned.md',false],['/second','Folder',true]]);
  const newWindowMenu = template.find(item => item.label === 'File').submenu[0];
  assert.equal(newWindowMenu.accelerator, undefined);
  invoke(windows[0], 'setMenuHotkeys', [{id:'new-window',shortcut:'⌘ ⌥ N'},{id:'close-tab',shortcut:''}]);
  assert.equal(template.find(item=>item.label==='File').submenu[0].label,'New window (⌘ ⌥ N)');
  assert.throws(()=>invoke(windows[0],'setMenuHotkeys',[{id:'new-window',shortcut:'X'},{id:'quit',shortcut:'Q'}]),/Invalid/);
  assert.throws(()=>handlers.get('zorid:setMenuHotkeys')({sender:windows[0].webContents,senderFrame:{}},[]),/Untrusted/);
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
  app.emit('will-quit',{preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(services.get('/first').watchers, 0);
  assert.equal(services.get('/first').stops, 1);
  app.emit('will-quit',{preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(services.get('/first').stops, 1);
  assert.throws(() => invoke(windows[0], 'getVault'), /Untrusted sender/);
});
