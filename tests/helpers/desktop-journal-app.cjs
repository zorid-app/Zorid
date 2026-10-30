'use strict';
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {WindowBroker}=require('../../desktop/window-broker.cjs');
const desktop=path.resolve(__dirname,'../../desktop');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function startJournalApp(t){
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-journal-app-'));await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:'/vault-one'}));
  const handlers=new Map(),windows=[],proxies=[],calls=[],services=new Map(),corePending=new Set();let broker,openCount=0,openFailures=0,lostReplies=0,contextGate,recoverGate,releaseGate,invokeGate,openGate,coreAdmission='core-one',postJournal,boundJournal,documentAdmission=0;
  class FakeWindow extends EventEmitter{
    constructor(){super();this.destroyed=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{id:windows.length+1,mainFrame:{url:''},isDestroyed:()=>this.destroyed,setWindowOpenHandler(){},send(){}});windows.push(this);}
    isDestroyed(){return this.destroyed;}
    async loadFile(file){this.webContents.mainFrame.url=require('node:url').pathToFileURL(file).href;this.webContents.emit('did-start-navigation', {url:this.webContents.mainFrame.url,isMainFrame:true,isSameDocument:false});}
    destroy(){this.destroyed=true;this.emit('closed');}
    static getAllWindows(){return windows.filter(window=>!window.destroyed);}
    static getFocusedWindow(){return windows[0];}
  }
  const app=new EventEmitter();Object.assign(app,{isPackaged:false,setName(){},whenReady:()=>Promise.resolve(),getPath:()=>profile,requestSingleInstanceLock:()=>true,quit(){}});
  const core={open:async root=>{if(!services.has(root))services.set(root,{root,subscribe:()=>()=>{}});return services.get(root);},owns:()=>false,requireReleased(){},
    context:async()=>{calls.push('context');await contextGate;return{admissionId:coreAdmission,scope:{vaultId:'vault-one',clientId:'client-one'}};},
    recover:async()=>{calls.push('recover');await recoverGate;coreAdmission='core-two';return{admissionId:coreAdmission,scope:{vaultId:'vault-one',clientId:'client-one'}};},
    bindIndependentJournal(_broker,record,root,admissionId,grant,check){
      check();if(admissionId!==coreAdmission||root!==record.vault.service.root||grant.scope.clientId!==record.clientSlot.clientId)throw{code:'draft_admission_denied'};
      if(boundJournal&&boundJournal.grant.token!==grant.token)coreAdmission=`document-core-${++documentAdmission}`;
      boundJournal={grant,check};return coreAdmission;
    },
    async quiesceJournalOwner(_broker,record,root,grant){
      const owner=boundJournal,id=coreAdmission;
      const check=()=>{if(!owner||boundJournal!==owner||coreAdmission!==id||owner.grant.token!==grant.token||root!==record.vault.service.root)throw{code:'draft_lease_revoked'};owner.check();};
      check();while(corePending.size)await Promise.allSettled([...corePending]);check();
    },
    release:async()=>{calls.push('release');await releaseGate;},invoke:()=>{calls.push('coreInvoke');const pending=Promise.resolve(invokeGate).then(()=>({core:true}));corePending.add(pending);void pending.then(()=>corePending.delete(pending),()=>corePending.delete(pending));return pending;},retire:async()=>{},close:async()=>{}};
  const electron={app,BrowserWindow:FakeWindow,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},Menu:{buildFromTemplate:value=>value,setApplicationMenu(){}},shell:{openExternal(){}},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:['/vault-two']}),showErrorBox(message,detail){throw Error(`${message}: ${detail}`);},showMessageBox:async()=>{}}};
  const nativeRequire=name=>{
    if(name==='electron')return electron;
    if(name==='./editor-core.cjs')return{createEditorCoreManager:()=>core};
    if(name==='./window-broker.cjs')return{WindowBroker:class extends WindowBroker{constructor(options){super(options);broker=this;}}};
    if(name==='./client-slots.cjs')return{openClientSlots:async()=>({listRestorable:async()=>[],claim:async()=>({slotId:'primary',clientId:'client-one',vaultPath:null}),setVault:async()=>{},release:async()=>{}})};
    if(name==='./context-menu.cjs')return{createContextMenuController:()=>({close(){},popup(){}})};
    if(name==='./draft-journal.cjs')return{openDraftJournal:async(...args)=>{openCount++;await openGate;if(openFailures-->0)throw Object.assign(new Error('Owned fixture storage unavailable'),{code:'EACCES'});return require(path.join(desktop,name)).openDraftJournal(...args);}};
    if(name==='./lazy-draft-journal.cjs')return{createLazyDraftJournal:open=>{const value=require(path.join(desktop,name)).createLazyDraftJournal(open);proxies.push(value);return value;}};
    if(name==='./draft-journal-admission.cjs')return{createDraftJournalAdmissionManager:options=>{const value=require(path.join(desktop,name)).createDraftJournalAdmissionManager(options);return{...value,
      // Main's VM and required modules have different intrinsic prototypes;
      // Electron loads these CJS files in one realm. Normalize only data here.
      dispatch:async(record,event,root,token,request)=>{const result=await value.dispatch(record,event,root,token,structuredClone(request));if(postJournal){const run=postJournal;postJournal=undefined;run();}return result;}};}};
    return name.startsWith('./')?require(path.join(desktop,name)):require(name);
  };
  vm.runInNewContext(fsSync.readFileSync(path.join(desktop,'main.cjs'),'utf8'),{require:nativeRequire,__dirname:desktop,process:{platform:'darwin',env:{}},URL,structuredClone,setImmediate});
  for(let n=0;n<100&&(!windows.length||!broker?.windows.size||broker.windows.get(1)?.opening);n++)await tick();
  const window=windows[0],record=broker.windows.get(window.webContents.id),event=()=>({sender:window.webContents,senderFrame:window.webContents.mainFrame});
  const invoke=(name,...args)=>handlers.get(`zorid:${name}`)(event(),...structuredClone(args));
  const journalRequests=[];
  let exposed;const preloadContext=vm.createContext({require:name=>{if(name!=='electron')throw Error('Unexpected preload dependency');return{contextBridge:{exposeInMainWorld(_name,value){exposed=value;}},webUtils:{},ipcRenderer:{on(){},removeListener(){},async invoke(channel,...args){if(channel==='zorid:independentJournal')journalRequests.push(structuredClone(args[0]));const value=await handlers.get(channel)(event(),...structuredClone(args));if(channel==='zorid:independentJournal'&&lostReplies-->0)throw Error('Lost independent acknowledgement');return copy(value);}}};}});
  function copy(value){if(value===null||typeof value!=='object')return value;const result=vm.runInContext(Array.isArray(value)?'[]':'({})',preloadContext);for(const key of Object.keys(value))Object.defineProperty(result,key,{value:copy(value[key]),enumerable:true,writable:true,configurable:true});return result;}
  vm.runInContext(fsSync.readFileSync(path.join(desktop,'preload.cjs'),'utf8'),preloadContext);
  const bridge=new Proxy({...exposed},{get(target,key){const value=Reflect.get(target,key);return typeof value!=='function'?value:String(key).startsWith('on')?((...args)=>value(...copy(args))):async(...args)=>structuredClone(await value(...copy(args)));}});
  t.after(async()=>{for(const value of proxies)await value.close();broker.dispose();await fs.rm(profile,{recursive:true,force:true});});
  return{bridge,invoke,handlers,event,record,window,broker,profile,calls,journalRequests,get openCount(){return openCount;},failOpen(times=1){openFailures=times;},loseReply(times=1){lostReplies=times;},afterJournal(callback){postJournal=callback;},holdContext(gate){contextGate=gate;},holdRecovery(gate){recoverGate=gate;},holdRelease(gate){releaseGate=gate;},holdCore(gate){invokeGate=gate;},holdOpen(gate){openGate=gate;},reload(){window.webContents.emit('did-start-navigation', {url:window.webContents.mainFrame.url,isMainFrame:true,isSameDocument:false});}};
}
module.exports={startJournalApp};
