import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRelayCampaign,assertRelayProvenance} from './relay-admission.mjs';
const testsRoot='/owned/tests',wrapper='/owned/evidence/native-relay/native-relay';
const files=[wrapper,...['control.mjs','protocol.mjs','relay.mjs'].map(name=>testsRoot+'/bases-electron-recovery-integration/'+name)];
test('relay admission preserves recovery and admits only the exact safety campaign',()=>{
  for(const name of ['recovery','safety'])assert.doesNotThrow(()=>assertRelayCampaign(testsRoot+'/bases-electron-'+name+'-integration/campaign.mjs',testsRoot));
  for(const candidate of [undefined,testsRoot+'/bases-electron-layouts-integration/campaign.mjs',testsRoot+'/bases-electron-safety-integration/other.mjs',testsRoot+'/bases-electron-safety-integration/../bases-electron-safety-integration/campaign.mjs','/elsewhere/tests/bases-electron-safety-integration/campaign.mjs'])assert.throws(()=>assertRelayCampaign(candidate,testsRoot));
});
test('relay provenance requires every exact shared source and rejects broad directory admission',()=>{
  assert.doesNotThrow(()=>assertRelayProvenance(files,{testsRoot,wrapper}));
  for(const wrong of [files.slice(1),files.slice(0,-1),[...files,testsRoot+'/bases-electron-safety-integration/campaign.mjs'],files.map(file=>file.endsWith('/relay.mjs')?testsRoot+'/bases-electron-recovery-integration/extra.mjs':file),[...files,files[1]]])assert.throws(()=>assertRelayProvenance(wrong,{testsRoot,wrapper}));
});
