#!/usr/bin/env node
// Actual normal Electron save/restart subset. Explicit coordinator freeze required.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CDP,delay,until} from '../tasks-electron-integration/cdp.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const required=name=>{const value=arg(name);assert.ok(value,`Explicit ${name} required`);return value;};
const root=path.resolve(required('--root')),expectedHead=required('--expected-head');
const native=path.resolve(required('--native')),electron=path.resolve(required('--electron')),out=path.resolve(required('--out'));
assert.equal(arg('--ready'),'storage-native-and-frontend-frozen','Matching frozen native/frontend readiness required');
assert.match(expectedHead,/^[0-9a-f]{40}$/);
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
assert.ok(!out.startsWith(root+path.sep)&&!out.startsWith(harness+path.sep),'Evidence must be outside source/artifact trees');
await fs.mkdir(out,{recursive:true});
const evidence={kind:'actual-electron-storage-save-restart-subset',status:'running',started:new Date().toISOString(),checks:[],runtime:[],limitations:['No crash/power-loss, late external-handle or multi-client concurrency proof','Five-minute interval/expiry/dedupe correctness remains covered by focused recovery checks, not a shortened runtime clock','Recovery snapshot inspection is read-only SQLite evidence; no recovery UI/restore acceptance is claimed','No mobile/browser/sync or complete S0 acceptance follows from this subset']};
let sandbox,child,cdp,before,failure;
const ownedNative=new Map();
const exited=()=>!child||child.exitCode!==null||child.signalCode!==null;
const processTable=()=>execFileSync('ps',['-ww','-axo','pid=,ppid=,command='],{encoding:'utf8',maxBuffer:4*1024*1024}).split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:Number(m[1]),parent:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
function observeNative(){const rows=processTable().filter(row=>row.parent===child?.pid&&row.command.startsWith(native+' --vault '+path.join(sandbox,'vault')));for(const row of rows)ownedNative.set(row.pid,row);return rows;}
async function stop(){
  if(!child)return;observeNative();cdp?.close();cdp=undefined;
  const result={pid:child.pid,method:exited()?'already-exited':'SIGTERM-owned-process'};
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
  child=spawn(electron,[path.join(root,'desktop/main.cjs'),'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let spawnError;child.on('error',error=>{spawnError=error;});for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{if(record[name].length<128000)record[name]+=bytes.toString();});
  const port=await until(async()=>{if(spawnError)throw spawnError;assert.ok(!exited(),'Electron exited: '+record.stderr);let value;try{value=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{value=record.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];}assert.match(value,/^[1-9][0-9]{0,4}$/);return value;},30000);
  const target=await until(async()=>{const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());const row=rows.find(r=>r.type==='page'&&r.url.startsWith('file:')&&r.url.includes('/dist/index.html'));assert.ok(row,'Normal renderer page missing');return row;},30000);
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Log.enable');await cdp.call('Page.enable');
  await until(async()=>assert.equal(await cdp.evaluate('Boolean(window.zorid&&document.querySelector(".workspace"))'),true),30000);
  record.vault=await cdp.evaluate('window.zorid.getVault()');assert.equal(record.vault.path,path.join(sandbox,'vault'));
  record.pid=child.pid;record.nativeChildren=observeNative();assert.equal(record.nativeChildren.length,1,'Exactly one matching actual native child');
}
async function dom(body){return cdp.evaluate(`(()=>{${body}})()`);}
async function quiet(label){
  const state=await until(async()=>{const value=await dom(`const s=document.querySelector('.import-status');const visible=s&&!s.hidden&&s.getClientRects().length;return{visible:!!visible,text:visible?s.textContent:'',errors:[...document.querySelectorAll('.error-message,.startup-error,[role="alert"]')].filter(e=>!e.hidden&&e.getClientRects().length).map(e=>e.textContent)};`);assert.equal(value.visible,false,'Normal operation should not show import status');assert.deepEqual(value.errors,[],'No visible error');return value;},15000);
  assert.doesNotMatch(state.text,/reconciliation|sqlite|scan|import|namespace|previous|vault.*attention/i);evidence.checks.push({label,ui:state});
}
async function screenshot(name){await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');const {data}=await cdp.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,name+'.png'),Buffer.from(data,'base64'));}
async function noArtifacts(label){const names=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else names.push(path.relative(path.join(sandbox,'vault'),f));}}await walk(path.join(sandbox,'vault'));assert.deepEqual(names.filter(n=>/\.(previous|stage|namespace)$/.test(n)),[],'Successful saves must not accumulate publication artifacts');evidence.checks.push({label,vaultFiles:names});}
async function editor(expected){return until(async()=>{const state=await dom(`const e=document.querySelector('.pane.is-active .cm-content[contenteditable="true"]');if(!e)return null;e.focus();return{text:[...e.querySelectorAll(".cm-line")].map(line=>line.textContent).join("\\n"),focused:e.contains(document.activeElement)||e===document.activeElement};`);assert.ok(state?.focused,'Editable CodeMirror focused');if(expected!==undefined)assert.equal(state.text,expected);return state;},15000);}
async function replaceText(text){await editor();await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4});await cdp.call('Input.insertText',{text});}
async function saved(file,text,label){await until(async()=>{assert.equal(await fs.readFile(path.join(sandbox,'vault',file),'utf8'),text);assert.equal(await dom(`return document.querySelector('.save-state')?.textContent??'';`),'');},20000);const read=await cdp.evaluate(`(async()=>{const v=await window.zorid.getVault();return window.zorid.read(v.path,${JSON.stringify(file)});})()`);assert.equal(read,text);evidence.checks.push({label,file,content:text});await quiet(label);await noArtifacts(label);}
async function snapshots(){
  const buckets=await fs.readdir(path.join(sandbox,'app-data','vaults'));assert.equal(buckets.length,1,'One per-vault app-local recovery bucket');const db=path.join(sandbox,'app-data','vaults',buckets[0],'recovery.sqlite');
  assert.ok(!db.startsWith(path.join(sandbox,'vault')+path.sep));
  const python='import sqlite3,json,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nprint(json.dumps([dict(zip(["id","entryId","path","time","provenance","hex"],r)) for r in c.execute("SELECT id,entry_id,historical_path,captured_at_ms,provenance,hex(content) FROM snapshots ORDER BY id")]))';
  const rows=JSON.parse(execFileSync('python3',['-c',python,db],{encoding:'utf8'}));return{db,rows};
}
async function closeWindow(){
  observeNative();const session=cdp;await session.evaluate('setTimeout(()=>window.close(),0);true');
  await until(async()=>{const rows=processTable();assert.ok([...ownedNative.values()].every(owned=>!rows.some(r=>r.pid===owned.pid&&r.command===owned.command)),'Normal window close must release its native host');},15000);
  evidence.checks.push({label:'normal-window-close-drained-host'});cdp?.close();cdp=undefined;await stop();
}
try{
  before=await provenance();await fs.writeFile(path.join(out,'provenance-before.json'),JSON.stringify(before,null,2));
  sandbox=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-storage-electron-')));evidence.sandbox=sandbox;
  const vault=path.join(sandbox,'vault'),profile=path.join(sandbox,'profile');await fs.mkdir(vault);await fs.mkdir(profile);await fs.mkdir(path.join(sandbox,'app-data'));
  const seed='# Recovery seed\nExact initial snapshot 😀\n';await fs.writeFile(path.join(vault,'Recovery seed.md'),seed);await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}));
  await launch('create-and-repeated-saves');await quiet('initial-open');
  await dom(`const b=document.querySelector('.sidebar-toolbar [aria-label="New note"]');if(!b||b.disabled||!b.getClientRects().length)throw Error('New note control unavailable');b.click();`);
  await until(async()=>assert.equal(await dom(`return document.querySelector('.pane.is-active .note-title')?.value;`),'Untitled'),15000);
  const file='Untitled.md';await editor();
  for(let i=1;i<=5;i++){const text=`Storage proof ${i} 😀\nSaved exact bytes ${i}`;await replaceText(text);await saved(file,text,'autosave-'+i);}
  evidence.createdFile=file;evidence.finalText='Storage proof 5 😀\nSaved exact bytes 5';
  const initial=await snapshots();assert.ok(initial.rows.some(row=>row.path==='Recovery seed.md'&&row.hex===Buffer.from(seed).toString('hex').toUpperCase()),'Exact seed snapshot retained outside vault');evidence.initialSnapshots=initial;
  await screenshot('saved-quiet');await closeWindow();await noArtifacts('after-normal-close');
  await launch('restart-and-reopen');
  await dom(`const row=[...document.querySelectorAll('[role="treeitem"][data-path]')].find(e=>e.dataset.path==='Untitled.md');if(!row||!row.getClientRects().length)throw Error('Created file tree row missing');row.click();`);
  await editor(evidence.finalText);await saved(file,evidence.finalText,'restart-reopen-exact');
  const reopened=await snapshots();for(const original of initial.rows)assert.ok(reopened.rows.some(row=>JSON.stringify(row)===JSON.stringify(original)),'Snapshot survives app restart unchanged');evidence.reopenedSnapshots=reopened;
  await screenshot('reopened-quiet');evidence.rendererEvents=cdp.events;await closeWindow();
  const after=await provenance();assert.deepEqual(after,before,'Frozen inputs/artifacts changed during runtime');evidence.status='passed';
}catch(error){failure=error;evidence.status='failed';evidence.failure={message:error.message,stack:error.stack};if(cdp){try{evidence.failureDOM=await dom('return document.body.innerText;');await screenshot('failure');}catch{}}}
finally{try{await stop();}catch(error){evidence.cleanupFailure=String(error);failure??=error;evidence.status='failed';}evidence.finished=new Date().toISOString();await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({status:evidence.status,evidence:path.join(out,'evidence.json'),sandbox,checks:evidence.checks.length}));if(failure){console.error(failure);process.exitCode=1;}
