// External observer only. The Tauri app embeds its own Rust core and runs no Node.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {sampleProcesses,probeMetadata} from './memory-metrics.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),prototype=path.dirname(here);
const [kind,mode='memory',label='run']=process.argv.slice(2);
if(!['tauri','electron'].includes(kind)||!['save','memory','probe'].includes(mode))throw Error('Usage: run.mjs tauri|electron save|memory label');
const directory=await fs.mkdtemp(`/private/tmp/zorid-tauri-native-${kind}-${mode}-${label}-`);
const vault=path.join(directory,'vault'),data=path.join(directory,'data');
await fs.mkdir(vault);await fs.mkdir(data);
await fs.writeFile(path.join(vault,'Benchmark.md'),'Embedded Rust core fixture\n\nExact durable text.\n');
if(mode==='probe')await fs.writeFile(path.join(vault,'Note 1.md'),'Other note\n');
if(mode==='memory'){
 for(let i=1;i<100;i++)await fs.writeFile(path.join(vault,`Note ${i}.md`),`# Note ${i}\n\n`+'A link to [[Benchmark]] and a short paragraph of deterministic fixture text.\n'.repeat(28));
 await fs.writeFile(path.join(vault,'Large.md'),'# Large fixture\n\n'+'A paragraph with **bold**, *emphasis*, [[Benchmark]] and `inline code`.\n\n'.repeat(3800));
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const table=()=>execFileSync('ps',['-axo','pid=,ppid=,rss=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],rssKiB:+m[3],command:m[4]};}).filter(Boolean);
const descendants=(all,root)=>{const ids=new Set([root]);let again=true;while(again){again=false;for(const p of all)if(ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);again=true;}}return ids;};
const isWebKit=p=>/com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(p.command);
const before=table(),existing=new Set(before.map(p=>p.pid)),ever=new Set(),candidatesEver=new Set();
const result={version:1,kind,mode,label,directory,vault,data,started:new Date().toISOString(),phases:[],launches:[],sameFrontendCapabilities:true};
const output=path.join(directory,'result.json');let child;
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
async function wait(probe,ms,label){const end=performance.now()+ms;while(performance.now()<end){const value=await probe();if(value)return value;if(result.launchError)throw Error(result.launchError);if(child&&(child.exitCode!==null||child.signalCode!==null))throw Error('App exited '+child.exitCode+'/'+child.signalCode+' before '+label);await pause(50);}throw Error('Timeout '+label);}
async function control(value){await fs.writeFile(path.join(data,'control.next'),JSON.stringify(value));await fs.rename(path.join(data,'control.next'),path.join(data,'control.json'));}
async function fixtureHash(){const files=(await fs.readdir(vault)).filter(n=>n.endsWith('.md')).sort();const h=createHash('sha256');for(const f of files){h.update(f+'\0');h.update(await fs.readFile(path.join(vault,f)));h.update('\0');}return{notes:files.length,sha256:h.digest('hex')};}
async function launch(controlValue){
 await control(controlValue);const log=await fs.open(path.join(directory,`app-${result.launches.length}.log`),'w');
 const executable=kind==='tauri'?path.join(prototype,'shell/target/release/zorid-tauri-native-prototype'):'/Users/ctk/Projects/Zorid/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
 child=spawn(executable,kind==='tauri'?[]:[path.join(prototype,'electron/main.cjs')],{env:{...process.env,ZORID_NATIVE_VAULT:vault,ZORID_NATIVE_DATA:data,ZORID_NATIVE_BENCH:'1',ZORID_NATIVE_HOST:path.join(prototype,'shell/target/release/zorid-native-host-comparator')},stdio:['ignore',log.fd,log.fd]});
 child.once('error',error=>{result.launchError=error.message;});await log.close();
 result.launches.push({pid:child.pid,at:new Date().toISOString(),control:controlValue});ever.add(child.pid);
}
async function close(){
 const all=table();for(const pid of descendants(all,child.pid))ever.add(pid);
 await control({phase:'close',expectedNotes:result.launches.at(-1).control.expectedNotes});
 const end=performance.now()+20000;while(child.exitCode===null&&child.signalCode===null&&performance.now()<end)await pause(100);
 if(child.exitCode!==0)throw Error('Native close did not exit0: '+child.exitCode+'/'+child.signalCode);
 result.launches.at(-1).exitCode=child.exitCode;
 await pause(500);
 const remaining=table().filter(p=>ever.has(p.pid));if(remaining.length)throw Error('Owned processes remain after normal close '+JSON.stringify(remaining));
}
function system(){const out={at:new Date().toISOString()};for(const [key,cmd,args]of [['swap','sysctl',['vm.swapusage']],['pressure','memory_pressure',['-Q']]])try{out[key]=execFileSync(cmd,args,{encoding:'utf8',timeout:5000});}catch(error){out[key]=String(error.message);}return out;}
async function sample(){
 const all=table(),ids=descendants(all,child.pid);for(const pid of ids)ever.add(pid);
 const rows=all.filter(p=>ids.has(p.pid)||kind==='tauri'&&isWebKit(p)&&!existing.has(p.pid));
 const values=await sampleProcesses(rows.map(p=>p.pid));
 const metrics=values.map(value=>({...rows.find(p=>p.pid===value.pid),...value,attribution:ids.has(value.pid)?'descendant':'new-WebKit-candidate'}));
 for(const row of metrics)if(row.attribution==='new-WebKit-candidate')candidatesEver.add(row.pid);
 const valid=metrics.every(p=>!p.error&&Number.isFinite(p.physFootprintBytes));
 if(!valid)throw Error('Incomplete footprint sample '+JSON.stringify(metrics.filter(p=>p.error)));
 return{at:new Date().toISOString(),processes:metrics,footprintBytes:metrics.reduce((n,p)=>n+p.physFootprintBytes,0),residentBytes:metrics.reduce((n,p)=>n+p.residentBytes,0),complete:valid};
}
try{
 result.fixtureBefore=await fixtureHash();result.systemBefore=system();result.probe=await probeMetadata();
 if(mode==='probe'){
  await launch({phase:'save',expectedNotes:2,probeFocus:true});
  const report=await wait(()=>read(path.join(data,'report.json')),90000,'focus probe');result.probeReport=report;
  if(report.status!=='passed')throw Error('Focus probe '+JSON.stringify(report));
  result.fixtureAfter=await fixtureHash();if(JSON.stringify(result.fixtureBefore)!==JSON.stringify(result.fixtureAfter))throw Error('Probe fixture changed');
  await close();
 }else if(mode==='save'){
  const marker='native-'+kind+'-'+randomUUID()+' π 漢字 🦀';
  await launch({phase:'save',expectedNotes:1,marker});
  const saved=await wait(()=>read(path.join(data,'report.json')),90000,'save report');
  if(saved.status!=='passed')throw Error('Save gate '+JSON.stringify(saved));result.saved=saved;
  await close();
  const benchmark=await fs.readFile(path.join(vault,'Benchmark.md'),'utf8'),created=await fs.readFile(path.join(vault,'Untitled.md'),'utf8');
  if(benchmark!==saved.benchmarkText||created!==saved.createdText)throw Error('Physical files do not match dirty-close expectations');
  result.physicalSaveMatches=true;result.clientBefore=await fs.readFile(path.join(data,'native-client-id'),'utf8');
  await fs.rename(path.join(data,'report.json'),path.join(data,'saved-report.json'));
  await launch({phase:'save',expectedNotes:2,marker,verifyOnly:true});
  const reopened=await wait(()=>read(path.join(data,'report.json')),90000,'restart report');
  if(reopened.status!=='passed'||reopened.benchmarkText!==benchmark||reopened.createdText!==created)throw Error('Restart gate '+JSON.stringify(reopened));
  result.reopened=reopened;result.clientAfter=await fs.readFile(path.join(data,'native-client-id'),'utf8');
  if(result.clientBefore!==result.clientAfter)throw Error('Native client identity changed');
  await close();
 }else{
  await launch({phase:'single',expectedNotes:101});
  for(const phase of ['single','tabs','large']){
   await control({phase,expectedNotes:101});
   const receipt=await wait(()=>read(path.join(data,'phase-'+phase+'.json')),180000,'memory state '+phase);
   if(receipt.status!=='ready'||!receipt.exactActiveSourceMatches)throw Error('Memory state gate '+JSON.stringify(receipt));
   const settleMs=phase==='single'?30000:10000;await pause(settleMs);const samples=[];
   for(let i=0;i<10;i++){samples.push(await sample());if(i<9)await pause(1000);}
   const record={phase,settleMs,receipt,samples,system:system()};
   const ids=[...new Set(samples.flatMap(s=>s.processes.map(p=>p.pid)))];
   try{record.footprint=execFileSync('/usr/bin/footprint',['--noCategories','--swapped','-f','bytes',...ids.map(String)],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});}catch(e){record.footprintError=String(e.message);}
   result.phases.push(record);await fs.writeFile(output,JSON.stringify(result,null,2));
   console.log(JSON.stringify({kind,label,phase,directory,footprintMiB:samples.map(s=>Math.round(s.footprintBytes/1048576)),processCounts:samples.map(s=>s.processes.length)}));
  }
  result.fixtureAfter=await fixtureHash();if(JSON.stringify(result.fixtureBefore)!==JSON.stringify(result.fixtureAfter))throw Error('Memory fixture was modified');
  await close();result.fixtureAfterClose=await fixtureHash();if(JSON.stringify(result.fixtureBefore)!==JSON.stringify(result.fixtureAfterClose))throw Error('Memory fixture changed during close');result.closeTrace=await read(path.join(data,'phase-large.json'));
 }
 result.status='passed';
}catch(error){result.status='failed';result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;}
finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const all=table(),ids=descendants(all,child.pid);for(const pid of ids){ever.add(pid);try{process.kill(pid,'SIGTERM');}catch{}}await pause(1000);for(const p of table())if(ids.has(p.pid))try{process.kill(p.pid,'SIGKILL');}catch{}}
 await pause(500);result.cleanup={remaining:table().filter(p=>ever.has(p.pid)),newWebKitCandidates:[...candidatesEver],newWebKitStillPresent:table().filter(p=>candidatesEver.has(p.pid))};result.finished=new Date().toISOString();result.systemAfter=system();
 await fs.writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify({kind,mode,label,directory,status:result.status,remaining:result.cleanup.remaining.length}));
}
