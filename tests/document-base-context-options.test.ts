import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentTransport} from '../src/core/document-semantics.ts';

test('Base context transports only a stable entry selector and bounded query steps',async()=>{
  const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}},source={localStoreId:'store',watermark:'1'};
  const inputs:Parameters<DocumentTransport['base']>[0][]=[];
  const unused=async():Promise<never>=>{throw Error('Unexpected operation');};
  const transport:DocumentTransport={status:unused,initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,closePin:unused,metadata:unused,search:unused,backlinks:unused,
    async open(){return {pinId:'pin',snapshot,source,coverageComplete:true};},
    async base(input){inputs.push(input);return {snapshot,source,coverageComplete:true,value:{}};},
  };
  const pin=await createDocumentService(transport).open();
  await pin.base({id:'definition',options:{currentEntryId:'current-entry',maxSteps:17,clockMs:0,maxRows:9}});
  assert.deepEqual(inputs[0].options,{currentEntryId:'current-entry',maxSteps:17,clockMs:0,maxRows:9});
  for(const maxSteps of [0,-1,1.5,2000001])await assert.rejects(()=>pin.base({id:'definition',options:{maxSteps}}),{code:'invalid_request'});
  await assert.rejects(()=>pin.base({id:'definition',options:{currentEntryId:'bad:path'}}),{code:'invalid_request'});
  assert.equal(inputs.length,1);
  await pin.base({id:'definition',options:{clockMs:0}});
  assert.equal(Object.hasOwn(inputs[1].options!,'currentEntryId'),false);
  assert.equal(Object.hasOwn(inputs[1].options!,'maxSteps'),false);
});
