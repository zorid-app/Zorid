import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {startOwnedMeasuredProcess} from './process-resources.mjs';
import {open,readFile,writeFile,stat,realpath,mkdtemp,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {generate,sha256,json,queries,literalOracle,expectedCount,checkCount} from './workload.mjs';

const finite=value=>assert.ok(Number.isFinite(value)&&value>=0,'nonnegative finite timing required');
const uint=(value,max=Number.MAX_SAFE_INTEGER)=>assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=max,'bounded integer required');
const source=Object.freeze({localStoreId:'s1-core-store',watermark:'1'});
const snapshot=Object.freeze({localStoreId:'s1-core-store',generationEpoch:'s1-core-epoch',generation:'1',versions:{schema:1,extraction:'zorid-markdown-1:metadata-2',resolver:'link-nfc-lower-segment-utf16-v1',query:'literal-lines-exact-v1'}});
const mapped=entry=>({id:entry.logicalId,revision:`source-${entry.sha256}`,path:entry.path,kind:'file',deleted:false});
export class CoreValidator {
  constructor(fixture,samples){this.fixture=fixture;this.samples=samples;this.byPath=new Map(fixture.manifest.entries.map(e=>[e.path,mapped(e)]));this.reports=[];this.seenSetup=false;this.seenGeneration=false;this.done=false;this.active=null;}
  identity(event){assert.deepEqual(event.source,source,'source witness changed');assert.deepEqual(event.snapshot,snapshot,'snapshot/version identity changed');}
  accept(event){
    assert.equal(this.done,false,'output after final acknowledgment');
    if(event.type==='error')throw Object.assign(Error(`core rejected ${event.phase}: ${event.detail}`),{kind:'core-rejection',phase:event.phase,detail:event.detail});
    if(event.type==='setup'){
      assert.equal(this.seenSetup,false);assert.equal(this.seenGeneration,false);assert.equal(event.fixtureHash,this.fixture.fixtureHash);assert.equal(event.noteCount,this.fixture.manifest.noteCount);assert.equal(event.entries,this.byPath.size);
      assert.equal(event.inputBytes,this.fixture.manifest.entries.reduce((n,e)=>n+e.bytes,0));assert.equal(event.textBytes,this.fixture.manifest.entries.filter(e=>e.kind==='text').reduce((n,e)=>n+e.bytes,0));
      for(const key of ['setupMs','sourceReadMs','sourceHashMs','utf8DecodeMs'])finite(event[key]);assert.equal(typeof event.debugAssertions,'boolean');this.setup=event;this.seenSetup=true;return;
    }
    assert.ok(this.seenSetup,'setup acknowledgment required');
    if(event.type==='generation'){
      assert.equal(this.seenGeneration,false);this.identity(event);assert.equal(event.entries,this.byPath.size);assert.equal(event.records,this.byPath.size);assert.equal(event.coverageComplete,true,'unexpected extraction exclusion');
      assert.equal(event.parseInvocations,this.fixture.manifest.noteCount);assert.equal(event.parseInputBytes,this.fixture.manifest.noteBytes);
      assert.deepEqual(event.exclusions,this.fixture.manifest.entries.filter(e=>e.kind==='binary').map(e=>({entry:mapped(e),reason:'binary'})));
      for(const key of ['manifestMs','bindingMs','extractionMs','insertionMs','finishMs'])finite(event[key]);uint(event.metadataBytes,64*1024*1024);uint(event.pumpResets);
      this.generation=event;this.seenGeneration=true;return;
    }
    assert.ok(this.seenGeneration,'generation acknowledgment required');this.identity(event);
    if(event.type==='done'){
      assert.equal(this.active,null);assert.equal(this.reports.length,queries.length*this.samples);assert.equal(event.queries,this.reports.length);assert.equal(event.coverageComplete,true);this.done=true;return;
    }
    const index=this.reports.length,q=queries[index%queries.length],sample=Math.floor(index/queries.length);
    assert.ok(q&&sample<this.samples,'unexpected extra query');assert.equal(event.queryId,q.id);assert.equal(event.sample,sample);
    if(event.type==='page'){
      this.active??={oracle:literalOracle(q,this.fixture.manifest.noteCount),pages:0,hits:0,documents:0,sourceBytes:0,final:false};const run=this.active;
      assert.equal(run.final,false,'page after completed scan');assert.equal(event.page,++run.pages);assert.equal(event.coverageComplete,true);assert.equal(typeof event.scanComplete,'boolean');assert.equal(event.complete,event.scanComplete);assert.equal(event.hasNext,!event.scanComplete);
      uint(event.documents,32);uint(event.sourceBytes,16*1024*1024);assert.ok(Array.isArray(event.hits)&&event.hits.length<=100);run.documents+=event.documents;run.sourceBytes+=event.sourceBytes;
      for(const hit of event.hits){const expected=run.oracle.next();assert.equal(expected.done,false,'unexpected extra match');const value=expected.value;
        assert.deepEqual(hit.entry,this.byPath.get(value.path),'entry ID/revision/path changed');assert.equal(hit.line,value.line);assert.deepEqual(hit.range,value.range);run.hits++;}
      run.final=event.scanComplete;
      if(run.final){assert.equal(run.oracle.next().done,true,'complete scan omitted oracle matches');assert.equal(run.hits,expectedCount(q,this.fixture.manifest.noteCount));}return;
    }
    assert.equal(event.type,'query','unknown protocol event');const run=this.active;assert.ok(run?.final,'summary before complete scan');assert.equal(event.query,q.query);
    assert.equal(event.pages,run.pages);assert.equal(event.hits,run.hits);assert.equal(event.documents,run.documents);assert.equal(event.sourceBytes,run.sourceBytes);assert.equal(event.scanComplete,true);assert.equal(event.coverageComplete,true);assert.equal(event.complete,true);
    finite(event.queryMs);finite(event.pageOutputMs);this.reports.push({...event,correctness:'complete-independent-literal-oracle'});this.active=null;
  }
}
async function verifyFiles(fixture){for(const e of fixture.manifest.entries){const bytes=await readFile(path.join(fixture.vault,e.path));assert.equal(bytes.length,e.bytes);assert.equal(sha256(bytes),e.sha256,'fixture changed during core pass');}}
async function executeMeasured(binary,args,validator,log,timeoutMs,sidecarDirectory){
  const owned=await startOwnedMeasuredProcess({binary,args,timeoutMs,sidecarDirectory,measureResources:true});let total=0,line='',stderr='',validationError;
  owned.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+chunk.length>1024*1024){validationError??=Error('stderr bound');owned.stop('stderr-output-limit');}else stderr+=chunk.toString('utf8');});
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try{
    for await(const chunk of owned.stdout){total+=chunk.length;if(total>512*1024*1024)throw Error('stdout bound');await log.write(chunk);line+=decoder.decode(chunk,{stream:true});let split;
      while((split=line.indexOf('\n'))>=0){const raw=line.slice(0,split);line=line.slice(split+1);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('NDJSON event bound');validator.accept(JSON.parse(raw));}
      if(Buffer.byteLength(line)>2*1024*1024)throw Error('NDJSON event bound');
    }
    line+=decoder.decode();assert.equal(line,'','truncated final NDJSON record');
  }catch(error){validationError??=error;owned.stop('protocol-or-output-failure');owned.stdout.resume();}
  const result=await owned.completed;
  return {...result,stdoutBytes:total,stderr,...(validationError?{validationError:{message:String(validationError.message),kind:validationError.kind,phase:validationError.phase,detail:validationError.detail}}:{})};
}
async function execute(binary,args,validator,log,timeoutMs,resourceDirectory){
  if(resourceDirectory)return executeMeasured(binary,args,validator,log,timeoutMs,resourceDirectory);
  const started=performance.now(),child=spawn(binary,args,{stdio:['ignore','pipe','pipe'],env:{...process.env}});let timedOut=false,killTimer,total=0,line='',stderr='',streamError;
  const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1000);};
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  const closed=new Promise(resolve=>{child.once('error',error=>resolve({spawnError:String(error)}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+chunk.length>1024*1024){streamError??=Error('stderr bound');stop();}else stderr+=chunk.toString('utf8');});
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try{
    for await(const chunk of child.stdout){total+=chunk.length;if(total>512*1024*1024)throw Error('stdout bound');await log.write(chunk);line+=decoder.decode(chunk,{stream:true});
      let split;while((split=line.indexOf('\n'))>=0){const raw=line.slice(0,split);line=line.slice(split+1);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('NDJSON event bound');validator.accept(JSON.parse(raw));}
      if(Buffer.byteLength(line)>2*1024*1024)throw Error('NDJSON event bound');
    }
    line+=decoder.decode();assert.equal(line,'','truncated final NDJSON record');
  }catch(error){streamError??=error;stop();child.stdout.resume();}
  const result=await closed;clearTimeout(timer);clearTimeout(killTimer);
  return {...result,wallMs:performance.now()-started,timedOut,stdoutBytes:total,stderr,...(streamError?{validationError:{message:String(streamError.message),kind:streamError.kind,phase:streamError.phase,detail:streamError.detail}}:{})};
}
export async function runCore({out,binary,notes=100,samples=1,timeoutMs=60000,buildSha='unknown',buildMode='unknown',stress=false,measureResources=false}){
  assert.equal(typeof measureResources,'boolean');if(measureResources)assert.equal(process.platform,'darwin','--process-resources currently supports Darwin only');
  checkCount(notes);if(notes===100000&&!stress)throw Error('100k requires --stress');
  assert.ok(Number.isSafeInteger(samples)&&samples>=1&&samples<=20);assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=300000);
  assert.ok(['debug','release','unknown'].includes(buildMode));assert.match(buildSha,/^(unknown|[a-f0-9]{40})$/);
  binary=await realpath(binary);assert.ok((await stat(binary)).isFile());const beforeHash=sha256(await readFile(binary));
  const started=performance.now(),previousMask=process.umask(0o077);let fixture;
  try{fixture=await generate(out,notes);}finally{process.umask(previousMask);}
  const generationMs=performance.now()-started;
  const report={schemaVersion:1,scope:'pure Rust document/index/literal query with preloaded sources; no Store/native admission, persistence, renderer, browser or mobile acceptance',status:'running',fixtureHash:fixture.fixtureHash,noteCount:notes,noteBytes:fixture.manifest.noteBytes,
    binary:{path:binary,sha256:beforeHash,buildSha,buildMode,provenance:'source/mode caller supplied; exact executable bytes hashed before/after, source correspondence not inferred'},
    wrapperSha256:sha256(await readFile(new URL(import.meta.url))),workloadSha256:sha256(await readFile(new URL('./workload.mjs',import.meta.url))),
    environment:{node:process.version,os:os.release(),platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalMemory:os.totalmem(),executor:'existing sequential pure engine; no worker pool'},setup:{fixtureGenerationMs:generationMs},queries:[],filesystemSourcePreserved:false,
    limitations:['initial literal/parsing baseline only, not S1.0 acceptance','source IO/hash/decode setup excluded from extraction/query timers','IndexRecord extraction includes source hash/projection/validation, not parser-only CPU','page encoding/output excluded from queryMs and reported separately; wrapper validation/backpressure may affect scheduling','no restart cache, incremental edits, graph/Base queries, foreground responsiveness or cancellation scenarios','OS page cache/load uncontrolled; peak RSS/CPU/internal cache counters unavailable','pure fixture witnesses never authorize source mutations; complete coverage excludes known binary body extraction']};
  if(measureResources)report.limitations[5]='OS page cache/load uncontrolled; internal cache counters unavailable; peak RSS/CPU unavailable unless optional per-utility process resources are requested';
  const validator=new CoreValidator(fixture,samples),log=await open(path.join(fixture.out,'core.stdout.ndjson'),'wx');
  try{
    report.process=await execute(binary,['--fixture',fixture.out,'--samples',String(samples)],validator,log,timeoutMs,measureResources?fixture.out:undefined);
    report.setup.core=validator.setup;report.generation=validator.generation;report.queries=validator.reports;
    if(measureResources){report.processResources={requested:true,helperSha256:sha256(await readFile(new URL('./process-resources.mjs',import.meta.url))),scope:'one instrumented utility lifetime, not engine phases or aggregate process tree'};}
    await verifyFiles(fixture);report.filesystemSourcePreserved=true;assert.equal(sha256(await readFile(binary)),beforeHash,'executable changed during pass');
    if(measureResources){assert.equal(report.process.stopReason,null);assert.equal(report.process.exitObserved,true);assert.equal(report.process.pipesDrained,true);assert.equal(report.process.cleanup.ownedGroupRemaining,false);}
    assert.equal(report.process.spawnError,undefined);assert.equal(report.process.validationError,undefined,report.process.validationError?.message);assert.equal(report.process.timedOut,false);assert.equal(report.process.signal,null);assert.equal(report.process.exitCode,0);assert.equal(validator.done,true,'missing complete final acknowledgment');
    report.status='passed';
  }catch(error){report.status='failed-or-incomplete';report.error={message:String(error.message),kind:error.kind,phase:error.phase};}
  finally{await log.close();await writeFile(path.join(fixture.out,'core-report.json'),json(report),{flag:'wx'});}
  return {out:fixture.out,report};
}
export async function selfTest(){
  // Check rejection properties with fixture-independent protocol corruption.
  const entry={logicalId:'note-000000',path:'Notes/G000/Note-000000.md',sha256:'0'.repeat(64),bytes:1,kind:'text'},fixture={fixtureHash:'fixture',manifest:{noteCount:1,noteBytes:1,entries:[entry]}};
  const v=new CoreValidator(fixture,1);assert.throws(()=>v.accept({type:'done',source,snapshot}));
  const setup={type:'setup',fixtureHash:'fixture',noteCount:1,entries:1,inputBytes:1,textBytes:1,setupMs:0,sourceReadMs:0,sourceHashMs:0,utf8DecodeMs:0,debugAssertions:true};
  v.accept(setup);assert.throws(()=>v.accept(setup));assert.throws(()=>v.accept({type:'error',phase:'generation',detail:'limit'}));
  const generation={type:'generation',source,snapshot,entries:1,records:1,coverageComplete:true,parseInvocations:1,parseInputBytes:1,exclusions:[],manifestMs:0,bindingMs:0,extractionMs:0,insertionMs:0,finishMs:0,metadataBytes:1,pumpResets:0};
  const fresh=()=>{const x=new CoreValidator(fixture,1);x.accept(setup);x.accept(generation);return x;};
  assert.throws(()=>fresh().accept({type:'done',source,snapshot,queries:0,coverageComplete:true}));
  const page={type:'page',queryId:'common',sample:0,page:1,source,snapshot,coverageComplete:true,scanComplete:true,complete:true,hasNext:false,documents:1,sourceBytes:1,hits:[]};
  assert.throws(()=>fresh().accept(page),'false completion must reject missing expected hit');
  assert.throws(()=>fresh().accept({...page,source:{...source,watermark:'2'}}));
  assert.throws(()=>fresh().accept({...page,snapshot:{...snapshot,generation:'2'}}));
  assert.throws(()=>fresh().accept({...page,page:2}));
  assert.throws(()=>fresh().accept({...page,hasNext:true}));
  const expected=literalOracle(queries[0],1).next().value,hit={entry:mapped(entry),line:expected.line,range:expected.range};
  assert.throws(()=>fresh().accept({...page,hits:[{...hit,entry:{...hit.entry,revision:'other'}}]}));
  assert.throws(()=>fresh().accept({...page,hits:[{...hit,range:{...hit.range,bytes:[0,1]}}]}));
  const valid=fresh();valid.accept({...page,hits:[hit]});assert.throws(()=>valid.accept({...page,hits:[hit]}));
  const temporary=await mkdtemp(path.join(os.tmpdir(),'zorid-s1-core-wrapper-'));
  try{
    const fake=`#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {queries,literalOracle,sha256} from ${JSON.stringify(new URL('./workload.mjs',import.meta.url).href)};
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const mode=path.basename(process.argv[1]);
if(mode==='timeout'){setInterval(()=>{},10000);}
else if(mode==='error'){emit({type:'error',phase:'generation',detail:'synthetic retained resource rejection'});process.exitCode=1;}
else{
  const fixture=process.argv[process.argv.indexOf('--fixture')+1],raw=await readFile(path.join(fixture,'manifest.json')),m=JSON.parse(raw);
  const source=${JSON.stringify(source)},snapshot=${JSON.stringify(snapshot)},mapped=e=>({id:e.logicalId,revision:'source-'+e.sha256,path:e.path,kind:'file',deleted:false});
  const total=m.entries.reduce((n,e)=>n+e.bytes,0),text=m.entries.filter(e=>e.kind==='text').reduce((n,e)=>n+e.bytes,0);
  emit({type:'setup',fixtureHash:sha256(raw),noteCount:m.noteCount,entries:m.entries.length,inputBytes:total,textBytes:text,setupMs:0,sourceReadMs:0,sourceHashMs:0,utf8DecodeMs:0,debugAssertions:false});
  emit({type:'generation',source,snapshot,entries:m.entries.length,records:m.entries.length,coverageComplete:true,parseInvocations:m.noteCount,parseInputBytes:m.noteBytes,metadataBytes:1,pumpResets:0,manifestMs:0,bindingMs:0,extractionMs:0,insertionMs:0,finishMs:0,exclusions:m.entries.filter(e=>e.kind==='binary').map(e=>({entry:mapped(e),reason:'binary'}))});
  for(const q of queries){const hits=[...literalOracle(q,m.noteCount)].map(e=>({entry:mapped(m.entries.find(row=>row.path===e.path)),line:e.line,range:e.range}));
    emit({type:'page',source,snapshot,queryId:q.id,sample:0,page:1,coverageComplete:true,scanComplete:true,complete:true,hasNext:false,documents:m.entries.length,sourceBytes:text,hits});
    emit({type:'query',source,snapshot,queryId:q.id,query:q.query,sample:0,pages:1,hits:hits.length,documents:m.entries.length,sourceBytes:text,queryMs:0,pageOutputMs:0,scanComplete:true,coverageComplete:true,complete:true});
  }
  emit({type:'done',source,snapshot,queries:queries.length,coverageComplete:true});
}
`;
    for(const mode of ['success','error','timeout']){
      const executable=path.join(temporary,mode);await writeFile(executable,fake,{flag:'wx'});await chmod(executable,0o700);
      const result=await runCore({out:path.join(temporary,mode+'-out'),binary:executable,notes:1,timeoutMs:mode==='timeout'?100:10000});
      const retained=JSON.parse(await readFile(path.join(result.out,'core-report.json'),'utf8'));
      assert.equal(retained.status,mode==='success'?'passed':'failed-or-incomplete');assert.equal(retained.filesystemSourcePreserved,true);
      if(mode==='success'){assert.equal(retained.queries.length,8);assert.equal(retained.process.exitCode,0);}
      if(mode==='error')assert.equal(retained.process.validationError.phase,'generation');
      if(mode==='timeout')assert.equal(retained.process.timedOut,true);
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
  return {scope:'Node validator plus synthetic executable/report lifecycle only; no Rust or performance acceptance',protocolChecks:12,syntheticProcessCases:3};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{out:{type:'string'},core:{type:'string'},notes:{type:'string',default:'100'},samples:{type:'string',default:'1'},'timeout-ms':{type:'string',default:'60000'},'build-sha':{type:'string',default:'unknown'},'build-mode':{type:'string',default:'unknown'},stress:{type:'boolean'},'self-test':{type:'boolean'},'process-resources':{type:'boolean'}}});
  if(values['self-test'])console.log(json(await selfTest()));
  else{if(!values.out||!values.core)throw Error('Use --out NEW_DIRECTORY --core ALREADY_BUILT_EXAMPLE');const result=await runCore({out:values.out,binary:values.core,notes:Number(values.notes),samples:Number(values.samples),timeoutMs:Number(values['timeout-ms']),buildSha:values['build-sha'],buildMode:values['build-mode'],measureResources:values['process-resources']??false,stress:values.stress});console.log(json({out:result.out,status:result.report.status,report:path.join(result.out,'core-report.json')}));if(result.report.status!=='passed')process.exitCode=1;}
}
