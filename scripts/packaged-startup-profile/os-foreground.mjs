import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertNativeWindowVisible,nativeWindowAdapterSource} from '../../tests/bases-electron-integration/window-visibility.mjs';
const execute=promisify(execFile);
/** Same ordinary PID-scoped AppKit request and CF window bridge as the existing
 * Native journey. No Electron require, bundle-name lookup or shell interpolation. */
export const appKitActivationSource=String.raw`
ObjC.import('AppKit');
${nativeWindowAdapterSource}
function run(argv){
  const pid=Number(argv[0]),expected=argv[1],waitMs=Number(argv[2]),app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if(!Number.isSafeInteger(pid)||pid<=0||Number(app.processIdentifier)!==pid||ObjC.unwrap(app.executableURL.path)!==expected)throw Error('Owned AppKit process identity differs');
  const unhideAccepted=Boolean(app.unhide),activationAccepted=Boolean(app.activateWithOptions(3));
  let observed=readOwnedNativeWindows(pid);const end=Date.now()+waitMs;
  while((Boolean(app.isHidden)||!observed.windows.length)&&Date.now()<end){$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));observed=readOwnedNativeWindows(pid);}
  return JSON.stringify({pid,executable:ObjC.unwrap(app.executableURL.path),requested:{unhide:true,activateAllWindows:true},unhideAccepted,activationAccepted,hidden:Boolean(app.isHidden),active:Boolean(app.isActive),...observed});
}`;
export function validateOwnedNativeActivation(value,config){assert.equal(value?.pid,config.pid,'AppKit PID differs');assert.equal(value.executable,config.executable,'AppKit executable differs');return assertNativeWindowVisible(value,config.pid);}
export async function activateOwnedAppKit(config,{timeoutMs,run=execute}={}){
  assert.ok(Number.isSafeInteger(config.pid)&&config.pid>0&&path.isAbsolute(config.executable)&&!config.executable.includes('\0'),'Invalid owned AppKit target');
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=5000,'Invalid remaining activation budget');
  const args=['-l','JavaScript','-e',appKitActivationSource,String(config.pid),config.executable,String(Math.min(3000,Math.max(0,timeoutMs-500)))];
  const reply=await run('/usr/bin/osascript',args,{encoding:'utf8',timeout:timeoutMs,maxBuffer:262144,shell:false});
  return validateOwnedNativeActivation(JSON.parse(reply.stdout),config);
}
/** Reuse only actual passive focus. Otherwise request each setup action once;
 * acceptance booleans never substitute for the caller's final focus proof. */
export async function requestOwnedForeground({config,measured,assertAlive,readWindow,readDocument,activateOS,bringToFront,focusWindow,receipt={},now,timeoutMs}){
  assert.equal(measured,true,'Only measured owned launches may activate');assertAlive();receipt.beforeWindow=await readWindow();
  assert.equal(receipt.beforeWindow.pid,config.pid,'Owned window PID differs');assert.ok(Number.isSafeInteger(receipt.beforeWindow.windowId)&&receipt.beforeWindow.windowId>0,'Owned window identity unavailable');assert.ok([config.url,'about:blank'].includes(receipt.beforeWindow.url),'Owned window URL differs');
  receipt.beforeDocument=readDocument?await readDocument():undefined;const w=receipt.beforeWindow,d=receipt.beforeDocument;
  if(w.focused===true&&w.visible===true&&w.minimized===false&&w.url===config.url&&d?.url===config.url&&d.visibilityState==='visible'&&d.hidden===false&&d.hasFocus===true){receipt.reusedConfirmedForeground=true;return receipt;}
  assertAlive();if(bringToFront){receipt.pageFront={requestedAtMs:now()};await bringToFront();receipt.pageFront.completedAtMs=now();}
  assertAlive();receipt.osRequestedAtMs=now();const budget=timeoutMs?Math.min(5000,Math.floor(timeoutMs())):5000;
  receipt.os=validateOwnedNativeActivation(await (activateOS??activateOwnedAppKit)(config,{timeoutMs:budget}),config);receipt.osCompletedAtMs=now();
  assertAlive();receipt.request=await focusWindow();receipt.requestCompletedAtMs=now();return receipt;
}
