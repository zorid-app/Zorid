#!/usr/bin/env node
// Actual normal Electron save/restart subset. Explicit coordinator freeze required.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CDP,delay,until} from '../tasks-electron-integration/cdp.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const required=name=>{const value=arg(name);assert.ok(value,`Explicit ${name} required`);return value;};
async function canonicalDestination(input){let at=path.resolve(input);const missing=[];for(;;){try{return path.join(await fs.realpath(at),...missing);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(at);assert.notEqual(parent,at);missing.unshift(path.basename(at));at=parent;}}}
const root=await fs.realpath(required('--root')),expectedHead=required('--expected-head');
const native=await fs.realpath(required('--native')),electron=await fs.realpath(required('--electron')),out=await canonicalDestination(required('--out'));
let manual=null;try{manual=JSON.parse(await fs.readFile('/private/tmp/zorid-current-manual-playground.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(manual)assert.ok(typeof manual.root==='string'&&path.isAbsolute(manual.root)&&Number.isSafeInteger(manual.pid)&&manual.pid>0);
const manualRoot=manual?await canonicalDestination(manual.root):null;
assert.equal(arg('--ready'),'storage-native-and-frontend-frozen','Matching frozen native/frontend readiness required');
assert.match(expectedHead,/^[0-9a-f]{40}$/);
const scenario=arg('--scenario')??'full',quitMethod=arg('--quit-method')??'appkit';assert.ok(['full','live-quit-history'].includes(scenario));assert.ok(['appkit','main-api'].includes(quitMethod));
const harness=path.dirname(fileURLToPath(import.meta.url));
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
async function sha(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function tree(directory){const rows=[];async function walk(relative=''){for(const item of (await fs.readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(relative,item.name);assert.ok(!item.isSymbolicLink(),'No artifact symlinks: '+name);if(item.isDirectory())await walk(name);else if(item.isFile())rows.push([name,await sha(path.join(directory,name))]);}}await walk();return rows;}
async function provenance(){
  assert.equal(git('rev-parse','HEAD').trim(),expectedHead,'Frozen integration HEAD changed');
  assert.equal(git('diff','--name-only','HEAD').trim(),'','Tracked integration source changed');
  const names=git('ls-files','-z','desktop','src','crates','scripts','Cargo.toml','Cargo.lock','package.json','pnpm-lock.yaml','vite.config.mjs','index.html').split('\0').filter(Boolean).sort();
  const tracked=[];for(const name of names)tracked.push([name,await sha(path.join(root,name))]);
  return{head:expectedHead,tracked,dist:await tree(path.join(root,'dist')),native:{file:native,sha256:await sha(native)},electron:{file:electron,sha256:await sha(electron)},harness:await tree(harness),cdpHelper:await sha(path.join(harness,'../tasks-electron-integration/cdp.mjs'))};
}
for(const protectedRoot of [root,await fs.realpath(harness),manualRoot].filter(Boolean))assert.ok(out!==protectedRoot&&!out.startsWith(protectedRoot+path.sep),'Evidence must exclude source/harness/manual roots and aliases');
await fs.mkdir(out,{recursive:true});
const evidence={kind:'actual-electron-storage-save-restart-subset',status:'running',scenario,quitMethod,started:new Date().toISOString(),checks:[],runtime:[],limitations:['No crash/power-loss, late external-handle or multi-client concurrency proof','Five-minute interval/expiry/dedupe correctness remains covered by focused recovery checks, not a shortened runtime clock','Recovery UI acceptance covers one selected existing-note version; missing/invalid/stale/dirty and failure variants retain separate focused checks','No mobile/browser/sync or complete S0 acceptance follows from this subset','The exact owned Electron app is hidden before edits; CDP input/rendered screenshots do not establish foreground OS keyboard or focus parity','Window close is the exact owned main-process BrowserWindow.close() API through a loopback Node inspector with passive event observers; it is not an OS traffic-light/AX click or renderer window.close()']};
let sandbox,child,cdp,mainCDP,before,failure;
const ownedNative=new Map();
const exited=()=>!child||child.exitCode!==null||child.signalCode!==null;
const processTable=()=>execFileSync('ps',['-ww','-axo','pid=,ppid=,command='],{encoding:'utf8',maxBuffer:4*1024*1024}).split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:Number(m[1]),parent:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
function observeNative(){const rows=processTable().filter(row=>row.parent===child?.pid&&row.command.startsWith(native+' --vault '+path.join(sandbox,'vault')));for(const row of rows)ownedNative.set(row.pid,row);return rows;}
async function stop(){
  if(!child)return;observeNative();cdp?.close();cdp=undefined;mainCDP?.close();mainCDP=undefined;
  assert.notEqual(child.pid,manual?.pid);const result={pid:child.pid,method:exited()?'already-exited':'SIGTERM-owned-process'};
  if(!exited()){child.kill('SIGTERM');try{await until(async()=>assert.ok(exited()),5000);}catch{result.method='SIGKILL-after-deadline';child.kill('SIGKILL');await until(async()=>assert.ok(exited()),5000);}}
  const alive=()=>{const rows=processTable();return [...ownedNative.values()].filter(owned=>rows.some(row=>row.pid===owned.pid&&row.command===owned.command));};
  try{await until(async()=>assert.equal(alive().length,0),5000);}catch{for(const row of alive())process.kill(row.pid,'SIGKILL');result.leakedNative=true;}
  result.exitCode=child.exitCode;result.signal=child.signalCode;result.nativeChildren=[...ownedNative.values()];
  evidence.runtime.push({shutdown:result});child=undefined;ownedNative.clear();assert.ok(!result.leakedNative,'Owned native process leaked and was force-cleaned');
}
async function launch(pass){
  assert.ok(!child,'Previous app must be closed');const profile=path.join(sandbox,'profile');await fs.rm(path.join(profile,'DevToolsActivePort'),{force:true});
  const env={...process.env,ZORID_DESKTOP_HOST_BIN:native,ZORID_LOCAL_DATA_DIR:path.join(sandbox,'app-data')};
  for(const key of ['ELECTRON_RUN_AS_NODE','ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_EDITOR_RUST','ZORID_FIXTURE_VAULT','ZORID_FIXTURE_SYNC_CONFIG','ZORID_FIXTURE_CLIENT_ID'])delete env[key];
  const record={pass,stdout:'',stderr:''};evidence.runtime.push(record);
  child=spawn(electron,['--inspect=127.0.0.1:0',path.join(root,'desktop/main.cjs'),'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let spawnError;child.on('error',error=>{spawnError=error;});for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{if(record[name].length<128000)record[name]+=bytes.toString();});
  const port=await until(async()=>{if(spawnError)throw spawnError;assert.ok(!exited(),'Electron exited: '+record.stderr);let value;try{value=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{value=record.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];}assert.match(value,/^[1-9][0-9]{0,4}$/);return value;},30000);
  const target=await until(async()=>{const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());const row=rows.find(r=>r.type==='page'&&r.url.startsWith('file:')&&r.url.includes('/dist/index.html'));assert.ok(row,'Normal renderer page missing');return row;},30000);
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Log.enable');await cdp.call('Page.enable');
  await until(async()=>assert.equal(await cdp.evaluate('Boolean(window.zorid&&document.querySelector(".workspace"))'),true),30000);
  record.vault=await cdp.evaluate('window.zorid.getVault()');assert.equal(record.vault.path,path.join(sandbox,'vault'));
  record.pid=child.pid;record.nativeChildren=observeNative();assert.equal(record.nativeChildren.length,1,'Exactly one matching actual native child');
  record.hiddenBeforeEdits=ownedAppKit('hide');assert.equal(record.hiddenBeforeEdits.hidden,true,'Owned test application must be verified hidden before any edits');
  const inspectorURL=await until(async()=>{const url=record.stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];assert.ok(url,'Owned main inspector endpoint missing');return url;},5000);
  mainCDP=new CDP(inspectorURL);await mainCDP.call('Runtime.enable');
  record.mainObservation=await mainCDP.evaluate(`(()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const windows=BrowserWindow.getAllWindows();if(process.pid!==${child.pid}||windows.length!==1||windows[0].webContents.getURL()!==${JSON.stringify(pathToFileURL(path.join(root,'dist/index.html')).href)})throw Error('Owned main window guard failed');const win=windows[0];globalThis.__zoridCloseEvidence=[];for(const name of ['before-quit','will-quit','quit'])app.on(name,(event,exitCode)=>process.stdout.write('ZORID_LIFECYCLE_WITNESS '+JSON.stringify({event:name,at:Date.now(),defaultPrevented:event?.defaultPrevented,exitCode})+'\\n'));win.on('close',event=>globalThis.__zoridCloseEvidence.push({event:'close',at:Date.now(),defaultPrevented:event.defaultPrevented}));win.on('closed',()=>globalThis.__zoridCloseEvidence.push({event:'closed',at:Date.now()}));return{pid:process.pid,windowId:win.id,url:win.webContents.getURL()};})()`);
  await dom(`globalThis.__zoridUnloadEvidence=[];window.addEventListener('beforeunload',event=>globalThis.__zoridUnloadEvidence.push({event:'beforeunload',at:Date.now(),defaultPrevented:event.defaultPrevented}));const root=document.querySelector('#app');if(root)new MutationObserver(()=>{if(root.inert)globalThis.__zoridUnloadEvidence.push({event:'workspace-inert',at:Date.now()});}).observe(root,{attributes:true,attributeFilter:['inert']});return true;`);
}
async function dom(body){return cdp.evaluate(`(()=>{${body}})()`);}
async function quiet(label){
  const state=await until(async()=>{const value=await dom(`const s=document.querySelector('.import-status');const visible=s&&!s.hidden&&s.getClientRects().length;return{visible:!!visible,text:visible?s.textContent:'',errors:[...document.querySelectorAll('.error-message,.startup-error,[role="alert"]')].filter(e=>!e.hidden&&e.getClientRects().length).map(e=>e.textContent)};`);assert.equal(value.visible,false,'Normal operation should not show import status');assert.deepEqual(value.errors,[],'No visible error');return value;},15000);
  assert.doesNotMatch(state.text,/reconciliation|sqlite|scan|import|namespace|previous|vault.*attention/i);evidence.checks.push({label,ui:state});
}
async function screenshot(name){// Hidden apps may pause requestAnimationFrame; CDP captures the rendered surface directly.
  const {data}=await cdp.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,name+'.png'),Buffer.from(data,'base64'));}
async function noArtifacts(label){const names=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else names.push(path.relative(path.join(sandbox,'vault'),f));}}await walk(path.join(sandbox,'vault'));assert.deepEqual(names.filter(n=>/\.(previous|stage|namespace)$/.test(n)),[],'Successful saves must not accumulate publication artifacts');evidence.checks.push({label,vaultFiles:names});}
async function editor(expected){return until(async()=>{const state=await dom(`const e=document.querySelector('.pane.is-active .cm-content[contenteditable="true"]');if(!e)return null;e.focus();return{text:[...e.querySelectorAll(".cm-line")].map(line=>line.textContent).join("\\n"),focused:e.contains(document.activeElement)||e===document.activeElement};`);assert.ok(state?.focused,'Editable CodeMirror focused');if(expected!==undefined)assert.equal(state.text,expected);return state;},15000);}
async function replaceText(text){await editor();await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4});const editedAt=Date.now();await cdp.call('Input.insertText',{text});return editedAt;}
async function saved(file,text,label){await until(async()=>{assert.equal(await fs.readFile(path.join(sandbox,'vault',file),'utf8'),text);assert.equal(await dom(`return document.querySelector('.save-state')?.textContent??'';`),'');},20000);const read=await cdp.evaluate(`(async()=>{const v=await window.zorid.getVault();return window.zorid.read(v.path,${JSON.stringify(file)});})()`);assert.equal(read,text);evidence.checks.push({label,file,content:text});await quiet(label);await noArtifacts(label);}
async function snapshots(){
  const buckets=await fs.readdir(path.join(sandbox,'app-data','vaults'));assert.equal(buckets.length,1,'One per-vault app-local recovery bucket');const db=path.join(sandbox,'app-data','vaults',buckets[0],'recovery.sqlite');
  assert.ok(!db.startsWith(path.join(sandbox,'vault')+path.sep));
  const python='import sqlite3,json,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nprint(json.dumps([dict(zip(["id","entryId","path","time","provenance","hex"],r)) for r in c.execute("SELECT id,entry_id,historical_path,captured_at_ms,provenance,hex(content) FROM snapshots ORDER BY id")]))';
  const rows=JSON.parse(execFileSync('python3',['-c',python,db],{encoding:'utf8'}));return{db,rows};
}
async function openFile(file){
  await until(async()=>assert.equal(await dom(`const row=[...document.querySelectorAll('[role="treeitem"][data-path]')].find(e=>e.dataset.path===${JSON.stringify(file)});if(!row||!row.getClientRects().length)return false;row.click();return true;`),true),15000);
  await until(async()=>assert.equal(await dom(`return document.querySelector('.pane.is-active .note-title')?.value;`),file.replace(/\.md$/i,'')),15000);
  await editor();
}
async function restoreSeedFromHistory(file,seed){
  const current='Current saved seed version 😀\nHistory should restore the original.';
  await openFile(file);await replaceText(current);await saved(file,current,'history-current-source-saved');
  await dom(`const button=document.querySelector('.ribbon [data-hotkey-command="command-palette"]');if(!button||!button.getClientRects().length)throw Error('Ordinary command palette control unavailable');button.click();`);
  await until(async()=>assert.equal(await dom(`const input=document.querySelector('.command-modal .command-input');if(!input)return false;input.focus();return document.activeElement===input;`),true));
  await cdp.call('Input.insertText',{text:'Version history'});
  const command=await until(async()=>{const value=await dom(`const rows=[...document.querySelectorAll('.command-modal .suggestion')].filter(row=>/version history/i.test(row.querySelector('span')?.textContent??''));if(rows.length!==1)return null;const row=rows[0];const label=row.querySelector('span').textContent;row.click();return label;`);assert.ok(value,'Exactly one ordinary Version history command');return value;});
  const count=await until(async()=>{const value=await dom(`return document.querySelectorAll('.version-history .version-history-version').length;`);assert.ok(value>0,'History list populated');return value;});
  assert.ok(count<=20,'Initial history page stays bounded');let selected;
  for(let index=0;index<count;index++){
    await dom(`const button=document.querySelectorAll('.version-history-version')[${index}];if(!button||button.disabled)throw Error('Version unavailable');button.click();`);
    const preview=await until(async()=>{const value=await dom(`const dialog=document.querySelector('.version-history');if(!dialog||dialog.getAttribute('aria-busy')!=='false')return null;return{content:dialog.querySelector('.version-history-preview').value,enabled:[...dialog.querySelectorAll('button')].some(button=>button.textContent==='Restore version'&&!button.disabled)};`);assert.ok(value?.enabled,'Selected version preview ready');return value;});
    if(preview.content===seed){selected={index,preview};break;}
  }
  assert.ok(selected,'Original seed snapshot appears verbatim in Version preview');
  assert.equal(await fs.readFile(path.join(sandbox,'vault',file),'utf8'),current,'Preview does not mutate current note');
  evidence.checks.push({label:'history-list-and-exact-preview',file,command,count,selected,currentSource:current});await screenshot('history-preview-original');
  await dom(`const button=[...document.querySelectorAll('.version-history button')].find(button=>button.textContent==='Restore version'&&!button.disabled);if(!button)throw Error('Explicit restore action unavailable');button.click();`);
  await until(async()=>assert.equal(await dom(`return !!document.querySelector('.version-history');`),false),20000);
  await editor(seed);await saved(file,seed,'history-explicit-restore-saved');await screenshot('history-restored');
}
async function dirtyEdit(file,base,suffix,label){
  await editor(base);const text=base+suffix;
  const editedAt=await replaceText(text);
  const witness=await dom(`const e=document.querySelector('.pane.is-active .cm-content');return{saveState:document.querySelector('.save-state')?.textContent??'',text:[...e.querySelectorAll('.cm-line')].map(line=>line.textContent).join("\\n")};`);
  assert.equal(witness.text,text,'Keyboard edit is visible before closing');
  assert.equal(witness.saveState,'Saving…','Unsaved edit must still be dirty');
  const disk=await fs.readFile(path.join(sandbox,'vault',file),'utf8');
  assert.equal(disk,base,'Close/quit must start before debounce writes this edit');
  const result={label,file,text,editedAt,witness,diskBefore:disk};evidence.checks.push(result);return result;
}
function ownedAppKit(action){
  assert.ok(['hide','terminate'].includes(action),'Only bounded owned AppKit actions');
  assert.ok(child&&!exited(),'Owned app must still run before AppKit request');
  const pid=child.pid,profile=path.join(sandbox,'profile');assert.notEqual(pid,manual?.pid);
  const owned=processTable().find(row=>row.pid===pid);
  assert.ok(owned?.command.startsWith(electron+' ')&&owned.command.includes(path.join(root,'desktop/main.cjs'))&&owned.command.includes('--user-data-dir='+profile),'Exact owned launcher PID/command revalidated');
  const script=`ObjC.import('AppKit');function run(argv){const pid=Number(argv[0]);const app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);if(Number(app.processIdentifier)!==pid)throw Error('Owned PID unavailable');const executable=ObjC.unwrap(app.executableURL.path);if(executable!==argv[1])throw Error('Executable changed before owned request');const action=argv[2];if(action!=='hide'&&action!=='terminate')throw Error('Unsupported owned action');const alreadyHidden=Boolean(app.isHidden);const accepted=Boolean(action==='hide'?app.hide:app.terminate);if(action==='hide'){const end=Date.now()+1000;while(!Boolean(app.isHidden)&&Date.now()<end)$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));}return JSON.stringify({pid:pid,executable:executable,action:action,alreadyHidden:alreadyHidden,accepted:accepted,hidden:Boolean(app.isHidden)});}`;
  const reply=JSON.parse(execFileSync('osascript',['-l','JavaScript','-e',script,String(pid),electron,action],{encoding:'utf8',timeout:5000}));
  assert.equal(reply.pid,pid);assert.equal(reply.executable,electron);assert.equal(reply.action,action);return reply;
}
async function quitOwnedApp(label,dirty){
  assert.ok(child&&!exited(),'Owned app must still run before normal quit request');observeNative();
  const pid=child.pid;
  if(dirty)assert.ok(Date.now()-dirty.editedAt<1500,'Dirty quit preparation exceeded pre-debounce deadline');
  const requestedAt=Date.now();
  let reply;
  if(quitMethod==='appkit')reply=ownedAppKit('terminate');
  else{assert.ok(mainCDP,'Owned main inspector required for API quit');reply=await mainCDP.evaluate(`(()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const windows=BrowserWindow.getAllWindows();if(process.pid!==${pid}||windows.length>1||windows.some(win=>win.webContents.getURL()!==${JSON.stringify(pathToFileURL(path.join(root,'dist/index.html')).href)}))throw Error('Owned API quit guard failed');setTimeout(()=>app.quit(),0);return{pid:process.pid,executable:process.execPath,action:'app.quit',windows:windows.length};})()`);}
  const record={label,pid,quitMethod,requestedAt,reply,elapsedSinceEditMs:dirty?Date.now()-dirty.editedAt:null};evidence.checks.push(record);
  assert.equal(reply.pid,pid);assert.equal(reply.executable,electron);
  // AppKit may return false while Electron defers the request for async flush.
  // Only an actual no-signal normal app exit and native drain satisfy this proof.
  mainCDP?.close();mainCDP=undefined;
  if(dirty)assert.ok(record.elapsedSinceEditMs<1800,'Normal termination acceptance exceeded pre-debounce deadline');
  await until(async()=>assert.ok(exited(),'Normal app quit did not complete'),15000);
  await until(async()=>{const rows=processTable();assert.ok([...ownedNative.values()].every(owned=>!rows.some(row=>row.pid===owned.pid&&row.command===owned.command)),'Normal app quit must drain its native host');},5000);
  assert.equal(child.exitCode,0,'Normal quit exits successfully');assert.equal(child.signalCode,null,'Normal quit must not use a termination signal');
  record.exitCode=child.exitCode;record.signal=child.signalCode;record.nativeChildrenExited=true;
  cdp?.close();cdp=undefined;await stop();
}
async function closeWindow(dirty){
  observeNative();assert.ok(mainCDP,'Owned main inspector required for native API close');
  if(dirty)assert.ok(Date.now()-dirty.editedAt<1500,'Dirty close preparation exceeded pre-debounce deadline');
  const requestedAt=Date.now();
  const request=await mainCDP.evaluate(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');const windows=BrowserWindow.getAllWindows();if(process.pid!==${child.pid}||windows.length!==1||windows[0].webContents.getURL()!==${JSON.stringify(pathToFileURL(path.join(root,'dist/index.html')).href)})throw Error('Owned native close guard failed');const win=windows[0];const reply={pid:process.pid,windowId:win.id,url:win.webContents.getURL(),method:'BrowserWindow.close'};win.close();return reply;})()`);
  const elapsedSinceEditMs=dirty?Date.now()-dirty.editedAt:null;
  const record={label:'dirty-native-api-window-close-requested',requestedAt,elapsedSinceEditMs,request};evidence.checks.push(record);
  if(dirty)assert.ok(elapsedSinceEditMs<1800,'Native close request exceeded pre-debounce deadline');
  await until(async()=>{const rows=processTable();assert.ok([...ownedNative.values()].every(owned=>!rows.some(r=>r.pid===owned.pid&&r.command===owned.command)),'Native API window close must release its native host');},15000);
  record.mainEvents=await mainCDP.evaluate('globalThis.__zoridCloseEvidence');
  assert.ok(record.mainEvents.some(row=>row.event==='close'&&row.defaultPrevented===true),'Initial native close entered the guarded close handshake');
  assert.ok(record.mainEvents.some(row=>row.event==='close'&&row.defaultPrevented===false),'Released renderer completed the allowed native close');
  assert.ok(record.mainEvents.some(row=>row.event==='closed'),'Owned BrowserWindow actually closed');
  if(dirty){const actual=await fs.readFile(path.join(sandbox,'vault',dirty.file),'utf8');assert.equal(actual,dirty.text,'Native API dirty close flushes exact bytes before shell cleanup');record.exactDiskAfterClose=actual;}
  evidence.checks.push({label:'native-api-window-close-drained-host'});cdp?.close();cdp=undefined;
  if(!exited())await quitOwnedApp('normal-quit-after-window-close');else await stop();
}

try{
  before=await provenance();await fs.writeFile(path.join(out,'provenance-before.json'),JSON.stringify(before,null,2));
  sandbox=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-storage-electron-')));evidence.sandbox=sandbox;
  const vault=path.join(sandbox,'vault'),profile=path.join(sandbox,'profile');await fs.mkdir(vault);await fs.mkdir(profile);await fs.mkdir(path.join(sandbox,'app-data'));
  const seed='Recovery seed\nExact initial snapshot 😀\n';await fs.writeFile(path.join(vault,'Recovery seed.md'),seed);await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}));
  await launch('create-and-repeated-saves');await quiet('initial-open');
  await dom(`const b=document.querySelector('.sidebar-toolbar [aria-label="New note"]');if(!b||b.disabled||!b.getClientRects().length)throw Error('New note control unavailable');b.click();`);
  await until(async()=>assert.equal(await dom(`return document.querySelector('.pane.is-active .note-title')?.value;`),'Untitled'),15000);
  const file='Untitled.md';await editor();
  const versions=scenario==='full'?5:1;for(let i=1;i<=versions;i++){const text=`Storage proof ${i} 😀\nSaved exact bytes ${i}`;await replaceText(text);await saved(file,text,'autosave-'+i);}
  evidence.createdFile=file;evidence.finalText=`Storage proof ${versions} 😀\nSaved exact bytes ${versions}`;
  const initial=await snapshots();assert.ok(initial.rows.some(row=>row.path==='Recovery seed.md'&&row.hex===Buffer.from(seed).toString('hex').toUpperCase()),'Exact seed snapshot retained outside vault');evidence.initialSnapshots=initial;
  await screenshot('saved-quiet');if(scenario==='full'){const dirtyClose=await dirtyEdit(file,evidence.finalText,'\nDirty close flushed 😀','dirty-before-window-close');await closeWindow(dirtyClose);assert.equal(await fs.readFile(path.join(vault,file),'utf8'),dirtyClose.text,'Normal dirty-window close flushes exact bytes');evidence.finalText=dirtyClose.text;await noArtifacts('after-dirty-normal-close');
  await launch('restart-and-reopen');
  await dom(`const row=[...document.querySelectorAll('[role="treeitem"][data-path]')].find(e=>e.dataset.path==='Untitled.md');if(!row||!row.getClientRects().length)throw Error('Created file tree row missing');row.click();`);
  await editor(evidence.finalText);await saved(file,evidence.finalText,'restart-reopen-exact');
  const reopened=await snapshots();for(const original of initial.rows)assert.ok(reopened.rows.some(row=>JSON.stringify(row)===JSON.stringify(original)),'Snapshot survives app restart unchanged');evidence.reopenedSnapshots=reopened;
  await screenshot('reopened-quiet');}
  evidence.rendererEvents=cdp.events;
  const dirtyQuit=await dirtyEdit(file,evidence.finalText,'\nDirty quit flushed 😀','dirty-before-app-quit');
  await quitOwnedApp('normal-dirty-app-quit',dirtyQuit);
  assert.equal(await fs.readFile(path.join(vault,file),'utf8'),dirtyQuit.text,'Normal app quit flushes exact dirty bytes');
  evidence.finalText=dirtyQuit.text;await noArtifacts('after-dirty-app-quit');
  await launch('restart-after-normal-dirty-quit');
  await dom(`const row=[...document.querySelectorAll('[role="treeitem"][data-path]')].find(e=>e.dataset.path==='Untitled.md');if(!row||!row.getClientRects().length)throw Error('Created file tree row missing');row.click();`);
  await editor(evidence.finalText);await saved(file,evidence.finalText,'normal-dirty-quit-reopen-exact');await screenshot('normal-quit-reopened');
  await restoreSeedFromHistory('Recovery seed.md',seed);
  await quitOwnedApp('normal-quit-after-history-restore');
  await launch('restart-after-history-restore');await openFile('Recovery seed.md');
  await editor(seed);await saved('Recovery seed.md',seed,'history-restored-restart-exact');await screenshot('history-restored-reopened');
  await quitOwnedApp('final-clean-normal-app-quit');
  const after=await provenance();assert.deepEqual(after,before,'Frozen inputs/artifacts changed during runtime');evidence.status='passed';
}catch(error){failure=error;evidence.status='failed';evidence.failure={message:error.message,stack:error.stack};if(cdp){try{evidence.failureDOM=await dom('return document.body.innerText;');await screenshot('failure');}catch{}}}
finally{try{await stop();}catch(error){evidence.cleanupFailure=String(error);failure??=error;evidence.status='failed';}evidence.finished=new Date().toISOString();await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({status:evidence.status,evidence:path.join(out,'evidence.json'),sandbox,checks:evidence.checks.length}));if(failure){console.error(failure);process.exitCode=1;}
