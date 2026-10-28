#!/usr/bin/env node
// Disposable normal-desktop startup/navigation profiler. No fixture runtime or bridge writes.
// The temporary main launcher only measures the existing Rust request queue.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {CDP} from '../tests/tasks-electron-integration/cdp.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const required=name=>{const value=arg(name);assert.ok(value,`${name} required`);return value;};
const root=await fs.realpath(required('--root')),out=path.resolve(required('--out'));
const native=await fs.realpath(required('--native')),electron=await fs.realpath(required('--electron'));
const notes=Number(arg('--notes','100')),runs=Number(arg('--runs','3'));
assert.ok(Number.isSafeInteger(notes)&&notes>=2&&notes<=10000);
assert.ok(Number.isSafeInteger(runs)&&runs>=1&&runs<=10);
const visitCount=Number(arg('--visit-count',String(Math.min(5,notes))));
assert.ok(Number.isSafeInteger(visitCount)&&visitCount>=2&&visitCount<=notes,'--visit-count must be in2..notes');
const includeBase=process.argv.includes('--include-base'),basePath='Profile.base';
const noteRepeats=Number(arg('--note-repeats','25')),largeFirstBytes=Number(arg('--large-first-note-bytes','0')),prepareAuthority=process.argv.includes('--prepare-authority');
const shutdownTimeoutMs=Number(arg('--shutdown-timeout-ms','60000'));assert.ok(Number.isSafeInteger(shutdownTimeoutMs)&&shutdownTimeoutMs>=10000&&shutdownTimeoutMs<=120000,'--shutdown-timeout-ms must be in10000..120000');
const idleMs=Number(arg('--idle-ms','0')),externalProbes=process.argv.includes('--external-probes'),forceMaintenance=process.argv.includes('--force-maintenance');
assert.ok(Number.isSafeInteger(idleMs)&&idleMs>=0&&idleMs<=120000,'--idle-ms must be in0..120000');
assert.ok(!externalProbes||notes>visitCount,'External probes need an unvisited note beyond --visit-count');
assert.ok(Number.isSafeInteger(noteRepeats)&&noteRepeats>=1&&noteRepeats<=10000,'--note-repeats must be in1..10000');
assert.ok(Number.isSafeInteger(largeFirstBytes)&&largeFirstBytes>=0&&largeFirstBytes<=8*1024*1024,'--large-first-note-bytes must be in0..8388608');
const baseSource=JSON.stringify({filters:'file.ext == "md"',views:[{id:'profilebase1',type:'table',name:'Profile table',source:{kind:'untyped'},order:['file.name'],sort:[{property:'file.name',direction:'ASC'}]}]},null,2)+'\n';
assert.ok(out.startsWith('/private/tmp/startup-performance-20261028/'),'Output must be in the owned temporary profiling root');
await fs.access(path.join(root,'dist/index.html'));
await fs.mkdir(path.dirname(out),{recursive:true});
await fs.mkdir(out,{recursive:false});
const reused=arg('--reuse-fixture'),fixtureRoot=reused?await fs.realpath(reused):out;
assert.ok(fixtureRoot.startsWith('/private/tmp/startup-performance-20261028/'),'Fixture must be in the owned temporary profiling root');
const profile=path.join(fixtureRoot,'profile'),vault=path.join(fixtureRoot,'vault'),appData=path.join(fixtureRoot,'app-data');
if(!reused){await fs.mkdir(profile);await fs.mkdir(vault);}
const sources=new Map();
for(let i=0;i<notes;i++){
  const name=`Note ${String(i).padStart(4,'0')}.md`,heading=`# Profile note ${i}\n\nNative navigation marker ${i}.\n\n`,filler='Ordinary note text and a paragraph.\n';
  let source=heading+filler.repeat(noteRepeats);
  if(i===0&&largeFirstBytes){assert.ok(largeFirstBytes>=heading.length,'Large first note must fit its heading');const remaining=largeFirstBytes-heading.length;source=heading+filler.repeat(Math.floor(remaining/filler.length))+filler.slice(0,remaining%filler.length);assert.equal(Buffer.byteLength(source),largeFirstBytes);}
  sources.set(name,source);if(reused)assert.equal(await fs.readFile(path.join(vault,name),'utf8'),source);else await fs.writeFile(path.join(vault,name),source,{flag:'wx'});
}
if(includeBase){if(reused)assert.equal(await fs.readFile(path.join(vault,basePath),'utf8'),baseSource);else await fs.writeFile(path.join(vault,basePath),baseSource,{flag:'wx'});}
if(!reused)await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}),{flag:'wx'});
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function sourceWitnesses(names){const rows=[];for(const name of names)rows.push({path:name,sha256:await hash(path.join(vault,name))});return rows;}
const report={version:1,root,out,fixtureRoot,reused:!!reused,notes,runs,visitCount,includeBase,noteRepeats,largeFirstBytes,prepareAuthority,started:new Date().toISOString(),head:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),native:{path:native,sha256:await hash(native)},electron:{path:electron,sha256:await hash(electron)},indexSha256:await hash(path.join(root,'dist/index.html')),sourceWitnessesBefore:await sourceWitnesses([...sources.keys(),...(includeBase?[basePath]:[])]),launches:[],limitations:['Filesystem cache is uncontrolled; these are process-cold, not disk-cold starts.','CDP dispatches the normal file-tree click handler and waits for matching CodeMirror text plus two animation frames; foreground OS input is not claimed.','Request total includes the normal shared FIFO queue; dispatch delay approximates queue wait using its existing tail Promise.','Temporary instrumentation retains timings in memory, without writing per-request logs.','Base row totals use the rendered grid aria-rowcount minus chrome rows; actual visible virtualized rows and first file path are recorded separately.','Optional authority preparation uses normal native startup import only; it is untimed setup, without index pumping or renderer bridge writes.']};
report.acceptanceOptions={idleMs,externalProbes,forceMaintenance};report.limitations.push('Optional external probes are genuine filesystem changes, separately labeled from UI edits. A watcher-overflow burst is not exercised.');
const startupObserver=`(()=>{
 const state=window.__zoridNavigationStartup={timeOrigin:performance.timeOrigin,installedAt:performance.now(),workspaceInitiallyPresent:!!document.querySelector('.workspace'),editorInitiallyPresent:!!document.querySelector('.pane.is-active .cm-content')};
 let workspaceScheduled=false,editorScheduled=false;
 const observer=new MutationObserver(sample);
 function sample(){
  if(!workspaceScheduled&&document.querySelector('.workspace')){workspaceScheduled=true;state.workspaceFoundAt=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{state.workspacePaintedAt=performance.now();}));}
  const node=document.querySelector('.pane.is-active .cm-content'),view=node?.cmTile?.root?.view;
  if(!editorScheduled&&view&&view.contentDOM===node){editorScheduled=true;state.editorFoundAt=performance.now();state.editorCharacters=view.state.doc.length;requestAnimationFrame(()=>requestAnimationFrame(()=>{state.editorPaintedAt=performance.now();}));}
  if(workspaceScheduled&&editorScheduled)observer.disconnect();
 }
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});sample();
 return state;
})()`;
const launcher=path.join(out,'profile-launcher.cjs');
await fs.writeFile(launcher,`'use strict';
const {performance}=require('node:perf_hooks');
global.__zoridNavigationProfile={events:[],windowEvents:[],nativeOpen:[],phases:[],watchPolls:[],watchScans:[],watchLifecycle:[],watchEvents:[],started:performance.now(),timeOrigin:performance.timeOrigin};
global.__zoridNavigationProfileQuit=()=>require('electron').app.quit();
const electron=require('electron');electron.app.once('ready',()=>global.__zoridNavigationProfile.windowEvents.push({event:'app-ready',at:performance.now()}));
function phase(name,action){const row={phase:name,startedAt:performance.now()};global.__zoridNavigationProfile.phases.push(row);try{const result=action();return Promise.resolve(result).then(value=>{row.finishedAt=performance.now();return value;},error=>{row.finishedAt=performance.now();row.code=error?.code;throw error;});}catch(error){row.finishedAt=performance.now();row.code=error?.code;throw error;}}
const loadFile=electron.BrowserWindow.prototype.loadFile;electron.BrowserWindow.prototype.loadFile=function(...args){return phase('BrowserWindow.loadFile',()=>loadFile.apply(this,args));};
require('electron').app.on('browser-window-created',(_event,window)=>{
 for(const name of ['ready-to-show','show'])window.once(name,()=>global.__zoridNavigationProfile.windowEvents.push({event:name,at:performance.now()}));
 for(const name of ['dom-ready','did-finish-load'])window.webContents.once(name,()=>global.__zoridNavigationProfile.windowEvents.push({event:name,at:performance.now()}));
 window.webContents.once('dom-ready',()=>{void window.webContents.executeJavaScript(${JSON.stringify(startupObserver)}).catch(error=>global.__zoridNavigationProfile.windowEvents.push({event:'startup-observer-error',at:performance.now(),message:String(error)}));});
});
const {RustVaultService}=require(${JSON.stringify(path.join(root,'desktop/rust-vault-service.cjs'))});
const {decodeRuntimeReply,isRuntimeOp}=require(${JSON.stringify(path.join(root,'desktop/document-runtime.cjs'))});
const issuedEffects=new Map();
const effectKey=value=>value.lifetime+':'+value.effectId;
function rememberEffect(value){if(value&&issuedEffects.size<50000)issuedEffects.set(effectKey(value),value.effect.kind);}
function runtimeTelemetry(command,row,reply){
 if(command.method==='document_work'){row.effectKind='unknown';row.effectClassification='composite-work-unsupported';return;}
 if(command.method!=='documents'||!isRuntimeOp(row.operation))return;
 try{
  const value=decodeRuntimeReply(command.request,reply.result,reply.bytes),snapshot=value?.snapshot,update=snapshot?.update??value?.update??value?.frame?.update;
  if(snapshot){rememberEffect(snapshot.inFlight);rememberEffect(snapshot.lastStep?.reduction?.effect);}
  if(update)row.runtime={phase:update.phase,freshness:update.freshness,sourceWatermark:update.source?.watermark??null,publishedGeneration:update.published?{epoch:update.published.generationEpoch,generation:update.published.generation}:null,progress:update.progress,execution:snapshot?.execution??null,inFlight:snapshot?.inFlight?{lifetime:snapshot.inFlight.lifetime,effectId:snapshot.inFlight.effectId,effectKind:snapshot.inFlight.effect.kind}:null,lastStep:snapshot?.lastStep?{lifetime:snapshot.lastStep.lifetime,effectId:snapshot.lastStep.effectId}:null};
 }catch(error){row.runtimeTelemetryError=error?.code??String(error);}
}
const originalOpen=RustVaultService.open;
RustVaultService.open=async function(...args){const row={startedAt:performance.now()};global.__zoridNavigationProfile.nativeOpen.push(row);try{const result=await originalOpen.apply(this,args);row.finishedAt=performance.now();row.pid=result.child?.pid;row.initialReconciliation=result.reconciliation?structuredClone(result.reconciliation):null;return result;}catch(error){row.finishedAt=performance.now();row.code=error?.code;throw error;}};
const original=RustVaultService.prototype.request;
RustVaultService.prototype.request=function(command,...args){
 const row={method:command?.method,operation:command?.request?.command?.op??command?.request?.op??command?.request?.kind??null,queuedAt:performance.now(),queueDepth:this.queuedCount};
 if(row.method==='documents'&&row.operation==='runtime_step'){const token=command.request.command;row.requestedEffect={lifetime:token.lifetime,effectId:token.effectId};row.effectKind=issuedEffects.get(effectKey(token))??'unknown';row.effectClassification=row.effectKind==='unknown'?'previous-issued-effect-unavailable':'previous-issued-effect';}
 if(row.method==='document_work'){row.effectKind='unknown';row.effectClassification='composite-work-unsupported';}
 const before=this.tail;Promise.resolve(before).then(()=>{row.dispatchAt=performance.now();},()=>{row.dispatchAt=performance.now();});
 const result=original.call(this,command,...args);
 result.then(reply=>{row.finishedAt=performance.now();row.ok=true;runtimeTelemetry(command,row,reply);},error=>{row.finishedAt=performance.now();row.ok=false;row.code=error?.code;});
 if(global.__zoridNavigationProfile.events.length<30000)global.__zoridNavigationProfile.events.push(row);return result;
};
const {CoreVaultFixtureService}=require(${JSON.stringify(path.join(root,'desktop/core-vault-fixture-service.cjs'))});
let pollOrdinal=0;const lastPoll=new WeakMap();
function watchSnapshot(service){const state=service.watchState,now=typeof service.now==='function'?service.now():Date.now(),hints=[...service.hints??[]],kinds=hints.length?new Map([...service.entries?.values()??[]].filter(row=>!row.state.deleted).map(row=>[row.state.path,row.state.kind])):new Map();return{at:performance.now(),now,lastScan:service.lastScan,elapsedMs:now-service.lastScan,rescanMs:service.rescanMs,needsScan:service.needsScan,active:state?.active??null,healthy:state?.healthy??null,started:state?.started??null,watcherPresent:!!service.watcher,hasStartedPolling:service.hasStartedPolling??null,hintsCount:hints.length,hints:hints.slice(0,32).map(path=>({path,kind:kinds.get(path)??null})),allHintsKnownFiles:!!hints.length&&hints.every(path=>kinds.get(path)==='file'),reconciliationComplete:service.reconciliation?.complete??null,runtimeOwners:[...service.documentRuntimeOwners??[]].map(owner=>({paused:owner.paused})),timerPresent:!!service.timer};}
const corePoll=CoreVaultFixtureService.prototype.pollNow;CoreVaultFixtureService.prototype.pollNow=function(...args){const row={ordinal:++pollOrdinal,before:watchSnapshot(this)};lastPoll.set(this,row);if(global.__zoridNavigationProfile.watchPolls.length<10000)global.__zoridNavigationProfile.watchPolls.push(row);return corePoll.apply(this,args);};
const coreScan=CoreVaultFixtureService.prototype.scanNow;CoreVaultFixtureService.prototype.scanNow=function(...args){const row={before:watchSnapshot(this),lastPoll:lastPoll.get(this)??null,stack:new Error('profile scan caller').stack.split('\\n').slice(1,7)};if(global.__zoridNavigationProfile.watchScans.length<10000)global.__zoridNavigationProfile.watchScans.push(row);return coreScan.apply(this,args);};
for(const method of ['syncPolling','startPolling','stopPolling']){const original=CoreVaultFixtureService.prototype[method];CoreVaultFixtureService.prototype[method]=function(...args){const row={method,before:watchSnapshot(this),stack:new Error('profile watcher lifecycle').stack.split('\\n').slice(1,7)};try{return original.apply(this,args);}finally{row.after=watchSnapshot(this);if(global.__zoridNavigationProfile.watchLifecycle.length<10000)global.__zoridNavigationProfile.watchLifecycle.push(row);}};}
const coreOpen=CoreVaultFixtureService.open;CoreVaultFixtureService.open=function(...args){const options=args[1]??{},factory=options.watchFactory??require('node:fs').watch;args[1]={...options,watchFactory:function(...watchArgs){const callback=watchArgs[2];watchArgs[2]=function(kind,file){if(global.__zoridNavigationProfile.watchEvents.length<10000)global.__zoridNavigationProfile.watchEvents.push({at:performance.now(),kind,file:file==null?null:file.toString()});return callback.apply(this,arguments);};return factory.apply(this,watchArgs);}};return phase('CoreVaultFixtureService.open',()=>coreOpen.apply(this,args));};
const managerModule=require(${JSON.stringify(path.join(root,'desktop/editor-core.cjs'))});const createManager=managerModule.createEditorCoreManager;
managerModule.createEditorCoreManager=function(...args){const result=createManager.apply(this,args);if(result){const open=result.open;result.open=function(...args){return phase('editorCore.open',()=>open.apply(this,args));};}return result;};
global.__zoridNavigationProfile.windowEvents.push({event:'main-require-start',at:performance.now()});
require(${JSON.stringify(path.join(root,'desktop/main.cjs'))});
global.__zoridNavigationProfile.windowEvents.push({event:'main-require-end',at:performance.now()});
`,{flag:'wx'});
let child,renderer,main,campaignError,stderr='',stdout='';const cleanupErrors=[];
const exited=()=>child?.exitCode!==null||child?.signalCode!==null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(action,timeout=30000){const end=performance.now()+timeout;let error;do{assert.ok(!exited(),`Owned Electron exited: ${stderr}`);try{return await action();}catch(e){error=e;}await sleep(15);}while(performance.now()<end);throw error??Error('Profiling wait deadline');}
async function getJSON(url){return fetch(url,{signal:AbortSignal.timeout(2000)}).then(reply=>reply.json());}
async function rendererEvidence(record,label){
 if(!renderer)return;
 try{
  const value=await renderer.evaluate(`(()=>{const pane=document.querySelector('.pane.is-active');return{label:${JSON.stringify(label)},at:performance.now(),startup:window.__zoridNavigationStartup??null,activeTitles:[...pane?.querySelectorAll('.note-title')??[]].map(node=>node.value),activeTreePaths:[...document.querySelectorAll('.tree-row.is-active')].map(node=>node.dataset.path),readingPreviews:pane?.querySelectorAll('.markdown-preview').length,errors:[...document.querySelectorAll('.error-message,.notice,.startup-failed')].map(node=>node.textContent.slice(0,1000)),editors:[...pane?.querySelectorAll('.cm-content')??[]].map(node=>{const view=node.cmTile?.root?.view,alternative=node.cmView?.view;return{visible:!!node.getClientRects().length,cmKeys:Object.getOwnPropertyNames(node).filter(key=>key.toLowerCase().includes('cm')),hasExpectedView:!!view,hasAlternativeView:!!alternative,document:view?.state?.doc?.toString()??alternative?.state?.doc?.toString()??null,visibleText:node.textContent.slice(0,150)};})};})()`);
  for(const editor of value.editors){if(editor.document!==null){editor.documentChars=editor.document.length;editor.documentSha256=createHash('sha256').update(editor.document).digest('hex');editor.matchesNote0=editor.document===sources.get('Note 0000.md');delete editor.document;}}
  (record.rendererEvidence??=[]).push(value);record.rendererErrors=renderer.events;
 }catch(error){(record.rendererEvidenceErrors??=[]).push({label,error:String(error)});}
 if(label==='failure')try{const {data}=await renderer.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,'failure.png'),Buffer.from(data,'base64'));}catch(error){(record.rendererEvidenceErrors??=[]).push({label:'failure-screenshot',error:String(error)});}
}
async function stop(record){
 if(!child)return;const owned=child,evidenceErrors=[],shutdownStarted=performance.now(),alive=()=>owned.exitCode===null&&owned.signalCode===null;
 const waitForExit=async milliseconds=>{const end=performance.now()+milliseconds;while(alive()&&performance.now()<end)await sleep(20);};
 record.stdout=stdout;record.stderr=stderr;
 try{
  if(main&&alive()){
   const fields=[['requests','events'],['windowEvents','windowEvents'],['nativeOpen','nativeOpen'],['phases','phases'],['mainTimeOrigin','timeOrigin'],['watchPolls','watchPolls'],['watchScans','watchScans'],['watchLifecycle','watchLifecycle'],['watchEvents','watchEvents']];
   const results=await Promise.allSettled(fields.map(([,field])=>main.evaluate('global.__zoridNavigationProfile.'+field)));
   for(let index=0;index<results.length;index++){const result=results[index],field=fields[index][0];if(result.status==='fulfilled')record[field]=result.value;else evidenceErrors.push({field,error:String(result.reason)});}
  }
 }catch(error){evidenceErrors.push({field:'evidence-capture',error:String(error)});}
 finally{
  try{if(main&&alive())await main.evaluate('global.__zoridNavigationProfileQuit();true');}catch(error){record.quitRequestError=String(error);}
  try{renderer?.close();}catch(error){evidenceErrors.push({field:'renderer-close',error:String(error)});}
  try{main?.close();}catch(error){evidenceErrors.push({field:'main-close',error:String(error)});}
  renderer=undefined;main=undefined;
  record.shutdownGraceMs=shutdownTimeoutMs;await waitForExit(shutdownTimeoutMs);
  if(alive()){record.forcedTermination=true;try{owned.kill('SIGTERM');}catch(error){record.terminationError=String(error);}await waitForExit(5000);}
  if(alive()){record.forcedKill=true;try{owned.kill('SIGKILL');}catch(error){record.killError=String(error);}await waitForExit(5000);}
  record.exitCode=owned.exitCode;record.signal=owned.signalCode;
  record.shutdownElapsedMs=performance.now()-shutdownStarted;
  if(!alive())child=undefined;
 }
 if(evidenceErrors.length){record.evidenceErrors=evidenceErrors;throw Error('Profiling evidence capture failed; shutdown was still attempted');}
 assert.equal(alive(),false,'Owned Electron remained alive after bounded cleanup');
}
async function clickFile(name){
 const source=sources.get(name);assert.ok(source);
 return renderer.evaluate(`new Promise((resolve,reject)=>{
  const row=[...document.querySelectorAll('.tree-row[data-path]')].find(row=>row.dataset.path===${JSON.stringify(name)});if(!row){reject(Error('File row missing'));return;}
  const start=performance.now();let found=false;
  const check=()=>{const node=document.querySelector('.pane.is-active .cm-content'),view=node?.cmTile?.root?.view;if(view&&view.contentDOM===node&&view.state.doc.toString()===${JSON.stringify(source)}){found=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{observer.disconnect();clearTimeout(timer);const paintedAt=performance.now();resolve({path:${JSON.stringify(name)},clickToPaintMs:paintedAt-start,rendererTimeOrigin:performance.timeOrigin,clickStartedAt:start,clickPaintedAt:paintedAt});}));}};
  const observer=new MutationObserver(()=>{if(!found)check();});observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  const timer=setTimeout(()=>{observer.disconnect();reject(Error('Editor paint deadline; exact CodeMirror document was not observed'));},18000);row.click();check();
 })`);
}
async function measuredClick(name){
 const first=await main.evaluate('global.__zoridNavigationProfile.events.length');
 const result=await clickFile(name);
 const last=await main.evaluate('global.__zoridNavigationProfile.events.length');
 return {...result,requestRange:[first,last]};
}
async function clickBase(){
 const first=await main.evaluate('global.__zoridNavigationProfile.events.length');
 const result=await renderer.evaluate(`new Promise((resolve,reject)=>{
  const row=[...document.querySelectorAll('.tree-row[data-path]')].find(row=>row.dataset.path===${JSON.stringify(basePath)});if(!row){reject(Error('Base file row missing'));return;}
  const start=performance.now();let scheduled=false,done=false;
  function snapshot(){
   const pane=document.querySelector('.pane.is-active'),session=pane?.querySelector('.bases-session'),grid=session?.querySelector('.zorid-bases-table');
   const error=pane?.querySelector('.error-message');if(error||session?.dataset.baseControllerError==='true')throw Error('Base open failed: '+(error?.textContent??session?.querySelector('.bases-session-status')?.textContent??'source/query error'));
   if(!session||!grid||!grid.getClientRects().length||session.dataset.baseControllerUpdating!=='false'||session.querySelector('.bases-session-content')?.getAttribute('aria-busy')!=='false')return;
   const status=[...session.querySelectorAll('.bases-session-status,.zorid-bases-table-status')].map(node=>node.textContent.trim()).filter(Boolean);if(status.length)return;
   const cells=[...grid.querySelectorAll('.zorid-bases-table-body [role="gridcell"][data-property="file.name"][data-path]')],first=cells[0];
   const chromeRows=1+(grid.querySelector('.zorid-bases-table-new-row')?1:0)+(grid.querySelector('.zorid-bases-table-footer:not([hidden])')?1:0),totalRows=Number(grid.getAttribute('aria-rowcount'))-chromeRows;
   if(totalRows!==${notes}||!first||first.dataset.path!=='Note 0000.md'||!first.getClientRects().length)return;
   return{totalRows,visibleRows:cells.length,firstRowPath:first.dataset.path,firstRowText:first.textContent.trim(),controllerVersion:session.dataset.baseControllerVersion,status};
  }
  const observer=new MutationObserver(check),timer=setTimeout(()=>finish(Error('Base ready deadline; refusing empty/loading/error results')),18000);
  function finish(error,result){if(done)return;done=true;observer.disconnect();clearTimeout(timer);error?reject(error):resolve(result);}
  function check(){if(done||scheduled)return;let value;try{value=snapshot();}catch(error){finish(error);return;}if(!value)return;scheduled=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{scheduled=false;try{const painted=snapshot();if(painted)finish(null,{path:${JSON.stringify(basePath)},clickToPaintMs:performance.now()-start,...painted});}catch(error){finish(error);}}));}
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});row.click();check();
 })`);
 const last=await main.evaluate('global.__zoridNavigationProfile.events.length');
 return{...result,requestRange:[first,last]};
}
let admittedContext;
const dom=body=>renderer.evaluate(`(()=>{${body}})()`);
async function readCore(method,args){
 admittedContext??=await renderer.evaluate(`window.zorid.getDurableContext(${JSON.stringify(vault)})`);assert.ok(admittedContext.admissionId&&admittedContext.scope?.vaultId);
 return renderer.evaluate(`window.zorid.durableInvoke(${JSON.stringify(vault)},${JSON.stringify(admittedContext.admissionId)},${JSON.stringify(method)},${JSON.stringify(args)})`);
}
const indexCurrent=value=>value?.state==='ready'&&value.coverageComplete===true&&value.observedSourceHead===value.source.watermark&&value.coveredWatermark===value.source.watermark;
const idleWork=row=>row.method==='rescan'||row.method==='document_work'||row.method==='documents'&&['runtime_step','initialize','begin','pump','publish','rebuild'].includes(row.operation);
async function indexStatus(){const value=await readCore('documentCommand',[{schemaVersion:1,command:{op:'status'}}]);assert.equal(value.source.localStoreId,admittedContext.scope.vaultId);return value;}
async function currentIndex(){return wait(async()=>{const value=await indexStatus();assert.ok(indexCurrent(value),'Index is not current/complete');return value;},60000);}
async function filesSidebar(){await dom(`const button=document.querySelector('.sidebar-tabs button[data-type="files"]');if(!button)throw Error('Normal Files tab unavailable');button.click();return true;`);}
async function searchUI(query,expectedPath,expectedId){
 const started=performance.now(),loadMoreActions=[];let lastDOM;
 await dom(`const button=document.querySelector('.sidebar-tabs button[data-type="search"]');if(!button)throw Error('Normal Search tab unavailable');button.click();const input=document.querySelector('.document-search-field input[type="search"]');if(!input)throw Error('Normal Search input unavailable');input.focus();return true;`);
 await renderer.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await renderer.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4});await renderer.call('Input.insertText',{text:query});
 let visible;try{visible=await wait(async()=>{
  const value=await dom(`const root=document.querySelector('.document-search');return{visible:!!root?.getClientRects().length,busy:root?.getAttribute('aria-busy'),input:root?.querySelector('input[type="search"]')?.value,status:root?.querySelector('.document-search-status')?.textContent,total:root?.querySelector('.document-search-total')?.textContent,actions:root?.querySelector('.document-search-actions')?.childElementCount,pending:root?.querySelectorAll('.document-search-file-pending').length,rows:[...root?.querySelectorAll('.document-search-file')??[]].map(row=>({id:row.dataset.entryId,path:row.querySelector('.document-search-title')?.title,snippets:[...row.querySelectorAll('.document-search-snippet')].map(node=>node.textContent)}))};`);
  lastDOM=value;
  if(value.visible&&value.input===query&&value.busy==='false'&&value.actions>0){
   const action=await dom(`const root=document.querySelector('.document-search');if(!root?.getClientRects().length||root.querySelector('input[type="search"]')?.value!==${JSON.stringify(query)}||root.getAttribute('aria-busy')!=='false')return null;const button=[...root.querySelectorAll('.document-search-actions button')].find(node=>node.textContent.trim()==='Load more results'&&!node.disabled&&node.getClientRects().length);if(!button)return null;const action={label:button.textContent.trim(),at:performance.now(),statusBefore:root.querySelector('.document-search-status')?.textContent,totalBefore:root.querySelector('.document-search-total')?.textContent};button.click();return action;`);
   if(action)loadMoreActions.push(action);
  }
  assert.ok(value.visible&&value.input===query&&value.busy==='false'&&value.actions===0&&value.pending===0,'Normal search still loading/incomplete');
  if(expectedPath){assert.equal(value.status,'');assert.equal(value.total,'1 match in 1 file');assert.equal(value.rows.length,1);assert.equal(value.rows[0].path,expectedPath);if(expectedId)assert.equal(value.rows[0].id,expectedId);assert.ok(value.rows[0].snippets.some(text=>text.includes(query)),'Expected exact marker snippet');}
  else{assert.equal(value.status,'No matching files.');assert.equal(value.total,'0 matches in 0 files');assert.equal(value.rows.length,0);}
  return value;
 },60000);}catch(error){const record=report.launches.at(-1);if(record)(record.searchFailures??=[]).push({query,expectedPath,lastDOM,loadMoreActions,elapsedObservedMs:performance.now()-started});throw error;}
 const status=await currentIndex();return{query,visible,status,loadMoreActions,elapsedObservedMs:performance.now()-started};
}
async function settledIdle(record){
 const settled=await searchUI('zoridprofilersetttledabsent'+randomUUID().replaceAll('-',''),null);await filesSidebar();await sleep(1000);
 const before=await currentIndex(),beforePending=await wait(async()=>{const pending=await main.evaluate('global.__zoridNavigationProfile.events.filter(row=>row.finishedAt===undefined)');assert.deepEqual(pending.filter(idleWork),[],'Prior native maintenance must finish before idle measurement');return pending;},60000),first=await main.evaluate('global.__zoridNavigationProfile.events.length'),started=performance.now();
 console.log(JSON.stringify({phase:'settled-idle',durationMs:idleMs}));
 const end=started+idleMs;while(performance.now()<end)await sleep(Math.min(1000,end-performance.now()));
 const ended=performance.now(),requests=await main.evaluate(`global.__zoridNavigationProfile.events.slice(${first})`),after=await currentIndex();
 const forbidden=requests.filter(idleWork);
 const runtimeSteps=requests.filter(row=>row.method==='documents'&&row.operation==='runtime_step'),effectCounts={};for(const row of runtimeSteps){const key=row.effectKind??'unknown';effectCounts[key]=(effectCounts[key]??0)+1;}
 const actualIndexWork=runtimeSteps.filter(row=>['initialize','begin','pump','publish','rebuild'].includes(row.effectKind)),housekeeping=runtimeSteps.filter(row=>['observe','recoverStage','discard'].includes(row.effectKind)),unknownEffectWork=requests.filter(row=>row.method==='document_work'||row.method==='documents'&&row.operation==='runtime_step'&&(!row.effectKind||row.effectKind==='unknown'));
 const counts={};for(const row of requests){const key=row.method+':'+(row.operation??'');counts[key]=(counts[key]??0)+1;}
 record.idle={settled,before,after,beforePending,durationMs:ended-started,requests,counts,effectCounts,runtimeStepCount:runtimeSteps.length,actualIndexWork,housekeeping,unknownEffectWork,forbidden,requestRange:[first,first+requests.length]};
 assert.equal(after.source.watermark,before.source.watermark,'Idle must not advance source authority');assert.deepEqual(forbidden,[],'Settled healthy idle must not rescan or dispatch maintenance; inspect effectKinds before interpreting its cause');
}
async function forcedMaintenance(record){
 await searchUI('zoridprofilerforcedabsent'+randomUUID().replaceAll('-',''),null);await filesSidebar();await currentIndex();
 const first=await main.evaluate('global.__zoridNavigationProfile.events.length'),started=performance.now();
 record.forcedMaintenance={kind:'diagnostic-forced-full-reconciliation',started};console.log(JSON.stringify({phase:'diagnostic-forced-full-reconciliation'}));
 await dom(`window.__zoridForcedMaintenance={done:false};Promise.resolve(window.zorid.retryReconciliation(${JSON.stringify(vault)})).then(value=>{window.__zoridForcedMaintenance={done:true,value};},error=>{window.__zoridForcedMaintenance={done:true,error:String(error)};});return true;`);
 record.forcedMaintenance.switchDuringWork=await measuredClick('Note 0001.md');
 const result=await wait(async()=>{const value=await dom('return window.__zoridForcedMaintenance;');assert.equal(value.done,true,'Forced public reconciliation pending');return value;},60000);
 record.forcedMaintenance.elapsedObservedMs=performance.now()-started;record.forcedMaintenance.result=result;assert.equal(result.error,undefined);assert.equal(result.value.complete,true);assert.equal(result.value.issueCount,0);
 const last=await main.evaluate('global.__zoridNavigationProfile.events.length');record.forcedMaintenance.requestRange=[first,last];const requests=await main.evaluate(`global.__zoridNavigationProfile.events.slice(${first},${last})`);assert.ok(requests.some(row=>row.method==='rescan'),'Forced audit must execute an actual native rescan');record.forcedMaintenance.requests=requests;
 const mainTimeOrigin=await main.evaluate('global.__zoridNavigationProfile.timeOrigin'),click=record.forcedMaintenance.switchDuringWork,clickStart=click.rendererTimeOrigin+click.clickStartedAt,clickEnd=click.rendererTimeOrigin+click.clickPaintedAt;
 record.forcedMaintenance.switchAuditOverlap={mainTimeOrigin,clickEpoch:[clickStart,clickEnd],rescans:requests.filter(row=>row.method==='rescan'&&Number.isFinite(row.dispatchAt)&&Number.isFinite(row.finishedAt)).map(row=>{const started=mainTimeOrigin+row.dispatchAt,finished=mainTimeOrigin+row.finishedAt;return{epoch:[started,finished],overlapMs:Math.max(0,Math.min(clickEnd,finished)-Math.max(clickStart,started))};})};
 record.forcedMaintenance.switchAuditOverlap.observed=record.forcedMaintenance.switchAuditOverlap.rescans.some(row=>row.overlapMs>0);record.forcedMaintenance.switchAuditOverlap.qualification=record.forcedMaintenance.switchAuditOverlap.observed?'overlap-observed':'concurrent-request-only; actual overlap not observed';
 await searchUI('zoridprofilerpostforcedabsent'+randomUUID().replaceAll('-',''),null);await filesSidebar();await measuredClick('Note 0000.md');
}
async function externalAcceptance(record){
 const name=`Note ${String(notes-1).padStart(4,'0')}.md`,original=sources.get(name),marker='zoridexternal'+randomUUID().replaceAll('-',''),changed=original+'\n\n'+marker+'\n';
 const createdPath='External profile probe.md',renamedPath='External profile probe renamed.md',createMarker='zoridcreated'+randomUUID().replaceAll('-',''),createdSource='# External probe\n\n'+createMarker+'\n';
 const probe={kind:'genuine-external-filesystem-events',steps:[],watcherOverflow:'not exercised'};record.external=probe;let failure;
 for(const name of [createdPath,renamedPath])await assert.rejects(fs.stat(path.join(vault,name)),{code:'ENOENT'});
 const read=async target=>readCore('readText',[target]);
 const waitRead=async(target,content,entryId)=>wait(async()=>{const value=await read(target);assert.equal(value.content,content,'Native source has not adopted exact external bytes');if(entryId)assert.equal(value.entryId,entryId);return value;},60000);
 const stat=target=>renderer.evaluate(`window.zorid.stat(${JSON.stringify(vault)},${JSON.stringify(target)})`);
 const boundary=()=>main.evaluate('global.__zoridNavigationProfile.events.length');
 async function fallbackWitness(first){const last=await boundary(),requests=await main.evaluate(`global.__zoridNavigationProfile.events.slice(${first},${last})`);assert.ok(requests.some(row=>row.method==='rescan'),'Unknown namespace events must use conservative full reconciliation');return{requestRange:[first,last],rescanCount:requests.filter(row=>row.method==='rescan').length};}
 try{
  console.log(JSON.stringify({phase:'genuine-external-edit',path:name}));await filesSidebar();
  const before=await read(name);assert.equal(before.content,original);const inode=(await fs.stat(path.join(vault,name))).ino,first=await main.evaluate('global.__zoridNavigationProfile.events.length'),started=performance.now();
  await fs.writeFile(path.join(vault,name),changed);assert.equal((await fs.stat(path.join(vault,name))).ino,inode,'External edit must preserve inode');
  const switchDuringWork=await measuredClick('Note 0001.md'),native=await waitRead(name,changed,before.entryId),search=await searchUI(marker,name,before.entryId);
  assert.notEqual(native.revision,before.revision);probe.steps.push({kind:'inplace-edit',path:name,before,native,switchDuringWork,search,elapsedObservedMs:performance.now()-started,requestRange:[first,await main.evaluate('global.__zoridNavigationProfile.events.length')]});
  console.log(JSON.stringify({phase:'genuine-external-create'}));const createFirst=await boundary(),createStarted=performance.now();await fs.writeFile(path.join(vault,createdPath),createdSource,{flag:'wx'});
  const created=await waitRead(createdPath,createdSource),createdSearch=await searchUI(createMarker,createdPath,created.entryId);probe.steps.push({kind:'unknown-file-create',native:created,search:createdSearch,elapsedObservedMs:performance.now()-createStarted,...await fallbackWitness(createFirst)});
  console.log(JSON.stringify({phase:'genuine-external-rename'}));const renameFirst=await boundary(),renameStarted=performance.now();await fs.rename(path.join(vault,createdPath),path.join(vault,renamedPath));
  const renamed=await waitRead(renamedPath,createdSource,created.entryId),renamedSearch=await searchUI(createMarker,renamedPath,created.entryId);assert.equal(await stat(createdPath),null);probe.steps.push({kind:'rename',native:renamed,search:renamedSearch,elapsedObservedMs:performance.now()-renameStarted,...await fallbackWitness(renameFirst)});
  console.log(JSON.stringify({phase:'genuine-external-delete'}));const deleteFirst=await boundary(),deleteStarted=performance.now();await fs.unlink(path.join(vault,renamedPath));await wait(async()=>assert.equal(await stat(renamedPath),null),60000);const deletedSearch=await searchUI(createMarker,null);probe.steps.push({kind:'delete',entryId:created.entryId,search:deletedSearch,elapsedObservedMs:performance.now()-deleteStarted,...await fallbackWitness(deleteFirst)});
 }catch(error){failure=error;probe.error=error.stack??String(error);}
 finally{
  console.log(JSON.stringify({phase:'restore-external-probe-sources'}));
  probe.restorationActions=[];probe.restorationErrors=[];
  const physicalActions=[['restore-original-note',()=>fs.writeFile(path.join(vault,name),original)],['remove-created-path',()=>fs.rm(path.join(vault,createdPath),{force:true})],['remove-renamed-path',()=>fs.rm(path.join(vault,renamedPath),{force:true})]];
  const physicalResults=await Promise.allSettled(physicalActions.map(([,run])=>Promise.resolve().then(run)));
  for(let index=0;index<physicalResults.length;index++){const result=physicalResults[index],action=physicalActions[index][0],row={action,status:result.status};if(result.status==='rejected'){row.error=result.reason?.stack??String(result.reason);probe.restorationErrors.push(row);}probe.restorationActions.push(row);}
  const verify=async(action,run)=>{try{const value=await run();probe.restorationActions.push({action,status:'fulfilled'});return value;}catch(error){const row={action,status:'rejected',error:error.stack??String(error)};probe.restorationActions.push(row);probe.restorationErrors.push(row);return undefined;}};
  probe.restoredNative=await verify('verify-native-original-bytes',()=>waitRead(name,original));
  await verify('verify-created-path-absent',()=>wait(async()=>assert.equal(await stat(createdPath),null),60000));
  await verify('verify-renamed-path-absent',()=>wait(async()=>assert.equal(await stat(renamedPath),null),60000));
  probe.restoredSearch=await verify('verify-original-marker-absent',()=>searchUI(marker,null));
  await verify('verify-created-marker-absent',()=>searchUI(createMarker,null));
  await verify('return-normal-note-view',async()=>{await filesSidebar();await measuredClick('Note 0000.md');});
  probe.restoredIndex=await verify('verify-restored-current-index',currentIndex);
  probe.restored=probe.restorationErrors.length===0;if(!probe.restored)failure??=Error('External probe restoration failed; every independent action was attempted');
 }
 if(failure)throw failure;
}
async function prepareNativeAuthority(){
 const {RustVaultService}=createRequire(path.join(root,'package.json'))('./desktop/rust-vault-service.cjs');
 const previous=process.env.ZORID_LOCAL_DATA_DIR,started=performance.now(),setup={started:new Date().toISOString(),startups:[]};report.authorityPreparation=setup;
 process.env.ZORID_LOCAL_DATA_DIR=appData;
 const expected=report.sourceWitnessesBefore.map(row=>row.path);
 try{
  for(let iteration=0;iteration<15;iteration++){
   const row={iteration,started:performance.now()};setup.startups.push(row);let service;
   try{service=await RustVaultService.open(vault,{executable:native,initializeLocal:true,timeoutMs:300000});row.openMs=performance.now()-row.started;row.pid=service.child.pid;const snapshot=await service.listSnapshot();const files=snapshot.entries.filter(row=>row.state.kind==='file'&&!row.state.deleted),paths=new Set(files.map(row=>row.state.path));row.importedFiles=files.length;row.reconciliation=service.reconciliation;row.complete=files.length===expected.length&&expected.every(name=>paths.has(name))&&service.reconciliation?.complete===true;}
   finally{if(service){await service.close();row.exitCode=service.child.exitCode;row.signal=service.child.signalCode;assert.equal(row.exitCode,0,'Authority preparation must close normally');}}
   row.elapsedMs=performance.now()-row.started;console.log(JSON.stringify({phase:'authority-preparation',iteration,files:row.importedFiles,complete:row.complete,elapsedMs:row.elapsedMs}));
   if(row.complete){setup.complete=true;setup.elapsedMs=performance.now()-started;return;}
  }
  throw Error('Normal native startup did not finish synthetic import within15 startups');
 }finally{if(previous===undefined)delete process.env.ZORID_LOCAL_DATA_DIR;else process.env.ZORID_LOCAL_DATA_DIR=previous;setup.elapsedMs=performance.now()-started;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
}
function assertNormalLaunch(record){
 assert.equal(record.forcedTermination,undefined,'Normal app shutdown failed');assert.equal(record.forcedKill,undefined,'Normal app shutdown required SIGKILL');assert.equal(record.exitCode,0,'Owned Electron must exit normally with code0');assert.equal(record.signal,null,'Owned Electron must exit without a signal');assert.equal(record.evidenceErrors,undefined,'Evidence capture must succeed');
}
async function finalSourceProof(){
 report.sourceWitnessesAfter=[];report.sourceVerificationFailures=[];
 for(const expected of report.sourceWitnessesBefore){
  try{const actual={path:expected.path,sha256:await hash(path.join(vault,expected.path))};report.sourceWitnessesAfter.push(actual);if(actual.sha256!==expected.sha256)report.sourceVerificationFailures.push({path:expected.path,error:'Source hash changed'});}
  catch(error){const actual={path:expected.path,sha256:null,error:error.stack??String(error)};report.sourceWitnessesAfter.push(actual);report.sourceVerificationFailures.push(actual);}
 }
 report.sourceWitnessesMatch=report.sourceVerificationFailures.length===0;
 if(!report.sourceWitnessesMatch)cleanupErrors.push({phase:'final-source-hashes',failures:report.sourceVerificationFailures});
 try{report.sourcePathsAfter=(await fs.readdir(vault)).filter(name=>!name.startsWith('.')).sort();report.sourcePathsMatch=JSON.stringify(report.sourcePathsAfter)===JSON.stringify(report.sourceWitnessesBefore.map(row=>row.path).sort());if(!report.sourcePathsMatch)cleanupErrors.push({phase:'final-source-paths',error:'Visible source path set differs from original fixture'});}
 catch(error){report.sourcePathsMatch=false;cleanupErrors.push({phase:'final-source-paths',error:error.stack??String(error)});}
}
try{
 if(prepareAuthority)await prepareNativeAuthority();
 for(let iteration=0;iteration<runs;iteration++){
  await fs.rm(path.join(profile,'DevToolsActivePort'),{force:true});stderr='';stdout='';admittedContext=undefined;
  const env={...process.env,ZORID_DESKTOP_HOST_BIN:native,ZORID_LOCAL_DATA_DIR:appData};
  for(const name of ['ELECTRON_RUN_AS_NODE','ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_EDITOR_RUST','ZORID_FIXTURE_VAULT','ZORID_FIXTURE_SYNC_CONFIG','ZORID_FIXTURE_CLIENT_ID','ZORID_IPC_ENDPOINT'])delete env[name];
  const record={iteration,mode:prepareAuthority?'prepared-existing-vault':iteration===0&&!reused?'fresh-import':'existing-vault',started:performance.now(),spawnEpochMs:Date.now(),switches:[]};report.launches.push(record);
  child=spawn(electron,['--inspect=0',launcher,'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{cwd:root,env,stdio:['ignore','pipe','pipe']});record.pid=child.pid;
  child.stderr.on('data',bytes=>{stderr+=bytes.toString();});child.stdout.on('data',bytes=>{stdout+=bytes.toString();});
  const mainURL=await wait(()=>{const url=stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];assert.ok(url,'Main inspector unavailable');return url;});main=new CDP(mainURL);await main.call('Runtime.enable');
  const port=await wait(async()=>{const value=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];assert.match(value,/^\d+$/);return value;});
  const expectedURL=pathToFileURL(path.join(root,'dist/index.html')).href;
  const target=await wait(async()=>{const rows=await getJSON('http://127.0.0.1:'+port+'/json/list');const target=rows.find(row=>row.type==='page'&&row.url.split('#')[0]===expectedURL);assert.ok(target,'Normal renderer unavailable');return target;});
  renderer=new CDP(target.webSocketDebuggerUrl);await renderer.call('Runtime.enable');await renderer.call('Profiler.enable');await renderer.call('Profiler.start');
  record.rendererAttachedMs=performance.now()-record.started;
  await wait(async()=>assert.equal(await renderer.evaluate('Boolean(window.zorid&&document.querySelector(".workspace .tree-row"))'),true));
  record.workspaceReadyObservedMs=performance.now()-record.started;
  assert.equal((await renderer.evaluate('window.zorid.getVault()')).path,vault);
  if(iteration>0||reused){await wait(async()=>assert.equal(await renderer.evaluate('Boolean(document.querySelector(".pane.is-active .cm-content"))'),true));record.restoredEditorReadyObservedMs=performance.now()-record.started;}
  await rendererEvidence(record,'before-first-activation');
  record.firstOpen={...await measuredClick('Note 0000.md'),kind:iteration>0||reused?'same-note-activation':'first-note-open'};record.processToFirstEditorObservedMs=performance.now()-record.started;
  await sleep(250);
  const cycle=[...Array.from({length:visitCount-1},(_,index)=>index+1),0];
  for(const index of [...cycle,...cycle])record.switches.push(await measuredClick(`Note ${String(index).padStart(4,'0')}.md`));
  if(includeBase){record.baseSwitches=[];for(let cycle=0;cycle<3;cycle++){const base=await clickBase(),returnNote=await measuredClick('Note 0000.md');record.baseSwitches.push({cycle,base,returnNote});}}
  const cpu=await renderer.call('Profiler.stop');await fs.writeFile(path.join(out,`renderer-${iteration}.cpuprofile`),JSON.stringify(cpu.profile));
  record.navigationRequestRange=[0,await main.evaluate('global.__zoridNavigationProfile.events.length')];
  if(iteration===runs-1&&(idleMs||externalProbes||forceMaintenance)){
   await renderer.call('Profiler.start');
   if(idleMs)await settledIdle(record);
   if(forceMaintenance)await forcedMaintenance(record);
   if(externalProbes)await externalAcceptance(record);
   const acceptanceCPU=await renderer.call('Profiler.stop');await fs.writeFile(path.join(out,'acceptance.cpuprofile'),JSON.stringify(acceptanceCPU.profile));
  }
  record.rendererTimings=await renderer.evaluate('({timeOrigin:performance.timeOrigin,navigation:performance.getEntriesByType("navigation").map(row=>row.toJSON()),paint:performance.getEntriesByType("paint").map(row=>row.toJSON())})');
  record.startupMarkers=await renderer.evaluate('window.__zoridNavigationStartup??null');
  if(record.startupMarkers){const marker=record.startupMarkers;marker.workspaceObservation=marker.workspaceInitiallyPresent?'late-observation':'observed-appearance';marker.editorObservation=marker.editorInitiallyPresent?'late-observation':'observed-appearance';marker.processToWorkspacePaintObservedMs=marker.timeOrigin+marker.workspacePaintedAt-record.spawnEpochMs;if(iteration>0||reused)marker.processToRestoredEditorPaintObservedMs=marker.timeOrigin+marker.editorPaintedAt-record.spawnEpochMs;}
  record.rendererErrors=renderer.events;record.stdout=stdout;record.stderr=stderr;
  await stop(record);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  assertNormalLaunch(record);
  console.log(JSON.stringify({iteration,mode:record.mode,workspaceReadyMs:record.workspaceReadyObservedMs,restoredEditorReadyMs:record.restoredEditorReadyObservedMs,firstOpenMs:record.firstOpen.clickToPaintMs,switchesMs:record.switches.map(value=>value.clickToPaintMs),requests:record.requests?.length}));
 }
}catch(error){campaignError=error;report.primaryFailure=error.stack??String(error);report.error=report.primaryFailure;await rendererEvidence(report.launches.at(-1)??{},'failure');}
finally{
 try{await stop(report.launches.at(-1)??{});}catch(error){cleanupErrors.push({phase:'final-native-cleanup',error:error.stack??String(error)});}
 for(const record of report.launches){try{assertNormalLaunch(record);}catch(error){cleanupErrors.push({phase:'normal-native-exit',iteration:record.iteration,exitCode:record.exitCode,signal:record.signal,error:error.stack??String(error)});}if(record.external?.restorationErrors?.length)cleanupErrors.push({phase:'external-source-restoration',iteration:record.iteration,failures:record.external.restorationErrors});}
 try{await finalSourceProof();}catch(error){cleanupErrors.push({phase:'final-source-proof',error:error.stack??String(error)});}
 report.cleanupErrors=cleanupErrors;report.status=campaignError||cleanupErrors.length?'failed':'passed';
 try{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}catch(error){cleanupErrors.push({phase:'report-write',error:error.stack??String(error)});campaignError??=error;}
}
if(campaignError)throw campaignError;
if(cleanupErrors.length)throw Error('Profiling cleanup verification failed: '+JSON.stringify(cleanupErrors));
