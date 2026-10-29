import test from 'node:test';
import assert from 'node:assert/strict';
import {stopOwned} from './cleanup.mjs';
test('PID evidence, quit, inspector close and TERM failures cannot skip exact child KILL cleanup',async()=>{
  const calls=[],child={exitCode:null,signalCode:null,kill(signal){calls.push(signal);if(signal==='SIGTERM')throw Error('TERM failed');this.signalCode=signal;}};
  const owned={child,exit:new Promise(()=>{}),main:{get events(){throw Error('main evidence failed');},evaluate(){calls.push('quit');throw Error('quit failed');},close(){calls.push('main-close');throw Error('main close failed');}},renderer:{get events(){throw Error('renderer evidence failed');},close(){calls.push('renderer-close');throw Error('renderer close failed');}}};
  const launch={errors:['original failure']};
  await stopOwned(owned,launch,{apps:['/owned.app'],shutdownMs:1,io:{snapshot(){throw Error('ps denied');},waitExit:async()=>{},readMain(){throw Error('no final');},writeLogs(){throw Error('log failure');}}});
  assert.deepEqual(calls,['quit','renderer-close','main-close','SIGTERM','SIGKILL']);
  assert.deepEqual(launch.errors,['original failure']);assert.equal(launch.cleanup.forced,true);assert.equal(launch.cleanup.gone,false);assert.equal(launch.cleanup.normal,false);
  for(const phase of ['ownedProcessesBeforeQuit','app-quit','renderer-inspector-close','main-inspector-close','owned-child-TERM','owned-PID-proof','terminal-log-write'])assert.ok(launch.cleanupErrors.some(error=>error.phase===phase),phase);
});
test('normal cleanup records actual terminal receipt and removes no process by guess',async()=>{
  const child={exitCode:0,signalCode:null,kill(){assert.fail('Normal child must not be signaled');}};
  const launch={};let wrote=false;
  await stopOwned({child,exit:Promise.resolve(),main:{close(){}},renderer:{close(){}}},launch,{apps:['/owned.app'],shutdownMs:1,io:{snapshot:()=>[],waitExit:async()=>{},readMain:()=>({normalQuitObserved:true,nativePids:[22],nativeExits:[{pid:22,code:0,signal:null}]}),writeLogs:()=>{wrote=true;}}});
  assert.equal(launch.cleanup.normal,true);assert.equal(launch.cleanup.gone,true);assert.equal(launch.cleanup.forced,false);assert.ok(wrote);
});
test('one descendant signal failure never skips other owned descendants or final verified absence',async()=>{
  let processes=[{pid:1},{pid:2}],time=0;const calls=[],child={exitCode:0,signalCode:null};
  const launch={};
  await stopOwned({child,exit:Promise.resolve()},launch,{apps:['/owned.app'],shutdownMs:1,io:{
    snapshot:()=>processes.map(row=>({...row})),now:()=>time+=1000,pause:async()=>{},waitExit:async()=>{},
    signal(pid,signal){calls.push([pid,signal]);if(pid===1&&signal==='SIGTERM')throw Error('TERM denied');processes=processes.filter(row=>row.pid!==pid);},
    readMain:()=>({normalQuitObserved:true}),writeLogs:()=>{},
  }});
  assert.deepEqual(calls,[[1,'SIGTERM'],[2,'SIGTERM'],[1,'SIGKILL']]);assert.equal(launch.cleanup.gone,true);assert.equal(launch.cleanup.normal,false);
});
