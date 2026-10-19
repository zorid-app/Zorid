import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {parseDarwinTime,RESOURCE_SIDECAR_LIMIT,startOwnedMeasuredProcess} from './process-resources.mjs';

const raw=(replace={})=>Buffer.from(Object.entries({real:'0.03',user:'0.01',sys:'0.00',...replace}).map(([key,value])=>`${key} ${value}\n`).join('')+'           123456  maximum resident set size\n           999999  peak memory footprint\n');
const unavailable=value=>assert.equal(parseDarwinTime(value).availability,'unavailable');
test('Darwin parser keeps byte RSS and zero CPU distinct from missing stats',()=>{
  assert.deepEqual(parseDarwinTime(raw()),{availability:'available',elapsedSeconds:0.03,userCpuSeconds:0.01,systemCpuSeconds:0,maxResidentSetBytes:123456,cpuDisplayResolutionSeconds:0.01});
  assert.equal(parseDarwinTime(raw()).maxResidentSetBytes,123456,'do not substitute peak memory footprint or multiply by1024');
  unavailable(Buffer.alloc(0));unavailable(Buffer.from('real 0.00\nuser 0.00\nsys 0.00\n'));unavailable('real 0');
});
test('Darwin parser rejects every duplicate promoted field',()=>{
  for(const addition of ['real 1.00\n','user 0.00\n','sys 0.00\n','  1 maximum resident set size\n'])unavailable(Buffer.concat([raw(),Buffer.from(addition)]));
});
test('Darwin parser rejects missing, invalid, negative, nonfinite and overflow fields',()=>{
  for(const key of ['real','user','sys']){
    for(const value of ['-1','-0','NaN','Infinity','1e309','1,01','1.00 extra', '9'.repeat(400),''])unavailable(raw({[key]:value}));
    unavailable(Buffer.from(raw().toString().replace(new RegExp(`^${key}[^\\n]*\\n`,'m'),'')));
  }
  for(const value of ['-1','-0','NaN','Infinity','1.2','9007199254740992','9'.repeat(400)])unavailable(Buffer.from(raw().toString().replace('123456',value)));
});
test('Darwin parser rejects partial, oversized and invalid UTF8 raw evidence',()=>{
  unavailable(raw().subarray(0,-1));unavailable(Buffer.alloc(RESOURCE_SIDECAR_LIMIT+1));unavailable(Buffer.concat([raw(),Buffer.from([0xff,0x0a])]));
  const padded=Buffer.concat([raw(),Buffer.alloc(RESOURCE_SIDECAR_LIMIT-raw().length-1,0x20),Buffer.from('\n')]);assert.equal(parseDarwinTime(padded).availability,'available');
});

// Explicit coordinator resource slot is required to enable these actual child/
// time executions. Defaults run parser checks only; no synthetic timings sneak
// into an active platform measurement slot. These tests are not Rust benchmarks.
const runtime={skip:process.env.ZORID_PROCESS_RESOURCES_RUNTIME_TESTS!=='1'||process.platform!=='darwin',concurrency:false};
async function collect(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}
async function fixture(run){const directory=await mkdtemp(path.join(os.tmpdir(),'zorid-process-resources-test-'));try{return await run(directory);}finally{await rm(directory,{recursive:true,force:true});}}
async function start(directory,script,options={}){
  return startOwnedMeasuredProcess({binary:process.execPath,args:['-e',script],timeoutMs:3000,termGraceMs:50,drainGraceMs:100,sidecarDirectory:directory,measureResources:true,...options});
}
async function outcome(handle){const streams=Promise.all([collect(handle.stdout),collect(handle.stderr)]);const result=await handle.completed;const [stdout,stderr]=await streams;return {result,stdout:stdout.toString(),stderr:stderr.toString()};}

test('opt-in time preserves utility output, private bounded evidence and provider fence',runtime,()=>fixture(async directory=>{
  const {result,stdout,stderr}=await outcome(await start(directory,"process.stdout.write('out');process.stderr.write('err');"));
  assert.equal(stdout,'out');assert.equal(stderr,'err');assert.equal(result.exitCode,0);assert.equal(result.signal,null);assert.equal(result.exitObserved,true);assert.equal(result.pipesDrained,true);assert.equal(result.stopReason,null);assert.deepEqual(result.signals,[]);
  assert.equal(result.observedProcessRole,'darwin-time-wrapper');assert.equal(result.measurement.mode,'instrumented-darwin-time');assert.equal(result.measurement.provider.path,'/usr/bin/time');assert.equal(result.measurement.provider.stable,true);assert.equal(result.measurement.metrics.availability,'available');
  const sidecar=result.measurement.sidecar,bytes=await readFile(sidecar.path);assert.ok(bytes.length<=RESOURCE_SIDECAR_LIMIT);assert.equal(sidecar.bytes,bytes.length);assert.equal(sidecar.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal((await stat(sidecar.path)).mode&0o777,0o600);assert.equal((await stat(path.dirname(sidecar.path))).mode&0o777,0o700);
}));
test('unmeasured direct utility stays explicitly unmeasured and late stop sends nothing',runtime,()=>fixture(async directory=>{
  const handle=await start(directory,"process.stdout.write('direct')",{measureResources:false});const {result,stdout}=await outcome(handle);assert.equal(stdout,'direct');assert.equal(result.observedProcessRole,'direct-utility');assert.deepEqual(result.measurement.metrics,{availability:'unavailable',reason:'not-requested'});assert.equal(handle.stop('too-late'),handle.completed);assert.deepEqual(result.signals,[]);
}));
test('nonzero wrapper exit stays nonzero and does not become successful stats',runtime,()=>fixture(async directory=>{
  const {result}=await outcome(await start(directory,'process.exitCode=7'));assert.equal(result.exitCode,7);assert.equal(result.signal,null);assert.equal(result.stopReason,null);assert.equal(result.measurement.metrics.availability,'unavailable');
}));
test('timeout escalates only the owned group and repeated stop is idempotent',runtime,()=>fixture(async directory=>{
  const handle=await start(directory,"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",{timeoutMs:250});const pending=outcome(handle);const {result}=await pending;
  assert.equal(result.timedOut,true);assert.equal(result.stopReason,'timeout');assert.equal(result.measurement.metrics.availability,'unavailable');assert.ok(result.signals.some(s=>s.signal==='SIGTERM'));assert.ok(result.signals.some(s=>s.signal==='SIGKILL'));assert.equal(handle.stop('late'),handle.completed);assert.equal(handle.stop('later'),handle.completed);
}));
test('caller protocol failure stops owned execution without rewriting observed signal',runtime,()=>fixture(async directory=>{
  const handle=await start(directory,"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)");const stderr=collect(handle.stderr);await new Promise(resolve=>handle.stdout.once('data',resolve));
  const first=handle.stop('');assert.equal(first,handle.stop('second-reason'));const result=await first;await stderr;assert.equal(result.stopReason,'caller-stop');assert.equal(result.measurement.metrics.availability,'unavailable');assert.equal(result.observedProcessRole,'darwin-time-wrapper');assert.ok(result.signals.length<=2);
}));
test('wrapper killed by utility preserves wrapper signal and cleans inherited utility pipes',runtime,()=>fixture(async directory=>{
  const handle=await start(directory,"process.on('SIGTERM',()=>{});process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000)");const {result}=await outcome(handle);
  assert.equal(result.signal,'SIGKILL');assert.equal(result.exitCode,null);assert.equal(result.stopReason,'observed-process-signalled');assert.equal(result.measurement.metrics.availability,'unavailable');assert.ok(result.signals.some(s=>s.signal==='SIGKILL'));
}));
test('normal wrapper exit with inherited pipes has bounded group cleanup',runtime,()=>fixture(async directory=>{
  const script="require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore',1,2]});process.exit(0)";
  const {result}=await outcome(await start(directory,script));assert.equal(result.exitCode,0);assert.equal(result.signal,null);assert.equal(result.stopReason,'inherited-or-undrained-pipes');assert.equal(result.measurement.metrics.availability,'unavailable');assert.ok(result.signals.some(s=>s.signal==='SIGKILL'));
}));
test('direct spawn failure settles without signalling an arbitrary process',runtime,()=>fixture(async directory=>{
  const handle=await startOwnedMeasuredProcess({binary:path.join(directory,'missing'),args:[],timeoutMs:1000});const {result}=await outcome(handle);assert.ok(result.spawnError);assert.equal(result.pid,null);assert.deepEqual(result.signals,[]);assert.equal(result.measurement.metrics.availability,'unavailable');
}));

test('normal wrapper cannot silently leave same-group descendants with closed pipes',runtime,()=>fixture(async directory=>{
  const script="const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});child.unref();process.stdout.write(String(child.pid));";
  const {result,stdout}=await outcome(await start(directory,script));const descendant=Number(stdout);assert.ok(Number.isSafeInteger(descendant)&&descendant>0);assert.equal(result.exitCode,0);assert.equal(result.stopReason,'remaining-owned-process-group');assert.equal(result.measurement.metrics.availability,'unavailable');assert.ok(result.signals.some(s=>s.signal==='SIGTERM'));
  let alive;try{process.kill(descendant,0);alive=true;}catch(error){assert.equal(error.code,'ESRCH');alive=false;}assert.ok(!alive||result.cleanup.ownedGroupRemaining!==false,'live descendant must not be reported gone');
}));
