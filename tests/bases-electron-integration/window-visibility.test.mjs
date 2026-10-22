import test from 'node:test';
import assert from 'node:assert/strict';
import {windowMode,assertNativeWindowVisible,assertRendererVisible} from './window-visibility.mjs';
const native={pid:42,accepted:true,hidden:false,active:true,windows:[{ownerPID:42,layer:0,onscreen:true,bounds:{width:1024,height:800}}]};
test('hidden remains the default and only the explicit boolean flag opts into showing',()=>{
  assert.equal(windowMode([]),'hidden');assert.equal(windowMode(['--root','/fixture']),'hidden');assert.equal(windowMode(['--show-window']),'visible');assert.throws(()=>windowMode(['--show-window=false']));
});
test('native request acceptance cannot stand in for an actual owned visible window',()=>{
  assert.equal(assertNativeWindowVisible(native,42),native);
  for(const receipt of [{...native,pid:7},{...native,accepted:false},{...native,hidden:true},{...native,active:false},{...native,windows:[]},{...native,windows:[{...native.windows[0],ownerPID:7}]},{...native,windows:[{...native.windows[0],onscreen:false}]},{...native,windows:[{...native.windows[0],bounds:{width:0,height:800}}]}])assert.throws(()=>assertNativeWindowVisible(receipt,42));
});
test('visible-mode document evidence rejects hidden, unfocused and prerender states',()=>{
  const receipt={visibilityState:'visible',hidden:false,hasFocus:true};assert.equal(assertRendererVisible(receipt),receipt);
  for(const value of [{...receipt,visibilityState:'hidden',hidden:true},{...receipt,visibilityState:'prerender'},{...receipt,hasFocus:false}])assert.throws(()=>assertRendererVisible(value));
});
