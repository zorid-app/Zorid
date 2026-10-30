import assert from 'node:assert/strict';
export function workspaceReady(snapshot){
  const {lifecycle,document,profile,requireProfile,window,expectedURL}=snapshot??{};
  if(!window?.focused||!window.visible||window.minimized||!expectedURL||window.url!==expectedURL||document?.url!==expectedURL||document.hidden||document.visibilityState!=='visible'||document.hasFocus!==true)return false;
  if(!lifecycle||lifecycle.truncated||!Array.isArray(lifecycle.nativeOpen)||lifecycle.nativeOpen.length===0||!lifecycle.nativeOpen.every(row=>Number.isFinite(row.finishedAt)&&!row.error))return false;
  if(!document?.workspace||!document.fixtureRow||document.inert||document.startupError)return false;
  if(requireProfile&&(!profile||profile.timeOrigin!==lifecycle.timeOrigin||!profile.phases.some(row=>row.phase==='close_handler.ready')))return false;
  return true;
}
export function startupProfile(value){
  if(value===undefined||value===null)return null;
  assert.equal(value.version,1);assert.ok(Number.isFinite(value.timeOrigin)&&value.timeOrigin>0&&Number.isFinite(value.moduleEntryUptimeMs)&&value.moduleEntryUptimeMs>=0);
  assert.ok(Array.isArray(value.phases)&&value.phases.length<=128);let previous=-Infinity;
  const phases=value.phases.map(row=>{assert.ok(typeof row.phase==='string'&&/^[A-Za-z_.]{1,80}$/.test(row.phase)&&Number.isFinite(row.atMs)&&row.atMs>=0&&row.atMs>=previous);previous=row.atMs;return {phase:row.phase,atMs:row.atMs};});
  const result={version:1,timeOrigin:value.timeOrigin,moduleEntryUptimeMs:value.moduleEntryUptimeMs,phases,truncated:value.truncated===true};
  if(value.nativeEvents!==undefined){
    assert.ok(Array.isArray(value.nativeEvents)&&value.nativeEvents.length<=128);
    result.nativeEvents=value.nativeEvents.map((row,index)=>{
      assert.ok(['spawn','native_phase','hello'].includes(row.kind)&&Number.isSafeInteger(row.pid)&&row.pid>0&&Number.isInteger(row.hostIndex)&&row.hostIndex>=0&&Number.isFinite(row.atMs)&&row.atMs>=0);
      const spawn=value.nativeEvents[row.hostIndex];assert.ok(row.hostIndex<=index&&spawn?.kind==='spawn'&&spawn.pid===row.pid&&spawn.hostIndex===row.hostIndex);
      const event={kind:row.kind,hostIndex:row.hostIndex,pid:row.pid,atMs:row.atMs};
      if(row.kind==='native_phase'){assert.ok(['entry','vault_open','recovery_ready','document_cache_ready','sync_ready','reconciliation_yielded'].includes(row.phase)&&Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);event.phase=row.phase;event.elapsedMs=row.elapsedMs;}
      return event;
    });result.nativeEventsTruncated=value.nativeEventsTruncated===true;
  }
  return result;
}
export async function waitForWorkspace({sample,remaining,pause,record}){
  do{const value=await sample();record.samples=(record.samples??0)+1;record.latest=value;record.first??=value;if(remaining()<=0)throw Error('Actual workspace not ready before diagnostic deadline');if(workspaceReady(value)){record.ready=value;return value;}await pause(Math.min(50,remaining()));}while(true);
}
export function observeDocument(){
  const root=document.querySelector('#app'),row=root?.querySelector('.file-tree .tree-row[data-path="Diagnostic.md"]');
  return {url:location.href.split('#')[0],readyState:document.readyState,visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus(),workspace:root?.classList.contains('workspace')===true,fixtureRow:!!row,inert:root?.inert===true,startupError:!!document.querySelector('.startup-error'),rootClass:root?.className??null,bodyText:document.body?.textContent?.slice(0,1000)??'',modalText:document.querySelector('[aria-modal="true"],.modal-overlay')?.textContent?.slice(0,300)??null};
}
/** Pure observation in the already authenticated main. No ready setters, Core
 * requests, activation or app/window state changes. Keep partial quit history. */
export function observeMain(config){
  const builtin=name=>process.getBuiltinModule?process.getBuiltinModule(name):require(name),req=builtin('module').createRequire(process.resourcesPath+'/app.asar/package.json'),{app,BrowserWindow}=req('electron');
  if(process.pid!==config.pid||process.execPath!==config.executable||!app.isPackaged||app.getAppPath()!==config.appPath||app.getPath('userData')!==config.profile||process.env.ZORID_LOCAL_DATA_DIR!==config.data||performance.timeOrigin!==config.timeOrigin)throw Error('Readonly diagnostic main scope differs');
  const state=globalThis.__zoridPackagedMain;
  if(!state||state.pid!==config.pid||state.timeOrigin!==config.timeOrigin)throw Error('Readonly lifecycle owner differs');
  const lifecycle={pid:state.pid,timeOrigin:state.timeOrigin,installedAt:state.installedAt,phases:state.phases.slice(-128),nativeOpen:state.nativeOpen.slice(-32),nativePids:state.nativePids.slice(-128),nativeExits:state.nativeExits.slice(-128),errors:state.errors.slice(-32),normalQuitObserved:state.normalQuitObserved,quitExitCode:state.quitExitCode,truncated:state.phases.length>128||state.nativeOpen.length>32||state.nativePids.length>128||state.nativeExits.length>128};
  const p=globalThis.__zoridStartupProfile;
  const profile=p?{version:p.version,timeOrigin:p.timeOrigin,moduleEntryUptimeMs:p.moduleEntryUptimeMs,truncated:p.truncated,phases:Array.isArray(p.phases)?p.phases.slice(0,129).map(row=>({phase:row.phase,atMs:row.atMs})):null,...(p.nativeEvents===undefined?{}:{nativeEvents:Array.isArray(p.nativeEvents)?p.nativeEvents.slice(0,129).map(row=>({kind:row.kind,hostIndex:row.hostIndex,pid:row.pid,atMs:row.atMs,phase:row.phase,elapsedMs:row.elapsedMs})):null,nativeEventsTruncated:p.nativeEventsTruncated})}:null;
  const windows=BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()),w=windows.length===1?windows[0]:null;
  const window=w?{pid:process.pid,windowId:w.id,url:w.webContents.getURL().split('#')[0],visible:w.isVisible(),focused:w.isFocused(),minimized:w.isMinimized(),webContentsFocused:w.webContents.isFocused()}:null;
  return {window,lifecycle,profile};
}
