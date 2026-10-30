import test from 'node:test';
import assert from 'node:assert/strict';
import {relayProcessOwnership,livingOwnedProcesses,discoverUnannouncedRelayProcesses,parseProcessRows} from './native-ownership.mjs';
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
test('authenticated exited-not-reaped relay is observed without being a living signal target',()=>{
  const args=input.events[0].args;
  const relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const launched=relayProcessOwnership({...input,requireLineage:true,rows:[{pid:11,parent:10,state:'S',command:relay},{pid:12,parent:11,state:'S',command:native}]});
  const rows=[{pid:11,parent:1,state:'Z',command:'(node)'}];
  const observed=relayProcessOwnership({...input,rows,previouslyOwned:launched});
  assert.deepEqual(livingOwnedProcesses(observed,rows),[],'A zombie must never enter the cleanup signal targets');
  assert.deepEqual(observed[0].exitedNotReaped,{state:'Z',parent:1,command:'(node)'});
  assert.equal(observed[0].authenticatedAtLaunch,true);
  assert.equal(observed[0].exitCode,undefined,'Observation is not evidence of a normal Native exit');
  assert.equal(observed[0].signal,undefined);
  const repeated=relayProcessOwnership({...input,rows,previouslyOwned:observed});
  assert.deepEqual(repeated,observed,'Repeated cleanup observations retain the exact authenticated identity');
  assert.deepEqual(livingOwnedProcesses(repeated,rows),[]);
  const absent=relayProcessOwnership({...input,rows:[],previouslyOwned:repeated});
  assert.deepEqual(absent[0].exitedNotReaped,observed[0].exitedNotReaped,'Later absence preserves the observation without inventing a normal exit');
  assert.deepEqual(livingOwnedProcesses(absent,[]),[]);
});
test('zombie exemption requires the exact launch-authenticated identity, never discovery alone',()=>{
  const args=input.events[0].args,relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const live=[{pid:11,parent:10,state:'S',command:relay},{pid:12,parent:11,state:'S',command:native}];
  const launched=relayProcessOwnership({...input,rows:live,requireLineage:true});
  const rows=[{pid:11,parent:1,state:'Z+',command:'(node)'}];
  const discovered=discoverUnannouncedRelayProcesses({...input,rows:live});
  assert.ok(discovered.every(row=>row.authenticatedAtLaunch===undefined));
  for(const previouslyOwned of [[],discovered,launched.map(row=>({...row,authenticatedAtLaunch:false})),launched.map(row=>({...row,pid:row.pid+100})),launched.map(row=>({...row,command:row.command+' changed'})),launched.map(row=>({...row,kind:'other'})),launched.map(row=>({...row,parent:999}))]){
    assert.throws(()=>relayProcessOwnership({...input,rows,previouslyOwned}),/exact prior launch authentication/);
  }
  assert.throws(()=>relayProcessOwnership({...input,rows,previouslyOwned:launched,requireLineage:true}),/live at launch/);
  assert.throws(()=>relayProcessOwnership({...input,rows:[{...rows[0],state:undefined}],previouslyOwned:launched}),/Exact owned process command/,'Missing state cannot authorize a command mismatch');
});
test('prior authentication never permits a changed live command or wrong launch lineage',()=>{
  const args=input.events[0].args,relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const rows=[{pid:11,parent:10,state:'S',command:relay},{pid:12,parent:11,state:'S',command:native}];
  const launched=relayProcessOwnership({...input,rows,requireLineage:true});
  assert.throws(()=>relayProcessOwnership({...input,rows:[{...rows[0],parent:1,command:'/unrelated/node'}],previouslyOwned:launched}),/Exact owned process command/);
  assert.throws(()=>relayProcessOwnership({...input,rows:rows.map(row=>({...row,parent:1})),previouslyOwned:launched,requireLineage:true}),/Actual app/);
  const reparented=relayProcessOwnership({...input,rows:rows.map(row=>({...row,parent:1})),previouslyOwned:launched});
  assert.ok(reparented.every(row=>row.authenticatedAtLaunch===true));
  assert.equal(livingOwnedProcesses(reparented,rows).length,2);
});
test('zombies cannot be discovered or signaled even when ps retains the original command',()=>{
  const args=input.events[0].args,relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const rows=[{pid:11,parent:10,state:'Z',command:relay},{pid:12,parent:11,state:'Z+',command:native}];
  assert.deepEqual(discoverUnannouncedRelayProcesses({...input,rows}),[]);
  assert.deepEqual(livingOwnedProcesses(rows,rows),[]);
});
test('ps parser preserves state and exact spaced commands, rejecting malformed rows',()=>{
  assert.deepEqual(parseProcessRows('  0 0 Ss /kernel task\n 11 10 S+ /owned/node --arg with spaces\n 12 1 Z+ (host)\n'),[
    {pid:0,parent:0,state:'Ss',command:'/kernel task'},
    {pid:11,parent:10,state:'S+',command:'/owned/node --arg with spaces'},
    {pid:12,parent:1,state:'Z+',command:'(host)'},
  ]);
  for(const malformed of ['11 10','9007199254740992 1 Z (node)','unparseable'])assert.throws(()=>parseProcessRows(malformed));
});

test('ps parser retains empty commands and unfamiliar states without authorizing owned processes',()=>{
  const rows=parseProcessRows('  11 10 S   \n 12 11 ?state /unrelated/process\n 13 1 ?\n');
  assert.deepEqual(rows,[
    {pid:11,parent:10,state:'S',command:''},
    {pid:12,parent:11,state:'?state',command:'/unrelated/process'},
    {pid:13,parent:1,state:'?',command:''},
  ]);
  assert.throws(()=>relayProcessOwnership({...input,rows}),/Exact owned process command/);
  assert.deepEqual(discoverUnannouncedRelayProcesses({...input,rows}),[]);
});
