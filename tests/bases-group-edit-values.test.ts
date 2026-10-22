import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaseViewActions, baseGroupWriteValue } from '../src/bases/view-actions.ts';
import type { BaseController } from '../src/bases/controller.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';
const raw = (value: string): BaseExpressionValue => ({type:'string',value});
const link = (name: string): BaseExpressionValue => ({type:'namespace',name,get(){return {type:'null'};}});
function fixture() {
  const source = {type:'list' as const,value:[link('A')]}, destination = {type:'list' as const,value:[link('Shown B'),link('Shown C')]};
  const editKey = {type:'list' as const,value:[raw('[[/Projects/B.md|Alias B]]'),raw('[[/Projects/C.md]]')]};
  const moves: unknown[] = [];
  const result = {version:7,view:{type:'kanban',name:'Board',groupBy:{property:'projects'}},rows:[{path:'One.md',values:{'note.projects':source}}],
    groups:[{key:source,sharedKeyId:'source',rows:[{path:'One.md',values:{'note.projects':source}}]},{key:destination,sharedKeyId:'destination',editKey,rows:[]}],
    groupOptions:[],shared:{},
  } as unknown as BaseQueryResult;
  const controller = {state:{version:7,result,error:null},async moveToGroup(edit:unknown){moves.push(edit);}} as unknown as BaseController;
  return {result,moves,actions:createBaseViewActions(controller,{validate(){}}),source,destination};
}

test('shared Kanban moves and New consume the exact core whole-list edit key identified by opaque destination', async()=>{
  const f=fixture();
  await f.actions.requestMove({version:7,path:'One.md',property:'note.projects',source:f.source,destination:raw('Untrusted display'),sourceKeyId:'source',destinationKeyId:'destination'});
  assert.deepEqual(f.moves,[{version:7,path:'One.md',value:['[[/Projects/B.md|Alias B]]','[[/Projects/C.md]]']}]);
  assert.deepEqual(f.actions.creationGroup({version:7,property:'projects',group:raw('Untrusted display'),groupKeyId:'destination'}),{property:'note.projects',value:['[[/Projects/B.md|Alias B]]','[[/Projects/C.md]]']});
  assert.equal(f.actions.canMove(f.result),true);
});

test('shared displayed strings and rich values never substitute for a missing writable edit key', async()=>{
  const f=fixture();
  const result=f.result as unknown as {groups:{key:BaseExpressionValue;editKey?:BaseExpressionValue}[]};delete result.groups[1].editKey;result.groups[1].key=raw('Visible but not writable');
  assert.equal(f.actions.canMove(f.result),false);
  await assert.rejects(f.actions.requestMove({version:7,path:'One.md',property:'projects',source:f.source,destination:raw('x'),sourceKeyId:'source',destinationKeyId:'destination'}),/no writable saved value/);
  assert.throws(()=>f.actions.creationGroup({version:7,property:'projects',group:raw('x'),groupKeyId:'destination'}),/no writable saved value/);assert.deepEqual(f.moves,[]);
});

test('stale version, changed grouping, or missing opaque destination cannot initialize New', ()=>{
  const f=fixture();
  assert.throws(()=>f.actions.creationGroup({version:6,property:'projects',group:f.destination,groupKeyId:'destination'}),/stale/);
  assert.throws(()=>f.actions.creationGroup({version:7,property:'other',group:f.destination,groupKeyId:'destination'}),/grouping property changed/);
  assert.throws(()=>f.actions.creationGroup({version:7,property:'projects',group:f.destination,groupKeyId:'gone'}),/group changed/);
  assert.throws(()=>baseGroupWriteValue({key:raw('Shown'),editKey:link('Shown')},true),/Cannot persist/);
  assert.equal(baseGroupWriteValue({key:raw('Legacy')},false),'Legacy');
  assert.equal(baseGroupWriteValue({key:{type:'null'},editKey:{type:'null'}},true),null);
});


test('New in the empty group skips assignment while existing-card moves still clear its property',async()=>{
 const f=fixture();const group=f.result.groups[1] as unknown as {key:BaseExpressionValue;editKey:BaseExpressionValue};group.key={type:'null'};group.editKey={type:'null'};
 assert.equal(f.actions.creationGroup({version:7,property:'projects',group:{type:'null'},groupKeyId:'destination'}),undefined);
 await f.actions.requestMove({version:7,path:'One.md',property:'projects',source:f.source,destination:{type:'null'},sourceKeyId:'source',destinationKeyId:'destination'});
 assert.deepEqual(f.moves,[{version:7,path:'One.md',value:null}]);
});
