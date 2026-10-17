'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { VaultService } = require('./vault-service.cjs');
const { WindowBroker } = require('./window-broker.cjs');
const editorCore = require('./editor-core.cjs').createEditorCoreManager();
const { createContextMenuController } = require('./context-menu.cjs');
const { validateMenuHotkeys, workspaceFileMenu } = require('./menu-hotkeys.cjs');
const menuHotkeys = new WeakMap();
const closeStates = new WeakMap();
let quitRequested = false;
const contextMenus = createContextMenuController(Menu);
app.setName('Zorid');
const familyFixture = process.env.ZORID_DESKTOP_FAMILY_FIXTURE === '1';
const devUrl = process.env.ZORID_DEV_URL;
const packagedUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
function allowedURL(url) {
  try { const current = new URL(url); current.hash = ''; const expected = new URL(devUrl || packagedUrl); expected.hash = ''; return current.href === expected.href; }
  catch { return false; }
}
const broker = new WindowBroker({ openVault: directory => editorCore ? editorCore.open(directory) : VaultService.open(directory), allowedURL });
let lastVaultPath;
function handle(name, callback) {
  ipcMain.handle(`zorid:${name}`, (event, ...args) => callback(broker.authenticate(event), event, ...args));
}
function registerIPC() {
  handle('showContextMenu', (record, _event, request) => contextMenus.popup(record.window, request));
  handle('dismissContextMenu', record => contextMenus.close(record.window));
  handle('getWindowInfo', record => broker.info(record));
  handle('setMenuHotkeys', (record, _event, bindings) => { menuHotkeys.set(record.window, validateMenuHotkeys(bindings)); if (BrowserWindow.getFocusedWindow() === record.window) refreshApplicationMenu(); });
  handle('newWindow', async record => {
    if (editorCore && record.vault && await editorCore.isCoreRoot(record.vault.service.root)) throw new Error('Rust fixture currently supports one window with split panes.');
    return { id: (await createWindow({ source: record })).id };
  });
  handle('getVault', record => broker.describe(record));
  handle('closeHandlerReady', (record, _event, ready) => {
    const state = closeStates.get(record);
    if (state) state.ready = ready === true;
  });
  handle('completeClose', (record, _event, token, ok) => {
    const state = closeStates.get(record);
    if (!state?.pending || state.pending.token !== token || state.pending.generation !== record.generation) return;
    state.pending = null;
    if (ok !== true) {
      quitRequested = false;
      dialog.showMessageBox(record.window, { type: 'error', message: 'The vault could not finish saving.', detail: 'The window remains open. Resolve the save error and try closing again.', buttons: ['Keep open'] });
      return;
    }
    try { editorCore?.requireReleased(record); }
    catch {
      quitRequested = false;
      dialog.showMessageBox(record.window, { type: 'error', message: 'The vault is still in use.', detail: 'Finish saving before closing this window.', buttons: ['Keep open'] });
      return;
    }
    state.allowed = true;
    setImmediate(() => { if (!record.window.isDestroyed()) { if (quitRequested) app.quit(); else record.window.close(); } });
  });
  handle('openVault', async (record, event) => {
    if (closeStates.get(record)?.pending) throw new Error('Finish closing or saving before switching vaults.');
    editorCore?.requireReleased(record);
    const selection = await dialog.showOpenDialog(record.window, { title: 'Open folder as vault', properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    broker.authenticate(event);
    editorCore?.requireReleased(record);
    if (editorCore && record.id !== 'main' && await editorCore.isCoreRoot(selection.filePaths[0])) throw new Error('Rust fixture currently supports one primary window.');
    const result = await broker.select(record, selection.filePaths[0]);
    lastVaultPath = result.path;
    const stateFile = path.join(app.getPath('userData'), 'vault.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ path: result.path }), { mode: 0o600 });
    return result;
  });
  const durableReply = async callback => {
    try { return { ok: true, result: await callback() }; }
    catch (error) { return { ok: false, error: { code: typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'durable_request_failed', commitUncertain: error?.commitUncertain === true } }; }
  };
  handle('getDurableContext', (record, _event, expectedRoot) => durableReply(() => editorCore ? editorCore.context(broker, record, expectedRoot) : null));
  handle('durableInvoke', (record, event, expectedRoot, admissionId, method, args) => durableReply(() => {
    if (!editorCore) throw new Error('No Rust editor context');
    return editorCore.invoke(broker, record, event, expectedRoot, admissionId, method, args);
  }));
  handle('releaseDurableContext', (record, event, expectedRoot, admissionId) => durableReply(() => {
    if (!editorCore) throw new Error('No Rust editor context');
    return editorCore.release(broker, record, event, expectedRoot, admissionId);
  }));
  for (const method of ['list', 'stat', 'read', 'readBinary', 'write', 'writeBinary', 'compareAndWrite', 'mkdir', 'rename', 'trash', 'remove']) {
    handle(method, (record, event, expectedRoot, ...args) => broker.dispatch(record, expectedRoot, method, args, () => broker.authenticate(event)));
  }
}
async function createWindow({ source, primary = false, initialState = 'empty' } = {}) {
  if (source) {
    broker.assertLive(source);
    if (editorCore && source.vault && await editorCore.isCoreRoot(source.vault.service.root)) throw new Error('Rust fixture currently supports one window with split panes.');
  }
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 480, title: 'Zorid', backgroundColor: '#1e1e1e', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const record = broker.register(window, { primary, initialState });
  const closeState = {ready: false, pending: null, allowed: false};
  closeStates.set(record, closeState);
  window.on('close', event => {
    if (!editorCore?.owns(record) || closeState.allowed) return;
    event.preventDefault();
    if (closeState.pending) return;
    if (!closeState.ready) {
      quitRequested = false;
      void dialog.showMessageBox(window, {type:'info',message:'The vault is still opening.',detail:'Wait for recovery to finish before closing this window.',buttons:['Keep open']});
      return;
    }
    const token = randomUUID();
    closeState.pending = {token, generation: record.generation};
    window.webContents.send('zorid:prepare-close', token);
  });
  window.on('focus', refreshApplicationMenu);
  window.on('closed', () => { contextMenus.close(window); broker.remove(record); void editorCore?.retire(broker, record).catch(() => {}); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!allowedURL(url)) event.preventDefault(); });
  try {
    if (source) broker.bind(record, source.vault);
    else if (lastVaultPath && (primary || !editorCore || !await editorCore.isCoreRoot(lastVaultPath).catch(() => false))) {
      try { await broker.select(record, lastVaultPath); } catch { /* Missing previous vault opens the picker. */ }
    }
    if (devUrl) await window.loadURL(devUrl); else await window.loadFile(path.join(__dirname, '../dist/index.html'));
    return record;
  } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
}
function openEmptyWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  const source = focused ? broker.windows.get(focused.webContents.id) : undefined;
  createWindow({ source }).catch(error => dialog.showErrorBox('Could not open window', error.message));
}
function refreshApplicationMenu() {
  const focused = BrowserWindow.getFocusedWindow();
  const trusted = focused && broker.windows.has(focused.webContents.id) ? focused : null;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role:'appMenu' }] : []),
    workspaceFileMenu(trusted ? menuHotkeys.get(trusted) : null, {
      newWindow: openEmptyWindow,
      closeTab: () => { const owner = BrowserWindow.getFocusedWindow(); if (owner && broker.windows.has(owner.webContents.id)) owner.webContents.send('zorid:command', 'close-tab'); },
      closeWindow: () => { const owner = BrowserWindow.getFocusedWindow(); if (owner && broker.windows.has(owner.webContents.id)) owner.close(); },
    }),
    { role:'editMenu' }, { role:'viewMenu' },
    { role:'windowMenu', submenu:[{role:'minimize'},{role:'zoom'},...(process.platform==='darwin'?[{type:'separator'},{role:'front'}]:[{label:'Close window',click:()=>{const owner=BrowserWindow.getFocusedWindow();if(owner&&broker.windows.has(owner.webContents.id))owner.close();}}])] },
  ]));
}
app.whenReady().then(async () => {
  if (familyFixture) {
    try {
      await require('./family-fixture.cjs').launchFamilyFixture({app,BrowserWindow,ipcMain}, {
        root: process.env.ZORID_FIXTURE_VAULT,
        executable: process.env.ZORID_DESKTOP_HOST_BIN,
        credentials: process.env.ZORID_FIXTURE_SYNC_CONFIG,
        source: process.env.ZORID_FIXTURE_SOURCE,
      });
    } catch { dialog.showErrorBox('Core fixture unavailable', 'Check the trusted fixture configuration and matching native host build.'); app.quit(); }
    return;
  }
  try { lastVaultPath = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'vault.json'), 'utf8')).path; }
  catch { /* A missing previous vault returns to the vault picker. */ }
  registerIPC();
  refreshApplicationMenu();
  await createWindow({ primary: true, initialState: 'restore' });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow({ primary: true, initialState: 'restore' }).catch(error => dialog.showErrorBox('Could not open window', error.message)); });
});
app.on('before-quit', () => { quitRequested = true; });
app.on('window-all-closed', () => { if (familyFixture || process.platform !== 'darwin') app.quit(); });
// before-quit can still be cancelled by a renderer's unsaved-note guard.
let coreClosed = false, coreClosing;
app.on('will-quit', event => {
  if (editorCore && !coreClosed) {
    event.preventDefault();
    coreClosing ??= editorCore.close().catch(() => {}).finally(() => { coreClosed = true; broker.dispose(); app.quit(); });
  } else broker.dispose();
});
