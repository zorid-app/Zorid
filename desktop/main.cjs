'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { VaultService } = require('./vault-service.cjs');
const { WindowBroker } = require('./window-broker.cjs');
const { createContextMenuController } = require('./context-menu.cjs');
const contextMenus = createContextMenuController(Menu);
app.setName('Zorid');
const devUrl = process.env.ZORID_DEV_URL;
const packagedUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
function allowedURL(url) {
  try { const current = new URL(url); current.hash = ''; const expected = new URL(devUrl || packagedUrl); expected.hash = ''; return current.href === expected.href; }
  catch { return false; }
}
const broker = new WindowBroker({ openVault: directory => VaultService.open(directory), allowedURL });
let lastVaultPath;
function handle(name, callback) {
  ipcMain.handle(`zorid:${name}`, (event, ...args) => callback(broker.authenticate(event), event, ...args));
}
function registerIPC() {
  handle('showContextMenu', (record, _event, request) => contextMenus.popup(record.window, request));
  handle('dismissContextMenu', record => contextMenus.close(record.window));
  handle('getWindowInfo', record => broker.info(record));
  handle('newWindow', async record => ({ id: (await createWindow({ source: record })).id }));
  handle('getVault', record => broker.describe(record));
  handle('openVault', async (record, event) => {
    const selection = await dialog.showOpenDialog(record.window, { title: 'Open folder as vault', properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    broker.authenticate(event);
    const result = await broker.select(record, selection.filePaths[0]);
    lastVaultPath = result.path;
    const stateFile = path.join(app.getPath('userData'), 'vault.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ path: result.path }), { mode: 0o600 });
    return result;
  });
  for (const method of ['list', 'stat', 'read', 'readBinary', 'write', 'writeBinary', 'compareAndWrite', 'mkdir', 'rename', 'trash']) {
    handle(method, (record, event, expectedRoot, ...args) => broker.dispatch(record, expectedRoot, method, args, () => broker.authenticate(event)));
  }
}
async function createWindow({ source, primary = false, initialState = 'empty' } = {}) {
  if (source) broker.assertLive(source);
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 480, title: 'Zorid', backgroundColor: '#1e1e1e', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const record = broker.register(window, { primary, initialState });
  window.on('closed', () => { contextMenus.close(window); broker.remove(record); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!allowedURL(url)) event.preventDefault(); });
  try {
    if (source) broker.bind(record, source.vault);
    else if (lastVaultPath) {
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
app.whenReady().then(async () => {
  try { lastVaultPath = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'vault.json'), 'utf8')).path; }
  catch { /* A missing previous vault returns to the vault picker. */ }
  registerIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ label: 'New window', accelerator: 'CmdOrCtrl+Shift+N', click: openEmptyWindow }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  await createWindow({ primary: true, initialState: 'restore' });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow({ primary: true, initialState: 'restore' }).catch(error => dialog.showErrorBox('Could not open window', error.message)); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => broker.dispose());
