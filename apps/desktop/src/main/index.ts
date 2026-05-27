import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { JsonValue } from '@zorid/shared';
import { openVaultFromDialog } from './open-vault-dialog.js';
import { createDesktopRuntime } from './runtime.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

const runtime = createDesktopRuntime();
const windows = new Set<BrowserWindow>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of windows) win.webContents.send(channel, payload);
}

runtime.kernel.disposables.use(runtime.kernel.events.on('metadata:index-updated', (payload) => broadcast('zorid:index-updated', payload)));
runtime.kernel.disposables.use(runtime.kernel.events.on('metadata:index-status', (payload) => broadcast('zorid:index-status', payload)));

function rendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL;
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const devServerUrl = rendererUrl();
  if (devServerUrl) await win.loadURL(devServerUrl);
  else await win.loadFile(path.join(currentDirectory, '../renderer/index.html'));

  windows.add(win);
  win.on('closed', () => { windows.delete(win); });

  return win;
}

ipcMain.handle('zorid:open-vault', async (event) => openVaultFromDialog(event, runtime, dialog.showOpenDialog));
ipcMain.handle('zorid:get-vault-profile', async () => runtime.vaultProfile());
ipcMain.handle('zorid:list-vault', async (_event, vaultPath?: string) => runtime.listVault(vaultPath));
ipcMain.handle('zorid:read-vault-text', async (_event, vaultPath: string) => runtime.readVaultText(vaultPath));
ipcMain.handle('zorid:write-vault-text', async (_event, vaultPath: string, contents: string) => runtime.writeVaultText(vaultPath, contents));
ipcMain.handle('zorid:create-vault-folder', async (_event, vaultPath: string) => runtime.createVaultFolder(vaultPath));
ipcMain.handle('zorid:create-markdown-file', async (_event, vaultPath: string, contents?: string) => runtime.createMarkdownFile(vaultPath, contents));
ipcMain.handle('zorid:rename-vault-path', async (_event, from: string, to: string) => runtime.renameVaultPath(from, to));
ipcMain.handle('zorid:delete-vault-path', async (_event, vaultPath: string) => runtime.deleteVaultPath(vaultPath));
ipcMain.handle('zorid:get-index-status', async () => runtime.getIndexStatus());
ipcMain.handle('zorid:rebuild-index', async () => runtime.rebuildIndex());
ipcMain.handle('zorid:search-index', async (_event, query: string) => runtime.searchIndex(query));
ipcMain.handle('zorid:get-backlinks', async (_event, vaultPath: string) => runtime.getBacklinks(vaultPath));
ipcMain.handle('zorid:list-tags', async () => runtime.listTags());
ipcMain.handle('zorid:get-outline', async (_event, vaultPath: string) => runtime.getOutline(vaultPath));
ipcMain.handle('zorid:list-types', async () => runtime.listTypes());
ipcMain.handle('zorid:get-file-fields', async (_event, vaultPath: string) => runtime.getFileFields(vaultPath));
ipcMain.handle('zorid:update-file-field', async (_event, vaultPath: string, key: string, value: JsonValue) => runtime.updateFileField(vaultPath, key, value));
ipcMain.handle('zorid:set-file-type', async (_event, vaultPath: string, typeName?: string) => runtime.setFileType(vaultPath, typeName));
ipcMain.handle('zorid:list-bases', async () => runtime.listBases());
ipcMain.handle('zorid:render-data-view', async (_event, basePath: string, viewId?: string) => runtime.renderDataView(basePath, viewId));
ipcMain.handle('zorid:get-markdown-embeds', async (_event, vaultPath: string) => runtime.getMarkdownEmbeds(vaultPath));
ipcMain.handle('zorid:list-commands', async () => runtime.listCommands());
ipcMain.handle('zorid:execute-command', async (_event, id: string, args?: JsonValue) => runtime.executeCommand(id, args));
ipcMain.handle('zorid:list-plugin-statuses', async () => runtime.listPluginStatuses());
ipcMain.handle('zorid:list-settings-sections', async () => runtime.listSettingsSections());
ipcMain.handle('zorid:get-setting-value', async (_event, sectionId: string, pluginId?: string) => runtime.getSettingValue(sectionId, pluginId));
ipcMain.handle('zorid:set-setting-value', async (_event, sectionId: string, value: JsonValue, pluginId?: string) => runtime.setSettingValue(sectionId, value, pluginId));

app.whenReady()
  .then(async () => {
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('Failed to launch Zorid desktop app.', error);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  void runtime.dispose();
  if (process.platform !== 'darwin') app.quit();
});
