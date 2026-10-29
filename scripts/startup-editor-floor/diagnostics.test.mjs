import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticLatch} from './diagnostics.mjs';
const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done;}),resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('finish requested before late readiness waits for that one probe journal and paint',async()=>{
 const startup=deferred(),journal=deferred(),paint=deferred(),latch=createDiagnosticLatch();let finished=false;
 const final=latch.finish(startup.promise).then(initial=>{finished=true;return initial;});
 startup.resolve({ready:true});await turn();assert.equal(finished,false);
 latch.trackProbe('ready',[journal.promise,paint.promise]);journal.resolve();await turn();assert.equal(finished,false);
 paint.resolve();assert.deepEqual(await final,{ready:true});assert.equal(finished,true);
});
test('a missing fixed deadline probe is never retried or required to finish late diagnostics',async()=>{
 const latch=createDiagnosticLatch(),journal=deferred();let finished=false;
 const final=latch.finish(Promise.resolve({ready:true})).then(()=>{finished=true;});
 latch.trackProbe('ready',[journal.promise]);await turn();assert.equal(finished,false);
 journal.resolve();await final;assert.equal(finished,true);
});
test('startup failure does not wait for a readiness probe that cannot occur',async()=>{
 const latch=createDiagnosticLatch();assert.equal(await latch.finish(Promise.resolve(null)),null);
});
