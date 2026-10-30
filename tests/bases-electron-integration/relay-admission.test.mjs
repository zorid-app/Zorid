import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRelayCampaign,assertRelayProvenance} from './relay-admission.mjs';
const testsRoot='/owned/tests',wrapper='/owned/evidence/native-relay/native-relay';
const files=[wrapper,...['control.mjs','protocol.mjs','relay.mjs'].map(name=>testsRoot+'/bases-electron-recovery-integration/'+name)];
test('relay admission preserves the exact legacy recovery, safety and layouts campaigns',()=>{
  for(const name of ['recovery','safety','layouts'])assert.doesNotThrow(()=>assertRelayCampaign(testsRoot+'/bases-electron-'+name+'-integration/campaign.mjs',testsRoot));
  for(const candidate of [undefined,testsRoot+'/bases-electron-properties-integration/campaign.mjs',testsRoot+'/bases-electron-safety-integration/other.mjs',testsRoot+'/bases-electron-safety-integration/../bases-electron-safety-integration/campaign.mjs','/elsewhere/tests/bases-electron-safety-integration/campaign.mjs'])assert.throws(()=>assertRelayCampaign(candidate,testsRoot));
});
test('relay provenance requires every exact shared source and rejects broad directory admission',()=>{
  assert.doesNotThrow(()=>assertRelayProvenance(files,{testsRoot,wrapper}));
  for(const wrong of [files.slice(1),files.slice(0,-1),[...files,testsRoot+'/bases-electron-safety-integration/campaign.mjs'],files.map(file=>file.endsWith('/relay.mjs')?testsRoot+'/bases-electron-recovery-integration/extra.mjs':file),[...files,files[1]]])assert.throws(()=>assertRelayProvenance(wrong,{testsRoot,wrapper}));
});

test('automatic-recovery relay admission requires its exact campaign path and keeps shared provenance sealed',()=>{
  const name='bases-electron-auto-recovery-integration',campaign=testsRoot+'/'+name+'/campaign.mjs';assert.doesNotThrow(()=>assertRelayCampaign(campaign,testsRoot));
  for(const candidate of [testsRoot+'/'+name+'s/campaign.mjs',testsRoot+'/'+name+'-extra/campaign.mjs',testsRoot+'/'+name+'/other.mjs',testsRoot+'/'+name+'/campaign.mjs/',testsRoot+'/'+name+'/child/../campaign.mjs',testsRoot+'/'+name+'/../'+name+'/campaign.mjs','/elsewhere/tests/'+name+'/campaign.mjs',testsRoot+'/bases-electron-config-integration/campaign.mjs'])assert.throws(()=>assertRelayCampaign(candidate,testsRoot),candidate);
  assert.doesNotThrow(()=>assertRelayProvenance(files,{testsRoot,wrapper}));
  assert.throws(()=>assertRelayProvenance([...files,campaign],{testsRoot,wrapper}),'caller admission never adds its campaign to shared relay provenance');
  assert.throws(()=>assertRelayProvenance(files.map(file=>file.endsWith('/relay.mjs')?testsRoot+'/'+name+'/relay.mjs':file),{testsRoot,wrapper}),'caller admission cannot replace a shared recovery relay source');
});
