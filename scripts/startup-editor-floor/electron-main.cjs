'use strict';
const {performance}=require('node:perf_hooks');
const mainModuleEntryEpoch=performance.timeOrigin+performance.now();
const {app,BrowserWindow,ipcMain,Menu}=require('electron');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const cfg=JSON.parse(process.env.ZORID_EDITOR_FLOOR_CONFIG);
if(!path.isAbsolute(cfg.directory)||!cfg.directory.startsWith('/private/tmp/zorid-editor-floor-'))throw Error('Unowned floor output');
const epoch=()=>performance.timeOrigin+performance.now(),spawnEpoch=Number(process.env.ZORID_EDITOR_FLOOR_SPAWN_EPOCH);
if(!Number.isFinite(spawnEpoch))throw Error('Missing launch clock');
app.setPath('userData',cfg.profile);app.setName('Zorid editor floor');
const report={floorOnly:true,mode:cfg.mode,deadlineMs:cfg.deadlineMs,spawnEpoch,selectionEpoch:null,events:[],mainModuleEntryEpoch,mainTimeOrigin:performance.timeOrigin,expectedElectronVersion:cfg.electronVersion,electronVersion:process.versions.electron,execPath:process.execPath,appPath:app.getAppPath(),packaged:app.isPackaged,errors:[],probeSends:[]};
const persist=()=>fs.writeFileSync(path.join(cfg.directory,'app-report.json'),JSON.stringify(report,null,2),{mode:0o600});
const event=(kind,data={})=>{report.events.push({kind,mainEpoch:epoch(),...data});};
event('main-module-entry',{at:mainModuleEntryEpoch});let window,armed=false,readySent=false,quitting=false,finishRequested=false,journal=Promise.resolve(),journalSequence=0;
const seen=new Set();
const owns=event=>{if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url.split('#')[0]!==new URL('file://'+path.join(__dirname,'renderer/index.html')).href)throw Error('Foreign fixture IPC');};
function sendProbe(name){
 const row={name,insert:name==='ready'?'x':'y',sentEpoch:epoch(),targetPresent:!!window&&!window.isDestroyed()};report.probeSends.push(row);event('probe-sent',row);
 if(!row.targetPresent)return;
 try{window.focus();window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode:row.insert.toUpperCase()});window.webContents.sendInputEvent({type:'char',keyCode:row.insert});window.webContents.sendInputEvent({type:'keyUp',keyCode:row.insert.toUpperCase()});}
 catch(error){report.errors.push('Input dispatch: '+error.message);}
}
function requestFinish(){if(finishRequested)return;finishRequested=true;event('finish-requested');if(window&&!window.isDestroyed())window.webContents.send('floor:finish');}
function arm(origin){if(armed)throw Error('Repeated input deadline');armed=true;setTimeout(()=>{sendProbe('deadline');setTimeout(requestFinish,cfg.diagnosticMs);},Math.max(0,origin+cfg.deadlineMs-epoch()));}
if(cfg.mode==='normal-reopen')arm(spawnEpoch);
async function loadFixture(){
 event('fixture-read-start');const before=await fsp.stat(cfg.fixture.path),text=await fsp.readFile(cfg.fixture.path,'utf8'),after=await fsp.stat(cfg.fixture.path);
 if(before.size!==cfg.fixture.bytes||after.size!==before.size||after.mtimeMs!==before.mtimeMs||text.length!==cfg.fixture.bytes)throw Error('Owned fixture changed while loading');
 event('fixture-read-end',{bytes:after.size});return{...cfg.fixture,text};
}
ipcMain.handle('floor:bootstrap',event=>{owns(event);return{mode:cfg.mode,mainEpoch:epoch()};});
ipcMain.handle('floor:load',async event=>{owns(event);if(cfg.mode!=='normal-reopen')throw Error('Wrong load clock');return loadFixture();});
ipcMain.handle('floor:select',async event=>{owns(event);if(cfg.mode!=='first-folder-selection'||report.selectionEpoch!==null)throw Error('Wrong or repeated fixture selection');report.selectionEpoch=epoch();eventRecord('fixture-folder-selected',{at:report.selectionEpoch,simulation:'Owned preconfigured fixture acknowledgment; no OS dialog measured'});arm(report.selectionEpoch);return loadFixture();});
const eventRecord=event;
ipcMain.on('floor:event',(message,kind,data)=>{owns(message);if(typeof kind!=='string'||JSON.stringify(data).length>20000)throw Error('Invalid fixture event');event(kind,data);if(kind==='editor-ready'&&!readySent){readySent=true;sendProbe('ready');}});
ipcMain.handle('floor:journal',(message,input)=>{
 owns(message);const bytes=Buffer.byteLength(JSON.stringify(input));
 if(bytes>4096||!['ready','deadline'].includes(input?.name)||input.insert!==(input.name==='ready'?'x':'y')||input.identity!==cfg.fixture.id||seen.has(input.name))throw Error('Invalid fixture journal command');
 seen.add(input.name);const operation=journal.then(async()=>{
  if(input.sequence!==++journalSequence||input.from!==cfg.fixture.caret+input.sequence-1||input.beforeLength!==cfg.fixture.bytes+input.sequence-1||input.afterLength!==cfg.fixture.bytes+input.sequence)throw Error('Fixture edit sequence mismatch');
  const record={version:1,floorOnly:true,...input},line=JSON.stringify(record)+'\n',file=path.join(cfg.directory,'fixture-journal.jsonl'),handle=await fsp.open(file,'a',0o600);
  try{await handle.writeFile(line);await handle.sync();}finally{await handle.close();}
  const rows=(await fsp.readFile(file,'utf8')).trim().split('\n').map(row=>JSON.parse(row)),readback=JSON.stringify(rows.at(-1))===JSON.stringify(record);
  if(!readback)throw Error('Fixture journal readback mismatch');
  const ack={ack:true,fsynced:true,readback,ackEpoch:epoch(),sequence:input.sequence};event('fixture-journal-fsync-ack',{name:input.name,...ack});return ack;
 });journal=operation.catch(error=>{report.errors.push(error.message);});return operation;
});
async function quit(){if(quitting)return;quitting=true;await journal;event('quit-requested');persist();app.quit();}
ipcMain.handle('floor:result',async(message,result)=>{
 owns(message);if(JSON.stringify(result).length>100000)throw Error('Oversized floor receipt');const priorErrors=[...report.errors];Object.assign(report,result);report.errors=[...priorErrors,...(result.errors??[])];
 try{const image=await window.webContents.capturePage();await fsp.writeFile(path.join(cfg.directory,'viewport.png'),image.toPNG());report.screenshot='viewport.png';}catch(error){report.errors.push('Screenshot: '+error.message);}
 try{report.memory=app.getAppMetrics().map(metric=>({pid:metric.pid,type:metric.type,memory:metric.memory}));}catch(error){report.memoryError=error.message;}
 persist();setImmediate(()=>void quit());return{recorded:true};
});
app.on('before-quit',()=>event('before-quit'));app.on('will-quit',()=>{event('will-quit');report.normalQuitObserved=true;persist();});
app.whenReady().then(async()=>{
 event('app-ready');Menu.setApplicationMenu(null);
 window=new BrowserWindow({width:1100,height:760,show:true,backgroundColor:'#1e1e1e',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 event('window-created');for(const name of ['ready-to-show','show'])window.once(name,()=>event(name));
 for(const name of ['dom-ready','did-finish-load'])window.webContents.once(name,()=>event(name));
 window.webContents.on('render-process-gone',(_event,details)=>{if(quitting)return;report.errors.push('Renderer exited: '+details.reason);event('renderer-gone',details);void quit();});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 event('load-start');await window.loadFile(path.join(__dirname,'renderer/index.html'));event('load-complete');
}).catch(error=>{report.errors.push(error.stack??String(error));void quit();});
setTimeout(()=>{report.errors.push('Owned floor case timed out');event('case-timeout');void quit();},cfg.timeoutMs);
