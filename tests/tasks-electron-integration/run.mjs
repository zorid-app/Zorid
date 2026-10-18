#!/usr/bin/env node
// Explicit actual Tasks UI target. No launch until exact coordinator Tasks-ready freeze.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream,watch} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {CDP,delay,until} from './cdp.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const requireArg=name=>{const value=arg(name);assert.ok(value,`Explicit ${name} required`);return value;};
const root=path.resolve(requireArg('--root')),expectedHead=requireArg('--expected-head');
const native=path.resolve(requireArg('--native')),electron=path.resolve(requireArg('--electron'));
const out=path.resolve(requireArg('--out'));
assert.equal(arg('--ready'),'tasks-native-and-frontend-frozen','Coordinator must explicitly supply matching native/frontend readiness');
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
const evidence={kind:'actual-electron-tasks-ui-subset',status:'running',started:new Date().toISOString(),groups:[],passes:[],remaining:['dirty NoteBuffer rejection unless a held save is observable','Type-definition revision conflict unless explicitly exercised','multi-client encrypted convergence','mobile/browser runtime parity'],limitations:['DOM and keyboard route for positive mutations; normal reads assert saved-file authority','Owned native process termination is a real fault test, not a mocked service','Process shutdown mode is recorded separately from graceful UI close acceptance']};
let sandbox,child,cdp,before,failure;
const parser=createRequire(path.join(root,'package.json'))('yaml');
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
  const admitted=await cdp.evaluate(`(async()=>{const vault=await window.zorid.getVault();if(!vault)throw Error('No normal selected vault');return {vault,versions:navigator.userAgent};})()`);
  assert.equal(admitted.vault.path,path.join(sandbox,'vault'),'Owned profile must select only owned vault');
  record.admission=admitted;record.nativeChildren=observeNative();assert.equal(record.nativeChildren.length,1,'Exactly one actual owned Rust native child required');return record;
}
const taskTitle='Task acceptance 😀',uncertainTitle='Unconfirmed acceptance task';
async function dom(code){return cdp.evaluate(`(()=>{${code}})()`);}
async function waitDOM(code,label,timeout=15000){return until(async()=>{const value=await dom(code);assert.ok(value,label);return value;},timeout);}
async function button(text,scope='.tasks-view'){
  await waitDOM(`const root=document.querySelector(${JSON.stringify(scope)});const b=root&&[...root.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}&&!e.disabled&&e.getClientRects().length);if(!b)return false;b.click();return true;`,'Enabled visible button: '+text);evidence.passes.push({action:'button',text,scope,at:new Date().toISOString()});
}
async function field(label,value,scope='.tasks-view .tasks-capture',chooseText=false){
  const chosen=(await waitDOM(`const root=document.querySelector(${JSON.stringify(scope)});if(!root)return false;const l=[...root.querySelectorAll('label')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)});const e=l?.querySelector('input,select');if(!e||e.disabled||!e.getClientRects().length)return false;let value=${JSON.stringify(value)};if(${chooseText})value=[...e.options].find(o=>o.textContent===value)?.value;if(value===undefined)throw Error('Missing option');e.value=value;e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return {value:e.value};`,'Enabled visible field: '+label)).value;evidence.passes.push({action:'field',label,value:chosen,scope,at:new Date().toISOString()});return chosen;
}
async function idle(){await delay(100);await waitDOM(`return document.querySelector('.tasks-view')?.getAttribute('aria-busy')==='false';`,'Tasks idle',30000);}
async function openTasks(){
  if(!await dom("return !!document.querySelector('.tasks-view');"))await dom(`const b=document.querySelector('.ribbon [aria-label="Open Tasks"]');if(!b)throw Error('Tasks Workspace destination absent');b.click();`);
  await waitDOM("return !!document.querySelector('.tasks-view');",'Tasks destination');await idle();
}
async function read(file){
  const value=await cdp.evaluate(`(async()=>{const vault=await window.zorid.getVault();return window.zorid.read(vault.path,${JSON.stringify(file)});})()`);
  assert.equal(typeof value,'string');assert.equal(await fs.readFile(path.join(sandbox,'vault',file),'utf8'),value,'normal read agrees with actual Markdown file');return value;
}
function frontmatter(source){assert.ok(source.startsWith('---\n'));const end=source.indexOf('\n---',4);assert.ok(end>0);return parser.parse(source.slice(4,end));}
async function staleDraftEvidence(key,deadline,expectedSource){
  // A normal refresh may clear a transient alert; the retained draft must still
  // explain its original stale revisions, and the actual file must not change.
  const source=await read(savedPath);
  const feedback=await dom(`const root=document.querySelector('.tasks-view'),form=root?.querySelector('.tasks-edit');const field=form&&[...form.querySelectorAll('label')].find(e=>e.querySelector('span')?.textContent==='Deadline')?.querySelector('input');const guidance=[...root.querySelectorAll('p')].map(e=>e.textContent).find(text=>text.includes('Saved data changed')&&text.includes('original revisions'));return{draft:!!form,deadline:field?.value,guidance,alert:root.querySelector('[role=alert]')?.textContent??null};`);
  evidence[key]={attemptedDeadline:deadline,source,feedback};
  assert.equal(source,expectedSource,'Stale draft cannot overwrite authoritative file');
  assert.ok(feedback.draft&&feedback.deadline===deadline&&feedback.guidance,'Stale save retains exact draft and explicit original-revision guidance');
}
async function taskRow(){return waitDOM(`const row=[...document.querySelectorAll('.tasks-item')].find(e=>e.querySelector('.tasks-item-heading button')?.textContent===${JSON.stringify(taskTitle)});return row?{id:row.dataset.taskId,path:row.querySelector('small').textContent,text:row.textContent}:null;`,'saved task from actual Pin.tasks',30000);}
async function screenshot(name){await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');await delay(150);(evidence.screenshotStates??=[]).push({name,...await dom("const e=document.querySelector('.tasks-view');return{theme:document.documentElement.dataset.theme,background:e?getComputedStyle(e).backgroundColor:null,width:e?.clientWidth,scrollWidth:e?.scrollWidth};")});const {data}=await cdp.call('Page.captureScreenshot',{format:'png'});const file=path.join(out,name+'.png');await fs.writeFile(file,Buffer.from(data,'base64'));(evidence.screenshots??=[]).push(file);}
async function narrowSidebar(){
  // At the narrow breakpoint use the visible native Workspace sidebar toggle,
  // with a real pointer event and hit test; never click a hidden chrome control.
  if(!await dom("return document.querySelector('.workspace').classList.contains('left-hidden');")){
    const point=await waitDOM(`for(const e of document.querySelectorAll('[aria-label="Toggle left sidebar"]')){const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(r.width&&r.height&&e.contains(document.elementFromPoint(x,y)))return{x,y};}return false;`,'Visible narrow left sidebar toggle');
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  }
  await waitDOM("return document.querySelector('.workspace').classList.contains('left-hidden');",'Narrow sidebar actually collapsed');
  evidence.narrowWitness=await dom(`const root=document.querySelector('.tasks-view');const targets=[root.querySelector('h2'),[...root.querySelectorAll('button')].find(e=>e.textContent==='Refresh'),root.querySelector('.tasks-capture input'),root.querySelector('.tasks-capture button[type=submit]'),root.querySelector('.tasks-item-heading button')];return{viewport:{width:innerWidth,height:innerHeight},sidebarHidden:document.querySelector('.workspace').classList.contains('left-hidden'),targets:targets.map(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e),x=r.x+r.width/2,y=r.y+r.height/2;return{text:e.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:style.display,visibility:style.visibility,inside:r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight,hit:e.contains(document.elementFromPoint(x,y))};})};`);
  assert.ok(evidence.narrowWitness.targets.every(e=>e.inside&&e.hit),'Narrow Tasks main controls must be inside viewport and unobscured');
}
async function theme(value){
  await dom(`document.querySelector('[data-hotkey-command="settings"]').click();`);await button('Appearance','.settings-modal');
  await dom(`const e=document.querySelector('[aria-label="Base color scheme"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitDOM(`return !document.querySelector('.modal-overlay')&&document.documentElement.dataset.theme===${JSON.stringify(value)};`,'actual theme UI');
}
async function closeGuard(label,expected){
  await dom(`const b=document.querySelector('.pane.is-active .tab.is-active .tab-close');if(!b)throw Error('Active tab close absent');b.click();`);await delay(250);
  assert.ok(await dom("return !!document.querySelector('.tasks-view');"),'Pending Tasks close must retain view');
  if(label)assert.equal(await dom(`return [...document.querySelectorAll('.tasks-view label')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input')?.value;`),expected,'Pending form value retained after actual tab close');
}
async function keyboardBody(marker,save=true){
  await waitDOM("return !!document.querySelector('.cm-content');",'shared body editor');
  const rect=await dom("const e=[...document.querySelectorAll('.cm-content .cm-line')].at(-1);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+8),y:Math.round(r.y+r.height/2)};");
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});await cdp.call('Input.insertText',{text:'\n'+marker+'\n'});
  if(save){await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:4});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:4});}
}
async function clickPoint(selector){
  const point=await dom(`const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing UI click target');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};`);
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
}
async function splitBody(){
  await dom(`document.querySelector('[data-hotkey-command="command-palette"]').click();`);
  await waitDOM(`return !!document.querySelector('.command-input');`,'normal command palette');
  await dom(`const e=document.querySelector('.command-input');e.value='Split right';e.dispatchEvent(new Event('input',{bubbles:true}));const option=[...document.querySelectorAll('.suggestion')].find(e=>e.querySelector('span')?.textContent==='Split right');if(!option)throw Error('Split right command absent');option.click();`);
  await waitDOM(`return document.querySelectorAll('.pane').length===2&&!!document.querySelector('.pane.is-active .cm-content');`,'normal split duplicates shared body');
}
function currentOwnedNative(){const owned=observeNative();assert.equal(owned.length,1);const current=processTable().find(p=>p.pid===owned[0].pid&&p.command===owned[0].command);assert.ok(current,'Exact owned native child still current');return current;}

let savedPath,expectedBody,installedType,installedBase;
try{
  for(const file of [native,electron,path.join(root,'dist/index.html')])assert.ok((await fs.stat(file)).isFile());
  before=await provenance();await fs.writeFile(path.join(out,'provenance-before.json'),JSON.stringify(before,null,2));
  sandbox=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-tasks-electron-')));const vault=path.join(sandbox,'vault'),profile=path.join(sandbox,'profile');
  await fs.mkdir(vault);await fs.mkdir(profile);await fs.mkdir(path.join(vault,'Bases'));const sentinel='# Non-clobber fixture: preserve exact bytes\n';await fs.writeFile(path.join(vault,'Bases/Tasks.base'),sentinel);
  await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}));
  const author=await launch('author-tasks');await openTasks();
  await dom("document.querySelector('.tasks-view details').open=true;");await button('Install preset');await idle();
  assert.equal(await read('Bases/Tasks.base'),sentinel,'preset never clobbers existing Base');assert.ok(await dom("return !!document.querySelector('.tasks-view [role=alert]');"),'non-clobber conflict visibly reported');
  await field('Type file (inside Types/)','Types/Acceptance.yaml','.tasks-view details');await field('Base file','Bases/Acceptance.base','.tasks-view details');await button('Install preset');await idle();
  await waitDOM("return !!document.querySelector('.tasks-capture');",'installed actual Type discovered through Pin.tasks');
  installedType=await read('Types/Acceptance.yaml');installedBase=await read('Bases/Acceptance.base');const type=parser.parse(installedType);assert.ok(type.id&&type.capabilities.task);evidence.installed={typeSource:installedType,baseSource:installedBase};
  await field('Title',taskTitle);await field('Folder','Tasks');await field('Type',type.id);await button('Create task');await idle();let row=await taskRow();savedPath=row.path;evidence.savedPath=savedPath;
  let text=await read(savedPath),properties=frontmatter(text);assert.equal(properties.type,type.id);const status=type.properties.find(p=>p.datatype==='status');assert.equal(properties.status,status.default);evidence.captured={row,source:text,properties};
  await button('Edit status and dates');const working=await field('Status','In progress','.tasks-edit',true);await field('Planned day','2099-08-09','.tasks-edit');await field('Deadline','2099-08-10','.tasks-edit');await button('Save changes');await idle();await taskRow();
  text=await read(savedPath);properties=frontmatter(text);assert.equal(properties.status,working);assert.equal(properties.planned,'2099-08-09');assert.equal(properties.deadline,'2099-08-10');evidence.edited={source:text,properties};
  await theme('light');await screenshot('tasks-light');await theme('dark');await screenshot('tasks-dark');await cdp.call('Emulation.setDeviceMetricsOverride',{width:460,height:760,deviceScaleFactor:1,mobile:false});await narrowSidebar();await screenshot('tasks-narrow');evidence.narrowGeometry=await dom("const e=document.querySelector('.tasks-view');return{width:e.clientWidth,scrollWidth:e.scrollWidth};");assert.ok(evidence.narrowGeometry.scrollWidth<=evidence.narrowGeometry.width+1,'Tasks narrow content must wrap');await cdp.call('Emulation.clearDeviceMetricsOverride');
  await button(taskTitle);await keyboardBody('Tasks ordinary body acceptance marker');await until(async()=>{assert.ok((await read(savedPath)).includes('Tasks ordinary body acceptance marker'));},15000);expectedBody=await read(savedPath);evidence.bodySaved=expectedBody;assert.deepEqual(frontmatter(expectedBody),properties);
  // Normal split leaves the same shared note buffer visible beside Tasks. Hold
  // only our verified native child so autosave cannot erase the dirty interval.
  await splitBody();assert.equal(await dom("return [...document.querySelectorAll('.note-recovery')].some(e=>!e.hidden&&e.getClientRects().length);"),false,'Ordinary saved body has no visible recovery conflict');await openTasks();await taskRow();await button('Edit status and dates');await field('Deadline','2099-08-13','.tasks-edit');
  const paused=currentOwnedNative();let dirtyError;
  try{
    process.kill(paused.pid,'SIGSTOP');
    await keyboardBody('Tasks dirty shared buffer acceptance marker',false);
    await button('Save changes');
    dirtyError=await waitDOM(`const e=document.querySelector('.tasks-view [role=alert]');return e?.textContent?.includes('unsaved or failed')?e.textContent:null;`,'synchronous dirty buffer admission rejection',5000);
    assert.ok(await dom(`return !!document.querySelector('.tasks-edit');`),'dirty rejection retains Tasks metadata draft');
  }finally{
    const alive=processTable().find(p=>p.pid===paused.pid&&p.command===paused.command);if(alive)process.kill(paused.pid,'SIGCONT');
    evidence.dirtyBufferResume={pid:paused.pid,resumed:Boolean(alive),at:new Date().toISOString()};
  }
  await until(async()=>{assert.ok((await read(savedPath)).includes('Tasks dirty shared buffer acceptance marker'));},20000);
  expectedBody=await read(savedPath);assert.deepEqual(frontmatter(expectedBody),properties,'dirty Tasks edit cannot overwrite metadata');evidence.dirtyBufferRejected={error:dirtyError,source:expectedBody};evidence.bodySaved=expectedBody;
  evidence.remaining=evidence.remaining.filter(g=>!g.startsWith('dirty NoteBuffer'));
  await idle();await button('Discard draft');
  // Close only the temporary right split via ordinary tab controls, leaving the
  // original note and parked original Tasks tab in the left pane.
  await clickPoint('.tasks-view h2');
  await dom(`document.querySelector('.pane.is-active .tab.is-active .tab-close').click();`);
  await waitDOM(`return !!document.querySelector('.pane.is-active .cm-content');`,'temporary split body restored');
  await dom(`document.querySelector('.pane.is-active .tab.is-active .tab-close').click();`);
  await waitDOM(`return document.querySelectorAll('.pane').length===1;`,'temporary split closed');
  await openTasks();await taskRow();
  await field('Title','Retained capture draft');await closeGuard('Title','Retained capture draft');await field('Title','');
  await button('Edit status and dates');await field('Deadline','2099-08-11','.tasks-edit');await closeGuard('Deadline','2099-08-11');
  // Negative fixture mutation only: positive saves always use actual Tasks/body UI.
  const external=expectedBody+'\nExternal stale-witness fixture marker\n';await fs.writeFile(path.join(vault,savedPath),external);
  await until(async()=>{assert.equal(await read(savedPath),external);},45000);await button('Refresh');await idle();await waitDOM("return document.querySelector('.tasks-view').textContent.includes('Saved data changed');",'stale draft visibly retained',45000);
  await button('Save changes');await idle();await staleDraftEvidence('staleDraftRejected','2099-08-11',external);await button('Discard draft');expectedBody=external;
  await button('Edit status and dates');await field('Deadline','2099-08-12','.tasks-edit');
  const changedType=installedType+'\n# External Type witness negative fixture\n';await fs.writeFile(path.join(vault,'Types/Acceptance.yaml'),changedType);
  await until(async()=>{assert.equal(await read('Types/Acceptance.yaml'),changedType);},45000);await button('Refresh');await idle();await waitDOM("return document.querySelector('.tasks-view').textContent.includes('Saved data changed');",'original Type witness retained',45000);
  await button('Save changes');await idle();await staleDraftEvidence('staleTypeRejected','2099-08-12',expectedBody);evidence.staleTypeRejected.typeSource=changedType;await button('Discard draft');installedType=changedType;
  evidence.remaining=evidence.remaining.filter(g=>!g.startsWith('Type-definition revision'));
  evidence.groups.push('actual-ui-nonclobber-preset-capture-defaults-status-dates-body-and-retained-stale-drafts');author.events=cdp.events;assert.equal(author.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0,'No unexpected renderer exception in positive/stale UI flow');await stop();
  const reopen=await launch('reopen-and-uncertain-capture');await openTasks();await taskRow();assert.equal(await read(savedPath),expectedBody,'ordinary task body/properties survive actual app restart');assert.equal(await read('Types/Acceptance.yaml'),installedType);assert.equal(await read('Bases/Acceptance.base'),installedBase);evidence.groups.push('actual-ui-reopen-preserves-authoritative-markdown-and-preset');
  await field('Title',uncertainTitle);const current=currentOwnedNative();
  // Observe only the exact unique final capture projection. The event is not a
  // receipt; actual unconfirmed UI remains mandatory after the real fault.
  let watcher,timer,signalled=false;
  try{
    const projected=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('Exact capture projection not observed before fault deadline')),15000);
      watcher=watch(path.join(vault,'Tasks'),(event,name)=>{
        if(signalled||String(name)!==uncertainTitle+'.md')return;signalled=true;
        watcher.close();clearTimeout(timer);
        try{assert.ok(processTable().some(p=>p.pid===current.pid&&p.parent===current.parent&&p.command===current.command),'Exact owned child identity must remain current at projection event');process.kill(current.pid,'SIGKILL');evidence.nativeFault={...current,signal:'SIGKILL',event,name:String(name),at:new Date().toISOString(),boundary:'observed final capture file projection; not a validated receipt or postcommit lost-ack proof'};resolve();}catch(error){reject(error);}
      });watcher.on('error',reject);
    });
    // Observe rejection immediately as well as awaiting it after UI dispatch.
    projected.catch(()=>{});await button('Create task');await projected;
  }finally{watcher?.close();clearTimeout(timer);}
  await waitDOM("return !!document.querySelector('[aria-label=\"Unconfirmed capture\"]');",'unknown real native outcome retained',20000);
  await closeGuard('Title',uncertainTitle);await screenshot('tasks-unconfirmed');
  const count=async()=>{const names=await fs.readdir(path.join(vault,'Tasks'));return names.filter(name=>name.includes('Unconfirmed acceptance task'));};const beforeCount=await count();await button('Refresh');await idle();await delay(1000);assert.deepEqual(await count(),beforeCount,'Refresh cannot automatically duplicate unconfirmed capture');assert.ok(await dom("return document.querySelector('.tasks-capture button[type=submit]')?.disabled;"));evidence.uncertainFiles=beforeCount;reopen.events=cdp.events;await stop();
  const final=await launch('reopen-no-automatic-duplicate');await openTasks();const afterRestart=await count();assert.ok(afterRestart.length<=1,'No duplicate uncertain capture files after restart');if(beforeCount.length)assert.deepEqual(afterRestart,beforeCount,'Existing uncertain capture identity must survive without duplicate');evidence.uncertainFilesAfterRestart=afterRestart;assert.equal(await dom("return [...document.querySelectorAll('.tasks-capture label')].find(e=>e.querySelector('span')?.textContent==='Title')?.querySelector('input')?.value;"),'','Restart must not resubmit retained transient capture');assert.equal(await read(savedPath),expectedBody);evidence.groups.push('actual-owned-native-interruption-retained-capture-no-automatic-duplicate');final.events=cdp.events;assert.equal(final.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0,'No unexpected renderer exception in healthy restart');await stop();
  const after=await provenance();await fs.writeFile(path.join(out,'provenance-after.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before);evidence.provenanceVerified=true;evidence.status='passed-subset';
}catch(error){failure=error;evidence.status='failed';evidence.error={message:error.message,stack:error.stack};if(cdp)try{evidence.failureEvents=cdp.events;evidence.failureDOM=await dom("return{recovery:[...document.querySelectorAll('.note-recovery')].map(e=>({hidden:e.hidden,visible:!!e.getClientRects().length,text:e.textContent})),tasks:[...document.querySelectorAll('.tasks-view')].map(e=>({busy:e.getAttribute('aria-busy'),fields:[...e.querySelectorAll('input,select')].map(e=>({label:e.dataset.focus,value:e.value,disabled:e.disabled})),html:e.outerHTML,visible:!!e.getClientRects().length})),panes:[...document.querySelectorAll('.pane')].map(e=>({className:e.className,text:e.textContent}))};");await screenshot('tasks-failure');}catch(diagnosticError){evidence.failureDiagnosticError=diagnosticError.message;}}
finally{
  await stop().catch(error=>{evidence.cleanupError=error.message;failure??=error;});
  if(sandbox)await fs.rm(sandbox,{recursive:true,force:true}).catch(error=>{evidence.cleanupError=error.message;failure??=error;});
  if(before&&!evidence.provenanceVerified)try{const after=await provenance();await fs.writeFile(path.join(out,'provenance-after.json'),JSON.stringify(after,null,2));evidence.provenanceVerified=JSON.stringify(after)===JSON.stringify(before);}catch(error){evidence.provenanceError=error.message;}
  if(failure)evidence.status='failed';
  evidence.finished=new Date().toISOString();evidence.runtime=runtime;await fs.writeFile(path.join(out,'result.json'),JSON.stringify(evidence,null,2));
}
if(failure){console.error(failure.stack);process.exitCode=1;}else console.log('PASS actual Tasks UI subset: '+out);
