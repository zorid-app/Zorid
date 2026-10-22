import {createHash} from 'node:crypto';
import {observeOwnedChild,cleanupOwnedResources} from '../browser-workblocks-worker/cleanup.mjs';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {groupNames} from './cases.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
if(!process.argv.includes('--runtime-authorized'))throw new Error('SOURCE ONLY: coordinator must authorize this concrete runtime turn before --runtime-authorized');
const campaignTimeout=Number(arg('--timeout-ms')??180000);
if(!Number.isInteger(campaignTimeout)||campaignTimeout<1000||campaignTimeout>300000)throw new Error('Runtime deadline must be 1000..300000 milliseconds');
const expectedHead=arg('--expect-head');
if(!expectedHead||!/^[a-f0-9]{40}$/.test(expectedHead))throw new Error('Pass --expect-head <full frozen integration commit>; this runner never builds WASM');
const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(head()!==expectedHead)throw new Error('Integration HEAD differs from explicit source freeze');
const generated=path.resolve(arg('--wasm-dir')??path.join(root,'target/browser-wasm/generated'));
const toolingRoot=process.env.ZORID_TOOLING_ROOT??'/Users/ctk/Projects/Zorid';
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
  await walk('src');await walk('tests/bases-browser-integration');
  files.push('tests/fixtures/bases-q3-semantics.mjs','tests/browser-workblocks-worker/cleanup.mjs','desktop/workblocks.cjs','desktop/document-semantics.cjs','vite.config.mjs','package.json','pnpm-lock.yaml');
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
  for(const binding of ['baseJson','propertyTargetsJson','WasmDocumentIndexBuilder'])if(!glue.includes(binding))throw new Error('Current generated bindings missing '+binding);
  return {head:expectedHead,fingerprint:metadata.fingerprint,files,sourceDigest:await sourceDigest()};
}
const provenance=await artifactProof();
let vite;
try {vite=await import('vite');} catch {
  // Existing main checkout tooling; no package install or lockfile mutation.
  const toolingRequire=createRequire(path.join(toolingRoot,'package.json'));
  vite=await import(pathToFileURL(toolingRequire.resolve('vite')).href);
}
const out=path.resolve(arg('--out')??path.join(here,'artifacts',new Date().toISOString().replaceAll(':','-')));
await mkdir(out,{recursive:true});
const assetBytes=new Map(await Promise.all(['zorid_wasm.js','zorid_wasm_bg.wasm'].map(async name=>[name,await readFile(path.join(generated,name))])));
const profile=await mkdtemp(path.join(tmpdir(),'zorid-bases-browser-chrome-'));
let server,chrome,cdp,stderr,childReceipt;
const servedAssets=[],workerRequests=[];
const viteRoot=path.resolve(toolingRoot);
const chromeDone=()=>!chrome||chrome.exitCode!==null||chrome.signalCode!==null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action, timeout=15000){const end=Date.now()+timeout;let last;do{try{return await action();}catch(error){last=error;}await delay(100);}while(Date.now()<end);throw last??new Error('Deadline');}
class CDP {
  constructor(url){this.ws=new WebSocket(url);this.next=0;this.pending=new Map();this.events=[];this.workerTargets=[];this.droppedEvents=0;
    this.opened=new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});
    this.ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const waiting=this.pending.get(value.id);if(!waiting)return;this.pending.delete(value.id);clearTimeout(waiting.timer);value.error?waiting.reject(new Error(JSON.stringify(value.error))):waiting.resolve(value.result);}else {const target=value.params?.targetInfo;if(target?.type==='worker'&&this.workerTargets.length<100)this.workerTargets.push({method:value.method,...target});if(this.events.length<8000)this.events.push(value);else this.droppedEvents++;}});
    this.ws.addEventListener('close',()=>{for(const waiting of this.pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('CDP socket closed'));}this.pending.clear();});
  }
  async call(method,params={}){await this.opened;const id=++this.next;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));
  });}
  close(){this.ws.close();}
}
let evidence, failure;
try {
  server=await vite.createServer({root,configFile:false,envFile:false,clearScreen:false,logLevel:'error',cacheDir:path.join(profile,'vite-cache'),
    // Same two dev CJS boundaries as the normal app. No source substitution,
    // private semantic route, registry injection or replacement Worker.
    resolve:{alias:[
      {find:'../../desktop/workblocks.cjs',replacement:'zorid-local/workblocks.cjs'},
      {find:'../../desktop/document-semantics.cjs',replacement:'zorid-local/document-semantics.cjs'},
      {find:'zorid-local/workblocks.cjs',replacement:path.join(root,'desktop/workblocks.cjs')},
      {find:'zorid-local/document-semantics.cjs',replacement:path.join(root,'desktop/document-semantics.cjs')},
    ]},
    optimizeDeps:{include:['zorid-local/workblocks.cjs','zorid-local/document-semantics.cjs'],entries:['tests/bases-browser-integration/index.html']},
    plugins:[{name:'exact-existing-wasm-assets',configureServer(server){server.middlewares.use((request,response,next)=>{
      const prefix='/target/browser-wasm/generated/';let pathname;try{pathname=new URL(request.url,'http://fixture').pathname;}catch{return next();}
      // A dedicated-worker CDP target can be announced before its URL is known.
      // Preserve the actual normal Vite Worker URL and completed HTTP response
      // without intercepting, substituting or invoking its implementation.
      if(pathname==='/src/platform/browser-core-worker.ts'){
        const receipt={url:request.url,method:request.method,requestedAt:new Date().toISOString()};workerRequests.push(receipt);
        response.once('finish',()=>{receipt.statusCode=response.statusCode;receipt.finishedAt=new Date().toISOString();});
      }
      const name=pathname.startsWith(prefix)?pathname.slice(prefix.length):'',data=assetBytes.get(name);if(!data)return next();
      if(!['GET','HEAD'].includes(request.method)){response.statusCode=405;return response.end();}
      servedAssets.push({name,sha256:sha(data),method:request.method,at:new Date().toISOString()});
      response.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':'text/javascript');response.setHeader('Cache-Control','no-store');response.end(request.method==='HEAD'?undefined:data);
    });}}],
    server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,viteRoot]}}});
  await server.listen();const address=server.httpServer.address();
  if(!address||typeof address==='string')throw new Error('No owned Vite port');
  const url=`http://127.0.0.1:${address.port}/tests/bases-browser-integration/`;
  const chromeBinary=process.env.CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  stderr='';chrome=spawn(chromeBinary,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
    '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
  childReceipt=observeOwnedChild(chrome);
  let spawnError;chrome.on('error',error=>{spawnError=error;});chrome.stderr.on('data',chunk=>{if(stderr.length<128000)stderr+=chunk;});
  const debugPort=await until(async()=>{if(spawnError)throw spawnError;if(chromeDone())throw new Error('Owned Chrome exited before CDP: '+chrome.exitCode);
    const lines=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');assertPort(lines[0]);return lines[0];});
  const target=await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Page.enable');await cdp.call('Target.setDiscoverTargets',{discover:true});
  const browserVersion=await cdp.call('Browser.getVersion');
  await writeFile(path.join(out,'browser.json'),JSON.stringify(browserVersion,null,2)+'\n');
  await cdp.call('Page.navigate',{url});
  const deadline=Date.now()+campaignTimeout;
  while(Date.now()<deadline){
    const result=await cdp.call('Runtime.evaluate',{expression:'JSON.stringify({done:window.basesBrowserComplete===true,evidence:window.basesBrowserEvidence})',returnByValue:true});
    if(result.exceptionDetails)throw new Error('Page evidence evaluation threw');
    const state=JSON.parse(result.result.value??'{}');evidence=state.evidence;
    if(state.done)break;
    await delay(250);
  }
  if(!evidence?.finished)throw new Error('Fixture deadline expired');
  if(evidence.status!=='passed')throw new Error('Browser fixture failed: '+JSON.stringify(evidence.error));
  if(JSON.stringify(evidence.plannedGroups)!==JSON.stringify(groupNames)||JSON.stringify(evidence.groups.map(group=>group.name))!==JSON.stringify(groupNames)||evidence.groups.some(group=>group.status!=='passed')||evidence.unexecutedGroups.length)throw new Error('Incomplete actual browser case execution');
  if(!cdp.workerTargets.length||!workerRequests.some(request=>request.method==='GET'&&request.statusCode===200))throw new Error('Product browser-core-worker target and completed script GET not observed');
  for(const name of ['zorid_wasm.js','zorid_wasm_bg.wasm'])if(!servedAssets.some(asset=>asset.name===name&&asset.method==='GET'))throw new Error('Browser did not fetch exact WASM asset: '+name);
  const screenshot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(out,'fixture-result.png'),Buffer.from(screenshot.data,'base64'));
  // Recompute all source/artifact witnesses AFTER execution as well as before it.
  if(head()!==expectedHead||JSON.stringify(await artifactProof())!==JSON.stringify(provenance))throw new Error('Sources/artifacts changed during execution; evidence rejected');
} catch(error){
  failure=error;console.error(String(error.stack??error));
  if(cdp){try{const screenshot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(out,'fixture-failure.png'),Buffer.from(screenshot.data,'base64'));}
    catch(captureError){console.error('Failure screenshot unavailable: '+String(captureError.stack??captureError));}}
}
finally {
  const cleanup=await cleanupOwnedResources({chrome,childReceipt,profile,server,cdp});
  const artifactFailures=[];
  for(const [name,value] of [['cdp-events.json',cdp?JSON.stringify(cdp.events,null,2)+'\n':null],['chrome-stderr.log',stderr??null],['cleanup.json',JSON.stringify(cleanup,null,2)+'\n']]){
    if(value===null)continue;
    try{await writeFile(path.join(out,name),value);}catch(error){artifactFailures.push({file:name,message:String(error.stack??error)});}
  }
  if(cleanup.failures.length||artifactFailures.length)failure??=new Error('Owned cleanup/evidence failure: '+JSON.stringify({cleanup:cleanup.failures,artifactFailures}));
  await writeFile(path.join(out,'report.json'),JSON.stringify({provenance,evidence:evidence??null,servedAssets,workerRequests,workerTargets:cdp?.workerTargets??[],cdpDroppedEvents:cdp?.droppedEvents??0,cleanup,artifactFailures,runnerError:failure?String(failure.stack??failure):null},null,2)+'\n');
}
if(failure)process.exitCode=1;
else console.log(`PASS browser Bases: ${evidence.groups.length} groups; ${evidence.remainingGates.length} explicitly deferred gates; ${out}`);
function assertPort(value){if(!/^[1-9][0-9]{0,4}$/.test(value)||Number(value)>65535)throw new Error('Invalid owned CDP port');}
