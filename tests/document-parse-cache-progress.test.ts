import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentTransport} from '../src/core/document-semantics.ts';

const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}};
const counters={hits:2,misses:3,unavailable:1,corrupt:4,unsupported:5};
function service(progress:unknown){
  const unused=async():Promise<never>=>{throw Error('Unexpected operation');};
  const transport:DocumentTransport={status:unused,initialize:unused,rebuild:unused,publish:unused,discard:unused,open:unused,closePin:unused,metadata:unused,search:unused,backlinks:unused,base:unused,
    async begin(){return{stageId:'stage',snapshot,progress};},async pump(){return{stageId:'stage',snapshot,progress};}};
  return createDocumentService(transport);
}
test('optional parse outcomes survive the service seam separately from same-entry reuse',async()=>{
  const source={prepared:19,total:20,reused:7,ready:false,parseCache:{...counters,extra:'existing decoder ignores unknown fields'}};
  const stage=await service(source).begin();assert.equal(stage.progress!.reused,7);assert.deepEqual(stage.progress!.parseCache,counters);
  source.parseCache.hits=99;assert.equal(stage.progress!.parseCache!.hits,2);assert.ok(Object.isFrozen(stage.progress!.parseCache));
  const pumped=await service({...source,parseCache:counters}).pump(stage.stageId);assert.deepEqual(pumped.progress!.parseCache,counters);
});
test('older transports may omit parse counters or return null progress',async()=>{
  const stage=await service({prepared:1,total:2,reused:null,ready:false}).begin();assert.equal(Object.hasOwn(stage.progress!,'parseCache'),false);
  assert.equal((await service(null).begin()).progress,null);
});
test('present parse counters reject missing, negative, fractional and unsafe values',async()=>{
  for(const parseCache of [null,[],{},...Object.keys(counters).flatMap(name=>[undefined,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1'].map(value=>({...counters,[name]:value})))]){
    await assert.rejects(service({prepared:1,total:2,reused:0,ready:false,parseCache}).begin(),{code:'invalid_document_response'});
  }
});
