import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../index.js';

const bridge: DesktopBridge = {
  openVault: () => ipcRenderer.invoke('zorid:open-vault'),
  readVaultText: (path) => ipcRenderer.invoke('zorid:read-vault-text', path),
  writeVaultText: (path, contents) => ipcRenderer.invoke('zorid:write-vault-text', path, contents),
};

contextBridge.exposeInMainWorld('zoridDesktop', bridge);
