import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync,spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {launchArguments,processRows,authenticate,assertLifetime,cleanupVerdict} from '../launchservices-focus-diagnostic/contract.mjs';
import {discoverIdentity} from '../launchservices-focus-diagnostic/run.mjs';
import {startupProfile} from '../launchservices-focus-diagnostic/observations.mjs';
import {hash,launchEnvironment} from './support.mjs';

export {discoverIdentity,startupProfile};
export function launchServicesOptions(args){
  const enabled=args.includes('--launch-services'),preRegister=args.includes('--pre-register-clones'),profile=args.includes('--startup-profile');
  assert.ok(!preRegister||enabled,'Clone registration requires LaunchServices mode');return {enabled,preRegister,profile};
}
/** Passive observer gets the earliest document; Main cannot perturb the window
 * constructor because production calls loadFile only after it has returned. */
export async function observeLaunchServices(hooks){
  const renderer=await hooks.connectRenderer();await hooks.installObserver(renderer);await hooks.waitForPackagedNavigation(renderer);
  const main=await hooks.connectMain();await hooks.installLifecycle?.(main);
  if(hooks.measured!==false)await hooks.foreground();await hooks.installNativeObserver(main);return {main,renderer};
}
export const currentProcesses=()=>processRows(execFileSync('/bin/ps',['-axo','pid=,lstart=,command='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}));
export async function createLaunchServices({pinned,pair,launch,profile,beforeSpawn=()=>{},io={}}){
  const readProcesses=io.readProcesses??currentProcesses,write=io.write??((file)=>fs.writeFile(file,'',{flag:'wx',mode:0o600}));
  const stdout=path.join(launch.directory,'launchservices.stdout'),stderr=path.join(launch.directory,'launchservices.stderr');
  assert.ok(!readProcesses().some(row=>row.command.startsWith(pinned.app+'/Contents/')),'Owned clone already has a live process');
  await write(stdout);await write(stderr);
  const args=launchArguments({app:pinned.app,profile:pair.profile,data:pair.data,stdout,stderr,startupProfile:profile});
  beforeSpawn();
  const wrapper=(io.spawn??spawn)('/usr/bin/open',args,{env:launchEnvironment(pair.profile,pair.data),cwd:path.dirname(launch.directory),stdio:'ignore'});
  const receipt=launch.launchServices={kind:'launch-services',wrapperPid:wrapper.pid,wrapperExitCode:null,wrapperSignal:null,stdout,stderr,args,appKernelExitStatus:'unknown'};
  const state={kind:'launch-services',wrapper,owner:null,readProcesses,receipt,pinned,pair,stopPromise:null};
  wrapper.once('exit',(code,signal)=>{receipt.wrapperExitCode=code;receipt.wrapperSignal=signal;receipt.wrapperExitedAtMs=launch.elapsed();if(code!==0||signal)launch.launchError='LaunchServices wrapper exited abnormally';});
  wrapper.once('error',error=>{launch.launchError=String(error);receipt.error=String(error);});
  state.refreshLogs=async()=>{const read=io.readFile??(file=>fs.readFile(file,'utf8'));[launch.stdout,launch.stderr]=await Promise.all([read(stdout),read(stderr)]);launch.stdout=launch.stdout.slice(-1000000);launch.stderr=launch.stderr.slice(-1000000);};
  state.adopt=identity=>{state.owner=authenticate(identity,{executable:pinned.executable,appPath:pinned.archive,profile:pair.profile,data:pair.data},readProcesses(),wrapper.pid);launch.pid=state.owner.pid;receipt.appIdentity=state.owner;return state.owner;};
  state.assertAlive=()=>{assert.ok(!launch.launchError,'LaunchServices wrapper failed');assert.ok(state.owner,'Actual main PID not yet authenticated');assertLifetime(state.owner,readProcesses());};
  return state;
}
/** Mode-specific observed normal lifecycle, not a fabricated direct ChildProcess
 * status. Every Native PID observed in the final owned snapshot needs its real
 * exit0/null receipt. An unobserved final receipt always remains negative. */
export async function stopLaunchServices(owned,launch,{apps,shutdownMs,io={}}){
  const state=owned.launcher;if(state.stopPromise)return state.stopPromise;
  const pause=io.pause??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),now=io.now??(()=>performance.now()),signal=io.signal??((pid,value)=>process.kill(pid,value));
  const errors=launch.cleanupErrors??=[];
  const attempt=async(phase,action)=>{try{return await action();}catch(error){errors.push({phase,error:String(error)});return undefined;}};
  const rows=()=>state.readProcesses().filter(row=>apps.some(app=>row.command.startsWith(app+'/Contents/')));
  state.stopPromise=(async()=>{
    let forced=false;
    launch.ownedProcessesBeforeQuit=await attempt('owned-PID-prequit-proof',rows);
    launch.rendererEvents=owned.renderer?.events??[];launch.mainInspectorEvents=owned.main?.events??[];
    try{
      if(owned.main&&state.owner)await attempt('actual-app-quit',()=>{state.assertAlive();return owned.main.evaluate('globalThis.__zoridPackagedQuit();true');});
    }finally{
      for(const [name,client]of [['renderer',owned.renderer],['browser',owned.browser],['main',owned.main]])if(client)await attempt(name+'-inspector-close',()=>client.close());
      const end=now()+shutdownMs;
      while(now()<end){const remaining=await attempt('owned-PID-exit-proof',rows);if(remaining?.length===0&&state.receipt.wrapperExitCode!==null)break;await pause(25);}
      const alive=await attempt('owned-PID-timeout-proof',rows);
      if(state.owner&&alive?.some(row=>row.pid===state.owner.pid))await attempt('authenticated-app-TERM',()=>{state.assertAlive();signal(state.owner.pid,'SIGTERM');forced=true;});
      const forcedEnd=now()+2000;
      while(forced&&now()<forcedEnd){const remaining=await attempt('owned-PID-TERM-proof',rows);if(remaining?.length===0)break;await pause(25);}
    }
    const remaining=await attempt('owned-PID-final-proof',rows);
    launch.mainFinal=await attempt('actual-main-final-receipt',()=>io.readMain?io.readMain():fs.readFile(launch.mainFinalFile,'utf8').then(JSON.parse));
    const nativePaths=apps.map(app=>app+'/Contents/Resources/native/zorid-desktop-host');
    const before=(launch.ownedProcessesBeforeQuit??[]).filter(row=>nativePaths.some(file=>row.command===file||row.command.startsWith(file+' '))).map(row=>row.pid);
    const known=[...new Set([...(launch.mainFinal?.nativePids??[]),...before])];
    const final=launch.mainFinal?{...launch.mainFinal,nativePids:known}:undefined;
    const verdict=cleanupVerdict({wrapper:{code:state.receipt.wrapperExitCode,signal:state.receipt.wrapperSignal},final,remaining,forced,appPid:state.owner?.pid});
    launch.cleanup={mode:'launch-services-normal-lifecycle',normal:verdict.normalLifecycle,gone:Array.isArray(remaining)&&remaining.length===0&&state.receipt.wrapperExitCode!==null,forced,remaining:remaining??[{unverifiable:true}],nativeNormal:verdict.nativeNormal,nativeExits:launch.mainFinal?.nativeExits??[],actualAppQuitExitCode:launch.mainFinal?.quitExitCode,appKernelExitStatus:'unknown',wrapper:{pid:state.wrapper.pid,exitCode:state.receipt.wrapperExitCode,signal:state.receipt.wrapperSignal}};
    await attempt('LaunchServices-final-logs',()=>state.refreshLogs());
    if(state.receipt.wrapperExitCode===null)state.wrapper.unref();
    return launch.cleanup;
  })();return state.stopPromise;
}
const REGISTER='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export function registerOwnedClones(out,apps,unregister=false,{execute=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8',timeout:30000}),now=()=>performance.now(),record=[]}={}){
  assert.equal(apps.length,2,'Registration must apply equally to both clones');
  for(const app of apps){assert.equal(path.dirname(app),path.join(out,'clones'));assert.ok(['baseline.app','candidate.app'].includes(path.basename(app)));}
  assert.equal(new Set(apps).size,2);
  for(const app of apps){const row={app,operation:unregister?'unregister-owned-clone':'register-owned-clone',startedAt:now()};record.push(row);const result=execute(REGISTER,[unregister?'-u':'-f',app]);Object.assign(row,{completedAt:now(),exitCode:result.status,signal:result.signal??null,stdoutSha256:hash(result.stdout??''),stderrSha256:hash(result.stderr??'')});assert.equal(result.status,0,'Exact clone LaunchServices registration failed');assert.ok(!result.error&&!result.signal);}
  return record;
}
