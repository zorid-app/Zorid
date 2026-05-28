import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { JsonValue } from '@zorid/shared';
import { selectVaultRootFromDialog } from './open-vault-dialog.js';
import { createRecentVaultStore, openRecentVault, type RecentVaultStore } from './recent-vaults.js';
import { createDesktopRuntime, type DesktopRuntime } from './runtime.js';
import { installRuntimeShutdown } from './shutdown.js';
import { VaultWindowManager, type VaultWindowRole } from './vault-window-manager.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

function isWslRuntime(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function shouldDisableGpu(): boolean {
  return process.env.ZORID_DISABLE_GPU === '1' || isWslRuntime();
}

if (shouldDisableGpu()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

let recentVaultStore: RecentVaultStore | undefined;

function recents(): RecentVaultStore {
  recentVaultStore ??= createRecentVaultStore(app.getPath('userData'));
  return recentVaultStore;
}

function rendererUrl(role: VaultWindowRole): string | undefined {
  const baseUrl = process.env.ELECTRON_RENDERER_URL;
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  url.searchParams.set('zoridWindow', role);
  return url.toString();
}

function createManagedWindow(role: VaultWindowRole): BrowserWindow {
  return new BrowserWindow({
    width: role === 'launcher' ? 1040 : 1280,
    height: role === 'launcher' ? 720 : 860,
    minWidth: role === 'launcher' ? 820 : 960,
    minHeight: role === 'launcher' ? 560 : 640,
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

async function loadManagedWindow(win: BrowserWindow, role: VaultWindowRole): Promise<void> {
  const devServerUrl = rendererUrl(role);
  if (devServerUrl) await win.loadURL(devServerUrl);
  else await win.loadFile(path.join(currentDirectory, '../renderer/index.html'), { query: { zoridWindow: role } });
}

const windows = new VaultWindowManager<BrowserWindow, DesktopRuntime>({
  createWindow: createManagedWindow,
  loadWindow: loadManagedWindow,
  createRuntime: createDesktopRuntime,
});

function runtimeFor(event: IpcMainInvokeEvent): DesktopRuntime {
  return windows.runtimeForSender(event.sender.id);
}

async function selectAndOpenVault(event: IpcMainInvokeEvent): Promise<Awaited<ReturnType<DesktopRuntime['openVault']>> | undefined> {
  const root = await selectVaultRootFromDialog(event, dialog.showOpenDialog);
  if (root === undefined) return undefined;
  const profile = await windows.openVault(root);
  await recents().record(root);
  return profile;
}

ipcMain.handle('zorid:get-window-role', (event) => windows.roleForSender(event.sender.id));
ipcMain.handle('zorid:open-vault', async (event) => selectAndOpenVault(event));
ipcMain.handle('zorid:create-vault', async (event) => selectAndOpenVault(event));
ipcMain.handle('zorid:list-recent-vaults', async () => recents().list());
ipcMain.handle('zorid:open-recent-vault', async (_event, id: string) => openRecentVault(id, { openVault: (root) => windows.openVault(root) }, recents()));
ipcMain.handle('zorid:get-vault-profile', async (event) => runtimeFor(event).vaultProfile());
ipcMain.handle('zorid:list-vault', async (event, vaultPath?: string) => runtimeFor(event).listVault(vaultPath));
ipcMain.handle('zorid:read-vault-text', async (event, vaultPath: string) => runtimeFor(event).readVaultText(vaultPath));
ipcMain.handle('zorid:write-vault-text', async (event, vaultPath: string, contents: string) => runtimeFor(event).writeVaultText(vaultPath, contents));
ipcMain.handle('zorid:create-vault-folder', async (event, vaultPath: string) => runtimeFor(event).createVaultFolder(vaultPath));
ipcMain.handle('zorid:create-markdown-file', async (event, vaultPath: string, contents?: string) => runtimeFor(event).createMarkdownFile(vaultPath, contents));
ipcMain.handle('zorid:rename-vault-path', async (event, from: string, to: string) => runtimeFor(event).renameVaultPath(from, to));
ipcMain.handle('zorid:delete-vault-path', async (event, vaultPath: string) => runtimeFor(event).deleteVaultPath(vaultPath));
ipcMain.handle('zorid:get-index-status', async (event) => runtimeFor(event).getIndexStatus());
ipcMain.handle('zorid:rebuild-index', async (event) => runtimeFor(event).rebuildIndex());
ipcMain.handle('zorid:search-index', async (event, query: string) => runtimeFor(event).searchIndex(query));
ipcMain.handle('zorid:get-backlinks', async (event, vaultPath: string) => runtimeFor(event).getBacklinks(vaultPath));
ipcMain.handle('zorid:list-tags', async (event) => runtimeFor(event).listTags());
ipcMain.handle('zorid:get-outline', async (event, vaultPath: string) => runtimeFor(event).getOutline(vaultPath));
ipcMain.handle('zorid:list-types', async (event) => runtimeFor(event).listTypes());
ipcMain.handle('zorid:get-file-fields', async (event, vaultPath: string) => runtimeFor(event).getFileFields(vaultPath));
ipcMain.handle('zorid:update-file-field', async (event, vaultPath: string, key: string, value: JsonValue) => runtimeFor(event).updateFileField(vaultPath, key, value));
ipcMain.handle('zorid:set-file-type', async (event, vaultPath: string, typeName?: string) => runtimeFor(event).setFileType(vaultPath, typeName));
ipcMain.handle('zorid:list-bases', async (event) => runtimeFor(event).listBases());
ipcMain.handle('zorid:render-data-view', async (event, basePath: string, viewId?: string) => runtimeFor(event).renderDataView(basePath, viewId));
ipcMain.handle('zorid:get-markdown-embeds', async (event, vaultPath: string) => runtimeFor(event).getMarkdownEmbeds(vaultPath));
ipcMain.handle('zorid:list-commands', async (event) => runtimeFor(event).listCommands());
ipcMain.handle('zorid:execute-command', async (event, id: string, args?: JsonValue) => runtimeFor(event).executeCommand(id, args));
ipcMain.handle('zorid:list-plugin-statuses', async (event) => runtimeFor(event).listPluginStatuses());
ipcMain.handle('zorid:list-settings-sections', async (event) => runtimeFor(event).listSettingsSections());
ipcMain.handle('zorid:get-setting-value', async (event, sectionId: string, pluginId?: string) => runtimeFor(event).getSettingValue(sectionId, pluginId));
ipcMain.handle('zorid:set-setting-value', async (event, sectionId: string, value: JsonValue, pluginId?: string) => runtimeFor(event).setSettingValue(sectionId, value, pluginId));

app.whenReady()
  .then(async () => {
    await windows.openLauncherWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void windows.openLauncherWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('Failed to launch Zorid desktop app.', error);
    app.exit(1);
  });

installRuntimeShutdown(app, windows);
