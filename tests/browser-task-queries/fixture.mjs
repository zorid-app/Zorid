import {BrowserCoreRuntime} from '../../src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '../../src/platform/browser-client-admission.ts';
import {defaultBrowserAdapter} from '../../src/platform/browser-default.ts';
import {catchUpDocumentIndex} from '../../src/core/document-semantics.ts';

// Actual normal adapter + admitted consumer + unchanged product Worker + generated
// Rust/WASM + IndexedDB. Synthetic files are authored only through the adapter.
const report={status:'running',groups:[],cleanup:[],remainingGates:['No rendered Tasks UI, Calendar, mobile or multi-browser acceptance']};
window.taskQueriesEvidence=report;
const names=new Set(),hosts=new Set();
function assert(value,message){if(!value)throw new Error(message);}
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
function equal(a,b,message){assert(JSON.stringify(canonical(a))===JSON.stringify(canonical(b)),message+': '+JSON.stringify({actual:a,expected:b}));}
async function rejects(action,code){try{await action();}catch(error){assert(error.code===code,`Expected ${code}; observed ${error.code}: ${error}`);return code;}throw new Error('Expected rejection: '+code);}
async function group(name,run){const evidence=await run();report.groups.push({name,status:'passed',evidence});}
async function start(name='zorid-core-vault:task-queries-'+crypto.randomUUID(),clientId=crypto.randomUUID()){
  names.add(name);const runtime=await BrowserCoreRuntime.open({database:name,clientId,wasmModuleUrl:'/target/browser-wasm/generated/zorid_wasm.js',allowNewVault:true,initializeLocal:true});
  const consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()}),adapter=defaultBrowserAdapter(runtime,consumer);
  const host={name,clientId,runtime,consumer,adapter,service:adapter.documentSemantics};hosts.add(host);assert(host.service,'Normal document capability missing');return host;
}
async function close(host){try{await host.consumer.release(()=>{});}finally{host.runtime.close();hosts.delete(host);}}
async function build(host){await catchUpDocumentIndex(host.service,{isCurrent:()=>true,maxPumps:100});}
async function metadata(host,path){const value=await host.runtime.readMetadata(path);assert(value?.entry,'Missing fixture file '+path);return value.entry;}
try{
  let h=await start();
  const yaml=await fetch('/tests/fixtures/tasks/task-type.json').then(r=>{assert(r.ok,'Type fixture missing');return r.text();});
  await h.adapter.createText('Task.yaml',yaml);
  await h.adapter.createText('Task.md','---\ntype: type-task\nstate: active\nplan: 2026-10-18\n---\nTask body\n');
  await h.adapter.createText('Checkbox.md','- [ ] Separate checkbox\n');
  const definition=await metadata(h,'Task.yaml'),task=await metadata(h,'Task.md');
  await build(h);const old=await h.service.open();assert(typeof old.tasks==='function','Normal Tasks capability absent');
  const request={typeIds:[definition.id],options:{clockMs:1792324800000,timezone:'America/Toronto'}};
  const initial=await old.tasks(request);
  await group('same retained generation, exact Type/task witnesses and separate checkboxes',async()=>{
    equal(initial.snapshot,old.snapshot,'Outer snapshot mismatch');equal(initial.value.result.snapshotId,old.snapshot,'Inner snapshot mismatch');
    equal(initial.value.definitions,[definition],'Actual retained definition mismatch');
    equal(initial.value.result.typeWitnesses,[{entryId:definition.id,revision:definition.revision}],'Type witness mismatch');
    equal(initial.value.result.rows.map(r=>r.witness),[{entryId:task.id,revision:task.revision}],'Task witness mismatch');
    assert(initial.value.types[0].status.key==='state','Native task property mapping missing');assert(initial.value.result.rows[0].statusId==='active','Native task status mapping missing');
    return initial;
  });
  await group('date-only Today follows explicit clockMs and timezone',async()=>{
    const options={filter:'today',clockMs:1792290600000,timezone:'America/Toronto'};
    const local=await old.tasks({typeIds:[definition.id],options}),utc=await old.tasks({typeIds:[definition.id],options:{...options,timezone:'UTC'}});
    assert(local.value.result.rows.length===0,'UTC date incorrectly shifted Toronto Today');
    assert(utc.value.result.rows.length===1&&utc.value.result.rows[0].plannedDay==='2026-10-18','Date-only Today lost its literal day');return {local,utc};
  });
  await h.adapter.write('Task.yaml',yaml.replace('"label": "Task"','"label": "Assignment"'));
  await h.adapter.rename('Task.yaml','Renamed.yaml');
  await h.adapter.write('Task.md','---\ntype: type-task\nstate: done\nplan: 2026-10-18\n---\nChanged body\n');
  await build(h);const current=await h.service.open();
  await group('retained Type/note reads survive edits and Type moves',async()=>{
    equal(await old.tasks(request),initial,'Old pin substituted current Type or note');
    const hidden=await current.tasks(request),visible=await current.tasks({...request,options:{...request.options,showDone:true}});
    assert(hidden.value.result.rows.length===0,'Done task not hidden');assert(visible.value.result.rows[0].statusId==='done','Current done state missing');
    assert(visible.value.definitions[0].path==='Renamed.yaml'&&visible.value.types[0].label==='Assignment','New Type source not selected');
    assert(visible.value.definitions[0].revision!==definition.revision,'New Type revision missing');return {hidden,visible};
  });
  await h.adapter.createText('Invalid.yaml','properties: [\n');await build(h);const invalidDefinition=await metadata(h,'Invalid.yaml'),diagnosticPin=await h.service.open();
  await group('malformed YAML diagnostics and strict selector/option rejection',async()=>{
    const value=await diagnosticPin.tasks({typeIds:[invalidDefinition.id],options:{clockMs:0}});
    assert(value.value.types.length===0&&value.value.result.rows.length===0&&!value.value.result.coverageComplete,'Malformed Type invented tasks');
    equal(value.value.result.typeDiagnostics[0].witness,{entryId:invalidDefinition.id,revision:invalidDefinition.revision},'Diagnostic witness mismatch');
    assert(value.value.result.typeDiagnostics[0].code==='invalid_type_yaml','YAML diagnostic missing');
    const rejected=[];rejected.push(await rejects(()=>old.tasks({typeIds:[definition.id,definition.id]}),'invalid_request'));
    rejected.push(await rejects(()=>old.tasks({typeIds:[definition.id],options:{clockMs:null}}),'invalid_request'));
    rejected.push(await rejects(()=>old.tasks({typeIds:['missing']}),'index_missing_source'));
    return {value,rejected};
  });
  await diagnosticPin.close();await current.close();
  await h.adapter.remove('Renamed.yaml',false);await build(h);
  equal(await old.tasks(request),initial,'Deleted current Type erased retained source');
  await group('foreign client pins, close, rebuild and reopening enforce lifetimes',async()=>{
    const other=await start(h.name);try{await rejects(()=>other.consumer.documentIndex.tasks({pinId:old.pinId,typeIds:[definition.id]}),'index_snapshot_expired');}finally{await close(other);}
    const expired=await h.service.open();await expired.close();await rejects(()=>expired.tasks({typeIds:[]}),'snapshot_expired');
    await h.service.rebuild();await rejects(()=>old.tasks(request),'index_snapshot_expired');await build(h);
    const name=h.name,clientId=h.clientId;await close(h);h=await start(name,clientId);const reopened=await h.service.open();
    await rejects(()=>reopened.tasks(request),'index_missing_source');const invalid=await reopened.tasks({typeIds:[invalidDefinition.id],options:{clockMs:0}});
    assert(invalid.value.result.typeDiagnostics[0].code==='invalid_type_yaml','Reopen lost retained malformed YAML');
    await reopened.close();return {reopened:invalid.snapshot,diagnostics:invalid.value.result.typeDiagnostics};
  });
  report.status='passed';
}catch(error){report.status='failed';report.error={message:String(error.stack??error),code:error.code};}
finally{
  for(const host of [...hosts])try{await close(host);}catch(error){report.status='failed';report.cleanup.push({resource:'host',error:String(error)});}
  for(const name of names)try{await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Owned database still open'));});report.cleanup.push({database:name,deleted:true});}catch(error){report.status='failed';report.cleanup.push({database:name,error:String(error)});}
  report.finished=true;window.taskQueriesComplete=true;document.querySelector('#result').textContent=JSON.stringify(report,null,2);
}
