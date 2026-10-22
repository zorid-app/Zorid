import test from 'node:test';
import assert from 'node:assert/strict';
import {relayProcessOwnership,livingOwnedProcesses,discoverUnannouncedRelayProcesses} from './native-ownership.mjs';
const input={native:'/owned/host',vault:'/owned/vault',identity:{executable:'/owned/node',args:['/owned/relay.mjs','--relay-native','/owned/host','--relay-directory','/owned/control','--']},appPid:10,events:[{kind:'started',relayPid:11,nativePid:12,native:'/owned/host',args:['--vault','/owned/vault','--initialize-local']}]};
test('records exact relay and genuine-host identities and keeps reparented descendants visible',()=>{
  const relay='/owned/node /owned/relay.mjs --relay-native /owned/host --relay-directory /owned/control -- --vault /owned/vault --initialize-local',native='/owned/host --vault /owned/vault --initialize-local';
  const owned=relayProcessOwnership({...input,rows:[{pid:11,parent:10,command:relay},{pid:12,parent:11,command:native}]});
  assert.deepEqual(owned.map(p=>p.kind),['relay','genuine-native']);
  assert.equal(livingOwnedProcesses(owned,[{pid:12,parent:1,command:native}]).length,1);
  assert.equal(livingOwnedProcesses(owned,[{pid:12,parent:1,command:'/unrelated/host'}]).length,0);
});
test('rejects substituted host, wrong vault, duplicate events and command mismatches',()=>{
  assert.throws(()=>relayProcessOwnership({...input,events:[{...input.events[0],native:'/other/host'}],rows:[]}));
  assert.throws(()=>relayProcessOwnership({...input,events:[{...input.events[0],args:['--vault','/other/vault']}],rows:[]}));
  assert.throws(()=>relayProcessOwnership({...input,events:[...input.events,...input.events],rows:[]}));
  assert.throws(()=>relayProcessOwnership({...input,rows:[{pid:12,parent:1,command:'/other/host --vault /owned/vault'}]}));
  assert.throws(()=>relayProcessOwnership({...input,rows:[],requireLineage:true}));
});
test('no-event startup cleanup discovers exact reparented relay/native rows and excludes prefix collisions',()=>{
  const args=['--vault',input.vault,'--initialize-local'];
  const relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const rows=[{pid:11,parent:1,command:relay},{pid:12,parent:1,command:native},{pid:13,parent:1,command:native+' --other'},{pid:14,parent:1,command:native.replace('/owned/vault','/owned/vault-other')},{pid:15,parent:1,command:relay.replace('/owned/control','/other/control')}];
  const owned=discoverUnannouncedRelayProcesses({...input,rows});assert.deepEqual(owned.map(row=>[row.pid,row.kind]),[[11,'relay'],[12,'genuine-native']]);
  assert.equal(livingOwnedProcesses(owned,rows).length,2);
  assert.deepEqual(discoverUnannouncedRelayProcesses({...input,rows:[rows[1]]}).map(row=>row.pid),[12],'Real native is still found after relay already exited');
});
