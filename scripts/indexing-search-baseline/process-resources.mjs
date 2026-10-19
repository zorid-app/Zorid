import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,mkdtemp,open,readFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

export const RESOURCE_SIDECAR_LIMIT=64*1024;
const PROVIDER='/usr/bin/time';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const unavailable=reason=>({availability:'unavailable',reason});
const boundedMs=(value,name)=>assert.ok(Number.isSafeInteger(value)&&value>=1&&value<=300000,`${name} must be an integer in 1..300000`);

// Darwin time(1), -p: elapsed/user/system seconds. Darwin getrusage(2):
// ru_maxrss is bytes, unlike Linux. Other -l fields are retained only as raw text.
// Local references: /usr/share/man/man1/time.1 and SDK usr/share/man/man2/getrusage.2.
export function parseDarwinTime(bytes){
  if(!Buffer.isBuffer(bytes))return unavailable('sidecar-not-bytes');
  if(bytes.length>RESOURCE_SIDECAR_LIMIT)return unavailable('sidecar-limit');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return unavailable('sidecar-invalid-utf8');}
  if(!text.endsWith('\n'))return unavailable('sidecar-partial');
  const values=new Map();
  for(const line of text.split('\n')){
    const key=/^\s*(real|user|sys)(?:\s|$)/.exec(line)?.[1]??(/\bmaximum resident set size\b/.test(line)?'maxRSS':null);
    if(!key)continue;
    if(values.has(key))return unavailable('sidecar-duplicate-field');
    const match=key==='maxRSS'?/^\s*([0-9]+)\s+maximum resident set size\s*$/.exec(line):/^\s*(?:real|user|sys)\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if(!match)return unavailable('sidecar-invalid-field');
    const number=Number(match[1]);
    if(!Number.isFinite(number)||number<0||(key==='maxRSS'&&!Number.isSafeInteger(number)))return unavailable('sidecar-invalid-number');
    values.set(key,number);
  }
  if(values.size!==4)return unavailable('sidecar-missing-field');
  return {availability:'available',elapsedSeconds:values.get('real'),userCpuSeconds:values.get('user'),systemCpuSeconds:values.get('sys'),maxResidentSetBytes:values.get('maxRSS'),cpuDisplayResolutionSeconds:0.01};
}

async function retainSidecar(filename){
  // O_NOFOLLOW plus a unique private directory prevents adopting a replacement
  // symlink. Bound both the retained raw file and memory even if its writer errs.
  let file;
  try{
    file=await open(filename,constants.O_RDWR|constants.O_NOFOLLOW);
    const info=await file.stat();
    if(!info.isFile()||info.nlink!==1)return {metrics:unavailable('sidecar-not-private-regular-file')};
    const raw=Buffer.alloc(Math.min(info.size,RESOURCE_SIDECAR_LIMIT));let offset=0;
    while(offset<raw.length){const {bytesRead}=await file.read(raw,offset,raw.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    const retained=raw.subarray(0,offset),truncated=info.size>RESOURCE_SIDECAR_LIMIT;
    if(truncated)await file.truncate(RESOURCE_SIDECAR_LIMIT);
    await file.chmod(0o600);
    const evidence={path:filename,bytes:retained.length,sha256:digest(retained),originalBytes:info.size,truncated};
    return {raw:evidence,metrics:truncated?unavailable('sidecar-limit'):offset!==info.size?unavailable('sidecar-partial-read'):parseDarwinTime(retained)};
  }catch(error){return {metrics:unavailable(`sidecar-read-${error.code??'error'}`)};}
  finally{await file?.close();}
}

/**
 * Spawn only an explicitly owned process in a new POSIX process group. Consumers
 * own stdout/stderr protocol parsing and output bounds; call stop(reason) on any
 * protocol/output failure, then await completed. The helper never accepts a PID.
 *
 * Resource collection is opt-in and Darwin-only. Its PID/exitCode/signal describe
 * /usr/bin/time when instrumented, NOT the Rust utility. A normal wrapper exit
 * still needs the caller's complete original protocol to establish success.
 *
 * Containment covers this detached process group, not descendants that escape it.
 * Completed reports unresolved cleanup rather than claiming those children died.
 */
export async function startOwnedMeasuredProcess({binary,args=[],cwd,env=process.env,sidecarDirectory,timeoutMs,termGraceMs=1000,drainGraceMs=1000,measureResources=false,stdin='ignore'}){
  assert.ok(typeof binary==='string'&&path.isAbsolute(binary),'absolute utility executable required');
  assert.ok(Array.isArray(args)&&args.every(arg=>typeof arg==='string'),'argument string array required');
  assert.ok(env&&typeof env==='object'&&!Array.isArray(env),'environment object required');
  // Admission inputs are owned before the first filesystem await.
  args=[...args];env={...env};
  assert.ok(process.platform!=='win32','owned POSIX process groups required');
  assert.ok(typeof measureResources==='boolean');
  boundedMs(timeoutMs,'timeoutMs');boundedMs(termGraceMs,'termGraceMs');boundedMs(drainGraceMs,'drainGraceMs');
  assert.ok(['ignore','pipe'].includes(stdin),'stdin must be ignore or pipe');
  let sidecar,provider;
  if(measureResources){
    assert.equal(process.platform,'darwin','resource collection currently supports Darwin only');
    assert.ok(typeof sidecarDirectory==='string'&&path.isAbsolute(sidecarDirectory),'absolute existing sidecarDirectory required');
    assert.ok((await stat(sidecarDirectory)).isDirectory());
    const directory=await mkdtemp(path.join(sidecarDirectory,'process-resources-'));await chmod(directory,0o700);
    sidecar=path.join(directory,'time.txt');const file=await open(sidecar,'wx',0o600);await file.close();
    provider={path:PROVIDER,sha256:digest(await readFile(PROVIDER))};
  }
  const command=measureResources?PROVIDER:binary,argv=measureResources?['-l','-p','-o',sidecar,binary,...args]:args;
  const started=performance.now();
  const child=spawn(command,argv,{cwd,env:measureResources?{...env,LC_ALL:'C'}:env,detached:true,stdio:[stdin,'pipe','pipe']});
  let resolveCompleted;
  const completed=new Promise(resolve=>{resolveCompleted=resolve;});
  const timers=new Set(),signals=[],pipeErrors=[];
  let finalized=false,exitObserved=false,exitCode=null,signal=null,spawnError,stopReason=null,timedOut=false,postKillExpired=false;
  let drainTimer;
  const pipes=new Map([['stdout',false],['stderr',false]]);
  const schedule=(callback,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);return timer;};
  const cancel=timer=>{if(timer){clearTimeout(timer);timers.delete(timer);}};
  const groupExists=()=>{
    if(!child.pid)return false;
    try{process.kill(-child.pid,0);return true;}catch(error){return error.code==='ESRCH'?false:null;}
  };
  const send=sentSignal=>{
    // Finalization is synchronous before async evidence IO. Late stop/timer calls
    // cannot signal an already settled group (or an eventually reused PID).
    if(finalized||!child.pid)return;
    const exists=groupExists();if(exists===false)return;
    try{process.kill(-child.pid,sentSignal);signals.push({signal:sentSignal,sent:true});}
    catch(error){signals.push({signal:sentSignal,sent:false,error:error.code??String(error)});}
  };
  const pipesDone=()=>[...pipes.values()].every(Boolean);
  const finalize=async()=>{
    if(finalized)return;finalized=true;
    for(const timer of timers)clearTimeout(timer);timers.clear();
    const processWallMs=performance.now()-started,ownedGroupRemaining=groupExists();
    const result={pid:child.pid??null,observedProcessRole:measureResources?'darwin-time-wrapper':'direct-utility',exitObserved,exitCode,signal,...(spawnError?{spawnError}:{}),wallMs:processWallMs,timedOut,stopReason,signals,
      pipesDrained:pipesDone()&&!postKillExpired,pipeErrors,cleanup:{groupContainment:'new detached POSIX process group only; escaped descendants are outside this claim',ownedGroupRemaining,postKillDrainExpired:postKillExpired},
      measurement:{mode:measureResources?'instrumented-darwin-time':'unmeasured',wallScope:measureResources?'Node-observed wrapper lifetime including time instrumentation overhead':'Node-observed direct utility lifetime',utility:binary,
        environment:{platform:process.platform,release:os.release(),version:os.version(),arch:process.arch},metrics:unavailable(measureResources?'pending':'not-requested')}};
    try{
      if(measureResources){
        const evidence=await retainSidecar(sidecar);
        const after=digest(await readFile(PROVIDER));result.measurement.provider={...provider,afterSha256:after,stable:provider.sha256===after};result.measurement.sidecar=evidence.raw;
        result.measurement.metrics=stopReason||!exitObserved||spawnError||signal||exitCode!==0||!result.pipesDrained?unavailable('process-incomplete-or-interrupted'):provider.sha256!==after?unavailable('provider-changed'):evidence.metrics;
        result.measurement.scope='utility lifetime including startup/loading/setup/output; CPU may include waited descendants; maxRSS is not an aggregate process-tree peak or peak memory footprint; inner engine timers are unchanged';
      }
    }catch(error){result.measurement.metrics=unavailable(`resource-evidence-${error.code??'error'}`);}
    resolveCompleted(result);
  };
  const maybeFinish=()=>{
    if(finalized)return;
    if(exitObserved&&pipesDone()){
      const remaining=groupExists();
      if(remaining===false)void finalize();
      else if(!stopReason)stop('remaining-owned-process-group');
    }
  };
  const postKill=()=>{
    if(finalized)return;
    postKillExpired=!(exitObserved&&pipesDone());
    // A killed wrapper or inherited pipe must never hang the harness forever.
    // Destroy only these owned streams; unresolved exit/group remains explicit.
    if(!pipesDone()){child.stdout.destroy();child.stderr.destroy();}
    child.stdin?.destroy();void finalize();
  };
  const stop=reason=>{
    if(finalized||stopReason)return completed;
    stopReason=String(reason??'caller-stop').slice(0,256)||'caller-stop';timedOut=stopReason==='timeout';
    cancel(drainTimer);send('SIGTERM');child.stdin?.destroy();child.stdout.resume();child.stderr.resume();
    schedule(()=>{
      if(finalized)return;send('SIGKILL');maybeFinish();
      if(!finalized)schedule(postKill,drainGraceMs);
    },termGraceMs);
    maybeFinish();return completed;
  };
  for(const [name,stream]of [['stdout',child.stdout],['stderr',child.stderr]]){
    const mark=()=>{pipes.set(name,true);maybeFinish();};
    stream.once('end',mark);
    stream.once('close',()=>{
      if(!stream.readableEnded&&!finalized&&!spawnError&&!postKillExpired){pipeErrors.push(`${name}-closed-before-end`);stop('output-stream-closed');}
      mark();
    });
    stream.once('error',error=>{pipeErrors.push(`${name}: ${error.code??error.message}`);stop('output-stream-error');});
  }
  child.stdin?.once('error',error=>{pipeErrors.push(`stdin: ${error.code??error.message}`);stop('input-stream-error');});
  child.once('error',error=>{
    spawnError=String(error);exitObserved=true;exitCode=null;signal=null;
    // A spawn failure has no process group; close events settle its streams.
    if(!child.pid){child.stdout.resume();child.stderr.resume();}
    else stop('child-process-error');
    maybeFinish();
  });
  child.once('exit',(code,exitSignal)=>{
    exitObserved=true;exitCode=code;signal=exitSignal;
    if(exitSignal)stop('observed-process-signalled');
    maybeFinish();
    if(!finalized&&!pipesDone()&&!stopReason)drainTimer=schedule(()=>stop('inherited-or-undrained-pipes'),drainGraceMs);
  });
  child.once('close',()=>maybeFinish());
  schedule(()=>stop('timeout'),timeoutMs);
  return {pid:child.pid??null,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,stop,completed};
}
