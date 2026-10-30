import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeLaunchServices,createLaunchServices,stopLaunchServices,launchServicesOptions,registerOwnedClones} from './launch-services.mjs';
import {assessNote} from './oracle.mjs';
test('actual packaged navigation precedes Main attachment while passive renderer observer installs early',async()=>{
  const events=[];
  await observeLaunchServices({measured:true,connectRenderer:async()=>{events.push('renderer');return {};},installObserver:async()=>events.push('observer'),waitForPackagedNavigation:async()=>events.push('navigation'),connectMain:async()=>{assert.ok(events.includes('navigation'),'Main inspector cannot touch constructor');events.push('main');return {};},installLifecycle:async()=>events.push('lifecycle'),foreground:async()=>events.push('foreground'),installNativeObserver:async()=>events.push('native')});
  assert.deepEqual(events,['renderer','observer','navigation','main','lifecycle','foreground','native']);
});
test('navigation failure blocks Main attachment, foreground and instrumentation',async()=>{
  const calls=[];await assert.rejects(observeLaunchServices({measured:true,connectRenderer:async()=>({}),installObserver:async()=>{},waitForPackagedNavigation:async()=>{throw Error('wrong package');},connectMain:async()=>{calls.push('main');return {};},foreground:async()=>calls.push('focus'),installNativeObserver:async()=>calls.push('native')}),/wrong package/);assert.deepEqual(calls,[]);
});
test('legacy warm observation skips foreground but still authenticates Main and installs Native hooks',async()=>{const calls=[];await observeLaunchServices({measured:false,connectRenderer:async()=>({}),installObserver:async()=>calls.push('observer'),waitForPackagedNavigation:async()=>calls.push('navigation'),connectMain:async()=>calls.push('main'),foreground:async()=>calls.push('focus'),installNativeObserver:async()=>calls.push('native')});assert.deepEqual(calls,['observer','navigation','main','native']);});
test('direct launch remains default and registration is explicit LS-only',()=>{assert.deepEqual(launchServicesOptions([]),{enabled:false,preRegister:false,profile:false});assert.throws(()=>launchServicesOptions(['--pre-register-clones']));assert.deepEqual(launchServicesOptions(['--launch-services','--pre-register-clones','--startup-profile']),{enabled:true,preRegister:true,profile:true});});
test('launch origin is armed exactly once after log preparation and immediately before open spawn',async()=>{const events=[],wrapper=new EventEmitter();wrapper.pid=7;await createLaunchServices({pinned,pair,launch:{directory:'/owned/launch',elapsed:()=>1},beforeSpawn:()=>events.push('origin800'),io:{readProcesses:()=>[],write:async()=>events.push('prepare-log'),spawn:()=>{events.push('spawn-open');return wrapper;}}});assert.deepEqual(events,['prepare-log','prepare-log','origin800','spawn-open']);});
const pinned={app:'/private/tmp/owned/clones/candidate.app',executable:'/private/tmp/owned/clones/candidate.app/Contents/MacOS/Zorid',archive:'/private/tmp/owned/clones/candidate.app/Contents/Resources/app.asar'};
const pair={profile:'/private/tmp/owned/profile',data:'/private/tmp/owned/data'};
const row={pid:42,started:'Fri Oct 30 10:00:00 2026',command:pinned.executable+' --user-data-dir='+pair.profile};
const identity={pid:42,executable:pinned.executable,appPath:pinned.archive,profile:pair.profile,data:pair.data,packaged:true,argv:[pinned.executable,'--user-data-dir='+pair.profile],timeOrigin:100};
async function fixture(){
  const wrapper=new EventEmitter();wrapper.pid=7;wrapper.unref=()=>{};let rows=[];const writes=[],spawns=[];const launch={directory:'/private/tmp/owned/first-import',elapsed:()=>10,mainFinalFile:'/private/tmp/owned/final.json'};
  const launcher=await createLaunchServices({pinned,pair,launch,profile:true,io:{readProcesses:()=>rows,write:async p=>writes.push(p),readFile:async()=>'',spawn:(...args)=>{spawns.push(args);return wrapper;}}});rows=[row];launcher.adopt(identity);
  return {wrapper,launch,launcher,setRows:value=>{rows=value;},writes,spawns};
}
test('actual authenticated app PID never inherits the wrapper PID or exit status',async()=>{const f=await fixture();assert.equal(f.launch.pid,42);assert.equal(f.launch.launchServices.wrapperPid,7);f.wrapper.emit('exit',0,null);assert.equal(f.launch.exitCode,undefined);assert.equal(f.launch.launchServices.wrapperExitCode,0);assert.equal(f.launch.launchServices.appKernelExitStatus,'unknown');assert.equal(f.writes.length,2);assert.ok(f.spawns[0][1].includes('ZORID_PROFILE_STARTUP=1'));f.launcher.assertAlive();f.setRows([{...row,started:'different lifetime'}]);assert.throws(()=>f.launcher.assertAlive());});
test('wrapper or foreign profile cannot become the actual app owner',async()=>{const f=await fixture();assert.throws(()=>f.launcher.adopt({...identity,pid:7}));assert.throws(()=>f.launcher.adopt({...identity,profile:'/real'}));});
test('LS observed normal lifecycle keeps kernel status unknown and requires actual app/native receipts',async()=>{
  const f=await fixture();let quits=0,clock=0;const final={pid:42,normalQuitObserved:true,quitExitCode:0,nativePids:[9],nativeExits:[{pid:9,code:0,signal:null}],errors:[]};
  const owned={launcher:f.launcher,main:{evaluate:async()=>{quits++;f.setRows([]);f.wrapper.emit('exit',0,null);},close:()=>{}}};
  const options={apps:[pinned.app],shutdownMs:10,io:{pause:async ms=>{clock+=ms;},now:()=>clock,readMain:async()=>final}};
  await stopLaunchServices(owned,f.launch,options);await stopLaunchServices(owned,f.launch,options);
  assert.equal(quits,1);assert.equal(f.launch.cleanup.normal,true);assert.equal(f.launch.cleanup.mode,'launch-services-normal-lifecycle');assert.equal(f.launch.cleanup.gone,true);assert.equal(f.launch.cleanup.appKernelExitStatus,'unknown');assert.equal(f.launch.exitCode,undefined);
});
test('wrapper0 plus disappearance cannot pass without app quit0 and real Native0/null',async()=>{
  for(const final of [undefined,{pid:42,normalQuitObserved:true,quitExitCode:0,nativePids:[9],nativeExits:[],errors:[]},{pid:42,normalQuitObserved:false,quitExitCode:0,nativePids:[9],nativeExits:[{pid:9,code:0,signal:null}],errors:[]}]){
    const f=await fixture();let clock=0;const owned={launcher:f.launcher,main:{evaluate:async()=>{f.setRows([]);f.wrapper.emit('exit',0,null);},close:()=>{}}};await stopLaunchServices(owned,f.launch,{apps:[pinned.app],shutdownMs:10,io:{pause:async ms=>{clock+=ms;},now:()=>clock,readMain:async()=>final}});assert.equal(f.launch.cleanup.normal,false);
  }
});
test('Native process observed in owned snapshot cannot be omitted from real exit receipts',async()=>{const f=await fixture();f.setRows([row,{pid:10,started:row.started,command:pinned.app+'/Contents/Resources/native/zorid-desktop-host --vault /owned/vault'}]);let clock=0;await stopLaunchServices({launcher:f.launcher,main:{evaluate:async()=>{f.setRows([]);f.wrapper.emit('exit',0,null);},close:()=>{}}},f.launch,{apps:[pinned.app],shutdownMs:1,io:{now:()=>clock,pause:async ms=>{clock+=ms;},readMain:async()=>({pid:42,normalQuitObserved:true,quitExitCode:0,nativePids:[9],nativeExits:[{pid:9,code:0,signal:null}],errors:[]})}});assert.equal(f.launch.cleanup.normal,false);});
test('LS lifecycle proof does not change800ms selected-source/trusted-input/clock requirements',()=>{
  const receipt={deadlineMs:800,packaged:true,packagedUrlVerified:true,identity:'selected',originMs:0,expectedCharacters:8192,clockSamples:[{timeOrigin:100,remoteNow:0,before:0,after:1}],observed:{identity:'selected',installedAt:10,initial:{length:8192,prefixMatches:true},ready:{at:100,visible:true,editable:true},probes:[{name:'ready',identity:'selected',trusted:true,accepted:true,appliedAt:110,caretAfterPaint:1,expectedCaretAfterPaint:1}]},dispatches:[{name:'ready',status:'sent'},{name:'deadline',status:'readiness-unresolved'}],body:{exact:true,sha256:'body'},expectedEditedSha256:'body',cleanup:{mode:'launch-services-normal-lifecycle',normal:true,gone:true,appKernelExitStatus:'unknown'},artifactsUnchanged:true};
  assert.equal(assessNote(receipt).outcome,'target-met');
  for(const mutation of [r=>r.observed.probes[0].trusted=false,r=>r.observed.initial.prefixMatches=false,r=>r.cleanup.normal=false,r=>r.body.exact=false]){const r=structuredClone(receipt);mutation(r);assert.equal(assessNote(r).outcome,'invalid-receipt');}
  const late=structuredClone(receipt);late.observed.installedAt=900;late.observed.ready.at=1000;late.observed.probes[0].appliedAt=1010;late.dispatches[1].status='unobservable';assert.equal(assessNote(late).outcome,'indeterminate');
});
test('reused actual PID prevents fallback signal and retains negative cleanup',async()=>{const f=await fixture();let clock=0,signals=0;f.setRows([{...row,started:'later'}]);await stopLaunchServices({launcher:f.launcher,main:{evaluate:async()=>{throw Error('must not quit reused owner');},close:()=>{}}},f.launch,{apps:[pinned.app],shutdownMs:1,io:{pause:async ms=>{clock+=ms;},now:()=>clock,readMain:async()=>undefined,signal:()=>{signals++;}}});assert.equal(signals,0);assert.equal(f.launch.cleanup.normal,false);assert.equal(f.launch.cleanup.gone,false);});
test('pre-registration and unregistration are exact-clone-only and apply equally to both sides',()=>{
  const out='/private/tmp/owned',apps=[out+'/clones/baseline.app',out+'/clones/candidate.app'],calls=[];const io={execute:(cmd,args)=>{calls.push([cmd,args]);return{status:0,stdout:'',stderr:''};}};
  registerOwnedClones(out,apps,false,io);registerOwnedClones(out,apps,true,io);assert.deepEqual(calls.map(c=>c[1][0]),['-f','-f','-u','-u']);assert.throws(()=>registerOwnedClones(out,['/Users/person/Applications/Zorid.app',apps[1]],false,io));assert.throws(()=>registerOwnedClones(out,[apps[0]],false,io));assert.equal(calls.length,4);
});
