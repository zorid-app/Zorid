#!/usr/bin/env node
// Actual admitted browser runtime, unchanged product Worker/WASM and IndexedDB.
// This runner never builds, installs tooling or selects a user's browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const arg=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const required=name=>{const value=arg(name);assert.ok(value,'Explicit '+name+' required');return value;};
const integer=(name,fallback,min,max)=>{const n=Number(arg(name)??fallback);assert.ok(Number.isSafeInteger(n)&&n>=min&&n<=max,'Invalid '+name);return n;};
if(!process.argv.includes('--runtime-authorized'))throw Error('Coordinator must grant an actual browser slot before --runtime-authorized');
const coreLifecycle=process.argv.includes('--core-lifecycle');
const root=await fs.realpath(required('--root')),expected=required('--expected-head');assert.match(expected,/^[a-f0-9]{40}$/);
const chromeBinary=await fs.realpath(required('--chrome')),notes=integer('--notes',10000,1,100000),runs=integer('--runs',1,1,5),repeats=integer('--repeats',20,1,20),deadlineMs=integer('--timeout-ms',300000,1000,3600000);
async function destination(input){let at=path.resolve(input);const missing=[];for(;;){try{return path.join(await fs.realpath(at),...missing);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(at);assert.notEqual(parent,at);missing.unshift(path.basename(at));at=parent;}}}
const out=await destination(required('--out')),own=fileURLToPath(import.meta.url),here=await fs.realpath(path.dirname(own));
const inside=(p,base)=>p===base||p.startsWith(base+path.sep);
let manual;try{manual=JSON.parse(await fs.readFile('/private/tmp/zorid-current-manual-playground.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(manual)assert.ok(typeof manual.root==='string'&&path.isAbsolute(manual.root)&&Number.isSafeInteger(manual.pid)&&manual.pid>0);
const protectedRoots=[root,here,...(manual?[await destination(manual.root)]:[])];for(const base of protectedRoots)assert.ok(!inside(out,base),'Output must exclude source/harness/manual roots and aliases');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:16*1024*1024});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),hashFile=async name=>sha(await fs.readFile(name));
const generator=path.join(root,'scripts/indexing-search-baseline/workload.mjs');
const generated=await fs.realpath(arg('--wasm-dir')??path.join(root,'target/browser-wasm/generated'));
if(manual)for(const artifact of [root,chromeBinary,generated])assert.ok(!inside(artifact,await destination(manual.root)),'Manual playground cannot supply artifacts');
const buildRequire=createRequire(path.join(root,'package.json')),{sourceInputs}=buildRequire(path.join(root,'scripts/build-core-wasm.cjs'));
async function proof(){
  assert.equal(git('rev-parse','HEAD').trim(),expected,'Frozen HEAD changed');assert.equal(git('diff','--name-only','HEAD').trim(),'','Tracked frozen sources changed');
  const metadata=JSON.parse(await fs.readFile(path.join(generated,'build.json'),'utf8')),fingerprint=createHash('sha256').update('wasm-bindgen 0.2.129\0');
  for(const name of await sourceInputs(root))fingerprint.update(name).update('\0').update(await fs.readFile(path.join(root,name))).update('\0');
  assert.equal(metadata.bindgenVersion,'0.2.129');assert.equal(metadata.fingerprint,fingerprint.digest('hex'),'STALE_WASM: coordinator must build the frozen sources');
  const wasm={};for(const name of ['zorid_wasm.js','zorid_wasm_bg.wasm']){wasm[name]=await hashFile(path.join(generated,name));assert.equal(wasm[name],metadata.files[name],'WASM asset hash mismatch');}
  const names=git('ls-files','-z','src','crates','Cargo.toml','Cargo.lock','scripts/build-core-wasm.cjs','scripts/indexing-search-baseline/workload.mjs','package.json','pnpm-lock.yaml').split('\0').filter(Boolean).sort();
  const source=[];for(const name of names)source.push([name,await hashFile(path.join(root,name))]);
  return{head:expected,source,wasmDirectory:generated,wasmBuild:metadata,wasm,generator:{file:generator,sha256:await hashFile(generator)},harness:{file:own,sha256:await hashFile(own)},chrome:{file:chromeBinary,sha256:await hashFile(chromeBinary)},wasmMode:'release per fingerprinted build-core-wasm.cjs',javascriptMode:'Vite development transform of frozen production modules; fixture UI',compilerVersion:null};
}
const before=await proof(),workload=await import(pathToFileURL(generator).href);
let vite;try{vite=await import('vite');}catch{vite=await import(pathToFileURL(buildRequire.resolve('vite')).href);}
await fs.mkdir(out,{recursive:false});
const report={version:1,kind:coreLifecycle?'actual-browser-core-lifecycle-retained-search':'actual-browser-retained-index-search-baseline',status:'running',started:new Date().toISOString(),provenance:before,settings:{notes,runs,repeats,deadlineMs,coreLifecycle},machine:{os:os.type(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),freeMemoryBefore:os.freemem(),node:process.version,loadBefore:os.loadavg()},phases:[],cleanup:[],limitations:[
 'A source-driven fixture uses the production admitted runtime/adapter/Worker/WASM/IndexedDB, not the complete normal editor or hosted login/sync flow.',
 'Vite development transforms are included. WASM is release; results are not production-bundle startup budgets.',
 'Headless Chrome is the sole named engine; no Safari, Firefox, mobile, foreground typing or browser multicore parity.',
 'Worker open is aggregate startup/WASM/IDB/recovery time, not independent subphase timing. RPC read latency includes work, not pure message overhead.',
 'No worker CPU/peak process memory, parse invocation/cache-hit counters, queue wait or transfer-byte telemetry is inferred. Unsupported metrics remain null.',
 coreLifecycle?'Normal core lifecycle can index during import or independent commit. Startup queries use retained state; incremental-reopen may already be current. No derived-cold or forced-stale claim.':'Manual-pump baseline opts out of core maintenance to retain its original absent-index and stale-reopen preconditions.',
 'Fresh browser process does not imply cold OS cache. No OS cache purge. All samples remain available; no p99 claim.',
 'Presentation is this fixture summary DOM, not the product workspace search UI. Synthetic presentation times are not forced into browser authority.',
 'One committed body edit while the original client is released checks catch-up, not sync, eviction, corruption, cancellation or foreground contention.',
]};
let server,child,cdp,serverOrigin,profile,stderr='',failure,fixture,launchRecord;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),done=()=>!child||child.exitCode!==null||child.signalCode!==null;
async function until(action,timeout=15000){const end=Date.now()+timeout;let last;do{try{return await action();}catch(error){last=error;}await delay(100);}while(Date.now()<end);throw last??Error('Deadline');}
class CDP{
 constructor(url){const parsed=new URL(url);assert.equal(parsed.protocol,'ws:');assert.ok(['127.0.0.1','localhost'].includes(parsed.hostname));this.ws=new WebSocket(url);this.next=0;this.pending=new Map();this.events=[];this.opened=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connection deadline')),5000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Owned CDP connection failed'));},{once:true});});this.ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const pending=this.pending.get(value.id);if(!pending)return;this.pending.delete(value.id);clearTimeout(pending.timer);value.error?pending.reject(Error(JSON.stringify(value.error))):pending.resolve(value.result);}else if(this.events.length<500&&['Runtime.exceptionThrown','Log.entryAdded'].includes(value.method))this.events.push(value);});this.ws.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Owned CDP closed'));}this.pending.clear();});}
 async call(method,params={}){await this.opened;const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP deadline '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const value=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value;}
 close(){this.ws.close();}
}
async function stopBrowser(){if(!child)return;cdp?.close();cdp=undefined;if(child.pid===undefined){report.cleanup.push({method:'spawn-failed-no-pid'});child=undefined;return;}assert.notEqual(child.pid,manual?.pid);const record={pid:child.pid,profile,method:done()?'already-exited':'SIGTERM-owned'};if(!done()){child.kill('SIGTERM');try{await until(async()=>assert.ok(done()),5000);}catch{record.method='SIGKILL-owned-after-deadline';child.kill('SIGKILL');await until(async()=>assert.ok(done()),5000);}}record.exitCode=child.exitCode;record.signal=child.signalCode;if(launchRecord){launchRecord.stderr=stderr;launchRecord.exitCode=child.exitCode;launchRecord.signal=child.signalCode;}report.cleanup.push(record);child=undefined;}
async function startBrowser(){assert.ok(!child);await fs.rm(path.join(profile,'DevToolsActivePort'),{force:true});stderr='';child=spawn(chromeBinary,['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});assert.notEqual(child.pid,manual?.pid);launchRecord={pid:child.pid,profile,started:new Date().toISOString()};(report.browserLaunches??=[]).push(launchRecord);let spawnError;child.once('error',e=>{spawnError=e;});child.stderr.on('data',b=>{if(stderr.length<128000)stderr+=b.toString();});const port=await until(async()=>{if(spawnError)throw spawnError;assert.ok(!done(),'Owned Chrome exited before CDP');const p=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];assert.match(p,/^[1-9][0-9]{0,4}$/);assert.ok(Number(p)<=65535);return p;});const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT',signal:AbortSignal.timeout(5000)}).then(r=>r.json());cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Log.enable');await cdp.call('Page.enable');report.engine??=await cdp.call('Browser.getVersion');await cdp.call('Page.navigate',{url:serverOrigin+'/__s1/'});await until(async()=>assert.equal(await cdp.evaluate('Boolean(window.s1)'),true));}
async function phase(name,config){
 await cdp.evaluate(`window.__s1Result=null;void window.s1.run(${JSON.stringify({...config,phase:name,coreLifecycle,phaseTimeoutMs:deadlineMs})});true`);
 const start=Date.now();let observed;while(Date.now()-start<deadlineMs){observed=await cdp.evaluate('window.__s1Result');if(observed?.finished)break;await delay(250);}
 if(!observed?.finished)throw Error('Actual browser scenario deadline: '+name);report.phases.push(observed);await fs.writeFile(path.join(out,`phase-${config.run}-${name}.json`),JSON.stringify(observed,null,2));report.browserEvents=[...(report.browserEvents??[]),...cdp.events];
 const {data}=await cdp.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,`phase-${config.run}-${name}.png`),Buffer.from(data,'base64'));
 assert.equal(observed.status,'passed',JSON.stringify(observed.error));return observed;
}
const browserFixture=browserSource();
try{
 const generationAt=performance.now();fixture=await workload.generate(path.join(out,'workload'),notes);report.generation={elapsedMs:performance.now()-generationAt,fixtureHash:fixture.fixtureHash,manifest:fixture.manifest};
 const manifest=typeof fixture.manifest==='object'?fixture.manifest:JSON.parse(await fs.readFile(path.join(out,'workload/manifest.json'),'utf8'));assert.ok(Array.isArray(manifest.entries));
 const oracles=workload.queries.map(query=>({...query,expected:[...workload.literalOracle(query,notes)]}));for(const row of oracles)assert.equal(row.expected.length,workload.expectedCount(row,notes));await fs.writeFile(path.join(out,'oracles.json'),JSON.stringify(oracles,null,2));
 const admittedFiles=new Map(manifest.entries.map(row=>[row.path,row]));
 server=await vite.createServer({root,configFile:false,envFile:false,clearScreen:false,logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,generated]}},plugins:[{name:'s1-web-baseline-fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{try{const url=new URL(req.url,'http://fixture');if(!url.pathname.startsWith('/__s1/'))return next();res.setHeader('Cache-Control','no-store');if(url.pathname==='/__s1/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>Zorid browser baseline fixture</title><pre id="result">Ready</pre><script type="module" src="/__s1/fixture.mjs"></script>');}else if(url.pathname==='/__s1/fixture.mjs'){res.setHeader('Content-Type','text/javascript');res.end(browserFixture);}else if(url.pathname==='/__s1/manifest.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));}else if(url.pathname==='/__s1/oracles.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(oracles));}else if(url.pathname==='/__s1/source'){const relative=url.searchParams.get('path');assert.ok(admittedFiles.has(relative),'Source path outside exact manifest');res.setHeader('Content-Type','application/octet-stream');res.end(await fs.readFile(path.join(fixture.vault,relative)));}else if(url.pathname==='/__s1/zorid_wasm.js'||url.pathname==='/__s1/zorid_wasm_bg.wasm'){const name=path.basename(url.pathname);res.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await fs.readFile(path.join(generated,name)));}else{res.statusCode=404;res.end();}}catch(error){res.statusCode=500;res.end(String(error));}});}}]});await server.listen();const address=server.httpServer.address();assert.ok(address&&typeof address!=='string');serverOrigin=`http://127.0.0.1:${address.port}`;report.origin=serverOrigin;
 profile=await fs.mkdtemp(path.join(out,'chrome-profile-'));report.profile=profile;
 for(let run=0;run<runs;run++){
  const config={run,database:'zorid-core-vault:s1-'+randomUUID(),clientId:randomUUID(),peerClientId:randomUUID(),repeats};
  await startBrowser();const imported=await phase('import',config);config.mapping=imported.mapping;if(coreLifecycle)config.expectedSetupSnapshot=imported.index.statusAfter.snapshot;await stopBrowser();
  await startBrowser();const cold=await phase(coreLifecycle?'startup-query':'derived-cold',config);config.expectedSnapshot=cold.index.statusAfter.snapshot;await stopBrowser();
  await startBrowser();await phase('warm-reopen',config);await stopBrowser();
  await startBrowser();const commit=await phase('offline-commit',config);config.mapping=config.mapping.map(row=>row.path===commit.changed.path?commit.changed:row);config.commit=commit.changed;await stopBrowser();
  await startBrowser();await phase(coreLifecycle?'incremental-reopen':'incremental-catchup',config);await stopBrowser();
 }
 assert.deepEqual(await proof(),before,'Frozen sources/artifacts changed');const samples={};const add=(key,value)=>{if(Number.isFinite(value))(samples[key]??=[]).push(value);};for(const phase of report.phases){for(const [name,value]of Object.entries(phase.timings))add(phase.phase+':'+name,value);for(const row of phase.queries??[])add(phase.phase+':query:'+row.id,row.elapsedMs);for(const row of phase.repeated??[])add('warm-repeated:'+row.id,row.elapsedMs);}report.statistics=Object.fromEntries(Object.entries(samples).map(([key,values])=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return[key,{samples:values,median:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2,min:sorted[0],max:sorted.at(-1)}];}));report.status='passed-subset';
}catch(error){failure=error;report.status='failed';report.error={message:error.message,stack:error.stack};if(cdp){report.browserEvents=[...(report.browserEvents??[]),...cdp.events];try{const {data}=await cdp.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,'failure.png'),Buffer.from(data,'base64'));report.lastProgress=await cdp.evaluate('window.__s1Progress??null');}catch{}}}
finally{try{await stopBrowser();await server?.close();}catch(error){failure??=error;report.status='failed';report.cleanupError=String(error);}report.finished=new Date().toISOString();report.chromeStderr=stderr;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,report:path.join(out,'report.json'),phases:report.phases.length}));if(failure){console.error(failure);process.exitCode=1;}


function browserSource(){return String.raw`
import {BrowserCoreRuntime} from '/src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '/src/platform/browser-client-admission.ts';
import {defaultBrowserAdapter} from '/src/platform/browser-default.ts';
const check=(condition,message)=>{if(!condition)throw Error(message);};
const equal=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message);
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const utf8=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true}),clock=()=>performance.now();
const fetchJson=async url=>{const r=await fetch(url);check(r.ok,'Fixture fetch failed '+url);return r.json();};
function errorFacts(error){return{code:error?.code??null,name:error?.name??null,message:String(error?.message??error),source:error?.source??null,details:error?.details??null};}
function frame(){return new Promise(resolve=>requestAnimationFrame(()=>resolve()));}
let activeRun=false;
window.s1={async run(config){
 if(activeRun)throw Error('A fixture phase is already active');activeRun=true;
 const record={phase:config.phase,run:config.run,database:config.database,clientId:config.phase==='offline-commit'?config.peerClientId:config.clientId,status:'running',started:performance.timeOrigin+clock(),timings:{},unsupported:{workerStartupSubphases:null,pureMessageOverheadMs:null,workerCpuMs:null,peakProcessMemoryBytes:null,parseCalls:null,parseCacheHits:null,queueWaitMs:null,messageTransferBytes:null}};
 let runtime,consumer,adapter,service,pin,stage;const phaseStart=clock();
 window.__s1Progress={phase:config.phase,state:'opening'};
 try{
  const manifest=await fetchJson('/__s1/manifest.json'),oracles=await fetchJson('/__s1/oracles.json'),byPath=new Map(manifest.entries.map(row=>[row.path,row]));
  const openedAt=clock();runtime=await BrowserCoreRuntime.open({database:config.database,clientId:record.clientId,wasmModuleUrl:location.origin+'/__s1/zorid_wasm.js',allowNewVault:true,initializeLocal:true,...(config.coreLifecycle?{documentMaintenance:true}:{}),timeoutMs:120000});record.timings.workerOpenMs=clock()-openedAt;record.scope=runtime.durableScope;
  consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()});adapter=defaultBrowserAdapter(runtime,consumer);service=adapter.documentSemantics;check(service,'Production document service unavailable');if(config.coreLifecycle)check(service.maintenance&&typeof service.maintenance.observeAndSubscribe==='function','Positive admitted core maintenance unavailable');
  record.environment={origin:location.origin,userAgent:navigator.userAgent,platform:navigator.platform,logicalCpus:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory??null,crossOriginIsolated,storage:await navigator.storage.estimate()};
  const statusAt=clock(),statusBefore=await service.status();record.timings.initialStatusMs=clock()-statusAt;record.index={statusBefore};
  const mapping=new Map((config.mapping??[]).map(row=>[row.path,row]));
  async function awaitCoreCurrent(){
   const started=clock();let latest=null,notified=false;const updates=[];record.index.lifecycle={waitStartedMs:started-phaseStart,updates,lastUpdate:null,status:null};
   const receive=update=>{notified=true;latest=update;record.index.lifecycle.lastUpdate=update;if(updates.length<1000)updates.push({elapsedMs:clock()-started,update});window.__s1Progress={phase:config.phase,state:'core-index-wait',update};};
   const observed=await service.maintenance.observeAndSubscribe(receive);if(!notified)receive(observed.snapshot);
   try{
    while(clock()-phaseStart<Math.max(config.phaseTimeoutMs-5000,config.phaseTimeoutMs/2)){
     if(latest?.freshness==='current'&&latest.coverageComplete===true&&latest.published){
      const value=await service.status();record.index.lifecycle.status=value;
      if(value.current&&value.coverageComplete===true){equal(value.snapshot,latest.published,'Core publication/status generation mismatch');equal(value.source,latest.source,'Core publication/status source mismatch');record.index.lifecycle.waitMs=clock()-started;return value;}
     }
     await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Normal core lifecycle did not reach complete/current source coverage before its bounded deadline');
   }finally{observed.unsubscribe();record.index.lifecycle.waitMs=clock()-started;}
  }
  async function readRow(row){const observed=await runtime.readEntry(row.path);check(observed?.entry?.path===row.path&&observed.bytes instanceof Uint8Array,'Retained source missing '+row.path);check(observed.bytes.length===row.bytes,'Retained source length mismatch '+row.path);check(await hash(observed.bytes)===row.sha256,'Retained source digest mismatch '+row.path);return{logicalId:row.logicalId,path:row.path,id:observed.entry.id,revision:observed.entry.revision,bytes:observed.bytes.length,sha256:row.sha256,presentation:observed.presentation};}
  if(config.phase==='import'){
   if(!config.coreLifecycle)check(statusBefore.snapshot===null,'Fresh import unexpectedly has a derived generation');
   const importAt=clock(),parents=new Set();for(const row of manifest.entries){const parts=row.path.split('/');parts.pop();for(let n=1;n<=parts.length;n++)parents.add(parts.slice(0,n).join('/'));}
   for(const folder of [...parents].sort())await adapter.mkdir(folder);
   const actual=[];record.mapping=actual;record.importedBytes=0;let importedBytes=0;for(const row of manifest.entries){
    const response=await fetch('/__s1/source?path='+encodeURIComponent(row.path));check(response.ok,'Source fetch failed');const bytes=new Uint8Array(await response.arrayBuffer());check(bytes.length===row.bytes&&await hash(bytes)===row.sha256,'Frozen source input mismatch '+row.path);
    if(row.kind==='binary')await adapter.createBinary(row.path,bytes);else await adapter.createText(row.path,decoder.decode(bytes));
    actual.push(await readRow(row));importedBytes+=bytes.length;record.importedBytes=importedBytes;window.__s1Progress={phase:config.phase,imported:actual.length,total:manifest.entries.length};
   }
   record.timings.importAndExactReadbackMs=clock()-importAt;record.importedBytes=importedBytes;record.mapping=actual;record.syntheticPresentation='Manifest facts retained separately; actual authority presentation recorded per row, not overwritten';
   const after=config.coreLifecycle?await awaitCoreCurrent():await service.status();if(!config.coreLifecycle)check(after.snapshot===null,'Setup unexpectedly built a derived index');record.index.statusAfter=after;
  }else{
   check(mapping.size===manifest.entries.length,'Exact committed source mapping unavailable');
   const sample=manifest.entries.find(row=>row.noteIndex===Math.min(42,manifest.noteCount-1)),sampleWitness=mapping.get(sample.path);const readAt=clock();const observed=await readRow({...sample,bytes:sampleWitness.bytes,sha256:sampleWitness.sha256});const original=mapping.get(sample.path);check(observed.id===original.id&&observed.revision===original.revision,'Retained sample identity changed');record.timings.retainedSampleReadRpcMs=clock()-readAt;record.retainedSample=observed;
   if(config.phase==='offline-commit'){
    const row=manifest.entries.find(row=>row.noteIndex===0),old=await readRow(row);check(old.id===mapping.get(row.path).id&&old.revision===mapping.get(row.path).revision,'Commit baseline mismatch');
    const response=await fetch('/__s1/source?path='+encodeURIComponent(row.path));check(response.ok,'Commit input source unavailable');const bytes=new Uint8Array(await response.arrayBuffer());check(await hash(bytes)===row.sha256,'Commit source differs from frozen fixture');const source=decoder.decode(bytes),next=source+'\nincremental-S1-body\n',commitAt=clock();
    await adapter.compareAndWrite(row.path,source,next,{entryId:old.id,revision:old.revision});record.timings.independentClientCommitMs=clock()-commitAt;
    const changed=await runtime.readEntry(row.path);check(changed.entry.id===old.id&&changed.entry.revision!==old.revision&&decoder.decode(changed.bytes)===next,'Incremental commit mismatch');record.changed={logicalId:row.logicalId,path:row.path,id:changed.entry.id,revision:changed.entry.revision,bytes:changed.bytes.length,sha256:await hash(changed.bytes),presentation:changed.presentation};record.baseRevision=old.revision;
    record.index.statusAfter=await service.status();if(!config.coreLifecycle)check(!record.index.statusAfter.current,'Changed source was incorrectly reported current');else record.index.independentCommitIndexAlreadyCurrent=record.index.statusAfter.current;
   }else{
    if(config.phase==='startup-query'){check(config.coreLifecycle&&statusBefore.current&&statusBefore.coverageComplete===true,'Startup query requires retained complete/current coverage');equal(statusBefore.snapshot,config.expectedSetupSnapshot,'Startup query switched setup generation');}
    if(config.phase==='derived-cold')check(statusBefore.snapshot===null,'Derived-cold requires no persisted index');
    if(config.phase==='warm-reopen'){check(statusBefore.current,'Retained warm index was not current');equal(statusBefore.snapshot,config.expectedSnapshot,'Warm restart switched generation');}
    if(config.phase==='incremental-catchup'||config.phase==='incremental-reopen'){if(!config.coreLifecycle)check(!statusBefore.current,'Independent commit did not make consumer stale');else record.index.reopenAlreadyCurrent=statusBefore.current;const row=config.commit,changed=await runtime.readEntry(row.path);check(changed.entry.id===row.id&&changed.entry.revision===row.revision&&await hash(changed.bytes)===row.sha256,'Missed-change source witness mismatch');record.incrementalSource=row;}
    const buildAt=clock(),progress=[];let pumps=0;
    if(config.coreLifecycle){record.index.statusAfter=await awaitCoreCurrent();record.timings.coreCurrentWaitMs=clock()-buildAt;record.index.manualPumps=0;}else if(!statusBefore.current){
     if(!statusBefore.snapshot)await service.initialize();stage=await service.begin();
     while(!stage.progress?.ready){const pumpAt=clock();stage=await service.pump(stage.stageId);pumps++;progress.push({elapsedMs:clock()-buildAt,requestMs:clock()-pumpAt,...stage.progress});window.__s1Progress={phase:config.phase,pumps,progress:stage.progress};check(pumps<=manifest.entries.length+100,'Index made no bounded progress');}
     const publicationAt=clock();record.index.publishedSnapshot=await service.publish(stage.stageId);stage=undefined;record.timings.publicationMs=clock()-publicationAt;
    }
    if(!config.coreLifecycle)record.timings.indexCatchupMs=clock()-buildAt;record.index.pumps=config.coreLifecycle?null:pumps;record.index.progress=config.coreLifecycle?null:progress;record.index.statusAfter=config.coreLifecycle?record.index.statusAfter:await service.status();check(record.index.statusAfter.current,'Index did not cover committed source');check(record.index.statusAfter.coverageComplete===true,'Permitted coverage incomplete');if(config.coreLifecycle&&(config.phase==='startup-query'||config.phase==='warm-reopen'))equal(record.index.statusAfter.snapshot,config.phase==='startup-query'?config.expectedSetupSnapshot:config.expectedSnapshot,'Retained query unexpectedly switched generation');
    const openPinAt=clock();pin=await service.open();record.timings.openRetainedPinMs=clock()-openPinAt;record.index.pin={snapshot:pin.snapshot,source:pin.source,coverageComplete:pin.coverageComplete};if(config.coreLifecycle){equal(pin.snapshot,record.index.statusAfter.snapshot,'Pin switched the verified current generation');equal(pin.source,record.index.statusAfter.source,'Pin switched the verified source watermark');check(pin.coverageComplete===true,'Core lifecycle pin has incomplete coverage');}
    async function query(row){
     const start=clock(),actual=[],pages=[];let cursor=null,last;
     do{const pageAt=clock(),page=await pin.search({query:row.query,cursor,limit:1000});last=page.result.value;check(page.result.coverageComplete===true,'Query omitted coverage');if(config.coreLifecycle){equal(page.result.snapshot,pin.snapshot,'Query page switched pinned generation');equal(page.result.source,pin.source,'Query page switched pinned source');}
      for(const hit of last.hits){const authority=mapping.get(hit.entry.path),logical=byPath.get(hit.entry.path);check(authority&&logical,'Unexpected query entry '+hit.entry.path);check(hit.entry.id===authority.id&&hit.entry.revision===authority.revision,'Query returned stale/foreign revision');actual.push({logicalId:logical.logicalId,path:hit.entry.path,line:hit.line,range:{bytes:[...hit.range.bytes],utf16:[...hit.range.utf16]}});}
      pages.push({elapsedMs:clock()-pageAt,hits:last.hits.length,documents:last.documents,sourceBytes:last.sourceBytes,scanComplete:last.scanComplete,complete:last.complete});check(page.cursor!==cursor||page.cursor===null,'Repeated query cursor');cursor=page.cursor;check(pages.length<=manifest.entries.length+100,'Pagination exceeded bounded work');
     }while(cursor!==null);
     check(last.scanComplete&&last.complete,'Query stopped with incomplete scan');equal(actual,row.expected,'Complete ordered literal oracle mismatch: '+row.id);
     const encoded=utf8.encode(JSON.stringify(actual));return{id:row.id,query:row.query,elapsedMs:clock()-start,pages,count:actual.length,actualSha256:await hash(encoded),first:actual[0]??null,last:actual.at(-1)??null};
    }
    record.queries=[];for(const row of oracles)record.queries.push(await query(row));
    if(config.phase==='incremental-catchup'||config.phase==='incremental-reopen'){
     const row=manifest.entries.find(row=>row.noteIndex===0),response=await fetch('/__s1/source?path='+encodeURIComponent(row.path));check(response.ok,'Incremental oracle source unavailable');const source=decoder.decode(await response.arrayBuffer()),prefix=source+'\n',marker='incremental-S1-body';
     record.queries.push(await query({id:'incremental-body',query:marker,expected:[{logicalId:row.logicalId,path:row.path,line:prefix.split('\n').length-1,range:{bytes:[utf8.encode(prefix).length,utf8.encode(prefix+marker).length],utf16:[prefix.length,prefix.length+marker.length]}}]}));
    }
    record.repeated=[];if(config.phase==='warm-reopen')for(let n=0;n<config.repeats;n++)record.repeated.push(await query(oracles.find(row=>row.id==='rare')));
    await pin.close();pin=undefined;
   }
  }
  record.status='passed';
 }catch(error){record.status='failed';record.error=errorFacts(error);record.progressAtFailure=window.__s1Progress;}
 finally{
  const cleanupAt=clock();record.release=[];for(const [name,action]of [['pin',()=>pin?.close()],['stage',()=>stage&&service?service.discard(stage.stageId):undefined],['client',()=>consumer?.release(()=>{})]]){try{await action();record.release.push({resource:name,acknowledged:true});}catch(error){record.status='failed';record.release.push({resource:name,acknowledged:false,error:errorFacts(error)});}}runtime?.close();
  record.timings.releaseMs=clock()-cleanupAt;record.timings.totalPhaseMs=clock()-phaseStart;
  record.environmentAfter={storage:await navigator.storage.estimate(),pageJsHeap:performance.memory?{usedBytes:performance.memory.usedJSHeapSize,totalBytes:performance.memory.totalJSHeapSize,scope:'Chrome performance.memory main-page JS heap, not Worker/process peak'}:null,resources:performance.getEntriesByType('resource').filter(row=>row.name.includes('wasm')||row.name.includes('browser-core-worker')).map(row=>({url:row.name,durationMs:row.duration,transferBytes:row.transferSize,encodedBytes:row.encodedBodySize,decodedBytes:row.decodedBodySize}))};
  const presentationAt=clock();document.querySelector('#result').textContent=JSON.stringify({phase:record.phase,status:record.status,queries:record.queries?.map(row=>({id:row.id,count:row.count,elapsedMs:row.elapsedMs})),error:record.error},null,2);await frame();record.timings.fixtureSummaryPresentationMs=clock()-presentationAt;
  record.finished=true;window.__s1Result=record;activeRun=false;
 }
}};
`;
}
