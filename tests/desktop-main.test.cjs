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
  const retirements=[];let coreFailure;
  const openService=async root=>{
    if (!services.has(root)) services.set(root, { root, watchers: 0, stops: 0, subscribe() { this.watchers++; return () => { this.watchers--; this.stops++; }; }, read: async () => 'base', write: async () => {}, recoveryList:async(entryId,options)=>({entryId,options}),recoveryRead:async(entryId,snapshotId)=>({entryId,snapshotId,content:'old'}), remove: async (target, force) => { removals.push([root, target, force]); } });
    return services.get(root);
  };
  const nativeRequire = name => {
    if (name === './editor-core.cjs') return { createEditorCoreManager: () => ({open:openService,owns:()=>false,requireReleased(){},async invoke(){if(coreFailure)throw coreFailure;return {queryId:'query'};},retire:async(_broker,_record,service)=>{retirements.push(service.root);},close:async()=>{}}) };
    if (name === './client-slots.cjs') return {openClientSlots:async()=>({listRestorable:async()=>[],claim:async({primary}={})=>({slotId:primary?'primary':`window-${++slotNumber}`,clientId:'client',vaultPath:null}),setVault:async()=>{},release:async()=>{}})};
    if (name === './document-semantics.cjs') return require('../desktop/document-semantics.cjs');
    if (name === 'electron') return electron;
    if (name === 'node:fs/promises') return { readFile: async () => '{"path":"/first"}', mkdir: async () => {}, writeFile: async () => {} };
    if (name === './menu-hotkeys.cjs') return require('../desktop/menu-hotkeys.cjs');
    if (name === './window-broker.cjs') return { WindowBroker };
    if (name === './context-menu.cjs') return { createContextMenuController: () => ({ close() {}, popup() {} }) };
    if (name === './vault-service.cjs') return {VaultService:{open:openService}};
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), { require: nativeRequire, __dirname: path.dirname(mainPath), process: { platform: 'darwin', env: {} }, URL, structuredClone, setImmediate });
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
  const historyOptions={limit:20};const historyRequest=invoke(windows[0],'recoveryList','/first','note',historyOptions);historyOptions.limit=99;
  assert.equal((await historyRequest).options.limit,20);
  assert.equal((await invoke(windows[0],'recoveryRead','/first','note','2')).content,'old');
  assert.throws(()=>invoke(windows[0],'recoveryRead','/second','note','2'),/vault|grant|authorized/i);
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
  // Exercise the real main handler and sandbox preload pass-through. Only
  // rich document calls use plain data to survive contextBridge Error copying.
  const richRequest={schemaVersion:1,command:{op:'rich_start',pinId:'1',spec:{query:'/(?=a)/',caseSensitive:false,sort:'nameAsc',context:'line',explain:false}}};
  const diagnostic={code:'unsupported-regex',queryRange:{bytes:[0,3],utf16:[0,3]},message:'Unsupported regular expression.'};
  coreFailure=Object.assign(new Error('/private/internal recovery'),{code:'search_compile',commitUncertain:false,details:{diagnostic}});
  const richReply=await invoke(windows[0],'durableInvoke','/first','admitted','documentCommand',[richRequest]);
  assert.deepEqual(structuredClone(richReply),{ok:true,result:{documents:true,schemaVersion:1,ok:false,error:{code:'search_compile',commitUncertain:false,details:{diagnostic}}}});
  let exposed;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../desktop/preload.cjs'),'utf8'),{require:name=>{
    assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld(_name,value){exposed=value;}},ipcRenderer:{invoke:(name,...args)=>handlers.get(name)({sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame},...args)},webUtils:{}};
  }});
  assert.deepEqual(structuredClone(await exposed.durableInvoke('/first','admitted','documentCommand',[richRequest])),structuredClone(richReply.result));
  const legacy=await invoke(windows[0],'durableInvoke','/first','admitted','fileCommand',[{}]);
  assert.deepEqual(structuredClone(legacy),{ok:false,error:{code:'search_compile',commitUncertain:false}},'other RPCs do not gain raw details');
  coreFailure.details={diagnostic:{...diagnostic,internal:'/private/secret'}};
  const malformed=await exposed.durableInvoke('/first','admitted','documentCommand',[richRequest]);
  assert.deepEqual(structuredClone(malformed),{documents:true,schemaVersion:1,ok:false,error:{code:'invalid_document_response',commitUncertain:false}});
  coreFailure=Object.assign(new Error('/private/internal'),{code:'cancelled',commitUncertain:false,details:{internal:true}});
  assert.deepEqual(structuredClone(await exposed.durableInvoke('/first','admitted','documentCommand',[richRequest])),{documents:true,schemaVersion:1,ok:false,error:{code:'cancelled',commitUncertain:false}});
  coreFailure=undefined;
  assert.deepEqual(structuredClone(await exposed.durableInvoke('/first','admitted','documentCommand',[richRequest])),{documents:true,schemaVersion:1,ok:true,value:{queryId:'query'}});
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

// Execute the real event registration while controlling the native quit boundary.
// This models native dispatch staying active through microtasks; actual AppKit
// behavior remains a separate runtime gate.
function quitFixture(closeSettlement) {
  const app = new EventEmitter(), turns = [], events = [];
  let nativeDispatch = false, closeCalls = 0, quits = 0, ignoredQuits = 0, disposals = 0, finishClose;
  const delayed = new Promise(resolve => { finishClose = resolve; });
  const core = { close() { closeCalls++; events.push('close'); return closeSettlement === 'immediate' ? Promise.resolve() : delayed; } };
  function willQuit() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit('will-quit', event);
    return event.defaultPrevented;
  }
  Object.assign(app, {
    setName() {}, whenReady: () => new Promise(() => {}), requestSingleInstanceLock: () => true,
    quit() {
      events.push('resume-quit');
      if (nativeDispatch) { ignoredQuits++; return; }
      app.emit('before-quit');
      if (!willQuit()) { quits++; events.push('quit'); app.emit('quit'); }
    },
  });
  const nativeRequire = name => {
    if (name === './document-semantics.cjs') return require('../desktop/document-semantics.cjs');
    if (name === 'electron') return { app };
    if (name === './editor-core.cjs') return { createEditorCoreManager: () => core };
    if (name === './window-broker.cjs') return { WindowBroker: class { dispose() { disposals++; events.push('dispose'); } } };
    if (name === './context-menu.cjs') return { createContextMenuController: () => ({}) };
    if (name === './vault-service.cjs') return {};
    if (name === './menu-hotkeys.cjs') return {};
    return require(name);
  };
  const mainPath = path.resolve(__dirname, '../desktop/main.cjs');
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
    require: nativeRequire, __dirname: path.dirname(mainPath), process: { platform: 'darwin', env: {} }, URL,
    setImmediate: callback => turns.push(callback),
  });
  return {
    events, get closeCalls() { return closeCalls; }, get quits() { return quits; }, get ignoredQuits() { return ignoredQuits; }, get disposals() { return disposals; },
    request() { nativeDispatch = true; app.emit('before-quit'); assert.equal(willQuit(), true); },
    repeat: willQuit, finishClose,
    leaveNativeDispatch() { nativeDispatch = false; },
    runNextTurn() { const callbacks = turns.splice(0); for (const callback of callbacks) callback(); },
  };
}
async function settleQuitMicrotasks() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
for (const settlement of ['immediate', 'delayed']) {
  test(`main resumes ordinary quit after the native turn when core close is ${settlement}`, async () => {
    const f = quitFixture(settlement);
    f.request();
    assert.equal(f.repeat(), true, 'another will-quit waits for the same close');
    assert.equal(f.closeCalls, 1);
    assert.equal(f.disposals, 0, 'broker remains alive until close has settled');
    await settleQuitMicrotasks();
    if (settlement === 'delayed') {
      assert.equal(f.quits, 0);
      assert.equal(f.disposals, 0);
      f.runNextTurn();
      assert.equal(f.quits, 0, 'a new turn cannot bypass unresolved close');
      f.leaveNativeDispatch();
      f.finishClose();
      await settleQuitMicrotasks();
    } else f.leaveNativeDispatch();
    f.runNextTurn();
    assert.equal(f.quits, 1, 'the initial quit completes without another external request');
    assert.equal(f.ignoredQuits, 0, 'quit must not reenter a still-active native dispatch');
    assert.equal(f.closeCalls, 1);
    assert.ok(f.events.indexOf('dispose') < f.events.indexOf('resume-quit'));
  });
}
