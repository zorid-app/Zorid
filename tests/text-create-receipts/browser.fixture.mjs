import {BrowserCoreRuntime} from '../../src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '../../src/platform/browser-client-admission.ts';
import {defaultBrowserAdapter} from '../../src/platform/browser-default.ts';
import {Vault} from '../../src/core/vault.ts';
import {decodeTextCreateReceipt} from '../../src/core/text-create.ts';

const report={status:'running',scenarios:[],cleanup:[]};window.createReceiptEvidence=report;
const database='zorid-core-vault:create-receipts-'+crypto.randomUUID(),clientId=crypto.randomUUID();
let runtime,consumer,vault;
const assert=(value,message)=>{if(!value)throw Error(message);};
const equal=(left,right,message)=>assert(JSON.stringify(left)===JSON.stringify(right),message);
async function rejects(action,code){try{await action();}catch(error){assert(error.code===code,`Expected ${code}, got ${error.code}: ${error.message}`);return;}throw Error(`Expected ${code}`);}
async function start(){runtime=await BrowserCoreRuntime.open({database,clientId,wasmModuleUrl:'/__receipt_wasm/zorid_wasm.js',allowNewVault:true,initializeLocal:true});consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()});}
async function close(){if(consumer)await consumer.release(()=>{});runtime?.close();consumer=undefined;runtime=undefined;}
const intents=async()=>JSON.stringify((await runtime.intents()).map(row=>({id:row.operation_id,status:row.status,receipt:row.receipt})));
try{
  await start();assert(typeof consumer.createTextReceipt==='function','Admitted receipt capability missing');
  let lose=false,failPublication=false;const calls=[];
  const forwarded=Object.create(consumer);
  Object.defineProperty(forwarded,'createTextReceipt',{value:async request=>{
    calls.push(structuredClone(request));const receipt=await consumer.createTextReceipt(request);
    if(lose){lose=false;throw Object.assign(Error('injected lost receipt'),{code:'outcome_unknown'});}return receipt;
  }});
  const adapter=defaultBrowserAdapter(runtime,forwarded),list=adapter.list.bind(adapter);
  adapter.list=async()=>{if(failPublication){failPublication=false;throw Error('injected publication failure');}return list();};
  vault=new Vault(adapter);await vault.initialize();
  const content='\uFEFF---\r\nstatus: Template\r\n---\r\n# {{title}}\r\nLiteral 😀\r\n';
  lose=true;const first=vault.createOperation('First.md',content);
  await rejects(()=>first.run(),'outcome_unknown');const original=await runtime.readMetadata('First.md'),before=await intents();
  const created=await first.run();assert(created.entryId===original.entry.id&&created.revision===original.entry.revision,'Retry did not retain original identity');
  assert(await adapter.read('First.md')===content,'Literal content changed');equal(calls[0],calls[1],'Retry changed original request');assert(await intents()===before,'Retry created another intent');
  report.scenarios.push({name:'lost reply resumes original committed creation',entryId:created.entryId,revision:created.revision});

  lose=true;const second=vault.createOperation('Replaced.md','original');await rejects(()=>second.run(),'outcome_unknown');
  const previous=await runtime.readMetadata('Replaced.md');
  await consumer.fileCommand({kind:'delete',path:'Replaced.md',force:true,operationId:crypto.randomUUID(),entryId:crypto.randomUUID()});
  await consumer.fileCommand({kind:'createText',path:'Replaced.md',content:'replacement',operationId:crypto.randomUUID(),entryId:crypto.randomUUID()});
  const replacement=await runtime.readMetadata('Replaced.md'),replacedBefore=await intents();
  await rejects(()=>second.run(),'created_file_changed');
  assert(replacement.entry.id!==previous.entry.id,'Replacement identity was not distinct');assert(await adapter.read('Replaced.md')==='replacement','Replacement overwritten');assert(await intents()===replacedBefore,'Original replay created another mutation');equal(calls[2],calls[3],'Replacement retry changed original request');
  report.scenarios.push({name:'original receipt cannot adopt a replacement at the same path',originalEntryId:previous.entry.id,replacementEntryId:replacement.entry.id});

  const capture=adapter.captureTextCreate.bind(adapter);
  adapter.captureTextCreate=(path,text)=>{const handle=capture(path,text);let failOnce=true;return{...handle,async run(){const receipt=await handle.run();if(failOnce){failOnce=false;failPublication=true;}return receipt;}};};
  const third=vault.createOperation('Advanced.md','initial');
  try{await third.run();throw Error('Expected publication failure');}catch(error){assert(error.message.includes('publication failure'),'Unexpected publication failure: '+error);}
  const advancedOriginal=await runtime.readMetadata('Advanced.md');
  await consumer.fileCommand({kind:'writeText',path:'Advanced.md',content:'later edit',expectedEntryId:advancedOriginal.entry.id,expectedRevision:advancedOriginal.entry.revision,operationId:crypto.randomUUID(),entryId:crypto.randomUUID()});
  await rejects(()=>third.run(),'created_file_changed');assert(await adapter.read('Advanced.md')==='later edit','Advanced revision overwritten');
  report.scenarios.push({name:'acknowledged publication retry preserves advanced original revision',entryId:advancedOriginal.entry.id});

  const originalRequest=calls[0];await vault.closeMetadataProjection();vault=undefined;await close();await start();
  const receipt=decodeTextCreateReceipt(await consumer.createTextReceipt(originalRequest),originalRequest);
  assert(receipt.entryId===created.entryId&&receipt.revision===created.revision,'Restart substituted current data for original receipt');
  report.scenarios.push({name:'new worker admission returns the same persisted original receipt',entryId:receipt.entryId,revision:receipt.revision});
  report.status='passed';
}catch(error){report.status='failed';report.error={message:String(error.stack??error),code:error.code};}
finally{
  try{await vault?.closeMetadataProjection();}catch(error){report.status='failed';report.cleanup.push({error:String(error)});}
  try{await close();report.cleanup.push({consumerReleased:true,workerClosed:true});}catch(error){report.status='failed';report.cleanup.push({error:String(error)});}
  try{await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(database);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Owned database remains open'));});report.cleanup.push({database,deleted:true});}catch(error){report.status='failed';report.cleanup.push({error:String(error)});}
  report.finished=true;window.createReceiptComplete=true;document.querySelector('#result').textContent=JSON.stringify(report,null,2);
}
