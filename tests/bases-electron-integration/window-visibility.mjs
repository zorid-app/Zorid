import assert from 'node:assert/strict';

/** JXA receives a CFArrayRef from CGWindowListCopyWindowInfo, not an NSArray.
 * Cast the toll-free reference before deepUnwrap; ObjC.wrap alone is insufficient.
 * Keep the cast object under JXA's managed lifetime (do not manually CFRelease). */
export const nativeWindowAdapterSource=String.raw`
ObjC.import('CoreGraphics');ObjC.import('CoreFoundation');
function readOwnedNativeWindows(pid){
  const raw=$.CGWindowListCopyWindowInfo(1,0);
  const all=ObjC.deepUnwrap(ObjC.castRefToObject(raw));
  if(!Array.isArray(all))throw Error('Native CGWindow CFArray bridge did not produce an array');
  const nativeCount=Number($.CFArrayGetCount(raw));
  if(all.length!==nativeCount)throw Error('Native CGWindow CFArray bridge count mismatch');
  const windows=all.filter(w=>Number(w.kCGWindowOwnerPID)===pid&&Number(w.kCGWindowLayer)===0).map(w=>({windowNumber:Number(w.kCGWindowNumber),ownerPID:Number(w.kCGWindowOwnerPID),layer:Number(w.kCGWindowLayer),onscreen:Boolean(w.kCGWindowIsOnscreen),bounds:{x:Number(w.kCGWindowBounds.X),y:Number(w.kCGWindowBounds.Y),width:Number(w.kCGWindowBounds.Width),height:Number(w.kCGWindowBounds.Height)}}));
  return {nativeCount,bridgeCount:all.length,windows};
}`;

export function windowMode(args){
  assert.ok(!args.some(value=>value.startsWith('--show-window=')),'Use the explicit --show-window flag without a value');
  return args.includes('--show-window')?'visible':'hidden';
}
/** Visibility is observed independently of activation acceptance or foreground
 * focus. macOS can decline activation while the owned window is on screen. */
export function assertNativeWindowVisible(receipt,pid){
  assert.equal(receipt.pid,pid,'Visibility belongs to the exact owned app');
  assert.equal(receipt.hidden,false,'Owned app is actually unhidden');
  assert.ok(receipt.windows?.some(window=>window.ownerPID===pid&&window.layer===0&&window.onscreen===true&&Number.isFinite(window.bounds?.width)&&window.bounds.width>0&&Number.isFinite(window.bounds?.height)&&window.bounds.height>0),'Owned native window is actually on screen');
  return receipt;
}
export function assertRendererVisible(receipt){
  assert.equal(receipt.visibilityState,'visible','Actual renderer document is visible');
  assert.equal(receipt.hidden,false,'Actual renderer hidden flag is false');
  return receipt;
}
