import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentTransport} from '../src/core/document-semantics.ts';

test('Base invocation forwards canonical clock and row defaults without replacing explicit values',async()=>{
  const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}},source={localStoreId:'store',watermark:'1'};
  const requests:Parameters<DocumentTransport['base']>[0][]=[];
  const unused=async():Promise<never>=>{throw Error('Unexpected operation');};
  const transport:DocumentTransport={status:unused,initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,closePin:unused,metadata:unused,search:unused,backlinks:unused,
    async open(){return {pinId:'pin',snapshot,source,coverageComplete:true};},
    async base(input){requests.push(input);return {snapshot,source,coverageComplete:true,value:{result:{}}};},
  };
  const pin=await createDocumentService(transport).open(),original=Date.now;let clocks=0;
  try{
    Date.now=()=>{clocks++;return 123456+clocks;};
    await pin.base({id:'base'});
    await pin.base({id:'base',options:{timezone:'UTC'}});
    await pin.base({id:'base',options:{clockMs:0,maxRows:0}});
    await pin.base({id:'base',options:{clockMs:42,maxRows:17}});
    assert.deepEqual(requests.map(request=>request.options),[
      {clockMs:123457,maxRows:1000},{timezone:'UTC',clockMs:123458,maxRows:1000},
      {clockMs:0,maxRows:0},{clockMs:42,maxRows:17},
    ]);
    assert.equal(clocks,2);
  }finally{Date.now=original;}
});
