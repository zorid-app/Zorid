import assert from 'node:assert/strict';
import path from 'node:path';

const relaySources=['control.mjs','protocol.mjs','relay.mjs'];
export function assertRelayCampaign(campaignPath,testsRoot){
  assert.ok(path.isAbsolute(testsRoot));
  assert.ok(['bases-electron-recovery-integration','bases-electron-safety-integration'].some(name=>campaignPath===path.join(testsRoot,name,'campaign.mjs')),'Only the approved recovery and safety campaigns may select the test relay');
}
export function assertRelayProvenance(files,{testsRoot,wrapper}){
  assert.ok(path.isAbsolute(testsRoot)&&path.isAbsolute(wrapper));
  const expected=[wrapper,...relaySources.map(name=>path.join(testsRoot,'bases-electron-recovery-integration',name))];
  assert.deepEqual([...files].sort(),expected.sort(),'Relay provenance must be exactly the owned wrapper and the three shared recovery sources');
}
