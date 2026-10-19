import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {startOwnedMeasuredProcess} from './process-resources.mjs';
import {mkdir,open,readFile,writeFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {sha256,json} from './workload.mjs';

const CORPORA=Object.freeze([
  {family:'detached',name:'accepted-queries.json',cases:10,sha256:'a598934dde189f9752d4227754edba8aeb10d75c965127efa2acb863f95d0b90'},
  {family:'generation',name:'accepted-generation-queries.json',cases:7,sha256:'be1f1ecfcf17fc648417201d5884d2a9c99d8fe26feee140a8e76358cfea5e62'},
]);
const uint=(value,max=Number.MAX_SAFE_INTEGER)=>assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=max,'bounded integer required');
const finite=value=>assert.ok(Number.isFinite(value)&&value>=0,'nonnegative finite timing required');
export async function loadCorpora(){return Promise.all(CORPORA.map(async spec=>{
  const url=new URL(`../../tests/fixtures/document-semantics/bases/${spec.name}`,import.meta.url),bytes=await readFile(url);assert.ok(bytes.length<=2*1024*1024);assert.equal(sha256(bytes),spec.sha256,'review changed oracle bytes, never regenerate from evaluator');
  const corpus=JSON.parse(bytes.toString('utf8'));assert.equal(corpus.schemaVersion,1);assert.equal(corpus.cases.length,spec.cases);assert.equal(new Set(corpus.cases.map(c=>c.id)).size,spec.cases);
  return {...spec,url:url.href,bytes,corpus};
}));}
function compactErrors(value){
  if(Array.isArray(value))return value.map(compactErrors);
  if(value&&typeof value==='object')return value.type==='error'?{type:'error',code:value.code}:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compactErrors(v)]));
  return value;
}
function subset(actual,expected){
  if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>subset(actual[i],v));
  if(expected&&typeof expected==='object')return !!actual&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>Object.hasOwn(actual,k)&&subset(actual[k],v));
  return actual===expected;
}
function inputWitnesses(item){return item.family==='detached'?item.case.request.snapshot.records.map(r=>({id:r.witness.entryId,revision:r.witness.revision,path:r.path})):item.case.request.entries.filter(e=>e.kind==='file'&&!e.deleted);}
function expectedSnapshot(item){return item.family==='detached'?item.case.request.snapshot.snapshotId:item.case.request.snapshotId;}
export function validateResult(item,result){
  assert.deepEqual(result.snapshotId,expectedSnapshot(item),'query snapshot/version changed');
  const entries=inputWitnesses(item),byPath=new Map(entries.map(e=>[e.path,e])),byId=new Map(entries.map(e=>[e.id,e]));
  assert.ok(Array.isArray(result.rows));const seen=new Set();
  for(const row of result.rows){const entry=byPath.get(row.path);assert.ok(entry,'unknown result path');assert.equal(row.entryId,entry.id);assert.equal(row.revision,entry.revision);assert.equal(seen.has(row.entryId),false,'duplicate result row');seen.add(row.entryId);assert.ok(row.values&&typeof row.values==='object'&&!Array.isArray(row.values));}
  for(const issue of result.metadataIssues){const entry=byId.get(issue.witness.entryId);assert.ok(entry,'unknown metadata issue');assert.equal(issue.witness.revision,entry.revision);}
  assert.equal(typeof result.relationshipsAvailable,'boolean');assert.equal(typeof result.metadataComplete,'boolean');assert.ok(Array.isArray(result.diagnostics));assert.ok(Array.isArray(result.groups));assert.ok(Array.isArray(result.groupOptions));
  const c=result.counts;for(const key of ['scanned','matched','afterGroupOrder','afterSearch','returned'])uint(c[key]);assert.equal(c.scanned,entries.length);assert.equal(c.returned,result.rows.length);assert.ok(c.returned<=c.afterSearch&&c.afterSearch<=c.afterGroupOrder&&c.afterGroupOrder<=c.matched&&c.matched<=c.scanned);
  uint(result.stepsUsed,item.case.request.options.maxSteps??2000000);
  const observables=[];
  for(const [key,expected] of Object.entries(item.case.expected)){
    if(key==='values'){
      for(const [file,cells]of Object.entries(expected)){const row=result.rows.find(r=>r.path===file);assert.ok(row,`missing declared row ${file}`);for(const [column,value]of Object.entries(cells)){assert.ok(Object.hasOwn(row.values,column));assert.deepEqual(compactErrors(row.values[column]),compactErrors(value),`${file} ${column}`);}}
      observables.push('declared typed cells (error codes only)');
    }else if(key==='diagnostics'){
      for(const expectedIssue of expected)assert.ok(result.diagnostics.some(actual=>subset(actual,expectedIssue)),'missing required diagnostic subset');observables.push('required diagnostic subsets');
    }else{
      const actual=key==='paths'?result.rows.map(row=>row.path):result[key];assert.deepEqual(actual,expected,`declared observable ${key}`);observables.push(key);
    }
  }
  return {declaredObservables:observables,scope:'existing declared fixture assertions plus exact returned-row/source witnesses; not independent full-output oracle',rows:result.rows.length,counts:result.counts,stepsUsed:result.stepsUsed,relationshipsAvailable:result.relationshipsAvailable,metadataComplete:result.metadataComplete,metadataIssueCount:result.metadataIssues.length,
    supplementalResultSha256:sha256(JSON.stringify(result)),hashScope:'Node JSON serialization of actual full typed result; supplemental observation, not expected output'};
}
export class BasesValidator{
  constructor(corpora,samples){this.corpora=corpora;this.samples=samples;this.cases=corpora.flatMap(c=>c.corpus.cases.map(caseItem=>({family:c.family,case:caseItem})));this.index=0;this.sample=0;this.prepared=null;this.pending=null;this.done=false;this.setup=null;this.results=[];this.preparations=[];}
  accept(event){
    assert.equal(this.done,false,'output after final acknowledgment');if(event.type==='error')throw Object.assign(Error(`Base core rejected ${event.phase}: ${event.detail}`),{kind:'core-rejection',phase:event.phase,detail:event.detail});
    if(event.type==='setup'){
      assert.equal(this.setup,null);assert.equal(event.detachedCases,10);assert.equal(event.generationCases,7);assert.equal(event.samples,this.samples);assert.equal(typeof event.debugAssertions,'boolean');
      assert.deepEqual(event.files,this.corpora.map(c=>({name:c.name,bytes:c.bytes.length})));for(const key of ['setupMs','readMs','typedDecodeMs'])finite(event[key]);this.setup=event;return;
    }
    assert.ok(this.setup,'setup acknowledgment required');
    if(event.type==='done'){assert.equal(this.pending,null);assert.equal(this.prepared,null);assert.equal(this.index,this.cases.length);assert.equal(event.cases,this.cases.length);assert.equal(event.results,this.results.length);assert.equal(this.results.length,this.cases.length*this.samples);this.done=true;return;}
    const item=this.cases[this.index];assert.ok(item,'extra case');assert.equal(event.family,item.family);assert.equal(event.caseId,item.case.id);
    if(event.type==='prepared'){
      assert.equal(this.prepared,null);assert.equal(this.pending,null);assert.equal(this.sample,0);assert.deepEqual(event.snapshot,expectedSnapshot(item));assert.deepEqual(event.source,item.family==='generation'?item.case.request.source:null);finite(event.configurationCompileMs);
      if(item.family==='generation')finite(event.generationBuildMs);else assert.equal(event.generationBuildMs,null);this.prepared=event;this.preparations.push(event);return;
    }
    assert.ok(this.prepared,'preparation required');assert.equal(event.sample,this.sample);
    if(event.type==='result'){assert.equal(this.pending,null,'measurement acknowledgment required');finite(event.queryMs);this.pending={family:item.family,caseId:item.case.id,sample:this.sample,queryMs:event.queryMs,...validateResult(item,event.result)};return;}
    assert.equal(event.type,'measurement');assert.ok(this.pending,'measurement before result');finite(event.resultOutputMs);this.results.push({...this.pending,resultOutputMs:event.resultOutputMs});this.pending=null;
    if(++this.sample===this.samples){this.sample=0;this.prepared=null;this.index++;}
  }
}
async function executeMeasured(binary,args,validator,log,timeoutMs,sidecarDirectory){
  const owned=await startOwnedMeasuredProcess({binary,args,timeoutMs,sidecarDirectory,measureResources:true});let total=0,line='',stderr='',validationError;
  owned.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+chunk.length>1024*1024){validationError??=Error('stderr bound');owned.stop('stderr-output-limit');}else stderr+=chunk.toString('utf8');});
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try{
    for await(const chunk of owned.stdout){total+=chunk.length;if(total>128*1024*1024)throw Error('stdout bound');await log.write(chunk);line+=decoder.decode(chunk,{stream:true});let split;
      while((split=line.indexOf('\n'))>=0){const raw=line.slice(0,split);line=line.slice(split+1);if(Buffer.byteLength(raw)>16*1024*1024)throw Error('NDJSON event bound');validator.accept(JSON.parse(raw));}
      if(Buffer.byteLength(line)>16*1024*1024)throw Error('NDJSON event bound');
    }
    line+=decoder.decode();assert.equal(line,'','truncated final NDJSON record');
  }catch(error){validationError??=error;owned.stop('protocol-or-output-failure');owned.stdout.resume();}
  const result=await owned.completed;
  return {...result,stdoutBytes:total,stderr,...(validationError?{validationError:{message:String(validationError.message),kind:validationError.kind,phase:validationError.phase,detail:validationError.detail}}:{})};
}
async function execute(binary,args,validator,log,timeoutMs,resourceDirectory){
  if(resourceDirectory)return executeMeasured(binary,args,validator,log,timeoutMs,resourceDirectory);
  const started=performance.now(),child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});let timedOut=false,killTimer,total=0,line='',stderr='',validationError;
  const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1000);};const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  const closed=new Promise(resolve=>{child.once('error',e=>resolve({spawnError:String(e)}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+chunk.length>1024*1024){validationError??=Error('stderr bound');stop();}else stderr+=chunk.toString('utf8');});const decoder=new TextDecoder('utf-8',{fatal:true});
  try{for await(const chunk of child.stdout){total+=chunk.length;if(total>128*1024*1024)throw Error('stdout bound');await log.write(chunk);line+=decoder.decode(chunk,{stream:true});let split;
    while((split=line.indexOf('\n'))>=0){const raw=line.slice(0,split);line=line.slice(split+1);if(Buffer.byteLength(raw)>16*1024*1024)throw Error('event bound');validator.accept(JSON.parse(raw));}if(Buffer.byteLength(line)>16*1024*1024)throw Error('event bound');}
    line+=decoder.decode();assert.equal(line,'','truncated final record');
  }catch(error){validationError??=error;stop();child.stdout.resume();}
  const result=await closed;clearTimeout(timer);clearTimeout(killTimer);return {...result,wallMs:performance.now()-started,timedOut,stdoutBytes:total,stderr,...(validationError?{validationError:{message:validationError.message,kind:validationError.kind,phase:validationError.phase,detail:validationError.detail}}:{})};
}
export async function runBases({out,binary,samples=1,timeoutMs=30000,buildSha='unknown',buildMode='unknown',measureResources=false}){
  assert.equal(typeof measureResources,'boolean');if(measureResources)assert.equal(process.platform,'darwin','--process-resources currently supports Darwin only');
  assert.ok(Number.isSafeInteger(samples)&&samples>=1&&samples<=20);assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=300000);assert.match(buildSha,/^(unknown|[a-f0-9]{40})$/);assert.ok(['debug','release','unknown'].includes(buildMode));
  const setupStart=performance.now(),corpora=await loadCorpora();binary=await realpath(binary);assert.ok((await stat(binary)).isFile());const binaryHash=sha256(await readFile(binary));out=path.resolve(out);
  await mkdir(out,{mode:0o700});const corpusDirectory=path.join(out,'corpus');await mkdir(corpusDirectory,{mode:0o700});for(const c of corpora)await writeFile(path.join(corpusDirectory,c.name),c.bytes,{flag:'wx',mode:0o600});
  const report={schemaVersion:1,status:'running',scope:'17 frozen existing Base semantic cases; declared independent assertions only, not representative performance or full language acceptance',samples,
    binary:{path:binary,sha256:binaryHash,buildSha,buildMode,provenance:'source/build mode caller supplied; measured executable bytes before/after do not infer source correspondence'},wrapperSha256:sha256(await readFile(new URL(import.meta.url))),
    corpora:corpora.map(c=>({name:c.name,sha256:c.sha256,cases:c.cases,sourceURL:c.url})),environment:{node:process.version,os:os.release(),platform:process.platform,arch:process.arch,totalMemory:os.totalmem(),cpus:os.cpus().length},setup:{copyAndWrapperSetupMs:performance.now()-setupStart},preparations:[],results:[],corpusPreserved:false,
    limitations:['small semantic corpus, not10k/100k representative Base workload','selected expected fields/cells and required diagnostic subsets; actual full-result hashes are supplemental','compile_base validates decoded configuration, not YAML parsing or complete formula AST compilation','query_generation includes generation-to-Base/relationship preparation; query_base still prepares relationships/property discovery; no internal phase counters','program reused within each case; existing process-global AST/regex caches may warm across cases/samples; not cold/restart/cache-speedup proof','no native storage, browser, renderer, peak RSS/CPU, cancellation, incremental or foreground measurements']};
  if(measureResources)report.limitations[5]='no native storage, browser, renderer, cancellation, incremental or foreground measurements; optional process resources describe each utility lifetime only';
  const validator=new BasesValidator(corpora,samples),log=await open(path.join(out,'bases.stdout.ndjson'),'wx',0o600);
  try{
    report.process=await execute(binary,['--corpus-dir',corpusDirectory,'--samples',String(samples)],validator,log,timeoutMs,measureResources?out:undefined);report.setup.core=validator.setup;report.preparations=validator.preparations;report.results=validator.results;
    if(measureResources){report.processResources={requested:true,helperSha256:sha256(await readFile(new URL('./process-resources.mjs',import.meta.url))),scope:'one instrumented utility lifetime, not engine phases or aggregate process tree'};}
    for(const c of corpora)assert.equal(sha256(await readFile(path.join(corpusDirectory,c.name))),c.sha256,'captured corpus changed');report.corpusPreserved=true;report.binary.afterSha256=sha256(await readFile(binary));report.binary.stable=report.binary.afterSha256===binaryHash;assert.equal(report.binary.stable,true,'executable changed');
    if(measureResources){assert.equal(report.process.stopReason,null);assert.equal(report.process.exitObserved,true);assert.equal(report.process.pipesDrained,true);assert.equal(report.process.cleanup.ownedGroupRemaining,false);}
    assert.equal(report.process.spawnError,undefined);assert.equal(report.process.validationError,undefined,report.process.validationError?.message);assert.equal(report.process.timedOut,false);assert.equal(report.process.signal,null);assert.equal(report.process.exitCode,0);assert.equal(validator.done,true);report.status='passed';
  }catch(error){report.status='failed-or-incomplete';report.error={message:error.message,kind:error.kind,phase:error.phase};}
  finally{await log.close();await writeFile(path.join(out,'bases-report.json'),json(report),{flag:'wx',mode:0o600});}
  return {out,report};
}
export async function selfTest(){
  const corpora=await loadCorpora(),item={family:'detached',case:corpora[0].corpus.cases[0]},r=item.case.request,byPath=new Map(r.snapshot.records.map(e=>[e.path,e]));
  const result={snapshotId:r.snapshot.snapshotId,rows:item.case.expected.paths.map(path=>({path,entryId:byPath.get(path).witness.entryId,revision:byPath.get(path).witness.revision,values:{}})),properties:item.case.expected.properties,counts:{scanned:4,matched:4,afterGroupOrder:4,afterSearch:4,returned:4},stepsUsed:1,groups:[],groupOptions:[],diagnostics:[],metadataIssues:[],metadataComplete:false,relationshipsAvailable:false};
  validateResult(item,result);const mutated=change=>{const copy=structuredClone(result);change(copy);assert.throws(()=>validateResult(item,copy));};
  mutated(x=>x.rows.reverse());mutated(x=>x.rows[0].revision='changed');mutated(x=>x.rows[0].entryId='foreign');mutated(x=>x.snapshotId.generation='999');mutated(x=>x.rows.pop());mutated(x=>x.counts.returned=0);mutated(x=>x.metadataIssues.push({witness:{entryId:'foreign',revision:'r1'}}));
  const v=new BasesValidator(corpora,1);assert.throws(()=>v.accept({type:'done'}));assert.throws(()=>v.accept({type:'error',phase:'query',detail:'synthetic rejection'}));
  const setup={type:'setup',detachedCases:10,generationCases:7,samples:1,debugAssertions:false,files:corpora.map(c=>({name:c.name,bytes:c.bytes.length})),setupMs:0,readMs:0,typedDecodeMs:0};
  v.accept(setup);assert.throws(()=>v.accept(setup));assert.throws(()=>v.accept({type:'done',cases:17,results:17}));assert.throws(()=>v.accept({type:'prepared',family:'detached',caseId:'wrong'}));
  v.accept({type:'prepared',family:'detached',caseId:item.case.id,source:null,snapshot:r.snapshot.snapshotId,configurationCompileMs:0,generationBuildMs:null});
  assert.throws(()=>v.accept({type:'result',family:'detached',caseId:item.case.id,sample:0,queryMs:-1,result}));
  v.accept({type:'result',family:'detached',caseId:item.case.id,sample:0,queryMs:0,result});assert.throws(()=>v.accept({type:'result',family:'detached',caseId:item.case.id,sample:0,queryMs:0,result}));
  v.accept({type:'measurement',family:'detached',caseId:item.case.id,sample:0,resultOutputMs:0});assert.equal(v.results.length,1);
  return {scope:'Node fixture/protocol checks only; no Rust, timing workload or full-output oracle acceptance',casesPinned:17,adversarialChecks:14};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{out:{type:'string'},bases:{type:'string'},samples:{type:'string',default:'1'},'timeout-ms':{type:'string',default:'30000'},'build-sha':{type:'string',default:'unknown'},'build-mode':{type:'string',default:'unknown'},'self-test':{type:'boolean'},'process-resources':{type:'boolean'}}});
  if(values['self-test'])console.log(json(await selfTest()));else{if(!values.out||!values.bases)throw Error('Use --out NEW_DIRECTORY --bases ALREADY_BUILT_BASE_EXAMPLE');const result=await runBases({out:values.out,binary:values.bases,samples:Number(values.samples),timeoutMs:Number(values['timeout-ms']),buildSha:values['build-sha'],buildMode:values['build-mode'],measureResources:values['process-resources']??false});console.log(json({out:result.out,status:result.report.status,report:path.join(result.out,'bases-report.json')}));if(result.report.status!=='passed')process.exitCode=1;}
}
