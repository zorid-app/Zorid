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

test('selects the exact replacement generation from two relay starts',()=>{
  const generation='22222222-2222-4222-8222-222222222222';
  const replacement={...input.events[0],generation,relayPid:21,nativePid:22};
  const events=[{...input.events[0],generation:'11111111-1111-4111-8111-111111111111'},replacement];
  const rows=[{pid:21,parent:10,state:'S',command:'/owned/node /owned/relay.mjs --relay-native /owned/host --relay-directory /owned/control -- --vault /owned/vault --initialize-local'},
    {pid:22,parent:21,state:'S',command:'/owned/host --vault /owned/vault --initialize-local'}];
  const current=relayProcessOwnership({...input,events,rows,generation,requireLineage:true});
  assert.deepEqual(current.map(row=>row.pid),[21,22]);
  assert.ok(current.every(row=>row.authenticatedAtLaunch===true));
});

import * as ownership from './native-ownership.mjs';
const appCommand='/owned/electron /owned/main.cjs --user-data-dir=/owned/profile';
const firstGeneration='11111111-1111-4111-8111-111111111111',nextGeneration='22222222-2222-4222-8222-222222222222';
const startGeneration=(generation,relayPid,nativePid)=>({...input.events[0],generation,relayPid,nativePid});
const generationRows=(relayPid,nativePid,appPid=10)=>[
  {pid:appPid,parent:1,state:'S',command:appCommand},
  {pid:relayPid,parent:appPid,state:'S',command:'/owned/node /owned/relay.mjs --relay-native /owned/host --relay-directory /owned/control -- --vault /owned/vault --initialize-local'},
  {pid:nativePid,parent:relayPid,state:'S',command:'/owned/host --vault /owned/vault --initialize-local'},
];
test('generation registry authenticates each same-app replacement and retains original launch evidence',()=>{
  const registry=ownership.createNativeGenerationRegistry({...input,appCommand});
  const first=startGeneration(firstGeneration,11,12),next=startGeneration(nextGeneration,21,22);
  const initial=registry.observe({events:[first],rows:generationRows(11,12),appPid:10});
  assert.equal(initial.current.generation,firstGeneration);
  assert.equal(initial.current.authenticatedAtLaunch,true);
  const events=[first,{...first,kind:'closed',exitCode:0,signal:null},next];
  const replacement=registry.observe({events,rows:generationRows(21,22),appPid:10});
  assert.equal(replacement.current.generation,nextGeneration);
  assert.deepEqual(replacement.generations.map(row=>[row.generation,row.appPid,row.relayPid,row.nativePid]),[[firstGeneration,10,11,12],[nextGeneration,10,21,22]]);
  assert.deepEqual(replacement.generations[0].closeObservations,[{kind:'closed',exitCode:0,signal:null}]);
  initial.current.processes[0].command='caller mutation';
  assert.equal(registry.observe({events,rows:generationRows(21,22),appPid:10}).generations[0].expectedCommands.relay,'/owned/node /owned/relay.mjs --relay-native /owned/host --relay-directory /owned/control -- --vault /owned/vault --initialize-local');
});
test('intentional fault targets only freshly authenticated current Native and records exact SIGKILL evidence',()=>{
  const registry=ownership.createNativeGenerationRegistry({...input,appCommand}),first=startGeneration(firstGeneration,11,12);
  const observation={events:[first],rows:generationRows(11,12),appPid:10};
  registry.observe(observation);const signals=[];
  const kill=(...args)=>signals.push(args);
  assert.throws(()=>registry.killCurrent(firstGeneration,{...observation,rows:generationRows(11,12).map(row=>row.pid===12?{...row,command:'/wrong/native'}:row),kill}),/Exact owned process command/);
  assert.deepEqual(signals,[]);
  assert.throws(()=>registry.killCurrent(nextGeneration,{...observation,kill}),/current generation/);
  const fault=registry.killCurrent(firstGeneration,{...observation,kill,at:123});
  assert.deepEqual(signals,[[12,'SIGKILL']]);
  assert.deepEqual(fault,{generation:firstGeneration,appPid:10,relayPid:11,nativePid:12,signal:'SIGKILL',at:123});
  assert.throws(()=>registry.killCurrent(firstGeneration,{...observation,kill}),/already has an intentional fault/);
  assert.deepEqual(signals,[[12,'SIGKILL']]);
  assert.deepEqual(registry.observe({...observation,rows:[]}).generations[0].intentionalFault,fault);
});
test('shutdown requires every normal Native close and keeps exact intentional faults abnormal',()=>{
  const registry=ownership.createNativeGenerationRegistry({...input,appCommand}),first=startGeneration(firstGeneration,11,12),next=startGeneration(nextGeneration,21,22);
  const initial={events:[first],rows:generationRows(11,12),appPid:10};
  registry.observe(initial);
  const absent=ownership.createNativeGenerationRegistry({...input,appCommand});absent.observe(initial);
  assert.throws(()=>absent.assertShutdown({...initial,rows:[]}),/Explicit normal Native closed/,'Absence never invents a successful close');
  registry.killCurrent(firstGeneration,{...initial,kill:()=>{},at:123});
  const events=[first,{...first,kind:'held-child-closed',exitCode:null,signal:'SIGKILL',at:124,withheldResponseSha256:'a'.repeat(64)},{...first,kind:'closed',exitCode:null,signal:'SIGKILL',at:125,nativeTerminatedDuringHold:true},next];
  registry.observe({events,rows:generationRows(21,22),appPid:10});
  assert.throws(()=>registry.assertShutdown({events,rows:[],appPid:10}),/Explicit normal Native closed/,'Replacement absence is insufficient');
  const closed=[...events,{...next,kind:'closed',exitCode:0,signal:null}];
  const result=registry.assertShutdown({events:closed,rows:[],appPid:10});
  assert.deepEqual(result.map(value=>[value.generation,value.kind]),[[firstGeneration,'intentional-native-sigkill'],[nextGeneration,'normal-native-close']]);
  assert.throws(()=>registry.assertShutdown({events:closed,rows:[generationRows(21,22)[2]],appPid:10}),/terminal process ID|No living owned generation/);
  assert.throws(()=>registry.assertShutdown({events:closed.map(event=>event.generation===nextGeneration&&event.kind==='closed'?{...event,exitCode:null,signal:'SIGTERM'}:event),rows:[],appPid:10}),/Append-only relay event history|Explicit normal Native closed/);
});
test('generation evidence rejects unauthenticated discovery, ambiguity, identity changes and event substitution',()=>{
  const first=startGeneration(firstGeneration,11,12),next=startGeneration(nextGeneration,21,22),rows=generationRows(11,12);
  const make=()=>ownership.createNativeGenerationRegistry({...input,appCommand});
  assert.deepEqual(make().observe({events:[],rows,appPid:10}),{current:null,generations:[]},'Rows without a started event cannot mint generation authority');
  for(const events of [[{...first,generation:'not-a-uuid'}],[first,first],[{...first,native:'/wrong/native'}],[{...first,args:['--vault','/wrong/vault']}],[{...first,args:['--vault',input.vault,'--unexpected']}],[first,{...first,kind:'closed',nativePid:99,exitCode:0,signal:null}]])assert.throws(()=>make().observe({events,rows,appPid:10}));
  for(const invalidRows of [rows.slice(0,2),rows.map(row=>row.pid===11?{...row,parent:99}:row),rows.map(row=>row.pid===12?{...row,command:'/other/native'}:row),rows.map(row=>row.pid===10?{...row,command:'/other/app'}:row)])assert.throws(()=>make().observe({events:[first],rows:invalidRows,appPid:10}));
  const registry=make();registry.observe({events:[first],rows,appPid:10});
  assert.throws(()=>registry.observe({events:[first,{...next,nativePid:12}],rows:generationRows(21,12),appPid:10}),/No process ID reuse/);
  assert.throws(()=>registry.observe({events:[first,next],rows:[...rows,...generationRows(21,22).slice(1)],appPid:10}),/Unambiguous current/);
  assert.equal(registry.observe({events:[first],rows,appPid:10}).generations.length,1,'Rejected discovery is transactional');
  assert.throws(()=>registry.observe({events:[first],rows:rows.map(row=>row.pid===12?{...row,command:''}:row),appPid:10}),/Exact owned process command/);
  const zombie=registry.observe({events:[first],rows:[{pid:11,parent:1,state:'Z',command:''}],appPid:10});
  assert.equal(zombie.current,null);assert.equal(zombie.generations[0].presence.relay,'exited-not-reaped');
  assert.throws(()=>make().observe({events:[first],rows:[{pid:11,parent:1,state:'Z',command:''}],appPid:10}),/Original owned app is live/);
});

test('terminal PIDs and append-only event evidence cannot be resurrected or rewritten',()=>{
  const first=startGeneration(firstGeneration,11,12),rows=generationRows(11,12);
  for(const terminalRows of [[],[{pid:12,parent:1,state:'Z',command:''}]]){
    const registry=ownership.createNativeGenerationRegistry({...input,appCommand}),signals=[];
    registry.observe({events:[first],rows,appPid:10});registry.observe({events:[first],rows:terminalRows,appPid:10});
    assert.throws(()=>registry.killCurrent(firstGeneration,{events:[first],rows,appPid:10,kill:(...args)=>signals.push(args)}),/terminal process ID/);
    assert.deepEqual(signals,[]);
  }
  const registry=ownership.createNativeGenerationRegistry({...input,appCommand});registry.observe({events:[first],rows,appPid:10});
  const abnormal={...first,kind:'closed',exitCode:null,signal:'SIGKILL',at:100};
  registry.observe({events:[first,abnormal],rows:[],appPid:10});
  for(const events of [[first],[first,{...abnormal,exitCode:0,signal:null}]])assert.throws(()=>registry.observe({events,rows:[],appPid:10}),/Append-only relay event history/);
});
test('intentional shutdown needs both real close events after its fault with sealed-response evidence',()=>{
  const first=startGeneration(firstGeneration,11,12),initial={events:[first],rows:generationRows(11,12),appPid:10};
  const held={...first,kind:'held-child-closed',exitCode:null,signal:'SIGKILL',at:124,withheldResponseSha256:'b'.repeat(64)};
  const closed={...first,kind:'closed',exitCode:null,signal:'SIGKILL',at:125,nativeTerminatedDuringHold:true};
  for(const tail of [[],[held],[closed],[{...held,at:122},closed],[{...held,withheldResponseSha256:undefined},closed],[held,{...closed,nativeTerminatedDuringHold:undefined}]]){
    const registry=ownership.createNativeGenerationRegistry({...input,appCommand});registry.observe(initial);
    registry.killCurrent(firstGeneration,{...initial,kill:()=>{},at:123});
    assert.throws(()=>registry.assertShutdown({events:[first,...tail],rows:[],appPid:10}),/Real held Native close|Real final Native close|after the intentional fault|Sealed response digest|terminated during hold/);
  }
});
test('normal shutdown rejects contradictory close outcomes and current requires live original lineage',()=>{
  const first=startGeneration(firstGeneration,11,12),rows=generationRows(11,12);
  const registry=ownership.createNativeGenerationRegistry({...input,appCommand});registry.observe({events:[first],rows,appPid:10});
  assert.throws(()=>registry.assertShutdown({events:[first,{...first,kind:'drop-child-closed',exitCode:null,signal:'SIGKILL'},{...first,kind:'closed',exitCode:0,signal:null}],rows:[],appPid:10}),/Consistent normal Native close/);
  for(const changed of [rows.slice(1),rows.filter(row=>row.pid!==11),rows.map(row=>row.pid===11?{...row,parent:1}:row),rows.map(row=>row.pid===12?{...row,parent:1}:row),rows.map(row=>row.pid===11?{...row,state:'Z',command:''}:row),rows.map(row=>row.pid===10?{...row,state:'Z',command:''}:row)]){
    const current=ownership.createNativeGenerationRegistry({...input,appCommand});current.observe({events:[first],rows,appPid:10});
    assert.equal(current.observe({events:[first],rows:changed,appPid:10}).current,null);
  }
});
test('close metadata is primitive typed and digest validated before entering generation evidence',()=>{
  const first=startGeneration(firstGeneration,11,12),initial={events:[first],rows:generationRows(11,12),appPid:10};
  for(const metadata of [{nativeTerminatedDuringHold:'true'},{nativeTerminatedDuringHold:{leaseToken:'private'}},{withheldResponseSha256:'not-a-digest'},{withheldResponseSha256:{reference:'private'}}]){
    const registry=ownership.createNativeGenerationRegistry({...input,appCommand});registry.observe(initial);
    assert.throws(()=>registry.observe({events:[first,{...first,kind:'closed',exitCode:0,signal:null,...metadata}],rows:[],appPid:10}),/Typed hold termination flag|SHA-256 sealed response digest/);
    assert.equal(registry.observe(initial).generations[0].closeObservations.length,0,'Malformed metadata never commits into evidence');
  }
});


test('command mismatch preserves the exact process row without inferring exit from its name',()=>{
  const args=input.events[0].args,relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const launched=relayProcessOwnership({...input,rows:[{pid:11,parent:10,state:'S',command:relay},{pid:12,parent:11,state:'S',command:native}],requireLineage:true});
  for(const state of ['S','?','E','?E','SunknownE',undefined]){
    const row={pid:12,parent:11,state,command:'(zorid-desktop-ho)'};
    assert.throws(()=>relayProcessOwnership({...input,rows:[row],previouslyOwned:launched}),error=>{
      assert.equal(error.code,'ERR_ASSERTION');
      assert.ok(error.message.includes('Exact owned process command; observed row '+JSON.stringify({...row,state:state??null})));
      return true;
    });
  }
});


test('macOS exiting rows require exact prior authentication and never become signal targets',()=>{
  const args=input.events[0].args,relay=[input.identity.executable,...input.identity.args,...args].join(' '),native=[input.native,...args].join(' ');
  const live=[{pid:11,parent:10,state:'S',command:relay},{pid:12,parent:11,state:'S',command:native}];
  const launched=relayProcessOwnership({...input,rows:live,requireLineage:true});
  for(const state of ['SE','UE+','RNE']){
    const rows=[{pid:12,parent:11,state,command:'(host)'}];
    assert.throws(()=>relayProcessOwnership({...input,rows}),/exact prior launch authentication/);
    assert.throws(()=>relayProcessOwnership({...input,rows,previouslyOwned:launched.map(row=>({...row,authenticatedAtLaunch:false}))}),/exact prior launch authentication/);
    assert.throws(()=>relayProcessOwnership({...input,rows,previouslyOwned:launched,requireLineage:true}),/live at launch/);
    const exiting=relayProcessOwnership({...input,rows,previouslyOwned:launched});
    assert.deepEqual(exiting[1].exiting,{state,parent:11,command:'(host)'});
    assert.deepEqual(livingOwnedProcesses(exiting,rows),[]);
    assert.deepEqual(discoverUnannouncedRelayProcesses({...input,rows:live.map(row=>({...row,state}))}),[]);
    assert.deepEqual(livingOwnedProcesses(launched,live.map(row=>({...row,state}))),[]);
    assert.throws(()=>relayProcessOwnership({...input,rows:live,previouslyOwned:exiting}),/cannot regain live authority/);
  }
});

test('exiting app, relay and Native revoke current authority and cannot satisfy shutdown until gone',()=>{
  const first=startGeneration(firstGeneration,11,12),events=[first],rows=generationRows(11,12);
  for(const pid of [10,11,12]){
    const registry=ownership.createNativeGenerationRegistry({...input,appCommand});
    assert.throws(()=>registry.observe({events,rows:rows.map(row=>row.pid===pid?{...row,state:'SE',command:'(exiting)'}:row),appPid:10}),/live/);
    registry.observe({events,rows,appPid:10});
    const exiting=rows.map(row=>row.pid===pid?{...row,state:'SE',command:'(exiting)'}:row);
    const observed=registry.observe({events,rows:exiting,appPid:10});
    assert.equal(observed.current,null);
    const signals=[];
    assert.throws(()=>registry.killCurrent(firstGeneration,{events,rows:exiting,appPid:10,kill:(...args)=>signals.push(args)}),/current generation/);
    assert.deepEqual(signals,[]);
    const closed=[first,{...first,kind:'closed',exitCode:0,signal:null}];
    // Keep only the exiting row: all other processes are already absent.
    const pending=[exiting.find(row=>row.pid===pid)];
    assert.throws(()=>registry.assertShutdown({events:closed,rows:pending,appPid:10}),/exiting processes are still pending|app must be absent/);
    const completed=registry.assertShutdown({events:closed,rows:pending.map(row=>({...row,state:'Z'})),appPid:10});
    assert.equal(completed[0].kind,'normal-native-close');
    assert.equal(registry.assertShutdown({events:closed,rows:[],appPid:10})[0].kind,'normal-native-close');
  }
});

test('live app command mismatches retain the exact row and never infer exiting by its name',()=>{
  const registry=ownership.createNativeGenerationRegistry({...input,appCommand}),first=startGeneration(firstGeneration,11,12),rows=generationRows(11,12);
  registry.observe({events:[first],rows,appPid:10});
  const app={...rows[0],command:'(Electron)'};
  assert.throws(()=>registry.observe({events:[first],rows:[app,...rows.slice(1)],appPid:10}),error=>{
    assert.ok(error.message.includes('Exact live owned app command; observed row '+JSON.stringify(app)));return true;
  });
});
