import test from 'node:test';
import assert from 'node:assert/strict';
import {captureCollectionSourceCompletion} from '../src/bases/collection-source-completion.ts';
import {BaseDocument} from '../src/bases/document.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const field={id:'field0000001',name:'Old',datatype:'text' as const,options:[]};
const collection:DatabaseCollection={id:'collection01',name:'Books',revision:uuid(2),deleted:false,properties:[field]};
const created:DatabaseCollection={...collection,revision:uuid(3)};
const source='# Root comment\nunknown: {sentinel: keep}\nviews:\n  - id: original0001\n    type: table\n    name: Original\n    source: {kind: collection, id: collection01}\n    order: [file.name, note.field0000001]\n    filterUnknown: keep-local\n  - id: sibling00001\n    type: list\n    name: Sibling # sibling comment\n    unknownSibling: untouched\n';
const base=(text=source)=>({source:text,entryId:uuid(10),revision:uuid(11),viewIndex:0,viewId:'original0001'});
const create:DatabaseRequest={op:'create',operationId:uuid(20),name:'Books',preset:'blank'};
const receipt=(value:DatabaseCollection=created):DatabaseResponse=>({collections:[structuredClone(value)],entries:[],projection:{pending:0,issues:[]}});
const appended={id:'field0000002',name:'Rating',datatype:'number' as const,options:[]};
const update:DatabaseRequest={op:'update',operationId:uuid(21),collectionId:collection.id,expectedRevision:collection.revision,name:collection.name,properties:[field,{name:'Rating',datatype:'number',options:[]}]};
const updated=()=>receipt({...created,properties:[field,appended]});

test('source selection uses returned generated collection ID and frozen whole-source witness, preserving unrelated YAML',()=>{
  const options={...base(),kind:{type:'change-source' as const}};
  const plan=captureCollectionSourceCompletion(options);options.source='foreign caller source';options.entryId='foreign';
  const saved=receipt({...created,id:'generated001'}),result=plan.complete(saved,create);
  assert.equal(result.expectedSource,source);assert.equal(result.entryId,uuid(10));assert.equal(result.revision,uuid(11));
  assert.equal(result.viewId,'original0001');assert.equal(result.viewIndex,0);
  const parsed=BaseDocument.parse(result.desiredSource);assert.deepEqual(parsed.views[0].source,{kind:'collection',id:'generated001'});
  assert.equal(parsed.views[0].order,undefined);assert.equal(parsed.views[0].filterUnknown,'keep-local');
  assert.match(result.desiredSource,/# Root comment/);assert.match(result.desiredSource,/# sibling comment/);
  assert.deepEqual(parsed.getRoot('unknown'),{sentinel:'keep'});assert.deepEqual(parsed.views[1],BaseDocument.parse(source).views[1]);
  assert.equal(Object.isFrozen(result),true);assert.equal(plan.complete(structuredClone(saved),structuredClone(create)),result);
  saved.collections[0].properties.push(appended);assert.throws(()=>plan.complete(saved,create),/no longer matches/);
});

test('add-view allocates its stable ID before completion and preserves the original selected view',()=>{
  const plan=captureCollectionSourceCompletion({...base(),kind:{type:'add-view',viewType:'cards',viewName:'Added'}});
  const before=structuredClone(create),first=plan.complete(receipt(),create),second=plan.complete(receipt(),before);
  assert.equal(first,second);assert.equal(first.viewIndex,2);assert.match(first.viewId!,/^[0-9a-z]{12}$/);
  const parsed=BaseDocument.parse(first.desiredSource);assert.equal(parsed.views[2].name,'Added');assert.equal(parsed.views[2].type,'cards');
  assert.equal(parsed.views[2].id,first.viewId);assert.deepEqual(parsed.views[2].source,{kind:'collection',id:created.id});
  assert.deepEqual(parsed.views.slice(0,2),BaseDocument.parse(source).views);
});

test('legacy source selection allocates once at capture; none preserves exact bytes and no missing identity is added',()=>{
  const legacy='# Legacy comment\nviews:\n  - type: table\n    name: Legacy\n    unknown: stays\n';
  const original={source:legacy,entryId:uuid(10),revision:uuid(11),viewIndex:0};
  const plan=captureCollectionSourceCompletion({...original,kind:{type:'change-source'}});
  const first=plan.complete(receipt(),create);assert.match(first.viewId!,/^[0-9a-z]{12}$/);assert.equal(plan.complete(receipt(),create),first);
  const none=captureCollectionSourceCompletion({...original,kind:{type:'none'}}).complete(receipt(),create);
  assert.equal(none.desiredSource,legacy);assert.equal(none.expectedSource,legacy);assert.equal(none.viewId,undefined);
});

test('append-properties uses frozen original collection and order, and only receipt-generated new field IDs',()=>{
  const old=structuredClone(collection),order=['file.name','note.field0000001'];
  const plan=captureCollectionSourceCompletion({...base(),kind:{type:'append-properties',collection:old,originalOrder:order}});
  old.revision=uuid(99);old.properties[0].name='Caller changed';order.unshift('note.foreign00001');
  const result=plan.complete(updated(),update),parsed=BaseDocument.parse(result.desiredSource);
  assert.deepEqual(parsed.views[0].order,['file.name','note.field0000001','note.field0000002']);
  assert.equal(parsed.views[0].filterUnknown,'keep-local');assert.deepEqual(parsed.views[1],BaseDocument.parse(source).views[1]);
  assert.match(result.desiredSource,/# Root comment/);
});

test('pending publication rejects without caching a source, while same-command clean receipt can complete later',()=>{
  const plan=captureCollectionSourceCompletion({...base(),kind:{type:'change-source'}}),pending=receipt();
  pending.projection.pending=1;assert.throws(()=>plan.complete(pending,create),/waiting for verified file publication/);
  assert.throws(()=>plan.complete(receipt(),{...create,operationId:uuid(22)}),/no longer matches/);
  assert.equal(BaseDocument.parse(plan.complete(receipt(),create).desiredSource).views[0].source?.id,created.id);
  const issues=receipt();issues.projection.issues.push({message:'Permission denied'});
  assert.throws(()=>captureCollectionSourceCompletion({...base(),kind:{type:'none'}}).complete(issues,create),/waiting for verified file publication/);
});

test('foreign, ambiguous, malformed and deleted create receipts never produce a completion',()=>{
  for(const response of [receipt({...created,name:'Foreign'}),receipt({...created,deleted:true}),{...receipt(),collections:[created,created]},receipt({...created,id:'bad'})]){
    assert.throws(()=>captureCollectionSourceCompletion({...base(),kind:{type:'change-source'}}).complete(response,create));
  }
  const response=receipt();response.entries.push({entryId:uuid(40),collectionId:'foreign00001',revision:uuid(41),fileRevision:uuid(42),path:'Other.md',values:{},deleted:false,pendingProjection:false});
  assert.throws(()=>captureCollectionSourceCompletion({...base(),kind:{type:'none'}}).complete(response,create));
});

test('append rejects foreign collection, changed original schema, incorrect generated field and wrong CAS request',()=>{
  const make=()=>captureCollectionSourceCompletion({...base(),kind:{type:'append-properties',collection,originalOrder:['file.name','note.field0000001']}});
  for(const response of [receipt({...created,id:'foreign00001',properties:[field,appended]}),receipt({...created,properties:[{...field,name:'Changed'},appended]}),receipt({...created,properties:[field,{...appended,name:'Wrong'}]})])assert.throws(()=>make().complete(response,update));
  assert.throws(()=>make().complete(updated(),{...update,expectedRevision:uuid(99)}));
  assert.throws(()=>make().complete(updated(),{...update,collectionId:'foreign00001'}));
});

test('capture rejects a mismatched selected view and completion rejects read/maintenance commands',()=>{
  assert.throws(()=>captureCollectionSourceCompletion({...base(),viewId:'foreign00001',kind:{type:'none'}}));
  assert.throws(()=>captureCollectionSourceCompletion({...base(),viewIndex:20,kind:{type:'change-source'}}));
  for(const command of [{op:'list'},{op:'retry'},{op:'get',collectionId:created.id}] as DatabaseRequest[]){
    assert.throws(()=>captureCollectionSourceCompletion({...base(),kind:{type:'none'}}).complete(receipt(),command));
  }
});


test('append capture rejects an order from another source and requires old property identities in the command',()=>{
  assert.throws(()=>captureCollectionSourceCompletion({...base(),kind:{type:'append-properties',collection,originalOrder:['file.name']}}));
  const plan=captureCollectionSourceCompletion({...base(),kind:{type:'append-properties',collection,originalOrder:['file.name','note.field0000001']}});
  assert.throws(()=>plan.complete(updated(),{...update,properties:[{name:field.name,datatype:field.datatype,options:[]},{name:'Rating',datatype:'number',options:[]}]}));
});

test('semantic old schema comparison accepts a different property key insertion order',()=>{
  const plan=captureCollectionSourceCompletion({...base(),kind:{type:'append-properties',collection,originalOrder:['file.name','note.field0000001']}});
  const response=receipt({...created,properties:[{name:field.name,options:[],datatype:field.datatype,id:field.id},appended]});
  assert.deepEqual(BaseDocument.parse(plan.complete(response,update).desiredSource).views[0].order,['file.name','note.field0000001','note.field0000002']);
});


test('none validates the exact returned entry identity, path, values and publication without changing source',()=>{
  const command:DatabaseRequest={op:'create_entry',operationId:uuid(30),collectionId:created.id,expectedCollectionRevision:created.revision,entryId:uuid(31),path:'New.md',values:{field0000001:'Exact'}};
  const entry={entryId:uuid(31),collectionId:created.id,revision:uuid(32),fileRevision:uuid(33),path:'New.md',values:{field0000001:'Exact'},deleted:false,pendingProjection:false};
  const accepted={...receipt(),entries:[entry]};
  const make=()=>captureCollectionSourceCompletion({...base(),kind:{type:'none'}});
  assert.equal(make().complete(accepted,command).desiredSource,source);
  for(const wrong of [{...entry,path:'Foreign.md'},{...entry,deleted:true},{...entry,pendingProjection:true},{...entry,values:{field0000001:'Different'}},{...entry,problems:{field0000001:'Invalid'}}]){
    assert.throws(()=>make().complete({...receipt(),entries:[wrong]},command));
  }
});

test('explicit create schema must match returned generated fields rather than a foreign schema',()=>{
  const command:DatabaseRequest={...create,properties:[{name:'Rating',datatype:'number',options:[]}]};
  const make=()=>captureCollectionSourceCompletion({...base(),kind:{type:'change-source'}});
  assert.throws(()=>make().complete(receipt(),command));
  assert.doesNotThrow(()=>make().complete(receipt({...created,properties:[appended]}),command));
});
