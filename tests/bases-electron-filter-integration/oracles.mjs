import assert from 'node:assert/strict';
import {records,initialConfiguration} from './fixtures.mjs';

export function expectedPaths(ids){
  assert.equal(new Set(ids).size,ids.length,'Authored membership cannot duplicate a row');
  for(const id of ids)assert.ok(records.some(record=>record.id===id),'Known independently authored record');
  return records.filter(record=>ids.includes(record.id)).map(record=>record.path);
}
export function assertMembership(actual,ids){
  const expected=expectedPaths(ids);assert.deepEqual(actual,expected,'Exact independently authored ordered membership');return expected;
}
export function expectedConfiguration(expression){
  const expected=structuredClone(initialConfiguration);
  if(expression!==undefined)expected.views[0].filters={and:[expression]};
  return expected;
}
export function assertConfiguration(yaml,source,expression){
  assert.match(source,/^# Typed filter acceptance: retain this comment and unknown fields\.$/m);
  assert.deepEqual(yaml.parse(source),expectedConfiguration(expression),'Whole independently expected Base configuration');
}
