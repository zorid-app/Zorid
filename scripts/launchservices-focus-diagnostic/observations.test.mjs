import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {workspaceReady,startupProfile,waitForWorkspace,observeMain,observeDocument} from './observations.mjs';
const ready={expectedURL:'file:///fixture',window:{focused:true,visible:true,minimized:false,url:'file:///fixture'},lifecycle:{nativeOpen:[{startedAt:1,finishedAt:10}]},document:{url:'file:///fixture',visibilityState:'visible',hidden:false,hasFocus:true,workspace:true,fixtureRow:true,inert:false,startupError:false}};
test('foreground alone must not authorize pre-startup cleanup',()=>assert.equal(workspaceReady({window:{focused:true}}),false));
test('actual Native opening must finish before ready, even when shell exists',()=>assert.equal(workspaceReady({...ready,lifecycle:{nativeOpen:[{startedAt:1}]}}),false));
test('shell cannot fake exact fixture namespace or honest startup state',()=>{for(const delta of [{workspace:false},{fixtureRow:false},{inert:true},{startupError:true}])assert.equal(workspaceReady({...ready,document:{...ready.document,...delta}}),false);});
test('actual source metadata and completed opening permit readiness',()=>assert.equal(workspaceReady(ready),true));
test('ready shell cannot replace current actual foreground or exact page',()=>{for(const delta of [{hidden:true},{hasFocus:false},{visibilityState:'hidden'},{url:'file:///other'}])assert.equal(workspaceReady({...ready,document:{...ready.document,...delta}}),false);assert.equal(workspaceReady({...ready,window:{...ready.window,focused:false}}),false);});
test('opt-in new Main chronology requires its actual close-handler-ready mark in same clock',()=>{
  const profile={version:1,timeOrigin:100,phases:[{phase:'close_handler.ready',atMs:2}]},snapshot={...ready,lifecycle:{...ready.lifecycle,timeOrigin:100},profile,requireProfile:true};
  assert.equal(workspaceReady(snapshot),true);
  for(const profile of [null,{timeOrigin:101,phases:[{phase:'close_handler.ready',atMs:2}]},{timeOrigin:100,phases:[]}])assert.equal(workspaceReady({...snapshot,profile}),false);
});
test('delayed opening and actual DOM are observed before caller can quit once',async()=>{
  let time=0,samples=0,quit=0;const record={};
  const value=await waitForWorkspace({sample:async()=>{samples++;return time<100?{...ready,lifecycle:{nativeOpen:[{startedAt:1}]}}:ready;},remaining:()=>200-time,pause:async ms=>{assert.equal(quit,0);time+=ms;},record});
  quit++;assert.equal(value,ready);assert.equal(time,100);assert.equal(samples,3);assert.equal(quit,1);assert.equal(record.ready,ready);
});
test('deadline preserves truthful unavailable evidence; no synthetic success',async()=>{let time=0;const record={};await assert.rejects(waitForWorkspace({sample:async()=>({window:{focused:true}}),remaining:()=>100-time,pause:async ms=>{time+=ms;},record}),/not ready/);assert.equal(record.ready,undefined);assert.equal(time,100);assert.ok(record.first&&record.latest);});
test('late passive reply cannot reset or outrun original startup deadline',async()=>{let time=0;const record={};await assert.rejects(waitForWorkspace({sample:async()=>{time=11;return ready;},remaining:()=>10-time,pause:async()=>{},record}),/deadline/);assert.equal(record.ready,undefined);assert.equal(record.latest,ready);});
const profile={version:1,timeOrigin:100,moduleEntryUptimeMs:10,phases:[{phase:'module.entry',atMs:1},{phase:'close_handler.ready',atMs:2}],truncated:false};
test('profile snapshot copies bounded fixed schema and drops unrelated fields',()=>assert.deepEqual(startupProfile({...profile,body:'not copied'}),profile));
test('absent legacy profile remains unavailable',()=>assert.equal(startupProfile(undefined),null));
test('malformed, unbounded or reordered chronology rejects',()=>{for(const delta of [{version:2},{timeOrigin:NaN},{phases:Array(129).fill({phase:'x',atMs:1})},{phases:[{phase:'x',atMs:2},{phase:'y',atMs:1}]}])assert.throws(()=>startupProfile({...profile,...delta}));});
test('optional Native events remain bound to exact preceding spawn and drop raw data',()=>{
  const nativeEvents=[{kind:'spawn',hostIndex:0,pid:9,atMs:1},{kind:'hello',hostIndex:0,pid:9,atMs:2},{kind:'native_phase',hostIndex:0,pid:9,atMs:3,phase:'entry',elapsedMs:0,raw:'not retained'}];
  const actual=startupProfile({...profile,nativeEvents,nativeEventsTruncated:false});assert.equal(actual.nativeEvents.length,3);assert.equal(actual.nativeEvents[2].raw,undefined);
  for(const patch of [{hostIndex:2},{pid:10},{phase:'raw-user-value'},{elapsedMs:-1}])assert.throws(()=>startupProfile({...profile,nativeEvents:[...nativeEvents.slice(0,2),{...nativeEvents[2],...patch}]}));
});
test('actual readonly Main snapshot retains prevented-quit history without invoking product actions',()=>{
  const config={pid:42,executable:'/app/Zorid',appPath:'/app/app.asar',profile:'/p',data:'/d',timeOrigin:100};
  const state={pid:42,timeOrigin:100,installedAt:10,phases:[{phase:'will-quit',at:12,defaultPreventedAtObserver:true}],nativeOpen:[{startedAt:11}],nativePids:[9],nativeExits:[],errors:[],normalQuitObserved:false};
  const context={process:{pid:42,execPath:'/app/Zorid',resourcesPath:'/app',env:{ZORID_LOCAL_DATA_DIR:'/d'},getBuiltinModule:()=>({createRequire:()=>()=>({app:{isPackaged:true,getAppPath:()=>'/app/app.asar',getPath:()=>'/p'},BrowserWindow:{getAllWindows:()=>[]}})})},performance:{timeOrigin:100},__zoridPackagedMain:state,__zoridStartupProfile:profile};
  const value=vm.runInNewContext(`(${observeMain.toString()})(${JSON.stringify(config)})`,context);assert.equal(value.lifecycle.phases[0].defaultPreventedAtObserver,true);assert.equal(value.lifecycle.nativeOpen[0].finishedAt,undefined);assert.equal(value.window,null);
  assert.throws(()=>vm.runInNewContext(`(${observeMain.toString()})(${JSON.stringify({...config,pid:43})})`,context),/scope differs/);
});
test('actual DOM observation reads honest fixture/shell/error state and bounds text',()=>{
  const root={classList:{contains:name=>name==='workspace'},querySelector:selector=>selector.includes('Diagnostic.md')?{}:null,inert:false,className:'workspace'};
  const document={querySelector:selector=>selector==='#app'?root:null,readyState:'complete',visibilityState:'visible',hidden:false,hasFocus:()=>true,body:{textContent:'x'.repeat(2000)}};
  const value=vm.runInNewContext(`(${observeDocument.toString()})()`,{document,location:{href:'file:///fixture#x'}});assert.equal(value.workspace,true);assert.equal(value.fixtureRow,true);assert.equal(value.bodyText.length,1000);assert.equal(value.url,'file:///fixture');assert.equal(value.startupError,false);
});
