import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCollectionOptionCreation} from '../src/databases/collection-option-creation.ts';
import type {DatabaseCollection, DatabaseRequest, DatabaseResponse} from '../src/core/databases.ts';

const collection: DatabaseCollection = {id:'abcdefghijkl',name:'Tasks',revision:'schema-1',deleted:false,properties:[
  {id:'fieldfield01',name:'Status',datatype:'status',default:'optionold001',options:[{id:'optionold001',name:'Started',category:'working',color:'blue'}]},
  {id:'fieldfield02',name:'Labels',datatype:'multi-select',default:['optionold002'],options:[{id:'optionold002',name:'Existing',color:'green'}]},
]};
function nextSchema(source=collection, propertyId='fieldfield01', name='Planned'):DatabaseCollection {
  return {...structuredClone(source),revision:'schema-2',properties:source.properties.map(field=>field.id===propertyId?{...structuredClone(field),options:[...structuredClone(field.options),{id:'optionnew001',name,...(field.datatype==='status'?{category:'not_started' as const}:{})}]}:structuredClone(field))};
}
const response=(next=nextSchema()):DatabaseResponse=>({collections:[next],entries:[],projection:{pending:0,issues:[]}});

test('captured option creation preserves every identity/default and appends a status option once',async()=>{
  const source=structuredClone(collection),requests:DatabaseRequest[]=[];
  const operation=prepareCollectionOptionCreation({collection:source,propertyId:'fieldfield01',label:'Planned',validate(){},service:{async request(command){requests.push(command);return response();}}});
  (source.properties[0] as {name:string}).name='Changed after capture';
  const result=await operation.run(),command=requests[0];assert.equal(command.op,'update');if(command.op==='update'){
    assert.equal(command.expectedRevision,'schema-1');assert.equal(command.name,'Tasks');assert.deepEqual(command.properties[1],collection.properties[1]);
    assert.deepEqual(command.properties[0],{...collection.properties[0],options:[...collection.properties[0].options,{name:'Planned',category:'not_started'}]});
    assert.equal(Object.isFrozen(command),true);assert.equal(Object.isFrozen(command.properties[0].options),true);
  }
  assert.equal(result.properties[0].options.at(-1)?.id,'optionnew001');assert.equal(result.properties[0].options.at(-1)?.name,'Planned');
  assert.equal(await operation.run(),result);assert.equal(requests.length,1);assert.equal(Object.isFrozen(result),true);
});

test('parallel run calls join the same request and accepted response is cached for presentation retry',async()=>{
  let requests=0,release!:(response:DatabaseResponse)=>void;
  const operation=prepareCollectionOptionCreation({collection,propertyId:'fieldfield01',label:'Planned',validate(){},service:{request(){requests++;return new Promise(resolve=>{release=resolve;});}}});
  const first=operation.run(),second=operation.run();assert.equal(first,second);assert.equal(requests,1);release(response());assert.equal(await first,await second);await operation.run();assert.equal(requests,1);
});

test('uncertain transport failure and pending publication retry the identical captured operation',async()=>{
  const requests:DatabaseRequest[]=[];
  const operation=prepareCollectionOptionCreation({collection,propertyId:'fieldfield01',label:'Planned',validate(){},service:{async request(command){requests.push(command);if(requests.length===1)throw new Error('Reply lost');if(requests.length===2)return{...response(),projection:{pending:1,issues:[]}};return response();}}});
  await assert.rejects(operation.run(),/Reply lost/);await assert.rejects(operation.run(),/still need publication/);const saved=await operation.run();assert.equal(saved.revision,'schema-2');assert.equal(requests.length,3);assert.equal(requests[0],requests[1]);assert.equal(requests[1],requests[2]);
});

test('projection issues are never acknowledged as an accepted schema',async()=>{
  let requests=0;const operation=prepareCollectionOptionCreation({collection,propertyId:'fieldfield01',label:'Planned',validate(){},service:{async request(){requests++;return{...response(),projection:{pending:0,issues:[{message:'Publication blocked'}]}};}}});
  await assert.rejects(operation.run(),/Publication blocked/);await assert.rejects(operation.run(),/Publication blocked/);assert.equal(requests,2);
});

test('retired ownership blocks request, reply acceptance and cached schema reuse',async()=>{
  let current=true,requests=0,release!:(response:DatabaseResponse)=>void;
  const validate=()=>{if(!current)throw new Error('Retired owner');};
  const operation=prepareCollectionOptionCreation({collection,propertyId:'fieldfield01',label:'Planned',validate,service:{request(){requests++;return new Promise(resolve=>{release=resolve;});}}});
  current=false;await assert.rejects(operation.run(),/Retired owner/);assert.equal(requests,0);current=true;
  const running=operation.run();current=false;release(response());await assert.rejects(running,/Retired owner/);assert.equal(requests,1);
  current=true;const retry=operation.run();release(response());await retry;assert.equal(requests,2);current=false;await assert.rejects(operation.run(),/Retired owner/);assert.equal(requests,2);
});

test('only supported option fields and valid exact labels can prepare a command',()=>{
  let requests=0;const service={async request(){requests++;return response();}},prepare=(field:string,label:string,source=collection)=>prepareCollectionOptionCreation({service,collection:source,propertyId:field,label,validate(){}});
  for(const label of ['', '   ', 'bad\nname', 'bad\u0085name', 'é'.repeat(129)])assert.throws(()=>prepare('fieldfield01',label),/option name/);
  assert.throws(()=>prepare('fieldfield01','Started'),/already exists/);assert.throws(()=>prepare('absent','Planned'),/does not support/);assert.throws(()=>prepare('fieldfield01','Planned',{...collection,deleted:true}),/Trash/);
  for(const datatype of ['text','number','checkbox','date','datetime'] as const)assert.throws(()=>prepare('fieldfield01','Planned',{...collection,properties:[{...collection.properties[0],datatype}]}),/does not support/);
  assert.equal(requests,0);
});

test('multi-select appends without a status category and preserves its selected default IDs',async()=>{
  let request:DatabaseRequest|undefined;
  const operation=prepareCollectionOptionCreation({collection,propertyId:'fieldfield02',label:' New label ',validate(){},service:{async request(command){request=command;return response(nextSchema(collection,'fieldfield02',' New label '));}}});
  const result=await operation.run();assert.equal(request?.op,'update');if(request?.op==='update'){assert.deepEqual(request.properties[1].default,['optionold002']);assert.deepEqual(request.properties[1].options?.at(-1),{name:' New label '});}assert.equal(result.properties[1].options.at(-1)?.name,' New label ');
});

test('Select keeps the exact Unicode label and returns its generated option identity',async()=>{
  const source:DatabaseCollection={...collection,properties:[{...collection.properties[0],datatype:'select',options:[{id:'optionold001',name:'Started',color:'blue'}]}]};
  const operation=prepareCollectionOptionCreation({collection:source,propertyId:'fieldfield01',label:'計畫',validate(){},service:{async request(){return response(nextSchema(source,'fieldfield01','計畫'));}}});
  const result=await operation.run();assert.deepEqual(result.properties[0].options.at(-1),{id:'optionnew001',name:'計畫'});assert.equal(result.properties[0].default,'optionold001');
});

for(const variant of ['wrong collection','deleted collection','missing field','changed datatype','missing option','ambiguous label','reused ID','changed old option','changed default'] as const){
  test(`unverified ${variant} response retains the captured command for retry`,async()=>{
    const bad=structuredClone(nextSchema()) as any;
    if(variant==='wrong collection')bad.id='wrongwrong01';
    else if(variant==='deleted collection')bad.deleted=true;
    else if(variant==='missing field')bad.properties.shift();
    else if(variant==='changed datatype')bad.properties[0].datatype='select';
    else if(variant==='missing option')bad.properties[0].options.pop();
    else if(variant==='ambiguous label')bad.properties[0].options.push({id:'optionnew002',name:'Planned',category:'not_started'});
    else if(variant==='reused ID')bad.properties[0].options.at(-1).id='optionold001';
    else if(variant==='changed old option')bad.properties[0].options[0].name='Reinterpreted';
    else bad.properties[0].default=null;
    const requests:DatabaseRequest[]=[];const operation=prepareCollectionOptionCreation({collection,propertyId:'fieldfield01',label:'Planned',validate(){},service:{async request(command){requests.push(command);return response(requests.length===1?bad:nextSchema());}}});
    await assert.rejects(operation.run(),/could not be verified/);await operation.run();assert.equal(requests[0],requests[1]);
  });
}
