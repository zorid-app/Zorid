import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {foregroundSource} from './foreground.mjs';
function fixture(){
  const calls=[],config={pid:123,executable:'/owned.app/Contents/MacOS/Zorid',appPath:'/owned.app/Contents/Resources/app.asar',profile:'/fixture/profile',localDataDirectory:'/fixture/data',url:'file:///owned.app/Contents/Resources/app.asar/dist/index.html',activate:true};
  let url=config.url,minimized=false;const window={id:1,isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>minimized,isFocused:()=>false,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('window-focus'),webContents:{getURL:()=>url,isFocused:()=>false,getBackgroundThrottling:()=>true}};
  const app={isPackaged:true,getAppPath:()=>config.appPath,getPath:()=>config.profile,focus:options=>calls.push(['app-focus',options])},BrowserWindow={getAllWindows:()=>[window]};
  const process={pid:123,execPath:config.executable,resourcesPath:'/owned.app/Contents/Resources',env:{ZORID_LOCAL_DATA_DIR:config.localDataDirectory},getBuiltinModule:()=>({createRequire:()=>()=>({app,BrowserWindow})})};
  const context={process,performance:{now:()=>20}};
  return {calls,config,process,app,BrowserWindow,window,run:override=>vm.runInNewContext(foregroundSource({...config,...override}),context),setURL:value=>url=value,setMinimized:value=>minimized=value};
}
test('normal foreground activation is confined to the exact authenticated packaged child and window',()=>{
  const f=fixture(),result=f.run();assert.equal(result.pid,123);assert.equal(result.windowId,1);assert.equal(result.activationRequested,true);assert.equal(result.backgroundThrottling,true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[['app-focus',{steal:true}],'show','window-focus']);
});
test('foreign process profile URL and ambiguous windows reject before activation',()=>{
  for(const mutate of [f=>f.process.pid=124,f=>f.process.execPath='/other',f=>f.app.isPackaged=false,f=>f.app.getAppPath=()=>'/foreign.asar',f=>f.app.getPath=()=>'/foreign-profile',f=>f.process.env.ZORID_LOCAL_DATA_DIR='/other',f=>f.setURL('file:///foreign'),f=>f.BrowserWindow.getAllWindows=()=>[] ,f=>f.BrowserWindow.getAllWindows=()=>[f.window,f.window]]){
    const f=fixture();mutate(f);assert.throws(()=>f.run());assert.equal(f.calls.length,0);
  }
});
test('passive diagnostics never activate and minimized owned windows restore normally',()=>{
  const f=fixture();assert.equal(f.run({activate:false}).activationRequested,false);assert.equal(f.calls.length,0);
  f.setMinimized(true);f.run();assert.ok(f.calls.includes('restore'));
});

test('the AppKit boundary uses Electron window-only focus without a second app activation',()=>{const f=fixture(),value=f.run({windowOnly:true});assert.deepEqual(f.calls,['show','window-focus']);assert.equal(value.applicationActivationRequested,false);assert.equal(value.activationRequested,true);});
