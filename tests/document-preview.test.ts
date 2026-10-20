import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentPreviewService,previewRequest,documentPreviewOpen,documentPreviewBase,documentPreviewClose,documentPreviewBound,decodePreviewEnvelope,DOCUMENT_PREVIEW_RESPONSE_BYTES} from '../src/core/document-preview.ts';
import type {DocumentPreviewTransport,DocumentPreviewBaseInput} from '../src/core/document-preview.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
const capture={ownerNonce:'owner',stageId:'stage',serial:'1'},source={localStoreId:'store',watermark:'0'},progress={preparedFiles:1,totalFiles:3,pendingFiles:2};
const opened=(previewId='1')=>({previewId,capture:{...capture},source:{...source},progress:{...progress}});
function result(previewId='1') {return {previewId,capture:{...capture},source:{...source},definition:{id:'base',revision:'r1',path:'Board.base',kind:'file',deleted:false},result:{status:'indexing',complete:false,aggregatesComplete:false,countsScope:'preparedSubset',progress:{...progress},preparedScanComplete:true,unavailablePreparedFiles:0,unavailableFilterRows:0,view:{type:'table'},rows:[],groups:[],groupOptions:[],properties:[],availableProperties:[],counts:{scanned:1,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],stepsUsed:1,relationshipsAvailable:false,metadataIssues:[],metadataComplete:false,refreshHint:null}};}
const baseRequest={previewId:'1',id:'base',options:{clockMs:1000,maxRows:1000}};
const encoded=(value:unknown,op='preview_base')=>new TextEncoder().encode(JSON.stringify({schemaVersion:1,op,value}));
function pause(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
function fixture(){const requests:{op:string;input:unknown}[]=[];let wait:Promise<void>|undefined,empty=false,failClose=false;
  const transport:DocumentPreviewTransport={async previewOpen(input){requests.push({op:'open',input});if(wait)await wait;return empty?null:opened(input.previewId);},async previewBase(input){requests.push({op:'base',input});if(wait)await wait;return result(input.previewId);},async previewClose(input){requests.push({op:'close',input});if(failClose){failClose=false;throw new Error('close failed');}return {closed:true};}};
  return {transport,requests,service:createDocumentPreviewService(transport),hold(value?:Promise<void>){wait=value;},empty(value:boolean){empty=value;},failClose(){failClose=true;}};
}
test('preview requests capture only closed bounded data fields and canonical positive IDs',()=>{
  const input={previewId:'2',id:'base',viewName:null,options:{searchTerms:['original'],clockMs:0,maxRows:0}};
  const copy=previewRequest('preview_base',input) as DocumentPreviewBaseInput;input.options.searchTerms[0]='changed';assert.deepEqual(copy.options!.searchTerms,['original']);assert.equal(Object.isFrozen(copy.options!.searchTerms),true);
  for(const value of [{previewId:'0'},{previewId:'01'},{previewId:'18446744073709551616'},{previewId:'1',pinId:'forged'}])assert.throws(()=>previewRequest('preview_open',value),{code:'invalid_request'});
  for(const options of [{maxSteps:0},{maxRows:10001},{clockMs:NaN},{currentEntryId:'../file'},{unknown:true},{searchTerms:['x'.repeat(65536)]}])assert.throws(()=>previewRequest('preview_base',{previewId:'1',id:'base',options}),{code:'invalid_request'});
  let hooks=0;const hooked={previewId:'1',get extra(){hooks++;return 1;}};assert.throws(()=>previewRequest('preview_open',hooked));assert.equal(hooks,0);
  const toJSON={previewId:'1',toJSON(){hooks++;return {previewId:'1'};}};assert.throws(()=>previewRequest('preview_open',toJSON));assert.equal(hooks,0);
});
test('preview byte accounting rejects cycles, sparse arrays, malformed Unicode and large strings without serialization',()=>{
  const cycle:any={};cycle.next=cycle;for(const value of [cycle,{x:'\ud800'},{x:new Array(3)},{x:'雪'.repeat(22000)}])assert.throws(()=>documentPreviewBound(value,65536));
  assert.doesNotThrow(()=>documentPreviewBound({x:'a\n雪'},64));
});
test('preview DTOs retain exact partial classifications and reject fake published snapshots or capture substitutions',()=>{
  const open=documentPreviewOpen(opened(),'1')!;const value=documentPreviewBase(result(),open,baseRequest);
  assert.equal(value.result.status,'indexing');assert.equal(value.result.complete,false);assert.equal(value.result.aggregatesComplete,false);assert.equal(value.result.countsScope,'preparedSubset');assert.equal(Object.hasOwn(value,'snapshot'),false);assert.equal(Object.isFrozen(value.result.progress),true);
  for(const change of [{complete:true},{aggregatesComplete:true},{countsScope:'allFiles'},{relationshipsAvailable:true},{metadataComplete:true},{snapshotId:{fake:true}},{progress:{...progress,pendingFiles:1}}]){const bad=result();Object.assign(bad.result,change);assert.throws(()=>documentPreviewBase(bad,open,baseRequest),{code:'invalid_document_response'});}
  const changed=result();changed.capture.serial='2';assert.throws(()=>documentPreviewBase(changed,open,baseRequest));
  const foreign=result();foreign.source.localStoreId='other';assert.throws(()=>documentPreviewBase(foreign,open,baseRequest));
  assert.throws(()=>documentPreviewOpen({...opened(),progress:{...progress,preparedFiles:4}},'1'));assert.throws(()=>documentPreviewOpen(opened('2'),'1'));
});
test('strict preview result traversal validates tagged values, counts and actual metadata issue DTOs',()=>{
  const value=result() as any;value.result.rows=[{entryId:'file',revision:'r1',path:'File.md',values:{text:{type:'string',value:'text'},nested:{type:'list',value:[{type:'object',value:[['x',{type:'number',value:1}]]}]},link:{type:'link',path:'File.md',target:{entryId:'file',revision:'r1'},display:null,external:false}}}];value.result.counts={scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1};
  value.result.metadataIssues=[{witness:{entryId:'file',revision:'r1'},exclusion:'unreadable',diagnostics:[],propertiesUnavailable:true}];
  assert.doesNotThrow(()=>documentPreviewBase(value,opened(),baseRequest));
  const wrong=structuredClone(value);wrong.result.rows[0].values.text={type:'number',value:Infinity};assert.throws(()=>documentPreviewBase(wrong,opened(),baseRequest));
  const count=structuredClone(value);count.result.counts.returned=0;assert.throws(()=>documentPreviewBase(count,opened(),baseRequest));
  const unknown=structuredClone(value);unknown.result.metadataIssues[0].witness.snapshotId='fake';assert.throws(()=>documentPreviewBase(unknown,opened(),baseRequest));
});
test('raw preview envelope validates exact operation, full backing allocation, UTF8 and complete byte ceiling',()=>{
  assert.equal(decodePreviewEnvelope(encoded(result())).definition.id,'base');
  for(const bytes of [encoded(result(),'base'),new Uint8Array([255]),new Uint8Array(DOCUMENT_PREVIEW_RESPONSE_BYTES+1),encoded(result()).subarray(1)])assert.throws(()=>decodePreviewEnvelope(bytes));
  assert.throws(()=>documentPreviewClose({closed:true,extra:1}));assert.doesNotThrow(()=>documentPreviewClose({closed:true}));
});
test('preview IDs share a transport highwater across facades and null opens consume IDs without creating pins',async()=>{
  const f=fixture();f.empty(true);assert.equal(await f.service.openPreview(),null);f.empty(false);
  const handle=await createDocumentPreviewService(f.transport).openPreview();assert.equal(handle!.previewId,'2');assert.equal(Object.isFrozen(handle),true);assert.equal(Object.hasOwn(handle!,'snapshot'),false);
  const next=await f.service.openPreview();assert.equal(next!.previewId,'3');assert.deepEqual(f.requests.map(row=>(row.input as {previewId:string}).previewId),['1','2','3']);
  await handle!.close();await next!.close();
});
test('preview handle captures one clock/options snapshot and rejects results during close while draining the accepted query',async()=>{
  const f=fixture(),handle=(await f.service.openPreview())!,wait=pause();f.hold(wait.promise);
  const input={id:'base',options:{searchTerms:['original'],clockMs:1000}},pending=handle.base(input);input.options.searchTerms[0]='changed';
  const closing=handle.close();await assert.rejects(handle.base({id:'base'}),{code:'document_preview_closed'});assert.equal(f.requests.some(row=>row.op==='close'),false);
  wait.resolve();await assert.rejects(pending,{code:'document_preview_closed'});await closing;await handle.close();
  assert.deepEqual((f.requests.find(row=>row.op==='base')!.input as DocumentPreviewBaseInput).options,{searchTerms:['original'],clockMs:1000,maxRows:1000});assert.equal(f.requests.filter(row=>row.op==='close').length,1);
});
test('common preview copy admission is shared across reconstructed facades and releases credits after failures',async()=>{
  const f=fixture(),wait=pause();f.hold(wait.promise);const pending=Array.from({length:8},()=>createDocumentPreviewService(f.transport).openPreview());
  await assert.rejects(f.service.openPreview(),{code:'document_preview_capacity'});assert.equal(f.requests.length,8);wait.resolve();const handles=await Promise.all(pending);await Promise.all(handles.map(handle=>handle!.close()));
  f.hold();const handle=(await f.service.openPreview())!;f.failClose();await assert.rejects(handle.close(),/close failed/);await handle.close();
});
test('common document service rejects a partial positive preview capability before opening anything',()=>{
  for(const missing of ['previewOpen','previewBase','previewClose']){let opened=false;const transport:any={basePreviewAvailable:true,previewOpen(){opened=true;},previewBase(){},previewClose(){}};delete transport[missing];assert.throws(()=>createDocumentService(transport),{code:'invalid_document_response'});assert.equal(opened,false);}
  const legacy=createDocumentService({basePreviewAvailable:false,previewOpen(){assert.fail();}} as any);assert.equal(legacy.openPreview,undefined);
});
