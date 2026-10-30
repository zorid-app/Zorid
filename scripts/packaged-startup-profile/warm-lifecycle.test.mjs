import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import * as mainObservers from './main-observer.mjs';
import {observeEarly} from './preparation.mjs';
import {captureSetupFailure} from './setup-failure.mjs';
import {stopOwned} from './cleanup.mjs';
function nativeFixture(){
  const app=new EventEmitter(),child=new EventEmitter(),writes=[],modules=[];child.pid=23;
  Object.assign(app,{isPackaged:true,getAppPath:()=>'/clone.app/Contents/Resources/app.asar',getPath:()=>'/owned/profile',isReady:()=>true,quit(){this.emit('before-quit');this.emit('will-quit',{defaultPrevented:false});this.emit('quit',{},0);}});
  class Host{static open(){return Promise.resolve({child});}request(){return Promise.resolve({result:{},bytes:new Uint8Array()});}}
  const req=name=>{modules.push(name);if(name==='electron')return {app,BrowserWindow:Object.assign(class{}, {getAllWindows:()=>[]})};if(name==='./desktop/rust-vault-service.cjs')return {RustVaultService:Host};if(name==='./desktop/document-runtime.cjs')return {isRuntimeOp:()=>false};throw Error('Unexpected module '+name);};
  const process={pid:22,execPath:'/clone.app/Contents/MacOS/Zorid',resourcesPath:'/clone.app/Contents/Resources',versions:{electron:'test'},env:{ZORID_LOCAL_DATA_DIR:'/owned/data'},getBuiltinModule:name=>name==='module'?{createRequire:()=>req}:name==='perf_hooks'?{performance:{now:()=>1,timeOrigin:1000}}:{writeFileSync:(_file,value)=>writes.push(JSON.parse(value))}};
  const context={process,structuredClone,Uint8Array},config={pid:22,executable:process.execPath,expectedAppPath:'/clone.app/Contents/Resources/app.asar',profile:'/owned/profile',localDataDirectory:'/owned/data',outputFile:'/owned/final.json'};
  const install=()=>{const fn=mainObservers.installMainLifecycle??mainObservers.installMainObserver;return vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(config)})`,context);};
  return {app,child,Host,writes,modules,context,config,install};
}
test('read-only empty warm skips activation but keeps lifecycle and zero-work observation',async()=>{
  const steps=[];await observeEarly({measured:false,connectMain:async()=> 'main',connectRenderer:async()=> 'renderer',installLifecycle:async()=>steps.push('lifecycle'),installObserver:async()=>steps.push('passive'),foreground:async()=>assert.fail('warm activation is forbidden'),installNativeObserver:async()=>steps.push('native')});
  steps.push('zero-work-proof');assert.ok(steps.includes('lifecycle'));assert.ok(steps.includes('native'));assert.equal(steps.at(-1),'zero-work-proof');
});
test('failed measured foreground still preserves independent actual final quit and Native exit observation',async()=>{
  const f=nativeFixture(),failure=Error('foreground not confirmed');
  await assert.rejects(observeEarly({measured:true,connectMain:async()=> 'main',installLifecycle:async()=>f.install(),connectRenderer:async()=> 'renderer',installObserver:async()=>{},foreground:async()=>{throw failure;},installNativeObserver:async()=>assert.fail('no heavy instrumentation after failed focus')}),error=>error===failure);
  const host=new f.Host();host.child=f.child;await host.request({method:'identity'});f.child.emit('exit',0,null);f.app.quit();
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].normalQuitObserved,true);assert.equal(f.writes[0].nativeExits[0].code,0);assert.equal(f.modules.includes('./desktop/document-runtime.cjs'),false);
});
test('warm failure JSON retains case activation evidence and passive window even if renderer evidence fails',async()=>{
  const launch={errors:['original'],cases:[{identity:'warm',foregroundActivations:[{request:{focused:false}}]}]};
  await captureSetupFailure({renderer:{evaluate:async()=>{throw Error('renderer lost');}},main:{evaluate:async()=>({visible:true,focused:false})},windowSource:'passive-owned-window',launch});
  const saved=JSON.parse(JSON.stringify(launch));assert.equal(saved.failureWindow.focused,false);assert.match(saved.failureObservation.error,/renderer lost/);assert.equal(saved.cases[0].foregroundActivations[0].request.focused,false);assert.deepEqual(saved.errors,['original']);
});
test('an owned Native PID without an observed exit can never become normal merely because all PIDs disappeared',async()=>{
  const launch={directory:'/unused',mainFinalFile:'/unused/final',stderr:'',stdout:''},child={pid:22,exitCode:0,signalCode:null};let first=true;
  await stopOwned({child,exit:Promise.resolve()},launch,{apps:['/clone.app'],shutdownMs:1,io:{snapshot:()=>{if(first){first=false;return [{pid:23,command:'/clone.app/Contents/Resources/native/zorid-desktop-host --vault /fixture'}];}return [];},readMain:async()=>({normalQuitObserved:true,quitExitCode:0,nativePids:[],nativeExits:[]}),writeLogs:async()=>{}}});
  assert.equal(launch.cleanup.gone,true);assert.equal(launch.cleanup.nativeNormal,false);assert.equal(launch.cleanup.normal,false);
});

test('later detailed instrumentation shares lifecycle state and never duplicates final-quit or child-exit listeners',async()=>{
  const f=nativeFixture();f.install();const initial=f.context.__zoridPackagedMain,host=new f.Host();host.child=f.child;await host.request({method:'identity'});
  const request=host.request;f.install();assert.equal(host.request,request);assert.equal(f.app.listenerCount('quit'),1);assert.equal(f.child.listenerCount('exit'),1);
  vm.runInNewContext(`(${mainObservers.installMainObserver.toString()})(${JSON.stringify(f.config)})`,f.context);
  assert.equal(f.context.__zoridPackagedMain,initial);assert.equal(f.app.listenerCount('quit'),1);assert.equal(f.child.listenerCount('exit'),1);
  f.child.emit('exit',0,null);f.app.quit();assert.equal(f.writes.length,1);assert.equal(f.writes[0].nativeExits.length,1);
});
test('foreign lifecycle scope cannot install quit or Native tracking hooks',()=>{
  const f=nativeFixture(),original=f.Host.prototype.request;f.config.pid=99;assert.throws(f.install,/scope differs/);assert.equal(f.Host.prototype.request,original);assert.equal(f.app.listenerCount('quit'),0);assert.equal(f.context.__zoridPackagedMain,undefined);
});
