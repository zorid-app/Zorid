import path from 'node:path';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { normalizeVaultPath } from '@zorid/shared';
import { createVaultService, type FolderVault } from '@zorid/vault';

let activeVault: FolderVault | undefined;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(app.getAppPath(), 'src/renderer.html'));
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

app.whenReady().then(createWindow);
