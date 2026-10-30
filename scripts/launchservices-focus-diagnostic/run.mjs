#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {CDP} from '../../tests/tasks-electron-integration/cdp.mjs';
import {appPins,currentBrowserEndpoint,hashFile,launchEnvironment} from '../packaged-startup-profile/support.mjs';
import {authenticateMain} from '../packaged-startup-profile/preparation.mjs';
import {installMainLifecycle} from '../packaged-startup-profile/main-observer.mjs';
import {foregroundSource} from '../packaged-startup-profile/foreground.mjs';
import {documentVisibilitySource} from '../packaged-startup-profile/measurement.mjs';
import {authenticate,assertLifetime,cleanupVerdict,launchArguments,processRows} from './contract.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function discoverIdentity(){
  const builtin=name=>process.getBuiltinModule?process.getBuiltinModule(name):require(name);
  const req=builtin('module').createRequire(process.resourcesPath+'/app.asar/package.json'),{app}=req('electron');
  return {pid:process.pid,executable:process.execPath,appPath:app.getAppPath(),profile:app.getPath('userData'),data:process.env.ZORID_LOCAL_DATA_DIR,packaged:app.isPackaged,argv:process.argv,timeOrigin:performance.timeOrigin};
}
async function poll(action,remaining){let last;while(remaining()>0){try{return await action();}catch(error){last=error;}await pause(Math.min(50,Math.max(1,remaining())));}throw last??Error('Diagnostic budget expired');}
const allProcesses=()=>processRows(execFileSync('/bin/ps',['-axo','pid=,lstart=,command='],{encoding:'utf8'}));
export async function main(args=process.argv.slice(2)){
  const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  const original=await fs.realpath(option('--app','')),out=path.resolve(option('--out','/private/tmp/zorid-launchservices-focus-'+randomUUID()));
  assert.ok(original.endsWith('.app'));assert.equal(path.dirname(out),'/private/tmp');assert.ok(path.basename(out).startsWith('zorid-launchservices-focus-'));
  const timeout=Number(option('--timeout-ms','15000')),shutdown=Number(option('--shutdown-ms','30000'));
  assert.ok(Number.isInteger(timeout)&&timeout>=1000&&timeout<=30000&&Number.isInteger(shutdown)&&shutdown>=1000&&shutdown<=60000);
  await fs.mkdir(out,{mode:0o700});
  const app=path.join(out,'owned.app'),profile=path.join(out,'profile'),data=path.join(out,'app-data'),vault=path.join(out,'vault'),stdout=path.join(out,'app.stdout'),stderr=path.join(out,'app.stderr'),mainFinal=path.join(out,'main-final.json');
  for(const directory of [profile,data,vault])await fs.mkdir(directory,{mode:0o700});
  await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}),{flag:'wx',mode:0o600});
  const fixture=path.join(vault,'Diagnostic.md');await fs.writeFile(fixture,'# Diagnostic\n\nOwned read-only focus fixture.\n',{flag:'wx',mode:0o600});
  for(const file of [stdout,stderr])await fs.writeFile(file,'',{flag:'wx',mode:0o600});
  const require=createRequire(import.meta.url),asar=await import(pathToFileURL(require.resolve('@electron/asar')).href);
  const originalPins=await appPins(original,asar);execFileSync('/bin/cp',['-cR',original,app]);const pinned=await appPins(app,asar);
  for(const key of ['executableSha256','asarSha256','frameworkSha256','nativeSha256','infoSha256'])assert.equal(pinned[key],originalPins[key]);
  assert.ok(!allProcesses().some(row=>row.command.startsWith(app+'/Contents/')));
  const fixtureHash=await hashFile(fixture),argv=launchArguments({app,profile,data,stdout,stderr});
  const report={version:1,purpose:'LaunchServices focus diagnostic ONLY; no startup benchmark and no input',out,originalPins,pinned,profile,data,vault,argv,activationAttempts:0,inputAttempts:0,appKernelExitStatus:'unknown',errors:[],cleanupErrors:[],focusSamples:[]};
  const start=performance.now(),elapsed=()=>performance.now()-start;report.launchWallClock=new Date().toISOString();
  const wrapper=spawn('/usr/bin/open',argv,{env:launchEnvironment(profile,data),cwd:out,stdio:'ignore'});
  report.wrapper={pid:wrapper.pid,code:null,signal:null};wrapper.once('exit',(code,signal)=>Object.assign(report.wrapper,{code,signal,exitedAtMs:elapsed()}));wrapper.once('error',error=>report.wrapper.error=String(error));
  const remaining=()=>timeout-elapsed();let main,renderer,browser,owner;
  const ownedRows=()=>allProcesses().filter(row=>row.command.startsWith(app+'/Contents/'));
  const write=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  const attempt=async(phase,action)=>{try{return await action();}catch(error){report.cleanupErrors.push({phase,error:String(error)});}};
  try{
    await write();process.stdout.write(JSON.stringify({event:'launchservices-wrapper-started',out,wrapperPid:wrapper.pid})+'\n');
    const mainURL=await poll(async()=>{if(report.wrapper.error)throw Error(report.wrapper.error);const value=await fs.readFile(stderr,'utf8'),url=/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(value)?.[1];assert.ok(url,'Fresh main endpoint not available');return url;},remaining);
    main=new CDP(mainURL);await main.call('Runtime.enable');
    const identity=await main.evaluate(`(${discoverIdentity.toString()})()`);
    owner=authenticate(identity,{executable:pinned.executable,appPath:pinned.archive,profile,data},allProcesses(),wrapper.pid);
    report.appIdentity=owner;report.mainAttachedMs=elapsed();
    // No product actions precede authentication. Reuse exact existing scope and
    // real Native child-exit hooks; do not treat wrapper status as app status.
    await main.evaluate(`(${authenticateMain.toString()})(${JSON.stringify({pid:owner.pid,executable:pinned.executable,appPath:pinned.archive,profile,localDataDirectory:data})})`);
    report.lifecycle=await main.evaluate(`(${installMainLifecycle.toString()})(${JSON.stringify({pid:owner.pid,executable:pinned.executable,expectedAppPath:pinned.archive,profile,localDataDirectory:data,outputFile:mainFinal})})`);
    report.lifecycleAttachedMs=elapsed();
    const endpoint=await poll(async()=>currentBrowserEndpoint(await fs.readFile(stderr,'utf8')),remaining);report.browserEndpoint=endpoint;
    browser=new CDP(endpoint.url);await browser.opened;
    const expectedURL=pathToFileURL(path.join(pinned.archive,'dist/index.html')).href;
    const target=await poll(async()=>{
      const {targetInfos}=await browser.call('Target.getTargets');const candidates=targetInfos.filter(t=>t.type==='page'&&(t.url.split('#')[0]===expectedURL||t.url==='about:blank'));assert.equal(candidates.length,1);
      const response=await fetch(`http://127.0.0.1:${endpoint.port}/json/list`,{signal:AbortSignal.timeout(Math.max(1,Math.min(1000,remaining())))});assert.ok(response.ok);const targets=await response.json();const target=targets.find(t=>t.id===candidates[0].targetId&&t.type==='page'&&(t.url.split('#')[0]===expectedURL||t.url==='about:blank'));assert.ok(target);return target;
    },remaining);
    renderer=new CDP(target.webSocketDebuggerUrl);await renderer.opened;report.rendererAttachedMs=elapsed();
    const config={pid:owner.pid,executable:pinned.executable,appPath:pinned.archive,profile,localDataDirectory:data,url:expectedURL,activate:false};
    await poll(async()=>{
      assertLifetime(owner,allProcesses());
      const [window,document]=await Promise.all([main.evaluate(foregroundSource(config)),renderer.evaluate(documentVisibilitySource)]);
      const sample={atMs:elapsed(),window,document};report.focusSamples.push(sample);
      assert.ok(window.focused&&window.visible&&!window.minimized&&document.url===expectedURL&&document.visibilityState==='visible'&&!document.hidden&&document.hasFocus===true,'Normal LaunchServices foreground not observed');
      report.focusConfirmed=sample;return sample;
    },remaining);
  }catch(error){report.errors.push(String(error));}
  finally{
    if(main&&owner)await attempt('normal-app-quit',async()=>{assertLifetime(owner,allProcesses());await main.evaluate('globalThis.__zoridPackagedQuit();true');});
    for(const [name,client]of [['renderer',renderer],['browser',browser],['main',main]])if(client)await attempt(name+'-close',()=>client.close());
    const end=elapsed()+shutdown;
    await attempt('normal-app-wrapper-exit-wait',()=>poll(async()=>{assert.equal(ownedRows().length,0,'Owned app/Native still alive');assert.notEqual(wrapper.exitCode,null,'open wrapper still alive');},()=>end-elapsed()));
    if(owner&&ownedRows().some(row=>row.pid===owner.pid))await attempt('authenticated-app-TERM',()=>{assertLifetime(owner,allProcesses());process.kill(owner.pid,'SIGTERM');report.forced=true;});
    if(report.forced)await attempt('forced-app-exit-wait',()=>poll(async()=>assert.equal(ownedRows().length,0),()=>end+2000-elapsed()));
    report.remaining=await attempt('final-owned-process-proof',()=>ownedRows());
    report.final=await attempt('actual-main-quit-receipt',async()=>JSON.parse(await fs.readFile(mainFinal,'utf8')));
    report.cleanup=cleanupVerdict({wrapper:report.wrapper,final:report.final,remaining:report.remaining,forced:report.forced===true,appPid:owner?.pid});
    report.fixtureUnchanged=await attempt('fixture-proof',async()=>await hashFile(fixture)===fixtureHash);
    report.artifactsUnchanged=await attempt('artifact-proof',async()=>{for(const [key,file]of [['executableSha256',pinned.executable],['asarSha256',pinned.archive],['nativeSha256',pinned.native],['frameworkSha256',pinned.framework]])assert.equal(await hashFile(file),pinned[key]);return true;});
    report.completeMs=elapsed();report.validDiagnostic=!!report.focusConfirmed&&report.cleanup.normalLifecycle&&report.fixtureUnchanged===true&&report.artifactsUnchanged===true&&report.errors.length===0&&report.cleanupErrors.length===0;
    // Retain all diagnostics/owned surfaces. An unauthenticated surviving app is
    // explicitly unresolved; never signal a guessed PID or equate wrapper death
    // with application death. Detach only the wrapper handle so the report exits.
    if(wrapper.exitCode===null)wrapper.unref();
    await write();process.stdout.write(JSON.stringify({event:'launchservices-diagnostic-terminal',out,validDiagnostic:report.validDiagnostic,wrapper:report.wrapper,appPid:owner?.pid,appKernelExitStatus:'unknown',remaining:report.remaining})+'\n');
  }
  return report.validDiagnostic?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
