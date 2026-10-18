import {createHash} from 'node:crypto';
import {observeOwnedChild,cleanupOwnedResources} from '../browser-workblocks-worker/cleanup.mjs';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
if(!process.argv.includes('--runtime-authorized'))throw new Error('SOURCE ONLY: coordinator must authorize this concrete runtime turn before --runtime-authorized');
const campaignTimeout=Number(arg('--timeout-ms')??180000);
if(!Number.isInteger(campaignTimeout)||campaignTimeout<1000||campaignTimeout>300000)throw new Error('Runtime deadline must be 1000..300000 milliseconds');
const expectedHead=arg('--expect-head');
if(!expectedHead||!/^[a-f0-9]{40}$/.test(expectedHead))throw new Error('Pass --expect-head <full frozen integration commit>; this runner never builds WASM');
const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(head()!==expectedHead)throw new Error('Integration HEAD differs from explicit source freeze');
const generated=path.join(root,'target/browser-wasm/generated');
const require=createRequire(import.meta.url);
const {sourceInputs}=require(path.join(root,'scripts/build-core-wasm.cjs'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function rustFingerprint(){
  const digest=createHash('sha256').update('wasm-bindgen 0.2.129\0');
  for(const file of await sourceInputs(root))digest.update(file).update('\0').update(await readFile(path.join(root,file))).update('\0');
  return digest.digest('hex');
}
async function sourceDigest(){
  const files=[];
  async function walk(dir){for(const entry of (await readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=dir+'/'+entry.name;if(entry.isDirectory())await walk(file);else if(entry.isFile()&&/\.(?:ts|mjs|html)$/.test(file))files.push(file);
  }}
  await walk('src/core');await walk('src/platform');await walk('tests/browser-task-queries');
  const digest=createHash('sha256');for(const file of files)digest.update(file).update('\0').update(await readFile(path.join(root,file))).update('\0');
  return digest.digest('hex');
}
async function artifactProof(){
  const metadata=JSON.parse(await readFile(path.join(generated,'build.json'),'utf8'));
  if(metadata.bindgenVersion!=='0.2.129'||metadata.fingerprint!==await rustFingerprint())throw new Error('STALE_WASM: coordinator must rebuild current assembled Rust before this run');
  const files={};for(const name of ['zorid_wasm.js','zorid_wasm_bg.wasm']){
    files[name]=sha(await readFile(path.join(generated,name)));if(files[name]!==metadata.files[name])throw new Error('WASM asset hash mismatch: '+name);
  }
  const glue=await readFile(path.join(generated,'zorid_wasm.js'),'utf8');
  if(!glue.includes('tasksJson'))throw new Error('Current generated bindings missing tasksJson');
  return {head:expectedHead,fingerprint:metadata.fingerprint,files,sourceDigest:await sourceDigest()};
}
const provenance=await artifactProof();
let vite;
try {vite=await import('vite');} catch {
  // Existing main checkout tooling; no package install or lockfile mutation.
  const toolingRoot=process.env.ZORID_TOOLING_ROOT??'/Users/ctk/Projects/Zorid';
  const toolingRequire=createRequire(path.join(toolingRoot,'package.json'));
  vite=await import(pathToFileURL(toolingRequire.resolve('vite')).href);
}
const out=path.resolve(arg('--out')??path.join(here,'artifacts',new Date().toISOString().replaceAll(':','-')));
await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),'zorid-tasks-browser-chrome-'));
let server,chrome,cdp,stderr,childReceipt;
const chromeDone=()=>!chrome||chrome.exitCode!==null||chrome.signalCode!==null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action, timeout=15000){const end=Date.now()+timeout;let last;do{try{return await action();}catch(error){last=error;}await delay(100);}while(Date.now()<end);throw last??new Error('Deadline');}
class CDP {
  constructor(url){this.ws=new WebSocket(url);this.next=0;this.pending=new Map();this.events=[];
    this.opened=new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});
    this.ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const waiting=this.pending.get(value.id);if(!waiting)return;this.pending.delete(value.id);clearTimeout(waiting.timer);value.error?waiting.reject(new Error(JSON.stringify(value.error))):waiting.resolve(value.result);}else if(this.events.length<3000)this.events.push(value);});
    this.ws.addEventListener('close',()=>{for(const waiting of this.pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('CDP socket closed'));}this.pending.clear();});
  }
  async call(method,params={}){await this.opened;const id=++this.next;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));
  });}
  close(){this.ws.close();}
}
let evidence, failure;
try {
  server=await vite.createServer({root,configFile:false,envFile:false,clearScreen:false,logLevel:'error',
    server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root]}}});
  await server.listen();const address=server.httpServer.address();
  if(!address||typeof address==='string')throw new Error('No owned Vite port');
  const url=`http://127.0.0.1:${address.port}/tests/browser-task-queries/`;
  const chromeBinary=process.env.CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  stderr='';chrome=spawn(chromeBinary,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
    '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
  childReceipt=observeOwnedChild(chrome);
  let spawnError;chrome.on('error',error=>{spawnError=error;});chrome.stderr.on('data',chunk=>{if(stderr.length<128000)stderr+=chunk;});
  const debugPort=await until(async()=>{if(spawnError)throw spawnError;if(chromeDone())throw new Error('Owned Chrome exited before CDP: '+chrome.exitCode);
    const lines=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');assertPort(lines[0]);return lines[0];});
  const target=await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  const browserVersion=await cdp.call('Browser.getVersion');
  await writeFile(path.join(out,'browser.json'),JSON.stringify(browserVersion,null,2)+'\n');
  await cdp.call('Page.navigate',{url});
  const deadline=Date.now()+campaignTimeout;
  while(Date.now()<deadline){
    const result=await cdp.call('Runtime.evaluate',{expression:'JSON.stringify({done:window.taskQueriesComplete===true,evidence:window.taskQueriesEvidence})',returnByValue:true});
    if(result.exceptionDetails)throw new Error('Page evidence evaluation threw');
    const state=JSON.parse(result.result.value??'{}');evidence=state.evidence;
    if(state.done)break;
    await delay(250);
  }
  if(!evidence?.finished)throw new Error('Fixture deadline expired');
  if(evidence.status!=='passed')throw new Error('Browser fixture failed: '+JSON.stringify(evidence.error));
  // Recompute all source/artifact witnesses AFTER execution as well as before it.
  if(head()!==expectedHead||JSON.stringify(await artifactProof())!==JSON.stringify(provenance))throw new Error('Sources/artifacts changed during execution; evidence rejected');
} catch(error){failure=error;console.error(String(error.stack??error));}
finally {
  const cleanup=await cleanupOwnedResources({chrome,childReceipt,profile,server,cdp});
  const artifactFailures=[];
  for(const [name,value] of [['cdp-events.json',cdp?JSON.stringify(cdp.events,null,2)+'\n':null],['chrome-stderr.log',stderr??null],['cleanup.json',JSON.stringify(cleanup,null,2)+'\n']]){
    if(value===null)continue;
    try{await writeFile(path.join(out,name),value);}catch(error){artifactFailures.push({file:name,message:String(error.stack??error)});}
  }
  if(cleanup.failures.length||artifactFailures.length)failure??=new Error('Owned cleanup/evidence failure: '+JSON.stringify({cleanup:cleanup.failures,artifactFailures}));
  await writeFile(path.join(out,'report.json'),JSON.stringify({provenance,evidence:evidence??null,cleanup,artifactFailures,runnerError:failure?String(failure.stack??failure):null},null,2)+'\n');
}
if(failure)process.exitCode=1;
else console.log(`PASS Tasks: ${evidence.groups.length} groups; ${evidence.remainingGates.length} explicitly deferred gates; ${out}`);
function assertPort(value){if(!/^[1-9][0-9]{0,4}$/.test(value)||Number(value)>65535)throw new Error('Invalid owned CDP port');}
