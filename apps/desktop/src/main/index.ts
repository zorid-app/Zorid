import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@zorid/shared';
import type { IpcMainInvokeEvent } from 'electron';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { appendDesktopDebugLog, type DesktopDebugLogEntry } from './debug-log.js';
import { selectVaultRootFromDialog } from './open-vault-dialog.js';
import { createRecentVaultStore, openRecentVault, type RecentVaultStore } from './recent-vaults.js';
import {
  appSettingsSections,
  createDesktopRuntime,
  type DesktopRuntime,
  InMemoryAppSettingsStore,
  type SettingsSectionDto,
  type SettingValueDto,
} from './runtime.js';
import { installRuntimeShutdown } from './shutdown.js';
import { VaultWindowManager, type VaultWindowRole } from './vault-window-manager.js';
import { managedWindowOptions } from './window-options.js';

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
const appSettingsStore = new InMemoryAppSettingsStore();

type RenamePathDebugState = {
  readonly input: string;
  readonly normalized?: string;
  readonly resolved?: string;
  readonly exists: boolean;
  readonly kind?: 'file' | 'directory';
  readonly error?: string;
};

function serializeError(error: unknown): { name: string; message: string; code?: string; stack?: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: 'Error', message: String(error) };
}

async function describeRenamePath(runtime: DesktopRuntime, vaultPath: string): Promise<RenamePathDebugState> {
  try {
    return await runtime.debugDescribeVaultPath(vaultPath);
  } catch (error) {
    return {
      input: vaultPath,
      exists: false,
      error: serializeError(error).message,
    };
  }
}

function logsRoot(): string {
  return app.getPath('logs');
}

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
  return new BrowserWindow(managedWindowOptions(role, path.join(currentDirectory, '../preload/index.cjs')));
}

async function loadManagedWindow(win: BrowserWindow, role: VaultWindowRole): Promise<void> {
  const devServerUrl = rendererUrl(role);
  if (devServerUrl) await win.loadURL(devServerUrl);
  else await win.loadFile(path.join(currentDirectory, '../renderer/index.html'), { query: { zoridWindow: role } });
}

const windows = new VaultWindowManager<BrowserWindow, DesktopRuntime>({
  createWindow: createManagedWindow,
  loadWindow: loadManagedWindow,
  createRuntime: () => createDesktopRuntime({ appSettings: appSettingsStore }),
});

function runtimeFor(event: IpcMainInvokeEvent): DesktopRuntime {
  return windows.runtimeForSender(event.sender.id);
}

function isAppSetting(sectionId: string, pluginId?: string): boolean {
  return pluginId === undefined && sectionId.startsWith('app.');
}

function appSettingsSectionDtos(): readonly SettingsSectionDto[] {
  return appSettingsSections.map((section) => ({
    id: section.id,
    title: section.title,
    schema: section.schema,
    source: 'app',
  }));
}

function getAppSettingValue(sectionId: string): SettingValueDto {
  return { sectionId, value: appSettingsStore.get(sectionId) };
}

function broadcastSettingUpdated(dto: SettingValueDto): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('zorid:setting-updated', dto);
  }
}

function setAppSettingValue(sectionId: string, value: JsonValue): SettingValueDto {
  appSettingsStore.set(sectionId, value);
  const dto = getAppSettingValue(sectionId);
  broadcastSettingUpdated(dto);
  return dto;
}

async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https external URLs can be opened.');
  }
  await shell.openExternal(parsed.toString());
}

async function selectAndOpenVault(
  event: IpcMainInvokeEvent,
): Promise<Awaited<ReturnType<DesktopRuntime['openVault']>> | undefined> {
  const root = await selectVaultRootFromDialog(event, dialog.showOpenDialog);
  if (root === undefined) return undefined;
  const profile = await windows.openVault(root);
  await recents().record(root);
  return profile;
}

ipcMain.handle('zorid:get-window-role', (event) => windows.roleForSender(event.sender.id));
ipcMain.handle('zorid:save-debug-log', async (_event, entry: DesktopDebugLogEntry) =>
  appendDesktopDebugLog(logsRoot(), entry),
);
ipcMain.handle('zorid:open-vault', async (event) => selectAndOpenVault(event));
ipcMain.handle('zorid:create-vault', async (event) => selectAndOpenVault(event));
ipcMain.handle('zorid:list-recent-vaults', async () => recents().list());
ipcMain.handle('zorid:open-recent-vault', async (_event, id: string) =>
  openRecentVault(id, { openVault: (root) => windows.openVault(root) }, recents()),
);
ipcMain.handle('zorid:get-vault-profile', async (event) => runtimeFor(event).vaultProfile());
ipcMain.handle('zorid:list-vault', async (event, vaultPath?: string) => runtimeFor(event).listVault(vaultPath));
ipcMain.handle('zorid:read-vault-text', async (event, vaultPath: string) => runtimeFor(event).readVaultText(vaultPath));
ipcMain.handle('zorid:read-file-renderer-image-resource', async (event, match) =>
  runtimeFor(event).readFileRendererImageResource(match),
);
ipcMain.handle('zorid:write-vault-text', async (event, vaultPath: string, contents: string) =>
  runtimeFor(event).writeVaultText(vaultPath, contents),
);
ipcMain.handle('zorid:create-vault-folder', async (event, vaultPath: string) =>
  runtimeFor(event).createVaultFolder(vaultPath),
);
ipcMain.handle('zorid:create-markdown-file', async (event, vaultPath: string, contents?: string) =>
  runtimeFor(event).createMarkdownFile(vaultPath, contents),
);
ipcMain.handle('zorid:rename-vault-path', async (event, from: string, to: string) => {
  const runtime = runtimeFor(event);
  const beforeFrom = await describeRenamePath(runtime, from);
  const beforeTo = await describeRenamePath(runtime, to);
  await appendDesktopDebugLog(logsRoot(), {
    level: 'debug',
    scope: 'desktop.ipc',
    message: 'rename-vault-path requested',
    data: {
      windowId: event.sender.id,
      vaultRoot: runtime.vaultRoot(),
      profile: runtime.vaultProfile(),
      input: { from, to },
      before: { from: beforeFrom, to: beforeTo },
    },
  });

  try {
    await runtime.renameVaultPath(from, to);
    const afterFrom = await describeRenamePath(runtime, from);
    const afterTo = await describeRenamePath(runtime, to);
    await appendDesktopDebugLog(logsRoot(), {
      level: 'debug',
      scope: 'desktop.ipc',
      message: 'rename-vault-path succeeded',
      data: {
        windowId: event.sender.id,
        vaultRoot: runtime.vaultRoot(),
        input: { from, to },
        before: { from: beforeFrom, to: beforeTo },
        after: { from: afterFrom, to: afterTo },
      },
    });
  } catch (error) {
    await appendDesktopDebugLog(logsRoot(), {
      level: 'error',
      scope: 'desktop.ipc',
      message: 'rename-vault-path failed',
      data: {
        windowId: event.sender.id,
        vaultRoot: runtime.vaultRoot(),
        input: { from, to },
        before: { from: beforeFrom, to: beforeTo },
        error: serializeError(error),
      },
    });
    throw error;
  }
});
ipcMain.handle('zorid:delete-vault-path', async (event, vaultPath: string) =>
  runtimeFor(event).deleteVaultPath(vaultPath),
);
ipcMain.handle('zorid:reveal-vault-path', async (event, vaultPath: string) => {
  const resolved = runtimeFor(event).resolveVaultPath(vaultPath);
  await shell.showItemInFolder(resolved);
});
ipcMain.handle('zorid:get-index-status', async (event) => runtimeFor(event).getIndexStatus());
ipcMain.handle('zorid:rebuild-index', async (event) => runtimeFor(event).rebuildIndex());
ipcMain.handle('zorid:search-index', async (event, query: string) => runtimeFor(event).searchIndex(query));
ipcMain.handle('zorid:search-index-candidates', async (event, query: string) =>
  runtimeFor(event).searchIndexCandidates(query),
);
ipcMain.handle('zorid:get-backlinks', async (event, vaultPath: string) => runtimeFor(event).getBacklinks(vaultPath));
ipcMain.handle('zorid:list-tags', async (event) => runtimeFor(event).listTags());
ipcMain.handle('zorid:get-outline', async (event, vaultPath: string) => runtimeFor(event).getOutline(vaultPath));
ipcMain.handle('zorid:list-types', async (event) => runtimeFor(event).listTypes());
ipcMain.handle('zorid:get-file-fields', async (event, vaultPath: string) => runtimeFor(event).getFileFields(vaultPath));
ipcMain.handle('zorid:update-file-field', async (event, vaultPath: string, key: string, value: JsonValue) =>
  runtimeFor(event).updateFileField(vaultPath, key, value),
);
ipcMain.handle('zorid:set-file-type', async (event, vaultPath: string, typeName?: string) =>
  runtimeFor(event).setFileType(vaultPath, typeName),
);
ipcMain.handle('zorid:list-bases', async (event) => runtimeFor(event).listBases());
ipcMain.handle('zorid:render-data-view', async (event, basePath: string, viewId?: string) =>
  runtimeFor(event).renderDataView(basePath, viewId),
);
ipcMain.handle('zorid:get-markdown-embeds', async (event, vaultPath: string) =>
  runtimeFor(event).getMarkdownEmbeds(vaultPath),
);
ipcMain.handle(
  'zorid:resolve-file-renderer',
  async (event, vaultPath: string, surface: 'full-page' | 'markdown-embed') =>
    runtimeFor(event).resolveFileRenderer(vaultPath, surface),
);
ipcMain.handle('zorid:open-external-url', async (_event, url: string) => openExternalUrl(url));
ipcMain.handle('zorid:list-commands', async (event) => runtimeFor(event).listCommands());
ipcMain.handle('zorid:execute-command', async (event, id: string, args?: JsonValue) =>
  runtimeFor(event).executeCommand(id, args),
);
ipcMain.handle('zorid:list-plugin-statuses', async (event) => runtimeFor(event).listPluginStatuses());
ipcMain.handle('zorid:list-settings-sections', async (event) =>
  windows.roleForSender(event.sender.id) === 'launcher'
    ? appSettingsSectionDtos()
    : runtimeFor(event).listSettingsSections(),
);
ipcMain.handle('zorid:get-setting-value', async (event, sectionId: string, pluginId?: string) =>
  isAppSetting(sectionId, pluginId)
    ? getAppSettingValue(sectionId)
    : runtimeFor(event).getSettingValue(sectionId, pluginId),
);
ipcMain.handle('zorid:set-setting-value', async (event, sectionId: string, value: JsonValue, pluginId?: string) =>
  isAppSetting(sectionId, pluginId)
    ? setAppSettingValue(sectionId, value)
    : runtimeFor(event).setSettingValue(sectionId, value, pluginId),
);

app
  .whenReady()
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
