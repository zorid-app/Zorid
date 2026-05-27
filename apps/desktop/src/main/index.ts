import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { normalizeVaultPath } from '@zorid/shared';
import { createVaultService, type FolderVault } from '@zorid/vault';

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

let activeVault: FolderVault | undefined;
const windows = new Set<BrowserWindow>();

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
      preload: path.join(currentDirectory, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const devServerUrl = rendererUrl();
  if (devServerUrl) {
    await win.loadURL(devServerUrl);
  } else {
    await win.loadFile(path.join(currentDirectory, '../renderer/index.html'));
  }

  windows.add(win);
  win.on('closed', () => {
    windows.delete(win);
  });

  return win;
}

function requireVault(): FolderVault {
  if (!activeVault) throw new Error('No vault is open.');
  return activeVault;
}

ipcMain.handle('zorid:open-vault', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || result.filePaths[0] === undefined) return undefined;
  activeVault = createVaultService(result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle('zorid:read-vault-text', async (_event, vaultPath: string) => requireVault().read(normalizeVaultPath(vaultPath)));
ipcMain.handle('zorid:write-vault-text', async (_event, vaultPath: string, contents: string) => requireVault().write(normalizeVaultPath(vaultPath), contents));

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
  if (process.platform !== 'darwin') app.quit();
});
