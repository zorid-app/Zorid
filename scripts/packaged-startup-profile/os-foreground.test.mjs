import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {activateOwnedAppKit,appKitActivationSource,requestOwnedForeground} from './os-foreground.mjs';
import {requireForeground} from './measurement.mjs';
const config={pid:123,executable:'/owned.app/Contents/MacOS/Zorid',url:'file:///owned.app/Contents/Resources/app.asar/dist/index.html'};
function fixture(){const events=[],os={pid:123,executable:config.executable,hidden:false,active:false,activationAccepted:false,windows:[{ownerPID:123,layer:0,onscreen:true,bounds:{width:100,height:100}}]};return {events,os,options:{config,measured:true,assertAlive:()=>events.push('alive'),readWindow:async()=>({pid:123,windowId:1,url:config.url}),activateOS:async()=>{events.push('appkit');return os;},bringToFront:async()=>events.push('page-front'),focusWindow:async()=>{events.push('window-focus');return {pid:123,focused:false};},receipt:{},now:()=>20}};}
test('one owned AppKit activation precedes one Page/front and Electron-window focus without a focus loop',async()=>{const f=fixture(),value=await requestOwnedForeground(f.options);assert.equal(f.events.filter(v=>v==='appkit').length,1);assert.equal(f.events.filter(v=>v==='window-focus').length,1);assert.ok(f.events.indexOf('appkit')<f.events.indexOf('window-focus'));assert.equal(value.os.active,false,'OS active/accepted remains diagnostic');});
test('a foreign PID/window scope cannot reach any OS activation',async()=>{const f=fixture();f.options.readWindow=async()=>({pid:999,windowId:1,url:config.url});await assert.rejects(requestOwnedForeground(f.options));assert.equal(f.events.includes('appkit'),false);assert.equal(f.events.includes('window-focus'),false);});
test('an invalid AppKit owner receipt stops before Electron focus instead of trying again',async()=>{const f=fixture();f.os.pid=999;await assert.rejects(requestOwnedForeground(f.options));assert.equal(f.events.filter(v=>v==='appkit').length,1);assert.equal(f.events.includes('window-focus'),false);});
test('an unmeasured preparation can never request native activation through this boundary',async()=>{const f=fixture();f.options.measured=false;await assert.rejects(requestOwnedForeground(f.options));assert.equal(f.events.length,0);});
test('a visible but unfocused document cannot pass the required measured foreground guard',()=>{assert.throws(()=>requireForeground({visible:true,minimized:false,focused:true},{hidden:false,visibilityState:'visible',hasFocus:false}));});

test('already confirmed exact window and document foreground is reused without another OS or window request',async()=>{
  const f=fixture();f.options.readWindow=async()=>({pid:123,windowId:1,url:config.url,focused:true,visible:true,minimized:false});f.options.readDocument=async()=>({url:config.url,visibilityState:'visible',hidden:false,hasFocus:true});
  const value=await requestOwnedForeground(f.options);assert.equal(value.reusedConfirmedForeground,true);assert.equal(f.events.includes('appkit'),false);assert.equal(f.events.includes('window-focus'),false);
});
test('OS activation uses an absolute executable, literal argv and a bounded async executor, never a shell',async()=>{
  const selected={...config,executable:"/owned space/quote' dollar$ app.app/Contents/MacOS/Zorid"};let calls=0;
  const result=await activateOwnedAppKit(selected,{timeoutMs:1000,run:async(file,args,options)=>{calls++;assert.equal(file,'/usr/bin/osascript');assert.equal(args[5],selected.executable);assert.equal(args[4],'123');assert.equal(options.shell,false);assert.equal(options.timeout,1000);return {stdout:JSON.stringify({...fixture().os,executable:selected.executable})};}});
  assert.equal(calls,1);assert.equal(result.executable,selected.executable);
  await assert.rejects(activateOwnedAppKit(config,{timeoutMs:0,run:()=>assert.fail('expired budget cannot activate')}));
});
function appKitVM({pid=123,executable=config.executable}={}){
  const events=[],raw=[{kCGWindowOwnerPID:123,kCGWindowLayer:0,kCGWindowNumber:9,kCGWindowIsOnscreen:true,kCGWindowBounds:{X:0,Y:0,Width:100,Height:100}}];
  const app={processIdentifier:pid,executableURL:{path:executable},isHidden:false,isActive:false,get unhide(){events.push('unhide');return true;},activateWithOptions(options){assert.equal(options,3);events.push('activate');return false;}};
  const $={NSRunningApplication:{runningApplicationWithProcessIdentifier:requested=>{assert.equal(requested,123);return app;}},CGWindowListCopyWindowInfo:()=>raw,CFArrayGetCount:array=>array.length};
  const ObjC={import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value};
  return {events,run:()=>JSON.parse(vm.runInNewContext(appKitActivationSource+`;run(${JSON.stringify(['123',config.executable,'0'])})`,{$,ObjC}))};
}
test('the actual emitted AppKit program checks PID/executable BEFORE its one activation and reports owned native windows',()=>{
  const f=appKitVM(),value=f.run();assert.deepEqual(f.events,['unhide','activate']);assert.equal(value.active,false);assert.equal(value.activationAccepted,false);assert.equal(value.windows[0].ownerPID,123);
  for(const wrong of [{pid:999},{executable:'/foreign.app/Contents/MacOS/Foreign'}]){const f=appKitVM(wrong);assert.throws(f.run,/identity differs/);assert.equal(f.events.length,0);}
});
test('a changed owned child lifetime aborts before later activation steps',async()=>{
  const f=fixture();let checks=0;f.options.assertAlive=()=>{if(++checks===2)throw Error('owned child exited');};await assert.rejects(requestOwnedForeground(f.options),/child exited/);assert.equal(f.events.includes('appkit'),false);assert.equal(f.events.includes('window-focus'),false);
});
