'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`zorid:${name}`, ...args);
const durable = async (name, ...args) => {
  const workblock = name === 'durableInvoke' && args[2] === 'workblockCommand';
  let reply;
  try { reply = await invoke(name, ...args); }
  catch (error) {
    if (workblock) throw Object.assign(new Error('WorkBlock acknowledgement is uncertain; retain the identical operation ID and request.'), {code:'workblock_transport_lost',source:'host',commitUncertain:true});
    throw error;
  }
  if (!reply?.ok) throw Object.assign(new Error('Durable editor request failed; retain pending recovery state.'), reply?.error, {source:'host'});
  return reply.result;
};
contextBridge.exposeInMainWorld('zorid', Object.freeze({
  showContextMenu: request => invoke('showContextMenu', request),
  dismissContextMenu: () => invoke('dismissContextMenu'),
  getPathForFile: file => webUtils.getPathForFile(file),
  getWindowInfo: () => invoke('getWindowInfo'),
  newWindow: () => invoke('newWindow'),
  setMenuHotkeys: bindings => invoke('setMenuHotkeys', bindings),
  onCommand: callback => {
    const listener = (_event, id) => { if (id === 'close-tab') callback(id); };
    ipcRenderer.on('zorid:command', listener);
    return () => ipcRenderer.removeListener('zorid:command', listener);
  },
  compareAndWrite: (vault, path, expectedContent, contents) => invoke('compareAndWrite', vault, path, expectedContent, contents),
  getVault: () => invoke('getVault'),
  retryReconciliation: vault => invoke('retryReconciliation',vault),
  onBeforeClose: handler => {
    if (typeof handler !== 'function') throw new TypeError('Close handler required');
    let busy = false;
    const listener = async (_event, token) => {
      if (busy || typeof token !== 'string') return;
      busy = true;
      let ok = false;
      try { await handler(); ok = true; }
      catch { /* Main retains the window and shows the bounded failure notice. */ }
      try { await invoke('completeClose', token, ok); }
      catch { /* Lost IPC never authorizes native close. */ }
      finally { busy = false; }
    };
    ipcRenderer.on('zorid:prepare-close', listener);
    void invoke('closeHandlerReady', true).catch(() => {});
    return () => {
      ipcRenderer.removeListener('zorid:prepare-close', listener);
      void invoke('closeHandlerReady', false).catch(() => {});
    };
  },
  getDurableContext: vault => durable('getDurableContext', vault),
  durableInvoke: (vault, admissionId, method, args) => durable('durableInvoke', vault, admissionId, method, args),
  releaseDurableContext: (vault, admissionId) => durable('releaseDurableContext', vault, admissionId),
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
  remove: (vault, path, force) => invoke('remove', vault, path, force),
  onChange: callback => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('zorid:change', listener);
    return () => ipcRenderer.removeListener('zorid:change', listener);
  },
}));
