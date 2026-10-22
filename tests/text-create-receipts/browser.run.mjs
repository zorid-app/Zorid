import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {observeOwnedChild,cleanupOwnedResources} from '../browser-workblocks-worker/cleanup.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const arg=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
if(!process.argv.includes('--runtime-authorized'))throw Error('The coordinator must authorize this actual browser run');
const wasm=arg('--wasm-dir');if(!wasm||!path.isAbsolute(wasm))throw Error('Pass the existing coordinated --wasm-dir; this runner never builds');
const out=path.resolve(arg('--out')??'/private/tmp/zorid-create-receipts-browser');await mkdir(out,{recursive:true});
const sources=['src/core/types.ts','src/core/text-create.ts','src/core/vault.ts','src/core/browser-vault.ts','src/platform/browser-default.ts','src/platform/browser-file-commands.ts','src/platform/browser-client-admission.ts','src/platform/browser-core.ts','src/platform/browser-core-runtime.ts','src/platform/browser-core-worker.ts','src/platform/browser-durable-writes.ts','tests/text-create-receipts/browser.fixture.mjs','tests/text-create-receipts/browser.run.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
async function proof(){const source={};for(const file of sources)source[file]=sha(await readFile(path.join(root,file)));const artifacts={};for(const file of ['zorid_wasm.js','zorid_wasm_bg.wasm'])artifacts[file]=sha(await readFile(path.join(wasm,file)));return{source,artifacts,wasmDirectory:wasm};}
const before=await proof(),assets=new Map();for(const file of ['zorid_wasm.js','zorid_wasm_bg.wasm'])assets.set('/__receipt_wasm/'+file,await readFile(path.join(wasm,file)));
const require=createRequire(import.meta.url),{createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const profile=await mkdtemp(path.join(tmpdir(),'zorid-create-receipts-chrome-'));
let server,chrome,childReceipt,cdp,stderr='',evidence,failure;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class CDP{
  constructor(url){this.ws=new WebSocket(url);this.next=0;this.pending=new Map();this.open=new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});this.ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(!value.id)return;const waiting=this.pending.get(value.id);if(!waiting)return;this.pending.delete(value.id);clearTimeout(waiting.timer);value.error?waiting.reject(Error(JSON.stringify(value.error))):waiting.resolve(value.result);});this.ws.addEventListener('close',()=>{for(const waiting of this.pending.values()){clearTimeout(waiting.timer);waiting.reject(Error('CDP closed'));}this.pending.clear();});}
  async call(method,params={}){await this.open;const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
  close(){this.ws.close();}
}
try{
  server=await createServer({root,configFile:false,envFile:false,clearScreen:false,logLevel:'error',
    resolve:{alias:[{find:'../../desktop/workblocks.cjs',replacement:'zorid-local/workblocks.cjs'},{find:'../../desktop/document-semantics.cjs',replacement:'zorid-local/document-semantics.cjs'},{find:'zorid-local/workblocks.cjs',replacement:path.join(root,'desktop/workblocks.cjs')},{find:'zorid-local/document-semantics.cjs',replacement:path.join(root,'desktop/document-semantics.cjs')}]},
    optimizeDeps:{include:['zorid-local/workblocks.cjs','zorid-local/document-semantics.cjs']},
    plugins:[{name:'receipt-existing-wasm',configureServer(instance){instance.middlewares.use((request,response,next)=>{const bytes=assets.get(new URL(request.url,'http://localhost').pathname);if(!bytes)return next();response.setHeader('Content-Type',request.url.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(bytes);});}}],
    server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root]}}});
  await server.listen();const port=server.httpServer.address().port;
  chrome=spawn(process.env.CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
  childReceipt=observeOwnedChild(chrome);chrome.stderr.on('data',bytes=>{if(stderr.length<64000)stderr+=bytes;});let spawnError;chrome.on('error',error=>{spawnError=error;});
  let debugPort;const startup=Date.now()+15000;while(Date.now()<startup){if(spawnError)throw spawnError;try{debugPort=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n')[0];if(/^[1-9][0-9]{0,4}$/.test(debugPort))break;}catch{}await delay(100);}if(!debugPort)throw Error('Owned Chrome did not start');
  const target=await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'}).then(response=>response.json());cdp=new CDP(target.webSocketDebuggerUrl);
  await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Page.navigate',{url:`http://127.0.0.1:${port}/tests/text-create-receipts/browser.html`});
  const deadline=Date.now()+90000;while(Date.now()<deadline){const value=await cdp.call('Runtime.evaluate',{expression:'JSON.stringify({done:window.createReceiptComplete===true,evidence:window.createReceiptEvidence})',returnByValue:true});const state=JSON.parse(value.result.value??'{}');evidence=state.evidence;if(state.done)break;await delay(250);}
  if(!evidence?.finished||evidence.status!=='passed')throw Error('Receipt browser proof failed: '+JSON.stringify(evidence));
  if(JSON.stringify(await proof())!==JSON.stringify(before))throw Error('Source or existing WASM changed during execution');
}catch(error){failure=String(error.stack??error);console.error(failure);}
finally{
  const cleanup=await cleanupOwnedResources({chrome,childReceipt,profile,server,cdp});if(cleanup.failures.length)failure??=JSON.stringify(cleanup.failures);
  await writeFile(path.join(out,'report.json'),JSON.stringify({provenance:before,evidence,cleanup,error:failure??null},null,2)+'\n');
  await writeFile(path.join(out,'chrome-stderr.log'),stderr);
}
if(failure)process.exitCode=1;else console.log(`PASS ${evidence.scenarios.length} actual browser/WASM receipt scenarios; ${out}`);
