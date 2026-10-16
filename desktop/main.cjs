'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { VaultService } = require('./vault-service.cjs');
const { dispatchVaultOperation } = require('./vault-dispatch.cjs');
const { createContextMenuController } = require('./context-menu.cjs');
const contextMenus = createContextMenuController(Menu);
app.setName('Zorid');
let window;
let vault;
let unsubscribe;
const devUrl = process.env.ZORID_DEV_URL;
const packagedUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
const describeVault = () => vault ? { path: vault.root, name: path.basename(vault.root) } : null;
async function selectVault(directory) {
  const next = await VaultService.open(directory);
  unsubscribe?.();
  vault = next;
  unsubscribe = vault.subscribe(change => {
    if (window && !window.isDestroyed()) window.webContents.send('zorid:change', change);
  });
  return describeVault();
}
function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted sender');
  const current = event.senderFrame.url;
  if (devUrl ? new URL(current).origin !== new URL(devUrl).origin : current.split('#')[0] !== packagedUrl) throw new Error('Untrusted page');
}
function handle(name, callback) {
  ipcMain.handle(`zorid:${name}`, (event, ...args) => { assertSender(event); return callback(...args); });
}
function registerIPC() {
  handle('showContextMenu', request => contextMenus.popup(window, request));
  handle('dismissContextMenu', () => contextMenus.close(window));
  handle('getVault', describeVault);
  handle('openVault', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Open folder as vault', properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const result = await selectVault(selection.filePaths[0]);
    const stateFile = path.join(app.getPath('userData'), 'vault.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ path: vault.root }), { mode: 0o600 });
    return result;
  });
  for (const method of ['list', 'stat', 'read', 'readBinary', 'write', 'writeBinary', 'mkdir', 'rename', 'trash']) {
    handle(method, (expectedRoot, ...args) => dispatchVaultOperation(vault, expectedRoot, method, args));
  }
}
async function createWindow() {
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 480, title: 'Zorid', backgroundColor: '#1e1e1e', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? new URL(url).origin === new URL(devUrl).origin : url.split('#')[0] === packagedUrl;
    if (!allowed) event.preventDefault();
  });
  if (devUrl) await window.loadURL(devUrl); else await window.loadFile(path.join(__dirname, '../dist/index.html'));
}
app.whenReady().then(async () => {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'vault.json'), 'utf8'));
    if (saved.path) await selectVault(saved.path);
  } catch { /* A missing or moved previous vault returns to the vault picker. */ }
  registerIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => unsubscribe?.());
