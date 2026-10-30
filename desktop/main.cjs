'use strict';
// Opt-in attribution only: retain fixed phase names before Electron or local
// modules load, so a late inspector can read the original Main chronology.
const startupEntry = process.env.ZORID_PROFILE_STARTUP === '1' ? {
  atMs: performance.now(), timeOrigin: performance.timeOrigin, uptimeMs: process.uptime() * 1000,
} : null;
const startupProfile = startupEntry ? {
  version: 1, timeOrigin: startupEntry.timeOrigin, moduleEntryUptimeMs: startupEntry.uptimeMs,
  phases: [{ phase: 'module.entry', atMs: startupEntry.atMs }], truncated: false,
} : null;
if (startupProfile) globalThis.__zoridStartupProfile = startupProfile;
function startupMark(phase) {
  if (!startupProfile) return;
  if (startupProfile.phases.length >= 128) { startupProfile.truncated = true; return; }
  startupProfile.phases.push({ phase, atMs: performance.now() });
}
function startupObserve(phase, result) {
  if (!startupProfile) return result;
  if (result && typeof result.then === 'function') {
    result.then(() => startupMark(`${phase}.fulfilled`), () => startupMark(`${phase}.rejected`));
  } else startupMark(`${phase}.fulfilled`);
  return result;
}
function startupCall(phase, callback) {
  startupMark(`${phase}.begin`);
  try { return startupObserve(phase, callback()); }
  catch (error) { startupMark(`${phase}.rejected`); throw error; }
}
startupMark('require.electron.begin');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
startupMark('require.electron.complete');
startupMark('require.node.begin');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
startupMark('require.node.complete');
startupMark('require.local.begin');
const { VaultService } = require('./vault-service.cjs');
const { WindowBroker } = require('./window-broker.cjs');
const { captureRichDiagnostic } = require('./document-semantics.cjs');
startupMark('require.local.complete');
startupMark('editor_core.create.begin');
const editorCore = require('./editor-core.cjs').createEditorCoreManager(process.env,{isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,documentRuntime:true,
  onDocumentRuntimeNudge:(record,message)=>record.window.webContents.send('zorid:document-runtime',message)});
startupMark('editor_core.create.complete');
let clientSlots;
let independentJournalManager;
const journalDocumentEpoch=new WeakMap();
function revokeIndependentJournal(record){journalDocumentEpoch.set(record,(journalDocumentEpoch.get(record)??0)+1);independentJournalManager?.revoke(record);}
function independentJournal(){
  if(!independentJournalManager){
    const {openDraftJournal}=require('./draft-journal.cjs');
    const {createLazyDraftJournal}=require('./lazy-draft-journal.cjs');
    const {createDraftJournalAdmissionManager}=require('./draft-journal-admission.cjs');
    independentJournalManager=createDraftJournalAdmissionManager({broker,journal:createLazyDraftJournal(()=>openDraftJournal(path.join(app.getPath('userData'),'draft-journal-v2'))),
      quiesceCore:(record,root,grant)=>{
        if(!ownsApplication||!editorCore)throw Object.assign(new Error('Independent draft owner is unavailable.'),{code:'draft_admission_denied'});
        return editorCore.quiesceJournalOwner(broker,record,root,grant);
      }});
  }
  return independentJournalManager;
}
function captureJournalOwner(record,event,expectedRoot){
  const entry=record.vault,generation=record.generation,webContents=record.window.webContents,frame=webContents.mainFrame,slot=record.clientSlot,epoch=journalDocumentEpoch.get(record)??0,persistedRoot=record.persistedVaultRoot;
  const check=()=>{
    try{
    if(broker.authenticate(event)!==record||!entry||record.vault!==entry||record.generation!==generation||record.window.webContents!==webContents||webContents.mainFrame!==frame||record.clientSlot!==slot
      ||record.vaultSelectionPending||typeof expectedRoot!=='string'||entry.service.root!==expectedRoot||persistedRoot!==expectedRoot||record.persistedVaultRoot!==persistedRoot||(journalDocumentEpoch.get(record)??0)!==epoch)
      throw Error();
    }catch{throw Object.assign(new Error('The independent draft owner changed.'),{code:'draft_admission_denied',commitUncertain:false});}
  };check();return check;
}
async function contextWithIndependentJournal(record,event,expectedRoot,operation){
  const check=captureJournalOwner(record,event,expectedRoot),context=await operation(check);check();
  if(!context)return context;
  const grant=independentJournal().attach(record,context);check();
  const admissionId=editorCore.bindIndependentJournal(broker,record,expectedRoot,context.admissionId,grant,check);check();
  return{...context,admissionId,independentJournal:grant};
}
startupMark('require.menus.begin');
const { createContextMenuController } = require('./context-menu.cjs');
const { validateMenuHotkeys, workspaceFileMenu } = require('./menu-hotkeys.cjs');
startupMark('require.menus.complete');
const menuHotkeys = new WeakMap();
const closeStates = new WeakMap();
let quitRequested = false;
const contextMenus = createContextMenuController(Menu);
app.setName('Zorid');
const familyFixture = process.env.ZORID_DESKTOP_FAMILY_FIXTURE === '1';
const devUrl = process.env.ZORID_DEV_URL;
const packagedUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
function allowedURL(url) {
  try { const current = new URL(url); current.hash = ''; const expected = new URL(devUrl || packagedUrl); expected.hash = ''; return current.href === expected.href; }
  catch { return false; }
}
let startupVaultOpening;
const broker = new WindowBroker({ openVault: directory => startupCall('vault_open', () => {
  if (startupVaultOpening?.directory === directory) {
    const opening = startupVaultOpening.promise;
    startupVaultOpening = undefined;
    return opening;
  }
  return editorCore ? editorCore.open(directory) : VaultService.open(directory);
}), allowedURL });
let lastVaultPath;
function handle(name, callback) {
  ipcMain.handle(`zorid:${name}`, (event, ...args) => {
    const record = broker.authenticate(event);
    const profiled = startupProfile && (name === 'getVault' || name === 'getDurableContext');
    if (profiled) startupMark(`ipc.${name}.received`);
    const dispatch = () => profiled ? startupCall(`ipc.${name}.dispatch`, () => callback(record, event, ...args)) : callback(record, event, ...args);
    // Renderer/module loading overlaps vault initialization. Its window identity
    // is already usable, but no vault capability may escape the opening barrier.
    const epoch=journalDocumentEpoch.get(record)??0,frame=event.senderFrame,webContents=event.sender;
    if (record.opening && name !== 'getWindowInfo') {
      if (profiled) startupMark(`ipc.${name}.opening_wait`);
      return record.opening.then(() => {
        if (broker.authenticate(event) !== record||(journalDocumentEpoch.get(record)??0)!==epoch||record.window.webContents!==webContents||webContents.mainFrame!==frame) throw new Error('Window changed while opening');
        return dispatch();
      });
    }
    return dispatch();
  });
}
function registerIPC() {
  handle('showContextMenu', (record, _event, request) => contextMenus.popup(record.window, request));
  handle('dismissContextMenu', record => contextMenus.close(record.window));
  handle('getWindowInfo', record => broker.info(record));
  handle('setMenuHotkeys', (record, _event, bindings) => { menuHotkeys.set(record.window, validateMenuHotkeys(bindings)); if (BrowserWindow.getFocusedWindow() === record.window) refreshApplicationMenu(); });
  handle('newWindow', async record => {
    return { id: (await createWindow({ source: record })).id };
  });
  handle('reopenCalendarRecovery', async (record, event, request) => {
    if (!request || typeof request.originalWindowId !== 'string' || request.originalWindowId === 'primary' || request.originalWindowId.length > 64 || typeof request.expectedVaultId !== 'string'
      || !request.expectedVaultId.length || request.expectedVaultId.length > 128) throw new Error('Invalid recovery request');
    const originalWindowId = request.originalWindowId, expectedVaultId = request.expectedVaultId;
    const entry = record.vault, generation = record.generation, root = entry?.service.root;
    const check = (opened) => {
      if (broker.authenticate(event) !== record || !entry || record.vault !== entry || record.generation !== generation
        || record.vaultSelectionPending || closeStates.get(record)?.pending || entry.service.closed
        || record.persistedVaultRoot !== root) throw new Error('Recovery caller changed');
      if (opened) {
        broker.assertLive(opened);
        if (opened.vault?.service.root !== root || opened.vaultSelectionPending) throw new Error('Recovery target vault changed');
      }
      if ([...broker.windows.values()].some(owner => owner.id === originalWindowId && owner !== opened)) throw new Error('Recovery window is still in use');
    };
    check();
    if (!editorCore || !clientSlots) throw new Error('Recovery is unavailable');
    const admitted = await editorCore.context(broker, record, root);
    check();
    if (!admitted || admitted.scope.vaultId !== expectedVaultId) throw new Error('Recovery vault does not match');
    const checkAdmission = async opened => {
      check(opened);
      const current = await editorCore.context(broker, record, root);
      check(opened);
      if (current?.admissionId !== admitted.admissionId || current.scope.vaultId !== expectedVaultId
        || current.scope.clientId !== admitted.scope.clientId) throw new Error('Recovery admission changed');
    };
    const id = originalWindowId === 'main' ? 'primary' : originalWindowId;
    const slot = (await clientSlots.listExisting()).find(row => row.slotId === id);
    await checkAdmission();
    if (!slot?.vaultPath || await fs.realpath(slot.vaultPath) !== root) throw new Error('Original recovery slot is unavailable for this vault');
    await checkAdmission();
    const opened = await createWindow({ primary: id === 'primary', restoreSlot: slot, initialState: 'restore', recoveryCheck: checkAdmission, recoveryAssert: check });
    return { id: opened.id };
  });
  handle('getVault', record => broker.describe(record));
  handle('closeHandlerReady', (record, _event, ready) => {
    const state = closeStates.get(record);
    if (state) state.ready = ready === true;
    if (state?.ready) startupMark('close_handler.ready');
  });
  handle('completeClose', (record, _event, token, ok) => {
    const state = closeStates.get(record);
    if (!state?.pending || state.pending.token !== token || state.pending.generation !== record.generation) return;
    state.pending = null;
    if (ok !== true) {
      quitRequested = false;
      dialog.showMessageBox(record.window, { type: 'error', message: 'The vault could not finish saving.', detail: 'The window remains open. Resolve the save error and try closing again.', buttons: ['Keep open'] });
      return;
    }
    try { editorCore?.requireReleased(record); }
    catch {
      quitRequested = false;
      dialog.showMessageBox(record.window, { type: 'error', message: 'The vault is still in use.', detail: 'Finish saving before closing this window.', buttons: ['Keep open'] });
      return;
    }
    state.allowed = true;
    setImmediate(() => { if (!record.window.isDestroyed()) { if (quitRequested) app.quit(); else record.window.close(); } });
  });
  handle('openVault', async (record, event) => {
    if (closeStates.get(record)?.pending||record.vaultSelectionPending) throw new Error('Finish closing, saving or switching before opening another vault.');
    editorCore?.requireReleased(record);
    record.vaultSelectionPending=true;
    try {
      const selection = await dialog.showOpenDialog(record.window, { title: 'Open folder as vault', properties: ['openDirectory', 'createDirectory'] });
      if (selection.canceled || !selection.filePaths[0]) return null;
      broker.authenticate(event);
      editorCore?.requireReleased(record);
      const previousService=record.vault?.service;
      revokeIndependentJournal(record);
      const result = await broker.select(record, selection.filePaths[0]);
      if(previousService&&previousService!==record.vault?.service)await editorCore?.retire(broker,record,previousService);
      record.persistedVaultRoot=null;
      await clientSlots?.setVault(record.clientSlot.slotId,result.path);
      record.persistedVaultRoot=result.path;
      lastVaultPath = result.path;
      const stateFile = path.join(app.getPath('userData'), 'vault.json');
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify({ path: result.path }), { mode: 0o600 });
      return result;
    } finally {record.vaultSelectionPending=false;}
  });
  const durableReply = async callback => {
    try { return { ok: true, result: await callback() }; }
    catch (error) { return { ok: false, error: { code: typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'durable_request_failed', commitUncertain: error?.commitUncertain === true } }; }
  };
  handle('getDurableContext', (record, event, expectedRoot) => durableReply(() => contextWithIndependentJournal(record,event,expectedRoot,check=>editorCore ? editorCore.context(broker, record, expectedRoot,undefined,check) : null)));
  handle('recoverDurableContext', (record, event, expectedRoot, admissionId) => durableReply(() => contextWithIndependentJournal(record,event,expectedRoot,check=>{
    if (!editorCore) throw new Error('No Rust editor context');
    return editorCore.recover(broker, record, event, expectedRoot, admissionId,check);
  })));
  ipcMain.handle('zorid:independentJournal',async(event,input)=>{
    try{
      const record=broker.authenticate(event);
      if(!input||typeof input!=='object'||Array.isArray(input)||Reflect.ownKeys(input).length!==4||!['vault','token','op','args'].every(key=>Object.hasOwn(input,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value')))throw{code:'invalid_draft_request'};
      const check=captureJournalOwner(record,event,input.vault),value=await independentJournal().dispatch(record,event,input.vault,input.token,{op:input.op,args:input.args});
      try{check();}catch(error){if(input.op==='compareAndSwap'||input.op==='retire')error.commitUncertain=true;throw error;}
      return{independentJournal:true,schemaVersion:1,ok:true,value};
    }catch(error){return{independentJournal:true,schemaVersion:1,ok:false,error:{code:typeof error?.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?error.code:'draft_admission_denied',commitUncertain:error?.commitUncertain===true,source:'main'}};}
  });
  handle('durableInvoke', (record, event, expectedRoot, admissionId, method, args) => durableReply(async () => {
    if (!editorCore) throw new Error('No Rust editor context');
    if(method==='documentDrafts'){
      try{return {documentDrafts:true,schemaVersion:1,ok:true,value:await editorCore.invoke(broker,record,event,expectedRoot,admissionId,method,args)};}
      catch(error){return {documentDrafts:true,schemaVersion:1,ok:false,error:{code:typeof error?.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?error.code:'invalid_document_response',commitUncertain:error?.commitUncertain===true}};}
    }
    if(method==='documentCommand'&&['rich_start','rich_prepare','rich_page','rich_close','metadata_rows','preview_open','preview_base','preview_close'].includes(args?.[0]?.command?.op)){
      // Return plain data through the existing preload pass-through: Electron's
      // contextBridge does not preserve custom properties on thrown Errors.
      try { return {documents:true,schemaVersion:1,ok:true,value:await editorCore.invoke(broker, record, event, expectedRoot, admissionId, method, args)}; }
      catch(error){
        const failure={code:typeof error?.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?error.code:'invalid_document_response',commitUncertain:error?.commitUncertain===true};
        if(failure.code==='search_compile'&&args?.[0]?.command?.op!=='metadata_rows'&&!args?.[0]?.command?.op?.startsWith('preview_')){
          try {if(!error.details||Object.keys(error.details).length!==1||!Object.hasOwn(error.details,'diagnostic'))throw new Error();failure.details={diagnostic:captureRichDiagnostic(error.details.diagnostic)};}
          catch {failure.code='invalid_document_response';}
        }
        return {documents:true,schemaVersion:1,ok:false,error:failure};
      }
    }
    return editorCore.invoke(broker, record, event, expectedRoot, admissionId, method, args);
  }));
  handle('releaseDurableContext', (record, event, expectedRoot, admissionId) => durableReply(async() => {
    if (!editorCore) throw new Error('No Rust editor context');
    const check=captureJournalOwner(record,event,expectedRoot);
    await editorCore.release(broker, record, event, expectedRoot, admissionId);check();revokeIndependentJournal(record);
  }));
  for (const method of ['list', 'stat', 'read', 'readBinary', 'write', 'writeBinary', 'compareAndWrite', 'mkdir', 'rename', 'trash', 'remove', 'retryReconciliation', 'recoveryList', 'recoveryRead']) {
    handle(method, (record, event, expectedRoot, ...args) => broker.dispatch(record, expectedRoot, method, method==='recoveryList'||method==='recoveryRead'?structuredClone(args):args, () => broker.authenticate(event)));
  }
}
async function createWindow({ source, primary = false, initialState = 'empty', restoreSlot, recoveryCheck, recoveryAssert } = {}) {
  startupMark('window.create.begin');
  if (source) {
    broker.assertLive(source);
  }
  const clientSlot=clientSlots?await clientSlots.claim(restoreSlot?{slotId:restoreSlot.slotId,...(recoveryCheck?{existingOnly:true,expectedClientId:restoreSlot.clientId,expectedVaultPath:restoreSlot.vaultPath}:{})}:primary?{primary:true}:{}):null;
  let window, record;
  try {
    if (recoveryCheck) { await recoveryCheck(); recoveryAssert(); }
    if (coreClosing || coreClosed) throw Object.assign(new Error('Zorid is closing.'), {code:'editor_core_closed'});
    startupMark('window.construct.begin');
    window = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 480, title: 'Zorid', backgroundColor: '#1e1e1e', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    startupMark('window.construct.complete');
    record = broker.register(window, { primary, initialState, persistentId:clientSlot?.slotId });
  } catch (error) {
    if (window && !window.isDestroyed()) window.destroy();
    if (clientSlot) await clientSlots.release(clientSlot.slotId, {restore:true});
    throw error;
  }
  record.clientSlot=clientSlot;
  const closeState = {ready: false, pending: null, allowed: false};
  closeStates.set(record, closeState);
  window.on('close', event => {
    if (!editorCore?.owns(record) || closeState.allowed) return;
    event.preventDefault();
    if (closeState.pending) return;
    if (!closeState.ready) {
      quitRequested = false;
      void dialog.showMessageBox(window, {type:'info',message:'The vault is still opening.',detail:'Wait for recovery to finish before closing this window.',buttons:['Keep open']});
      return;
    }
    const token = randomUUID();
    closeState.pending = {token, generation: record.generation};
    window.webContents.send('zorid:prepare-close', token);
  });
  window.on('focus', refreshApplicationMenu);
  window.on('closed', () => {
    revokeIndependentJournal(record);
    const selectedService=record.vault?.service;
    contextMenus.close(window);broker.remove(record);
    void (async()=>{await editorCore?.retire(broker,record,selectedService);
      if(clientSlot)await clientSlots.release(clientSlot.slotId,{restore:quitRequested||!closeState.allowed});
    })().catch(error=>console.error('Window recovery ownership retained:',error.code||'close_failed'));
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!allowedURL(url)) event.preventDefault(); });
  window.webContents.on('did-start-navigation',(details,_url,isInPlace,isMainFrame)=>{
    const main=typeof details?.isMainFrame==='boolean'?details.isMainFrame:isMainFrame;
    const same=typeof details?.isSameDocument==='boolean'?details.isSameDocument:isInPlace;
    if(main===true&&same!==true)revokeIndependentJournal(record);
  });
  window.webContents.on('render-process-gone',()=>revokeIndependentJournal(record));
  startupMark('window.opening.begin');
  const opening = (async () => {
    if (source) broker.bind(record, source.vault);
    else {
      const selected=restoreSlot?.vaultPath||(primary?clientSlot?.vaultPath||lastVaultPath:null);
      if(selected){
        try {await broker.select(record,selected);if(recoveryCheck){await recoveryCheck(record);recoveryAssert(record);}}
        catch(error){if(recoveryCheck)throw error;dialog.showErrorBox('Could not open Rust vault',`${error.code||'vault_open_failed'}: ${error.message}`);}
      }
    }
    if(record.vault&&clientSlot){await clientSlots.setVault(clientSlot.slotId,record.vault.service.root);record.persistedVaultRoot=record.vault.service.root;}
    if (recoveryCheck) { await recoveryCheck(record); recoveryAssert(record); }
  })();
  startupObserve('window.opening', opening);
  record.opening = opening;
  try {
    // Start Chromium navigation before waiting for Rust/import/recovery. IPC
    // above still admits all vault operations only after opening succeeds.
    // Convert a synchronous navigation exception into a joined rejection too;
    // opening must remain observed if Chromium rejects navigation immediately.
    const loading = startupCall('navigation', () => (async () => devUrl ? window.loadURL(devUrl) : window.loadFile(path.join(__dirname, '../dist/index.html')))());
    await Promise.all([opening, loading]);
    if (recoveryCheck) { await recoveryCheck(record); recoveryAssert(record); }
    startupMark('window.create.complete');
    return record;
  } catch (error) { startupMark('window.create.rejected'); if (!window.isDestroyed()) window.destroy(); throw error; }
  finally { if (record.opening === opening) delete record.opening; }
}
function openEmptyWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  const source = focused ? broker.windows.get(focused.webContents.id) : undefined;
  createWindow({ source }).catch(error => dialog.showErrorBox('Could not open window', error.message));
}
function refreshApplicationMenu() {
  const focused = BrowserWindow.getFocusedWindow();
  const trusted = focused && broker.windows.has(focused.webContents.id) ? focused : null;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role:'appMenu' }] : []),
    workspaceFileMenu(trusted ? menuHotkeys.get(trusted) : null, {
      newWindow: openEmptyWindow,
      closeTab: () => { const owner = BrowserWindow.getFocusedWindow(); if (owner && broker.windows.has(owner.webContents.id)) owner.webContents.send('zorid:command', 'close-tab'); },
      closeWindow: () => { const owner = BrowserWindow.getFocusedWindow(); if (owner && broker.windows.has(owner.webContents.id)) owner.close(); },
    }),
    { role:'editMenu' }, { role:'viewMenu' },
    { role:'windowMenu', submenu:[{role:'minimize'},{role:'zoom'},...(process.platform==='darwin'?[{type:'separator'},{role:'front'}]:[{label:'Close window',click:()=>{const owner=BrowserWindow.getFocusedWindow();if(owner&&broker.windows.has(owner.webContents.id))owner.close();}}])] },
  ]));
}
const ownsApplication=app.requestSingleInstanceLock();
if(!ownsApplication)app.quit();
app.on('second-instance',()=>{const first=BrowserWindow.getAllWindows()[0];if(first){if(first.isMinimized())first.restore();first.focus();}});
app.whenReady().then(async () => {
  startupMark('app.ready');
  if(!ownsApplication)return;
  if (familyFixture) {
    try {
      await require('./family-fixture.cjs').launchFamilyFixture({app,BrowserWindow,ipcMain}, {
        root: process.env.ZORID_FIXTURE_VAULT,
        executable: process.env.ZORID_DESKTOP_HOST_BIN,
        credentials: process.env.ZORID_FIXTURE_SYNC_CONFIG,
        source: process.env.ZORID_FIXTURE_SOURCE,
      });
    } catch { dialog.showErrorBox('Core fixture unavailable', 'Check the trusted fixture configuration and matching native host build.'); app.quit(); }
    return;
  }
  const slotsReady = startupCall('client_slots.open', () => require('./client-slots.cjs').openClientSlots(path.join(app.getPath('userData'),'client-slots.json'))).then(slots => {
    clientSlots = slots;
    return startupCall('restore_slots.list', () => slots.listRestorable());
  });
  const lastVaultReady = (async () => {
    try { lastVaultPath = JSON.parse(await startupCall('last_vault.read', () => fs.readFile(path.join(app.getPath('userData'), 'vault.json'), 'utf8'))).path; }
    catch { /* A missing previous vault returns to the vault picker. */ }
  })();
  const [restoreSlots] = await Promise.all([slotsReady, lastVaultReady]);
  const primarySlot = (await clientSlots.listExisting()).find(slot => slot.slotId === 'primary');
  if (coreClosing || coreClosed) return;
  const selected = primarySlot?.vaultPath || lastVaultPath;
  if (selected && editorCore) {
    // Open only the saved primary vault, without admitting a renderer/client.
    // Durable slot claim yields to filesystem work before BrowserWindow's
    // synchronous construction, allowing Native startup to overlap both costs.
    const promise = startupCall('vault_preopen', () => editorCore.open(selected));
    startupVaultOpening = {directory:selected, promise};
    // Opening may fail before there is a window. Keep that rejection observed;
    // normal broker selection below consumes the same outcome and picker path.
    void promise.catch(() => {});
  }
  registerIPC();
  refreshApplicationMenu();
  await createWindow({ primary: true, initialState: 'restore' });
  for(const restoreSlot of restoreSlots)await createWindow({restoreSlot,initialState:'restore'});
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow({ primary: true, initialState: 'restore' }).catch(error => dialog.showErrorBox('Could not open window', error.message)); });
  startupMark('app.initial_windows.complete');
}).catch(error=>{dialog.showErrorBox('Could not start Zorid',error.message);app.quit();});
app.on('before-quit', () => { quitRequested = true; });
app.on('window-all-closed', () => { if (familyFixture || process.platform !== 'darwin') app.quit(); });
// before-quit can still be cancelled by a renderer's unsaved-note guard.
let coreClosed = false, coreClosing;
app.on('will-quit', event => {
  if (editorCore && !coreClosed) {
    event.preventDefault();
    coreClosing ??= editorCore.close().catch(() => {}).finally(() => {
      coreClosed = true; broker.dispose();
      // A settled close can finish within the original native quit dispatch.
      // Resume after that turn so Electron can accept the second quit request.
      setImmediate(() => app.quit());
    });
  } else broker.dispose();
});
startupMark('module.setup.complete');
