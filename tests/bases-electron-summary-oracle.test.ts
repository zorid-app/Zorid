import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScopedGroupSummaries } from './bases-electron-integration/summary-oracle.mjs';

function fixture() {
  return [
    {scope:'3',label:'Empty',count:1,display:'',paths:['Missing properties.md'],visibleAlerts:[]},
    ...[['Finished',3,'71'],['Reading',2,'72'],['To read',1,'73']].map(([label,first,display],index)=>({
      scope:String(index),label,count:24,display,paths:Array.from({length:24},(_,row)=>`Book ${String(Number(first)+row*3).padStart(3,'0')}.md`),visibleAlerts:[],
    })),
  ];
}

test('group summary receipt distinguishes blank Null from numeric zero',()=>{
  const groups=fixture(),receipt=assertScopedGroupSummaries(groups);
  assert.equal(receipt.groups[0].display,'');assert.equal(receipt.groups[0].valueKind,'null');
  groups[0].display='0';assert.throws(()=>assertScopedGroupSummaries(groups),/Blank Null/);
});

test('equal group counts cannot conceal summary values attached to the wrong rows',()=>{
  const groups=fixture();[groups[1].paths[0],groups[2].paths[0]]=[groups[2].paths[0],groups[1].paths[0]];
  assert.throws(()=>assertScopedGroupSummaries(groups),/exact fixture paths/);
});

test('a visible diagnostic cannot satisfy a blank summary oracle',()=>{
  const groups=fixture();groups[0].visibleAlerts.push('Summary unavailable');
  assert.throws(()=>assertScopedGroupSummaries(groups),/no visible diagnostic/);
});
