import test from 'node:test';
import assert from 'node:assert/strict';
import {mountedRename,nestedRename,fencedRename,mountedRenameFixtures,nestedRenamedExternal,assertMountedRenameRetention,assertLogicalCellSelection} from './mounted-rename-contract.mjs';

test('C2 byte oracles change only exact view-name fields/fragments and keep unrelated note links',()=>{
  assert.equal(mountedRename.afterBase,mountedRename.beforeBase.replace('name: Mounted old','name: Mounted renamed'));
  assert.equal(mountedRename.afterHost,mountedRename.beforeHost.replaceAll('#Mounted old','#Mounted renamed'));
  assert.ok(mountedRename.afterHost.includes('#Other]]'));
  assert.equal(nestedRename.afterBase,nestedRename.beforeBase.replace('name: Nested old','name: Nested renamed'));
  assert.equal(nestedRename.cleanAfter,nestedRename.cleanBefore.replace('#Nested old','#Nested renamed'));
  const external=nestedRename.beforeChild+'\nExternal authority marker\n',renamed=nestedRenamedExternal(external);
  assert.equal(renamed,nestedRename.beforeChild.replace('#Nested old|','#Nested renamed|').replace('#Nested%20old)','#Nested%20renamed)')+'\nExternal authority marker\n');
  assert.equal(fencedRename.afterHost,fencedRename.beforeHost.replace('name: Fence old','name: Fence renamed'));
  assert.ok(fencedRename.sentinelSource.includes('#Fence old|')&&fencedRename.sentinelSource.includes('#Fence%20old)'));
  assert.equal(mountedRenameFixtures().size,8);
});
test('C2 in-place oracle rejects recreated sessions, wrong bindings, lost drafts and changed selections',()=>{
  const before={rootId:2,sessionId:3,connected:true,inEmbed:true,binding:'C2 Mounted.base — Mounted old',gridName:'Mounted old',selected:{path:'A.md',property:'note.score'},input:{id:8,connected:true,value:mountedRename.draft,start:0,end:3,direction:'forward'}};
  const good={...structuredClone(before),binding:'C2 Mounted.base — Mounted renamed'};
  assertMountedRenameRetention(before,good,{base:mountedRename.base,name:mountedRename.to,draft:true});
  for(const change of [row=>row.rootId++,row=>row.sessionId++,row=>row.connected=false,row=>row.inEmbed=false,row=>row.binding='wrong',row=>row.selected.property='file.name',row=>row.input.id++,row=>row.input.connected=false,row=>row.input.value='saved or lost',row=>row.input.end=0]){
    const broken=structuredClone(good);change(broken);assert.throws(()=>assertMountedRenameRetention(before,broken,{base:mountedRename.base,name:mountedRename.to,draft:true}));
  }
});

test('C2 clean fenced remount must preserve a populated logical row/property selection',()=>{
  const before={rootId:1,sessionId:2,selected:{path:'A.md',property:'note.score'}},remounted={rootId:3,sessionId:4,selected:{path:'A.md',property:'note.score'}};
  assertLogicalCellSelection(before,remounted);
  for(const selected of [null,{path:'A.md',property:'file.name'},{path:'B.md',property:'note.score'}])assert.throws(()=>assertLogicalCellSelection(before,{...remounted,selected}));
  assert.throws(()=>assertLogicalCellSelection({selected:null},remounted));
});
