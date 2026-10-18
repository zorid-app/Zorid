#!/usr/bin/env node
// Bounded normal-editor/independent-CLI race and exact-owned host interruption.
// No build or launch is implicit: a coordinator must supply frozen artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CDP,delay,until} from '../tasks-electron-integration/cdp.mjs';

const arg=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const required=name=>{const value=arg(name);assert.ok(value,'Explicit '+name+' required');return value;};
async function destination(input){let at=path.resolve(input);const missing=[];for(;;){try{return path.join(await fs.realpath(at),...missing);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(at);assert.notEqual(parent,at);missing.unshift(path.basename(at));at=parent;}}}
const root=await fs.realpath(required('--root')),expected=required('--expected-head');
const native=await fs.realpath(required('--native')),cli=await fs.realpath(required('--cli')),electron=await fs.realpath(required('--electron')),out=await destination(required('--out'));
assert.equal(arg('--ready'),'storage-concurrency-artifacts-frozen');assert.match(expected,/^[0-9a-f]{40}$/);
const ownFile=fileURLToPath(import.meta.url),ownDirectory=await fs.realpath(path.dirname(ownFile));
const inside=(candidate,base)=>candidate===base||candidate.startsWith(base+path.sep);
let manual;try{manual=JSON.parse(await fs.readFile('/private/tmp/zorid-current-manual-playground.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(manual)assert.ok(path.isAbsolute(manual.root)&&Number.isSafeInteger(manual.pid)&&manual.pid>0);
const manualRoots=await Promise.all(['/private/tmp/zorid-manual-playground-dlko_ol6',...(manual?[manual.root]:[])].map(destination));
const excludedPids=new Set([66932,...(manual?[manual.pid]:[])]);
for(const protectedRoot of [root,ownDirectory,...manualRoots])assert.ok(!inside(out,protectedRoot),'Evidence excludes source, harness and manual playgrounds');
for(const file of [root,native,cli,electron])for(const excluded of manualRoots)assert.ok(!inside(file,excluded),'No artifact or source may come from the manual playground');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
async function sha(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function tree(directory){const rows=[];async function walk(relative=''){for(const item of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){assert.ok(!item.isSymbolicLink(),'Artifact tree contains alias');const name=path.join(relative,item.name);if(item.isDirectory())await walk(name);else if(item.isFile())rows.push([name,await sha(path.join(directory,name))]);}}await walk();return rows.sort((a,b)=>a[0].localeCompare(b[0]));}
async function provenance(){assert.equal(git('rev-parse','HEAD').trim(),expected,'Frozen HEAD changed');assert.equal(git('diff','--name-only','HEAD').trim(),'','Tracked frozen source changed');const names=git('ls-files','-z','desktop','src','crates','scripts','Cargo.toml','Cargo.lock','package.json','pnpm-lock.yaml','vite.config.mjs','index.html').split('\0').filter(Boolean).sort(),source=[];for(const name of names)source.push([name,await sha(path.join(root,name))]);return{head:expected,source,dist:await tree(path.join(root,'dist')),native:{file:native,sha256:await sha(native)},cli:{file:cli,sha256:await sha(cli)},electron:{file:electron,sha256:await sha(electron)},harness:await sha(ownFile),cdpHelper:await sha(path.join(ownDirectory,'../tasks-electron-integration/cdp.mjs'))};}
const evidence={kind:'actual-electron-independent-cli-and-host-interruption',status:'running',started:new Date().toISOString(),checks:[],runtime:[],cli:[],limitations:[
  'Hidden owned Electron renderer driven through CDP; no foreground OS keyboard/focus parity',
  'One targeted native-host SIGKILL after an observed durable draft; no arbitrary-instruction crash or power-loss proof',
  'Intentional competing edits remain separate under current retained-draft UX; seamless merging is deferred',
  'Checkpoint inspection uses the existing read-only durable bridge; all source mutations use keyboard, CLI or the explicit recovery-copy UI',
  'No SQLite inspection/writes, stress workload, sync, mobile/browser or complete S0 acceptance',
]};
let sandbox,child,cdp,before,failure,interruptions=0;
const knownNative=new Map(),ownedCli=new Map();
const exited=()=>!child||child.exitCode!==null||child.signalCode!==null;
const processes=()=>execFileSync('ps',['-ww','-axo','pid=,ppid=,command='],{encoding:'utf8',maxBuffer:4*1024*1024}).split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:+m[1],parent:+m[2],command:m[3]}:null;}).filter(Boolean);
function observeNative(){if(!child)return[];const rows=processes().filter(row=>row.parent===child.pid&&row.command.startsWith(native+' --vault '+path.join(sandbox,'vault')));for(const row of rows){assert.ok(!excludedPids.has(row.pid));knownNative.set(row.pid,row);}return rows;}
function killExact(row,signal){assert.ok(!excludedPids.has(row.pid));const live=processes().find(item=>item.pid===row.pid);assert.ok(live&&live.parent===row.parent&&live.command===row.command,'Exact owned process identity changed');assert.ok(live.command.includes(sandbox),'Owned process must name this disposable sandbox');process.kill(row.pid,signal);}
async function stop(){
  if(!child)return;observeNative();cdp?.close();cdp=undefined;
  assert.ok(!excludedPids.has(child.pid));const record={pid:child.pid,method:exited()?'already-exited':'SIGTERM-owned-cleanup'};
  if(!exited()){const live=processes().find(row=>row.pid===child.pid);assert.ok(live?.command.startsWith(electron+' ')&&live.command.includes('--user-data-dir='+path.join(sandbox,'profile')));child.kill('SIGTERM');try{await until(async()=>assert.ok(exited()),5000);}catch{record.method='SIGKILL-owned-cleanup-after-deadline';child.kill('SIGKILL');await until(async()=>assert.ok(exited()),5000);}}
  const surviving=()=>processes().filter(row=>[...knownNative.values()].some(owned=>owned.pid===row.pid&&owned.command===row.command));
  try{await until(async()=>assert.equal(surviving().length,0),5000);}catch{for(const row of surviving())killExact(row,'SIGKILL');record.leakedNative=true;}
  record.exitCode=child.exitCode;record.signal=child.signalCode;record.native=[...knownNative.values()];evidence.runtime.push({cleanup:record});child=undefined;knownNative.clear();assert.ok(!record.leakedNative,'Owned native process leaked and needed forced cleanup');
}
const environment=()=>{const env={...process.env,ZORID_DESKTOP_HOST_BIN:native,ZORID_LOCAL_DATA_DIR:path.join(sandbox,'app-data')};for(const key of ['ELECTRON_RUN_AS_NODE','ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_EDITOR_RUST','ZORID_FIXTURE_VAULT','ZORID_FIXTURE_SYNC_CONFIG','ZORID_FIXTURE_CLIENT_ID','ZORID_IPC_ENDPOINT'])delete env[key];return env;};
function invokeCli(args,expectFailure){
  const argv=['--vault',path.join(sandbox,'vault'),...args],record={args,started:Date.now(),stdout:'',stderr:''};evidence.cli.push(record);
  const proc=spawn(cli,argv,{cwd:root,env:environment(),stdio:['ignore','pipe','pipe']});assert.ok(!excludedPids.has(proc.pid));ownedCli.set(proc.pid,proc);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{const row=processes().find(row=>row.pid===proc.pid&&row.command.startsWith(cli+' ')&&row.command.includes(path.join(sandbox,'vault')));if(row)killExact(row,'SIGKILL');reject(Error('Owned CLI deadline: '+args.join(' ')));},15000);
    const done=()=>{clearTimeout(timer);ownedCli.delete(proc.pid);record.finished=Date.now();};
    proc.once('error',error=>{done();reject(error);});for(const name of ['stdout','stderr'])proc[name].on('data',bytes=>{record[name]+=bytes.toString();if(record[name].length>1024*1024){proc.kill('SIGKILL');reject(Error('Owned CLI output exceeds bound'));}});
    proc.once('close',(code,signal)=>{done();record.code=code;record.signal=signal;try{
      if(expectFailure){assert.notEqual(code,0);assert.equal(record.stdout,'');const value=JSON.parse(record.stderr);assert.equal(value.ok,false);assert.equal(value.error.code,expectFailure);resolve(value.error);}
      else{assert.equal(code,0,record.stderr);assert.equal(record.stderr,'');const value=JSON.parse(record.stdout);assert.equal(value.version,1);assert.equal(value.ok,true);resolve(value.result);}
    }catch(error){reject(error);}});
  });
}
async function launch(pass){
  assert.ok(!child);await fs.rm(path.join(sandbox,'profile','DevToolsActivePort'),{force:true});
  const record={pass,stdout:'',stderr:''};evidence.runtime.push(record);
  child=spawn(electron,[path.join(root,'desktop/main.cjs'),'--user-data-dir='+path.join(sandbox,'profile'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{cwd:root,env:environment(),stdio:['ignore','pipe','pipe']});assert.ok(!excludedPids.has(child.pid));
  let spawnError;child.once('error',error=>{spawnError=error;});for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{if(record[name].length<128000)record[name]+=bytes.toString();});
  const port=await until(async()=>{if(spawnError)throw spawnError;assert.ok(!exited(),record.stderr);let value;try{value=(await fs.readFile(path.join(sandbox,'profile','DevToolsActivePort'),'utf8')).split('\n')[0];}catch{value=record.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];}assert.match(value,/^[1-9][0-9]{0,4}$/);return value;},30000);
  const target=await until(async()=>{const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(response=>response.json());const page=rows.find(row=>row.type==='page'&&row.url.startsWith('file:')&&row.url.includes('/dist/index.html'));assert.ok(page);return page;},30000);
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Log.enable');await cdp.call('Page.enable');
  await until(async()=>assert.equal(await cdp.evaluate('Boolean(window.zorid&&document.querySelector(".workspace"))'),true),30000);
  record.vault=await cdp.evaluate('window.zorid.getVault()');assert.equal(record.vault.path,path.join(sandbox,'vault'));record.pid=child.pid;record.native=observeNative();assert.equal(record.native.length,1);
  const app=processes().find(row=>row.pid===child.pid);assert.ok(app?.command.startsWith(electron+' ')&&app.command.includes('--user-data-dir='+path.join(sandbox,'profile')));
  const hide=`ObjC.import('AppKit');function run(argv){const pid=Number(argv[0]),app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);if(Number(app.processIdentifier)!==pid||ObjC.unwrap(app.executableURL.path)!==argv[1])throw Error('Owned app changed');const alreadyHidden=Boolean(app.isHidden),accepted=alreadyHidden?false:Boolean(app.hide),end=Date.now()+1000;while(!Boolean(app.isHidden)&&Date.now()<end)$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));return JSON.stringify({pid:pid,alreadyHidden:alreadyHidden,accepted:accepted,hidden:Boolean(app.isHidden)});}`;
  record.hide=JSON.parse(execFileSync('osascript',['-l','JavaScript','-e',hide,String(child.pid),electron],{encoding:'utf8',timeout:5000}));assert.equal(record.hide.hidden,true,'Exact owned app hidden before interaction');
}
const dom=body=>cdp.evaluate(`(()=>{${body}})()`);
async function screenshot(label){const{data}=await cdp.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,label+'.png'),Buffer.from(data,'base64'));}
async function view(){return dom(`const e=document.querySelector('.pane.is-active .cm-content[contenteditable="true"]'),b=document.querySelector('.pane.is-active .note-recovery');return{text:e?[...e.querySelectorAll('.cm-line')].map(line=>line.textContent).join('\\n'):null,save:document.querySelector('.save-state')?.textContent??'',conflict:!!b&&!b.hidden,banner:b&&!b.hidden?b.textContent:null};`);}
async function editor(text){return until(async()=>{const value=await view();assert.equal(value.text,text);return value;},15000);}
async function openFile(){await until(async()=>assert.equal(await dom(`const row=[...document.querySelectorAll('[role="treeitem"][data-path]')].find(row=>row.dataset.path==='Concurrent.md');if(!row||!row.getClientRects().length)return false;row.click();return true;`),true),15000);await until(async()=>assert.equal(await dom(`return document.querySelector('.pane.is-active .note-title')?.value;`),'Concurrent'),15000);}
async function replace(text){await dom(`const e=document.querySelector('.pane.is-active .cm-content[contenteditable="true"]');if(!e)throw Error('Editor not ready');e.focus();`);await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4});await cdp.call('Input.insertText',{text});}
async function disk(){return fs.readFile(path.join(sandbox,'vault','Concurrent.md'),'utf8');}
async function checkpoint(entryId){return cdp.evaluate(`(async()=>{const vault=await window.zorid.getVault(),binding=await window.zorid.getDurableContext(vault.path);if(!binding?.admissionId)throw Error('Existing durable read capability unavailable');const row=await window.zorid.durableInvoke(vault.path,binding.admissionId,'checkpoints.load',['note/v1/'+${JSON.stringify(entryId)}]);return row?{scope:binding.scope,revision:row.revision,state:JSON.parse(row.encodedState)}:null;})()`);}
async function readCli(entryId){const value=await invokeCli(['read','--id',entryId]);assert.equal(value.encoding,'base64');return{entry:value.entry,text:Buffer.from(value.bytes,'base64').toString('utf8')};}
async function sharedCache(entryId){
  const built=await invokeCli(['document-index','build']);assert.equal(built.published,true);const status=await invokeCli(['document-index','status']);assert.equal(status.status.state,'ready');
  const journal=await checkpoint(entryId);assert.equal(status.localStoreId,journal.scope.vaultId);
  const buckets=await fs.readdir(path.join(sandbox,'app-data','vaults'));assert.equal(buckets.length,1);const cache=path.join(sandbox,'app-data','vaults',buckets[0],'cache.sqlite');assert.ok((await fs.stat(cache)).isFile());assert.ok(!inside(cache,path.join(sandbox,'vault')));
  await dom(`const tab=document.querySelector('.sidebar-tabs button[data-type="search"]');if(!tab)throw Error('Normal Search tab unavailable');tab.click();document.querySelector('.search-box').focus();`);
  await cdp.call('Input.insertText',{text:'Clean desktop baseline'});
  const search=await until(async()=>{const rows=await dom(`return [...document.querySelectorAll('.search-results .search-result')].map(row=>({entryId:row.querySelector('.search-result-title')?.dataset.entryId,title:row.querySelector('.search-result-title')?.textContent,snippets:[...row.querySelectorAll('.search-snippet')].map(item=>item.textContent)}));`);assert.equal(rows.length,1);assert.equal(rows[0].entryId,entryId);assert.equal(rows[0].title,'Concurrent');assert.ok(rows[0].snippets.some(text=>text.includes('Clean desktop baseline 😀')));return rows;},20000);
  await dom(`document.querySelector('.sidebar-tabs button[data-type="files"]').click();`);
  evidence.checks.push({label:'desktop-and-cli-same-authority-app-local-cache',localStoreId:status.localStoreId,cache,built,status,ordinarySearchResults:search});
}

try{
  await fs.mkdir(out,{recursive:true});before=await provenance();await fs.writeFile(path.join(out,'provenance-before.json'),JSON.stringify(before,null,2));
  sandbox=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-storage-concurrency-')));for(const excluded of manualRoots)assert.ok(!inside(sandbox,excluded));evidence.sandbox=sandbox;
  const vault=path.join(sandbox,'vault'),profile=path.join(sandbox,'profile');await fs.mkdir(vault);await fs.mkdir(profile);await fs.mkdir(path.join(sandbox,'app-data'));
  const seed='Concurrency seed\nInitial ordinary note',baseline='Clean desktop baseline 😀\nExact committed editor version';
  await fs.writeFile(path.join(vault,'Concurrent.md'),seed);await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}));
  await launch('shared-vault-concurrency');await openFile();await editor(seed);await replace(baseline);
  await until(async()=>{assert.equal(await disk(),baseline);const current=await editor(baseline);assert.equal(current.save,'');assert.equal(current.conflict,false);},20000);
  const listed=await invokeCli(['list']),entry=listed.entries.find(entry=>entry.path==='Concurrent.md');assert.ok(entry?.id);const clean=await readCli(entry.id);assert.equal(clean.text,baseline);evidence.checks.push({label:'normal-editor-clean-baseline',entry:clean.entry,text:baseline});
  await sharedCache(entry.id);await screenshot('clean-shared-vault');

  const peer='Peer committed text 😀\nIndependent CLI version',input=path.join(sandbox,'peer-input.txt');await fs.writeFile(input,peer);
  const operationId=randomUUID(),writeArgs=['write','--id',entry.id,'--expected-revision',clean.entry.revision,'--operation-id',operationId,'--input',input];
  const prefix='Desktop retained draft 😀\nConcurrent typing ';await replace(prefix);const dirty=await editor(prefix);assert.equal(dirty.save,'Saving…');assert.equal(await disk(),baseline);
  let done=false;const writing=invokeCli(writeArgs).finally(()=>{done=true;});void writing.catch(()=>undefined);let typed=0;
  // Ordinary repeated input keeps the actual debounce pending; no clock mocks.
  for(;!done&&typed<60;typed++){await cdp.call('Input.insertText',{text:'.'});await delay(50);}
  const withinTypingBudget=done;const written=await writing;assert.ok(withinTypingBudget,'CLI write did not finish inside the bounded real-typing race');
  const draft=prefix+'.'.repeat(typed),afterTyping=await editor(draft);assert.equal(written.durable_local_commit,true);
  assert.equal(written.commit.operation_id,operationId);const change=written.commit.changes.find(change=>change.after?.id===entry.id);assert.ok(change);assert.equal(change.before.revision,clean.entry.revision);assert.notEqual(change.after.revision,clean.entry.revision);
  assert.equal(await disk(),peer);const peerRead=await readCli(entry.id);assert.equal(peerRead.text,peer);assert.equal(peerRead.entry.revision,change.after.revision);
  const replay=await invokeCli(writeArgs);assert.deepEqual(replay.commit,written.commit,'Identical CLI replay must return its original receipt');
  const rejected=await invokeCli(['write','--id',entry.id,'--expected-revision',clean.entry.revision,'--operation-id',randomUUID(),'--input',input],'revision_conflict');assert.equal(await disk(),peer);
  const conflict=await until(async()=>{const value=await editor(draft);assert.equal(value.conflict,true);assert.match(value.banner,/changed elsewhere|draft|both versions/i);assert.doesNotMatch(value.banner,/sqlite|namespace|checkpoint|revision_conflict/i);return value;},20000);
  const journal=await until(async()=>{const value=await checkpoint(entry.id);assert.equal(value.state.draft,draft);assert.equal(value.state.base.entryId,entry.id);assert.equal(value.state.base.content,baseline);assert.equal(value.state.conflict,true);return value;},15000);
  evidence.checks.push({label:'independent-cli-commit-with-retained-desktop-draft',typed,initialDirty:dirty,afterTyping,draft,peer,entryId:entry.id,receipt:written.commit,replayedReceipt:replay.commit,staleRejection:rejected,conflict,journal});await screenshot('peer-committed-draft-retained');

  const hosts=observeNative();assert.equal(hosts.length,1);const host=hosts[0];assert.equal(host.parent,child.pid);killExact(host,'SIGKILL');interruptions++;
  await until(async()=>assert.ok(!processes().some(row=>row.pid===host.pid&&row.command===host.command)),5000);
  assert.equal(await disk(),peer);const stillCommitted=await readCli(entry.id);assert.equal(stillCommitted.text,peer);assert.equal(stillCommitted.entry.revision,peerRead.entry.revision);
  evidence.checks.push({label:'exact-owned-host-interruption',host,signal:'SIGKILL',interruptions,committed:stillCommitted,journalBeforeInterruption:journal});await stop();
  await launch('reopen-after-host-interruption');await openFile();const reopened=await until(async()=>{const value=await editor(draft);assert.equal(value.conflict,true);return value;},20000);
  assert.equal(await disk(),peer);const restoredJournal=await checkpoint(entry.id);assert.equal(restoredJournal.state.draft,draft);assert.equal(restoredJournal.state.base.content,baseline);assert.equal(restoredJournal.state.conflict,true);
  evidence.checks.push({label:'reopen-preserves-committed-peer-and-exact-journaled-draft',peer,draft,reopened,restoredJournal});await screenshot('reopened-retained-draft');
  const prior=await invokeCli(['list']);await dom(`const banner=document.querySelector('.pane.is-active .note-recovery'),button=[...banner.querySelectorAll('button')].find(button=>button.textContent==='Save recovery copy');if(!button||button.disabled)throw Error('Ordinary recovery-copy action unavailable');button.click();`);
  await until(async()=>{const value=await editor(peer);assert.equal(value.conflict,false);assert.equal(value.save,'');},20000);
  const copied=await until(async()=>{const latest=await invokeCli(['list']),added=latest.entries.filter(entry=>!entry.deleted&&!prior.entries.some(old=>old.id===entry.id));assert.equal(added.length,1);return added[0];},15000);
  assert.match(copied.path,/^Concurrent \(recovered draft [a-f0-9]{8}\)\.md$/);const recovery=await readCli(copied.id);assert.equal(recovery.text,draft);assert.equal(await fs.readFile(path.join(vault,copied.path),'utf8'),draft);
  const original=await readCli(entry.id);assert.equal(original.text,peer);assert.equal(original.entry.revision,peerRead.entry.revision,'Saving a recovery copy cannot rewrite the original');
  evidence.checks.push({label:'explicit-recovery-copy-preserves-both-versions',copy:recovery,original});await screenshot('both-versions-preserved');
  assert.equal(interruptions,1);evidence.rendererEvents=cdp.events;await stop();assert.deepEqual(await provenance(),before,'Frozen inputs changed during runtime');evidence.status='passed';
}catch(error){failure=error;evidence.status='failed';evidence.failure={message:error.message,stack:error.stack};if(cdp)try{evidence.failureDOM=await dom('return document.body.innerText;');evidence.rendererEvents=cdp.events;await screenshot('failure');}catch{}}
finally{
  try{await stop();for(const [pid,proc]of ownedCli){const live=processes().find(row=>row.pid===pid&&row.command.startsWith(cli+' ')&&row.command.includes(sandbox));if(live)killExact(live,'SIGKILL');ownedCli.delete(pid);}}catch(error){evidence.cleanupFailure=String(error);failure??=error;evidence.status='failed';}
  evidence.finished=new Date().toISOString();evidence.nativeInterruptions=interruptions;await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify({status:evidence.status,evidence:path.join(out,'evidence.json'),sandbox,checks:evidence.checks.length}));if(failure){console.error(failure);process.exitCode=1;}
