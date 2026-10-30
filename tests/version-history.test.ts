import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {openVersionHistory} from '../src/ui/version-history.ts';
import type {RecoveryHistory,RecoveryVersion} from '../src/platform/bridge';
const row=(snapshotId='2'):RecoveryVersion=>({snapshotId,entryId:'private-entry-id',path:'Note.md',capturedAtMs:1_700_000_000_000,byteLength:3});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(t:TestContext){
  const dom=new JSDOM('<body><button id="trigger">History</button></body>',{pretendToBeVisual:true});
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const[key,value]of Object.entries({document:dom.window.document,MutationObserver:dom.window.MutationObserver})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
  t.after(()=>{dom.window.close();for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  t.mock.method(console,'error',()=>{});document.querySelector<HTMLButtonElement>('#trigger')!.focus();return dom;
}
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label)!;
const history=(overrides:Partial<RecoveryHistory>={}):RecoveryHistory=>({list:async()=>({versions:[row()]}),read:async()=>({version:row(),content:'old'}),...overrides});
test('history previews exact text, hides technical metadata and restores with explicit action',async t=>{
  setup(t);let restored:string|undefined;
  openVersionHistory({history:history({read:async()=>({version:row(),content:'\ufeff<script>old</script>'})}),entryId:row().entryId,isCurrent:()=>true,restore:async value=>{restored=value;return'restored';}});
  await settle();document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await settle();
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value,'\ufeff<script>old</script>');assert.equal(document.querySelector('script'),null);
  assert.doesNotMatch(document.querySelector('[role=dialog]')!.outerHTML,/private-entry-id|snapshotId|provenance/);
  assert.match(document.body.textContent!,/Restoring replaces the current note/);
  button('Restore version').click();await settle();assert.equal(restored,'\ufeff<script>old</script>');assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(document.activeElement?.id,'trigger');
});
test('history page requests use the captured cursor and show plain failure copy',async t=>{
  setup(t);let calls=0;
  openVersionHistory({history:history({list:async(_id,options)=>{calls++;if(calls===1)return{versions:[row()],nextCursor:{captured_at_ms:row().capturedAtMs,snapshot_id:'2'}};assert.deepEqual(options.before,{captured_at_ms:row().capturedAtMs,snapshot_id:'2'});throw new Error('IPC schema private-entry-id');}}),entryId:row().entryId,isCurrent:()=>true,restore:async()=>'restored'});
  await settle();button('Show older versions').click();await settle();assert.equal(calls,2);assert.match(document.body.textContent!,/Version history is unavailable/);assert.doesNotMatch(document.body.innerHTML,/IPC|schema|private-entry-id/);button('Close').click();
});
test('dirty draft and failed restoration remain visible without technical error details',async t=>{
  setup(t);let calls=0;
  openVersionHistory({history:history(),entryId:row().entryId,isCurrent:()=>true,restore:async()=>{if(++calls===1)return'save_changes';throw new Error('IPC checkpoint_cas UUID');}});
  await settle();document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await settle();
  button('Restore version').click();await settle();assert.match(document.body.textContent!,/Restoring is unavailable while they are unsaved/);
  button('Restore version').click();await settle();assert.match(document.body.textContent!,/note and your changes were kept/);assert.doesNotMatch(document.body.innerHTML,/IPC|checkpoint_cas|UUID/);button('Close').click();
});
test('stale asynchronous replies cannot preview or restore a different vault',async t=>{
  setup(t);let current=true,release!:(value:{version:RecoveryVersion;content:string})=>void,restores=0;
  const pending=new Promise<{version:RecoveryVersion;content:string}>(resolve=>{release=resolve;});
  openVersionHistory({history:history({read:()=>pending}),entryId:row().entryId,isCurrent:()=>current,restore:async()=>{restores++;return'restored';}});
  await settle();document.querySelector<HTMLButtonElement>('.version-history-version')!.click();current=false;release({version:row(),content:'stale'});await settle();
  assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(restores,0);
});
test('keyboard focus stays inside history and Escape closes without restoring',async t=>{
  const dom=setup(t);let restores=0;
  openVersionHistory({history:history(),entryId:row().entryId,isCurrent:()=>true,restore:async()=>{restores++;return'restored';}});await settle();
  button('Close').focus();document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',cancelable:true}));
  assert.equal(document.activeElement?.className,'version-history-version');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(restores,0);assert.equal(document.activeElement?.id,'trigger');
});
