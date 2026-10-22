import test from 'node:test';
import assert from 'node:assert/strict';
import {mountedRename,nestedRename,fencedRename,mountedRenameFixtures,nestedRenamedExternal,assertMountedRenameRetention,assertLogicalCellSelection,hoverPublication,newPublication,publicationFixtures,assertInlinePublicationFrame} from './mounted-rename-contract.mjs';

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


test('C2 hover/New inert templates preserve literal whole-note source except the exact view name',()=>{
  const files=publicationFixtures();assert.equal(files.size,5);
  for(const value of [hoverPublication,newPublication]){
    assert.equal(value.after,value.before.replace('name: '+value.from,'name: '+value.to));
    assert.ok(value.before.includes('{{title}}')&&value.after.includes('{{date}}'));
  }
  assert.equal(files.get(hoverPublication.file),hoverPublication.before);
  assert.equal(files.get(newPublication.template),newPublication.before);
  assert.ok(files.get(newPublication.launcher).includes('newItemTemplate: '+newPublication.template));
  for(const file of mountedRenameFixtures().keys())assert.ok(!files.has(file),'New named inputs never replace earlier C2 inputs');
});
test('C2 failed inline source cannot publish, remount, transfer host or unblock properties',()=>{
  const before={hostId:9,hostConnected:true,nodeInHost:true,rootId:2,sessionId:3,connected:true,inEmbed:true,binding:hoverPublication.file,gridName:hoverPublication.from,selected:{path:'A.md',property:'note.score'},propertyBlocked:false},failed={...structuredClone(before),propertyBlocked:true};
  const options={file:hoverPublication.file,name:hoverPublication.from,failed:true};assertInlinePublicationFrame(before,failed,options);
  for(const change of [v=>v.hostId++,v=>v.hostConnected=false,v=>v.nodeInHost=false,v=>v.rootId++,v=>v.sessionId++,v=>v.connected=false,v=>v.inEmbed=false,v=>v.binding=newPublication.template,v=>v.gridName=hoverPublication.to,v=>v.selected=null,v=>v.selected.property='file.name',v=>v.propertyBlocked=false]){
    const broken=structuredClone(failed);change(broken);assert.throws(()=>assertInlinePublicationFrame(before,broken,options));
  }
  const acknowledged={...structuredClone(before),rootId:20,sessionId:30,gridName:hoverPublication.to};
  assertInlinePublicationFrame(before,acknowledged,{file:hoverPublication.file,name:hoverPublication.to});
  assert.throws(()=>assertInlinePublicationFrame(before,{...acknowledged,hostId:10},{file:hoverPublication.file,name:hoverPublication.to}));
});
