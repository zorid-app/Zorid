import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedBaseValueProjector } from '../src/bases/shared-values.ts';

test('one shared value projector retains inert namespace identity across maps and frozen nested values',()=>{
 const link=Object.freeze({type:'link' as const,path:'People/Ada.md',display:'Original alias',target:Object.freeze({entryId:'ada',revision:'r3'}),external:false});
 const project=createSharedBaseValueProjector('UTC'),first=project(link),nested=project(Object.freeze({type:'list',value:Object.freeze([link])}));
 assert.equal(first.type,'namespace');assert.equal(first.name,'Original alias');assert.equal(nested.type,'list');assert.equal(nested.value[0],first);assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(nested.value));assert.deepEqual(first.presentation.target,{entryId:'ada',revision:'r3'});
});
test('the original shared node budget spans separate maps and externally accounted order keys',()=>{
 const budget={remaining:3},project=createSharedBaseValueProjector('UTC',budget);project({type:'string',value:'First map'});budget.remaining--;project({type:'null'});assert.equal(budget.remaining,0);assert.throws(()=>project({type:'string',value:'Another map'}),/too large/);
});
test('projection preserves captured date timezone and core diagnostic codes without evaluation',()=>{
 const project=createSharedBaseValueProjector('Asia/Tokyo'),date=project({type:'date',timestamp:0,hasTime:false}),error=project({type:'error',code:'unavailable',message:'Core graph unavailable'});
 assert.deepEqual(date,{type:'date',timestamp:0,hasTime:false,presentationTimezone:'Asia/Tokyo'});assert.equal(error.type,'error');assert.equal(error.error.code,'unavailable');assert.equal(error.error.message,'Core graph unavailable');assert.ok(Object.isFrozen(error.error));
});
test('link projection retains only explicit core subpaths and never parses a filename',()=>{
 const project=createSharedBaseValueProjector(),target={entryId:'ada',revision:'r1'};
 const headed=project({type:'link',path:'Ada#^block',subpath:'#^block',target,display:null,external:false});
 assert.equal(headed.type,'namespace');if(headed.type!=='namespace')return;assert.equal(headed.presentation?.subpath,'#^block');
 const literal=project({type:'link',path:'People/A#B.md',target,display:null,external:false});
 assert.equal(literal.type,'namespace');if(literal.type!=='namespace')return;assert.equal(literal.presentation?.subpath,undefined);
 assert.throws(()=>project({type:'link',path:'Ada',subpath:'untrusted',target,display:null,external:false}),/subpath is invalid/);
});
