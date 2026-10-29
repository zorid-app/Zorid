'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`zorid:${name}`, ...args);
// This optional route transfers generic errors as data. Keep legacy throws and
// all established domain envelopes unchanged for older renderer callers.
const durableFailure = (code, commitUncertain, source) => ({durableError:true,schemaVersion:1,error:{code,commitUncertain,source}});
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [null,Object.prototype].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const journalFailure=(code,commitUncertain,source)=>({independentJournal:true,schemaVersion:1,ok:false,error:{code,commitUncertain,source}});
const independentJournal=async request=>{
  if(!exact(request,['vault','token','op','args'])||typeof request.vault!=='string'||!request.vault||request.vault.length>4096||request.vault.includes('\0')
    ||typeof request.token!=='string'||!request.token||request.token.length>128||!['list','read','compareAndSwap','retire'].includes(request.op)||!Array.isArray(request.args)||request.args.length>1)
    return journalFailure('invalid_draft_request',false,'protocol');
  let reply;
  try{reply=await invoke('independentJournal',request);}catch{return journalFailure('draft_transport_lost',true,'transport');}
  if(exact(reply,['independentJournal','schemaVersion','ok','value'])&&reply.independentJournal===true&&reply.schemaVersion===1&&reply.ok===true)return reply;
  if(exact(reply,['independentJournal','schemaVersion','ok','error'])&&reply.independentJournal===true&&reply.schemaVersion===1&&reply.ok===false&&exact(reply.error,['code','commitUncertain','source'])
    &&typeof reply.error.code==='string'&&/^[a-z_]{1,64}$/.test(reply.error.code)&&typeof reply.error.commitUncertain==='boolean'&&reply.error.source==='main')return reply;
  return journalFailure('invalid_draft_response',true,'protocol');
};
const durableMethods = new Set(['readText','readTextById','composeNote','planWrite','prepare','commit','query','listUnacknowledged','acknowledge',
  'checkpoints.load','checkpoints.compareAndSwap','checkpoints.list','checkpoints.changes','createText','createTextReceipt','fileCommand',
  'captureSavedSource','releaseSavedSource','databaseCommand','workblockCommand','documentCommand','documentDrafts','binaryCommand',
  'documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome']);
const durable = (name, ...args) => runDurable(false,name,args);
const durableRequest = request => {
  const kind = plain(request) ? request.kind : undefined;
  const keys = kind === 'context' ? ['kind','vault'] : kind === 'invoke' ? ['kind','vault','admissionId','method','args'] : ['kind','vault','admissionId'];
  if (!['context','recover','invoke','release'].includes(kind) || !exact(request,keys)
    || typeof request.vault !== 'string' || !request.vault || request.vault.length > 4096
    || kind !== 'context' && (typeof request.admissionId !== 'string' || !request.admissionId || request.admissionId.length > 128)
    || kind === 'invoke' && (!durableMethods.has(request.method) || !Array.isArray(request.args) || request.args.length > 2)) {
    return Promise.resolve(durableFailure('invalid_durable_request',false,'protocol'));
  }
  if (kind === 'context') return runDurable(true,'getDurableContext',[request.vault]);
  if (kind === 'recover') return runDurable(true,'recoverDurableContext',[request.vault,request.admissionId]);
  if (kind === 'release') return runDurable(true,'releaseDurableContext',[request.vault,request.admissionId]);
  return runDurable(true,'durableInvoke',[request.vault,request.admissionId,request.method,Array.prototype.slice.call(request.args)]);
};
const runDurable = async (typed, name, args) => {
  const databases = name === 'durableInvoke' && args[2] === 'databaseCommand';
  const workblock = name === 'durableInvoke' && args[2] === 'workblockCommand';
  const planning = name === 'durableInvoke' && args[2] === 'planWrite';
  const runtime = name === 'durableInvoke' && ['documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome'].includes(args[2]);
  let reply;
  try { reply = await invoke(name, ...args); }
  catch (error) {
    if (databases) return {databases:true,schemaVersion:1,ok:false,error:{code:'database_transport_lost',source:'host',commitUncertain:true}};
    if (planning) return {notePlanning:true,schemaVersion:1,ok:false,error:{code:'planning_transport_lost',source:'host',commitUncertain:true}};
    if (workblock) return {workblocks:true,schemaVersion:1,ok:false,error:{code:'workblock_transport_lost',source:'host',commitUncertain:true}};
    if (runtime) return {documentRuntime:true,schemaVersion:1,ok:false,error:{code:'document_runtime_transport_lost',source:'host',commitUncertain:true}};
    if (typed) return durableFailure('durable_transport_lost',true,'transport');
    throw error;
  }
  if (typed && !databases && !planning && !workblock && !runtime) {
    if (exact(reply,['ok','result']) && reply.ok === true) return reply.result;
    const valid = exact(reply,['ok','error']) && reply.ok === false && exact(reply.error,['code','commitUncertain'])
      && typeof reply.error.code === 'string' && /^[a-z_]{1,64}$/.test(reply.error.code) && typeof reply.error.commitUncertain === 'boolean';
    return valid ? durableFailure(reply.error.code,reply.error.commitUncertain,'host') : durableFailure('invalid_durable_response',true,'protocol');
  }
  if (databases) {
    if(reply?.ok===true)return {databases:true,schemaVersion:1,ok:true,value:reply.result};
    const valid=reply?.ok===false&&typeof reply.error?.code==='string'&&/^[a-z_]{1,64}$/.test(reply.error.code)&&typeof reply.error.commitUncertain==='boolean';
    return {databases:true,schemaVersion:1,ok:false,error:{code:valid?reply.error.code:'invalid_database_response',source:'host',commitUncertain:valid?reply.error.commitUncertain:true}};
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
  if (!reply?.ok) {
    const savedSource = name === 'durableInvoke' && ['captureSavedSource','releaseSavedSource'].includes(args[2]);
    const error = reply?.error;
    // Main redacts failures to this bounded shape. contextBridge preserves the
    // message but drops custom Error fields, so explain only a definitive guard
    // rejection here; unknown replies and acknowledgement uncertainty stay generic.
    if (savedSource && reply?.ok === false && error && typeof error === 'object' && !Array.isArray(error)
      && Object.keys(error).length === 2 && Object.hasOwn(error,'code') && Object.hasOwn(error,'commitUncertain')
      && error.code === 'conditional_source_changed' && error.commitUncertain === false) {
      throw Object.assign(new Error('The file changed or was replaced. Your draft was kept; refresh before saving.'), {code:error.code,commitUncertain:false,source:'host'});
    }
    throw Object.assign(new Error('Durable editor request failed; retain pending recovery state.'), error, {source:'host'});
  }
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
  durableRequest,
  independentJournal,
  recoverDurableContext: (vault, admissionId) => durable('recoverDurableContext', vault, admissionId),
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
