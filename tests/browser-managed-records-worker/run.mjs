import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
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
    const file=dir+'/'+entry.name;if(entry.isDirectory())await walk(file);else if(entry.isFile()&&/\.(?:ts|mjs)$/.test(file))files.push(file);
  }}
  await walk('src/core');await walk('src/platform');await walk('tests/browser-managed-records-worker');
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
  for(const name of ['prepareRecordsLocal','recordsSnapshot','validateRecordsRegistration','canonicalRecordsLocalRequest','finalizeRecordsLocalResult','recordsRetryEligible','recordsLocalReadSet','recordsStoredReadSet','validateRecordsAccepted','validateRecordsStoredOperation','validateRecordsStoredReplay','validateRecordsStoredBinding','recordsReadSetJson','prepareRecords'])
    if(!glue.includes(name))throw new Error('Current generated bindings missing '+name);
  return {head:expectedHead,fingerprint:metadata.fingerprint,files,sourceDigest:await sourceDigest()};
}
const provenance=await artifactProof();
let relayItems=[];
let vite;
try {vite=await import('vite');} catch {
  // Existing main checkout tooling; no package install or lockfile mutation.
  const toolingRoot=process.env.ZORID_TOOLING_ROOT??'/Users/ctk/Projects/Zorid';
  const toolingRequire=createRequire(path.join(toolingRoot,'package.json'));
  vite=await import(pathToFileURL(toolingRequire.resolve('vite')).href);
}
const out=path.resolve(arg('--out')??path.join(here,'artifacts',new Date().toISOString().replaceAll(':','-')));
await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),'zorid-managed-browser-chrome-'));
let server,chrome,cdp,stderr;
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
    server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root]}},
    plugins:[{name:'host-fixture-registry',enforce:'pre',async load(id){if(id.endsWith('/src/platform/browser-managed-records-registry.ts'))return await readFile(path.join(here,'registry.mjs'),'utf8');}}, {name:'managed-fixture-provenance',configureServer(server){server.middlewares.use((req,res,next)=>{const url=new URL(req.url,'http://fixture');const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};if(url.pathname==='/__host_relay'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{relayItems=JSON.parse(body);send({ok:true});});return;}if(url.pathname==='/v1/hello'){send({realm_id:'host-realm',server_epoch:'host-epoch',transport_versions:[1],envelope_versions:[1],suite:'xchacha20poly1305',max_wire_bytes:1052720,max_page_bytes:2105440,max_page_items:64,extensions:{}});return;}if(url.pathname==='/v1/vaults/host-vault/updates'){const cursor=JSON.parse(url.searchParams.get('cursor'));const through=url.searchParams.get('through')??String(relayItems.length);const items=relayItems.filter(item=>BigInt(item.sequence)>BigInt(cursor.after)&&BigInt(item.sequence)<=BigInt(through));send({items,next:{server_epoch:'host-epoch',after:items.at(-1)?.sequence??cursor.after},through,complete:true,extensions:{}});return;}next();});server.middlewares.use('/__managed_fixture_provenance',(_req,res)=>{
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(provenance));
    });}}]});
  await server.listen();const address=server.httpServer.address();
  if(!address||typeof address==='string')throw new Error('No owned Vite port');
  const url=`http://127.0.0.1:${address.port}/tests/browser-managed-records-worker/`;
  const chromeBinary=process.env.CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  stderr='';chrome=spawn(chromeBinary,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
    '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
  let spawnError;chrome.on('error',error=>{spawnError=error;});chrome.stderr.on('data',chunk=>{if(stderr.length<128000)stderr+=chunk;});
  const debugPort=await until(async()=>{if(spawnError)throw spawnError;if(chromeDone())throw new Error('Owned Chrome exited before CDP: '+chrome.exitCode);
    const lines=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');assertPort(lines[0]);return lines[0];});
  const target=await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  await cdp.call('Page.navigate',{url});
  const deadline=Date.now()+Number(arg('--timeout-ms')??120000);
  while(Date.now()<deadline){
    const result=await cdp.call('Runtime.evaluate',{expression:'JSON.stringify({done:window.managedRecordsComplete===true,evidence:window.managedRecordsEvidence})',returnByValue:true});
    if(result.exceptionDetails)throw new Error('Page evidence evaluation threw');
    const state=JSON.parse(result.result.value??'{}');evidence=state.evidence;
    if(state.done)break;
    await delay(250);
  }
  if(!evidence?.finished)throw new Error('Fixture deadline expired');
  if(evidence.status!=='passed-subset')throw new Error('Browser fixture failed: '+JSON.stringify(evidence.error));
  // Recompute all source/artifact witnesses AFTER execution as well as before it.
  if(head()!==expectedHead||JSON.stringify(await artifactProof())!==JSON.stringify(provenance))throw new Error('Sources/artifacts changed during execution; evidence rejected');
  console.log(`PASS subset: ${evidence.groups.length} groups; ${evidence.remainingGates.length} explicitly deferred gates; ${out}`);
} catch(error){failure=error;console.error(String(error.stack??error));}
finally {
  await writeFile(path.join(out,'report.json'),JSON.stringify({provenance,evidence:evidence??null,runnerError:failure?String(failure.stack??failure):null},null,2)+'\n');
  if(cdp)await writeFile(path.join(out,'cdp-events.json'),JSON.stringify(cdp.events,null,2)+'\n');
  // Only the child process/profile created here are owned. Never kill by process name or port.
  cdp?.close();
  if(chrome&&!chromeDone()){chrome.kill('SIGTERM');await Promise.race([new Promise(resolve=>chrome.once('exit',resolve)),delay(4000)]);
    if(!chromeDone()){chrome.kill('SIGKILL');await Promise.race([new Promise(resolve=>chrome.once('exit',resolve)),delay(4000)]);}}
  if(stderr)await writeFile(path.join(out,'chrome-stderr.log'),stderr);
  await server?.close();
  if(chromeDone())await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  else {console.error('Owned Chrome did not confirm exit; profile retained: '+profile);failure??=new Error('Chrome cleanup unverified');}
}
if(failure)process.exitCode=1;
function assertPort(value){if(!/^[1-9][0-9]{0,4}$/.test(value)||Number(value)>65535)throw new Error('Invalid owned CDP port');}
