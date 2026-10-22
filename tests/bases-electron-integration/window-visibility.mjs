import assert from 'node:assert/strict';

export function windowMode(args){
  assert.ok(!args.some(value=>value.startsWith('--show-window=')),'Use the explicit --show-window flag without a value');
  return args.includes('--show-window')?'visible':'hidden';
}
/** Successful activation requests alone do not prove a visible native window. */
export function assertNativeWindowVisible(receipt,pid){
  assert.equal(receipt.pid,pid,'Visibility belongs to the exact owned app');
  assert.equal(receipt.accepted,true,'Native unhide/activation request accepted');
  assert.equal(receipt.hidden,false,'Owned app is actually unhidden');
  assert.equal(receipt.active,true,'Owned app is actually active');
  assert.ok(receipt.windows?.some(window=>window.ownerPID===pid&&window.layer===0&&window.onscreen===true&&Number.isFinite(window.bounds?.width)&&window.bounds.width>0&&Number.isFinite(window.bounds?.height)&&window.bounds.height>0),'Owned native window is actually on screen');
  return receipt;
}
export function assertRendererVisible(receipt){
  assert.equal(receipt.visibilityState,'visible','Actual renderer document is visible');
  assert.equal(receipt.hidden,false,'Actual renderer hidden flag is false');
  assert.equal(receipt.hasFocus,true,'Actual renderer has foreground focus');
  return receipt;
}
