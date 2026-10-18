'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {WindowBroker} = require('../desktop/window-broker.cjs');
const {openClientSlots} = require('../desktop/client-slots.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };

// Real main IPC registration, broker authentication, and on-disk client registry.
// Electron windows and core admissions are controlled seams, not native proof.
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-calendar-recovery-')));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'vault'), other=path.join(directory,'other');
  await fs.mkdir(root);await fs.mkdir(other);
  await fs.writeFile(path.join(directory,'vault.json'),JSON.stringify({path:root}));
  const journal=path.join(directory,'retained-calendar-journal');
  await fs.writeFile(journal,'exact retained original journal bytes');
  const file=path.join(directory,'client-slots.json'), registry=await openClientSlots(file);
  const windows=[],handlers=new Map(),controls={},ready=deferred();let broker;
  class TestWindow extends EventEmitter {
    constructor() {
      super();if(controls.constructorFailure)throw new Error('constructor failed');
      this.destroyed=false;this.webContents=new EventEmitter();
      Object.assign(this.webContents,{id:windows.length+1,mainFrame:{url:''},isDestroyed:()=>this.destroyed,setWindowOpenHandler(){},send(){}});
      windows.push(this);
    }
    isDestroyed(){return this.destroyed;}
    async loadFile(file){
      controls.loadStarted?.resolve();
      if(controls.loadWait)await controls.loadWait;
      if(controls.loadFailure)throw new Error('load failed');
      this.webContents.mainFrame.url=require('node:url').pathToFileURL(file).href;
      if(windows.length===1)ready.resolve();
    }
    destroy(){this.destroyed=true;this.emit('closed');}
    static getFocusedWindow(){return windows.find(w=>!w.destroyed);}
    static getAllWindows(){return windows.filter(w=>!w.destroyed);}
  }
  const app=new EventEmitter();Object.assign(app,{setName(){},whenReady:()=>Promise.resolve(),getPath:()=>directory,requestSingleInstanceLock:()=>true,quit(){}});
  const services=new Map(),admissions=new WeakMap();
  const core={
    async open(root){if(controls.openFailure)throw new Error('open failed');if(!services.has(root))services.set(root,{root,subscribe:()=>()=>{}});return services.get(root);},
    owns:()=>false,requireReleased(){},close:async()=>{},
    async retire(){if(controls.retireWait)await controls.retireWait;},
    async context(_broker,record){
      if(controls.contextHook)await controls.contextHook(record);
      if(controls.noAdmission)return null;
      if(!admissions.has(record))admissions.set(record,{admissionId:`admission-${record.id}`,scope:{vaultId:'local-store',clientId:record.clientSlot.clientId}});
      return admissions.get(record);
    },
  };
  const slots={...registry,async claim(options){const slot=await registry.claim(options);if(options?.existingOnly)await controls.claimHook?.();return slot;},async listExisting(){if(controls.lookupHook)await controls.lookupHook();return registry.listExisting();}};
  const electron={app,BrowserWindow:TestWindow,ipcMain:{handle:(name,callback)=>handlers.set(name,callback)},dialog:{showErrorBox:(...args)=>{ready.resolve(new Error(args.join(': ')));},showMessageBox:async()=>{}},
    Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},shell:{openExternal(){}}};
  const mainPath=path.resolve(__dirname,'../desktop/main.cjs');
  const nativeRequire=name=>{
    if(name==='electron')return electron;
    if(name==='./editor-core.cjs')return {createEditorCoreManager:()=>core};
    if(name==='./client-slots.cjs')return {openClientSlots:async()=>slots};
    if(name==='./window-broker.cjs')return {WindowBroker:class extends WindowBroker{constructor(options){super(options);broker=this;}}};
    if(name==='./context-menu.cjs')return {createContextMenuController:()=>({close(){},popup(){}})};
    if(name.startsWith('./'))return require(path.join(path.dirname(mainPath),name));
    return require(name);
  };
  vm.runInNewContext(fsSync.readFileSync(mainPath,'utf8'),{require:nativeRequire,__dirname:path.dirname(mainPath),process:{platform:'darwin',env:{}},URL,console,setImmediate});
  const startupError=await ready.promise;if(startupError)throw startupError;
  assert.equal(windows.length,1);assert.ok(windows[0].webContents.mainFrame.url);
  const event=w=>({sender:w.webContents,senderFrame:w.webContents.mainFrame});
  const invoke=(w,name,...args)=>handlers.get(`zorid:${name}`)(event(w),...args);
  const caller=windows[0];
  async function secondary(){const {id}=await invoke(caller,'newWindow');return {id,window:windows.at(-1),slot:(await registry.listExisting()).find(row=>row.slotId===id)};}
  async function retire(window){window.destroy();await tick();await registry.listExisting();}
  const recover=(id,w=caller,vaultId='local-store')=>invoke(w,'reopenCalendarRecovery',{originalWindowId:id,expectedVaultId:vaultId});
  return {root,other,registry,file,journal,windows,handlers,event,invoke,caller,secondary,retire,recover,controls,broker,admissions};
}

test('reopens exact existing secondary identity; concurrent requests admit one owner',async t=>{
  const f=await fixture(t),old=await f.secondary();await f.retire(old.window);
  const before=await fs.readFile(f.journal);
  const replies=await Promise.allSettled([f.recover(old.id),f.recover(old.id)]);
  assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);
  const opened=f.windows.at(-1),record=f.broker.windows.get(opened.webContents.id);
  assert.equal(record.id,old.id);assert.equal(record.clientSlot.clientId,old.slot.clientId);
  assert.equal(record.vault.service.root,f.root);
  assert.deepEqual(await fs.readFile(f.journal),before);
  assert.equal((await f.registry.listExisting()).length,2);
  await assert.rejects(f.registry.claim({slotId:old.id}),{code:'client_slot_in_use'});
});

test('primary recovery maps main to the exact existing primary slot',async t=>{
  const f=await fixture(t),secondary=await f.secondary();
  const primary=(await f.registry.listExisting()).find(row=>row.slotId==='primary');
  await f.retire(f.caller);
  const result=await f.recover('main',secondary.window);
  assert.equal(result.id,'main');
  const record=f.broker.windows.get(f.windows.at(-1).webContents.id);
  assert.equal(record.clientSlot.slotId,'primary');assert.equal(record.clientSlot.clientId,primary.clientId);
  assert.equal((await f.registry.listExisting()).length,2);
});

test('rejects unauthenticated frames, wrong local store, other vault, missing slot and primary alias without allocation',async t=>{
  const f=await fixture(t),old=await f.secondary();await f.retire(old.window);
  const original=await fs.readFile(f.file,'utf8');
  assert.throws(()=>f.handlers.get('zorid:reopenCalendarRecovery')({...f.event(f.caller),senderFrame:{}},{originalWindowId:old.id,expectedVaultId:'local-store'}),/Untrusted/);
  await assert.rejects(f.recover(old.id,f.caller,'foreign-store'),/vault/);
  await assert.rejects(f.recover('window-00000000-0000-0000-0000-000000000001'),/unavailable/);
  await assert.rejects(f.recover('primary'),/Invalid/);
  const slot=await f.registry.claim({slotId:old.id});await f.registry.setVault(slot.slotId,f.other);await f.registry.release(slot.slotId,{restore:true});
  const changed=await fs.readFile(f.file,'utf8');
  await assert.rejects(f.recover(old.id),/unavailable/);
  assert.equal(await fs.readFile(f.file,'utf8'),changed);
  assert.notEqual(original,changed);
});

test('rejects live broker records and claimed slots still retiring',async t=>{
  const f=await fixture(t),old=await f.secondary();
  await assert.rejects(f.recover(old.id),/still in use/);
  const drain=deferred();f.controls.retireWait=drain.promise;old.window.destroy();
  assert.equal(f.broker.windows.has(old.window.webContents.id),false);
  await assert.rejects(f.recover(old.id),{code:'client_slot_in_use'});
  drain.resolve();delete f.controls.retireWait;await tick();await f.registry.listExisting();
  assert.equal((await f.recover(old.id)).id,old.id);
});

for(const change of ['generation','admission','page','closed','noAdmission'])test(`rechecks caller ${change} after awaited lookup`,async t=>{
  const f=await fixture(t),old=await f.secondary();await f.retire(old.window);
  f.controls.lookupHook=async()=>{
    const record=f.broker.windows.get(f.caller.webContents.id);
    if(change==='generation')record.generation++;
    if(change==='admission')f.admissions.set(record,{admissionId:'replacement',scope:{vaultId:'local-store',clientId:record.clientSlot.clientId}});
    if(change==='page')f.caller.webContents.mainFrame.url='https://untrusted.invalid';
    if(change==='closed')f.caller.destroy();
    if(change==='noAdmission')f.controls.noAdmission=true;
  };
  await assert.rejects(f.recover(old.id));assert.equal(f.windows.length,2);
  assert.equal((await f.registry.listExisting()).length,2);
});

test('caller change after claim releases only its acquired slot, preserving original identity',async t=>{
  const f=await fixture(t),old=await f.secondary();await f.retire(old.window);
  f.controls.claimHook=async()=>{f.broker.windows.get(f.caller.webContents.id).generation++;};
  await assert.rejects(f.recover(old.id),/changed/);
  assert.equal(f.windows.length,2);
  delete f.controls.claimHook;
  const recovered=await f.recover(old.id);assert.equal(recovered.id,old.id);
  assert.equal(f.windows.at(-1).destroyed,false);
});

for(const failure of ['constructorFailure','openFailure','loadFailure'])test(`${failure} preserves bytes and prevents stealing until retirement finishes`,async t=>{
  const f=await fixture(t),old=await f.secondary();await f.retire(old.window);
  const before=await fs.readFile(f.journal);f.controls[failure]=true;
  const drain=deferred();if(failure!=='constructorFailure')f.controls.retireWait=drain.promise;
  await assert.rejects(f.recover(old.id),/failed/);
  assert.deepEqual(await fs.readFile(f.journal),before);
  delete f.controls[failure];
  if(failure!=='constructorFailure')await assert.rejects(f.recover(old.id),{code:'client_slot_in_use'});
  drain.resolve();delete f.controls.retireWait;await tick();await f.registry.listExisting();
  assert.equal((await f.recover(old.id)).id,old.id);
  assert.equal(f.broker.windows.get(f.windows.at(-1).webContents.id).clientSlot.clientId,old.slot.clientId);
});

test('preload forwards the exact bounded recovery API',()=>{
  let bridge;const calls=[];
  vm.runInNewContext(fsSync.readFileSync(path.resolve(__dirname,'../desktop/preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {id:'main'};}},webUtils:{}})});
  const request={originalWindowId:'main',expectedVaultId:'local-store'};
  return bridge.reopenCalendarRecovery(request).then(result=>{assert.equal(result.id,'main');assert.deepEqual(calls,[['zorid:reopenCalendarRecovery',request]]);});
});

test('existing-only primary claim never allocates and stale slot snapshots cannot claim',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-existing-slot-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'slots.json'),registry=await openClientSlots(file);
  await assert.rejects(registry.claim({primary:true,existingOnly:true}),{code:'client_slot_not_found'});
  await assert.rejects(fs.readFile(file),{code:'ENOENT'});
  const old=await registry.claim({primary:true});await registry.setVault(old.slotId,'/original');await registry.release(old.slotId,{restore:true});
  const before=await fs.readFile(file);
  await assert.rejects(registry.claim({primary:true,existingOnly:true,expectedClientId:old.clientId,expectedVaultPath:'/stale'}),{code:'client_slot_not_found'});
  assert.deepEqual(await fs.readFile(file),before);
});

test('caller generation change during renderer load rejects and retains claim until retirement',async t=>{
  const f=await fixture(t),old=await f.secondary();await f.retire(old.window);
  const load=deferred(),drain=deferred();f.controls.loadStarted=deferred();f.controls.loadWait=load.promise;f.controls.retireWait=drain.promise;
  const recovery=f.recover(old.id);
  // Reaching load means the real slot claim, broker registration and vault bind succeeded.
  await f.controls.loadStarted.promise;
  f.broker.windows.get(f.caller.webContents.id).generation++;
  load.resolve();await assert.rejects(recovery,/changed/);
  await assert.rejects(f.recover(old.id),{code:'client_slot_in_use'});
  drain.resolve();delete f.controls.retireWait;delete f.controls.loadWait;await tick();await f.registry.listExisting();
  assert.equal((await f.recover(old.id)).id,old.id);
});
