import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {installMainObserver} from './main-observer.mjs';
import {appPins,currentBrowserEndpoint,hash,launchEnvironment,ownedOutput} from './support.mjs';
import {BaseDocument} from '../../src/bases/document.ts';
import {baseFixtureSource} from './oracle.mjs';

test('the exact packaged benchmark Base fixture passes the actual production BaseDocument parser',()=>{
  const document=BaseDocument.parse(baseFixtureSource());
  assert.equal(document.views.length,1);assert.equal(document.views[0].id,'profilebase1');
  assert.equal(document.views[0].type,'table');assert.equal(document.views[0].source.kind,'untyped');
});

test('reopen debugger endpoint comes only from the current child renderer nonce, never a stale profile port',()=>{
  const staleProfile='53950\n/devtools/browser/old-browser\n';
  assert.throws(()=>currentBrowserEndpoint(staleProfile),/Current launch/);
  assert.throws(()=>currentBrowserEndpoint('Debugger listening on ws://127.0.0.1:53000/main-inspector\n'),/renderer/);
  const current='Debugger listening on ws://127.0.0.1:54000/current-main\nDevTools listening on ws://127.0.0.1:54108/devtools/browser/current-browser\n';
  assert.deepEqual(currentBrowserEndpoint(current),{port:54108,url:'ws://127.0.0.1:54108/devtools/browser/current-browser'});
  assert.throws(()=>currentBrowserEndpoint('DevTools listening on ws://other-host:54108/devtools/browser/foreign\n'),/Current launch/);
});

test('launch environment removes development/native overrides and never accepts an output under real profiles',()=>{
  const env=launchEnvironment('/private/tmp/owned/profile','/private/tmp/owned/data',{PATH:'/bin',ZORID_DEV_URL:'http://bad',ZORID_DESKTOP_HOST_BIN:'/bad',ZORID_FIXTURE_VAULT:'/real',ZORID_LOCAL_DATA_DIR:'/real',NODE_OPTIONS:'--require=bad',ELECTRON_RUN_AS_NODE:'1',ELECTRON_USER_DATA_DIR:'/real',CHROME_LOG_FILE:'/real/log'});
  assert.deepEqual(env,{PATH:'/bin',ZORID_LOCAL_DATA_DIR:'/private/tmp/owned/data'});
  assert.equal(ownedOutput('/private/tmp/zorid-packaged-startup-owned'),'/private/tmp/zorid-packaged-startup-owned');
  for(const value of ['/Users/person/Library/Application Support/Zorid','/private/tmp/other','/private/tmp/zorid-packaged-startup-owned/nested','/private/tmp/zorid-packaged-startup-x/../real'])assert.throws(()=>ownedOutput(value));
});

test('main observer preserves actual request/open Promise identity and records final quit after a cancelled quit and native exit',async()=>{
  let closing=true;const app=new EventEmitter();
  Object.assign(app,{isPackaged:true,getAppPath:()=>'/clone.app/Contents/Resources/app.asar',getPath:()=>'/owned/profile',isReady:()=>true,quit(){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};this.emit('before-quit');this.emit('will-quit',event);if(!event.defaultPrevented)this.emit('quit',{},0);}});
  app.on('will-quit',event=>{if(closing)event.preventDefault();});
  const writes=[],calls=[];let now=10;
  const reply={result:{checkpoint:{key:'note/v1/entry',revision:'2',deleted:false}},bytes:new Uint8Array()},nativeChild=new EventEmitter();nativeChild.pid=23;
  const originalPromise=Promise.resolve(reply),openPromise=Promise.resolve({child:nativeChild,reconciliation:{complete:false}});
  class Host{static open(...args){calls.push({kind:'open',args,thisValue:this});return openPromise;}request(...args){calls.push({kind:'request',args,thisValue:this});return originalPromise;}}
  const req=name=>{
    if(name==='electron')return{app,BrowserWindow:Object.assign(class{}, {getAllWindows:()=>[]})};
    if(name==='./desktop/rust-vault-service.cjs')return{RustVaultService:Host};
    if(name==='./desktop/document-runtime.cjs')return{isRuntimeOp:()=>false};
    throw Error('Unexpected module '+name);
  };
  const context={process:{pid:22,resourcesPath:'/clone.app/Contents/Resources',execPath:'/clone.app/Contents/MacOS/Zorid',versions:{electron:'44.9.1'},env:{ZORID_LOCAL_DATA_DIR:'/owned/data'},getBuiltinModule(name){return name==='module'?{createRequire:()=>req}:name==='perf_hooks'?{performance:{now:()=>now++,timeOrigin:1000}}:{writeFileSync:(...args)=>writes.push(args)};}},structuredClone,Uint8Array};
  vm.runInNewContext(`(${installMainObserver.toString()})(${JSON.stringify({expectedAppPath:'/clone.app/Contents/Resources/app.asar',profile:'/owned/profile',localDataDirectory:'/owned/data',outputFile:'/owned/final.json'})})`,context);
  const host=new Host();host.tail=Promise.resolve();host.child=nativeChild;
  const command={method:'checkpoint_cas',scope:{vault_id:'store',client_id:'client'},key:'note/v1/entry',next_revision:'2',has_state:true},bytes=new Uint8Array([1]);
  assert.equal(host.request(command,bytes),originalPromise);assert.equal(Host.open('fixture'),openPromise);await originalPromise;await Promise.resolve();
  assert.equal(calls[0].thisValue,host);assert.equal(calls[0].args[0],command);assert.equal(calls[0].args[1],bytes);assert.equal(calls[1].thisValue,Host);
  const observed=context.__zoridPackagedMain;assert.equal(observed.requests[0].ok,true);assert.equal(observed.requests[0].checkpointResult.revision,'2');
  assert.equal(observed.phases[0].phase,'inspector-attached');assert.equal(observed.phases[0].appReadyAlready,true);assert.ok(!observed.phases.some(phase=>phase.phase==='app-ready'));
  context.__zoridPackagedQuit();assert.equal(observed.normalQuitObserved,false,'cancelled first will-quit cannot establish normal exit');assert.equal(writes.length,0,'no terminal receipt before native close');
  nativeChild.emit('exit',0,null);closing=false;context.__zoridPackagedQuit();
  assert.equal(observed.nativeExits[0].pid,23);assert.equal(observed.nativeExits[0].code,0);assert.equal(observed.normalQuitObserved,true);assert.equal(observed.quitExitCode,0);
  assert.equal(writes.length,1);assert.equal(writes[0][0],'/owned/final.json');
  const terminal=JSON.parse(writes[0][1]);assert.equal(terminal.nativeExits[0].code,0);
  assert.deepEqual(terminal.phases.filter(phase=>phase.phase==='will-quit').map(phase=>phase.defaultPreventedAtFinalQuit),[true,false]);
});

test('artifact pins never infer source provenance and reject a mismatched supplied manifest',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-packaged-pins-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app=path.join(root,'Test.app'),files={
    'Contents/Info.plist':'info','Contents/MacOS/Zorid':'executable','Contents/Resources/app.asar':'archive',
    'Contents/Resources/native/zorid-desktop-host':'native','Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework':'framework'};
  for(const [name,value] of Object.entries(files)){const file=path.join(app,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);}
  const asar={extractFile:(_file,name)=>{assert.equal(name,'desktop/main.cjs');return Buffer.from('main');}},readInfo=()=>({CFBundleExecutable:'Zorid',CFBundleIdentifier:'app.zorid.notes'});
  const unknown=await appPins(app,asar,undefined,{readInfo});assert.equal(unknown.provenance.status,'unknown');
  const manifest=path.join(root,'inputs.json');await fs.writeFile(manifest,JSON.stringify({files:{'desktop/main.cjs':hash('main')},native:{sourceSha256:hash('native')}}));
  assert.equal((await appPins(app,asar,manifest,{readInfo})).provenance.status,'provided-manifest-verified');
  await fs.writeFile(path.join(app,'Contents/Resources/native/zorid-desktop-host'),'changed');
  await assert.rejects(appPins(app,asar,manifest,{readInfo}),/native manifest/);
});
