import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument } from '../src/bases/document.ts';
import { BaseFunctionRegistry, baseExpressionValue, baseValueToString } from '../src/bases/expression.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
const doc=(root={},view={})=>BaseDocument.parse(JSON.stringify({...root,views:[{type:'table',name:'Table',...view}]}));
test('cyclic custom formula result used as a group key cannot crash the whole query',()=>{
 const functions=new BaseFunctionRegistry();functions.register('cycle',{parameters:[],invoke:()=>{const value={type:'list',value:[]};value.value.push(value);return value;}});
 const result=executeBaseQuery(doc({formulas:{key:'cycle()'}},{groupBy:{property:'formula.key',direction:'ASC'}}),{version:1,files:[{path:'a.md'},{path:'b.md'}]},{functions});
 assert.equal(result.rows.length,2);assert.ok(result.diagnostics.length>0);
});
test('snapshot revision and scanned count retain the entry snapshot despite reentrant callbacks',()=>{
 const snapshot={version:1,files:[{path:'a.md',properties:{value:2}}]};const functions=new BaseFunctionRegistry();functions.register('trigger',{parameters:[],invoke:()=>{snapshot.version=2;snapshot.files.push({path:'b.md'});return baseExpressionValue(1);}});
 const result=executeBaseQuery(doc({formulas:{trigger:'trigger()'}}),snapshot,{functions});assert.equal(result.version,1);assert.equal(result.counts.scanned,1);assert.equal(result.rows.length,1);
});
test('combined group-order search sort limit pipeline retains pre-search group counts',()=>{
 const result=executeBaseQuery(doc({filters:'enabled'},{order:['label'],groupBy:{property:'state',direction:'ASC'},groupOrder:['todo','done','empty'],sort:[{property:'rank',direction:'DESC'}],limit:1}),{version:'v',files:[{path:'a.md',properties:{enabled:true,label:'match',state:'todo',rank:1}},{path:'b.md',properties:{enabled:true,label:'match',state:'done',rank:9}},{path:'c.md',properties:{enabled:true,label:'miss',state:'done',rank:12}},{path:'d.md',properties:{enabled:true,label:'match',state:'unlisted',rank:20}},{path:'e.md',properties:{enabled:false,label:'match',state:'todo',rank:30}}]},{searchTerms:['match']});
 assert.deepEqual(result.rows.map(row=>row.path),['b.md']);assert.deepEqual(result.counts,{scanned:5,matched:4,afterGroupOrder:3,afterSearch:2,returned:1});assert.deepEqual(result.groupOptions.map(group=>[baseValueToString(group.key),group.count]),[['todo',1],['done',2],['empty',0],['unlisted',1]]);
});
test('group and row nested values do not alias external callback data',()=>{
 const raw={type:'list',value:[{type:'string',value:'original'}]};const functions=new BaseFunctionRegistry();functions.register('external',{parameters:[],invoke:()=>raw});const result=executeBaseQuery(doc({formulas:{key:'external()'}},{groupBy:{property:'formula.key',direction:'ASC'}}),{version:1,files:[{path:'a.md'}]},{functions});raw.value[0].value='mutated';assert.equal(baseValueToString(result.groups[0].key),'original');assert.equal(baseValueToString(result.rows[0].values['formula.key']),'original');assert.ok(Object.isFrozen(result.groups[0].key.value[0]));
});
test('formula caches are independent per row and per call even for the same revision token',()=>{
 let calls=0;const functions=new BaseFunctionRegistry();functions.register('counted',{parameters:[],invoke:()=>{calls++;return baseExpressionValue(10);}});
 const document=doc({formulas:{shared:'counted() + value',nested:'[100,200].map(formula.shared)',cyclic:'formula.cyclic'},filters:'formula.shared > 0'},{order:['formula.nested'],sort:[{property:'formula.shared',direction:'DESC'}]});
 const snapshot={version:'unchanged',files:[{path:'a.md',properties:{value:1}},{path:'b.md',properties:{value:2}}]};
 const first=executeBaseQuery(document,snapshot,{functions});assert.equal(calls,2);assert.deepEqual(first.rows.map(row=>baseValueToString(row.values['formula.nested'])),['12, 12','11, 11']);
 snapshot.files[0].properties.value=30;const second=executeBaseQuery(document,snapshot,{functions});assert.equal(calls,4);assert.equal(second.rows[0].path,'a.md');assert.equal(baseValueToString(first.rows[1].values['formula.shared']),'11');
 assert.ok(first.rows.every(row=>row.values['formula.cyclic'].type==='error'));
});
test('null boolean and whole-list groups remain typed values rather than flattened buckets',()=>{
 const result=executeBaseQuery(doc({}, {groupBy:{property:'key',direction:'DESC'}}),{version:1,files:[{path:'false.md',properties:{key:false}},{path:'true.md',properties:{key:true}},{path:'empty.md',properties:{key:null}},{path:'list.md',properties:{key:['x','y']}},{path:'second.md',properties:{key:['x','y']}}]});
 assert.equal(result.groups.length,4);assert.equal(result.groups.at(-1).key.type,'null');const list=result.groups.find(group=>group.key.type==='list');assert.deepEqual(list.rows.map(row=>row.path),['list.md','second.md']);assert.ok(Object.isFrozen(list.key.value));assert.equal(result.groups.filter(group=>group.key.type==='boolean').length,2);
});
