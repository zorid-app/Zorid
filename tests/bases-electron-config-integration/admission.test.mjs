import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureAdmission,awaitFixtureAdmission} from './admission.mjs';

const paths=['Configuration.base','Records/Item 01.md','Export/Export 0001.md'];
const entry=path=>({path,type:'file'});
function context(inventories){
  let time=0,index=0;const reads=[],screenshots=[],messages=[];
  const c={vault:'/owned/disposable vault',evidence:{},ui:{dom:async()=>({rowcount:'1',busy:'false',status:''})},screenshot:async name=>screenshots.push(name),cdp:{evaluate:async expression=>{reads.push(expression);return inventories[Math.min(index++,inventories.length-1)];}}};
  return {c,reads,screenshots,messages,options:{timeoutMs:3000,now:()=>time,pause:async ms=>{time+=ms;},progress:message=>messages.push(message)}};
}
test('durable admission requires exact file identities, not scan counts or published empty rows',()=>{
  const partial=fixtureAdmission([{path:'Records',type:'folder'},entry(paths[0]),entry(paths[2])],new Set(paths));
  assert.deepEqual(partial,{complete:false,expectedFiles:3,admittedFiles:2,missingFiles:1,admittedRecords:0,admittedExports:1});
  assert.equal(fixtureAdmission(paths.map(entry),new Set(paths)).complete,true);
  assert.throws(()=>fixtureAdmission([entry(paths[0]),entry(paths[0])],new Set(paths)),/unique/);
  assert.throws(()=>fixtureAdmission([entry('Unexpected.md')],new Set(paths)),/only owned/);
  assert.throws(()=>fixtureAdmission([{path:paths[0],type:'unknown'}],new Set(paths)),/kind/);
});
test('read-only readiness preserves first-entry zero rows and receipts while ordinary admission advances',async()=>{
  const f=context([[entry(paths[0]),entry(paths[2])],paths.map(entry)]);
  const receipt=await awaitFixtureAdmission(f.c,paths,f.options);
  assert.equal(receipt.complete,true);assert.equal(receipt.elapsedMs,1000);assert.equal(receipt.initialUi.rowcount,'1');
  assert.deepEqual(receipt.samples.map(sample=>[sample.admittedFiles,sample.admittedRecords]),[[2,0],[3,1]]);
  assert.deepEqual(f.screenshots,['00-initial-admission-state']);assert.equal(f.c.evidence.preconditions[0],receipt);
  assert.deepEqual(f.reads,['window.zorid.list("/owned/disposable vault")','window.zorid.list("/owned/disposable vault")']);
  assert.equal(f.messages.length,2,'Initial and completed progress are observable');
});
test('stalled admission fails its bounded precondition and retains every partial receipt',async()=>{
  const f=context([[entry(paths[0])]]);
  await assert.rejects(awaitFixtureAdmission(f.c,paths,f.options),/incomplete at 3000ms: 1\/3/);
  const receipt=f.c.evidence.preconditions[0];assert.equal(receipt.complete,false);assert.equal(receipt.samples.length,4);assert.equal(receipt.samples.at(-1).elapsedMs,3000);
  assert.equal(f.reads.length,4,'No unbounded retry or silent sleep');
});
test('inventory failures propagate immediately without being mistaken for pending admission',async()=>{
  const f=context([[]]);f.c.cdp.evaluate=async()=>{throw Error('read-only inventory unavailable');};
  await assert.rejects(awaitFixtureAdmission(f.c,paths,f.options),/inventory unavailable/);
  assert.equal(f.c.evidence.preconditions[0].samples.length,0);
});
test('a completed inventory read arriving after the deadline cannot pass readiness',async()=>{
  const f=context([[]]);let time=0;f.options.now=()=>time;
  f.c.cdp.evaluate=async()=>{time=4000;return paths.map(entry);};
  await assert.rejects(awaitFixtureAdmission(f.c,paths,f.options),/incomplete at 4000ms: 3\/3/);
  const receipt=f.c.evidence.preconditions[0];assert.equal(receipt.complete,false);assert.equal(receipt.samples.at(-1).complete,true);
});
