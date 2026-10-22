import test from 'node:test';
import assert from 'node:assert/strict';
import {createClipboardGuard} from './clipboard.mjs';
const bytes=text=>Buffer.from(text).toString('base64');
function fixture(original={changeCount:1,items:[[{type:'test/plain',data:bytes('prior fixture bytes')},{type:'test/custom',data:bytes('prior custom bytes')}],[{type:'test/binary',data:'AAECAw=='}]]}){
  let state=structuredClone(original),plain='prior fixture bytes',writes=0;
  const transport={async capture(){return structuredClone(state);},async restore(value){writes++;state={changeCount:state.changeCount+1,items:structuredClone(value.items)};return structuredClone(state);},async plain(){return plain;}};
  const guard=createClipboardGuard({transport});
  return{guard,transport,original,copy(text){plain=text;state={changeCount:state.changeCount+1,items:[[{type:'test/plain',data:bytes(text)},{type:'org.chromium.web-custom-data',data:bytes('known fixture MIME')}]]};},state:()=>state,writes:()=>writes};
}
test('private preservation restores all item/type bytes and never exposes prior text to the campaign',async()=>{
  const f=fixture();assert.equal(await f.guard.capture(),undefined);await assert.rejects(f.guard.readPlainText(),/acknowledged fixture/);f.copy('expected TSV');
  assert.deepEqual(await f.guard.recordOwnedClipboard('expected TSV'),{formats:['test/plain','org.chromium.web-custom-data'],plainBytes:12});assert.equal(await f.guard.readPlainText(),'expected TSV');
  assert.deepEqual(await f.guard.restore(),{restored:true});assert.deepEqual(f.state().items,f.original.items);assert.equal(f.writes(),1);assert.deepEqual(await f.guard.restore(),{restored:false});
});
test('the empty clipboard is preserved as empty',async()=>{const f=fixture({changeCount:1,items:[]});await f.guard.capture();f.copy('known');await f.guard.recordOwnedClipboard('known');await f.guard.restore();assert.deepEqual(f.state().items,[]);});
test('unsupported representations stop before clipboard writes',async()=>{const f=fixture({changeCount:1,items:[[{type:'promised',data:undefined}]]});await assert.rejects(f.guard.capture(),/preserved completely/);assert.equal(f.writes(),0);assert.deepEqual(await f.guard.restore(),{restored:false});});
test('copy mismatch still permits finally restoration without logging actual clipboard text',async()=>{const f=fixture();await f.guard.capture();f.copy('unexpected fixture text');await assert.rejects(f.guard.recordOwnedClipboard('expected'),error=>{assert.equal(error.message,'System clipboard plain text differs from the fixture oracle.');assert.ok(!error.message.includes('unexpected'));return true;});await f.guard.restore();assert.deepEqual(f.state().items,f.original.items);});
test('restoration mismatch reports only a content-free error',async()=>{const f=fixture();f.transport.restore=async()=>({changeCount:3,items:[]});await f.guard.capture();await assert.rejects(f.guard.restore(),{message:'Clipboard restoration verification failed.'});});
