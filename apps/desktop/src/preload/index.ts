import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEditorBridge, DesktopLauncherBridge } from '../index.js';

const launcher: DesktopLauncherBridge = {
  getWindowRole: () => ipcRenderer.invoke('zorid:get-window-role'),
  createVault: () => ipcRenderer.invoke('zorid:create-vault'),
  openVault: () => ipcRenderer.invoke('zorid:open-vault'),
  listRecentVaults: () => ipcRenderer.invoke('zorid:list-recent-vaults'),
  openRecentVault: (id) => ipcRenderer.invoke('zorid:open-recent-vault', id),
};

const editor: DesktopEditorBridge = {
  getVaultProfile: () => ipcRenderer.invoke('zorid:get-vault-profile'),
  listVault: (path) => ipcRenderer.invoke('zorid:list-vault', path),
  readVaultText: (path) => ipcRenderer.invoke('zorid:read-vault-text', path),
  writeVaultText: (path, contents) => ipcRenderer.invoke('zorid:write-vault-text', path, contents),
  createVaultFolder: (path) => ipcRenderer.invoke('zorid:create-vault-folder', path),
  createMarkdownFile: (path, contents) => ipcRenderer.invoke('zorid:create-markdown-file', path, contents),
  renameVaultPath: (from, to) => ipcRenderer.invoke('zorid:rename-vault-path', from, to),
  deleteVaultPath: (path) => ipcRenderer.invoke('zorid:delete-vault-path', path),
  getIndexStatus: () => ipcRenderer.invoke('zorid:get-index-status'),
  rebuildIndex: () => ipcRenderer.invoke('zorid:rebuild-index'),
  searchIndex: (query) => ipcRenderer.invoke('zorid:search-index', query),
  getBacklinks: (path) => ipcRenderer.invoke('zorid:get-backlinks', path),
  listTags: () => ipcRenderer.invoke('zorid:list-tags'),
  getOutline: (path) => ipcRenderer.invoke('zorid:get-outline', path),
  listTypes: () => ipcRenderer.invoke('zorid:list-types'),
  getFileFields: (path) => ipcRenderer.invoke('zorid:get-file-fields', path),
  updateFileField: (path, key, value) => ipcRenderer.invoke('zorid:update-file-field', path, key, value),
  setFileType: (path, typeName) => ipcRenderer.invoke('zorid:set-file-type', path, typeName),
  listBases: () => ipcRenderer.invoke('zorid:list-bases'),
  renderDataView: (basePath, viewId) => ipcRenderer.invoke('zorid:render-data-view', basePath, viewId),
  getMarkdownEmbeds: (path) => ipcRenderer.invoke('zorid:get-markdown-embeds', path),
  onIndexUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('zorid:index-updated', listener);
    ipcRenderer.on('zorid:index-status', listener);
    return () => {
      ipcRenderer.removeListener('zorid:index-updated', listener);
      ipcRenderer.removeListener('zorid:index-status', listener);
    };
  },
  onEditorSnapshot: (callback) => {
    const listener = (_event: unknown, snapshot: Parameters<typeof callback>[0]) => callback(snapshot);
    ipcRenderer.on('zorid:editor-snapshot', listener);
    return () => { ipcRenderer.removeListener('zorid:editor-snapshot', listener); };
  },
  listCommands: () => ipcRenderer.invoke('zorid:list-commands'),
  executeCommand: (id, args) => ipcRenderer.invoke('zorid:execute-command', id, args),
  listPluginStatuses: () => ipcRenderer.invoke('zorid:list-plugin-statuses'),
  listSettingsSections: () => ipcRenderer.invoke('zorid:list-settings-sections'),
  getSettingValue: (sectionId, pluginId) => ipcRenderer.invoke('zorid:get-setting-value', sectionId, pluginId),
  setSettingValue: (sectionId, value, pluginId) => ipcRenderer.invoke('zorid:set-setting-value', sectionId, value, pluginId),
};

const bridge: DesktopBridge = { ...launcher, ...editor, launcher, editor };

contextBridge.exposeInMainWorld('zoridDesktop', bridge);
