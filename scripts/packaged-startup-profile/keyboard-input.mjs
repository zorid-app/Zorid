import assert from 'node:assert/strict';

// The benchmark sends only Cmd+S, Cmd+Z and Cmd+Home. Windows virtual keys match
// the shared integration UI helper; macOS native keys match HIToolbox Events.h
// (kVK_ANSI_S, kVK_ANSI_Z, kVK_Home). No synthesized command or fallback bypasses
// ordinary renderer/native key routing.
const keys={KeyS:{key:'s',windowsVirtualKeyCode:83,nativeVirtualKeyCode:0x01},KeyZ:{key:'z',windowsVirtualKeyCode:90,nativeVirtualKeyCode:0x06},Home:{key:'Home',windowsVirtualKeyCode:36,nativeVirtualKeyCode:0x73}};
export async function pressProfileKey(renderer,key,code,commands){
  const mapping=keys[code];assert.ok(mapping&&mapping.key===key,'Only the benchmark’s explicit key identities may be dispatched');
  for(const type of ['keyDown','keyUp'])await renderer.call('Input.dispatchKeyEvent',{type,code,modifiers:4,...mapping,...(type==='keyDown'&&commands?.length?{commands:[...commands]}:{})});
}
