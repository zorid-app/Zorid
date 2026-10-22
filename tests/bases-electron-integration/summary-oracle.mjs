import assert from 'node:assert/strict';

// Independent fixture oracle, not the production grouping or expression code.
const expected = [
  {label:'Empty',count:1,display:'',valueKind:'null',paths:['Missing properties.md']},
  ...[['Finished',3,'71'],['Reading',2,'72'],['To read',1,'73']].map(([label,first,display])=>({
    label,count:24,display,valueKind:'number',paths:Array.from({length:24},(_,index)=>`Book ${String(first+index*3).padStart(3,'0')}.md`),
  })),
];

export function assertScopedGroupSummaries(observed) {
  assert.equal(observed.length,4,'Four distinct group scopes must be observed across virtualized rows');
  assert.equal(new Set(observed.map(group=>group.scope)).size,4,'Each summary belongs to one distinct group scope');
  assert.deepEqual(observed.map(group=>group.display).sort(),['','71','72','73'],'Blank Null is distinct from numeric zero');
  const groups=expected.map(oracle=>{
    const matches=observed.filter(group=>group.label===oracle.label);
    assert.equal(matches.length,1,`Exactly one ${oracle.label} group`);
    const group=matches[0];
    assert.equal(group.count,oracle.count,`${oracle.label} has the expected row count`);
    assert.equal(group.display,oracle.display,`${oracle.label} summary uses only that group's values`);
    assert.deepEqual([...group.paths].sort(),[...oracle.paths].sort(),`${oracle.label} contains its exact fixture paths`);
    assert.deepEqual(group.visibleAlerts,[],`${oracle.label} has no visible diagnostic`);
    return {scope:group.scope,label:group.label,count:group.count,display:group.display,valueKind:oracle.valueKind,paths:[...group.paths].sort()};
  });
  return {name:'group-custom-summary-scope',groups,overall:214};
}
