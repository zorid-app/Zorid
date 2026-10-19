'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`zorid:${name}`, ...args);
const durable = async (name, ...args) => {
  const workblock = name === 'durableInvoke' && args[2] === 'workblockCommand';
  const planning = name === 'durableInvoke' && args[2] === 'planWrite';
  const runtime = name === 'durableInvoke' && ['documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome'].includes(args[2]);
  let reply;
  try { reply = await invoke(name, ...args); }
  catch (error) {
    if (planning) return {notePlanning:true,schemaVersion:1,ok:false,error:{code:'planning_transport_lost',source:'host',commitUncertain:true}};
    if (workblock) return {workblocks:true,schemaVersion:1,ok:false,error:{code:'workblock_transport_lost',source:'host',commitUncertain:true}};
    if (runtime) return {documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_transport_lost',source:'host',commitUncertain:true}};
    throw error;
  }
  if (runtime) {
    if (reply?.ok === true) return {documentRuntime:true,schemaVersion:1,ok:true,value:reply.result};
    const valid = reply?.ok === false && typeof reply.error?.code === 'string'
      && /^[a-z_]{1,64}$/.test(reply.error.code) && typeof reply.error.commitUncertain === 'boolean';
    return {documentRuntime:true,schemaVersion:1,ok:false,error:{code:valid?reply.error.code:'invalid_document_response',source:'host',commitUncertain:valid?reply.error.commitUncertain:true}};
  }
  if (workblock) {
    // contextBridge copies Error objects without custom properties. Transfer
    // only bounded plain data; the renderer reconstructs its own typed error.
    if (reply?.ok === true) return {workblocks:true,schemaVersion:1,ok:true,value:reply.result};
    const valid = reply?.ok === false && typeof reply.error?.code === 'string'
      && /^[a-z_]{1,64}$/.test(reply.error.code) && typeof reply.error.commitUncertain === 'boolean';
    return {workblocks:true,schemaVersion:1,ok:false,error:{code:valid?reply.error.code:'invalid_workblock_response',source:'host',commitUncertain:valid?reply.error.commitUncertain:true}};
  }
  if (planning) {
    // Return plain data: contextBridge does not preserve custom Error fields.
    if (reply?.ok === true) return {notePlanning:true,schemaVersion:1,ok:true,value:reply.result};
    const valid = reply?.ok === false && typeof reply.error?.code === 'string'
      && /^[a-z_]{1,64}$/.test(reply.error.code) && typeof reply.error.commitUncertain === 'boolean';
    return {notePlanning:true,schemaVersion:1,ok:false,error:{code:valid?reply.error.code:'invalid_planning_response',source:'host',commitUncertain:valid?reply.error.commitUncertain:true}};
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
  reopenCalendarRecovery: request => invoke('reopenCalendarRecovery', request),
  setMenuHotkeys: bindings => invoke('setMenuHotkeys', bindings),
  onCommand: callback => {
    const listener = (_event, id) => { if (id === 'close-tab') callback(id); };
    ipcRenderer.on('zorid:command', listener);
    return () => ipcRenderer.removeListener('zorid:command', listener);
  },
  compareAndWrite: (vault, path, expectedContent, contents) => invoke('compareAndWrite', vault, path, expectedContent, contents),
  getVault: () => invoke('getVault'),
  recoveryList: (vault,entryId,options) => invoke('recoveryList',vault,entryId,options),
  recoveryRead: (vault,entryId,snapshotId) => invoke('recoveryRead',vault,entryId,snapshotId),
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
  onDocumentRuntimeNudge: (vault, admissionId, callback, onRetire) => {
    if(typeof vault!=='string'||!vault||typeof admissionId!=='string'||!admissionId||typeof callback!=='function'||typeof onRetire!=='function')throw new TypeError('Admitted runtime receiver required');
    let retired=false;
    const listener = (_event, message) => {
      if(retired||!message||typeof message!=='object'||Array.isArray(message)||message.vault!==vault||message.admissionId!==admissionId)return;
      if(Object.keys(message).length===2)callback();
      else if(Object.keys(message).length===3&&message.retired===true){retired=true;onRetire();}
    };
    ipcRenderer.on('zorid:document-runtime',listener);
    return ()=>ipcRenderer.removeListener('zorid:document-runtime',listener);
  },
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
