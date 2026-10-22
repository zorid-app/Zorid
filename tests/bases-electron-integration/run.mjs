#!/usr/bin/env node
// Actual composed Electron journey. Never builds or chooses artifacts implicitly.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {CDP,delay,until} from '../tasks-electron-integration/cdp.mjs';
import {UI} from './ui.mjs';
import {fixtureFiles,template} from './fixtures.mjs';
import {journey} from './journey.mjs';
import {CAMPAIGN_DIRECTORIES,validateFixtureName,readFixture,writeFixture,campaignClosure} from './owned-fixtures.mjs';
import {relayProcessOwnership,livingOwnedProcesses,discoverUnannouncedRelayProcesses} from './native-ownership.mjs';
import {windowMode,assertNativeWindowVisible,assertRendererVisible,nativeWindowAdapterSource} from './window-visibility.mjs';

const arg = name => { const i=process.argv.indexOf(name); return i<0?undefined:process.argv[i+1]; };
const required = name => { const value=arg(name); assert.ok(value,`Explicit ${name} required`); return value; };
const requestedWindowMode=windowMode(process.argv.slice(2));
const windowBootstrapProbe=process.argv.includes('--window-bootstrap-probe');
assert.equal(arg('--ready'),windowBootstrapProbe?'owned-window-bootstrap-frozen':'bases-native-and-frontend-frozen','Coordinator readiness gate required');
if(windowBootstrapProbe){assert.equal(requestedWindowMode,'visible','Window bootstrap probe requires --show-window');assert.ok(!arg('--campaign-module'),'Window bootstrap probe cannot run a product campaign');}
const root=await fs.realpath(required('--root')),head=required('--expected-head');
const native=await fs.realpath(required('--native')),electron=await fs.realpath(required('--electron'));
assert.match(head,/^[0-9a-f]{40}$/);
const harness=path.dirname(fileURLToPath(import.meta.url));
const campaignRequested=arg('--campaign-module');
const campaignPath=campaignRequested?await fs.realpath(campaignRequested):undefined;
if(campaignPath){
  assert.ok(CAMPAIGN_DIRECTORIES.some(name=>campaignPath===path.join(path.dirname(harness),name,'campaign.mjs')),'Only an explicitly owned supplemental campaign module is admitted');
}
const campaign=campaignPath?await import(pathToFileURL(campaignPath).href):undefined;
if(campaign)assert.ok(typeof campaign.fixtureFiles==='function'&&typeof campaign.journey==='function','Explicit supplemental campaign exports');
const recoveryCampaign=campaignPath===path.join(path.dirname(harness),'bases-electron-recovery-integration/campaign.mjs');
if(campaign?.createNativeRelay)assert.ok(recoveryCampaign,'Only the approved recovery campaign may select a test relay');
const vaultName=campaign?.vaultName??'vault';assert.match(vaultName,/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/,'Owned fixture vault basename');
const outRequested=path.resolve(required('--out'));
// Require an existing evidence parent; aliases are resolved before any writes.
const out=path.join(await fs.realpath(path.dirname(outRequested)),path.basename(outRequested));
for(const protectedRoot of [root,await fs.realpath(harness),...(campaignPath?[path.dirname(campaignPath)]:[])])assert.ok(out!==protectedRoot&&!out.startsWith(protectedRoot+path.sep),'Evidence must be outside source/artifact roots');
await fs.mkdir(out); // A fresh directory avoids overwriting retained evidence.
const sandbox=path.join(out,'disposable'),vault=path.join(sandbox,vaultName),profile=path.join(sandbox,'profile');
const yaml=createRequire(path.join(root,'package.json'))('yaml');
const evidence={kind:windowBootstrapProbe?'actual-electron-owned-window-bootstrap-probe':campaign?'actual-electron-bases-supplemental':'actual-electron-bases-heavy-user',...(windowBootstrapProbe?{scope:'Harness window activation/visibility and normal quit only. No Bases, Rust semantic, or matching native product acceptance.'}:{}),...(campaignPath?{campaignModule:campaignPath}:{}),status:'running',started:new Date().toISOString(),head,windowMode:requestedWindowMode,actions:[],checks:[],screenshots:[],runtime:[],limitations:[requestedWindowMode==='visible'?'Owned native window is shown; activation and focus outcomes are recorded. User interaction can affect this run; OS foreground and physical keyboard parity are not established.':'CDP renderer input and hit testing; not OS foreground focus/keyboard parity','Synthetic TSV ClipboardEvent exercises the production event handler, not the system clipboard','Disposable prelaunch fixtures and explicit external-editor/failure fixtures are not user creation coverage','No mobile, sync, arbitrary crash/power-loss, or performance acceptance follows from this journey']};
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
async function hash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
async function tree(directory){const result=[];async function visit(relative=''){for(const entry of(await fs.readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(relative,entry.name);assert.ok(!entry.isSymbolicLink(),'No artifact symlink: '+name);if(entry.isDirectory())await visit(name);else if(entry.isFile())result.push([name,await hash(path.join(directory,name))]);}}await visit();return result;}
async function provenance(){assert.equal(git('rev-parse','HEAD').trim(),head,'Frozen integration HEAD changed');assert.equal(git('diff','--name-only','HEAD').trim(),'','Frozen tracked source changed');const names=git('ls-files','-z','desktop','src','crates','scripts','Cargo.toml','Cargo.lock','package.json','pnpm-lock.yaml','vite.config.mjs','index.html').split('\0').filter(Boolean).sort();return{head,tracked:await Promise.all(names.map(async name=>[name,await hash(path.join(root,name))])),dist:await tree(path.join(root,'dist')),native:{file:native,sha256:await hash(native)},...(relay?{relay:{executable:relayExecutable,identity:relayIdentity,files:await Promise.all(relayFiles.map(async file=>[file,await hash(file)])),node:{file:relayIdentity.executable,sha256:await hash(await fs.realpath(relayIdentity.executable))}}}:{}),electron:{file:electron,sha256:await hash(electron)},harness:await tree(harness),campaigns:await campaignClosure(path.dirname(harness),tree),cdpHelper:await hash(path.join(harness,'../tasks-electron-integration/cdp.mjs'))};}
const processes=()=>execFileSync('ps',['-ww','-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:Number(m[1]),parent:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
let child,cdp,browserCDP,ui,record,before,failure,relay,relayExecutable,relayIdentity,relayFiles=[];
const natives=new Map();
const exited=()=>!child||child.exitCode!==null||child.signalCode!==null;
async function nativeChildren(requireLineage=false){
  const rows=processes();
  if(!relay){const owned=rows.filter(row=>row.parent===child?.pid&&row.command.startsWith(native+' --vault '+vault));for(const row of owned)natives.set(row.pid,row);return owned;}
  for(const row of discoverUnannouncedRelayProcesses({rows,native,vault,identity:relayIdentity}))natives.set(row.pid,row);
  const events=(await relay.events()).slice(record?.relayEventOffset??0);if(!events.some(event=>event.kind==='started')){assert.ok(!requireLineage,'Relay launch event required');return livingOwnedProcesses(natives.values(),rows);}
  const owned=relayProcessOwnership({events,rows,native,vault,identity:relayIdentity,appPid:child?.pid,requireLineage});
  for(const value of owned)natives.set(value.pid,value);return livingOwnedProcesses(owned,rows);
}
function appKit(action){
  assert.ok(['hide','show','terminate'].includes(action));assert.ok(child&&!exited());
  const owned=processes().find(row=>row.pid===child.pid);
  assert.ok(owned?.command.startsWith(electron+' ')&&owned.command.includes(path.join(root,'desktop/main.cjs'))&&owned.command.includes('--user-data-dir='+profile),'Exact owned app guard');
  const script=`ObjC.import('AppKit');${action==='show'?nativeWindowAdapterSource:''}function run(a){
    const p=Number(a[0]),app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(p);
    if(Number(app.processIdentifier)!==p||ObjC.unwrap(app.executableURL.path)!==a[1])throw Error('Owned app identity changed');
    let accepted;
    if(a[2]==='show'){
      const unhidden=Boolean(app.unhide),activated=Boolean(app.activateWithOptions(3));accepted=unhidden&&activated;
      let observed=readOwnedNativeWindows(p);
      const end=Date.now()+3000;while((Boolean(app.isHidden)||!observed.windows.length)&&Date.now()<end){$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));observed=readOwnedNativeWindows(p);}
      return JSON.stringify({pid:p,requested:{unhide:true,activateAllWindows:true},unhideAccepted:unhidden,activationAccepted:activated,accepted,hidden:Boolean(app.isHidden),active:Boolean(app.isActive),...observed});
    }
    accepted=Boolean(a[2]==='hide'?app.hide:app.terminate);
    if(a[2]==='hide'){const end=Date.now()+1000;while(!Boolean(app.isHidden)&&Date.now()<end)$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));}
    return JSON.stringify({pid:p,accepted,hidden:Boolean(app.isHidden)});
  }`;
  return JSON.parse(execFileSync('osascript',['-l','JavaScript','-e',script,String(child.pid),electron,action],{encoding:'utf8',timeout:action==='show'?6000:5000}));
}
async function diskGuard(){
  const stat=await fs.statfs(out,{bigint:true}),free=stat.bavail*stat.bsize,required=1073741824n;
  // Preserve the observed sample even when the unchanged guard aborts launch.
  (evidence.diskGuards??=[]).push({name:'minimum-free-space',at:Date.now(),bytes:String(free),requiredBytes:String(required)});
  assert.ok(free>=required,'At least 1 GiB free required');
}
async function stop(){
  browserCDP?.close();browserCDP=undefined;if(!child)return;
  let ownershipFailure;try{await nativeChildren();}catch(error){ownershipFailure=error;}
  if(cdp){record.events=cdp.events;cdp.close();cdp=undefined;}
  if(relay)try{await relay.dispose();}catch(error){ownershipFailure??=error;}
  const shutdown={pid:child.pid,method:exited()?'already-exited':'SIGTERM-cleanup'};
  if(!exited()){child.kill('SIGTERM');try{await until(async()=>assert.ok(exited()),5000);}catch{shutdown.method='SIGKILL-cleanup';child.kill('SIGKILL');await until(async()=>assert.ok(exited()),5000);}}
  // A relay/native pair can become reparented after app or transport exit.
  // Recover its authenticated PID/command identities before checking leftovers.
  try{await nativeChildren();}catch(error){ownershipFailure??=error;}
  const alive=()=>livingOwnedProcesses(natives.values(),processes());let leaked=[];
  try{await until(async()=>assert.equal(alive().length,0),5000);}catch{leaked=alive();for(const value of leaked)process.kill(value.pid,'SIGKILL');await until(async()=>assert.equal(alive().length,0),5000);}
  Object.assign(shutdown,{exitCode:child.exitCode,signal:child.signalCode,nativeChildren:[...natives.values()],leaked});
  if(relay){shutdown.relayEvents=await relay.events();evidence.relayEvents=shutdown.relayEvents;}
  evidence.runtime.push({shutdown});child=undefined;natives.clear();
  assert.deepEqual(leaked,[],'Owned native/relay processes leaked; cleaned, acceptance fails');if(ownershipFailure)throw ownershipFailure;
}
async function forceShutdown(name){
  assert.ok(recoveryCampaign&&relay&&child,'Explicit recovery campaign interruption only');
  evidence.actions.push({action:'forced-negative-app-interruption',name,pid:child.pid,at:Date.now()});
  await stop();evidence.checks.push({name,kind:'forced-negative-app-interruption',gracefulAcceptance:false});
}
async function launch(name){await diskGuard();assert.ok(!child);await fs.rm(path.join(profile,'DevToolsActivePort'),{force:true});const env={...process.env,ZORID_DESKTOP_HOST_BIN:relayExecutable??native,ZORID_LOCAL_DATA_DIR:path.join(sandbox,'app-data')};for(const name of ['ELECTRON_RUN_AS_NODE','ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_EDITOR_RUST','ZORID_FIXTURE_VAULT','ZORID_FIXTURE_SYNC_CONFIG','ZORID_FIXTURE_CLIENT_ID'])delete env[name];record={name,stdout:'',stderr:'',...(relay?{relayEventOffset:(await relay.events()).length}:{})};evidence.runtime.push(record);child=spawn(electron,[path.join(root,'desktop/main.cjs'),'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{cwd:root,env,stdio:['ignore','pipe','pipe']});let spawnError;child.on('error',error=>{spawnError=error;});for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>{if(record[stream].length<256000)record[stream]+=bytes.toString();});const port=await until(async()=>{if(spawnError)throw spawnError;assert.ok(!exited(),record.stderr);let value;try{value=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{value=record.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];}assert.match(value,/^[1-9][0-9]{0,4}$/);return value;},30000);const target=await until(async()=>{const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());const value=rows.find(r=>r.type==='page'&&r.url.startsWith('file:')&&r.url.includes('/dist/index.html'));assert.ok(value);return value;},30000);cdp=new CDP(target.webSocketDebuggerUrl);ui=new UI(cdp,evidence.actions);await cdp.call('Runtime.enable');await cdp.call('Log.enable');await cdp.call('Page.enable');await ui.wait('return !!(window.zorid&&document.querySelector(".workspace"));','Normal Workspace',45000);const admitted=await cdp.evaluate('window.zorid.getVault()');assert.equal(admitted.path,vault,'Only owned disposable vault');record.pid=child.pid;record.url=target.url;record.cdpPort=port;record.nativeChildren=await nativeChildren(!!relay);assert.equal(record.nativeChildren.length,relay?2:1,'Exactly the owned matching host or relay/native pair');if(requestedWindowMode==='visible'){
  const frontRequest={requested:true};try{await cdp.call('Page.bringToFront');frontRequest.accepted=true;}catch(error){frontRequest.accepted=false;frontRequest.error=error.message;}
  const nativeVisibility=appKit('show');
  const observeDocument=()=>ui.dom('return {visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus()};');
  record.visibility={mode:'visible',frontRequest,native:nativeVisibility,renderer:await observeDocument()};
  assertNativeWindowVisible(nativeVisibility,child.pid);
  await until(async()=>{record.visibility.renderer=await observeDocument();return assertRendererVisible(record.visibility.renderer);},10000);
  evidence.checks.push({name:'owned-native-window-and-renderer-actually-visible',...record.visibility});
}else{record.hidden=appKit('hide');assert.equal(record.hidden.hidden,true,'Owned test app verified hidden');}
return ui;}
async function quit(name){assert.ok(child&&!exited());await nativeChildren();const request=appKit('terminate');await until(async()=>assert.ok(exited(),'Normal application quit'),20000);assert.equal(child.exitCode,0);assert.equal(child.signalCode,null,'A cleanup signal cannot satisfy normal quit');evidence.checks.push({name,request,exitCode:child.exitCode,signal:child.signalCode});await stop();}
async function read(file){return readFixture(vault,file);}
async function saved(file,check,name){const source=await until(async()=>{const source=await read(file);await check(source);return source;},45000);const normal=await cdp.evaluate(`(async()=>{const v=await window.zorid.getVault();return window.zorid.read(v.path,${JSON.stringify(file)});})()`);assert.equal(normal,source,'Normal bridge read equals actual saved bytes');evidence.checks.push({name,file,sha256:createHash('sha256').update(source).digest('hex'),source});return source;}
function frontmatter(source){const match=source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);assert.ok(match,'Frontmatter present');return yaml.parse(match[1]);}
async function screenshot(name){const {data}=await cdp.call('Page.captureScreenshot',{format:'png'});const file=name+'.png';await fs.writeFile(path.join(out,file),Buffer.from(data,'base64'));evidence.screenshots.push({file,...await ui.dom('return {viewport:{width:innerWidth,height:innerHeight,scale:devicePixelRatio},theme:document.documentElement.dataset.theme,active:document.activeElement?.outerHTML?.slice(0,1500)};')});}
async function external(file,source,label){validateFixtureName(file);assert.ok(file!=='Properties.yaml','Property registry has a separate guarded fixture path');await writeFixture(vault,file,source);evidence.actions.push({action:'external-editor-fixture',file,label,source,at:Date.now()});}
async function prepareDownloads(){
  const directory=path.join(out,'downloads');await fs.mkdir(directory);
  const version=await fetch(`http://127.0.0.1:${record.cdpPort}/json/version`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  browserCDP=new CDP(version.webSocketDebuggerUrl);
  await browserCDP.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory,eventsEnabled:true});
  browserCDP.ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.method?.startsWith('Browser.download'))(evidence.downloadEvents??=[]).push(value);});
  evidence.limitations.push('CSV export uses the actual UI download with Chromium test download-directory isolation; the native Save dialog is not exercised.');
  evidence.actions.push({action:'chromium-download-directory-isolation',directory,at:Date.now()});return directory;
}
try{
  if(campaign?.createNativeRelay){
    const directory=path.join(out,'native-relay');relay=await campaign.createNativeRelay({native,directory});
    for(const name of ['arm','release','events','dispose'])assert.equal(typeof relay?.[name],'function','Required relay control '+name);
    const directoryStat=await fs.lstat(directory);assert.ok(directoryStat.isDirectory()&&!directoryStat.isSymbolicLink());assert.equal(await fs.realpath(directory),directory,'Owned relay control directory');
    assert.equal(relay.directory,directory);relayExecutable=await fs.realpath(relay.executable);assert.equal(relayExecutable,path.join(directory,'native-relay'),'Owned generated relay executable');
    const stat=await fs.lstat(relay.executable);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o111),'Regular executable relay wrapper');
    relayIdentity=structuredClone(relay.processIdentity);assert.ok(path.isAbsolute(relayIdentity?.executable)&&Array.isArray(relayIdentity.args),'Immutable relay process identity');
    relayFiles=[...new Set(relay.provenanceFiles)];assert.ok(relayFiles.includes(relayExecutable),'Relay wrapper is in immutable provenance');
    for(const file of relayFiles){assert.equal(await fs.realpath(file),file,'Relay provenance file cannot alias');assert.ok(file===relayExecutable||file.startsWith(path.dirname(campaignPath)+path.sep),'Relay provenance belongs to owned source or generated wrapper');assert.ok((await fs.lstat(file)).isFile(),'Relay provenance is a regular file');}
  }
  before=await provenance();await fs.writeFile(path.join(out,'provenance-before.json'),JSON.stringify(before,null,2));
  await fs.mkdir(vault,{recursive:true});await fs.mkdir(profile);await fs.mkdir(path.join(sandbox,'app-data'));if(!campaign&&!windowBootstrapProbe)await fs.mkdir(path.join(vault,'Created'));
  const fixtures=windowBootstrapProbe?new Map([['Window probe.md','Owned window bootstrap fixture.\n']]):(campaign?.fixtureFiles??fixtureFiles)();
  assert.ok(fixtures instanceof Map,'Owned fixture map');
  for(const[file,source]of fixtures){validateFixtureName(file);assert.ok(typeof source==='string'||Buffer.isBuffer(source),'Fixture file is text or bytes');}
  if(!campaign&&!windowBootstrapProbe)fixtures.set('Properties.yaml',yaml.stringify({properties:{rating:{type:'number'},done:{type:'checkbox'},finished:{type:'date'},appointment:{type:'datetime'},priority:{type:'select',options:[{value:'Low'},{value:'Medium'},{value:'High'}]},keywords:{type:'list'},topics:{type:'multiselect',options:[{value:'Rust',color:'orange'},{value:'Design',color:'blue'},{value:'Writing',color:'green'}]},status:{type:'status',options:[{value:'To read',category:'todo'},{value:'Reading',category:'in-progress'},{value:'Finished',category:'done'}]},author:{type:'relation',relation:{multiple:false,targetFilter:'type == "author"'}},books:{type:'reverseRelation',reverseRelation:{property:'author'}},bookCount:{type:'rollup',rollup:{relation:'books',aggregation:'count'}},averageRating:{type:'rollup',rollup:{relation:'books',property:'rating',aggregation:'average'}}}}));
  for(const[file,source]of fixtures)await writeFixture(vault,file,source,{createParents:true});
  await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}));
  evidence.fixtureManifest=await tree(vault);
  if(windowBootstrapProbe){await launch('owned-visible-window-bootstrap');await screenshot('owned-visible-window-bootstrap');await quit('owned-window-bootstrap-normal-quit');}
  else await (campaign?.journey??journey)({get ui(){return ui;},get cdp(){return cdp;},vault,yaml,template:campaign?(campaign.template??''):template,evidence,outputDirectory:out,...(relay?{relay:Object.freeze({arm:input=>relay.arm(input),release:token=>relay.release(token),events:()=>relay.events()}),forceShutdown}:{}),launch,quit,read,saved,frontmatter,screenshot,external,diskGuard,prepareDownloads});
  const after=await provenance();await fs.writeFile(path.join(out,'provenance-after.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before,'Exact source/artifact freeze survived journey');evidence.provenanceVerified=true;evidence.status='passed';
}catch(error){failure=error;evidence.status='failed';evidence.failure={message:error.message,stack:error.stack};if(cdp)try{evidence.failureDOM=await ui.dom('return {body:document.body.innerText,editors:[...document.querySelectorAll("[data-base-editing]")].map(e=>e.outerHTML),alerts:[...document.querySelectorAll("[role=alert]")].map(e=>e.outerHTML)};');await screenshot('failure');}catch(diagnostic){evidence.diagnosticFailure=diagnostic.message;}}
finally{try{await stop();}catch(error){failure??=error;evidence.status='failed';evidence.cleanupFailure=error.message;}if(before&&!evidence.provenanceVerified)try{const after=await provenance();await fs.writeFile(path.join(out,'provenance-after.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before,'Source/artifact freeze after failed journey');evidence.provenanceVerified=true;}catch(error){evidence.provenanceFailure=error.message;failure??=error;evidence.status='failed';}evidence.finished=new Date().toISOString();await fs.writeFile(path.join(out,'result.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({status:evidence.status,checks:evidence.checks.length,actions:evidence.actions.length,evidence:path.join(out,'result.json')}));if(failure){console.error(failure.stack);process.exitCode=1;}
