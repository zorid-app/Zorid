/** Normal activation of exactly one window in the already authenticated child.
 * Do not change background throttling or use another application's window. */
export function ownedPackagedWindow(config){
  const builtin=name=>process.getBuiltinModule?process.getBuiltinModule(name):require(name);
  const req=builtin('module').createRequire(process.resourcesPath+'/app.asar/package.json'),{app,BrowserWindow}=req('electron');
  if(process.pid!==config.pid||process.execPath!==config.executable||!app.isPackaged||app.getAppPath()!==config.appPath||app.getPath('userData')!==config.profile||process.env.ZORID_LOCAL_DATA_DIR!==config.localDataDirectory)throw Error('Foreground owned packaged process scope differs');
  const windows=BrowserWindow.getAllWindows().filter(window=>!window.isDestroyed());
  if(windows.length!==1)throw Error('Expected one owned packaged window');
  const window=windows[0],url=window.webContents.getURL().split('#')[0];
  if(url!==config.url&&url!=='about:blank')throw Error('Foreground owned packaged window URL differs');
  const startedAt=performance.now();
  if(config.activate){if(!config.windowOnly)app.focus({steal:true});if(window.isMinimized())window.restore();window.show();window.focus();}
  return {startedAt,completedAt:performance.now(),activationRequested:config.activate===true,applicationActivationRequested:config.activate===true&&!config.windowOnly,pid:process.pid,windowId:window.id,url,
    visible:window.isVisible(),minimized:window.isMinimized(),focused:window.isFocused(),webContentsFocused:window.webContents.isFocused(),
    backgroundThrottling:typeof window.webContents.getBackgroundThrottling==='function'?window.webContents.getBackgroundThrottling():null,
    occlusion:'not exposed by the inspected Electron BrowserWindow API'};
}
export const foregroundSource=config=>`(${ownedPackagedWindow.toString()})(${JSON.stringify(config)})`;
