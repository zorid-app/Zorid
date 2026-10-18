#!/usr/bin/env node
// Explicit actual Electron integration target. Never launches during import or
// syntax checks. Missing readiness/HEAD/artifacts are failures, never passing skips.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CDP,delay,until} from './cdp.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const requireArg=name=>{const value=arg(name);assert.ok(value,`Explicit ${name} required`);return value;};
const root=path.resolve(requireArg('--root')),expectedHead=requireArg('--expected-head');
const native=path.resolve(requireArg('--native')),electron=path.resolve(requireArg('--electron'));
const out=path.resolve(requireArg('--out'));
assert.equal(arg('--ready'),'native-and-frontend-frozen','Coordinator must explicitly supply matching native/frontend readiness');
assert.match(expectedHead,/^[0-9a-f]{40}$/);
const ownDirectory=path.dirname(fileURLToPath(import.meta.url));
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:4*1024*1024});
async function sha(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function tree(directory){const result=[];async function walk(relative=''){for(const entry of (await fs.readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(relative,entry.name);if(entry.isSymbolicLink())throw Error('Artifact symlink rejected: '+name);if(entry.isDirectory())await walk(name);else if(entry.isFile())result.push([name,await sha(path.join(directory,name))]);}}await walk();return result;}
async function provenance(){
  assert.equal(git('rev-parse','HEAD').trim(),expectedHead,'Frozen integration HEAD changed');
  assert.equal(git('diff','--name-only','HEAD').trim(),'','Tracked integration files changed');
  const names=git('ls-files','-z','desktop','src','crates','scripts','Cargo.toml','Cargo.lock','package.json','pnpm-lock.yaml','vite.config.mjs','index.html').split('\0').filter(Boolean).sort();
  const files=[];for(const name of names)files.push([name,await sha(path.join(root,name))]);
  return{head:expectedHead,tracked:files,dist:await tree(path.join(root,'dist')),native:{file:native,sha256:await sha(native)},electron:{file:electron,sha256:await sha(electron)},harness:{file:ownDirectory,files:await tree(ownDirectory)}};
}
assert.ok(!out.startsWith(root+path.sep)&&!out.startsWith(ownDirectory+path.sep),'Evidence output must be outside source/artifact trees');
await fs.mkdir(out,{recursive:true});
const evidence={kind:'actual-electron-bridge-storage-subset',status:'running',started:new Date().toISOString(),groups:[],passes:[],remaining:['Calendar rendered UI acceptance','multi-client encrypted convergence','mobile/browser runtime parity'],limitations:['Raw existing preload semantic API exercised; no Calendar UI instrumentation','Explicit durable release tested; process termination recorded separately from UI-close acceptance']};
let sandbox,child,cdp,before,failure;
const runtime=[],nativeChildren=new Map();
const processTable=()=>execFileSync('ps',['-ww','-axo','pid=,ppid=,command='],{encoding:'utf8',maxBuffer:4*1024*1024}).split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match?{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}:null;}).filter(Boolean);
function observeNative(){
  if(!child||!sandbox)return [];
  const observed=processTable().filter(row=>row.parent===child.pid&&row.command.startsWith(native+' --vault '+path.join(sandbox,'vault')));
  for(const row of observed)nativeChildren.set(row.pid,row);return observed;
}
const exited=()=>!child||child.exitCode!==null||child.signalCode!==null;
async function stop(){
  if(child)observeNative();
  cdp?.close();cdp=undefined;
  if(!child)return;
  const result={pid:child.pid,method:'already-exited'};
  if(!exited()){
    result.method='SIGTERM-owned-process';child.kill('SIGTERM');
    const end=Date.now()+5000;while(!exited()&&Date.now()<end)await delay(100);
    if(!exited()){result.method='SIGKILL-owned-process-after-deadline';child.kill('SIGKILL');await until(async()=>{assert.ok(exited());},5000);}
  }
  result.exitCode=child.exitCode;result.signal=child.signalCode;
  const children=[...nativeChildren.values()];
  const remaining=()=>{const rows=processTable();return children.filter(owned=>rows.some(row=>row.pid===owned.pid&&row.command===owned.command));};
  const end=Date.now()+5000;while(remaining().length&&Date.now()<end)await delay(100);
  const leaked=remaining();result.nativeChildren=children;result.nativeChildrenExited=leaked.length===0;
  for(const owned of leaked){process.kill(owned.pid,'SIGKILL');}
  runtime.push({shutdown:result});nativeChildren.clear();child=undefined;
  assert.equal(leaked.length,0,'Owned native child survived app exit; force-cleaned, runtime proof failed');
}
async function launch(pass){
  assert.ok(!child,'Previous owned app must close first');
  const profile=path.join(sandbox,'profile');await fs.rm(path.join(profile,'DevToolsActivePort'),{force:true});
  // Electron's supported Chromium profile switch also isolates its single-instance
  // lock. vault.json seeds only the normal launcher's existing recent-vault flow.
  const environment={...process.env,ZORID_DESKTOP_HOST_BIN:native};
  for(const key of ['ELECTRON_RUN_AS_NODE','ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_EDITOR_RUST','ZORID_FIXTURE_VAULT','ZORID_FIXTURE_SYNC_CONFIG','ZORID_FIXTURE_CLIENT_ID'])delete environment[key];
  const record={pass,stdout:'',stderr:'',events:[]};runtime.push(record);
  child=spawn(electron,[path.join(root,'desktop/main.cjs'),'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']});
  let spawnError;child.on('error',error=>{spawnError=error;});
  for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>{if(record[stream].length<128000)record[stream]+=bytes.toString();});
  const port=await until(async()=>{
    if(spawnError)throw spawnError;assert.ok(!exited(),'Owned Electron exited before debugger: '+record.stderr);
    let value;try{value=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{value=record.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];}assert.match(value,/^[1-9][0-9]{0,4}$/);return value;
  },30000);
  const target=await until(async()=>{const targets=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(reply=>reply.json());const target=targets.find(value=>value.type==='page'&&value.url.startsWith('file:')&&value.url.includes('/dist/index.html'));assert.ok(target,'Normal application page not ready');return target;},30000);
  cdp=new CDP(target.webSocketDebuggerUrl);record.pid=child.pid;record.url=target.url;
  await cdp.call('Runtime.enable');await cdp.call('Log.enable');await cdp.call('Page.enable');
  await until(async()=>{const value=await cdp.evaluate('Boolean(window.zorid&&document.querySelector(".workspace"))');assert.equal(value,true,'Normal Workspace not ready');},30000);
  const admitted=await cdp.evaluate(`(async()=>{const vault=await window.zorid.getVault();if(!vault)throw Error('No normal selected vault');const context=await window.zorid.getDurableContext(vault.path);window.__workblockProof={vault,context};return {vault,context};})()`);
  assert.equal(admitted.vault.path,path.join(sandbox,'vault'),'Owned profile must select only owned vault');
  assert.equal(admitted.context.workBlocks,true,'Matched native/renderer capability absent');
  record.admission=admitted;record.nativeChildren=observeNative();assert.equal(record.nativeChildren.length,1,'Exactly one actual owned Rust native child required');return record;
}
async function command(op,input){
  const request={schemaVersion:1,command:{op,...input}};
  const result=await cdp.evaluate(`(async()=>{const {vault,context}=window.__workblockProof;try{return {ok:true,value:await window.zorid.durableInvoke(vault.path,context.admissionId,'workblockCommand',[${JSON.stringify(request)}])};}catch(error){return {ok:false,error:{code:error.code,commitUncertain:error.commitUncertain,message:error.message}};}})()`);
  evidence.passes.push({request,...result});assert.equal(result.ok,true,JSON.stringify(result));return result.value;
}
function readShape(value,target){assert.equal(value.record,target.record);assert.equal(value.generation,target.generation);assert.equal(value.revision.length,32);assert.ok(value.revision.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<256));assert.equal(value.created,true);assert.equal(value.deleted,false);assert.ok(value.block);}
async function releaseAndReject(record,target){
  assert.equal(cdp.events.filter(event=>event.method==='Runtime.exceptionThrown').length,0,'Unexpected renderer exception before release');
  const value=await cdp.evaluate(`(async()=>{const {vault,context}=window.__workblockProof;await window.zorid.releaseDurableContext(vault.path,context.admissionId);try{await window.zorid.durableInvoke(vault.path,context.admissionId,'workblockCommand',[${JSON.stringify({schemaVersion:1,command:{op:'read',...target}})}]);return {accepted:true};}catch(error){return {accepted:false,code:error.code,commitUncertain:error.commitUncertain};}})()`);
  assert.equal(value.accepted,false);assert.equal(value.code,'durable_scope_changed');record.released=value;
  record.events=cdp.events;
}
try{
  for(const filename of [native,electron,path.join(root,'dist/index.html')]){const stat=await fs.stat(filename);assert.ok(stat.isFile(),'Required real artifact: '+filename);}
  before=await provenance();await fs.writeFile(path.join(out,'provenance-before.json'),JSON.stringify(before,null,2));
  sandbox=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-workblock-electron-')));const vault=path.join(sandbox,'vault'),profile=path.join(sandbox,'profile');
  await fs.mkdir(vault);await fs.mkdir(profile);await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}));
  // No CLI/backend creates WorkBlocks; only the actual admitted renderer API does.
  const target={record:'electron-block-'+randomUUID(),generation:'generation-'+randomUUID()};
  const original={...target,operation:target.generation,range:{start_ms:'253402300800000',end_ms:'253402300801000',timezone:'America/Toronto'},title:'Electron 😀 original'};
  evidence.target=target;const first=await launch('create-edit-release');
  const negatives=await cdp.evaluate(`(async()=>{const {vault,context}=window.__workblockProof;const result=[];for(const [root,admission,request] of [[vault.path+'-stale',context.admissionId,{schemaVersion:1,command:{op:'read',...${JSON.stringify(target)}}}],[vault.path,'revoked-admission',{schemaVersion:1,command:{op:'read',...${JSON.stringify(target)}}}],[vault.path,context.admissionId,{schemaVersion:1,command:{op:'read',...${JSON.stringify(target)},owner:'forbidden'}}]]){try{await window.zorid.durableInvoke(root,admission,'workblockCommand',[request]);result.push({accepted:true});}catch(error){result.push({accepted:false,code:error.code,commitUncertain:error.commitUncertain});}}return result;})()`);
  assert.deepEqual(negatives.map(value=>value.code),['durable_scope_changed','durable_scope_changed','invalid_workblock_request']);assert.ok(negatives.every(value=>value.accepted===false));evidence.admissionNegatives=negatives;
  const created=await command('create',original);assert.equal(created.operation,original.operation);assert.match(created.sequence,/^[1-9][0-9]*$/);
  let read=await command('read',target);readShape(read,target);assert.deepEqual(read.revision,created.revision);assert.deepEqual(read.block.ranges[0].range,original.range);
  const move={...target,operation:'move-'+randomUUID(),expectedRevision:read.revision,range:{start_ms:'253402300802000',end_ms:'253402300803000',timezone:'America/Toronto'}};
  await command('move',move);read=await command('read',target);assert.deepEqual(read.block.ranges[0].range,move.range);
  const title={...target,operation:'title-'+randomUUID(),expectedRevision:read.revision,title:'Electron 😀 persisted'};
  await command('title',title);read=await command('read',target);assert.equal(read.block.titles[0].title,title.title);
  const ref={...target,operation:'ref-'+randomUUID(),expectedRevision:read.revision,task:'stable_task_reference'};
  await command('add_ref',ref);read=await command('read',target);assert.deepEqual(read.block.taskRefs,[ref.task]);
  const remove={...target,operation:'unref-'+randomUUID(),expectedRevision:read.revision,task:ref.task};
  await command('remove_ref',remove);read=await command('read',target);assert.deepEqual(read.block.taskRefs,[]);
  const beforeReplay=await command('changes',{after:'0',limit:64});
  const replay=await command('create',original);assert.deepEqual(replay,created,'Original immutable receipt after later edits');
  assert.deepEqual(await command('changes',{after:'0',limit:64}),beforeReplay,'Replay creates no duplicate durable change');
  assert.deepEqual(await command('read',target),read,'Replay cannot revert later state');
  const window=await command('window',{fromMs:move.range.start_ms,untilMs:move.range.end_ms,limit:64,byteLimit:1048576});assert.deepEqual(window.blocks.map(b=>b.record),[target.record]);assert.equal(window.incomplete,false);
  evidence.persisted=read;evidence.originalReceipt=created;evidence.groups.push('actual-preload-create-read-move-title-add-remove-ref-identical-create-replay');
  await releaseAndReject(first,target);await stop();
  const second=await launch('reopen-read-replay');
  const reopened=await command('read',target);assert.deepEqual(reopened,evidence.persisted,'SQLite state survives actual Electron/native restart');
  const changes=await command('changes',{after:'0',limit:64});assert.deepEqual(await command('create',original),created,'Original receipt survives process restart');
  assert.deepEqual(await command('changes',{after:'0',limit:64}),changes,'Restart replay has no duplicate write');
  assert.deepEqual(await command('read',target),reopened);
  evidence.groups.push('actual-process-reopen-read-original-receipt-no-duplicate-write');
  // Deliberately abandon the controller's observation after real renderer
  // dispatch. No mock error/receipt is injected and no outcome is inferred.
  // This is observer interruption, not proof of a dropped native stdio frame.
  const unknown={...target,operation:'observer-unknown-'+randomUUID(),expectedRevision:reopened.revision,title:'Observer retry 😀'};
  evidence.uncertainRequest=unknown;evidence.beforeObserverChanges=changes;
  const started=await cdp.evaluate(`(()=>{const {vault,context}=window.__workblockProof;window.__unobservedWorkBlock=window.zorid.durableInvoke(vault.path,context.admissionId,'workblockCommand',[${JSON.stringify({schemaVersion:1,command:{op:'title',...unknown}})}]).then(()=>true,()=>false);return {dispatched:true};})()`);
  assert.equal(started.dispatched,true);second.events=cdp.events;await stop();
  const third=await launch('observer-interruption-identical-retry');
  evidence.observedAfterInterruption=await command('read',target);
  const recovered=await command('title',unknown);evidence.observerRecoveryReceipt=recovered;
  const afterUnknown=await command('changes',{after:'0',limit:64});assert.equal(afterUnknown.changes.length,changes.changes.length+1,'Interrupted observer has exactly one durable write');
  assert.deepEqual(await command('title',unknown),recovered);assert.deepEqual(await command('changes',{after:'0',limit:64}),afterUnknown);
  const finalRead=await command('read',target);assert.equal(finalRead.block.titles[0].title,unknown.title);assert.deepEqual(finalRead.revision,recovered.revision);
  evidence.groups.push('actual-observer-interruption-identical-request-replay-one-durable-write');
  await releaseAndReject(third,target);await stop();
  const after=await provenance();assert.deepEqual(after,before,'Source/artifacts changed during pass; evidence invalid');await fs.writeFile(path.join(out,'provenance-after.json'),JSON.stringify(after,null,2));
  evidence.status='passed-subset';
}catch(error){failure=error;evidence.status='failed';evidence.error={message:error.message,stack:error.stack};}
finally{
  await stop().catch(error=>{evidence.cleanupError=error.message;failure??=error;});
  if(sandbox)await fs.rm(sandbox,{recursive:true,force:true}).catch(error=>{evidence.cleanupError=error.message;failure??=error;});
  evidence.finished=new Date().toISOString();evidence.runtime=runtime;
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(evidence,null,2));
}
if(failure){console.error(failure.stack);process.exitCode=1;}else console.log('PASS actual Electron bridge/storage subset: '+out);
