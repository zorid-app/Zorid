#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {assessFloor,fixtureText,FLOOR_LABEL} from './oracle.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,'../..');
const option=(name,fallback)=>{const index=process.argv.indexOf(name);return index<0?fallback:process.argv[index+1];};
const deps=path.resolve(option('--deps','/Users/ctk/Projects/Zorid/.worktrees/bases-edit-performance/node_modules'));
const out=path.resolve(option('--out',`/private/tmp/zorid-editor-floor-${Date.now()}-${randomUUID().slice(0,8)}`));
assert.ok(out.startsWith('/private/tmp/zorid-editor-floor-'),'Only an owned temporary output root is allowed');
const sizes=option('--sizes','ordinary,0.5,5').split(',').map(value=>value==='ordinary'?8192:Number(value)*1024*1024);
assert.ok(sizes.every(value=>[8192,524288,5242880,52428800].includes(value)),'Sizes: ordinary,0.5,5,50 (MiB)');
assert.ok(!sizes.includes(52428800)||process.argv.includes('--allow-50mb'),'50 MiB needs its separate bounded run and memory inspection');
const modes=option('--modes','normal-reopen,first-folder-selection').split(',');assert.ok(modes.every(mode=>['normal-reopen','first-folder-selection'].includes(mode)));
const deadlineMs=800,timeoutMs=Number(option('--timeout-ms','15000')),diagnosticMs=Number(option('--diagnostic-ms','1800'));
assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=4000&&timeoutMs<=60000);assert.ok(Number.isSafeInteger(diagnosticMs)&&diagnosticMs>=250&&diagnosticMs<=5000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=value=>createHash('sha256').update(value).digest('hex'),hashFile=async file=>hash(await fs.readFile(file));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sourceNames=git('ls-files','src','desktop').split('\n').filter(Boolean);
assert.equal(git('diff','--name-only','HEAD','--','src','desktop','package.json','package-lock.json'),'','Production inputs must be unchanged');
const productionPin=async()=>{const rows=[];for(const name of sourceNames)rows.push([name,await hashFile(path.join(root,name))]);return{sha256:hash(JSON.stringify(rows)),files:rows};};
async function treePins(folder,prefix=''){const rows=[];for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(entry.name==='node_modules')continue;const name=path.join(prefix,entry.name),file=path.join(folder,entry.name);if(entry.isDirectory())rows.push(...await treePins(file,name));else if(entry.isFile())rows.push([name,await hashFile(file)]);}return rows.sort((a,b)=>a[0].localeCompare(b[0]));}
await fs.mkdir(out,{recursive:false,mode:0o700});
const report={version:1,label:FLOOR_LABEL,floorOnly:true,out,head:git('rev-parse','HEAD'),started:new Date().toISOString(),production:await productionPin(),harness:await treePins(directory),cases:[],errors:[],limitations:[
 'No production Workspace, vault, Rust core, import, metadata, recovery, real-file write authority, or sync is exercised.',
 'Actual production createEditor runs in live mode with Base/embed extension slots enabled; declared plain Markdown fixtures contain no embeds, tables, math or databases.',
 'The fixture journal append/fsync/readback acknowledgment is independent test I/O, not a production save or a power-loss durability proof.',
 'Normal reopen clock starts immediately before process spawn. First folder-selection clock starts at an owned preconfigured fixture selection acknowledgment; human/OS dialog interaction is not measured.',
 'One earliest-ready trusted key probe and one separately scheduled 800 ms key probe; no deadline probe retries. Earliest applied input is the <=800 ms target. Deadline probe dispatch lateness and latency remain visible.',
 'First viewport uses exact document length/prefix and two animation frames; complete-body hashes run after the deadline. Filesystem cache is uncontrolled; process-cold does not mean disk-cold.',
]};
const save=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await save();
let child,activeExit,ownedApp;
function ownedProcesses(){
 if(!ownedApp)return[];
 return execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(.*)$/.exec(line);return match&&match[2].startsWith(ownedApp+'/Contents/')?[{pid:Number(match[1]),command:match[2]}]:[];});
}
async function cleanOwnedProcesses(){
 const end=Date.now()+2000;while(ownedProcesses().length&&Date.now()<end)await sleep(25);
 const remaining=ownedProcesses();let forced=false;
 for(const row of remaining){if(ownedProcesses().some(current=>current.pid===row.pid)){forced=true;process.kill(row.pid,'SIGTERM');}}
 if(forced){await sleep(1000);for(const row of ownedProcesses())process.kill(row.pid,'SIGKILL');await sleep(250);}
 return{gone:ownedProcesses().length===0,forced,remaining:ownedProcesses()};
}
try{
 const version=JSON.parse(await fs.readFile(path.join(deps,'electron/package.json'),'utf8')).version;assert.equal(version,'44.9.1');
 const runtime=path.join(deps,'electron/dist/Electron.app'),originalExecutable=path.join(runtime,'Contents/MacOS/Electron'),framework=path.join(runtime,'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
 report.runtime={version,path:runtime,executableSha256:await hashFile(originalExecutable),frameworkSha256:await hashFile(framework)};
 const packageRoot=path.join(out,'package'),rendererOut=path.join(packageRoot,'renderer');await fs.mkdir(packageRoot);
 const {build}=await import(pathToFileURL(path.join(deps,'vite/dist/node/index.js')).href);
 const previous=process.env.ZORID_EDITOR_FLOOR_RENDERER_OUT;process.env.ZORID_EDITOR_FLOOR_RENDERER_OUT=rendererOut;
 try{await build({configFile:path.join(directory,'vite.config.mjs'),configLoader:'native',cacheDir:path.join(out,'vite-cache'),mode:'native'});}finally{if(previous===undefined)delete process.env.ZORID_EDITOR_FLOOR_RENDERER_OUT;else process.env.ZORID_EDITOR_FLOOR_RENDERER_OUT=previous;}
 for(const name of ['electron-main.cjs','preload.cjs'])await fs.copyFile(path.join(directory,name),path.join(packageRoot,name));
 await fs.writeFile(path.join(packageRoot,'package.json'),JSON.stringify({name:'zorid-editor-floor',version:'1.0.0',main:'electron-main.cjs'}));
 const app=ownedApp=path.join(out,'EditorFloor.app');execFileSync('/bin/cp',['-cR',runtime,app]);
 await fs.rm(path.join(app,'Contents/Resources/default_app.asar'),{force:true});
 const {createPackage}=await import(pathToFileURL(path.join(deps,'@electron/asar/lib/asar.js')).href);
 const asar=path.join(app,'Contents/Resources/app.asar');await createPackage(packageRoot,asar);
 const executable=path.join(app,'Contents/MacOS/EditorFloor');await fs.rename(path.join(app,'Contents/MacOS/Electron'),executable);
 const info=path.join(app,'Contents/Info.plist');for(const [key,value] of [['CFBundleExecutable','EditorFloor'],['CFBundleName','Zorid Editor Floor'],['CFBundleDisplayName','Zorid Editor Floor'],['CFBundleIdentifier','app.zorid.editor-floor']])execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,info]);
 assert.equal(await hashFile(executable),report.runtime.executableSha256);assert.equal(await hashFile(path.join(app,'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')),report.runtime.frameworkSha256);
 report.package={app,asarSha256:await hashFile(asar),rendererFiles:await treePins(rendererOut)};await save();
 if(process.argv.includes('--build-only')){report.buildOnly=true;await save();process.stdout.write(JSON.stringify({out,buildOnly:true,package:report.package})+'\n');process.exit(0);}
 if(sizes.includes(52428800)){
  const memory=execFileSync('/usr/bin/vm_stat',[],{encoding:'utf8'}),page=Number(/page size of (\d+) bytes/.exec(memory)?.[1]??4096);
  const pages=name=>Number(new RegExp(name+':\\s+(\\d+)').exec(memory)?.[1]??0),available=(pages('Pages free')+pages('Pages inactive')+pages('Pages speculative'))*page;
  report.memoryBefore50={raw:memory,availableEstimate:available};assert.ok(available>=1536*1024*1024,'Less than 1.5 GiB free/inactive/speculative estimate; do not launch 50 MiB');
 }
 for(const bytes of sizes)for(const mode of modes){
  const caseDirectory=path.join(out,`${bytes}-${mode}`),profile=path.join(caseDirectory,'profile');await fs.mkdir(caseDirectory);await fs.mkdir(profile);
  const text=fixtureText(bytes),fixturePath=path.join(caseDirectory,'Fixture.md'),sha256=hash(text),caret=text.indexOf('first paragraph');await fs.writeFile(fixturePath,text,{flag:'wx',mode:0o600});
  const config={directory:caseDirectory,profile,mode,deadlineMs,timeoutMs,diagnosticMs,electronVersion:version,fixture:{id:'fixture-'+sha256,path:fixturePath,bytes,sha256,caret,prefix:text.slice(0,96)}};await fs.writeFile(path.join(caseDirectory,'case.json'),JSON.stringify(config),{mode:0o600});
  const record={bytes,mode,directory:caseDirectory,spawnEpoch:null,forced:false,stdout:'',stderr:''};report.cases.push(record);await save();
  record.spawnEpoch=Date.now();const env={...process.env,ZORID_EDITOR_FLOOR_CASE:path.join(caseDirectory,'case.json'),ZORID_EDITOR_FLOOR_SPAWN_EPOCH:String(record.spawnEpoch)};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(executable,['--user-data-dir='+profile],{cwd:out,env,stdio:['ignore','pipe','pipe']});record.pid=child.pid;process.stdout.write(JSON.stringify({event:'case-start',pid:child.pid,bytes,mode,out:caseDirectory})+'\n');
  child.stdout.on('data',chunk=>{record.stdout=(record.stdout+chunk.toString()).slice(-100000);});child.stderr.on('data',chunk=>{record.stderr=(record.stderr+chunk.toString()).slice(-100000);});
  let done=false;const exited=activeExit=new Promise(resolve=>{child.once('exit',(code,signal)=>{done=true;record.exitCode=code;record.signal=signal;resolve();});child.once('error',error=>{record.launchError=error.message;done=true;resolve();});});
  const end=Date.now()+timeoutMs+5000;while(!done&&Date.now()<end)await sleep(25);
  if(!done){record.forced=true;child.kill('SIGTERM');await Promise.race([exited,sleep(1500)]);if(!done){child.kill('SIGKILL');await exited;}}
  await exited;child=undefined;activeExit=undefined;record.cleanup=await cleanOwnedProcesses();record.ownedProcessesGone=record.cleanup.gone;record.forced||=record.cleanup.forced;
  await fs.writeFile(path.join(caseDirectory,'stdout.log'),record.stdout);await fs.writeFile(path.join(caseDirectory,'stderr.log'),record.stderr);
  let observed={};try{observed=JSON.parse(await fs.readFile(path.join(caseDirectory,'app-report.json'),'utf8'));}catch(error){record.reportError=error.message;}
  record.observed=observed;record.normalExit=!record.forced&&record.exitCode===0&&record.signal===null&&observed.normalQuitObserved===true;assert.equal(await hashFile(fixturePath),sha256,'Immutable input fixture changed');
  const inputOrder=(observed.probes??[]).slice().sort((a,b)=>a.sequence-b.sequence),edited=text.slice(0,caret)+inputOrder.map(probe=>probe.insert).join('')+text.slice(caret);
  const validationErrors=[];if(observed.body?.editedSha!==hash(edited))validationErrors.push('Independent edited-body hash mismatch');
  try{const rows=(await fs.readFile(path.join(caseDirectory,'fixture-journal.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));record.journalReadback=rows.length===2&&rows.every((row,index)=>row.identity===config.fixture.id&&row.sequence===index+1&&row.name===inputOrder[index]?.name&&row.insert===inputOrder[index]?.insert&&row.from===caret+index);if(!record.journalReadback)validationErrors.push('Independent journal readback mismatch');}catch(error){validationErrors.push('Independent journal readback: '+error.message);}
  record.assessment=assessFloor({...observed,...record,floorOnly:true,expectedBytes:bytes,expectedElectronVersion:version,fixtureId:config.fixture.id,errors:[...(observed.errors??[]),...validationErrors,...(record.reportError?[record.reportError]:[]),...(record.launchError?[record.launchError]:[])]});
  await fs.writeFile(path.join(caseDirectory,'result.json'),JSON.stringify(record,null,2));await save();process.stdout.write(JSON.stringify({event:'case-complete',pid:record.pid,bytes,mode,...record.assessment})+'\n');
 }
 assert.equal((await productionPin()).sha256,report.production.sha256,'Production source changed during benchmark');assert.equal(hash(JSON.stringify(await treePins(directory))),hash(JSON.stringify(report.harness)),'Harness source changed during benchmark');assert.equal(await hashFile(path.join(report.package.app,'Contents/Resources/app.asar')),report.package.asarSha256,'Packaged assets changed');
 report.complete=true;await save();if(report.cases.some(record=>!record.assessment.valid||!record.assessment.usableByDeadline))process.exitCode=1;
}catch(error){report.errors.push(error.stack??String(error));await save();throw error;}
finally{if(child){child.kill('SIGTERM');await sleep(1000);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(activeExit)await Promise.race([activeExit,sleep(5000)]);}try{report.finalCleanup=await cleanOwnedProcesses();if(!report.finalCleanup.gone||report.finalCleanup.forced){report.errors.push('Final owned PID proof required forced cleanup or left an owned process');process.exitCode=1;}}catch(error){report.errors.push('Final owned PID proof: '+error.message);process.exitCode=1;}await save();}
process.stdout.write(JSON.stringify({event:'report',out,cases:report.cases.length,complete:report.complete??false,errors:report.errors})+'\n');
