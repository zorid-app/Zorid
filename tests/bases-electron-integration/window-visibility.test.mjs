import test from 'node:test';
import assert from 'node:assert/strict';
import {windowMode,assertNativeWindowVisible,assertRendererVisible} from './window-visibility.mjs';
const native={pid:42,accepted:true,hidden:false,active:true,windows:[{ownerPID:42,layer:0,onscreen:true,bounds:{width:1024,height:800}}]};
test('hidden remains the default and only the explicit boolean flag opts into showing',()=>{
  assert.equal(windowMode([]),'hidden');assert.equal(windowMode(['--root','/fixture']),'hidden');assert.equal(windowMode(['--show-window']),'visible');assert.throws(()=>windowMode(['--show-window=false']));
});
test('native request acceptance cannot stand in for an actual owned visible window',()=>{
  assert.equal(assertNativeWindowVisible(native,42),native);
  for(const receipt of [{...native,pid:7},{...native,hidden:true},{...native,windows:[]},{...native,windows:[{...native.windows[0],ownerPID:7}]},{...native,windows:[{...native.windows[0],onscreen:false}]},{...native,windows:[{...native.windows[0],bounds:{width:0,height:800}}]}])assert.throws(()=>assertNativeWindowVisible(receipt,42));
});
test('visible-mode document evidence rejects hidden and prerender states',()=>{
  const receipt={visibilityState:'visible',hidden:false,hasFocus:true};assert.equal(assertRendererVisible(receipt),receipt);
  for(const value of [{...receipt,visibilityState:'hidden',hidden:true},{...receipt,visibilityState:'prerender'},{...receipt,hidden:true}])assert.throws(()=>assertRendererVisible(value));
});
test('declined activation and absent foreground focus do not falsify actual visibility',()=>{
  const observedNative={...native,accepted:false,active:false},document={visibilityState:'visible',hidden:false,hasFocus:false};
  assert.equal(assertNativeWindowVisible(observedNative,42),observedNative);assert.equal(assertRendererVisible(document),document);
  assert.throws(()=>assertNativeWindowVisible({...observedNative,windows:[]},42));assert.throws(()=>assertRendererVisible({...document,visibilityState:'hidden',hidden:true}));
});
