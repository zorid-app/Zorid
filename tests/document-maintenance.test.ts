import test from 'node:test';
import assert from 'node:assert/strict';
import {catchUpDocumentIndex} from '../src/core/document-semantics.ts';
import type {DocumentService,DocumentSnapshotId,DocumentStage,DocumentStageId,DocumentStatus} from '../src/core/document-semantics.ts';

for(const advanceSource of [false,true])test(`lost publication ACK is witnessed before cleanup (source advances: ${advanceSource})`,async()=>{
  const snapshot=(generation:string):DocumentSnapshotId=>({localStoreId:'store',generationEpoch:'epoch',generation,versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}});
  let sourceWatermark='1',published:DocumentSnapshotId|null=null,coveredWatermark:string|null=null;
  let begins=0,discards=0,resets=0,firstPublish=true;
  const status=():DocumentStatus=>({source:{localStoreId:'store',watermark:sourceWatermark},snapshot:published,
    coveredSource:coveredWatermark?{localStoreId:'store',watermark:coveredWatermark}:null,
    current:coveredWatermark===sourceWatermark,rebuildRequired:false,coverageComplete:published?true:null});
  const stages=new Map<DocumentStageId,{snapshot:DocumentSnapshotId;watermark:string}>();
  const service:DocumentService={
    async status(){return status();},async initialize(){},async rebuild(){resets++;},async open(){throw Error('Helper must not open pins');},
    async begin(){const stageId=`stage-${++begins}` as DocumentStageId;const id=snapshot(String(begins));stages.set(stageId,{snapshot:id,watermark:sourceWatermark});return {stageId,snapshot:id,progress:null};},
    async pump(stageId):Promise<DocumentStage>{return {stageId,snapshot:stages.get(stageId)!.snapshot,progress:{prepared:1,total:1,reused:0,ready:true}};},
    async publish(stageId){const stage=stages.get(stageId)!;published=stage.snapshot;coveredWatermark=stage.watermark;
      if(firstPublish){firstPublish=false;if(advanceSource)sourceWatermark='2';throw {code:'transport_error'};}return stage.snapshot;},
    async discard(){discards++;throw Error('Publication witness must not be discarded');},
  };
  await assert.rejects(()=>catchUpDocumentIndex(service,{isCurrent:()=>true}),error=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='transport_error'));
  const result=await catchUpDocumentIndex(service,{isCurrent:()=>true});
  assert.equal(result.current,true);assert.equal(discards,0);assert.equal(resets,0);
  assert.equal(begins,advanceSource?2:1);assert.equal(result.snapshot?.generation,advanceSource?'2':'1');assert.equal(result.source.watermark,advanceSource?'2':'1');
});
