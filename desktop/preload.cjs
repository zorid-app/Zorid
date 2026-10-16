'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`zorid:${name}`, ...args);
contextBridge.exposeInMainWorld('zorid', Object.freeze({
  showContextMenu: request => invoke('showContextMenu', request),
  dismissContextMenu: () => invoke('dismissContextMenu'),
  getPathForFile: file => webUtils.getPathForFile(file),
  getWindowInfo: () => invoke('getWindowInfo'),
  newWindow: () => invoke('newWindow'),
  compareAndWrite: (vault, path, expectedContent, contents) => invoke('compareAndWrite', vault, path, expectedContent, contents),
  getVault: () => invoke('getVault'),
  openVault: () => invoke('openVault'),
  list: vault => invoke('list', vault),
  stat: (vault, path) => invoke('stat', vault, path),
  read: (vault, path) => invoke('read', vault, path),
  readBinary: (vault, path) => invoke('readBinary', vault, path),
  write: (vault, path, contents) => invoke('write', vault, path, contents),
  writeBinary: (vault, path, contents) => invoke('writeBinary', vault, path, contents),
  mkdir: (vault, path) => invoke('mkdir', vault, path),
  rename: (vault, from, to) => invoke('rename', vault, from, to),
  trash: (vault, path) => invoke('trash', vault, path),
  onChange: callback => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('zorid:change', listener);
    return () => ipcRenderer.removeListener('zorid:change', listener);
  },
}));
