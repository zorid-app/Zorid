import fs from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {ownedProcesses} from './support.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Failure evidence must never prevent the normal quit request, inspector
 * teardown or bounded termination of the exact child this harness spawned. */
export async function stopOwned(owned,launch,{apps,shutdownMs,io={}}){
  const errors=launch.cleanupErrors??=[],record=(phase,error)=>errors.push({phase,error:String(error)});
  const snapshot=io.snapshot??(()=>ownedProcesses(apps)),pause=io.pause??sleep,now=io.now??(()=>performance.now());
  const signal=io.signal??((pid,value)=>process.kill(pid,value));
  const alive=()=>owned.child.exitCode===null&&owned.child.signalCode===null;
  const waitExit=io.waitExit??(ms=>new Promise(resolve=>{
    const timer=setTimeout(resolve,ms);owned.exit.then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);resolve();});
  }));
  const attempt=async(phase,action)=>{try{return await action();}catch(error){record(phase,error);return undefined;}};
  let forced=false;
  try{
    const evidence=await Promise.allSettled([
      Promise.resolve().then(()=>snapshot()),
      Promise.resolve().then(()=>owned.renderer?.events??[]),
      Promise.resolve().then(()=>owned.main?.events??[]),
    ]);
    for(const [index,key]of ['ownedProcessesBeforeQuit','rendererEvents','mainInspectorEvents'].entries()){
      if(evidence[index].status==='fulfilled')launch[key]=evidence[index].value;else record(key,evidence[index].reason);
    }
  }finally{
    try{if(owned.main&&alive())await attempt('app-quit',()=>owned.main.evaluate('globalThis.__zoridPackagedQuit();true'));}
    finally{
      await attempt('renderer-inspector-close',()=>owned.renderer?.close());
      await attempt('browser-inspector-close',()=>owned.browser?.close());
      await attempt('main-inspector-close',()=>owned.main?.close());
      await attempt('normal-exit-wait',()=>waitExit(shutdownMs));
      if(alive()){forced=true;await attempt('owned-child-TERM',()=>owned.child.kill('SIGTERM'));await attempt('TERM-exit-wait',()=>waitExit(2000));}
      if(alive()){forced=true;await attempt('owned-child-KILL',()=>owned.child.kill('SIGKILL'));await attempt('KILL-exit-wait',()=>waitExit(2000));}
    }
  }
  const readProcesses=async()=>{try{return await snapshot();}catch(error){record('owned-PID-proof',error);return null;}};
  let remaining=await readProcesses();const end=now()+2000;
  while(remaining?.length&&now()<end){await attempt('descendant-exit-wait',()=>pause(25));remaining=await readProcesses();}
  for(const item of remaining??[]){const actual=await readProcesses();if(actual?.some(row=>row.pid===item.pid)){forced=true;await attempt('owned-descendant-TERM',()=>signal(item.pid,'SIGTERM'));}}
  if(remaining?.length){
    await attempt('descendant-TERM-wait',()=>pause(500));
    for(const item of await readProcesses()??[]){
      const actual=await readProcesses();if(actual?.some(row=>row.pid===item.pid)){forced=true;await attempt('owned-descendant-KILL',()=>signal(item.pid,'SIGKILL'));}
    }
    await attempt('descendant-KILL-wait',()=>pause(100));
  }
  remaining=await readProcesses();
  const readMain=io.readMain??(async()=>JSON.parse(await fs.readFile(launch.mainFinalFile,'utf8')));
  launch.mainFinal=await attempt('main-final-evidence',readMain);
  const known=launch.mainFinal?.nativePids??[],exits=launch.mainFinal?.nativeExits??[];
  const nativeNormal=known.length?known.every(pid=>exits.some(row=>row.pid===pid&&row.code===0&&row.signal===null)):null;
  launch.cleanup={normal:!forced&&!alive()&&owned.child.exitCode===0&&owned.child.signalCode===null&&launch.mainFinal?.normalQuitObserved===true&&launch.mainFinal?.quitExitCode===0&&nativeNormal!==false,
    gone:remaining!==null&&remaining.length===0&&!alive(),forced,remaining:remaining??[{unverifiable:true}],nativeNormal,nativeExits:exits};
  const writeLogs=io.writeLogs??(async()=>{await fs.writeFile(path.join(launch.directory,'stderr.log'),launch.stderr);await fs.writeFile(path.join(launch.directory,'stdout.log'),launch.stdout);});
  await attempt('terminal-log-write',writeLogs);return launch.cleanup;
}
