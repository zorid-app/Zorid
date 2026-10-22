import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {nativeWindowAdapterSource} from './window-visibility.mjs';

test('actual read-only CGWindow CFArray converts to an array with native count and filters only the owned PID',{skip:process.platform!=='darwin'},()=>{
  // No application is opened, hidden, activated or queried for titles/content.
  // Reuse the exact adapter embedded by the runner, unlike the pure policy test.
  const script=nativeWindowAdapterSource+`\nfunction run(a){return JSON.stringify({pid:Number(a[0]),...readOwnedNativeWindows(Number(a[0]))});}`;
  const receipt=JSON.parse(execFileSync('osascript',['-l','JavaScript','-e',script,String(process.pid)],{encoding:'utf8',timeout:5000}));
  assert.equal(receipt.pid,process.pid);assert.ok(Number.isSafeInteger(receipt.nativeCount)&&receipt.nativeCount>=0);assert.equal(receipt.bridgeCount,receipt.nativeCount);assert.ok(Array.isArray(receipt.windows));
  assert.ok(receipt.windows.every(window=>window.ownerPID===process.pid&&window.layer===0&&window.onscreen===true));
});
